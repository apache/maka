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
    event::{
        Fact, InvocationInput, InvocationOutcome, LogScope, RuntimeEvent, StoredEvent, ToolOutcome,
    },
    model::{ModelFinishReason, ModelPart, ModelStep, ModelToolCall},
    tool_call::{ToolCallIdentity, ToolOrigin},
};
use rusqlite::{Connection as RawConnection, StatementStatus};
use serde_json::json;

async fn database() -> SqliteConnection {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql("CREATE TABLE event_log (
        sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
        invocation_id TEXT NOT NULL, kind TEXT NOT NULL, operation_id TEXT,
        event_json TEXT NOT NULL,
        accounting_at REAL,
        accounting_usage TEXT,
        invocation_model TEXT,
        accounting_tool TEXT,
        event_session TEXT
    );
    CREATE INDEX invocation_kind ON event_log(invocation_id,kind,operation_id);
    CREATE VIEW runtime_events AS SELECT * FROM event_log;
    CREATE TABLE imported_invocations(invocation_id TEXT PRIMARY KEY);
    CREATE VIEW local_runtime_events AS SELECT * FROM runtime_events e
        WHERE NOT EXISTS(SELECT 1 FROM imported_invocations i WHERE i.invocation_id=e.invocation_id);")
        .execute(&mut db).await.unwrap();
    let schema = crate::schema::fixture(|_, name| {
        [
            "context_obligations",
            "context_safety_",
            "context_execution_",
            "context_independent_",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    });
    sqlx::raw_sql(sqlx::AssertSqlSafe(schema))
        .execute(&mut db)
        .await
        .unwrap();
    db
}

fn opening() -> Fact {
    Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Message {
            source_messages: vec![],
            content: "fixture".into(),
            request_fingerprint: None,
        },
    }
}

fn ended(class: &str) -> Fact {
    Fact::InvocationEnded {
        outcome: if class == "completed" {
            InvocationOutcome::Completed
        } else {
            InvocationOutcome::Failed {
                class: class.into(),
                message: None,
                model_failure: None,
            }
        },
    }
}

fn requested(step: &str) -> Fact {
    Fact::ModelRequested {
        step_id: step.into(),
        model_id: "fixture".into(),
        item_acceptance: false,
        purpose: ModelPurpose::Main,
        source_scope: LogScope::Session {
            id: "session".into(),
        },
        source_high_water: 0,
        source_digest: "fixture".into(),
        input_digest: "fixture".into(),
        route_identity: format!("sha256:{}", "0".repeat(64)),
        checkpoint_event_id: None,
        context: None,
        context_breakdown: None,
        effective_source_digest: None,
    }
}

fn completed(step: &str, parts: Vec<ModelPart>) -> Fact {
    Fact::ModelCompleted {
        step_id: step.into(),
        output: ModelStep {
            parts,
            finish_reason: ModelFinishReason::Stop,
            usage: Default::default(),
            provider_options: None,
            response_id: None,
            model: None,
            timestamp: None,
        },
    }
}

async fn append_worker(
    worker: &mut sqlx::sqlite::SqliteWorkerConnection<'_>,
    invocation: &str,
    fact: Fact,
) -> Result<(), StoreError> {
    let event = RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: invocation.into(),
        },
        fact,
    );
    let json = serde_json::to_string(&event)?;
    let inserted = crate::canonical_insert::insert(crate::canonical_insert::Record {
        sequence: None,
        event_id: &event.id,
        invocation_id: Some(invocation),
        kind: event.fact.kind(),
        operation_id: event.fact.operation_id(),
        json: &json,
    })
    .execute(&mut *worker)
    .await?;
    let stored = StoredEvent {
        sequence: u64::try_from(inserted.last_insert_rowid()).unwrap(),
        event,
    };
    crate::context::projection::record(worker, &stored, &json).await
}

async fn append(db: &mut SqliteConnection, invocation: &str, fact: Fact) {
    let invocation = invocation.to_owned();
    let mut tx = db.begin().await.unwrap();
    crate::connection::worker_query(&mut tx, move |worker| {
        Box::pin(async move { append_worker(worker, &invocation, fact).await })
    })
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn inspect<T: Send + 'static>(
    db: &mut SqliteConnection,
    read: impl FnOnce(&RawConnection) -> rusqlite::Result<T> + Send + 'static,
) -> T {
    crate::connection::worker_query(db, move |worker| {
        Box::pin(async move {
            // SAFETY: the callback exclusively borrows the original worker; the wrapper
            // and all statements finish before that borrow is returned to SQLx.
            let raw = unsafe { RawConnection::from_handle(worker.as_raw_handle().as_ptr()) }?;
            Ok(read(&raw)?)
        })
    })
    .await
    .unwrap()
}

