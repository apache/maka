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

use futures_util::TryStreamExt;
use maka_agent_facts::event::LogPrefix;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::StoredEvent;
use sqlx::{Connection, Row};

use crate::{EventLog, StoreError, context::selection::Selection, sequence_number};

impl EventLog {
    /// Read one complete bounded execution prefix, or fail without returning a partial
    /// history that a caller could accidentally treat as complete. Session-owned
    /// control facts share the ledger order but are not execution history.
    pub async fn prefix(
        &self,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<LogPrefix, StoreError> {
        self.scoped_prefix(LogScope::Root, max_events, max_bytes)
            .await
    }

    /// Bounds apply only to events in scope; exceeding either bound is an error.
    /// Membership, budget and contents are read from the same SQLite snapshot.
    pub async fn scoped_prefix(
        &self,
        scope: LogScope,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<LogPrefix, StoreError> {
        self.validate_root()?;
        self.connection.run(move |connection| Box::pin(async move {
        let mut transaction = connection.begin().await?;
        let selection = Selection::resolve(&mut transaction, &scope).await?;
        let collected: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM event_log WHERE invocation_id IS NOT NULL
             AND event_json IS NULL AND (?1 IS NULL OR event_session=?1))"
        ).bind(&selection.session).fetch_one(&mut *transaction).await?;
        if collected { return Err(StoreError::MaterialCollected); }
        let lineage = Selection::predicate("runtime_events", "?2");
        let source = if selection.session.is_some() { "session_history_events" } else { "runtime_events" };
        let session_filter = if selection.session.is_some() {
            "owner_session_id=?1"
        } else { "?1 IS NULL" };
        let filter = format!("{session_filter} AND {lineage}");
        // Only internal SQL clauses are formatted; all identities remain bound.
        let budget = sqlx::query_as::<_, (i64, i64, i64)>(sqlx::AssertSqlSafe(format!(
            "SELECT COALESCE(MAX(sequence), 0), COUNT(*), COALESCE(SUM(length(CAST(event_json AS BLOB))), 0) FROM {source} runtime_events WHERE {filter}"
        ))).bind(&selection.session).bind(&selection.lineage);
        let (high_water, count, bytes) = budget.fetch_one(&mut *transaction).await?;
        if sequence_number(count)? > max_events as u64 || sequence_number(bytes)? > max_bytes as u64
        {
            return Err(StoreError::PrefixTooLarge);
        }
        let mut events = Vec::new();
        {
            let statement = sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT sequence, event_json FROM {source} runtime_events WHERE {filter} ORDER BY sequence"
            ))).bind(&selection.session).bind(&selection.lineage);
            let mut rows = statement.fetch(&mut *transaction);
            while let Some(row) = rows.try_next().await? {
                let sequence: i64 = row.try_get(0)?;
                let json: &str = row.try_get(1)?;
                let sequence = sequence_number(sequence)?;
                let event = serde_json::from_str(json)?;
                events.push(StoredEvent {
                    sequence,
                    event,
                });
            }
        }
        let digest = crate::context::evidence::selected(
            &mut transaction, &selection, sequence_number(high_water)?).await?.digest;
        transaction.commit().await?;
        Ok(LogPrefix {
            scope,
            high_water: sequence_number(high_water)?,
            digest,
            events,
        })
        })).await
    }
}
