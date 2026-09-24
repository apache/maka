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
use maka_protocol::Operation;
use maka_protocol::configuration::*;
use serde_json::{Value, json};
const ID: &str = "11111111-1111-4111-8111-111111111111";
fn create() -> Value {
    json!({"expectedCatalogRevision":0,"connection":{"slug":"local-fixture","name":"Local fixture",
        "provider":{"packageId":"external.provider","entryId":"entry","scope":"profile","name":"custom"},
        "configuration":{"endpoint":" provider-owned value ","deployment":{"region":"local"}},
        "enabled":true,"enabledModelIds":["fixture-model"]}})
}
fn secret() -> Value {
    json!({"locator":{"scope":"network_proxy","kind":"password"},"expected":null,"secret":"fixture-secret"})
}
#[test]
fn connection_input_preserves_opaque_configuration_and_three_state_updates() {
    let input = decode_create_connection_input(&create()).unwrap();
    assert_eq!(
        input.connection.configuration,
        create()["connection"]["configuration"]
    );
    let mut input = json!({"expected":{"connectionId":ID,"revision":1},"changes":{"name":"","configuration":{},"enabled":true,"enabledModelIds":["m"]}});
    assert!(matches!(
        decode_update_connection_input(&input)
            .unwrap()
            .changes
            .model_overrides,
        Patch::Keep
    ));
    input["changes"]["modelOverrides"] = Value::Null;
    assert!(matches!(
        decode_update_connection_input(&input)
            .unwrap()
            .changes
            .model_overrides,
        Patch::Clear
    ));
    input["changes"]["modelOverrides"] = json!({"m":{
        "thinkingLevels":["off","minimal","max","ultra"],"serviceTier":"fast"
    }});
    let Patch::Set(profiles) = decode_update_connection_input(&input)
        .unwrap()
        .changes
        .model_overrides
    else {
        panic!("profile was not set")
    };
    use maka_runtime::{configuration::RelayServiceTier, execution::ThinkingLevel};
    assert_eq!(
        profiles["m"].thinking_levels,
        Some(vec![
            ThinkingLevel::Off,
            ThinkingLevel::Minimal,
            ThinkingLevel::Max,
            ThinkingLevel::Ultra
        ])
    );
    assert_eq!(profiles["m"].service_tier, Some(RelayServiceTier::Fast));
    assert_eq!(
        serde_json::to_value(profiles).unwrap(),
        input["changes"]["modelOverrides"]
    );
}
#[test]
fn connection_input_rejects_unknown_fields_and_semantic_boundaries() {
    for (key, value) in [
        ("provider", json!({"name":"missing-owner"})),
        ("slug", json!("x")),
        ("slug", json!("-invalid")),
        ("configuration", Value::Null),
        ("configuration", json!({"value":"x".repeat(65536)})),
        ("enabledModelIds", json!(["x", "x"])),
        ("enabledModelIds", json!(vec!["m"; 513])),
        ("apiKey", json!("never-public")),
        (
            "modelOverrides",
            json!({"absent":{"capabilities":{"vision":true}}}),
        ),
        (
            "modelOverrides",
            json!({"fixture-model":{"thinkingLevels":["high","high"]}}),
        ),
        (
            "modelOverrides",
            json!({"fixture-model":{"thinkingLevels":["turbo"]}}),
        ),
        (
            "modelOverrides",
            json!({"fixture-model":{"serviceTier":"priority"}}),
        ),
        ("requestBodyOverlay", json!({"constructor":{}})),
    ] {
        let mut value_in = create();
        value_in["connection"][key] = value;
        assert!(
            decode_create_connection_input(&value_in).is_err(),
            "accepted {key}"
        );
    }
    for rev in [json!(-1), json!(1.5), json!(9007199254740992u64)] {
        let mut input = create();
        input["expectedCatalogRevision"] = rev;
        assert!(decode_create_connection_input(&input).is_err());
    }
}
#[test]
fn vault_requires_string_material_and_normalizes_valid_custom_headers() {
    let mut input = secret();
    input["secret"] = json!({"password":"CANARY-SECRET"});
    assert!(decode_set_credential_input(&input).is_err());
    input = secret();
    input["locator"] = json!({"scope":"connection","connectionId":ID,"kind":"request_headers"});
    input["secret"] = json!("{\" X-Fixture \":\"value\"}");
    assert_eq!(
        decode_set_credential_input(&input).unwrap().secret,
        "{\"X-Fixture\":\"value\"}"
    );
    for header in [
        "{\"Authorization\":\"CANARY-SECRET\"}",
        "{\"x-fixture\":\"x\",\"X-Fixture\":\"y\"}",
        "{\"x-fixture\":\"bad\\nvalue\"}",
        "{\"x-fixture\":\"\"}",
    ] {
        input["secret"] = json!(header);
        assert!(decode_set_credential_input(&input).is_err());
    }
}
#[test]
fn vault_rejects_missing_basis_invalid_locator_and_byte_overflow() {
    let mut missing = secret();
    missing.as_object_mut().unwrap().remove("expected");
    assert!(decode_set_credential_input(&missing).is_err());
    for locator in [
        json!({"scope":"connection","connectionId":"invalid","kind":"request_headers"}),
        json!({"scope":"web_search","provider":"google","kind":"api_key"}),
        json!({"scope":"network_proxy","kind":"api_key"}),
        json!({"scope":"connection","connectionId":ID,"kind":"provider"}),
        json!({"scope":"connection","connectionId":ID,"kind":"request_headers","secret":"CANARY"}),
    ] {
        let mut input = secret();
        input["locator"] = locator;
        assert!(decode_set_credential_input(&input).is_err());
    }
    let mut input = secret();
    input["secret"] = json!("é".repeat(5121));
    assert!(decode_set_credential_input(&input).is_err());
    input["secret"] = json!("é".repeat(5120));
    assert!(decode_set_credential_input(&input).is_ok());
}
#[test]
fn wire_results_require_metadata_and_operation_specific_shapes() {
    let committed = json!({"kind":"committed","catalogRevision":1,"connection":{"connectionId":ID,"revision":1}});
    assert!(decode_catalog_mutation_result(Operation::ConnectionCatalogCreate, &committed).is_ok());
    assert!(
        decode_catalog_mutation_result(Operation::ConnectionCatalogRemove, &committed).is_err()
    );
    assert!(
        decode_catalog_mutation_result(
            Operation::ConnectionCatalogCreate,
            &json!({"kind":"committed","catalogRevision":1})
        )
        .is_err()
    );
    let absent = json!({"kind":"status","status":{"locator":{"scope":"connection","connectionId":ID,"kind":"provider"},"configured":false,"credentialId":null,"revision":null,"updatedAt":null}});
    assert!(decode_credential_query_result(&absent).is_ok());
    let mut bad = absent.clone();
    bad["status"]["revision"] = json!(1);
    assert!(decode_credential_query_result(&bad).is_err());
    bad = absent;
    bad["status"].as_object_mut().unwrap().remove("updatedAt");
    assert!(decode_credential_query_result(&bad).is_err());
}
#[test]
fn credential_states_preserve_wire_shape_and_reject_partial_metadata() {
    use maka_runtime::configuration::{CredentialState, CredentialStatus};
    let fields = [
        ("credentialId", json!(ID)),
        ("revision", json!(1)),
        ("updatedAt", json!(0)),
    ];
    for configured in [false, true] {
        for mask in 0..8 {
            let mut wire = json!({
                "locator":{"scope":"network_proxy","kind":"password"},
                "configured":configured
            });
            for (index, (key, value)) in fields.iter().enumerate() {
                wire[key] = if mask & (1 << index) != 0 {
                    value.clone()
                } else {
                    Value::Null
                };
            }
            let valid = if configured { mask == 7 } else { mask == 0 };
            let decoded = serde_json::from_value::<CredentialStatus>(wire.clone());
            assert_eq!(decoded.is_ok(), valid, "{wire}");
            let query = json!({"kind":"status","status":wire});
            assert_eq!(decode_credential_query_result(&query).is_ok(), valid);
            let mutation = json!({"kind":"committed","vaultRevision":1,"status":wire});
            assert_eq!(
                decode_credential_mutation_result(Operation::CredentialVaultSet, &mutation).is_ok(),
                valid
            );
            if let Ok(status) = decoded {
                assert_eq!(
                    matches!(status.state, CredentialState::Configured { .. }),
                    configured
                );
                assert_eq!(serde_json::to_value(status).unwrap(), wire);
                for key in ["configured", "credentialId", "revision", "updatedAt"] {
                    let mut missing = wire.clone();
                    missing.as_object_mut().unwrap().remove(key);
                    assert!(
                        serde_json::from_value::<CredentialStatus>(missing.clone()).is_err(),
                        "{missing}"
                    );
                    assert!(
                        decode_credential_query_result(&json!({"kind":"status","status":missing}))
                            .is_err()
                    );
                }
                let mut unknown = wire;
                unknown["secret"] = json!("CANARY-SECRET");
                assert!(serde_json::from_value::<CredentialStatus>(unknown).is_err());
            }
        }
    }
}
#[test]
fn persisted_model_validation_rejects_unknown_facts() {
    use maka_runtime::configuration::validation::connection_model;
    assert!(connection_model(&json!({"id":"m","capabilities":{"chat":true},"modalities":{"input":["pdf"],"output":["video"]}})).is_ok());
    for bad in [
        json!({"id":"m","secret":"x"}),
        json!({"id":"m","capabilities":{"invented":true}}),
        json!({"id":"m","contextWindow":0}),
        json!({"id":"m","modalities":{"input":["binary"],"output":[]}}),
    ] {
        assert!(connection_model(&bad).is_err());
    }
}
