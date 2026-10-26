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

//! Fixture-only prepared source. Semantic reads fail so live and loopback tests
//! cannot accidentally exercise the explicit in-memory fallback path.
use maka_agent_facts::model::prompt_source::{
    Next, NextWire, NextWireMetadata, WireMetadata, WireMetadataCursor, WirePosition,
};
use maka_model::{
    ModelError, ModelRequest,
    prompt::{Message, Prompt, PromptCursor, PromptSource, WireChunk, WireCursor, WireSource},
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Default)]
struct Counters {
    semantic: AtomicUsize,
    wire_bytes: AtomicUsize,
}
pub(crate) struct Reads(Arc<Counters>);
impl Reads {
    pub(crate) fn assert_wire_only(&self) {
        assert_eq!(
            self.0.semantic.load(Ordering::SeqCst),
            0,
            "prepared request must never open semantic history"
        );
        assert!(
            self.0.wire_bytes.load(Ordering::SeqCst) > 0,
            "provider must consume the prepared body"
        );
    }
}
struct Source {
    chunks: Arc<Vec<WireChunk>>,
    counters: Arc<Counters>,
}
struct FailedCursor;
impl PromptSource for Source {
    fn open(&self) -> Box<dyn PromptCursor> {
        self.counters.semantic.fetch_add(1, Ordering::SeqCst);
        Box::new(FailedCursor)
    }
}
impl PromptCursor for FailedCursor {
    fn next(&mut self) -> Next<'_> {
        Box::pin(async {
            Err(ModelError::Adapter(
                "fixture semantic history must remain unread".into(),
            ))
        })
    }
}
struct Cursor {
    chunks: Arc<Vec<WireChunk>>,
    position: usize,
    counters: Arc<Counters>,
}
impl WireCursor for Cursor {
    fn next(&mut self) -> NextWire<'_> {
        Box::pin(async move {
            let Some(chunk) = self.chunks.get(self.position) else {
                return Ok(None);
            };
            self.position += 1;
            self.counters
                .wire_bytes
                .fetch_add(chunk.bytes.len(), Ordering::SeqCst);
            Ok(Some(WireChunk {
                bytes: chunk.bytes.clone(),
                item_start: chunk.item_start,
                item_end: chunk.item_end,
                message_index: chunk.message_index,
                metadata: chunk.metadata.clone(),
            }))
        })
    }
}
struct MetadataCursor {
    chunks: Arc<Vec<WireChunk>>,
    position: usize,
}
impl WireMetadataCursor for MetadataCursor {
    fn next(&mut self) -> NextWireMetadata<'_> {
        Box::pin(async move {
            while let Some(chunk) = self.chunks.get(self.position) {
                let piece_index = self.position;
                self.position += 1;
                if let Some(metadata) = &chunk.metadata {
                    return Ok(Some(WireMetadata {
                        position: WirePosition {
                            message_index: chunk.message_index,
                            piece_index,
                        },
                        message_index: chunk.message_index,
                        metadata: metadata.clone(),
                    }));
                }
            }
            Ok(None)
        })
    }
}
impl Source {
    fn position(&self, start: usize) -> usize {
        self.chunks
            .iter()
            .position(|chunk| chunk.message_index >= start)
            .unwrap_or(self.chunks.len())
    }
    fn cursor(&self, position: usize) -> Box<dyn WireCursor> {
        Box::new(Cursor {
            chunks: self.chunks.clone(),
            position,
            counters: self.counters.clone(),
        })
    }
}
impl WireSource for Source {
    fn open(&self, start_message: usize) -> Box<dyn WireCursor> {
        self.cursor(self.position(start_message))
    }
    fn open_at(&self, position: WirePosition) -> Option<Box<dyn WireCursor>> {
        Some(self.cursor(position.piece_index))
    }
    fn open_metadata(&self, start_message: usize) -> Option<Box<dyn WireMetadataCursor>> {
        Some(Box::new(MetadataCursor {
            chunks: self.chunks.clone(),
            position: self.position(start_message),
        }))
    }
}

pub(crate) fn prepare_input(input: &mut ModelRequest) -> Reads {
    let messages = input
        .prompt
        .memory_messages()
        .expect("synthetic fixture input")
        .to_vec();
    let messages = maka_model::reasoning::project(messages, &input.provider.kind);
    let instructions = messages
        .iter()
        .find_map(|message| match message {
            Message::System { content, .. } if !content.trim().is_empty() => Some(content.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let logical = Prompt::from_messages(messages.clone());
    let wire = maka_model::WireEncoding::new(
        input.language,
        &input.provider,
        &input.provider_options,
        &input.tools,
    )
    .unwrap()
    .prepare_group(messages, &maka_model::PreparationContext::default());
    let identity = format!("fixture-wire-v1:{}:{}", logical.identity(), wire.codec);
    let chunks = wire.chunks.collect::<Result<Vec<_>, _>>().unwrap();
    let counters = Arc::new(Counters::default());
    let source = Arc::new(Source {
        chunks: Arc::new(chunks),
        counters: counters.clone(),
    });
    input.prompt = Prompt::new(
        source.clone(),
        logical.identity(),
        logical.len(),
        logical.breakdown().clone(),
    )
    .with_normalization(input.provider.kind.clone())
    .with_wire(wire.format, wire.codec, identity, source)
    .with_instructions(instructions);
    Reads(counters)
}
