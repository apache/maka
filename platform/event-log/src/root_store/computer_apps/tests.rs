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
use crate::root::{RootNamespaces, RootOwner};
use maka_agent_facts::event::{InvocationInput, InvocationOutcome, RuntimeEvent};
use maka_agent_facts::interaction::{
    ComputerAppDisplay, ComputerAppPlatform, Decision, GrantCapability,
};
use maka_agent_facts::workspace::BindingStamp;
use serde_json::json;
use tokio::sync::oneshot;

#[tokio::test]
async fn app_operations_reuse_original_execution_custody_behind_queued_binding_writer() {
    let (_dir, _owner, root, store, invocation, basis) = fixture().await;
    let execution = store.execution_scope(Some(basis)).await.unwrap().accept();
    let selected = execution.store();
    let app = target("fixture.queued-binding");
    let writer = root.gates.write([gates::Key::Binding(basis.binding.id)]);
    tokio::pin!(writer);
    assert!(futures_util::poll!(&mut writer).is_pending());
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        decide(
            &selected,
            &invocation,
            basis,
            &app,
            "accepted-app-consent",
            "accepted-app-effect",
            ComputerAppDecision::Once,
        )
        .await;
        assert!(
            selected
                .computer_app_granted(&invocation, "accepted-app-effect", &app, &basis)
                .await
                .unwrap()
        );
        selected
            .establish_run_interaction(
                &invocation,
                &request(
                    &invocation,
                    basis,
                    &app,
                    "pending-close",
                    "pending-effect",
                    0,
                ),
            )
            .await
            .unwrap();
        assert_eq!(
            selected
                .close_run_interactions(&invocation, ClosureReason::TurnStopped, 4)
                .await
                .unwrap(),
            1
        );
        assert!(matches!(
            selected
                .interaction("pending-close")
                .await
                .unwrap()
                .unwrap()
                .outcome,
            Some(InteractionOutcome::Closure {
                reason: ClosureReason::TurnStopped,
                ..
            })
        ));
    })
    .await
    .expect("accepted app work must reuse its original binding custody");
    assert!(futures_util::poll!(&mut writer).is_pending());
    execution.finish();
    drop(
        tokio::time::timeout(std::time::Duration::from_secs(2), writer)
            .await
            .unwrap()
            .unwrap(),
    );
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_unbound_source_keeps_control_ingress_until_accepted_sql_cleanup() {
    let (_dir, owner, root, store, _invocation, _basis) = fixture().await;
    let before: i64 = root
        .control
        .connection
        .read(|connection| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT revision FROM session_catalog_revision WHERE singleton=1",
                )
                .fetch_one(connection)
                .await?)
            })
        })
        .await
        .unwrap();
    let partition = store.control_source().await.unwrap();
    let control = root.control.clone();
    let (entered, started) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let caller = tokio::spawn(async move {
        partition
            .connection
            .run(move |connection| {
                Box::pin(async move {
                    let tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let _ = entered.send(());
                    released.await.map_err(|_| StoreError::OperationUnknown)?;
                    control
                        .connection
                        .run(|connection| {
                            Box::pin(async move {
                                let mut control_tx =
                                    connection.begin_with("BEGIN IMMEDIATE").await?;
                                crate::sessions::advance_catalog(&mut control_tx).await?;
                                control_tx.commit().await.map_err(StoreError::CommitUnknown)
                            })
                        })
                        .await?;
                    tx.rollback().await?;
                    Ok(())
                })
            })
            .await
    });
    started.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let closing_root = root.clone();
    let closing = tokio::spawn(async move { closing_root.shutdown().await });
    while !root.closed.load(std::sync::atomic::Ordering::Acquire) {
        tokio::task::yield_now().await;
    }
    // The caller is gone, but the original SQL actor still retains the existing
    // Root active-work barrier. This assertion also detects a no-op dependency.
    assert_eq!(root.gates.shutdown_ready(), None);
    assert!(!closing.is_finished());
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), closing)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(root);
    let reopened = RootStore::open(owner).await.unwrap();
    let after: i64 = reopened
        .control
        .connection
        .read(|connection| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT revision FROM session_catalog_revision WHERE singleton=1",
                )
                .fetch_one(connection)
                .await?)
            })
        })
        .await
        .unwrap();
    assert_eq!(
        after,
        before + 1,
        "accepted delayed control write must finish before ingress closes"
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn project_relink_closes_relocated_app_prompt_and_preserves_metadata_only_alias_prompt() {
    let (_dir, _owner, root, _store, _invocation, _basis) = fixture().await;
    let registration = |identity: &str, path: &str| crate::projects::ProjectRegistration {
        identity: identity.into(),
        name: identity.into(),
        path: path.into(),
        is_worktree: false,
    };
    let source = root
        .register_project(registration("source-project", "/source"), true, 1)
        .await
        .unwrap();
    let absorbed = root
        .register_project(registration("absorbed-project", "/absorbed"), true, 1)
        .await
        .unwrap();
    let app = target("fixture.relink");
    let mut sessions = Vec::new();
    for (project, id, path) in [
        (&source, "relocated", "/source"),
        (&absorbed, "metadata-only", "/absorbed"),
    ] {
        let binding = root
            .attach_workspace(
                "owner",
                &json!({"projectId":project.id,"identity":project.identity,"path":path}),
            )
            .await
            .unwrap();
        let store = root
            .create_session(
                id,
                id,
                &json!({"workspace":binding,"boundary_revision":0}),
                1,
            )
            .await
            .unwrap();
        let invocation = Invocation {
            session_id: id.into(),
            turn_id: format!("{id}-turn"),
            run_id: format!("{id}-run"),
            invocation_id: format!("{id}-invocation"),
        };
        let basis = PermissionBasis {
            boundary_revision: 0,
            binding: BindingStamp {
                id: binding.id,
                permission_epoch: binding.permission_epoch_at_attach,
            },
        };
        open(&store, &invocation).await;
        store
            .establish_run_interaction(&invocation, &request(&invocation, basis, &app, id, id, 0))
            .await
            .unwrap();
        sessions.push((store, invocation, basis));
    }
    let changed = root
        .relink_project(
            &source.id,
            "owner",
            registration("absorbed-project", "/relocated"),
            5,
            json!({"path":"/relocated","identity":"absorbed-project"}),
        )
        .await
        .unwrap();
    assert_eq!(changed.updated_bindings, 2);
    let (relocated, _, _) = &sessions[0];
    assert!(matches!(
        relocated
            .interaction("relocated")
            .await
            .unwrap()
            .unwrap()
            .outcome,
        Some(InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            committed_at: 5,
        })
    ));
    assert!(
        relocated
            .pending_interactions(relocated.id())
            .await
            .unwrap()
            .is_empty()
    );
    let (metadata_only, invocation, basis) = &sessions[1];
    assert!(
        metadata_only
            .interaction("metadata-only")
            .await
            .unwrap()
            .unwrap()
            .outcome
            .is_none()
    );
    assert!(
        metadata_only
            .commit_interaction_outcome(
                "metadata-only",
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Session,
                    committed_at: 6,
                },
            )
            .await
            .unwrap()
            .matches
    );
    assert!(
        metadata_only
            .computer_app_granted(invocation, "after-metadata-change", &app, basis)
            .await
            .unwrap()
    );
    root.shutdown().await.unwrap();
}

