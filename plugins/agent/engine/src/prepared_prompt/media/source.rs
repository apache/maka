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

//! Request-local media replacements over the original indexed recipe directories.
use maka_agent_facts::model::prompt_source::source::{
    AssistantRecipe, ContentRecipe, MessageMetadata, MessageRecipe, MessageSource, NextRecipe,
    RecipeCursor, RecipeSource, ToolOutputRecipe, ToolResultRecipe,
};
use std::{collections::BTreeMap, sync::Arc};

pub(super) type Key = (usize, usize, usize);
pub(super) struct Replacement {
    pub part: ContentRecipe,
}

struct Mapping {
    replacements: Arc<BTreeMap<Key, Replacement>>,
    _owner: Arc<dyn Send + Sync>,
}
struct Messages {
    base: Arc<dyn MessageSource>,
    mapping: Arc<Mapping>,
}
pub(super) fn mapped(
    base: Arc<dyn MessageSource>,
    replacements: Arc<BTreeMap<Key, Replacement>>,
    owner: Arc<dyn Send + Sync>,
) -> Arc<dyn MessageSource> {
    Arc::new(Messages {
        base,
        mapping: Arc::new(Mapping {
            replacements,
            _owner: owner,
        }),
    })
}
impl RecipeSource<MessageRecipe> for Messages {
    fn len(&self) -> usize {
        self.base.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        Box::new(MessageCursor {
            base: self.base.open(start),
            mapping: self.mapping.clone(),
            index: start,
        })
    }
}
impl MessageSource for Messages {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        self.base.open_metadata(start)
    }
}
struct MessageCursor {
    base: Box<dyn RecipeCursor<MessageRecipe>>,
    mapping: Arc<Mapping>,
    index: usize,
}
impl RecipeCursor<MessageRecipe> for MessageCursor {
    fn next(&mut self) -> NextRecipe<'_, MessageRecipe> {
        Box::pin(async move {
            let Some(message) = self.base.next().await? else {
                return Ok(None);
            };
            let index = self.index;
            self.index += 1;
            let mapping = &self.mapping;
            Ok(Some(match message {
                MessageRecipe::User {
                    content,
                    provider_options,
                } => MessageRecipe::User {
                    content: contents(content, mapping.clone(), index, 0),
                    provider_options,
                },
                MessageRecipe::Assistant {
                    content,
                    provider_options,
                } => MessageRecipe::Assistant {
                    content: Arc::new(List {
                        base: content,
                        mapping: mapping.clone(),
                        message: index,
                        map: assistant,
                    }),
                    provider_options,
                },
                MessageRecipe::Tool {
                    content,
                    provider_options,
                } => MessageRecipe::Tool {
                    content: Arc::new(List {
                        base: content,
                        mapping: mapping.clone(),
                        message: index,
                        map: result,
                    }),
                    provider_options,
                },
                system => system,
            }))
        })
    }
}

fn assistant(
    value: AssistantRecipe,
    mapping: Arc<Mapping>,
    message: usize,
    group: usize,
) -> AssistantRecipe {
    match value {
        AssistantRecipe::ToolResult(value) => {
            AssistantRecipe::ToolResult(result(value, mapping, message, group))
        }
        other => other,
    }
}
fn result(
    mut value: ToolResultRecipe,
    mapping: Arc<Mapping>,
    message: usize,
    group: usize,
) -> ToolResultRecipe {
    value.output = match value.output {
        ToolOutputRecipe::Content(content) => {
            ToolOutputRecipe::Content(contents(content, mapping, message, group))
        }
        other => other,
    };
    value
}

type Map<T> = fn(T, Arc<Mapping>, usize, usize) -> T;
struct List<T> {
    base: Arc<dyn RecipeSource<T>>,
    mapping: Arc<Mapping>,
    message: usize,
    map: Map<T>,
}
impl<T: Send + 'static> RecipeSource<T> for List<T> {
    fn len(&self) -> usize {
        self.base.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<T>> {
        Box::new(ListCursor {
            base: self.base.open(start),
            mapping: self.mapping.clone(),
            message: self.message,
            index: start,
            map: self.map,
        })
    }
}
struct ListCursor<T> {
    base: Box<dyn RecipeCursor<T>>,
    mapping: Arc<Mapping>,
    message: usize,
    index: usize,
    map: Map<T>,
}
impl<T: Send + 'static> RecipeCursor<T> for ListCursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        Box::pin(async move {
            let Some(value) = self.base.next().await? else {
                return Ok(None);
            };
            let index = self.index;
            self.index += 1;
            Ok(Some((self.map)(
                value,
                self.mapping.clone(),
                self.message,
                index,
            )))
        })
    }
}

fn contents(
    base: Arc<dyn RecipeSource<ContentRecipe>>,
    mapping: Arc<Mapping>,
    message: usize,
    group: usize,
) -> Arc<dyn RecipeSource<ContentRecipe>> {
    Arc::new(Contents {
        base,
        mapping,
        message,
        group,
    })
}
struct Contents {
    base: Arc<dyn RecipeSource<ContentRecipe>>,
    mapping: Arc<Mapping>,
    message: usize,
    group: usize,
}
impl RecipeSource<ContentRecipe> for Contents {
    fn len(&self) -> usize {
        self.base.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<ContentRecipe>> {
        Box::new(ContentCursor {
            base: self.base.clone(),
            cursor: None,
            mapping: self.mapping.clone(),
            message: self.message,
            group: self.group,
            index: start,
        })
    }
}
struct ContentCursor {
    base: Arc<dyn RecipeSource<ContentRecipe>>,
    cursor: Option<Box<dyn RecipeCursor<ContentRecipe>>>,
    mapping: Arc<Mapping>,
    message: usize,
    group: usize,
    index: usize,
}
impl RecipeCursor<ContentRecipe> for ContentCursor {
    fn next(&mut self) -> NextRecipe<'_, ContentRecipe> {
        Box::pin(async move {
            if self.index >= self.base.len() {
                return Ok(None);
            }
            if let Some(replacement) =
                self.mapping
                    .replacements
                    .get(&(self.message, self.group, self.index))
            {
                self.index += 1;
                // Resume through the indexed source after this skipped original.
                self.cursor = None;
                return Ok(Some(replacement.part.clone()));
            }
            let cursor = self
                .cursor
                .get_or_insert_with(|| self.base.open(self.index));
            let value = cursor.next().await?;
            self.index += usize::from(value.is_some());
            Ok(value)
        })
    }
}
