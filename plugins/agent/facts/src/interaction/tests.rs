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
use serde_json::{Value, json};

fn computer_app_request() -> Value {
    json!({
        "kind": "computer_app",
        "toolUseId": "tool_123",
        "nativeOperationId": "018f7c44-c332-7140-bef8-58a066669ab4",
        "target": {
            "providerId": "computer",
            "contractId": "desktop",
            "serverId": "workspace_computer",
            "toolName": "cua",
            "capability": "computer_use",
            "scope": {
                "kind": "computer_app",
                "platform": "macos",
                "applicationId": "org.example.Editor"
            }
        },
        "basis": {
            "boundaryRevision": 2,
            "binding": {
                "id": "018f7c44-c332-7140-bef8-58a066669ab5",
                "permissionEpoch": 3
            }
        },
        "display": {
            "name": "Example Editor",
            "appPath": "/Volumes/Work/Example Editor.app",
            "risk": "high",
            "warning": "This application can access private documents."
        },
        "allowAlways": true,
        "authorityRevision": 0
    })
}

#[test]
fn computer_app_consent_roundtrips_trusted_metadata_and_typed_lifetimes() {
    let input = computer_app_request();
    let request: InteractionRequest = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(&request).unwrap(), input);
    for (wire, decision) in [
        ("once", ComputerAppDecision::Once),
        ("session", ComputerAppDecision::Session),
        ("always", ComputerAppDecision::Always),
        ("deny", ComputerAppDecision::Deny),
    ] {
        let answer: InteractionAnswer =
            serde_json::from_value(json!({"kind": "computer_app", "decision": wire})).unwrap();
        assert_eq!(answer, InteractionAnswer::ComputerApp { decision });
        assert_eq!(answer.validate_for_request(&request), Ok(()));
        let outcome = answer.clone().into_outcome(42);
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            json!({"kind": "computer_app_decision", "decision": wire, "committedAt": 42})
        );
        assert_eq!(outcome.validate_for_request(&request), Ok(()));
        assert!(answer.matches_outcome(&outcome));
        assert_eq!(outcome.committed_at(), 42);
        assert_eq!(
            serde_json::from_value::<InteractionOutcome>(serde_json::to_value(&outcome).unwrap())
                .unwrap(),
            outcome
        );
    }
}

#[test]
fn computer_app_persistence_must_be_offered_and_cannot_use_generic_decisions() {
    let mut input = computer_app_request();
    input["allowAlways"] = json!(false);
    let request: InteractionRequest = serde_json::from_value(input.clone()).unwrap();
    let answer = InteractionAnswer::ComputerApp {
        decision: ComputerAppDecision::Always,
    };
    assert_eq!(
        answer.validate_for_request(&request),
        Err("Persistent computer application approval was not offered")
    );
    assert_eq!(
        answer.into_outcome(42).validate_for_request(&request),
        Err("Persistent computer application approval was not offered")
    );
    for decision in [
        ComputerAppDecision::Once,
        ComputerAppDecision::Session,
        ComputerAppDecision::Deny,
    ] {
        assert_eq!(
            InteractionAnswer::ComputerApp { decision }.validate_for_request(&request),
            Ok(())
        );
    }
    assert_eq!(
        InteractionAnswer::ClientCapability {
            decision: Decision::Allow
        }
        .validate_for_request(&request),
        Err("Interaction answer does not match request")
    );
    assert_eq!(
        InteractionOutcome::ClientCapabilityDecision {
            decision: Decision::Allow,
            committed_at: 42
        }
        .validate_for_request(&request),
        Err("Interaction outcome does not match request")
    );
    let generic = json!({
        "kind": "client_capability", "toolUseId": "tool_123",
        "target": input["target"], "basis": input["basis"]
    });
    assert!(serde_json::from_value::<InteractionRequest>(generic).is_err());
    for kind in ["service_approval", "client_capability"] {
        assert!(
            serde_json::from_value::<InteractionAnswer>(json!({"kind": kind, "decision": "once"}))
                .is_err()
        );
    }
    assert!(
        serde_json::from_value::<InteractionAnswer>(
            json!({"kind": "computer_app", "decision": "allow"})
        )
        .is_err()
    );
}

