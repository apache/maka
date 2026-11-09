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

use super::*;
use base64::Engine;
use json::JsonValue;
use std::io::Write;
type DecodeFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<T>> + Send + 'a>>;
struct Fields(Vec<Option<JsonValue>>);
impl Fields {
    async fn open(
        source: &JsonSource,
        names: &[&str],
        budget: &Arc<dyn SourceBudget>,
    ) -> io::Result<Self> {
        Ok(Self(json::fields(source, names, budget.clone()).await?))
    }
    fn value(&self, i: usize) -> io::Result<&JsonValue> {
        self.0[i].as_ref().ok_or_else(invalid)
    }
    fn text(&self, i: usize) -> io::Result<TextSource> {
        self.value(i)?.text()
    }
    fn json(&self, i: usize) -> Option<JsonSource> {
        self.0[i].as_ref().map(|v| v.source.clone())
    }
    async fn is(&self, i: usize, tag: &str, budget: &Arc<dyn SourceBudget>) -> io::Result<bool> {
        json::text_eq(&self.text(i)?, tag, budget.clone()).await
    }
}
fn location(bytes: &SourceBytes) -> io::Result<Range<u64>> {
    if let SourceBytes::Source(bytes) = bytes
        && let Some(SourceLocator::Arena { range, .. }) = bytes.locator()
    {
        return Ok(range);
    }
    Err(invalid())
}
impl Store {
    async fn leaf(&self, bytes: &SourceBytes, encoding: u64) -> io::Result<u64> {
        let range = location(bytes)?;
        let mut r = Record::default();
        r[0] = range.start;
        r[1] = range.end;
        r[2] = encoding;
        self.write(r).await?.checked_add(1).ok_or_else(overflow)
    }
    async fn text_node(&self, text: TextSource) -> io::Result<u64> {
        self.leaf(
            text.bytes(),
            u64::from(text.encoding() == TextEncoding::JsonString),
        )
        .await
    }
    async fn json_node(&self, json: Option<JsonSource>) -> io::Result<u64> {
        match json {
            Some(json) => self.leaf(json.bytes(), 0).await,
            None => Ok(0),
        }
    }
    async fn read_text(&self, node: u64) -> io::Result<TextSource> {
        let r = self.read(node.checked_sub(1).ok_or_else(invalid)?).await?;
        Ok(TextSource::new(
            self.bytes(r[0]..r[1]),
            if r[2] == 0 {
                TextEncoding::Utf8
            } else {
                TextEncoding::JsonString
            },
        ))
    }
    async fn read_json(&self, node: u64) -> io::Result<Option<JsonSource>> {
        if node == 0 {
            return Ok(None);
        }
        let r = self.read(node - 1).await?;
        Ok(Some(JsonSource::new(self.bytes(r[0]..r[1]))))
    }
}
pub(super) fn role(code: u64) -> io::Result<MessageRole> {
    match code {
        0 => Ok(MessageRole::System),
        1 => Ok(MessageRole::User),
        2 => Ok(MessageRole::Assistant),
        3 => Ok(MessageRole::Tool),
        _ => Err(invalid()),
    }
}
pub(super) async fn index_message(
    store: &Store,
    range: Range<u64>,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<Record> {
    let f = Fields::open(
        &JsonSource::new(store.bytes(range)),
        &["role", "content", "providerOptions"],
        budget,
    )
    .await?;
    let role = if f.is(0, "system", budget).await? {
        0
    } else if f.is(0, "user", budget).await? {
        1
    } else if f.is(0, "assistant", budget).await? {
        2
    } else {
        3
    };
    let mut r = Record::default();
    r[1] = store.json_node(f.json(2)).await?;
    r[2] = role;
    if role == 0 {
        r[0] = store.text_node(f.text(1)?).await?;
    } else {
        let mode = match role {
            1 => Mode::Content,
            2 => Mode::Assistant,
            _ => Mode::Result,
        };
        let list = index_array(store, &f.value(1)?.source, mode, budget, cancel).await?;
        r[3] = list.offset;
        r[4] = list.len as u64;
    }
    Ok(r)
}
#[derive(Clone, Copy)]
enum Mode {
    Content,
    Assistant,
    Result,
}
fn index_array<'a>(
    store: &'a Store,
    source: &'a JsonSource,
    mode: Mode,
    budget: &'a Arc<dyn SourceBudget>,
    cancel: &'a CancellationToken,
) -> DecodeFuture<'a, List> {
    Box::pin(async move {
        let mut cursor = json::ArrayCursor::open(source.clone(), budget.clone()).await?;
        let mut len = 0usize;
        while cursor.next_span().await?.is_some() {
            if cancel.is_cancelled() {
                return Err(crate::preparation_cancelled("canonical indexing cancelled"));
            }
            len = len.checked_add(1).ok_or_else(overflow)?;
        }
        drop(cursor);
        let list = store.table(len).await?;
        let mut cursor = json::ArrayCursor::open(source.clone(), budget.clone()).await?;
        for index in 0..len {
            if cancel.is_cancelled() {
                return Err(crate::preparation_cancelled("canonical indexing cancelled"));
            }
            let value = cursor.next().await?.ok_or_else(invalid)?;
            let r = match mode {
                Mode::Content => index_content(store, &value.source, budget, cancel).await?,
                Mode::Assistant => index_assistant(store, &value.source, budget, cancel).await?,
                Mode::Result => index_result(store, &value.source, budget, cancel).await?,
            };
            let offset = store.write(r).await?;
            store.put(list, index, offset).await?;
        }
        Ok(list)
    })
}
async fn index_content(
    store: &Store,
    source: &JsonSource,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<Record> {
    let f = Fields::open(
        source,
        &["type", "text", "data", "mediaType", "providerOptions"],
        budget,
    )
    .await?;
    let mut r = Record::default();
    if f.is(0, "text", budget).await? {
        r[0] = 1;
        r[1] = store.text_node(f.text(1)?).await?;
        r[2] = store.json_node(f.json(4)).await?;
    } else {
        r[0] = 2;
        let data = Fields::open(&f.value(2)?.source, &["data"], budget).await?;
        let range = decode_media(store, data.text(0)?, budget, cancel).await?;
        r[1] = range.start;
        r[2] = range.end;
        r[3] = store.text_node(f.text(3)?).await?;
        if let Some(options) = f.json(4)
            && let Some(detail) =
                json::field(&options, &["openai", "imageDetail"], budget.clone()).await?
            && detail.kind == json::JsonKind::String
        {
            r[4] = store.text_node(detail.text()?).await?;
        }
        r[5] = store.json_node(f.json(4)).await?;
    }
    Ok(r)
}
async fn custom(options: Option<&JsonSource>, budget: &Arc<dyn SourceBudget>) -> io::Result<bool> {
    if let Some(options) = options {
        for provider in ["openai", "openResponses"] {
            if let Some(kind) =
                json::field(options, &[provider, "toolKind"], budget.clone()).await?
                && kind.kind == json::JsonKind::String
                && json::text_eq(&kind.text()?, "custom", budget.clone()).await?
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
async fn index_assistant(
    store: &Store,
    source: &JsonSource,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<Record> {
    let f = Fields::open(
        source,
        &[
            "type",
            "text",
            "providerOptions",
            "item",
            "toolCallId",
            "toolName",
            "input",
            "providerExecuted",
        ],
        budget,
    )
    .await?;
    let mut r = Record::default();
    if f.is(0, "text", budget).await? || f.is(0, "reasoning", budget).await? {
        r[0] = if f.is(0, "text", budget).await? { 3 } else { 4 };
        r[1] = store.text_node(f.text(1)?).await?;
        r[2] = store.json_node(f.json(2)).await?;
    } else if f.is(0, "codex-compaction", budget).await? {
        r[0] = 5;
        r[1] = store.json_node(f.json(3)).await?;
    } else if f.is(0, "tool-call", budget).await? {
        r[0] = 6;
        r[1] = store.text_node(f.text(4)?).await?;
        r[2] = store.text_node(f.text(5)?).await?;
        let input = Fields::open(&f.value(6)?.source, &["kind", "data"], budget).await?;
        if input.is(0, "invalid_json", budget).await? {
            let raw = Fields::open(&input.value(1)?.source, &["raw"], budget).await?;
            r[3] = store.text_node(raw.text(0)?).await?;
            r[4] = 1;
        } else {
            r[3] = store.json_node(input.json(1)).await?;
        }
        r[5] = u64::from(custom(f.json(2).as_ref(), budget).await?);
        r[6] = match f.json(7) {
            Some(value) => {
                if json::bool_value(&value, budget.clone()).await? {
                    2
                } else {
                    1
                }
            }
            None => 0,
        };
        r[7] = store.json_node(f.json(2)).await?;
    } else {
        return index_result(store, source, budget, cancel).await;
    }
    Ok(r)
}
fn index_result<'a>(
    store: &'a Store,
    source: &'a JsonSource,
    budget: &'a Arc<dyn SourceBudget>,
    cancel: &'a CancellationToken,
) -> DecodeFuture<'a, Record> {
    Box::pin(async move {
        let f = Fields::open(
            source,
            &["toolCallId", "toolName", "output", "providerOptions"],
            budget,
        )
        .await?;
        let mut r = Record::default();
        r[0] = 7;
        r[1] = store.text_node(f.text(0)?).await?;
        r[2] = store.text_node(f.text(1)?).await?;
        let options = f.json(3);
        r[4] = u64::from(custom(options.as_ref(), budget).await?);
        if let Some(options) = &options
            && let Some(flag) =
                json::field(options, &["maka", "notification"], budget.clone()).await?
            && flag.kind == json::JsonKind::Bool
        {
            r[3] = u64::from(json::bool_value(&flag.source, budget.clone()).await?);
        }
        let output = Fields::open(&f.value(2)?.source, &["type", "value"], budget).await?;
        if output.is(0, "text", budget).await? {
            r[5] = 0;
            r[6] = store.text_node(output.text(1)?).await?;
        } else if output.is(0, "error-text", budget).await? {
            r[5] = 1;
            r[6] = store.text_node(output.text(1)?).await?;
        } else if output.is(0, "json", budget).await? {
            r[5] = 2;
            r[6] = store.json_node(output.json(1)).await?;
        } else if output.is(0, "error-json", budget).await? {
            r[5] = 3;
            r[6] = store.json_node(output.json(1)).await?;
        } else {
            r[5] = 4;
            let list = index_array(
                store,
                &output.value(1)?.source,
                Mode::Content,
                budget,
                cancel,
            )
            .await?;
            r[6] = list.offset;
            r[7] = list.len as u64;
        }
        if r[5] == 1 || (r[5] == 3 && output.value(1)?.kind == json::JsonKind::String) {
            let (value, code) = parsed_error(store, output.text(1)?, budget, cancel).await?;
            r[10] = value;
            r[11] = code;
        }
        r[8] = store.json_node(options).await?;
        Ok(r)
    })
}
async fn decode_media(
    store: &Store,
    data: TextSource,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<Range<u64>> {
    let mut cursor = text::cursor(data, budget.clone());
    let mut input = budget.allocate(4096).await?;
    let mut output = budget.allocate(4096).await?;
    let append = store.arena.begin_append().await;
    let start = append.with_writer(|w| Ok(w.position())).await?;
    let mut quartet = [0u8; 4];
    let mut used = 0;
    let mut padded = false;
    loop {
        if cancel.is_cancelled() {
            return Err(crate::preparation_cancelled(
                "canonical media capture cancelled",
            ));
        }
        let read = cursor.read_chunk(input).await?;
        input = read.buffer;
        let mut written = 0;
        for byte in &input.as_ref()[..read.bytes_read] {
            if padded {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "base64 data follows padding",
                ));
            }
            quartet[used] = *byte;
            used += 1;
            if used == 4 {
                let count = base64::engine::general_purpose::STANDARD
                    .decode_slice(quartet, &mut output.as_mut()[written..written + 3])
                    .map_err(io::Error::other)?;
                written += count;
                used = 0;
                padded = quartet.contains(&b'=');
            }
        }
        if written != 0 {
            output = append
                .with_writer(move |w| {
                    w.write_all(&output.as_ref()[..written])?;
                    Ok(output)
                })
                .await?;
        }
        if read.eof {
            break;
        }
        if read.bytes_read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "media source made no progress",
            ));
        }
    }
    if used != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "truncated base64 media",
        ));
    }
    let end = append.with_writer(|w| Ok(w.position())).await?;
    Ok(start..end)
}
pub(super) async fn index_identifiers(
    store: &Store,
    identifiers: &dyn RecipeSource<IdentifiedText>,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<List> {
    let mut builder = IdentifierBuilder::new(store.clone(), identifiers.len()).await?;
    let mut cursor = identifiers.open(0);
    while let Some(value) = cursor.next().await? {
        builder.push(value, budget, cancel).await?;
    }
    Ok(builder.list)
}
pub(in crate::history) struct IdentifierBuilder {
    store: Store,
    list: List,
    used: usize,
}
impl IdentifierBuilder {
    pub(in crate::history) async fn new(store: Store, capacity: usize) -> io::Result<Self> {
        let list = store.table(capacity).await?;
        Ok(Self {
            store,
            list,
            used: 0,
        })
    }
    pub(in crate::history) async fn push(
        &mut self,
        value: IdentifiedText,
        budget: &Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<()> {
        let range = self
            .store
            .arena
            .append(
                text::bytes(value.text, budget.clone()),
                budget.clone(),
                cancel,
            )
            .await?;
        let mut r = Record::default();
        r[0] = range.start;
        r[1] = range.end;
        put_digest(&mut r[2..6], value.identity);
        let offset = self.store.write(r).await?;
        self.store.put(self.list, self.used, offset).await?;
        self.used += 1;
        Ok(())
    }
    pub(in crate::history) fn finish(self) -> Arc<dyn RecipeSource<IdentifiedText>> {
        self.store.list(List {
            offset: self.list.offset,
            len: self.used,
        })
    }
}
impl Decode for IdentifiedText {
    fn decode<'a>(store: &'a Store, r: Record) -> DecodeFuture<'a, Self> {
        Box::pin(async move {
            Ok(Self {
                text: TextSource::new(store.bytes(r[0]..r[1]), TextEncoding::Utf8),
                identity: digest(&r[2..6]),
            })
        })
    }
}
impl Decode for MessageRecipe {
    fn decode<'a>(store: &'a Store, r: Record) -> DecodeFuture<'a, Self> {
        Box::pin(async move {
            let provider_options = store.read_json(r[1]).await?;
            let list = List {
                offset: r[3],
                len: r[4] as usize,
            };
            Ok(match role(r[2])? {
                MessageRole::System => Self::System {
                    content: store.read_text(r[0]).await?,
                    provider_options,
                },
                MessageRole::User => Self::User {
                    content: store.list(list),
                    provider_options,
                },
                MessageRole::Assistant => Self::Assistant {
                    content: store.list(list),
                    provider_options,
                },
                MessageRole::Tool => Self::Tool {
                    content: store.list(list),
                    provider_options,
                },
            })
        })
    }
}
impl Decode for ContentRecipe {
    fn decode<'a>(store: &'a Store, r: Record) -> DecodeFuture<'a, Self> {
        Box::pin(async move {
            match r[0] {
                1 => Ok(Self::Text {
                    text: store.read_text(r[1]).await?,
                    provider_options: store.read_json(r[2]).await?,
                }),
                2 => Ok(Self::Media {
                    media: MediaSource {
                        bytes: store.bytes(r[1]..r[2]),
                        media_type: store.read_text(r[3]).await?,
                        detail: if r[4] == 0 {
                            None
                        } else {
                            Some(store.read_text(r[4]).await?)
                        },
                    },
                    provider_options: store.read_json(r[5]).await?,
                }),
                _ => Err(invalid()),
            }
        })
    }
}
impl Decode for AssistantRecipe {
    fn decode<'a>(store: &'a Store, r: Record) -> DecodeFuture<'a, Self> {
        Box::pin(async move {
            Ok(match r[0] {
                3 => Self::Text {
                    text: store.read_text(r[1]).await?,
                    provider_options: store.read_json(r[2]).await?,
                },
                4 => Self::Reasoning {
                    text: store.read_text(r[1]).await?,
                    provider_options: store.read_json(r[2]).await?,
                },
                5 => Self::CodexCompaction {
                    item: store.read_json(r[1]).await?.ok_or_else(invalid)?,
                },
                6 => Self::ToolCall {
                    tool_call_id: store.read_text(r[1]).await?,
                    tool_name: store.read_text(r[2]).await?,
                    input: if r[4] == 0 {
                        ToolInputRecipe::Json(store.read_json(r[3]).await?.ok_or_else(invalid)?)
                    } else {
                        ToolInputRecipe::Text(store.read_text(r[3]).await?)
                    },
                    kind: if r[5] == 0 {
                        ToolCallKind::Function
                    } else {
                        ToolCallKind::Custom
                    },
                    provider_executed: match r[6] {
                        0 => None,
                        1 => Some(false),
                        _ => Some(true),
                    },
                    provider_options: store.read_json(r[7]).await?,
                },
                7 => Self::ToolResult(ToolResultRecipe::decode(store, r).await?),
                _ => return Err(invalid()),
            })
        })
    }
}
impl Decode for ToolResultRecipe {
    fn decode<'a>(store: &'a Store, r: Record) -> DecodeFuture<'a, Self> {
        Box::pin(async move {
            let output = match r[5] {
                0 => ToolOutputRecipe::Text(store.read_text(r[6]).await?),
                1 => ToolOutputRecipe::ErrorText(store.read_text(r[6]).await?),
                2 => ToolOutputRecipe::Json(store.read_json(r[6]).await?.ok_or_else(invalid)?),
                3 => ToolOutputRecipe::ErrorJson(store.read_json(r[6]).await?.ok_or_else(invalid)?),
                4 => ToolOutputRecipe::Content(store.list(List {
                    offset: r[6],
                    len: r[7] as usize,
                })),
                _ => return Err(invalid()),
            };
            Ok(Self {
                tool_call_id: store.read_text(r[1]).await?,
                tool_name: store.read_text(r[2]).await?,
                kind: if r[3] == 0 {
                    ToolResultKind::Output
                } else {
                    ToolResultKind::Notification
                },
                call_kind: if r[4] == 0 {
                    ToolCallKind::Function
                } else {
                    ToolCallKind::Custom
                },
                output,
                parsed_error: if r[10] == 0 {
                    None
                } else {
                    Some(ParsedToolError {
                        value: store.read_json(r[10]).await?.ok_or_else(invalid)?,
                        code_value: store.read_json(r[11]).await?.ok_or_else(invalid)?,
                    })
                },
                replay: if r[9] == 0 {
                    ToolResultReplay::Ordinary
                } else {
                    ToolResultReplay::AnthropicMcp
                },
                provider_options: store.read_json(r[8]).await?,
            })
        })
    }
}

