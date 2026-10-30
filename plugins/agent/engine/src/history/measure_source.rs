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

//! Streaming logical commitments and per-term context accounting.
use super::frozen::{Items, MessageDescriptor};
use maka_agent_facts::{
    context::{ContextBucket, PreparedContextBreakdown},
    model::prompt_source::source::*,
};
use sha2::{Digest, Sha256};
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;

/// Consume one decoded text value without retaining its complete token.
pub(crate) async fn text_bytes(
    text: &TextSource,
    budget: &Arc<dyn SourceBudget>,
    cancellation: &CancellationToken,
    mut consume: impl FnMut(&[u8]) -> io::Result<()>,
) -> io::Result<u64> {
    let mut cursor = text::cursor(text.clone(), budget.clone());
    let mut buffer = budget.allocate(4096).await?;
    let mut total = 0;
    loop {
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let read = cursor.read_chunk(buffer).await?;
        consume(&read.buffer.as_ref()[..read.bytes_read])?;
        total += read.bytes_read as u64;
        buffer = read.buffer;
        if read.eof {
            return Ok(total);
        }
        if read.bytes_read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "decoded text source made no progress",
            ));
        }
    }
}

pub(crate) async fn raw_bytes(
    source: &SourceBytes,
    budget: &Arc<dyn SourceBudget>,
    cancellation: &CancellationToken,
    mut consume: impl FnMut(&[u8]) -> io::Result<()>,
) -> io::Result<u64> {
    match source {
        SourceBytes::Inline(bytes) => {
            consume(bytes)?;
            Ok(bytes.len() as u64)
        }
        SourceBytes::Source(source) => {
            let mut cursor = source.open(budget.clone());
            let mut input = budget.allocate(4096).await?;
            let mut total = 0;
            loop {
                if cancellation.is_cancelled() {
                    return Err(cancelled());
                }
                let read = cursor.read_chunk(input).await?;
                consume(&read.buffer.as_ref()[..read.bytes_read])?;
                total += read.bytes_read as u64;
                input = read.buffer;
                if read.eof {
                    return Ok(total);
                }
                if read.bytes_read == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "byte source made no progress",
                    ));
                }
            }
        }
    }
}
fn cancelled() -> io::Error {
    crate::preparation_cancelled("request preparation cancelled")
}

