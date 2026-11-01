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

use super::{PendingMessageAdmission, invalid, read};
use crate::StoreError;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::message::MessageDisposition;
use sqlx::SqliteConnection;

pub(crate) enum Owner {
    Unsealed,
    /// Host still owns this latest Run's cleanup/handoff under its admission gate.
    Current,
}
pub(crate) async fn insert(
    tx: &mut SqliteConnection,
    admission: &PendingMessageAdmission,
    owner: Owner,
) -> Result<Option<u64>, StoreError> {
    admission.validate()?;
    crate::recovery::require_local(tx, &admission.invocation.invocation_id).await?;
    if admission.steering_invocation.is_some() {
        return Err(invalid("new admission cannot override steering ownership"));
    }
    let encoded = serde_json::to_string(&admission)?;
    let session = &admission.invocation.session_id;
    let message = &admission.source.message.message_id;
    if let Some(previous) = read(&mut *tx, session, message).await? {
        if previous != *admission {
            return Err(invalid("message admission identity changed"));
        }
        return Ok(None);
    }
    let archived: Option<bool> =
        sqlx::query_scalar("SELECT archived FROM session_control WHERE id = ?")
            .bind(session)
            .fetch_optional(&mut *tx)
            .await?;
    match archived {
        None => return Err(StoreError::SessionNotFound),
        Some(true) => return Err(invalid("cannot admit a message to an archived Session")),
        Some(false) => {}
    }
    let delivered: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM message_sources WHERE session_id = ? AND message_id = ?)",
    )
    .bind(session)
    .bind(message)
    .fetch_one(&mut *tx)
    .await?;
    if delivered {
        return Err(invalid("message already has an immutable delivery"));
    }
    if crate::message_queue::cancelled(&mut *tx, session, message).await? {
        return Err(invalid("message has a durable cancellation"));
    }
    crate::message_identity::validate_source_id(&mut *tx, session, message).await?;
    if crate::message_interrupts::fenced(&mut *tx, session, &admission.invocation.run_id).await? {
        return Err(StoreError::SessionBusy);
    }
    let active: Option<String> = sqlx::query_scalar(
        "SELECT json_extract(o.event_header, '$.invocation') FROM (
            SELECT invocation_id, event_header FROM event_log INDEXED BY catalog_message_facts
            WHERE invocation_id IS NOT NULL AND event_header IS NOT NULL
            AND kind IN ('invocation_opened', 'model_completed') AND kind = 'invocation_opened'
            AND json_extract(event_header, '$.invocation.session_id') = ?1
            ORDER BY sequence DESC LIMIT 1
         ) AS o
         WHERE NOT EXISTS(SELECT 1 FROM imported_invocations i
            WHERE i.invocation_id = o.invocation_id)
         AND (?2 OR NOT EXISTS(SELECT 1 FROM runtime_events t
            WHERE t.invocation_id = o.invocation_id AND t.kind = 'invocation_ended'))",
    )
    .bind(session)
    .bind(matches!(owner, Owner::Current))
    .fetch_optional(&mut *tx)
    .await?;
    match (admission.source.disposition, active) {
        (MessageDisposition::TurnStarted, None) => {}
        (MessageDisposition::Steering | MessageDisposition::Followup, Some(active))
            if serde_json::from_str::<Invocation>(&active)? == admission.invocation => {}
        _ => {
            return Err(invalid(
                "message admission no longer matches the active Run",
            ));
        }
    }
    let other_owner: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id = ?
         AND json_extract(record_json, '$.execution.owner') IS NOT ?)",
    )
    .bind(session)
    .bind(&admission.execution.owner)
    .fetch_one(&mut *tx)
    .await?;
    if other_owner {
        return Err(invalid("pending Session belongs to another dispatcher"));
    }
    let (pending, position): (bool, i64) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id = ?1),
                COALESCE(MAX(position),0)
         FROM message_admissions WHERE session_id = ?1",
    )
    .bind(session)
    .fetch_one(&mut *tx)
    .await?;
    let position = position
        .checked_add(1)
        .ok_or_else(|| invalid("message queue position exhausted"))?;
    if admission.source.disposition == MessageDisposition::TurnStarted && pending {
        return Err(StoreError::SessionBusy);
    }
    sqlx::query("INSERT INTO message_admissions (session_id, message_id, position, record_json) VALUES (?, ?, ?, ?)")
        .bind(session).bind(message).bind(position).bind(encoded).execute(&mut *tx).await?;
    crate::sessions::retain(tx, session).await?;
    crate::message_queue::bump(tx, session).await.map(Some)
}
