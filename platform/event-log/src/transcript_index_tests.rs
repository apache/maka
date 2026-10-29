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
mod interrupted_ancestry;
mod large_siblings;
mod performance;
mod performance_executor;
mod prefix_replay;
mod source;
mod sparse_directory;
use fixtures::*;

#[tokio::test]
async fn completed_bytes_digest_identity_reopen_and_selected_rebuild() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    crate::transcript_cache::materialize_all_rows(&log, "a", 0)
        .await
        .unwrap();
    assert!(
        log.transcript_headers(
            "a",
            &maka_event_log::transcript::TranscriptRead {
                through: 0,
                position: None,
                direction: maka_event_log::transcript::TranscriptDirection::Newer,
                limit: 1,
            }
        )
        .await
        .unwrap()
        .is_empty()
    );
    let (part, _) = partial(&log, "a", "hello😀").await;
    let id = part.message_id.clone();
    log.append(&event(
        "a",
        Fact::ModelCompleted {
            step_id: "step-a".into(),
            output: ModelCompletion {
                parts: vec![CompletionPart::Own(part)],
                finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
                usage: ModelUsage {
                    input_tokens: Some(9),
                    output_tokens: Some(3),
                    ..Default::default()
                },
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ))
    .await
    .unwrap();
    let through = end(&log, "a", InvocationOutcome::Completed).await;
    let wake = log.subscribe_commits();
    crate::transcript_cache::materialize_all_rows(&log, "a", through)
        .await
        .unwrap();
    assert!(!wake.has_changed().unwrap());
    let db = Connection::open(&path).unwrap();
    let original = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
    assert_eq!(original.len(), 5);
    let assistant: Value = serde_json::from_slice(&original[2].1).unwrap();
    assert_eq!(assistant["id"], id);
    assert_eq!(assistant["modelId"], "real-model");
    for (_, bytes, digest, size) in &original {
        assert_eq!(*size, bytes.len() as i64);
        assert_eq!(
            *digest,
            format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
        );
    }
    // Optional bodies may be discarded; selected reconstruction preserves the same rows.
    crate::test_store::inspect_cache(&log, move |db| {
        db.execute_batch("DELETE FROM temp.transcript_text; DELETE FROM temp.transcript_rows")
            .unwrap()
    })
    .await;
    crate::transcript_cache::materialize_all_rows(&log, "a", through)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        original
    );
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    crate::transcript_cache::materialize_all_rows(&reopened, "a", through)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&reopened, |db| rows(db, "a")).await,
        original
    );
    let canonical = serde_json::to_vec(&reopened.prefix(32, 65536).await.unwrap()).unwrap();
    // This real completed producer emits assistant then usage. Derive positions
    // from the emitted fixture, rather than assuming fixed event/ordinal numbers.
    let assistant_row = original
        .iter()
        .find(|row| serde_json::from_slice::<Value>(&row.1).unwrap()["type"] == "assistant")
        .unwrap();
    let usage_row = original
        .iter()
        .find(|row| serde_json::from_slice::<Value>(&row.1).unwrap()["type"] == "token_usage")
        .unwrap();
    assert_eq!(assistant_row.0.source_sequence, usage_row.0.source_sequence);
    assert_eq!(
        original
            .iter()
            .filter(|row| row.0.source_sequence == assistant_row.0.source_sequence)
            .map(|row| row.0)
            .collect::<Vec<_>>(),
        [assistant_row.0, usage_row.0]
    );
    let assistant_source = i64::try_from(assistant_row.0.source_sequence).unwrap();
    let assistant_item = i64::try_from(assistant_row.0.item_index).unwrap();
    let usage_source = i64::try_from(usage_row.0.source_sequence).unwrap();
    let usage_item = i64::try_from(usage_row.0.item_index).unwrap();
    // Preserve the original byte-identity refusal: a missing sibling triggers
    // whole-S reconstruction, which must not overwrite an existing bad payload.
    crate::test_store::inspect_cache(&reopened, move |db| { db.execute("UPDATE temp.transcript_rows SET payload=X'00' WHERE session_id='a' AND source_sequence=?1 AND item_index=?2",[assistant_source,assistant_item]).unwrap() }).await;
    crate::test_store::inspect_cache(&reopened, move |db| { db.execute(
        "DELETE FROM temp.transcript_rows WHERE session_id='a' AND source_sequence=?1 AND item_index=?2",
        [usage_source, usage_item],
    )
    .unwrap() }).await;
    let damaged = crate::test_store::inspect_cache(&reopened, |db| rows(db, "a")).await;
    assert!(matches!(
        reopened
            .transcript_headers(
                "a",
                &maka_event_log::transcript::TranscriptRead {
                    through,
                    position: Some(usage_row.0),
                    direction: maka_event_log::transcript::TranscriptDirection::Newer,
                    limit: 1,
                }
            )
            .await,
        Err(StoreError::TranscriptConflict)
    ));
    assert_eq!(
        crate::test_store::inspect_cache(&reopened, |db| rows(db, "a")).await,
        damaged
    );
    assert_eq!(
        serde_json::to_vec(&reopened.prefix(32, 65536).await.unwrap()).unwrap(),
        canonical
    );
    let restore_payload = assistant_row.1.clone();
    crate::test_store::inspect_cache(&reopened, move |db| { db.execute("UPDATE temp.transcript_rows SET payload=?1 WHERE session_id='a' AND source_sequence=?2 AND item_index=?3",rusqlite::params![restore_payload,assistant_source,assistant_item]).unwrap() }).await;
    crate::transcript_cache::materialize_all_rows(&reopened, "a", through)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&reopened, |db| rows(db, "a")).await,
        original
    );
    // Cache hits retain their separate directory-identity check without hashing
    // every cached payload on each fragment.
    let identity_position = original[1].0;
    crate::test_store::inspect_cache(&reopened, move |db| { db.execute(
        "UPDATE temp.transcript_rows SET turn_id = 'wrong-turn' WHERE source_sequence = ? AND item_index = ?",
        [i64::try_from(identity_position.source_sequence).unwrap(),i64::try_from(identity_position.item_index).unwrap()],
    ).unwrap() }).await;
    assert!(matches!(
        crate::transcript_cache::materialize_all_rows(&reopened, "a", through).await,
        Err(StoreError::TranscriptConflict)
    ));
    assert_eq!(
        serde_json::to_vec(&reopened.prefix(32, 65536).await.unwrap()).unwrap(),
        canonical
    );
    reopened.close().await.unwrap();
    db.close().map_err(|(_, error)| error).unwrap();
    // All connections are now closed (including the last SQLite connection's
    // WAL close/checkpoint). Copy this task fixture, never a live-WAL DB or hardlink.
    for operation in ["headers", "fragment", "turn_bounds"] {
        let copy = temp.path().join(format!("{operation}.sqlite"));
        std::fs::copy(&path, &copy).unwrap();
        let copied = EventLog::open(&copy).await.unwrap();
        crate::transcript_cache::materialize_all_rows(&copied, "a", through)
            .await
            .unwrap();
        // A miss inserts the first emitted row, then the existing second row
        // fails the exact byte comparison. Only optional cache bytes are damaged.
        crate::test_store::inspect_cache(&copied, move |fault| { fault.execute("DELETE FROM temp.transcript_rows WHERE session_id='a' AND source_sequence=?1 AND item_index=?2",[assistant_source,assistant_item]).unwrap() }).await;
        crate::test_store::inspect_cache(&copied, move |fault| { fault.execute("UPDATE temp.transcript_rows SET payload=X'00' WHERE session_id='a' AND source_sequence=?1 AND item_index=?2",[usage_source,usage_item]).unwrap() }).await;
        let before = crate::test_store::inspect_cache(&copied, |db| rows(db, "a")).await;
        let error = match operation {
            "headers" => copied
                .transcript_headers(
                    "a",
                    &maka_event_log::transcript::TranscriptRead {
                        through,
                        position: Some(assistant_row.0),
                        direction: maka_event_log::transcript::TranscriptDirection::Newer,
                        limit: 1,
                    },
                )
                .await
                .unwrap_err(),
            "fragment" => copied
                .transcript_fragment("a", assistant_row.0, 0, 1)
                .await
                .unwrap_err(),
            "turn_bounds" => copied
                .transcript_turn_bounds("a", "turn-a", through)
                .await
                .unwrap_err(),
            _ => unreachable!(),
        };
        assert!(
            matches!(&error, StoreError::TranscriptConflict),
            "{operation}: {error}"
        );
        assert_eq!(
            serde_json::to_vec(&copied.prefix(32, 65536).await.unwrap()).unwrap(),
            canonical
        );
        assert_eq!(
            crate::test_store::inspect_cache(&copied, |db| rows(db, "a")).await,
            before,
            "{operation}: failed source fill must roll back its first row"
        );
        copied.close().await.unwrap();
    }
}

