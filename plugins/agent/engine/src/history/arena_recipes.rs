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

//! Numeric recipe records in the request's existing arena.

use super::{
    capture_arena::CaptureArena,
    source_reference::{SourceRecord, WORDS as SOURCE_WORDS},
};
use maka_agent_facts::model::prompt_source::source::*;
use std::{io, marker::PhantomData, sync::Arc};
use tokio_util::sync::CancellationToken;

const MEASURE_WORD: usize = 2 + SOURCE_WORDS;
const WORDS: usize = MEASURE_WORD + 6;
pub(crate) type Record = [u64; WORDS];
const RECORD_BYTES: usize = std::mem::size_of::<Record>();
const LEAF: u64 = 1;
const LIST: u64 = 2;
const CONTENT_TEXT: u64 = 3;
const CONTENT_MEDIA: u64 = 4;
const ASSISTANT_TEXT: u64 = 5;
const ASSISTANT_REASONING: u64 = 6;
const ASSISTANT_CALL: u64 = 7;
const ASSISTANT_RESULT: u64 = 8;
const RESULT: u64 = 9;
const MESSAGE: u64 = 10;
const IDENTIFIED_TEXT: u64 = 12;
const CONTENT_TEXT_LIST: u64 = 13;

/// Zero denotes an absent optional reference; actual arena positions use +1.
#[derive(Clone, Copy)]
pub(crate) struct Node(pub(crate) u64);
#[derive(Clone, Copy)]
pub(crate) struct List {
    pub(crate) table: u64,
    pub(crate) len: usize,
}