async fn fixture() -> (
    tempfile::TempDir,
    Arc<RootOwner>,
    Arc<RootStore>,
    SessionStore,
    Invocation,
    PermissionBasis,
) {
    let dir = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        RootOwner::create(
            &dir.path().join("root"),
            &RootNamespaces {
                ownership: dir.path().join("ownership"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let root = Arc::new(RootStore::open(owner.clone()).await.unwrap());
    let (store, invocation, basis) = session(&root, "session").await;
    (dir, owner, root, store, invocation, basis)
}

async fn session(root: &RootStore, id: &str) -> (SessionStore, Invocation, PermissionBasis) {
    let reference = root
        .attach_workspace(id, &json!({"path":format!("/fixture/{id}")}))
        .await
        .unwrap();
    let store = root
        .create_session(
            id,
            id,
            &json!({"workspace":reference,"boundary_revision":0}),
            1,
        )
        .await
        .unwrap();
    let basis = PermissionBasis {
        boundary_revision: 0,
        binding: BindingStamp {
            id: reference.id,
            permission_epoch: 0,
        },
    };
    let invocation = Invocation {
        session_id: id.into(),
        turn_id: format!("{id}-turn"),
        run_id: format!("{id}-run"),
        invocation_id: format!("{id}-invocation"),
    };
    open(&store, &invocation).await;
    (store, invocation, basis)
}

async fn open(store: &SessionStore, invocation: &Invocation) {
    store
        .append(
            &EventWrite::plain(RuntimeEvent::new(
                invocation.clone(),
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        source_messages: Vec::new(),
                        content: "fixture".into(),
                        request_fingerprint: None,
                    },
                },
            ))
            .unwrap(),
        )
        .await
        .unwrap();
}

fn end(invocation: &Invocation) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        invocation.clone(),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ))
    .unwrap()
}

