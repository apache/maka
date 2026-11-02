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

struct Seed {
    through: u64,
    expected: Vec<fixtures::Row>,
    operations: Vec<(u64, u64)>,
}

async fn seed(log: &EventLog) -> Seed {
    let opening = log.append(&event("a", opening())).await.unwrap();
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
    let completion = log
        .append(&event(
            "a",
            Fact::ModelCompleted {
                step_id: "step-a".into(),
                output: ModelCompletion {
                    parts: completion_parts(
                        "step-a".into(),
                        calls
                            .into_iter()
                            .map(|call| ModelPart::ToolCall { call })
                            .collect(),
                    ),
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
    let mut operations = Vec::new();
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
        let dispatched_sequence = log.append(&dispatched).await.unwrap();
        let succeeded = EventWrite::tool_success(
            format!("result-{index}"),
            dispatched.event().recorded_at,
            dispatched.event().invocation.clone(),
            format!("step-a:call-{index}"),
            serde_json::json!({"literal":format!("result-{index}中😀")}).into(),
        )
        .unwrap()
        .0;
        let settled_sequence = log.append(&succeeded).await.unwrap();
        operations.push((dispatched_sequence, settled_sequence));
    }
    let through = end(log, "a", InvocationOutcome::Completed).await;
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
    let mut positions = vec![(opening, 0), (opening, 1), (completion, 0), (completion, 1)];
    positions.extend(
        operations
            .iter()
            .flat_map(|&(dispatched, settled)| [(dispatched, 0), (settled, 0)]),
    );
    positions.push((through, 0));
    assert_eq!(
        expected
            .iter()
            .map(|row| (row.0.source_sequence, row.0.item_index))
            .collect::<Vec<_>>(),
        positions,
    );
    for (index, &(_, sequence)) in operations.iter().enumerate() {
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
    Seed {
        through,
        expected,
        operations,
    }
}

#[tokio::test]
async fn selected_raw_damage_and_cached_identity_conflict_are_not_repaired() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let Seed {
        through,
        expected,
        operations,
    } = seed(&log).await;
    let earlier_fence = operations[0].0;
    let damaged_source = operations[1].1;
    let canonical = log.prefix(64, 1_000_000).await.unwrap().digest;
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
    crate::transcript_cache::materialize_all_rows(&log, "a", earlier_fence)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        expected
            .iter()
            .filter(|row| row.0.source_sequence <= earlier_fence)
            .cloned()
            .collect::<Vec<_>>()
    );
    let before = crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await;
    let expected_failure = format!(
        "history source {damaged_source}: raw_binding: missing or inconsistent durable tool payload"
    );
    assert!(matches!(
        crate::transcript_cache::materialize_all_rows(&log, "a", through).await,
        Err(StoreError::InvalidTransition(message)) if message == expected_failure
    ));
    crate::test_store::inspect_cache(&log, move |db| {
        let failure: (i64, String, String) = db.query_row(
            "SELECT source_sequence,category,reason FROM temp.transcript_failures WHERE session_id='a'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(failure, (damaged_source as i64, "raw_binding".into(), "missing or inconsistent durable tool payload".into()));
        assert_eq!(db.query_row(
            "SELECT count(*) FROM temp.transcript_directory WHERE session_id='a' AND source_sequence=?",
            [damaged_source as i64], |row| row.get::<_, i64>(0),
        ).unwrap(), 0);
    }).await;
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        before,
        "failed full header batch must not publish body rows"
    );
    db.execute(
        "UPDATE tool_result_payloads SET payload=? WHERE event_id='result-1'",
        [raw],
    )
    .unwrap();
    assert!(matches!(
        crate::transcript_cache::materialize_all_rows(&log, "a", through).await,
        Err(StoreError::InvalidTransition(message)) if message == expected_failure
    ));
    crate::transcript_cache::materialize_all_rows(&log, "a", earlier_fence)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        before
    );
    // External repair does not silently invalidate a cached immutable-source failure.
    // Reopening explicitly discards the disposable cache before rebuilding it.
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    crate::transcript_cache::materialize_all_rows(&log, "a", through)
        .await
        .unwrap();
    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        expected
    );
    crate::test_store::inspect_cache(&log, move |db| {
        db.execute(
            "UPDATE temp.transcript_rows SET turn_id='wrong-turn' WHERE source_sequence=?",
            [i64::try_from(damaged_source).unwrap()],
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
    assert_eq!(log.prefix(64, 1_000_000).await.unwrap().digest, canonical);
    log.close().await.unwrap();
}
