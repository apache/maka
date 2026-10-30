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

use maka_agent_facts::interaction::Decision;
use maka_agent_facts::interaction::GrantCapability;
use maka_agent_facts::interaction::GrantScope;
use maka_agent_facts::interaction::GrantTarget;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use maka_agent_facts::workspace::{BindingStamp, PermissionBasis};
use maka_event_log::EventLog;
use sqlx::Connection;

async fn bound_session(log: &EventLog, session: &str, boundary_revision: u64) -> PermissionBasis {
    let reference = log
        .attach_workspace("permissions", &serde_json::json!({"path":"/workspace"}))
        .await
        .unwrap();
    log.create_session(
        session,
        "create",
        &serde_json::json!({"workspace":reference,"boundary_revision":boundary_revision}),
        1,
    )
    .await
    .unwrap();
    PermissionBasis {
        boundary_revision,
        binding: BindingStamp {
            id: reference.id,
            permission_epoch: reference.permission_epoch_at_attach,
        },
    }
}

#[tokio::test]
async fn permission_receipts_preserve_partial_scope_and_revoke_by_boundary_revision() {
    use maka_agent_facts::event::Invocation;
    use maka_agent_facts::interaction::PermissionRequest;
    use maka_sandbox::{
        Network,
        filesystem::{Access, Rule},
        grant,
    };
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("permissions.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let basis = bound_session(&log, "session", 4).await;
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let requested = grant::Permissions {
        filesystem: vec![Rule::subtree(temp.path(), Access::Write)],
        network: Network::Allowed,
    };
    let partial = grant::Permissions {
        filesystem: vec![Rule::exact(temp.path().join("result"), Access::Read)],
        network: Network::Denied,
    };
    let make_request = |id: &str| InteractionRecord {
        request: InteractionRequest::Permissions {
            tool_use_id: Some("tool-use".into()),
            basis,
            request: PermissionRequest {
                reason: "Read the requested result".into(),
                command: None,
                permissions: requested.clone(),
            },
        },
        ..request(id)
    };
    let mut complete = make_request("complete_receipt");
    let InteractionRequest::Permissions { request, .. } = &mut complete.request else {
        unreachable!()
    };
    request.permissions.filesystem = (0..32)
        .map(|index| {
            Rule::exact(
                temp.path().join(format!("{index}{}", "x".repeat(300))),
                Access::Read,
            )
        })
        .collect();
    let complete_permissions = request.permissions.clone();
    // Keep this accepted receipt separate from the three scope-grant oracles below.
    let InteractionRequest::Permissions { tool_use_id, .. } = &mut complete.request else {
        unreachable!()
    };
    *tool_use_id = Some("complete-tool".into());
    assert!(log.establish_interaction(&complete).await.unwrap().matches);
    let complete_outcome = InteractionOutcome::PermissionsDecision {
        decision: grant::Decision::Allow {
            permissions: complete_permissions,
            scope: grant::Scope::Once,
        },
        committed_at: 19,
    };
    assert!(
        log.commit_interaction_outcome("complete_receipt", complete_outcome.clone())
            .await
            .unwrap()
            .matches
    );
    assert!(
        log.commit_interaction_outcome("complete_receipt", complete_outcome.clone())
            .await
            .unwrap()
            .matches
    );
    let complete_record = log.interaction("complete_receipt").await.unwrap().unwrap();
    assert_eq!(complete_record.request, complete.request);
    assert_eq!(complete_record.outcome, Some(complete_outcome));
    for (id, scope) in [
        ("once", grant::Scope::Once),
        ("turn_grant", grant::Scope::Turn),
        ("session_grant", grant::Scope::Session),
    ] {
        log.establish_interaction(&make_request(id)).await.unwrap();
        let outcome = InteractionOutcome::PermissionsDecision {
            decision: grant::Decision::Allow {
                permissions: partial.clone(),
                scope,
            },
            committed_at: 20,
        };
        let committed = log.commit_interaction_outcome(id, outcome).await.unwrap();
        assert!(committed.matches);
        let retry = InteractionOutcome::PermissionsDecision {
            decision: grant::Decision::Allow {
                permissions: requested.clone(),
                scope,
            },
            committed_at: 21,
        };
        assert!(
            !log.commit_interaction_outcome(id, retry)
                .await
                .unwrap()
                .matches,
            "lost reply cannot broaden a partial approval"
        );
    }
    let all = log
        .permission_grants(&invocation, Some("tool-use"), &basis)
        .await
        .unwrap();
    assert_eq!(all.len(), 3);
    assert!(all.iter().all(|grant| grant.permissions == partial));
    assert_eq!(
        log.permission_grants(&invocation, None, &basis)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        log.permission_grants(&invocation, Some("other-tool"), &basis)
            .await
            .unwrap()
            .len(),
        2
    );
    let other_run = Invocation {
        run_id: "other-run".into(),
        ..invocation.clone()
    };
    assert_eq!(
        log.permission_grants(&other_run, Some("tool-use"), &basis)
            .await
            .unwrap()
            .len(),
        2
    );
    let other_turn = Invocation {
        turn_id: "other-turn".into(),
        ..other_run
    };
    assert_eq!(
        log.permission_grants(&other_turn, Some("tool-use"), &basis)
            .await
            .unwrap()
            .len(),
        1
    );
    let other_session = Invocation {
        session_id: "other-session".into(),
        ..invocation.clone()
    };
    assert!(
        log.permission_grants(&other_session, Some("tool-use"), &basis)
            .await
            .unwrap()
            .is_empty()
    );

    log.establish_interaction(&make_request("pending"))
        .await
        .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.interaction("complete_receipt").await.unwrap().unwrap(),
        complete_record
    );
    assert_eq!(log.close_abandoned_interactions(30).await.unwrap(), 1);
    assert_eq!(
        log.permission_grants(&invocation, Some("tool-use"), &basis)
            .await
            .unwrap(),
        all
    );
    let late = InteractionOutcome::PermissionsDecision {
        decision: grant::Decision::Allow {
            permissions: requested.clone(),
            scope: grant::Scope::Session,
        },
        committed_at: 31,
    };
    assert!(
        !log.commit_interaction_outcome("pending", late)
            .await
            .unwrap()
            .matches
    );

    log.establish_interaction(&make_request("stale"))
        .await
        .unwrap();
    let session = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap();
    log.update_session_metadata(
        "session",
        session.revision,
        |value: &mut serde_json::Value| {
            value["boundary_revision"] = serde_json::json!(5);
            Ok(())
        },
    )
    .await
    .unwrap();
    let stale = InteractionOutcome::PermissionsDecision {
        decision: grant::Decision::Allow {
            permissions: partial,
            scope: grant::Scope::Session,
        },
        committed_at: 32,
    };
    assert!(
        log.commit_interaction_outcome("stale", stale)
            .await
            .is_err()
    );
    assert!(
        log.interaction("stale")
            .await
            .unwrap()
            .unwrap()
            .outcome
            .is_none()
    );
    assert!(
        log.permission_grants(&invocation, Some("tool-use"), &basis)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        log.permission_grants(
            &invocation,
            Some("tool-use"),
            &PermissionBasis {
                boundary_revision: 5,
                ..basis
            }
        )
        .await
        .unwrap()
        .is_empty()
    );
    assert!(
        log.establish_interaction(&make_request("stale_request"))
            .await
            .is_err()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn native_audio_dispatch_requires_both_current_capability_grants() {
    use maka_agent_facts::event::{
        CommitError, EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent,
    };
    use maka_agent_facts::tool_call::ToolCallIdentity;
    use serde_json::{Value, json};

    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("audio.sqlite"))
        .await
        .unwrap();
    let basis = bound_session(&log, "session", 0).await;
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(&event(Fact::InvocationOpened {
        input: InvocationInput::Message {
            content: "Record computer audio".into(),
            source_messages: vec![],
            request_fingerprint: None,
        },
        configuration: None,
    }))
    .await
    .unwrap();
    let computer = GrantTarget {
        provider_id: "maka_workspace_computer".into(),
        contract_id: "maka_workspace_computer_v1".into(),
        server_id: "maka_workspace_computer".into(),
        tool_name: "cua_repl".into(),
        capability: GrantCapability::ComputerUse,
        scope: GrantScope::Capability {},
    };
    let audio = GrantTarget {
        capability: GrantCapability::ComputerAudio,
        ..computer.clone()
    };
    let targets = [computer, audio];
    let approve = async |id: &str, target: &GrantTarget, basis| {
        let record = InteractionRecord {
            request: InteractionRequest::ClientCapability {
                tool_use_id: "audio-use".into(),
                basis: Some(basis),
                target: target.clone(),
            },
            ..request(id)
        };
        log.establish_run_interaction(&invocation, &record)
            .await
            .unwrap();
        assert!(
            log.commit_interaction_outcome(id, decision(Decision::Allow, 20))
                .await
                .unwrap()
                .matches
        );
    };
    let dispatch = |operation: &str| {
        event(Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: operation.into(),
            call: ToolCallIdentity::standalone(format!("{operation}-call")),
            name: "cua_operation".into(),
            input: json!({"operation":"start_audio_recording"}),
        })
    };
    approve("computer", &targets[0], basis).await;
    assert!(matches!(
        log.append_capability_dispatch(&[], &dispatch("missing-audio"), &targets, &basis)
            .await,
        Err(CommitError::PermissionRevoked)
    ));
    approve("audio", &targets[1], basis).await;
    log.append_capability_dispatch(&[], &dispatch("both"), &targets, &basis)
        .await
        .unwrap();
    let current = log.get_session::<Value>("session").await.unwrap().unwrap();
    log.update_session_permissions("session", current.revision, 30, |value: &mut Value| {
        value["boundary_revision"] = json!(1);
        Ok(())
    })
    .await
    .unwrap();
    let renewed = PermissionBasis {
        boundary_revision: 1,
        ..basis
    };
    approve("renewed-audio", &targets[1], renewed).await;
    assert!(matches!(
        log.append_capability_dispatch(&[], &dispatch("missing-computer"), &targets, &renewed)
            .await,
        Err(CommitError::PermissionRevoked)
    ));
    approve("renewed-computer", &targets[0], renewed).await;
    assert!(matches!(
        log.append_capability_dispatch(&[], &dispatch("old-worker"), &targets, &basis)
            .await,
        Err(CommitError::PermissionRevoked)
    ));
    log.append_capability_dispatch(&[], &dispatch("renewed"), &targets, &renewed)
        .await
        .unwrap();
    let events = log
        .scoped_prefix(
            maka_agent_facts::event::LogScope::Session {
                id: "session".into(),
            },
            64,
            1024 * 1024,
        )
        .await
        .unwrap()
        .events;
    let admitted: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.event.fact {
            Fact::ToolDispatched { operation_id, .. } => Some(operation_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(admitted, ["both", "renewed"]);
    log.close().await.unwrap();
}

fn request(id: &str) -> InteractionRecord {
    InteractionRecord {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        request_id: id.into(),
        created_at: 10,
        request: InteractionRequest::ClientCapability {
            tool_use_id: "tool-use".into(),
            basis: None,
            target: GrantTarget {
                provider_id: "provider".into(),
                contract_id: "contract".into(),
                server_id: "desktop_browser".into(),
                tool_name: "browser_navigate".into(),
                capability: GrantCapability::Browser,
                scope: GrantScope::BrowserOrigin {
                    origin: "https://example.com".into(),
                },
            },
        },
        outcome: None,
    }
}
fn target(record: &InteractionRecord) -> &GrantTarget {
    let InteractionRequest::ClientCapability { target, .. } = &record.request else {
        panic!("expected capability request")
    };
    target
}
fn decision(value: Decision, time: u64) -> InteractionOutcome {
    InteractionOutcome::ClientCapabilityDecision {
        decision: value,
        committed_at: time,
    }
}

#[tokio::test]
async fn first_outcome_and_atomic_grant_survive_conflicts_faults_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let mut wake = log.subscribe_commits();
    let initial = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap();
    let candidate = request("request");
    assert!(log.establish_interaction(&candidate).await.unwrap().matches);
    let waiting = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(waiting.revision, initial.revision + 1);
    let version = log.observation_versions(&["session".into()]).await.unwrap()["session"];
    assert_eq!(
        version.metadata, waiting.revision,
        "pending interactions must invalidate observation without an execution event"
    );
    assert_eq!(version.event, 0);
    assert_eq!(
        waiting.pending_interaction_since,
        Some(candidate.created_at)
    );
    wake.changed().await.unwrap();
    assert_eq!(
        *wake.borrow_and_update(),
        0,
        "interaction is not an execution event"
    );
    let mut conflict = candidate.clone();
    conflict.run_id = "other_run".into();
    let result = log.establish_interaction(&conflict).await.unwrap();
    assert!(!result.matches);
    assert_eq!(result.record, candidate);
    assert_eq!(
        log.get_session::<serde_json::Value>("session")
            .await
            .unwrap()
            .unwrap(),
        waiting
    );
    assert_eq!(
        log.pending_interactions("session").await.unwrap(),
        std::slice::from_ref(&candidate)
    );
    let observation = log
        .observe_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        observation.pending_interactions,
        std::slice::from_ref(&candidate)
    );
    assert_eq!(observation.through_sequence, 0);

    // Failure between outcome insertion and grant insertion must roll back both.
    let mut observer = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::raw_sql(
        "CREATE TRIGGER fail_grant BEFORE INSERT ON client_capability_session_grants
        BEGIN SELECT RAISE(ABORT, 'injected grant failure'); END;",
    )
    .execute(&mut observer)
    .await
    .unwrap();
    assert!(
        log.commit_interaction_outcome("request", decision(Decision::Allow, 20))
            .await
            .is_err()
    );
    assert_eq!(
        log.interaction("request").await.unwrap(),
        Some(candidate.clone())
    );
    assert!(
        log.client_capability_grant("session", target(&candidate))
            .await
            .unwrap()
            .is_none()
    );
    assert!(!wake.has_changed().unwrap());
    assert_eq!(
        log.get_session::<serde_json::Value>("session")
            .await
            .unwrap()
            .unwrap(),
        waiting
    );
    sqlx::raw_sql("DROP TRIGGER fail_grant")
        .execute(&mut observer)
        .await
        .unwrap();

    let (allow, deny) = tokio::join!(
        log.commit_interaction_outcome("request", decision(Decision::Allow, 21)),
        log.commit_interaction_outcome("request", decision(Decision::Deny, 22)),
    );
    let (allow, deny) = (allow.unwrap(), deny.unwrap());
    assert_ne!(allow.matches, deny.matches);
    assert_eq!(allow.record, deny.record);
    let canonical = allow.record;
    let settled = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(settled.revision, waiting.revision + 1);
    assert_eq!(settled.pending_interaction_since, None);
    let allowed = matches!(
        canonical.outcome,
        Some(InteractionOutcome::ClientCapabilityDecision {
            decision: Decision::Allow,
            ..
        })
    );
    let grant = log
        .client_capability_grant("session", target(&candidate))
        .await
        .unwrap();
    assert_eq!(grant.is_some(), allowed);
    if let Some(grant) = &grant {
        assert_eq!(
            grant.granted_at,
            canonical.outcome.as_ref().unwrap().committed_at()
        );
        assert_eq!(grant.target, *target(&candidate));
    }
    let repeat = log
        .commit_interaction_outcome(
            "request",
            decision(
                if allowed {
                    Decision::Allow
                } else {
                    Decision::Deny
                },
                99,
            ),
        )
        .await
        .unwrap();
    assert!(
        repeat.matches,
        "timestamps do not change semantic answer identity"
    );
    assert_eq!(repeat.record, canonical);
    assert!(log.establish_interaction(&candidate).await.unwrap().matches);
    assert!(
        log.pending_interactions("session")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(log.prefix(32, 65536).await.unwrap().events.is_empty());
    let projection = log
        .session_projection::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert!(projection.pending_interactions.is_empty());
    assert_eq!(projection.through_sequence, observation.through_sequence);
    observer.close().await.unwrap();
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(log.interaction("request").await.unwrap(), Some(canonical));
    assert_eq!(
        log.client_capability_grant("session", target(&candidate))
            .await
            .unwrap(),
        grant
    );
    log.close().await.unwrap();
}
