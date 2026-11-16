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
use crate::facts;
use maka_agent_facts::configuration::{ModelInfo, ModelOverride};
use maka_agent_ports::provider::Connection;
use serde_json::json;
use std::collections::BTreeSet;

fn selection<'a>(
    provider: &'a str,
    connection: &'a Connection,
    base_url: &'a str,
    model: &'a ModelInfo,
    overrides: Option<&'a ModelOverride>,
) -> Selection<'a> {
    Selection {
        provider,
        connection,
        base_url,
        model,
        overrides,
    }
}

#[test]
fn catalog_resolution_strictly_follows_declarations() {
    let all = facts::all().unwrap();
    let connection = Connection {
        id: "conformance".into(),
        revision: 1,
        configuration: json!({}),
    };
    let mut resolved = 0usize;
    let mut rejected = 0usize;

    for (provider_id, provider) in all {
        let base_url = if provider.base_url.is_empty() {
            "https://relay.test/v1"
        } else {
            provider.base_url.as_str()
        };
        let mut models: BTreeSet<&str> = provider.models.keys().map(String::as_str).collect();
        models.extend(provider.fallback_models.iter().map(String::as_str));
        models.insert("__probe_unlisted_model__");

        for model_id in models {
            let info = ModelInfo::new(model_id);
            let row = selection(provider_id, &connection, base_url, &info, None);
            let known = provider.models.get(model_id);
            let base = known
                .and_then(|model| model.runtime_override.as_ref())
                .map_or(&provider.runtime_adapter, |value| &value.adapter);

            if matches!(
                base,
                RuntimeAdapter::Google {}
                    | RuntimeAdapter::Cohere {}
                    | RuntimeAdapter::Unavailable {}
            ) {
                assert!(
                    matches!(resolve(&row, provider), Err(Error::UnsupportedProtocol)),
                    "{provider_id}/{model_id} should reject unsupported adapter"
                );
                rejected += 1;
            } else {
                let expected = known
                    .and_then(|model| model.api_protocol)
                    .unwrap_or_else(|| base.wire().unwrap());
                let route = resolve(&row, provider).unwrap_or_else(|error| {
                    panic!("{provider_id}/{model_id} failed route resolution: {error:?}")
                });
                assert_eq!(route.wire, expected, "{provider_id}/{model_id}");
                resolved += 1;
            }
        }
    }

    assert!(resolved > 0 && rejected > 0);
}

#[test]
fn explicit_model_routes_match_expected_wire_protocols() {
    let all = facts::all().unwrap();
    let connection = Connection {
        id: "ground-truth".into(),
        revision: 1,
        configuration: json!({}),
    };

    for (provider_id, model_id, expected) in [
        ("opencode", "grok-4.5", Wire::OpenaiResponses),
        ("opencode", "grok-4.6", Wire::OpenaiResponses),
        ("opencode", "grok-build-0.1", Wire::OpenaiResponses),
        ("opencode", "muse-spark-1.2", Wire::OpenaiResponses),
        (
            "opencode",
            "muse-spark-1.2-contributor-free",
            Wire::OpenaiResponses,
        ),
        ("opencode", "muse-spark-1.3", Wire::OpenaiResponses),
        (
            "opencode",
            "muse-spark-1.3-contributor-free",
            Wire::OpenaiResponses,
        ),
        ("opencode-go", "grok-4.5", Wire::OpenaiResponses),
        ("opencode-go", "grok-4.6", Wire::OpenaiResponses),
        (
            "opencode-go",
            "muse-spark-1.3-contributor",
            Wire::OpenaiResponses,
        ),
        ("openai", "gpt-5.4", Wire::OpenaiResponses),
        ("openai", "gpt-4.1", Wire::OpenaiChatCompletions),
        ("deepseek", "deepseek-flash", Wire::OpenaiResponses),
        ("zenmux", "openai/gpt-5.2", Wire::OpenaiChatCompletions),
    ] {
        let provider = &all[provider_id];
        let info = ModelInfo::new(model_id);
        let row = selection(provider_id, &connection, &provider.base_url, &info, None);
        let route = resolve(&row, provider).unwrap();
        assert_eq!(route.wire, expected, "{provider_id}/{model_id}");
        match (provider_id, expected) {
            ("deepseek", Wire::OpenaiResponses) => {
                assert!(matches!(route.kind, ProviderKind::OpenResponses(_)));
            }
            (_, Wire::OpenaiResponses) => {
                assert!(matches!(route.kind, ProviderKind::OpenaiResponses));
            }
            (_, Wire::OpenaiChatCompletions) => {
                assert!(matches!(route.kind, ProviderKind::OpenaiChatCompletions));
            }
            (_, Wire::AnthropicMessages) => unreachable!(),
        }
        if provider_id == "zenmux" {
            route.check_execution().unwrap();
        }
    }
}

