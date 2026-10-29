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
use maka_agent_facts::model::prompt_source::source::{
    Allocate, ChargedBuffer, NextRecipe, ReadSource, SourceRead, ToolCallKind,
};
use maka_provider_protocol::{anthropic::prompt::prepared::PreparedEncoder, input};
use serde_json::json;

struct Budget;
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
    }
}
struct List<T>(Arc<[T]>);
struct ListCursor<T> {
    items: Arc<[T]>,
    index: usize,
}
impl<T: Clone + Send + Sync + 'static> RecipeSource<T> for List<T> {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<T>> {
        Box::new(ListCursor {
            items: self.0.clone(),
            index: start,
        })
    }
}
impl<T: Clone + Send + Sync> RecipeCursor<T> for ListCursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        Box::pin(async move {
            let item = self.items.get(self.index).cloned();
            self.index += usize::from(item.is_some());
            Ok(item)
        })
    }
}
fn list<T: Clone + Send + Sync + 'static>(values: Vec<T>) -> Arc<dyn RecipeSource<T>> {
    Arc::new(List(values.into()))
}
fn options(value: serde_json::Value) -> Option<JsonSource> {
    Some(JsonSource::new(SourceBytes::Inline(Bytes::from(
        serde_json::to_vec(&value).unwrap(),
    ))))
}
fn opts() -> StreamOptions {
    StreamOptions {
        send_reasoning: true,
        cache_namespace: "anthropic".into(),
        tool_names: Default::default(),
        toolsets: Default::default(),
    }
}
fn raw(value: &str) -> TextSource {
    TextSource::new(
        SourceBytes::Inline(Bytes::copy_from_slice(value.as_bytes())),
        TextEncoding::Utf8,
    )
}
async fn bytes(item: &SourceItem) -> Vec<u8> {
    let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
    let mut result = Vec::new();
    for fragment in item.fragments.iter() {
        let mut cursor = FragmentCursor::new(fragment.clone());
        while let Some(bytes) = cursor.next(budget.clone()).await.unwrap() {
            result.extend_from_slice(&bytes)
        }
    }
    result
}
fn metadata(item: &SourceItem) -> &SourcePart {
    match item.metadata.as_ref().unwrap() {
        WireItemMetadata::Anthropic(metadata) => metadata,
        _ => panic!("source metadata"),
    }
}
type SourcePart = PartMetadata<IdentifiedText, FrozenCacheCandidate>;

