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

use maka_agent_facts::configuration::ApiProtocol;
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_facts::configuration::ModelOverride;
use maka_agent_facts::execution::ThinkingLevel::High;
use maka_agent_facts::execution::ThinkingLevel::Low;
use maka_agent_facts::execution::ThinkingLevel::Max;
use maka_agent_facts::execution::ThinkingLevel::Medium;
use maka_agent_facts::execution::ThinkingLevel::Off;
use maka_agent_facts::execution::ThinkingLevel::Xhigh;
use maka_agent_facts::model::request::ProviderKind;
use maka_agent_ports::provider::Connection;
use maka_agent_ports::provider::Definition;
use maka_agent_ports::provider::Resolve;
use maka_providers::api::ApiProviders;
use serde_json::json;

mod discovery;
mod effects;
mod policy;

fn snapshot() -> std::sync::Arc<maka_providers::catalog::Snapshot> {
    std::sync::Arc::new(maka_providers::catalog::Snapshot::bundled().unwrap())
}

fn binding(name: &str) -> Definition {
    ApiProviders::definition(name, snapshot()).unwrap()
}
fn request(binding: &Definition, id: &str, overrides: ModelOverride) -> Resolve {
    let configuration = binding
        .configure(json!({"baseUrl":"https://relay.test/v1"}))
        .unwrap();
    Resolve {
        connection: Connection {
            id: "test-account".into(),
            revision: 1,
            configuration,
        },
        model: ModelInfo::new(id),
        overrides: Some(overrides),
        thinking_level: None,
    }
}

#[tokio::test]
async fn public_provider_binding_preserves_protocol_contracts_and_explicit_policy() {
    for name in ["ollama", "localai"] {
        let binding = binding(name);
        assert!(binding.descriptor().anonymous);
        let connection = request(&binding, "custom", ModelOverride::default()).connection;
        let credentials = binding
            .authorize(connection, None, "session".into())
            .await
            .unwrap();
        assert!(
            matches!(credentials, maka_agent_ports::model::Credentials::RequestHeaders(headers) if headers.is_empty())
        );
    }
    let required = binding("openai");
    assert!(!required.descriptor().anonymous);
    assert!(
        required
            .authorize(
                request(&required, "custom", ModelOverride::default()).connection,
                None,
                "session".into()
            )
            .await
            .is_err()
    );
    for (name, summary) in [
        ("deepseek", false),
        ("moonshot-global", true),
        ("alibaba-token-plan", true),
    ] {
        let binding = binding(name);
        let input = request(
            &binding,
            "custom",
            ModelOverride {
                api_protocol: Some(ApiProtocol::OpenaiResponses),
                thinking_levels: Some(vec![Off, High]),
                default_thinking_level: Some(High),
                ..Default::default()
            },
        );
        let model = binding.prepare(input.clone()).await.unwrap();
        assert!(matches!(model.protocol, ProviderKind::OpenResponses(_)));
        assert_eq!(model.adapter, "responses");
        assert_eq!(
            model.provider_options["openResponses"]["reasoningEffort"],
            "high"
        );
        assert_eq!(
            model.provider_options["openResponses"]
                .get("reasoningSummary")
                .is_some(),
            summary
        );
        let model = binding
            .prepare(Resolve {
                thinking_level: Some(Off),
                ..input
            })
            .await
            .unwrap();
        assert_eq!(
            model.provider_options,
            json!({"openResponses":{"reasoningEffort":"none"}})
        );
    }
    for (provider, expected_name) in [
        ("openai-compatible", "test-account"),
        ("openrouter", "openrouter"),
    ] {
        let binding = binding(provider);
        let model = binding
            .prepare(request(&binding, "future-model", ModelOverride::default()))
            .await
            .unwrap();
        assert!(matches!(
            model.protocol,
            ProviderKind::OpenaiCompatible { name } if name == expected_name
        ));
    }
    for (name, protocol, adapter) in [
        (
            "openai-compatible",
            ApiProtocol::OpenaiChatCompletions,
            "chat-completions",
        ),
        (
            "openai-responses-compatible",
            ApiProtocol::OpenaiResponses,
            "responses",
        ),
        (
            "anthropic-compatible",
            ApiProtocol::AnthropicMessages,
            "anthropic-messages",
        ),
    ] {
        let binding = binding(name);
        let mut input = request(
            &binding,
            "future-model",
            ModelOverride {
                api_protocol: Some(protocol),
                max_output_tokens: Some(5000),
                ..Default::default()
            },
        );
        input.model.max_output_tokens = Some(4000);
        let model = binding.prepare(input).await.unwrap();
        assert_eq!(model.adapter, adapter);
        assert_eq!(model.main_output_limit, Some(4000));
        assert_eq!(model.info.max_output_tokens, Some(4000));
    }
}

