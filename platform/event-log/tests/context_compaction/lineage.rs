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
use maka_agent_facts::continuation::ContinuationClaim;
use maka_agent_facts::continuation::REPLAY_VERSION;
use maka_agent_facts::continuation::ReplayEvidence;
use maka_agent_facts::continuation::SessionBase;
use maka_agent_facts::execution::BehaviorId;
use maka_agent_facts::execution::CollaborationMode;
use maka_agent_facts::execution::InvocationConfiguration;
use maka_agent_facts::execution::SandboxMode;
use maka_agent_facts::execution::ToolMode;
use maka_agent_facts::execution::WorkspaceIdentity;

#[path = "../continuation/fixtures.rs"]
mod continuation;

#[path = "lineage/cells.rs"]
mod cells;

#[path = "lineage/observers.rs"]
mod observers;

fn lineage_request(step: &str, purpose: ModelPurpose, source: &ModelContextSource) -> EventWrite {
    let mut write = request("child", step, purpose, source).event().clone();
    if let Fact::ModelRequested {
        effective_source_digest,
        ..
    } = &mut write.fact
    {
        *effective_source_digest = Some(source.effective_source_digest.clone());
    }
    EventWrite::plain(write).unwrap()
}

#[tokio::test]
async fn continuation_requests_and_checkpoints_prove_selected_source_across_repairs_and_reopen() {
    for mid_turn in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("lineage.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        closed(&log, "prior", 32, 1).await;
        let prior = prepared(&log, "prior-summary").await;
        log.append_batch(&prior).await.unwrap();
        let source_opening = continuation::opening("source", None);
        continuation::append(&log, &source_opening).await;
        continuation::close(&log, &source_opening).await;
        let base = log
            .context_before_run(&source_opening.invocation, 100, 65536)
            .await
            .unwrap()
            .source_evidence;
        let claim = continuation::claim(
            &log,
            "claim",
            &source_opening,
            SessionBase {
                high_water: base.high_water,
                digest: base.digest,
            },
        )
        .await;
        // This whole-Session baseline is newer, but is not an ancestor of the child.
        let unrelated = prepared(&log, "unrelated-summary").await;
        log.append_batch(&unrelated).await.unwrap();
        let child = continuation::opening("child", Some(claim.clone()));
        let opened = continuation::append(&log, &child).await;
        let main_source = log
            .capture_model_context("session", Some("child"), 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        let request = lineage_request("main", ModelPurpose::Main, &main_source);
        let commits = log.subscribe_commits();
        for mutation in 1..6 {
            let mut forged = request.event().clone();
            let Fact::ModelRequested {
                source_scope,
                source_digest,
                source_high_water,
                effective_source_digest,
                checkpoint_event_id,
                ..
            } = &mut forged.fact
            else {
                panic!()
            };
            match mutation {
                1 => {
                    *source_scope = LogScope::Session {
                        id: "session".into(),
                    }
                }
                2 => *source_digest = continuation::digest('e'),
                3 => *source_high_water = opened - 1,
                4 => *effective_source_digest = None,
                _ => *checkpoint_event_id = Some(unrelated[0].event().id.clone()),
            }
            assert!(
                log.append(&EventWrite::plain(forged).unwrap())
                    .await
                    .is_err(),
                "mutation {mutation}"
            );
            assert!(!commits.has_changed().unwrap());
        }
        if mid_turn {
            log.append(&request).await.unwrap();
            log.append(&completion("child", "main", "resumed work"))
                .await
                .unwrap();
        }
        let mode = if mid_turn {
            CheckpointMode::MidTurn {
                anchor_event_id: child.id.clone(),
            }
        } else {
            CheckpointMode::PreTurn
        };
        let source = log
            .capture_compaction_context("session", Some("child"), &mode, 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(
            source.baseline.as_ref().unwrap().event_id,
            prior[0].event().id
        );
        assert_eq!(source.source_evidence.high_water < opened, !mid_turn);
        if !mid_turn {
            let frozen = log
                .read_frozen_model_context(&source.source_evidence, 100, 65536)
                .await
                .unwrap();
            assert_eq!(
                frozen.effective_source_digest,
                source.effective_source_digest
            );
        }
        log.append(&lineage_request("summary", ModelPurpose::Summary, &source))
            .await
            .unwrap();
        log.append(&completion("child", "summary", "malformed summary"))
            .await
            .unwrap();
        let repair = lineage_request("repair", ModelPurpose::Summary, &source);
        let mut wrong_route = repair.event().clone();
        if let Fact::ModelRequested { route_identity, .. } = &mut wrong_route.fact {
            *route_identity = continuation::digest('e');
        }
        assert!(
            log.append(&EventWrite::plain(wrong_route).unwrap())
                .await
                .is_err()
        );
        log.append(&repair).await.unwrap();
        let completed = completion("child", "repair", SUMMARY);
        log.append(&completed).await.unwrap();
        let Fact::ModelCompleted { output, .. } = &completed.event().fact else {
            panic!()
        };
        let checkpoint = event(
            "child",
            Fact::ContextCheckpointRecorded {
                checkpoint: ContextCheckpoint {
                    mode,
                    covered_through: source.source_evidence.high_water,
                    source_digest: source.source_evidence.digest.clone(),
                    previous_checkpoint_id: source.baseline.as_ref().map(|b| b.event_id.clone()),
                    summary: TextSummary::from_model_step(output).unwrap(),
                    summary_step_id: "repair".into(),
                },
            },
        );
        let mut forged = checkpoint.event().clone();
        if let Fact::ContextCheckpointRecorded { checkpoint } = &mut forged.fact {
            checkpoint.previous_checkpoint_id = Some(unrelated[0].event().id.clone());
        }
        assert!(
            log.append(&EventWrite::plain(forged).unwrap())
                .await
                .is_err()
        );
        let inspect = rusqlite::Connection::open(&path).unwrap();
        inspect.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON event_log WHEN NEW.kind='context_checkpoint_recorded' BEGIN SELECT RAISE(ABORT,'injected checkpoint failure'); END;").unwrap();
        let commits = log.subscribe_commits();
        assert!(log.append(&checkpoint).await.is_err());
        assert!(!commits.has_changed().unwrap());
        assert_eq!(
            log.capture_model_context("session", Some("child"), 100_000, 64 * 1024 * 1024)
                .await
                .unwrap()
                .baseline
                .unwrap()
                .event_id,
            prior[0].event().id
        );
        inspect
            .execute_batch("DROP TRIGGER reject_checkpoint;")
            .unwrap();
        log.append(&checkpoint).await.unwrap();
        let after = log
            .capture_model_context("session", Some("child"), 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(
            after.baseline.as_ref().unwrap().event_id,
            checkpoint.event().id
        );
        assert_eq!(
            after.tail.iter().any(|event| matches!(event, maka_event_log::context::ContextEvent::Canonical(event) if event.event.id == child.id)),
            !mid_turn,
            "only a pre-turn checkpoint leaves the current opening outside its coverage"
        );
        log.append(&lineage_request(
            "after-summary",
            ModelPurpose::Main,
            &after,
        ))
        .await
        .unwrap();
        log.append(&completion("child", "after-summary", "continued"))
            .await
            .unwrap();
        continuation::close(&log, &child).await;
        let descendant = continuation::claim(&log, "descendant", &child, claim.base).await;
        let selected = log
            .capture_lineage_context(&descendant.source, 100, 65536)
            .await
            .unwrap();
        assert_eq!(
            selected.baseline.as_ref().unwrap().event_id,
            checkpoint.event().id
        );
        assert_eq!(
            log.capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
                .await
                .unwrap()
                .baseline
                .unwrap()
                .event_id,
            unrelated[0].event().id
        );
        // A later whole-Session summary must not adopt the narrower child checkpoint.
        let later = prepared(&log, "later-summary").await;
        log.append_batch(&later).await.unwrap();
        let Fact::ContextCheckpointRecorded {
            checkpoint: later_checkpoint,
        } = &later[0].event().fact
        else {
            panic!()
        };
        assert_eq!(
            later_checkpoint.previous_checkpoint_id.as_ref(),
            Some(&unrelated[0].event().id)
        );
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        let frozen = log
            .read_frozen_model_context(&selected.source_evidence, 100, 65536)
            .await
            .unwrap();
        assert_eq!(frozen.baseline.unwrap().event_id, checkpoint.event().id);
        assert_eq!(
            frozen.effective_source_digest,
            selected.effective_source_digest
        );
        log.close().await.unwrap();
    }
}