struct SplitSource(Bytes);
struct SplitCursor {
    bytes: Bytes,
    at: usize,
}
impl ByteSource for SplitSource {
    fn len(&self) -> Option<u64> {
        Some(self.0.len() as u64)
    }
    fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(SplitCursor {
            bytes: self.0.clone(),
            at: 0,
        })
    }
}
impl ByteCursor for SplitCursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let count = 7.min(buffer.as_mut().len()).min(self.bytes.len() - self.at);
            buffer.as_mut()[..count].copy_from_slice(&self.bytes[self.at..self.at + count]);
            self.at += count;
            Ok(SourceRead {
                buffer,
                bytes_read: count,
                eof: self.at == self.bytes.len(),
            })
        })
    }
}
#[tokio::test]
async fn source_text_matches_owned_oracle_with_split_escapes_and_unicode_trim() {
    let text = format!("\u{2003}\n{}\u{00a0}", "中\"\\\n🚀".repeat(5000));
    let source = TextSource::new(
        SourceBytes::Source(Arc::new(SplitSource(Bytes::from(
            serde_json::to_vec(&text).unwrap(),
        )))),
        TextEncoding::JsonString,
    );
    let compiler = Compiler::new(Arc::new(opts()), Language::En);
    let items = compiler
        .compile(
            MessageRecipe::Assistant {
                content: list(vec![AssistantRecipe::Text {
                    text: source,
                    provider_options: None,
                }]),
                provider_options: None,
            },
            Arc::new(Budget),
        )
        .await
        .unwrap();
    let actual = bytes(&items[0]).await;
    let message = input::Message::Assistant {
        parts: vec![input::AssistantPart::Text {
            text: text.clone(),
            extensions: None,
        }],
        extensions: None,
    };
    let mut oracle = PreparedEncoder::new(opts());
    oracle.begin(&message).unwrap();
    let expected: Vec<u8> = oracle.part(&message, 0).unwrap().chunks.flatten().collect();
    assert_eq!(actual, expected);
    let trim = metadata(&items[0]).trim.as_ref().unwrap();
    let trimmed: Vec<u8> = actual
        .into_iter()
        .enumerate()
        .filter_map(|(index, byte)| {
            (!trim.leading.contains(&(index as u64)) && !trim.trailing.contains(&(index as u64)))
                .then_some(byte)
        })
        .collect();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&trimmed).unwrap()["text"],
        text.trim()
    );
}
#[tokio::test]
async fn mcp_replay_consumes_only_the_frozen_producer_decision() {
    let compiler = Compiler::new(Arc::new(opts()), Language::En);
    let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
    let call = MessageRecipe::Assistant {
        content: list(vec![AssistantRecipe::ToolCall {
            tool_call_id: raw("id"),
            tool_name: raw("custom"),
            input: ToolInputRecipe::Json(JsonSource::new(SourceBytes::Inline(Bytes::from_static(
                b"{}",
            )))),
            kind: ToolCallKind::Function,
            provider_executed: Some(true),
            provider_options: options(
                json!({"anthropic":{"type":"mcp-tool-use","serverName":"mcp"}}),
            ),
        }]),
        provider_options: None,
    };
    compiler.compile(call, budget.clone()).await.unwrap();
    let result = |replay| MessageRecipe::Assistant {
        content: list(vec![AssistantRecipe::ToolResult(ToolResultRecipe {
            tool_call_id: raw("id"),
            tool_name: raw("custom"),
            kind: ToolResultKind::Settled,
            call_kind: ToolCallKind::Function,
            output: ToolOutputRecipe::Json(JsonSource::new(SourceBytes::Inline(
                Bytes::from_static(b"{\"opaque\":[1,2]}"),
            ))),
            provider_options: None,
            parsed_error: None,
            replay,
        })]),
        provider_options: None,
    };
    let selected = compiler
        .compile(result(ToolResultReplay::AnthropicMcp), budget.clone())
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes(&selected[0]).await).unwrap()["type"],
        "mcp_tool_result"
    );
    compiler
        .compile(
            MessageRecipe::User {
                content: list(vec![ContentRecipe::Text {
                    text: raw("boundary"),
                    provider_options: None,
                }]),
                provider_options: None,
            },
            budget.clone(),
        )
        .await
        .unwrap();
    let unselected = compiler
        .compile(result(ToolResultReplay::Ordinary), budget)
        .await
        .unwrap();
    assert!(!metadata(&unselected[0]).emitted);
    assert!(bytes(&unselected[0]).await.is_empty());
}
#[tokio::test]
async fn notification_splits_preserve_localized_text_and_following_message_cache_scope() {
    let compiler = Compiler::new(Arc::new(opts()), Language::ZhCn);
    let result = ToolResultRecipe {
        tool_call_id: raw("x"),
        tool_name: raw("exec"),
        kind: ToolResultKind::Notification,
        call_kind: ToolCallKind::Function,
        output: ToolOutputRecipe::Text(raw("ready\n中")),
        provider_options: None,
        parsed_error: None,
        replay: ToolResultReplay::Ordinary,
    };
    let items = compiler
        .compile(
            MessageRecipe::Tool {
                content: list(vec![result]),
                provider_options: None,
            },
            Arc::new(Budget),
        )
        .await
        .unwrap();
    let block: serde_json::Value = serde_json::from_slice(&bytes(&items[0]).await).unwrap();
    assert_eq!(block["text"], "[来自 exec x 的通知]\nready\n中");
    assert!(metadata(&items[0]).message.user_content);
    assert_eq!(metadata(&items[0]).part_index, 0);
}

#[tokio::test]
async fn nested_error_string_keeps_first_stage_wrapper_and_second_stage_code() {
    use maka_agent_facts::model::prompt_source::source::ParsedToolError;
    let inner = json!({"type":"code_execution_tool_result_error","error_code":"quota"});
    let first = json!(inner.to_string());
    let original = json!(first.to_string());
    let source_json = |value: &serde_json::Value| {
        JsonSource::new(SourceBytes::Inline(Bytes::from(
            serde_json::to_vec(value).unwrap(),
        )))
    };
    let mut options = opts();
    options
        .tool_names
        .insert("executor".into(), "code_execution".into());
    let recipe = MessageRecipe::Assistant {
        content: list(vec![AssistantRecipe::ToolResult(ToolResultRecipe {
            tool_call_id: raw("call"),
            tool_name: raw("executor"),
            kind: ToolResultKind::Settled,
            call_kind: ToolCallKind::Function,
            output: ToolOutputRecipe::ErrorJson(source_json(&original)),
            parsed_error: Some(ParsedToolError {
                value: source_json(&first),
                code_value: source_json(&inner),
            }),
            replay: ToolResultReplay::Ordinary,
            provider_options: None,
        })]),
        provider_options: None,
    };
    let compiler = Compiler::new(Arc::new(options.clone()), Language::En);
    let items = compiler.compile(recipe, Arc::new(Budget)).await.unwrap();
    let actual = bytes(&items[0]).await;
    let input = input::Message::Assistant {
        parts: vec![input::AssistantPart::ToolResult(input::ToolResult {
            id: "call".into(),
            name: "executor".into(),
            output: input::ToolOutput {
                value: input::ToolValue::ErrorJson(original),
                extensions: None,
            },
            extensions: None,
        })],
        extensions: None,
    };
    let mut oracle = PreparedEncoder::new(options);
    oracle.begin(&input).unwrap();
    let expected: Vec<u8> = oracle.part(&input, 0).unwrap().chunks.flatten().collect();
    assert_eq!(actual, expected);
    let value: serde_json::Value = serde_json::from_slice(&actual).unwrap();
    assert_eq!(value["type"], "bash_code_execution_tool_result");
    assert_eq!(value["content"]["error_code"], "quota");
}

