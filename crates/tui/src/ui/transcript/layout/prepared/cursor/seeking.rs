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

use super::super::seeking::{Probe, Seek, Target};
use super::*;
impl Cursor {
    pub fn request_tail(&mut self, rows: usize) {
        self.start_seek(Target::Tail, 0, rows);
    }
    pub fn request_logical(&mut self, offset: usize, before: usize, rows: usize) {
        if offset > self.document.text().len() {
            self.seek = None;
            self.seek_status = SeekStatus::Missing;
            return;
        }
        self.start_seek(
            Target::Logical {
                offset,
                end: offset == self.document.text().len(),
            },
            before,
            rows,
        );
    }
    pub fn request_source(&mut self, source: Range<usize>, before: usize, rows: usize) {
        self.start_seek(Target::Source(source), before, rows);
    }
    pub fn seek_status(&self) -> SeekStatus {
        self.seek_status
    }
    fn start_seek(&mut self, target: Target, before: usize, rows: usize) {
        self.seek_status = SeekStatus::Pending;
        self.seek = Some(Seek {
            target: target.clone(),
            before,
            rows: rows.max(1),
            window_row: None,
        });
        let point = match target {
            Target::Logical { offset, .. } => self
                .checkpoints
                .iter()
                .rev()
                .find(|point| point.logical_len <= offset),
            Target::Tail => self.checkpoints.last(),
            Target::Source(_) => self.checkpoints.first(),
        }
        .unwrap()
        .clone();
        self.window = 0..0;
        self.restore(point);
        if !matches!(target, Target::Tail) {
            self.writer.probe = Some(Probe::new(target));
        }
        self.update_seek();
    }
    pub(in super::super) fn begin_probe(&mut self, probe: Probe) {
        let point = match probe.target {
            Target::Logical { offset, .. } => self
                .checkpoints
                .iter()
                .rev()
                .find(|point| point.logical_len <= offset),
            _ => self.checkpoints.first(),
        }
        .unwrap()
        .clone();
        self.window = 0..0;
        self.restore(point);
        self.writer.probe = Some(probe);
        self.seek = None;
        self.seek_status = SeekStatus::Idle;
    }
    pub(super) fn update_seek(&mut self) {
        let Some(seek) = &self.seek else {
            return;
        };
        if let Some(row) = seek.window_row {
            if self.complete || self.writer.solid_rows >= self.window.end {
                self.seek_status = SeekStatus::Ready { row };
            }
            return;
        }
        let mut row = self.writer.probe.as_ref().and_then(|probe| probe.found);
        if row.is_none() && self.complete {
            row = match seek.target {
                Target::Tail => Some(self.height.unwrap().saturating_sub(1)),
                Target::Source(_) => Some(
                    self.writer
                        .probe
                        .as_ref()
                        .and_then(|probe| probe.fallback)
                        .map_or(0, |(_, row)| row),
                ),
                Target::Logical { offset: 0, .. } if self.document.text().is_empty() => Some(0),
                _ => None,
            };
            if row.is_none() {
                self.seek_status = SeekStatus::Missing;
                return;
            }
        }
        // Exact height from an earlier window makes a tail request immediately locatable.
        if matches!(seek.target, Target::Tail)
            && let Some(height) = self.height
        {
            row = Some(height.saturating_sub(1));
        }
        let Some(mut row) = row else {
            return;
        };
        if let Some(height) = self.height {
            row = row.min(height.saturating_sub(1));
        }
        let start = if matches!(seek.target, Target::Tail) {
            row.saturating_add(1).saturating_sub(seek.rows)
        } else {
            row.saturating_sub(seek.before)
        };
        let end = start
            .saturating_add(seek.rows)
            .min(self.height.unwrap_or(usize::MAX));
        self.seek.as_mut().unwrap().window_row = Some(row);
        self.request_window(start..end);
    }
}