struct Measure<'a> {
    hash: Sha256,
    bucket: ContextBucket,
    counts: maka_agent_facts::context::ContextCounts,
    budget: &'a Arc<dyn SourceBudget>,
    cancellation: &'a CancellationToken,
}
impl Measure<'_> {
    fn marker(&mut self, marker: &[u8]) {
        self.hash.update((marker.len() as u64).to_le_bytes());
        self.hash.update(marker);
    }
    fn term(&mut self, bytes: u64) {
        self.bucket.content_bytes += bytes;
        self.bucket.estimated_tokens += bytes.div_ceil(3);
    }
    async fn text(&mut self, text: &TextSource, measured: bool) -> io::Result<[u8; 32]> {
        if self.cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let (count, identity) = if let Some(measure) = text.measure() {
            (measure.bytes, measure.sha256)
        } else {
            let mut hash = Sha256::new();
            let count = text_bytes(text, self.budget, self.cancellation, |bytes| {
                hash.update(bytes);
                Ok(())
            })
            .await?;
            (count, <[u8; 32]>::from(hash.finalize()))
        };
        self.marker(b"text");
        self.hash.update(count.to_le_bytes());
        self.hash.update(identity);
        if measured {
            self.term(count);
        }
        Ok(identity)
    }
    async fn json(&mut self, json: &JsonSource, measured: bool) -> io::Result<()> {
        if self.cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let (count, identity) = if let Some(measure) = json.measure() {
            (measure.bytes, measure.sha256)
        } else {
            let mut hash = Sha256::new();
            let count = raw_bytes(json.bytes(), self.budget, self.cancellation, |bytes| {
                hash.update(bytes);
                Ok(())
            })
            .await?;
            (count, <[u8; 32]>::from(hash.finalize()))
        };
        self.marker(b"json");
        self.hash.update(count.to_le_bytes());
        self.hash.update(identity);
        if measured {
            self.term(count);
        }
        Ok(())
    }
    async fn options(&mut self, options: &Option<JsonSource>) -> io::Result<()> {
        self.marker(if options.is_some() { b"some" } else { b"none" });
        if let Some(options) = options {
            self.json(options, false).await?;
        }
        Ok(())
    }
    async fn contents(&mut self, source: &Arc<dyn RecipeSource<ContentRecipe>>) -> io::Result<()> {
        let mut cursor = source.open(0);
        while let Some(part) = cursor.next().await? {
            match part {
                ContentRecipe::Text {
                    text,
                    provider_options,
                } => {
                    self.marker(b"content-text");
                    self.text(&text, true).await?;
                    self.options(&provider_options).await?;
                }
                ContentRecipe::Media {
                    media,
                    provider_options,
                } => {
                    self.marker(b"media");
                    self.counts.media += 1;
                    self.bucket.estimated_tokens += 1024;
                    self.text(&media.media_type, false).await?;
                    if let Some(detail) = media.detail {
                        self.marker(b"detail");
                        self.text(&detail, false).await?;
                    } else {
                        self.marker(b"no-detail");
                    }
                    let mut hash = Sha256::new();
                    let count = raw_bytes(&media.bytes, self.budget, self.cancellation, |bytes| {
                        hash.update(bytes);
                        Ok(())
                    })
                    .await?;
                    self.hash.update(count.to_le_bytes());
                    self.hash.update(hash.finalize());
                    self.options(&provider_options).await?;
                }
            }
        }
        self.marker(b"content-end");
        Ok(())
    }
    async fn result(&mut self, result: &ToolResultRecipe) -> io::Result<IdentifiedText> {
        self.marker(b"result");
        self.counts.tool_results += 1;
        self.bucket.estimated_tokens += 16;
        self.hash.update([
            result.kind as u8,
            result.call_kind as u8,
            result.replay as u8,
        ]);
        let identity = self.text(&result.tool_call_id, false).await?;
        self.text(&result.tool_name, true).await?;
        match &result.output {
            ToolOutputRecipe::Text(text) => {
                self.marker(b"text");
                self.text(text, true).await?;
            }
            ToolOutputRecipe::ErrorText(text) => {
                self.marker(b"error-text");
                self.text(text, true).await?;
            }
            ToolOutputRecipe::Json(json) => {
                self.marker(b"json");
                self.json(json, true).await?;
            }
            ToolOutputRecipe::ErrorJson(json) => {
                self.marker(b"error-json");
                self.json(json, true).await?;
            }
            ToolOutputRecipe::Content(content) => {
                self.marker(b"content");
                self.contents(content).await?;
            }
        }
        self.options(&result.provider_options).await?;
        Ok(IdentifiedText {
            text: result.tool_call_id.clone(),
            identity,
        })
    }
}

