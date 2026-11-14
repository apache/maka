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
use maka_agent_facts::context::ModelFailureProtocol;

pub(super) struct RunEnd {
    through: u64,
    stop: Option<u64>,
    terminal: Option<RecordedFact>,
}

impl RunEnd {
    pub(super) fn terminated(&self) -> bool {
        self.terminal.is_some()
    }
}

pub(super) fn run_end(
    c: &Connection,
    source: &HistoryDataSource,
    run: RunId,
    through: u64,
) -> Result<RunEnd, StoreError> {
    let mut stop = None;
    let mut terminal = None;
    for (sequence, record) in records(c, source, run, None, through)? {
        match record.fact {
            Fact::StopRequested { .. } => stop = Some(sequence),
            Fact::RunTerminated { .. } => terminal = Some(record),
            _ => return Err(invalid("unexpected run end fact in request trace")),
        }
    }
    Ok(RunEnd {
        through,
        stop,
        terminal,
    })
}

pub(super) fn read(
    c: &Connection,
    source: &HistoryDataSource,
    run: RunId,
    step: StepId,
    attempt: ModelAttemptId,
    mut finished: Option<ModelRequestTraceFinished>,
    end: &RunEnd,
) -> Result<(Option<ModelRequestTraceFinished>, Option<ModelRequestRetry>), StoreError> {
    if finished
        .as_ref()
        .is_some_and(|result| result.outcome == Outcome::Success)
    {
        return Ok((finished, None));
    }

    let mut retry = None;
    let mut interruption = None;
    let mut source_failure = None;
    for (sequence, record) in records(c, source, run, Some((step, attempt)), end.through)? {
        match record.fact {
            Fact::RetryCharged {
                attempt: actual,
                due_at,
                ..
            } if actual == attempt => {
                retry = Some((sequence, due_at));
            }
            Fact::ModelInterrupted {
                attempt: actual,
                diagnostic,
            } if actual == attempt => {
                interruption = Some((sequence, record.at, diagnostic));
            }
            Fact::ModelSourceFailureCaptured {
                attempt: actual,
                failure,
            } if actual == attempt => {
                source_failure = Some((record.at, failure));
            }
            _ => return Err(invalid("request outcome differs from its original attempt")),
        }
    }
    if finished.is_none() {
        let failure = if let Some((at, reference)) = source_failure {
            let protocol: ModelFailureProtocol = metadata(c, source, run, &reference)?;
            Some((at, Outcome::Error, Some(protocol.failure.to_string())))
        } else if let Some((sequence, at, diagnostic)) = interruption {
            let outcome = if end.stop.is_some_and(|stop| stop < sequence) {
                Outcome::Aborted
            } else {
                Outcome::Error
            };
            Some((at, outcome, Some(diagnostic)))
        } else if let Some(RecordedFact {
            at,
            fact:
                Fact::RunTerminated {
                    terminal,
                    diagnostic,
                },
            ..
        }) = &end.terminal
        {
            let outcome = if *terminal == Terminal::Cancelled {
                Outcome::Aborted
            } else {
                Outcome::Unknown
            };
            Some((*at, outcome, diagnostic.clone()))
        } else {
            None
        };
        finished = failure.map(|(at, outcome, diagnostic)| ModelRequestTraceFinished {
            at,
            outcome,
            usage: ModelUsage::default(),
            diagnostic: diagnostic.map(|text| diagnostic_preview(&text)),
        });
    }
    let retry = retry
        .map(|(sequence, at)| {
            Ok::<_, StoreError>(
                if successor_started(c, source, run, step, sequence, end.through)? {
                    ModelRequestRetry::Started
                } else if end.stop.is_some() || end.terminal.is_some() {
                    ModelRequestRetry::Cancelled
                } else {
                    ModelRequestRetry::Scheduled { at }
                },
            )
        })
        .transpose()?;
    Ok((finished, retry))
}

fn records(
    c: &Connection,
    source: &HistoryDataSource,
    run: RunId,
    attempt: Option<(StepId, ModelAttemptId)>,
    through: u64,
) -> Result<Vec<(u64, RecordedFact)>, StoreError> {
    let run_key = run.to_string();
    let step = attempt.map(|(step, _)| step.to_string());
    let attempt = attempt.map(|(_, attempt)| attempt.to_string());
    let kinds = if attempt.is_some() {
        [
            "model_interrupted",
            "model_source_failure_captured",
            "retry_charged",
        ]
    } else {
        ["stop_requested", "run_terminated", ""]
    };
    match source {
        HistoryDataSource::Live { history, .. } => {
            let mut statement = c.prepare_cached(
                "SELECT sequence,fact_id FROM agent_session_history INDEXED BY agent_session_history_run
                 WHERE owner=? AND session=? AND run=? AND step IS ? AND attempt IS ?
                   AND kind IN (?,?,?) AND sequence<=? ORDER BY sequence",
            )?;
            let mut rows = statement.query(params![
                serde_json::to_string(&history.namespace.owner)?,
                history.namespace.session,
                run_key,
                step,
                attempt,
                kinds[0],
                kinds[1],
                kinds[2],
                sql::bind_u64(through)?,
            ])?;
            let mut facts = Vec::new();
            while let Some(row) = rows.next()? {
                let sequence = sql::read_u64(row, 0)?;
                let id = sql::identity(row.get(1)?)?;
                let fact = crate::sql::fact(c, run, id)?
                    .ok_or_else(|| invalid("request outcome fact is absent"))?;
                facts.push((sequence, fact));
            }
            Ok(facts)
        }
        HistoryDataSource::Snapshot(snapshot) => {
            let mut statement = c.prepare_cached(
                "SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_attempt
                 WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.attempt') IS ?
                   AND fact_kind IN (?,?,?) AND sequence<=? ORDER BY sequence",
            )?;
            let mut rows = statement.query(params![
                snapshot.id().to_string(),
                run_key,
                attempt,
                kinds[0],
                kinds[1],
                kinds[2],
                sql::bind_u64(through)?,
            ])?;
            let mut facts = Vec::new();
            while let Some(row) = rows.next()? {
                let key = copied_fact(c, snapshot, &row.get::<_, String>(0)?, through)?;
                facts.push((key.sequence, metadata(c, source, run, &key.body)?));
            }
            Ok(facts)
        }
    }
}

fn successor_started(
    c: &Connection,
    source: &HistoryDataSource,
    run: RunId,
    step: StepId,
    after: u64,
    through: u64,
) -> Result<bool, StoreError> {
    let run = run.to_string();
    let step = step.to_string();
    let after = sql::bind_u64(after)?;
    Ok(match source {
        HistoryDataSource::Live { history, .. } => c.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_session_history INDEXED BY agent_session_history_run
             WHERE owner=? AND session=? AND run=? AND step=? AND kind='model_attempt_admitted'
               AND sequence>? AND sequence<=?)",
            params![serde_json::to_string(&history.namespace.owner)?, history.namespace.session, run, step, after, sql::bind_u64(through)?],
            |row| row.get(0),
        )?,
        HistoryDataSource::Snapshot(snapshot) => c.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_step
             WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.step')=?
               AND fact_kind='model_attempt_admitted' AND sequence>? AND sequence<=?)",
            params![snapshot.id().to_string(), run, step, after, sql::bind_u64(through)?],
            |row| row.get(0),
        )?,
    })
}
