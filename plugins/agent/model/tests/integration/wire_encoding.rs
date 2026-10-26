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
use maka_model::prompt::{AssistantPart, Message, WireGroup};
use maka_model::{PreparationContext, ProviderKind, WireEncoding};
use serde_json::{Value, json};

fn items(group: WireGroup) -> Vec<Value> {
    let mut items = Vec::new();
    let mut bytes = Vec::new();
    for chunk in group.chunks {
        let chunk = chunk.unwrap();
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

#[test]
fn captured_wire_encoding_replays_after_request_inputs_and_partial_cursor_are_dropped() {
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
        let context = PreparationContext::default();
        let mut partial = encoding
            .prepare_group(vec![Message::user("hello")], &context)
            .chunks;
        assert!(partial.next().unwrap().is_ok());
        drop(partial);
        for _ in 0..2 {
            let group = encoding.prepare_group(vec![Message::user("hello")], &context);
            assert_eq!(items(group), vec![expected.clone()]);
        }
    }
}

#[test]
fn captured_anthropic_wire_encoding_keeps_hosted_tool_alias_after_catalog_changes() {
    use maka_agent_facts::tools::ProviderTool;
    let mut input = request(ProviderKind::Anthropic, "http://localhost/v1".into());
    input.tools[0].name = "Research".into();
    input.tools[0].provider = Some(ProviderTool {
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
    input.tools[0].name = "Changed".into();
    input.tools[0].provider = None;
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
    for _ in 0..2 {
        assert_eq!(
            items(encoding.prepare_group(messages.clone(), &PreparationContext::default())),
            vec![
                json!({"type":"server_tool_use","id":"search-1","name":"web_search","input":{"query":"Maka"}})
            ]
        );
    }
}