async fn work(
    db: &mut SqliteConnection,
    sql: &'static str,
    parameter: rusqlite::types::Value,
) -> (usize, i32) {
    inspect(db, move |db| {
        let mut statement = db.prepare(sql)?;
        let parameters = if sql == UNFINISHED_INVOCATIONS {
            vec![rusqlite::types::Value::Integer(0), parameter]
        } else {
            vec![parameter]
        };
        let count = statement
            .query_map(rusqlite::params_from_iter(parameters), |_| Ok(()))?
            .count();
        Ok((count, statement.get_status(StatementStatus::VmStep)))
    })
    .await
}

#[tokio::test]
async fn recovery_work_depends_on_unfinished_work_not_completed_history() {
    let mut db = database().await;
    append(&mut db, "forever", opening()).await;
    let query = unresolved!(" SELECT kind,id,name,input,call FROM unresolved");
    let mut short = None;
    for n in 0..10_000 {
        let id = format!("old-{n}");
        append(&mut db, &id, opening()).await;
        append(&mut db, &id, ended("completed")).await;
        append(&mut db, "forever", requested(&id)).await;
        append(&mut db, "forever", completed(&id, vec![])).await;
        if n == 99 {
            short = Some((
                work(&mut db, UNFINISHED_INVOCATIONS, 16.into()).await,
                work(&mut db, query, "forever".to_owned().into()).await,
            ));
        }
    }
    let (startup, active) = short.unwrap();
    let long_startup = work(&mut db, UNFINISHED_INVOCATIONS, 16.into()).await;
    let long_active = work(&mut db, query, "forever".to_owned().into()).await;
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
    sqlx::query("INSERT INTO imported_invocations VALUES('forever')")
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(work(&mut db, UNFINISHED_INVOCATIONS, 16.into()).await.0, 0);
}

#[tokio::test]
async fn pending_call_recovery_preserves_accepted_input_and_unknown_effects() {
    let mut db = database().await;
    append(&mut db, "run", opening()).await;
    append(&mut db, "run", requested("step")).await;
    append(
        &mut db,
        "run",
        completed(
            "step",
            vec![ModelPart::ToolCall {
                call: ModelToolCall {
                    id: "call".into(),
                    name: "read".into(),
                    input: ToolInput::InvalidJson { raw: "{".into() },
                    provider_options: None,
                    provider_executed: false,
                },
            }],
        ),
    )
    .await;
    let query = unresolved!(" SELECT kind,id,name,input,call FROM unresolved ORDER BY kind,id");
    let row: (i64, String, String, String, String) = sqlx::query_as(query)
        .bind("run")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(
        (row.0, row.1.as_str(), row.2.as_str()),
        (2, "step:call", "read")
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&row.3).unwrap(),
        json!({"kind":"invalid_json","data":{"raw":"{"}})
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&row.4).unwrap(),
        json!({"tool_call_id":"call","origin":{"kind":"provider","step_id":"step"}})
    );
    append(
        &mut db,
        "run",
        Fact::ToolDispatched {
            operation_id: "step:call".into(),
            presentation: None,
            title: None,
            call: ToolCallIdentity {
                tool_call_id: "call".into(),
                origin: ToolOrigin::Provider {
                    step_id: "step".into(),
                },
            },
            name: "read".into(),
            input: json!({}),
        },
    )
    .await;
    append(&mut db, "run", ended("outcome_unknown")).await;
    let pending: (i64, String) = sqlx::query_as(query)
        .bind("run")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(pending, (1, "step:call".into()));
    append(
        &mut db,
        "run",
        Fact::ToolSettled {
            operation_id: "step:call".into(),
            outcome: ToolOutcome::Failed {
                message: "fixture".into(),
            },
        },
    )
    .await;
    assert_eq!(work(&mut db, query, "run".to_owned().into()).await.0, 0);
}

mod pagination;
