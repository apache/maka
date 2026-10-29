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
use maka_agent_facts::model::{ModelFinishReason, ModelToolCall};
use maka_agent_ports::session::history::{SourceField, SourcePosition};
use maka_event_log::transcript::{TranscriptDirection, TranscriptRead};
use serde_json::json;

const SESSION: &str = "large-siblings";

fn input(index: usize) -> Value {
    let prefix = format!("call-{index}:中😀");
    let suffix = format!(":end-{index}");
    let note = format!(
        "{prefix}{}{suffix}",
        "x".repeat(65_536 - prefix.len() - suffix.len())
    );
    assert_eq!(note.len(), 65_536);
    json!({"index":index,"note":note})
}

async fn source(
    log: &EventLog,
    through: u64,
    position: RowPosition,
    field: SourceField,
    expected: &str,
    paired: bool,
) {
    let mut offset = 0;
    loop {
        let page = log
            .history_source(
                SESSION,
                through,
                maka_event_log::transcript::SourceSelection {
                    locator: position,
                    field,
                    path: None,
                },
                SourcePosition::After { offset },
                4096,
            )
            .await
            .unwrap();
        assert_eq!(page.position, position);
        assert_eq!(page.field, field);
        assert_eq!(page.offset, offset);
        assert_eq!(page.total_bytes, expected.len() as u64);
        assert!(!page.text.is_empty());
        let end = offset as usize + page.text.len();
        assert_eq!(page.text, expected[offset as usize..end]);
        let tool = page.tool.unwrap();
        assert!(tool.call.is_some());
        assert_eq!(tool.result.is_some(), paired);
        offset = end as u64;
        if offset == page.total_bytes {
            break;
        }
    }
}

