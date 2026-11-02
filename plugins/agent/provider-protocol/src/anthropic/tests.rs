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
