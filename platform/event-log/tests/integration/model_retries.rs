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
    composition::{CompositionEvidence, RequestComposition},
    context::ModelPurpose,
    event::{
        EventWrite, Fact, Invocation, InvocationInput, ModelInterruption, RuntimeEvent,
        SourceCapture,
    },
    model::{
        error::{ModelFailureCause, ProviderFailureReason},
        retry_transport::RetryTransportPhase,
    },
    model_retry::{ModelRetryConsumption, RetryPlan},
    native_approval::{ActivationCheckpoint, ActivationSuspension},
};
use maka_event_log::{EventLog, native_approvals::ParkResult};
use serde_json::json;
use std::sync::Arc;

async fn fixture(
    path: &std::path::Path,
    deadline: u64,
) -> (EventLog, ActivationCheckpoint, EventWrite) {
    let log = EventLog::open(path).await.unwrap();
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
            content: "frozen input".into(),
            source_messages: vec![],
            request_fingerprint: None,
        },
    }))
    .await
    .unwrap();
    let view = log
        .read_model_view("session", Some("invocation"))
        .await
        .unwrap();
    let composition = Arc::new(
        RequestComposition {
            system_prompt: Some("frozen system".into()),
            dynamic_context: vec![],
            tool_catalog_digest: maka_agent_facts::artifact::content_digest(b"[]"),
            tools: vec![],
            provider_options: None,
            max_output_tokens: None,
            sources: vec![],
        }
        .freeze()
        .unwrap(),
    );
    let request = write(Fact::ModelRequested {
        item_acceptance: false,
        step_id: "original".into(),
        model_id: "model".into(),
        source_scope: view.source_evidence.scope,
        source_high_water: view.source_evidence.high_water,
        source_capture: SourceCapture {
            publication_watermark: view.selection.captured_through,
            prior_unknown: true,
        },
        source_digest: view.source_evidence.digest,
        effective_source_digest: Some(view.effective_source_digest),
        input_digest: "input".into(),
        route_identity: "route".into(),
        checkpoint_event_id: None,
        purpose: ModelPurpose::Main,
        context: None,
        context_breakdown: None,
    })
    .with_composition(CompositionEvidence::Inline(composition))
    .unwrap();
    log.append(&request).await.unwrap();
    let failure = write(Fact::ModelInterrupted {
        step_id: "original".into(),
        status: ModelInterruption::RetryableFailure,
        diagnostic: None,
        partial: None,
        model_failure: Some(ModelFailureCause::Provider {
            reason: ProviderFailureReason::RateLimit,
            retry_at_unix_ms: Some(deadline),
        }),
    });
    let through = log.append(&failure).await.unwrap();
    let checkpoint = ActivationCheckpoint {
        id: "checkpoint".into(),
        invocation,
        through,
        engine: json!({"continuation": "saved"}),
        native_basis: json!({"basis": "saved"}),
        suspension: ActivationSuspension::ModelRetry {
            plan: RetryPlan {
                failure_event_id: failure.event().id.clone(),
                not_before_unix_ms: deadline,
                failures: 1,
                transport_phase: RetryTransportPhase::Primary,
            },
        },
    };
    (log, checkpoint, request)
}
fn next(request: &EventWrite, step: &str) -> EventWrite {
    let mut event = request.event().clone();
    event.id = format!("request-{step}");
    let Fact::ModelRequested { step_id, .. } = &mut event.fact else {
        panic!("request fixture")
    };
    *step_id = step.into();
    EventWrite::plain(event)
        .unwrap()
        .with_composition(request.composition().unwrap().clone())
        .unwrap()
}
fn evidence(checkpoint: &ActivationCheckpoint, revision: u64) -> ModelRetryConsumption {
    let ActivationSuspension::ModelRetry { plan } = &checkpoint.suspension else {
        panic!("retry fixture")
    };
    ModelRetryConsumption {
        checkpoint_id: checkpoint.id.clone(),
        revision,
        plan: plan.clone(),
    }
}

