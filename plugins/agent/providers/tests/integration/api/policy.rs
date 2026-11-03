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
use maka_agent_facts::configuration::ModelOverrideCapabilities;

#[tokio::test]
async fn anthropic_alias_override_and_alternate_use_the_selected_protocol_policy() {
    // These inputs distinguish direct aliases, model adapter overrides and an
    // explicit protocol alternate. Account endpoints must retain precedence.
    for (provider, id, protocol, level, options, budget) in [
        (
            "minimax-coding-plan",
            "MiniMax-M2.5",
            None,
            High,
            json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"effort":"high"}}),
            4000,
        ),
        (
            "opencode",
            "claude-opus-4-6",
            None,
            High,
            json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"thinking":{"type":"enabled","budgetTokens":1024},"effort":"high"}}),
            2976,
        ),
        (
            "zenmux",
            "anthropic/claude-opus-4.5",
            None,
            High,
            json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"thinking":{"type":"enabled","budgetTokens":1024},"effort":"high"}}),
            2976,
        ),
        (
            "opencode",
            "custom-model",
            Some(ApiProtocol::AnthropicMessages),
            High,
            json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"effort":"high"}}),
            4000,
        ),
        (
            "anthropic",
            "claude-opus-4-6",
            None,
            High,
            json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"thinking":{"type":"adaptive","display":"summarized"},"effort":"high"}}),
            4000,
        ),
        (
            "anthropic",
            "claude-sonnet-4-5",
            None,
            Off,
            json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"thinking":{"type":"disabled"}}}),
            4000,
        ),
    ] {
        let binding = binding(provider);
        let mut input = request(
            &binding,
            id,
            ModelOverride {
                api_protocol: protocol,
                thinking_levels: Some(vec![level]),
                max_output_tokens: Some(4000),
                ..Default::default()
            },
        );
        input.thinking_level = Some(level);
        let model = binding.prepare(input).await.unwrap();
        assert!(
            matches!(model.protocol, ProviderKind::Anthropic),
            "{provider}/{id}"
        );
        assert_eq!(model.adapter, "anthropic-messages");
        assert_eq!(model.base_url, "https://relay.test/v1");
        assert_eq!(model.info.id, id);
        assert_eq!(model.provider_options, options, "{provider}/{id}");
        assert_eq!(model.main_output_limit, Some(budget), "{provider}/{id}");
    }
    // With the catalog endpoint unchanged, the model's endpoint override owns
    // routing; a custom account endpoint above deliberately takes precedence.
    let binding = binding("zenmux");
    let mut input = request(
        &binding,
        "anthropic/claude-opus-4.5",
        ModelOverride {
            max_output_tokens: Some(4000),
            ..Default::default()
        },
    );
    input.connection.configuration = binding
        .configure(json!({"baseUrl":"https://zenmux.ai/api/v1"}))
        .unwrap();
    let model = binding.prepare(input).await.unwrap();
    assert!(matches!(model.protocol, ProviderKind::Anthropic));
    assert_eq!(model.base_url, "https://zenmux.ai/api/anthropic/v1");
    assert_eq!(
        model.provider_options,
        json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"thinking":{"type":"enabled","budgetTokens":1024}}})
    );
    assert_eq!(model.main_output_limit, Some(2976));
}

#[tokio::test]
async fn resolved_openai_routes_preserve_explicit_effort_and_parallel_policy() {
    for (provider, id, wire) in [
        (
            "volcengine-agent-plan",
            "ark-code-latest",
            ApiProtocol::OpenaiResponses,
        ),
        ("xai", "grok-4.5", ApiProtocol::OpenaiResponses),
        ("opencode", "gpt-5.2", ApiProtocol::OpenaiResponses),
        ("opencode", "custom-model", ApiProtocol::OpenaiResponses),
        (
            "zenmux",
            "openai/gpt-5.2",
            ApiProtocol::OpenaiChatCompletions,
        ),
    ] {
        let binding = binding(provider);
        let mut input = request(
            &binding,
            id,
            ModelOverride {
                api_protocol: Some(wire),
                thinking_levels: Some(vec![High]),
                max_output_tokens: Some(4000),
                capabilities: Some(ModelOverrideCapabilities {
                    parallel_tool_calls: Some(false),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        input.thinking_level = Some(High);
        input.model.supports_reasoning_summary = Some(false);
        let model = binding.prepare(input).await.unwrap();
        match wire {
            ApiProtocol::OpenaiResponses => {
                assert!(matches!(model.protocol, ProviderKind::OpenaiResponses));
                assert_eq!(model.adapter, "responses");
            }
            ApiProtocol::OpenaiChatCompletions => {
                assert!(matches!(
                    model.protocol,
                    ProviderKind::OpenaiChatCompletions
                ));
                assert_eq!(model.adapter, "chat-completions");
            }
            ApiProtocol::AnthropicMessages => unreachable!(),
        }
        assert_eq!(model.base_url, "https://relay.test/v1");
        assert_eq!(model.info.id, id);
        assert_eq!(
            model.provider_options,
            json!({"openai":{"store":false,"parallelToolCalls":false,"reasoningEffort":"high"}}),
            "{provider}/{id}"
        );
        assert_eq!(model.main_output_limit, Some(4000));
    }
}

#[tokio::test]
async fn ollama_cloud_catalog_models_are_selectable_and_executable() {
    let snapshot = snapshot();
    let binding = binding("ollama-cloud");
    let models: Vec<_> = snapshot
        .models(None)
        .filter(|(provider, _)| *provider == "ollama-cloud")
        .map(|(_, model)| model.clone())
        .collect();
    assert!(!models.is_empty());
    for model in models {
        let mut input = request(&binding, &model.id, ModelOverride::default());
        input.model = model;
        input.connection.configuration = binding
            .configure(json!({"baseUrl":"https://ollama.com/v1"}))
            .unwrap();
        let metadata = ApiProviders::model_metadata(
            "ollama-cloud",
            snapshot.clone(),
            input.connection.clone(),
            input.model.clone(),
            None,
        )
        .unwrap();
        let prepared = binding.prepare(input.clone()).await.unwrap();
        assert!(
            matches!(prepared.protocol, ProviderKind::OpenaiCompatible { ref name } if name == "ollama-cloud")
        );
        assert_eq!(prepared.base_url, "https://ollama.com/v1");
        assert_eq!(
            prepared.provider_options["maka"],
            json!({"includeUsage":true,"openAiChatReasoningField":"reasoning"})
        );
        for level in metadata.thinking_levels {
            binding
                .prepare(Resolve {
                    thinking_level: Some(level),
                    ..input.clone()
                })
                .await
                .unwrap();
        }
    }
}
