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
async fn kimi_catalog_thinking_levels_prepare_without_losing_the_selected_route() {
    let binding = binding("kimi-coding-plan");
    for (level, options) in [
        (
            None,
            json!({"anthropic":{"cacheControl":{"type":"ephemeral"}}}),
        ),
        (
            Some(Low),
            json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"effort":"low"}}),
        ),
        (
            Some(High),
            json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"effort":"high"}}),
        ),
        (
            Some(Max),
            json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"effort":"max"}}),
        ),
    ] {
        let mut input = request(&binding, "k3", ModelOverride::default());
        input.thinking_level = level;
        let model = binding.prepare(input).await.unwrap();
        assert!(matches!(model.protocol, ProviderKind::Anthropic));
        assert_eq!(model.adapter, "anthropic-messages");
        assert_eq!(model.info.id, "k3");
        assert_eq!(model.base_url, "https://relay.test/v1");
        assert_eq!(model.thinking_levels, [Low, High, Max]);
        assert_eq!(model.provider_options, options);
        assert_eq!(model.main_output_limit, Some(131072));
    }
}

#[tokio::test]
async fn kimi_catalog_choices_and_supported_default_remain_selectable() {
    let binding = binding("kimi-coding-plan");
    for default in [None, Some(High)] {
        let input = request(
            &binding,
            "k3",
            ModelOverride {
                default_thinking_level: default,
                ..Default::default()
            },
        );
        let metadata = ApiProviders::model_metadata(
            "kimi-coding-plan",
            snapshot(),
            input.connection.clone(),
            input.model.clone(),
            input.overrides.clone(),
        )
        .unwrap();
        assert_eq!(metadata.thinking_levels, [Low, High, Max]);
        assert_eq!(metadata.default_thinking_level, default);
        let model = binding.prepare(input).await.unwrap();
        assert_eq!(
            model.provider_options,
            if default.is_some() {
                json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"effort":"high"}})
            } else {
                json!({"anthropic":{"cacheControl":{"type":"ephemeral"}}})
            }
        );
    }
}

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
async fn anthropic_parallel_opt_out_is_encoded_on_canonical_and_alias_routes() {
    for provider in ["anthropic", "anthropic-compatible"] {
        let binding = binding(provider);
        for parallel in [None, Some(false)] {
            let input = request(
                &binding,
                "custom-model",
                ModelOverride {
                    capabilities: Some(ModelOverrideCapabilities {
                        parallel_tool_calls: parallel,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            );
            let model = binding.prepare(input).await.unwrap();
            assert!(matches!(model.protocol, ProviderKind::Anthropic));
            assert_eq!(
                model.provider_options,
                if parallel == Some(false) {
                    json!({"anthropic":{"cacheControl":{"type":"ephemeral"},"disableParallelToolUse":true}})
                } else {
                    json!({"anthropic":{"cacheControl":{"type":"ephemeral"}}})
                },
                "{provider}/{parallel:?}"
            );
        }
    }
}

#[tokio::test]
async fn supported_options_do_not_enable_unsupported_execution_contracts() {
    let mut observed = Vec::new();
    for (provider, id, wire) in [
        ("MiniMax", "custom-model", ApiProtocol::AnthropicMessages),
        (
            "commandcode",
            "custom-model",
            ApiProtocol::AnthropicMessages,
        ),
        ("zenmux", "openai/gpt-5.2", ApiProtocol::OpenaiResponses),
        ("kimi-coding-plan", "k3", ApiProtocol::OpenaiChatCompletions),
        (
            "anthropic-compatible",
            "custom-model",
            ApiProtocol::OpenaiResponses,
        ),
    ] {
        let binding = binding(provider);
        let input = request(
            &binding,
            id,
            ModelOverride {
                api_protocol: Some(wire),
                thinking_levels: Some(vec![High]),
                default_thinking_level: Some(High),
                ..Default::default()
            },
        );
        observed.push(json!({
            "case": provider,
            "error": binding.prepare(input).await.err(),
        }));
    }
    let binding = binding("deepseek");
    let input = request(
        &binding,
        "custom-model",
        ModelOverride {
            api_protocol: Some(ApiProtocol::OpenaiResponses),
            capabilities: Some(ModelOverrideCapabilities {
                parallel_tool_calls: Some(false),
                ..Default::default()
            }),
            ..Default::default()
        },
    );
    observed.push(json!({
        "case": "open-responses-parallel",
        "error": binding.prepare(input).await.err(),
    }));
    let binding = super::binding("kimi-coding-plan");
    let mut input = request(&binding, "k3", ModelOverride::default());
    input.thinking_level = Some(Medium);
    observed.push(json!({
        "case": "undeclared-kimi-level",
        "error": binding.prepare(input).await.err(),
    }));
    assert_eq!(
        json!(observed),
        json!([
            {"case":"MiniMax","error":{"kind":"unsupported_execution_profile"}},
            {"case":"commandcode","error":{"kind":"unsupported_execution_profile"}},
            {"case":"zenmux","error":{"kind":"unsupported_execution_profile"}},
            {"case":"kimi-coding-plan","error":{"kind":"unsupported_execution_profile"}},
            {"case":"anthropic-compatible","error":{"kind":"unsupported_protocol"}},
            {"case":"open-responses-parallel","error":{"kind":"unsupported_parallel_policy"}},
            {"case":"undeclared-kimi-level","error":{"kind":"unsupported_thinking_level"}},
        ])
    );
}
