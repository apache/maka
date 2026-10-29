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
use crate::input::{File, FileSource, ToolOutput};

fn extensions(value: Value) -> Extensions {
    Some(BTreeMap::from([("anthropic".into(), value)]))
}
fn stream_options() -> StreamOptions {
    StreamOptions {
        send_reasoning: true,
        cache_namespace: "anthropic".into(),
        tool_names: BTreeMap::new(),
        toolsets: BTreeMap::new(),
    }
}
fn text(text: &str) -> AssistantPart {
    AssistantPart::Text {
        text: text.into(),
        extensions: None,
    }
}
fn user(text: &str) -> Message {
    Message::User {
        parts: vec![UserPart::Text {
            text: text.into(),
            extensions: None,
        }],
        extensions: None,
    }
}
fn call(id: &str, name: &str, provider_executed: bool, ext: Value) -> AssistantPart {
    AssistantPart::ToolCall(ToolCall {
        id: id.into(),
        name: name.into(),
        input: json!({"query":id}),
        provider_executed,
        extensions: extensions(ext),
    })
}

fn compare(messages: &[Message]) -> (Metadata, Value) {
    let options = stream_options();
    let mut cache = CacheBudget::default();
    let batch = PreparedPrompt::encode(messages, options.borrowed(), &mut cache).unwrap();
    let (metadata, wire) = encode_prepared(messages, options);
    assert_eq!(metadata.features, batch.features);
    assert_eq!(metadata.warnings, batch.warnings);
    assert_eq!(metadata.cache.warnings(), cache.warnings());
    let expected = serde_json::to_value(batch).unwrap();
    assert_eq!(wire, expected);
    for (actual, expected) in wire["messages"]
        .as_array()
        .unwrap()
        .iter()
        .zip(expected["messages"].as_array().unwrap())
    {
        assert_eq!(
            serde_json::to_vec(&actual["content"]).unwrap(),
            serde_json::to_vec(&expected["content"]).unwrap()
        );
    }
    (metadata, wire)
}

