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
use rusqlite::{Connection, StatementStatus, params};
use serde_json::json;

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE event_log (
        sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
        invocation_id TEXT NOT NULL, kind TEXT NOT NULL, operation_id TEXT,
        event_json TEXT NOT NULL,
        event_session TEXT GENERATED ALWAYS AS (json_extract(event_json,'$.invocation.session_id')) STORED
    );
    CREATE INDEX invocation_kind ON event_log(invocation_id,kind,operation_id);
    CREATE VIEW runtime_events AS SELECT * FROM event_log;
    CREATE TABLE imported_invocations(invocation_id TEXT PRIMARY KEY);
    CREATE VIEW local_runtime_events AS SELECT * FROM runtime_events e
        WHERE NOT EXISTS(SELECT 1 FROM imported_invocations i WHERE i.invocation_id=e.invocation_id);").unwrap();
    db.execute_batch(&crate::schema::fixture(|_, name| {
        name.starts_with("context_obligations") || name.starts_with("context_safety_")
    }))
    .unwrap();
    db
}

fn append(
    db: &Connection,
    invocation: &str,
    kind: &str,
    operation: Option<&str>,
    fact: serde_json::Value,
) {
    let body = json!({"invocation":{"session_id":"session","turn_id":"turn","run_id":"run","invocation_id":invocation},"fact":fact});
    db.execute(
        "INSERT INTO event_log(event_id,invocation_id,kind,operation_id,event_json)
        VALUES(lower(hex(randomblob(16))),?,?,?,?)",
        params![invocation, kind, operation, body.to_string()],
    )
    .unwrap();
}

fn work(db: &Connection, sql: &str, parameter: &dyn rusqlite::ToSql) -> (usize, i32) {
    let mut statement = db.prepare(sql).unwrap();
    let parameters: Vec<&dyn rusqlite::ToSql> = if sql == UNFINISHED_INVOCATIONS {
        vec![&0i64, parameter]
    } else {
        vec![parameter]
    };
    let count = statement
        .query_map(parameters.as_slice(), |_| Ok(()))
        .unwrap()
        .count();
    (count, statement.get_status(StatementStatus::VmStep))
}

#[test]
fn recovery_work_depends_on_unfinished_work_not_completed_history() {
    let db = database();
    append(&db, "forever", "invocation_opened", None, json!({}));
    let query = unresolved!(" SELECT kind,id,name,input,call FROM unresolved");
    let mut short = None;
    for n in 0..10_000 {
        let id = format!("old-{n}");
        append(&db, &id, "invocation_opened", None, json!({}));
        append(
            &db,
            &id,
            "invocation_ended",
            None,
            json!({"outcome":{"class":"completed"}}),
        );
        append(
            &db,
            "forever",
            "model_requested",
            Some(&id),
            json!({"item_acceptance":false}),
        );
        append(
            &db,
            "forever",
            "model_completed",
            Some(&id),
            json!({"output":{"parts":[]}}),
        );
        if n == 99 {
            short = Some((
                work(&db, UNFINISHED_INVOCATIONS, &16),
                work(&db, query, &"forever"),
            ));
        }
    }
    let (startup, active) = short.unwrap();
    let long_startup = work(&db, UNFINISHED_INVOCATIONS, &16);
    let long_active = work(&db, query, &"forever");
    assert_eq!(startup.0, 1);
    assert_eq!(long_startup.0, 1);
    assert_eq!(active.0, 0);
    assert_eq!(long_active.0, 0);
    assert!(
        long_startup.1 <= startup.1 + 32,
        "startup work {startup:?} -> {long_startup:?}"
    );
    assert!(
        long_active.1 <= active.1 + 32,
        "active run work {active:?} -> {long_active:?}"
    );
    db.execute("INSERT INTO imported_invocations VALUES('forever')", [])
        .unwrap();
    assert_eq!(work(&db, UNFINISHED_INVOCATIONS, &16).0, 0);
}

#[test]
fn pending_call_recovery_preserves_accepted_input_and_unknown_effects() {
    let db = database();
    append(&db, "run", "invocation_opened", None, json!({}));
    append(
        &db,
        "run",
        "model_requested",
        Some("step"),
        json!({"item_acceptance":false}),
    );
    append(
        &db,
        "run",
        "model_completed",
        Some("step"),
        json!({"output":{"parts":[
            {"kind":"tool_call","call":{"id":"call","name":"read","input":{"kind":"malformed","raw":"{"},"provider_executed":false}}
        ]}}),
    );
    let query = unresolved!(" SELECT kind,id,name,input,call FROM unresolved ORDER BY kind,id");
    let row: (i64, String, String, String, String) = db
        .query_row(query, ["run"], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap();
    assert_eq!(
        (row.0, row.1.as_str(), row.2.as_str()),
        (2, "step:call", "read")
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&row.3).unwrap(),
        json!({"kind":"malformed","raw":"{"})
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&row.4).unwrap(),
        json!({"tool_call_id":"call","origin":{"kind":"provider","step_id":"step"}})
    );
    append(&db, "run", "tool_dispatched", Some("step:call"), json!({}));
    append(
        &db,
        "run",
        "invocation_ended",
        None,
        json!({"outcome":{"class":"outcome_unknown"}}),
    );
    let pending: (i64, String) = db
        .query_row(query, ["run"], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(pending, (1, "step:call".into()));
    append(&db, "run", "tool_settled", Some("step:call"), json!({}));
    assert_eq!(work(&db, query, &"run").0, 0);
}

#[path = "pagination_tests.rs"]
mod pagination;
