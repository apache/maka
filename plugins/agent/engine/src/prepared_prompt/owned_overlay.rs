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

//! The actual generated overlay shapes: one System or one plaintext User value.
use maka_agent_facts::{
    context::PreparedContextBreakdown,
    model::prompt_source::{PromptInstructions, source::*},
};
use maka_event_log::context::ContextView;
use maka_provider_protocol::json_stream::pull::{JsonEscape, Transform};
use sha2::{Digest, Sha256};
use std::{io, mem, ops::Range, sync::Arc};

#[derive(Clone)]
pub(crate) struct OwnedOverlay(Arc<Overlay>, Option<Arc<Binding>>);
struct Overlay {
    text: TextOwner,
    recipe: MessageRecipe,
    metadata: MessageMetadata,
    breakdown: PreparedContextBreakdown,
    instructions: Option<PromptInstructions>,
}
struct Binding {
    overlay: Arc<Overlay>,
    recipe: MessageRecipe,
    metadata: MessageMetadata,
    instructions: Option<PromptInstructions>,
    _owner: Arc<dyn Send + Sync>,
}
impl OwnedOverlay {
    pub fn system_metadata_bytes() -> usize {
        arc_bytes::<Overlay>()
            + arc_bytes::<OwnedString>()
            + arc_bytes::<EmptyIds>()
            + arc_slice_bytes::<u8>(Sha256::output_size() * 2)
    }
    pub fn user_metadata_bytes() -> usize {
        Self::system_metadata_bytes() + arc_bytes::<PlainUser>()
    }
    pub fn checkpoint_metadata_bytes() -> usize {
        Self::user_metadata_bytes()
    }
    pub fn system_binding_metadata_bytes() -> usize {
        arc_bytes::<Binding>() + arc_bytes::<BoundString>() + arc_bytes::<BoundIds>()
    }
    pub fn user_binding_metadata_bytes() -> usize {
        Self::system_binding_metadata_bytes() + arc_bytes::<PlainUser>()
    }
    pub fn system(text: Arc<String>) -> Self {
        Self::new(TextOwner::Owned(text), MessageRole::System)
    }
    pub fn user(text: Arc<String>) -> Self {
        Self::new(TextOwner::Owned(text), MessageRole::User)
    }
    /// The label contains the complete separator, including the original blank line.
    pub fn checkpoint(source: Arc<ContextView>, label: &'static str) -> Option<Self> {
        source.baseline.as_ref()?;
        Some(Self::new(
            TextOwner::Checkpoint { source, label },
            MessageRole::User,
        ))
    }
    fn new(text: TextOwner, role: MessageRole) -> Self {
        let source = TextSource::new(
            SourceBytes::Source(Arc::new(OwnedString {
                text: text.clone(),
                range: 0..text.len(),
            })),
            TextEncoding::Utf8,
        );
        let recipe = match role {
            MessageRole::System => MessageRecipe::System {
                content: source,
                provider_options: None,
            },
            MessageRole::User => MessageRecipe::User {
                content: Arc::new(PlainUser { text: source }),
                provider_options: None,
            },
            _ => unreachable!("generated overlays have only System and User roles"),
        };
        let identity: Arc<str> = hex::encode(text.commitment(role)).into();
        let mut breakdown = PreparedContextBreakdown::default();
        breakdown.counts.messages = 1;
        let bucket = match role {
            MessageRole::System => &mut breakdown.system,
            _ => &mut breakdown.user,
        };
        bucket.content_bytes = text.len() as u64;
        bucket.estimated_tokens = 16 + (text.len() as u64).div_ceil(3);
        let empty: Arc<dyn RecipeSource<IdentifiedText>> = Arc::new(EmptyIds);
        let metadata = MessageMetadata {
            message_index: 0,
            logical_identity: identity,
            role,
            last_is_tool_result: false,
            local_tool_names: empty.clone(),
            settled_tool_call_ids: empty,
        };
        let instructions = match &text {
            TextOwner::Owned(value) if role == MessageRole::System && !value.trim().is_empty() => {
                Some(PromptInstructions::owned(value.clone()))
            }
            _ => None,
        };
        Self(
            Arc::new(Overlay {
                text,
                recipe,
                metadata,
                breakdown,
                instructions,
            }),
            None,
        )
    }
    /// Create a per-request accounting view; the shared input DTO never retains it.
    pub fn bound(&self, owner: Arc<dyn Send + Sync>) -> Self {
        let source = TextSource::new(
            SourceBytes::Source(Arc::new(BoundString {
                overlay: self.0.clone(),
                range: 0..self.0.text.len(),
                owner: owner.clone(),
            })),
            TextEncoding::Utf8,
        );
        let recipe = match self.0.metadata.role {
            MessageRole::System => MessageRecipe::System {
                content: source,
                provider_options: None,
            },
            MessageRole::User => MessageRecipe::User {
                content: Arc::new(PlainUser { text: source }),
                provider_options: None,
            },
            _ => unreachable!("generated overlay role"),
        };
        let empty: Arc<dyn RecipeSource<IdentifiedText>> = Arc::new(BoundIds {
            _owner: owner.clone(),
        });
        let mut metadata = self.0.metadata.clone();
        metadata.local_tool_names = empty.clone();
        metadata.settled_tool_call_ids = empty;
        let instructions = self
            .0
            .instructions
            .clone()
            .map(|instructions| instructions.with_owner(owner.clone()));
        Self(
            self.0.clone(),
            Some(Arc::new(Binding {
                overlay: self.0.clone(),
                recipe,
                metadata,
                instructions,
                _owner: owner,
            })),
        )
    }
    pub fn recipe(&self) -> MessageRecipe {
        self.1
            .as_ref()
            .map_or_else(|| self.0.recipe.clone(), |binding| binding.recipe.clone())
    }
    pub fn metadata(&self, index: usize) -> MessageMetadata {
        let mut metadata = self.1.as_ref().map_or_else(
            || self.0.metadata.clone(),
            |binding| binding.metadata.clone(),
        );
        metadata.message_index = index;
        metadata
    }
    pub fn identity(&self) -> &str {
        &self.0.metadata.logical_identity
    }
    pub fn breakdown(&self) -> &PreparedContextBreakdown {
        &self.0.breakdown
    }
    pub fn instructions(&self) -> Option<PromptInstructions> {
        self.1.as_ref().map_or_else(
            || self.0.instructions.clone(),
            |binding| binding.instructions.clone(),
        )
    }
    /// Explicit generated/UI DTO boundary; native request preparation uses `source`.
    pub fn owned_message(&self) -> maka_agent_facts::model::prompt::Message {
        use maka_agent_facts::model::prompt::Message;
        match self.0.metadata.role {
            MessageRole::System => Message::System {
                content: self.0.text.materialize(),
                provider_options: None,
            },
            MessageRole::User => Message::user(self.0.text.materialize()),
            _ => unreachable!("generated overlay role"),
        }
    }
    pub fn source(&self) -> Arc<dyn MessageSource> {
        match &self.1 {
            Some(binding) => binding.clone(),
            None => self.0.clone(),
        }
    }
}
impl RecipeSource<MessageRecipe> for Overlay {
    fn len(&self) -> usize {
        1
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        Box::new(One {
            value: (start == 0).then(|| self.recipe.clone()),
        })
    }
}
impl MessageSource for Overlay {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        Box::new(One {
            value: (start == 0).then(|| self.metadata.clone()),
        })
    }
    fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_> {
        Box::pin(async move {
            if messages > 1 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "overlay prefix exceeds its message",
                ));
            }
            let mut hash = Sha256::new();
            hash.update(b"maka.logical-prefix\0");
            if messages == 1 {
                hash.update(self.metadata.logical_identity.as_bytes());
            }
            Ok(hex::encode(hash.finalize()))
        })
    }
}
impl RecipeSource<MessageRecipe> for Binding {
    fn len(&self) -> usize {
        1
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        Box::new(One {
            value: (start == 0).then(|| self.recipe.clone()),
        })
    }
}
impl MessageSource for Binding {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        Box::new(One {
            value: (start == 0).then(|| self.metadata.clone()),
        })
    }
    fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_> {
        self.overlay.prefix_identity(messages)
    }
}

