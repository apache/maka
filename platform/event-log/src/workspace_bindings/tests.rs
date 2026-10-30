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

use serde_json::json;

async fn log() -> (tempfile::TempDir, EventLog) {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("state.sqlite"))
        .await
        .unwrap();
    (directory, log)
}

#[tokio::test]
async fn capability_t1_rejects_an_old_binding_even_when_numeric_boundary_matches() {
    use maka_agent_facts::{
        event::{CommitError, EventWrite, Fact, Invocation, RuntimeEvent},
        input::InvocationInput,
        interaction::{
            Decision, GrantCapability, GrantScope, GrantTarget, InteractionOutcome,
            InteractionRecord, InteractionRequest,
        },
        tool_call::ToolCallIdentity,
    };
    let (_directory, log) = log().await;
    let first = log
        .attach_workspace("owner_", &json!({"path":"/first"}))
        .await
        .unwrap();
    let second = log
        .attach_workspace("owner_", &json!({"path":"/second"}))
        .await
        .unwrap();
    log.create_session(
        "session",
        "create",
        &json!({"workspace":first,"boundary_revision":0}),
        1,
    )
    .await
    .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(&event(Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Message {
            content: "test".into(),
            source_messages: vec![],
            request_fingerprint: None,
        },
    }))
    .await
    .unwrap();
    let old = PermissionBasis {
        boundary_revision: 0,
        binding: BindingStamp {
            id: first.id,
            permission_epoch: 0,
        },
    };
    let target = GrantTarget {
        provider_id: "provider".into(),
        contract_id: "contract".into(),
        server_id: "browser".into(),
        tool_name: "navigate".into(),
        capability: GrantCapability::Browser,
        scope: GrantScope::BrowserOrigin {
            origin: "https://example.com".into(),
        },
    };
    let request = |id: &str, basis| InteractionRecord {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        request_id: id.into(),
        created_at: 2,
        outcome: None,
        request: InteractionRequest::ClientCapability {
            tool_use_id: "tool".into(),
            target: target.clone(),
            basis: Some(basis),
        },
    };
    log.establish_run_interaction(&invocation, &request("old", old))
        .await
        .unwrap();
    log.commit_interaction_outcome(
        "old",
        InteractionOutcome::ClientCapabilityDecision {
            decision: Decision::Allow,
            committed_at: 3,
        },
    )
    .await
    .unwrap();
    let current = log.get_session::<Value>("session").await.unwrap().unwrap();
    log.update_session_metadata::<Value, _>("session", current.revision, move |configuration| {
        configuration["workspace"] = serde_json::to_value(second)?;
        Ok(())
    })
    .await
    .unwrap();
    let dispatch = |id: &str| {
        event(Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: id.into(),
            call: ToolCallIdentity::standalone(format!("{id}-call")),
            name: "navigate".into(),
            input: json!({}),
        })
    };
    assert!(matches!(
        log.append_capability_dispatch(
            &[],
            &dispatch("old-dispatch"),
            std::slice::from_ref(&target),
            &old
        )
        .await,
        Err(CommitError::PermissionRevoked)
    ));
    assert!(
        log.client_capability_grant("session", &target)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        log.establish_run_interaction(&invocation, &request("stale", old))
            .await
            .is_err()
    );
    let new = PermissionBasis {
        binding: BindingStamp {
            id: second.id,
            permission_epoch: 0,
        },
        ..old
    };
    log.establish_run_interaction(&invocation, &request("new", new))
        .await
        .unwrap();
    log.commit_interaction_outcome(
        "new",
        InteractionOutcome::ClientCapabilityDecision {
            decision: Decision::Allow,
            committed_at: 4,
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        log.append_capability_dispatch(
            &[],
            &dispatch("still-old"),
            std::slice::from_ref(&target),
            &old
        )
        .await,
        Err(CommitError::PermissionRevoked)
    ));
    log.append_capability_dispatch(
        &[],
        &dispatch("new-dispatch"),
        std::slice::from_ref(&target),
        &new,
    )
    .await
    .unwrap();
    let facts = log.prefix(32, 65536).await.unwrap();
    assert_eq!(
        facts
            .events
            .iter()
            .filter(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
            .count(),
        1
    );
    log.close().await.unwrap();
}
