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

//! Accounting cuts are read on one Root DEFERRED snapshot, never current projections.
use super::*;
use maka_agent_facts::accounting::{Group, Selection};
use maka_event_log::connection::Query;
use rusqlite::{Connection, types::Value};
mod activity;
mod summary;

const MAX_EXACT: u64 = 9_007_199_254_740_991;

impl UsageStore {
    pub async fn activity(
        &self,
        query: UsageQuery,
        selection: Selection,
        after: Option<UsageActivityCursor>,
    ) -> Result<UsageActivityPage, Error> {
        validate(&query)?;
        selection.validate().map_err(|e| Error::Invalid(e.into()))?;
        if after.as_ref().is_some_and(|cursor| {
            query.through.is_none()
                || !cursor.completed_at.is_finite()
                || cursor.completed_at < query.from
                || cursor.completed_at > query.to
                || cursor.request_id.is_empty()
                || cursor.request_id.chars().any(char::is_control)
        }) {
            return Err(Error::Invalid("invalid activity cursor".into()));
        }
        Ok(self
            .data
            .query(activity::Read {
                query,
                selection,
                after,
                domain: self.data.root_id()?,
            })
            .await?)
    }

    pub async fn summary(
        &self,
        query: UsageQuery,
        group: Group,
        after: Option<UsageGroupCursor>,
    ) -> Result<UsageReport, Error> {
        validate(&query)?;
        if after.as_ref().is_some_and(|cursor| {
            query.through.is_none()
                || cursor.group != group
                || (cursor.key.is_none() && group != Group::ByProvider)
                || cursor
                    .key
                    .as_ref()
                    .is_some_and(|key| key.chars().any(char::is_control))
        }) {
            return Err(Error::Invalid("invalid group cursor".into()));
        }
        Ok(self
            .data
            .query(summary::Read {
                query,
                group: Some(group),
                after,
                domain: self.data.root_id()?,
            })
            .await?)
    }

    pub async fn totals(&self, query: UsageQuery) -> Result<UsageReport, Error> {
        validate(&query)?;
        Ok(self
            .data
            .query(summary::Read {
                query,
                group: None,
                after: None,
                domain: self.data.root_id()?,
            })
            .await?)
    }

    /// Read on the caller's original Root transaction; never enqueues another writer job.
    pub fn session_totals_in_transaction(
        &self,
        connection: &Connection,
        owner: RunOwner,
        session: &str,
    ) -> Result<SessionUsageTotals, StoreError> {
        let query = UsageQuery {
            from: 0.0,
            to: 9_007_199_254_740_991.0,
            owner: Some(owner),
            session_id: Some(session.into()),
            through: None,
        };
        validate(&query).map_err(|error| invalid(error.to_string()))?;
        summary::SessionTotals {
            query,
            domain: self.data.root_id()?,
        }
        .execute(connection)
    }

    pub async fn session_totals(
        &self,
        owner: RunOwner,
        session: &str,
    ) -> Result<SessionUsageTotals, Error> {
        let query = UsageQuery {
            from: 0.0,
            to: 9_007_199_254_740_991.0,
            owner: Some(owner),
            session_id: Some(session.into()),
            through: None,
        };
        validate(&query)?;
        Ok(self
            .data
            .query(summary::SessionTotals {
                query,
                domain: self.data.root_id()?,
            })
            .await?)
    }
}

fn validate(query: &UsageQuery) -> Result<(), Error> {
    query.validate()?;
    if let Some(owner) = &query.owner {
        owner
            .namespace
            .validate()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        if owner.deployment.is_nil() {
            return Err(Error::Invalid("invalid owner deployment".into()));
        }
    }
    Ok(())
}