enum Identifiers {
    Resident {
        values: Vec<IdentifiedText>,
        owner: Arc<dyn Send + Sync>,
    },
    Arena {
        store: super::arena_recipes::ArenaRecipes,
        list: super::arena_recipes::List,
        used: usize,
    },
}
impl Identifiers {
    async fn new(
        capacity: usize,
        owner: Arc<dyn Send + Sync>,
        store: Option<&super::arena_recipes::ArenaRecipes>,
    ) -> io::Result<Self> {
        Ok(match store {
            Some(store) => Self::Arena {
                store: store.clone(),
                list: store.begin_list(capacity).await?,
                used: 0,
            },
            None => Self::Resident {
                values: Vec::with_capacity(capacity),
                owner,
            },
        })
    }
    async fn push(
        &mut self,
        value: IdentifiedText,
        budget: &Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<()> {
        match self {
            Self::Resident { values, .. } => values.push(value),
            Self::Arena { store, list, used } => {
                let node = store.identified(value, budget.clone(), cancel).await?;
                store.put(*list, *used, node).await?;
                *used += 1;
            }
        }
        Ok(())
    }
    fn finish(self) -> io::Result<Arc<dyn RecipeSource<IdentifiedText>>> {
        Ok(match self {
            Self::Resident { values, owner } => Arc::new(Items::new(values, owner)),
            Self::Arena { store, list, used } => store.identifiers(list.range(0..used)?),
        })
    }
}
pub(crate) async fn describe(
    recipe: MessageRecipe,
    budget: &Arc<dyn SourceBudget>,
    owner: Arc<dyn Send + Sync>,
    cancellation: &CancellationToken,
) -> io::Result<MessageDescriptor> {
    describe_with(recipe, budget, owner, cancellation, None).await
}
pub(super) async fn describe_arena(
    recipe: MessageRecipe,
    budget: &Arc<dyn SourceBudget>,
    owner: Arc<dyn Send + Sync>,
    cancellation: &CancellationToken,
    store: &super::arena_recipes::ArenaRecipes,
) -> io::Result<MessageDescriptor> {
    describe_with(recipe, budget, owner, cancellation, Some(store)).await
}
async fn describe_with(
    recipe: MessageRecipe,
    budget: &Arc<dyn SourceBudget>,
    owner: Arc<dyn Send + Sync>,
    cancellation: &CancellationToken,
    store: Option<&super::arena_recipes::ArenaRecipes>,
) -> io::Result<MessageDescriptor> {
    let mut measure = Measure {
        hash: Sha256::new(),
        bucket: ContextBucket::default(),
        counts: maka_agent_facts::context::ContextCounts::default(),
        budget,
        cancellation,
    };
    measure.marker(b"maka.logical-message");
    measure.counts.messages = 1;
    measure.bucket.estimated_tokens = 16;
    let part_capacity = match &recipe {
        MessageRecipe::Assistant { content, .. } => content.len(),
        MessageRecipe::Tool { content, .. } => content.len(),
        _ => 0,
    };
    let mut local_tool_names = Identifiers::new(part_capacity, owner.clone(), store).await?;
    let mut settled = Identifiers::new(part_capacity, owner, store).await?;
    let mut last_is_tool_result = false;
    let role = match &recipe {
        MessageRecipe::System {
            content,
            provider_options,
        } => {
            measure.marker(b"system");
            measure.text(content, true).await?;
            measure.options(provider_options).await?;
            MessageRole::System
        }
        MessageRecipe::User {
            content,
            provider_options,
        } => {
            measure.marker(b"user");
            measure.contents(content).await?;
            measure.options(provider_options).await?;
            MessageRole::User
        }
        MessageRecipe::Assistant {
            content,
            provider_options,
        } => {
            measure.marker(b"assistant");
            let mut cursor = content.open(0);
            while let Some(part) = cursor.next().await? {
                last_is_tool_result = matches!(part, AssistantRecipe::ToolResult(_));
                match part {
                    AssistantRecipe::Text {
                        text,
                        provider_options,
                    } => {
                        measure.marker(b"text");
                        measure.text(&text, true).await?;
                        measure.options(&provider_options).await?;
                    }
                    AssistantRecipe::Reasoning {
                        text,
                        provider_options,
                    } => {
                        measure.marker(b"reasoning");
                        measure.text(&text, true).await?;
                        measure.options(&provider_options).await?;
                    }
                    AssistantRecipe::ToolCall {
                        tool_call_id,
                        tool_name,
                        input,
                        kind,
                        provider_executed,
                        provider_options,
                    } => {
                        measure.marker(b"call");
                        measure.hash.update([
                            kind as u8,
                            match provider_executed {
                                None => 0,
                                Some(false) => 1,
                                Some(true) => 2,
                            },
                        ]);
                        measure.counts.tool_calls += 1;
                        measure.bucket.estimated_tokens += 16;
                        measure.text(&tool_call_id, false).await?;
                        let name_identity = measure.text(&tool_name, true).await?;
                        if provider_executed != Some(true) {
                            local_tool_names
                                .push(
                                    IdentifiedText {
                                        text: tool_name,
                                        identity: name_identity,
                                    },
                                    budget,
                                    cancellation,
                                )
                                .await?;
                        }
                        match input {
                            ToolInputRecipe::Text(text) => {
                                measure.marker(b"text");
                                measure.text(&text, true).await?;
                            }
                            ToolInputRecipe::Json(json) => {
                                measure.marker(b"json");
                                measure.json(&json, true).await?;
                            }
                        }
                        measure.options(&provider_options).await?;
                    }
                    AssistantRecipe::ToolResult(result) => {
                        let id = measure.result(&result).await?;
                        if result.kind == ToolResultKind::Settled {
                            settled.push(id, budget, cancellation).await?;
                        }
                    }
                }
            }
            measure.marker(b"assistant-end");
            measure.options(provider_options).await?;
            MessageRole::Assistant
        }
        MessageRecipe::Tool {
            content,
            provider_options,
        } => {
            measure.marker(b"tool");
            let mut cursor = content.open(0);
            while let Some(result) = cursor.next().await? {
                let id = measure.result(&result).await?;
                if result.kind == ToolResultKind::Settled {
                    settled.push(id, budget, cancellation).await?;
                }
            }
            measure.marker(b"tool-end");
            measure.options(provider_options).await?;
            MessageRole::Tool
        }
    };
    let mut breakdown = PreparedContextBreakdown {
        counts: measure.counts,
        ..Default::default()
    };
    *match role {
        MessageRole::System => &mut breakdown.system,
        MessageRole::User => &mut breakdown.user,
        MessageRole::Assistant => &mut breakdown.assistant,
        MessageRole::Tool => &mut breakdown.tool,
    } = measure.bucket;
    let commitment: [u8; 32] = measure.hash.finalize().into();
    Ok(MessageDescriptor {
        recipe,
        role,
        last_is_tool_result,
        local_tool_names: local_tool_names.finish()?,
        settled_tool_call_ids: settled.finish()?,
        breakdown,
        logical_identity: hex::encode(commitment).into(),
        commitment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        context::measure,
        model::{
            prompt::{AssistantPart, Message},
            prompt_source::Prompt,
        },
    };

    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
        }
    }
    fn measured_text(bytes: &'static [u8], decoded: &[u8], encoding: TextEncoding) -> TextSource {
        TextSource::measured(
            SourceBytes::Inline(bytes.into()),
            encoding,
            DecodedTextMeasure {
                bytes: decoded.len() as u64,
                sha256: Sha256::digest(decoded).into(),
            },
        )
    }
    #[tokio::test]
    async fn known_leaves_preserve_logical_commitment_and_accounting() {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let cancellation = CancellationToken::new();
        let decoded = "想😀\n".as_bytes();
        let encoded = br#""\u60f3\ud83d\ude00\n""#;
        let raw_json = br#"{ "value": "\u60f3" }"#;
        let unknown = MessageRecipe::System {
            content: TextSource::new(
                SourceBytes::Inline(encoded.as_slice().into()),
                TextEncoding::JsonString,
            ),
            provider_options: Some(JsonSource::new(SourceBytes::Inline(
                raw_json.as_slice().into(),
            ))),
        };
        let known = MessageRecipe::System {
            content: measured_text(encoded, decoded, TextEncoding::JsonString),
            provider_options: Some(JsonSource::measured(
                SourceBytes::Inline(raw_json.as_slice().into()),
                RawJsonMeasure {
                    bytes: raw_json.len() as u64,
                    sha256: Sha256::digest(raw_json).into(),
                },
            )),
        };
        let unknown = describe(unknown, &budget, Arc::new(()), &cancellation)
            .await
            .unwrap();
        let known = describe(known, &budget, Arc::new(()), &cancellation)
            .await
            .unwrap();
        assert_eq!(known.commitment, unknown.commitment);
        assert_eq!(known.breakdown, unknown.breakdown);
        let changed = describe(
            MessageRecipe::System {
                content: measured_text(encoded, decoded, TextEncoding::JsonString),
                provider_options: Some(JsonSource::new(SourceBytes::Inline(
                    r#"{"value":"想"}"#.as_bytes().into(),
                ))),
            },
            &budget,
            Arc::new(()),
            &cancellation,
        )
        .await
        .unwrap();
        assert_ne!(known.commitment, changed.commitment);
    }
    #[tokio::test]
    async fn cancelled_known_message_does_not_complete_measurement() {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let options = Some(JsonSource::measured(
            SourceBytes::Inline(b"{}".as_slice().into()),
            RawJsonMeasure {
                bytes: 2,
                sha256: Sha256::digest(b"{}").into(),
            },
        ));
        for recipe in [
            MessageRecipe::System {
                content: measured_text(b"hello", b"hello", TextEncoding::Utf8),
                provider_options: options.clone(),
            },
            MessageRecipe::User {
                content: Arc::new(generated::GeneratedRecipes::new(Vec::new())),
                provider_options: options,
            },
        ] {
            let result = describe(recipe, &budget, Arc::new(()), &cancellation).await;
            assert!(matches!(
                result.map_err(crate::RunError::preparation),
                Err(crate::RunError::Cancelled)
            ));
        }
    }

