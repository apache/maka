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

//! Chat's logical tool-media projection, before accounting and commitment.
use super::{frozen::Items, prepared::MessageBuilder};
use maka_agent_facts::{language::Language, model::prompt_source::source::*};
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;

const LABEL_CHARACTERS: usize = 128;
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct ChatShape {
    pub content_parts: usize,
    pub media_parts: usize,
    pub media_results: usize,
}
impl ChatShape {
    pub fn accumulate(&mut self, other: Self) -> io::Result<()> {
        for (total, add) in [
            (&mut self.content_parts, other.content_parts),
            (&mut self.media_parts, other.media_parts),
            (&mut self.media_results, other.media_results),
        ] {
            *total = total
                .checked_add(add)
                .ok_or_else(|| io::Error::other("Chat projection count overflow"))?;
        }
        Ok(())
    }
}
fn array<T>(count: usize) -> io::Result<usize> {
    std::mem::size_of::<T>()
        .checked_mul(count)
        .ok_or_else(|| io::Error::other("Chat projection allocation overflow"))
}
fn arc<T>() -> usize {
    2 * std::mem::size_of::<usize>() + std::mem::size_of::<T>()
}
pub(super) fn allocation_bytes(
    rows: usize,
    shape: ChatShape,
    language: Language,
) -> io::Result<usize> {
    let mut bytes = 2 * std::mem::size_of::<usize>()
        + array::<MessageBuilder>(
            rows.checked_add(shape.media_results)
                .ok_or_else(|| io::Error::other("Chat message count overflow"))?,
        )?;
    let generated = shape
        .media_parts
        .checked_add(shape.media_results)
        .ok_or_else(|| io::Error::other("Chat content count overflow"))?;
    for amount in [
        array::<ContentRecipe>(generated)?.checked_mul(2),
        Some(array::<ContentRecipe>(shape.content_parts)?),
        Some(
            shape
                .media_results
                .checked_mul(
                    2 * label_capacity(language)
                        + arc::<OwnedLabel>()
                        + arc::<LabelRange>()
                        + arc::<Items<ContentRecipe>>(),
                )
                .ok_or_else(|| io::Error::other("Chat label allocation overflow"))?,
        ),
        Some(array::<MessageDescriptorSlot>(shape.media_results)?),
    ] {
        bytes = bytes
            .checked_add(
                amount.ok_or_else(|| io::Error::other("Chat projection allocation overflow"))?,
            )
            .ok_or_else(|| io::Error::other("Chat projection allocation overflow"))?;
    }
    // Prefix/name/result directories have one additional user entry per batch at most.
    bytes = bytes
        .checked_add(
            shape
                .media_results
                .checked_mul(
                    2 * std::mem::size_of::<[u8; 32]>()
                        + 3 * arc::<Items<IdentifiedText>>()
                        + 6 * std::mem::size_of::<usize>()
                        + 64,
                )
                .ok_or_else(|| io::Error::other("Chat metadata allocation overflow"))?,
        )
        .ok_or_else(|| io::Error::other("Chat metadata allocation overflow"))?;
    Ok(bytes)
}
type MessageDescriptorSlot = [super::frozen::MessageDescriptor; 2];

