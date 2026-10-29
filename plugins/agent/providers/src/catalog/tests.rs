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

use super::Snapshot;
use maka_agent_facts::configuration::{
    ModelCapabilities, ModelInfo, ModelModalities, ModelModality,
};
use maka_agent_facts::execution::ThinkingLevel::{High, Low, Max, Off};
use serde_json::{Value, json};

fn from_values(
    models: Option<&serde_json::Value>,
    router: Option<&serde_json::Value>,
) -> Result<Snapshot, String> {
    let body = |v: &serde_json::Value| {
        maka_agent_facts::public_catalog::PublicCatalogBody::from_json(v.to_string()).unwrap()
    };
    let models = models.map(body);
    let router = router.map(body);
    Snapshot::from_sources(models.as_ref(), router.as_ref())
}

#[test]
fn new_public_model_keeps_each_routes_own_controls_and_limits() {
    let models_dev = json!({
        "deepseek":{"id":"deepseek","models":{
            "brand-new-native":{"id":"brand-new-native","name":"Native name",
                "canonical_model_id":"vendor/new-model","reasoning":true,"tool_call":false,
                "reasoning_options":[{"type":"effort","values":["low","high"]}],
                "limit":{"context":8192,"input":4096,"output":2048}}
        }},
        "openrouter":{"id":"openrouter","models":{
            "vendor/new-model:free":{"id":"vendor/new-model:free","canonical_model_id":"vendor/new-model",
                "reasoning_options":[{"type":"effort","values":["low"]}]}
        }}
    });
    let openrouter = json!({"data":[{
        "id":"vendor/new-model:free","canonical_slug":"this-is-not-the-bridge",
        "name":"Gateway name","description":"Shared model description","knowledge_cutoff":"2026-01",
        "context_length":1048576,"top_provider":{"max_completion_tokens":393216},
        "architecture":{"input_modalities":["text","image"],"output_modalities":["text"]},
        "supported_parameters":["tools","structured_outputs","reasoning"],
        "reasoning":{"mandatory":true,"supported_efforts":["max","high"],"default_effort":"max"}
    }]});
    let snapshot = from_values(Some(&models_dev), Some(&openrouter)).unwrap();
    let native = snapshot.get("deepseek", "brand-new-native").unwrap();
    assert_eq!(native.display_name.as_deref(), Some("Native name"));
    assert_eq!(
        native.description.as_deref(),
        Some("Shared model description")
    );
    assert_eq!(native.knowledge_cutoff.as_deref(), Some("2026-01"));
    assert_eq!(native.context_window, Some(8192));
    assert_eq!(native.input_limit, Some(4096));
    assert_eq!(native.max_output_tokens, Some(2048));
    assert_eq!(native.capabilities.unwrap().function_calling, Some(false));
    assert_eq!(native.capabilities.unwrap().vision, None);
    assert_eq!(native.thinking_levels, Some(vec![Low, High]));
    assert_eq!(native.default_thinking_level, None);
    let gateway = snapshot.get("openrouter", "vendor/new-model:free").unwrap();
    assert_eq!(gateway.display_name.as_deref(), Some("Gateway name"));
    assert_eq!(gateway.context_window, Some(1048576));
    assert_eq!(gateway.max_output_tokens, Some(393216));
    assert_eq!(gateway.input_limit, None);
    assert_eq!(gateway.thinking_levels, Some(vec![Max, High]));
    assert_eq!(gateway.default_thinking_level, Some(Max));
    assert_eq!(gateway.capabilities.unwrap().vision, Some(true));
    assert_eq!(gateway.capabilities.unwrap().function_calling, Some(true));
    assert_eq!(gateway.structured_output, Some(true));
    assert_eq!(
        snapshot.get("openai-compatible", "brand-new-native"),
        Some(&ModelInfo {
            id: "brand-new-native".into(),
            display_name: Some("Gateway name".into()),
            description: Some("Shared model description".into()),
            knowledge_cutoff: Some("2026-01".into()),
            context_window: Some(1048576),
            max_output_tokens: Some(393216),
            ..Default::default()
        })
    );
    assert_eq!(
        snapshot.get("deepseek", "vendor/new-model:free"),
        Some(&ModelInfo {
            id: "vendor/new-model:free".into(),
            display_name: Some("Gateway name".into()),
            description: Some("Shared model description".into()),
            knowledge_cutoff: Some("2026-01".into()),
            context_window: Some(1048576),
            max_output_tokens: Some(393216),
            ..Default::default()
        })
    );
}

