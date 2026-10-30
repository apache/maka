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
async fn catalog_metadata_and_execution_share_provider_facts_and_explicit_overrides() {
    use maka_agent_facts::public_catalog::PublicCatalogBody;
    use maka_providers::catalog::Snapshot;
    let models = PublicCatalogBody::from_json(json!({
        "openai":{"id":"openai","models":{
            "model-alias":{"id":"model-alias","canonical_model_id":"vendor/public-model"}
        }},
        "openrouter":{"id":"openrouter","models":{
            "vendor/public-model":{"id":"vendor/public-model","canonical_model_id":"vendor/public-model"}
        }}
    }).to_string()).unwrap();
    let router = PublicCatalogBody::from_json(
        json!({"data":[{
            "id":"vendor/public-model","name":"Public model","context_length":1048576,
            "top_provider":{"max_completion_tokens":393216},
            "reasoning":{"mandatory":true,"supported_efforts":["high"],"default_effort":"high"}
        }]})
        .to_string(),
    )
    .unwrap();
    let snapshot =
        std::sync::Arc::new(Snapshot::from_sources(Some(&models), Some(&router)).unwrap());
    let binding = ApiProviders::definition("openai-compatible", snapshot.clone()).unwrap();
    let mut input = request(&binding, "model-alias", ModelOverride::default());
    let metadata = ApiProviders::model_metadata(
        "openai-compatible",
        snapshot,
        input.connection.clone(),
        input.model.clone(),
        None,
    )
    .unwrap();
    assert_eq!(metadata.info.display_name.as_deref(), Some("Public model"));
    assert_eq!(metadata.info.context_window, Some(1048576));
    assert_eq!(metadata.info.max_output_tokens, Some(393216));
    assert_eq!(metadata.info.api_protocol, None);
    assert!(metadata.thinking_levels.is_empty());
    assert_eq!(metadata.default_thinking_level, None);
    let model = binding.prepare(input.clone()).await.unwrap();
    assert_eq!(model.info.id, "model-alias");
    assert_eq!(model.adapter, "chat-completions");
    assert_eq!(model.info.context_window, Some(1048576));
    assert_eq!(model.main_output_limit, Some(393216));
    input.model.context_window = Some(8192);
    input.model.max_output_tokens = Some(4096);
    input.overrides = Some(ModelOverride {
        context_window: Some(6000),
        input_limit: Some(4000),
        max_output_tokens: Some(2048),
        ..Default::default()
    });
    let model = binding.prepare(input).await.unwrap();
    assert_eq!(model.info.context_window, Some(6000));
    assert_eq!(model.info.input_limit, Some(4000));
    assert_eq!(model.info.max_output_tokens, Some(4096));
    assert_eq!(model.main_output_limit, Some(2048));
}

#[tokio::test]
async fn selectable_thinking_choices_respect_native_encoder_and_invalid_default() {
    let binding = binding("anthropic-compatible");
    let mut input = request(
        &binding,
        "future-model",
        ModelOverride {
            thinking_levels: Some(vec![High]),
            ..Default::default()
        },
    );
    let metadata = ApiProviders::model_metadata(
        "anthropic-compatible",
        snapshot(),
        input.connection.clone(),
        input.model.clone(),
        input.overrides.clone(),
    )
    .unwrap();
    assert_eq!(metadata.thinking_levels, [High]);
    assert_eq!(metadata.default_thinking_level, None);
    assert_eq!(
        binding
            .prepare(input.clone())
            .await
            .unwrap()
            .provider_options,
        json!({"anthropic":{"cacheControl":{"type":"ephemeral"}}})
    );
    input.thinking_level = Some(High);
    assert_eq!(
        binding
            .prepare(input.clone())
            .await
            .unwrap()
            .provider_options,
        json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"effort":"high"}})
    );
    input.overrides.as_mut().unwrap().default_thinking_level = Some(High);
    let metadata = ApiProviders::model_metadata(
        "anthropic-compatible",
        snapshot(),
        input.connection.clone(),
        input.model.clone(),
        input.overrides.clone(),
    )
    .unwrap();
    assert_eq!(metadata.thinking_levels, [High]);
    assert_eq!(metadata.default_thinking_level, Some(High));
    input.thinking_level = None;
    assert_eq!(
        binding
            .prepare(input.clone())
            .await
            .unwrap()
            .provider_options,
        json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"effort":"high"}})
    );
    input.overrides.as_mut().unwrap().thinking_levels = Some(vec![Low]);
    assert!(
        ApiProviders::model_metadata(
            "anthropic-compatible",
            snapshot(),
            input.connection.clone(),
            input.model.clone(),
            input.overrides.clone(),
        )
        .is_err()
    );
    // A default outside the declared choices is invalid on either protocol.
    assert!(
        ApiProviders::model_metadata(
            "openai-compatible",
            snapshot(),
            input.connection,
            input.model,
            input.overrides
        )
        .is_err()
    );
}

#[tokio::test]
async fn manual_catalog_association_preserves_connection_policy_and_explicit_facts() {
    use maka_agent_facts::configuration::CatalogModelReference;
    let snapshot = snapshot();
    let (provider, public) = snapshot
        .models(None)
        .find(|(provider, model)| {
            *provider == "anthropic"
                && model.context_window.is_some()
                && model.max_output_tokens.is_some()
        })
        .unwrap();
    let public = public.clone();
    let reference = CatalogModelReference {
        provider: provider.into(),
        model_id: public.id.clone(),
    };
    let binding = ApiProviders::definition("openai-compatible", snapshot.clone()).unwrap();
    let mut input = request(
        &binding,
        "private-alias",
        ModelOverride {
            catalog_model: Some(reference.clone()),
            ..Default::default()
        },
    );
    let model = binding.prepare(input.clone()).await.unwrap();
    assert_eq!(model.info.id, "private-alias");
    assert_eq!(model.base_url, "https://relay.test/v1");
    assert_eq!(model.adapter, "chat-completions");
    assert_eq!(model.info.context_window, public.context_window);
    assert_eq!(model.main_output_limit, public.max_output_tokens);
    assert!(model.thinking_levels.is_empty());
    input.model.context_window = Some(8192);
    input.overrides.as_mut().unwrap().context_window = Some(6000);
    let model = binding.prepare(input).await.unwrap();
    assert_eq!(model.info.context_window, Some(6000));
    let subscription = maka_providers::codex::Codex::new(snapshot)
        .definition()
        .unwrap();
    let model = subscription
        .prepare(Resolve {
            connection: Connection {
                id: "subscription".into(),
                revision: 1,
                configuration: json!({"baseUrl":"https://chatgpt.com/backend-api/codex"}),
            },
            model: ModelInfo::new("private-alias"),
            overrides: Some(ModelOverride {
                catalog_model: Some(reference),
                ..Default::default()
            }),
            thinking_level: None,
        })
        .await
        .unwrap();
    assert_eq!(model.info.id, "private-alias");
    assert_eq!(model.info.context_window, public.context_window);
    assert_eq!(model.adapter, maka_providers::codex::ADAPTER);
}
