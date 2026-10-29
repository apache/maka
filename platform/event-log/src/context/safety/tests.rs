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
use maka_agent_facts::event::{
    Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent, StoredEvent,
};
use serde_json::{Value, json};
use sqlx::Connection;

// Keep the independent ledger oracle while projecting complete typed facts through
// the production reducer. Admission is deliberately separate from historical order.
const LEDGER: &str = "CREATE TABLE event_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    invocation_id TEXT,
    kind TEXT NOT NULL,
    operation_id TEXT,
    event_json TEXT,
    accounting_at REAL,
    accounting_usage TEXT,
    invocation_model TEXT,
    accounting_tool TEXT,
    event_session TEXT
);
CREATE VIEW runtime_events AS SELECT * FROM event_log WHERE invocation_id IS NOT NULL AND event_json IS NOT NULL;
CREATE INDEX invocation_sequence ON event_log(invocation_id, sequence);
CREATE UNIQUE INDEX operation_fact ON event_log(operation_id,kind) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX invocation_boundary ON event_log(invocation_id,kind) WHERE kind='invocation_opened' OR kind='invocation_ended';
CREATE INDEX model_observed_step ON event_log(invocation_id, CAST(json_extract(event_json,'$.fact.step_id') AS TEXT), sequence)
    WHERE kind='model_observed';";
fn obligation_schema() -> String {
    crate::schema::fixture(|_, name| {
        name.starts_with("context_obligations") || name.starts_with("context_safety_")
    })
}
fn execution_schema() -> String {
    crate::schema::fixture(|_, name| {
        [
            "context_execution_",
            "context_independent_",
            "context_summary_",
            "tool_call_identity",
            "model_part_",
            "model_selected_parts",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    })
}

async fn database() -> SqliteConnection {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(LEDGER).execute(&mut db).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(obligation_schema()))
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(execution_schema()))
        .execute(&mut db)
        .await
        .unwrap();
    db
}

mod execution;

async fn append(db: &mut SqliteConnection, kind: &str, op: Option<&str>, fact: Value) -> u64 {
    let fact = fixture_fact(kind, op, fact);
    let mut tx = db.begin().await.unwrap();
    let sequence = crate::connection::worker_query(&mut tx, move |worker| {
        Box::pin(async move { append_worker(worker, fact).await })
    })
    .await
    .unwrap();
    tx.commit().await.unwrap();
    sequence
}