#[test]
fn computer_app_scope_requires_exact_identity_and_supported_capability() {
    for application_id in ["", " ", " org.example.Editor", "org.example.Editor\0"] {
        let mut input = computer_app_request();
        input["target"]["scope"]["applicationId"] = json!(application_id);
        assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    }
    let identity = ComputerAppIdentity {
        platform: ComputerAppPlatform::Macos,
        application_id: "org.example.Editor".into(),
    };
    assert_eq!(identity.validate(), Ok(()));
    assert_eq!(
        serde_json::to_value(identity).unwrap(),
        json!({"platform": "macos", "applicationId": "org.example.Editor"})
    );
    for capability in [
        "browser",
        "browser_download",
        "desktop_mcp",
        "mcp",
        "computer_audio",
    ] {
        let mut input = computer_app_request();
        input["target"]["capability"] = json!(capability);
        assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    }
    let mut input = computer_app_request();
    input["target"]["scope"] = json!({"kind": "capability"});
    assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    let mut input = computer_app_request();
    input["target"]["scope"]["platform"] = json!("linux");
    assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
}

#[test]
fn computer_app_operation_and_revision_are_canonical_source_evidence() {
    for field in ["toolUseId", "nativeOperationId"] {
        for identity in ["", " ", "operation/other", "operation:other", "operation\0"] {
            let mut input = computer_app_request();
            input[field] = json!(identity);
            assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
        }
    }
    let mut input = computer_app_request();
    input["authorityRevision"] = json!(9_007_199_254_740_991_u64);
    assert!(serde_json::from_value::<InteractionRequest>(input.clone()).is_ok());
    input["authorityRevision"] = json!(9_007_199_254_740_992_u64);
    assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    let mut input = computer_app_request();
    input["basis"]["boundaryRevision"] = json!(9_007_199_254_740_992_u64);
    assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    let mut input = computer_app_request();
    input["basis"]["binding"]["id"] = json!("00000000-0000-0000-0000-000000000000");
    assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    assert!(
        serde_json::from_value::<InteractionOutcome>(json!({
            "kind": "computer_app_decision", "decision": "session",
            "committedAt": 9_007_199_254_740_992_u64
        }))
        .is_err()
    );
}

#[test]
fn computer_app_display_uses_macos_paths_on_any_host_and_rejects_empty_copy() {
    for path in [
        "",
        "Example.app",
        "C:\\Example.app",
        "/Applications/Example\0.app",
    ] {
        let mut input = computer_app_request();
        input["display"]["appPath"] = json!(path);
        assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    }
    for (field, value) in [
        ("name", " "),
        ("name", "Editor\0"),
        ("warning", ""),
        ("warning", "Private\0"),
    ] {
        let mut input = computer_app_request();
        input["display"][field] = json!(value);
        assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    }
    let mut input = computer_app_request();
    input["display"]["risk"] = Value::Null;
    input["display"]["warning"] = Value::Null;
    let request: InteractionRequest = serde_json::from_value(input.clone()).unwrap();
    let InteractionRequest::ComputerApp { display, .. } = &request else {
        panic!("expected application consent");
    };
    assert_eq!(display.risk, None);
    assert_eq!(serde_json::to_value(request).unwrap(), input);
}

