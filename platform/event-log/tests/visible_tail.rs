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
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::TextKind;
use maka_event_log::EventLog;
use maka_presentation::{Content, InvocationView};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::time::{Duration, UNIX_EPOCH};

async fn append(
    log: &EventLog,
    view: &mut InvocationView,
    ids: &mut Vec<String>,
    fact: Fact,
    time: u64,
) {
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
    ids.extend(
        view.push(&StoredEvent { sequence, event })
            .unwrap()
            .into_iter()
            .filter(|row| {
                matches!(
                    row.message.content,
                    Content::User { .. } | Content::Assistant { .. }
                )
            })
            .map(|row| row.message.id),
    );
}

fn observed(event: ModelEvent) -> Fact {
    Fact::ModelObserved {
        step_id: "step".into(),
        event,
    }
}

fn projected(db: &Connection) -> Vec<String> {
    db.prepare(
        "SELECT message_id FROM catalog_messages WHERE session_id = 'a' ORDER BY sequence, ordinal",
    )
    .unwrap()
    .query_map([], |row| row.get(0))
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

fn canonical(db: &Connection) -> Vec<String> {
    db.prepare("SELECT event_json FROM runtime_events ORDER BY sequence")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[tokio::test]
async fn visible_ids_match_presentation_for_accepted_and_partial_parts_across_cache_rebuild() {
    // Completed, explicit interruption, and terminal failure fallback share IDs.
    for seal in ["completed", "interrupted", "failed"] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("events.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.create_session("a", "request", &json!({}), 1)
            .await
            .unwrap();
        let db = Connection::open(&path).unwrap();
        let mut view = InvocationView::new();
        let mut ids = Vec::new();
        assert!(projected(&db).is_empty());
        append(
            &log,
            &mut view,
            &mut ids,
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
        assert_eq!(projected(&db), ids);
        append(
            &log,
            &mut view,
            &mut ids,
            Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance: false,
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None,
                checkpoint_event_id: None,
                step_id: "step".into(),
                model_id: "model".into(),
                source_scope: LogScope::Root,
                source_high_water: 0,
                source_digest: "source".into(),
                effective_source_digest: None,
                input_digest: "input".into(),
                route_identity: "route".into(),
            },
            1100,
        )
        .await;
        let mut parts = Vec::new();
        for (id, kind, text, time) in [
            ("answer", TextKind::Text, "answer", 2000),
            ("empty", TextKind::Text, "", 2000),
            ("thinking", TextKind::Thinking, "private", 500),
        ] {
            append(
                &log,
                &mut view,
                &mut ids,
                observed(ModelEvent::PartStarted {
                    id: id.into(),
                    text_kind: kind,
                    provider_options: None,
                }),
                time,
            )
            .await;
            append(
                &log,
                &mut view,
                &mut ids,
                observed(ModelEvent::PartDelta {
                    id: id.into(),
                    text: text.into(),
                    provider_options: None,
                }),
                time,
            )
            .await;
            append(
                &log,
                &mut view,
                &mut ids,
                observed(ModelEvent::PartFinished {
                    id: id.into(),
                    provider_options: None,
                }),
                time,
            )
            .await;
            parts.push(ModelPart::Text {
                text_kind: kind,
                text: text.into(),
                provider_options: None,
            });
        }
        assert_eq!(
            projected(&db).len(),
            1,
            "live parts are not durable messages"
        );
        match seal {
            "completed" => {
                append(
                    &log,
                    &mut view,
                    &mut ids,
                    Fact::ModelCompleted {
                        step_id: "step".into(),
                        output: ModelStep {
                            parts,
                            finish_reason: ModelFinishReason::Stop,
                            usage: Default::default(),
                            provider_options: None,
                            response_id: None,
                            model: None,
                            timestamp: None,
                        },
                    },
                    600,
                )
                .await
            }
            "interrupted" => {
                append(
                    &log,
                    &mut view,
                    &mut ids,
                    Fact::ModelInterrupted {
                        model_failure: None,
                        diagnostic: None,
                        step_id: "step".into(),
                        status: ModelInterruption::Cancelled,
                    },
                    600,
                )
                .await
            }
            _ => (),
        }
        append(
            &log,
            &mut view,
            &mut ids,
            Fact::InvocationEnded {
                outcome: if seal == "completed" {
                    InvocationOutcome::Completed
                } else {
                    InvocationOutcome::Failed {
                        model_failure: None,
                        class: "test".into(),
                        message: None,
                    }
                },
            },
            400,
        )
        .await;
        assert_eq!(ids.len(), 4);
        assert_eq!(projected(&db), ids);
        let tail: String = db
            .query_row(
                "SELECT message_id FROM catalog_messages INDEXED BY catalog_visible_tail
             WHERE session_id = 'a' ORDER BY sequence DESC, ordinal DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(Some(&tail), ids.last());
        let session = log.get_session::<Value>("a").await.unwrap().unwrap();
        let last_message = session.last_message.as_ref().unwrap();
        assert_eq!(last_message.recorded_at, 2000);
        assert_eq!(last_message.preview.as_deref(), Some("answer"));
        assert_eq!(last_message.tail_message_id, tail);
        let source = canonical(&db);
        log.close().await.unwrap();
        // Either half may be discarded; rebuild both from the canonical facts.
        for table in ["catalog_messages", "catalog_message_watermark"] {
            db.execute_batch(&format!("DELETE FROM {table};")).unwrap();
            let reopened = EventLog::open(&path).await.unwrap();
            assert_eq!(projected(&db), ids);
            assert_eq!(canonical(&db), source);
            assert_eq!(
                reopened.get_session::<Value>("a").await.unwrap().unwrap(),
                session
            );
            reopened.close().await.unwrap();
        }
    }
}