#[test]
fn compatible_connections_share_exact_public_ids_without_borrowing_route_controls() {
    let router = json!({"data":[{
        "id":"vendor/new-model","name":"Public name","description":"Public description",
        "knowledge_cutoff":"2026-01","canonical_slug":"some-other-id",
        "context_length":131072,"supported_parameters":["tools","reasoning"],
        "reasoning":{"mandatory":true,"supported_efforts":["high"],"default_effort":"high"}
    }, {
        "id":"openai/gpt-oss-120b","name":"OpenAI: gpt-oss-120b",
        "knowledge_cutoff":"2024-06-30","context_length":131072,
        "top_provider":{"max_completion_tokens":65536},
        "reasoning":{"mandatory":true,"supported_efforts":["high","medium","low"],"default_effort":"medium"}
    }]});
    let snapshot = from_values(None, Some(&router)).unwrap();
    let public = ModelInfo {
        id: "vendor/new-model".into(),
        display_name: Some("Public name".into()),
        description: Some("Public description".into()),
        knowledge_cutoff: Some("2026-01".into()),
        context_window: Some(131072),
        ..Default::default()
    };
    assert_eq!(
        snapshot.get("openai-compatible", "vendor/new-model"),
        Some(&public)
    );
    assert_eq!(snapshot.get("openai-compatible", "new-model"), None);
    assert_eq!(snapshot.get("openai-compatible", "some-other-id"), None);
    let reported = ModelInfo {
        display_name: Some("Account name".into()),
        context_window: Some(8192),
        thinking_levels: Some(vec![]),
        capabilities: Some(ModelCapabilities {
            reasoning: Some(false),
            function_calling: Some(false),
            ..Default::default()
        }),
        ..ModelInfo::new("vendor/new-model")
    };
    let expected = ModelInfo {
        description: Some("Public description".into()),
        knowledge_cutoff: Some("2026-01".into()),
        ..reported.clone()
    };
    assert_eq!(
        snapshot.resolve("openai-compatible", reported.clone(), None),
        expected
    );
    let captured =
        Snapshot::for_model("openai-compatible", "vendor/new-model", Some(public)).unwrap();
    assert_eq!(
        captured.resolve("openai-compatible", reported, None),
        expected
    );

    let models_dev = json!({"openai-compatible":{"id":"openai-compatible","models":{
        "vendor/new-model":{"id":"vendor/new-model","name":"Route name",
            "reasoning":false,"tool_call":false,"limit":{"context":8192}}
    }}});
    let known = from_values(Some(&models_dev), Some(&router)).unwrap();
    assert_eq!(
        known.get("openai-compatible", "vendor/new-model"),
        Some(&ModelInfo {
            id: "vendor/new-model".into(),
            display_name: Some("Route name".into()),
            description: Some("Public description".into()),
            knowledge_cutoff: Some("2026-01".into()),
            context_window: Some(8192),
            thinking_levels: Some(vec![]),
            capabilities: Some(ModelCapabilities {
                reasoning: Some(false),
                function_calling: Some(false),
                ..Default::default()
            }),
            ..Default::default()
        })
    );
    // This exact public ID also occurs in the bundled SiliconFlow inventory.
    let bundled = known.get("siliconflow", "openai/gpt-oss-120b").unwrap();
    assert_eq!(bundled.display_name.as_deref(), Some("openai/gpt-oss-120b"));
    assert_eq!(
        bundled.description.as_deref(),
        Some("Open-weight GPT model for self-hosted reasoning and instruction-following workloads")
    );
    assert_eq!(bundled.knowledge_cutoff.as_deref(), Some("2024-06-30"));
    assert_eq!(bundled.context_window, Some(131000));
    assert_eq!(bundled.max_output_tokens, Some(8000));
    assert_eq!(bundled.thinking_levels, Some(vec![]));
    assert_eq!(bundled.default_thinking_level, None);
}

