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

use super::*;

fn submit(executor: &Executor, source: &str, previous: Option<Arc<str>>) -> Result<Job, Admission> {
    executor.submit_rebasing(
        Arc::from(source),
        Input::Plain,
        false,
        Palette::default(),
        previous,
    )
}

#[test]
fn queued_previous_text_is_admitted_and_reclaimed_on_cancellation() {
    let (entered, starts) = mpsc::channel();
    let (release, barrier) = mpsc::channel();
    let old: Arc<str> = "x".repeat(OVERHEAD * 2).into();
    let old_bytes = old.len();
    let old_text = Arc::downgrade(&old);
    let executor = Executor::start(2 * OVERHEAD + 1 + 4 + old_bytes, move |work| {
        entered.send(work.text.clone()).unwrap();
        barrier.recv().unwrap();
        prepare(work)
    })
    .unwrap();
    let active = submit(&executor, "a", None).unwrap();
    assert_eq!(starts.recv().unwrap().as_ref(), "a");
    let queued = submit(&executor, "next", Some(old)).unwrap();
    assert_eq!(queued.retained_bytes(), OVERHEAD + 4 + old_bytes);
    assert_eq!(submit(&executor, "p", None).err(), Some(Admission::Busy));
    drop(queued);
    assert!(old_text.upgrade().is_none());
    assert_eq!(executor.used.load(Ordering::Relaxed), 2 * OVERHEAD + 1);
    let probe = submit(&executor, "p", None).unwrap();
    drop(active);
    release.send(()).unwrap();
    assert_eq!(starts.recv().unwrap().as_ref(), "p");
    release.send(()).unwrap();
    assert!(probe.result.recv().unwrap().result.is_ok());
    assert_eq!(executor.used.load(Ordering::Relaxed), 0);
}

#[test]
fn unread_rebase_preserves_exact_previous_arc_until_poll_or_reader_drop() {
    for poll in [true, false] {
        let (entered, starts) = mpsc::channel();
        let (release, barrier) = mpsc::channel();
        let executor = Executor::start(64 * 1024, move |work| {
            entered.send(()).unwrap();
            barrier.recv().unwrap();
            prepare(work)
        })
        .unwrap();
        let old: Arc<str> = Arc::from("ab old 🦀");
        let old_bytes = old.len();
        let old_text = Arc::downgrade(&old);
        let source = "ab **new** 🦀";
        let mut job = executor
            .submit_rebasing(
                Arc::from(source),
                Input::Markdown,
                false,
                Palette::default(),
                Some(old),
            )
            .unwrap();
        starts.recv().unwrap();
        assert_eq!(job.retained_bytes(), OVERHEAD + source.len() + old_bytes);
        let sentinel = submit(&executor, "sentinel", None).unwrap();
        release.send(()).unwrap();
        starts.recv().unwrap();
        let output_bytes = Document::markdown(source, false, Palette::default())
            .unwrap()
            .bytes();
        assert_eq!(job.retained_bytes(), OVERHEAD + output_bytes + old_bytes);
        assert!(old_text.upgrade().is_some());
        if poll {
            let Poll::Ready(Ok(prepared)) = job.poll() else {
                panic!("completed rebase must be available")
            };
            assert_eq!(prepared.document.text(), "ab new 🦀");
            let (basis, rebase) = prepared.previous.as_ref().unwrap();
            assert!(Arc::ptr_eq(basis, &old_text.upgrade().unwrap()));
            assert_eq!(
                *rebase,
                Rebase::Changed {
                    prefix: 3,
                    old_end: 6,
                    new_end: 6
                }
            );
            assert_eq!(job.retained_bytes(), 0);
            assert!(
                old_text.upgrade().is_some(),
                "poll transfers the old basis to its owner"
            );
            drop(prepared);
        } else {
            drop(job);
        }
        assert!(old_text.upgrade().is_none());
        assert_eq!(
            executor.used.load(Ordering::Relaxed),
            OVERHEAD + "sentinel".len()
        );
        release.send(()).unwrap();
        assert!(sentinel.result.recv().unwrap().result.is_ok());
        assert_eq!(executor.used.load(Ordering::Relaxed), 0);
    }
}

