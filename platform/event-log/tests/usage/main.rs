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

use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::session::CopyPurpose;
use maka_event_log::{
    EventLog,
    sessions::{SessionCopy, SessionCopyResult, SessionRetirement},
    usage::Outcome,
};
use serde_json::json;
mod fixture;
use fixture::{event, query, request};

#[tokio::test]
async fn physical_attempt_usage_survives_rejection_copy_removal_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("usage.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("source", "fixture", &json!({}), 1)
        .await
        .unwrap();
    let rejected = request("rejected", 1000);
    let retry = request("retry", 2000);
    let success = request("success", 3000);
    let reported = ModelUsage {
        input_tokens: Some(100),
        output_tokens: Some(20),
        cache_read_tokens: Some(80),
        ..Default::default()
    };
    let writes = [
        event(
            Fact::InvocationOpened {
                input: InvocationInput::Message {
                    content: "question".into(),
                    source_messages: vec![],
                    request_fingerprint: None,
                },
                configuration: None,
            },
            0,
        ),
        rejected.clone(),
        event(
            Fact::ModelObserved {
                step_id: "rejected".into(),
                event: ModelEvent::Finished {
                    reason: ModelFinishReason::Length,
                    usage: reported.clone(),
                    provider_options: None,
                },
            },
            10000,
        ),
        event(
            Fact::ModelInterrupted {
                model_failure: None,
                diagnostic: None,
                step_id: "rejected".into(),
                status: ModelInterruption::Failed,
            },
            10250,
        ),
        retry.clone(),
        event(
            Fact::ModelInterrupted {
                model_failure: None,
                diagnostic: None,
                step_id: "retry".into(),
                status: ModelInterruption::RetryableFailure,
            },
            11500,
        ),
        success.clone(),
        event(
            Fact::ModelCompleted {
                step_id: "success".into(),
                output: ModelStep {
                    parts: vec![],
                    finish_reason: ModelFinishReason::Stop,
                    usage: ModelUsage {
                        input_tokens: Some(0),
                        ..Default::default()
                    },
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            },
            11500,
        ),
    ];
    // The second request exists at the fence, but has not settled yet.
    log.append_batch(&writes[..5]).await.unwrap();
    let captured = log.model_attempts(query(), 0, 100).await.unwrap();
    assert_eq!(captured.total, 1);
    log.append_batch(&writes[5..]).await.unwrap();
    let mut fixed = query();
    fixed.through = Some(captured.through);
    let historical = log.model_attempts(fixed.clone(), 0, 100).await.unwrap();
    assert_eq!(historical.attempts, captured.attempts);
    assert_eq!(historical.total, 1);
    let mut future = query();
    future.through = Some(u64::MAX);
    assert!(log.model_attempts(future, 0, 100).await.is_err());
    let terminal = event(
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
        12750,
    );
    log.append(&terminal).await.unwrap();
    log.append(&terminal).await.unwrap(); // Exact replay cannot count a second call.
    let first = log.model_attempts(query(), 0, 2).await.unwrap();
    assert_eq!(first.total, 3);
    assert_eq!(first.next_offset, Some(2));
    assert_eq!(first.attempts[0].request_id, success.event().id);
    assert_eq!(first.attempts[0].usage.input_tokens, Some(0));
    assert_eq!(first.attempts[0].usage.output_tokens, None);
    assert_eq!(first.attempts[1].request_id, retry.event().id);
    assert_eq!(first.attempts[1].outcome, Outcome::Error);
    assert_eq!(first.attempts[1].usage, ModelUsage::default());
    let second = log.model_attempts(query(), 2, 2).await.unwrap();
    assert_eq!(second.next_offset, None);
    assert_eq!(second.attempts[0].request_id, rejected.event().id);
    assert_eq!(second.attempts[0].outcome, Outcome::Error);
    assert_eq!(second.attempts[0].usage, reported);
    assert_eq!(second.attempts[0].completed_at, 10.25);
    assert!(
        second.attempts[0].binding.is_none(),
        "do not invent provider identity"
    );
    let mut fractional = query();
    fractional.from = 10.25;
    fractional.to = 10.25;
    assert_eq!(
        log.model_attempts(fractional.clone(), 0, 100)
            .await
            .unwrap()
            .total,
        1
    );
    fractional.from = 10.251;
    fractional.to = 100.0;
    assert_eq!(
        log.model_attempts(fractional, 0, 100).await.unwrap().total,
        2
    );

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
                    position: maka_agent_facts::session::ForkPosition::End,
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
    let snapshot = log.model_attempts(query(), 0, 100).await.unwrap().attempts;
    assert_eq!(
        snapshot.len(),
        3,
        "history membership is not another physical request"
    );
    let mut branch = query();
    branch.session_id = Some("branch".into());
    assert_eq!(log.model_attempts(branch, 0, 100).await.unwrap().total, 0);

    log.begin_session_removal("source", revision).await.unwrap();
    assert_eq!(
        log.finish_session_retirement("source").await.unwrap(),
        SessionRetirement::Removed
    );
    assert_eq!(
        log.model_attempts(query(), 0, 100).await.unwrap().attempts,
        snapshot
    );
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .model_attempts(fixed, 0, 100)
            .await
            .unwrap()
            .attempts,
        captured.attempts
    );
    assert_eq!(
        reopened
            .model_attempts(query(), 0, 100)
            .await
            .unwrap()
            .attempts,
        snapshot
    );
    reopened.close().await.unwrap();
}
#[tokio::test]
async fn lost_request_outcome_is_unknown_not_a_success_with_zero_usage() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("lost.sqlite"))
        .await
        .unwrap();
    log.append_batch(&[
        event(
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: "question".into(),
                    source_messages: vec![],
                    request_fingerprint: None,
                },
            },
            0,
        ),
        request("lost", 13000),
    ])
    .await
    .unwrap();
    assert_eq!(log.model_attempts(query(), 0, 100).await.unwrap().total, 0);
    log.append(&event(
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Failed {
                model_failure: None,
                class: "worker_lost".into(),
                message: None,
            },
        },
        12750,
    ))
    .await
    .unwrap();
    let page = log.model_attempts(query(), 0, 100).await.unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.attempts[0].outcome, Outcome::Unknown);
    assert_eq!(page.attempts[0].usage, ModelUsage::default());
    assert_eq!(
        page.attempts[0].latency_ms(),
        0.0,
        "wall clock moved backwards"
    );
    log.close().await.unwrap();
}
