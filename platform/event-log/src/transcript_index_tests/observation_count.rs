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
async fn large_complete_body_remains_readable_without_durable_deltas() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("observations.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let session = "observations";
    log.create_session(session, "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let expected = "x".repeat(10_001);
    let record = record(
        "step-observations",
        0,
        ModelPart::Text {
            text_kind: TextKind::Text,
            text: expected.clone().into(),
            provider_options: None,
        },
    );
    let message_id = record.message_id.clone();
    log.append_batch(&[event(session, opening()), event(session, request(session))])
        .await
        .unwrap();
    let completion = log
        .append(&event(
            session,
            Fact::ModelCompleted {
                step_id: "step-observations".into(),
                output: ModelCompletion {
                    parts: vec![CompletionPart::Own(record)],
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
        chunks[0].model_part,
        Some(maka_agent_ports::session::history::ModelPartIdentity {
            step_id: "step-observations".into(),
            ordinal: 0,
        })
    );
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
        crate::test_store::inspect_cache(&log, |db| rows(db, session))
            .await
            .len(),
        4
    );
    log.close().await.unwrap();
}