// Retain only identities/digests, never a second copy of all large row payloads.
fn fingerprints(db: &Connection) -> Vec<(i64, i64, String, i64)> {
    db.prepare(
        "SELECT source_sequence, item_index, digest, total_bytes FROM temp.transcript_rows
         WHERE session_id = ? ORDER BY source_sequence, item_index",
    )
    .unwrap()
    .query_map([SESSION], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

#[tokio::test]
async fn completion_fanout_keeps_large_original_sources_usage_and_exact_positions_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("large-siblings.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session(SESSION, "create", &json!({}), 1)
        .await
        .unwrap();
    let opening = log.append(&event(SESSION, opening())).await.unwrap();
    log.append(&event(SESSION, request(SESSION))).await.unwrap();
    let calls: Vec<_> = (0..256)
        .map(|index| ModelToolCall {
            id: format!("call-{index}"),
            name: if index < 2 { "wait" } else { "Read" }.into(),
            input: input(index).into(),
            provider_options: None,
            provider_executed: false,
        })
        .collect();
    let observed = calls
        .iter()
        .map(|call| {
            event(
                SESSION,
                observe(SESSION, ModelEvent::ToolCall(call.clone())),
            )
        })
        .collect::<Vec<_>>();
    let old_fence = *log.append_batch(&observed).await.unwrap().last().unwrap();
    let completion = log
        .append(&event(
            SESSION,
            Fact::ModelCompleted {
                step_id: format!("step-{SESSION}"),
                output: ModelStep {
                    parts: calls
                        .into_iter()
                        .map(|call| ModelPart::ToolCall { call })
                        .collect(),
                    finish_reason: ModelFinishReason::ToolCalls,
                    usage: ModelUsage {
                        input_tokens: Some(7),
                        output_tokens: Some(11),
                        ..Default::default()
                    },
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            },
        ))
        .await
        .unwrap();
    crate::transcript_cache::materialize_all_rows(&log, SESSION, completion)
        .await
        .unwrap();
    for index in [0, 255] {
        source(
            &log,
            completion,
            RowPosition {
                source_sequence: completion,
                item_index: index as u64,
            },
            SourceField::Arguments,
            &serde_json::to_string(&input(index)).unwrap(),
            false,
        )
        .await;
    }
    let operation = format!("step-{SESSION}:call-255");
    let neighboring = log
        .append(&event(
            SESSION,
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: operation.clone(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::provider(
                    format!("step-{SESSION}"),
                    "call-255".into(),
                ),
                name: "Read".into(),
                input: input(255),
            },
        ))
        .await
        .unwrap();
    assert_eq!(neighboring, completion + 1);
    let template = event(
        SESSION,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    let success = maka_agent_facts::event::EventWrite::tool_success(
        template.event().id.clone(),
        template.event().recorded_at,
        template.event().invocation.clone(),
        operation.clone(),
        json!({"answer":"literal中😀result"}).into(),
    )
    .unwrap()
    .0;
    let result = log.append(&success).await.unwrap();
    let through = end(&log, SESSION, InvocationOutcome::Completed).await;
    crate::transcript_cache::materialize_all_rows(&log, SESSION, through)
        .await
        .unwrap();
    let original = crate::test_store::inspect_cache(&log, fingerprints).await;
    assert_eq!(
        original
            .iter()
            .filter(|row| row.0 == i64::try_from(completion).unwrap())
            .count(),
        257
    );
    let usage = crate::test_store::inspect_cache(&log, move |db| {
        let payload: Vec<u8> = db.query_row(
            "SELECT payload FROM temp.transcript_rows WHERE session_id=? AND source_sequence=? AND item_index=256",
            (SESSION, completion), |row| row.get(0),
        ).unwrap();
        serde_json::from_slice::<Value>(&payload).unwrap()
    }).await;
    assert_eq!(usage["type"], "token_usage");
    assert_eq!(usage["input"], 7);
    assert_eq!(usage["output"], 11);
    assert!(
        original
            .iter()
            .any(|row| row.0 == i64::try_from(neighboring).unwrap() && row.1 == 0)
    );
    let old = log
        .transcript_headers(
            SESSION,
            &TranscriptRead {
                through: old_fence,
                position: None,
                direction: TranscriptDirection::Newer,
                limit: 256,
            },
        )
        .await
        .unwrap();
    assert_eq!(old.len(), 2);
    assert!(
        old.iter()
            .all(|row| row.position.source_sequence <= old_fence)
    );
    let anchor = RowPosition {
        source_sequence: completion,
        item_index: 255,
    };
    for (fence, expected) in [
        (
            through,
            [
                anchor,
                RowPosition {
                    item_index: 254,
                    ..anchor
                },
            ],
        ),
        (
            old_fence,
            [
                RowPosition {
                    source_sequence: opening,
                    item_index: 1,
                },
                RowPosition {
                    source_sequence: opening,
                    item_index: 0,
                },
            ],
        ),
    ] {
        let headers = log
            .transcript_headers(
                SESSION,
                &TranscriptRead {
                    through: fence,
                    position: Some(anchor),
                    direction: TranscriptDirection::Older,
                    limit: 2,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            headers
                .iter()
                .map(|header| header.position)
                .collect::<Vec<_>>(),
            expected
        );
    }
    let page = log
        .transcript_headers(
            SESSION,
            &TranscriptRead {
                through,
                position: Some(RowPosition {
                    source_sequence: completion,
                    item_index: 0,
                }),
                direction: TranscriptDirection::Newer,
                limit: 256,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.len(), 256);
    assert_eq!(page.last().unwrap().position, anchor);
    let next = log
        .transcript_headers(
            SESSION,
            &TranscriptRead {
                through,
                position: Some(RowPosition {
                    item_index: 256,
                    ..anchor
                }),
                direction: TranscriptDirection::Newer,
                limit: 2,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        next.iter()
            .map(|header| header.position)
            .collect::<Vec<_>>(),
        [
            RowPosition {
                item_index: 256,
                ..anchor
            },
            RowPosition {
                source_sequence: neighboring,
                item_index: 0
            },
        ]
    );
    let search = log
        .search_transcript(
            SESSION,
            maka_event_log::transcript::search::TranscriptSearch {
                through,
                after: Some(RowPosition {
                    item_index: 257,
                    ..anchor
                }),
                query: "literal".into(),
                case_sensitive: true,
                whole_word: false,
                include_internal: false,
                max_matches: 16,
            },
        )
        .await
        .unwrap();
    assert_eq!(search.matches.len(), 1);
    assert_eq!(
        search.matches[0].position,
        RowPosition {
            source_sequence: result,
            item_index: 0
        }
    );
    {
        let log = &log;
        use maka_agent_ports::session::history::{HistoryField, HistoryView, Page, Position};
        // These are real siblings from one completed canonical ModelStep. Event
        // navigation would choose item zero instead of the requested item255.
        for index in [0, 255] {
            let position = RowPosition {
                source_sequence: completion,
                item_index: index,
            };
            let Page::Ready { chunks, after, .. } = log
                .history_view(
                    SESSION,
                    through,
                    Position::Row {
                        position,
                        field: HistoryField::Body,
                    },
                    false,
                    HistoryView::Conversation,
                    maka_event_log::transcript::HistoryLimits {
                        max_bytes: 8192,
                        max_chunks: Some(1),
                        max_json_bytes: 65536,
                    },
                )
                .await
                .unwrap();
            assert_eq!(chunks[0].position, position);
            assert_eq!(chunks[0].field, HistoryField::Body);
            assert_eq!(
                chunks[0].role,
                maka_agent_ports::session::history::Role::ToolCall
            );
            assert_eq!(chunks[0].total_bytes, 0);
            let expected_name = if index == 0 { "wait" } else { "Read" };
            assert_eq!(
                chunks[0].tool.as_ref().unwrap().call.as_ref().unwrap().name,
                expected_name
            );
            if index == 0 {
                let Page::Ready { chunks, .. } = log
                    .history_view(
                        SESSION,
                        through,
                        Position::After {
                            cursor: after.unwrap(),
                        },
                        false,
                        HistoryView::Conversation,
                        maka_event_log::transcript::HistoryLimits {
                            max_bytes: 8192,
                            max_chunks: Some(1),
                            max_json_bytes: 65536,
                        },
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    chunks[0].position,
                    RowPosition {
                        source_sequence: completion,
                        item_index: 2
                    },
                    "the following internal sibling remains hidden and continuation advances"
                );
            }
            assert!(
                log.history_view(
                    SESSION,
                    through,
                    Position::Row {
                        position,
                        field: HistoryField::Thinking
                    },
                    true,
                    HistoryView::Conversation,
                    maka_event_log::transcript::HistoryLimits {
                        max_bytes: 8192,
                        max_chunks: Some(1),
                        max_json_bytes: 65536
                    }
                )
                .await
                .is_err(),
                "a tool Body is not a Thinking field"
            );
        }
        for include_internal in [false, true] {
            let hits = log
                .search_transcript(
                    SESSION,
                    maka_event_log::transcript::search::TranscriptSearch {
                        through,
                        after: None,
                        query: "wait".into(),
                        case_sensitive: true,
                        whole_word: true,
                        include_internal,
                        max_matches: 16,
                    },
                )
                .await
                .unwrap();
            assert_eq!(hits.matches.len(), if include_internal { 2 } else { 0 });
            if include_internal {
                assert_eq!(
                    hits.matches[0].position,
                    RowPosition {
                        source_sequence: completion,
                        item_index: 0
                    }
                );
                assert_eq!(hits.matches[0].field, SourceField::ToolName);
            }
        }
        for position in [
            RowPosition {
                source_sequence: completion,
                item_index: 999,
            },
            RowPosition {
                source_sequence: through + 1,
                item_index: 0,
            },
        ] {
            assert!(
                log.history_view(
                    SESSION,
                    through,
                    Position::Row {
                        position,
                        field: HistoryField::Body
                    },
                    false,
                    HistoryView::Conversation,
                    maka_event_log::transcript::HistoryLimits {
                        max_bytes: 8192,
                        max_chunks: Some(1),
                        max_json_bytes: 65536
                    }
                )
                .await
                .is_err()
            );
        }
        for index in [0, 255] {
            let position = RowPosition {
                source_sequence: completion,
                item_index: index as u64,
            };
            let expected = serde_json::to_string(&input(index)).unwrap();
            source(
                log,
                completion,
                position,
                SourceField::Arguments,
                &expected,
                false,
            )
            .await;
            source(
                log,
                through,
                position,
                SourceField::Arguments,
                &expected,
                index == 255,
            )
            .await;
        }
        let result_position = RowPosition {
            source_sequence: result,
            item_index: 0,
        };
        source(
            log,
            through,
            result_position,
            SourceField::Result,
            r#"{"answer":"literal中😀result"}"#,
            true,
        )
        .await;
        assert!(
            log.history_source(
                SESSION,
                completion,
                maka_event_log::transcript::SourceSelection {
                    locator: result_position,
                    field: SourceField::Result,
                    path: None
                },
                SourcePosition::Start,
                4096
            )
            .await
            .is_err()
        );
        assert_eq!(
            log.tool_source_position(
                SESSION,
                through,
                &maka_presentation::tool_message_id(&format!("inv-{SESSION}"), &operation)
            )
            .await
            .unwrap(),
            RowPosition {
                source_sequence: completion,
                item_index: 255
            }
        );
    }
    crate::test_store::inspect_cache(&log, |db| {
        for table in ["temp.transcript_text", "temp.transcript_rows"] {
            db.execute(&format!("DELETE FROM {table}"), []).unwrap();
        }
    })
    .await;
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    crate::transcript_cache::materialize_all_rows(&reopened, SESSION, through)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&reopened, fingerprints).await,
        original
    );
    source(
        &reopened,
        through,
        anchor,
        SourceField::Arguments,
        &serde_json::to_string(&input(255)).unwrap(),
        true,
    )
    .await;
    reopened.close().await.unwrap();
}
