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

use maka_agent_facts::model::ModelPart;
use maka_agent_facts::tools::ToolDefinition;
use maka_model::{
    ModelExecutor, ModelRequest, ProviderAuth, ProviderConfig, ProviderKind, StepBuilder,
};
use serde_json::json;
use std::{collections::BTreeMap, time::Duration};
use tokio_util::sync::CancellationToken;

async fn run(protocol: &str, kind: ProviderKind) {
    use maka_agent_facts::model::TextKind;
    use maka_model::prompt::{AssistantPart, Message, ToolOutput};
    let base_url = "https://openrouter.ai/api/v1".to_owned();
    let key = std::env::var("OPENROUTER_API_KEY").expect("explicit authorization required");
    let model = std::env::var("MAKA_OPENROUTER_FREE_MODEL").expect("explicit free model required");
    assert!(
        model.ends_with(":free"),
        "only explicit free models are allowed"
    );
    let executor = ModelExecutor::new(Duration::from_secs(120)).unwrap();
    let tools = vec![ToolDefinition {
        freeform: None,
        output_schema: None,
        provider: None,
        name: "echo".into(),
        description: "Echo the supplied token.".into(),
        input_schema: json!({"type":"object","properties":{"token":{"type":"string"}},"required":["token"],"additionalProperties":false}),
    }];
    {
        let options = json!({});
        let provider = ProviderConfig {
            adapter: None,
            capabilities: Default::default(),
            network: Default::default(),
            kind,
            base_url: base_url.clone(),
            model: model.clone(),
            auth: ProviderAuth::ApiKey(key),
            headers: BTreeMap::new(),
            body_overlay: None,
        };
        let mut prompt = vec![Message::user(
            "Call echo with token amber-native-42 exactly once, then report its result. Do not answer without calling echo.",
        )];
        for turn in 0..2 {
            let mut input = ModelRequest {
                language: maka_agent_facts::language::Language::En,
                provider: provider.clone(),
                prompt: prompt.clone().into(),
                tools: tools.clone(),
                provider_options: options.clone(),
                max_output_tokens: Some(4096),
            };
            let reads = super::provider_stream::prepare_input(&mut input);
            let mut stream = executor
                .stream(input, CancellationToken::new())
                .await
                .unwrap();
            let mut builder = StepBuilder::default();
            while let Some(event) = stream.next().await {
                builder
                    .push(
                        event
                            .unwrap_or_else(|error| panic!("{protocol} step {turn}: {error}"))
                            .event,
                    )
                    .unwrap();
            }
            let step = builder.finish().unwrap();
            stream
                .cancel_and_wait()
                .await
                .expect("actual stream cleanup");
            reads.assert_wire_only();
            assert!(
                step.usage.input_tokens.is_some(),
                "{protocol}: missing input usage"
            );
            assert!(
                step.usage.output_tokens.is_some(),
                "{protocol}: missing output usage"
            );
            if turn == 0 {
                let calls = step.tool_calls().collect::<Vec<_>>();
                assert_eq!(calls.len(), 1, "{protocol}: expected one tool call");
                let call = calls[0];
                assert_eq!(call.name, "echo");
                assert_eq!(
                    call.input,
                    maka_agent_facts::model::ToolInput::Json(json!({"token":"amber-native-42"}))
                );
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
                    ToolOutput::Text("cobalt-tool-receipt-73".into()),
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
                    text.contains("cobalt-tool-receipt-73"),
                    "{protocol}: tool result was not replayed"
                );
                assert_eq!(
                    step.tool_calls().count(),
                    0,
                    "{protocol}: unexpected repeated tool call"
                );
            }
        }
        println!(
            "OpenRouter {protocol} {model}: prepared-wire tool call, canonical replay, final text, usage, zero semantic reads and cleanup passed"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires authorized OPENROUTER_API_KEY and verified MAKA_OPENROUTER_FREE_MODEL"]
async fn openrouter_chat_tools_and_replay() {
    tokio::time::timeout(
        Duration::from_secs(240),
        run(
            "chat",
            ProviderKind::OpenaiCompatible {
                name: "openrouter".into(),
            },
        ),
    )
    .await
    .expect("bounded live test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires authorized OPENROUTER_API_KEY and verified MAKA_OPENROUTER_FREE_MODEL"]
async fn openrouter_messages_tools_and_replay() {
    tokio::time::timeout(
        Duration::from_secs(240),
        run("messages", ProviderKind::Anthropic),
    )
    .await
    .expect("bounded live test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires authorized OPENROUTER_API_KEY and verified MAKA_OPENROUTER_FREE_MODEL"]
async fn openrouter_responses_tools_and_replay() {
    tokio::time::timeout(
        Duration::from_secs(240),
        run("responses", ProviderKind::OpenaiResponses),
    )
    .await
    .expect("bounded live test");
}

async fn vision(protocol: &str, kind: ProviderKind) {
    use maka_agent_facts::model::TextKind;
    use maka_model::prompt::{ContentPart, FileData, Message};
    let model = std::env::var("MAKA_OPENROUTER_FREE_VISION_MODEL")
        .expect("explicit free vision model required");
    assert!(model.ends_with(":free"));
    let mut input = super::provider_stream::request(kind, "https://openrouter.ai/api/v1".into());
    input.provider.auth = ProviderAuth::ApiKey(
        std::env::var("OPENROUTER_API_KEY").expect("explicit authorization required"),
    );
    input.provider.model = model.clone();
    input.tools.clear();
    input.max_output_tokens = Some(1024);
    input.prompt = vec![Message::User {
        content: vec![
            ContentPart::text("Name the solid color in this image. Reply with its English color name only."),
            ContentPart::File {
                data: FileData::Data("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC".into()),
                media_type: "image/png".into(),
                provider_options: Some(json!({"openai":{"imageDetail":"high"}})),
            },
        ],
        provider_options: None,
    }].into();
    let reads = super::provider_stream::prepare_input(&mut input);
    let executor = ModelExecutor::new(Duration::from_secs(120)).unwrap();
    let mut stream = executor
        .stream(input, CancellationToken::new())
        .await
        .unwrap();
    let mut builder = StepBuilder::default();
    while let Some(event) = stream.next().await {
        builder
            .push(
                event
                    .unwrap_or_else(|error| panic!("{protocol} vision: {error}"))
                    .event,
            )
            .unwrap();
    }
    stream.cancel_and_wait().await.unwrap();
    reads.assert_wire_only();
    let step = builder.finish().unwrap();
    let text = step
        .parts
        .iter()
        .filter_map(|part| match part {
            ModelPart::Text {
                text_kind: TextKind::Text,
                text,
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(
        text.to_ascii_lowercase().contains("red"),
        "{protocol}: actual image color was not recognized: {text}"
    );
    assert!(step.usage.input_tokens.is_some() && step.usage.output_tokens.is_some());
    println!(
        "OpenRouter {protocol} {model}: prepared-wire inline PNG, color recognition, usage, zero semantic reads and cleanup passed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires authorized OPENROUTER_API_KEY and verified MAKA_OPENROUTER_FREE_VISION_MODEL"]
async fn openrouter_chat_vision() {
    tokio::time::timeout(
        Duration::from_secs(180),
        vision(
            "chat",
            ProviderKind::OpenaiCompatible {
                name: "openrouter".into(),
            },
        ),
    )
    .await
    .expect("bounded live vision test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires authorized OPENROUTER_API_KEY and verified MAKA_OPENROUTER_FREE_VISION_MODEL"]
async fn openrouter_messages_vision() {
    tokio::time::timeout(
        Duration::from_secs(180),
        vision("messages", ProviderKind::Anthropic),
    )
    .await
    .expect("bounded live vision test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires authorized OPENROUTER_API_KEY and verified MAKA_OPENROUTER_FREE_VISION_MODEL"]
async fn openrouter_responses_vision() {
    tokio::time::timeout(
        Duration::from_secs(180),
        vision("responses", ProviderKind::OpenaiResponses),
    )
    .await
    .expect("bounded live vision test");
}