#[derive(Clone)]
struct BoundString {
    overlay: Arc<Overlay>,
    range: Range<usize>,
    owner: Arc<dyn Send + Sync>,
}
impl ByteSource for BoundString {
    fn len(&self) -> Option<u64> {
        Some((self.range.end - self.range.start) as u64)
    }
    fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(BoundStringCursor {
            source: self.clone(),
            position: self.range.start,
        })
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        if range.start > range.end || range.end > (self.range.end - self.range.start) as u64 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "bound overlay slice exceeds text",
            ));
        }
        Ok(Arc::new(Self {
            overlay: self.overlay.clone(),
            owner: self.owner.clone(),
            range: (self.range.start + range.start as usize)
                ..(self.range.start + range.end as usize),
        }))
    }
}
struct BoundStringCursor {
    source: BoundString,
    position: usize,
}
impl ByteCursor for BoundStringCursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let bytes_read = buffer
                .as_mut()
                .len()
                .min(self.source.range.end - self.position);
            if bytes_read == 0 && self.position < self.source.range.end {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "empty bound overlay work buffer",
                ));
            }
            self.source
                .overlay
                .text
                .copy_range(self.position, &mut buffer.as_mut()[..bytes_read]);
            self.position += bytes_read;
            Ok(SourceRead {
                buffer: buffer
                    .retain_owner((self.source.overlay.clone(), self.source.owner.clone())),
                bytes_read,
                eof: self.position == self.source.range.end,
            })
        })
    }
}
struct BoundIds {
    _owner: Arc<dyn Send + Sync>,
}
impl RecipeSource<IdentifiedText> for BoundIds {
    fn len(&self) -> usize {
        0
    }
    fn open(&self, _start: usize) -> Box<dyn RecipeCursor<IdentifiedText>> {
        Box::new(BoundEmpty {
            _owner: self._owner.clone(),
        })
    }
}
struct BoundEmpty {
    _owner: Arc<dyn Send + Sync>,
}
impl RecipeCursor<IdentifiedText> for BoundEmpty {
    fn next(&mut self) -> NextRecipe<'_, IdentifiedText> {
        Box::pin(async { Ok(None) })
    }
}

