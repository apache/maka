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

//! Joining a terminal's live output to the snapshot an acquire answers, as
//! Maka Desktop does (`SessionTerminalHydration` in
//! `apps/desktop/src/renderer/features/workbar/tools/terminal/session-terminal-hydration.ts`).
//!
//! Output chunks carry `ptySequence`, one more per chunk; the snapshot names
//! the sequence of the last chunk its buffer holds. Chunks that arrive
//! while the acquire is in flight wait; once it answers, those after the
//! snapshot follow it in order. A gap means the Host dropped a chunk (it
//! drops frames over its size limit silently and collapses an overfull
//! queue into `reset`), and only a new snapshot repairs the picture.

/// Chunks that may wait for an acquire's answer before a new snapshot is
/// cheaper (`session-terminal-hydration.ts`, `accept`).
pub(crate) const MAX_PENDING_CHUNKS: usize = 128;
/// Bytes of chunks that may wait for an acquire's answer.
pub(crate) const MAX_PENDING_BYTES: usize = 256 * 1024;

/// What to do with a chunk of output.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Accepted {
    /// Write it to the emulator now.
    Apply(String),
    /// Nothing: already in the picture, or kept until the acquire answers.
    Hold,
    /// The output has a gap: acquire again for a new snapshot.
    Resync,
}

/// The output state of one attach.
#[derive(Debug, Default)]
pub(crate) struct Hydration {
    /// The snapshot is in the emulator; chunks apply as they come.
    attached: bool,
    /// The sequence of the last chunk in the emulator.
    last: u64,
    /// Chunks received before the snapshot, unordered.
    pending: Vec<(u64, String)>,
    pending_bytes: usize,
    /// The output can no longer be joined: chunks are dropped until the next
    /// acquire begins.
    needs_snapshot: bool,
}

impl Hydration {
    /// An acquire is about to be sent: chunks wait for its snapshot.
    pub(crate) fn begin(&mut self) {
        *self = Self::default();
    }

    /// The output can no longer be joined to the picture (a gap, a `reset`
    /// frame, a lost subscription): whatever answers next is not committed,
    /// and chunks are dropped until the next [`Self::begin`].
    pub(crate) fn invalidate(&mut self) {
        self.attached = false;
        self.needs_snapshot = true;
        self.pending.clear();
        self.pending_bytes = 0;
    }

    pub(crate) fn accept(&mut self, sequence: u64, data: &str) -> Accepted {
        if self.needs_snapshot || sequence <= self.last {
            return Accepted::Hold;
        }
        if !self.attached {
            let bytes = self.pending_bytes + data.len();
            if self.pending.len() >= MAX_PENDING_CHUNKS || bytes > MAX_PENDING_BYTES {
                self.invalidate();
                return Accepted::Resync;
            }
            self.pending.push((sequence, data.to_owned()));
            self.pending_bytes = bytes;
            return Accepted::Hold;
        }
        if sequence != self.last + 1 {
            self.invalidate();
            return Accepted::Resync;
        }
        self.last = sequence;
        Accepted::Apply(data.to_owned())
    }

    /// The acquire answered with a snapshot through `sequence`: the chunks
    /// that follow it, in order, to write after its buffer; `None` when the
    /// output since was invalidated or has a gap, and a new acquire is due.
    pub(crate) fn commit(&mut self, sequence: u64) -> Option<Vec<String>> {
        if self.needs_snapshot {
            return None;
        }
        let mut pending = std::mem::take(&mut self.pending);
        self.pending_bytes = 0;
        pending.sort_by_key(|(sequence, _)| *sequence);
        self.last = sequence;
        let mut replay = Vec::new();
        for (chunk_sequence, data) in pending {
            if chunk_sequence <= self.last {
                continue;
            }
            if chunk_sequence != self.last + 1 {
                self.invalidate();
                return None;
            }
            self.last = chunk_sequence;
            replay.push(data);
        }
        self.attached = true;
        Some(replay)
    }

    #[cfg(test)]
    pub(crate) fn is_attached(&self) -> bool {
        self.attached
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_after_the_snapshot_follow_it_and_duplicates_are_dropped() {
        let mut hydration = Hydration::default();
        hydration.begin();
        assert_eq!(hydration.accept(4, "d"), Accepted::Hold);
        assert_eq!(hydration.accept(3, "c"), Accepted::Hold);
        assert_eq!(hydration.accept(2, "b"), Accepted::Hold);
        assert_eq!(hydration.commit(2), Some(vec!["c".to_owned(), "d".to_owned()]));
        assert_eq!(hydration.accept(4, "d"), Accepted::Hold, "already written");
        assert_eq!(hydration.accept(5, "e"), Accepted::Apply("e".into()));
    }

    #[test]
    fn a_gap_live_or_before_the_snapshot_asks_for_a_new_one() {
        let mut hydration = Hydration::default();
        hydration.begin();
        assert_eq!(hydration.commit(10), Some(Vec::new()));
        assert_eq!(hydration.accept(12, "x"), Accepted::Resync);
        assert_eq!(hydration.accept(13, "y"), Accepted::Hold, "dropped until the next acquire");

        hydration.begin();
        assert_eq!(hydration.accept(14, "z"), Accepted::Hold);
        assert_eq!(hydration.commit(12), None, "13 is missing");
    }

    #[test]
    fn a_long_wait_for_the_snapshot_gives_up_on_its_backlog() {
        let mut hydration = Hydration::default();
        hydration.begin();
        for sequence in 1..=MAX_PENDING_CHUNKS as u64 {
            assert_eq!(hydration.accept(sequence, "x"), Accepted::Hold);
        }
        assert_eq!(hydration.accept(129, "x"), Accepted::Resync);
        assert_eq!(hydration.commit(1), None);

        hydration.begin();
        assert_eq!(hydration.accept(1, &"x".repeat(MAX_PENDING_BYTES)), Accepted::Hold);
        assert_eq!(hydration.accept(2, "x"), Accepted::Resync);
    }

    #[test]
    fn an_invalidated_attach_commits_nothing() {
        let mut hydration = Hydration::default();
        hydration.begin();
        hydration.invalidate();
        assert_eq!(hydration.commit(1), None);
        assert!(!hydration.is_attached());
    }
}