fn target(id: &str) -> GrantTarget {
    GrantTarget {
        provider_id: "maka_workspace_computer".into(),
        contract_id: "maka_workspace_computer_v1".into(),
        server_id: "maka_workspace_computer".into(),
        tool_name: "cua_repl".into(),
        capability: GrantCapability::ComputerUse,
        scope: GrantScope::ComputerApp {
            platform: ComputerAppPlatform::Macos,
            application_id: id.into(),
        },
    }
}

fn activity_display() -> ComputerAppDisplay {
    ComputerAppDisplay {
        name: "Fixture application".into(),
        app_path: "/Applications/Fixture.app".into(),
        risk: None,
        warning: None,
    }
}

async fn broad_grant(
    store: &SessionStore,
    invocation: &Invocation,
    basis: PermissionBasis,
    app: &GrantTarget,
) -> GrantTarget {
    let mut broad = app.clone();
    broad.scope = GrantScope::Capability {};
    let record = InteractionRecord {
        request: InteractionRequest::ClientCapability {
            tool_use_id: "repl".into(),
            target: broad.clone(),
            basis: Some(basis),
        },
        ..request(invocation, basis, app, "broad-native-access", "unused", 0)
    };
    store
        .establish_run_interaction(invocation, &record)
        .await
        .unwrap();
    store
        .commit_interaction_outcome(
            &record.request_id,
            InteractionOutcome::ClientCapabilityDecision {
                decision: Decision::Allow,
                committed_at: 3,
            },
        )
        .await
        .unwrap();
    broad
}

fn native_dispatch(invocation: &Invocation, operation: &str) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        invocation.clone(),
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: operation.into(),
            call: maka_agent_facts::tool_call::ToolCallIdentity::standalone(format!(
                "call-{operation}"
            )),
            name: "native-fixture".into(),
            input: json!({}),
        },
    ))
    .unwrap()
}

async fn settle_native(store: &SessionStore, invocation: &Invocation, operation: &str) {
    let (write, _) = EventWrite::tool_success(
        format!("settled-{operation}"),
        std::time::SystemTime::now(),
        invocation.clone(),
        operation.into(),
        maka_agent_facts::tool_output::ToolOutput::Text("completed fixture".into()).into(),
    )
    .unwrap();
    store.append(&write).await.unwrap();
}

