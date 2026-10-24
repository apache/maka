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
use crate::sessions::{SessionCopy, SessionCopyResult, SessionMutation};
use serde_json::json;

async fn log() -> (tempfile::TempDir, EventLog) {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("state.sqlite"))
        .await
        .unwrap();
    (directory, log)
}

async fn replace_binding(
    log: &EventLog,
    id: uuid::Uuid,
    workspace: Value,
    permission: bool,
) -> Result<(), StoreError> {
    log.connection
        .run(move |connection| {
            Box::pin(async move {
                let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                replace(&mut tx, id, workspace, permission).await?;
                tx.commit().await?;
                Ok(())
            })
        })
        .await
}

#[tokio::test]
async fn reuse_is_owner_scoped_and_relocation_changes_only_shared_rows() {
    let (_directory, log) = log().await;
    let workspace =
        json!({"path":"/source","worktree":{"allocation":"first"},"projectId":"source"});
    let first = log.attach_workspace("owner_", &workspace).await.unwrap();
    let reordered = serde_json::from_str::<Value>(
        r#"{"projectId":"source","worktree":{"allocation":"first"},"path":"/source"}"#,
    )
    .unwrap();
    assert_eq!(
        first,
        log.attach_workspace("owner_", &reordered).await.unwrap()
    );
    assert_ne!(
        first.id,
        log.attach_workspace("foreign_", &workspace)
            .await
            .unwrap()
            .id
    );
    for index in 0..128 {
        log.create_session(
            &format!("owner_{index}"),
            "create",
            &json!({"workspace":first,"boundary_revision":7,"title":"before"}),
            1,
        )
        .await
        .unwrap();
    }
    let before = log.get_session::<Value>("owner_0").await.unwrap().unwrap();
    log.connection.run(|connection| Box::pin(async move {
        sqlx::query("CREATE TRIGGER forbid_session_rewrite BEFORE UPDATE ON session_control BEGIN SELECT RAISE(ABORT,'Session rows must not change'); END").execute(connection).await?;
        Ok(())
    })).await.unwrap();
    let destination =
        json!({"path":"/destination","projectId":"source","worktree":{"allocation":"replacement"}});
    replace_binding(&log, first.id, destination.clone(), true)
        .await
        .unwrap();
    let after = log.get_session::<Value>("owner_0").await.unwrap().unwrap();
    assert_eq!(after.configuration, before.configuration);
    assert_eq!(after.configuration_digest, before.configuration_digest);
    assert_eq!(after.revision, before.revision + 1);
    let binding = after.workspace_binding.as_ref().unwrap();
    assert_eq!(binding.workspace, destination);
    assert_eq!(
        effective_boundary(&after.configuration, binding)
            .unwrap()
            .boundary_revision,
        8
    );
    assert_eq!((binding.permission_epoch, binding.metadata_epoch), (1, 1));
    assert_eq!(
        log.attach_workspace("owner_", &destination)
            .await
            .unwrap()
            .id,
        first.id
    );
    log.connection
        .run(|connection| {
            Box::pin(async move {
                sqlx::query("DROP TRIGGER forbid_session_rewrite")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(matches!(
        log.update_session_metadata::<Value, _>("owner_0", before.revision, |_| panic!(
            "stale effective CAS ran"
        ))
        .await
        .unwrap(),
        SessionMutation::RevisionConflict { actual: 2, .. }
    ));
    let SessionMutation::Committed(updated) = log
        .update_session_metadata::<Value, _>("owner_0", after.revision, |value| {
            value["title"] = json!("after");
            Ok(())
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(updated.revision, 3);
    assert_eq!(updated.configuration["boundary_revision"], 8);
    assert_eq!(
        updated.configuration["workspace"],
        serde_json::to_value(binding.reference()).unwrap()
    );
    let captured = before.workspace_binding.unwrap();
    assert_eq!(captured.workspace["path"], "/source");
    assert_eq!(
        captured.permission_epoch, 0,
        "historical snapshot was upgraded"
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn metadata_only_change_and_rebind_preserve_effective_counters() {
    let (_directory, log) = log().await;
    let original =
        json!({"path":"/worktree","worktree":{"allocation":"retained"},"projectId":"absorbed"});
    let reference = log.attach_workspace("owner_", &original).await.unwrap();
    let created = log
        .create_session(
            "owner_session",
            "create",
            &json!({"workspace":reference,"boundary_revision":11}),
            1,
        )
        .await
        .unwrap();
    let mut renamed = original.clone();
    renamed["projectId"] = json!("canonical");
    replace_binding(&log, reference.id, renamed.clone(), false)
        .await
        .unwrap();
    let current = log
        .get_session::<Value>("owner_session")
        .await
        .unwrap()
        .unwrap();
    let binding = current.workspace_binding.as_ref().unwrap();
    assert_eq!(binding.workspace, renamed);
    assert_eq!(binding.workspace["worktree"], original["worktree"]);
    assert_eq!(binding.permission_epoch, 0);
    assert_eq!(current.revision, created.revision + 1);
    assert_eq!(
        effective_boundary(&current.configuration, binding)
            .unwrap()
            .boundary_revision,
        11
    );
    let other = log
        .attach_workspace("owner_", &json!({"path":"/other"}))
        .await
        .unwrap();
    let SessionMutation::Committed(rebound) = log
        .update_session_metadata::<Value, _>(
            "owner_session",
            current.revision,
            move |configuration| {
                configuration["workspace"] = serde_json::to_value(other)?;
                Ok(())
            },
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(rebound.revision, 3, "metadata delta was lost during rebind");
    let rebound_basis = effective_boundary(
        &rebound.configuration,
        rebound.workspace_binding.as_ref().unwrap(),
    )
    .unwrap();
    assert_eq!(rebound_basis.boundary_revision, 11);
    assert_eq!(rebound_basis.binding.id, other.id);
    assert_ne!(rebound_basis.binding, binding.stamp());
    log.close().await.unwrap();
}

#[tokio::test]
async fn relocation_checks_indexed_session_headroom_and_copy_uses_effective_revision() {
    let (_directory, log) = log().await;
    let reference = log
        .attach_workspace("owner_", &json!({"path":"/old"}))
        .await
        .unwrap();
    log.create_session(
        "source",
        "source",
        &json!({"workspace":reference,"boundary_revision":0}),
        1,
    )
    .await
    .unwrap();
    replace_binding(&log, reference.id, json!({"path":"/new"}), true)
        .await
        .unwrap();
    let destination = log
        .attach_workspace("owner_", &json!({"path":"/target"}))
        .await
        .unwrap();
    let configuration = json!({"workspace":destination,"boundary_revision":0});
    let mut request = SessionCopy {
        source_session_id: "source".into(),
        target_session_id: "target".into(),
        expected_source_revision: 1,
        purpose: maka_agent_facts::session::CopyPurpose::EmptySideConversation,
    };
    assert!(matches!(
        log.copy_session(request.clone(), &configuration, 2)
            .await
            .unwrap(),
        SessionCopyResult::SourceRevisionConflict {
            expected: 1,
            actual: 2
        }
    ));
    request.expected_source_revision = 2;
    assert!(matches!(
        log.copy_session(request.clone(), &configuration, 2)
            .await
            .unwrap(),
        SessionCopyResult::Committed(_)
    ));
    for permission_overflow in [false, true] {
        let binding = log
            .workspace_binding::<Value>(reference.id)
            .await
            .unwrap()
            .unwrap();
        log.connection.run(move |connection| Box::pin(async move {
            if permission_overflow {
                sqlx::query("UPDATE session_control SET revision=1,configuration=json_set(configuration,'$.boundary_revision',?,'$.workspace.permissionEpochAtAttach',1) WHERE id='source'").bind(MAX as i64).execute(connection).await?;
            } else {
                sqlx::query("UPDATE session_control SET revision=?,configuration=json_set(configuration,'$.workspace.metadataEpochAtAttach',1) WHERE id='source'").bind(MAX as i64).execute(connection).await?;
            }
            Ok(())
        })).await.unwrap();
        assert!(
            replace_binding(&log, reference.id, json!({"path":"/overflow"}), true)
                .await
                .is_err()
        );
        assert_eq!(
            log.workspace_binding::<Value>(reference.id)
                .await
                .unwrap()
                .unwrap(),
            binding
        );
    }
    log.close().await.unwrap();
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
        log.append_capability_dispatch(&dispatch("old-dispatch"), &target, &old)
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
        log.append_capability_dispatch(&dispatch("still-old"), &target, &old)
            .await,
        Err(CommitError::PermissionRevoked)
    ));
    log.append_capability_dispatch(&dispatch("new-dispatch"), &target, &new)
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

#[tokio::test]
async fn lifecycle_history_and_bundle_tokens_use_the_effective_metadata_revision() {
    use crate::{
        context::{HistoryCapture, HistoryCut},
        sessions::{RemovalAuthority, RemoveFamilyResult, SessionRemovalResult},
    };
    let (_directory, log) = log().await;
    let reference = log
        .attach_workspace("owner_", &json!({"path":"/same","projectId":"old"}))
        .await
        .unwrap();
    for session in ["single", "family"] {
        log.create_session(
            session,
            session,
            &json!({"workspace":reference,"boundary_revision":0}),
            1,
        )
        .await
        .unwrap();
    }
    replace_binding(
        &log,
        reference.id,
        json!({"path":"/same","projectId":"canonical"}),
        false,
    )
    .await
    .unwrap();
    assert!(matches!(
        log.begin_session_removal("single", 1).await.unwrap(),
        SessionRemovalResult::RevisionConflict {
            expected: 1,
            actual: 2
        }
    ));
    assert!(matches!(
        log.remove_session_family("family", 1, RemovalAuthority::Unmanaged)
            .await
            .unwrap(),
        RemoveFamilyResult::RevisionConflict {
            expected: 1,
            actual: 2
        }
    ));
    assert!(matches!(
        log.capture_session_history("single", 1, HistoryCut::Empty, 32, 65536)
            .await
            .unwrap(),
        HistoryCapture::SourceRevisionConflict {
            expected: 1,
            actual: 2
        }
    ));
    let HistoryCapture::Captured(history) = log
        .capture_session_history("single", 2, HistoryCut::Empty, 32, 65536)
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(history.source_revision, 2);
    assert_eq!(
        log.preview_bundle("single").await.unwrap().sessions[0].revision,
        2
    );
    assert!(matches!(
        log.begin_session_removal("single", 2).await.unwrap(),
        SessionRemovalResult::Accepted(_)
    ));
    assert!(matches!(
        log.remove_session_family("family", 2, RemovalAuthority::Unmanaged)
            .await
            .unwrap(),
        RemoveFamilyResult::Accepted(_)
    ));
    log.close().await.unwrap();
}
