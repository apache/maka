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
use maka_agent_facts::{
    event::StoredEvent,
    model::{ModelFinishReason, ModelSource, ModelToolCall, assembly::StepBuilder},
};
use maka_agent_ports::session::history::{Page, Position};

async fn seed(
    log: &EventLog,
    accepted: bool,
    interrupted: bool,
) -> (Vec<u64>, u64, Vec<StoredEvent>) {
    log.create_session("a", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    log.append(&event("a", opening())).await.unwrap();
    let source = log.prefix(16, 16384).await.unwrap();
    let mut requested = request("a");
    let Fact::ModelRequested {
        item_acceptance,
        source_scope,
        source_high_water,
        source_digest,
        ..
    } = &mut requested
    else {
        unreachable!()
    };
    *item_acceptance = accepted;
    *source_scope = source.scope;
    *source_high_water = source.high_water;
    *source_digest = source.digest;
    log.append(&event("a", requested)).await.unwrap();
    let mut builder = StepBuilder::default();
    let mut cuts = Vec::new();
    for observation in [
        ModelEvent::PartStarted {
            id: "part".into(),
            text_kind: TextKind::Text,
            provider_options: None,
        },
        ModelEvent::PartDelta {
            id: "part".into(),
            text: "accepted中😀".into(),
            provider_options: None,
        },
        ModelEvent::PartFinished {
            id: "part".into(),
            provider_options: None,
        },
        ModelEvent::Source(ModelSource::Url {
            id: "ref".into(),
            url: "https://example.test/ref".into(),
            title: Some("Ref".into()),
            provider_options: None,
        }),
        ModelEvent::ToolCall(ModelToolCall {
            id: "provider".into(),
            name: "Remote".into(),
            input: serde_json::json!({"q":"literal"}).into(),
            provider_options: None,
            provider_executed: true,
        }),
        ModelEvent::ProviderToolResult {
            id: "provider".into(),
            name: "Remote".into(),
            output: serde_json::json!({"answer":"provider中😀"}),
            is_error: false,
            provider_options: None,
        },
    ] {
        let publishes = matches!(
            observation,
            ModelEvent::PartFinished { .. }
                | ModelEvent::Source(_)
                | ModelEvent::ToolCall(_)
                | ModelEvent::ProviderToolResult { .. }
        );
        builder.push(observation.clone()).unwrap();
        let sequence = log
            .append(&event("a", observe("a", observation)))
            .await
            .unwrap();
        if publishes {
            cuts.push(sequence);
        }
    }
    let later = if interrupted {
        log.append(&event(
            "a",
            Fact::ModelInterrupted {
                step_id: "step-a".into(),
                status: ModelInterruption::RetryableFailure,
                diagnostic: None,
                model_failure: None,
            },
        ))
        .await
        .unwrap()
    } else {
        let finished = ModelEvent::Finished {
            reason: ModelFinishReason::Stop,
            usage: ModelUsage::default(),
            provider_options: None,
        };
        builder.push(finished.clone()).unwrap();
        log.append(&event("a", observe("a", finished)))
            .await
            .unwrap();
        log.append(&event(
            "a",
            Fact::ModelCompleted {
                step_id: "step-a".into(),
                output: builder.finish().unwrap(),
            },
        ))
        .await
        .unwrap()
    };
    (cuts, later, log.prefix(32, 65536).await.unwrap().events)
}
fn expected(events: &[StoredEvent], through: u64) -> Vec<fixtures::Row> {
    let mut view = maka_presentation::InvocationView::new();
    events
        .iter()
        .filter(|fact| fact.sequence <= through)
        .flat_map(|fact| view.push(fact).unwrap())
        .map(|row| {
            let bytes = serde_json::to_vec(&row.message).unwrap();
            let digest = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
            let size = bytes.len() as i64;
            (row.position, bytes, digest, size)
        })
        .collect()
}
fn canonical_bytes(db: &Connection) -> Vec<(i64, Vec<u8>)> {
    db.prepare("SELECT sequence, CAST(event_json AS BLOB) FROM event_log WHERE event_json IS NOT NULL ORDER BY sequence")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}
async fn page(log: &EventLog, through: u64) -> Value {
    let page = log
        .history_text(
            "a",
            through,
            Position::Start,
            false,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 4096,
                max_chunks: Some(16),
                max_json_bytes: 16384,
            },
        )
        .await
        .unwrap();
    assert!(matches!(&page, Page::Ready { .. }));
    serde_json::to_value(page).unwrap()
}

