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

//! Immutable logical directory. Entries contain sources, never history bodies.

use maka_agent_facts::{
    context::PreparedContextBreakdown,
    model::prompt_source::source::{
        IdentifiedText, MessageMetadata, MessageRecipe, MessageRole, MessageSource, NextRecipe,
        RecipeCursor, RecipeIdentity, RecipeSource,
    },
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// A message's decisions and content commitment are fixed before publication.
#[derive(Clone)]
pub(crate) struct MessageDescriptor {
    pub recipe: MessageRecipe,
    pub role: MessageRole,
    pub last_is_tool_result: bool,
    pub local_tool_names: Arc<dyn RecipeSource<IdentifiedText>>,
    pub settled_tool_call_ids: Arc<dyn RecipeSource<IdentifiedText>>,
    pub breakdown: PreparedContextBreakdown,
    pub commitment: [u8; 32],
    pub logical_identity: Arc<str>,
}

/// One flat directory owns its allocation charge and original source custody.
/// It never points at a prior directory or retains an idle cache entry.
#[derive(Clone)]
pub(crate) struct FrozenDirectory(Arc<Directory>);
struct Directory {
    messages: Box<[MessageDescriptor]>,
    prefixes: Box<[[u8; 32]]>,
    totals: PreparedContextBreakdown,
    _owner: Box<dyn Send + Sync>,
}

impl FrozenDirectory {
    pub fn fixed_metadata_bytes() -> usize {
        2 * std::mem::size_of::<usize>()
            + std::mem::size_of::<Directory>()
            + std::mem::size_of::<Arc<dyn Send + Sync>>()
    }

    pub fn new(messages: Vec<MessageDescriptor>, owner: impl Send + Sync + 'static) -> Self {
        let mut totals = PreparedContextBreakdown::default();
        let mut prefixes = Vec::with_capacity(messages.len() + 1);
        let mut hash = Sha256::new();
        hash.update(b"maka.logical-prefix\0");
        prefixes.push(hash.clone().finalize().into());
        for message in &messages {
            totals.accumulate(&message.breakdown);
            hash.update(message.commitment);
            prefixes.push(hash.clone().finalize().into());
        }
        Self(Arc::new(Directory {
            messages: messages.into_boxed_slice(),
            prefixes: prefixes.into_boxed_slice(),
            totals,
            _owner: Box::new(owner),
        }))
    }

    pub fn breakdown(&self) -> &PreparedContextBreakdown {
        &self.0.totals
    }
    pub fn prefix_identity(&self, messages: usize) -> Option<String> {
        self.0.prefixes.get(messages).map(hex::encode)
    }
    pub fn identity(&self) -> String {
        hex::encode(
            self.0
                .prefixes
                .last()
                .expect("directory includes the empty prefix"),
        )
    }
}
impl RecipeSource<MessageRecipe> for FrozenDirectory {
    fn len(&self) -> usize {
        self.0.messages.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        Box::new(Cursor {
            directory: self.clone(),
            position: start,
        })
    }
}
impl MessageSource for FrozenDirectory {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        Box::new(MetadataCursor {
            directory: self.clone(),
            position: start,
        })
    }
    fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_> {
        Box::pin(async move {
            FrozenDirectory::prefix_identity(self, messages).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "logical prefix exceeds frozen directory",
                )
            })
        })
    }
}
struct MetadataCursor {
    directory: FrozenDirectory,
    position: usize,
}
impl RecipeCursor<MessageMetadata> for MetadataCursor {
    fn next(&mut self) -> NextRecipe<'_, MessageMetadata> {
        Box::pin(async move {
            let Some(message) = self.directory.0.messages.get(self.position) else {
                return Ok(None);
            };
            let result = MessageMetadata {
                message_index: self.position,
                logical_identity: message.logical_identity.clone(),
                role: message.role,
                settled_tool_call_ids: message.settled_tool_call_ids.clone(),
                local_tool_names: message.local_tool_names.clone(),
                last_is_tool_result: message.last_is_tool_result,
            };
            self.position += 1;
            Ok(Some(result))
        })
    }
}