#[test]
fn signed_boundaries_mcp_cross_message_ids_and_final_trim_match_exact_wire() {
    let messages = vec![
        user("start"),
        Message::Assistant {
            parts: vec![
                call("local-a", "lookup", false, json!({})),
                text("before"),
                AssistantPart::Reasoning {
                    text: "signed".into(),
                    extensions: extensions(json!({"signature":"sig"})),
                },
                call(
                    "remote",
                    "web_search",
                    true,
                    json!({"type":"mcp-tool-use","serverName":"remote-server"}),
                ),
                call("local-b", "lookup", false, json!({})),
            ],
            extensions: None,
        },
        Message::Assistant {
            parts: vec![
                AssistantPart::ToolResult(ToolResult {
                    id: "remote".into(),
                    name: "web_search".into(),
                    output: ToolOutput {
                        value: ToolValue::Json(json!({"opaque":"kept"})),
                        extensions: None,
                    },
                    extensions: None,
                }),
                AssistantPart::Custom {
                    kind: "anthropic.fallback".into(),
                    extensions: extensions(json!({"from":{"model":"old"},"to":{"model":"new"}})),
                },
                call("local-c", "lookup", false, json!({})),
                text(" final  "),
            ],
            extensions: None,
        },
    ];
    let (_, wire) = compare(&messages);
    let content = wire["messages"][1]["content"].as_array().unwrap();
    assert_eq!(
        content
            .iter()
            .map(|part| part["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "text",
            "tool_use",
            "thinking",
            "mcp_tool_use",
            "mcp_tool_result",
            "tool_use",
            "fallback",
            "text",
            "tool_use"
        ]
    );
    assert_eq!(content[4]["content"], json!({"opaque":"kept"}));
    assert_eq!(content[7]["text"], "final");
}

#[test]
fn system_selection_caller_pruning_and_citation_metadata_match_batch() {
    let messages = vec![
        Message::Assistant {
            parts: vec![
                call(
                    "missing",
                    "lookup",
                    false,
                    json!({"caller":{"type":"code_execution_20260120","toolId":"absent"}}),
                ),
                call(
                    "kept",
                    "lookup",
                    false,
                    json!({"caller":{"type":"code_execution_20260120","toolId":"later"}}),
                ),
            ],
            extensions: None,
        },
        Message::System {
            text: "late top-level".into(),
            extensions: None,
        },
        Message::System {
            text: "also top-level".into(),
            extensions: None,
        },
        Message::User {
            parts: vec![UserPart::File(File {
                media_type: "text/plain".into(),
                filename: Some("source.txt".into()),
                source: FileSource::Text("body".into()),
                extensions: extensions(json!({"citations":{"enabled":true}})),
            })],
            extensions: None,
        },
        Message::System {
            text: "mid".into(),
            extensions: extensions(json!({"clearAt":"next_user_message"})),
        },
        Message::System {
            text: String::new(),
            extensions: extensions(json!({"effort":"high"})),
        },
        Message::Assistant {
            parts: vec![call("later", "code_execution", true, json!({}))],
            extensions: None,
        },
    ];
    let (metadata, wire) = compare(&messages);
    assert_eq!(metadata.context.top_system(), Some(1..3));
    assert_eq!(metadata.documents.len(), 1);
    assert_eq!(metadata.documents[0].title, "source.txt");
    assert!(wire["messages"][0]["content"][0].get("caller").is_none());
    assert_eq!(
        wire["messages"][0]["content"][1]["caller"]["tool_id"],
        "later"
    );
    assert_eq!(wire["system"].as_array().unwrap().len(), 2);
    assert_eq!(wire["messages"][2]["clear_at"], "next_user_message");
    assert_eq!(wire["messages"][3]["output_config"]["effort"], "high");
}

#[test]
fn prepared_cache_reservations_match_batch_across_messages() {
    let cached = || extensions(json!({"cacheControl":{"type":"ephemeral"}}));
    let messages = vec![
        Message::System {
            text: "system".into(),
            extensions: cached(),
        },
        user("hi"),
        Message::Assistant {
            parts: vec![
                AssistantPart::ToolCall(ToolCall {
                    id: "a".into(),
                    name: "lookup".into(),
                    input: json!({}),
                    provider_executed: false,
                    extensions: cached(),
                }),
                AssistantPart::Text {
                    text: "text".into(),
                    extensions: cached(),
                },
                AssistantPart::Reasoning {
                    text: "signed".into(),
                    extensions: extensions(
                        json!({"signature":"signature","cacheControl":{"type":"ephemeral"}}),
                    ),
                },
                AssistantPart::Text {
                    text: "last".into(),
                    extensions: cached(),
                },
            ],
            extensions: None,
        },
    ];
    let (metadata, _) = compare(&messages);
    assert!(
        metadata
            .cache
            .warnings()
            .iter()
            .any(|warning| matches!(warning, super::super::super::Warning::CacheLimit { .. }))
    );
}

#[test]
fn initial_effort_only_and_later_controlled_system_groups_keep_headers_and_cache() {
    compare(&[
        Message::System {
            text: String::new(),
            extensions: extensions(json!({"effort":"high"})),
        },
        Message::System {
            text: "root".into(),
            extensions: extensions(
                json!({"toolChanges":[{"type":"tool_addition","toolName":"x"}]}),
            ),
        },
        user("question"),
        Message::System {
            text: "plain".into(),
            extensions: None,
        },
        Message::System {
            text: String::new(),
            extensions: extensions(json!({"toolChanges":[{"type":"tool_removal","toolName":"x"}]})),
        },
    ]);
    compare(&[
        user("question"),
        Message::System {
            text: "plain".into(),
            extensions: None,
        },
        Message::System {
            text: String::new(),
            extensions: extensions(json!({"effort":"medium"})),
        },
    ]);
}

fn encode_prepared(messages: &[Message], options: StreamOptions) -> (Metadata, Value) {
    use super::prepared::*;
    let mut dirty = PreparedEncoder::new(options);
    let mut rows = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        for part in 0..dirty.begin(message).unwrap() {
            let prepared = dirty.part(message, part).unwrap();
            let metadata = serde_json::from_value::<PartMetadata>(
                serde_json::to_value(&prepared.metadata).unwrap(),
            )
            .unwrap();
            rows.push((index, metadata, prepared.chunks.collect::<Vec<_>>()));
        }
    }
    let mut preflight = MetadataPrepass::default();
    for (index, metadata, _) in &rows {
        preflight.push(*index, metadata).unwrap();
    }
    let metadata = preflight.finish();
    let mut replay = Replay::new(metadata.context.clone());
    let mut output = json!({"messages":[]});
    if metadata.context.has_system() {
        output["system"] = json!([]);
    }
    let mut active: Option<(usize, Value, Vec<Value>)> = None;
    let mut info = None;
    fn flush(active: &mut Option<(usize, Value, Vec<Value>)>, output: &mut Value) {
        let Some((_, mut header, mut blocks)) = active.take() else {
            return;
        };
        if header["role"] == "assistant" {
            if blocks.is_empty() {
                return;
            }
            for segment in blocks.split_mut(|block| {
                matches!(
                    block["type"].as_str(),
                    Some("thinking" | "redacted_thinking" | "fallback")
                )
            }) {
                segment.sort_by_key(|block| block["type"] == "tool_use");
            }
        }
        header["content"] = json!(blocks);
        output["messages"].as_array_mut().unwrap().push(header);
    }
    for (index, metadata, chunks) in &rows {
        if metadata.part_index == 0 {
            let next = replay.begin(*index, &metadata.message);
            if active
                .as_ref()
                .is_some_and(|(group, _, _)| *group != next.group)
            {
                flush(&mut active, &mut output);
            }
            if next.emit_message && active.is_none() {
                active = Some((next.group, next.header.clone(), Vec::new()));
            }
            info = Some(next);
        }
        let info = info.as_ref().unwrap();
        let decision = replay.part(metadata, Selection::All).unwrap();
        if !decision.emit {
            continue;
        }
        let mut overlay = Overlay::new(metadata, &decision);
        let mut bytes = Vec::new();
        for chunk in chunks {
            bytes.extend(overlay.push(chunk));
        }
        overlay.finish().unwrap();
        let block = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(
            serde_json::to_vec(&block).unwrap(),
            bytes,
            "overlay preserves encoded field order"
        );
        if info.top_level_system {
            output["system"].as_array_mut().unwrap().push(block);
        } else {
            active.as_mut().unwrap().2.push(block);
        }
    }
    flush(&mut active, &mut output);
    (metadata, output)
}