impl List {
    pub fn range(self, range: std::ops::Range<usize>) -> io::Result<Self> {
        if range.start > range.end || range.end > self.len {
            return Err(invalid("recipe range exceeds numeric table"));
        }
        Ok(Self {
            table: self
                .table
                .checked_add((range.start as u64).checked_mul(8).ok_or_else(overflow)?)
                .ok_or_else(overflow)?,
            len: range.end - range.start,
        })
    }
}
#[derive(Clone)]
pub(crate) struct ArenaRecipes(Arc<Store>, bool);
struct Store {
    arena: CaptureArena,
    _owner: Arc<dyn Send + Sync>,
    cancellation: Option<CancellationToken>,
}
impl ArenaRecipes {
    pub fn metadata_bytes() -> usize {
        // Message options, a result's identifiers/options and one media content
        // recipe can hold eight original source views during numeric decoding.
        let decoded_sources = 8
            * (maka_event_log::context::semantic::CapturedSource::locator_metadata_bytes()
                + std::mem::size_of::<OwnedBytes>()
                + 2 * std::mem::size_of::<usize>());
        decoded_sources
            + std::mem::size_of::<Store>()
            + 2 * std::mem::size_of::<usize>()
            + std::mem::size_of::<ListSource<MessageRecipe>>()
            + 2 * std::mem::size_of::<usize>()
    }
    #[cfg(test)]
    pub fn new(arena: CaptureArena, owner: Arc<dyn Send + Sync>) -> Self {
        Self(
            Arc::new(Store {
                arena,
                _owner: owner,
                cancellation: None,
            }),
            false,
        )
    }
    pub fn cancellable(
        arena: CaptureArena,
        owner: Arc<dyn Send + Sync>,
        cancellation: &CancellationToken,
    ) -> Self {
        Self(
            Arc::new(Store {
                arena,
                _owner: owner,
                cancellation: Some(cancellation.clone()),
            }),
            false,
        )
    }
    /// Capture-only view of completed leaf ranges; never publish this view.
    pub fn internal(&self) -> Self {
        Self(self.0.clone(), true)
    }
    pub async fn message_list(
        &self,
        role: MessageRole,
        content: List,
        options: Option<JsonSource>,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        let role = match role {
            MessageRole::User => 1,
            MessageRole::Assistant => 2,
            MessageRole::Tool => 3,
            MessageRole::System => return Err(invalid("system content is not a recipe list")),
        };
        let content = self.list_record(content).await?;
        let options = self.json(options, budget, cancel).await?;
        self.record(words(MESSAGE, &[role, content.0, options.0]))
            .await
    }
    /// Allocate the numeric index before producing its children. Backpatches
    /// target this unsealed table only; completed body ranges never change.
    pub async fn begin_list(&self, len: usize) -> io::Result<List> {
        let bytes = u64::try_from(len)
            .map_err(io::Error::other)?
            .checked_mul(8)
            .ok_or_else(overflow)?;
        if self
            .0
            .cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(crate::preparation_cancelled(
                "numeric directory capture cancelled",
            ));
        }
        let table = self
            .0
            .arena
            .with_writer(move |writer| Ok(writer.reserve_zeroed(bytes)?.start))
            .await?;
        Ok(List { table, len })
    }
    pub async fn put(&self, list: List, index: usize, node: Node) -> io::Result<()> {
        if index >= list.len {
            return Err(invalid("recipe index exceeds table"));
        }
        let offset = list
            .table
            .checked_add((index as u64).checked_mul(8).ok_or_else(overflow)?)
            .ok_or_else(overflow)?;
        self.0
            .arena
            .with_writer(move |writer| writer.write_at(offset, &node.0.to_le_bytes()))
            .await
    }
    pub(crate) async fn record(&self, words: Record) -> io::Result<Node> {
        self.0
            .arena
            .with_writer(move |writer| {
                let mut bytes = [0_u8; RECORD_BYTES];
                for (word, bytes) in words
                    .into_iter()
                    .zip(bytes.as_chunks_mut::<8>().0.iter_mut())
                {
                    bytes.copy_from_slice(&word.to_le_bytes());
                }
                Ok(Node(
                    writer
                        .append_bytes(&bytes)?
                        .start
                        .checked_add(1)
                        .ok_or_else(overflow)?,
                ))
            })
            .await
    }
    pub(crate) async fn list_record(&self, list: List) -> io::Result<Node> {
        self.record(words(LIST, &[list.table, list.len as u64]))
            .await
    }
    async fn leaf(
        &self,
        bytes: SourceBytes,
        encoding: u64,
        measure: Option<(u64, [u8; 32])>,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        let source = self.0.arena.retain_source(bytes, budget, cancel).await?;
        let mut record = words(LEAF, &[encoding]);
        record[2..2 + SOURCE_WORDS].copy_from_slice(&source.0);
        if let Some((bytes, digest)) = measure {
            record[MEASURE_WORD] = 1;
            record[MEASURE_WORD + 1] = bytes;
            for (word, chunk) in record[MEASURE_WORD + 2..WORDS]
                .iter_mut()
                .zip(digest.as_chunks::<8>().0)
            {
                *word = u64::from_le_bytes(*chunk);
            }
        }
        self.record(record).await
    }
    pub(crate) async fn text(
        &self,
        text: TextSource,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        let encoding = match text.encoding() {
            TextEncoding::Utf8 => 0,
            TextEncoding::JsonString => 1,
        };
        let measure = text
            .measure()
            .map(|measure| (measure.bytes, measure.sha256));
        self.leaf(text.into_bytes(), encoding, measure, budget, cancel)
            .await
    }
    pub(crate) async fn json(
        &self,
        value: Option<JsonSource>,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        match value {
            Some(value) => {
                let measure = value
                    .measure()
                    .map(|measure| (measure.bytes, measure.sha256));
                self.leaf(value.into_bytes(), 2, measure, budget, cancel)
                    .await
            }
            None => Ok(Node(0)),
        }
    }
    pub async fn content(
        &self,
        value: ContentRecipe,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        match value {
            ContentRecipe::Text {
                text,
                provider_options,
            } => {
                let text = self.text(text, budget.clone(), cancel).await?;
                let options = self.json(provider_options, budget, cancel).await?;
                self.record(words(CONTENT_TEXT, &[text.0, options.0])).await
            }
            ContentRecipe::Media {
                media,
                provider_options,
            } => {
                let raw = self
                    .leaf(media.bytes, 3, None, budget.clone(), cancel)
                    .await?;
                let mime = self.text(media.media_type, budget.clone(), cancel).await?;
                let detail = match media.detail {
                    Some(detail) => self.text(detail, budget.clone(), cancel).await?,
                    None => Node(0),
                };
                let options = self.json(provider_options, budget, cancel).await?;
                self.record(words(CONTENT_MEDIA, &[raw.0, mime.0, detail.0, options.0]))
                    .await
            }
        }
    }
    pub async fn content_list(
        &self,
        source: &dyn RecipeSource<ContentRecipe>,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<List> {
        let list = self.begin_list(source.len()).await?;
        let mut cursor = source.open(0);
        for index in 0..list.len {
            let value = cursor
                .next()
                .await?
                .ok_or_else(|| invalid("content source shortened during capture"))?;
            let node = self.content(value, budget.clone(), cancel).await?;
            self.put(list, index, node).await?;
        }
        if cursor.next().await?.is_some() {
            return Err(invalid("content source grew during capture"));
        }
        Ok(list)
    }
    pub async fn content_text_list(
        &self,
        pieces: List,
        options: Option<JsonSource>,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        let pieces = self.list_record(pieces).await?;
        let options = self.json(options, budget, cancel).await?;
        self.record(words(CONTENT_TEXT_LIST, &[pieces.0, options.0]))
            .await
    }
    pub async fn result(
        &self,
        result: ToolResultRecipe,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        self.result_with_content(result, None, budget, cancel).await
    }
    pub async fn result_content(
        &self,
        result: ToolResultRecipe,
        content: List,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        self.result_with_content(result, Some(content), budget, cancel)
            .await
    }
    async fn result_with_content(
        &self,
        result: ToolResultRecipe,
        content: Option<List>,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        let id = self
            .text(result.tool_call_id, budget.clone(), cancel)
            .await?;
        let name = self.text(result.tool_name, budget.clone(), cancel).await?;
        let options = self
            .json(result.provider_options, budget.clone(), cancel)
            .await?;
        let (output, output_kind) = if let Some(content) = content {
            (self.list_record(content).await?, 4)
        } else {
            match result.output {
                ToolOutputRecipe::Text(text) => (self.text(text, budget.clone(), cancel).await?, 0),
                ToolOutputRecipe::ErrorText(text) => {
                    (self.text(text, budget.clone(), cancel).await?, 1)
                }
                ToolOutputRecipe::Json(json) => {
                    (self.json(Some(json), budget.clone(), cancel).await?, 2)
                }
                ToolOutputRecipe::ErrorJson(json) => {
                    (self.json(Some(json), budget.clone(), cancel).await?, 3)
                }
                ToolOutputRecipe::Content(content) => {
                    let list = self
                        .content_list(content.as_ref(), budget.clone(), cancel)
                        .await?;
                    (self.list_record(list).await?, 4)
                }
            }
        };
        let (error, code) = match result.parsed_error {
            Some(error) => {
                let same = match (error.value.bytes(), error.code_value.bytes()) {
                    (SourceBytes::Source(left), SourceBytes::Source(right)) => {
                        Arc::ptr_eq(left, right)
                    }
                    (SourceBytes::Inline(left), SourceBytes::Inline(right)) => {
                        left.as_ptr() == right.as_ptr() && left.len() == right.len()
                    }
                    _ => false,
                };
                let value = self.json(Some(error.value), budget.clone(), cancel).await?;
                let code = if same {
                    value
                } else {
                    self.json(Some(error.code_value), budget, cancel).await?
                };
                (value, code)
            }
            None => (Node(0), Node(0)),
        };
        let flags = u64::from(result.kind == ToolResultKind::Notification)
            | (u64::from(result.call_kind == ToolCallKind::Custom) << 1)
            | (u64::from(result.replay == ToolResultReplay::AnthropicMcp) << 2);
        self.record(words(
            RESULT,
            &[
                id.0,
                name.0,
                options.0,
                output.0,
                output_kind,
                flags,
                error.0,
                code.0,
            ],
        ))
        .await
    }
    pub async fn assistant(
        &self,
        part: AssistantRecipe,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        let reasoning = matches!(&part, AssistantRecipe::Reasoning { .. });
        let (tag, fields) = match part {
            AssistantRecipe::Text {
                text,
                provider_options,
            }
            | AssistantRecipe::Reasoning {
                text,
                provider_options,
            } => {
                let text = self.text(text, budget.clone(), cancel).await?;
                let options = self.json(provider_options, budget, cancel).await?;
                (
                    if reasoning {
                        ASSISTANT_REASONING
                    } else {
                        ASSISTANT_TEXT
                    },
                    [text.0, options.0, 0, 0, 0, 0],
                )
            }
            AssistantRecipe::ToolCall {
                tool_call_id,
                tool_name,
                input,
                kind,
                provider_executed,
                provider_options,
            } => {
                let id = self.text(tool_call_id, budget.clone(), cancel).await?;
                let name = self.text(tool_name, budget.clone(), cancel).await?;
                let (input, input_kind) = match input {
                    ToolInputRecipe::Text(text) => {
                        (self.text(text, budget.clone(), cancel).await?, 0)
                    }
                    ToolInputRecipe::Json(json) => {
                        (self.json(Some(json), budget.clone(), cancel).await?, 1)
                    }
                };
                let options = self.json(provider_options, budget, cancel).await?;
                let flags = u64::from(kind == ToolCallKind::Custom)
                    | (match provider_executed {
                        None => 0,
                        Some(false) => 1,
                        Some(true) => 2,
                    } << 1);
                (
                    ASSISTANT_CALL,
                    [id.0, name.0, input.0, input_kind, flags, options.0],
                )
            }
            AssistantRecipe::ToolResult(result) => {
                let result = self.result(result, budget, cancel).await?;
                (ASSISTANT_RESULT, [result.0, 0, 0, 0, 0, 0])
            }
        };
        self.record(words(tag, &fields)).await
    }
    pub(crate) async fn read(&self, node: Node) -> io::Result<Record> {
        let offset = node
            .0
            .checked_sub(1)
            .ok_or_else(|| invalid("absent recipe record"))?;
        let bytes = self
            .0
            .arena
            .read_control_owned::<RECORD_BYTES>(offset, self.0.clone())
            .await?;
        let mut words = [0; WORDS];
        for (word, bytes) in words.iter_mut().zip(bytes.as_chunks::<8>().0.iter()) {
            *word = u64::from_le_bytes(*bytes);
        }
        Ok(words)
    }

    pub(crate) async fn get(&self, list: List, index: usize) -> io::Result<Option<Node>> {
        if index >= list.len {
            return Ok(None);
        }
        let offset = list
            .table
            .checked_add((index as u64).checked_mul(8).ok_or_else(overflow)?)
            .ok_or_else(overflow)?;
        let node = Node(u64::from_le_bytes(
            self.0
                .arena
                .read_control_owned::<8>(offset, self.0.clone())
                .await?,
        ));
        if node.0 == 0 {
            Err(invalid("unfilled recipe table entry"))
        } else {
            Ok(Some(node))
        }
    }

    pub(crate) async fn read_list(&self, node: Node) -> io::Result<List> {
        let record = self.read(node).await?;
        if record[0] != LIST {
            return Err(invalid("expected recipe list"));
        }
        Ok(List {
            table: record[1],
            len: usize::try_from(record[2]).map_err(io::Error::other)?,
        })
    }
    async fn read_leaf(
        &self,
        node: Node,
    ) -> io::Result<(SourceBytes, u64, Option<(u64, [u8; 32])>)> {
        let record = self.read(node).await?;
        if record[0] != LEAF {
            return Err(invalid("expected recipe leaf"));
        }
        let bytes = SourceBytes::Source(Arc::new(OwnedBytes {
            bytes: self.0.arena.restore_source(
                SourceRecord(
                    record[2..2 + SOURCE_WORDS]
                        .try_into()
                        .expect("fixed source record"),
                ),
                self.1,
            )?,
            owner: self.0.clone(),
        }));
        let measure = match record[MEASURE_WORD] {
            0 => None,
            1 => {
                let mut digest = [0; 32];
                for (chunk, word) in digest
                    .as_chunks_mut::<8>()
                    .0
                    .iter_mut()
                    .zip(&record[MEASURE_WORD + 2..WORDS])
                {
                    *chunk = word.to_le_bytes();
                }
                Some((record[MEASURE_WORD + 1], digest))
            }
            _ => return Err(invalid("invalid leaf measure presence")),
        };
        Ok((bytes, record[1], measure))
    }
    pub(crate) async fn read_text(&self, node: Node) -> io::Result<TextSource> {
        let (bytes, encoding, measure) = self.read_leaf(node).await?;
        let encoding = match encoding {
            0 => TextEncoding::Utf8,
            1 => TextEncoding::JsonString,
            _ => return Err(invalid("expected text leaf")),
        };
        Ok(match measure {
            Some((bytes_count, sha256)) => TextSource::measured(
                bytes,
                encoding,
                DecodedTextMeasure {
                    bytes: bytes_count,
                    sha256,
                },
            ),
            None => TextSource::new(bytes, encoding),
        })
    }
    pub(crate) async fn read_json(&self, node: Node) -> io::Result<Option<JsonSource>> {
        if node.0 == 0 {
            return Ok(None);
        }
        let (bytes, encoding, measure) = self.read_leaf(node).await?;
        if encoding != 2 {
            return Err(invalid("expected JSON leaf"));
        }
        Ok(Some(match measure {
            Some((bytes_count, sha256)) => JsonSource::measured(
                bytes,
                RawJsonMeasure {
                    bytes: bytes_count,
                    sha256,
                },
            ),
            None => JsonSource::new(bytes),
        }))
    }
    fn source<T: Decode>(&self, list: List) -> Arc<dyn RecipeSource<T>> {
        Arc::new(ListSource::<T> {
            store: self.clone(),
            list,
            _type: PhantomData,
        })
    }
    pub async fn identified(
        &self,
        value: IdentifiedText,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Node> {
        let text = self.text(value.text, budget, cancel).await?;
        let mut record = words(IDENTIFIED_TEXT, &[text.0]);
        for (word, bytes) in record[2..6]
            .iter_mut()
            .zip(value.identity.as_chunks::<8>().0.iter())
        {
            *word = u64::from_le_bytes(*bytes);
        }
        self.record(record).await
    }
    pub fn identifiers(&self, list: List) -> Arc<dyn RecipeSource<IdentifiedText>> {
        self.source(list)
    }
    pub async fn set_assistant_replay(
        &self,
        node: Node,
        replay: ToolResultReplay,
    ) -> io::Result<()> {
        let part = self.read(node).await?;
        if part[0] != ASSISTANT_RESULT {
            return Err(invalid("replay target is not an assistant result"));
        }
        let result = Node(part[1]);
        let fields = self.read(result).await?;
        let flags = (fields[6] & !4)
            | if replay == ToolResultReplay::AnthropicMcp {
                4
            } else {
                0
            };
        self.0
            .arena
            .with_writer(move |writer| writer.write_at(result.0 - 1 + 6 * 8, &flags.to_le_bytes()))
            .await
    }
    pub async fn read_message(&self, node: Node) -> io::Result<MessageRecipe> {
        MessageRecipe::decode(self, node)
            .await?
            .ok_or_else(|| invalid("absent message recipe"))
    }
    pub fn texts(&self, list: List) -> Arc<dyn RecipeSource<TextSource>> {
        self.source(list)
    }
    pub fn contents(&self, list: List) -> Arc<dyn RecipeSource<ContentRecipe>> {
        self.source(list)
    }
    pub fn assistants(&self, list: List) -> Arc<dyn RecipeSource<AssistantRecipe>> {
        self.source(list)
    }
    pub fn results(&self, list: List) -> Arc<dyn RecipeSource<ToolResultRecipe>> {
        self.source(list)
    }
    pub fn messages(&self, list: List) -> Arc<dyn RecipeSource<MessageRecipe>> {
        self.source(list)
    }
}

trait Decode: Send + Sync + 'static + Sized {
    fn decode(store: &ArenaRecipes, node: Node) -> NextRecipe<'_, Self>;
}
struct ListSource<T> {
    store: ArenaRecipes,
    list: List,
    _type: PhantomData<T>,
}
impl<T: Decode> RecipeSource<T> for ListSource<T> {
    fn len(&self) -> usize {
        self.list.len
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<T>> {
        Box::new(ListCursor::<T> {
            store: self.store.clone(),
            list: self.list,
            index: start,
            _type: PhantomData,
        })
    }
}
struct ListCursor<T> {
    store: ArenaRecipes,
    list: List,
    index: usize,
    _type: PhantomData<T>,
}
impl<T: Decode> RecipeCursor<T> for ListCursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        Box::pin(async move {
            let Some(node) = self.store.get(self.list, self.index).await? else {
                return Ok(None);
            };
            let value = T::decode(&self.store, node).await?;
            self.index += 1;
            Ok(value)
        })
    }
}
impl Decode for TextSource {
    fn decode(store: &ArenaRecipes, node: Node) -> NextRecipe<'_, Self> {
        Box::pin(async move { Ok(Some(store.read_text(node).await?)) })
    }
}
impl Decode for IdentifiedText {
    fn decode(store: &ArenaRecipes, node: Node) -> NextRecipe<'_, Self> {
        Box::pin(async move {
            let r = store.read(node).await?;
            if r[0] != IDENTIFIED_TEXT {
                return Err(invalid("expected identified text"));
            }
            let mut identity = [0; 32];
            for (bytes, word) in identity.as_chunks_mut::<8>().0.iter_mut().zip(&r[2..6]) {
                bytes.copy_from_slice(&word.to_le_bytes());
            }
            Ok(Some(Self {
                text: store.read_text(Node(r[1])).await?,
                identity,
            }))
        })
    }
}
impl Decode for ContentRecipe {
    fn decode(store: &ArenaRecipes, node: Node) -> NextRecipe<'_, Self> {
        Box::pin(async move {
            let r = store.read(node).await?;
            Ok(Some(match r[0] {
                CONTENT_TEXT_LIST => Self::Text {
                    text: TextSource::new(
                        SourceBytes::Source(Arc::new(ConcatBytes {
                            store: store.clone(),
                            pieces: store.read_list(Node(r[1])).await?,
                        })),
                        TextEncoding::Utf8,
                    ),
                    provider_options: store.read_json(Node(r[2])).await?,
                },
                CONTENT_TEXT => Self::Text {
                    text: store.read_text(Node(r[1])).await?,
                    provider_options: store.read_json(Node(r[2])).await?,
                },
                CONTENT_MEDIA => Self::Media {
                    media: MediaSource {
                        bytes: store.read_leaf(Node(r[1])).await?.0,
                        media_type: store.read_text(Node(r[2])).await?,
                        detail: if r[3] == 0 {
                            None
                        } else {
                            Some(store.read_text(Node(r[3])).await?)
                        },
                    },
                    provider_options: store.read_json(Node(r[4])).await?,
                },
                _ => return Err(invalid("expected content recipe")),
            }))
        })
    }
}
impl Decode for ToolResultRecipe {
    fn decode(store: &ArenaRecipes, node: Node) -> NextRecipe<'_, Self> {
        Box::pin(async move {
            let r = store.read(node).await?;
            if r[0] != RESULT {
                return Err(invalid("expected result recipe"));
            }
            let output = match r[5] {
                0 => ToolOutputRecipe::Text(store.read_text(Node(r[4])).await?),
                1 => ToolOutputRecipe::ErrorText(store.read_text(Node(r[4])).await?),
                2 => ToolOutputRecipe::Json(
                    store
                        .read_json(Node(r[4]))
                        .await?
                        .ok_or_else(|| invalid("absent result JSON"))?,
                ),
                3 => ToolOutputRecipe::ErrorJson(
                    store
                        .read_json(Node(r[4]))
                        .await?
                        .ok_or_else(|| invalid("absent result JSON"))?,
                ),
                4 => ToolOutputRecipe::Content(store.contents(store.read_list(Node(r[4])).await?)),
                _ => return Err(invalid("unknown result output")),
            };
            Ok(Some(Self {
                tool_call_id: store.read_text(Node(r[1])).await?,
                tool_name: store.read_text(Node(r[2])).await?,
                kind: if r[6] & 1 == 0 {
                    ToolResultKind::Settled
                } else {
                    ToolResultKind::Notification
                },
                call_kind: if r[6] & 2 == 0 {
                    ToolCallKind::Function
                } else {
                    ToolCallKind::Custom
                },
                replay: if r[6] & 4 == 0 {
                    ToolResultReplay::Ordinary
                } else {
                    ToolResultReplay::AnthropicMcp
                },
                provider_options: store.read_json(Node(r[3])).await?,
                output,
                parsed_error: if r[7] == 0 {
                    None
                } else {
                    Some(ParsedToolError {
                        value: store
                            .read_json(Node(r[7]))
                            .await?
                            .ok_or_else(|| invalid("absent error JSON"))?,
                        code_value: store
                            .read_json(Node(r[8]))
                            .await?
                            .ok_or_else(|| invalid("absent code error JSON"))?,
                    })
                },
            }))
        })
    }
}
impl Decode for AssistantRecipe {
    fn decode(store: &ArenaRecipes, node: Node) -> NextRecipe<'_, Self> {
        Box::pin(async move {
            let r = store.read(node).await?;
            Ok(Some(match r[0] {
                ASSISTANT_TEXT => Self::Text {
                    text: store.read_text(Node(r[1])).await?,
                    provider_options: store.read_json(Node(r[2])).await?,
                },
                ASSISTANT_REASONING => Self::Reasoning {
                    text: store.read_text(Node(r[1])).await?,
                    provider_options: store.read_json(Node(r[2])).await?,
                },
                ASSISTANT_CALL => Self::ToolCall {
                    tool_call_id: store.read_text(Node(r[1])).await?,
                    tool_name: store.read_text(Node(r[2])).await?,
                    input: if r[4] == 0 {
                        ToolInputRecipe::Text(store.read_text(Node(r[3])).await?)
                    } else {
                        ToolInputRecipe::Json(
                            store
                                .read_json(Node(r[3]))
                                .await?
                                .ok_or_else(|| invalid("absent call input"))?,
                        )
                    },
                    kind: if r[5] & 1 == 0 {
                        ToolCallKind::Function
                    } else {
                        ToolCallKind::Custom
                    },
                    provider_executed: match r[5] >> 1 {
                        0 => None,
                        1 => Some(false),
                        2 => Some(true),
                        _ => return Err(invalid("invalid execution marker")),
                    },
                    provider_options: store.read_json(Node(r[6])).await?,
                },
                ASSISTANT_RESULT => Self::ToolResult(
                    ToolResultRecipe::decode(store, Node(r[1]))
                        .await?
                        .ok_or_else(|| invalid("absent embedded result"))?,
                ),
                _ => return Err(invalid("expected assistant recipe")),
            }))
        })
    }
}
impl Decode for MessageRecipe {
    fn decode(store: &ArenaRecipes, node: Node) -> NextRecipe<'_, Self> {
        Box::pin(async move {
            let r = store.read(node).await?;
            if r[0] != MESSAGE {
                return Err(invalid("expected message recipe"));
            }
            let provider_options = store.read_json(Node(r[3])).await?;
            Ok(Some(match r[1] {
                0 => Self::System {
                    content: store.read_text(Node(r[2])).await?,
                    provider_options,
                },
                1 => Self::User {
                    content: store.contents(store.read_list(Node(r[2])).await?),
                    provider_options,
                },
                2 => Self::Assistant {
                    content: store.assistants(store.read_list(Node(r[2])).await?),
                    provider_options,
                },
                3 => Self::Tool {
                    content: store.results(store.read_list(Node(r[2])).await?),
                    provider_options,
                },
                _ => return Err(invalid("unknown message role")),
            }))
        })
    }
}
struct ConcatBytes {
    store: ArenaRecipes,
    pieces: List,
}
impl ByteSource for ConcatBytes {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        text::cursor(
            text::concat(self.store.texts(self.pieces), budget.clone()),
            budget,
        )
    }
}
struct OwnedBytes {
    bytes: SourceBytes,
    owner: Arc<Store>,
}
impl ByteSource for OwnedBytes {
    fn locator(&self) -> Option<SourceLocator> {
        match &self.bytes {
            SourceBytes::Inline(_) => None,
            SourceBytes::Source(source) => source.locator(),
        }
    }
    fn len(&self) -> Option<u64> {
        self.bytes.len()
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(OwnedCursor {
            cursor: self.bytes.open(budget),
            owner: self.owner.clone(),
        })
    }
    fn slice(&self, range: std::ops::Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        Ok(Arc::new(Self {
            bytes: self.bytes.slice(range)?,
            owner: self.owner.clone(),
        }))
    }
}
struct OwnedCursor {
    cursor: Box<dyn ByteCursor>,
    owner: Arc<Store>,
}
impl ByteCursor for OwnedCursor {
    fn read_chunk(&mut self, buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let mut read = self.cursor.read_chunk(buffer).await?;
            read.buffer = read.buffer.retain_owner(self.owner.clone());
            Ok(read)
        })
    }
}
fn words(tag: u64, fields: &[u64]) -> Record {
    let mut words = [0; WORDS];
    words[0] = tag;
    words[1..1 + fields.len()].copy_from_slice(fields);
    words
}
fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}
fn overflow() -> io::Error {
    io::Error::other("arena recipe directory offset overflow")
}
