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

//! Compare selected producer reconstruction with the original full canonical replay.
use super::*;
use maka_agent_facts::{
    event::{EventWrite, ToolOutcome},
    model::{ModelFinishReason, ModelToolCall},
    tool_call::ToolCallIdentity,
};

async fn seed(log: &EventLog) -> (u64, Vec<fixtures::Row>) {
    log.append(&event("a", opening())).await.unwrap();
    log.append(&event("a", request("a"))).await.unwrap();
    let calls: Vec<_> = (0..2)
        .map(|index| ModelToolCall {
            id: format!("call-{index}"),
            name: "Read".into(),
            input: serde_json::json!({"index":index}).into(),
            provider_options: None,
            provider_executed: false,
        })
        .collect();
    for call in &calls {
        log.append(&event(
            "a",
            observe("a", ModelEvent::ToolCall(call.clone())),
        ))
        .await
        .unwrap();
    }
    let completion = log
        .append(&event(
            "a",
            Fact::ModelCompleted {
                step_id: "step-a".into(),
                output: ModelStep {
                    parts: calls
                        .into_iter()
                        .map(|call| ModelPart::ToolCall { call })
                        .collect(),
                    finish_reason: ModelFinishReason::ToolCalls,
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
    assert_eq!(completion, 5);
    for index in 0..2 {
        let dispatched = event(
            "a",
            Fact::ToolDispatched {
                operation_id: format!("step-a:call-{index}"),
                call: ToolCallIdentity::provider("step-a".into(), format!("call-{index}")),
                name: "Read".into(),
                input: serde_json::json!({"index":index}),
                title: None,
                presentation: None,
            },
        );
        log.append(&dispatched).await.unwrap();
        let succeeded = EventWrite::tool_success(
            format!("result-{index}"),
            dispatched.event().recorded_at,
            dispatched.event().invocation.clone(),
            format!("step-a:call-{index}"),
            serde_json::json!({"literal":format!("result-{index}中😀")}).into(),
        )
        .unwrap()
        .0;
        log.append(&succeeded).await.unwrap();
    }
    let through = end(log, "a", InvocationOutcome::Completed).await;
    assert_eq!(through, 10);
    // Independent full canonical replay: no boundary selector or prefix algorithm.
    let canonical = log.prefix(64, 1_000_000).await.unwrap();
    let mut view = maka_presentation::InvocationView::new();
    let mut expected = Vec::new();
    for fact in &canonical.events {
        let resolved = if matches!(
            fact.event.fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Succeeded { .. },
                ..
            }
        ) {
            Some(log.resolve_tool_result("a", &fact.event.id).await.unwrap())
        } else {
            None
        };
        for row in view.push_with_tool_output(fact, resolved.as_ref()).unwrap() {
            let bytes = serde_json::to_vec(&row.message).unwrap();
            let digest = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
            let size = bytes.len() as i64;
            expected.push((row.position, bytes, digest, size));
        }
    }
    assert_eq!(
        expected
            .iter()
            .map(|row| (row.0.source_sequence, row.0.item_index))
            .collect::<Vec<_>>(),
        [
            (1, 0),
            (1, 1),
            (5, 0),
            (5, 1),
            (6, 0),
            (7, 0),
            (8, 0),
            (9, 0),
            (10, 0)
        ]
    );
    for (sequence, index) in [(7, 0), (9, 1)] {
        let bytes = &expected
            .iter()
            .find(|row| row.0.source_sequence == sequence)
            .unwrap()
            .1;
        let value: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(
            value["content"]["value"]["literal"],
            format!("result-{index}中😀")
        );
    }
    (through, expected)
}

#[tokio::test]
async fn sibling_sources_match_full_canonical_replay_with_empty_cache_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let (through, expected) = seed(&log).await;
    assert!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a"))
            .await
            .is_empty()
    );
    crate::transcript_cache::materialize_all_rows(&log, "a", through)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        expected
    );
    let canonical = log.prefix(32, 65536).await.unwrap().digest;
    crate::test_store::inspect_cache(&log, move |db| {
        db.execute_batch("DELETE FROM temp.transcript_text; DELETE FROM temp.transcript_rows")
            .unwrap()
    })
    .await;
    log.close().await.unwrap();

    let reopened = EventLog::open(&path).await.unwrap();
    assert!(
        crate::test_store::inspect_cache(&reopened, |db| rows(db, "a"))
            .await
            .is_empty()
    );
    crate::transcript_cache::materialize_all_rows(&reopened, "a", through)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&reopened, |db| rows(db, "a")).await,
        expected
    );
    assert_eq!(reopened.prefix(32, 65536).await.unwrap().digest, canonical);
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn selected_raw_damage_and_cached_identity_conflict_are_not_repaired() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let (through, expected) = seed(&log).await;
    let db = Connection::open(&path).unwrap();
    let raw: Vec<u8> = db
        .query_row(
            "SELECT payload FROM tool_result_payloads WHERE event_id='result-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    db.execute("UPDATE tool_result_payloads SET payload=zeroblob(length(payload)) WHERE event_id='result-1'",[]).unwrap();
    // An earlier fence excludes the damaged later source and remains readable.
    crate::transcript_cache::materialize_all_rows(&log, "a", 6)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        expected[..5]
    );
    let before = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
    assert!(
        matches!(crate::transcript_cache::materialize_all_rows(&log,"a",through).await,
        Err(StoreError::InvalidTransition(message)) if message=="missing or inconsistent durable tool payload")
    );
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        before,
        "failed full header batch must roll back its new rows"
    );
    db.execute(
        "UPDATE tool_result_payloads SET payload=? WHERE event_id='result-1'",
        [raw],
    )
    .unwrap();
    crate::transcript_cache::materialize_all_rows(&log, "a", through)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        expected
    );
    crate::test_store::inspect_cache(&log, move |db| {
        db.execute(
            "UPDATE temp.transcript_rows SET turn_id='wrong-turn' WHERE source_sequence=9",
            [],
        )
        .unwrap()
    })
    .await;
    let damaged = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
    assert!(matches!(
        crate::transcript_cache::materialize_all_rows(&log, "a", through).await,
        Err(StoreError::TranscriptConflict)
    ));
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        damaged
    );
    log.close().await.unwrap();
}