#[tokio::test]
async fn app_stop_between_completed_calls_preserves_consent_and_new_turn_recovers() {
    let (_dir, _owner, root, store, invocation, basis) = fixture().await;
    let app = target("fixture.stop");
    let display = activity_display();
    decide(
        &store,
        &invocation,
        basis,
        &app,
        "app-consent",
        "unused",
        ComputerAppDecision::Always,
    )
    .await;
    let mut missing_broad = app.clone();
    missing_broad.scope = GrantScope::Capability {};
    assert!(matches!(
        store
            .append_computer_app_dispatch(
                &[],
                &native_dispatch(&invocation, "rejected-native"),
                &[missing_broad],
                &app,
                &display,
                &basis
            )
            .await,
        Err(CommitError::PermissionRevoked)
    ));
    assert!(
        store.computer_apps(store.id()).await.unwrap().is_empty(),
        "a rejected T1 must not publish native activity"
    );
    let broad = broad_grant(&store, &invocation, basis, &app).await;
    let ordinary_prefix = native_dispatch(&invocation, "ordinary-prefix");
    let event = native_dispatch(&invocation, "first-native");
    let sequence = store
        .append_computer_app_dispatch(
            std::slice::from_ref(&ordinary_prefix),
            &event,
            std::slice::from_ref(&broad),
            &app,
            &display,
            &basis,
        )
        .await
        .unwrap();
    assert!(store.append(&ordinary_prefix).await.unwrap() < sequence.last_sequence);
    assert_eq!(store.append(&event).await.unwrap(), sequence.last_sequence);
    settle_native(&store, &invocation, "ordinary-prefix").await;
    settle_native(&store, &invocation, "first-native").await;
    let observed = store.computer_apps(store.id()).await.unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].0.operation_id, "first-native");
    assert_eq!(observed[0].0.display, display);
    assert!(!observed[0].1);
    assert!(
        !store
            .stop_computer_app_operation("caller-forged-app-id", 4)
            .await
            .unwrap()
    );
    assert!(
        store
            .stop_computer_app_operation("first-native", 4)
            .await
            .unwrap()
    );
    assert!(
        store
            .stop_computer_app_operation("first-native", 5)
            .await
            .unwrap()
    );
    assert!(store.computer_apps(store.id()).await.unwrap()[0].1);
    assert!(
        store
            .computer_app_granted(&invocation, "next-native", &app, &basis)
            .await
            .unwrap(),
        "Stop must not revoke remembered consent"
    );
    let blocked_prefix = native_dispatch(&invocation, "blocked-prefix");
    let blocked = native_dispatch(&invocation, "blocked-native");
    assert!(matches!(
        store
            .append_computer_app_dispatch(
                std::slice::from_ref(&blocked_prefix),
                &blocked,
                std::slice::from_ref(&broad),
                &app,
                &display,
                &basis
            )
            .await,
        Err(CommitError::PermissionRevoked)
    ));
    assert!(
        store
            .scoped()
            .await
            .unwrap()
            .execution_event(&invocation, &blocked.event().id, u64::MAX >> 1)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .scoped()
            .await
            .unwrap()
            .execution_event(&invocation, &blocked_prefix.event().id, u64::MAX >> 1)
            .await
            .unwrap()
            .is_none(),
        "an app fence must roll back the ordinary prefix with its T1"
    );
    store.append(&end(&invocation)).await.unwrap();
    assert!(store.computer_apps(store.id()).await.unwrap().is_empty());
    let next = Invocation {
        turn_id: "new-turn".into(),
        run_id: "new-run".into(),
        invocation_id: "new-invocation".into(),
        ..invocation
    };
    open(&store, &next).await;
    assert!(
        !store
            .computer_app_stopped(&next, &app, &display)
            .await
            .unwrap()
    );
    assert!(
        !store
            .stop_computer_app_operation("first-native", 6)
            .await
            .unwrap()
    );
    store
        .append_computer_app_dispatch(
            &[],
            &native_dispatch(&next, "new-native"),
            &[broad],
            &app,
            &display,
            &basis,
        )
        .await
        .unwrap();
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn app_stop_closes_matching_pending_consent_and_settlement_still_commits() {
    let (_dir, _owner, root, store, invocation, basis) = fixture().await;
    let app = target("fixture.stop");
    let display = activity_display();
    decide(
        &store,
        &invocation,
        basis,
        &app,
        "app-consent",
        "running-native",
        ComputerAppDecision::Once,
    )
    .await;
    let broad = broad_grant(&store, &invocation, basis, &app).await;
    store
        .append_computer_app_dispatch(
            &[],
            &native_dispatch(&invocation, "running-native"),
            &[broad],
            &app,
            &display,
            &basis,
        )
        .await
        .unwrap();
    store
        .establish_run_interaction(
            &invocation,
            &request(
                &invocation,
                basis,
                &app,
                "pending-consent",
                "next-native",
                0,
            ),
        )
        .await
        .unwrap();
    let (foreign, _, _) = session(&root, "foreign").await;
    assert!(
        !foreign
            .stop_computer_app_operation("running-native", 4)
            .await
            .unwrap()
    );
    assert!(
        store
            .stop_computer_app_operation("running-native", 4)
            .await
            .unwrap()
    );
    assert!(matches!(
        store
            .interaction("pending-consent")
            .await
            .unwrap()
            .unwrap()
            .outcome,
        Some(InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            ..
        })
    ));
    assert!(
        store
            .pending_interactions(store.id())
            .await
            .unwrap()
            .is_empty()
    );
    let closed_request = request(
        &invocation,
        basis,
        &app,
        "pending-consent",
        "next-native",
        0,
    );
    let replay = store
        .establish_run_interaction(&invocation, &closed_request)
        .await
        .unwrap();
    assert!(replay.matches);
    assert!(
        matches!(
            replay.record.outcome,
            Some(InteractionOutcome::Closure {
                reason: ClosureReason::ProducerCancelled,
                ..
            })
        ),
        "an acknowledged closed request must remain replayable without reopening"
    );
    let fresh = request(
        &invocation,
        basis,
        &app,
        "after-stop-consent",
        "after-stop-native",
        0,
    );
    assert!(
        store
            .establish_run_interaction(&invocation, &fresh)
            .await
            .is_err(),
        "Stop must fence request publication in the source transaction, even after an earlier producer precheck"
    );
    assert!(
        store
            .interaction(&fresh.request_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !store
            .commit_interaction_outcome(
                "pending-consent",
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Always,
                    committed_at: 5
                }
            )
            .await
            .unwrap()
            .matches
    );
    settle_native(&store, &invocation, "running-native").await;
    store.append(&end(&invocation)).await.unwrap();
    root.shutdown().await.unwrap();
}

