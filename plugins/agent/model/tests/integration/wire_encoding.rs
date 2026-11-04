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

use super::provider_stream::request;
use maka_agent_facts::model::ToolInput;
use maka_model::prompt::{AssistantPart, Message};
use maka_model::{FrozenWire, ProviderKind, WireEncoding};
use serde_json::{Value, json};
use std::sync::Arc;

async fn items(wire: &FrozenWire) -> Vec<Value> {
    let mut cursor = wire.source.open(0);
    let mut items = Vec::new();
    let mut bytes = Vec::new();
    while let Some(chunk) = cursor.next().await.unwrap() {
        if chunk.bytes.is_empty() {
            continue;
        }
        if chunk.item_start {
            assert!(bytes.is_empty());
        }
        bytes.extend_from_slice(&chunk.bytes);
        if chunk.item_end {
            items.push(serde_json::from_slice(&bytes).unwrap());
            bytes.clear();
        }
    }
    assert!(bytes.is_empty());
    items
}

#[tokio::test]
async fn captured_wire_encoding_replays_after_request_inputs_and_partial_cursor_are_dropped() {
    for (kind, expected) in [
        (
            ProviderKind::OpenaiChatCompletions,
            json!({"role":"user","content":"hello"}),
        ),
        (
            ProviderKind::OpenaiResponses,
            json!({"role":"user","content":[{"type":"input_text","text":"hello"}]}),
        ),
        (
            ProviderKind::Anthropic,
            json!({"type":"text","text":"hello"}),
        ),
    ] {
        let input = request(kind, "http://localhost/v1".into());
        let encoding = WireEncoding::new(
            input.language,
            &input.provider,
            &input.provider_options,
            &input.tools,
        )
        .unwrap();
        drop(input);
        let wire=encoding.prepare_source(Arc::new(maka_agent_facts::model::prompt_source::source::generated::GeneratedMessages::new(&[Message::user("hello")])),resources()).await.unwrap();
        let mut partial = wire.source.open(0);
        assert!(partial.next().await.unwrap().is_some());
        drop(partial);
        for _ in 0..2 {
            assert_eq!(items(&wire).await, vec![expected.clone()]);
        }
    }
}

#[tokio::test]
async fn captured_anthropic_wire_encoding_keeps_hosted_tool_alias_after_catalog_changes() {
    use maka_agent_facts::tools::ProviderTool;
    let mut input = request(ProviderKind::Anthropic, "http://localhost/v1".into());
    Arc::make_mut(&mut input.tools[0]).name = "Research".into();
    Arc::make_mut(&mut input.tools[0]).provider = Some(ProviderTool {
        id: "anthropic.web_search_20250305".into(),
        args: json!({"maxUses":8}),
    });
    let encoding = WireEncoding::new(
        input.language,
        &input.provider,
        &input.provider_options,
        &input.tools,
    )
    .unwrap();
    Arc::make_mut(&mut input.tools[0]).name = "Changed".into();
    Arc::make_mut(&mut input.tools[0]).provider = None;
    drop(input);
    let messages = vec![Message::Assistant {
        content: vec![AssistantPart::ToolCall {
            tool_call_id: "search-1".into(),
            tool_name: "Research".into(),
            input: ToolInput::Json(json!({"query":"Maka"})),
            provider_executed: Some(true),
            provider_options: None,
        }],
        provider_options: None,
    }];
    let wire = encoding
        .prepare_source(
            Arc::new(
                maka_agent_facts::model::prompt_source::source::generated::GeneratedMessages::new(
                    &messages,
                ),
            ),
            resources(),
        )
        .await
        .unwrap();
    for _ in 0..2 {
        assert_eq!(
            items(&wire).await,
            vec![
                json!({"type":"server_tool_use","id":"search-1","name":"web_search","input":{"query":"Maka"}})
            ]
        );
    }
}

fn resources() -> maka_model::ModelPreparationResources {
    maka_model::ModelPreparationResources::new(maka_model::PreparationPolicy {
        staging_bytes: 8 * 1024 * 1024,
        resident_bytes: 8 * 1024 * 1024,
        progress_bytes: 256 * 1024,
        work_bytes: 256 * 1024,
    })
    .unwrap()
}