#[test]
fn persisted_fragment_metadata_does_not_retain_giant_text_and_overlay_trims_incrementally() {
    use super::prepared::*;
    let message = Message::Assistant {
        parts: vec![AssistantPart::Text {
            text: format!("  {} \n", "中\n\"".repeat(300_000)),
            extensions: extensions(
                json!({"cacheControl":{"type":"ephemeral"},"citations":[{"x":1}]}),
            ),
        }],
        extensions: None,
    };
    let mut dirty = PreparedEncoder::new(stream_options());
    dirty.begin(&message).unwrap();
    let part = dirty.part(&message, 0).unwrap();
    assert!(serde_json::to_vec(&part.metadata).unwrap().len() < 2048);
    let mut preflight = MetadataPrepass::default();
    preflight.push(0, &part.metadata).unwrap();
    let mut replay = Replay::new(preflight.finish().context);
    replay.begin(0, &part.metadata.message);
    let decision = replay.part(&part.metadata, Selection::Normal).unwrap();
    let mut overlay = Overlay::new(&part.metadata, &decision);
    let mut bytes = Vec::new();
    let mut chunks = 0;
    for chunk in part.chunks {
        assert!(chunk.len() <= 16 * 1024);
        bytes.extend(overlay.push(&chunk));
        chunks += 1;
    }
    overlay.finish().unwrap();
    assert!(chunks > 100);
    let actual = serde_json::from_slice::<Value>(&bytes).unwrap();
    let Message::Assistant { parts, .. } = message else {
        unreachable!()
    };
    let AssistantPart::Text { text, .. } = &parts[0] else {
        unreachable!()
    };
    assert_eq!(actual["text"], text.trim());
    assert_eq!(actual["cache_control"], json!({"type":"ephemeral"}));
}

