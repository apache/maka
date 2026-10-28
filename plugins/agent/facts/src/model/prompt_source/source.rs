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

//! Frozen input recipes and allocation ownership shared by sources and codecs.

use bytes::Bytes;
use std::{future::Future, io, ops::Range, pin::Pin, sync::Arc};

pub mod generated;
pub mod json;
pub mod text;

/// A caller-owned allocation that a source fills without replacing or growing it.
pub trait SourceBuffer: AsMut<[u8]> + Send + 'static {}

/// An initialized work buffer whose resource charge follows its final byte slice.
pub struct ChargedBuffer {
    bytes: Vec<u8>,
    visible: usize,
    _charge: Box<dyn Send + Sync>,
    _owner: Option<Box<dyn Send + Sync>>,
}

impl ChargedBuffer {
    /// The caller has already charged the allocation's complete capacity.
    pub fn new(bytes: Vec<u8>, charge: impl Send + Sync + 'static) -> Self {
        let visible = bytes.len();
        Self {
            bytes,
            visible,
            _charge: Box::new(charge),
            _owner: None,
        }
    }

    pub fn capacity(&self) -> usize {
        self.bytes.capacity()
    }

    /// Restrict the next work unit without releasing or reallocating its charge.
    pub fn limit(&mut self, maximum: usize) {
        self.visible = self.visible.min(maximum);
    }
    /// Bind this work unit's source custody through the final transport slice.
    /// Reusing a work buffer replaces its previous read owner without stacking it.
    pub fn retain_owner(mut self, owner: impl Send + Sync + 'static) -> Self {
        self._owner = Some(Box::new(owner));
        self
    }

    /// Transfer the allocation and its charge, including unused capacity.
    pub fn into_bytes(mut self, bytes_read: usize) -> Bytes {
        assert!(
            bytes_read <= self.visible,
            "source read exceeds its supplied buffer"
        );
        self.visible = bytes_read;
        Bytes::from_owner(self)
    }
}

impl std::fmt::Debug for ChargedBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChargedBuffer")
            .field("capacity", &self.capacity())
            .field("visible", &self.visible)
            .finish()
    }
}
impl AsRef<[u8]> for ChargedBuffer {
    fn as_ref(&self) -> &[u8] {
        &self.bytes[..self.visible]
    }
}
impl AsMut<[u8]> for ChargedBuffer {
    fn as_mut(&mut self) -> &mut [u8] {
        &mut self.bytes[..self.visible]
    }
}
impl SourceBuffer for ChargedBuffer {}

/// The same supplied buffer, after a bounded source read has physically settled.
#[derive(Debug)]
pub struct SourceRead {
    pub buffer: ChargedBuffer,
    pub bytes_read: usize,
    pub eof: bool,
}
pub type ReadSource<'a> = Pin<Box<dyn Future<Output = io::Result<SourceRead>> + Send + 'a>>;

/// A single immutable byte stream; its implementation retains the original read authority.
///
/// Database handles cannot escape into this object. Each read returns after its
/// bounded worker operation and transaction have settled. Multiple fragment JSON
/// envelopes must be decoded by their adapter, never concatenated as UTF-8 text.
pub trait ByteSource: Send + Sync {
    /// Encoded stream length, when already known without scanning the source.
    fn len(&self) -> Option<u64>;
    fn is_empty(&self) -> bool {
        self.len() == Some(0)
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor>;
    /// Mint a checked, directly addressable raw range; never scan from the start.
    fn slice(&self, _range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "source has no indexed raw ranges",
        ))
    }
}
/// Independent forward progress, including compound fragment and decoder state.
pub trait ByteCursor: Send {
    fn read_chunk(&mut self, buffer: ChargedBuffer) -> ReadSource<'_>;
}

pub type Allocate<'a> = Pin<Box<dyn Future<Output = io::Result<ChargedBuffer>> + Send + 'a>>;
/// Host-provided preparation resources, shared with the actual upload owner.
///
/// Callers reserve a complete progress envelope before reading; they must not
/// retain an input allocation while waiting for an unreserved output allocation.
/// Allocations subdivide that reservation, rather than waiting for a global
/// semaphore. A minimum beyond its capacity fails immediately.
pub trait SourceBudget: Send + Sync {
    fn allocate(&self, minimum: usize) -> Allocate<'_>;
}

