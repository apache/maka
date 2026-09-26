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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeekStatus {
    Idle,
    Pending,
    Ready { row: usize },
    Missing,
}
#[derive(Clone)]
pub(in super::super) enum Target {
    Source(Range<usize>),
    Logical { offset: usize, end: bool },
    Tail,
}
#[derive(Clone)]
pub(in super::super) struct Probe {
    pub target: Target,
    pub found: Option<usize>,
    pub fallback: Option<(usize, usize)>,
}
impl Probe {
    pub(super) fn new(target: Target) -> Self {
        Self {
            target,
            found: None,
            fallback: None,
        }
    }
    pub(in super::super) fn span(
        &mut self,
        source: &Range<usize>,
        logical: &Range<usize>,
        row: usize,
    ) {
        if logical.is_empty() {
            return;
        }
        let hit = match &self.target {
            Target::Source(target) => source.start < target.end && target.start < source.end,
            Target::Logical { offset, end } => {
                logical.contains(offset) || (*end && logical.end == *offset)
            }
            Target::Tail => false,
        };
        if hit {
            self.found = Some(self.found.map_or(row, |previous| previous.min(row)));
        }
    }
    pub(in super::super) fn logical(&mut self, logical: Range<usize>, row: usize) {
        if let Target::Logical { offset, .. } = self.target
            && logical.contains(&offset)
        {
            self.found = Some(self.found.map_or(row, |previous| previous.min(row)));
        }
    }
    pub(in super::super) fn anchor(&mut self, source: usize, row: usize) {
        if let Target::Source(target) = &self.target
            && source <= target.start
            && self.fallback.is_none_or(|(previous, _)| source > previous)
        {
            self.fallback = Some((source, row));
        }
    }
    pub(super) fn cell(&self, logical: usize, len: usize) -> Option<Self> {
        let target = match &self.target {
            Target::Logical { offset, end } => {
                if *offset < logical || *offset > logical + len {
                    return None;
                }
                Target::Logical {
                    offset: offset - logical,
                    end: *end || *offset == logical + len,
                }
            }
            target => target.clone(),
        };
        Some(Self::new(target))
    }
}
pub(super) struct Seek {
    pub target: Target,
    pub before: usize,
    pub rows: usize,
    pub window_row: Option<usize>,
}
