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

//! Immutable, replayable model input. Opening a cursor never changes its view.
use super::{error::ModelError, prompt::Message, request::ProviderKind};
use crate::context::PreparedContextBreakdown;
use bytes::Bytes;
use sha2::{Digest, Sha256};
use std::{future::Future, pin::Pin, sync::Arc};

mod instructions;
pub mod source;
pub use instructions::PromptInstructions;

pub type Next<'a> = Pin<Box<dyn Future<Output = Result<Option<Message>, ModelError>> + Send + 'a>>;

pub trait PromptCursor: Send {
    fn next(&mut self) -> Next<'_>;
}

/// Implementations pin their semantic root and captured media for every cursor.
pub trait PromptSource: Send + Sync {
    fn open(&self) -> Box<dyn PromptCursor>;
}

#[derive(Clone)]
pub struct Prompt {
    source: Option<Arc<dyn PromptSource>>,
    recipes: Option<Arc<dyn source::MessageSource>>,
    identity: Arc<str>,
    count: usize,
    breakdown: PreparedContextBreakdown,
    normalization: Option<ProviderKind>,
    memory: Option<Arc<Vec<Message>>>,
    wire: Option<PreparedWire>,
    instructions: Option<PromptInstructions>,
}

impl Prompt {
    pub fn new(
        source: Arc<dyn PromptSource>,
        identity: impl Into<Arc<str>>,
        count: usize,
        breakdown: PreparedContextBreakdown,
    ) -> Self {
        Self {
            source: Some(source),
            recipes: None,
            identity: identity.into(),
            count,
            breakdown,
            normalization: None,
            memory: None,
            wire: None,
            instructions: None,
        }
    }
    /// Production history enters through immutable source recipes, never owned messages.
    pub fn from_recipes(
        source: Arc<dyn source::MessageSource>,
        identity: impl Into<Arc<str>>,
        count: usize,
        breakdown: PreparedContextBreakdown,
    ) -> Self {
        Self {
            source: None,
            recipes: Some(source),
            identity: identity.into(),
            count,
            breakdown,
            normalization: None,
            memory: None,
            wire: None,
            instructions: None,
        }
    }
    pub fn recipes(&self) -> Option<&Arc<dyn source::MessageSource>> {
        self.recipes.as_ref()
    }
    /// Bind the primary persisted provider representation for this fixed view.
    pub fn with_wire(
        mut self,
        format: WireFormat,
        codec: impl Into<Arc<str>>,
        identity: impl Into<Arc<str>>,
        source: Arc<dyn WireSource>,
    ) -> Self {
        let codec = codec.into();
        let identity = identity.into();
        let mut hash = Sha256::new();
        hash.update(b"maka-prepared-prompt-v1\0");
        for component in [self.identity.as_ref(), codec.as_ref(), identity.as_ref()] {
            hash.update((component.len() as u64).to_le_bytes());
            hash.update(component.as_bytes());
        }
        hash.update([match format {
            WireFormat::ChatCompletions => 0,
            WireFormat::Responses => 1,
            WireFormat::Anthropic => 2,
        }]);
        self.identity = hex::encode(hash.finalize()).into();
        self.wire = Some(PreparedWire {
            format,
            codec,
            identity,
            source,
        });
        self
    }
    /// Captured first nonblank system instruction, including an explicit empty
    /// value when no system instruction exists. Subscription adapters read it
    /// without opening semantic history.
    pub fn with_instructions(self, instructions: impl Into<Arc<str>>) -> Self {
        self.with_instruction_source(PromptInstructions::shared(instructions.into()))
    }
    /// Bind already-frozen instructions without copying or rehashing their text.
    pub fn with_instruction_source(mut self, instructions: PromptInstructions) -> Self {
        let mut hash = Sha256::new();
        hash.update(b"maka-prompt-instructions\0");
        hash.update((self.identity.len() as u64).to_le_bytes());
        hash.update(self.identity.as_bytes());
        hash.update(instructions.commitment());
        self.identity = hex::encode(hash.finalize()).into();
        self.instructions = Some(instructions);
        self
    }
    pub fn with_instructions_from(self, original: &Self) -> Self {
        self.with_instruction_source(
            original
                .instructions
                .clone()
                .unwrap_or_else(PromptInstructions::empty),
        )
    }
    pub fn instructions_source(&self) -> Option<PromptInstructions> {
        self.instructions.clone()
    }
    pub fn instructions(&self) -> Option<&str> {
        self.instructions.as_ref().map(PromptInstructions::as_str)
    }
    pub fn wire(&self, format: WireFormat) -> Option<&PreparedWire> {
        self.wire.as_ref().filter(|wire| wire.format == format)
    }
    /// Capture-time projection policy, after reasoning normalization and metering.
    pub fn with_normalization(mut self, provider: ProviderKind) -> Self {
        self.normalization = Some(provider);
        self
    }
    pub fn normalization(&self) -> Option<&ProviderKind> {
        self.normalization.as_ref()
    }
    /// Only explicit small input constructors expose their in-memory source.
    pub fn memory_messages(&self) -> Option<&[Message]> {
        self.memory.as_deref().map(Vec::as_slice)
    }
    pub fn open(&self) -> Box<dyn PromptCursor> {
        match &self.source {
            Some(source) => source.open(),
            None => Box::new(RecipeOnly),
        }
    }
    pub fn identity(&self) -> &str {
        &self.identity
    }
    /// Number of messages in the captured view.
    pub fn len(&self) -> usize {
        self.count
    }
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }
    pub fn breakdown(&self) -> &PreparedContextBreakdown {
        &self.breakdown
    }

    /// Explicit in-memory input for small generated requests and adapter tests.
    /// Persisted conversation history must use a fixed storage-backed source.
    pub fn from_messages(messages: Vec<Message>) -> Self {
        let breakdown = crate::context::measure::prompt_breakdown(&messages);
        struct HashWriter(Sha256);
        impl std::io::Write for HashWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.update(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut hash = HashWriter(Sha256::new());
        hash.0.update(b"maka-prompt-memory-v1\0");
        serde_json::to_writer(&mut hash, &messages).expect("prompt JSON");
        let identity = hex::encode(hash.0.finalize());
        let count = messages.len();
        let messages = Arc::new(messages);
        let instructions = messages.iter().enumerate().find_map(|(index, message)| {
            matches!(message, Message::System { content, .. } if !content.trim().is_empty())
                .then(|| PromptInstructions::generated(messages.clone(), index))
        });
        let mut prompt = Self::new(
            Arc::new(Memory(messages.clone())),
            identity,
            count,
            breakdown,
        );
        prompt.memory = Some(messages);
        prompt.instructions = instructions;
        prompt.recipes = Some(Arc::new(source::generated::GeneratedMessages::new(
            prompt.memory.as_deref().expect("generated message source"),
        )));
        prompt
    }
}
struct RecipeOnly;
impl PromptCursor for RecipeOnly {
    fn next(&mut self) -> Next<'_> {
        Box::pin(async {
            Err(ModelError::Adapter(
                "source-backed prompt requires a recipe cursor".into(),
            ))
        })
    }
}
impl From<Vec<Message>> for Prompt {
    fn from(messages: Vec<Message>) -> Self {
        Self::from_messages(messages)
    }
}
impl std::fmt::Debug for Prompt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Prompt")
            .field("identity", &self.identity)
            .field("count", &self.count)
            .finish()
    }
}
struct Memory(Arc<Vec<Message>>);
impl PromptSource for Memory {
    fn open(&self) -> Box<dyn PromptCursor> {
        Box::new(MemoryCursor {
            messages: self.0.clone(),
            offset: 0,
        })
    }
}
struct MemoryCursor {
    messages: Arc<Vec<Message>>,
    offset: usize,
}
impl PromptCursor for MemoryCursor {
    fn next(&mut self) -> Next<'_> {
        Box::pin(async move {
            let result = self.messages.get(self.offset).cloned();
            self.offset += usize::from(result.is_some());
            Ok(result)
        })
    }
}

