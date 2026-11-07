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

use super::{EventLog, Page, Query, StoreError, invalid};
use maka_agent_facts::accounting::{ActivityKind, ActivityStatus, Selection};
use rusqlite::params;
use serde::Serialize;

pub(super) enum View {
    Models,
    Tools,
    Activity(Selection),
}
impl View {
    fn table(&self) -> &'static str {
        match self {
            Self::Models => "model_usage",
            Self::Tools => "tool_usage",
            Self::Activity(_) => "usage_activity",
        }
    }
    fn columns(&self) -> &'static str {
        match self {
            Self::Models => {
                "event_id, origin, session_id, binding, model_id, started_at, completed_at, outcome, usage, quote_json, usd"
            }
            Self::Tools => "event_id, invocation, call, name, binding, completed_at, result",
            Self::Activity(_) => {
                "kind, event_id, origin, session_id, binding, model_id, started_at, completed_at, outcome, usage, quote_json, usd, invocation, call, name, result"
            }
        }
    }
    fn filters(&self) -> (Option<&'static str>, Option<&'static str>, &str) {
        match self {
            Self::Models | Self::Tools => (None, None, ""),
            Self::Activity(selection) => (
                selection.kind.map(|kind| match kind {
                    ActivityKind::Model => "model",
                    ActivityKind::Tool => "tool",
                }),
                selection.status.map(|status| match status {
                    ActivityStatus::Success => "success",
                    ActivityStatus::Error => "error",
                    ActivityStatus::Aborted => "aborted",
                    ActivityStatus::Unknown => "unknown",
                    ActivityStatus::Rejected => "rejected",
                }),
                &selection.search,
            ),
        }
    }
    fn predicate(&self, query: &Query) -> String {
        let mut predicate = query.predicate();
        if matches!(self, Self::Activity(_)) {
            predicate.push_str(" AND (?5 IS NULL OR kind = ?5) AND (?6 IS NULL OR status = ?6) AND instr(lower(search), lower(?7)) > 0");
        } else {
            // Keep a fixed parameter layout for all closed views.
            predicate.push_str(" AND ?5 IS NULL AND ?6 IS NULL AND ?7 = ''");
        }
        predicate
    }
}

pub(super) async fn page<T: Serialize + Send + 'static>(
    log: &EventLog,
    query: Query,
    offset: u64,
    limit: u32,
    view: View,
    read: fn(&rusqlite::Row<'_>) -> Result<T, StoreError>,
) -> Result<Page<T>, StoreError> {
    log.validate_root()?;
    query.validate()?;
    if offset > i64::MAX as u64 || limit == 0 {
        return Err(invalid("invalid Usage page"));
    }
    log.connection.read(move |connection| {
        let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Deferred)?;
        let through = query.fence(&tx)?;
        let (kind, status, search) = view.filters();
        let predicate = view.predicate(&query);
        let total: i64 = tx.query_row(&format!("SELECT COUNT(*) FROM {}{predicate}", view.table()),
            params![query.from, query.to, through as i64, query.session_id, kind, status, search], |row| row.get(0))?;
        let attempts = {
            let mut statement = tx.prepare_cached(&format!("SELECT {} FROM {}{predicate} ORDER BY completed_at DESC, sequence DESC LIMIT ?8 OFFSET ?9", view.columns(), view.table()))?;
            let mut rows = statement.query(params![query.from, query.to, through as i64, query.session_id, kind, status, search, limit, offset as i64])?;
            let mut attempts = Vec::new();
            while let Some(row) = rows.next()? { attempts.push(read(row)?); }
            attempts
        };
        let total = crate::sequence_number(total)?;
        let end = offset + attempts.len() as u64;
        tx.commit()?;
        Ok(Page { through, attempts, total, next_offset: (end < total).then_some(end) })
    }).await
}

pub(crate) async fn activity_after(
    log: &EventLog,
    query: Query,
    selection: Selection,
    after: Option<crate::root_store::UsageActivityCursor>,
) -> Result<Page<super::Activity>, StoreError> {
    log.validate_root()?;
    query.validate()?;
    selection.validate().map_err(invalid)?;
    log.connection
        .read(move |connection| {
            let tx = rusqlite::Transaction::new_unchecked(
                connection,
                rusqlite::TransactionBehavior::Deferred,
            )?;
            let through = query.fence(&tx)?;
            let view = View::Activity(selection);
            let (kind, status, search) = view.filters();
            let predicate = view.predicate(&query);
            let total: i64 = tx.query_row(
                &format!("SELECT COUNT(*) FROM usage_activity{predicate}"),
                params![
                    query.from,
                    query.to,
                    through as i64,
                    query.session_id,
                    kind,
                    status,
                    search
                ],
                |row| row.get(0),
            )?;
            let attempts = {
                let mut statement = tx.prepare_cached(&format!(
                    "SELECT {} FROM usage_activity{predicate}
                AND (?8 IS NULL OR completed_at < ?8 OR (completed_at = ?8 AND event_id > ?9))
                ORDER BY completed_at DESC, event_id LIMIT 33",
                    view.columns()
                ))?;
                let mut rows = statement.query(params![
                    query.from,
                    query.to,
                    through as i64,
                    query.session_id,
                    kind,
                    status,
                    search,
                    after.as_ref().map(|after| after.completed_at),
                    after.as_ref().map(|after| after.request_id.as_str())
                ])?;
                let mut attempts = Vec::new();
                while let Some(row) = rows.next()? {
                    attempts.push(super::read_activity(row)?);
                }
                attempts
            };
            tx.commit()?;
            Ok(Page {
                through,
                attempts,
                total: crate::sequence_number(total)?,
                next_offset: None,
            })
        })
        .await
}