struct OwnedLabel {
    bytes: Vec<u8>,
    _owner: Arc<dyn Send + Sync>,
}
struct LabelRange {
    label: Arc<OwnedLabel>,
    start: usize,
    end: usize,
}
impl ByteSource for LabelRange {
    fn len(&self) -> Option<u64> {
        Some((self.end - self.start) as u64)
    }
    fn slice(&self, range: std::ops::Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        let start = usize::try_from(range.start).map_err(io::Error::other)?;
        let end = usize::try_from(range.end).map_err(io::Error::other)?;
        if start > end || end > self.end - self.start {
            return Err(io::Error::other("Chat label range exceeds bytes"));
        }
        Ok(Arc::new(Self {
            label: self.label.clone(),
            start: self.start + start,
            end: self.start + end,
        }))
    }
    fn open(&self, _: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(LabelCursor {
            label: self.label.clone(),
            position: self.start,
            end: self.end,
        })
    }
}
struct LabelCursor {
    label: Arc<OwnedLabel>,
    position: usize,
    end: usize,
}
impl ByteCursor for LabelCursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let take = (self.end - self.position).min(buffer.as_ref().len());
            buffer.as_mut()[..take]
                .copy_from_slice(&self.label.bytes[self.position..self.position + take]);
            self.position += take;
            Ok(SourceRead {
                buffer: buffer.retain_owner(self.label.clone()),
                bytes_read: take,
                eof: self.position == self.end,
            })
        })
    }
}
fn label_capacity(language: Language) -> usize {
    let fixed = match language {
        Language::En => "Images from tool  (toolCallId: ):",
        Language::ZhCn => "工具  提供的图片（toolCallId: ）：",
        Language::ZhTw => "工具  提供的圖片（toolCallId: ）：",
    };
    fixed.len() + 2 * LABEL_CHARACTERS * 4
}
async fn prefix(
    text: &TextSource,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<String> {
    let capacity = LABEL_CHARACTERS * 4;
    let mut bytes = Vec::with_capacity(capacity);
    let mut cursor = text::cursor(text.clone(), budget.clone());
    let mut buffer = budget.allocate(capacity).await?;
    let mut eof = false;
    while bytes.len() < capacity && !eof {
        if cancel.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Chat projection cancelled",
            ));
        }
        let read = cursor.read_chunk(buffer).await?;
        let take = read.bytes_read.min(capacity - bytes.len());
        bytes.extend_from_slice(&read.buffer.as_ref()[..take]);
        eof = read.eof && take == read.bytes_read;
        buffer = read.buffer;
        if take == 0 && !eof {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Chat label source made no progress",
            ));
        }
    }
    let value = match std::str::from_utf8(&bytes) {
        Ok(value) => value,
        Err(error) if !eof && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).map_err(io::Error::other)?
        }
        Err(error) => return Err(io::Error::other(error)),
    };
    let end = value
        .char_indices()
        .nth(LABEL_CHARACTERS)
        .map_or(value.len(), |(offset, _)| offset);
    Ok(value[..end].to_owned())
}
pub(super) async fn class(
    part: &ContentRecipe,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<Option<bool>> {
    let ContentRecipe::Media { media, .. } = part else {
        return Ok(None);
    };
    let mime = prefix(&media.media_type, budget, cancel).await?;
    Ok(if mime.starts_with("audio/") {
        Some(true)
    } else if mime.starts_with("image/") {
        Some(false)
    } else {
        None
    })
}
pub(super) fn fallback(language: Language, audio: bool) -> &'static str {
    match (language, audio) {
        (Language::En, false) => "Tool images are supplied in the following user message.",
        (Language::En, true) => "Tool media are supplied in the following user message.",
        (Language::ZhCn, false) => "工具图片见下一条用户消息。",
        (Language::ZhCn, true) => "工具媒体见下一条用户消息。",
        (Language::ZhTw, false) => "工具圖片見下一則使用者訊息。",
        (Language::ZhTw, true) => "工具媒體見下一則使用者訊息。",
    }
}
pub(super) async fn label(
    result: &ToolResultRecipe,
    audio: bool,
    language: Language,
    budget: &Arc<dyn SourceBudget>,
    owner: Arc<dyn Send + Sync>,
    cancel: &CancellationToken,
) -> io::Result<TextSource> {
    use std::fmt::Write as _;
    let name = prefix(&result.tool_name, budget, cancel).await?;
    let id = prefix(&result.tool_call_id, budget, cancel).await?;
    let mut text = String::with_capacity(label_capacity(language));
    match language {
        Language::En => write!(
            &mut text,
            "{} from tool {name} (toolCallId: {id}):",
            if audio { "Media" } else { "Images" }
        ),
        Language::ZhCn => write!(
            &mut text,
            "工具 {name} 提供的{}（toolCallId: {id}）：",
            if audio { "媒体" } else { "图片" }
        ),
        Language::ZhTw => write!(
            &mut text,
            "工具 {name} 提供的{}（toolCallId: {id}）：",
            if audio { "媒體" } else { "圖片" }
        ),
    }
    .expect("precharged Chat label capacity accepts formatting");
    let end = text.len();
    let label = Arc::new(OwnedLabel {
        bytes: text.into_bytes(),
        _owner: owner,
    });
    Ok(TextSource {
        bytes: SourceBytes::Source(Arc::new(LabelRange {
            label,
            start: 0,
            end,
        })),
        encoding: TextEncoding::Utf8,
    })
}