fn fixture_fact(kind: &str, op: Option<&str>, mut fields: Value) -> Fact {
    if kind == "invocation_opened" {
        return Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "fixture".into(),
                request_fingerprint: None,
            },
        };
    }
    if kind == "invocation_ended" {
        let class = fields["outcome"]["class"].as_str().unwrap();
        return Fact::InvocationEnded {
            outcome: if matches!(class, "succeeded" | "completed") {
                InvocationOutcome::Completed
            } else if class == "cancelled" {
                InvocationOutcome::Cancelled {
                    source: "fixture".into(),
                }
            } else {
                InvocationOutcome::Failed {
                    class: class.into(),
                    message: None,
                    model_failure: None,
                }
            },
        };
    }
    fields["kind"] = kind.into();
    match kind {
        "model_requested" => {
            let values = fields.as_object_mut().unwrap();
            for (key, value) in [
                ("step_id", json!(op.unwrap())),
                ("model_id", json!("fixture")),
                ("item_acceptance", json!(false)),
                ("purpose", json!("main")),
                (
                    "source_scope",
                    serde_json::to_value(maka_agent_facts::event::LogScope::Session {
                        id: "session".into(),
                    })
                    .unwrap(),
                ),
                ("source_high_water", json!(0)),
                ("source_digest", json!("fixture")),
                ("input_digest", json!("fixture")),
                (
                    "route_identity",
                    json!(format!("sha256:{}", "0".repeat(64))),
                ),
            ] {
                values.entry(key).or_insert(value);
            }
        }
        "model_interrupted" => {
            if let Some(parts) = fields
                .get_mut("partial")
                .and_then(|partial| partial.get_mut("parts"))
                .and_then(Value::as_array_mut)
            {
                for part in parts {
                    if part["kind"] == "own" {
                        complete_model_part(&mut part["data"]["part"]);
                    }
                }
            }
            fields
                .as_object_mut()
                .unwrap()
                .entry("step_id")
                .or_insert(json!(op.unwrap()));
            fields
                .as_object_mut()
                .unwrap()
                .entry("status")
                .or_insert(json!("retryable_failure"));
        }
        "model_completed" => {
            fields
                .as_object_mut()
                .unwrap()
                .entry("step_id")
                .or_insert(json!(op.unwrap()));
            let output = fields["output"].as_object_mut().unwrap();
            output.entry("finish_reason").or_insert(json!("stop"));
            output.entry("usage").or_insert(json!({}));
            for part in fields["output"]["parts"].as_array_mut().unwrap() {
                if part["kind"] == "own" {
                    complete_model_part(&mut part["data"]["part"]);
                }
            }
        }
        "model_observed" => match fields["event"]["kind"].as_str().unwrap() {
            "part" => complete_model_part(&mut fields["event"]["data"]["part"]),
            "finished" => {
                let data = fields["event"]["data"].as_object_mut().unwrap();
                data.entry("reason").or_insert(json!("stop"));
                data.entry("usage").or_insert(json!({}));
            }
            "provider_options" | "response_metadata" => {}
            other => panic!("unsupported fixture observation {other}"),
        },
        "tool_dispatched" | "tool_rejected" => {
            fields["operation_id"] = json!(op.unwrap());
            fields
                .as_object_mut()
                .unwrap()
                .entry("name")
                .or_insert(json!("fixture"));
            fields
                .as_object_mut()
                .unwrap()
                .entry("input")
                .or_insert(if kind == "tool_rejected" {
                    json!({"kind":"json","data":{}})
                } else {
                    json!({})
                });
            if fields["call"].is_null() {
                fields["call"] = json!({});
            }
            let call = fields["call"].as_object_mut().unwrap();
            call.entry("tool_call_id").or_insert(json!(op.unwrap()));
            call.entry("origin").or_insert(json!({"kind":"standalone"}));
            let origin = call["origin"].as_object_mut().unwrap();
            match origin["kind"].as_str().unwrap() {
                "code_cell" | "code_mode" => {
                    origin
                        .entry("parent_operation_id")
                        .or_insert(json!("missing-parent"));
                    origin
                        .entry("parent_tool_call_id")
                        .or_insert(json!("parent-call"));
                }
                "host_sdk" => {
                    for key in ["package_id", "entry_id", "activation"] {
                        origin.entry(key).or_insert(json!("fixture"));
                    }
                }
                "provider" => {
                    origin.entry("step_id").or_insert(json!("step"));
                }
                "standalone" => {}
                other => panic!("unsupported fixture origin {other}"),
            }
            if kind == "tool_rejected" {
                fields
                    .as_object_mut()
                    .unwrap()
                    .entry("reason")
                    .or_insert(json!({"kind":"unavailable"}));
            }
        }
        "tool_settled" => {
            use maka_agent_facts::event::ToolOutcome;
            return Fact::ToolSettled {
                operation_id: op.unwrap().into(),
                outcome: match fields["outcome"]["kind"].as_str() {
                    Some("succeeded") => ToolOutcome::Succeeded {
                        raw: maka_agent_facts::tool_output::RawToolResultRef {
                            bytes: 2,
                            digest: maka_agent_facts::artifact::content_digest(b"{}"),
                        },
                        model_projection:
                            maka_agent_facts::tool_output::DurableToolProjection::Json {
                                value: json!({}),
                            },
                        artifacts: vec![],
                    },
                    Some("unknown") => ToolOutcome::Unknown {
                        message: "fixture".into(),
                        operation: None,
                    },
                    Some("failed") | None => ToolOutcome::Failed {
                        message: "fixture".into(),
                    },
                    other => panic!("unsupported fixture settlement {other:?}"),
                },
            };
        }
        other => panic!("unsupported fixture fact {other}"),
    }
    serde_json::from_value(fields).expect("fixture has every required typed fact field")
}

fn complete_model_part(part: &mut Value) {
    match part["kind"].as_str().unwrap() {
        "tool_call" => {
            part["call"]
                .as_object_mut()
                .unwrap()
                .entry("input")
                .or_insert(json!({"kind":"json","data":{}}));
        }
        "tool_result" => {
            let fields = part.as_object_mut().unwrap();
            fields.entry("output").or_insert(Value::Null);
            fields.entry("is_error").or_insert(json!(false));
        }
        "text" | "source" => {}
        other => panic!("unsupported fixture part {other}"),
    }
}

