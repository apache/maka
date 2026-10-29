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

//! An interrupted producer and a later step retain their separate selected evidence.
use super::*;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::tool_call::ToolCallIdentity;

#[tokio::test]
async fn interrupted_streaming_tool_ancestry_and_later_model_step_replay_exactly() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.append(&event("a", opening())).await.unwrap();
    let source = log.prefix(16, 16_384).await.unwrap();
    let mut first = request("a");
    let Fact::ModelRequested {
        item_acceptance,
        source_scope,
        source_high_water,
        source_digest,
        ..
    } = &mut first
    else {
        unreachable!()
    };
    *item_acceptance = true;
    *source_scope = source.scope;
    *source_high_water = source.high_water;
    *source_digest = source.digest;
    log.append(&event("a", first)).await.unwrap();
    log.append(&event(
        "a",
        observe(
            "a",
            tool_observation(
                &format!("step-{}", "a"),
                ModelToolCall {
                    id: "call".into(),
                    name: "Read".into(),
                    input: serde_json::json!({}).into(),
                    provider_options: None,
                    provider_executed: false,
                },
            ),
        ),
    ))
    .await
    .unwrap();
    log.append(&event(
        "a",
        Fact::ToolDispatched {
            operation_id: "step-a:call".into(),
            call: ToolCallIdentity::provider("step-a".into(), "call".into()),
            name: "Read".into(),
            input: serde_json::json!({}),
            title: None,
            presentation: None,
        },
    ))
    .await
    .unwrap();
    let cut = log
        .append(&event(
            "a",
            Fact::ModelInterrupted {
                partial: None,
                step_id: "step-a".into(),
                status: ModelInterruption::RetryableFailure,
                diagnostic: None,
                model_failure: None,
            },
        ))
        .await
        .unwrap();
    // Commit progress beyond the interruption so the next batch does not
    // independently select it. The next batch still needs the old tool ancestry.
    crate::transcript_cache::materialize_all_rows(&log, "a", cut)
        .await
        .unwrap();
    let db = Connection::open(&path).unwrap();

    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a"))
            .await
            .len(),
        4
    );

    // The ordinary Message main-request append contract permits this order.
    // Current engine direct-tool cleanup is stricter; this test covers the log.
    let source = log.prefix(16, 16_384).await.unwrap();
    let mut next = request("retry");
    let Fact::ModelRequested {
        source_scope,
        source_high_water,
        source_digest,
        ..
    } = &mut next
    else {
        unreachable!()
    };
    *source_scope = source.scope;
    *source_high_water = source.high_water;
    *source_digest = source.digest;
    log.append(&event("a", next)).await.unwrap();
    log.append(&event(
        "a",
        Fact::ModelObserved {
            step_id: "step-retry".into(),
            event: ModelObservation::Finished {
                reason: maka_agent_facts::model::ModelFinishReason::Stop,
                usage: ModelUsage::default(),
                provider_options: None,
            },
        },
    ))
    .await
    .unwrap();
    log.append(&event(
        "a",
        Fact::ModelCompleted {
            step_id: "step-retry".into(),
            output: ModelCompletion {
                parts: completion_parts("step-retry".into(), Vec::new()),
                finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
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
    log.append(&event(
        "a",
        Fact::ToolSettled {
            operation_id: "step-a:call".into(),
            outcome: ToolOutcome::Failed {
                message: "fixture failure".into(),
            },
        },
    ))
    .await
    .unwrap();
    let through = end(&log, "a", InvocationOutcome::Completed).await;
    assert_eq!(through, 10);

    // A full canonical forward replay has the interruption and is valid.
    // Compare original position, exact bytes, digest and size, not only count.
    let prefix = log.prefix(16, 16_384).await.unwrap();
    let mut view = maka_presentation::InvocationView::new();
    let expected: Vec<fixtures::Row> = prefix
        .events
        .iter()
        .flat_map(|stored| view.push(stored).unwrap())
        .map(|row| {
            let bytes = serde_json::to_vec(&row.message).unwrap();
            let digest = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
            let size = bytes.len() as i64;
            (row.position, bytes, digest, size)
        })
        .collect();
    assert_eq!(expected.len(), 6);
    let prepared = crate::transcript_cache::materialize_all_rows(&log, "a", through).await;
    prepared.expect("append-accepted evidence must preserve the selected-boundary contract");

    assert_eq!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a")).await,
        expected
    );
    drop(db);
    log.close().await.unwrap();
}