fn request(
    invocation: &Invocation,
    basis: PermissionBasis,
    target: &GrantTarget,
    id: &str,
    operation: &str,
    revision: u64,
) -> InteractionRecord {
    InteractionRecord {
        request_id: id.into(),
        session_id: invocation.session_id.clone(),
        turn_id: invocation.turn_id.clone(),
        run_id: invocation.run_id.clone(),
        created_at: 2,
        outcome: None,
        request: InteractionRequest::ComputerApp {
            tool_use_id: "repl-tool".into(),
            native_operation_id: operation.into(),
            target: target.clone(),
            basis,
            display: ComputerAppDisplay {
                name: "Fixture application".into(),
                app_path: match &target.scope {
                    GrantScope::ComputerApp {
                        platform: ComputerAppPlatform::Windows,
                        ..
                    } => r"C:\Fixture\fixture.exe".into(),
                    _ => "/Applications/Fixture.app".into(),
                },
                risk: None,
                warning: Some("Native classification unavailable in fixture".into()),
            },
            allow_always: true,
            authority_revision: revision,
        },
    }
}

async fn decide(
    store: &SessionStore,
    invocation: &Invocation,
    basis: PermissionBasis,
    app: &GrantTarget,
    id: &str,
    operation: &str,
    decision: ComputerAppDecision,
) {
    let revision = store.computer_app_authority_revision(app).await.unwrap();
    assert!(
        store
            .establish_run_interaction(
                invocation,
                &request(invocation, basis, app, id, operation, revision)
            )
            .await
            .unwrap()
            .matches
    );
    assert!(
        store
            .commit_interaction_outcome(
                id,
                InteractionOutcome::ComputerAppDecision {
                    decision,
                    committed_at: 3
                }
            )
            .await
            .unwrap()
            .matches
    );
}