pub type AcquireBudget<'a> =
    Pin<Box<dyn Future<Output = io::Result<Arc<dyn SourceBudget>>> + Send + 'a>>;
/// Resource admission without retaining a frozen input directory or read authority.
pub trait SourceBudgetFactory: Send + Sync {
    fn acquire(&self) -> AcquireBudget<'_>;
}

/// Inline values are explicit generated literals; history uses authorized sources.
#[derive(Clone)]
pub enum SourceBytes {
    Inline(Bytes),
    Source(Arc<dyn ByteSource>),
}
impl SourceBytes {
    pub fn len(&self) -> Option<u64> {
        match self {
            Self::Inline(bytes) => Some(bytes.len() as u64),
            Self::Source(source) => source.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == Some(0)
    }
    pub fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        match self {
            Self::Inline(bytes) => Box::new(InlineCursor {
                bytes: bytes.clone(),
                position: 0,
            }),
            Self::Source(source) => source.open(budget),
        }
    }
    pub fn slice(&self, range: Range<u64>) -> io::Result<Self> {
        if range.start > range.end {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "inverted source range",
            ));
        }
        match self {
            Self::Inline(bytes) => {
                let start = usize::try_from(range.start).map_err(io::Error::other)?;
                let end = usize::try_from(range.end).map_err(io::Error::other)?;
                if end > bytes.len() {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "source range exceeds its value",
                    ));
                }
                Ok(Self::Inline(bytes.slice(start..end)))
            }
            Self::Source(source) => Ok(Self::Source(source.slice(range)?)),
        }
    }
}
struct InlineCursor {
    bytes: Bytes,
    position: usize,
}
impl ByteCursor for InlineCursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let bytes_read = buffer.as_mut().len().min(self.bytes.len() - self.position);
            if bytes_read == 0 && self.position < self.bytes.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "empty source work buffer",
                ));
            }
            buffer.as_mut()[..bytes_read]
                .copy_from_slice(&self.bytes[self.position..self.position + bytes_read]);
            self.position += bytes_read;
            Ok(SourceRead {
                buffer: buffer.retain_owner(self.bytes.clone()),
                bytes_read,
                eof: self.position == self.bytes.len(),
            })
        })
    }
}
impl std::fmt::Debug for SourceBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Inline(bytes) => f.debug_tuple("Inline").field(&bytes.len()).finish(),
            Self::Source(source) => f.debug_tuple("Source").field(&source.len()).finish(),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    JsonString,
}
/// `JsonString` includes both quotes; `Utf8` is decoded text.
#[derive(Clone, Debug)]
pub struct TextSource {
    pub bytes: SourceBytes,
    pub encoding: TextEncoding,
}
/// One already-validated JSON value, preserving its insertion order.
#[derive(Clone, Debug)]
pub struct JsonSource {
    pub bytes: SourceBytes,
}
impl JsonSource {
    pub fn slice(&self, range: Range<u64>) -> io::Result<Self> {
        Ok(Self {
            bytes: self.bytes.slice(range)?,
        })
    }
}
/// A text value paired with its capture-time decoded-content commitment.
#[derive(Clone, Debug)]
pub struct IdentifiedText {
    pub text: TextSource,
    pub identity: [u8; 32],
}
impl PartialEq for IdentifiedText {
    fn eq(&self, other: &Self) -> bool {
        self.identity == other.identity
    }
}
impl Eq for IdentifiedText {}
impl std::hash::Hash for IdentifiedText {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::hash::Hash::hash(&self.identity, state);
    }
}
/// Captured immutable media bytes, before base64 encoding.
#[derive(Clone, Debug)]
pub struct MediaSource {
    pub bytes: SourceBytes,
    pub media_type: TextSource,
    pub detail: Option<TextSource>,
}

pub type NextRecipe<'a, T> = Pin<Box<dyn Future<Output = io::Result<Option<T>>> + Send + 'a>>;
pub trait RecipeCursor<T>: Send {
    fn next(&mut self) -> NextRecipe<'_, T>;
}
/// A charged frozen directory, including a direct indexed starting position.
pub trait RecipeSource<T>: Send + Sync {
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<T>>;
}