#[test]
fn conflicting_gateway_descriptions_never_cross_routes_or_use_slugs_as_ids() {
    let models_dev = json!({
        "private-relay":{"id":"private-relay","models":{
            "exact-local":{"id":"exact-local","canonical_model_id":"vendor/base"},
            "unrelated":{"id":"unrelated","canonical_model_id":"slug-only"},
            "vendor/base":{"id":"vendor/base","canonical_model_id":"vendor/other"},
            "vendor/base:free":{"id":"vendor/base:free","canonical_model_id":"vendor/base"}
        }},
        "openrouter":{"id":"openrouter","models":{
            "vendor/base":{"id":"vendor/base","canonical_model_id":"vendor/base"},
            "vendor/base:free":{"id":"vendor/base:free","canonical_model_id":"vendor/base"},
            "vendor/other":{"id":"vendor/other","canonical_model_id":"vendor/other"}
        }}
    });
    let router = json!({"data":[
        {"id":"vendor/base","name":"Paid name","description":"Same description","knowledge_cutoff":"2026-01",
            "canonical_slug":"slug-only","context_length":1000},
        {"id":"vendor/base:free","name":"Free name","description":"Same description","knowledge_cutoff":"2025-01",
            "context_length":2000},
        {"id":"vendor/other","name":"Other name"}
    ]});
    let snapshot = from_values(Some(&models_dev), Some(&router)).unwrap();
    let local = snapshot.get("private-relay", "exact-local").unwrap();
    assert_eq!(local.display_name, None);
    assert_eq!(local.description.as_deref(), Some("Same description"));
    assert_eq!(local.knowledge_cutoff, None);
    assert_eq!(local.context_window, Some(1000));
    assert_eq!(local.thinking_levels, Some(vec![]));
    assert_eq!(
        snapshot
            .get("private-relay", "unrelated")
            .unwrap()
            .description,
        None
    );
    let conflicting = snapshot.get("private-relay", "vendor/base").unwrap();
    assert_eq!(conflicting.display_name.as_deref(), Some("Other name"));
    assert_eq!(conflicting.description, None);
    assert_eq!(conflicting.knowledge_cutoff, None);
    assert_eq!(conflicting.context_window, None);
    let same = snapshot.get("private-relay", "vendor/base:free").unwrap();
    assert_eq!(same.display_name.as_deref(), Some("Free name"));
    assert_eq!(same.description.as_deref(), Some("Same description"));
    assert_eq!(same.knowledge_cutoff.as_deref(), Some("2025-01"));
}

#[test]
fn a_complete_public_record_replaces_bundled_guesses_and_has_no_invented_default() {
    let bundled = Snapshot::bundled().unwrap();
    assert!(
        !bundled
            .get("openai", "gpt-5.2")
            .unwrap()
            .thinking_levels
            .as_ref()
            .unwrap()
            .is_empty()
    );
    let models_dev = json!({"openai":{"id":"openai","models":{
        "gpt-5.2":{"id":"gpt-5.2","name":"Current record","reasoning":true,
            "tool_call":false,"structured_output":false,
            "modalities":{"input":["text"],"output":["text"]}}
    }}});
    let snapshot = from_values(Some(&models_dev), None).unwrap();
    let current = snapshot.get("openai", "gpt-5.2").unwrap();
    assert_eq!(current.display_name.as_deref(), Some("Current record"));
    assert_eq!(current.context_window, None);
    assert_eq!(current.thinking_levels, Some(vec![]));
    assert_eq!(current.default_thinking_level, None);
    assert_eq!(current.structured_output, Some(false));
    assert_eq!(current.capabilities.unwrap().function_calling, Some(false));
    assert_eq!(current.capabilities.unwrap().vision, Some(false));
    // An absent source/model retains the compiled floor, not a stale public-only row.
    assert_eq!(
        snapshot.get("anthropic", "claude-opus-4-8"),
        bundled.get("anthropic", "claude-opus-4-8")
    );
    let empty = from_values(Some(&json!({})), Some(&json!({"data":[]}))).unwrap();
    assert_eq!(
        empty.get("openai", "gpt-5.2"),
        bundled.get("openai", "gpt-5.2")
    );
}

