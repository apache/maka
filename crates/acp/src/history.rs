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

use crate::Error;
use maka_client::{
    Client,
    transcript::{TranscriptBatch, TranscriptRow},
};
use maka_protocol::subscription::{SubscriptionOpenInput, TranscriptPolicy};
use maka_protocol::transcript::{
    SESSION_TRANSCRIPT_PAGE_MAX_BYTES, SessionTranscriptPageDirection as Direction,
    SessionTranscriptPageInput,
};
use std::collections::HashSet;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_PAGES: usize = 256;

/// Obtain a fresh authoritative fence without starting observation delivery.
pub async fn snapshot(
    client: &Client,
    session: &str,
    after: Option<u64>,
) -> Result<Vec<TranscriptRow>, Error> {
    let opened = client
        .open_subscription(SubscriptionOpenInput {
            session_id: session.into(),
            transcript: TranscriptPolicy::Tail { max_bytes: 16384 },
        })
        .await?;
    let result = match opened.transcript {
        Some(transcript) => {
            read(
                client,
                &opened.subscription_id,
                transcript.durable.through_sequence,
                after,
            )
            .await
        }
        None => Err("Transcript snapshot subscription omitted its bootstrap".into()),
    };
    let closed = client.close_subscription(&opened.subscription_id).await;
    match (result, closed) {
        (Ok(rows), Ok(())) => Ok(rows),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
        (Err(read), Err(close)) => {
            Err(format!("{read}; transcript subscription close also failed: {close}").into())
        }
    }
}

/// Read one announced transcript snapshot. `through` comes from the subscription
/// bootstrap or a transcript watermark notification; None denotes empty history.
/// The limit counts completed pages (the client separately bounds fragment assembly).
pub async fn read(
    client: &Client,
    subscription_id: &str,
    through: Option<u64>,
    after: Option<u64>,
) -> Result<Vec<TranscriptRow>, Error> {
    let direction = if after.is_some() {
        Direction::Newer
    } else {
        Direction::Older
    };
    let mut history = History::new(direction, through, after);
    let mut cursor = None;
    let mut session = None;
    for _ in 0..MAX_PAGES {
        let page = client
            .transcript_page(SessionTranscriptPageInput {
                subscription_id: subscription_id.into(),
                direction,
                through_sequence: through,
                anchor_sequence: if cursor.is_none() { after } else { None },
                cursor,
                max_bytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
            })
            .await?;
        if page.direction != direction
            || page.through_sequence != through
            || session.as_ref().is_some_and(|id| id != &page.session_id)
        {
            return Err("Transcript snapshot changed during history read".into());
        }
        session = Some(page.session_id.clone());
        let batch = client
            .complete_transcript_page(subscription_id, page)
            .await?;
        cursor = history.accept(batch)?;
        if cursor.is_none() {
            return Ok(history.finish());
        }
    }
    Err("ACP transcript exceeds the 256 completed page limit".into())
}

struct History {
    direction: Direction,
    through: Option<u64>,
    edge: Option<u64>,
    bytes: usize,
    cursors: HashSet<String>,
    pages: Vec<Vec<TranscriptRow>>,
}

impl History {
    fn new(direction: Direction, through: Option<u64>, after: Option<u64>) -> Self {
        Self {
            direction,
            through,
            edge: after,
            bytes: 0,
            cursors: HashSet::new(),
            pages: Vec::new(),
        }
    }

    fn accept(&mut self, batch: TranscriptBatch) -> Result<Option<String>, Error> {
        if batch.through_sequence != self.through {
            return Err("Transcript snapshot watermark changed".into());
        }
        if batch.rows.is_empty() && batch.next_cursor.is_some() {
            return Err("Transcript cursor advanced without a complete message".into());
        }
        if batch
            .rows
            .windows(2)
            .any(|rows| rows[0].sequence >= rows[1].sequence)
            || batch
                .rows
                .iter()
                .any(|row| self.through.is_none_or(|through| row.sequence > through))
        {
            return Err("Transcript rows are out of order or outside the snapshot".into());
        }
        if let (Some(first), Some(last)) = (batch.rows.first(), batch.rows.last()) {
            let advances = self.edge.is_none_or(|previous| match self.direction {
                Direction::Newer => first.sequence > previous,
                Direction::Older => last.sequence < previous,
            });
            if !advances {
                return Err("Transcript page overlaps or moves backwards".into());
            }
            self.edge = Some(match self.direction {
                Direction::Newer => last.sequence,
                Direction::Older => first.sequence,
            });
        }
        if batch
            .next_cursor
            .as_ref()
            .is_some_and(|cursor| !self.cursors.insert(cursor.clone()))
        {
            return Err("Transcript cursor repeated".into());
        }
        for row in &batch.rows {
            self.bytes = self
                .bytes
                .checked_add(serde_json::to_vec(&row.value)?.len())
                .filter(|bytes| *bytes <= MAX_BYTES)
                .ok_or("ACP transcript exceeds the 32 MiB history limit")?;
        }
        self.pages.push(batch.rows);
        Ok(batch.next_cursor)
    }

    fn finish(mut self) -> Vec<TranscriptRow> {
        if self.direction == Direction::Older {
            self.pages.reverse();
        }
        self.pages.into_iter().flatten().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(sequences: &[u64], cursor: Option<&str>) -> TranscriptBatch {
        TranscriptBatch {
            rows: sequences
                .iter()
                .map(|sequence| TranscriptRow {
                    sequence: *sequence,
                    value: serde_json::json!({"id":sequence}),
                })
                .collect(),
            next_cursor: cursor.map(str::to_owned),
            through_sequence: Some(100),
        }
    }

    #[test]
    fn older_pages_reverse_page_order_without_reversing_messages() {
        let mut history = History::new(Direction::Older, Some(100), None);
        history.accept(batch(&[30, 40], Some("older"))).unwrap();
        history.accept(batch(&[10, 20], None)).unwrap();
        assert_eq!(
            history
                .finish()
                .iter()
                .map(|row| row.sequence)
                .collect::<Vec<_>>(),
            [10, 20, 30, 40]
        );
    }

    #[test]
    fn pagination_rejects_overlap_cursor_cycles_and_changed_watermarks() {
        let mut history = History::new(Direction::Newer, Some(100), Some(10));
        assert!(history.accept(batch(&[10], Some("a"))).is_err());
        history.accept(batch(&[20], Some("a"))).unwrap();
        assert!(history.accept(batch(&[20, 30], Some("b"))).is_err());
        assert!(history.accept(batch(&[30], Some("a"))).is_err());
        let mut changed = batch(&[40], None);
        changed.through_sequence = Some(101);
        assert!(history.accept(changed).is_err());
    }

    #[test]
    fn incomplete_or_oversized_history_is_an_error_not_a_partial_replay() {
        let mut history = History::new(Direction::Newer, Some(100), None);
        assert!(history.accept(batch(&[], Some("next"))).is_err());
        history.bytes = MAX_BYTES;
        assert!(history.accept(batch(&[1], None)).is_err());
    }
}
