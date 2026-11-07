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
    context::ModelPurpose,
    event::{Fact, Invocation, LogScope, RuntimeEvent, SourceCapture, StoredEvent, ToolOutcome},
    input::InvocationInput,
    tool_call::ToolCallIdentity,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn database() -> rusqlite::Connection {
    initialize(rusqlite::Connection::open_in_memory().unwrap())
}

fn initialize(db: rusqlite::Connection) -> rusqlite::Connection {
    crate::sqlite_functions::register(&db).unwrap();
    db.execute_batch(&crate::schema::fixture(|kind, _| kind != "trigger"))
        .unwrap();
    append(
        &db,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "original".into(),
                request_fingerprint: None,
            },
        },
    );
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
fn append(db: &rusqlite::Connection, fact: Fact) -> (u64, String) {
    let event = RuntimeEvent::new(invocation(), fact);
    let id = event.id.clone();
    let tx =
        rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Deferred).unwrap();
    let json = serde_json::to_string(&event).unwrap();
    crate::canonical_insert::insert(
        &tx,
        crate::canonical_insert::Record {
            sequence: None,
            event_id: &event.id,
            invocation_id: Some(&event.invocation.invocation_id),
            kind: event.fact.kind(),
            operation_id: event.fact.operation_id(),
            json: &json,
        },
    )
    .unwrap();
    let sequence = crate::sequence_number(tx.last_insert_rowid()).unwrap();
    let stored = StoredEvent { sequence, event };
    crate::model_items::record(&tx, &stored).unwrap();
    crate::context::projection::record(&tx, &stored, &json).unwrap();
    tx.commit().unwrap();
    (sequence, id)
}

fn request(step: &str, acceptance: bool) -> Fact {
    Fact::ModelRequested {
        source_capture: SourceCapture {
            publication_watermark: 0,
            prior_unknown: false,
        },
        context_breakdown: None,
        item_acceptance: acceptance,
        purpose: ModelPurpose::Main,
        context: None,
        checkpoint_event_id: None,
        step_id: step.into(),
        model_id: "test".into(),
        source_scope: LogScope::Session {
            id: "session".into(),
        },
        source_high_water: 0,
        source_digest: "fixture".into(),
        effective_source_digest: None,
        input_digest: "fixture".into(),
        route_identity: "fixture".into(),
    }
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

fn seeds(db: &rusqlite::Connection) -> Vec<(u64, String)> {
    let root = crate::turns::read(db, "session", None).unwrap().unwrap();
    read(db, Some(&root))
        .unwrap()
        .into_iter()
        .map(|seed| (seed.start_sequence, seed.tool_use_id))
        .collect()
}

fn measured(db: &mut rusqlite::Connection) -> (Vec<ToolStreamSeed>, usize) {
    let root = crate::turns::read(db, "session", None).unwrap().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    db.progress_handler(
        1,
        Some(move || {
            observed.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )
    .unwrap();
    let result = read(db, Some(&root));
    db.progress_handler(0, None::<fn() -> bool>).unwrap();
    (result.unwrap(), count.load(Ordering::Relaxed))
}

fn expected(sequence: u64, operation: &str) -> (u64, String) {
    (
        sequence,
        maka_agent_facts::tool_call::tool_use_id("invocation", operation),
    )
}

fn settled_round(db: &rusqlite::Connection, index: usize) {
    let step = format!("history-{index}");
    let operation = format!("{step}:call");
    append(db, request(&step, false));
    append(
        db,
        complete(
            &step,
            vec![json!({"kind":"own","data":record(&step,0,call("call",false))})],
        ),
    );
    append(db, dispatch(&operation));
    append(db, settle(&operation));
}

#[test]
fn settled_same_run_history_does_not_grow_active_seed_work() {
    let mut samples = Vec::new();
    for history in [20, 220] {
        let mut db = database();
        for index in 0..history {
            settled_round(&db, index);
        }
        append(&db, request("pending:step", true));
        let (start, _) = append(&db, observed("pending:step", 0, call("tiny:call", false)));
        let (native, _) = append(&db, dispatch("native:pending"));
        let (actual, steps) = measured(&mut db);
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

#[test]
fn approval_replay_keeps_original_call_across_step_end_dispatch_and_interruption() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("seeds.sqlite");
    let db = initialize(rusqlite::Connection::open(&path).unwrap());
    append(&db, request("approval:step", true));
    let (start, id) = append(
        &db,
        observed("approval:step", 0, call("call:original", false)),
    );
    let operation = "approval:step:call:original";
    assert_eq!(seeds(&db), vec![expected(start, operation)]);
    let (ended, _) = append(
        &db,
        complete(
            "approval:step",
            vec![json!({"kind":"ref","data":{"event_id":id,"ordinal":0}})],
        ),
    );
    let (dispatched, _) = append(&db, dispatch(operation));
    assert_eq!(seeds(&db), vec![expected(start, operation)]);
    db.close().unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    crate::sqlite_functions::register(&db).unwrap();
    assert_eq!(seeds(&db), vec![expected(start, operation)]);
    let replay:Vec<(i64,String)>=db.prepare_cached("SELECT sequence,kind FROM runtime_events WHERE sequence>? AND sequence<=? ORDER BY sequence").unwrap().query_map(rusqlite::params![(start-1) as i64,dispatched as i64], |row| Ok((row.get(0)?,row.get(1)?,))).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(
        replay,
        vec![
            (start as i64, "model_observed".into()),
            (ended as i64, "model_completed".into()),
            (dispatched as i64, "tool_dispatched".into())
        ]
    );
    append(&db, settle(operation));
    assert_eq!(seeds(&db), vec![]);

    append(&db, request("interrupted", true));
    append(
        &db,
        observed("interrupted", 0, call("never-dispatched", false)),
    );
    let (pending, _) = append(&db, observed("interrupted", 1, call("dispatched", false)));
    append(&db, dispatch("interrupted:dispatched"));
    append(&db, interrupted("interrupted"));
    assert_eq!(
        seeds(&db),
        vec![expected(pending, "interrupted:dispatched")]
    );
}

#[test]
fn native_nested_and_rejected_tools_keep_their_original_seeds() {
    use maka_agent_facts::tool_call::{ToolOrigin, ToolRejection};
    let db = database();
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
    let (host, _) = append(&db, native);
    let mut cell = dispatch("cell:child");
    let Fact::ToolDispatched { call: identity, .. } = &mut cell else {
        unreachable!()
    };
    identity.origin = ToolOrigin::CodeCell {
        parent_operation_id: "host:sdk".into(),
        parent_tool_call_id: "host:sdk".into(),
    };
    let (child, _) = append(&db, cell);
    append(&db, request("rejected", true));
    append(&db, observed("rejected", 0, call("call", false)));
    append(
        &db,
        Fact::ToolRejected {
            operation_id: "rejected:call".into(),
            call: ToolCallIdentity::standalone("call".into()),
            name: "Read".into(),
            input: serde_json::from_value(json!({"kind":"json","data":{}})).unwrap(),
            reason: ToolRejection::Unavailable,
        },
    );
    assert_eq!(
        seeds(&db),
        vec![expected(host, "host:sdk"), expected(child, "cell:child")]
    );
    append(&db, settle("cell:child"));
    assert_eq!(seeds(&db), vec![expected(host, "host:sdk")]);
}
