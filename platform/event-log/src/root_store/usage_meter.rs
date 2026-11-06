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

//! Lifetime goal accounting reads fixed-size counters, never Session history.
use super::RootStore;
use crate::StoreError;
use maka_agent_facts::{
    accounting::Tokens,
    event::{Fact, RuntimeEvent},
    model::ModelUsage,
};
use rusqlite::{Connection as SqliteConnection, OptionalExtension};

const MAX_EXACT: u64 = (1 << 53) - 1;
const OVERFLOW: i64 = 1 << 53;
const READ: &str = "SELECT input_known,input_missing,output_known,output_missing FROM session_usage_totals WHERE session_id=?";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionUsageTotals {
    pub input: Tokens,
    pub output: Tokens,
}
impl RootStore {
    /// Physical settled usage, including auxiliary operation models.
    /// Pending calls do not become fabricated zero usage.
    pub async fn session_usage_totals(
        &self,
        session: &str,
    ) -> Result<SessionUsageTotals, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        let total = self
            .log
            .connection
            .read(move |db| read(db, &session))
            .await?;
        if total.iter().any(|value| *value > MAX_EXACT) {
            return Err(overflow());
        }
        Ok(SessionUsageTotals {
            input: Tokens {
                known: total[0],
                missing: total[1],
            },
            output: Tokens {
                known: total[2],
                missing: total[3],
            },
        })
    }
}
fn overflow() -> StoreError {
    StoreError::InvalidTransition("Usage aggregate exceeds exact integer capacity".into())
}
fn read(db: &SqliteConnection, session: &str) -> Result<[u64; 4], StoreError> {
    let row: Option<(i64, i64, i64, i64)> = db
        .query_row(READ, rusqlite::params![session], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .optional()?;
    let (a, b, c, d) = row.unwrap_or_default();
    Ok([
        crate::sequence_number(a)?,
        crate::sequence_number(b)?,
        crate::sequence_number(c)?,
        crate::sequence_number(d)?,
    ])
}
fn add(db: &SqliteConnection, session: &str, usage: &ModelUsage) -> Result<(), StoreError> {
    db.execute(
        "INSERT INTO session_usage_totals VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(session_id) DO UPDATE SET
        input_known=MIN(input_known+excluded.input_known,9007199254740992),
        input_missing=MIN(input_missing+excluded.input_missing,9007199254740992),
        output_known=MIN(output_known+excluded.output_known,9007199254740992),
        output_missing=MIN(output_missing+excluded.output_missing,9007199254740992)",
        rusqlite::params![
            session,
            usage.input_tokens.unwrap_or(0).min(OVERFLOW as u64) as i64,
            i64::from(usage.input_tokens.is_none()),
            usage.output_tokens.unwrap_or(0).min(OVERFLOW as u64) as i64,
            i64::from(usage.output_tokens.is_none())
        ],
    )?;
    Ok(())
}
fn observed(db: &SqliteConnection, invocation: &str, step: &str) -> Result<ModelUsage, StoreError> {
    let usage: Option<String> = db.query_row("SELECT accounting_usage FROM event_log INDEXED BY model_usage_observation
        WHERE kind='model_observed' AND json_extract(COALESCE(event_header,retained_json),'$.fact.event.kind')='finished'
        AND invocation_id=? AND json_extract(COALESCE(event_header,retained_json),'$.fact.step_id')=?
        ORDER BY sequence DESC LIMIT 1", rusqlite::params![invocation, step], |row| row.get(0)).optional()?;
    Ok(usage
        .map(|json| serde_json::from_str(&json))
        .transpose()?
        .unwrap_or_default())
}
fn settle_main(
    db: &SqliteConnection,
    event: &RuntimeEvent,
    step: &str,
    usage: Option<&ModelUsage>,
) -> Result<(), StoreError> {
    let session: String = db.query_row("DELETE FROM session_usage_pending WHERE operation_id=? AND invocation_id=? RETURNING session_id", rusqlite::params![step, &event.invocation.invocation_id], |row| row.get(0))?;
    let fallback;
    let usage = match usage {
        Some(usage) => usage,
        None => {
            fallback = observed(db, &event.invocation.invocation_id, step)?;
            &fallback
        }
    };
    add(db, &session, usage)
}
/// Called only for a newly inserted canonical fact, in that fact's transaction.
pub(crate) fn append(db: &SqliteConnection, event: &RuntimeEvent) -> Result<(), StoreError> {
    match &event.fact {
        Fact::ModelRequested { step_id, .. } => {
            db.execute(
                "INSERT INTO session_usage_pending VALUES(?,?,?,?)",
                rusqlite::params![
                    &event.id,
                    &event.invocation.invocation_id,
                    step_id,
                    &event.invocation.session_id
                ],
            )?;
        }
        Fact::ModelCompleted { step_id, output } => {
            settle_main(db, event, step_id, Some(&output.usage))?
        }
        Fact::ModelInterrupted { step_id, .. } => settle_main(db, event, step_id, None)?,
        Fact::InvocationEnded { .. } => loop {
            let step: Option<String> = db.query_row("SELECT operation_id FROM session_usage_pending WHERE invocation_id=? ORDER BY request_id LIMIT 1", rusqlite::params![&event.invocation.invocation_id], |row| row.get(0)).optional()?;
            let Some(step) = step else { break };
            settle_main(db, event, &step, None)?;
        },
        _ => {}
    }
    Ok(())
}
pub(crate) fn settle_auxiliary(
    db: &SqliteConnection,
    request: uuid::Uuid,
) -> Result<(), StoreError> {
    let session: Option<String> = db.query_row("SELECT json_extract(event_header,'$.session_id') FROM event_log WHERE event_id=? AND kind='auxiliary_model_started'", rusqlite::params![request.to_string()], |row| row.get(0))?;
    let Some(session) = session else {
        return Ok(());
    };
    let usage: Option<String> = db.query_row("SELECT accounting_usage FROM event_log INDEXED BY auxiliary_usage_meter_observation WHERE kind='auxiliary_model_usage' AND json_extract(COALESCE(event_header,retained_json),'$.request_id')=?", rusqlite::params![request.to_string()], |row| row.get(0)).optional()?;
    let usage = usage
        .map(|json| serde_json::from_str(&json))
        .transpose()?
        .unwrap_or_default();
    add(db, &session, &usage)
}

#[cfg(test)]
mod tests;
