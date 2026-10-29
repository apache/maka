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
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_event_log::{EventLog, StoreError};
use serde_json::{Value, json};
use std::time::{Duration, UNIX_EPOCH};

fn at(mut event: RuntimeEvent, millis: u64) -> RuntimeEvent {
    event.recorded_at = UNIX_EPOCH + Duration::from_millis(millis);
    event
}

#[tokio::test]
async fn execution_projection_is_bounded_and_catalog_revision_tracks_committed_facts() {
    use maka_agent_facts::event::LogScope;
    use maka_agent_facts::event::TerminalStatus;
    use maka_agent_facts::model::ModelPart;
    use maka_agent_facts::model::TextKind;
    use maka_agent_facts::model::recorded::ModelCompletion;
    use maka_agent_facts::model::recorded::ModelObservation;
    use maka_event_log::sessions::SessionExecutionState;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("a", "a", &json!({}), 1).await.unwrap();
    log.create_session("b", "b", &json!({}), 1).await.unwrap();
    let before = log.list_sessions::<Value>(None, None, 1).await.unwrap();
    let invocation = Invocation {
        session_id: "a".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let opened = at(
        RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: maka_agent_facts::input::InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: maka_agent_facts::input::MessageInput {
                        display_text: Some(format!("\n {}  ", "答".repeat(120))),
                        .."model-only expanded prompt".into()
                    },
                    request_fingerprint: None,
                },
            },
        ),
        1001,
    );
    log.append(&EventWrite::plain((opened).clone()).unwrap())
        .await
        .unwrap();
    let live = log.get_session::<Value>("a").await.unwrap().unwrap();
    assert_eq!(live.revision, 2);
    assert_eq!(
        live.execution.as_ref().unwrap().state,
        SessionExecutionState::Live { recorded_at: 1001 }
    );
    assert_eq!(
        live.last_message.as_ref().unwrap().preview.as_deref(),
        Some(format!("{}…", "答".repeat(95)).as_str())
    );
    assert!(matches!(
        log.list_sessions::<Value>(Some(&before.revision), Some("a"), 1)
            .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    log.append(&EventWrite::plain((opened).clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(log.get_session::<Value>("a").await.unwrap().unwrap(), live);
    log.append(
        &EventWrite::plain(
            (RuntimeEvent::new(
                invocation.clone(),
                Fact::ModelRequested {
                    context_breakdown: None,
                    item_acceptance: false,
                    purpose: maka_agent_facts::context::ModelPurpose::Main,
                    context: None,
                    checkpoint_event_id: None,
                    step_id: "step".into(),
                    model_id: "test".into(),
                    source_scope: LogScope::Session { id: "a".into() },
                    source_high_water: 1,
                    source_digest: "source".into(),
                    effective_source_digest: None,
                    input_digest: "input".into(),
                    route_identity: "route".into(),
                },
            ))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    log.append(
        &EventWrite::plain(
            (at(
                RuntimeEvent::new(
                    invocation.clone(),
                    Fact::ModelObserved {
                        step_id: "step".into(),
                        event: ModelObservation::ResponseMetadata {
                            id: None,
                            model: None,
                            timestamp: None,
                        },
                    },
                ),
                2000,
            ))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    // A large observation must not turn a small catalog read into a full log read.
    log.append(
        &EventWrite::plain(
            (RuntimeEvent::new(
                invocation.clone(),
                Fact::ModelObserved {
                    step_id: "step".into(),
                    event: ModelObservation::ProviderOptions {
                        provider_part_id: Some("thinking".into()),
                        options: std::sync::Arc::new(json!({"opaque":"x".repeat(9 * 1024 * 1024)})),
                    },
                },
            ))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(log.get_session::<Value>("a").await.unwrap().unwrap(), live);
    log.append(
        &EventWrite::plain(
            (at(
                RuntimeEvent::new(
                    invocation.clone(),
                    Fact::ModelCompleted {
                        step_id: "step".into(),
                        output: ModelCompletion {
                            parts: owned_parts(
                                &invocation.invocation_id,
                                "step",
                                vec![ModelPart::Text {
                                    text_kind: TextKind::Thinking,
                                    text: "private thinking".into(),
                                    provider_options: None,
                                }],
                            ),
                            finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
                            usage: Default::default(),
                            provider_options: None,
                            response_id: None,
                            model: None,
                            timestamp: None,
                        },
                    },
                ),
                1400,
            ))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let answered = log.get_session::<Value>("a").await.unwrap().unwrap();
    assert_eq!(answered.revision, 3);
    assert_eq!(
        answered.last_message.as_ref().unwrap().preview,
        Some(format!("{}…", "答".repeat(95)))
    );
    assert_eq!(answered.last_message.as_ref().unwrap().recorded_at, 2000);
    // A later terminal sequence can carry an earlier wall clock. It changes status,
    // not the visible-message timestamp or preview.
    log.append(
        &EventWrite::plain(
            (at(
                RuntimeEvent::new(
                    invocation.clone(),
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed,
                    },
                ),
                900,
            ))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let ended_before = log.get_session::<Value>("a").await.unwrap().unwrap();
    let source = rusqlite::Connection::open(&path).unwrap();
    let source_bytes = source
        .prepare("SELECT event_json FROM runtime_events ORDER BY sequence")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    log.close().await.unwrap();
    // The message cache is disposable even when its watermark survives. A cold
    // rebuild must recover identical facts without rewriting the source log.
    source
        .execute_batch("DELETE FROM catalog_messages;")
        .unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let ended = log.get_session::<Value>("a").await.unwrap().unwrap();
    assert_eq!(ended.revision, 4);
    assert_eq!(
        ended.execution.as_ref().unwrap().state,
        SessionExecutionState::Ended {
            status: TerminalStatus::Completed,
            recorded_at: 900
        }
    );
    assert_eq!(ended, ended_before);
    assert_eq!(ended.last_message, answered.last_message);
    assert_eq!(
        source_bytes,
        source
            .prepare("SELECT event_json FROM runtime_events ORDER BY sequence")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    );
    // A new turn after a wall-clock rollback keeps the newer catalog message,
    // while its execution status still reports the new opening's factual time.
    let mut rollback = opened.clone();
    rollback.id = "rollback-opening".into();
    rollback.invocation = Invocation {
        session_id: "a".into(),
        turn_id: "rollback-turn".into(),
        run_id: "rollback-run".into(),
        invocation_id: "rollback-invocation".into(),
    };
    if let Fact::InvocationOpened {
        input: maka_agent_facts::input::InvocationInput::Message { content, .. },
        ..
    } = &mut rollback.fact
    {
        content.display_text = Some("rollback preview must not replace the original".into());
    }
    log.append(&EventWrite::plain((at(rollback, 1500)).clone()).unwrap())
        .await
        .unwrap();
    let rollback = log.get_session::<Value>("a").await.unwrap().unwrap();
    assert_eq!(
        rollback.execution.as_ref().unwrap().state,
        SessionExecutionState::Live { recorded_at: 1500 }
    );
    let message = rollback.last_message.as_ref().unwrap();
    let previous = ended.last_message.as_ref().unwrap();
    assert_eq!(message.recorded_at, previous.recorded_at);
    assert_eq!(message.preview, previous.preview);
    assert_eq!(message.tail_message_id, "rollback-opening");
    log.close().await.unwrap();
    // Rebuild commit-order guards from canonical facts, not max(time)/latest(text).
    source
        .execute_batch("DELETE FROM catalog_message_watermark;")
        .unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.get_session::<Value>("a")
            .await
            .unwrap()
            .unwrap()
            .execution
            .unwrap(),
        rollback.execution.unwrap()
    );
    assert_eq!(
        log.get_session::<Value>("b")
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );
}

fn owned_parts(
    invocation: &str,
    step: &str,
    parts: Vec<maka_agent_facts::model::ModelPart>,
) -> Vec<maka_agent_facts::model::recorded::CompletionPart> {
    use maka_agent_facts::model::{
        ModelPart,
        recorded::{CompletionPart, ModelPartRecord},
    };
    parts
        .into_iter()
        .enumerate()
        .map(|(ordinal, part)| {
            let message_id = match &part {
                ModelPart::ToolCall { call } => maka_agent_facts::tool_call::tool_use_id(
                    invocation,
                    &format!("{step}:{}", call.id),
                ),
                _ => uuid::Uuid::new_v4().to_string(),
            };
            CompletionPart::Own(ModelPartRecord {
                ordinal: ordinal as u64,
                message_id,
                started_at: std::time::UNIX_EPOCH + std::time::Duration::from_millis(2000),
                provider_part_id: None,
                part: std::sync::Arc::new(part),
            })
        })
        .collect()
}
