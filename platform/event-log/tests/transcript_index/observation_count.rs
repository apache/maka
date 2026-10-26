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
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_ports::session::history::{Page, Position};

#[tokio::test]
async fn more_than_ten_thousand_actual_observations_remain_readable() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("observations.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let session = "observations";
    log.create_session(session, "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let start = event(
        session,
        observe(
            session,
            ModelEvent::PartStarted {
                id: "part".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            },
        ),
    );
    let message_id = start.event().id.clone();
    let invocation = start.event().invocation.clone();
    let mut events = vec![
        event(session, opening()),
        event(session, request(session)),
        start,
    ];
    for _ in 0..10_001 {
        events.push(event(
            session,
            observe(
                session,
                ModelEvent::PartDelta {
                    id: "part".into(),
                    text: "x".into(),
                    provider_options: None,
                },
            ),
        ));
    }
    events.push(event(
        session,
        observe(
            session,
            ModelEvent::PartFinished {
                id: "part".into(),
                provider_options: None,
            },
        ),
    ));
    let sequences = log.append_batch(&events).await.unwrap();
    assert_eq!(sequences.len(), 10_005);
    let live = *sequences.last().unwrap();
    let expected = "x".repeat(10_001);
    let overlay = log.active_transcript(&invocation, live).await.unwrap();
    assert_eq!(overlay.len(), 1);
    assert_eq!(overlay[0].id, message_id);
    assert!(matches!(&overlay[0].content,
        maka_presentation::Content::Assistant { text, interrupted: false, .. } if text == &expected));
    let completion = log
        .append(&event(
            session,
            Fact::ModelCompleted {
                step_id: "step-observations".into(),
                output: ModelStep {
                    parts: vec![ModelPart::Text {
                        text_kind: TextKind::Text,
                        text: expected.clone(),
                        provider_options: None,
                    }],
                    finish_reason: ModelFinishReason::Stop,
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
    let through = end(&log, session, InvocationOutcome::Completed).await;

    let Page::Ready { chunks, .. } = log
        .history_text(
            session,
            through,
            Position::Event {
                sequence: completion,
            },
            false,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 32 * 1024,
                max_chunks: Some(1),
                max_json_bytes: 64 * 1024,
            },
        )
        .await
        .unwrap();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].message_id, message_id);
    assert_eq!(
        chunks[0].position,
        RowPosition {
            source_sequence: completion,
            item_index: 0
        }
    );
    assert_eq!(chunks[0].text, expected);
    assert_eq!(chunks[0].total_bytes, 10_001);
    crate::transcript_cache::materialize_all_rows(&log, session, through)
        .await
        .unwrap();

    assert_eq!(
        crate::test_store::inspect(&log, |db| rows(db, session))
            .await
            .len(),
        4
    );
    log.close().await.unwrap();
}