#[tokio::test]
async fn retry_requires_exact_consumption_and_replays_one_request() {
    let directory = tempfile::tempdir().unwrap();
    let (log, checkpoint, request) = fixture(&directory.path().join("retry.sqlite"), 0).await;
    let ParkResult::Parked(receipt) = log.park_model_retry(checkpoint.clone()).await.unwrap()
    else {
        panic!("eligible retry must park")
    };
    assert_eq!(
        log.confirm_model_retry_park(&checkpoint).await.unwrap(),
        Some(receipt.clone())
    );
    assert!(
        log.native_approval_checkpoint("session")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        log.append(&next(&request, "next")).await.is_err(),
        "ordinary append cannot retire a retry"
    );
    let mut wrong = evidence(&checkpoint, receipt.revision());
    wrong.plan.failures += 1;
    assert!(
        log.append(
            &next(&request, "next")
                .with_model_retry_consumption(wrong)
                .unwrap()
        )
        .await
        .is_err()
    );
    let consumed = next(&request, "next")
        .with_model_retry_consumption(evidence(&checkpoint, receipt.revision()))
        .unwrap();
    assert_eq!(
        log.confirm_model_retry_request(&consumed).await.unwrap(),
        None
    );
    let sequence = log.append(&consumed).await.unwrap();
    assert_eq!(
        log.confirm_model_retry_request(&consumed).await.unwrap(),
        Some(sequence)
    );
    let mut conflicting = consumed.event().clone();
    let Fact::ModelRequested { input_digest, .. } = &mut conflicting.fact else {
        panic!("request fixture")
    };
    *input_digest = "different input".into();
    let conflicting = EventWrite::plain(conflicting)
        .unwrap()
        .with_composition(consumed.composition().unwrap().clone())
        .unwrap()
        .with_model_retry_consumption(consumed.model_retry_consumption().unwrap().clone())
        .unwrap();
    assert!(
        log.confirm_model_retry_request(&conflicting).await.is_err(),
        "confirmation rejects a different request with the same event id"
    );
    let different_composition = RequestComposition {
        system_prompt: Some("changed system".into()),
        dynamic_context: vec![],
        tool_catalog_digest: maka_agent_facts::artifact::content_digest(b"[]"),
        tools: vec![],
        provider_options: None,
        max_output_tokens: None,
        sources: vec![],
    }
    .freeze()
    .unwrap();
    let different_composition = EventWrite::plain(consumed.event().clone())
        .unwrap()
        .with_composition(CompositionEvidence::Inline(Arc::new(different_composition)))
        .unwrap()
        .with_model_retry_consumption(consumed.model_retry_consumption().unwrap().clone())
        .unwrap();
    assert!(
        log.confirm_model_retry_request(&different_composition)
            .await
            .is_err(),
        "same request JSON cannot confirm different composition evidence"
    );
    let plain = EventWrite::plain(consumed.event().clone()).unwrap();
    assert!(
        log.confirm_model_retry_request(&plain).await.is_err(),
        "confirmation requires the original retry submission"
    );

    assert_eq!(
        log.append(&consumed).await.unwrap(),
        sequence,
        "lost publication receipts replay exactly"
    );
    assert!(
        log.activation_checkpoint("session")
            .await
            .unwrap()
            .is_none()
    );
    for fact in [
        Fact::ModelInterrupted {
            step_id: "next".into(),
            status: ModelInterruption::Cancelled,
            diagnostic: None,
            model_failure: None,
            partial: None,
        },
        Fact::InvocationEnded {
            outcome: maka_agent_facts::event::InvocationOutcome::Cancelled {
                source: "test".into(),
            },
        },
    ] {
        log.append(
            &EventWrite::plain(RuntimeEvent::new(checkpoint.invocation.clone(), fact)).unwrap(),
        )
        .await
        .unwrap();
    }
    let archived = log
        .set_session_archived::<serde_json::Value>("session", true, 3)
        .await
        .unwrap();
    log.begin_session_removal("session", archived.revision)
        .await
        .unwrap();
    assert_eq!(
        log.confirm_model_retry_request(&consumed).await.unwrap(),
        Some(sequence),
        "read confirmation survives changed admission and removal controls"
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn deadline_and_post_decision_budget_survive_restart_and_exact_confirmation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("future.sqlite");
    let deadline = 4_000_000_000_000;
    let (log, checkpoint, request) = fixture(&path, deadline).await;
    let ParkResult::Parked(receipt) = log.park_model_retry(checkpoint.clone()).await.unwrap()
    else {
        panic!("eligible retry must park")
    };
    let mut different = checkpoint.clone();
    let ActivationSuspension::ModelRetry { plan } = &mut different.suspension else {
        panic!("retry fixture")
    };
    plan.not_before_unix_ms += 1;
    assert!(
        log.confirm_model_retry_park(&different).await.is_err(),
        "same id cannot resample a deadline"
    );
    assert!(
        log.due_model_retry_sessions(deadline - 1)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        log.next_model_retry_deadline(deadline - 1).await.unwrap(),
        Some(deadline)
    );
    assert_eq!(
        log.next_model_retry_deadline(deadline).await.unwrap(),
        None,
        "due rows do not produce a busy timer"
    );
    assert_eq!(
        log.due_model_retry_sessions(deadline).await.unwrap(),
        vec!["session"],
        "a deadline crossed during the scan remains discoverable at the next cutoff"
    );

    assert!(
        log.append(
            &next(&request, "too-early")
                .with_model_retry_consumption(evidence(&checkpoint, receipt.revision()))
                .unwrap()
        )
        .await
        .is_err()
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        maka_event_log::recovery::recover_invocations(&log)
            .await
            .unwrap(),
        0
    );
    let saved = log
        .model_retry_checkpoint("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.checkpoint, checkpoint);
    assert_eq!(saved.receipt, receipt);
    assert!(
        !log.settle_controlled_model_retry(&receipt).await.unwrap(),
        "no control evidence grants terminal settlement"
    );
    log.stop_native_approvals(&checkpoint.invocation, 1)
        .await
        .unwrap();
    assert_eq!(
        log.due_model_retry_sessions(0).await.unwrap(),
        vec!["session"]
    );
    assert!(log.settle_controlled_model_retry(&receipt).await.unwrap());
    assert!(
        log.settle_controlled_model_retry(&receipt).await.unwrap(),
        "lost cancellation receipt confirms the same terminal"
    );
    assert!(
        log.activation_checkpoint("session")
            .await
            .unwrap()
            .is_none()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn newer_main_request_prevents_old_failure_from_parking() {
    let directory = tempfile::tempdir().unwrap();
    let (log, checkpoint, request) = fixture(&directory.path().join("advanced.sqlite"), 0).await;
    log.append(&next(&request, "advanced")).await.unwrap();
    assert_eq!(
        log.park_model_retry(checkpoint).await.unwrap(),
        ParkResult::Changed
    );
    log.close().await.unwrap();
}
