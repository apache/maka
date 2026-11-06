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

//! A physical native interruption belongs to the canonical logical Turn.
//!
//! These are Host-control observations, not replayable RuntimeEvents or grants.
//! The Host accepts only the native owner's sealed bound-event callback.

use crate::{EventLog, StoreError};
use maka_agent_facts::{
    event::Invocation,
    tool_call::{HostSdkParent, ToolOrigin},
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

/// Immutable routing from the native owner's validated physical-Esc observation.
/// This data is not a physical proof: the embedding must first consume the sealed
/// native event. No model service or JSON transport may publish this record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeInterruption {
    pub opening: Invocation,
    pub operation_id: String,
    pub native_epoch: String,
    pub native_generation: String,
}

/// Persistence is independent of the physical input release acknowledgement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterruptionCommit {
    Recorded { sequence: u64 },
    Superseded,
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
impl NativeInterruption {
    fn validate(&self) -> Result<(), StoreError> {
        for id in [
            &self.opening.session_id,
            &self.opening.turn_id,
            &self.opening.run_id,
            &self.opening.invocation_id,
            &self.operation_id,
            &self.native_epoch,
            &self.native_generation,
        ] {
            crate::sessions::validate_id(id)?;
        }
        Ok(())
    }
}
impl EventLog {
    /// Called exclusively after the Host consumes the sealed native event and
    /// compares its captured invocation/operation/epoch. T1 alone is not Esc.
    /// The callback's accepted original future must remain owned until this
    /// transaction settles, including after its initiating observer disappears.
    pub async fn record_native_turn_interruption(
        &self,
        observed: NativeInterruption,
    ) -> Result<InterruptionCommit, StoreError> {
        self.check_bound_session(&observed.opening.session_id)?;
        observed.validate()?;
        let commits = self.commits.session(&observed.opening.session_id);
        self.connection.run(move |connection| {
            let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
            source(&tx, &observed)?;
            let latest = crate::turns::read(&tx, &observed.opening.session_id, None)?;
            if latest.is_none_or(|current| current.invocation.turn_id != observed.opening.turn_id
                || current.state.terminal_outcome().is_some()) {
                return Ok(InterruptionCommit::Superseded);
            }
            if let Some((sequence, _)) = interruption(&tx, &observed.opening.session_id, &observed.opening.turn_id)? {
                return Ok(InterruptionCommit::Recorded { sequence });
            }
            tx.execute("INSERT INTO event_log(event_id,kind,event_header,canonical_bytes) VALUES (?1,'native_turn_interrupted',?2,length(CAST(?2 AS BLOB)))", rusqlite::params![uuid::Uuid::new_v4().to_string(), serde_json::to_string(&observed)?])?;
            let sequence = crate::sequence_number(tx.last_insert_rowid())?;
            tx.commit().map_err(StoreError::CommitUnknown)?;
            commits.publish(sequence);
            Ok(InterruptionCommit::Recorded { sequence })
        }).await
    }
}

fn source(tx: &Connection, observed: &NativeInterruption) -> Result<(), StoreError> {
    // Compacted T1 retains its real invocation/call identity. Never require or
    // reconstruct the collected input body merely to observe a later Esc.
    let encoded: Option<(String, String)> = tx.query_row("SELECT json_extract(COALESCE(event_header,retained_json),'$.invocation'),
                json_extract(COALESCE(event_header,retained_json),'$.fact.call')
         FROM event_log e WHERE invocation_id=? AND operation_id=? AND kind='tool_dispatched'
           AND NOT EXISTS (SELECT 1 FROM imported_invocations i WHERE i.invocation_id=e.invocation_id)", rusqlite::params![&observed.opening.invocation_id, &observed.operation_id], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
    let (opening, call) =
        encoded.ok_or_else(|| invalid("native interruption has no original durable dispatch"))?;
    let opening: Invocation = serde_json::from_str(&opening)?;
    let call: maka_agent_facts::tool_call::ToolCallIdentity = serde_json::from_str(&call)?;
    if opening != observed.opening
        || !matches!(call.origin,
        ToolOrigin::HostSdk { parent: Some(HostSdkParent::EvaluationObserver {
            epoch, .. }), .. } if epoch == observed.native_epoch)
    {
        return Err(invalid(
            "native interruption differs from its original dispatch binding",
        ));
    }
    Ok(())
}

fn interruption(
    tx: &Connection,
    session: &str,
    turn: &str,
) -> Result<Option<(u64, NativeInterruption)>, StoreError> {
    let row: Option<(i64, String)> = tx
        .query_row(
            "SELECT sequence,event_header FROM event_log INDEXED BY native_turn_interruption_lookup
         WHERE kind='native_turn_interrupted'
           AND json_extract(event_header,'$.opening.session_id')=?
           AND json_extract(event_header,'$.opening.turn_id')=?",
            rusqlite::params![session, turn],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    row.map(|(sequence, body)| {
        let observed: NativeInterruption = serde_json::from_str(&body)?;
        observed.validate()?;
        if observed.opening.session_id != session || observed.opening.turn_id != turn {
            return Err(invalid("stored native interruption identity changed"));
        }
        Ok((crate::sequence_number(sequence)?, observed))
    })
    .transpose()
}

/// The original native T1 and physical-Esc fact serialize on this same writer.
/// A browser/JS dispatch never calls this predicate. Cleanup never creates T1.
pub(crate) fn require_native_turn_running(
    tx: &Connection,
    invocation: &Invocation,
) -> Result<(), StoreError> {
    if interruption(tx, &invocation.session_id, &invocation.turn_id)?.is_some() {
        return Err(StoreError::NativeTurnInterrupted);
    }
    Ok(())
}
