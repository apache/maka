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
use maka_agent_facts::context::ModelPurpose;

#[path = "automatic/steps.rs"]
mod steps;
use steps::{finish, step};

#[tokio::test]
async fn automatic_summary_is_hidden_without_interrupting_main_delivery_or_read_tail() {
    for ending in ["success", "interrupted", "cancelled"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.create_session("session", "create", &json!({}), 1)
            .await
            .unwrap();
        let inv = identity("main");
        let mut view = InvocationView::new();
        let opened = append(
            &log,
            &inv,
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "question".into(),
                    request_fingerprint: None,
                },
            },
        )
        .await;
        let mut expected = view.push(&opened).unwrap();
        let (main_fence, main_id) = step(
            &log,
            &mut view,
            &inv,
            "main-a",
            ModelPurpose::Main,
            "first answer",
        )
        .await;
        let before = log
            .observe_session::<Value>("session")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before.active_streams.len(), 1);
        assert_eq!(before.active_streams[0].message_id, main_id);
        expected.extend(finish(&log, &mut view, &inv, "main-a", "first answer").await);
        let read = log
            .set_session_read_marker::<Value>("session", &main_id)
            .await
            .unwrap();
        let (summary_fence, _) = step(
            &log,
            &mut view,
            &inv,
            "summary",
            ModelPurpose::Summary,
            &"secret ".repeat(1024),
        )
        .await;
        assert!(view.overlay().is_empty());
        let during = log
            .observe_session::<Value>("session")
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            during.root_turn.unwrap().state,
            InvocationState::Running
        ));
        assert!(during.active_streams.is_empty());
        assert!(during.compacting.is_none());
        assert!(
            log.active_transcript(&inv, summary_fence)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(during.session.last_message, read.last_message);
        assert_eq!(during.session.read_state, read.read_state);
        let requested = log
            .prefix(32, 128 * 1024)
            .await
            .unwrap()
            .events
            .into_iter()
            .find(|event| {
                matches!(
                    &event.event.fact,
                    Fact::ModelRequested {
                        purpose: ModelPurpose::Summary,
                        ..
                    }
                )
            })
            .unwrap()
            .event;
        let waiting = append(&log, &inv, Fact::ContextCompactionWaiting).await;
        assert!(view.push(&waiting).unwrap().is_empty());
        let progress = log
            .observe_session::<Value>("session")
            .await
            .unwrap()
            .unwrap()
            .compacting
            .unwrap();
        assert_eq!(progress.id, requested.id);
        assert_eq!(
            progress.started_at,
            requested
                .recorded_at
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
        );
        let change = log
            .session_stream_events("session", summary_fence, waiting.sequence, 32, 8192)
            .await
            .unwrap();
        assert_eq!(change.events.len(), 1);
        assert!(matches!(change.events[0].fact, StreamFact::ContextChanged));
        // Subscribers receive the main closer and a status invalidation,
        // while private summary content remains hidden.
        let mut cursor = main_fence;
        let mut facts = Vec::new();
        loop {
            let page = log
                .session_stream_events("session", cursor, summary_fence, 1, 4096)
                .await
                .unwrap();
            facts.extend(page.events.into_iter().map(|event| event.fact));
            if let Some(after) = page.next_after {
                cursor = after;
            } else {
                assert_eq!(page.through_sequence, summary_fence);
                break;
            }
        }
        assert_eq!(facts.len(), 3);
        assert!(matches!(&facts[2], StreamFact::ContextChanged));
        assert!(
            matches!(&facts[0], StreamFact::PartFinished { step_id, .. } if step_id == "main-a")
        );
        assert!(matches!(&facts[1], StreamFact::StepEnded { step_id, .. } if step_id == "main-a"));
        crate::transcript_cache::materialize_all_rows(&log, "session", summary_fence)
            .await
            .unwrap();
        let db = Connection::open(&path).unwrap();
        let before_rows = crate::test_store::inspect_cache(&log, transcript).await;
        if ending == "success" {
            assert!(
                finish(&log, &mut view, &inv, "summary", &"secret ".repeat(1024))
                    .await
                    .is_empty()
            );
        } else if ending == "interrupted" {
            let interrupted = append(
                &log,
                &inv,
                Fact::ModelInterrupted {
                    model_failure: None,
                    diagnostic: None,
                    step_id: "summary".into(),
                    status: ModelInterruption::Failed,
                },
            )
            .await;
            assert!(view.push(&interrupted).unwrap().is_empty());
        }
        let unchanged = log.get_session::<Value>("session").await.unwrap().unwrap();
        assert_eq!(unchanged.last_message, read.last_message);
        assert_eq!(unchanged.read_state, read.read_state);
        if ending != "cancelled" {
            let (later, later_id) = step(
                &log,
                &mut view,
                &inv,
                "main-b",
                ModelPurpose::Main,
                "second answer",
            )
            .await;
            let active = log
                .observe_session::<Value>("session")
                .await
                .unwrap()
                .unwrap();
            assert_eq!(active.active_streams.len(), 1);
            assert!(active.compacting.is_none());
            let main = log.session_events("session", waiting.sequence, later, 32, 128 * 1024)
                .await.unwrap().events.into_iter().find(|event| matches!(&event.event.fact,
                    Fact::ModelRequested { step_id, purpose: ModelPurpose::Main, .. } if step_id == "main-b"))
                .unwrap();
            let changes = log
                .session_stream_events("session", waiting.sequence, later, 32, 128 * 1024)
                .await
                .unwrap();
            assert!(
                changes
                    .events
                    .iter()
                    .any(|change| change.id == main.event.id
                        && matches!(change.fact, StreamFact::ContextChanged))
            );
            assert_eq!(active.active_streams[0].message_id, later_id);
            assert_eq!(
                log.active_transcript(&inv, later).await.unwrap()[0].id,
                later_id
            );
            expected.extend(finish(&log, &mut view, &inv, "main-b", "second answer").await);
        }
        let end = append(
            &log,
            &inv,
            Fact::InvocationEnded {
                outcome: if ending == "cancelled" {
                    InvocationOutcome::Cancelled {
                        source: "user".into(),
                    }
                } else {
                    InvocationOutcome::Completed
                },
            },
        )
        .await;
        expected.extend(view.push(&end).unwrap());
        assert!(
            log.observe_session::<Value>("session")
                .await
                .unwrap()
                .unwrap()
                .compacting
                .is_none()
        );
        assert!(
            log.get_session::<Value>("session")
                .await
                .unwrap()
                .unwrap()
                .read_state
                .has_unread,
            "the genuine main Turn terminal retains normal unread behavior"
        );
        let tail = log
            .session_stream_events("session", summary_fence, end.sequence, 32, 8192)
            .await
            .unwrap();
        assert!(matches!(
            tail.events.last().unwrap().fact,
            StreamFact::InvocationEnded { .. }
        ));
        assert!(tail.events.iter().all(|event| match &event.fact {
            StreamFact::PartStarted { step_id, .. }
            | StreamFact::PartDelta { step_id, .. }
            | StreamFact::PartFinished { step_id, .. }
            | StreamFact::StepEnded { step_id, .. } => step_id != "summary",
            _ => true,
        }));
        crate::transcript_cache::materialize_all_rows(&log, "session", end.sequence)
            .await
            .unwrap();
        let projected = crate::test_store::inspect_cache(&log, transcript).await;
        assert_eq!(&projected[..before_rows.len()], before_rows.as_slice());
        assert_eq!(projected.len(), expected.len());
        for ((sequence, bytes, _), row) in projected.iter().zip(expected) {
            assert_eq!(*sequence, row.position);
            assert_eq!(
                serde_json::from_slice::<Value>(bytes).unwrap(),
                serde_json::to_value(row.message).unwrap()
            );
        }
        crate::test_store::inspect_cache(&log, move |db| {
            db.execute("DELETE FROM temp.transcript_rows", []).unwrap()
        })
        .await;
        crate::test_store::inspect_cache(&log, move |db| {
            db.execute_batch("DELETE FROM temp.transcript_text; DELETE FROM temp.transcript_rows")
                .unwrap()
        })
        .await;
        db.execute("DELETE FROM catalog_message_watermark", [])
            .unwrap();
        log.close().await.unwrap();
        let reopened = EventLog::open(&path).await.unwrap();
        crate::transcript_cache::materialize_all_rows(&reopened, "session", end.sequence)
            .await
            .unwrap();
        assert_eq!(
            crate::test_store::inspect_cache(&reopened, transcript).await,
            projected
        );
        assert!(
            reopened
                .observe_session::<Value>("session")
                .await
                .unwrap()
                .unwrap()
                .active_streams
                .is_empty()
        );
    }
}
