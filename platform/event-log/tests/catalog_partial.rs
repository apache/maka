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

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::TextKind;
use maka_agent_facts::model::assembly::{AttemptBinding, AttemptWriter};
use maka_agent_facts::model::recorded::{CompletionPart, ModelObservation};
use maka_event_log::{EventLog, sessions::SessionExecutionState};
use maka_presentation::{Content, InvocationView};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::time::{Duration, UNIX_EPOCH};

async fn append(
    log: &EventLog,
    view: &mut InvocationView,
    fact: Fact,
    time: u64,
) -> (u64, Vec<maka_presentation::Row>) {
    let mut event = RuntimeEvent::new(
        Invocation {
            session_id: "a".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        fact,
    );
    event.recorded_at = UNIX_EPOCH + Duration::from_millis(time);
    let sequence = log
        .append(&EventWrite::plain((event).clone()).unwrap())
        .await
        .unwrap();
    (
        sequence,
        view.push(&StoredEvent { sequence, event }).unwrap(),
    )
}
fn observe(event: ModelObservation) -> Fact {
    Fact::ModelObserved {
        step_id: "step".into(),
        event,
    }
}
fn source(db: &Connection) -> Vec<String> {
    db.prepare("SELECT event_json FROM runtime_events ORDER BY sequence")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[tokio::test]
async fn sealed_partial_catalog_matches_committed_presentation_and_rebuild() {
    for (large, status, outcome) in [
        (
            true,
            ModelInterruption::Cancelled,
            InvocationOutcome::Cancelled {
                source: "user".into(),
            },
        ),
        (
            false,
            ModelInterruption::Failed,
            InvocationOutcome::Failed {
                model_failure: None,
                class: "event_commit".into(),
                message: None,
            },
        ),
        (
            false,
            ModelInterruption::Cancelled,
            InvocationOutcome::Cancelled {
                source: "shutdown".into(),
            },
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.create_session("a", "request", &json!({}), 1)
            .await
            .unwrap();
        let mut view = InvocationView::new();
        append(
            &log,
            &mut view,
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "user".into(),
                    request_fingerprint: None,
                },
            },
            1000,
        )
        .await;
        let live = append(
            &log,
            &mut view,
            Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance: false,
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None,
                checkpoint_event_id: None,
                step_id: "step".into(),
                model_id: "real".into(),
                source_scope: LogScope::Root,
                source_high_water: 0,
                source_digest: "source".into(),
                effective_source_digest: None,
                input_digest: "input".into(),
                route_identity: "route".into(),
            },
            1100,
        )
        .await
        .0;
        let mut writer = AttemptWriter::new(
            AttemptBinding {
                invocation: Invocation {
                    session_id: "a".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                step_id: "step".into(),
                purpose: maka_agent_facts::context::ModelPurpose::Main,
            },
            false,
        )
        .unwrap();
        writer.fenced(live);
        assert!(
            writer
                .push(
                    ModelEvent::PartStarted {
                        id: "part".into(),
                        text_kind: TextKind::Text,
                        provider_options: None
                    },
                    UNIX_EPOCH + Duration::from_millis(2000)
                )
                .unwrap()
                .is_empty()
        );
        let mut expected_text = String::new();
        for chunk in [" \n par", "tial\t", " \n", "😀  tail "] {
            expected_text.push_str(chunk);
            assert!(
                writer
                    .push(
                        ModelEvent::PartDelta {
                            id: "part".into(),
                            text: chunk.into(),
                            provider_options: None
                        },
                        UNIX_EPOCH + Duration::from_millis(2100)
                    )
                    .unwrap()
                    .is_empty()
            );
        }
        if large {
            for chunk in ["答".repeat(120), "x".repeat(9 * 1024 * 1024)] {
                expected_text.push_str(&chunk);
                assert!(
                    writer
                        .push(
                            ModelEvent::PartDelta {
                                id: "part".into(),
                                text: chunk,
                                provider_options: None
                            },
                            UNIX_EPOCH + Duration::from_millis(2150)
                        )
                        .unwrap()
                        .is_empty()
                );
            }
        }
        // Valid live ingress has not sealed any catalog message.
        let before = log.get_session::<Value>("a").await.unwrap().unwrap();
        assert_eq!(before.last_message.as_ref().unwrap().recorded_at, 1000);
        let partial = writer.partial().unwrap();
        let CompletionPart::Own(part) = &partial.parts[0] else {
            unreachable!()
        };
        let part_id = part.message_id.clone();
        assert_eq!(part.started_at, UNIX_EPOCH + Duration::from_millis(2000));
        let (boundary, rows) = append(
            &log,
            &mut view,
            Fact::ModelInterrupted {
                model_failure: None,
                diagnostic: None,
                step_id: "step".into(),
                status,
                partial: Some(partial),
            },
            3000,
        )
        .await;
        let assistant = rows
            .into_iter()
            .find(|row| matches!(row.message.content, Content::Assistant { .. }))
            .unwrap()
            .message;
        assert_eq!(assistant.id, part_id);
        let interrupted = log.get_session::<Value>("a").await.unwrap().unwrap();
        assert_eq!(interrupted.revision, before.revision + 1);
        assert_eq!(
            interrupted.execution.as_ref().unwrap().state,
            SessionExecutionState::Live { recorded_at: 1000 }
        );
        assert_eq!(
            log.session_catalog_changes(live, boundary, 129)
                .await
                .unwrap(),
            [(boundary, "a".into())]
        );
        assert!(
            log.append(
                &EventWrite::plain(RuntimeEvent::new(
                    Invocation {
                        session_id: "a".into(),
                        turn_id: "turn".into(),
                        run_id: "run".into(),
                        invocation_id: "invocation".into()
                    },
                    observe(ModelObservation::ResponseMetadata {
                        id: Some("too-late".into()),
                        model: None,
                        timestamp: None
                    }),
                ))
                .unwrap()
            )
            .await
            .is_err()
        );
        let (_, rows) = append(&log, &mut view, Fact::InvocationEnded { outcome }, 900).await;
        assert!(
            rows.iter()
                .all(|row| !matches!(row.message.content, Content::Assistant { .. }))
        );
        let Content::Assistant { text, .. } = assistant.content else {
            unreachable!()
        };
        assert_eq!(text, expected_text);
        let expected = if large {
            format!("partial 😀 tail {}…", "答".repeat(80))
        } else {
            "partial 😀 tail".into()
        };
        let ended = log.get_session::<Value>("a").await.unwrap().unwrap();
        let message = ended.last_message.as_ref().unwrap();
        assert_eq!(message.tail_message_id, part_id);
        assert_eq!(message.recorded_at, assistant.ts);
        assert_eq!(message.recorded_at, 2000); // Not interruption@3000 or terminal@900.
        assert_eq!(message.preview.as_deref(), Some(expected.as_str()));
        assert_eq!(ended.revision, interrupted.revision + 1);
        let db = Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM runtime_events WHERE kind = 'model_completed'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        let original = source(&db);
        log.close().await.unwrap();
        let reopened = EventLog::open(&path).await.unwrap();
        assert_eq!(
            reopened.get_session::<Value>("a").await.unwrap().unwrap(),
            ended
        );
        reopened.close().await.unwrap();
        db.execute_batch("DELETE FROM catalog_messages;").unwrap();
        let rebuilt = EventLog::open(&path).await.unwrap();
        assert_eq!(
            rebuilt.get_session::<Value>("a").await.unwrap().unwrap(),
            ended
        );
        assert_eq!(source(&db), original);
    }
}