/// Wire codecs have independent fingerprints; transport credentials and top-level
/// sampling fields are never part of a stored historical message body.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireFormat {
    ChatCompletions,
    Responses,
    Anthropic,
}

/// One bounded slice of a complete provider array item. Array brackets and item
/// separators belong to the request encoder. Metadata contains no body payload.
pub struct WireChunk {
    pub bytes: Bytes,
    pub item_start: bool,
    pub item_end: bool,
    pub message_index: usize,
    pub metadata: Option<WireItemMetadata>,
}
pub type NextWire<'a> =
    Pin<Box<dyn Future<Output = Result<Option<WireChunk>, ModelError>> + Send + 'a>>;
pub trait WireCursor: Send {
    fn next(&mut self) -> NextWire<'_>;
    /// Share the active cursor's existing progress envelope with provider overlays.
    fn budget(&self) -> Option<Arc<dyn source::SourceBudget>> {
        None
    }
}
pub type PrefixIdentity<'a> =
    Pin<Box<dyn Future<Output = Result<Option<String>, ModelError>> + Send + 'a>>;
#[derive(Clone, Copy, Debug)]
pub struct WirePosition {
    pub message_index: usize,
    /// Stable source-owned logical item/part location, independent of output chunk sizes.
    pub piece_index: usize,
}
pub struct WireMetadata {
    pub position: WirePosition,
    pub message_index: usize,
    pub metadata: WireItemMetadata,
}
#[derive(Clone)]
pub enum WireItemMetadata {
    Message(source::MessageMetadata),
    /// Only explicit generated-memory inputs and protocol oracles use owned metadata.
    GeneratedAnthropic(Arc<maka_provider_protocol::anthropic::prompt::prepared::PartMetadata>),
    Anthropic(
        Arc<
            maka_provider_protocol::anthropic::prompt::prepared::PartMetadata<
                source::IdentifiedText,
                maka_provider_protocol::anthropic::prompt::prepared::FrozenCacheCandidate,
            >,
        >,
    ),
}
pub type NextWireMetadata<'a> =
    Pin<Box<dyn Future<Output = Result<Option<WireMetadata>, ModelError>> + Send + 'a>>;