#[test]
fn indexed_mcp_dependency_seeds_a_dirty_append_without_old_body() {
    use super::prepared::*;
    let earlier = Message::Assistant {
        parts: vec![call(
            "mcp",
            "web_search",
            true,
            json!({"type":"mcp-tool-use","serverName":"remote"}),
        )],
        extensions: None,
    };
    let mut first = PreparedEncoder::new(stream_options());
    first.begin(&earlier).unwrap();
    let first = first.part(&earlier, 0).unwrap();
    // The store answers only the new result's ID dependency from its index.
    let seed = first.metadata.mcp_id.clone().unwrap();
    drop(first);
    drop(earlier);
    let result = Message::Assistant {
        parts: vec![AssistantPart::ToolResult(ToolResult {
            id: "mcp".into(),
            name: "web_search".into(),
            output: ToolOutput {
                value: ToolValue::Json(json!({"opaque":"unchanged"})),
                extensions: None,
            },
            extensions: None,
        })],
        extensions: None,
    };
    let mut dirty = PreparedEncoder::new(stream_options());
    dirty.seed_assistant_mcp([seed]);
    dirty.begin(&result).unwrap();
    let prepared = dirty.part(&result, 0).unwrap();
    let wire =
        serde_json::from_slice::<Value>(&prepared.chunks.flatten().collect::<Vec<_>>()).unwrap();
    assert_eq!(wire["type"], "mcp_tool_result");
    assert_eq!(wire["content"], json!({"opaque":"unchanged"}));
}

#[test]
fn metadata_preparation_preserves_prompt_before_tools_cache_and_request_fields() {
    use crate::anthropic::{FunctionTool, Tool, request};
    fn input(messages: &[Message]) -> request::Request<'_> {
        request::Request {
            model: "claude-sonnet-4-5".into(),
            messages,
            tools: ["first", "second"]
                .into_iter()
                .map(|name| request::ToolBinding {
                    name: name.into(),
                    definition: Tool::Function(FunctionTool {
                        name: name.into(),
                        description: None,
                        input_schema: json!({"type":"object"}),
                        cache_control: Some(CacheDirective::Ephemeral { ttl: None }),
                        strict: None,
                        defer_loading: None,
                        eager_input_streaming: None,
                        allowed_callers: None,
                        input_examples: None,
                    }),
                })
                .collect(),
            choice: None,
            sampling: Default::default(),
            reasoning: request::Reasoning::ProviderDefault,
            format: request::Format::Text,
            options: Default::default(),
            custom_namespace_used: false,
            streaming: true,
            header_betas: vec![],
        }
    }
    let cached = || extensions(json!({"cacheControl":{"type":"ephemeral"}}));
    let messages = vec![
        Message::System {
            text: "system".into(),
            extensions: cached(),
        },
        Message::User {
            parts: vec![
                UserPart::Text {
                    text: "one".into(),
                    extensions: cached(),
                },
                UserPart::Text {
                    text: "two".into(),
                    extensions: cached(),
                },
            ],
            extensions: None,
        },
    ];
    let config = request::Config::default();
    let batch = request::prepare(input(&messages), &config).unwrap();
    let (metadata, wire) =
        encode_prepared(&messages, StreamOptions::from_request(&input(&[]), &config));
    let streamed = request::prepare_streaming(input(&[]), &config, metadata).unwrap();
    assert_eq!(
        format!("{:?}", batch.diagnostics),
        format!("{:?}", streamed.diagnostics)
    );
    assert_eq!(batch.betas, streamed.betas);
    let mut actual = serde_json::to_value(&streamed.body).unwrap();
    for (key, value) in wire.as_object().unwrap() {
        actual[key] = value.clone();
    }
    assert_eq!(actual, serde_json::to_value(&batch.body).unwrap());
    assert_eq!(
        actual["tools"][0]["cache_control"],
        json!({"type":"ephemeral"})
    );
    assert!(actual["tools"][1].get("cache_control").is_none());
}
