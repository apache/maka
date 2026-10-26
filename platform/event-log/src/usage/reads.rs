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
use maka_agent_facts::accounting::ActivityKind;
use maka_agent_facts::accounting::ActivityStatus;
use maka_agent_facts::accounting::Selection;
use serde::Serialize;
use sqlx::{Connection, QueryBuilder, sqlite::SqliteRow};

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

    fn restrict(&self, sql: &mut QueryBuilder<sqlx::Sqlite>, query: &Query, through: u64) {
        query.restrict(sql, through);
        if let Self::Activity(selection) = self {
            if let Some(kind) = selection.kind {
                sql.push(" AND kind = ").push_bind(match kind {
                    ActivityKind::Model => "model",
                    ActivityKind::Tool => "tool",
                });
            }
            if let Some(status) = selection.status {
                sql.push(" AND status = ").push_bind(match status {
                    ActivityStatus::Success => "success",
                    ActivityStatus::Error => "error",
                    ActivityStatus::Aborted => "aborted",
                    ActivityStatus::Unknown => "unknown",
                    ActivityStatus::Rejected => "rejected",
                });
            }
            if !selection.search.is_empty() {
                sql.push(" AND instr(lower(search), lower(")
                    .push_bind(selection.search.clone())
                    .push(")) > 0");
            }
        }
    }
}

pub(super) async fn page<T: Serialize + Send + 'static>(
    log: &EventLog,
    query: Query,
    offset: u64,
    limit: u32,
    view: View,
    read: fn(&SqliteRow) -> Result<T, StoreError>,
) -> Result<Page<T>, StoreError> {
    log.validate_root()?;
    query.validate()?;
    if offset > i64::MAX as u64 || !(1..=100).contains(&limit) {
        return Err(invalid("invalid Usage page"));
    }
    log.connection
        .run(move |connection| {
            Box::pin(async move {
                let mut tx = connection.begin().await?;
                let through = query.fence(&mut tx).await?;
                // Only closed internal view/column identifiers are interpolated.
                let mut count = QueryBuilder::new("SELECT COUNT(*) FROM ");
                count.push(view.table());
                view.restrict(&mut count, &query, through);
                let total: i64 = count.build_query_scalar().fetch_one(&mut *tx).await?;
                let mut select = QueryBuilder::new("SELECT ");
                select
                    .push(view.columns())
                    .push(" FROM ")
                    .push(view.table());
                view.restrict(&mut select, &query, through);
                select
                    .push(" ORDER BY completed_at DESC, sequence DESC LIMIT ")
                    .push_bind(limit)
                    .push(" OFFSET ")
                    .push_bind(offset as i64);
                let rows = select.build().fetch_all(&mut *tx).await?;
                let mut attempts = Vec::with_capacity(rows.len());
                // Leave envelope/cursor headroom. Never truncate one accounting fact.
                let mut bytes = 0;
                for row in &rows {
                    let attempt = read(row)?;
                    let size = serde_json::to_vec(&attempt)?.len() + 1;
                    if bytes + size > 32 * 1024 {
                        if attempts.is_empty() {
                            return Err(invalid("one Usage record exceeds page capacity"));
                        }
                        break;
                    }
                    bytes += size;
                    attempts.push(attempt);
                }
                let total = crate::sequence_number(total)?;
                let end = offset + attempts.len() as u64;
                tx.commit().await?;
                Ok(Page {
                    through,
                    attempts,
                    total,
                    next_offset: (end < total).then_some(end),
                })
            })
        })
        .await
}

/// Each partition's contribution to the Root's bounded keyset merge. The first
/// query captures its own settlement fence in the same read transaction.
pub(crate) async fn activity_after(
    log: &EventLog,
    query: Query,
    selection: Selection,
    partition: usize,
    after: Option<crate::root_store::UsageActivityCursor>,
) -> Result<Page<super::Activity>, StoreError> {
    log.validate_root()?;
    query.validate()?;
    selection.validate().map_err(invalid)?;
    log.connection
        .read(move |connection| {
            Box::pin(async move {
                let mut tx = connection.begin().await?;
                let through = query.fence(&mut tx).await?;
                let view = View::Activity(selection);
                let mut count = QueryBuilder::new("SELECT COUNT(*) FROM usage_activity");
                view.restrict(&mut count, &query, through);
                let total: i64 = count.build_query_scalar().fetch_one(&mut *tx).await?;
                let mut select = QueryBuilder::new("SELECT ");
                select.push(view.columns()).push(" FROM usage_activity");
                view.restrict(&mut select, &query, through);
                if let Some(after) = after {
                    select
                        .push(" AND (completed_at < ")
                        .push_bind(after.completed_at);
                    if partition >= after.partition {
                        select
                            .push(" OR (completed_at = ")
                            .push_bind(after.completed_at);
                        if partition == after.partition {
                            select.push(" AND event_id > ").push_bind(after.request_id);
                        }
                        select.push(")");
                    }
                    select.push(")");
                }
                select.push(" ORDER BY completed_at DESC, event_id LIMIT 33");
                let rows = select.build().fetch_all(&mut *tx).await?;
                let attempts = rows
                    .iter()
                    .map(super::read_activity)
                    .collect::<Result<Vec<_>, _>>()?;
                // Fixed 33 records per partition; one oversized fact is never truncated.
                for attempt in &attempts {
                    if serde_json::to_vec(attempt)?.len() > 32 * 1024 {
                        return Err(invalid("one Usage record exceeds page capacity"));
                    }
                }
                tx.commit().await?;
                Ok(Page {
                    through,
                    attempts,
                    total: crate::sequence_number(total)?,
                    next_offset: None,
                })
            })
        })
        .await
}
