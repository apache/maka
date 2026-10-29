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
use maka_agent_facts::handoff::{HandoffIntent, HandoffPause};
use maka_agent_facts::model::recorded::ModelCompletion;
use maka_agent_facts::model::{ModelFinishReason, ModelPart, ModelUsage, TextKind};
use maka_event_log::{StoreError, context::ContextEvent, turns::InvocationState};

#[tokio::test]
async fn handoff_above_the_former_replay_allowance_can_be_sealed_and_cancelled_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("handoff.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let source = opening("root", None);
    append(&log, &source).await;
    let base = log
        .context_before_run(&source.invocation, usize::MAX, usize::MAX)
        .await
        .unwrap();
    let context = log
        .capture_model_context("session", Some("root"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    append(
        &log,
        &RuntimeEvent::new(
            source.invocation.clone(),
            Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance: false,
                step_id: "step".into(),
                model_id: "test".into(),
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None,
                source_scope: context.source_evidence.scope,
                source_high_water: context.source_evidence.high_water,
                source_digest: context.source_evidence.digest,
                effective_source_digest: Some(context.effective_source_digest),
                input_digest: digest('a'),
                route_identity: digest('b'),
                checkpoint_event_id: None,
            },
        ),
    )
    .await;
    let completed = RuntimeEvent::new(
        source.invocation.clone(),
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelCompletion {
                parts: vec![model_part(
                    &source.invocation.invocation_id,
                    "step",
                    0,
                    ModelPart::Text {
                        text_kind: TextKind::Text,
                        text: "x".repeat(9 * 1024 * 1024).into(),
                        provider_options: None,
                    },
                )],
                finish_reason: ModelFinishReason::Stop,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    );
    append(&log, &completed).await;
    let pause = HandoffPause {
        intent: HandoffIntent {
            handoff_id: "handoff".into(),
            host_epoch: "host".into(),
            root_run_id: "root".into(),
            successor_run_id: "successor-run".into(),
            successor_invocation_id: "successor-invocation".into(),
            claim_id: "claim".into(),
        },
        execution: super::handoff::execution(),
    };
    let before = log.prefix(100, usize::MAX).await.unwrap();
    log.check_handoff(&source.invocation, &pause).await.unwrap();
    assert_eq!(
        log.prefix(100, usize::MAX).await.unwrap().digest,
        before.digest
    );
    let seal = RuntimeEvent::new(
        source.invocation.clone(),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::HandoffPaused {
                pause: pause.clone(),
            },
        },
    );
    append(&log, &seal).await;
    let sealed = log
        .run_source("session", "root", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(sealed.boundary.high_water, 4);
    assert_eq!(sealed.last.event, seal);
    assert!(matches!(
        log.capture_lineage_context(&sealed.boundary, 100, 8 * 1024 * 1024)
            .await,
        Err(StoreError::PrefixTooLarge)
    ));
    assert!(matches!(
        log.capture_lineage_context(&sealed.boundary, 1, usize::MAX)
            .await,
        Err(StoreError::PrefixTooLarge)
    ));
    let cancelled = log.cancel_handoff(&source.invocation).await.unwrap();
    assert_eq!(
        cancelled.invocation,
        pause.intent.successor(&source.invocation)
    );
    assert_eq!(cancelled.root_invocation(), &source.invocation);
    let InvocationState::Ended {
        event_id: cancelled_event_id,
        outcome: cancelled_outcome,
    } = &cancelled.state
    else {
        panic!("cancellation did not settle")
    };
    assert!(matches!(cancelled_outcome,
        InvocationOutcome::Cancelled { source } if source == "runtime_cancellation"
    ));
    let successor = log
        .run_source("session", "successor-run", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(successor.boundary.high_water, 2);
    let Fact::InvocationOpened {
        configuration,
        input:
            InvocationInput::Handoff {
                claim,
                pause: claimed_pause,
            },
    } = &successor.opening.event.fact
    else {
        panic!("cancellation did not acquire the sealed handoff")
    };
    let Fact::InvocationOpened {
        configuration: original_configuration,
        ..
    } = &source.fact
    else {
        unreachable!()
    };
    assert_eq!(configuration, original_configuration);
    assert_eq!(**claimed_pause, pause);
    assert_eq!(claim.id, "claim");
    assert_eq!(claim.source, sealed.boundary);
    assert_eq!(
        claim.base,
        SessionBase {
            high_water: base.source_evidence.high_water,
            digest: base.source_evidence.digest,
        }
    );
    assert_eq!(claim.replay, pause.execution.replay);
    let selected = log
        .capture_lineage_context(&successor.boundary, usize::MAX, usize::MAX)
        .await
        .unwrap();
    assert!(selected.tail.iter().any(|event| matches!(event,
        ContextEvent::Canonical(stored) if stored.event == completed
    )));
    assert_eq!(
        log.run_source("session", "root", None)
            .await
            .unwrap()
            .unwrap()
            .boundary,
        sealed.boundary
    );
    assert!(log.pending_handoffs(0).await.unwrap().is_empty());
    let before = log.prefix(100, usize::MAX).await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let owner = log.cancel_handoff(&source.invocation).await.unwrap();
    assert_eq!(owner.invocation, successor.boundary.invocation);
    let InvocationState::Ended { event_id, outcome } = owner.state else {
        panic!("reopen lost the cancellation owner")
    };
    assert_eq!(&event_id, cancelled_event_id);
    assert_eq!(&outcome, cancelled_outcome);
    assert_eq!(
        log.prefix(100, usize::MAX).await.unwrap().digest,
        before.digest
    );
    assert_eq!(
        log.run_source("session", "root", None)
            .await
            .unwrap()
            .unwrap()
            .boundary,
        sealed.boundary
    );
    log.capture_lineage_context(&successor.boundary, usize::MAX, usize::MAX)
        .await
        .unwrap();
    log.close().await.unwrap();
}

fn model_part(
    invocation: &str,
    step: &str,
    ordinal: u64,
    part: maka_agent_facts::model::ModelPart,
) -> maka_agent_facts::model::recorded::CompletionPart {
    use maka_agent_facts::model::{
        ModelPart,
        recorded::{CompletionPart, ModelPartRecord},
    };
    let message_id = match &part {
        ModelPart::ToolCall { call } => {
            maka_agent_facts::tool_call::tool_use_id(invocation, &format!("{step}:{}", call.id))
        }
        _ => uuid::Uuid::new_v4().to_string(),
    };
    CompletionPart::Own(ModelPartRecord {
        ordinal,
        message_id,
        started_at: std::time::SystemTime::now(),
        provider_part_id: None,
        part: std::sync::Arc::new(part),
    })
}
