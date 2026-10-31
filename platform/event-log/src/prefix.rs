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

use maka_agent_facts::event::LogPrefix;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::StoredEvent;
use sqlx::Connection;

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
        let collected: bool = match &selection.session {
            Some(session) => sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM context_source_prefixes p
                 JOIN event_log e ON e.sequence=p.sequence
                 WHERE p.kind='session' AND p.owner=? AND e.event_header IS NULL)",
            ).bind(session).fetch_one(&mut *transaction).await?,
            None => sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM event_log INDEXED BY invocation_sequence
                 WHERE invocation_id IS NOT NULL AND event_header IS NULL)",
            ).fetch_one(&mut *transaction).await?,
        };
        if collected { return Err(StoreError::MaterialCollected); }
        let lineage = Selection::predicate("e", "?2");
        let source = if selection.session.is_some() { "session_history_events" } else { "runtime_events" };
        let session_filter = if selection.session.is_some() {
            "owner_session_id=?1"
        } else { "?1 IS NULL" };
        let filter = format!("{session_filter} AND {lineage}");
        // Only internal SQL clauses are formatted; all identities remain bound.
        let budget = sqlx::query_as::<_, (i64, i64, i64)>(sqlx::AssertSqlSafe(format!(
            "SELECT COALESCE(MAX(sequence), 0), COUNT(*), COALESCE(SUM(canonical_bytes), 0) FROM {source} e WHERE {filter}"
        ))).bind(&selection.session).bind(&selection.lineage);
        let (high_water, count, bytes) = budget.fetch_one(&mut *transaction).await?;
        if sequence_number(count)? > max_events as u64 || sequence_number(bytes)? > max_bytes as u64
        {
            return Err(StoreError::PrefixTooLarge);
        }
        let query = format!(
            "SELECT e.sequence,e.event_header,{columns} FROM {source} e {joins} WHERE {filter} ORDER BY e.sequence",
            columns=crate::canonical::COLUMNS,joins=crate::canonical::JOINS
        );
        let session = selection.session.clone();
        let selected_lineage = selection.lineage.clone();
        let root_scope = session.is_none();
        let (events, root_digest) = if count == 0 {
            (Vec::new(), root_scope.then(crate::context::evidence::RootDigest::new))
        } else { crate::connection::worker_query(&mut transaction, move |worker| Box::pin(async move {
            // SAFETY: this callback exclusively owns the original SQLite worker.
            // The wrapper and all borrowed rows/statements close before return.
            let raw = unsafe { rusqlite::Connection::from_handle(worker.as_raw_handle().as_ptr()) }?;
            let result = (|| {
                let mut digest = session.is_none().then(crate::context::evidence::RootDigest::new);
                let mut events = Vec::new();
                let mut statement = raw.prepare(&query)?;
                let mut rows = statement.query(rusqlite::params![session, selected_lineage])?;
                while let Some(row) = rows.next()? {
                    let sequence: i64 = row.get("sequence")?;
                    let event = crate::canonical::decode_event_on_handle(row, |parts| {
                        if let Some(digest) = &mut digest { digest.record(sequence, &parts); }
                    })?;
                    events.push(StoredEvent { sequence: sequence_number(sequence)?, event });
                }
                if events.len() as u64 != sequence_number(count)? {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,
                        "prefix decoder stopped before completing the admitted snapshot").into());
                }
                Ok((events, digest))
            })();
            drop(raw);
            result
        })).await? };
        let digest = match root_digest {
            Some(digest) => digest.finish(high_water)?,
            None => crate::context::evidence::selected(
                &mut transaction, &selection, sequence_number(high_water)?).await?.digest,
        };
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