#[test]
fn load_rejects_invalid_adapter_and_model_protocol_declarations() {
    let provider_json = |adapter: serde_json::Value,
                         protocol_adapters: serde_json::Value,
                         models: serde_json::Value| {
        json!({
            "test": {
                "label": "Test",
                "baseUrl": "https://relay.test/v1",
                "authKind": "api_key",
                "runtimeAdapter": adapter,
                "protocolAdapters": protocol_adapters,
                "retired": false,
                "modelDiscovery": { "kind": "protocol" },
                "fallbackModels": [],
                "models": models
            }
        })
        .to_string()
    };
    let model_entry = |api_protocol: Option<&str>| {
        let mut entry = json!({
            "metadata": {},
            "runtimeOverride": null,
            "entry": {
                "canUseAsChatDefault": true,
                "supportsVision": false,
                "thinkingLevels": []
            },
            "anthropicAdaptiveThinking": null
        });
        if let Some(wire) = api_protocol {
            entry["apiProtocol"] = json!(wire);
        }
        entry
    };

    // Every RuntimeAdapter variant speaks one protocol and rejects unknown fields at load time.
    for adapter in [
        json!({"kind": "anthropic", "auth": "api-key", "normalizeBaseUrl": true, "apiProtocol": "anthropic-messages"}),
        json!({"kind": "openai-chat", "apiProtocol": "openai-chat-completions"}),
        json!({"kind": "openai-responses", "responses": {"adapter": "openai", "reasoningReplay": "encrypted-content"}, "apiProtocol": "openai-responses"}),
        json!({"kind": "openai-codex", "responses": {"adapter": "openai", "reasoningReplay": "encrypted-content"}, "apiProtocol": "openai-responses"}),
        json!({"kind": "openai-compatible", "name": "provider", "apiProtocol": "openai-chat-completions"}),
        json!({"kind": "google", "apiProtocol": "openai-chat-completions"}),
        json!({"kind": "cohere", "apiProtocol": "openai-chat-completions"}),
        json!({"kind": "unavailable", "apiProtocol": "openai-chat-completions"}),
    ] {
        let raw = provider_json(adapter.clone(), json!({}), json!({}));
        assert!(
            facts::parse(&raw).is_err(),
            "adapter should reject invalid fields at load time: {adapter}"
        );
    }

    // Model-level apiProtocol unsupported by base or protocolAdapters fails at load time.
    let raw = provider_json(
        json!({"kind": "openai-responses", "responses": {"adapter": "openai", "reasoningReplay": "encrypted-content"}}),
        json!({}),
        json!({"m": model_entry(Some("openai-chat-completions"))}),
    );
    assert!(facts::parse(&raw).is_err());

    // protocolAdapters entries must match their declared protocol key.
    let raw = provider_json(
        json!({"kind": "anthropic", "auth": "api-key", "normalizeBaseUrl": true}),
        json!({"openai-chat-completions": {"kind": "openai-responses", "responses": {"adapter": "openai", "reasoningReplay": "encrypted-content"}}}),
        json!({}),
    );
    assert!(facts::parse(&raw).is_err());
}

#[test]
fn runtime_protocol_overrides_and_unsupported_wire_rejection() {
    let all = facts::all().unwrap();
    let connection = Connection {
        id: "route-test".into(),
        revision: 1,
        configuration: json!({}),
    };

    // Alternate protocolAdapters via explicit ModelOverride.
    let kimi = &all["kimi-coding-plan"];
    let info = ModelInfo::new("k3");
    let overrides = ModelOverride {
        api_protocol: Some(Wire::OpenaiChatCompletions),
        ..Default::default()
    };
    let route = resolve(
        &selection(
            "kimi-coding-plan",
            &connection,
            &kimi.base_url,
            &info,
            Some(&overrides),
        ),
        kimi,
    )
    .unwrap();
    assert_eq!(route.wire, Wire::OpenaiChatCompletions);
    assert!(matches!(
        route.kind,
        ProviderKind::OpenaiCompatible { ref name } if name == "kimi-coding-plan"
    ));

    // Alternate protocolAdapters via discovered model.api_protocol.
    let commandcode = &all["commandcode"];
    let mut discovered = ModelInfo::new("anthropic/claude-opus-4-6");
    discovered.api_protocol = Some(Wire::AnthropicMessages);
    let route = resolve(
        &selection(
            "commandcode",
            &connection,
            &commandcode.base_url,
            &discovered,
            None,
        ),
        commandcode,
    )
    .unwrap();
    assert_eq!(route.wire, Wire::AnthropicMessages);
    assert!(matches!(route.kind, ProviderKind::Anthropic));

    // UnsupportedProtocol guard fails closed without a fallback waterfall.
    let anthropic = &all["anthropic"];
    let bad_override = ModelOverride {
        api_protocol: Some(Wire::OpenaiResponses),
        ..Default::default()
    };
    assert!(matches!(
        resolve(
            &selection(
                "anthropic",
                &connection,
                &anthropic.base_url,
                &info,
                Some(&bad_override)
            ),
            anthropic
        ),
        Err(Error::UnsupportedProtocol)
    ));
}
