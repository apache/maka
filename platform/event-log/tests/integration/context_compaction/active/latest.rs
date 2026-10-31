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

#[tokio::test]
async fn preturn_keeps_anchor_and_latest_main_never_falls_back_a_broken_newer_trace() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("latest.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    assert!(matches!(
        log.latest_main_context("session").await.unwrap(),
        LatestMainContext::NoCompletedRequest
    ));
    closed(&log, "old", 9 * 1024 * 1024, 1).await;
    assert!(
        matches!(log.latest_main_context("session").await.unwrap(), LatestMainContext::Selected(value) if value.context.is_none())
    );
    log.append(&opening("current")).await.unwrap();
    // Existing full prefix cap still holds; the small-field query did not load it.
    let source = log
        .capture_compaction_context(
            "session",
            Some("current"),
            &CheckpointMode::PreTurn,
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    log.append(&request(
        "current",
        "summary",
        ModelPurpose::Summary,
        &source,
    ))
    .await
    .unwrap();
    let complete = completion("current", "summary", SUMMARY);
    log.append(&complete).await.unwrap();
    let Fact::ModelCompleted { output, .. } = &complete.event().fact else {
        panic!()
    };
    let write = event(
        "current",
        Fact::ContextCheckpointRecorded {
            checkpoint: ContextCheckpoint {
                mode: CheckpointMode::PreTurn,
                covered_through: source.source_evidence.high_water,
                source_digest: source.source_evidence.digest,
                previous_checkpoint_id: None,
                summary: fixtures::output_summary(output),
                summary_step_id: "summary".into(),
            },
        },
    );
    log.append(&write).await.unwrap();
    let source = log
        .capture_model_context("session", Some("current"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(source.tail.len(), 1);
    assert!(
        matches!(source.latest_main, LatestMainContext::Selected(ref value) if value.context.is_none())
    );
    let mut requested = request("current", "new-main", ModelPurpose::Main, &source)
        .event()
        .clone();
    requested.recorded_at = std::time::UNIX_EPOCH;
    log.append(&EventWrite::plain(requested).unwrap())
        .await
        .unwrap();
    let mut latest = completion("current", "new-main", "newer").event().clone();
    let Fact::ModelCompleted { output, .. } = &latest.fact else {
        panic!()
    };
    let mut finished = event(
        "current",
        Fact::ModelObserved {
            step_id: "new-main".into(),
            event: ModelObservation::Finished {
                reason: output.finish_reason,
                usage: output.usage.clone(),
                provider_options: output.provider_options.clone(),
            },
        },
    )
    .event()
    .clone();
    let finished_at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(2);
    finished.recorded_at = finished_at;
    log.append(&EventWrite::plain(finished).unwrap())
        .await
        .unwrap();
    // Remaining tools can settle later; they must not extend model request time.
    latest.recorded_at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(12);
    log.append(&EventWrite::plain(latest).unwrap())
        .await
        .unwrap();
    log.append(&event(
        "current",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Failed {
                model_failure: None,
                class: "later_tool_failure".into(),
                message: None,
            },
        },
    ))
    .await
    .unwrap();
    let LatestMainContext::Selected(selected) = log.latest_main_context("session").await.unwrap()
    else {
        panic!()
    };
    assert_eq!(selected.finished_at, Some(finished_at));
    assert_eq!(selected.requested_at, Some(std::time::UNIX_EPOCH));
    assert_eq!(selected.connection_id.as_deref(), Some("connection"));
    assert_eq!(
        selected.checkpoint_event_id.as_deref(),
        Some(write.event().id.as_str())
    );
    let inspect = rusqlite::Connection::open(&path).unwrap();
    inspect.execute("UPDATE event_log SET event_header=json_remove(event_header, '$.fact.context') WHERE operation_id='new-main' AND kind='model_requested'", []).unwrap();
    assert!(
        matches!(log.latest_main_context("session").await.unwrap(), LatestMainContext::Selected(value) if value.context.is_none() && value.finished_at == Some(finished_at))
    );
    inspect.execute("UPDATE event_log SET operation_id='missing-request' WHERE operation_id='new-main' AND kind='model_requested'", []).unwrap();
    assert!(matches!(
        log.latest_main_context("session").await.unwrap(),
        LatestMainContext::TraceUnavailable
    ));
    log.close().await.unwrap();
}