fn recorded_part(step: &str, ordinal: u64, mut part: Value) -> Value {
    complete_model_part(&mut part);
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

fn own_part(step: &str, ordinal: u64, part: Value) -> Value {
    json!({"kind":"own","data":recorded_part(step, ordinal, part)})
}

async fn part_reference(db: &mut SqliteConnection, sequence: u64, ordinal: u64) -> Value {
    let id: String = sqlx::query_scalar("SELECT event_id FROM event_log WHERE sequence=?")
        .bind(sequence as i64)
        .fetch_one(db)
        .await
        .unwrap();
    json!({"kind":"ref","data":{"event_id":id,"ordinal":ordinal}})
}

async fn append_worker(
    worker: &mut sqlx::sqlite::SqliteWorkerConnection<'_>,
    fact: Fact,
) -> Result<u64, StoreError> {
    let event = RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        fact,
    );
    let json = serde_json::to_string(&event)?;
    let result = crate::canonical_insert::insert(crate::canonical_insert::Record {
        sequence: None,
        event_id: &event.id,
        invocation_id: Some(&event.invocation.invocation_id),
        kind: event.fact.kind(),
        operation_id: event.fact.operation_id(),
        json: &json,
    })
    .execute(&mut *worker)
    .await?;
    let sequence = u64::try_from(result.last_insert_rowid()).unwrap();
    let stored = StoredEvent { sequence, event };
    crate::model_items::record(worker, &stored).await?;
    crate::context::projection::record(worker, &stored, &json).await?;
    Ok(sequence)
}

async fn ended(db: &mut SqliteConnection, class: &str) -> u64 {
    append(
        db,
        "invocation_ended",
        None,
        json!({"outcome":{"class":class}}),
    )
    .await
}

