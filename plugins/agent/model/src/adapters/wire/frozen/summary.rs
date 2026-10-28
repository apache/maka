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

//! Summary allocation bounds from the frozen systems, instruction and native media.
use super::super::{
    WireOptions, anthropic,
    source::{self as fragments, SourceFragment},
};
use super::{Counts, Shape, WirePlan, add, arc_bytes, array_bytes, error};
use crate::{ModelError, ModelPreparationResources};
use maka_agent_facts::model::prompt_source::source::{
    self, AssistantRecipe, ContentRecipe, MessageRecipe, MessageRole, MessageSource, RecipeCursor,
    SourceBudget, ToolOutputRecipe, ToolResultRecipe,
};
use std::sync::Arc;
pub struct SummaryWireBound {
    allocation: usize,
}
impl SummaryWireBound {
    pub fn allocation(&self) -> usize {
        self.allocation
    }
}
struct MediaCursor {
    messages: Box<dyn RecipeCursor<MessageRecipe>>,
    remaining: usize,
    assistant: Option<Box<dyn RecipeCursor<AssistantRecipe>>>,
    tools: Option<Box<dyn RecipeCursor<ToolResultRecipe>>>,
    content: Option<Box<dyn RecipeCursor<ContentRecipe>>>,
}
impl MediaCursor {
    fn new(source: &dyn MessageSource, messages: usize) -> Self {
        Self {
            messages: source.open(0),
            remaining: messages,
            assistant: None,
            tools: None,
            content: None,
        }
    }
    async fn next(&mut self) -> Result<Option<ContentRecipe>, ModelError> {
        loop {
            if let Some(cursor) = &mut self.content {
                while let Some(part) = cursor.next().await.map_err(error)? {
                    if matches!(part, ContentRecipe::Media { .. }) {
                        return Ok(Some(part));
                    }
                }
                self.content = None;
            }
            if let Some(cursor) = &mut self.assistant {
                if let Some(part) = cursor.next().await.map_err(error)? {
                    if let AssistantRecipe::ToolResult(ToolResultRecipe {
                        output: ToolOutputRecipe::Content(parts),
                        ..
                    }) = part
                    {
                        self.content = Some(parts.open(0));
                    }
                    continue;
                }
                self.assistant = None;
            }
            if let Some(cursor) = &mut self.tools {
                if let Some(part) = cursor.next().await.map_err(error)? {
                    if let ToolOutputRecipe::Content(parts) = part.output {
                        self.content = Some(parts.open(0));
                    }
                    continue;
                }
                self.tools = None;
            }
            if self.remaining == 0 {
                return Ok(None);
            }
            self.remaining -= 1;
            let message =
                self.messages.next().await.map_err(error)?.ok_or_else(|| {
                    ModelError::Adapter("truncated summary source directory".into())
                })?;
            match message {
                MessageRecipe::System { .. } => {}
                MessageRecipe::User { content, .. } => self.content = Some(content.open(0)),
                MessageRecipe::Assistant { content, .. } => self.assistant = Some(content.open(0)),
                MessageRecipe::Tool { content, .. } => self.tools = Some(content.open(0)),
            }
        }
    }
}
fn arc_fragments(count: usize) -> Result<usize, ModelError> {
    arc_bytes(
        array_bytes::<SourceFragment>(count)?,
        std::mem::align_of::<SourceFragment>(),
    )
}
fn object_user(content_arity: usize, owned: usize) -> Result<Shape, ModelError> {
    Ok(Shape {
        items: 1,
        retained: arc_fragments(1)?
            .checked_add(
                fragments::object_allocation_shape(&[3, content_arity], owned).map_err(error)?,
            )
            .ok_or_else(|| ModelError::Adapter("summary user bound overflow".into()))?,
        documents: 0,
        source_ids: 0,
    })
}
async fn fitted_user(
    plan: &WirePlan,
    budget: Arc<dyn SourceBudget>,
    original_messages: usize,
) -> Result<Shape, ModelError> {
    let mut media = MediaCursor::new(plan.source.as_ref(), original_messages);
    match plan.encoding.options.as_ref() {
        WireOptions::Anthropic(options) => {
            let compiler = anthropic::Compiler::new(options.clone(), plan.encoding.language);
            let placeholder = ContentRecipe::Text {
                text: source::generated::text("fit"),
                provider_options: None,
            };
            let base = compiler
                .count_user_part_bound(placeholder.clone(), budget.clone())
                .await?;
            let mut shape = Shape {
                items: 1,
                retained: base.retained,
                documents: base.documents,
                source_ids: 0,
            };
            while let Some(part) = media.next().await? {
                tokio::task::yield_now().await;
                let bound = compiler.count_user_part_bound(part, budget.clone()).await?;
                add(&mut shape.items, 2)?;
                add(&mut shape.retained, base.retained)?;
                add(&mut shape.retained, bound.retained)?;
                add(&mut shape.documents, bound.documents)?;
                add(&mut shape.source_ids, 1)?;
            }
            Ok(shape)
        }
        WireOptions::Chat(_) | WireOptions::Responses { .. } => {
            let array = object_user(1, fragments::content_array_allocation().map_err(error)?)?;
            if matches!(plan.encoding.options.as_ref(), WireOptions::Chat(_)) {
                let text = object_user(3, 0)?;
                Ok(if text.retained > array.retained {
                    text
                } else {
                    array
                })
            } else {
                Ok(array)
            }
        }
    }
}
pub(super) async fn count(
    plan: &WirePlan,
    original_messages: usize,
    resources: ModelPreparationResources,
) -> Result<SummaryWireBound, ModelError> {
    if original_messages.checked_add(1) != Some(plan.source.len())
        || plan.counts.last_role != Some(MessageRole::User)
    {
        return Err(ModelError::Adapter(
            "summary wire bound requires the original prefix and one frozen User instruction"
                .into(),
        ));
    }
    let work = resources.acquire_work().await.map_err(error)?;
    let user = fitted_user(plan, work.budget(), original_messages).await?;
    drop(work);
    let mut count = Counts::default();
    for shape in [plan.counts.systems, plan.counts.last, user] {
        add(&mut count.items, shape.items)?;
        add(&mut count.retained, shape.retained)?;
        add(&mut count.documents, shape.documents)?;
        add(&mut count.source_ids, shape.source_ids)?;
    }
    let messages = plan
        .counts
        .system_messages
        .checked_add(2)
        .ok_or_else(|| ModelError::Adapter("summary message count overflow".into()))?;
    Ok(SummaryWireBound {
        allocation: count.allocation(messages)?,
    })
}
