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

//! Accounting reads use physical source facts, never copied conversation history.
//! Missing counters remain unknown; this layer makes no pricing assumptions.

use crate::{EventLog, StoreError};
pub use maka_agent_facts::accounting::Activity;
pub use maka_agent_facts::accounting::AuxiliarySource;
pub use maka_agent_facts::accounting::ModelAttempt;
pub use maka_agent_facts::accounting::Origin;
pub use maka_agent_facts::accounting::Outcome;
pub use maka_agent_facts::accounting::Selection;
pub use maka_agent_facts::accounting::ToolAttempt;
use sqlx::{Row, sqlite::SqliteRow};

mod auxiliary;
pub(crate) mod reads;
mod summary;
pub use summary::Report;
pub(crate) mod valuation;

#[derive(Clone, Debug)]
pub struct Query {
    /// Inclusive Unix milliseconds; fractional milliseconds are not rounded.
    pub from: f64,
    pub to: f64,
    pub session_id: Option<String>,
    /// Inclusive canonical fence from the first page, independent of wall-clock time.
    pub through: Option<u64>,
}

impl Query {
    /// Capture inside the same read transaction as every section of the result.
    async fn fence(&self, connection: &mut sqlx::SqliteConnection) -> Result<u64, StoreError> {
        let current = crate::sequence_number(
            sqlx::query_scalar("SELECT COALESCE(MAX(sequence), 0) FROM event_log")
                .fetch_one(connection)
                .await?,
        )?;
        let through = self.through.unwrap_or(current);
        if through > current {
            return Err(invalid("Usage fence is in the future"));
        }
        Ok(through)
    }

    fn restrict(&self, sql: &mut sqlx::QueryBuilder<sqlx::Sqlite>, through: u64) {
        sql.push(" WHERE completed_at >= ")
            .push_bind(self.from)
            .push(" AND completed_at <= ")
            .push_bind(self.to)
            .push(" AND completed_sequence <= ")
            .push_bind(through as i64);
        if let Some(session) = &self.session_id {
            sql.push(" AND session_id = ").push_bind(session.clone());
        }
    }

    pub(crate) fn validate(&self) -> Result<(), StoreError> {
        if !self.from.is_finite() || !self.to.is_finite() || self.from < 0.0 || self.to < self.from
        {
            return Err(invalid("invalid Usage time range"));
        }
        if let Some(id) = &self.session_id {
            crate::sessions::validate_id(id)?;
        }
        Ok(())
    }
}

pub struct Page<T> {
    pub through: u64,
    pub attempts: Vec<T>,
    pub total: u64,
    pub next_offset: Option<u64>,
}

impl EventLog {
    pub async fn usage_activity(
        &self,
        query: Query,
        selection: Selection,
        offset: u64,
        limit: u32,
    ) -> Result<Page<Activity>, StoreError> {
        selection.validate().map_err(invalid)?;
        reads::page(
            self,
            query,
            offset,
            limit,
            reads::View::Activity(selection),
            read_activity,
        )
        .await
    }

    /// Settled physical admissions, not copied conversation membership.
    pub async fn model_attempts(
        &self,
        query: Query,
        offset: u64,
        limit: u32,
    ) -> Result<Page<ModelAttempt>, StoreError> {
        reads::page(self, query, offset, limit, reads::View::Models, read).await
    }

    /// Dispatched tools and known refusals, without inputs or result bodies.
    pub async fn tool_attempts(
        &self,
        query: Query,
        offset: u64,
        limit: u32,
    ) -> Result<Page<ToolAttempt>, StoreError> {
        reads::page(self, query, offset, limit, reads::View::Tools, read_tool).await
    }
}

fn read(row: &SqliteRow) -> Result<ModelAttempt, StoreError> {
    let outcome: String = row.try_get("outcome")?;
    Ok(ModelAttempt {
        request_id: row.try_get("event_id")?,
        origin: serde_json::from_str(row.try_get("origin")?)?,
        session_id: row.try_get("session_id")?,
        binding: row
            .try_get::<Option<&str>, _>("binding")?
            .map(serde_json::from_str)
            .transpose()?,
        model_id: row.try_get("model_id")?,
        started_at: row.try_get("started_at")?,
        completed_at: row.try_get("completed_at")?,
        outcome: serde_json::from_value(serde_json::Value::String(outcome))?,
        usage: serde_json::from_str(row.try_get("usage")?)?,
        quote: row
            .try_get::<Option<&str>, _>("quote_json")?
            .map(serde_json::from_str)
            .transpose()?,
        cost_usd: row.try_get("usd")?,
    })
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

fn read_tool(row: &SqliteRow) -> Result<ToolAttempt, StoreError> {
    Ok(ToolAttempt {
        request_id: row.try_get("event_id")?,
        invocation: serde_json::from_str(row.try_get("invocation")?)?,
        call: serde_json::from_str(row.try_get("call")?)?,
        name: row.try_get("name")?,
        binding: row
            .try_get::<Option<&str>, _>("binding")?
            .map(serde_json::from_str)
            .transpose()?,
        completed_at: row.try_get("completed_at")?,
        result: serde_json::from_str(row.try_get("result")?)?,
    })
}

fn read_activity(row: &SqliteRow) -> Result<Activity, StoreError> {
    match row.try_get::<&str, _>("kind")? {
        "model" => Ok(Activity::Model(read(row)?)),
        "tool" => Ok(Activity::Tool(read_tool(row)?)),
        _ => Err(invalid("invalid accounting activity kind")),
    }
}