#[tokio::test]
async fn captured_media_matches_owned_sniffing_base64_and_lossy_text() {
    for (mime, data) in [
        ("image/*", b"\x89PNG\r\n\x1a\nraw-image".as_slice()),
        ("application/*", b"%PDF-1.7\nraw-pdf".as_slice()),
        ("text/plain", b"before\xff\xe4\xb8\xadafter".as_slice()),
    ] {
        let source = MessageRecipe::User {
            content: list(vec![ContentRecipe::Media {
                media: MediaSource {
                    bytes: SourceBytes::Source(Arc::new(SplitSource(Bytes::copy_from_slice(data)))),
                    media_type: raw(mime),
                    detail: None,
                },
                provider_options: None,
            }]),
            provider_options: None,
        };
        let compiler = Compiler::new(Arc::new(opts()), Language::En);
        let items = compiler.compile(source, Arc::new(Budget)).await.unwrap();
        let actual = bytes(&items[0]).await;
        let message = input::Message::User {
            parts: vec![input::UserPart::File(input::File {
                media_type: mime.into(),
                filename: None,
                source: input::FileSource::Inline(input::InlineData::Bytes(data.to_vec())),
                extensions: None,
            })],
            extensions: None,
        };
        let mut oracle = PreparedEncoder::new(opts());
        oracle.begin(&message).unwrap();
        let expected: Vec<u8> = oracle.part(&message, 0).unwrap().chunks.flatten().collect();
        assert_eq!(actual, expected, "MIME {mime}");
    }
}

#[tokio::test]
async fn message_cursor_emits_one_part_before_opening_later_bodies() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct FailedSource(Arc<AtomicUsize>);
    struct FailedCursor(Arc<AtomicUsize>);
    impl ByteSource for FailedSource {
        fn len(&self) -> Option<u64> {
            Some(8)
        }
        fn open(&self, _: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            Box::new(FailedCursor(self.0.clone()))
        }
    }
    impl ByteCursor for FailedCursor {
        fn read_chunk(&mut self, _: ChargedBuffer) -> ReadSource<'_> {
            Box::pin(async move {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::other("later body unavailable"))
            })
        }
    }
    let reads = Arc::new(AtomicUsize::new(0));
    let compiler = Compiler::new(Arc::new(opts()), Language::En);
    let mut cursor = compiler
        .open(
            MessageRecipe::User {
                content: list(vec![
                    ContentRecipe::Text {
                        text: raw("first"),
                        provider_options: None,
                    },
                    ContentRecipe::Text {
                        text: TextSource::new(
                            SourceBytes::Source(Arc::new(FailedSource(reads.clone()))),
                            TextEncoding::Utf8,
                        ),
                        provider_options: None,
                    },
                ]),
                provider_options: None,
            },
            Arc::new(Budget),
        )
        .await
        .unwrap();
    let first = cursor.next().await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes(&first).await).unwrap()["text"],
        "first"
    );
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "planning the first part never opens a later body"
    );
    assert!(cursor.next().await.is_err());
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn summary_media_allocation_bound_never_opens_blob_bodies() {
    struct NoBlob;
    impl ByteSource for NoBlob {
        fn len(&self) -> Option<u64> {
            None
        }
        fn open(&self, _: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            panic!("allocation-only fit bound opened a blob")
        }
    }
    let compiler = Compiler::new(Arc::new(opts()), Language::En);
    for mime in ["image/*", "application/*", "audio/unknown"] {
        let bound = compiler
            .count_user_part_bound(
                ContentRecipe::Media {
                    media: MediaSource {
                        bytes: SourceBytes::Source(Arc::new(NoBlob)),
                        media_type: raw(mime),
                        detail: None,
                    },
                    provider_options: None,
                },
                Arc::new(Budget),
            )
            .await
            .unwrap();
        assert!(bound.retained > 0);
        assert_eq!(bound.documents, usize::from(!mime.starts_with("audio/")));
    }
}
