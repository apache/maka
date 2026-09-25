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

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub first: u64,
    pub last: u64,
    pub through: u64,
    pub older: bool,
}

pub(super) struct Saved {
    pub range: Option<Window>,
    pub view: render::reading::Reading,
}

/// Newest entries survive the bounded disk bookmark cache; drafts are separate.
pub const DISK_BUDGET: usize = 4 * 1024 * 1024;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    range: Option<Window>,
    view: render::reading::saved::Saved,
}
impl Checkpoint {
    pub fn bytes(&self) -> usize {
        self.view.bytes() + 128
    }
    pub fn valid(&self) -> bool {
        self.view.valid()
            && self.range.is_none_or(|range| {
                range.first > 0
                    && range.first <= range.last
                    && range.last <= range.through
                    && range.through <= 9_007_199_254_740_991
            })
    }
}

impl Chat {
    pub fn checkpoints(&self) -> Vec<(String, Checkpoint)> {
        let active = self.session.as_ref().map(|id| {
            (
                id.clone(),
                Checkpoint {
                    range: self.reading_range(),
                    view: self.view.saved_reading(),
                },
            )
        });
        let saved = self
            .readings
            .iter()
            .rev()
            .filter(|(id, _)| Some(id) != self.session.as_ref())
            .map(|(id, reading)| {
                (
                    id.clone(),
                    Checkpoint {
                        range: reading.range,
                        view: reading.view.saved(),
                    },
                )
            });
        let mut bytes = 0;
        let mut retained = Vec::new();
        for (id, reading) in active.into_iter().chain(saved) {
            let size = id.len() * 2 + reading.bytes();
            if reading.valid()
                && size <= DISK_BUDGET - bytes
                && retained.len() < crate::navigation::tabs::LIMIT
            {
                bytes += size;
                retained.push((id, reading));
            }
        }
        retained.reverse();
        retained
    }
    pub fn restore_checkpoints(&mut self, checkpoints: Vec<(String, Checkpoint)>) {
        self.readings = checkpoints
            .into_iter()
            .map(|(id, reading)| {
                (
                    id,
                    Saved {
                        range: reading.range,
                        view: reading.view.restore(),
                    },
                )
            })
            .collect();
    }
}

impl Chat {
    fn reading_range(&self) -> Option<Window> {
        if self.snapshot.is_none() {
            self.restore_range
        } else if !self.view.following()
            && !self.view.anchored_to(
                self.live
                    .iter()
                    .map(|(id, _)| presentation::live_key(id))
                    .collect::<Vec<_>>()
                    .iter(),
            )
        {
            self.rows
                .first_key_value()
                .zip(self.rows.last_key_value())
                .map(|((first, _), (last, _))| Window {
                    first: *first,
                    last: *last,
                    // Log watermarks include events that are not transcript rows.
                    through: self.through.unwrap_or(*last),
                    older: self.older.is_some(),
                })
        } else {
            None
        }
    }
    pub(super) fn save_reading(&mut self) {
        let Some(id) = self.session.clone() else {
            return;
        };
        let range = self.reading_range();
        let view = self.view.take_reading();
        self.readings.retain(|(key, _)| key != &id);
        self.readings.push_back((id, Saved { range, view }));
        while self.readings.len() > crate::navigation::tabs::LIMIT {
            self.readings.pop_front();
        }
        while self
            .readings
            .iter()
            .map(|(id, saved)| id.len() + saved.view.bytes())
            .sum::<usize>()
            > 16 * 1024 * 1024
        {
            self.readings.pop_front();
        }
    }
}

/// Restore only the formerly loaded, immutable interval. No old subscription
/// token survives; later messages are available via the fresh observation.
pub(super) async fn restore(
    client: &Client,
    subscription: &str,
    range: Window,
) -> Result<TranscriptBatch, Error> {
    let mut rows = Vec::new();
    let mut cursor = None;
    let mut bytes = 0;
    for _ in 0..16 {
        let page = client
            .transcript_page(SessionTranscriptPageInput {
                subscription_id: subscription.into(),
                direction: SessionTranscriptPageDirection::Newer,
                through_sequence: Some(range.through),
                anchor_sequence: if cursor.is_none() {
                    range.first.checked_sub(1)
                } else {
                    None
                },
                cursor: cursor.clone(),
                max_bytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
            })
            .await?;
        let batch = client.complete_transcript_page(subscription, page).await?;
        for row in batch.rows {
            bytes += serde_json::to_vec(&row.value)?.len();
            rows.push(row);
        }
        if rows.len() > WINDOW_ROWS || (rows.len() > 1 && bytes > WINDOW_BYTES) {
            return Err("Restored reading window exceeds local capacity".into());
        }
        cursor = batch.next_cursor;
        if cursor.is_none() {
            if rows.first().map(|row| row.sequence) != Some(range.first)
                || rows.last().map(|row| row.sequence) != Some(range.last)
            {
                return Err("Saved reading window is no longer available".into());
            }
            return Ok(TranscriptBatch {
                rows,
                next_cursor: None,
                through_sequence: Some(range.through),
            });
        }
    }
    Err("Reading window restore exceeded page budget".into())
}