#[derive(Clone)]
enum TextOwner {
    Owned(Arc<String>),
    Checkpoint {
        source: Arc<ContextView>,
        label: &'static str,
    },
}
impl TextOwner {
    fn parts(&self) -> [&str; 2] {
        match self {
            Self::Owned(text) => [text.as_str(), ""],
            Self::Checkpoint { source, label } => [
                label,
                &source
                    .baseline
                    .as_ref()
                    .expect("captured checkpoint baseline")
                    .checkpoint
                    .summary
                    .text,
            ],
        }
    }
    fn len(&self) -> usize {
        self.parts().iter().map(|part| part.len()).sum()
    }
    fn copy_range(&self, position: usize, output: &mut [u8]) {
        let [prefix, body] = self.parts();
        let first = output.len().min(prefix.len().saturating_sub(position));
        if first != 0 {
            output[..first].copy_from_slice(&prefix.as_bytes()[position..position + first]);
        }
        let body_start = position.saturating_sub(prefix.len());
        let remaining = output.len() - first;
        output[first..].copy_from_slice(&body.as_bytes()[body_start..body_start + remaining]);
    }
    fn materialize(&self) -> String {
        match self {
            Self::Owned(text) => text.as_ref().clone(),
            Self::Checkpoint { .. } => {
                let mut text = String::with_capacity(self.len());
                for part in self.parts() {
                    text.push_str(part);
                }
                text
            }
        }
    }
    fn commitment(&self, role: MessageRole) -> [u8; 32] {
        let mut hash = Sha256::new();
        hash.update(match role {
            MessageRole::System => b"{\"role\":\"system\",\"content\":\"".as_slice(),
            MessageRole::User => {
                b"{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"".as_slice()
            }
            _ => unreachable!("generated overlay role"),
        });
        let mut escape = JsonEscape::new();
        let mut output = [0; 4096];
        for (index, part) in self.parts().into_iter().enumerate() {
            let mut consumed = 0;
            loop {
                let progress = escape
                    .transform(&part.as_bytes()[consumed..], index == 1, &mut output)
                    .expect("validated overlay text escapes");
                consumed += progress.consumed;
                hash.update(&output[..progress.written]);
                if progress.finished
                    || (index == 0 && progress.consumed == 0 && progress.written == 0)
                {
                    break;
                }
            }
        }
        hash.update(match role {
            MessageRole::System => b"\"}".as_slice(),
            _ => b"\"}]}".as_slice(),
        });
        hash.finalize().into()
    }
}

