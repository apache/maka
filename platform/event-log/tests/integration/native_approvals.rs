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

use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationInput, LogScope, RuntimeEvent},
    interaction::{Decision, InteractionOutcome, InteractionRecord, InteractionRequest},
    model::{
        ModelFinishReason, ModelPart, ModelToolCall, ModelUsage,
        recorded::{CompletionPart, ModelCompletion, ModelPartRecord},
    },
    native_approval::{ActivationCheckpoint, DispatchReceipt, NativeApprovalPending},
    tool_call::{ToolCallIdentity, tool_use_id},
};
use maka_event_log::{EventLog, native_approvals::ParkResult};
use serde_json::json;

async fn fixture(
    path: &std::path::Path,
) -> (EventLog, ActivationCheckpoint, Vec<NativeApprovalPending>) {
    let (log, checkpoint, pending, _) = fixture_with_changes(path).await;
    (log, checkpoint, pending)
}
async fn fixture_with_changes(
    path: &std::path::Path,
) -> (
    EventLog,
    ActivationCheckpoint,
    Vec<NativeApprovalPending>,
    tokio::sync::watch::Receiver<()>,
) {
    let log = EventLog::open(path).await.unwrap();
    let changes = log.subscribe_native_approval_changes();
    log.create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let write = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(&write(Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Message {
            source_messages: vec![],
            content: "test".into(),
            request_fingerprint: None,
        },
    }))
    .await
    .unwrap();
    let prefix = log.prefix(100, 100000).await.unwrap();
    log.append_batch(&[
        write(Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: "step".into(),
            model_id: "model".into(),
            source_scope: LogScope::Root,
            source_high_water: prefix.high_water,
            source_digest: prefix.digest,
            effective_source_digest: None,
            input_digest: "input".into(),
            route_identity: "route".into(),
        }),
        write(Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelCompletion {
                parts: vec![CompletionPart::Own(ModelPartRecord {
                    ordinal: 0,
                    message_id: tool_use_id("invocation", "step:call"),
                    started_at: std::time::SystemTime::now(),
                    provider_part_id: None,
                    part: std::sync::Arc::new(ModelPart::ToolCall {
                        call: ModelToolCall {
                            id: "call".into(),
                            name: "tool".into(),
                            input: json!({}).into(),
                            provider_options: None,
                            provider_executed: false,
                        },
                    }),
                })],
                finish_reason: ModelFinishReason::ToolCalls,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        }),
    ])
    .await
    .unwrap();
    let dispatch = RuntimeEvent::new(
        invocation.clone(),
        Fact::ToolDispatched {
            operation_id: "step:call".into(),
            call: ToolCallIdentity::provider("step".into(), "call".into()),
            name: "tool".into(),
            input: json!({}),
            title: None,
            presentation: None,
        },
    );
    let dispatch_id = dispatch.id.clone();
    let sequence = log
        .append(&EventWrite::plain(dispatch).unwrap())
        .await
        .unwrap();
    log.establish_run_interaction(
        &invocation,
        &InteractionRecord {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            request_id: "approval".into(),
            created_at: 2,
            request: InteractionRequest::ServiceApproval {
                tool_use_id: tool_use_id("invocation", "step:call"),
                tool_name: "tool".into(),
                service: "service".into(),
                method: "run".into(),
                binding: "binding".into(),
                through: sequence,
            },
            outcome: None,
        },
    )
    .await
    .unwrap();
    let pending = vec![NativeApprovalPending {
        invocation: invocation.clone(),
        operation_id: "step:call".into(),
        dispatch: DispatchReceipt {
            event_id: dispatch_id,
            sequence,
        },
        interaction_id: "approval".into(),
        native: json!({}),
    }];
    let checkpoint = ActivationCheckpoint {
        id: "checkpoint".into(),
        invocation,
        through: sequence,
        engine: json!({}),
        native_basis: json!({}),
    };
    (log, checkpoint, pending, changes)
}
async fn answer(log: &EventLog) {
    log.commit_interaction_outcome(
        "approval",
        InteractionOutcome::ServiceApprovalDecision {
            decision: Decision::Allow,
            committed_at: 3,
        },
    )
    .await
    .unwrap();
}
#[tokio::test]
async fn park_rechecks_answer_and_exact_confirmation_payload() {
    let directory = tempfile::tempdir().unwrap();
    let (log, checkpoint, pending) = fixture(&directory.path().join("db")).await;
    answer(&log).await;
    assert!(matches!(
        log.park_native_approvals(checkpoint.clone(), pending.clone())
            .await
            .unwrap(),
        ParkResult::Changed
    ));
    assert!(
        log.confirm_native_approval_park(&checkpoint, &pending)
            .await
            .unwrap()
            .is_none()
    );
    log.close().await.unwrap();
}
#[tokio::test]
async fn durable_answer_claim_and_stop_fence_preserve_original_identity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let (log, checkpoint, pending) = fixture(&path).await;
    let ParkResult::Parked(receipt) = log
        .park_native_approvals(checkpoint.clone(), pending.clone())
        .await
        .unwrap()
    else {
        panic!("eligible frontier must park")
    };
    assert!(
        log.ready_native_approval_sessions()
            .await
            .unwrap()
            .is_empty()
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    maka_event_log::recovery::recover_invocations(&log)
        .await
        .unwrap();
    assert!(
        log.interaction("approval")
            .await
            .unwrap()
            .unwrap()
            .outcome
            .is_none()
    );
    assert_eq!(
        log.confirm_native_approval_park(&checkpoint, &pending)
            .await
            .unwrap(),
        Some(receipt.clone())
    );
    answer(&log).await;
    assert_eq!(
        log.ready_native_approval_sessions().await.unwrap(),
        ["session"]
    );
    assert_eq!(
        log.claim_native_approvals(&receipt, "claim", "epoch")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        log.claim_native_approvals(&receipt, "other", "epoch")
            .await
            .unwrap()
            .is_empty()
    );
    log.stop_native_approvals(&checkpoint.invocation, 4)
        .await
        .unwrap();
    assert!(
        !log.start_native_approval(&receipt, "step:call", "claim", "different-start")
            .await
            .unwrap()
    );
    assert!(!log.native_approvals_settled(&receipt).await.unwrap());
    log.close().await.unwrap();
}
#[tokio::test]
async fn crash_after_started_never_requeues_physical_effect() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let (log, checkpoint, pending) = fixture(&path).await;
    let ParkResult::Parked(receipt) = log
        .park_native_approvals(checkpoint.clone(), pending)
        .await
        .unwrap()
    else {
        panic!("eligible frontier must park")
    };
    answer(&log).await;
    log.claim_native_approvals(&receipt, "claim", "epoch")
        .await
        .unwrap();
    assert!(
        log.start_native_approval(&receipt, "step:call", "claim", "start")
            .await
            .unwrap()
    );
    assert!(
        !log.start_native_approval(&receipt, "step:call", "claim", "different-start")
            .await
            .unwrap()
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    maka_event_log::recovery::recover_invocations(&log)
        .await
        .unwrap();
    assert!(
        log.native_approval_checkpoint("session")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        log.ready_native_approval_sessions()
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        log.claim_native_approvals(&receipt, "fresh", "new-epoch")
            .await
            .is_err()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn crash_before_start_reclaims_and_exact_t2_reconciles_without_replay() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let (log, checkpoint, pending) = fixture(&path).await;
    let ParkResult::Parked(receipt) = log
        .park_native_approvals(checkpoint.clone(), pending)
        .await
        .unwrap()
    else {
        panic!("eligible frontier must park")
    };
    answer(&log).await;
    log.claim_native_approvals(&receipt, "old-claim", "old-epoch")
        .await
        .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    maka_event_log::recovery::recover_invocations(&log)
        .await
        .unwrap();
    assert_eq!(
        log.claim_native_approvals(&receipt, "new-claim", "new-epoch")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        log.start_native_approval(&receipt, "step:call", "new-claim", "start")
            .await
            .unwrap()
    );
    assert!(
        log.start_native_approval(&receipt, "step:call", "new-claim", "start")
            .await
            .unwrap()
    );
    let (settled, _) = EventWrite::tool_success(
        "original-t2".into(),
        std::time::SystemTime::now(),
        checkpoint.invocation,
        "step:call".into(),
        json!(42).into(),
    )
    .unwrap();
    log.append(&settled).await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    maka_event_log::recovery::recover_invocations(&log)
        .await
        .unwrap();
    assert!(
        log.native_approval_checkpoint("session")
            .await
            .unwrap()
            .unwrap()
            .pending
            .is_empty()
    );
    assert!(
        log.claim_native_approvals(&receipt, "again", "third-epoch")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(log.native_approvals_settled(&receipt).await.unwrap());
    assert!(log.native_approvals_settled(&receipt).await.unwrap());
    log.close().await.unwrap();
}

#[tokio::test]
async fn retirement_settles_original_waiting_call_without_resume_admission() {
    let directory = tempfile::tempdir().unwrap();
    let (log, checkpoint, pending) = fixture(&directory.path().join("db")).await;
    assert!(matches!(
        log.park_native_approvals(checkpoint.clone(), pending)
            .await
            .unwrap(),
        ParkResult::Parked(_)
    ));
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.begin_session_removal("session", revision)
        .await
        .unwrap();
    assert!(log.session_retirement_ready("session").await.unwrap());
    assert_eq!(
        log.finish_session_retirement("session").await.unwrap(),
        maka_event_log::sessions::SessionRetirement::Removed
    );
    let prefix = log.prefix(100, 100000).await.unwrap();
    let settlements: Vec<_> = prefix
        .events
        .iter()
        .filter_map(|stored| match &stored.event.fact {
            Fact::ToolSettled { operation_id, .. } => Some(operation_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(settlements, ["step:call"]);
    assert!(prefix.events.iter().any(|stored|matches!(&stored.event.fact,Fact::InvocationEnded{outcome:maka_agent_facts::event::InvocationOutcome::Cancelled{source}} if source=="session_retired")));
    assert!(
        log.native_approval_checkpoint("session")
            .await
            .unwrap()
            .is_none()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn repark_retires_old_checkpoint_and_confirms_same_new_identity() {
    let directory = tempfile::tempdir().unwrap();
    let (log, checkpoint, pending) = fixture(&directory.path().join("db")).await;
    let ParkResult::Parked(previous) = log
        .park_native_approvals(checkpoint.clone(), pending.clone())
        .await
        .unwrap()
    else {
        panic!("eligible frontier must park")
    };
    let mut next = checkpoint.clone();
    next.id = "checkpoint-next".into();
    let ParkResult::Parked(receipt) = log
        .repark_native_approvals(&previous, next.clone(), pending.clone())
        .await
        .unwrap()
    else {
        panic!("unchanged frontier must repark")
    };
    assert_eq!(
        log.repark_native_approvals(&previous, next.clone(), pending.clone())
            .await
            .unwrap(),
        ParkResult::Parked(receipt.clone())
    );
    assert!(
        log.confirm_native_approval_park(&checkpoint, &pending)
            .await
            .unwrap()
            .is_none()
    );
    let mut conflict = next.clone();
    conflict.engine = json!({"changed":true});
    assert!(matches!(
        log.confirm_native_approval_park(&conflict, &pending).await,
        Err(maka_event_log::StoreError::EventConflict)
    ));
    assert_eq!(
        log.native_approval_checkpoint("session")
            .await
            .unwrap()
            .unwrap()
            .receipt,
        receipt
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn retirement_does_not_take_claimed_resume_ownership() {
    let directory = tempfile::tempdir().unwrap();
    let (log, checkpoint, pending) = fixture(&directory.path().join("db")).await;
    let ParkResult::Parked(receipt) = log
        .park_native_approvals(checkpoint, pending)
        .await
        .unwrap()
    else {
        panic!("eligible frontier must park")
    };
    answer(&log).await;
    log.claim_native_approvals(&receipt, "claim", "epoch")
        .await
        .unwrap();
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.begin_session_removal("session", revision)
        .await
        .unwrap();
    assert!(matches!(
        log.finish_session_retirement("session").await,
        Err(maka_event_log::StoreError::SessionBusy)
    ));
    assert!(
        log.native_approval_checkpoint("session")
            .await
            .unwrap()
            .is_some()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn retirement_fences_absent_start_but_confirms_exact_committed_start() {
    for started in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let (log, checkpoint, pending) = fixture(&directory.path().join("db")).await;
        let ParkResult::Parked(receipt) = log
            .park_native_approvals(checkpoint, pending)
            .await
            .unwrap()
        else {
            panic!("eligible frontier must park")
        };
        answer(&log).await;
        log.claim_native_approvals(&receipt, "claim", "epoch")
            .await
            .unwrap();
        if started {
            assert!(
                log.start_native_approval(&receipt, "step:call", "claim", "original-start")
                    .await
                    .unwrap()
            );
        }
        let revision = log
            .get_session::<serde_json::Value>("session")
            .await
            .unwrap()
            .unwrap()
            .revision;
        log.begin_session_removal("session", revision)
            .await
            .unwrap();
        assert_eq!(
            log.start_native_approval(&receipt, "step:call", "claim", "original-start")
                .await
                .unwrap(),
            started
        );
        assert!(
            !log.start_native_approval(&receipt, "step:call", "claim", "different-start")
                .await
                .unwrap()
        );
        log.close().await.unwrap();
    }
}
#[tokio::test]
async fn repark_refuses_revoked_waits_and_leaves_closed_obligations_claimable() {
    let directory = tempfile::tempdir().unwrap();
    let (log, mut checkpoint, pending) = fixture(&directory.path().join("db")).await;
    let ParkResult::Parked(previous) = log
        .park_native_approvals(checkpoint.clone(), pending.clone())
        .await
        .unwrap()
    else {
        panic!("eligible frontier must park")
    };
    log.stop_native_approvals(&checkpoint.invocation, 4)
        .await
        .unwrap();
    checkpoint.id = "new-after-stop".into();
    assert_eq!(
        log.repark_native_approvals(&previous, checkpoint.clone(), pending.clone())
            .await
            .unwrap(),
        ParkResult::Changed
    );
    assert!(
        log.confirm_native_approval_park(&checkpoint, &pending)
            .await
            .unwrap()
            .is_none()
    );
    let claimed = log
        .claim_native_approvals(&previous, "same-worker", "epoch")
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert!(matches!(
        claimed[0].outcome,
        InteractionOutcome::Closure { .. }
    ));
    log.close().await.unwrap();
}

#[tokio::test]
async fn shutdown_release_keeps_checkpoint_and_cannot_steal_new_claim_or_reset_start() {
    let directory = tempfile::tempdir().unwrap();
    let (log, checkpoint, pending) = fixture(&directory.path().join("db")).await;
    let ParkResult::Parked(receipt) = log
        .park_native_approvals(checkpoint.clone(), pending.clone())
        .await
        .unwrap()
    else {
        panic!("eligible frontier must park")
    };
    answer(&log).await;
    log.claim_native_approvals(&receipt, "old", "epoch")
        .await
        .unwrap();
    assert!(
        !log.release_native_approval_claim(&receipt, "step:call", "wrong", "epoch")
            .await
            .unwrap()
    );
    assert!(
        log.release_native_approval_claim(&receipt, "step:call", "old", "epoch")
            .await
            .unwrap()
    );
    assert!(
        log.release_native_approval_claim(&receipt, "step:call", "old", "epoch")
            .await
            .unwrap()
    );
    assert_eq!(
        log.confirm_native_approval_park(&checkpoint, &pending)
            .await
            .unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(
        log.claim_native_approvals(&receipt, "new", "epoch-2")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        !log.release_native_approval_claim(&receipt, "step:call", "old", "epoch")
            .await
            .unwrap()
    );
    assert!(
        log.start_native_approval(&receipt, "step:call", "new", "start")
            .await
            .unwrap()
    );
    assert!(
        !log.release_native_approval_claim(&receipt, "step:call", "new", "epoch-2")
            .await
            .unwrap()
    );
    log.close().await.unwrap();
}
#[tokio::test]
async fn domain_stop_prevents_shutdown_claim_release() {
    let directory = tempfile::tempdir().unwrap();
    let (log, checkpoint, pending) = fixture(&directory.path().join("db")).await;
    let ParkResult::Parked(receipt) = log
        .park_native_approvals(checkpoint, pending)
        .await
        .unwrap()
    else {
        panic!("eligible frontier must park")
    };
    answer(&log).await;
    log.claim_native_approvals(&receipt, "claim", "epoch")
        .await
        .unwrap();
    log.stop_native_approvals(receipt.invocation(), 4)
        .await
        .unwrap();
    assert!(
        !log.release_native_approval_claim(&receipt, "step:call", "claim", "epoch")
            .await
            .unwrap()
    );
    assert!(
        !log.start_native_approval(&receipt, "step:call", "claim", "start")
            .await
            .unwrap()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn settled_cursor_survives_capture_window_until_actual_next_model_request() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let (log, checkpoint, pending) = fixture(&path).await;
    let ParkResult::Parked(receipt) = log
        .park_native_approvals(checkpoint.clone(), pending)
        .await
        .unwrap()
    else {
        panic!("eligible frontier must park")
    };
    answer(&log).await;
    log.claim_native_approvals(&receipt, "claim", "epoch")
        .await
        .unwrap();
    assert!(
        log.start_native_approval(&receipt, "step:call", "claim", "start")
            .await
            .unwrap()
    );
    let (settled, _) = EventWrite::tool_success(
        "original-t2".into(),
        std::time::SystemTime::now(),
        checkpoint.invocation.clone(),
        "step:call".into(),
        json!(42).into(),
    )
    .unwrap();
    log.append(&settled).await.unwrap();
    assert!(log.native_approvals_settled(&receipt).await.unwrap());
    assert!(
        log.native_approval_checkpoint("session")
            .await
            .unwrap()
            .is_some()
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        maka_event_log::recovery::recover_invocations(&log)
            .await
            .unwrap(),
        0
    );
    assert!(
        log.native_approval_checkpoint("session")
            .await
            .unwrap()
            .unwrap()
            .pending
            .is_empty()
    );
    let prefix = log.prefix(100, 100000).await.unwrap();
    assert!(
        !prefix
            .events
            .iter()
            .any(|stored| matches!(stored.event.fact, Fact::InvocationEnded { .. }))
    );
    let request = EventWrite::plain(RuntimeEvent::new(
        checkpoint.invocation.clone(),
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: "next-model".into(),
            model_id: "model".into(),
            source_scope: prefix.scope,
            source_high_water: prefix.high_water,
            source_digest: prefix.digest,
            effective_source_digest: None,
            input_digest: "next-input".into(),
            route_identity: "route".into(),
        },
    ))
    .unwrap();
    log.append(&request).await.unwrap();
    assert!(
        log.native_approval_checkpoint("session")
            .await
            .unwrap()
            .is_none()
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        maka_event_log::recovery::recover_invocations(&log)
            .await
            .unwrap(),
        1
    );
    let prefix = log.prefix(100, 100000).await.unwrap();
    assert!(prefix.events.iter().any(|stored|matches!(&stored.event.fact,Fact::ModelInterrupted{step_id,..} if step_id=="next-model")));
    assert_eq!(prefix.events.iter().filter(|stored|matches!(&stored.event.fact,Fact::ToolSettled{operation_id,..} if operation_id=="step:call")).count(),1);
    log.close().await.unwrap();
}

#[tokio::test]
async fn activation_hints_follow_parked_approval_changes_not_ordinary_commits() {
    let directory = tempfile::tempdir().unwrap();
    let (ordinary, checkpoint, _, changes) =
        fixture_with_changes(&directory.path().join("ordinary")).await;
    ordinary
        .append(
            &EventWrite::plain(RuntimeEvent::new(
                checkpoint.invocation,
                Fact::ToolSettled {
                    operation_id: "step:call".into(),
                    outcome: maka_agent_facts::event::ToolOutcome::Failed {
                        message: "ordinary failure".into(),
                    },
                },
            ))
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(!changes.has_changed().unwrap());
    assert_eq!(
        ordinary.ready_native_approval_sessions().await.unwrap(),
        Vec::<String>::new()
    );
    ordinary.close().await.unwrap();
    let (log, checkpoint, pending, mut changes) =
        fixture_with_changes(&directory.path().join("db")).await;
    // The fixture commits a model completion, T1 and its unanswered interaction.
    assert!(!changes.has_changed().unwrap());
    let ParkResult::Parked(receipt) = log
        .park_native_approvals(checkpoint.clone(), pending.clone())
        .await
        .unwrap()
    else {
        panic!("eligible frontier must park")
    };
    assert!(changes.has_changed().unwrap());
    changes.borrow_and_update();
    assert_eq!(
        log.ready_native_approval_sessions().await.unwrap(),
        Vec::<String>::new()
    );
    answer(&log).await;
    assert!(changes.has_changed().unwrap());
    changes.borrow_and_update();
    assert_eq!(
        log.ready_native_approval_sessions().await.unwrap(),
        ["session"]
    );
    let claimed = log
        .claim_native_approvals(&receipt, "claim", "epoch")
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert!(!changes.has_changed().unwrap());
    assert_eq!(
        log.ready_native_approval_sessions().await.unwrap(),
        Vec::<String>::new()
    );
    assert!(
        log.release_native_approval_claim(&receipt, "step:call", "claim", "epoch")
            .await
            .unwrap()
    );
    assert!(changes.has_changed().unwrap());
    changes.borrow_and_update();
    assert_eq!(
        log.ready_native_approval_sessions().await.unwrap(),
        ["session"]
    );
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            checkpoint.invocation,
            Fact::ToolSettled {
                operation_id: "step:call".into(),
                outcome: maka_agent_facts::event::ToolOutcome::Failed {
                    message: "denied".into(),
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    assert!(changes.has_changed().unwrap());
    assert!(log.native_approvals_settled(&receipt).await.unwrap());
    log.close().await.unwrap();
}

#[tokio::test]
async fn closure_and_stop_wake_an_already_registered_park_observer() {
    for stop in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let (log, checkpoint, pending) = fixture(&directory.path().join("db")).await;
        let ParkResult::Parked(_) = log
            .park_native_approvals(checkpoint.clone(), pending)
            .await
            .unwrap()
        else {
            panic!("eligible frontier must park")
        };
        let mut changes = log.subscribe_native_approval_changes();
        assert_eq!(
            log.ready_native_approval_sessions().await.unwrap(),
            Vec::<String>::new()
        );
        if stop {
            assert!(
                log.stop_native_approvals(&checkpoint.invocation, 4)
                    .await
                    .unwrap()
            );
        } else {
            assert_eq!(
                log.close_run_interactions(
                    &checkpoint.invocation,
                    maka_agent_facts::interaction::ClosureReason::ProducerCancelled,
                    4
                )
                .await
                .unwrap(),
                1
            );
        }
        changes.changed().await.unwrap();
        assert_eq!(
            log.ready_native_approval_sessions().await.unwrap(),
            ["session"]
        );
        let saved = log
            .native_approval_checkpoint("session")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.revoked, stop);
        log.close().await.unwrap();
    }
}