pub(super) async fn preserve_decisions(
    store: &Store,
    message: Record,
    original: &MessageRecipe,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<()> {
    let list = List {
        offset: message[3],
        len: message[4] as usize,
    };
    match original {
        MessageRecipe::Assistant { content, .. } => {
            let mut cursor = content.open(0);
            for index in 0..list.len {
                let part = cursor.next().await?.ok_or_else(invalid)?;
                let mut r = store.get(list, index).await?.ok_or_else(invalid)?;
                match part {
                    AssistantRecipe::ToolCall { kind, .. } => {
                        r[5] = u64::from(kind == ToolCallKind::Custom);
                    }
                    AssistantRecipe::ToolResult(result) => {
                        preserve_result(store, &mut r, result, budget, cancel).await?
                    }
                    _ => continue,
                }
                let offset = store.write(r).await?;
                store.put(list, index, offset).await?;
            }
        }
        MessageRecipe::Tool { content, .. } => {
            let mut cursor = content.open(0);
            for index in 0..list.len {
                let result = cursor.next().await?.ok_or_else(invalid)?;
                let mut r = store.get(list, index).await?.ok_or_else(invalid)?;
                preserve_result(store, &mut r, result, budget, cancel).await?;
                let offset = store.write(r).await?;
                store.put(list, index, offset).await?;
            }
        }
        _ => {}
    }
    Ok(())
}
async fn copy_json(
    store: &Store,
    value: JsonSource,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<u64> {
    let range = store
        .arena
        .append(value.into_bytes(), budget.clone(), cancel)
        .await?;
    store
        .json_node(Some(JsonSource::new(store.bytes(range))))
        .await
}
async fn preserve_result(
    store: &Store,
    r: &mut Record,
    result: ToolResultRecipe,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<()> {
    r[3] = u64::from(result.kind == ToolResultKind::Notification);
    r[4] = u64::from(result.call_kind == ToolCallKind::Custom);
    r[9] = u64::from(result.replay == ToolResultReplay::AnthropicMcp);
    if let Some(parsed) = result.parsed_error {
        r[10] = copy_json(store, parsed.value, budget, cancel).await?;
        r[11] = copy_json(store, parsed.code_value, budget, cancel).await?;
    }
    Ok(())
}

async fn parsed_error(
    store: &Store,
    text: TextSource,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<(u64, u64)> {
    let value = decoded_json(store, text, budget, cancel).await?;
    let source = store.read_json(value).await?.ok_or_else(invalid)?;
    let second = if json::kind(&source, budget.clone()).await? == json::JsonKind::String {
        decoded_json(
            store,
            TextSource::new(source.into_bytes(), TextEncoding::JsonString),
            budget,
            cancel,
        )
        .await?
    } else {
        value
    };
    Ok((value, second))
}
async fn decoded_json(
    store: &Store,
    text: TextSource,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<u64> {
    let range = store
        .arena
        .append(text::bytes(text, budget.clone()), budget.clone(), cancel)
        .await?;
    let bytes = store.bytes(range);
    match json::validate_value_bytes(&bytes, budget.clone()).await {
        Ok(_) => store.json_node(Some(JsonSource::new(bytes))).await,
        Err(error) if json::is_syntax_error(&error) => {
            let range = store.arena.with_writer(|w| w.append_bytes(b"null")).await?;
            store
                .json_node(Some(JsonSource::new(store.bytes(range))))
                .await
        }
        Err(error) => Err(error),
    }
}

/// The only cross-message replay state is an arena-backed hash set of MCP ids.
#[derive(Default)]
pub(super) struct McpSet {
    buckets: List,
    len: usize,
}
impl McpSet {
    async fn head(&self, store: &Store, key: [u8; 32]) -> io::Result<(usize, u64)> {
        let bucket = (u64::from_le_bytes(key[..8].try_into().unwrap())
            & (self.buckets.len as u64 - 1)) as usize;
        let bytes = store
            .arena
            .read_control_owned::<8>(self.buckets.offset + bucket as u64 * 8, store.owner.clone())
            .await?;
        Ok((bucket, u64::from_le_bytes(bytes)))
    }
    async fn contains(&self, store: &Store, key: [u8; 32]) -> io::Result<bool> {
        if self.buckets.len == 0 {
            return Ok(false);
        }
        let (_, mut node) = self.head(store, key).await?;
        while node != 0 {
            let r = store.read(node - 1).await?;
            if digest(&r[..4]) == key {
                return Ok(true);
            }
            node = r[4];
        }
        Ok(false)
    }
    async fn link(&self, store: &Store, key: [u8; 32]) -> io::Result<()> {
        let (bucket, head) = self.head(store, key).await?;
        let mut r = Record::default();
        put_digest(&mut r[..4], key);
        r[4] = head;
        let node = store.write(r).await?.checked_add(1).ok_or_else(overflow)?;
        store.put(self.buckets, bucket, node).await
    }
    async fn insert(&mut self, store: &Store, key: [u8; 32]) -> io::Result<()> {
        if self.contains(store, key).await? {
            return Ok(());
        }
        if self.len >= self.buckets.len / 2 {
            let old = self.buckets;
            self.buckets = store
                .table(old.len.checked_mul(2).ok_or_else(overflow)?.max(8))
                .await?;
            for index in 0..old.len {
                let mut node = u64::from_le_bytes(
                    store
                        .arena
                        .read_control_owned::<8>(old.offset + index as u64 * 8, store.owner.clone())
                        .await?,
                );
                while node != 0 {
                    let r = store.read(node - 1).await?;
                    self.link(store, digest(&r[..4])).await?;
                    node = r[4];
                }
            }
        }
        self.link(store, key).await?;
        self.len += 1;
        Ok(())
    }
}
pub(super) async fn mark_mcp(
    store: &Store,
    message: Record,
    set: &mut McpSet,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<()> {
    if message[2] != 2 {
        *set = McpSet::default();
        return Ok(());
    }
    let list = List {
        offset: message[3],
        len: message[4] as usize,
    };
    for index in 0..list.len {
        if cancel.is_cancelled() {
            return Err(crate::preparation_cancelled("MCP replay capture cancelled"));
        }
        let mut r = store.get(list, index).await?.ok_or_else(invalid)?;
        if r[0] == 6 && r[6] == 2 {
            if let Some(options) = store.read_json(r[7]).await?
                && let Some(kind) =
                    json::field(&options, &["anthropic", "type"], budget.clone()).await?
                && kind.kind == json::JsonKind::String
                && json::text_eq(&kind.text()?, "mcp-tool-use", budget.clone()).await?
            {
                let text = store.read_text(r[1]).await?;
                let id = json::text_digest(&text, budget.clone()).await?;
                set.insert(store, id).await?;
            }
        } else if r[0] == 7 {
            let id = json::text_digest(&store.read_text(r[1]).await?, budget.clone()).await?;
            r[9] = u64::from(set.contains(store, id).await?);
            let offset = store.write(r).await?;
            store.put(list, index, offset).await?;
        }
    }
    Ok(())
}
