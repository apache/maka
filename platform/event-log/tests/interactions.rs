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

use maka_agent_facts::interaction::ClosureReason;
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
async fn capability_approval_and_dispatch_share_the_original_permission_boundary() {
    use maka_agent_facts::event::{
        CommitError, EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent,
    };
    use maka_agent_facts::tool_call::ToolCallIdentity;
    use serde_json::{Value, json};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("capability.sqlite");
    let log = EventLog::open(&path).await.unwrap();
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
            content: "Computer Use".into(),
            source_messages: vec![],
            request_fingerprint: None,
        },
        configuration: None,
    }))
    .await
    .unwrap();
    let make_request = |id: &str, revision| {
        let mut record = request(id);
        if let InteractionRequest::ClientCapability {
            basis: captured, ..
        } = &mut record.request
        {
            *captured = Some(PermissionBasis {
                boundary_revision: revision,
                ..basis
            });
        }
        record
    };
    let original = make_request("original", 0);
    let target = target(&original).clone();
    log.establish_run_interaction(&invocation, &original)
        .await
        .unwrap();
    assert!(
        log.commit_interaction_outcome("original", decision(Decision::Allow, 20))
            .await
            .unwrap()
            .matches
    );
    let dispatch = |operation: &str| {
        event(Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: operation.into(),
            call: ToolCallIdentity::standalone(format!("{operation}-call")),
            name: "cua_operation".into(),
            input: json!({}),
        })
    };
    log.append_capability_dispatch(
        &dispatch("before"),
        &target,
        &PermissionBasis {
            boundary_revision: 0,
            ..basis
        },
    )
    .await
    .unwrap();
    log.establish_run_interaction(&invocation, &make_request("pending", 0))
        .await
        .unwrap();
    let session = log.get_session::<Value>("session").await.unwrap().unwrap();
    assert!(matches!(
        log.update_session_permissions("session", session.revision, 30, |value: &mut Value| {
            value["boundary_revision"] = json!(1);
            Ok(())
        })
        .await
        .unwrap(),
        maka_event_log::sessions::SessionMutation::Committed(_)
    ));
    assert!(
        log.client_capability_grant("session", &target)
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        log.append_capability_dispatch(
            &dispatch("revoked"),
            &target,
            &PermissionBasis {
                boundary_revision: 0,
                ..basis
            }
        )
        .await,
        Err(CommitError::PermissionRevoked)
    ));
    let late = log
        .commit_interaction_outcome("pending", decision(Decision::Allow, 31))
        .await
        .unwrap();
    assert!(!late.matches);
    assert!(matches!(
        late.record.outcome,
        Some(InteractionOutcome::Closure { .. })
    ));
    assert!(
        log.establish_run_interaction(&invocation, &make_request("stale", 0))
            .await
            .is_err()
    );
    assert!(
        matches!(
            log.interaction("original").await.unwrap().unwrap().outcome,
            Some(InteractionOutcome::ClientCapabilityDecision {
                decision: Decision::Allow,
                ..
            })
        ),
        "revocation does not rewrite the original answer"
    );
    log.establish_run_interaction(&invocation, &make_request("renewed", 1))
        .await
        .unwrap();
    assert!(
        log.commit_interaction_outcome("renewed", decision(Decision::Allow, 40))
            .await
            .unwrap()
            .matches
    );
    assert_eq!(
        log.client_capability_grant("session", &target)
            .await
            .unwrap()
            .unwrap()
            .basis
            .map(|basis| basis.boundary_revision),
        Some(1)
    );
    assert!(
        matches!(
            log.append_capability_dispatch(
                &dispatch("stale_worker"),
                &target,
                &PermissionBasis {
                    boundary_revision: 0,
                    ..basis
                }
            )
            .await,
            Err(CommitError::PermissionRevoked)
        ),
        "renewal cannot revive a worker captured under the old boundary"
    );
    log.append_capability_dispatch(
        &dispatch("after"),
        &target,
        &PermissionBasis {
            boundary_revision: 1,
            ..basis
        },
    )
    .await
    .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.client_capability_grant("session", &target)
            .await
            .unwrap()
            .unwrap()
            .basis
            .map(|basis| basis.boundary_revision),
        Some(1)
    );
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
    assert_eq!(admitted, ["before", "after"]);
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
async fn pending_session_pages_use_canonical_outcomes_and_isolate_continuation_scope() {
    use maka_event_log::{StoreError, sessions::CatalogScope};
    use serde_json::{Value, json};
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("pending.sqlite"))
        .await
        .unwrap();
    for index in 0..35 {
        let id = format!("session-{index:02}");
        log.create_session(&id, &id, &json!({}), 1).await.unwrap();
        if index < 34 {
            let mut pending = request(&format!("request-{index}"));
            pending.session_id = id;
            log.establish_interaction(&pending).await.unwrap();
        }
    }
    let mut second_request = request("second-request");
    second_request.session_id = "session-33".into();
    log.establish_interaction(&second_request).await.unwrap();
    let page = log
        .scoped_sessions::<Value>(
            CatalogScope::Profile,
            None,
            None.into(),
            maka_event_log::sessions::CatalogFilter {
                archived_only: false,
                include_archived: true,
                pending_only: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.sessions.len(), 32);
    assert!(
        page.sessions
            .iter()
            .all(|row| row.pending_interaction_since == Some(10))
    );
    let cursor = page.next_cursor.as_deref();
    for (scope, include_archived) in [
        (CatalogScope::Profile, false),
        (CatalogScope::IdPrefix("session-".into()), true),
        (CatalogScope::Workspace("/other".into()), true),
    ] {
        assert!(matches!(
            log.scoped_sessions::<Value>(
                scope,
                Some(&page.revision),
                cursor.into(),
                maka_event_log::sessions::CatalogFilter {
                    include_archived,
                    archived_only: false,
                    pending_only: true
                }
            )
            .await,
            Err(StoreError::RevisionConflict { .. })
        ));
    }

    let tail = log
        .scoped_sessions::<Value>(
            CatalogScope::Profile,
            Some(&page.revision),
            cursor.into(),
            maka_event_log::sessions::CatalogFilter {
                archived_only: false,
                include_archived: true,
                pending_only: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        tail.sessions
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["session-32", "session-33"]
    );
    assert!(tail.next_cursor.is_none());
    assert!(matches!(
        log.list_sessions::<Value>(Some(&page.revision), cursor, 32)
            .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    log.commit_interaction_outcome("request-0", decision(Decision::Deny, 20))
        .await
        .unwrap();
    assert!(matches!(
        log.scoped_sessions::<Value>(
            CatalogScope::Profile,
            Some(&page.revision),
            cursor.into(),
            maka_event_log::sessions::CatalogFilter {
                archived_only: false,
                include_archived: true,
                pending_only: true
            }
        )
        .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    log.commit_interaction_outcome("request-33", decision(Decision::Deny, 20))
        .await
        .unwrap();
    assert!(
        log.get_session::<Value>("session-33")
            .await
            .unwrap()
            .unwrap()
            .pending_interaction_since
            .is_some()
    );
    log.commit_interaction_outcome("second-request", decision(Decision::Deny, 20))
        .await
        .unwrap();
    let fresh = log
        .scoped_sessions::<Value>(
            CatalogScope::Profile,
            None,
            None.into(),
            maka_event_log::sessions::CatalogFilter {
                archived_only: false,
                include_archived: true,
                pending_only: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(fresh.sessions.len(), 32);
    assert!(fresh.next_cursor.is_none());
    assert_eq!(fresh.sessions.first().unwrap().id, "session-01");
    assert_eq!(fresh.sessions.last().unwrap().id, "session-32");
    log.close().await.unwrap();
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

#[tokio::test]
async fn closure_cannot_grant_and_browser_authority_is_session_provider_contract_origin() {
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("runtime.sqlite"))
        .await
        .unwrap();
    let closed = request("closed");
    log.establish_interaction(&closed).await.unwrap();
    let closure = InteractionOutcome::Closure {
        reason: ClosureReason::ProviderDisconnected,
        committed_at: 30,
    };
    log.commit_interaction_outcome("closed", closure.clone())
        .await
        .unwrap();
    let late = log
        .commit_interaction_outcome("closed", decision(Decision::Allow, 31))
        .await
        .unwrap();
    assert!(!late.matches);
    assert_eq!(late.record.outcome, Some(closure));
    assert!(
        log.client_capability_grant("session", target(&closed))
            .await
            .unwrap()
            .is_none()
    );

    let allowed = request("allowed");
    log.establish_interaction(&allowed).await.unwrap();
    log.commit_interaction_outcome("allowed", decision(Decision::Allow, 40))
        .await
        .unwrap();
    let mut other_tool = target(&allowed).clone();
    other_tool.tool_name = "browser_snapshot".into();
    assert!(
        log.client_capability_grant("session", &other_tool)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        log.client_capability_grant("other_session", &other_tool)
            .await
            .unwrap()
            .is_none()
    );
    for variant in 0..3 {
        let mut changed = other_tool.clone();
        match variant {
            0 => changed.provider_id = "other_provider".into(),
            1 => changed.contract_id = "other_contract".into(),
            _ => {
                changed.scope = GrantScope::BrowserOrigin {
                    origin: "https://other.example".into(),
                }
            }
        }
        assert!(
            log.client_capability_grant("session", &changed)
                .await
                .unwrap()
                .is_none()
        );
    }
    let later = request("later");
    log.establish_interaction(&later).await.unwrap();
    log.commit_interaction_outcome("later", decision(Decision::Allow, 50))
        .await
        .unwrap();
    assert_eq!(
        log.client_capability_grant("session", target(&later))
            .await
            .unwrap()
            .unwrap()
            .granted_at,
        40
    );
    let mut invalid = request("invalid");
    invalid.outcome = Some(decision(Decision::Allow, 60));
    assert!(log.establish_interaction(&invalid).await.is_err());
    assert!(log.interaction("invalid").await.unwrap().is_none());
    log.close().await.unwrap();
}

#[tokio::test]
async fn permission_metadata_cas_closes_only_old_pending_requests_and_notifies_waiters() {
    use maka_agent_facts::interaction::PermissionRequest;
    use maka_event_log::sessions::SessionMutation;
    use maka_sandbox::{Network, grant};
    use serde_json::{Value, json};
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("permission-cas.sqlite"))
        .await
        .unwrap();
    let basis = bound_session(&log, "session", 4).await;
    bound_session(&log, "other", 4).await;
    let permissions = |id: &str, session: &str| InteractionRecord {
        session_id: session.into(),
        request: InteractionRequest::Permissions {
            tool_use_id: Some("tool-use".into()),
            basis,
            request: PermissionRequest {
                reason: "Exact write".into(),
                command: None,
                permissions: grant::Permissions {
                    filesystem: vec![],
                    network: Network::Denied,
                },
            },
        },
        ..request(id)
    };
    for record in [
        permissions("waiting", "session"),
        permissions("settled", "session"),
        permissions("foreign", "other"),
        request("capability"),
    ] {
        log.establish_interaction(&record).await.unwrap();
    }
    let winner = InteractionOutcome::PermissionsDecision {
        decision: grant::Decision::Deny,
        committed_at: 12,
    };
    log.commit_interaction_outcome("settled", winner.clone())
        .await
        .unwrap();
    let current = log.get_session::<Value>("session").await.unwrap().unwrap();
    assert!(matches!(
        log.update_session_permissions::<Value, _>(
            "session",
            current.revision + 1,
            20,
            |_| panic!("CAS conflict must not run update")
        )
        .await
        .unwrap(),
        SessionMutation::RevisionConflict { .. }
    ));
    log.update_session_permissions::<Value, _>("session", current.revision, 20, |_| Ok(()))
        .await
        .unwrap();
    assert!(
        log.interaction("waiting")
            .await
            .unwrap()
            .unwrap()
            .outcome
            .is_none()
    );
    let mut commits = log.subscribe_commits();
    let changed = log
        .update_session_permissions::<Value, _>("session", current.revision, 21, |value| {
            value["boundary_revision"] = json!(5);
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        matches!(changed, SessionMutation::Committed(ref session) if session.configuration["boundary_revision"] == 5)
    );
    tokio::time::timeout(std::time::Duration::from_secs(1), commits.changed())
        .await
        .unwrap()
        .unwrap();
    let closed = log.interaction("waiting").await.unwrap().unwrap();
    assert_eq!(
        closed.outcome,
        Some(InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            committed_at: 21
        })
    );
    assert_eq!(
        log.interaction("settled").await.unwrap().unwrap().outcome,
        Some(winner)
    );
    for id in ["foreign", "capability"] {
        assert!(
            log.interaction(id)
                .await
                .unwrap()
                .unwrap()
                .outcome
                .is_none()
        );
    }
    // A malformed boundary update rolls back configuration and outcome changes together.
    let current = log.get_session::<Value>("session").await.unwrap().unwrap();
    assert!(
        log.update_session_permissions::<Value, _>("session", current.revision, 22, |value| {
            value["boundary_revision"] = json!(3);
            Ok(())
        })
        .await
        .is_err()
    );
    assert_eq!(
        log.get_session::<Value>("session")
            .await
            .unwrap()
            .unwrap()
            .configuration["boundary_revision"],
        5
    );
    log.create_session("missing", "missing", &json!({}), 1)
        .await
        .unwrap();
    let missing = log.get_session::<Value>("missing").await.unwrap().unwrap();
    assert!(
        log.update_session_permissions::<Value, _>("missing", missing.revision, 22, |value| {
            value["boundary_revision"] = json!(1);
            Ok(())
        })
        .await
        .is_err()
    );
    assert_eq!(
        log.get_session::<Value>("missing")
            .await
            .unwrap()
            .unwrap()
            .configuration,
        json!({})
    );
}
