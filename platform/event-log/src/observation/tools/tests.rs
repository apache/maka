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
    event::{Fact, Invocation, LogScope, RuntimeEvent, StoredEvent, ToolOutcome},
    input::InvocationInput,
    tool_call::ToolCallIdentity,
};
use serde_json::{Value, json};
use sqlx::{Connection, SqliteConnection};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

async fn database() -> SqliteConnection {
    initialize(SqliteConnection::connect("sqlite::memory:").await.unwrap()).await
}

async fn initialize(mut db: SqliteConnection) -> SqliteConnection {
    crate::sqlite_functions::register(&mut db).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(crate::schema::fixture(|kind, _| {
        kind != "trigger"
    })))
    .execute(&mut db)
    .await
    .unwrap();
    crate::connection::control::initialize_views(&mut db, None)
        .await
        .unwrap();
    append(
        &mut db,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "original".into(),
                request_fingerprint: None,
            },
        },
    )
    .await;
    db
}

fn invocation() -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    }
}

// Isolate seed discovery and the real ingress reducers from admission policy.
async fn append(db: &mut SqliteConnection, fact: Fact) -> (u64, String) {
    let event = RuntimeEvent::new(invocation(), fact);
    let id = event.id.clone();
    let mut tx = db.begin().await.unwrap();
    let sequence = crate::connection::worker_query(&mut tx, move |worker| {
        Box::pin(async move {
            let json = serde_json::to_string(&event)?;
            let inserted = crate::canonical_insert::insert(crate::canonical_insert::Record {
                sequence: None,
                event_id: &event.id,
                invocation_id: Some(&event.invocation.invocation_id),
                kind: event.fact.kind(),
                operation_id: event.fact.operation_id(),
                json: &json,
            })
            .execute(&mut *worker)
            .await?;
            let sequence = crate::sequence_number(inserted.last_insert_rowid())?;
            let stored = StoredEvent { sequence, event };
            crate::model_items::record(worker, &stored).await?;
            crate::context::projection::record(worker, &stored, &json).await?;
            Ok(sequence)
        })
    })
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (sequence, id)
}

fn request(step: &str, acceptance: bool, purpose: &str) -> Fact {
    serde_json::from_value(json!({"kind":"model_requested","step_id":step,"model_id":"test",
        "item_acceptance":acceptance,"purpose":purpose,
        "source_scope":serde_json::to_value(LogScope::Session{id:"session".into()}).unwrap(),
        "source_high_water":0,"source_digest":"fixture","input_digest":"fixture","route_identity":"fixture"})).unwrap()
}

fn call(id: &str, provider: bool) -> Value {
    json!({"kind":"tool_call","call":{"id":id,"name":"Read",
        "input":{"kind":"json","data":{"limit":3}},"provider_executed":provider}})
}

fn record(step: &str, ordinal: u64, part: Value) -> Value {
    let message_id = if part["kind"] == "tool_call" {
        maka_agent_facts::tool_call::tool_use_id(
            "invocation",
            &format!("{step}:{}", part["call"]["id"].as_str().unwrap()),
        )
    } else {
        uuid::Uuid::now_v7().to_string()
    };
    json!({"ordinal":ordinal,"message_id":message_id,"started_at":std::time::UNIX_EPOCH,
        "provider_part_id":null,"part":part})
}

fn observed(step: &str, ordinal: u64, part: Value) -> Fact {
    serde_json::from_value(json!({"kind":"model_observed","step_id":step,
        "event":{"kind":"part","data":record(step,ordinal,part)}}))
    .unwrap()
}

fn complete(step: &str, parts: Vec<Value>) -> Fact {
    serde_json::from_value(json!({"kind":"model_completed","step_id":step,
        "output":{"parts":parts,"finish_reason":"tool-calls","usage":{}}}))
    .unwrap()
}

fn interrupted(step: &str) -> Fact {
    serde_json::from_value(json!({"kind":"model_interrupted","step_id":step,"status":"failed"}))
        .unwrap()
}

fn dispatch(operation: &str) -> Fact {
    Fact::ToolDispatched {
        operation_id: operation.into(),
        call: ToolCallIdentity::standalone(operation.to_owned()),
        name: "Read".into(),
        input: json!({"limit":3}),
        presentation: None,
        title: None,
    }
}

fn settle(operation: &str) -> Fact {
    Fact::ToolSettled {
        operation_id: operation.into(),
        outcome: ToolOutcome::Failed {
            message: "done".into(),
        },
    }
}

async fn seeds(db: &mut SqliteConnection) -> Vec<(u64, String)> {
    measured(db)
        .await
        .0
        .into_iter()
        .map(|seed| (seed.start_sequence, seed.tool_use_id))
        .collect()
}

async fn measured(db: &mut SqliteConnection) -> (Vec<ToolStreamSeed>, usize) {
    let root = crate::turns::read(db, "session", None)
        .await
        .unwrap()
        .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    db.lock_handle()
        .await
        .unwrap()
        .set_progress_handler(1, move || {
            observed.fetch_add(1, Ordering::Relaxed);
            true
        });
    let result = read(db, Some(&root)).await;
    db.lock_handle().await.unwrap().remove_progress_handler();
    (result.unwrap(), count.load(Ordering::Relaxed))
}

fn expected(sequence: u64, operation: &str) -> (u64, String) {
    (
        sequence,
        maka_agent_facts::tool_call::tool_use_id("invocation", operation),
    )
}

