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

use maka_agent_facts::context::CompactOutcome;
use maka_agent_facts::context::ContextCheckpoint;
use maka_agent_facts::context::TextSummary;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_event_log::{
    EventLog, StoreError,
    context::{HistoryCapture, HistoryCut, ModelContextSource},
};
use serde_json::json;

mod active;
mod fixtures;
mod frozen;
use fixtures::{SUMMARY, closed, prepare_trace, prepared};

#[tokio::test]
async fn repeated_checkpoints_cross_old_history_limits_with_bounded_tail_and_exact_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "history-source", &json!({}), 1)
        .await
        .unwrap();
    let mut last = Vec::new();
    for round in 0..3 {
        closed(&log, &format!("main-{round}"), 3 * 1024 * 1024, 3400).await;
        if round == 0 {
            let source = log
                .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
                .await
                .unwrap();
            let prefix = log
                .scoped_prefix(
                    LogScope::Session {
                        id: "session".into(),
                    },
                    10_000,
                    8 * 1024 * 1024,
                )
                .await
                .unwrap();
            assert_eq!(source.source_evidence.digest, prefix.digest);
        }
        last = prepare_trace(
            &log,
            &format!("compact-{round}"),
            if round == 2 { 10_001 } else { 0 },
            false,
        )
        .await;
        let commits = log.subscribe_commits();
        assert!(
            log.append(&last[0]).await.is_err(),
            "checkpoint without atomic domain terminal must roll back"
        );
        assert!(!commits.has_changed().unwrap());
        log.append_batch(&last).await.unwrap();
    }
    prepare_trace(&log, "failed-compact", 10_001, true).await;
    assert!(matches!(
        log.scoped_prefix(
            LogScope::Session {
                id: "session".into()
            },
            10_000,
            8 * 1024 * 1024
        )
        .await,
        Err(StoreError::PrefixTooLarge)
    ));
    let source = log
        .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(source.baseline.unwrap().event_id, last[0].event().id);
    assert!(source.tail.len() < 10);
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    let HistoryCapture::Captured(copied) = log
        .capture_session_history("session", revision, HistoryCut::End, 100, 8192)
        .await
        .unwrap()
    else {
        panic!("unchanged history");
    };
    assert_eq!(
        copied.context.baseline.unwrap().event_id,
        last[0].event().id
    );
    assert_eq!(
        copied.context.source_evidence.digest,
        source.source_evidence.digest
    );
    assert!(matches!(
        log.copy_session(
            maka_event_log::sessions::SessionCopy {
                source_session_id: "session".into(),
                target_session_id: "copied-session".into(),
                expected_source_revision: revision,
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    turn_id: None,
                    side_conversation: false
                },
            },
            &json!({}),
            2
        )
        .await
        .unwrap(),
        maka_event_log::sessions::SessionCopyResult::Committed(_)
    ));
    let inherited = log
        .capture_model_context("copied-session", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(inherited.baseline.unwrap().event_id, last[0].event().id);
    assert!(inherited.tail.len() < 10);
    assert!(
        matches!(
            log.capture_session_history(
                "session",
                revision,
                HistoryCut::ThroughTurn("main-0".into()),
                100,
                8192,
            )
            .await,
            Err(StoreError::PrefixTooLarge)
        ),
        "an earlier branch cannot borrow a later summary containing excluded Turns"
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let commits = log.subscribe_commits();
    log.append_batch(&last).await.unwrap();
    assert!(!commits.has_changed().unwrap());
    assert_eq!(
        log.capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
            .await
            .unwrap()
            .source_evidence
            .digest,
        source.source_evidence.digest
    );
    assert!(
        log.capture_model_context("other", None, 100_000, 64 * 1024 * 1024)
            .await
            .unwrap()
            .baseline
            .is_none()
    );
    let oversized = fixtures::event(
        "oversized",
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "x".repeat(9 * 1024 * 1024).into(),
                request_fingerprint: None,
            },
        },
    );
    log.append(&oversized).await.unwrap();
    log.invocation_recovery(&oversized.event().invocation, 100, 8192)
        .await
        .unwrap();
    log.append(&fixtures::event(
        "oversized",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Cancelled {
                source: "recovery".into(),
            },
        },
    ))
    .await
    .unwrap();
    assert!(
        log.unfinished_invocations(0, 10)
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn forged_summary_source_and_hidden_old_unknowns_never_become_a_baseline() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    closed(&log, "main", 32, 1).await;
    let pair = prepared(&log, "compact").await;
    for mutation in [0, 1, 2] {
        let mut forged = pair[0].event().clone();
        let Fact::ContextCheckpointRecorded { checkpoint } = &mut forged.fact else {
            panic!()
        };
        match mutation {
            0 => checkpoint.source_digest = format!("sha256:{}", "0".repeat(64)),
            1 => checkpoint.summary.text = "forged summary text".into(),
            _ => checkpoint.previous_checkpoint_id = Some(forged.id.clone()),
        }
        assert!(
            log.append_batch(&[EventWrite::plain(forged).unwrap(), pair[1].clone()])
                .await
                .is_err()
        );
    }
    log.append_batch(&pair).await.unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "unknown".into(),
        run_id: "unknown".into(),
        invocation_id: "unknown".into(),
    };
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "new work".into(),
                source_messages: Vec::new(),
                request_fingerprint: None,
            },
        },
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "hidden".into(),
            call: ToolCallIdentity::standalone("hidden-call".into()),
            name: "write".into(),
            input: json!({}),
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Failed {
                class: "outcome_unknown".into(),
                message: None,
                model_failure: None,
            },
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
    let error = log
        .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("unresolved prior execution"));
    assert!(
        log.capture_compaction_context(
            "session",
            None,
            &maka_agent_facts::context::CheckpointMode::Standalone,
            100_000,
            64 * 1024 * 1024
        )
        .await
        .is_err()
    );
    log.close().await.unwrap();
}
