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

fn system_permission_request() -> Value {
    json!({
        "kind": "system_permission",
        "toolUseId": "tool_123",
        "grants": ["accessibility", "screen_recording"],
        "application": "Maka Host"
    })
}

#[test]
fn system_permission_request_round_trips_and_validates_grants_and_application() {
    let request: InteractionRequest = serde_json::from_value(system_permission_request()).unwrap();
    assert_eq!(
        request,
        InteractionRequest::SystemPermission {
            tool_use_id: "tool_123".into(),
            grants: vec![
                SystemPermissionGrant::Accessibility,
                SystemPermissionGrant::ScreenRecording
            ],
            application: "Maka Host".into(),
        }
    );
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        system_permission_request()
    );
    let mut single = system_permission_request();
    single["grants"] = json!(["screen_recording"]);
    assert!(serde_json::from_value::<InteractionRequest>(single).is_ok());

    for grants in [
        json!([]),
        json!(["accessibility", "accessibility"]),
        json!(["microphone"]),
        json!(null),
    ] {
        let mut input = system_permission_request();
        input["grants"] = grants;
        assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    }
    for application in [
        json!(""),
        json!(" "),
        json!(" Maka Host"),
        json!("Maka\nHost"),
        json!("Maka\0Host"),
        json!(null),
    ] {
        let mut input = system_permission_request();
        input["application"] = application;
        assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    }
    let mut input = system_permission_request();
    input["toolUseId"] = json!("");
    assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    let mut input = system_permission_request();
    input["extra"] = json!(true);
    assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
    let mut input = system_permission_request();
    input.as_object_mut().unwrap().remove("application");
    assert!(serde_json::from_value::<InteractionRequest>(input).is_err());
}

#[test]
fn system_permission_cancel_closes_as_producer_cancelled_only_for_its_request() {
    let answer: InteractionAnswer =
        serde_json::from_value(json!({"kind": "system_permission_cancel"})).unwrap();
    assert_eq!(answer, InteractionAnswer::SystemPermissionCancel {});
    assert_eq!(
        serde_json::to_value(&answer).unwrap(),
        json!({"kind": "system_permission_cancel"})
    );
    assert!(
        serde_json::from_value::<InteractionAnswer>(
            json!({"kind": "system_permission_cancel", "extra": 1})
        )
        .is_err()
    );
    let outcome = answer.clone().into_outcome(7);
    assert_eq!(
        outcome,
        InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            committed_at: 7,
        }
    );
    assert!(answer.matches_outcome(&outcome));
    assert!(
        !answer.matches_outcome(&InteractionOutcome::SystemPermissionGranted { committed_at: 7 })
    );

    let request: InteractionRequest = serde_json::from_value(system_permission_request()).unwrap();
    let computer_app: InteractionRequest = serde_json::from_value(computer_app_request()).unwrap();
    assert_eq!(answer.validate_for_request(&request), Ok(()));
    assert!(answer.validate_for_request(&computer_app).is_err());
    assert!(
        InteractionAnswer::ComputerAppCancel {}
            .validate_for_request(&request)
            .is_err()
    );
}

#[test]
fn system_permission_granted_is_producer_committed_and_only_for_its_request() {
    let outcome: InteractionOutcome =
        serde_json::from_value(json!({"kind": "system_permission_granted", "committedAt": 42}))
            .unwrap();
    assert_eq!(
        outcome,
        InteractionOutcome::SystemPermissionGranted { committed_at: 42 }
    );
    assert_eq!(outcome.committed_at(), 42);
    assert_eq!(
        serde_json::to_value(&outcome).unwrap(),
        json!({"kind": "system_permission_granted", "committedAt": 42})
    );
    for invalid in [
        json!({"kind": "system_permission_granted"}),
        json!({"kind": "system_permission_granted", "committedAt": 42, "grants": []}),
        json!({"kind": "system_permission_granted", "committedAt": MAX_SAFE_INTEGER + 1}),
    ] {
        assert!(serde_json::from_value::<InteractionOutcome>(invalid).is_err());
    }
    assert!(
        serde_json::from_value::<InteractionAnswer>(json!({"kind": "system_permission_granted"}))
            .is_err(),
        "no user answer may claim the grant"
    );

    let request: InteractionRequest = serde_json::from_value(system_permission_request()).unwrap();
    let computer_app: InteractionRequest = serde_json::from_value(computer_app_request()).unwrap();
    assert_eq!(outcome.validate_for_request(&request), Ok(()));
    assert!(outcome.validate_for_request(&computer_app).is_err());
    let question: InteractionRequest = serde_json::from_value(json!({
        "kind": "question",
        "toolUseId": "tool_123",
        "questions": [{"question": "Continue?", "options": [{"label": "Yes"}, {"label": "No"}]}]
    }))
    .unwrap();
    assert!(outcome.validate_for_request(&question).is_err());
    assert_eq!(
        InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            committed_at: 1,
        }
        .validate_for_request(&request),
        Ok(())
    );
    assert!(
        InteractionOutcome::ComputerAppDecision {
            decision: ComputerAppDecision::Once,
            committed_at: 1,
        }
        .validate_for_request(&request)
        .is_err()
    );
}
