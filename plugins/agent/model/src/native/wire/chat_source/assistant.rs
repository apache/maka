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

//! One bounded assistant part at a time, with independent replay cursors.
use super::*;
use crate::native::wire::source::FragmentSequence;
use std::io;
#[derive(Clone)]
pub(super) enum Mode {
    Text,
    Reasoning,
    Calls(Arc<str>),
}
struct AssistantSource {
    parts: Arc<dyn RecipeSource<AssistantRecipe>>,
    mode: Mode,
}
pub(super) fn plan(
    parts: Arc<dyn RecipeSource<AssistantRecipe>>,
    mode: Mode,
) -> Result<Vec<F>, ModelError> {
    let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
        .extend(std::alloc::Layout::new::<AssistantSource>())
        .map_err(|e| ModelError::Adapter(e.to_string()))?;
    let owned = layout
        .pad_to_align()
        .size()
        .checked_add(match &mode {
            Mode::Calls(namespace) => {
                let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
                    .extend(
                        std::alloc::Layout::array::<u8>(namespace.len())
                            .map_err(|e| ModelError::Adapter(e.to_string()))?,
                    )
                    .map_err(|e| ModelError::Adapter(e.to_string()))?;
                layout.pad_to_align().size()
            }
            _ => 0,
        })
        .ok_or_else(|| ModelError::Adapter("assistant metadata overflow".into()))?;
    Ok(vec![F::owned_raw(
        JsonSource {
            bytes: SourceBytes::Source(Arc::new(AssistantSource { parts, mode })),
        },
        owned,
    )])
}
impl ByteSource for AssistantSource {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            parts: self.parts.open(0),
            mode: self.mode.clone(),
            budget,
            active: Some(FragmentSequence::new(Arc::from([l(
                if matches!(&self.mode, Mode::Calls(_)) {
                    b"["
                } else {
                    b"\""
                },
            )]))),
            first: true,
            closed: false,
        })
    }
}
struct Cursor {
    parts: Box<dyn RecipeCursor<AssistantRecipe>>,
    mode: Mode,
    budget: Arc<dyn SourceBudget>,
    active: Option<FragmentSequence>,
    first: bool,
    closed: bool,
}
impl Cursor {
    async fn next_part(&mut self) -> io::Result<Option<Vec<F>>> {
        while let Some(part) = self.parts.next().await? {
            tokio::task::yield_now().await;
            let value = match (&self.mode, part) {
                (Mode::Text, AssistantRecipe::Text { text, .. })
                | (Mode::Reasoning, AssistantRecipe::Reasoning { text, .. }) => vec![F::Text(text)],
                (
                    Mode::Calls(namespace),
                    AssistantRecipe::ToolCall {
                        tool_call_id,
                        tool_name,
                        input,
                        provider_options,
                        ..
                    },
                ) => {
                    let mut fields = super::render_call(
                        tool_call_id,
                        tool_name,
                        input,
                        provider_options,
                        namespace,
                        &self.budget,
                    )
                    .await
                    .map_err(|e| io::Error::other(e.to_string()))?;
                    if !std::mem::replace(&mut self.first, false) {
                        fields.insert(0, l(b","));
                    }
                    fields
                }
                _ => continue,
            };
            return Ok(Some(value));
        }
        Ok(None)
    }
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
                if self.closed {
                    break;
                }
                let fragments = if let Some(part) = self.next_part().await? {
                    part
                } else {
                    self.closed = true;
                    vec![l(if matches!(&self.mode, Mode::Calls(_)) {
                        b"]"
                    } else {
                        b"\""
                    })]
                };
                self.active = Some(FragmentSequence::new(fragments.into()));
            }
            Ok(SourceRead {
                buffer,
                bytes_read: written,
                eof: self.closed && self.active.is_none(),
            })
        })
    }
}
