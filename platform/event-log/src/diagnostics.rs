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

//! Bounded safe projections of original execution and auxiliary facts.

use crate::{EventLog, StoreError};
use maka_agent_facts::diagnostics::DiagnosticDetail;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::time::SystemTime;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub sequence: u64,
    pub event_id: String,
    pub recorded_at: SystemTime,
    pub detail: DiagnosticDetail,
}
#[derive(Debug, Serialize)]
pub struct Page {
    pub through: u64,
    pub entries: Vec<Record>,
    pub next_before: Option<u64>,
}
impl EventLog {
    pub async fn diagnostics_page(
        &self,
        session: &str,
        through: Option<u64>,
        before: Option<u64>,
        max_entries: usize,
        max_bytes: usize,
    ) -> Result<Page, StoreError> {
        crate::sessions::validate_id(session)?;
        if max_entries == 0 || max_bytes == 0 || (before.is_some() && through.is_none()) {
            return Err(invalid("invalid diagnostic page bounds"));
        }
        let row_limit = i64::try_from(max_entries)
            .ok()
            .and_then(|n| n.checked_add(1))
            .ok_or_else(|| invalid("diagnostic page count is not representable"))?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let high_water = crate::observation::high_water(&tx)?;
                let through = through.unwrap_or(high_water);
                validate_bounds(through, before, high_water)?;
                let mut entries: Vec<Record> = Vec::new();
                let mut more = false;
                {
                    let mut rows_statement = tx.prepare_cached(RECORDS)?;
                    let mut rows = rows_statement.query(rusqlite::params![
                        session,
                        through as i64,
                        before.map(|n| n as i64),
                        row_limit
                    ])?;
                    while let Some(row) = rows.next()? {
                        let json: String = row.get(0)?;
                        if entries.len() == max_entries
                            || (!entries.is_empty() && json.len() > max_bytes)
                        {
                            more = true;
                            break;
                        }
                        entries.push(serde_json::from_str(&json)?);
                    }
                }
                let mut page = Page {
                    through,
                    entries,
                    next_before: None,
                };
                loop {
                    page.next_before = if more {
                        page.entries.last().map(|entry| entry.sequence)
                    } else {
                        None
                    };
                    if serde_json::to_vec(&page)?.len() <= max_bytes {
                        break;
                    }
                    if page.entries.len() <= 1 {
                        break;
                    }
                    page.entries.pop();
                    more = true;
                }
                tx.commit()?;
                Ok(page)
            })
            .await
    }

    pub async fn latest_diagnostic_sequence(
        &self,
        session: &str,
        through: u64,
    ) -> Result<Option<u64>, StoreError> {
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let high_water = crate::observation::high_water(&tx)?;
                validate_bounds(through, None, high_water)?;
                let sequence: Option<i64> = tx
                    .prepare_cached(LATEST)?
                    .query_row(rusqlite::params![session, through as i64], |row| row.get(0))
                    .optional()?;
                tx.commit()?;
                sequence.map(crate::sequence_number).transpose()
            })
            .await
    }
}
fn validate_bounds(through: u64, before: Option<u64>, high_water: u64) -> Result<(), StoreError> {
    if through > high_water || before.is_some_and(|before| before == 0 || before > through) {
        return Err(invalid("invalid diagnostic fence"));
    }
    Ok(())
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

const RECORDS: &str = r#"SELECT json_object('sequence',sequence,'event_id',event_id,
 'recorded_at',json_extract(event_header,'$.recorded_at'),
 'detail',json(CASE kind
  WHEN 'title_failure' THEN json_object('kind','session_title','invocation',json_extract(event_header,'$.opening'),'cause',json_extract(event_header,'$.cause'))
  WHEN 'model_interrupted' THEN json_object('kind','model_step','invocation',json_extract(event_header,'$.invocation'),
    'stepId',json_extract(event_header,'$.fact.step_id'),'status',json_extract(event_header,'$.fact.status'),
    'modelFailure',json_extract(event_header,'$.fact.model_failure'))
  ELSE json_object('kind','execution','invocation',json_extract(event_header,'$.invocation'),
    'reason',CASE WHEN json_extract(event_header,'$.fact.outcome.class') IN ('session_busy','continuation_changed','reconciliation_required','invalid_input','cancelled','model_incomplete','event_commit','event_store','model_timeout','model_http','model_adapter','model_provider','context_overflow','tool_execution','runtime_internal','cleanup_unconfirmed','executor','message_preparation_failed','host_interrupted','outcome_unknown') THEN json_extract(event_header,'$.fact.outcome.class') ELSE 'execution_failed' END,
    'modelFailure',json_extract(event_header,'$.fact.outcome.model_failure')) END))
FROM event_log INDEXED BY diagnostic_session_sequence
WHERE (kind='title_failure' OR (kind='invocation_ended' AND json_extract(event_header,'$.fact.outcome.kind')='failed') OR (kind='model_interrupted' AND json_extract(event_header,'$.fact.status')!='cancelled')) AND (CASE WHEN kind='title_failure' THEN json_extract(event_header,'$.opening.session_id') ELSE json_extract(event_header,'$.invocation.session_id') END)=?1 AND sequence<=min(?2,coalesce(?3-1,?2))
ORDER BY sequence DESC LIMIT ?4"#;
const LATEST: &str = r#"SELECT sequence FROM event_log INDEXED BY diagnostic_session_sequence
WHERE (kind='title_failure' OR (kind='invocation_ended' AND json_extract(event_header,'$.fact.outcome.kind')='failed') OR (kind='model_interrupted' AND json_extract(event_header,'$.fact.status')!='cancelled')) AND (CASE WHEN kind='title_failure' THEN json_extract(event_header,'$.opening.session_id') ELSE json_extract(event_header,'$.invocation.session_id') END)=?1 AND sequence<=?2
ORDER BY sequence DESC LIMIT 1"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn diagnostic_queries_use_the_candidate_index_without_body_scans() {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("plan.sqlite"))
            .await
            .unwrap();
        log.connection
            .read(|connection| {
                for (query, paged) in [(RECORDS, true), (LATEST, false)] {
                    let explain = format!("EXPLAIN QUERY PLAN {query}");
                    let mut statement = connection.prepare_cached(&explain)?;
                    let rows = if paged {
                        statement
                            .query_map(
                                rusqlite::params!["session", 100i64, None::<i64>, 33i64],
                                |row| row.get::<_, String>(3),
                            )?
                            .collect::<Result<Vec<_>, _>>()?
                    } else {
                        statement
                            .query_map(rusqlite::params!["session", 100i64], |row| {
                                row.get::<_, String>(3)
                            })?
                            .collect::<Result<Vec<_>, _>>()?
                    };
                    let plan = rows.join("\n");
                    assert!(
                        plan.contains("SEARCH event_log USING INDEX diagnostic_session_sequence"),
                        "{plan}"
                    );
                    assert!(
                        !plan.contains("SCAN event_log") && !plan.contains("USE TEMP B-TREE"),
                        "{plan}"
                    );
                }
                Ok(())
            })
            .await
            .unwrap();
        log.close().await.unwrap();
    }
}