#[tokio::test]
async fn interleaved_stream_preserves_order_and_excludes_other_session_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let expected = format!(
        "start\n{}",
        (0..1024).map(|i| format!("{i}😀\n")).collect::<String>()
    );
    let (part, _) = partial(&log, "a", &expected).await;
    let id = part.message_id.clone();
    let (part_b, _) = partial(
        &log,
        "b",
        &format!("unrelated{}", "not part of a".repeat(1024)),
    )
    .await;
    let events: Vec<_> = (0..128)
        .flat_map(|i| {
            ["a", "b"].map(move |session| {
                event(
                    session,
                    observe(
                        session,
                        ModelObservation::ResponseMetadata {
                            id: Some(format!("response-{session}-{i}")),
                            model: None,
                            timestamp: None,
                        },
                    ),
                )
            })
        })
        .collect();
    log.append_batch(&events).await.unwrap();
    let through = interrupt(&log, "a", part).await;
    crate::transcript_cache::materialize_all_rows(&log, "a", through)
        .await
        .unwrap();

    let projected = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
    assert_eq!(projected.len(), 3);
    let assistant: Value = serde_json::from_slice(&projected[2].1).unwrap();
    assert_eq!(assistant["id"], id);
    assert_eq!(assistant["text"], expected);

    let other_id = part_b.message_id.clone();
    let other = log
        .append(&event(
            "b",
            Fact::ModelCompleted {
                step_id: "step-b".into(),
                output: ModelCompletion {
                    parts: vec![CompletionPart::Own(part_b)],
                    finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
                    usage: ModelUsage::default(),
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            },
        ))
        .await
        .unwrap();
    crate::transcript_cache::materialize_all_rows(&log, "b", other)
        .await
        .unwrap();
    let other_rows = crate::test_store::inspect_cache(&log, |db| rows(db, "b")).await;
    let assistant: Value = serde_json::from_slice(&other_rows[2].1).unwrap();
    assert_eq!(assistant["id"], other_id);
    assert_eq!(
        assistant["text"],
        format!("unrelated{}", "not part of a".repeat(1024))
    );
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        projected
    );
}

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
async fn directory_fences_and_sparse_body_session_isolation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.append(&event("a", opening())).await.unwrap();
    log.append(&event("b", opening())).await.unwrap();
    let a_end = end(&log, "a", InvocationOutcome::Completed).await;
    let through = end(&log, "b", InvocationOutcome::Completed).await;
    assert!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a"))
            .await
            .is_empty()
            && crate::test_store::inspect_cache(&log, |db| rows(db, "b"))
                .await
                .is_empty()
    );
    crate::transcript_cache::materialize_all_rows(&log, "a", through)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a"))
            .await
            .last()
            .unwrap()
            .0,
        RowPosition {
            source_sequence: a_end,
            item_index: 0
        }
    );
    assert!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "b"))
            .await
            .is_empty()
    );
    assert!(
        crate::transcript_cache::materialize_all_rows(&log, "a", through + 1)
            .await
            .is_err()
    );
    log.close().await.unwrap();
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

