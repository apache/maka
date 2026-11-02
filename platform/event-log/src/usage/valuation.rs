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
use sqlx::SqliteConnection;

pub(crate) async fn capture(
    connection: &mut SqliteConnection,
    id: &str,
    quote: &Quote,
) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO model_accounting(request_id, quote_json) VALUES(?, ?)")
        .bind(id)
        .bind(serde_json::to_string(quote)?)
        .execute(connection)
        .await?;
    Ok(())
}

pub(crate) async fn value(
    connection: &mut SqliteConnection,
    id: &str,
    usage: &ModelUsage,
) -> Result<(), StoreError> {
    let quote: Option<String> =
        sqlx::query_scalar("SELECT quote_json FROM model_accounting WHERE request_id = ?")
            .bind(id)
            .fetch_optional(&mut *connection)
            .await?;
    let Some(quote) = quote else {
        return Ok(());
    };
    let quote: Quote = serde_json::from_str(&quote)?;
    let usd = quote.estimate(usage).map_err(invalid)?;
    let usage = serde_json::to_string(usage)?;
    sqlx::query(
        "INSERT INTO model_valuations(request_id, usage_json, usd) VALUES(?, ?, ?)
         ON CONFLICT(request_id) DO NOTHING",
    )
    .bind(id)
    .bind(&usage)
    .bind(usd)
    .execute(&mut *connection)
    .await?;
    let same: bool = sqlx::query_scalar(
        "SELECT usage_json = ? AND usd IS ? FROM model_valuations WHERE request_id = ?",
    )
    .bind(usage)
    .bind(usd)
    .bind(id)
    .fetch_one(connection)
    .await?;
    if !same {
        return Err(StoreError::EventConflict);
    }
    Ok(())
}

pub(crate) async fn append(
    connection: &mut SqliteConnection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    let event = write.event();
    if let Some(quote) = write.quote() {
        capture(connection, &event.id, quote).await?;
    }
    let (step, usage) = match &event.fact {
        Fact::ModelObserved {
            step_id,
            event: ModelObservation::Finished { usage, .. },
        } => (step_id, usage),
        Fact::ModelCompleted { step_id, output } => (step_id, &output.usage),
        _ => return Ok(()),
    };
    let id: String = sqlx::query_scalar(
        "SELECT event_id FROM event_log WHERE kind = 'model_requested' AND operation_id = ? AND invocation_id = ?"
    ).bind(step).bind(&event.invocation.invocation_id).fetch_one(&mut *connection).await?;
    value(connection, &id, usage).await
}

pub(crate) async fn verify_replay(
    connection: &mut SqliteConnection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT quote_json FROM model_accounting WHERE request_id = ?")
            .bind(&write.event().id)
            .fetch_optional(connection)
            .await?;
    let submitted = write.quote().map(serde_json::to_string).transpose()?;
    if stored != submitted {
        return Err(StoreError::EventConflict);
    }
    Ok(())
}
