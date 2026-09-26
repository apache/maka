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
impl State {
    pub(super) fn measure(
        &mut self,
        budget: usize,
        progress: &mut Progress,
    ) -> Result<bool, &'static str> {
        if self.at == self.table.cells.len() {
            if self.phase == Phase::Preferred {
                self.arrange();
                self.phase = Phase::Measure;
                self.at = 0;
            } else {
                self.phase = Phase::Ready;
            }
            progress.work += 1;
            return Ok(true);
        }
        let column = self.at % self.table.columns;
        if self.phase == Phase::Preferred && self.preferred[column] >= self.widths[column] {
            self.at += 1;
            progress.work += 1;
            return Ok(true);
        }
        if self.active.is_none() {
            self.active = Some(
                self.table.cells[self.at]
                    .document
                    .cursor(self.widths[column] as u16, 0..0),
            );
        }
        let cursor = self.active.as_mut().unwrap();
        let step = cursor.advance(budget)?;
        progress.work += step.work;
        progress.bytes += step.bytes;
        if !step.complete {
            return Ok(false);
        }
        let cursor = self.active.take().unwrap();
        if self.phase == Phase::Preferred {
            self.preferred[column] = self.preferred[column].max(cursor.writer.max_cells);
        } else {
            let height = cursor.total_rows().unwrap();
            self.heights.push(height);
            self.sources.push(if self.table.cells[self.at].empty {
                self.table.cells[self.at].source
            } else {
                cursor.writer.last_source
            });
            self.row_max = self.row_max.max(height);
            self.keep(self.at, cursor);
            if column + 1 == self.table.columns {
                let row = self.at / self.table.columns;
                let start = row * self.table.columns;
                let height = if !self.stacked {
                    self.row_max + usize::from(row == 0)
                } else if row == 0 {
                    if self.table.cells.len() == self.table.columns {
                        self.heights[..self.table.columns].iter().sum()
                    } else {
                        0
                    }
                } else {
                    self.heights[..self.table.columns].iter().sum::<usize>()
                        + self.heights[start..start + self.table.columns]
                            .iter()
                            .sum::<usize>()
                        + 1
                };
                self.starts.push(self.height() + height);
                self.row_max = 0;
            }
        }
        self.at += 1;
        Ok(true)
    }
    fn arrange(&mut self) {
        let available = self.width - (self.table.columns - 1) * 3;
        if self
            .preferred
            .iter()
            .map(|size| (*size).min(4))
            .sum::<usize>()
            > available
        {
            self.stacked = true;
            self.widths.fill(self.width);
            return;
        }
        let mut low = 1;
        let mut high = available;
        while low < high {
            let mid = (low + high).div_ceil(2);
            if self
                .preferred
                .iter()
                .map(|size| (*size).min(mid))
                .sum::<usize>()
                <= available
            {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        self.widths = self.preferred.iter().map(|size| (*size).min(low)).collect();
        let mut left = available - self.widths.iter().sum::<usize>();
        for (size, preferred) in self.widths.iter_mut().zip(&self.preferred) {
            if left > 0 && *size < *preferred {
                *size += 1;
                left -= 1;
            }
        }
    }
}
