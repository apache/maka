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
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::execution::BehaviorId;
use maka_agent_facts::input::DeliveredMessage;
use maka_agent_facts::input::MessageInput;
use maka_agent_facts::message;
use maka_agent_facts::message::MessageDisposition;
use maka_agent_facts::message::Placement;
use maka_agent_facts::message::RootSourceMessage;
use maka_agent_facts::message::SubmittedTurnIntent;
use maka_agent_facts::message::TurnOrchestration;
use maka_agent_facts::message::TurnOrchestrationSource;
use maka_event_log::{EventLog, message_resolution::MessageExecution};
use serde_json::json;

#[path = "../src/transcript_cache.rs"]
mod support;

fn source(id: &str, text: &str) -> RootSourceMessage {
    RootSourceMessage {
        unprepared_content: text.into(),
        message: DeliveredMessage {
            origin: None,
            message_id: id.into(),
            content: text.into(),
            submitted_content_digest: format!("sha256:{}", "b".repeat(64)),
        },
        submitted_placement: Placement::CurrentTurn,
        disposition: MessageDisposition::Steering,
        submitted_intent: None,
    }
}
fn opening(session: &str, turn: &str, sources: Vec<RootSourceMessage>) -> RuntimeEvent {
    RuntimeEvent::new(
        Invocation {
            session_id: session.into(),
            turn_id: turn.into(),
            run_id: format!("run-{turn}"),
            invocation_id: format!("invocation-{turn}"),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: message::aggregate(sources.iter().map(|source| &source.message.content)),
                request_fingerprint: None,
                source_messages: sources,
            },
        },
    )
}
async fn end(log: &EventLog, event: &RuntimeEvent) {
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            event.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn root_sources_are_atomic_exclusive_delivery_proofs_and_rebuild_exact_visible_identity() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("root-sources.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    for session in ["a", "b"] {
        log.create_session(session, "create", &json!({}), 1)
            .await
            .unwrap();
    }
    let mut first = source("client-source", "prepared");
    first.unprepared_content = "original input".into();
    first.message.content.display_text = Some("visible".into());
    first.disposition = MessageDisposition::TurnStarted;
    first.submitted_intent = Some(SubmittedTurnIntent {
        input_selections: [("reviewer".into(), vec!["project:review".into()])].into(),
        input_selection_sources: Default::default(),
        turn_orchestration: Some(TurnOrchestration {
            mode: BehaviorId::try_from("graph".to_owned()).unwrap(),
            source: TurnOrchestrationSource::SlashCommand,
        }),
    });
    let event = opening("a", "first", vec![first.clone()]);
    let mut duplicate_receipt = event.clone();
    let Fact::InvocationOpened {
        input: InvocationInput::Message { content, .. },
        ..
    } = &mut duplicate_receipt.fact
    else {
        unreachable!()
    };
    content.text.push_str("not in source");
    assert!(
        EventWrite::plain(duplicate_receipt).is_err(),
        "opening must preserve its admitted source content"
    );
    let write = EventWrite::plain(event.clone()).unwrap();
    let pending = maka_event_log::message_admissions::PendingMessageAdmission {
        execution: maka_event_log::message_admissions::PendingExecution {
            owner: "maka-runtime-host".into(),
            basis: serde_json::Value::Null,
        },
        steering_invocation: None,
        required_tools: Default::default(),
        invocation: event.invocation.clone(),
        source: first.clone(),
        admitted_at: 1,
    };
    assert_eq!(log.admit_message(pending.clone()).await.unwrap(), pending);
    assert_eq!(log.admit_message(pending.clone()).await.unwrap(), pending);
    assert!(matches!(
        log.message_execution("a", "client-source").await.unwrap(),
        MessageExecution::Pending
    ));
    let mut changed = pending.clone();
    changed.source.message.content.text = "different intent".into();
    assert!(log.admit_message(changed).await.is_err());
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_source BEFORE INSERT ON message_sources BEGIN SELECT RAISE(ABORT, 'source fault'); END;").unwrap();
    let before = serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap();
    assert!(log.append(&write).await.is_err());
    assert_eq!(
        serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap(),
        before
    );
    assert!(
        log.root_message("a", "client-source")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(log.pending_messages("a").await.unwrap(), vec![pending]);
    db.execute_batch("DROP TRIGGER reject_source").unwrap();
    let sequence = log.append(&write).await.unwrap();
    assert!(log.pending_messages("a").await.unwrap().is_empty());
    let mut queued_exact = maka_event_log::message_admissions::PendingMessageAdmission {
        execution: maka_event_log::message_admissions::PendingExecution {
            owner: "maka-runtime-host".into(),
            basis: serde_json::Value::Null,
        },
        steering_invocation: None,
        required_tools: Default::default(),
        invocation: event.invocation.clone(),
        source: first.clone(),
        admitted_at: 2,
    };
    queued_exact.source.message.message_id = "queued-exact".into();
    queued_exact.source.disposition = MessageDisposition::Steering;
    assert!(log.admit_message(queued_exact).await.is_err());
    assert_eq!(log.append(&write).await.unwrap(), sequence);
    let proof = log
        .root_message("a", "client-source")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(proof.opening().event, event);
    assert_eq!(proof.source(), &first);
    let editable = log
        .editable_message("a", "first", "client-source")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(editable.content.text, "original input");
    assert_eq!(editable.intent, first.submitted_intent);
    assert!(
        matches!(log.message_execution("a", "client-source").await.unwrap(), MessageExecution::Owned(owner) if owner.invocation == event.invocation)
    );
    assert!(
        log.steering_message("a", "client-source")
            .await
            .unwrap()
            .is_none()
    );
    let rows = support::transcript(&log, "a").await;
    assert_eq!(rows[0]["id"], "client-source");
    assert_eq!(rows[0]["text"], "prepared");
    assert_eq!(rows[0]["displayText"], "visible");

    // Root and steering deliveries share one identity domain, in both directions.
    let colliding = RuntimeEvent::new(event.invocation.clone(), {
        let message = first.message.clone();
        let mut unprepared_content = message.content.clone();
        unprepared_content.preparation.clear();
        Fact::MessageSteered {
            source: Box::new(maka_agent_facts::message::RootSourceMessage {
                message: message.clone(),
                unprepared_content,
                submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
                disposition: maka_agent_facts::message::MessageDisposition::Steering,
                submitted_intent: None,
            }),
            message: Box::new(message),
        }
    });
    assert!(
        log.append(&EventWrite::plain(colliding).unwrap())
            .await
            .is_err()
    );
    let delivered = source("already-steered", "correction").message;
    log.append(
        &EventWrite::plain(RuntimeEvent::new(event.invocation.clone(), {
            let message = delivered;
            let mut unprepared_content = message.content.clone();
            unprepared_content.preparation.clear();
            Fact::MessageSteered {
                source: Box::new(maka_agent_facts::message::RootSourceMessage {
                    message: message.clone(),
                    unprepared_content,
                    submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
                    disposition: maka_agent_facts::message::MessageDisposition::Steering,
                    submitted_intent: None,
                }),
                message: Box::new(message),
            }
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    end(&log, &event).await;
    assert!(
        matches!(log.message_execution("a", "already-steered").await.unwrap(), MessageExecution::Shared(owner) if owner.invocation == event.invocation)
    );
    assert_eq!(log.append(&write).await.unwrap(), sequence);
    for id in ["client-source", "already-steered", event.id.as_str()] {
        assert!(
            log.append(
                &EventWrite::plain(opening("a", "conflict", vec![source(id, "new")])).unwrap()
            )
            .await
            .is_err()
        );
    }
    let other = opening("b", "other", vec![first.clone()]);
    log.append(&EventWrite::plain(other.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        support::transcript(&log, "b").await[0]["id"],
        "client-source"
    );

    let mut batch = vec![
        source("batch-z-left", "left"),
        source("batch-a-right", "right"),
    ];
    batch[0].unprepared_content.text = "first original".into();
    batch[1].unprepared_content.text = "second original".into();
    let combined = opening("a", "successor", batch.clone());
    let mut mismatch = combined.clone();
    if let Fact::InvocationOpened {
        input: InvocationInput::Message { content, .. },
        ..
    } = &mut mismatch.fact
    {
        *content = MessageInput::from("not their ordered aggregate");
    }
    assert!(EventWrite::plain(mismatch).is_err());
    let mixed = vec![first, source("another", "right")];
    assert!(
        EventWrite::plain(opening("a", "mixed", mixed)).is_err(),
        "exact intent cannot join a multi-source Turn"
    );
    log.append(&EventWrite::plain(combined.clone()).unwrap())
        .await
        .unwrap();
    let rows = support::transcript(&log, "a").await;
    let row = rows.iter().find(|row| row["id"] == combined.id).unwrap();
    assert_eq!(row["text"], "left\n\nright");
    let mut editable = Vec::new();
    for (index, source) in batch.iter().enumerate() {
        let proof = log
            .root_message("a", &source.message.message_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(proof.opening().event, combined);
        if index == 0 {
            let Fact::InvocationOpened {
                input:
                    InvocationInput::Message {
                        source_messages, ..
                    },
                ..
            } = &proof.opening().event.fact
            else {
                unreachable!()
            };
            assert_eq!(
                source_messages
                    .iter()
                    .map(|source| (
                        source.message.message_id.as_str(),
                        source.unprepared_content.text.as_str()
                    ))
                    .collect::<Vec<_>>(),
                [
                    ("batch-z-left", "first original"),
                    ("batch-a-right", "second original")
                ]
            );
        }
        assert_eq!(proof.source(), source);
        let message = log
            .editable_message(
                "a",
                &combined.invocation.turn_id,
                &source.message.message_id,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            message.content, source.unprepared_content,
            "editing selects the exact source, not the batch aggregate"
        );
        assert!(
            log.editable_message("b", "successor", &source.message.message_id)
                .await
                .unwrap()
                .is_none()
        );
        editable.push(message);
        assert!(
            matches!(log.message_execution("a", &source.message.message_id).await.unwrap(), MessageExecution::Shared(owner) if owner.invocation == combined.invocation)
        );
    }
    let mut collision = RuntimeEvent::new(
        combined.invocation.clone(),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    collision.id = "batch-a-right".into();
    assert!(
        log.append(&EventWrite::plain(collision).unwrap())
            .await
            .is_err()
    );
    end(&log, &combined).await;
    let rows = support::transcript(&log, "a").await;
    let canonical = serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap();
    log.close().await.unwrap();
    db.execute_batch("DELETE FROM message_sources; DELETE FROM catalog_messages;")
        .unwrap();
    drop(db);
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap(),
        canonical
    );
    assert_eq!(support::transcript(&log, "a").await, rows);
    for message in editable {
        assert_eq!(
            log.editable_message("a", "successor", &message.message_id)
                .await
                .unwrap()
                .unwrap(),
            message
        );
    }
    assert!(
        matches!(log.message_execution("a", "client-source").await.unwrap(), MessageExecution::Owned(owner) if owner.invocation == event.invocation),
        "a later independent root cannot acquire an earlier Message"
    );
    assert_eq!(
        log.root_message("a", "client-source")
            .await
            .unwrap()
            .unwrap()
            .opening()
            .event,
        event
    );
    assert_eq!(
        log.root_message("b", "client-source")
            .await
            .unwrap()
            .unwrap()
            .opening()
            .event,
        other
    );
    assert!(
        log.steering_message("a", "already-steered")
            .await
            .unwrap()
            .is_some()
    );
    for source in &batch {
        assert_eq!(
            log.root_message("a", &source.message.message_id)
                .await
                .unwrap()
                .unwrap()
                .source(),
            source
        );
    }
    log.close().await.unwrap();
}
