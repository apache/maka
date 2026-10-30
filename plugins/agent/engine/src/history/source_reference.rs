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

//! Fixed source descriptors under the request's one captured owner and arena.

use super::capture_arena::CaptureArena;
use maka_agent_facts::{history::RowPosition, model::prompt_source::source::*};
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) const WORDS: usize = 12;
#[derive(Clone, Copy)]
pub(super) struct SourceRecord(pub [u64; WORDS]);
impl CaptureArena {
    pub(super) async fn retain_source(
        &self,
        bytes: SourceBytes,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<SourceRecord> {
        if cancel.is_cancelled() {
            return Err(crate::preparation_cancelled("source retention cancelled"));
        }
        let locator = match &bytes {
            SourceBytes::Inline(_) => None,
            SourceBytes::Source(source) => source.locator(),
        };
        let mut words = [0; WORDS];
        let range = match locator {
            Some(SourceLocator::Captured {
                identity,
                backing,
                range,
            }) => {
                if !self.captured().owns_locator(&identity) {
                    return Err(invalid("foreign captured source locator"));
                }
                match backing {
                    SourceBacking::Row { rowid, bytes } => {
                        words[..3].copy_from_slice(&[1, rowid as u64, bytes]);
                    }
                    SourceBacking::Canonical { key, offset, bytes } => {
                        words[..5].copy_from_slice(&[
                            2,
                            key.source_sequence,
                            key.item_index,
                            offset,
                            bytes,
                        ]);
                    }
                    SourceBacking::Pieces { key, bytes } => {
                        words[..4].copy_from_slice(&[
                            3,
                            key.source_sequence,
                            key.item_index,
                            bytes,
                        ]);
                    }
                    SourceBacking::ArtifactMetadata {
                        rowid,
                        bytes,
                        payload_bytes,
                        digest,
                    } => {
                        words[..4].copy_from_slice(&[5, rowid as u64, bytes, payload_bytes]);
                        digest_words(&mut words[4..8], digest);
                    }
                }
                range
            }
            Some(SourceLocator::Arena { identity, range }) => {
                if !self.owns_arena_locator(&identity) {
                    return Err(invalid("foreign request arena locator"));
                }
                words[0] = 6;
                range
            }
            None => {
                words[0] = 6;
                self.append(bytes, budget, cancel).await?
            }
        };
        words[10] = range.start;
        words[11] = range.end;
        Ok(SourceRecord(words))
    }
    pub(super) fn restore_source(
        &self,
        record: SourceRecord,
        inspection: bool,
    ) -> io::Result<SourceBytes> {
        let words = record.0;
        let range = words[10]..words[11];
        if range.start > range.end {
            return Err(invalid("inverted stored source range"));
        }
        let key = RowPosition {
            source_sequence: words[1],
            item_index: words[2],
        };
        let backing = match words[0] {
            1 => SourceBacking::Row {
                rowid: words[1] as i64,
                bytes: words[2],
            },
            2 => SourceBacking::Canonical {
                key,
                offset: words[3],
                bytes: words[4],
            },
            3 => SourceBacking::Pieces {
                key,
                bytes: words[3],
            },
            5 => SourceBacking::ArtifactMetadata {
                rowid: words[1] as i64,
                bytes: words[2],
                payload_bytes: words[3],
                digest: read_digest(&words[4..8]),
            },
            6 => {
                return Ok(if inspection {
                    self.inspect(range)
                } else {
                    self.pending(range)
                });
            }
            _ => return Err(invalid("unknown stored source backing")),
        };
        self.captured()
            .restore_locator(backing, range)
            .map(SourceBytes::Source)
            .map_err(io::Error::other)
    }
}
fn digest_words(words: &mut [u64], digest: [u8; 32]) {
    for (word, bytes) in words.iter_mut().zip(digest.as_chunks::<8>().0) {
        *word = u64::from_le_bytes(*bytes);
    }
}
fn read_digest(words: &[u64]) -> [u8; 32] {
    let mut digest = [0; 32];
    for (bytes, word) in digest.as_chunks_mut::<8>().0.iter_mut().zip(words) {
        bytes.copy_from_slice(&word.to_le_bytes());
    }
    digest
}
fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}