pub trait WireMetadataCursor: Send {
    fn next(&mut self) -> NextWireMetadata<'_>;
}
pub type AcquireWireBudget<'a> =
    Pin<Box<dyn Future<Output = std::io::Result<Arc<dyn source::SourceBudget>>> + Send + 'a>>;
pub type NextWireDocument<'a> = Pin<
    Box<
        dyn Future<
                Output = Result<
                    Option<
                        maka_provider_protocol::anthropic::prompt::prepared::DocumentMetadata<
                            source::IdentifiedText,
                        >,
                    >,
                    ModelError,
                >,
            > + Send
            + 'a,
    >,
>;
pub type HasSource<'a> = Pin<Box<dyn Future<Output = Result<bool, ModelError>> + Send + 'a>>;
pub trait SourceIdentityLookup: Send + Sync {
    fn contains(&self, identity: [u8; 32], budget: Arc<dyn source::SourceBudget>) -> HasSource<'_>;
}
pub trait WireSource: Send + Sync {
    fn source_identities(&self) -> Option<Arc<dyn SourceIdentityLookup>> {
        None
    }

    fn document_count(&self) -> usize {
        0
    }
    fn document(
        &self,
        _index: usize,
        _budget: Arc<dyn source::SourceBudget>,
    ) -> NextWireDocument<'_> {
        Box::pin(async { Ok(None) })
    }

    /// Detached resources for response-time work, without retaining this directory.
    fn budget_factory(&self) -> Option<Arc<dyn source::SourceBudgetFactory>> {
        None
    }
    /// Production native transforms require their pre-admitted work envelope.
    fn budget(&self) -> Option<Arc<dyn source::SourceBudget>> {
        None
    }
    /// Admit one ephemeral work envelope. Frozen sources do not retain it.
    fn acquire_budget(&self) -> AcquireWireBudget<'_> {
        Box::pin(async move {
            if let Some(factory) = self.budget_factory() {
                return factory.acquire().await;
            }
            self.budget().ok_or_else(|| {
                std::io::Error::other("wire source has no preparation work envelope")
            })
        })
    }
    /// Open at an indexed item without consuming preceding body bytes.
    fn open_at(&self, _position: WirePosition) -> Option<Box<dyn WireCursor>> {
        None
    }

    /// Provider decisions use only indexed metadata; this cursor must not load
    /// body chunks or decode semantic Message payloads.
    fn open_metadata(&self, _start_message: usize) -> Option<Box<dyn WireMetadataCursor>> {
        None
    }
    /// Skip logical input messages using the stored item/range index, never by
    /// reading or decoding the skipped body bytes.
    fn open(&self, start_message: usize) -> Box<dyn WireCursor>;
    /// Ordered structural identity of a logical prefix, excluding later items.
    /// Sources without a persistent prefix index are used only for small input.
    fn prefix_identity(&self, _messages: usize) -> PrefixIdentity<'_> {
        Box::pin(async { Ok(None) })
    }
}
#[derive(Clone)]
pub struct PreparedWire {
    pub format: WireFormat,
    pub codec: Arc<str>,
    pub identity: Arc<str>,
    pub source: Arc<dyn WireSource>,
}
impl PreparedWire {
    pub fn open(&self, start_message: usize) -> Box<dyn WireCursor> {
        self.source.open(start_message)
    }
}

/// A dirty group's codec owns only the current input and encoder state. Storage
/// consumes and commits the iterator without collecting the encoded body.
pub struct WireGroup {
    pub format: WireFormat,
    pub codec: String,
    pub message_count: usize,
    pub chunks: Box<dyn Iterator<Item = Result<WireChunk, ModelError>> + Send>,
}