#[test]
fn account_false_empty_and_unknown_defaults_override_public_facts() {
    let router = json!({"data":[{"id":"new/account-model","name":"Public label","context_length":8192,
        "supported_parameters":["tools","reasoning"],
        "reasoning":{"mandatory":false,"default_enabled":true,
            "supported_efforts":["high","low","none"],"default_effort":"high"}}]});
    let snapshot = from_values(None, Some(&router)).unwrap();
    let reported = ModelInfo {
        thinking_levels: Some(vec![]),
        default_thinking_level: None,
        structured_output: Some(false),
        context_window: Some(123),
        capabilities: Some(ModelCapabilities {
            reasoning: Some(false),
            function_calling: Some(false),
            ..Default::default()
        }),
        modalities: Some(ModelModalities {
            input: vec![],
            output: vec![],
        }),
        ..ModelInfo::new("new/account-model")
    };
    let effective = snapshot.resolve("openrouter", reported.clone(), None);
    assert_eq!(effective.display_name.as_deref(), Some("Public label"));
    assert_eq!(effective.thinking_levels, Some(vec![]));
    assert_eq!(effective.default_thinking_level, None);
    assert_eq!(effective.context_window, Some(123));
    assert_eq!(effective.structured_output, Some(false));
    assert_eq!(effective.capabilities, reported.capabilities);
    assert_eq!(effective.modalities, reported.modalities);
    let own_choices = ModelInfo {
        thinking_levels: Some(vec![Low, High]),
        ..ModelInfo::new("new/account-model")
    };
    let effective = snapshot.resolve("openrouter", own_choices, None);
    assert_eq!(effective.thinking_levels, Some(vec![Low, High]));
    assert_eq!(effective.default_thinking_level, None);
    let disabled = snapshot.resolve(
        "openrouter",
        ModelInfo {
            capabilities: Some(ModelCapabilities {
                reasoning: Some(false),
                ..Default::default()
            }),
            ..ModelInfo::new("new/account-model")
        },
        None,
    );
    assert_eq!(disabled.thinking_levels, None);
    assert_eq!(disabled.default_thinking_level, None);
    let inherited = snapshot.resolve("openrouter", ModelInfo::new("new/account-model"), None);
    assert_eq!(inherited.thinking_levels, Some(vec![High, Low, Off]));
    assert_eq!(inherited.default_thinking_level, Some(High));
}

#[test]
fn models_dev_efforts_are_explicit_and_native_toggle_is_not_a_gateway_effort() {
    let models_dev = json!({
        "deepseek":{"id":"deepseek","models":{"new-model":{
            "id":"new-model","reasoning":true,
            "reasoning_options":[{"type":"toggle"},{"type":"effort","values":["low","high","future",null]}]}}},
        "openrouter":{"id":"openrouter","models":{"vendor/toggle":{
            "id":"vendor/toggle","reasoning":true,"reasoning_options":[{"type":"toggle"}]}}},
        "openai":{"id":"openai","models":{"new-effort":{
            "id":"new-effort","reasoning":true,
            "reasoning_options":[{"type":"effort","values":["none","high"]},{"type":"budget_tokens","min":2048}]}}}
    });
    let snapshot = from_values(Some(&models_dev), None).unwrap();
    assert_eq!(
        snapshot
            .get("deepseek", "new-model")
            .unwrap()
            .thinking_levels,
        Some(vec![Low, High])
    );
    assert_eq!(
        snapshot
            .get("openrouter", "vendor/toggle")
            .unwrap()
            .thinking_levels,
        Some(vec![Off])
    );
    assert_eq!(
        snapshot
            .get("openai", "new-effort")
            .unwrap()
            .thinking_levels,
        Some(vec![Off, High])
    );
    assert_eq!(
        snapshot
            .get("openai", "new-effort")
            .unwrap()
            .default_thinking_level,
        None
    );
}

#[test]
fn malformed_sources_and_conflicting_exact_identities_are_not_empty_successes() {
    for models_dev in [
        json!(null),
        json!([]),
        json!({"x":{"id":"other","models":{}}}),
        json!({"x":{"id":"x","models":{"key":{"id":"other"}}}}),
    ] {
        assert!(from_values(Some(&models_dev), None).is_err());
    }
    for router in [
        json!(null),
        json!({}),
        json!({"data":[{}]}),
        json!({"data":[{"id":"same"},{"id":"same"}]}),
    ] {
        assert!(from_values(None, Some(&router)).is_err());
    }
    let snapshot = from_values(None, Some(&json!({"data":[{
        "id":"image/new","architecture":{"input_modalities":["text","file","image"],"output_modalities":["image"]}
    }]}))).unwrap();
    let model = snapshot.get("openrouter", "image/new").unwrap();
    assert_eq!(model.capabilities.unwrap().chat, Some(false));
    assert_eq!(model.capabilities.unwrap().image_generation, Some(true));
    assert_eq!(
        model.modalities.as_ref().unwrap().input,
        [ModelModality::Text, ModelModality::Image]
    );
}