/// Indexed part directory sharing the request's allocation owner.
#[derive(Clone)]
pub(crate) struct Items<T> {
    entries: Arc<[T]>,
    range: std::ops::Range<usize>,
    _owner: Arc<dyn Send + Sync>,
}
impl<T> Items<T> {
    pub fn new(entries: Vec<T>, owner: Arc<dyn Send + Sync>) -> Self {
        let end = entries.len();
        Self {
            entries: entries.into(),
            range: 0..end,
            _owner: owner,
        }
    }
    pub fn range(
        entries: Arc<[T]>,
        range: std::ops::Range<usize>,
        owner: Arc<dyn Send + Sync>,
    ) -> Self {
        assert!(
            range.start <= range.end && range.end <= entries.len(),
            "part range exceeds frozen directory"
        );
        Self {
            entries,
            range,
            _owner: owner,
        }
    }
}
impl<T: Clone + Send + Sync + 'static> RecipeSource<T> for Items<T> {
    fn len(&self) -> usize {
        self.range.end - self.range.start
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<T>> {
        Box::new(ItemsCursor {
            items: self.clone(),
            position: self.range.start.saturating_add(start),
        })
    }
}
struct ItemsCursor<T> {
    items: Items<T>,
    position: usize,
}
impl<T: Clone + Send + Sync + 'static> RecipeCursor<T> for ItemsCursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        Box::pin(async move {
            let result = (self.position < self.items.range.end)
                .then(|| self.items.entries[self.position].clone());
            self.position += usize::from(result.is_some());
            Ok(result)
        })
    }
}

struct Cursor {
    directory: FrozenDirectory,
    position: usize,
}
impl RecipeCursor<MessageRecipe> for Cursor {
    fn next(&mut self) -> NextRecipe<'_, MessageRecipe> {
        Box::pin(async move {
            let message = self.directory.0.messages.get(self.position);
            self.position += usize::from(message.is_some());
            Ok(message.map(|message| message.recipe.clone()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::prompt_source::source::{SourceBytes, TextEncoding, TextSource};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn message(text: &'static str) -> MessageDescriptor {
        MessageDescriptor {
            recipe: MessageRecipe::System {
                content: TextSource::new(
                    SourceBytes::Inline(text.as_bytes().into()),
                    TextEncoding::Utf8,
                ),
                provider_options: None,
            },
            role: MessageRole::System,
            last_is_tool_result: false,
            local_tool_names: Arc::new(Items::new(Vec::new(), Arc::new(()))),
            settled_tool_call_ids: Arc::new(Items::new(Vec::new(), Arc::new(()))),
            breakdown: PreparedContextBreakdown::default(),
            commitment: Sha256::digest(text.as_bytes()).into(),
            logical_identity: hex::encode(Sha256::digest(text.as_bytes())).into(),
        }
    }
    #[tokio::test]
    async fn append_preserves_prefix_and_cursor_retains_original_owner() {
        struct Owner(Arc<AtomicUsize>);
        impl Drop for Owner {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicUsize::new(0));
        let first = FrozenDirectory::new(vec![message("a")], Owner(dropped.clone()));
        let second = FrozenDirectory::new(vec![message("a"), message("b")], ());
        assert_eq!(first.prefix_identity(1), second.prefix_identity(1));
        assert_ne!(first.identity(), second.identity());
        let mut cursor = first.open(0);
        drop(first);
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        assert!(cursor.next().await.unwrap().is_some());
        assert!(cursor.next().await.unwrap().is_none());
        drop(cursor);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn metadata_and_prefix_remain_available_when_bodies_cannot_open() {
        use maka_agent_facts::model::prompt_source::source::{
            ByteCursor, ByteSource, SourceBudget,
        };
        struct Unreadable;
        impl ByteSource for Unreadable {
            fn len(&self) -> Option<u64> {
                Some(100)
            }
            fn open(&self, _: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
                panic!("metadata must never open a historical body")
            }
        }
        let text = TextSource::new(
            SourceBytes::Source(Arc::new(Unreadable)),
            TextEncoding::Utf8,
        );
        let descriptor = MessageDescriptor {
            recipe: MessageRecipe::User {
                content: Arc::new(Items::new(
                    vec![
                        maka_agent_facts::model::prompt_source::source::ContentRecipe::Text {
                            text: text.clone(),
                            provider_options: None,
                        },
                    ],
                    Arc::new(()),
                )),
                provider_options: None,
            },
            role: MessageRole::User,
            last_is_tool_result: false,
            local_tool_names: Arc::new(Items::new(Vec::new(), Arc::new(()))),
            settled_tool_call_ids: Arc::new(Items::new(Vec::new(), Arc::new(()))),
            breakdown: PreparedContextBreakdown::default(),
            commitment: [7; 32],
            logical_identity: hex::encode([7; 32]).into(),
        };
        let directory = FrozenDirectory::new(vec![descriptor], ());
        let expected = directory.identity();
        assert_eq!(
            directory.prefix_identity(1).as_deref(),
            Some(expected.as_str())
        );
        let mut metadata = directory.open_metadata(0);
        let item = metadata.next().await.unwrap().unwrap();
        assert_eq!(item.role, MessageRole::User);
        assert_eq!(item.message_index, 0);
        assert!(metadata.next().await.unwrap().is_none());
        let mut recipe = directory.open(0);
        assert!(matches!(
            recipe.next().await.unwrap(),
            Some(MessageRecipe::User { .. })
        ));
    }
}
