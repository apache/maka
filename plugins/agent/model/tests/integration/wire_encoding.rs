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
