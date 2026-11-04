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
use serde_json::json;

#[test]
fn mcp_replay_preserves_opaque_results_without_unsupported_warnings() {
    use super::prompt::{PreparedPrompt, PromptOptions};
    use crate::input::{AssistantPart, Message, ToolCall, ToolOutput, ToolResult, ToolValue};
    use std::collections::BTreeMap;

    for is_error in [false, true] {
        // A hosted-tool spelling must not reinterpret an MCP server's payload.
        let payload = json!({"errorCode":"opaque", "content":[{"type":"text","text":"answer"}]});
        let messages = [Message::Assistant {
            parts: vec![
                AssistantPart::ToolCall(ToolCall {
                    id: "remote-1".into(),
                    name: "web_search".into(),
                    input: json!({"q":"native"}),
                    provider_executed: true,
                    extensions: Some(BTreeMap::from([(
                        "anthropic".into(),
                        json!({"type":"mcp-tool-use","serverName":"research"}),
                    )])),
                }),
                AssistantPart::ToolResult(ToolResult {
                    id: "remote-1".into(),
                    name: "web_search".into(),
                    output: ToolOutput {
                        value: if is_error {
                            ToolValue::ErrorJson(payload.clone())
                        } else {
                            ToolValue::Json(payload.clone())
                        },
                        extensions: None,
                    },
                    extensions: None,
                }),
            ],
            extensions: None,
        }];
        let names = BTreeMap::new();
        let mut cache = CacheBudget::default();
        let prompt = PreparedPrompt::encode(
            &messages,
            PromptOptions {
                send_reasoning: true,
                cache_namespace: "anthropic",
                tool_names: &names,
                toolsets: &names,
            },
            &mut cache,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&prompt).unwrap(),
            json!({"messages":[{
                "role":"assistant","content":[
                    {"type":"mcp_tool_use","id":"remote-1","name":"web_search","input":{"q":"native"},"server_name":"research"},
                    {"type":"mcp_tool_result","tool_use_id":"remote-1","content":payload,"is_error":is_error}
                ]
            }]})
        );
        assert!(prompt.warnings.is_empty());
        assert!(cache.warnings().is_empty());
    }
}

#[test]
fn fallback_usage_excludes_the_failed_primary_and_advisor() {
    let usage: Usage = serde_json::from_value(json!({
        "input_tokens":80,"output_tokens":11,"cache_read_input_tokens":4,
        "cache_creation_input_tokens":2,"output_tokens_details":{"thinking_tokens":3},
        "iterations":[
            {"type":"message","input_tokens":900,"output_tokens":0},
            {"type":"fallback_message","input_tokens":80,"output_tokens":11},
            {"type":"advisor_message","input_tokens":50,"output_tokens":5}
        ]
    }))
    .unwrap();
    assert_eq!(
        usage.totals().unwrap(),
        TokenCounts {
            input: 86,
            uncached_input: 80,
            cache_read: 4,
            cache_write: 2,
            output: 11,
            reasoning: Some(3)
        }
    );
}

#[test]
fn response_sources_follow_documents_and_search_results_without_losing_citations() {
    use crate::output::{Part, Source, Stop};
    let raw = json!({"type":"message","id":"reply-1","model":"model-1","usage":{"input_tokens":7,"output_tokens":2},"stop_reason":"end_turn","content":[
        {"type":"web_fetch_tool_result","tool_use_id":"fetch-1","content":{"type":"web_fetch_result","url":"https://example.org/document","retrieved_at":null,"content":{"type":"document","title":null,"source":{"type":"text","media_type":"text/plain","data":"evidence"}}}},
        {"type":"text","text":"answer","citations":[
            {"type":"char_location","cited_text":"evidence","document_index":0,"document_title":null,"start_char_index":0,"end_char_index":8},
            {"type":"web_search_result_location","cited_text":"answer","url":"https://example.org/search","title":null,"encrypted_index":"citation-1"}
        ]},
        {"type":"web_search_tool_result","tool_use_id":"search-1","content":[{"type":"web_search_result","url":"https://example.org/search","title":null,"encrypted_content":"opaque"}]}
    ]});
    let mut ids = 0;
    let decoded = response::decode(
        raw.to_string().as_bytes(),
        response::Options::default(),
        &mut || {
            ids += 1;
            format!("source-{ids}")
        },
    )
    .unwrap();
    assert_eq!(decoded.finish.reason, Stop::Stop);
    assert_eq!(
        ids, 2,
        "search results suppress duplicate standalone web citations"
    );
    let Part::Text { citations, .. } = &decoded.parts[1] else {
        panic!("text after fetched result")
    };
    assert_eq!(
        citations.len(),
        2,
        "attachments survive standalone source suppression"
    );
    assert!(
        matches!(&citations[0].source, Source::Document { id, title, .. } if id == "0" && title == "https://example.org/document")
    );
    assert!(
        matches!(&decoded.parts[2], Part::Source(Source::Document { id, .. }) if id == "source-1")
    );
    assert!(matches!(&decoded.parts[4], Part::Source(Source::Url { id, .. }) if id == "source-2"));
}

