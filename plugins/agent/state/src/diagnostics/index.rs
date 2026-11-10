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
use maka_agent_facts::{
    accounting::Outcome, artifact::content_digest, diagnostics::ExecutionFailureReason,
    event::ModelInterruption,
};
use rusqlite::{OptionalExtension, params};

fn classify(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
) -> Result<Option<DiagnosticDetail>, StoreError> {
    let execution = || ExecutionIdentity {
        session_id: spec.session_id.clone(),
        turn_id: spec.turn_id.clone(),
        run_id: fact.run,
    };
    let reason = match &fact.fact {
        Fact::SessionTitleFailed { cause } => {
            cause
                .validate()
                .map_err(|error| invalid(error.to_string()))?;
            return Ok(Some(DiagnosticDetail::SessionTitle {
                execution: execution(),
                cause: cause.clone(),
            }));
        }
        Fact::ModelInterrupted { .. } => ExecutionFailureReason::ModelInterrupted,
        Fact::ModelClosed {
            attempt,
            outcome: Outcome::Error | Outcome::Aborted,
            ..
        } => {
            let step: String = c
                .query_row(
                    "SELECT step FROM agent_attempt_ids WHERE run=? AND attempt=?",
                    params![fact.run.to_string(), attempt.to_string()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| {
                    invalid("diagnostic model closure has no original attempt identity")
                })?;
            let status = if matches!(
                &fact.fact,
                Fact::ModelClosed {
                    outcome: Outcome::Error,
                    ..
                }
            ) {
                ModelInterruption::Failed
            } else {
                ModelInterruption::Cancelled
            };
            return Ok(Some(DiagnosticDetail::ModelStep {
                execution: execution(),
                step_id: identity(step)?,
                attempt_id: *attempt,
                status,
                model_failure: None,
            }));
        }
        Fact::ModelClosed {
            outcome: Outcome::Unknown,
            ..
        } => ExecutionFailureReason::OutcomeUnknown,
        Fact::RunTerminated {
            terminal: Terminal::Failed,
            ..
        } => ExecutionFailureReason::ExecutionFailed,
        Fact::RunTerminated {
            terminal: Terminal::Cancelled,
            ..
        } => ExecutionFailureReason::Cancelled,
        _ => return Ok(None),
    };
    Ok(Some(DiagnosticDetail::Execution {
        execution: execution(),
        reason,
        model_failure: None,
    }))
}

pub(crate) fn index_fact(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
) -> Result<(), StoreError> {
    if spec.schema_version != SCHEMA_VERSION
        || fact.schema_version != SCHEMA_VERSION
        || fact.revision == 0
        || sequence == 0
        || fact.at.0 < 0
    {
        return Err(invalid("unsupported diagnostic source schema or metadata"));
    }
    if let Some(detail) = classify(c, spec, fact)? {
        c.execute("INSERT INTO agent_diagnostics(sequence,run,owner,session,event_id,at,detail_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(sequence) DO UPDATE SET run=excluded.run,owner=excluded.owner,session=excluded.session,event_id=excluded.event_id,at=excluded.at,detail_json=excluded.detail_json", params![signed(sequence)?, fact.run.to_string(), serde_json::to_string(&spec.owner)?, spec.session_id, fact.id.to_string(), fact.at.0, serde_json::to_string(&detail)?])?;
    }
    // New writes after an old/missing prefix must not certify that prefix.
    // Replaying an older fact never lowers an already indexed high-water mark.
    c.execute("INSERT INTO agent_diagnostic_coverage(run,revision,sequence) SELECT ?1,?2,?3 WHERE ?2=1 OR EXISTS(SELECT 1 FROM agent_diagnostic_coverage WHERE run=?1 AND revision=?2-1 AND sequence<?3) ON CONFLICT(run) DO UPDATE SET revision=excluded.revision,sequence=excluded.sequence WHERE agent_diagnostic_coverage.revision=excluded.revision-1 AND agent_diagnostic_coverage.sequence<excluded.sequence", params![fact.run.to_string(), signed(fact.revision)?, signed(sequence)?])?;
    Ok(())
}

pub(super) fn rebuild(c: &Connection, scope: &Scope) -> Result<(), StoreError> {
    let owner = serde_json::to_string(&scope.owner)?;
    c.execute(
        "DELETE FROM agent_diagnostics WHERE owner=? AND session=?",
        params![owner, scope.session],
    )?;
    c.execute("DELETE FROM agent_diagnostic_coverage WHERE run IN (SELECT run FROM agent_run_specs INDEXED BY agent_run_specs_diagnostics_cover WHERE owner=? AND session=?)", params![owner,scope.session])?;
    let mut statement=c.prepare_cached("SELECT s.run,s.schema_version,b.payload,b.content_sha256,length(b.payload) FROM agent_run_specs s INDEXED BY agent_run_specs_diagnostics_cover LEFT JOIN contents b ON b.id=s.spec_content_id WHERE s.owner=? AND s.session=? ORDER BY s.run")?;
    let mut runs = statement.query(params![owner, scope.session])?;
    while let Some(row) = runs.next()? {
        let run: RunId = identity(row.get(0)?)?;
        let bytes: Vec<u8> = row.get(2)?;
        if content_digest(&bytes) != row.get::<_, String>(3)? {
            return Err(invalid("diagnostic rebuild RunSpec content hash differs"));
        }
        let spec: RunSpec = serde_json::from_slice(&bytes)?;
        if row.get::<_, u32>(1)? != SCHEMA_VERSION
            || spec.schema_version != SCHEMA_VERSION
            || spec.owner != scope.owner
            || spec.session_id != scope.session
        {
            return Err(invalid(
                "diagnostic rebuild RunSpec differs from its canonical scope/schema",
            ));
        }
        let spec_ref = ContentRef {
            digest: row.get(3)?,
            bytes: unsigned(row.get(4)?)?,
        };
        spec_ref.validate().map_err(invalid)?;
        let mut after = 0;
        loop {
            let mut page=c.prepare_cached("SELECT f.sequence,f.id,f.revision,f.schema_version,f.at,b.content_sha256,b.payload FROM agent_facts f LEFT JOIN contents b ON b.id=f.body_content_id WHERE f.run=? AND f.revision>? ORDER BY f.revision LIMIT 128")?;
            let mut rows = page.query(params![run.to_string(), signed(after)?])?;
            let mut count = 0;
            while let Some(row) = rows.next()? {
                let sequence = unsigned(row.get(0)?)?;
                let id: FactId = identity(row.get(1)?)?;
                let revision = unsigned(row.get(2)?)?;
                let bytes: Vec<u8> = row.get(6)?;
                if content_digest(&bytes) != row.get::<_, String>(5)? {
                    return Err(invalid(
                        "diagnostic rebuild canonical fact content hash differs",
                    ));
                }
                let fact: RecordedFact = serde_json::from_slice(&bytes)?;
                if fact.id != id
                    || fact.run != run
                    || after.checked_add(1) != Some(revision)
                    || fact.revision != revision
                    || row.get::<_, u32>(3)? != fact.schema_version
                    || row.get::<_, i64>(4)? != fact.at.0
                {
                    return Err(invalid(
                        "diagnostic rebuild canonical prefix is inconsistent",
                    ));
                }
                if revision == 1
                    && !matches!(&fact.fact, Fact::RunAdmitted { spec } if spec == &spec_ref)
                {
                    return Err(invalid("diagnostic rebuild Run has no original admission"));
                }
                index_fact(c, &spec, &fact, sequence)?;
                after = revision;
                count += 1;
            }
            if count == 0 {
                break;
            }
        }
        if after == 0 {
            return Err(invalid("diagnostic rebuild Run has no canonical facts"));
        }
    }
    read::coverage(c, scope)?;
    Ok(())
}