#[tokio::test]
async fn notifications_keep_all_output_formats_without_a_second_provider_receipt() {
    use maka_model::prompt::{ContentPart, FileData, ToolOutput};
    const IMAGE: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==";
    fn strings(value: &Value, output: &mut Vec<String>) {
        match value {
            Value::String(value) => output.push(value.clone()),
            Value::Array(values) => {
                for value in values {
                    strings(value, output);
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    strings(value, output);
                }
            }
            _ => {}
        }
    }
    for kind in [
        ProviderKind::OpenaiChatCompletions,
        ProviderKind::OpenaiResponses,
        ProviderKind::Anthropic,
    ] {
        for custom in [false, true] {
            if custom && !matches!(&kind, ProviderKind::OpenaiResponses) {
                continue;
            }
            let input = request(kind.clone(), "http://localhost/v1".into());
            let options = custom.then(|| json!({"openai":{"toolKind":"custom"}}));
            let mut messages = vec![Message::Assistant {
                content: vec![AssistantPart::ToolCall {
                    tool_call_id: "call-1".into(),
                    tool_name: "exec".into(),
                    input: if custom {
                        ToolInput::Json(json!("text('start')"))
                    } else {
                        ToolInput::Json(json!({}))
                    },
                    provider_executed: None,
                    provider_options: options.clone(),
                }],
                provider_options: None,
            }];
            let outputs = [
                ToolOutput::Text("running receipt".into()),
                ToolOutput::Text("late text 原文".into()),
                ToolOutput::ErrorText("late failure 原因".into()),
                ToolOutput::Json(json!({"result":"完整", "values":[1,2,3]})),
                ToolOutput::ErrorJson(json!({"problem":"错误", "partial":[4,5]})),
                ToolOutput::Content(vec![
                    ContentPart::text("media caption"),
                    ContentPart::File {
                        data: FileData::Data(IMAGE.into()),
                        media_type: "image/png".into(),
                        provider_options: None,
                    },
                ]),
            ];
            for (index, output) in outputs.into_iter().enumerate() {
                let mut message = Message::tool("call-1", "exec", output);
                let Message::Tool { content, .. } = &mut message else {
                    unreachable!()
                };
                content[0].provider_options = Some(
                    json!({"openai":{"toolKind":if custom {"custom"} else {"function"}}, "maka":{"notification": index != 0}}),
                );
                messages.push(message);
            }
            let encoding = WireEncoding::new(
                input.language,
                &input.provider,
                &input.provider_options,
                &input.tools,
            )
            .unwrap();
            let wire = encoding.prepare_source(Arc::new(maka_agent_facts::model::prompt_source::source::generated::GeneratedMessages::new(&messages)), resources()).await.unwrap();
            let encoded = items(&wire).await;
            let receipts = encoded
                .iter()
                .filter(|item| match &kind {
                    ProviderKind::OpenaiChatCompletions => item["role"] == "tool",
                    ProviderKind::OpenaiResponses => matches!(
                        item["type"].as_str(),
                        Some("custom_tool_call_output" | "function_call_output")
                    ),
                    ProviderKind::Anthropic => item["type"] == "tool_result",
                    _ => unreachable!(),
                })
                .count();
            assert_eq!(receipts, 1, "one output receipt per call: {encoded:?}");
            let mut values = Vec::new();
            strings(&Value::Array(encoded), &mut values);
            let text = values.join("\n");
            for expected in [
                "late text 原文",
                "late failure 原因",
                "Error: ",
                "media caption",
                IMAGE,
            ] {
                assert!(
                    text.contains(expected),
                    "notification lost {expected:?}: {text}"
                );
            }
            for expected in [
                json!({"result":"完整", "values":[1,2,3]}),
                json!({"problem":"错误", "partial":[4,5]}),
            ] {
                assert!(
                    values.iter().any(|text| serde_json::from_str::<Value>(
                        text.strip_prefix("Error: ").unwrap_or(text)
                    )
                    .is_ok_and(|value| value == expected)),
                    "notification lost JSON value {expected}: {text}"
                );
            }
        }
    }
}

#[test]
fn default_chat_codec_preserves_the_legacy_identity() {
    let input = request(
        ProviderKind::OpenaiChatCompletions,
        "http://localhost/v1".into(),
    );
    let encoding = WireEncoding::new(
        input.language,
        &input.provider,
        &input.provider_options,
        &input.tools,
    )
    .unwrap();
    assert_eq!(
        encoding.codec(),
        r#"{"codec":"maka.chat-items.v1","language":"en","namespace":"openai","metadataNamespace":"openai","multipartToolContent":false}"#
    );
    let reasoning = WireEncoding::new(
        input.language,
        &input.provider,
        &json!({"maka":{"openAiChatReasoningField":"reasoning"}}),
        &input.tools,
    )
    .unwrap();
    assert_ne!(encoding.codec(), reasoning.codec());
}

#[tokio::test]
async fn generated_chat_reasoning_uses_the_selected_field() {
    use maka_provider_protocol::{
        chat_completions::request as chat, input as wire, output::ReasoningField,
    };
    for (field, expected) in [
        (
            ReasoningField::Content,
            json!({"role":"assistant","content":"reply","reasoning_content":"思考"}),
        ),
        (
            ReasoningField::Reasoning,
            json!({"role":"assistant","content":"reply","reasoning":"思考"}),
        ),
    ] {
        let mut input = request(
            ProviderKind::OpenaiCompatible {
                name: "ollama-cloud".into(),
            },
            "http://localhost/v1".into(),
        );
        input.provider_options = json!({"maka":{"openAiChatReasoningField":field}});
        let encoding = WireEncoding::new(
            input.language,
            &input.provider,
            &input.provider_options,
            &input.tools,
        )
        .unwrap();
        let messages = vec![Message::Assistant {
            content: vec![
                AssistantPart::Reasoning {
                    text: "思考".into(),
                    provider_options: None,
                },
                AssistantPart::Text {
                    text: "reply".into(),
                    provider_options: None,
                },
            ],
            provider_options: None,
        }];
        drop(input);
        let frozen = encoding.prepare_source(Arc::new(maka_agent_facts::model::prompt_source::source::generated::GeneratedMessages::new(&messages)), resources()).await.unwrap();
        assert_eq!(items(&frozen).await, vec![expected.clone()]);
        let direct = chat::messages(
            &[wire::Message::Assistant {
                parts: vec![
                    wire::AssistantPart::Reasoning {
                        text: "思考".into(),
                        extensions: None,
                    },
                    wire::AssistantPart::Text {
                        text: "reply".into(),
                        extensions: None,
                    },
                ],
                extensions: None,
            }],
            &chat::PromptOptions {
                provider_namespace: "ollama-cloud".into(),
                metadata_namespace: "ollamaCloud".into(),
                multipart_tool_content: false,
                reasoning_field: field,
            },
        )
        .unwrap();
        assert_eq!(direct, vec![expected]);
    }
}