#[test]
fn stream_eof_reuses_only_completed_accounting_and_spliced_messages_latch() {
    use crate::output::{Event, Stop};
    fn feed(stream: &mut stream::Stream, value: serde_json::Value) -> Vec<Event> {
        stream.value(value, &mut || "unused".into())
    }
    let mut stream = stream::Stream::new(response::Options::default());
    feed(
        &mut stream,
        json!({"type":"message_start","message":{"id":"one","usage":{"input_tokens":3}}}),
    );
    feed(
        &mut stream,
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}),
    );
    feed(&mut stream, json!({"type":"message_stop"}));
    feed(
        &mut stream,
        json!({"type":"message_start","message":{"id":"two","usage":{"input_tokens":99}}}),
    );
    feed(
        &mut stream,
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
    );
    feed(
        &mut stream,
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}),
    );
    let events = stream.finish();
    let [Event::Finish(finish)] = events.as_slice() else {
        panic!("interrupted finish")
    };
    assert_eq!(finish.reason, Stop::Interrupted);
    assert_eq!(finish.usage.as_ref().unwrap().input, Some(3));
    assert_eq!(finish.usage.as_ref().unwrap().output, Some(4));
    assert!(stream.finish().is_empty());

    let mut stream = stream::Stream::new(response::Options::default());
    let start = json!({"type":"message_start","message":{"id":"one","usage":{"input_tokens":3}}});
    feed(&mut stream, start.clone());
    assert!(
        feed(&mut stream, start).is_empty(),
        "duplicate start is idempotent"
    );
    let events = feed(
        &mut stream,
        json!({"type":"message_start","message":{"id":"other","usage":{"input_tokens":7}}}),
    );
    assert!(matches!(
        events.as_slice(),
        [Event::Error(Error::InvalidResponse { .. })]
    ));
    assert!(feed(&mut stream, json!({"type":"message_stop"})).is_empty());
    assert!(stream.finish().is_empty());
}

#[test]
fn tool_schemas_reach_the_model_with_local_refs_inlined() {
    use schema::inline_refs;
    let directory = json!({"type": "object", "properties": {"rootId": {"type": "string"}}});
    let schema = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "workspace": {"$ref": "#/$defs/Workspace"},
            "backup": {"$ref": "#/$defs/Directory", "description": "Optional copy."},
            "literal": {"const": {"$ref": "#/$defs/Directory"}},
            "$ref": {"type": "string"},
        },
        "$defs": {
            "Workspace": {"oneOf": [
                {"type": "object", "properties": {"kind": {"const": "directory"}, "selection": {"$ref": "#/$defs/Directory"}}},
            ]},
            "Directory": directory,
        },
    });
    let inlined = inline_refs(schema);
    assert_eq!(
        inlined["properties"]["workspace"]["oneOf"][0]["properties"]["selection"],
        directory
    );
    let mut backup = directory.clone();
    backup["description"] = json!("Optional copy.");
    assert_eq!(inlined["properties"]["backup"], backup);
    assert_eq!(
        inlined["properties"]["literal"],
        json!({"const": {"$ref": "#/$defs/Directory"}})
    );
    assert_eq!(inlined["properties"]["$ref"], json!({"type": "string"}));
    assert!(inlined.get("$defs").is_none());
    assert_eq!(
        inlined["$schema"],
        json!("https://json-schema.org/draft/2020-12/schema")
    );

    // A colliding sibling keeps both constraints.
    let narrowed = inline_refs(json!({
        "properties": {"name": {"$ref": "#/$defs/Name", "maxLength": 8}},
        "$defs": {"Name": {"type": "string", "maxLength": 64}},
    }));
    assert_eq!(
        narrowed["properties"]["name"],
        json!({"maxLength": 8, "allOf": [{"type": "string", "maxLength": 64}]})
    );

    // Annotations describe rather than constrain, so the field's own wins.
    let described = inline_refs(json!({
        "properties": {"scope": {"$ref": "#/$defs/Scope", "description": "Which sessions.", "default": "all"}},
        "$defs": {"Scope": {"description": "A session filter.", "oneOf": [{"type": "object"}]}},
    }));
    assert_eq!(
        described["properties"]["scope"],
        json!({"description": "Which sessions.", "oneOf": [{"type": "object"}], "default": "all"})
    );

    // A sibling that reads its neighbours stays apart from the target's.
    let closed = inline_refs(json!({
        "properties": {"item": {"$ref": "#/$defs/Item", "additionalProperties": false}},
        "$defs": {"Item": {"properties": {"id": {"type": "string"}}}},
    }));
    assert_eq!(
        closed["properties"]["item"],
        json!({"additionalProperties": false, "allOf": [{"properties": {"id": {"type": "string"}}}]})
    );
}

