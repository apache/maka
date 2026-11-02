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

use crate::{EventLog, StoreError};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::tool_call::tool_use_id;
use sqlx::SqliteConnection;

impl EventLog {
    /// Admission preflight only. The canonical INSERT checks the same namespace
    /// again in its transaction; this does not claim or reserve the identity.
    pub async fn validate_message_identity(
        &self,
        session: &str,
        message: &str,
    ) -> Result<(), StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        crate::sessions::validate_id(message)?;
        let session = session.to_owned();
        let message = message.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move { validate_source_id(connection, &session, &message).await })
            })
            .await
    }
}

/// Source IDs share the client's visible-message namespace with Host event and
/// tool IDs. Check both directions before either side becomes a durable fact.
pub(crate) async fn validate(
    tx: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let session = &event.invocation.session_id;
    // All event IDs are checked by the INSERT itself, without an extra query
    // for every streamed delta. Derived tool IDs are checked here.
    let invocation = &event.invocation.invocation_id;
    match &event.fact {
        Fact::ModelObserved {
            step_id,
            event: maka_agent_facts::model::recorded::ModelObservation::Part(record),
        } => {
            if let maka_agent_facts::model::ModelPart::ToolCall { call } = record.part.as_ref() {
                reject_claim(
                    tx,
                    session,
                    &tool_use_id(invocation, &format!("{step_id}:{}", call.id)),
                )
                .await?;
            }
        }
        Fact::ModelCompleted { step_id, output } => {
            for part in &output.parts {
                if let maka_agent_facts::model::recorded::CompletionPart::Own(record) = part
                    && let maka_agent_facts::model::ModelPart::ToolCall { call } =
                        record.part.as_ref()
                {
                    reject_claim(
                        tx,
                        session,
                        &tool_use_id(invocation, &format!("{step_id}:{}", call.id)),
                    )
                    .await?;
                }
            }
        }
        Fact::ToolDispatched { operation_id, .. } | Fact::ToolRejected { operation_id, .. } => {
            reject_claim(tx, session, &tool_use_id(invocation, operation_id)).await?;
        }
        Fact::ExecutorObserved {
            output: maka_agent_facts::executor::Output::ToolStart { tool_call_id, .. },
        } => {
            reject_claim(tx, session, &tool_use_id(invocation, tool_call_id)).await?;
        }
        Fact::ExecutorCompleted { .. } | Fact::InvocationEnded { .. } => {
            // The event is absent: this writer transaction contains exactly its
            // preceding facts, including earlier writes in the same batch.
            for index in 0..executor_pending(tx, invocation, i64::MAX).await? {
                reject_claim(
                    tx,
                    session,
                    &maka_agent_facts::tool_call::provider_result_id(&event.id, index),
                )
                .await?;
            }
        }
        Fact::ToolSettled { .. } => {
            reject_claim(
                tx,
                session,
                &maka_agent_facts::tool_call::metered_usage_id(&event.id),
            )
            .await?;
        }
        _ => {}
    }
    for message_id in crate::message_sources::identities(event) {
        validate_source_id(tx, session, message_id).await?;
    }
    Ok(())
}
async fn validate_recorded_id(
    tx: &mut SqliteConnection,
    session: &str,
    message_id: &str,
) -> Result<(), StoreError> {
    let used: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_history_events WHERE event_id = ?1 AND owner_session_id = ?2
             UNION ALL SELECT 1 FROM session_message_sources
             WHERE owner_session_id=?2 AND source_session_id!=?2 AND message_id=?1
             UNION ALL SELECT 1 FROM model_part_records p WHERE p.message_id=?1
             AND EXISTS(SELECT 1 FROM session_history_events e
                 WHERE e.event_id=p.event_id AND e.owner_session_id=?2))",
    )
    .bind(message_id)
    .bind(session)
    .fetch_one(&mut *tx)
    .await?;
    if used {
        return Err(conflict());
    }
    Ok(())
}

pub(crate) async fn validate_derived_tool_id(
    tx: &mut SqliteConnection,
    session: &str,
    message_id: &str,
    invocation: &str,
    operation: &str,
) -> Result<(), StoreError> {
    validate_recorded_id(tx, session, message_id).await?;
    reject_claim(tx, session, message_id).await?;
    let used: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM session_history_events
            WHERE owner_session_id=?1 AND invocation_id=?2 AND operation_id=?3
              AND kind IN ('tool_dispatched','tool_rejected')
            UNION ALL
            SELECT 1 FROM session_history_events
            WHERE owner_session_id=?1 AND invocation_id=?2
              AND kind IN ('executor_observed','executor_completed')
              AND json_extract(event_header,'$.fact.output.toolCallId')=?3
              AND json_extract(event_header,'$.fact.output.type')='tool_start')",
    )
    .bind(session)
    .bind(invocation)
    .bind(operation)
    .fetch_one(tx)
    .await?;
    if used { Err(conflict()) } else { Ok(()) }
}