#[tokio::test]
async fn accepted_kinds_publish_at_observation_and_unaccepted_kinds_wait_for_seal() {
    for accepted in [false, true] {
        for interrupted in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("items.sqlite");
            let log = EventLog::open(&path).await.unwrap();
            let (cuts, later, events) = seed(&log, accepted, interrupted).await;
            let db = Connection::open(&path).unwrap();
            let canonical = canonical_bytes(&db);
            let unaccepted = cuts[0] - 1;
            crate::transcript_cache::materialize_all_rows(&log, "a", unaccepted)
                .await
                .unwrap();
            assert_eq!(
                crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
                expected(&events, unaccepted)
            );
            assert_eq!(
                crate::test_store::inspect_cache(&log, |db| rows(db, "a"))
                    .await
                    .len(),
                2
            );
            let unaccepted_page = page(&log, unaccepted).await;
            let mut cold = Vec::new();
            for (index, &cut) in cuts.iter().enumerate() {
                crate::transcript_cache::materialize_all_rows(&log, "a", cut)
                    .await
                    .unwrap();

                let actual = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
                assert_eq!(actual, expected(&events, cut));
                assert_eq!(actual.len(), if accepted { 3 + index } else { 2 });
                if accepted {
                    let value: Value = serde_json::from_slice(&actual.last().unwrap().1).unwrap();
                    match index {
                        0 => assert_eq!(value["text"], "accepted中😀"),
                        1 => assert_eq!(value["text"], "Source: Ref\nhttps://example.test/ref"),
                        2 => {
                            assert_eq!(value["type"], "tool_call");
                            assert_eq!(value["args"], serde_json::json!({"q":"literal"}));
                        }
                        3 => {
                            assert_eq!(value["type"], "tool_result");
                            assert_eq!(
                                value["content"]["value"],
                                serde_json::json!({"answer":"provider中😀"})
                            );
                        }
                        _ => unreachable!(),
                    }
                    assert_eq!(actual.last().unwrap().0.source_sequence, cut);
                }
                cold.push(page(&log, cut).await);
            }
            crate::transcript_cache::materialize_all_rows(&log, "a", later)
                .await
                .unwrap();
            assert_eq!(
                crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
                expected(&events, later)
            );
            for (&cut, original) in cuts.iter().zip(&cold) {
                assert_eq!(page(&log, cut).await, *original);
            }
            assert_eq!(page(&log, unaccepted).await, unaccepted_page);
            assert_eq!(canonical_bytes(&db), canonical);
            drop(db);
            log.close().await.unwrap();
            let reopened = EventLog::open(&path).await.unwrap();
            for (&cut, original) in cuts.iter().zip(&cold) {
                assert_eq!(page(&reopened, cut).await, *original);
            }
            let db = Connection::open(&path).unwrap();
            crate::transcript_cache::materialize_all_rows(&reopened, "a", later)
                .await
                .unwrap();
            assert_eq!(
                crate::test_store::inspect_cache(&reopened, |db| rows(db, "a")).await,
                expected(&events, later)
            );

            assert_eq!(page(&reopened, unaccepted).await, unaccepted_page);
            assert_eq!(canonical_bytes(&db), canonical);
            drop(db);
            let before_terminal = page(&reopened, later).await;
            let through = end(
                &reopened,
                "a",
                if interrupted {
                    InvocationOutcome::Failed {
                        class: "provider".into(),
                        message: None,
                        model_failure: None,
                    }
                } else {
                    InvocationOutcome::Completed
                },
            )
            .await;
            let completed = page(&reopened, through).await;
            let final_text: Vec<_> = completed["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|chunk| chunk["finalOutput"] == true)
                .map(|chunk| chunk["text"].as_str().unwrap())
                .collect();
            assert_eq!(
                final_text,
                if interrupted {
                    vec![]
                } else {
                    vec!["accepted中😀", "Source: Ref\nhttps://example.test/ref"]
                }
            );
            assert_eq!(page(&reopened, later).await, before_terminal);
            reopened.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn accepted_observation_directory_survives_missing_optional_bodies_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cache.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let (cuts, _, events) = seed(&log, true, false).await;
    let old = cuts[0];
    let original = page(&log, old).await;
    crate::test_store::inspect_cache(&log, move |db| {
        db.execute_batch("DELETE FROM temp.transcript_text; DELETE FROM temp.transcript_rows")
            .unwrap()
    })
    .await;
    log.close().await.unwrap();
    let db = Connection::open(&path).unwrap();
    let canonical = canonical_bytes(&db);
    let metadata: i64 = db
        .query_row(
            "SELECT count(*) FROM transcript_directory WHERE session_id='a'",
            [],
            |r| r.get(0),
        )
        .unwrap();

    let reopened = EventLog::open(&path).await.unwrap();
    assert!(
        crate::test_store::inspect_cache(&reopened, |db| rows(db, "a"))
            .await
            .is_empty()
    );
    assert_eq!(page(&reopened, old).await, original);
    crate::transcript_cache::materialize_all_rows(&reopened, "a", old)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&reopened, |db| rows(db, "a")).await,
        expected(&events, old)
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM transcript_directory WHERE session_id='a'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        metadata
    );
    assert_eq!(canonical_bytes(&db), canonical);
    reopened.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(page(&reopened, old).await, original);
    assert_eq!(canonical_bytes(&db), canonical);
    reopened.close().await.unwrap();
}
