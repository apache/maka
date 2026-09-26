/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Cancellable semantic preparation on one byte-admitted CPU lane.
use super::layout::{self, diff::Row, prepared::Document};
use super::selection::rebase::{self, Rebase};
use crate::theme::Palette;
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    task::Poll,
};

#[derive(Clone)]
pub(super) enum Input {
    Plain,
    Markdown,
    Diff(Arc<[Row]>),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Admission {
    Busy,
    TooLarge,
    WorkerFailed,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Preparation(&'static str),
    WorkerFailed,
}
pub(super) struct Prepared {
    pub document: Document,
    pub previous: Option<(Arc<str>, Rebase)>,
}
impl Prepared {
    fn bytes(&self) -> usize {
        self.document
            .bytes()
            .saturating_add(self.previous.as_ref().map_or(0, |(old, _)| old.len()))
    }
}
type Outcome = Result<Prepared, Failure>;
// Weak ownership releases cancelled input immediately; queue credit bounds the
// remaining queue nodes until they are consumed by the worker.
type Queued = (Weak<Pending>, Credit);
const OVERHEAD: usize =
    size_of::<Pending>() + size_of::<Queued>() + size_of::<Job>() + size_of::<Reply>();

pub(super) struct Job {
    pending: Option<Arc<Pending>>,
    result: mpsc::Receiver<Reply>,
    alive: Arc<AtomicBool>,
    retained: Arc<AtomicUsize>,
}
struct Pending {
    work: Mutex<Option<Work>>,
    cancelled: AtomicBool,
}
struct Work {
    text: Arc<str>,
    input: Input,
    ascii: bool,
    colors: Palette,
    previous: Option<Arc<str>>,
    reply: mpsc::Sender<Reply>,
    credit: Credit,
}
struct Reply {
    result: Outcome,
    // Owners delegate basis accounting to Job until success or failure is consumed.
    _error_previous: Option<Arc<str>>,
    _credit: Credit,
}
struct Credit {
    used: Arc<AtomicUsize>,
    retained: Arc<AtomicUsize>,
    bytes: usize,
}
impl Credit {
    fn resize(&mut self, bytes: usize, limit: usize) -> bool {
        if bytes > self.bytes {
            let extra = bytes - self.bytes;
            if self
                .used
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                    used.checked_add(extra).filter(|n| *n <= limit)
                })
                .is_err()
            {
                return false;
            }
            self.retained.fetch_add(extra, Ordering::Relaxed);
        } else {
            self.used.fetch_sub(self.bytes - bytes, Ordering::Relaxed);
            self.retained
                .fetch_sub(self.bytes - bytes, Ordering::Relaxed);
        }
        self.bytes = bytes;
        true
    }
}
impl Drop for Credit {
    fn drop(&mut self) {
        self.used.fetch_sub(self.bytes, Ordering::Relaxed);
        self.retained.fetch_sub(self.bytes, Ordering::Relaxed);
    }
}
struct Alive(Arc<AtomicBool>);
impl Drop for Alive {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
struct Executor {
    queue: mpsc::Sender<Queued>,
    used: Arc<AtomicUsize>,
    alive: Arc<AtomicBool>,
    limit: usize,
}

pub(super) fn submit(
    text: Arc<str>,
    input: Input,
    ascii: bool,
    colors: Palette,
) -> Result<Job, Admission> {
    worker()?.submit_rebasing(text, input, ascii, colors, None)
}
pub(super) fn submit_rebasing(
    text: Arc<str>,
    input: Input,
    ascii: bool,
    colors: Palette,
    previous: Option<Arc<str>>,
) -> Result<Job, Admission> {
    if previous.is_none() {
        return submit(text, input, ascii, colors);
    }
    worker()?.submit_rebasing(text, input, ascii, colors, previous)
}
fn worker() -> Result<&'static Executor, Admission> {
    static WORKER: OnceLock<Result<Executor, Admission>> = OnceLock::new();
    WORKER
        .get_or_init(|| Executor::start(layout::MAX_BYTES, prepare))
        .as_ref()
        .map_err(|error| *error)
}
fn prepare(work: &Work) -> Result<Document, &'static str> {
    match &work.input {
        Input::Plain => Document::plain(&work.text),
        Input::Markdown => Document::markdown(&work.text, work.ascii, work.colors),
        Input::Diff(rows) => Document::diff(&work.text, rows, work.ascii, work.colors),
    }
}
impl Executor {
    fn start(
        limit: usize,
        prepare: impl Fn(&Work) -> Result<Document, &'static str> + Send + 'static,
    ) -> Result<Self, Admission> {
        let (queue, receiver) = mpsc::channel::<Queued>();
        let alive = Arc::new(AtomicBool::new(true));
        let guard = Alive(alive.clone());
        std::thread::Builder::new()
            .name("transcript-preparation".into())
            .spawn(move || {
                let _alive = guard;
                while let Ok((pending, mut queue_credit)) = receiver.recv() {
                    let Some(pending) = pending.upgrade() else {
                        continue;
                    };
                    let work = pending
                        .work
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .take();
                    let Some(work) = work else { continue };
                    if pending.cancelled.load(Ordering::Acquire) {
                        continue;
                    }
                    let mut result = catch_unwind(AssertUnwindSafe(|| {
                        let document = prepare(&work)?;
                        let previous = work
                            .previous
                            .as_ref()
                            .map(|old| (old.clone(), rebase::compute(old, document.text())));
                        Ok::<_, &'static str>(Prepared { document, previous })
                    }))
                    .map_err(|_| Failure::WorkerFailed)
                    .and_then(|result| result.map_err(Failure::Preparation));
                    if pending.cancelled.load(Ordering::Acquire) {
                        continue;
                    }
                    drop((work.text, work.input));
                    let previous = work.previous;
                    let error_bytes = OVERHEAD + previous.as_ref().map_or(0, |old| old.len());
                    let mut credit = work.credit;
                    credit.bytes += queue_credit.bytes;
                    queue_credit.bytes = 0;
                    let bytes = result.as_ref().map_or(error_bytes, |prepared| {
                        prepared.bytes().saturating_add(OVERHEAD)
                    });
                    if !credit.resize(bytes, limit) {
                        result = Err(Failure::Preparation(
                            "Prepared transcript exceeds shared capacity",
                        ));
                        credit.resize(error_bytes, limit);
                    }
                    let error_previous = if result.is_err() {
                        previous
                    } else {
                        drop(previous);
                        None
                    };
                    // Unread results remain admitted until their reader polls or drops.
                    let _ = work.reply.send(Reply {
                        result,
                        _error_previous: error_previous,
                        _credit: credit,
                    });
                }
            })
            .map_err(|_| Admission::WorkerFailed)?;
        Ok(Self {
            queue,
            used: Arc::new(AtomicUsize::new(0)),
            alive,
            limit,
        })
    }
    #[cfg(test)]
    fn submit(
        &self,
        text: Arc<str>,
        input: Input,
        ascii: bool,
        colors: Palette,
    ) -> Result<Job, Admission> {
        self.submit_rebasing(text, input, ascii, colors, None)
    }
    fn submit_rebasing(
        &self,
        text: Arc<str>,
        input: Input,
        ascii: bool,
        colors: Palette,
        previous: Option<Arc<str>>,
    ) -> Result<Job, Admission> {
        if !self.alive.load(Ordering::Acquire) {
            return Err(Admission::WorkerFailed);
        }
        let rows = match &input {
            Input::Diff(rows) => size_of_val(rows.as_ref()),
            _ => 0,
        };
        let bytes = text
            .len()
            .checked_add(rows)
            .and_then(|n| n.checked_add(previous.as_ref().map_or(0, |old| old.len())))
            .and_then(|n| n.checked_add(OVERHEAD))
            .filter(|n| *n <= self.limit)
            .ok_or(Admission::TooLarge)?;
        self.used
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                used.checked_add(bytes).filter(|n| *n <= self.limit)
            })
            .map_err(|_| Admission::Busy)?;
        let retained = Arc::new(AtomicUsize::new(bytes));
        let mut credit = Credit {
            used: self.used.clone(),
            retained: retained.clone(),
            bytes,
        };
        let queue_credit = Credit {
            used: self.used.clone(),
            retained: retained.clone(),
            bytes: OVERHEAD,
        };
        credit.bytes -= OVERHEAD;
        let (reply, result) = mpsc::channel();
        let pending = Arc::new(Pending {
            work: Mutex::new(Some(Work {
                text,
                input,
                ascii,
                colors,
                previous,
                reply,
                credit,
            })),
            cancelled: AtomicBool::new(false),
        });
        self.queue
            .send((Arc::downgrade(&pending), queue_credit))
            .map_err(|_| Admission::WorkerFailed)?;
        Ok(Job {
            pending: Some(pending),
            result,
            alive: self.alive.clone(),
            retained,
        })
    }
}
impl Job {
    /// Already included in the executor's shared budget; count once in owner totals.
    pub(super) fn retained_bytes(&self) -> usize {
        self.retained.load(Ordering::Relaxed)
    }
    /// Consume the completion once; the caller removes the job after Ready.
    pub(super) fn poll(&mut self) -> Poll<Outcome> {
        let result = match self.result.try_recv() {
            Ok(reply) => reply.result,
            Err(mpsc::TryRecvError::Empty) if self.alive.load(Ordering::Acquire) => {
                return Poll::Pending;
            }
            Err(_) => Err(Failure::WorkerFailed),
        };
        self.pending.take();
        Poll::Ready(result)
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        if let Some(pending) = &self.pending {
            pending.cancelled.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod rebase_tests;

#[cfg(test)]
mod tests {
    use super::*;
    fn submit(executor: &Executor, text: Arc<str>) -> Result<Job, Admission> {
        executor.submit(text, Input::Plain, false, Palette::default())
    }

    #[test]
    fn cancellation_reclaims_input_but_keeps_queued_bookkeeping_charged() {
        let (entered, starts) = mpsc::channel();
        let (release, barrier) = mpsc::channel();
        let (prepared, documents) = mpsc::channel();
        let size = OVERHEAD * 4;
        let executor = Executor::start(2 * size + 3 * OVERHEAD, move |_| {
            entered.send(()).unwrap();
            barrier.recv().unwrap();
            let document = Document::plain("ready").unwrap();
            prepared
                .send(Arc::downgrade(&document.shared_text()))
                .unwrap();
            Ok(document)
        })
        .unwrap();
        let mut active = submit(&executor, "x".repeat(size).into()).unwrap();
        starts.recv().unwrap();
        assert!(active.poll().is_pending());
        let text: Arc<str> = "y".repeat(size).into();
        let source = Arc::downgrade(&text);
        let queued = submit(&executor, text).unwrap();
        let pressure = submit(&executor, "z".repeat(size).into()).err();
        assert_eq!(pressure, Some(Admission::Busy));
        let oversized = submit(&executor, "z".repeat(executor.limit).into()).err();
        assert_eq!(oversized, Some(Admission::TooLarge));
        drop(queued);
        assert!(source.upgrade().is_none());
        assert_eq!(executor.used.load(Ordering::Relaxed), size + 2 * OVERHEAD);
        let replacement = submit(&executor, "z".repeat(size).into()).unwrap();
        release.send(()).unwrap();
        starts.recv().unwrap();
        assert!(
            matches!(active.poll(), Poll::Ready(Ok(prepared)) if prepared.document.text() == "ready")
        );
        assert!(documents.recv().unwrap().upgrade().is_none());
        drop(replacement);
        release.send(()).unwrap();
        let sentinel = submit(&executor, Arc::from("")).unwrap();
        starts.recv().unwrap();
        assert!(
            documents.recv().unwrap().upgrade().is_none(),
            "closed reader retains no result"
        );
        assert_eq!(executor.used.load(Ordering::Relaxed), OVERHEAD);
        release.send(()).unwrap();
        assert!(sentinel.result.recv().unwrap().result.is_ok());
        assert_eq!(executor.used.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn error_and_panic_release_credit_and_leave_the_lane_usable() {
        let executor = Executor::start(4096, |work| match work.text.as_ref() {
            "panic" => panic!("injected preparation panic"),
            "error" => Err("injected preparation error"),
            _ => prepare(work),
        })
        .unwrap();
        for (text, expected) in [
            ("panic", Failure::WorkerFailed),
            ("error", Failure::Preparation("injected preparation error")),
        ] {
            let job = submit(&executor, Arc::from(text)).unwrap();
            assert!(matches!(job.result.recv().unwrap().result, Err(error) if error == expected));
            assert_eq!(executor.used.load(Ordering::Relaxed), 0);
        }
        let job = submit(&executor, Arc::from("still usable")).unwrap();
        assert_eq!(
            job.result.recv().unwrap().result.unwrap().document.text(),
            "still usable"
        );
        assert_eq!(executor.used.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn unread_output_is_charged_until_poll_or_reader_drop() {
        let output = Document::plain("expanded semantic output").unwrap();
        let charge = output.bytes() + OVERHEAD;
        let (entered, starts) = mpsc::channel();
        let (release, barrier) = mpsc::channel();
        let executor = Executor::start(charge + OVERHEAD, move |_| {
            entered.send(()).unwrap();
            barrier.recv().unwrap();
            Ok(output.clone())
        })
        .unwrap();
        let mut first = submit(&executor, Arc::from("")).unwrap();
        starts.recv().unwrap();
        let second = submit(&executor, Arc::from("")).unwrap();
        release.send(()).unwrap();
        starts.recv().unwrap();
        assert_eq!(first.retained_bytes(), charge);
        assert_eq!(executor.used.load(Ordering::Relaxed), charge + OVERHEAD);
        assert_eq!(
            submit(&executor, Arc::from("")).err(),
            Some(Admission::Busy)
        );
        assert!(matches!(first.poll(), Poll::Ready(Ok(_))));
        assert_eq!(first.retained_bytes(), 0);
        let sentinel = submit(&executor, Arc::from("")).unwrap();
        release.send(()).unwrap();
        starts.recv().unwrap();
        assert_eq!(second.retained_bytes(), charge);
        drop(second);
        assert_eq!(executor.used.load(Ordering::Relaxed), OVERHEAD);
        release.send(()).unwrap();
        assert!(sentinel.result.recv().unwrap().result.is_ok());
        assert_eq!(executor.used.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn output_expansion_without_credit_finishes_with_a_terminal_error() {
        let output = Document::plain("expanded semantic output").unwrap();
        let charge = output.bytes() + OVERHEAD;
        let (entered, starts) = mpsc::channel();
        let (release, barrier) = mpsc::channel();
        let executor = Executor::start(charge + OVERHEAD - 1, move |_| {
            entered.send(()).unwrap();
            barrier.recv().unwrap();
            Ok(output.clone())
        })
        .unwrap();
        let mut first = submit(&executor, Arc::from("")).unwrap();
        starts.recv().unwrap();
        let second = submit(&executor, Arc::from("")).unwrap();
        release.send(()).unwrap();
        starts.recv().unwrap();
        assert!(matches!(
            first.poll(),
            Poll::Ready(Err(Failure::Preparation(_)))
        ));
        assert_eq!(executor.used.load(Ordering::Relaxed), OVERHEAD);
        release.send(()).unwrap();
        assert!(second.result.recv().unwrap().result.is_ok());
        assert_eq!(executor.used.load(Ordering::Relaxed), 0);
        let oversized = Executor::start(OVERHEAD + 1, |_| Document::plain("too large")).unwrap();
        let job = submit(&oversized, Arc::from("")).unwrap();
        assert!(matches!(
            job.result.recv().unwrap().result,
            Err(Failure::Preparation(_))
        ));
        assert_eq!(oversized.used.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn stopped_worker_cannot_leave_an_admitted_reader_pending() {
        let (queue, receiver) = mpsc::channel();
        let executor = Executor {
            queue,
            used: Arc::new(AtomicUsize::new(0)),
            alive: Arc::new(AtomicBool::new(true)),
            limit: 4096,
        };
        let text = Arc::from("queued");
        let source = Arc::downgrade(&text);
        let mut job = submit(&executor, text).unwrap();
        let rows = vec![
            Row {
                source: 0..0,
                kind: layout::diff::Kind::Content,
                language: None
            };
            executor.limit
        ];
        let oversized = executor
            .submit(
                Arc::from(""),
                Input::Diff(rows.into()),
                false,
                Palette::default(),
            )
            .err();
        assert_eq!(oversized, Some(Admission::TooLarge));
        drop(receiver);
        let disconnected = submit(&executor, Arc::from("disconnected")).err();
        assert_eq!(disconnected, Some(Admission::WorkerFailed));
        drop(Alive(executor.alive.clone()));
        assert!(matches!(
            job.poll(),
            Poll::Ready(Err(Failure::WorkerFailed))
        ));
        assert!(source.upgrade().is_none());
        assert_eq!(executor.used.load(Ordering::Relaxed), 0);
    }
}

#[cfg(test)]
mod visibility_tests;