pub(crate) async fn validate_source_id(
    tx: &mut SqliteConnection,
    session: &str,
    message_id: &str,
) -> Result<(), StoreError> {
    validate_recorded_id(tx, session, message_id).await?;
    if let Some(event_id) = maka_agent_facts::tool_call::parse_metered_usage_id(message_id) {
        let used: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM session_history_events WHERE event_id = ?1
                 AND kind = 'tool_settled'
                 AND owner_session_id = ?2)",
        )
        .bind(event_id)
        .bind(session)
        .fetch_one(&mut *tx)
        .await?;
        if used {
            return Err(conflict());
        }
    }
    if let Some((event_id, index)) =
        maka_agent_facts::tool_call::parse_provider_result_id(message_id)
    {
        let closing: Option<(String, i64)> = sqlx::query_as(
            "SELECT invocation_id, sequence FROM session_history_events
             WHERE owner_session_id = ? AND event_id = ?
               AND kind IN ('executor_completed', 'invocation_ended')",
        )
        .bind(session)
        .bind(event_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((invocation, before)) = closing
            && index < executor_pending(tx, &invocation, before).await?
        {
            return Err(conflict());
        }
    }
    // Only this exact generated spelling can equal a tool ID. Ordinary
    // client UUIDs never scan tool facts; this is not a reserved prefix.
    if message_id.starts_with("tool_") {
        let used: bool = sqlx::query_scalar(concat!("WITH ", crate::model_items::accepted_calls!(),
                " SELECT EXISTS(
                    SELECT 1 FROM session_history_events WHERE kind IN ('tool_dispatched', 'tool_rejected')
                    AND owner_session_id = ?1 AND maka_tool_use_id(invocation_id, operation_id) = ?2
                    UNION ALL
                    SELECT 1 FROM session_history_events WHERE kind = 'executor_observed'
                    AND owner_session_id = ?1 AND json_extract(event_header, '$.fact.output.type') = 'tool_start'
                    AND maka_tool_use_id(invocation_id, json_extract(event_header, '$.fact.output.toolCallId')) = ?2
                    UNION ALL
                    SELECT 1 FROM accepted_calls c JOIN session_history_events e ON e.event_id=c.event_id
                    WHERE e.owner_session_id=?1 AND maka_tool_use_id(c.invocation_id, c.step_id || ':' || json_extract(c.call,'$.id'))=?2)"
            )).bind(session).bind(message_id).fetch_one(&mut *tx).await?;
        if used {
            return Err(conflict());
        }
    }
    Ok(())
}
/// Count the synthetic result slots closed at this historical boundary.
/// A prior completion already drained the pending set. Only scalar current-
/// executor evidence is selected without assembling presentation in Rust.
/// Malformed observations retain their existing optional projection errors.
async fn executor_pending(
    tx: &mut SqliteConnection,
    invocation: &str,
    before: i64,
) -> Result<usize, StoreError> {
    let started: Option<i64> = sqlx::query_scalar(
        "SELECT sequence FROM runtime_events AS started
         WHERE invocation_id = ?1 AND kind = 'executor_started' AND sequence < ?2
           AND NOT EXISTS(SELECT 1 FROM runtime_events AS completed
             WHERE completed.invocation_id = started.invocation_id
               AND completed.kind = 'executor_completed'
               AND completed.sequence > started.sequence AND completed.sequence < ?2)",
    )
    .bind(invocation)
    .bind(before)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(started) = started else {
        return Ok(0);
    };
    // Keep the partial-index kind predicate for executor_tool_observations.
    // Original JSON equality matches the pending tool ID, not a cast spelling.
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT json_extract(start.event_header, '$.fact.output.toolCallId'))
         FROM runtime_events AS start
         WHERE start.invocation_id = ?1
           AND start.kind IN ('executor_observed', 'executor_completed')
           AND start.sequence > ?2 AND start.sequence < ?3
           AND json_extract(start.event_header, '$.fact.output.type') = 'tool_start'
           AND NOT EXISTS(SELECT 1 FROM runtime_events AS result
             WHERE result.invocation_id = start.invocation_id
               AND result.kind IN ('executor_observed', 'executor_completed')
               AND json_extract(result.event_header, '$.fact.output.toolCallId') =
                   json_extract(start.event_header, '$.fact.output.toolCallId')
               AND result.sequence > start.sequence AND result.sequence < ?3
               AND json_extract(result.event_header, '$.fact.output.type') = 'tool_result')",
    )
    .bind(invocation)
    .bind(started)
    .bind(before)
    .fetch_one(tx)
    .await?;
    usize::try_from(count).map_err(|_| StoreError::PrefixTooLarge)
}