pub(super) async fn project(
    messages: Vec<MessageBuilder>,
    shape: ChatShape,
    language: Language,
    budget: &Arc<dyn SourceBudget>,
    owner: Arc<dyn Send + Sync>,
    cancel: &CancellationToken,
) -> io::Result<(Vec<MessageBuilder>, Arc<[ContentRecipe]>)> {
    let mut output = Vec::with_capacity(
        messages
            .capacity()
            .checked_add(shape.media_results)
            .ok_or_else(|| io::Error::other("Chat message capacity overflow"))?,
    );
    let mut deferred = Vec::with_capacity(
        shape
            .media_parts
            .checked_add(shape.media_results)
            .ok_or_else(|| io::Error::other("Chat content capacity overflow"))?,
    );
    let mut pending = 0;
    for mut message in messages {
        let MessageBuilder::Tool(result) = &mut message else {
            if deferred.len() != pending {
                output.push(MessageBuilder::DeferredUser {
                    parts: pending..deferred.len(),
                });
                pending = deferred.len();
            }
            output.push(message);
            continue;
        };
        let ToolOutputRecipe::Content(content) = &result.output else {
            output.push(message);
            continue;
        };
        let mut parts = content.open(0);
        let mut media = 0usize;
        let mut audio = false;
        while let Some(part) = parts.next().await? {
            if let Some(is_audio) = class(&part, budget, cancel).await? {
                media += 1;
                audio |= is_audio;
            }
        }
        drop(parts);
        if media == 0 {
            output.push(message);
            continue;
        }
        deferred.push(ContentRecipe::Text {
            text: label(result, audio, language, budget, owner.clone(), cancel).await?,
            provider_options: None,
        });
        let placeholder = ToolOutputRecipe::Text(TextSource {
            bytes: SourceBytes::Inline((&b""[..]).into()),
            encoding: TextEncoding::Utf8,
        });
        let ToolOutputRecipe::Content(content) = std::mem::replace(&mut result.output, placeholder)
        else {
            unreachable!()
        };
        let mut kept = Vec::with_capacity(content.len());
        let mut parts = content.open(0);
        while let Some(part) = parts.next().await? {
            if class(&part, budget, cancel).await?.is_some() {
                deferred.push(part);
            } else {
                kept.push(part);
            }
        }
        drop(parts);
        drop(content);
        if kept.is_empty() {
            kept.push(ContentRecipe::Text {
                text: TextSource {
                    bytes: SourceBytes::Inline(fallback(language, audio).as_bytes().into()),
                    encoding: TextEncoding::Utf8,
                },
                provider_options: None,
            });
        }
        result.output = ToolOutputRecipe::Content(Arc::new(Items::new(kept, owner.clone())));
        output.push(message);
    }
    if deferred.len() != pending {
        output.push(MessageBuilder::DeferredUser {
            parts: pending..deferred.len(),
        });
    }
    Ok((output, deferred.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        context::{PreparedContextBreakdown, measure},
        model::{
            prompt::{AssistantPart, ContentPart, FileData, Message, ToolOutput},
            prompt_source::source::generated,
        },
    };
    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
        }
    }
    #[tokio::test]
    async fn logical_tool_media_projection_preserves_owned_oracle_accounting() {
        for text in [Some("before"), None] {
            let mut content = Vec::new();
            if let Some(text) = text {
                content.push(ContentPart::text(text));
            }
            content.push(ContentPart::File {
                data: FileData::Data("eHl6".into()),
                media_type: "image/png".into(),
                provider_options: None,
            });
            let owned = vec![
                Message::tool("call", "Read", ToolOutput::Content(content)),
                Message::Assistant {
                    content: vec![AssistantPart::Text {
                        text: "done".into(),
                        provider_options: None,
                    }],
                    provider_options: None,
                },
            ];
            let expected = measure::prompt_breakdown(&super::super::chat::project(
                owned.clone(),
                Language::En,
            ));
            let MessageRecipe::Tool { content, .. } = generated::message(&owned[0]) else {
                panic!("tool")
            };
            let result = content.open(0).next().await.unwrap().unwrap();
            let input_parts = text.is_some() as usize + 1;
            let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
            let owner: Arc<dyn Send + Sync> = Arc::new(());
            let cancel = CancellationToken::new();
            let (projected, deferred) = project(
                vec![
                    MessageBuilder::Tool(result),
                    MessageBuilder::Assistant {
                        parts: 0..1,
                        options: None,
                    },
                ],
                ChatShape {
                    content_parts: input_parts,
                    media_parts: 1,
                    media_results: 1,
                },
                Language::En,
                &budget,
                owner.clone(),
                &cancel,
            )
            .await
            .unwrap();
            assert_eq!(projected.len(), 3);
            let mut breakdown = PreparedContextBreakdown::default();
            for message in projected {
                let recipe = match message {
                    MessageBuilder::Tool(result) => MessageRecipe::Tool {
                        content: Arc::new(Items::new(vec![result], owner.clone())),
                        provider_options: None,
                    },
                    MessageBuilder::DeferredUser { parts } => MessageRecipe::User {
                        content: Arc::new(Items::range(deferred.clone(), parts, owner.clone())),
                        provider_options: None,
                    },
                    MessageBuilder::Assistant { .. } => generated::message(&owned[1]),
                    MessageBuilder::User(_) => panic!("unexpected original user"),
                };
                let measured =
                    super::super::measure_source::describe(recipe, &budget, owner.clone(), &cancel)
                        .await
                        .unwrap();
                breakdown.accumulate(&measured.breakdown);
            }
            assert_eq!(breakdown, expected);
            assert_eq!(breakdown.counts.messages, 3);
            assert!(breakdown.user.estimated_tokens > 1024);
        }
    }
}