#[test]
fn captured_public_fact_or_absence_never_uses_todays_fallback() {
    let record = ModelInfo {
        display_name: Some("Accepted public name".into()),
        context_window: Some(1234),
        ..ModelInfo::new("gpt-5.2")
    };
    let captured = Snapshot::for_model("openai", "gpt-5.2", Some(record.clone())).unwrap();
    assert_eq!(captured.get("openai", "gpt-5.2"), Some(&record));
    assert_eq!(captured.get("openrouter", "gpt-5.2"), None);
    let absent = Snapshot::for_model("openai", "gpt-5.2", None).unwrap();
    assert_eq!(absent.get("openai", "gpt-5.2"), None);
    assert_eq!(
        absent.resolve("openai", ModelInfo::new("gpt-5.2"), None),
        ModelInfo::new("gpt-5.2")
    );
    assert!(Snapshot::for_model("openai", "a-different-model", Some(record)).is_err());
}

#[tokio::test]
async fn explicit_refresh_enqueues_synchronously_and_reports_the_owner_receipt() {
    let catalog = super::Catalog::new(Snapshot::bundled().unwrap());
    // A standalone embedding returns an already completed cached receipt.
    catalog.request_refresh().unwrap().await.unwrap().unwrap();
    let mut requests = catalog.attach_refresh();
    let completed = catalog.request_refresh().unwrap();
    requests
        .recv()
        .await
        .unwrap()
        .send(Err("refresh kept the previous valid source".into()))
        .unwrap();
    assert_eq!(
        completed.await.unwrap(),
        Err("refresh kept the previous valid source".into())
    );
    drop(requests);
    assert!(catalog.request_refresh().is_err());
    let mut replacement = catalog.attach_refresh();
    let completed = catalog.request_refresh().unwrap();
    replacement.recv().await.unwrap().send(Ok(())).unwrap();
    completed.await.unwrap().unwrap();
}

#[test]
fn raw_sources_resolve_decoded_duplicates_before_schema_validation() {
    use maka_agent_facts::public_catalog::PublicCatalogBody;
    let models = r#"{"x":null,"\u0078":{"id":1,"id":"x","models":null,"models":{"m":false,"\u006d":{"id":1,"id":"m","name":"Final","canonical_model_id":null}}}}"#;
    let router = r#"{"data":null,"\u0064ata":[{"id":null,"id":"raw/model","name":false,"name":"Final router"}]}"#;
    let raw_models = PublicCatalogBody::from_json(models.into()).unwrap();
    let raw_router = PublicCatalogBody::from_json(router.into()).unwrap();
    let actual = Snapshot::from_sources(Some(&raw_models), Some(&raw_router)).unwrap();
    let expected = from_values(
        Some(&serde_json::from_str(models).unwrap()),
        Some(&serde_json::from_str(router).unwrap()),
    )
    .unwrap();
    assert_eq!(actual.models, expected.models);
    assert_eq!(actual.shared, expected.shared);
    assert_eq!(
        actual.get("x", "m").unwrap().display_name.as_deref(),
        Some("Final")
    );
    assert_eq!(
        actual
            .get("openrouter", "raw/model")
            .unwrap()
            .display_name
            .as_deref(),
        Some("Final router")
    );
    for input in [
        r#"{"data":[],"data":null}"#,
        r#"{"data":[{"id":"same"},{"id":"same"}]}"#,
        r#"{"data":[{"id":"valid","id":false}]}"#,
    ] {
        let body = PublicCatalogBody::from_json(input.into()).unwrap();
        assert!(Snapshot::from_sources(None, Some(&body)).is_err());
    }
    let bad_model = PublicCatalogBody::from_json(
        r#"{"x":{"id":"x","models":{"m":{"id":"m","id":"other"}}}}"#.into(),
    )
    .unwrap();
    assert!(Snapshot::from_sources(Some(&bad_model), None).is_err());
    // Hidden JSON-invalid metadata cannot cross the validated input boundary.
    for input in [
        r#"{"x":1e,"x":{}}"#,
        r#"{"data":[],"unknown":"\ud800","unknown":null}"#,
    ] {
        assert!(PublicCatalogBody::from_json(input.into()).is_err());
    }
}