fn fence(db: &Connection, query: &UsageQuery, domain: &str) -> Result<UsageFence, StoreError> {
    let (sequence, auxiliary_sequence, cell_sequence): (i64, i64, i64) = db.query_row(
        "SELECT (SELECT COALESCE(MAX(sequence),0) FROM agent_facts),
                (SELECT COALESCE(MAX(sequence),0) FROM agent_usage_aux_events),
                (SELECT COALESCE(MAX(sequence),0) FROM agent_standalone_cell_events)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let current = UsageFence {
        schema_version: SCHEMA_VERSION,
        state_domain: domain.into(),
        sequence: unsigned(sequence)?,
        auxiliary_sequence: unsigned(auxiliary_sequence)?,
        cell_sequence: unsigned(cell_sequence)?,
        query_digest: query.digest()?,
    };
    if let Some(original) = &query.through {
        if original.schema_version != current.schema_version
            || original.state_domain != current.state_domain
            || original.query_digest != current.query_digest
            || original.sequence > current.sequence
            || original.auxiliary_sequence > current.auxiliary_sequence
            || original.cell_sequence > current.cell_sequence
        {
            return Err(invalid("foreign, unsupported or future usage fence"));
        }
        Ok(original.clone())
    } else {
        Ok(current)
    }
}

// Parameters ?1..=?5 are the inclusive wall-clock range and the three canonical cuts.
// All owner/session predicates are concrete equality constraints when selected.
fn scope(
    db: &Connection,
    query: &UsageQuery,
    through: &UsageFence,
) -> Result<(String, Vec<Value>), StoreError> {
    let mut values = vec![
        Value::Real(query.from),
        Value::Real(query.to),
        Value::Integer(integer(through.sequence)?),
        Value::Integer(integer(through.auxiliary_sequence)?),
        Value::Integer(integer(through.cell_sequence)?),
    ];
    let mut predicate = String::new();
    match (&query.owner, &query.session_id) {
        (Some(owner), Some(session)) => {
            if let Some(ns_id) = crate::namespace::find_owner_id(db, owner, session)? {
                values.push(Value::Integer(ns_id.as_i64()));
                predicate.push_str(&format!(
                    " AND c.namespace_id=?{} AND c.namespace_id IS NOT NULL",
                    values.len()
                ));
            } else {
                predicate.push_str(" AND 0");
            }
        }
        (Some(owner), None) => {
            values.push(Value::Text(serde_json::to_string(owner)?));
            predicate.push_str(&format!(
                " AND c.namespace_id IN (SELECT id FROM agent_namespaces WHERE owner=?{}) AND c.namespace_id IS NOT NULL",
                values.len()
            ));
        }
        (None, Some(session)) => {
            values.push(Value::Text(session.clone()));
            let idx = values.len();
            predicate.push_str(&format!(
                " AND ((c.standalone_session=?{idx} AND c.standalone_session IS NOT NULL) OR (c.namespace_id IN (SELECT id FROM agent_namespaces WHERE session=?{idx}) AND c.namespace_id IS NOT NULL))"
            ));
        }
        (None, None) => {}
    }
    Ok((predicate, values))
}

const CUT: &str =
    "CASE c.source WHEN 'fact' THEN ?3 WHEN 'auxiliary' THEN ?4 WHEN 'cell' THEN ?5 END";

fn settled(scope: &str) -> String {
    format!(
        "FROM agent_usage_results r JOIN agent_usage_calls c ON c.request=r.request
         LEFT JOIN agent_usage_json_blobs q ON q.id=c.quote_id {}",
        settled_where(scope)
    )
}
fn settled_where(scope: &str) -> String {
    format!(
        "WHERE r.completed_at>=?1 AND r.completed_at<=?2
        AND c.admission_sequence<={CUT}
        AND r.sequence=(SELECT v.sequence FROM agent_usage_results v
            WHERE v.request=c.request AND v.sequence<={CUT} ORDER BY v.sequence DESC LIMIT 1)
        {scope}"
    )
}

fn count(value: i64) -> Result<u64, StoreError> {
    let value = unsigned(value)?;
    if value > MAX_EXACT {
        return Err(invalid("usage aggregate exceeds exact integer capacity"));
    }
    Ok(value)
}
fn finite(value: f64) -> Result<f64, StoreError> {
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err(invalid("usage amount exceeds finite numeric capacity"))
    }
}
fn timestamp(row: &rusqlite::Row<'_>, name: &str) -> Result<f64, StoreError> {
    Ok(count(row.get(name)?)? as f64)
}
fn tokens(row: &rusqlite::Row<'_>, name: &str) -> Result<accounting::Tokens, StoreError> {
    Ok(accounting::Tokens {
        known: count(row.get(name)?)?,
        missing: count(row.get(format!("{name}_missing").as_str())?)?,
    })
}
