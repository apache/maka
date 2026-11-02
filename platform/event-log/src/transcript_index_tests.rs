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
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::history::RowPosition;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::recorded::{
    CompletionPart, ModelCompletion, ModelObservation, ModelPartRecord, ModelPartial,
};

use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::model::TextKind;
use maka_event_log::{EventLog, StoreError};
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};

mod accepted_observations;
mod fixtures;
mod history;
mod image;
mod prefix_replay;
mod source;
use fixtures::*;

#[tokio::test]
async fn partial_freezes_at_interruption_and_old_fence_excludes_later_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let (part, live) = partial(&log, "a", "partial😀").await;
    let id = part.message_id.clone();
    let interrupted = interrupt(&log, "a", part).await;
    let ended = end(
        &log,
        "a",
        InvocationOutcome::Cancelled {
            source: "user".into(),
        },
    )
    .await;
    let invocation = event("a", opening()).event().invocation.clone();
    let overlay = log.active_transcript(&invocation, live).await.unwrap();
    assert!(overlay.is_empty());
    assert!(
        log.active_transcript(&invocation, interrupted)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        log.active_transcript(&invocation, ended)
            .await
            .unwrap()
            .is_empty()
    );
    crate::transcript_cache::materialize_all_rows(&log, "a", live)
        .await
        .unwrap();
    let running = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
    assert_eq!(running.len(), 2);
    let state: Value = serde_json::from_slice(&running[1].1).unwrap();
    assert_eq!(state["type"], "turn_state");
    assert_eq!(
        state["status"], "running",
        "pending work is not interrupted"
    );

    crate::transcript_cache::materialize_all_rows(&log, "a", interrupted)
        .await
        .unwrap();
    let frozen = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
    assert_eq!(frozen.len(), 3);
    let assistant: Value = serde_json::from_slice(&frozen[2].1).unwrap();
    assert_eq!(assistant["id"], id);
    assert_eq!(assistant["text"], "partial😀");
    crate::transcript_cache::materialize_all_rows(&log, "a", ended)
        .await
        .unwrap();
    let final_rows = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
    assert_eq!(&final_rows[..3], frozen.as_slice());
    assert_eq!(final_rows.len(), 4); // no invented unknown usage
    let terminal: Value = serde_json::from_slice(&final_rows[3].1).unwrap();
    assert_eq!(terminal["status"], "aborted");
}

#[tokio::test]
async fn terminal_without_model_interruption_does_not_invent_unsealed_preview() {
    for outcome in [
        InvocationOutcome::Failed {
            model_failure: None,
            class: "event_commit".into(),
            message: None,
        },
        InvocationOutcome::Cancelled {
            source: "shutdown".into(),
        },
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("log.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        let (_part, live) = partial(&log, "a", "committed😀 prefix").await;
        let invocation = event("a", opening()).event().invocation.clone();
        let overlay = log.active_transcript(&invocation, live).await.unwrap();
        crate::transcript_cache::materialize_all_rows(&log, "a", live)
            .await
            .unwrap();
        // A persistence fault may prevent ModelInterrupted while a later
        // terminal append succeeds. The source facts allow this boundary.
        let through = end(&log, "a", outcome.clone()).await;
        crate::transcript_cache::materialize_all_rows(&log, "a", through)
            .await
            .unwrap();
        assert!(
            log.active_transcript(&invocation, through)
                .await
                .unwrap()
                .is_empty()
        );
        let original = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
        assert_eq!(original.len(), 3); // user, running, terminal; no unsealed preview
        assert!(overlay.is_empty());
        let delivery = log
            .session_stream_events("a", live, through, 8, 4096)
            .await
            .unwrap();
        assert!(matches!(&delivery.events[0].fact,
            maka_event_log::observation::StreamFact::InvocationEnded { interrupted, .. }
            if interrupted.is_empty()));
        assert_eq!(
            original[2].0,
            RowPosition {
                source_sequence: through,
                item_index: 0
            }
        );
        let terminal: Value = serde_json::from_slice(&original[2].1).unwrap();
        assert_eq!(
            terminal["status"],
            if matches!(outcome, InvocationOutcome::Failed { .. }) {
                "failed"
            } else {
                "aborted"
            }
        );
        // Index reset and process reopen must not drop or relabel the prefix.
        crate::test_store::inspect_cache(&log, move |db| {
            db.execute_batch("DELETE FROM temp.transcript_text; DELETE FROM temp.transcript_rows")
                .unwrap()
        })
        .await;
        log.close().await.unwrap();
        let reopened = EventLog::open(&path).await.unwrap();
        crate::transcript_cache::materialize_all_rows(&reopened, "a", through)
            .await
            .unwrap();
        assert_eq!(
            crate::test_store::inspect_cache(&reopened, |db| rows(db, "a")).await,
            original
        );
        assert_eq!(
            reopened.active_transcript(&invocation, live).await.unwrap(),
            overlay
        );
    }
}