#[test]
fn references_that_cannot_be_inlined_keep_their_definitions() {
    use schema::inline_refs;
    let recursive = json!({
        "type": "object",
        "properties": {"tree": {"$ref": "#/$defs/Node"}},
        "$defs": {"Node": {
            "type": "object",
            "properties": {"children": {"type": "array", "items": {"$ref": "#/$defs/Node"}}},
        }},
    });
    let inlined = inline_refs(recursive.clone());
    assert_eq!(
        inlined["properties"]["tree"]["properties"]["children"]["items"],
        json!({"$ref": "#/$defs/Node"})
    );
    assert_eq!(inlined["$defs"], recursive["$defs"]);

    let external = json!({
        "properties": {"a": {"$ref": "https://example.com/a.json"}, "b": {"$ref": "#/$defs/B"}},
        "$defs": {"B": {"type": "string"}},
    });
    let inlined = inline_refs(external.clone());
    assert_eq!(inlined["properties"]["a"], external["properties"]["a"]);
    assert_eq!(inlined["properties"]["b"], json!({"type": "string"}));
    assert_eq!(inlined["$defs"], external["$defs"]);

    // A keyword this expansion does not walk keeps its reference resolvable.
    let unwalked = json!({
        "properties": {"b": {"$ref": "#/$defs/B"}},
        "dependencies": {"b": {"properties": {"c": {"$ref": "#/$defs/B"}}}},
        "$defs": {"B": {"type": "string"}},
    });
    let inlined = inline_refs(unwalked.clone());
    assert_eq!(inlined["dependencies"], unwalked["dependencies"]);
    assert_eq!(inlined["$defs"], unwalked["$defs"]);

    let inlined = inline_refs(external.clone());
    assert_eq!(inlined["properties"]["a"], external["properties"]["a"]);
    assert_eq!(inlined["properties"]["b"], json!({"type": "string"}));
    assert_eq!(inlined["$defs"], external["$defs"]);

    // Definitions that multiply past the bound leave the schema unchanged.
    let mut defs = serde_json::Map::new();
    defs.insert("L0".into(), json!({"type": "string"}));
    for level in 1..20 {
        let below = format!("#/$defs/L{}", level - 1);
        defs.insert(
            format!("L{level}"),
            json!({"type": "array", "prefixItems": [{"$ref": below}, {"$ref": below}]}),
        );
    }
    let exploding = json!({"properties": {"x": {"$ref": "#/$defs/L19"}}, "$defs": defs});
    assert_eq!(inline_refs(exploding.clone()), exploding);
}

#[test]
fn prepared_function_tools_carry_inlined_schemas() {
    let tool = Tool::Function(FunctionTool {
        name: "SessionCreate".into(),
        description: None,
        input_schema: json!({
            "type": "object",
            "properties": {"workspace": {"$ref": "#/$defs/Workspace"}},
            "$defs": {"Workspace": {"type": "object"}},
        }),
        cache_control: None,
        strict: None,
        defer_loading: None,
        eager_input_streaming: None,
        allowed_callers: None,
        input_examples: None,
    });
    let prepared = PreparedTools::build(
        [tool],
        None,
        None,
        ToolPolicy::default(),
        &mut CacheBudget::default(),
    );
    let PreparedTool::Function(tool) = &prepared.tools[0] else {
        panic!("function tool expected");
    };
    assert_eq!(
        tool.input_schema,
        json!({"type": "object", "properties": {"workspace": {"type": "object"}}})
    );
}