#[tokio::test]
async fn account_metadata_and_reply_capacity_survive_plugin_policy_resolution() {
    let anthropic = binding("anthropic");
    let mut input = request(
        &anthropic,
        "claude-sonnet-4-5",
        ModelOverride {
            max_output_tokens: Some(5000),
            ..Default::default()
        },
    );
    input.model.max_output_tokens = Some(4000);
    let model = anthropic.prepare(input.clone()).await.unwrap();
    assert_eq!(
        model.provider_options["anthropic"]["thinking"]["budgetTokens"],
        1024
    );
    assert_eq!(model.main_output_limit, Some(2976));
    input.overrides.as_mut().unwrap().max_output_tokens = None;
    let inherited = anthropic.prepare(input.clone()).await.unwrap();
    assert_eq!(inherited.info.max_output_tokens, Some(4000));
    assert_eq!(inherited.main_output_limit, Some(2976));
    input.overrides.as_mut().unwrap().max_output_tokens = Some(4000);
    let explicit = anthropic.prepare(input.clone()).await.unwrap();
    assert_eq!(
        explicit.main_output_limit, inherited.main_output_limit,
        "entering the inherited total budget must not subtract thinking twice"
    );
    assert_eq!(explicit.provider_options, inherited.provider_options);
    input.overrides.as_mut().unwrap().max_output_tokens = Some(1000);
    assert_eq!(
        serde_json::to_value(anthropic.prepare(input).await.unwrap_err()).unwrap(),
        json!({"kind":"insufficient_output_budget"})
    );
    let mut unknown = request(
        &anthropic,
        "claude-future-unlisted",
        ModelOverride::default(),
    );
    unknown.model.capabilities = Some(maka_agent_facts::configuration::ModelCapabilities {
        reasoning: Some(true),
        ..Default::default()
    });
    let inherited = anthropic.prepare(unknown.clone()).await.unwrap();
    assert_eq!(inherited.info.max_output_tokens, None);
    assert_eq!(
        inherited.provider_options["anthropic"]["thinking"]["budgetTokens"],
        1024
    );
    assert_eq!(
        maka_agent_facts::context::effective_output_limit(inherited.main_output_limit),
        8000
    );
    unknown.overrides.as_mut().unwrap().max_output_tokens = Some(9024);
    let explicit = anthropic.prepare(unknown).await.unwrap();
    assert_eq!(
        explicit.main_output_limit,
        Some(8000),
        "an unknown model's displayed total budget must preserve its effective reply budget"
    );
    assert_eq!(explicit.provider_options, inherited.provider_options);
    let openai = binding("openai");
    for (id, label) in [("gpt-6-sol", "GPT-6 Sol"), ("gpt-6-luna", "GPT-6 Luna")] {
        let mut input = request(&openai, id, ModelOverride::default());
        input.thinking_level = Some(Max);
        let model = openai.prepare(input).await.unwrap();
        assert!(matches!(model.protocol, ProviderKind::OpenaiResponses));
        assert_eq!(model.info.id, id);
        assert_eq!(model.info.display_name.as_deref(), Some(label));
        assert_eq!(model.thinking_levels, [Low, Medium, High, Xhigh, Max]);
        assert_eq!(model.provider_options["openai"]["reasoningEffort"], "max");
    }
    let input = request(&openai, "gpt-5.2", ModelOverride::default());
    let model = openai.prepare(input.clone()).await.unwrap();
    assert_eq!(
        model.provider_options,
        json!({"openai":{"store":false,"parallelToolCalls":true}})
    );
    let mut account = input;
    account.model.thinking_levels = Some(vec![High]);
    let model = openai.prepare(account).await.unwrap();
    assert!(
        model.provider_options["openai"]
            .get("reasoningEffort")
            .is_none()
    );
    let mut input = request(
        &openai,
        "gpt-5.2",
        ModelOverride {
            thinking_levels: Some(vec![Max]),
            default_thinking_level: Some(Max),
            ..Default::default()
        },
    );
    input.model.context_window = Some(12345);
    input.model.supports_reasoning_summary = Some(false);
    input.model.thinking_levels = Some(vec![]);
    let model = openai.prepare(input).await.unwrap();
    assert_eq!(model.info.context_window, Some(12345));
    assert_eq!(model.thinking_levels, [Max]);
    assert_eq!(model.provider_options["openai"]["reasoningEffort"], "max");
    assert!(
        model.provider_options["openai"]
            .get("reasoningSummary")
            .is_none()
    );
    assert_eq!(model.main_output_limit, Some(128000));
}

#[tokio::test]
async fn repeated_definitions_keep_each_captured_model_observation() {
    use maka_providers::{catalog::Snapshot, codex::Codex};
    use std::sync::Arc;

    for provider in ["openai", "chatgpt"] {
        let bindings: Vec<_> = [Some(400_000), Some(600_000), None]
            .into_iter()
            .map(|context_window| {
                let record = context_window.map(|context_window| ModelInfo {
                    context_window: Some(context_window),
                    max_output_tokens: Some(8_000),
                    ..ModelInfo::new("gpt-5.4")
                });
                let snapshot = Arc::new(Snapshot::for_model(provider, "gpt-5.4", record).unwrap());
                let binding = if provider == "chatgpt" {
                    Codex::new(snapshot).definition().unwrap()
                } else {
                    ApiProviders::definition(provider, snapshot).unwrap()
                };
                (binding, context_window)
            })
            .collect();
        assert!(
            std::ptr::eq(bindings[0].0.descriptor(), bindings[1].0.descriptor()),
            "provider {provider} should share its compiled descriptor policy"
        );
        for (binding, context_window) in bindings {
            let configuration = binding.configure(json!({})).unwrap();
            let model = binding
                .prepare(Resolve {
                    connection: Connection {
                        id: "captured-account".into(),
                        revision: 1,
                        configuration,
                    },
                    model: ModelInfo::new("gpt-5.4"),
                    overrides: None,
                    thinking_level: None,
                })
                .await
                .unwrap();
            assert_eq!(
                model.info.context_window, context_window,
                "provider {provider}"
            );
        }
    }
}
