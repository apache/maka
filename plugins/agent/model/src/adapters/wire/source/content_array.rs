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

//! A replayable provider content array with one active content-part encoder.
use super::super::{chat_source, responses};
use super::{FragmentSequence, SourceFragment as F};
use crate::ModelError;
use maka_agent_facts::{
    language::Language,
    model::prompt_source::source::{
        ByteCursor, ByteSource, ChargedBuffer, ContentRecipe, JsonSource, ReadSource, RecipeCursor,
        RecipeSource, SourceBudget, SourceBytes, SourceRead,
    },
};
use std::{io, sync::Arc};
#[derive(Clone, Copy)]
pub(super) enum Codec {
    Chat,
    ChatTool,
    Responses,
}
struct ContentArray {
    parts: Arc<dyn RecipeSource<ContentRecipe>>,
    codec: Codec,
    language: Language,
}
pub(super) fn allocation() -> io::Result<usize> {
    let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
        .extend(std::alloc::Layout::new::<ContentArray>())
        .map_err(io::Error::other)?;
    Ok(layout.pad_to_align().size())
}
pub(super) fn plan(
    parts: Arc<dyn RecipeSource<ContentRecipe>>,
    codec: Codec,
    language: Language,
) -> io::Result<Vec<F>> {
    Ok(vec![F::owned_raw(
        JsonSource::new(SourceBytes::Source(Arc::new(ContentArray {
            parts,
            codec,
            language,
        }))),
        allocation()?,
    )])
}
pub(super) fn textual(
    parts: Arc<dyn RecipeSource<ContentRecipe>>,
    language: Language,
) -> io::Result<Vec<F>> {
    let source = JsonSource::new(SourceBytes::Source(Arc::new(ContentArray {
        parts,
        codec: Codec::ChatTool,
        language,
    })));
    Ok(vec![
        F::literal(b"\""),
        F::OwnedJsonString {
            source,
            metadata_bytes: allocation()?,
        },
        F::literal(b"\""),
    ])
}
impl ByteSource for ContentArray {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            parts: self.parts.open(0),
            codec: self.codec,
            language: self.language,
            budget,
            active: Some(FragmentSequence::new(Arc::from([F::literal(b"[")]))),
            first: true,
            closing: false,
            done: false,
        })
    }
}
struct Cursor {
    parts: Box<dyn RecipeCursor<ContentRecipe>>,
    codec: Codec,
    language: Language,
    budget: Arc<dyn SourceBudget>,
    active: Option<FragmentSequence>,
    first: bool,
    closing: bool,
    done: bool,
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let mut written = 0;
            while written < buffer.as_mut().len() {
                if let Some(active) = &mut self.active {
                    let (count, done) = active
                        .copy(&mut buffer.as_mut()[written..], self.budget.clone())
                        .await?;
                    written += count;
                    if !done {
                        break;
                    }
                    self.active = None;
                }
                if self.closing {
                    self.done = true;
                    break;
                }
                if let Some(part) = self.parts.next().await? {
                    tokio::task::yield_now().await;
                    let mut fragments = match self.codec {
                        Codec::Chat => {
                            chat_source::render_content_part(
                                part,
                                self.language,
                                self.budget.clone(),
                            )
                            .await
                        }
                        Codec::ChatTool => {
                            chat_source::render_tool_textual_part(
                                part,
                                self.language,
                                self.budget.clone(),
                            )
                            .await
                        }
                        Codec::Responses => {
                            responses::render_content_part(part, self.budget.clone()).await
                        }
                    }
                    .map_err(|error: ModelError| io::Error::other(error))?;
                    if !self.first {
                        fragments.insert(0, F::literal(b","));
                    }
                    self.first = false;
                    self.active = Some(FragmentSequence::new(fragments.into()));
                } else {
                    self.closing = true;
                    self.active = Some(FragmentSequence::new(Arc::from([F::literal(b"]")])));
                }
            }
            Ok(SourceRead {
                buffer,
                bytes_read: written,
                eof: self.done,
            })
        })
    }
}
