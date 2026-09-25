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

pub(super) struct Replacement {
    base: u64,
    revision: u64,
    append: bool,
    pub(super) assembly: Assembly,
}

pub(super) struct Change {
    pub(super) revision: u64,
    pub(super) update: Update,
}

pub(super) enum Update {
    Replace {
        block: Block,
        append: bool,
    },
    Append {
        key: Key,
        base: String,
        revision: String,
        offset: usize,
        text: String,
    },
    Remove(Key),
    Timing(Timing),
}

impl Update {
    fn key(&self) -> Option<&Key> {
        match self {
            Self::Replace { block, .. } => Some(&block.key),
            Self::Append { key, .. } | Self::Remove(key) => Some(key),
            Self::Timing(_) => None,
        }
    }

    fn bytes(&self) -> Result<usize, Error> {
        Ok(2 * std::mem::size_of::<Change>()
            + match self {
                Self::Replace { block, .. } => size(block)?,
                Self::Append {
                    key,
                    base,
                    revision,
                    text,
                    ..
                } => size(key)? + base.len() + revision.len() + text.len(),
                Self::Remove(key) => size(key)?,
                Self::Timing(timing) => size(timing)?,
            })
    }

    pub(super) fn apply(&self, blocks: &mut VecDeque<Block>, insert: bool) -> Result<(), Error> {
        let index = self
            .key()
            .and_then(|key| blocks.iter().position(|block| &block.key == key));
        match self {
            Self::Replace { block, append } => {
                if let Some(index) = index {
                    blocks[index] = block.clone();
                } else if insert && *append {
                    blocks.push_back(block.clone());
                }
            }
            Self::Append {
                base,
                revision,
                offset,
                text,
                ..
            } => {
                if let Some(index) = index {
                    let block = &mut blocks[index];
                    if block.revision != *base || block.content.text.len() != *offset {
                        return Err(Error::RevisionGap);
                    }
                    block.content.text.push_str(text);
                    block.revision.clone_from(revision);
                    block.validate().map_err(|_| Error::Invalid)?;
                }
            }
            Self::Remove(_) => {
                if let Some(index) = index {
                    blocks.remove(index);
                }
            }
            Self::Timing(_) => {}
        }
        Ok(())
    }
}

impl Source {
    pub(crate) fn event(&mut self, event: wire::Event, following: bool) -> Result<bool, Error> {
        self.following = following;
        match self.accept_event(event) {
            Ok(changed) => Ok(changed),
            Err(error) => self.fail(error),
        }
    }

    fn accept_event(&mut self, event: wire::Event) -> Result<bool, Error> {
        event.validate().map_err(|_| Error::Invalid)?;
        match event {
            wire::Event::Ready { fence } => {
                self.ready(fence)?;
                return Ok(false);
            }
            wire::Event::Invalidated => return Err(Error::Invalidated),
            _ => {}
        }
        self.ensure_ready()?;
        let (base, revision, update) = match event {
            wire::Event::Replace {
                base,
                revision,
                append,
                record,
            } => {
                if Some(base) != self.revision {
                    return Err(Error::RevisionGap);
                }
                let mut pending = self.replacement.take().unwrap_or(Replacement {
                    base,
                    revision,
                    append,
                    assembly: Assembly::default(),
                });
                if (base, revision, append) != (pending.base, pending.revision, pending.append) {
                    return Err(Error::Fragment);
                }
                let block = pending.assembly.push(record)?;
                self.budget(pending.assembly.bytes())?;
                let Some(block) = block else {
                    self.replacement = Some(pending);
                    return Ok(false);
                };
                (base, revision, Update::Replace { block, append })
            }
            wire::Event::Append {
                base,
                revision,
                key,
                block_base,
                block_revision,
                offset,
                text,
            } => (
                base,
                revision,
                Update::Append {
                    key,
                    base: block_base,
                    revision: block_revision,
                    offset,
                    text,
                },
            ),
            wire::Event::Remove {
                base,
                revision,
                key,
            } => (base, revision, Update::Remove(key)),
            wire::Event::Timing {
                base,
                revision,
                timing,
            } => (base, revision, Update::Timing(timing)),
            wire::Event::Ready { .. } | wire::Event::Invalidated => return Err(Error::Invalid),
        };
        if self.replacement.is_some() {
            return Err(Error::Fragment);
        }
        if Some(base) != self.revision {
            return Err(Error::RevisionGap);
        }
        self.validate_known(&update)?;
        let bytes = update.bytes()?;
        let live = self.phase == Phase::Ready && self.page.is_none();
        let insert = self.following && self.newer.is_none() && self.unseen.is_empty();
        let unseen_bytes = match &update {
            Update::Replace {
                block,
                append: true,
            } if (!live || !insert) && !self.unseen.contains(&block.key) => {
                block.key.turn.len() + block.key.message.len() + 128
            }
            _ => 0,
        };
        self.budget(bytes + unseen_bytes)?;
        let mut blocks = self.blocks.clone();
        let mut timings = self.timings.clone();
        if live {
            update.apply(&mut blocks, insert)?;
            if let Update::Replace { block, .. } = &update
                && let Some(timing) =
                    self.journal
                        .iter()
                        .rev()
                        .find_map(|change| match &change.update {
                            Update::Timing(timing) if timing.turn == block.key.turn => Some(timing),
                            _ => None,
                        })
            {
                set_timing(&mut timings, timing.clone());
            }
            if let Update::Timing(timing) = &update {
                set_timing(&mut timings, timing.clone());
            }
            window(&blocks)?;
            retain_timings(&blocks, &mut timings);
        }
        let changed = blocks != self.blocks || timings != self.timings;
        match &update {
            Update::Replace {
                block,
                append: true,
            } if !live || !insert => {
                self.unseen.insert(block.key.clone());
            }
            Update::Remove(key) => {
                self.unseen.remove(key);
            }
            _ => {}
        }
        self.journal.push(Change { revision, update });
        self.journal_bytes += bytes;
        self.revision = Some(revision);
        if live {
            self.blocks = blocks;
            self.timings = timings;
            self.visible_revision = revision;
        }
        Ok(changed)
    }

    /// An offscreen append must still be checked when a prior replacement gave
    /// us its base. Otherwise retain it for validation against the fenced page.
    fn validate_known(&self, update: &Update) -> Result<(), Error> {
        let Update::Append { key, .. } = update else {
            return Ok(());
        };
        let known = self.blocks.iter().find(|block| &block.key == key).cloned();
        let since = if known.is_some() {
            self.visible_revision
        } else {
            self.fence.unwrap_or(0)
        };
        let mut blocks: VecDeque<Block> = known.into_iter().collect();
        let mut removed = false;
        for change in self.journal.iter().filter(|change| change.revision > since) {
            if change.update.key() != Some(key) {
                continue;
            }
            match &change.update {
                Update::Replace { block, .. } => {
                    blocks.clear();
                    blocks.push_back(block.clone());
                    removed = false;
                }
                Update::Remove(_) => {
                    blocks.clear();
                    removed = true;
                }
                _ => change.update.apply(&mut blocks, false)?,
            }
        }
        if removed {
            return Err(Error::RevisionGap);
        }
        update.apply(&mut blocks, false)
    }
}