#[derive(Clone)]
struct OwnedString {
    text: TextOwner,
    range: Range<usize>,
}
impl ByteSource for OwnedString {
    fn len(&self) -> Option<u64> {
        Some((self.range.end - self.range.start) as u64)
    }
    fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(StringCursor {
            source: self.clone(),
            position: self.range.start,
        })
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        if range.start > range.end || range.end > (self.range.end - self.range.start) as u64 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "owned overlay slice exceeds text",
            ));
        }
        Ok(Arc::new(Self {
            text: self.text.clone(),
            range: (self.range.start + range.start as usize)
                ..(self.range.start + range.end as usize),
        }))
    }
}
struct StringCursor {
    source: OwnedString,
    position: usize,
}
impl ByteCursor for StringCursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let bytes_read = buffer
                .as_mut()
                .len()
                .min(self.source.range.end - self.position);
            if bytes_read == 0 && self.position < self.source.range.end {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "empty overlay work buffer",
                ));
            }
            self.source
                .text
                .copy_range(self.position, &mut buffer.as_mut()[..bytes_read]);
            self.position += bytes_read;
            Ok(SourceRead {
                buffer: buffer.retain_owner(self.source.text.clone()),
                bytes_read,
                eof: self.position == self.source.range.end,
            })
        })
    }
}
struct PlainUser {
    text: TextSource,
}
impl RecipeSource<ContentRecipe> for PlainUser {
    fn len(&self) -> usize {
        1
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<ContentRecipe>> {
        Box::new(One {
            value: (start == 0).then(|| ContentRecipe::Text {
                text: self.text.clone(),
                provider_options: None,
            }),
        })
    }
}
struct EmptyIds;
impl RecipeSource<IdentifiedText> for EmptyIds {
    fn len(&self) -> usize {
        0
    }
    fn open(&self, _start: usize) -> Box<dyn RecipeCursor<IdentifiedText>> {
        Box::new(One { value: None })
    }
}
struct One<T> {
    value: Option<T>,
}
impl<T: Send + 'static> RecipeCursor<T> for One<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        Box::pin(async move { Ok(self.value.take()) })
    }
}
fn arc_bytes<T>() -> usize {
    arc_slice_bytes::<T>(1)
}
fn arc_slice_bytes<T>(len: usize) -> usize {
    let header = 2 * mem::size_of::<usize>();
    let alignment = mem::align_of::<T>();
    let offset = (header + alignment - 1) & !(alignment - 1);
    let allocation_alignment = alignment.max(mem::align_of::<usize>());
    (offset + mem::size_of::<T>() * len + allocation_alignment - 1) & !(allocation_alignment - 1)
}
