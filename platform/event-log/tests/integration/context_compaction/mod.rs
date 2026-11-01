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
use maka_agent_facts::model::recorded::ModelCompletion;
use maka_agent_facts::model::recorded::ModelObservation;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_event_log::{EventLog, StoreError, context::ModelContextSource};
use serde_json::json;

mod active;
mod fixtures;
mod frozen;
use fixtures::{SUMMARY, closed, prepared};

#[tokio::test]
async fn forged_summary_source_is_rejected() {
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
    log.close().await.unwrap();
}

#[tokio::test]
async fn failed_tool_history_can_be_compacted_and_pruned_without_losing_uncertainty() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    closed(&log, "main", 32, 1).await;
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "inspect the browser".into(),
                source_messages: Vec::new(),
                request_fingerprint: None,
            },
        },
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "browser-operation".into(),
            call: ToolCallIdentity::standalone("browser-call".into()),
            name: "browser".into(),
            input: json!({}),
        },
    ] {
        log.append(&fixtures::event("unknown", fact)).await.unwrap();
    }
    assert!(matches!(
        log.prepare_compaction_view(
            "session",
            None,
            &maka_agent_facts::context::CheckpointMode::Standalone
        )
        .await,
        Err(StoreError::HistoryUnsettled)
    ));
    log.append(&fixtures::event(
        "unknown",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Failed {
                class: "outcome_unknown".into(),
                message: None,
                model_failure: None,
            },
        },
    ))
    .await
    .unwrap();
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    let pair = prepared(&log, "compact").await;
    log.append_batch(&pair).await.unwrap();
    log.prepare_prune_candidates("session", None, 0, 0, None)
        .await
        .unwrap();
    let view = log.read_model_view("session", None).await.unwrap();
    assert_eq!(view.baseline.unwrap().checkpoint.summary.text, SUMMARY);
    let history = log.prefix(100, 128 * 1024).await.unwrap();
    assert!(
        history
            .events
            .iter()
            .any(|stored| matches!(&stored.event.fact,
        Fact::ToolDispatched { operation_id, .. } if operation_id == "browser-operation"))
    );
    assert!(
        !history
            .events
            .iter()
            .any(|stored| matches!(&stored.event.fact,
        Fact::ToolSettled { operation_id, .. } if operation_id == "browser-operation"))
    );
    log.close().await.unwrap();
}
