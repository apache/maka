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
use maka_agent_facts::configuration::{ModelCapabilities, ModelInfo, ModelModality};
use maka_agent_facts::execution::ThinkingLevel::High;
use serde_json::json;

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
                image_input: Some(maka_agent_facts::configuration::ImageInput {
                    max_width: Some(8192),
                    ..Default::default()
                }),
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
    assert_eq!(
        effective.image_input, None,
        "a catalog association cannot move another provider's route limits"
    );
    let same_provider_alias = snapshot
        .model_base("catalog-provider", "wire-alias", Some(&reference))
        .unwrap();
    assert_eq!(
        same_provider_alias.image_input.as_ref().unwrap().max_width,
        Some(8192),
        "same provider/API binding keeps declared limits despite a display/wire alias"
    );
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

#[test]
fn image_declarations_stay_exact_and_route_local() {
    let catalog = json!({"image-provider":{"id":"image-provider","models":{
        "exact-image":{"id":"exact-image","modalities":{"input":["text","image/png","image/avif"],"output":["text"]},
            "limit":{"request_bytes":12000000,"image":{"max_per_message":8,"max_per_request":12,"max_bytes":4000000,"min_width":16,"min_height":20,"max_width":8192,"max_height":4096}}},
        "generic-image":{"id":"generic-image","modalities":{"input":["image"],"output":["text"]}},
        "unknown":{"id":"unknown"}
    }}});
    let snapshot = from_values(Some(&catalog), None).unwrap();
    let model = snapshot.get("image-provider", "exact-image").unwrap();
    assert_eq!(model.capabilities.unwrap().vision, Some(true));
    assert_eq!(
        model.image_input,
        Some(maka_agent_facts::configuration::ImageInput {
            mime_types: Some(vec!["image/png".into(), "image/avif".into()]),
            max_per_message: Some(8),
            max_per_request: Some(12),
            max_bytes: Some(4000000),
            min_width: Some(16),
            min_height: Some(20),
            max_width: Some(8192),
            max_height: Some(4096),
            request_bytes: Some(12000000),
        })
    );
    assert_eq!(
        snapshot
            .get("image-provider", "generic-image")
            .unwrap()
            .image_input,
        None
    );
    assert_eq!(
        snapshot
            .get("image-provider", "unknown")
            .unwrap()
            .capabilities
            .unwrap()
            .vision,
        None
    );
    assert!(snapshot.get("openai-compatible", "exact-image").is_none());
}

#[test]
fn invalid_image_constraints_reject_catalog_without_inventing_defaults() {
    for limits in [
        json!({"max_bytes":-1}),
        json!({"max_width":1.5}),
        json!({"min_width":100,"max_width":50}),
    ] {
        let catalog =
            json!({"test":{"id":"test","models":{"m":{"id":"m","limit":{"image":limits}}}}});
        assert!(
            from_values(Some(&catalog), None).is_err(),
            "limits {limits}"
        );
    }
    let catalog = json!({"test":{"id":"test","models":{"m":{"id":"m","limit":{"image":{"max_per_request":0}}}}}});
    assert_eq!(
        from_values(Some(&catalog), None)
            .unwrap()
            .get("test", "m")
            .unwrap()
            .image_input
            .as_ref()
            .unwrap()
            .max_per_request,
        Some(0)
    );
}

#[test]
fn live_gateway_mime_and_exact_route_limits_survive_catalog_merge() {
    let catalog = json!({"openrouter":{"id":"openrouter","models":{
        "vendor/image":{"id":"vendor/image","limit":{"image":{"max_width":8192}}}
    }}});
    let router = json!({"data":[{"id":"vendor/image","architecture":{"input_modalities":["text","image/png"],"output_modalities":["text"]}}]});
    let snapshot = from_values(Some(&catalog), Some(&router)).unwrap();
    let image = snapshot
        .get("openrouter", "vendor/image")
        .unwrap()
        .image_input
        .as_ref()
        .unwrap();
    assert_eq!(image.max_width, Some(8192));
    assert_eq!(
        image.mime_types.as_deref(),
        Some(["image/png".to_owned()].as_slice())
    );
    assert_eq!(
        snapshot
            .get("openai-compatible", "vendor/image")
            .unwrap()
            .image_input,
        None
    );
    let explicit = maka_agent_facts::configuration::ModelOverride {
        image_input: Some(maka_agent_facts::configuration::ImageInput::default()),
        ..Default::default()
    };
    assert_eq!(
        explicit
            .apply(snapshot.get("openrouter", "vendor/image").unwrap())
            .image_input,
        explicit.image_input
    );
}
