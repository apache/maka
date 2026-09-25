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

use super::{events::Update, *};

pub(super) struct StagedPage {
    direction: Direction,
    records: VecDeque<Block>,
    timings: Vec<Timing>,
    assembly: Assembly,
    cursors: HashSet<String>,
    bytes: usize,
}

impl StagedPage {
    pub(super) fn bytes(&self) -> usize {
        self.bytes
            + self.assembly.bytes()
            + self
                .cursors
                .iter()
                .map(|cursor| cursor.len() + 64)
                .sum::<usize>()
    }

    fn push(&mut self, page: &mut wire::Page) -> Result<(), Error> {
        for record in page.records.drain(..) {
            if let Some(block) = self.assembly.push(record)? {
                if self.records.iter().any(|value| value.key == block.key) {
                    return Err(Error::Invalid);
                }
                self.bytes += size(&block)?;
                self.records.push_back(block);
            }
            if self.records.len() + usize::from(self.assembly.pending()) > wire::MAX_RECORDS {
                return Err(Error::ResourceLimit);
            }
        }
        for timing in page.timings.drain(..) {
            if let Some(previous) = self.timings.iter().find(|value| value.turn == timing.turn) {
                if previous != &timing {
                    return Err(Error::Invalid);
                }
            } else {
                self.bytes += size(&timing)?;
                self.timings.push(timing);
            }
        }
        if self.timings.len() > wire::MAX_RECORDS {
            return Err(Error::ResourceLimit);
        }
        Ok(())
    }
}

impl Source {
    pub(crate) fn page(
        &mut self,
        direction: Direction,
        page: wire::Page,
    ) -> Result<PageResult, Error> {
        match self.accept_page(direction, page) {
            Ok(result) => Ok(result),
            Err(error) => self.fail(error),
        }
    }

    fn accept_page(
        &mut self,
        direction: Direction,
        mut page: wire::Page,
    ) -> Result<PageResult, Error> {
        self.ensure_ready()?;
        page.validate().map_err(|_| Error::Invalid)?;
        if Some(page.fence) != self.fence {
            return Err(Error::RevisionGap);
        }
        let mut staged = match self.page.take() {
            Some(staged) if direction == Direction::Continue || direction == staged.direction => {
                staged
            }
            Some(_) => return Err(Error::Invalid),
            None if direction == Direction::Continue => return Err(Error::Invalid),
            None => {
                let cursor = match direction {
                    Direction::Older => Some(self.older.clone().ok_or(Error::Invalid)?),
                    Direction::Newer => Some(self.newer.clone().ok_or(Error::Invalid)?),
                    Direction::Tail => None,
                    Direction::Continue => return Err(Error::Invalid),
                };
                if self.walk_direction != Some(direction) || direction == Direction::Tail {
                    self.walk_cursors.clear();
                    self.walk_direction = Some(direction);
                }
                if let Some(cursor) = cursor
                    && !self.walk_cursors.insert(cursor)
                {
                    return Err(Error::CursorLoop);
                }
                StagedPage {
                    direction,
                    records: VecDeque::new(),
                    timings: Vec::new(),
                    assembly: Assembly::default(),
                    cursors: HashSet::new(),
                    bytes: 0,
                }
            }
        };
        staged.push(&mut page)?;
        if let Some(cursor) = &page.continuation
            && !staged.cursors.insert(cursor.clone())
        {
            return Err(Error::CursorLoop);
        }
        self.budget(staged.bytes())?;
        if page.continuation.is_some() {
            self.page = Some(staged);
            self.phase = Phase::Loading;
            return Ok(PageResult {
                changed: false,
                continuation: page.continuation,
            });
        }
        if staged.assembly.pending() {
            return Err(Error::Fragment);
        }
        let adjacent = match staged.direction {
            Direction::Older => &page.older,
            Direction::Newer => &page.newer,
            _ => &None,
        };
        if adjacent
            .as_ref()
            .is_some_and(|cursor| self.walk_cursors.contains(cursor))
        {
            return Err(Error::CursorLoop);
        }
        window(&staged.records)?;
        let at_tail = staged.direction == Direction::Tail
            || staged.direction == Direction::Newer && page.newer.is_none() && self.following;
        let overhead = staged
            .timings
            .iter()
            .map(size)
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .sum::<usize>()
            + staged
                .cursors
                .iter()
                .map(|cursor| cursor.len() + 64)
                .sum::<usize>();
        for change in &self.journal {
            change.update.apply(&mut staged.records, at_tail)?;
            let bytes = staged.records.iter().try_fold(0usize, |bytes, block| {
                size(block).map(|size| bytes.saturating_add(size))
            })?;
            self.budget(bytes + overhead)?;
        }
        for change in &self.journal {
            if let Update::Timing(timing) = &change.update
                && staged
                    .records
                    .iter()
                    .any(|block| block.key.turn == timing.turn)
            {
                set_timing(&mut staged.timings, timing.clone());
            }
        }
        window(&staged.records)?;
        retain_timings(&staged.records, &mut staged.timings);
        let changed = self.blocks != staged.records || self.timings != staged.timings;
        self.blocks = staged.records;
        self.timings = staged.timings;
        self.older = page.older;
        self.newer = page.newer;
        self.visible_revision = self.revision.ok_or(Error::NotReady)?;
        self.phase = Phase::Ready;
        if at_tail {
            self.unseen.clear();
        }
        Ok(PageResult {
            changed,
            continuation: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{block, page, replace};
    use super::*;

    #[test]
    fn replay_limits_the_final_window_after_post_fence_deletions() {
        let mut source = Source::default();
        source.ready(10).unwrap();
        let count = wire::MAX_RECORDS + 1;
        for index in 0..count {
            source
                .event(
                    replace(
                        10 + index as u64,
                        block(&format!("m-{index}"), "r1", "x"),
                        true,
                    ),
                    false,
                )
                .unwrap();
        }
        for index in 0..2 {
            let base = 10 + count as u64 + index as u64;
            source
                .event(
                    wire::Event::Remove {
                        base,
                        revision: base + 1,
                        key: block(&format!("m-{index}"), "r1", "x").key,
                    },
                    false,
                )
                .unwrap();
        }
        source
            .page(Direction::Tail, page(vec![], None, None))
            .unwrap();
        assert_eq!(source.blocks().len(), wire::MAX_RECORDS - 1);
        assert_eq!(source.blocks().front().unwrap().key.message, "m-2");
        assert_eq!(source.unseen(), 0);
    }
}
