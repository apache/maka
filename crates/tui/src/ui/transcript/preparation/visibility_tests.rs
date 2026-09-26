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

//! Frame ownership tests; private barriers keep every worker transition explicit.
use super::super::{
    Kind, MessageKey, Part, Revision, Transcript, block_layout::Request, frame_work, large,
    tests as transcript_tests,
};
use super::*;
use ratatui::{Terminal, backend::TestBackend};

struct Lane {
    executor: Executor,
    starts: mpsc::Receiver<char>,
    release: mpsc::Sender<()>,
    output_bytes: usize,
}
impl Lane {
    fn new(size: usize) -> Self {
        let output = Document::plain("prepared output").unwrap();
        let output_bytes = output.bytes() + OVERHEAD;
        assert!(output.bytes() < size);
        let (entered, starts) = mpsc::channel();
        let (release, barrier) = mpsc::channel();
        let executor = Executor::start(2 * (size + OVERHEAD), move |work| {
            entered.send(work.text.chars().next().unwrap()).unwrap();
            barrier.recv().unwrap();
            Ok(output.clone())
        })
        .unwrap();
        Self {
            executor,
            starts,
            release,
            output_bytes,
        }
    }
    fn submit(&self, source: &str) -> Result<Job, Admission> {
        self.executor
            .submit(Arc::from(source), Input::Plain, false, Palette::default())
    }
    fn used(&self) -> usize {
        self.executor.used.load(Ordering::Relaxed)
    }
    fn finish_probe(&self, probe: Job) {
        self.release.send(()).unwrap();
        assert!(probe.result.recv().unwrap().result.is_ok());
        assert_eq!(self.used(), 0);
    }
}
fn key() -> MessageKey {
    MessageKey::new("visibility", "message", Part::Text)
}
fn reader(source: &str, state: large::State) -> Transcript {
    let mut view = Transcript::default();
    view.begin();
    view.upsert(key(), Revision::Durable(1), Kind::Assistant, || {
        source.to_owned().into()
    });
    view.finish([], &transcript_tests::locale());
    view.blocks.get_mut(&key()).unwrap().large = Some(state);
    view.cached.insert(key());
    view
}
fn pending(source: &str, job: Job) -> Transcript {
    reader(
        source,
        large::State::pending(job, false, Palette::default()),
    )
}
fn state(view: &Transcript) -> &large::State {
    view.blocks[&key()].large.as_ref().unwrap()
}
fn shell_frame(visible: &mut Transcript, hidden: &mut Transcript, show_hidden: bool) {
    let _frame = frame_work::begin();
    Terminal::new(TestBackend::new(48, 8))
        .unwrap()
        .draw(|frame| {
            visible.draw(frame, frame.area(), false).unwrap();
            if show_hidden {
                hidden.draw(frame, frame.area(), false).unwrap();
            }
        })
        .unwrap();
    hidden.finish_layout_frame();
    visible.finish_layout_frame();
}

#[test]
fn frame_end_cancels_hidden_queued_input_without_cancelling_visible_work() {
    let size = large::INLINE_BYTES + 1;
    let lane = Lane::new(size);
    let visible_source = "v".repeat(size);
    let hidden_source = "h".repeat(size);
    let visible_job = lane.submit(&visible_source).unwrap();
    assert_eq!(lane.starts.recv().unwrap(), 'v');
    let hidden_job = lane.submit(&hidden_source).unwrap();
    let hidden_pending = Arc::downgrade(hidden_job.pending.as_ref().unwrap());
    let mut visible = pending(&visible_source, visible_job);
    let mut hidden = pending(&hidden_source, hidden_job);
    shell_frame(&mut visible, &mut hidden, true);
    assert_eq!(state(&hidden).bytes(), size + OVERHEAD);
    assert_eq!(lane.submit(&hidden_source).err(), Some(Admission::Busy));

    shell_frame(&mut visible, &mut hidden, false);
    assert_eq!(state(&visible).bytes(), size + OVERHEAD);
    assert_eq!(state(&hidden).bytes(), 0);
    assert!(hidden_pending.upgrade().is_none());
    assert_eq!(
        lane.used(),
        size + 2 * OVERHEAD,
        "cancelled queue node remains charged"
    );

    let probe = lane.submit("p").unwrap();
    drop(visible);
    lane.release.send(()).unwrap();
    assert_eq!(
        lane.starts.recv().unwrap(),
        'p',
        "cancelled input never executes"
    );
    assert_eq!(lane.used(), 1 + OVERHEAD);
    lane.finish_probe(probe);
}

#[test]
fn frame_end_releases_hidden_unread_output_and_unblocks_visible_admission() {
    let size = large::INLINE_BYTES + 1;
    let lane = Lane::new(size);
    let hidden_source = "h".repeat(size);
    let visible_source = "v".repeat(size);
    let hidden_job = lane.submit(&hidden_source).unwrap();
    assert_eq!(lane.starts.recv().unwrap(), 'h');
    let visible_job = lane.submit(&visible_source).unwrap();
    let mut hidden = pending(&hidden_source, hidden_job);
    let mut visible = pending(&visible_source, visible_job);
    shell_frame(&mut visible, &mut hidden, true);
    lane.release.send(()).unwrap();
    assert_eq!(lane.starts.recv().unwrap(), 'v');
    assert_eq!(state(&hidden).bytes(), lane.output_bytes);
    assert_eq!(lane.submit(&visible_source).err(), Some(Admission::Busy));

    shell_frame(&mut visible, &mut hidden, false);
    assert_eq!(state(&visible).bytes(), size + OVERHEAD);
    assert_eq!(state(&hidden).bytes(), 0);
    assert_eq!(lane.used(), size + OVERHEAD);
    let probe = lane.submit(&"p".repeat(size)).unwrap();
    drop(visible);
    lane.release.send(()).unwrap();
    assert_eq!(lane.starts.recv().unwrap(), 'p');
    assert_eq!(lane.used(), size + OVERHEAD);
    lane.finish_probe(probe);
}

#[test]
fn hidden_reader_keeps_completed_document_semantics_and_measured_geometry() {
    let source = "retained line\n".repeat(1000);
    let document = Document::plain(&source).unwrap();
    let semantic = document.shared_text();
    let mut prepared = large::State::prepared(document, false, Palette::default());
    {
        let _frame = frame_work::begin();
        prepared.advance(48, Request::Rows(0..2)).unwrap();
    }
    assert!(!prepared.lines().is_empty());
    let mut hidden = reader(&source, prepared);
    hidden.blocks.get_mut(&key()).unwrap().semantic = Some(semantic.clone());
    let (bytes, origin, lines) = (
        state(&hidden).bytes(),
        state(&hidden).origin(),
        state(&hidden).lines().len(),
    );
    {
        let _frame = frame_work::begin();
        hidden.finish_layout_frame();
    }
    assert_eq!(state(&hidden).bytes(), bytes);
    assert_eq!(state(&hidden).origin(), origin);
    assert_eq!(state(&hidden).lines().len(), lines);
    assert!(Arc::ptr_eq(
        &semantic,
        &state(&hidden).shared_text().unwrap()
    ));
    assert!(Arc::ptr_eq(
        &semantic,
        hidden.blocks[&key()].semantic.as_ref().unwrap()
    ));
}
