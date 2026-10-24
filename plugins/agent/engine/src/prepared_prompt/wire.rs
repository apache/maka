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

//! Compose bounded request overlays with a storage-backed wire source.
use super::PreparedPrompt;
use crate::RunError;
use maka_agent_facts::{language::Language, model::prompt_source::*};
use maka_model::{ModelError, ProviderConfig, ToolDefinition, WireEncoding, prompt::Message};
use std::{collections::VecDeque, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) async fn compile(
    prompt: &mut PreparedPrompt,
    language: Language,
    provider: &ProviderConfig,
    options: &serde_json::Value,
    tools: &[ToolDefinition],
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    let encoding = Arc::new(WireEncoding::new(language, provider, options, tools)?);
    let codec = encoding.codec().to_owned();
    let format = encoding.format();
    let body: Arc<dyn WireSource> = if let Some(history) = &prompt.history {
        let prepared = history
            .compile(provider, options, tools, cancellation)
            .await?;
        prepared
            .wire(format)
            .expect("compiled requested codec")
            .source
            .clone()
    } else {
        let messages = prompt.body.memory_messages().ok_or_else(|| {
            RunError::Internal("generated summary lacks its bounded input".into())
        })?;
        Small::validated(Arc::new(messages.to_vec()), encoding.clone(), cancellation)?
    };
    let mut prefix = Vec::new();
    if let Some(system) = &prompt.system {
        prefix.push(system.as_ref().clone());
    }
    prefix.extend(prompt.prefix.iter().cloned());
    let prefix_count = prefix.len();
    let suffix_count = prompt.suffix.len();
    let source = Composite {
        codec: codec.clone(),
        segments: vec![
            Segment {
                source: Small::validated(Arc::new(prefix), encoding.clone(), cancellation)?,
                count: prefix_count,
            },
            Segment {
                source: body,
                count: prompt.body.len(),
            },
            Segment {
                source: Small::validated(prompt.suffix.clone(), encoding, cancellation)?,
                count: suffix_count,
            },
        ],
    };
    let count = source.segments.iter().map(|segment| segment.count).sum();
    let identity = source.prefix_identity(count).await?.ok_or_else(|| {
        RunError::Internal("prepared wire lacks its fixed prefix identity".into())
    })?;
    prompt.wire = Some(PreparedWire {
        format,
        codec: codec.into(),
        identity: identity.into(),
        source: Arc::new(source),
    });
    Ok(())
}
struct Small {
    messages: Arc<Vec<Message>>,
    encoding: Arc<WireEncoding>,
}
impl Small {
    fn validated(
        messages: Arc<Vec<Message>>,
        encoding: Arc<WireEncoding>,
        cancellation: &CancellationToken,
    ) -> Result<Arc<dyn WireSource>, RunError> {
        let source = Arc::new(Self { messages, encoding });
        // Only generated overlays are traversed here. Stored history was encoded
        // and admitted when its dirty groups were published.
        for chunk in source.chunks(0) {
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            chunk?;
        }
        Ok(source)
    }
    fn chunks(
        &self,
        start: usize,
    ) -> Box<dyn Iterator<Item = Result<WireChunk, ModelError>> + Send> {
        self.encoding
            .prepare_group(
                self.messages.iter().skip(start).cloned().collect(),
                &maka_model::PreparationContext::default(),
            )
            .chunks
    }
}
impl WireSource for Small {
    fn open_at(&self, position: WirePosition) -> Option<Box<dyn WireCursor>> {
        Some(Box::new(SmallCursor {
            chunks: Box::new(self.chunks(0).skip(position.piece_index)),
            start: 0,
        }))
    }
    fn open(&self, start: usize) -> Box<dyn WireCursor> {
        Box::new(SmallCursor {
            chunks: self.chunks(start),
            start,
        })
    }
    fn open_metadata(&self, start: usize) -> Option<Box<dyn WireMetadataCursor>> {
        Some(Box::new(SmallMetadata {
            chunks: self.chunks(0),
            start,
            piece: 0,
        }))
    }
    fn prefix_identity(&self, count: usize) -> PrefixIdentity<'_> {
        Box::pin(async move {
            if count > self.messages.len() {
                return Ok(None);
            }
            crate::runner::digest(&(
                "maka.overlay-wire.v2",
                self.encoding.codec(),
                &self.messages[..count],
            ))
            .map(Some)
            .map_err(|error| ModelError::Adapter(error.to_string()))
        })
    }
}
struct SmallCursor {
    chunks: Box<dyn Iterator<Item = Result<WireChunk, ModelError>> + Send>,
    start: usize,
}
impl WireCursor for SmallCursor {
    fn next(&mut self) -> NextWire<'_> {
        Box::pin(async move {
            self.chunks.next().transpose().map(|chunk| {
                chunk.map(|mut chunk| {
                    chunk.message_index += self.start;
                    chunk
                })
            })
        })
    }
}
struct SmallMetadata {
    chunks: Box<dyn Iterator<Item = Result<WireChunk, ModelError>> + Send>,
    start: usize,
    piece: usize,
}
impl WireMetadataCursor for SmallMetadata {
    fn next(&mut self) -> NextWireMetadata<'_> {
        Box::pin(async move {
            for chunk in self.chunks.by_ref() {
                let chunk = chunk?;
                let piece = self.piece;
                self.piece += 1;
                if chunk.message_index < self.start {
                    continue;
                }
                if let Some(metadata) = chunk.metadata {
                    return Ok(Some(WireMetadata {
                        position: WirePosition {
                            message_index: chunk.message_index,
                            piece_index: piece,
                        },
                        message_index: chunk.message_index,
                        metadata,
                    }));
                }
            }
            Ok(None)
        })
    }
}
struct Segment {
    source: Arc<dyn WireSource>,
    count: usize,
}
struct Composite {
    codec: String,
    segments: Vec<Segment>,
}
impl WireSource for Composite {
    fn open_at(&self, position: WirePosition) -> Option<Box<dyn WireCursor>> {
        let mut offset = 0;
        let mut cursors = VecDeque::new();
        let mut found = false;
        for segment in &self.segments {
            if found {
                cursors.push_back((offset, segment.source.open(0)));
            } else if position.message_index < offset + segment.count {
                cursors.push_back((
                    offset,
                    segment.source.open_at(WirePosition {
                        message_index: position.message_index - offset,
                        piece_index: position.piece_index,
                    })?,
                ));
                found = true;
            }
            offset += segment.count;
        }
        found.then(|| Box::new(CompositeCursor { cursors }) as Box<dyn WireCursor>)
    }
    fn open(&self, start: usize) -> Box<dyn WireCursor> {
        let mut offset = 0;
        let mut cursors = VecDeque::new();
        for segment in &self.segments {
            if start < offset + segment.count {
                cursors.push_back((offset, segment.source.open(start.saturating_sub(offset))));
            }
            offset += segment.count;
        }
        Box::new(CompositeCursor { cursors })
    }
    fn open_metadata(&self, start: usize) -> Option<Box<dyn WireMetadataCursor>> {
        let mut offset = 0;
        let mut cursors = VecDeque::new();
        for segment in &self.segments {
            if start < offset + segment.count {
                cursors.push_back((
                    offset,
                    segment.source.open_metadata(start.saturating_sub(offset))?,
                ));
            }
            offset += segment.count;
        }
        Some(Box::new(CompositeMetadata { cursors }))
    }
    fn prefix_identity(&self, count: usize) -> PrefixIdentity<'_> {
        Box::pin(async move {
            let mut remaining = count;
            let mut roots = Vec::new();
            for segment in &self.segments {
                if remaining == 0 {
                    break;
                }
                let take = remaining.min(segment.count);
                if take > 0 {
                    let Some(root) = segment.source.prefix_identity(take).await? else {
                        return Ok(None);
                    };
                    roots.push((take, root));
                    remaining -= take;
                }
            }
            if remaining != 0 {
                return Ok(None);
            }
            crate::runner::digest(&("maka.request-wire-prefix.v2", &self.codec, count, roots))
                .map(Some)
                .map_err(|error| ModelError::Adapter(error.to_string()))
        })
    }
}
struct CompositeCursor {
    cursors: VecDeque<(usize, Box<dyn WireCursor>)>,
}
impl WireCursor for CompositeCursor {
    fn next(&mut self) -> NextWire<'_> {
        Box::pin(async move {
            loop {
                let Some((offset, cursor)) = self.cursors.front_mut() else {
                    return Ok(None);
                };
                if let Some(mut chunk) = cursor.next().await? {
                    chunk.message_index += *offset;
                    return Ok(Some(chunk));
                }
                self.cursors.pop_front();
            }
        })
    }
}
struct CompositeMetadata {
    cursors: VecDeque<(usize, Box<dyn WireMetadataCursor>)>,
}
impl WireMetadataCursor for CompositeMetadata {
    fn next(&mut self) -> NextWireMetadata<'_> {
        Box::pin(async move {
            loop {
                let Some((offset, cursor)) = self.cursors.front_mut() else {
                    return Ok(None);
                };
                if let Some(mut item) = cursor.next().await? {
                    item.message_index += *offset;
                    item.position.message_index += *offset;
                    return Ok(Some(item));
                }
                self.cursors.pop_front();
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Indexed {
        rows: Vec<String>,
        opened_at: Arc<AtomicUsize>,
    }
    impl WireSource for Indexed {
        fn open(&self, start: usize) -> Box<dyn WireCursor> {
            self.opened_at.store(start, Ordering::SeqCst);
            Box::new(TestCursor {
                rows: self.rows.clone(),
                offset: start,
            })
        }
        fn prefix_identity(&self, count: usize) -> PrefixIdentity<'_> {
            Box::pin(async move { Ok(Some(self.rows[..count].join("|"))) })
        }
    }
    struct TestCursor {
        rows: Vec<String>,
        offset: usize,
    }
    impl WireCursor for TestCursor {
        fn next(&mut self) -> NextWire<'_> {
            Box::pin(async move {
                let Some(row) = self.rows.get(self.offset) else {
                    return Ok(None);
                };
                let chunk = WireChunk {
                    bytes: row.as_bytes().to_vec(),
                    item_start: true,
                    item_end: true,
                    message_index: self.offset,
                    metadata: None,
                };
                self.offset += 1;
                Ok(Some(chunk))
            })
        }
    }
    fn source(rows: &[&str], opened_at: Arc<AtomicUsize>) -> Arc<dyn WireSource> {
        Arc::new(Indexed {
            rows: rows.iter().map(|row| (*row).to_owned()).collect(),
            opened_at,
        })
    }

    #[tokio::test]
    async fn suffix_replay_seeks_the_index_and_preserves_prefix_across_appends() {
        let prefix_reads = Arc::new(AtomicUsize::new(usize::MAX));
        let body_reads = Arc::new(AtomicUsize::new(usize::MAX));
        let before = Composite {
            codec: "codec".into(),
            segments: vec![
                Segment {
                    source: source(&["system"], prefix_reads.clone()),
                    count: 1,
                },
                Segment {
                    source: source(&["old", "answer"], body_reads.clone()),
                    count: 2,
                },
            ],
        };
        let after = Composite {
            codec: "codec".into(),
            segments: vec![
                Segment {
                    source: source(&["system"], prefix_reads.clone()),
                    count: 1,
                },
                Segment {
                    source: source(&["old", "answer", "tool result"], body_reads.clone()),
                    count: 3,
                },
            ],
        };
        assert_eq!(
            before.prefix_identity(3).await.unwrap(),
            after.prefix_identity(3).await.unwrap()
        );
        let mut cursor = after.open(3);
        assert_eq!(
            prefix_reads.load(Ordering::SeqCst),
            usize::MAX,
            "skipped overlays are never opened"
        );
        assert_eq!(
            body_reads.load(Ordering::SeqCst),
            2,
            "the persistent body seeks past old input"
        );
        let chunk = cursor.next().await.unwrap().unwrap();
        assert_eq!(chunk.message_index, 3);
        assert_eq!(chunk.bytes, b"tool result");
        assert!(cursor.next().await.unwrap().is_none());
        let changed = Composite {
            codec: "codec".into(),
            segments: vec![
                Segment {
                    source: source(&["different system"], prefix_reads),
                    count: 1,
                },
                Segment {
                    source: source(&["old", "answer", "tool result"], body_reads),
                    count: 3,
                },
            ],
        };
        assert_ne!(
            before.prefix_identity(3).await.unwrap(),
            changed.prefix_identity(3).await.unwrap()
        );
    }
}
