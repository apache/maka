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

//! Immutable request quotes and valuations committed with their source facts.
use super::invalid;
use crate::StoreError;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::model::recorded::ModelObservation;
use maka_agent_facts::pricing::Quote;
use rusqlite::{OptionalExtension, params};

pub(crate) fn capture(
    connection: &rusqlite::Connection,
    id: &str,
    quote: &Quote,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO model_accounting(request_id, quote_json) VALUES(?, ?)",
        params![id, serde_json::to_string(quote)?],
    )?;
    Ok(())
}

pub(crate) fn value(
    connection: &rusqlite::Connection,
    id: &str,
    usage: &ModelUsage,
) -> Result<(), StoreError> {
    let quote: Option<String> = connection
        .query_row(
            "SELECT quote_json FROM model_accounting WHERE request_id = ?",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(quote) = quote else {
        return Ok(());
    };
    let quote: Quote = serde_json::from_str(&quote)?;
    let usd = quote.estimate(usage).map_err(invalid)?;
    let usage = serde_json::to_string(usage)?;
    connection.execute(
        "INSERT INTO model_valuations(request_id, usage_json, usd) VALUES(?, ?, ?)
         ON CONFLICT(request_id) DO NOTHING",
        params![id, &usage, usd],
    )?;
    let same: bool = connection.query_row(
        "SELECT usage_json = ? AND usd IS ? FROM model_valuations WHERE request_id = ?",
        params![usage, usd, id],
        |row| row.get(0),
    )?;
    if !same {
        return Err(StoreError::EventConflict);
    }
    Ok(())
}

pub(crate) fn append(
    connection: &rusqlite::Connection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    let event = write.event();
    if let Some(quote) = write.quote() {
        capture(connection, &event.id, quote)?;
    }
    let (step, usage) = match &event.fact {
        Fact::ModelObserved {
            step_id,
            event: ModelObservation::Finished { usage, .. },
        } => (step_id, usage),
        Fact::ModelCompleted { step_id, output } => (step_id, &output.usage),
        _ => return Ok(()),
    };
    let id: String = connection.query_row("SELECT event_id FROM event_log WHERE kind = 'model_requested' AND operation_id = ? AND invocation_id = ?", params![step, &event.invocation.invocation_id], |row| row.get(0))?;
    value(connection, &id, usage)
}

pub(crate) fn verify_replay(
    connection: &rusqlite::Connection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT quote_json FROM model_accounting WHERE request_id = ?",
            params![&write.event().id],
            |row| row.get(0),
        )
        .optional()?;
    let submitted = write.quote().map(serde_json::to_string).transpose()?;
    if stored != submitted {
        return Err(StoreError::EventConflict);
    }
    Ok(())
}