#[test]
fn raw_source_numeric_overflow_follows_value_acceptance_before_schema_validation() {
    use maka_agent_facts::public_catalog::PublicCatalogBody;
    let input =
        r#"{"x":1e400,"x":{"id":"x","models":{"m":{"id":"m","name":"Final","unknown":1e400}}}}"#;
    let expected = serde_json::from_str::<Value>(input);
    let body = PublicCatalogBody::from_json(input.into());
    assert_eq!(body.is_ok(), expected.is_ok());
    if let Ok(body) = body {
        assert_eq!(body.as_raw().get(), input);
        let actual = Snapshot::from_sources(Some(&body), None).unwrap();
        let expected = from_values(Some(&expected.unwrap()), None).unwrap();
        assert_eq!(actual.models, expected.models);
        assert_eq!(actual.shared, expected.shared);
        assert_eq!(
            actual.get("x", "m").unwrap().display_name.as_deref(),
            Some("Final")
        );
    }
}

#[test]
fn explicit_catalog_association_keeps_wire_identity_account_facts_and_captured_defaults() {
    use maka_agent_facts::configuration::{ApiProtocol, CatalogModelReference};
    let mut snapshot = Snapshot::bundled().unwrap();
    let reference = CatalogModelReference {
        provider: "catalog-provider".into(),
        model_id: "catalog-model".into(),
    };
    snapshot
        .models
        .entry(reference.provider.clone())
        .or_default()
        .insert(
            reference.model_id.clone(),
            ModelInfo {
                id: reference.model_id.clone(),
                display_name: Some("Catalog model".into()),
                context_window: Some(8192),
                input_limit: Some(6144),
                max_output_tokens: Some(2048),
                api_protocol: Some(ApiProtocol::AnthropicMessages),
                thinking_levels: Some(vec![High]),
                default_thinking_level: Some(High),
                supports_reasoning_summary: Some(true),
                capabilities: Some(ModelCapabilities {
                    vision: Some(true),
                    function_calling: Some(true),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
    let reported = ModelInfo {
        id: "custom-alias".into(),
        context_window: Some(4096),
        capabilities: Some(ModelCapabilities {
            vision: Some(false),
            ..Default::default()
        }),
        ..Default::default()
    };
    let effective = snapshot.resolve("openai-compatible", reported.clone(), Some(&reference));
    assert_eq!(effective.id, "custom-alias");
    assert_eq!(effective.context_window, Some(4096));
    assert_eq!(effective.max_output_tokens, Some(2048));
    assert_eq!(effective.capabilities.unwrap().vision, Some(false));
    assert_eq!(effective.capabilities.unwrap().function_calling, Some(true));
    assert_eq!(effective.api_protocol, None);
    assert_eq!(effective.thinking_levels, None);
    assert_eq!(effective.default_thinking_level, None);
    assert_eq!(effective.supports_reasoning_summary, None);
    let captured = Snapshot::for_model(
        "openai-compatible",
        "custom-alias",
        snapshot
            .model_base("openai-compatible", "custom-alias", Some(&reference))
            .map(std::borrow::Cow::into_owned),
    )
    .unwrap();
    snapshot
        .models
        .get_mut(&reference.provider)
        .unwrap()
        .get_mut(&reference.model_id)
        .unwrap()
        .max_output_tokens = Some(1024);
    assert_eq!(
        snapshot
            .resolve("openai-compatible", reported.clone(), Some(&reference))
            .max_output_tokens,
        Some(1024)
    );
    let missing = CatalogModelReference {
        provider: reference.provider,
        model_id: "removed-model".into(),
    };
    assert_eq!(
        snapshot.resolve("openai-compatible", reported.clone(), Some(&missing)),
        reported
    );
    assert_eq!(
        captured.resolve("openai-compatible", reported.clone(), Some(&missing)),
        effective
    );
    assert_eq!(
        captured.resolve("openai-compatible", reported.clone(), None),
        effective
    );
    assert_eq!(
        snapshot.resolve("openai-compatible", reported.clone(), None),
        reported
    );
    let absent = Snapshot::for_model("openai-compatible", "custom-alias", None).unwrap();
    assert_eq!(
        absent.resolve("openai-compatible", reported.clone(), Some(&missing)),
        reported
    );
}