#[tokio::test]
async fn complete_projection_and_malformed_source_preserve_canonical_admission() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let expected = "x".repeat(16 * 1024 * 1024);
    let (part, _) = partial(&log, "a", &expected).await;
    let id = part.message_id.clone();
    let through = interrupt(&log, "a", part).await;
    crate::transcript_cache::materialize_all_rows(&log, "a", through)
        .await
        .unwrap();
    let original = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
    assert_eq!(original.len(), 3);
    let assistant: Value = serde_json::from_slice(&original[2].1).unwrap();
    assert_eq!(assistant["id"], id);
    assert!(
        assistant["text"].as_str() == Some(expected.as_str()),
        "complete assistant text must survive projection"
    );
    crate::test_store::inspect_cache(&log, move |db| {
        db.execute_batch("DELETE FROM temp.transcript_text; DELETE FROM temp.transcript_rows")
            .unwrap()
    })
    .await;
    crate::transcript_cache::materialize_all_rows(&log, "a", through)
        .await
        .unwrap();
    assert!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await == original,
        "cold rebuild must preserve full rows, digests and positions"
    );
    log.append(&event("b", opening())).await.unwrap();
    let through = log
        .append(&event(
            "b",
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "tool".into(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::standalone("tool-call".into()),
                name: "file".into(),
                input: Value::Null,
            },
        ))
        .await
        .unwrap();
    assert!(matches!(
        crate::transcript_cache::materialize_all_rows(&log, "b", through).await,
        Err(StoreError::InvalidTransition(message)) if message.contains(&format!("history source {through}:"))
    ));

    assert!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "b"))
            .await
            .is_empty()
    );
    log.close().await.unwrap();
}