    struct UnopenedLargeLeaf;
    impl ByteSource for UnopenedLargeLeaf {
        fn len(&self) -> Option<u64> {
            Some(1 << 40)
        }
        fn open(&self, _: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            panic!("known logical measurement must not open the leaf")
        }
    }
    #[tokio::test]
    async fn known_large_leaf_is_measured_without_opening_its_body() {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let descriptor = describe(
            MessageRecipe::System {
                content: TextSource::measured(
                    SourceBytes::Source(Arc::new(UnopenedLargeLeaf)),
                    TextEncoding::Utf8,
                    DecodedTextMeasure {
                        bytes: 1 << 40,
                        sha256: [7; 32],
                    },
                ),
                provider_options: None,
            },
            &budget,
            Arc::new(()),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(descriptor.breakdown.system.content_bytes, 1 << 40);
    }
    #[tokio::test]
    async fn decoded_content_commitment_does_not_depend_on_json_escape_spelling() {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let make = |bytes: &'static [u8], encoding| MessageRecipe::System {
            content: TextSource::new(SourceBytes::Inline(bytes.into()), encoding),
            provider_options: None,
        };
        let cancellation = CancellationToken::new();
        let raw = describe(
            make("想😀\n".as_bytes(), TextEncoding::Utf8),
            &budget,
            Arc::new(()),
            &cancellation,
        )
        .await
        .unwrap();
        let escaped = describe(
            make(br#""\u60f3\ud83d\ude00\n""#, TextEncoding::JsonString),
            &budget,
            Arc::new(()),
            &cancellation,
        )
        .await
        .unwrap();
        assert_eq!(raw.commitment, escaped.commitment);
        assert_eq!(raw.breakdown, escaped.breakdown);
        assert_eq!(raw.breakdown.system.content_bytes, 8);
    }
    #[tokio::test]
    async fn recipe_accounting_preserves_original_term_rounding() {
        let messages = vec![Message::Assistant {
            content: vec![
                AssistantPart::Text {
                    text: "a".into(),
                    provider_options: None,
                },
                AssistantPart::Text {
                    text: "bc".into(),
                    provider_options: None,
                },
            ],
            provider_options: None,
        }];
        let expected = measure::prompt_breakdown(&messages);
        let prompt = Prompt::from_messages(messages);
        let mut cursor = prompt.recipes().unwrap().open(0);
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let descriptor = describe(
            cursor.next().await.unwrap().unwrap(),
            &budget,
            Arc::new(()),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(descriptor.breakdown, expected);
        assert_eq!(descriptor.breakdown.assistant.estimated_tokens, 18);
    }
}