#[test]
fn unread_failure_keeps_the_owners_previous_basis_charged_until_poll_drop_or_cancel() {
    use super::super::large::State;
    for source in ["error", "panic", "capacity", "pressure"] {
        for completion in ["poll", "drop", "cancel"] {
            let semantic: Arc<str> = Arc::from("old semantic text");
            let old_bytes = semantic.len();
            let old_text = Arc::downgrade(&semantic);
            let output = Document::plain("expanded semantic output").unwrap();
            let limit = 2 * OVERHEAD + old_bytes + output.bytes() + "sentinel".len() - 1;
            let (entered, starts) = mpsc::channel();
            let (release, barrier) = mpsc::channel();
            let executor = Executor::start(limit, move |work| {
                entered.send(()).unwrap();
                barrier.recv().unwrap();
                match work.text.as_ref() {
                    "error" => Err("injected preparation error"),
                    "panic" => panic!("injected preparation panic"),
                    "capacity" => Document::plain(&"x".repeat(limit + 1)),
                    "pressure" => Ok(output.clone()),
                    _ => Document::plain(""),
                }
            })
            .unwrap();
            let job = submit(&executor, source, Some(semantic.clone())).unwrap();
            let charged = job.retained.clone();
            let mut state = State::pending(job, false, Palette::default())
                .with_previous(Some(semantic.clone()));
            starts.recv().unwrap();
            let sentinel = submit(&executor, "sentinel", None).unwrap();
            release.send(()).unwrap();
            starts.recv().unwrap();
            assert!(
                state.shares_text(&semantic),
                "the owner's semantic is counted by State"
            );
            assert_eq!(charged.load(Ordering::Relaxed), OVERHEAD + old_bytes);
            assert_eq!(state.bytes(), OVERHEAD + old_bytes);
            assert_eq!(
                Arc::strong_count(&semantic),
                3,
                "State, owner and unread error share one basis"
            );
            match completion {
                "poll" => {
                    let error = match source {
                        "error" => "injected preparation error",
                        "panic" => "Transcript preparation worker is unavailable",
                        _ => "Prepared transcript exceeds shared capacity",
                    };
                    assert_eq!(state.prepare(source, || Input::Plain), Err(error));
                    assert_eq!(state.bytes(), old_bytes);
                    assert_eq!(Arc::strong_count(&semantic), 2);
                    drop(state);
                }
                "cancel" => {
                    state.cancel_preparation();
                    assert_eq!(state.bytes(), old_bytes);
                    assert_eq!(Arc::strong_count(&semantic), 2);
                    drop(state);
                }
                _ => drop(state),
            }
            assert_eq!(charged.load(Ordering::Relaxed), 0);
            assert_eq!(Arc::strong_count(&semantic), 1);
            drop(semantic);
            assert!(old_text.upgrade().is_none());
            assert_eq!(
                executor.used.load(Ordering::Relaxed),
                OVERHEAD + "sentinel".len()
            );
            release.send(()).unwrap();
            assert!(sentinel.result.recv().unwrap().result.is_ok());
            assert_eq!(executor.used.load(Ordering::Relaxed), 0);
        }
    }
}

#[test]
fn rejected_previous_basis_has_no_admitted_owner() {
    let executor = Executor::start(OVERHEAD + 2, prepare).unwrap();
    let old: Arc<str> = Arc::from("xx");
    let old_text = Arc::downgrade(&old);
    assert_eq!(
        submit(&executor, "n", Some(old)).err(),
        Some(Admission::TooLarge)
    );
    assert!(old_text.upgrade().is_none());
    assert_eq!(executor.used.load(Ordering::Relaxed), 0);
}
