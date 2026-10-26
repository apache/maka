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
async fn narrower_checkpoint_does_not_corrupt_later_whole_session_archives() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("checkpoint-archive.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let source = continuation::opening("source", None);
    continuation::append(&log, &source).await;
    continuation::close(&log, &source).await;
    let base = log
        .context_before_run(&source.invocation, 100, 65536)
        .await
        .unwrap()
        .source_evidence;
    let claim = continuation::claim(
        &log,
        "claim",
        &source,
        SessionBase {
            high_water: base.high_water,
            digest: base.digest,
        },
    )
    .await;
    open(&log, "unrelated", false).await;
    let target = tool(&log, "unrelated", "unrelated-tool", "body".repeat(3000)).await;
    end(&log, "unrelated").await;
    let child = continuation::opening("child", Some(claim));
    continuation::append(&log, &child).await;
    let active = log
        .capture_model_context("session", Some("child"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    let mut main = request("child", "main", Some(&active)).event().clone();
    if let Fact::ModelRequested { purpose, .. } = &mut main.fact {
        *purpose = ModelPurpose::Main;
    }
    continuation::append(&log, &main).await;
    log.append(&event("child", Fact::ModelCompleted {
        step_id: "main".into(),
        output: serde_json::from_value(json!({"parts":[{"kind":"text","text_kind":"text","text":"work"}],"finish_reason":"stop","usage":{}})).unwrap(),
    })).await.unwrap();
    let mode = CheckpointMode::MidTurn {
        anchor_event_id: child.id.clone(),
    };
    let compact = log
        .capture_compaction_context("session", Some("child"), &mode, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    let pair = summary_pair(&log, "child", &compact).await;
    let mut checkpoint = pair[0].event().clone();
    if let Fact::ContextCheckpointRecorded { checkpoint } = &mut checkpoint.fact {
        checkpoint.mode = mode;
    }
    continuation::append(&log, &checkpoint).await;
    continuation::close(&log, &child).await;
    open(&log, "writer", false).await;
    let archived = archive("writer", &target);
    log.append(&archived).await.unwrap();
    let Fact::ToolResultArchived { placeholder } = &archived.event().fact else {
        panic!()
    };
    let body = log
        .read_archive("session", &placeholder.identity)
        .await
        .unwrap()
        .unwrap();
    let current = log
        .capture_model_context("session", Some("writer"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert!(current.baseline.is_none());
    assert!(
        current
            .tail
            .iter()
            .any(|e| matches!(e, ContextEvent::Archived(e) if e.event_id == target.event().id))
    );
    end(&log, "writer").await;
    // Verify that the existing narrower proof also remains readable after this archive.
    let boundary = log
        .run_source("session", "child", None)
        .await
        .unwrap()
        .unwrap();
    let selected = log
        .capture_lineage_context(&boundary.boundary, 100, 65536)
        .await
        .unwrap();
    assert_eq!(selected.baseline.unwrap().event_id, checkpoint.id);
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.read_archive("session", &placeholder.identity)
            .await
            .unwrap()
            .unwrap(),
        body
    );
    log.append(&archived).await.unwrap();
    log.close().await.unwrap();
}

#[tokio::test]
async fn admitted_archive_survives_run_alias_reuse_while_fresh_lookup_rejects_ambiguity() {
    let mut outcomes = Vec::new();
    for cold in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("archive-run-identity.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        open(&log, "prior", false).await;
        let target = tool(
            &log,
            "prior",
            "prior-tool",
            "retained base tool".repeat(800),
        )
        .await;
        end(&log, "prior").await;
        let source = continuation::opening("source", None);
        continuation::append(&log, &source).await;
        continuation::close(&log, &source).await;
        let base = log
            .context_before_run(&source.invocation, 100, 65536)
            .await
            .unwrap()
            .source_evidence;
        let claim = continuation::claim(
            &log,
            "archive-claim",
            &source,
            SessionBase {
                high_water: base.high_water,
                digest: base.digest,
            },
        )
        .await;
        let child = continuation::opening("archive-writer", Some(claim));
        continuation::append(&log, &child).await;
        log.append(&archive("archive-writer", &target))
            .await
            .unwrap();
        continuation::close(&log, &child).await;
        open(&log, "whole-session-summary", true).await;
        let source = log
            .capture_compaction_context(
                "session",
                Some("whole-session-summary"),
                &CheckpointMode::Standalone,
                100_000,
                64 * 1024 * 1024,
            )
            .await
            .unwrap();
        let pair = summary_pair(&log, "whole-session-summary", &source).await;
        log.append_batch(&pair).await.unwrap();
        let original = log
            .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(
            original.baseline.as_ref().unwrap().event_id,
            pair[0].event().id
        );
        assert!(matches!(
            original.source_evidence.scope,
            LogScope::Session { .. }
        ));

        // Accepted archives retain their exact Invocation identity. Reusing a
        // Run alias cannot reinterpret them, but new alias resolution fails.
        let mut reused = continuation::opening("new-message", None);
        reused.invocation.run_id = "archive-writer".into();
        continuation::append(&log, &reused).await;
        let log = if cold {
            log.close().await.unwrap();
            EventLog::open(&path).await.unwrap()
        } else {
            log
        };
        let safety = log
            .prepare_prune_candidates("session", Some("new-message"), 0, 0, None)
            .await
            .unwrap();
        assert!(safety.candidates.is_empty());
        assert!(safety.next.is_none());
        let prune = log
            .prepare_prune_candidates("session", Some("new-message"), 128, 65536, None)
            .await
            .unwrap();
        assert!(prune.candidates.is_empty());
        assert!(
            log.run_source("session", "archive-writer", None)
                .await
                .is_err()
        );
        let current = log
            .capture_model_context("session", Some("new-message"), 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(
            current.baseline.as_ref().unwrap().event_id,
            pair[0].event().id
        );
        let mut main = request("new-message", "next-main", Some(&current))
            .event()
            .clone();
        main.invocation = reused.invocation;
        let Fact::ModelRequested { purpose, .. } = &mut main.fact else {
            panic!()
        };
        *purpose = ModelPurpose::Main;
        outcomes.push(
            log.append(&EventWrite::plain(main).unwrap())
                .await
                .map(|_| ())
                .map_err(|error| error.to_string()),
        );
        log.close().await.unwrap();
    }
    assert_eq!(outcomes, vec![Ok(()), Ok(())]);
}