async fn settled_round(db: &mut SqliteConnection, index: usize) {
    let step = format!("history-{index}");
    let operation = format!("{step}:call");
    append(db, request(&step, false, "main")).await;
    append(
        db,
        complete(
            &step,
            vec![json!({"kind":"own","data":record(&step,0,call("call",false))})],
        ),
    )
    .await;
    append(db, dispatch(&operation)).await;
    append(db, settle(&operation)).await;
}

#[tokio::test]
async fn settled_same_run_history_does_not_grow_active_seed_work() {
    let mut samples = Vec::new();
    for history in [20, 220] {
        let mut db = database().await;
        for index in 0..history {
            settled_round(&mut db, index).await;
        }
        append(&mut db, request("pending:step", true, "main")).await;
        let (start, _) = append(
            &mut db,
            observed("pending:step", 0, call("tiny:call", false)),
        )
        .await;
        let (native, _) = append(&mut db, dispatch("native:pending")).await;
        let (actual, steps) = measured(&mut db).await;
        assert_eq!(
            actual,
            vec![
                ToolStreamSeed {
                    start_sequence: start,
                    tool_use_id: expected(start, "pending:step:tiny:call").1
                },
                ToolStreamSeed {
                    start_sequence: native,
                    tool_use_id: expected(native, "native:pending").1
                },
            ]
        );
        assert!(steps > 0, "VM counting must cover the actual seed read");
        samples.push(steps);
    }
    assert!(
        samples[1] < samples[0] * 2,
        "same two active seeds must not sweep 11 times more settled rounds: {samples:?}"
    );
}

#[tokio::test]
async fn approval_replay_keeps_original_call_across_step_end_dispatch_and_interruption() {
    let directory = tempfile::tempdir().unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(directory.path().join("seeds.sqlite"))
        .create_if_missing(true);
    let mut db = initialize(SqliteConnection::connect_with(&options).await.unwrap()).await;
    append(&mut db, request("approval:step", true, "main")).await;
    let (start, id) = append(
        &mut db,
        observed("approval:step", 0, call("call:original", false)),
    )
    .await;
    let operation = "approval:step:call:original";
    assert_eq!(seeds(&mut db).await, vec![expected(start, operation)]);
    let (ended, _) = append(
        &mut db,
        complete(
            "approval:step",
            vec![json!({"kind":"ref","data":{"event_id":id,"ordinal":0}})],
        ),
    )
    .await;
    let (dispatched, _) = append(&mut db, dispatch(operation)).await;
    assert_eq!(seeds(&mut db).await, vec![expected(start, operation)]);
    db.close().await.unwrap();
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    crate::sqlite_functions::register(&mut db).await.unwrap();
    crate::connection::control::initialize_views(&mut db, None)
        .await
        .unwrap();
    assert_eq!(seeds(&mut db).await, vec![expected(start, operation)]);
    let replay:Vec<(i64,String)>=sqlx::query_as("SELECT sequence,kind FROM runtime_events WHERE sequence>? AND sequence<=? ORDER BY sequence")
        .bind((start-1) as i64).bind(dispatched as i64).fetch_all(&mut db).await.unwrap();
    assert_eq!(
        replay,
        vec![
            (start as i64, "model_observed".into()),
            (ended as i64, "model_completed".into()),
            (dispatched as i64, "tool_dispatched".into())
        ]
    );
    append(&mut db, settle(operation)).await;
    assert_eq!(seeds(&mut db).await, vec![]);

    append(&mut db, request("interrupted", true, "main")).await;
    append(
        &mut db,
        observed("interrupted", 0, call("never-dispatched", false)),
    )
    .await;
    let (pending, _) = append(
        &mut db,
        observed("interrupted", 1, call("dispatched", false)),
    )
    .await;
    append(&mut db, dispatch("interrupted:dispatched")).await;
    append(&mut db, interrupted("interrupted")).await;
    assert_eq!(
        seeds(&mut db).await,
        vec![expected(pending, "interrupted:dispatched")]
    );
}

#[tokio::test]
async fn native_nested_and_rejected_tools_keep_their_original_seeds() {
    use maka_agent_facts::tool_call::{ToolOrigin, ToolRejection};
    let mut db = database().await;
    let mut native = dispatch("host:sdk");
    let Fact::ToolDispatched { call: identity, .. } = &mut native else {
        unreachable!()
    };
    identity.origin = ToolOrigin::HostSdk {
        package_id: "package".into(),
        entry_id: "entry".into(),
        activation: "activation".into(),
        parent: None,
    };
    let (host, _) = append(&mut db, native).await;
    let mut cell = dispatch("cell:child");
    let Fact::ToolDispatched { call: identity, .. } = &mut cell else {
        unreachable!()
    };
    identity.origin = ToolOrigin::CodeCell {
        parent_operation_id: "host:sdk".into(),
        parent_tool_call_id: "host:sdk".into(),
    };
    let (child, _) = append(&mut db, cell).await;
    append(&mut db, request("rejected", true, "main")).await;
    append(&mut db, observed("rejected", 0, call("call", false))).await;
    append(
        &mut db,
        Fact::ToolRejected {
            operation_id: "rejected:call".into(),
            call: ToolCallIdentity::standalone("call".into()),
            name: "Read".into(),
            input: serde_json::from_value(json!({"kind":"json","data":{}})).unwrap(),
            reason: ToolRejection::Unavailable,
        },
    )
    .await;
    assert_eq!(
        seeds(&mut db).await,
        vec![expected(host, "host:sdk"), expected(child, "cell:child")]
    );
    append(&mut db, settle("cell:child")).await;
    assert_eq!(seeds(&mut db).await, vec![expected(host, "host:sdk")]);
}
