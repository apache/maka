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

use super::{Block, Error, Key, wire};

#[derive(Default)]
pub(super) struct Assembly {
    pending: Option<Fragment>,
}

struct Fragment {
    key: Key,
    revision: String,
    total: usize,
    json: String,
}

impl Assembly {
    pub(super) fn bytes(&self) -> usize {
        self.pending.as_ref().map_or(0, |value| {
            value.json.capacity()
                + value.key.turn.len()
                + value.key.message.len()
                + value.revision.len()
                + 128
        })
    }

    pub(super) fn pending(&self) -> bool {
        self.pending.is_some()
    }

    pub(super) fn push(&mut self, record: wire::Record) -> Result<Option<Block>, Error> {
        record.validate().map_err(|_| Error::Invalid)?;
        match record {
            wire::Record::Block { block } => {
                if self.pending.is_some() {
                    return Err(Error::Fragment);
                }
                Ok(Some(block))
            }
            wire::Record::Fragment {
                key,
                revision,
                offset,
                total,
                json,
            } => {
                if self.pending.is_none() {
                    if offset != 0 {
                        return Err(Error::Fragment);
                    }
                    self.pending = Some(Fragment {
                        key: key.clone(),
                        revision: revision.clone(),
                        total,
                        json: String::new(),
                    });
                }
                let pending = self.pending.as_mut().ok_or(Error::Fragment)?;
                if pending.key != key
                    || pending.revision != revision
                    || pending.total != total
                    || pending.json.len() != offset
                {
                    return Err(Error::Fragment);
                }
                pending.json.push_str(&json);
                if pending.json.len() != total {
                    return Ok(None);
                }
                let complete = self.pending.take().ok_or(Error::Fragment)?;
                let block: Block =
                    serde_json::from_str(&complete.json).map_err(|_| Error::Invalid)?;
                block.validate().map_err(|_| Error::Invalid)?;
                if block.key != complete.key || block.revision != complete.revision {
                    return Err(Error::Fragment);
                }
                Ok(Some(block))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{block, fragments, page, replace, source};
    use super::super::*;

    #[test]
    fn assembled_identity_and_repeated_fragment_metadata_are_checked() {
        let value = block("a", "r2", "new");
        let original = block("a", "r1", "old");
        for mismatch in 0..3 {
            let mut source = source(vec![original.clone()]);
            let mut records = fragments(&value);
            if mismatch == 0 {
                for record in &mut records {
                    if let wire::Record::Fragment { key, .. } = record {
                        key.message = "wrong".into();
                    }
                }
            }
            source
                .event(
                    wire::Event::Replace {
                        base: 10,
                        revision: 11,
                        append: false,
                        record: records[0].clone(),
                    },
                    true,
                )
                .unwrap();
            let record = if mismatch == 1 {
                records[0].clone()
            } else {
                records[1].clone()
            };
            assert!(
                source
                    .event(
                        wire::Event::Replace {
                            base: 10,
                            revision: 11,
                            append: mismatch == 2,
                            record
                        },
                        true
                    )
                    .is_err()
            );
            assert_eq!(source.blocks().front(), Some(&original));
            assert_eq!(source.revision(), Some(10));
        }
    }

    #[test]
    fn buffer_exhaustion_and_oversized_record_window_are_explicit() {
        let mut source = source(vec![]);
        source.journal_bytes = MAX_BUFFERED_BYTES;
        assert_eq!(
            source.event(replace(10, block("a", "r1", "x"), false), false),
            Err(Error::ResourceLimit)
        );
        assert!(source.blocks().is_empty());
        let oversized = block("big", "r1", &"x".repeat(wire::MAX_WINDOW_BYTES + 1));
        oversized.validate().unwrap();
        let mut blocks = VecDeque::from([oversized]);
        assert_eq!(window(&blocks), Ok(()));
        blocks.push_back(block("another", "r1", "x"));
        assert_eq!(window(&blocks), Err(Error::ResourceLimit));
    }

    #[test]
    fn repeated_continuation_and_adjacent_cursor_fail_without_partial_commit() {
        let mut source = source(vec![block("a", "r1", "old")]);
        let mut first = page(vec![block("b", "r1", "older")], None, None);
        first.continuation = Some("loop".into());
        source.page(Direction::Older, first).unwrap();
        let mut second = page(vec![], None, None);
        second.continuation = Some("loop".into());
        assert_eq!(
            source.page(Direction::Continue, second),
            Err(Error::CursorLoop)
        );
        assert_eq!(source.blocks()[0].key.message, "a");
        let mut source = super::super::tests::source(vec![block("a", "r1", "old")]);
        assert_eq!(
            source.page(
                Direction::Older,
                page(vec![block("b", "r1", "older")], Some("older-1"), None)
            ),
            Err(Error::CursorLoop)
        );
        assert_eq!(source.blocks()[0].key.message, "a");
    }
}