async fn reject_claim(
    tx: &mut SqliteConnection,
    session: &str,
    id: &str,
) -> Result<(), StoreError> {
    let claimed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_message_sources WHERE owner_session_id = ?1 AND message_id = ?2
         UNION ALL SELECT 1 FROM message_admissions WHERE session_id = ?1 AND message_id = ?2)",
    )
    .bind(session)
    .bind(id)
    .fetch_one(tx)
    .await?;
    if claimed { Err(conflict()) } else { Ok(()) }
}
fn conflict() -> StoreError {
    StoreError::InvalidTransition(
        "message identity collides with a canonical visible identity".into(),
    )
}
pub(crate) fn register(connection: &rusqlite::Connection) -> Result<(), StoreError> {
    use rusqlite::functions::FunctionFlags;
    connection.create_scalar_function(
        "maka_tool_use_id",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            Ok(ctx
                .get_raw(0)
                .as_str_or_null()?
                .zip(ctx.get_raw(1).as_str_or_null()?)
                .map(|(invocation, operation)| tool_use_id(invocation, operation)))
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn tool_identity_sql_preserves_text_null_and_wrong_type_semantics() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        super::register(&db).unwrap();
        let value: String = db
            .query_row(
                "SELECT maka_tool_use_id('invocation', 'operation')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            value,
            "tool_81c478783b57624325cf312c0a24b2bdd0d430109780498d16605e498f2ee58f"
        );
        for sql in [
            "SELECT maka_tool_use_id(NULL, 'operation')",
            "SELECT maka_tool_use_id('invocation', NULL)",
            "SELECT maka_tool_use_id(NULL, NULL)",
        ] {
            let value: Option<String> = db.query_row(sql, [], |row| row.get(0)).unwrap();
            assert_eq!(value, None);
        }
        for sql in [
            "SELECT maka_tool_use_id(7, 'operation')",
            "SELECT maka_tool_use_id('invocation', x'00')",
            "SELECT maka_tool_use_id(NULL, 7)",
        ] {
            assert!(
                db.query_row(sql, [], |row| row.get::<_, Option<String>>(0))
                    .is_err(),
                "wrong types must remain errors: {sql}"
            );
        }
    }

    #[tokio::test]
    async fn derived_tool_identity_rejects_prior_native_and_executor_claims() {
        use maka_agent_facts::{
            event::{Fact, Invocation, RuntimeEvent},
            executor::Output,
            tool_call::{ToolCallIdentity, ToolRejection},
        };
        use sqlx::Connection;

        for fact in [
            Fact::ToolDispatched {
                operation_id: "step:call".into(),
                call: ToolCallIdentity::standalone("call".into()),
                name: "Read".into(),
                input: serde_json::json!({}),
                presentation: None,
                title: None,
            },
            Fact::ToolRejected {
                operation_id: "step:call".into(),
                call: ToolCallIdentity::standalone("call".into()),
                name: "Read".into(),
                input: serde_json::json!({}).into(),
                reason: ToolRejection::Unavailable,
            },
            Fact::ExecutorObserved {
                output: Output::ToolStart {
                    tool_call_id: "step:call".into(),
                    name: "Read".into(),
                    input: serde_json::json!({}),
                },
            },
        ] {
            let mut db = sqlx::SqliteConnection::connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::raw_sql(sqlx::AssertSqlSafe(crate::schema::fixture(|kind, _| {
                kind != "trigger"
            })))
            .execute(&mut db)
            .await
            .unwrap();
            let event = RuntimeEvent::new(
                Invocation {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                fact,
            );
            let json = serde_json::to_string(&event).unwrap();
            crate::canonical_insert::insert(crate::canonical_insert::Record {
                sequence: None,
                event_id: &event.id,
                invocation_id: Some("invocation"),
                kind: event.fact.kind(),
                operation_id: event.fact.operation_id(),
                json: &json,
            })
            .execute(&mut db)
            .await
            .unwrap();
            let id = super::tool_use_id("invocation", "step:call");
            assert!(super::validate_derived_tool_id(
                &mut db, "session", &id, "invocation", "step:call",
            ).await.is_err(), "{} claim was missed", event.fact.kind());
            let fresh = super::tool_use_id("invocation", "step:fresh");
            super::validate_derived_tool_id(&mut db, "session", &fresh, "invocation", "step:fresh")
                .await
                .unwrap();
            super::validate_derived_tool_id(&mut db, "other", &id, "invocation", "step:call")
                .await
                .unwrap();
        }
    }
}