#[test]
fn computer_app_wire_rejects_missing_or_unrecognized_authority_fields() {
    for field in [
        "toolUseId",
        "nativeOperationId",
        "target",
        "basis",
        "display",
        "allowAlways",
        "authorityRevision",
    ] {
        let mut input = computer_app_request();
        input.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    }
    for pointer in ["", "/display", "/target/scope"] {
        let mut input = computer_app_request();
        input.pointer_mut(pointer).unwrap()["approved"] = json!(true);
        assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    }
    assert!(
        serde_json::from_value::<InteractionAnswer>(
            json!({"kind": "computer_app", "decision": "session", "approved": true})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<InteractionOutcome>(json!({
            "kind": "computer_app_decision", "decision": "session",
            "committedAt": 42, "approved": true
        }))
        .is_err()
    );
    let request: InteractionRequest = serde_json::from_value(computer_app_request()).unwrap();
    assert_eq!(
        InteractionOutcome::Closure {
            reason: ClosureReason::TurnTerminal,
            committed_at: 42
        }
        .validate_for_request(&request),
        Ok(())
    );
    assert_eq!(
        InteractionOutcome::Closure {
            reason: ClosureReason::TimedOut,
            committed_at: 42
        }
        .validate_for_request(&request),
        Err("Human interactions have no response deadline")
    );
}

#[test]
fn computer_app_dismissal_closes_only_the_original_app_request_without_authority() {
    let request: InteractionRequest = serde_json::from_value(computer_app_request()).unwrap();
    let answer: InteractionAnswer =
        serde_json::from_value(json!({"kind": "computer_app_cancel"})).unwrap();
    assert_eq!(answer.validate_for_request(&request), Ok(()));
    assert_eq!(
        serde_json::to_value(&answer).unwrap(),
        json!({"kind": "computer_app_cancel"})
    );
    let outcome = answer.clone().into_outcome(42);
    assert_eq!(
        serde_json::to_value(&outcome).unwrap(),
        json!({"kind": "closure", "reason": "producer_cancelled", "committedAt": 42})
    );
    assert_eq!(outcome.validate_for_request(&request), Ok(()));
    assert!(answer.matches_outcome(&outcome));
    assert!(
        !answer.matches_outcome(&InteractionOutcome::ComputerAppDecision {
            decision: ComputerAppDecision::Once,
            committed_at: 42,
        })
    );
    let mut legacy = computer_app_request()["target"].clone();
    legacy["scope"] = json!({"kind": "capability"});
    let legacy: InteractionRequest = serde_json::from_value(json!({
        "kind": "client_capability", "toolUseId": "original", "target": legacy
    }))
    .unwrap();
    assert_eq!(
        answer.validate_for_request(&legacy),
        Err("Interaction answer does not match request")
    );
    assert!(
        serde_json::from_value::<InteractionAnswer>(
            json!({"kind": "computer_app_cancel", "decision": "once"})
        )
        .is_err()
    );
}

#[test]
fn computer_output_audio_consent_uses_the_existing_session_capability_contract() {
    let mut target = computer_app_request()["target"].clone();
    target["capability"] = json!("computer_audio");
    target["scope"] = json!({"kind": "capability"});
    let request: InteractionRequest = serde_json::from_value(json!({
        "kind": "client_capability", "toolUseId": "output_audio", "target": target
    }))
    .unwrap();
    let answer: InteractionAnswer = serde_json::from_value(json!({
        "kind": "client_capability", "decision": "allow"
    }))
    .unwrap();
    assert_eq!(answer.validate_for_request(&request), Ok(()));
    assert_eq!(
        serde_json::to_value(answer.into_outcome(42)).unwrap(),
        json!({"kind": "client_capability_decision", "decision": "allow", "committedAt": 42})
    );
    assert_eq!(
        InteractionAnswer::ComputerApp {
            decision: ComputerAppDecision::Always,
        }
        .validate_for_request(&request),
        Err("Interaction answer does not match request")
    );
}

#[test]
fn computer_app_activity_retains_exact_source_and_trusted_display() {
    let request = computer_app_request();
    let input = json!({
        "invocation":{"session_id":"session","turn_id":"turn","run_id":"run","invocation_id":"invocation"},
        "operationId":"observed-native-effect",
        "target":request["target"],"display":request["display"]
    });
    let activity: ComputerAppActivity = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(activity.validate(), Ok(()));
    assert_eq!(serde_json::to_value(&activity).unwrap(), input);
    for field in ["session_id", "turn_id", "run_id", "invocation_id"] {
        let mut invalid = input.clone();
        invalid["invocation"][field] = json!("foreign/source");
        assert_eq!(
            serde_json::from_value::<ComputerAppActivity>(invalid)
                .unwrap()
                .validate(),
            Err("Invalid interaction entity identity")
        );
    }
    let mut invalid = activity.clone();
    invalid.operation_id.clear();
    assert_eq!(
        invalid.validate(),
        Err("Invalid interaction entity identity")
    );
    let mut invalid = activity;
    invalid.target.scope = GrantScope::Capability {};
    assert_eq!(
        invalid.validate(),
        Err("Computer application activity requires an application scope")
    );
    let mut invalid = input;
    invalid["stopped"] = json!(true);
    assert!(serde_json::from_value::<ComputerAppActivity>(invalid).is_err());
}

#[test]
fn browser_download_consent_is_origin_scoped_and_distinct_from_page_access() {
    let mut input = computer_app_request()["target"].clone();
    input["capability"] = json!("browser_download");
    input["scope"] = json!({"kind":"browser_origin", "origin":"https://download.example"});
    let target: GrantTarget = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(target.validate(), Ok(()));
    assert_eq!(target.capability, GrantCapability::BrowserDownload);
    let request: InteractionRequest = serde_json::from_value(json!({
        "kind":"client_capability", "toolUseId":"original_download", "target":input
    }))
    .unwrap();
    let answer = InteractionAnswer::ClientCapability {
        decision: Decision::Allow,
    };
    assert_eq!(answer.validate_for_request(&request), Ok(()));
    let mut read = target.clone();
    read.capability = GrantCapability::Browser;
    assert_ne!(
        target, read,
        "page access cannot stand in for file transfer consent"
    );
    for scope in [
        json!({"kind":"capability"}),
        json!({"kind":"browser_origin", "origin":"https://download.example/private"}),
        json!({"kind":"browser_origin", "origin":"file:///private"}),
    ] {
        let mut invalid = serde_json::to_value(&target).unwrap();
        invalid["scope"] = scope;
        assert!(
            serde_json::from_value::<GrantTarget>(invalid)
                .unwrap()
                .validate()
                .is_err()
        );
    }
}

// Append inside plugins/agent/facts/src/interaction/tests.rs. Uses the real
// canonical request decoder, decisions and serializer on every build host.
#[test]
fn windows_app_consent_uses_the_existing_typed_interaction_and_absolute_path_boundary() {
    for path in [
        r"C:\Program Files\Fixture\fixture.exe",
        r"\\server\share\fixture.exe",
        r"\\?\C:\Fixture\fixture.exe",
    ] {
        let mut input = computer_app_request();
        input["target"]["scope"]["platform"] = json!("windows");
        input["target"]["scope"]["applicationId"] = json!(path);
        input["display"]["appPath"] = json!(path);
        input["allowAlways"] = json!(false);
        let request: InteractionRequest = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(&request).unwrap(), input);
        for decision in [ComputerAppDecision::Once, ComputerAppDecision::Session] {
            assert_eq!(
                InteractionAnswer::ComputerApp { decision }.validate_for_request(&request),
                Ok(())
            );
        }
        assert!(
            InteractionAnswer::ComputerApp {
                decision: ComputerAppDecision::Always
            }
            .validate_for_request(&request)
            .is_err()
        );
        for path in [
            r"C:fixture.exe",
            r"\fixture.exe",
            r"\\?\UNC",
            r"\\?\UNC\server",
            r"\\server\",
            "fixture.exe",
            "/Applications/Fixture.app",
            "C:\\bad\0.exe",
        ] {
            let mut invalid = input.clone();
            invalid["display"]["appPath"] = json!(path);
            assert!(
                serde_json::from_value::<InteractionRequest>(invalid).is_err(),
                "{path:?}"
            );
        }
    }
}
