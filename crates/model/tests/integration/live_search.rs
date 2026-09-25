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

use maka_model::{
    Conversation, ModelExecutor, ModelRequest, ProviderAuth, ProviderConfig, ProviderKind,
    StepBuilder,
};
use maka_runtime::{
    model::{ModelPart, ModelSource},
    tools::{ProviderTool, ToolDefinition},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit MAKA_SGLANG_TEST_URL and authorized deepseek-v4.1-flash access"]
async fn sglang_protocols_preserve_reasoning_tools_and_replay() {
    use maka_model::prompt::{AssistantPart, Message, ToolOutput};
    use maka_runtime::model::{PlaintextReasoningReplay, PlaintextResponses, TextKind};
    let base_url = std::env::var("MAKA_SGLANG_TEST_URL").expect("explicit endpoint required");
    let executor = ModelExecutor::new(1, Duration::from_secs(120)).unwrap();
    let tools = vec![ToolDefinition {
        freeform: None,
        output_schema: None,
        provider: None,
        name: "echo".into(),
        description: "Echo the supplied token.".into(),
        input_schema: json!({"type":"object","properties":{"token":{"type":"string"}},"required":["token"],"additionalProperties":false}),
    }];
    for (protocol, kind, options) in [
        (
            "chat",
            ProviderKind::OpenaiCompatible {
                name: "sglang".into(),
            },
            json!({"sglang":{"reasoningEffort":"high"}}),
        ),
        (
            "responses",
            ProviderKind::OpenResponses(PlaintextResponses {
                reasoning_replay: PlaintextReasoningReplay::PlaintextContent,
                compatibility: None,
            }),
            json!({"openResponses":{"reasoningEffort":"high"}}),
        ),
        (
            "messages",
            ProviderKind::Anthropic,
            json!({"anthropic":{"thinking":{"type":"enabled","budgetTokens":1024}}}),
        ),
    ] {
        let provider = ProviderConfig {
            adapter: None,
            capabilities: Default::default(),
            network: Default::default(),
            kind,
            base_url: base_url.clone(),
            model: "deepseek-v4.1-flash".into(),
            auth: ProviderAuth::ApiKey("local-test".into()),
            headers: BTreeMap::new(),
            body_overlay: None,
        };
        let mut prompt = vec![Message::user(
            "Call echo with token amber-native-42 exactly once, then report its result. Do not answer without calling echo.",
        )];
        for turn in 0..2 {
            let mut stream = executor
                .stream(
                    ModelRequest {
                        provider: provider.clone(),
                        prompt: prompt.clone(),
                        tools: tools.clone(),
                        provider_options: options.clone(),
                        max_output_tokens: Some(4096),
                    },
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            let mut builder = StepBuilder::default();
            while let Some(event) = stream.next().await {
                builder
                    .push(event.unwrap_or_else(|error| panic!("{protocol} step {turn}: {error}")))
                    .unwrap();
            }
            let step = builder.finish().unwrap();
            stream.cancel_and_wait().await;
            assert!(
                step.usage.input_tokens.is_some(),
                "{protocol}: missing input usage"
            );
            assert!(
                step.usage.output_tokens.is_some(),
                "{protocol}: missing output usage"
            );
            if turn == 0 {
                assert!(step.parts.iter().any(|part| matches!(part, ModelPart::Text { text_kind: TextKind::Thinking, text, .. } if !text.is_empty())),
                    "{protocol}: reasoning was lost");
                let calls = step.tool_calls().collect::<Vec<_>>();
                assert_eq!(calls.len(), 1, "{protocol}: expected one tool call");
                let call = calls[0];
                assert_eq!(call.name, "echo");
                assert_eq!(call.input, json!({"token":"amber-native-42"}));
                let content = step
                    .parts
                    .iter()
                    .filter_map(|part| match part {
                        ModelPart::Text {
                            text_kind: TextKind::Thinking,
                            text,
                            provider_options,
                        } => Some(AssistantPart::Reasoning {
                            text: text.clone(),
                            provider_options: provider_options.clone(),
                        }),
                        ModelPart::Text {
                            text,
                            provider_options,
                            ..
                        } => Some(AssistantPart::Text {
                            text: text.clone(),
                            provider_options: provider_options.clone(),
                        }),
                        ModelPart::ToolCall { call } => Some(AssistantPart::ToolCall {
                            tool_call_id: call.id.clone(),
                            tool_name: call.name.clone(),
                            input: call.input.clone(),
                            provider_options: call.provider_options.clone(),
                            provider_executed: Some(call.provider_executed),
                        }),
                        _ => None,
                    })
                    .collect();
                prompt.push(Message::Assistant {
                    content,
                    provider_options: None,
                });
                prompt.push(Message::tool(
                    &call.id,
                    &call.name,
                    ToolOutput::Text("amber-native-42".into()),
                ));
            } else {
                let text = step
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        ModelPart::Text {
                            text_kind: TextKind::Text,
                            text,
                            ..
                        } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                assert!(
                    text.contains("amber-native-42"),
                    "{protocol}: tool result was not replayed"
                );
                assert_eq!(
                    step.tool_calls().count(),
                    0,
                    "{protocol}: unexpected repeated tool call"
                );
            }
        }
        println!("SGLang {protocol}: reasoning, tool call, replay and usage passed");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit MAKA_CODEX_AUTH_FILE and authorized gpt-5.6-luna subscription access"]
async fn codex_search_preserves_real_provider_calls_and_citations() {
    use std::io::Read;
    let path = std::env::var_os("MAKA_CODEX_AUTH_FILE").expect("explicit auth path required");
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .unwrap()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= 1024 * 1024);
    let auth: Value = serde_json::from_slice(&bytes).expect("invalid auth document");
    let access_token = auth["tokens"]["access_token"]
        .as_str()
        .expect("ChatGPT subscription token required")
        .to_owned();
    let mut network = maka_network::Policy::default();
    if let Ok(port) = std::env::var("MAKA_LIVE_PROXY_PORT") {
        let mut proxy = maka_runtime::configuration::policy::RuntimePolicy::default().network_proxy;
        proxy.enabled = true;
        proxy.host = "127.0.0.1".into();
        proxy.port = port.parse().expect("invalid proxy port");
        network = maka_network::Policy::from_settings(&proxy, None).unwrap();
    }
    tokio::time::timeout(Duration::from_secs(120), async {
        let executor = ModelExecutor::new(1, Duration::from_secs(60)).unwrap();
        let lane = Conversation::default();
        let request = ModelRequest {
            provider: ProviderConfig {
                adapter: Some(maka_providers::codex::ADAPTER.into()),
                capabilities: Default::default(),
                kind: ProviderKind::OpenaiResponses,
                model: "gpt-5.6-luna".into(),
                base_url: "https://chatgpt.com/backend-api/codex".into(),
                auth: ProviderAuth::RequestHeaders(maka_providers::codex::request_headers(&access_token, &format!("maka-web-test-{}", std::process::id())).unwrap()),
                headers: BTreeMap::new(), body_overlay: None, network,
            },
            prompt: vec![
                maka_model::prompt::Message::System { content: "Use the provided web search tool for current information. Reply briefly with a cited source.".into(), provider_options: None },
                maka_model::prompt::Message::user("Search rust-lang.org for the current stable Rust release. Give its version and release date with a citation.")
            ],
            tools: vec![ToolDefinition {
                freeform: None,
                output_schema: None,
                name: "WebSearch".into(),
                description: "Search the web".into(),
                input_schema: json!({"type":"object","properties":{}}),
                provider: Some(ProviderTool { id: "openai.web_search".into(), args: json!({"searchContextSize":"medium"}) }),
            }],
            provider_options: json!({"openai":{"reasoningEffort":"low"}}),
            max_output_tokens: None,
        };
        let mut stream = executor.stream_in_conversation(request, CancellationToken::new(), Some(lane.clone())).await.unwrap();
        let mut builder = StepBuilder::for_step("live-native-search").unwrap();
        while let Some(event) = stream.next().await { builder.push(event.unwrap()).unwrap(); }
        let step = builder.finish().unwrap();
        stream.cancel_and_wait().await;
        let calls = step.tool_calls().filter(|call| call.provider_executed && call.name == "WebSearch").count();
        let sources = step.parts.iter().filter(|part| matches!(part, ModelPart::Source { source: ModelSource::Url { .. } })).count();
        println!("Codex native search: {calls} provider calls, {sources} cited sources; websocket={}", lane.needs_confirmation());
        assert!(calls > 0, "ordinary text is not evidence of a provider search");
        assert!(sources > 0, "citations must survive the SDK and canonical step");
        drop(lane);
    }).await.expect("live search must remain bounded");
}
