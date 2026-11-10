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

use super::*;
use rusqlite::{OptionalExtension, Row, params};

fn requires_rebuild() -> StoreError {
    invalid("diagnostic index requires rebuild")
}

pub(super) fn tail(c: &Connection, run: &str) -> Result<Option<(i64, i64, u32)>, StoreError> {
    Ok(c.prepare_cached("SELECT revision,sequence,schema_version FROM agent_facts INDEXED BY agent_facts_diagnostics_tail WHERE run=? ORDER BY revision DESC LIMIT 1")?
        .query_row([run], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?)
}

/// Coverage is derived from a contiguous classifier prefix, and checked against
/// the actual canonical tail, not the potentially missing current Run projection.
pub(super) fn coverage(c: &Connection, scope: &Scope) -> Result<u64, StoreError> {
    let mut statement=c.prepare_cached("SELECT s.run,s.schema_version,v.revision,v.sequence FROM agent_run_specs s INDEXED BY agent_run_specs_diagnostics_cover LEFT JOIN agent_diagnostic_coverage v ON v.run=s.run WHERE s.owner=? AND s.session=?")?;
    let mut rows = statement.query(params![serde_json::to_string(&scope.owner)?, scope.session])?;
    let mut through = 0;
    while let Some(row) = rows.next()? {
        let run: String = row.get(0)?;
        let (revision, sequence, schema) = tail(c, &run)?.ok_or_else(requires_rebuild)?;
        if row.get::<_, u32>(1)? != SCHEMA_VERSION
            || schema != SCHEMA_VERSION
            || revision <= 0
            || sequence <= 0
            || row.get::<_, Option<i64>>(2)? != Some(revision)
            || row.get::<_, Option<i64>>(3)? != Some(sequence)
        {
            return Err(requires_rebuild());
        }
        through = through.max(unsigned(sequence)?);
    }
    Ok(through)
}

pub(super) fn head(c: &Connection, scope: Scope) -> Result<DiagnosticHead, StoreError> {
    let through = coverage(c, &scope)?;
    let owner = serde_json::to_string(&scope.owner)?;
    let mut statement=c.prepare_cached("SELECT d.sequence,d.event_id,d.at,d.detail_json,d.run,f.id,f.run,f.at,f.schema_version,s.owner,s.session,s.schema_version,json_extract(CAST(b.payload AS TEXT),'$.turnId') FROM agent_diagnostics d LEFT JOIN agent_facts f ON f.sequence=d.sequence LEFT JOIN agent_run_specs s ON s.run=f.run LEFT JOIN contents b ON b.id=s.spec_content_id WHERE d.owner=?1 AND d.session=?2 AND d.sequence<=?3 ORDER BY d.sequence DESC LIMIT 1")?;
    let mut rows = statement.query(params![owner, scope.session, signed(through)?])?;
    let latest = rows
        .next()?
        .map(|row| entry(row, &scope, &owner))
        .transpose()?
        .map(|entry| entry.sequence);
    Ok(DiagnosticHead { through, latest })
}

fn entry(row: &Row<'_>, scope: &Scope, owner: &str) -> Result<DiagnosticEntry, StoreError> {
    let sequence = unsigned(row.get(0)?)?;
    let id: String = row.get(1)?;
    let at: i64 = row.get(2)?;
    let run: String = row.get(4)?;
    if sequence == 0
        || at < 0
        || row.get::<_, Option<String>>(5)?.as_ref() != Some(&id)
        || row.get::<_, Option<String>>(6)?.as_ref() != Some(&run)
        || row.get::<_, Option<i64>>(7)? != Some(at)
        || row.get::<_, Option<u32>>(8)? != Some(SCHEMA_VERSION)
        || row.get::<_, Option<String>>(9)?.as_deref() != Some(owner)
        || row.get::<_, Option<String>>(10)?.as_deref() != Some(scope.session.as_str())
        || row.get::<_, Option<u32>>(11)? != Some(SCHEMA_VERSION)
    {
        return Err(requires_rebuild());
    }
    let detail: DiagnosticDetail = serde_json::from_str(&row.get::<_, String>(3)?)?;
    let execution = match &detail {
        DiagnosticDetail::Execution {
            execution,
            model_failure,
            ..
        }
        | DiagnosticDetail::ModelStep {
            execution,
            model_failure,
            ..
        } => {
            if let Some(cause) = model_failure {
                cause
                    .validate()
                    .map_err(|error| invalid(error.to_string()))?;
            }
            execution
        }
        DiagnosticDetail::SessionTitle { execution, cause } => {
            cause
                .validate()
                .map_err(|error| invalid(error.to_string()))?;
            execution
        }
    };
    if execution.run_id.to_string() != run
        || execution.session_id != scope.session
        || row.get::<_, Option<String>>(12)?.as_deref() != Some(execution.turn_id.as_str())
    {
        return Err(requires_rebuild());
    }
    Ok(DiagnosticEntry {
        sequence,
        event_id: identity(id)?,
        recorded_at: UnixMillis(at),
        detail,
    })
}

pub(super) fn page(c: &Connection, query: ReadPage) -> Result<DiagnosticPage, StoreError> {
    let actual = coverage(c, &query.scope)?;
    let through = query.through.unwrap_or(actual);
    if through > actual
        || query
            .before
            .is_some_and(|before| before == 0 || before > through)
    {
        return Err(invalid("invalid diagnostic page boundary"));
    }
    if query.through.is_some() && through != 0 {
        let member:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_facts f JOIN agent_run_specs s ON s.run=f.run WHERE f.sequence=? AND f.schema_version=? AND s.owner=? AND s.session=?)",params![signed(through)?,SCHEMA_VERSION,serde_json::to_string(&query.scope.owner)?,query.scope.session],|row|row.get(0))?;
        if !member {
            return Err(invalid(
                "diagnostic fence belongs to another canonical scope",
            ));
        }
    }
    let mut page = DiagnosticPage {
        through,
        next_before: None,
        entries: Vec::new(),
    };
    let empty_bytes = serde_json::to_vec(&page)?.len();
    if empty_bytes > query.max_bytes {
        return Err(invalid("diagnostic JSON budget is too small"));
    }
    let mut statement=c.prepare_cached("SELECT d.sequence,d.event_id,d.at,d.detail_json,d.run,f.id,f.run,f.at,f.schema_version,s.owner,s.session,s.schema_version,json_extract(CAST(b.payload AS TEXT),'$.turnId') FROM agent_diagnostics d LEFT JOIN agent_facts f ON f.sequence=d.sequence LEFT JOIN agent_run_specs s ON s.run=f.run LEFT JOIN contents b ON b.id=s.spec_content_id WHERE d.owner=?1 AND d.session=?2 AND d.sequence<=?3 AND (?4 IS NULL OR d.sequence<?4) ORDER BY d.sequence DESC LIMIT ?5")?;
    let owner = serde_json::to_string(&query.scope.owner)?;
    let mut rows = statement.query(params![
        owner,
        query.scope.session,
        signed(through)?,
        query.before.map(signed).transpose()?,
        i64::from(query.limit) + 1
    ])?;
    let mut entries_bytes = 0;
    while let Some(row) = rows.next()? {
        if page.entries.len() == query.limit as usize {
            page.next_before = page.entries.last().map(|entry| entry.sequence);
            break;
        }
        let entry = entry(row, &query.scope, &owner)?;
        let bytes = serde_json::to_vec(&entry)?.len();
        let header = DiagnosticPage {
            through,
            next_before: Some(entry.sequence),
            entries: Vec::new(),
        };
        let size = serde_json::to_vec(&header)?.len().max(empty_bytes)
            + entries_bytes
            + bytes
            + usize::from(!page.entries.is_empty());
        if size > query.max_bytes {
            if page.entries.is_empty() {
                return Err(invalid("diagnostic entry exceeds JSON budget"));
            }
            page.next_before = page.entries.last().map(|entry| entry.sequence);
            break;
        }
        entries_bytes += bytes + usize::from(!page.entries.is_empty());
        page.entries.push(entry);
    }
    Ok(page)
}
