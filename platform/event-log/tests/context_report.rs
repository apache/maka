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
    context::{
        CheckpointMode, ContextBucket, ContextCounts, ModelPurpose, ModelRequestContext,
        PreparedContextBreakdown,
    },
    event::{
        CommitError, EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, LogScope,
        ModelInterruption, RuntimeEvent,
    },
    model::{ModelFinishReason, ModelStep, ModelUsage},
    session::CopyPurpose,
};
use maka_event_log::{
    EventLog, StoreError,
    context::ContextRequestState,
    sessions::{SessionCopy, SessionCopyResult},
};
use serde_json::json;

fn event(session: &str, invocation: &str, fact: Fact) -> RuntimeEvent {
    RuntimeEvent::new(
        Invocation {
            session_id: session.into(),
            turn_id: format!("turn-{invocation}"),
            run_id: format!("run-{invocation}"),
            invocation_id: invocation.into(),
        },
        fact,
    )
}
fn write(event: RuntimeEvent) -> EventWrite {
    EventWrite::plain(event).unwrap()
}
fn opening(session: &str, invocation: &str) -> EventWrite {
    write(event(
        session,
        invocation,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "Question".into(),
                source_messages: vec![],
                request_fingerprint: None,
            },
        },
    ))
}
fn measured() -> PreparedContextBreakdown {
    PreparedContextBreakdown {
        system: ContextBucket {
            content_bytes: 12,
            estimated_tokens: 4,
        },
        user: ContextBucket {
            content_bytes: 15,
            estimated_tokens: 21,
        },
        assistant: ContextBucket::default(),
        tool: ContextBucket::default(),
        tool_schemas: ContextBucket {
            content_bytes: 2,
            estimated_tokens: 1,
        },
        counts: ContextCounts {
            messages: 1,
            media: 0,
            tool_calls: 0,
            tool_results: 0,
            tools: 0,
        },
    }
}
fn request(
    session: &str,
    invocation: &str,
    step: &str,
    breakdown: Option<PreparedContextBreakdown>,
) -> RuntimeEvent {
    event(
        session,
        invocation,
        Fact::ModelRequested {
            item_acceptance: false,
            step_id: step.into(),
            model_id: format!("model-{invocation}"),
            source_scope: LogScope::Session { id: session.into() },
            source_high_water: 0,
            source_digest: "fixture".into(),
            input_digest: "prepared-input".into(),
            route_identity: "selected-route".into(),
            checkpoint_event_id: None,
            purpose: ModelPurpose::Main,
            effective_source_digest: None,
            context_breakdown: breakdown,
            context: Some(ModelRequestContext {
                provider_id: "fixture-provider".into(),
                context_window: Some(8000),
                model_context_window: Some(12000),
                declared_window: Some(6800),
            }),
        },
    )
}
fn complete(session: &str, invocation: &str, step: &str, tokens: u64) -> EventWrite {
    write(event(
        session,
        invocation,
        Fact::ModelCompleted {
            step_id: step.into(),
            output: ModelStep {
                parts: vec![],
                finish_reason: ModelFinishReason::Stop,
                usage: ModelUsage {
                    input_tokens: Some(tokens),
                    ..Default::default()
                },
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ))
}
fn interrupted(session: &str, invocation: &str, step: &str) -> EventWrite {
    write(event(
        session,
        invocation,
        Fact::ModelInterrupted {
            step_id: step.into(),
            status: ModelInterruption::Failed,
            diagnostic: None,
            model_failure: None,
        },
    ))
}
fn ended(session: &str, invocation: &str, outcome: InvocationOutcome) -> EventWrite {
    write(event(
        session,
        invocation,
        Fact::InvocationEnded { outcome },
    ))
}
fn failed() -> InvocationOutcome {
    InvocationOutcome::Failed {
        class: "model".into(),
        message: None,
        model_failure: None,
    }
}

#[tokio::test]
async fn context_report_tracks_latest_own_main_at_exact_fences_and_survives_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("source", "fixture", &json!({}), 1)
        .await
        .unwrap();
    assert!(
        log.context_report("source", None)
            .await
            .unwrap()
            .request
            .is_none()
    );
    log.append(&opening("source", "first")).await.unwrap();
    let first = request("source", "first", "shared-step", Some(measured()));
    let first_recorded_at = first.recorded_at;
    let requested_sequence = log.append(&write(first)).await.unwrap();
    let requested = log
        .context_report("source", Some(requested_sequence))
        .await
        .unwrap();
    let selected = requested.request.as_ref().unwrap();
    assert_eq!(requested.through, requested_sequence);
    assert_eq!(selected.invocation_id, "first");
    assert_eq!(selected.step_id, "shared-step");
    assert_eq!(selected.sequence, requested_sequence);
    assert_eq!(selected.source_through, 0);
    assert_eq!(selected.recorded_at, first_recorded_at);
    assert_eq!(selected.model_id, "model-first");
    assert_eq!(selected.context_window, Some(12000));
    assert_eq!(selected.input_limit, Some(8000));
    assert_eq!(selected.state, ContextRequestState::Requested);
    assert_eq!(selected.breakdown, Some(measured()));
    assert_eq!(selected.reported_input_tokens, None);
    let completed_sequence = log
        .append(&complete("source", "first", "shared-step", 37))
        .await
        .unwrap();
    let completed = log
        .context_report("source", Some(completed_sequence))
        .await
        .unwrap();
    let selected = completed.request.as_ref().unwrap();
    assert_eq!(selected.state, ContextRequestState::Completed);
    assert_eq!(selected.reported_input_tokens, Some(37));
    assert_eq!(selected.breakdown, Some(measured()));
    assert_eq!(selected.sequence, requested_sequence);
    log.append(&ended("source", "first", InvocationOutcome::Completed))
        .await
        .unwrap();

    // A real compaction opening/request has a later sequence but is not Main.
    log.append(&write(event(
        "source",
        "summary",
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::ContextCompact {
                request_fingerprint: "summary-request".into(),
            },
        },
    )))
    .await
    .unwrap();
    let source = log
        .capture_compaction_context(
            "source",
            Some("summary"),
            &CheckpointMode::Standalone,
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    let mut summary = request("source", "summary", "summary-step", Some(measured()));
    let Fact::ModelRequested {
        purpose,
        source_scope,
        source_high_water,
        source_digest,
        effective_source_digest,
        checkpoint_event_id,
        ..
    } = &mut summary.fact
    else {
        unreachable!()
    };
    *purpose = ModelPurpose::Summary;
    *source_scope = source.source_evidence.scope;
    *source_high_water = source.source_evidence.high_water;
    *source_digest = source.source_evidence.digest;
    *effective_source_digest = Some(source.effective_source_digest);
    *checkpoint_event_id = source.baseline.map(|baseline| baseline.event_id);
    let summary_sequence = log.append(&write(summary)).await.unwrap();
    let summary_report = log
        .context_report("source", Some(summary_sequence))
        .await
        .unwrap();
    assert_eq!(summary_report.request, completed.request);
    log.append(&interrupted("source", "summary", "summary-step"))
        .await
        .unwrap();
    log.append(&ended("source", "summary", failed()))
        .await
        .unwrap();

    // The newer request must not borrow an older completed request measurement or usage.
    log.append(&opening("source", "second")).await.unwrap();
    let unmeasured_sequence = log
        .append(&write(request("source", "second", "second-step", None)))
        .await
        .unwrap();
    let unmeasured = log
        .context_report("source", Some(unmeasured_sequence))
        .await
        .unwrap();
    let selected = unmeasured.request.as_ref().unwrap();
    assert_eq!(selected.invocation_id, "second");
    assert_eq!(selected.state, ContextRequestState::Requested);
    assert_eq!(selected.breakdown, None);
    assert_eq!(selected.reported_input_tokens, None);
    let interrupted_sequence = log
        .append(&interrupted("source", "second", "second-step"))
        .await
        .unwrap();
    let interrupted_report = log
        .context_report("source", Some(interrupted_sequence))
        .await
        .unwrap();
    let selected = interrupted_report.request.as_ref().unwrap();
    assert_eq!(selected.state, ContextRequestState::Interrupted);
    assert_eq!(selected.breakdown, None);
    assert_eq!(selected.reported_input_tokens, None);
    log.append(&ended("source", "second", failed()))
        .await
        .unwrap();

    let revision = log
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        log.copy_session(
            SessionCopy {
                source_session_id: "source".into(),
                target_session_id: "branch".into(),
                expected_source_revision: revision,
                purpose: CopyPurpose::Branch {
                    turn_id: None,
                    side_conversation: false
                },
            },
            &json!({}),
            2
        )
        .await
        .unwrap(),
        SessionCopyResult::Committed(_)
    ));
    let copied = log.context_report("branch", None).await.unwrap();
    assert!(
        copied.request.is_none(),
        "copied membership is not an own model request"
    );
    log.append(&opening("branch", "branch-own")).await.unwrap();
    let scope = LogScope::Lineage {
        session_id: "branch".into(),
        run_id: "run-branch-own".into(),
    };
    let source = log.scoped_prefix(scope, 100, 128 * 1024).await.unwrap();
    let mut own = request("branch", "branch-own", "branch-step", Some(measured()));
    let Fact::ModelRequested {
        source_scope,
        source_high_water,
        source_digest,
        ..
    } = &mut own.fact
    else {
        unreachable!()
    };
    *source_scope = source.scope;
    *source_high_water = source.high_water;
    *source_digest = source.digest;
    let own_sequence = log.append(&write(own)).await.unwrap();
    let branch = log
        .context_report("branch", Some(own_sequence))
        .await
        .unwrap();
    assert_eq!(branch.request.as_ref().unwrap().invocation_id, "branch-own");
    assert_eq!(branch.request.as_ref().unwrap().breakdown, Some(measured()));
    assert_eq!(
        log.context_report("source", None).await.unwrap().request,
        interrupted_report.request,
        "another Session request must not replace this Session Main"
    );
    assert!(
        log.context_report("source", Some(own_sequence + 1))
            .await
            .is_err()
    );

    assert!(
        log.context_report("source", Some(9_007_199_254_740_992))
            .await
            .is_err(),
        "read fences must remain JS-safe"
    );

    let frozen = [
        (requested_sequence, requested),
        (completed_sequence, completed),
        (summary_sequence, summary_report),
        (unmeasured_sequence, unmeasured),
        (interrupted_sequence, interrupted_report),
    ];
    for (through, expected) in &frozen {
        assert_eq!(
            log.context_report("source", Some(*through)).await.unwrap(),
            *expected
        );
    }
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    for (through, expected) in frozen {
        assert_eq!(
            log.context_report("source", Some(through)).await.unwrap(),
            expected
        );
    }
    assert_eq!(
        log.context_report("branch", Some(copied.through))
            .await
            .unwrap(),
        copied
    );
    assert_eq!(
        log.context_report("branch", Some(own_sequence))
            .await
            .unwrap(),
        branch
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn context_measurement_is_immutable_and_rejects_unsafe_values() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("context.sqlite"))
        .await
        .unwrap();
    log.create_session("source", "fixture", &json!({}), 1)
        .await
        .unwrap();
    log.append(&opening("source", "first")).await.unwrap();
    let accepted = request("source", "first", "first-step", Some(measured()));
    let original = write(accepted.clone());
    let sequence = log.append(&original).await.unwrap();
    assert_eq!(log.append(&original).await.unwrap(), sequence);
    let frozen = log.context_report("source", None).await.unwrap();
    let mut conflicting = accepted;
    let Fact::ModelRequested {
        context_breakdown: Some(breakdown),
        ..
    } = &mut conflicting.fact
    else {
        unreachable!()
    };
    breakdown.user.content_bytes += 1;
    assert!(
        matches!(log.append(&write(conflicting)).await,Err(CommitError::Rejected(reason)) if reason == StoreError::EventConflict.to_string())
    );
    assert_eq!(log.context_report("source", None).await.unwrap(), frozen);
    log.append(&complete("source", "first", "first-step", 0))
        .await
        .unwrap();
    log.append(&ended("source", "first", InvocationOutcome::Completed))
        .await
        .unwrap();

    const MAX: u64 = 9_007_199_254_740_991;
    let mut unsafe_count = measured();
    unsafe_count.counts.media = MAX + 1;
    let mut unsafe_bytes = measured();
    unsafe_bytes.system.content_bytes = MAX;
    let mut unsafe_tokens = measured();
    unsafe_tokens.system.estimated_tokens = MAX;
    for (index, breakdown) in [unsafe_count, unsafe_bytes, unsafe_tokens]
        .into_iter()
        .enumerate()
    {
        let invocation = format!("invalid-{index}");
        log.append(&opening("source", &invocation)).await.unwrap();
        let before = log.context_report("source", None).await.unwrap();
        assert!(matches!(
            log.append(&write(request(
                "source",
                &invocation,
                "invalid-step",
                Some(breakdown)
            )))
            .await,
            Err(CommitError::Rejected(_))
        ));
        assert_eq!(
            log.context_report("source", None).await.unwrap(),
            before,
            "invalid measurement must not commit a request or advance the fence"
        );
        log.append(&ended("source", &invocation, failed()))
            .await
            .unwrap();
    }
    log.close().await.unwrap();
}