#[tokio::test]
async fn unknown_end_keeps_tool_obligation_and_late_settlement_does_not_fix_old_cut() {
    for class in ["outcome_unknown", "tool_execution", "cancelled"] {
        let mut db = database().await;
        append(&mut db, "invocation_opened", None, json!({})).await;
        append(&mut db, "tool_dispatched", Some("cell"), json!({})).await;
        let unknown_cut = ended(&mut db, class).await;
        assert!(matches!(
            require_safe(&mut db, "session", None).await,
            Err(StoreError::HistoryUnsettled)
        ));
        assert!(
            require_manual_message_safe(&mut db, "session", None)
                .await
                .unwrap()
        );
        append(
            &mut db,
            "tool_settled",
            Some("cell"),
            json!({"outcome":{"kind":"succeeded"}}),
        )
        .await;
        require_safe(&mut db, "session", None).await.unwrap();
        assert!(
            !require_manual_message_safe(&mut db, "session", None)
                .await
                .unwrap()
        );
        assert!(matches!(
            require_safe_through(&mut db, "session", None, unknown_cut).await,
            Err(StoreError::HistoryUnsettled)
        ));
        require_safe_through_policy(&mut db, "session", None, unknown_cut, true)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn ordinary_end_does_not_make_live_tool_or_model_work_safe() {
    let mut db = database().await;
    append(&mut db, "invocation_opened", None, json!({})).await;
    append(&mut db, "tool_dispatched", Some("tool"), json!({})).await;
    append(
        &mut db,
        "model_requested",
        Some("step"),
        json!({"step_id":"step"}),
    )
    .await;
    ended(&mut db, "failed").await;
    assert!(matches!(
        require_manual_message_safe(&mut db, "session", None).await,
        Err(StoreError::HistoryUnsettled)
    ));
    append(
        &mut db,
        "tool_settled",
        Some("tool"),
        json!({"outcome":{"kind":"failed"}}),
    )
    .await;
    assert!(matches!(
        require_safe(&mut db, "session", None).await,
        Err(StoreError::HistoryUnsettled)
    ));
    append(
        &mut db,
        "model_interrupted",
        Some("step"),
        json!({"step_id":"step"}),
    )
    .await;
    require_safe(&mut db, "session", None).await.unwrap();
}

#[tokio::test]
async fn accepted_call_dispatch_and_completion_do_not_duplicate_obligations() {
    let mut db = database().await;
    append(&mut db, "invocation_opened", None, json!({})).await;
    append(
        &mut db,
        "model_requested",
        Some("step"),
        json!({"step_id":"step","item_acceptance":true}),
    )
    .await;
    let call = json!({"id":"call","name":"tool","provider_executed":false});
    let observed = append(
        &mut db,
        "model_observed",
        None,
        json!({"step_id":"step","event":{"kind":"part","data":recorded_part("step",0,json!({"kind":"tool_call","call":call}))}}),
    )
    .await;
    let reference = part_reference(&mut db, observed, 0).await;
    append(&mut db, "tool_dispatched", Some("step:call"), json!({})).await;
    append(
        &mut db,
        "tool_settled",
        Some("step:call"),
        json!({"outcome":{"kind":"succeeded"}}),
    )
    .await;
    append(
        &mut db,
        "model_completed",
        Some("step"),
        json!({"step_id":"step","output":{"parts":[reference]}}),
    )
    .await;
    ended(&mut db, "succeeded").await;
    require_safe(&mut db, "session", None).await.unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_obligations")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}

#[tokio::test]
async fn interrupted_provider_effect_requires_matching_result_before_interrupt() {
    for result in [
        None,
        Some(("call", "wrong", "step")),
        Some(("wrong", "provider", "step")),
        Some(("call", "provider", "wrong")),
        Some(("call", "provider", "step")),
    ] {
        let mut db = database().await;
        append(&mut db, "invocation_opened", None, json!({})).await;
        append(
            &mut db,
            "model_requested",
            Some("step"),
            json!({"step_id":"step"}),
        )
        .await;
        append(&mut db,"model_observed",None,json!({"step_id":"step","event":{"kind":"part","data":recorded_part("step",0,json!({"kind":"tool_call","call":{"id":"call","name":"provider","provider_executed":true}}))}})).await;
        if let Some((id, name, step)) = result {
            append(&mut db,"model_observed",None,json!({"step_id":step,"event":{"kind":"part","data":recorded_part(step,1,json!({"kind":"tool_result","id":id,"name":name}))}})).await;
        }
        append(
            &mut db,
            "model_interrupted",
            Some("step"),
            json!({"step_id":"step"}),
        )
        .await;
        ended(&mut db, "outcome_unknown").await;
        let safety = require_manual_message_safe(&mut db, "session", None).await;
        if result == Some(("call", "provider", "step")) {
            assert!(!safety.unwrap());
        } else {
            assert!(matches!(
                safety,
                Err(StoreError::HistoryProviderEffectUnresolved)
            ));
        }
    }
}

#[tokio::test]
async fn obligations_are_transactional_and_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(directory.path().join("safety.db"))
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(LEDGER).execute(&mut db).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(obligation_schema()))
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(execution_schema()))
        .execute(&mut db)
        .await
        .unwrap();
    append(&mut db, "invocation_opened", None, json!({})).await;
    append(&mut db, "tool_dispatched", Some("tool"), json!({})).await;
    ended(&mut db, "outcome_unknown").await;
    {
        let mut tx = db.begin().await.unwrap();
        append(
            &mut tx,
            "tool_settled",
            Some("tool"),
            json!({"outcome":{"kind":"succeeded"}}),
        )
        .await;
        require_safe(&mut tx, "session", None).await.unwrap();
        tx.rollback().await.unwrap();
    }
    db.close().await.unwrap();
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    assert!(matches!(
        require_safe(&mut db, "session", None).await,
        Err(StoreError::HistoryUnsettled)
    ));
    assert!(
        require_manual_message_safe(&mut db, "session", None)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn completion_without_matching_provider_result_blocks_manual_message_too() {
    for include_result in [false, true] {
        let mut db = database().await;
        append(&mut db, "invocation_opened", None, json!({})).await;
        append(
            &mut db,
            "model_requested",
            Some("step"),
            json!({"step_id":"step"}),
        )
        .await;
        let mut parts = vec![own_part(
            "step",
            0,
            json!({"kind":"tool_call","call":{"id":"call","name":"provider","provider_executed":true}}),
        )];
        if include_result {
            parts.push(own_part(
                "step",
                1,
                json!({"kind":"tool_result","id":"call","name":"provider"}),
            ));
        }
        append(
            &mut db,
            "model_completed",
            Some("step"),
            json!({"step_id":"step","output":{"parts":parts}}),
        )
        .await;
        ended(&mut db, "outcome_unknown").await;
        let safety = require_manual_message_safe(&mut db, "session", None).await;
        if include_result {
            assert!(!safety.unwrap());
        } else {
            assert!(matches!(safety, Err(StoreError::HistoryUnsettled)));
        }
    }
}