#[tokio::test]
async fn once_is_exact_native_effect_session_survives_turns_and_denial_grants_nothing() {
    let (_dir, _owner, root, store, invocation, basis) = fixture().await;
    let once = target("fixture.once");
    let persistent = target("fixture.session");
    let denied = target("fixture.denied");
    decide(
        &store,
        &invocation,
        basis,
        &once,
        "once",
        "effect-one",
        ComputerAppDecision::Once,
    )
    .await;
    decide(
        &store,
        &invocation,
        basis,
        &persistent,
        "session-decision",
        "effect-session",
        ComputerAppDecision::Session,
    )
    .await;
    decide(
        &store,
        &invocation,
        basis,
        &denied,
        "denied",
        "effect-denied",
        ComputerAppDecision::Deny,
    )
    .await;
    assert!(
        store
            .computer_app_granted(&invocation, "effect-one", &once, &basis)
            .await
            .unwrap()
    );
    assert!(
        !store
            .computer_app_granted(&invocation, "effect-other", &once, &basis)
            .await
            .unwrap()
    );
    assert!(
        !store
            .computer_app_granted(&invocation, "effect-denied", &denied, &basis)
            .await
            .unwrap()
    );
    store.append(&end(&invocation)).await.unwrap();
    let next = Invocation {
        turn_id: "next-turn".into(),
        run_id: "next-run".into(),
        invocation_id: "next-invocation".into(),
        ..invocation.clone()
    };
    open(&store, &next).await;
    assert!(
        !store
            .computer_app_granted(&next, "effect-one", &once, &basis)
            .await
            .unwrap()
    );
    assert!(
        store
            .computer_app_granted(&next, "next-effect", &persistent, &basis)
            .await
            .unwrap()
    );
    let (other, other_invocation, other_basis) = session(&root, "other").await;
    assert!(
        !other
            .computer_app_granted(
                &other_invocation,
                "effect-session",
                &persistent,
                &other_basis
            )
            .await
            .unwrap()
    );
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn always_belongs_to_selected_root_profile_across_workspaces_and_restart() {
    let (_dir, owner, root, store, invocation, basis) = fixture().await;
    let app = target("fixture.always");
    decide(
        &store,
        &invocation,
        basis,
        &app,
        "always",
        "effect",
        ComputerAppDecision::Always,
    )
    .await;
    let (other, other_invocation, other_basis) = session(&root, "other").await;
    assert!(
        other
            .computer_app_granted(&other_invocation, "different-effect", &app, &other_basis)
            .await
            .unwrap()
    );
    let local_count:i64=store.owner().unwrap().connection.read(|connection|Box::pin(async move {
        Ok(sqlx::query_scalar("SELECT count(*) FROM interaction_requests WHERE json_extract(record_json,'$.request.kind')='computer_app'").fetch_one(connection).await?)
    })).await.unwrap();
    assert_eq!(
        local_count, 0,
        "app authority must have no source-partition shadow"
    );
    root.shutdown().await.unwrap();
    drop(root);
    let reopened = RootStore::open(owner).await.unwrap();
    let other = reopened.session("other").await.unwrap();
    assert!(
        other
            .computer_app_granted(&other_invocation, "post-restart-effect", &app, &other_basis)
            .await
            .unwrap()
    );
    let (
        _isolated_dir,
        _isolated_owner,
        isolated,
        isolated_store,
        isolated_invocation,
        isolated_basis,
    ) = fixture().await;
    assert!(
        !isolated_store
            .computer_app_granted(&isolated_invocation, "effect", &app, &isolated_basis)
            .await
            .unwrap()
    );
    reopened.close().await.unwrap();
    isolated.shutdown().await.unwrap();
}

#[tokio::test]
async fn revoke_fences_delayed_always_response_without_erasing_explicit_session_consent() {
    let (_dir, _owner, root, store, invocation, basis) = fixture().await;
    let app = target("fixture.app");
    decide(
        &store,
        &invocation,
        basis,
        &app,
        "session-consent",
        "session-effect",
        ComputerAppDecision::Session,
    )
    .await;
    decide(
        &store,
        &invocation,
        basis,
        &app,
        "always-consent",
        "always-effect",
        ComputerAppDecision::Always,
    )
    .await;
    let pending = request(
        &invocation,
        basis,
        &app,
        "delayed-always",
        "delayed-effect",
        0,
    );
    store
        .establish_run_interaction(&invocation, &pending)
        .await
        .unwrap();
    assert_eq!(
        root.revoke_computer_app_profile_grant(&app).await.unwrap(),
        1
    );
    let reply = store
        .commit_interaction_outcome(
            "delayed-always",
            InteractionOutcome::ComputerAppDecision {
                decision: ComputerAppDecision::Always,
                committed_at: 4,
            },
        )
        .await
        .unwrap();
    assert!(!reply.matches);
    assert!(matches!(
        reply.record.outcome,
        Some(InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            ..
        })
    ));
    assert!(
        store
            .computer_app_granted(&invocation, "independent-effect", &app, &basis)
            .await
            .unwrap()
    );
    let (other, other_invocation, other_basis) = session(&root, "other").await;
    assert!(
        !other
            .computer_app_granted(&other_invocation, "independent-effect", &app, &other_basis)
            .await
            .unwrap()
    );
    assert!(
        store
            .pending_interactions(store.id())
            .await
            .unwrap()
            .is_empty()
    );
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn root_pending_blocks_source_seal_and_observers_see_response_without_source_revision_copy() {
    let (_dir, _owner, root, store, invocation, basis) = fixture().await;
    let app = target("fixture.app");
    let before = store
        .scoped()
        .await
        .unwrap()
        .observation_versions(&[store.id().to_owned()])
        .await
        .unwrap();
    let revision = store
        .get::<serde_json::Value>()
        .await
        .unwrap()
        .unwrap()
        .revision;
    store
        .establish_run_interaction(
            &invocation,
            &request(&invocation, basis, &app, "pending", "effect", 0),
        )
        .await
        .unwrap();
    let after = store
        .scoped()
        .await
        .unwrap()
        .observation_versions(&[store.id().to_owned()])
        .await
        .unwrap();
    assert_ne!(before, after);
    assert_eq!(
        store
            .get::<serde_json::Value>()
            .await
            .unwrap()
            .unwrap()
            .revision,
        revision
    );
    let projection = store
        .session_projection::<serde_json::Value>(store.id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(projection.pending_interactions.len(), 1);
    assert_eq!(projection.session.pending_interaction_since, Some(2));
    assert!(store.append(&end(&invocation)).await.is_err());
    assert_eq!(
        store
            .close_run_interactions(&invocation, ClosureReason::TurnStopped, 5)
            .await
            .unwrap(),
        1
    );
    store.append(&end(&invocation)).await.unwrap();
    let late = store
        .commit_interaction_outcome(
            "pending",
            InteractionOutcome::ComputerAppDecision {
                decision: ComputerAppDecision::Always,
                committed_at: 6,
            },
        )
        .await
        .unwrap();
    assert!(!late.matches);
    assert!(matches!(
        late.record.outcome,
        Some(InteractionOutcome::Closure {
            reason: ClosureReason::TurnStopped,
            ..
        })
    ));
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn stale_session_boundary_response_closes_without_grant_and_foreign_session_cannot_respond() {
    let (_dir, _owner, root, store, invocation, basis) = fixture().await;
    let app = target("fixture.app");
    store
        .establish_run_interaction(
            &invocation,
            &request(&invocation, basis, &app, "pending", "effect", 0),
        )
        .await
        .unwrap();
    let (foreign, _, _) = session(&root, "foreign").await;
    assert!(foreign.interaction("pending").await.unwrap().is_none());
    assert!(
        foreign
            .commit_interaction_outcome(
                "pending",
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Always,
                    committed_at: 3
                }
            )
            .await
            .is_err()
    );
    let current = store.get::<serde_json::Value>().await.unwrap().unwrap();
    store
        .update_session_permissions::<serde_json::Value, _>(
            store.id(),
            current.revision,
            4,
            |configuration| {
                configuration["boundary_revision"] = json!(1);
                Ok(())
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .pending_interactions(store.id())
            .await
            .unwrap()
            .is_empty(),
        "permission revocation must retire obsolete app prompts before returning"
    );
    let reply = store
        .commit_interaction_outcome(
            "pending",
            InteractionOutcome::ComputerAppDecision {
                decision: ComputerAppDecision::Always,
                committed_at: 5,
            },
        )
        .await
        .unwrap();
    assert!(!reply.matches);
    assert!(matches!(
        reply.record.outcome,
        Some(InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            ..
        })
    ));
    assert!(
        !store
            .computer_app_granted(&invocation, "effect", &app, &basis)
            .await
            .unwrap()
    );
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn profile_revoke_waits_only_for_accepted_dispatch_t1_and_blocks_following_dispatch() {
    let (_dir, _owner, root, store, invocation, basis) = fixture().await;
    let app = target("fixture.app");
    decide(
        &store,
        &invocation,
        basis,
        &app,
        "always",
        "native-effect",
        ComputerAppDecision::Always,
    )
    .await;
    let mut broad = app.clone();
    broad.scope = GrantScope::Capability {};
    let broad_request = InteractionRecord {
        request: InteractionRequest::ClientCapability {
            tool_use_id: "repl".into(),
            target: broad.clone(),
            basis: Some(basis),
        },
        ..request(&invocation, basis, &app, "broad", "unused", 0)
    };
    store
        .establish_run_interaction(&invocation, &broad_request)
        .await
        .unwrap();
    store
        .commit_interaction_outcome(
            "broad",
            InteractionOutcome::ClientCapabilityDecision {
                decision: Decision::Allow,
                committed_at: 3,
            },
        )
        .await
        .unwrap();
    let partition = store.owner().unwrap();
    let (entered, started) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let blocking = tokio::spawn(async move {
        partition
            .connection
            .run(move |_connection| {
                Box::pin(async move {
                    let _ = entered.send(());
                    released.await.map_err(|_| StoreError::OperationUnknown)?;
                    Ok(())
                })
            })
            .await
    });
    started.await.unwrap();
    let event = EventWrite::plain(RuntimeEvent::new(
        invocation.clone(),
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "native-effect".into(),
            call: maka_agent_facts::tool_call::ToolCallIdentity::standalone("native-call".into()),
            name: "native_fixture".into(),
            input: json!({}),
        },
    ))
    .unwrap();
    let dispatch_store = store.clone();
    let dispatch_app = app.clone();
    let dispatch_broad = broad.clone();
    let dispatched = tokio::spawn(async move {
        dispatch_store
            .append_computer_app_dispatch(
                &[],
                &event,
                &[dispatch_broad],
                &dispatch_app,
                &ComputerAppDisplay {
                    name: "Fixture application".into(),
                    app_path: "/Applications/Fixture.app".into(),
                    risk: None,
                    warning: None,
                },
                &basis,
            )
            .await
    });
    // The accepted app admission must own the read gate before its queued source
    // observation can run. This is a test barrier, not a production polling path.
    let key = app_key(&app).unwrap();
    loop {
        if root
            .gates
            .try_write([gates::Key::ComputerApp(key.clone())])
            .unwrap()
            .is_none()
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    let revoke_root = root.clone();
    let revoke_app = app.clone();
    let revoked = tokio::spawn(async move {
        revoke_root
            .revoke_computer_app_profile_grant(&revoke_app)
            .await
    });
    tokio::task::yield_now().await;
    assert!(!revoked.is_finished());
    release.send(()).unwrap();
    blocking.await.unwrap().unwrap();
    dispatched.await.unwrap().unwrap();
    assert_eq!(revoked.await.unwrap().unwrap(), 1);
    assert!(
        !store
            .computer_app_granted(&invocation, "next-effect", &app, &basis)
            .await
            .unwrap()
    );
    root.shutdown().await.unwrap();
}

// Append in the real existing root_store/computer_apps/tests.rs fixture.
// The fixture's request display path must follow the target platform (below).
#[tokio::test]
async fn windows_app_session_consent_is_canonical_and_does_not_cross_platform_identity() {
    let (_dir, _owner, root, store, invocation, basis) = fixture().await;
    let mut windows = target(r"C:\Fixture\fixture.exe");
    windows.scope = GrantScope::ComputerApp {
        platform: ComputerAppPlatform::Windows,
        application_id: r"C:\Fixture\fixture.exe".into(),
    };
    decide(
        &store,
        &invocation,
        basis,
        &windows,
        "windows-consent",
        "windows-effect",
        ComputerAppDecision::Session,
    )
    .await;
    assert!(
        store
            .computer_app_granted(&invocation, "next-windows-effect", &windows, &basis)
            .await
            .unwrap()
    );
    let mut other_platform = windows.clone();
    other_platform.scope = GrantScope::ComputerApp {
        platform: ComputerAppPlatform::Macos,
        application_id: r"C:\Fixture\fixture.exe".into(),
    };
    assert!(
        !store
            .computer_app_granted(&invocation, "next-windows-effect", &other_platform, &basis)
            .await
            .unwrap()
    );
    let mut other_executable = windows.clone();
    other_executable.scope = GrantScope::ComputerApp {
        platform: ComputerAppPlatform::Windows,
        application_id: r"C:\Other\fixture.exe".into(),
    };
    assert!(
        !store
            .computer_app_granted(
                &invocation,
                "next-windows-effect",
                &other_executable,
                &basis
            )
            .await
            .unwrap()
    );
    root.shutdown().await.unwrap();
}
