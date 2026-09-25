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

//! Bounded, atomic projection of one mounted public transcript resource.

mod assembly;
mod events;
mod pages;

use assembly::Assembly;
use events::{Change, Replacement};
use maka_plugins::terminal_ui::transcript::{self as wire, Block, Direction, Key, Timing};
use pages::StagedPage;
use std::collections::{HashSet, VecDeque};

const MAX_BUFFERED_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Phase {
    #[default]
    Opening,
    Loading,
    Ready,
    RefreshRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Invalid,
    RevisionGap,
    Fragment,
    CursorLoop,
    ResourceLimit,
    Invalidated,
    NotReady,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Invalid => "Invalid transcript data",
            Self::RevisionGap => "Transcript revisions are not contiguous",
            Self::Fragment => "Invalid transcript fragment sequence",
            Self::CursorLoop => "Transcript pagination did not advance",
            Self::ResourceLimit => "Transcript refresh required: buffer limit reached",
            Self::Invalidated => "Transcript resource expired",
            Self::NotReady => "Transcript resource is not ready",
        })
    }
}

impl std::error::Error for Error {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageResult {
    pub changed: bool,
    pub continuation: Option<String>,
}

#[derive(Default)]
pub(crate) struct Source {
    blocks: VecDeque<Block>,
    timings: Vec<Timing>,
    fence: Option<u64>,
    revision: Option<u64>,
    visible_revision: u64,
    phase: Phase,
    error: Option<Error>,
    older: Option<String>,
    newer: Option<String>,
    following: bool,
    unseen: HashSet<Key>,
    journal: Vec<Change>,
    journal_bytes: usize,
    page: Option<StagedPage>,
    replacement: Option<Replacement>,
    walk_direction: Option<Direction>,
    walk_cursors: HashSet<String>,
}

impl Source {
    pub(crate) fn ready(&mut self, fence: u64) -> Result<(), Error> {
        if self.fence.is_some() || self.phase == Phase::RefreshRequired {
            return self.fail(Error::Invalid);
        }
        self.fence = Some(fence);
        self.revision = Some(fence);
        self.visible_revision = fence;
        self.following = true;
        self.phase = Phase::Loading;
        Ok(())
    }

    pub(crate) fn set_following(&mut self, following: bool) {
        self.following = following;
    }

    pub(crate) fn blocks(&self) -> &VecDeque<Block> {
        &self.blocks
    }

    pub(crate) fn timings(&self) -> &[Timing] {
        &self.timings
    }

    pub(crate) fn older(&self) -> Option<&str> {
        self.older.as_deref()
    }

    pub(crate) fn newer(&self) -> Option<&str> {
        self.newer.as_deref()
    }

    #[cfg(test)]
    pub(crate) fn fence(&self) -> Option<u64> {
        self.fence
    }

    #[cfg(test)]
    pub(crate) fn revision(&self) -> Option<u64> {
        self.revision
    }

    pub(crate) fn phase(&self) -> Phase {
        self.phase
    }

    pub(crate) fn error(&self) -> Option<&Error> {
        self.error.as_ref()
    }

    pub(crate) fn unseen(&self) -> usize {
        self.unseen.len()
    }

    /// Conservative accounting for the enclosing mount budget, including
    /// owned structures and spare allocation capacity as well as wire bytes.
    pub(crate) fn bytes(&self) -> usize {
        let visible = self
            .blocks
            .iter()
            .map(|block| size(block).unwrap_or(wire::MAX_RECORD_BYTES) + 256)
            .sum::<usize>()
            + self
                .timings
                .iter()
                .map(|timing| size(timing).unwrap_or(1024) + 128)
                .sum::<usize>()
            + self.older.as_ref().map_or(0, String::len)
            + self.newer.as_ref().map_or(0, String::len);
        visible
            .saturating_add(self.buffered_bytes())
            .saturating_mul(2)
            .saturating_add(std::mem::size_of::<Self>())
    }

    fn ensure_ready(&self) -> Result<(), Error> {
        if self.fence.is_none() || self.phase == Phase::RefreshRequired {
            return Err(self.error.unwrap_or(Error::NotReady));
        }
        Ok(())
    }

    fn buffered_bytes(&self) -> usize {
        self.journal_bytes
            + self.page.as_ref().map_or(0, StagedPage::bytes)
            + self
                .replacement
                .as_ref()
                .map_or(0, |value| value.assembly.bytes())
            + self
                .walk_cursors
                .iter()
                .map(|value| value.len() + 64)
                .sum::<usize>()
            + self
                .unseen
                .iter()
                .map(|key| key.turn.len() + key.message.len() + 128)
                .sum::<usize>()
    }

    fn budget(&self, additional: usize) -> Result<(), Error> {
        if self.buffered_bytes().saturating_add(additional) > MAX_BUFFERED_BYTES {
            Err(Error::ResourceLimit)
        } else {
            Ok(())
        }
    }

    fn fail<T>(&mut self, error: Error) -> Result<T, Error> {
        self.phase = Phase::RefreshRequired;
        self.error = Some(error);
        self.page = None;
        self.replacement = None;
        self.journal.clear();
        self.journal_bytes = 0;
        self.walk_cursors.clear();
        Err(error)
    }
}

fn size(value: &impl serde::Serialize) -> Result<usize, Error> {
    serde_json::to_vec(value)
        .map(|value| value.len())
        .map_err(|_| Error::Invalid)
}

/// Keep complete logical pages so opaque adjacent cursors cannot skip an
/// evicted portion of a page. Live overflow needs a newly fenced resource.
fn window(blocks: &VecDeque<Block>) -> Result<(), Error> {
    if blocks.len() > wire::MAX_RECORDS {
        return Err(Error::ResourceLimit);
    }
    let total = blocks.iter().try_fold(0usize, |total, block| {
        size(block).map(|bytes| total.saturating_add(bytes))
    })?;
    if total > wire::MAX_RECORD_BYTES || total > wire::MAX_WINDOW_BYTES && blocks.len() > 1 {
        return Err(Error::ResourceLimit);
    }
    Ok(())
}

fn retain_timings(blocks: &VecDeque<Block>, timings: &mut Vec<Timing>) {
    let mut seen = HashSet::new();
    *timings = blocks
        .iter()
        .filter_map(|block| {
            if !seen.insert(&block.key.turn) {
                return None;
            }
            timings
                .iter()
                .find(|timing| timing.turn == block.key.turn)
                .cloned()
        })
        .collect();
}

fn set_timing(timings: &mut Vec<Timing>, timing: Timing) {
    if let Some(value) = timings.iter_mut().find(|value| value.turn == timing.turn) {
        *value = timing;
    } else {
        timings.push(timing);
    }
}

#[cfg(test)]
mod tests;
