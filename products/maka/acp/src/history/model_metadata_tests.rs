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
use crate::projection::Projection;
use maka_agent_facts::{
    event::{
        EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, ModelInterruption,
        RuntimeEvent,
    },
    model::{
        ModelFinishReason, ModelPart, ModelUsage, TextKind,
        recorded::{
            CompletionPart, ModelCompletion, ModelObservation, ModelPartRecord, ModelPartial,
            RecordedPartRef,
        },
    },
};
use maka_event_log::{EventLog, transcript::HistoryLimits};
use std::{sync::Arc, time::UNIX_EPOCH};

async fn query(
    log: &EventLog,
    through: Option<u64>,
    position: HistoryPosition,
) -> Result<HistoryPage, Error> {
    let page = log
        .history_text(
            "session",
            through.unwrap(),
            position,
            true,
            HistoryLimits {
                max_bytes: 8,
                max_chunks: Some(1),
                max_json_bytes: 4096,
            },
        )
        .await?;
    Ok(serde_json::from_value(serde_json::to_value(page)?)?)
}

#[tokio::test]
async fn accepted_parts_get_late_reported_model_without_replaying_their_bodies() {
    for completed in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap();
        log.create_session("session", "create", &json!({}), 1)
            .await
            .unwrap();
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        let write = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
        log.append(&write(Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "Read accepted output".into(),
                request_fingerprint: None,
            },
        }))
        .await
        .unwrap();
        let source = log.prefix(256, 1024 * 1024).await.unwrap();
        log.append(&write(Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: true,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: "step".into(),
            model_id: "requested-alias".into(),
            source_scope: source.scope,
            source_high_water: source.high_water,
            source_digest: source.digest,
            effective_source_digest: None,
            input_digest: "input".into(),
            route_identity: "route".into(),
        }))
        .await
        .unwrap();
        let mut references = Vec::new();
        let mut early = 0;
        for (ordinal, kind) in [TextKind::Text, TextKind::Thinking].into_iter().enumerate() {
            let part = write(Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelObservation::Part(ModelPartRecord {
                    ordinal: ordinal as u64,
                    message_id: format!("accepted-{ordinal}"),
                    started_at: UNIX_EPOCH,
                    provider_part_id: None,
                    part: Arc::new(ModelPart::Text {
                        text_kind: kind,
                        text: "immutable accepted body ".repeat(12).into(),
                        provider_options: None,
                    }),
                }),
            });
            references.push(CompletionPart::Ref(RecordedPartRef {
                event_id: part.event().id.clone(),
                ordinal: ordinal as u64,
            }));
            early = log.append(&part).await.unwrap();
        }
        let mut projection = Projection::default();
        let snapshot = since_with(|through, position| query(&log, through, position), early, 0)
            .await
            .unwrap();
        for chunk in snapshot.chunks {
            projection.chunk(&chunk).unwrap();
        }
        let steps = HashSet::from(["step".to_owned()]);
        assert_eq!(projection.pending_model_positions(Some(&steps)).len(), 2);
        log.append(&write(Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelObservation::ResponseMetadata {
                id: None,
                model: Some("reported-late".into()),
                timestamp: None,
            },
        }))
        .await
        .unwrap();
        let terminal = if completed {
            log.append(&write(Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelObservation::Finished {
                    reason: ModelFinishReason::Stop,
                    usage: ModelUsage::default(),
                    provider_options: None,
                },
            }))
            .await
            .unwrap();
            log.append(&write(Fact::ModelCompleted {
                step_id: "step".into(),
                output: ModelCompletion {
                    parts: references,
                    finish_reason: ModelFinishReason::Stop,
                    usage: ModelUsage::default(),
                    provider_options: None,
                    response_id: None,
                    model: Some("reported-final".into()),
                    timestamp: None,
                },
            }))
            .await
            .unwrap()
        } else {
            log.append(&write(Fact::ModelInterrupted {
                step_id: "step".into(),
                status: ModelInterruption::Cancelled,
                model_failure: None,
                diagnostic: None,
                partial: Some(ModelPartial {
                    parts: references,
                    tool_inputs: Vec::new(),
                    response_id: None,
                    model: None,
                    timestamp: None,
                }),
            }))
            .await
            .unwrap();
            log.append(&write(Fact::InvocationEnded {
                outcome: InvocationOutcome::Cancelled {
                    source: "user".into(),
                },
            }))
            .await
            .unwrap()
        };
        let appended = since_with(
            |through, position| query(&log, through, position),
            terminal,
            early,
        )
        .await
        .unwrap();
        if completed {
            assert!(
                appended
                    .chunks
                    .iter()
                    .all(|chunk| chunk.role != maka_agent_ports::session::history::Role::Assistant),
                "accepted Ref completion must not emit a new source row that could hide this regression"
            );
        }
        for chunk in appended.chunks {
            projection.chunk(&chunk).unwrap();
        }
        // None exercises finish after terminal execution was observed before its delivery frame.
        let selected = completed.then_some(&steps);
        let positions = projection.pending_model_positions(selected);
        let mut updates = Vec::new();
        for (position, field) in positions {
            let chunk = metadata_with(
                |through, position| query(&log, through, position),
                terminal,
                position,
                field,
            )
            .await
            .unwrap();
            assert!(
                chunk.text.len() < chunk.total_bytes as usize,
                "metadata refresh must need only the first fragment"
            );
            let update = projection.prepare_model_metadata(&chunk).unwrap().unwrap();
            assert!(
                projection.prepare_model_metadata(&chunk).unwrap().is_some(),
                "unpublished metadata must remain retryable"
            );
            updates.push(update.update.clone());
            projection.commit_model_metadata(update);
        }
        assert_eq!(updates.len(), 2);
        for update in updates {
            let update = serde_json::to_value(update).unwrap();
            assert!(
                update.get("content").is_none(),
                "ACP metadata patch must preserve the client's accepted body"
            );
            assert_eq!(
                update["_meta"]["maka"]["model"]["requestedModelId"],
                "requested-alias"
            );
            assert_eq!(
                update["_meta"]["maka"]["model"]["reportedModelId"],
                if completed {
                    "reported-final"
                } else {
                    "reported-late"
                }
            );
        }
        projection.acknowledge_models(selected);
        assert!(
            projection.pending_model_positions(None).is_empty(),
            "settled step metadata must leave no historical refresh work"
        );
        log.close().await.unwrap();
    }
}