#[derive(Clone)]
pub enum ContentRecipe {
    Text {
        text: TextSource,
        provider_options: Option<JsonSource>,
    },
    Media {
        media: MediaSource,
        provider_options: Option<JsonSource>,
    },
}
#[derive(Clone)]
pub enum ToolInputRecipe {
    Text(TextSource),
    Json(JsonSource),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCallKind {
    Function,
    Custom,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolResultKind {
    Settled,
    Notification,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolResultReplay {
    Ordinary,
    AnthropicMcp,
}
#[derive(Clone)]
pub enum ToolOutputRecipe {
    Text(TextSource),
    ErrorText(TextSource),
    Json(JsonSource),
    ErrorJson(JsonSource),
    Content(Arc<dyn RecipeSource<ContentRecipe>>),
}
#[derive(Clone)]
pub struct ParsedToolError {
    pub value: JsonSource,
    pub code_value: JsonSource,
}
#[derive(Clone)]
pub struct ToolResultRecipe {
    pub tool_call_id: TextSource,
    pub tool_name: TextSource,
    pub kind: ToolResultKind,
    pub call_kind: ToolCallKind,
    pub output: ToolOutputRecipe,
    pub parsed_error: Option<ParsedToolError>,
    pub replay: ToolResultReplay,
    pub provider_options: Option<JsonSource>,
}
#[derive(Clone)]
pub enum AssistantRecipe {
    Text {
        text: TextSource,
        provider_options: Option<JsonSource>,
    },
    Reasoning {
        text: TextSource,
        provider_options: Option<JsonSource>,
    },
    ToolCall {
        tool_call_id: TextSource,
        tool_name: TextSource,
        input: ToolInputRecipe,
        kind: ToolCallKind,
        provider_executed: Option<bool>,
        provider_options: Option<JsonSource>,
    },
    ToolResult(ToolResultRecipe),
}
#[derive(Clone)]
pub enum MessageRecipe {
    System {
        content: TextSource,
        provider_options: Option<JsonSource>,
    },
    User {
        content: Arc<dyn RecipeSource<ContentRecipe>>,
        provider_options: Option<JsonSource>,
    },
    Assistant {
        content: Arc<dyn RecipeSource<AssistantRecipe>>,
        provider_options: Option<JsonSource>,
    },
    Tool {
        content: Arc<dyn RecipeSource<ToolResultRecipe>>,
        provider_options: Option<JsonSource>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}
/// Frozen Responses decisions; querying them must never open message bodies.
#[derive(Clone)]
pub struct MessageMetadata {
    pub message_index: usize,
    pub logical_identity: Arc<str>,
    pub role: MessageRole,
    pub last_is_tool_result: bool,
    pub local_tool_names: Arc<dyn RecipeSource<IdentifiedText>>,
    pub settled_tool_call_ids: Arc<dyn RecipeSource<IdentifiedText>>,
}
pub type RecipeIdentity<'a> = Pin<Box<dyn Future<Output = io::Result<String>> + Send + 'a>>;
/// Frozen message recipes and the body-independent metadata used by transports.
pub trait MessageSource: RecipeSource<MessageRecipe> {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>>;
    fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Charge(Arc<AtomicUsize>);
    impl Drop for Charge {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    #[test]
    fn final_slice_keeps_the_allocation_charge() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let source_dropped = Arc::new(AtomicUsize::new(0));
        let mut buffer = ChargedBuffer::new(vec![0; 16], Charge(dropped.clone()))
            .retain_owner(Charge(source_dropped.clone()));
        buffer.as_mut()[..5].copy_from_slice(b"hello");
        let bytes = buffer.into_bytes(5);
        let tail = bytes.slice(1..);
        drop(bytes);
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        assert_eq!(source_dropped.load(Ordering::SeqCst), 0);
        assert_eq!(&tail[..], b"ello");
        drop(tail);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert_eq!(source_dropped.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn reused_buffer_keeps_only_its_current_source_owner() {
        let allocation_dropped = Arc::new(AtomicUsize::new(0));
        let source_dropped = Arc::new(AtomicUsize::new(0));
        let mut buffer = ChargedBuffer::new(vec![0; 16], Charge(allocation_dropped.clone()));
        for _ in 0..128 {
            buffer = buffer.retain_owner(Charge(source_dropped.clone()));
        }
        assert_eq!(source_dropped.load(Ordering::SeqCst), 127);
        assert_eq!(allocation_dropped.load(Ordering::SeqCst), 0);
        drop(buffer);
        assert_eq!(source_dropped.load(Ordering::SeqCst), 128);
        assert_eq!(allocation_dropped.load(Ordering::SeqCst), 1);
    }
}
