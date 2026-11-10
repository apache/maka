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
use crate::{fold::RunView, store::invalid};
use rusqlite::{OptionalExtension, params};
use serde::de::DeserializeOwned;
const VERSION: u32 = 1;
fn sql_integer(value: u64) -> Result<i64, StoreError> {
    if value > MAX_SAFE_INTEGER {
        return Err(invalid("computer integer exceeds safe range"));
    }
    i64::try_from(value).map_err(|_| invalid("computer SQL integer overflow"))
}
fn unsigned(value: i64) -> Result<u64, StoreError> {
    let value = u64::try_from(value).map_err(|_| invalid("negative computer integer"))?;
    if value > MAX_SAFE_INTEGER {
        return Err(invalid("computer integer exceeds safe range"));
    }
    Ok(value)
}
fn json<T: Serialize>(v: &T) -> Result<String, StoreError> {
    Ok(serde_json::to_string(v)?)
}
fn parse<T: DeserializeOwned>(v: String) -> Result<T, StoreError> {
    Ok(serde_json::from_str(&v)?)
}
fn run(c: &Connection, id: RunId) -> Result<RunView, StoreError> {
    crate::sql::load(c, id, &[], false)
}
fn execution(view: &RunView) -> ExecutionIdentity {
    ExecutionIdentity {
        session_id: view.spec.session_id.clone(),
        turn_id: view.spec.turn_id.clone(),
        run_id: view.run,
    }
}
fn verify_execution(c: &Connection, actual: &ExecutionIdentity) -> Result<(), StoreError> {
    let (version, session, body_version, body_session, turn): (u32, String, u32, String, String) =
        c.prepare_cached("SELECT s.schema_version,s.session,json_extract(CAST(b.payload AS TEXT),'$.schemaVersion'),json_extract(CAST(b.payload AS TEXT),'$.sessionId'),json_extract(CAST(b.payload AS TEXT),'$.turnId') FROM agent_run_specs s JOIN contents b ON b.id=s.spec_content_id WHERE s.run=?")?
            .query_row([actual.run_id.to_string()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
    if version != SCHEMA_VERSION
        || body_version != version
        || session != body_session
        || *actual
            != (ExecutionIdentity {
                session_id: session,
                turn_id: turn,
                run_id: actual.run_id,
            })
    {
        return Err(invalid("native source differs from immutable execution"));
    }
    Ok(())
}
pub(super) fn verify_native_binding(
    c: &Connection,
    execution_id: &ExecutionIdentity,
    binding: FactId,
) -> Result<(), StoreError> {
    let raw: Option<String> = c
        .query_row(
            "SELECT source_json FROM agent_computer_native_bindings WHERE id=? AND run=?",
            params![binding.to_string(), execution_id.run_id.to_string()],
            |r| r.get(0),
        )
        .optional()?;
    let source: NativeSource =
        parse(raw.ok_or_else(|| invalid("original native binding missing"))?)?;
    verify_execution(c, execution_id)?;
    if source.execution != *execution_id {
        return Err(invalid(
            "native interruption differs from its bound immutable execution",
        ));
    }
    Ok(())
}
pub(super) fn native_turn_interrupted(
    c: &Connection,
    execution_id: &ExecutionIdentity,
) -> Result<bool, StoreError> {
    verify_execution(c, execution_id)?;
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_computer_native_turn_fences WHERE run=? AND turn=?)",
        params![execution_id.run_id.to_string(), execution_id.turn_id],
        |r| r.get(0),
    )?)
}
fn id(v: &str) -> Result<(), StoreError> {
    entity_id(v).map_err(invalid)
}
fn live(view: &RunView) -> Result<(), StoreError> {
    if view.stopped || view.terminal.is_some() || !matches!(view.spec.origin, RunOrigin::Local) {
        return Err(invalid("computer Run admission is fenced"));
    }
    Ok(())
}
fn boundary(c: &Connection, s: &Subject) -> Result<(), StoreError> {
    if crate::interactions::sql::current_basis(c, &s.activity.execution.session_id)?
        != Some(s.basis)
    {
        return Err(invalid("computer permission boundary changed"));
    }
    Ok(())
}
fn subject_for_run(c: &Connection, run: RunId, operation: &str) -> Result<Subject, StoreError> {
    c.query_row(
        "SELECT subject_json FROM agent_computer_subjects WHERE run=? AND operation=?",
        params![run.to_string(), operation],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(parse)
    .transpose()?
    .ok_or_else(|| invalid("computer original subject missing"))
}
pub(super) fn subject(
    c: &Connection,
    session: &str,
    operation: &str,
) -> Result<Option<Subject>, StoreError> {
    id(session)?;
    id(operation)?;
    c.query_row(
        "SELECT subject_json FROM agent_computer_subjects WHERE session=? AND operation=?",
        params![session, operation],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(parse)
    .transpose()
}
fn revision(c: &Connection, owner: &RunOwner, target: &GrantTarget) -> Result<u64, StoreError> {
    let value: Option<i64> = c
        .query_row(
            "SELECT revision FROM agent_computer_revocations WHERE owner=? AND target=?",
            params![json(owner)?, json(target)?],
            |r| r.get(0),
        )
        .optional()?;
    unsigned(value.unwrap_or(0))
}
fn stopped(c: &Connection, s: &Subject) -> Result<bool, StoreError> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_computer_stops WHERE run=? AND target=?)",
        params![
            s.activity.execution.run_id.to_string(),
            json(&s.activity.target)?
        ],
        |r| r.get(0),
    )?)
}
fn full_access(c: &Connection, view: &RunView) -> Result<bool, StoreError> {
    let raw: String = c.query_row(
        "SELECT configuration FROM session_control WHERE id=? AND archived=0",
        [&view.spec.session_id],
        |r| r.get(0),
    )?;
    let policy: serde_json::Value = serde_json::from_str(&raw)?;
    let access = policy
        .get("permissions")
        .and_then(|v| v.get("access"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid("computer session policy missing"))?;
    if access == "read_only" {
        return Err(invalid(
            "computer action is outside current read-only policy",
        ));
    }
    if !matches!(access, "workspace_write" | "danger_full_access") {
        return Err(invalid("unknown computer session policy"));
    }
    Ok(access == "danger_full_access"
        && matches!(
            view.spec.permission_ceiling.sandbox,
            maka_sandbox::Sandbox::Disabled
        ))
}
fn source_obligation(c: &Connection, view: &RunView, s: &Subject) -> Result<(), StoreError> {
    original_source(c, view, &s.activity.execution, &s.target, &s.operation)
}
fn original_source(
    c: &Connection,
    view: &RunView,
    execution: &ExecutionIdentity,
    target: &AuthorizationObligation,
    original: &RecoveryRef,
) -> Result<(), StoreError> {
    match target {
        AuthorizationObligation::Tool { tool: key } => {
            let raw: String = c
                .query_row(
                    "SELECT body FROM agent_tools WHERE run=? AND key=?",
                    params![view.run.to_string(), crate::fold::tool_key(key)],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| invalid("computer source tool missing"))?;
            let tool: crate::fold::Tool = parse(raw)?;
            if !tool.admitted
                || tool.accepted.is_some()
                || tool.original.as_ref() != Some(original)
                || tool.prohibited_before_host.is_some()
            {
                return Err(invalid(
                    "computer source lacks its exact original admitted Host operation",
                ));
            }
        }
        AuthorizationObligation::Cell { cell, operation } => {
            crate::cells::verify_native_source(c, *cell, *operation, execution, original)?;
        }
        AuthorizationObligation::External { task, operation } => {
            crate::external_effects::verify_native_source(
                c,
                execution,
                &maka_agent_facts::external_effects::ExternalEffectKey {
                    task: *task,
                    operation: *operation,
                },
                original,
            )?;
        }
    }
    Ok(())
}
fn status_for(c: &Connection, s: &Subject) -> Result<Status, StoreError> {
    let view = run(c, s.activity.execution.run_id)?;
    let authority_revision = revision(c, &view.spec.owner, &s.activity.target)?;
    let blocked = view.stopped || view.terminal.is_some() || stopped(c, s)?;
    if blocked {
        return Ok(Status {
            stopped: true,
            authority_revision,
            consent: Consent::Absent,
        });
    }
    boundary(c, s)?;
    if full_access(c, &view)? {
        return Ok(Status {
            stopped: false,
            authority_revision,
            consent: Consent::FullAccess,
        });
    }
    let grant:Option<(String,String)>=c.query_row(
        "SELECT request,scope FROM agent_computer_grants g WHERE owner=?1 AND target=?2 AND authority_revision=?3 AND (scope='profile' OR (scope='session' AND session=?4 AND basis=?5) OR (scope='once' AND run=?6 AND operation=?7 AND basis=?5 AND NOT EXISTS(SELECT 1 FROM agent_computer_authorizations a WHERE a.request=g.request AND a.operation<>?7))) ORDER BY CASE scope WHEN 'once' THEN 0 WHEN 'session' THEN 1 ELSE 2 END,request LIMIT 1",
        params![json(&view.spec.owner)?,json(&s.activity.target)?,sql_integer(authority_revision)?,s.activity.execution.session_id,json(&s.basis)?,view.run.to_string(),s.activity.operation_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let consent = match grant {
        None => Consent::Absent,
        Some((request, scope)) => match scope.as_str() {
            "once" => Consent::Once { request },
            "session" => Consent::Session { request },
            "profile" => Consent::Profile { request },
            _ => return Err(invalid("unknown computer consent scope")),
        },
    };
    Ok(Status {
        stopped: false,
        authority_revision,
        consent,
    })
}
pub(super) fn status(c: &Connection, session: &str, operation: &str) -> Result<Status, StoreError> {
    status_for(
        c,
        &subject(c, session, operation)?.ok_or_else(|| invalid("computer source missing"))?,
    )
}
fn pin(c: &Connection, run: RunId, reference: &ContentRef) -> Result<(), StoreError> {
    reference.validate().map_err(invalid)?;
    let content: Option<i64> = c
        .query_row(
            "SELECT id FROM contents WHERE content_sha256=? AND length(payload)=?",
            params![reference.digest, sql_integer(reference.bytes)?],
            |r| r.get(0),
        )
        .optional()?;
    let content = content.ok_or_else(|| invalid("computer capture bytes missing"))?;
    c.execute(
        "INSERT OR IGNORE INTO agent_content_pins VALUES(?,?)",
        params![run.to_string(), content],
    )?;
    Ok(())
}
pub(super) fn append(
    c: &Connection,
    run_id: RunId,
    head: Option<Head>,
    change: Change,
    contents: Vec<ContentBlob>,
    driver: bool,
) -> Result<Option<String>, StoreError> {
    let encoded = json(&change.fact)?;
    let prior: Option<(String, String)> = c
        .query_row(
            "SELECT run,fact_json FROM agent_computer_facts WHERE id=?",
            [change.id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((run, fact)) = prior {
        if run != run_id.to_string() || fact != encoded {
            return Err(StoreError::EventConflict);
        }
        return Ok(None);
    }
    let view = run(c, run_id)?;
    if let Some(expected) = head {
        if Head::from(&view) != expected {
            return Err(StoreError::RevisionConflict {
                expected: json(&expected)?,
                actual: json(&Head::from(&view))?,
            });
        }
    }
    match &change.fact {
        Fact::NativeSourceBound { source } => {
            if !driver {
                return Err(invalid("native binding requires its current driver"));
            }
            live(&view)?;
            if source.execution != execution(&view) {
                return Err(invalid("native binding differs from immutable execution"));
            }
            id(&source.native_epoch)?;
            id(&source.generation)?;
            id(&source.operation)?;
            source
                .original
                .validate()
                .map_err(|e| invalid(e.to_string()))?;
            original_source(
                c,
                &view,
                &source.execution,
                &source.target,
                &source.original,
            )?;
            if native_turn_interrupted(c, &source.execution)? {
                return Err(invalid(
                    "native input was physically interrupted in this turn",
                ));
            }
        }
        Fact::NativeTurnInterrupted { binding } => {
            if driver {
                return Err(invalid(
                    "native interruption is an original producer observation",
                ));
            }
            verify_native_binding(c, &execution(&view), *binding)?;
        }
        Fact::SubjectObserved { subject: s } => {
            if !driver {
                return Err(invalid("only a driver may observe a native subject"));
            }
            live(&view)?;
            s.activity.validate().map_err(invalid)?;
            s.operation.validate().map_err(|e| invalid(e.to_string()))?;
            if s.activity.execution != execution(&view) {
                return Err(invalid("computer subject belongs to another Run"));
            }
            boundary(c, s)?;
            full_access(c, &view)?;
            source_obligation(c, &view, s)?;
            for blob in contents {
                blob.store(c)?;
            }
            pin(c, run_id, &s.capture)?;
        }
        Fact::AppAuthorized {
            source_operation,
            request,
            basis,
        } => {
            if !driver {
                return Err(invalid("only a driver may authorize a native action"));
            }
            live(&view)?;
            let s = subject_for_run(c, run_id, source_operation)?;
            source_obligation(c, &view, &s)?;
            boundary(c, &s)?;
            if s.basis != *basis {
                return Err(invalid("computer action changed boundary"));
            }
            let actual = status_for(c, &s)?;
            if actual.stopped {
                return Err(invalid("computer app was stopped"));
            }
            let expected = match actual.consent {
                Consent::Absent => return Err(invalid("computer app consent missing")),
                Consent::FullAccess => None,
                Consent::Once { request }
                | Consent::Session { request }
                | Consent::Profile { request } => Some(request),
            };
            if &expected != request {
                return Err(invalid("computer action changed original consent"));
            }
            let existing:Option<(Option<String>,String)>=c.query_row("SELECT request,basis FROM agent_computer_authorizations WHERE run=? AND operation=?",params![run_id.to_string(),source_operation],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if existing.is_some() {
                return Err(invalid(
                    "computer native action was already authorized; observe its original fact instead of redispatching",
                ));
            }
        }
        Fact::AppStopRequested { source_operation }
        | Fact::ProfileGrantRevoked { source_operation } => {
            if driver {
                return Err(invalid("computer human controls are not driver actions"));
            }
            subject_for_run(c, run_id, source_operation)?;
        }
    }
    c.execute(
        "INSERT INTO agent_computer_facts(id,run,at,schema_version,fact_json) VALUES(?,?,?,?,?)",
        params![
            change.id.to_string(),
            run_id.to_string(),
            change.at.0,
            VERSION,
            encoded
        ],
    )?;
    let sequence = c.last_insert_rowid();
    unsigned(sequence)?;
    fold(c, sequence, &view, &change.fact)?;
    Ok(Some(view.spec.session_id))
}
fn fold(c: &Connection, sequence: i64, view: &RunView, fact: &Fact) -> Result<(), StoreError> {
    match fact {
        Fact::NativeSourceBound { source } => {
            if source.execution != execution(view) {
                return Err(invalid("native binding differs from immutable execution"));
            }
            c.execute(
                "INSERT INTO agent_computer_native_bindings(id,run,source_json) SELECT id,run,? FROM agent_computer_facts WHERE sequence=?",
                params![json(source)?, sequence],
            )?;
        }
        Fact::NativeTurnInterrupted { binding } => {
            verify_native_binding(c, &execution(view), *binding)?;
            c.execute(
                "INSERT OR IGNORE INTO agent_computer_native_turn_fences VALUES(?,?,?)",
                params![view.run.to_string(), view.spec.turn_id, binding.to_string()],
            )?;
        }
        Fact::SubjectObserved { subject: s } => {
            pin(c, view.run, &s.capture)?;
            if let Some(old) = subject(
                c,
                &s.activity.execution.session_id,
                &s.activity.operation_id,
            )? {
                if old != *s {
                    return Err(StoreError::EventConflict);
                }
                return Ok(());
            }
            c.execute(
                "INSERT INTO agent_computer_subjects VALUES(?,?,?,?,?,?,?)",
                params![
                    s.activity.operation_id,
                    view.run.to_string(),
                    view.spec.session_id,
                    json(&view.spec.owner)?,
                    json(&s.activity.target)?,
                    json(s)?,
                    sequence
                ],
            )?;
            c.execute("INSERT INTO agent_computer_activities VALUES(?,?,?,?) ON CONFLICT(run,target) DO UPDATE SET operation=excluded.operation,sequence=excluded.sequence",params![view.run.to_string(),json(&s.activity.target)?,s.activity.operation_id,sequence])?;
        }
        Fact::AppStopRequested { source_operation } => {
            let s = subject_for_run(c, view.run, source_operation)?;
            c.execute(
                "INSERT OR IGNORE INTO agent_computer_stops VALUES(?,?,?)",
                params![
                    view.run.to_string(),
                    json(&s.activity.target)?,
                    source_operation
                ],
            )?;
        }
        Fact::ProfileGrantRevoked { source_operation } => {
            let s = subject_for_run(c, view.run, source_operation)?;
            c.execute("INSERT INTO agent_computer_revocations VALUES(?,?,?) ON CONFLICT(owner,target) DO UPDATE SET revision=excluded.revision",params![json(&view.spec.owner)?,json(&s.activity.target)?,sequence])?;
        }
        Fact::AppAuthorized {
            source_operation,
            request,
            basis,
        } => {
            c.execute(
                "INSERT OR IGNORE INTO agent_computer_authorizations VALUES(?,?,?,?)",
                params![
                    view.run.to_string(),
                    source_operation,
                    request,
                    json(basis)?
                ],
            )?;
        }
    }
    Ok(())
}
fn tool_use_id_for(s: &Subject) -> String {
    let operation = match &s.target {
        AuthorizationObligation::Tool { tool } => crate::fold::tool_key(tool),
        AuthorizationObligation::Cell { cell, operation } => format!("cell:{cell}:{operation}"),
        AuthorizationObligation::External { task, operation } => {
            format!("external:{task}:{operation}")
        }
    };
    maka_agent_facts::tool_call::tool_use_id(s.activity.execution.run_id, &operation)
}
fn request_subject(c: &Connection, record: &InteractionRecord) -> Result<Subject, StoreError> {
    let InteractionRequest::ComputerApp {
        tool_use_id,
        native_operation_id,
        target,
        basis,
        display,
        allow_always,
        ..
    } = &record.request
    else {
        return Err(invalid("computer app request required"));
    };
    let s = subject(c, &record.execution.session_id, native_operation_id)?
        .ok_or_else(|| invalid("computer consent has no native source observation"))?;
    if *tool_use_id != tool_use_id_for(&s)
        || s.activity.execution != record.execution
        || s.activity.target != *target
        || s.basis != *basis
        || s.activity.display != *display
        || s.allow_always != *allow_always
    {
        return Err(invalid("computer consent immutable source differs"));
    }
    Ok(s)
}
fn source_pending(c: &Connection, s: &Subject) -> Result<bool, StoreError> {
    match &s.target {
        AuthorizationObligation::Tool { tool: key } => {
            let raw: String = c
                .query_row(
                    "SELECT body FROM agent_tools WHERE run=? AND key=?",
                    params![
                        s.activity.execution.run_id.to_string(),
                        crate::fold::tool_key(key)
                    ],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| invalid("computer original tool disappeared"))?;
            let tool: crate::fold::Tool = parse(raw)?;
            if tool.original.as_ref() != Some(&s.operation) {
                return Err(invalid(
                    "computer immutable original tool reference differs",
                ));
            }
            Ok(tool.admitted && tool.accepted.is_none() && tool.prohibited_before_host.is_none())
        }
        AuthorizationObligation::Cell { cell, operation } => crate::cells::native_source_pending(
            c,
            *cell,
            *operation,
            &s.activity.execution,
            &s.operation,
        ),
        AuthorizationObligation::External { task, operation } => {
            crate::external_effects::native_source_pending(
                c,
                &s.activity.execution,
                &maka_agent_facts::external_effects::ExternalEffectKey {
                    task: *task,
                    operation: *operation,
                },
                &s.operation,
            )
        }
    }
}
pub(crate) fn eligible(c: &Connection, record: &InteractionRecord) -> Result<bool, StoreError> {
    let s = request_subject(c, record)?;
    let InteractionRequest::ComputerApp {
        authority_revision, ..
    } = &record.request
    else {
        unreachable!()
    };
    let pending = source_pending(c, &s)?;
    let view = run(c, s.activity.execution.run_id)?;
    Ok(pending
        && !view.stopped
        && view.terminal.is_none()
        && !stopped(c, &s)?
        && crate::interactions::sql::current_basis(c, &view.spec.session_id)? == Some(s.basis)
        && revision(c, &view.spec.owner, &s.activity.target)? == *authority_revision)
}
/// Called by the canonical interaction writer; no user path or inferred app identity is accepted.
pub(crate) fn validate_request(
    c: &Connection,
    record: &InteractionRecord,
) -> Result<(), StoreError> {
    if !eligible(c, record)? {
        return Err(invalid("computer consent authority changed"));
    }
    Ok(())
}
/// This is only a deterministic index of the original canonical answer, never a second approval ledger.
pub(crate) fn fold_outcome(
    c: &Connection,
    record: &InteractionRecord,
    eligible: bool,
) -> Result<(), StoreError> {
    let InteractionRequest::ComputerApp {
        native_operation_id,
        target,
        basis,
        authority_revision,
        ..
    } = &record.request
    else {
        return Ok(());
    };
    if !eligible {
        return Ok(());
    }
    let Some(InteractionOutcome::ComputerAppDecision { decision, .. }) = &record.outcome else {
        return Ok(());
    };
    let scope = match decision {
        ComputerAppDecision::Once => "once",
        ComputerAppDecision::Session => "session",
        ComputerAppDecision::Always => "profile",
        ComputerAppDecision::Deny => return Ok(()),
    };
    let s = subject(c, &record.execution.session_id, native_operation_id)?
        .ok_or_else(|| invalid("computer grant source missing"))?;
    let view = run(c, s.activity.execution.run_id)?;
    c.execute(
        "INSERT OR IGNORE INTO agent_computer_grants VALUES(?,?,?,?,?,?,?,?,?)",
        params![
            record.request_id,
            json(&view.spec.owner)?,
            record.execution.session_id,
            record.execution.run_id.to_string(),
            json(target)?,
            native_operation_id,
            json(basis)?,
            scope,
            sql_integer(*authority_revision)?
        ],
    )?;
    Ok(())
}
pub(super) fn activities(
    c: &Connection,
    session: &str,
    owner: &RunOwner,
) -> Result<Vec<ActivityState>, StoreError> {
    id(session)?;
    let rows=c.prepare_cached("SELECT s.subject_json,(r.stopped OR EXISTS(SELECT 1 FROM agent_computer_stops x WHERE x.run=s.run AND x.target=s.target)),EXISTS(SELECT 1 FROM agent_computer_authorizations a WHERE a.run=s.run AND a.operation=s.operation) FROM agent_runs r JOIN agent_computer_activities a ON a.run=r.run JOIN agent_computer_subjects s ON s.run=a.run AND s.operation=a.operation WHERE r.session=? AND r.owner=? AND r.terminal IS NULL ORDER BY a.sequence")?.query_map(params![session,json(owner)?],|r|Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?,r.get::<_,bool>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
    rows.into_iter()
        .map(|(s, stopped, authorized)| {
            Ok(ActivityState {
                subject: parse(s)?,
                stopped,
                authorized,
            })
        })
        .collect()
}
/// Core Run rebuild also clears its content pins. Restore this domain's original capture owners.
pub(crate) fn pin_run(c: &Connection, run: RunId) -> Result<(), StoreError> {
    let mut after = 0i64;
    loop {
        let rows=c.prepare_cached("SELECT sequence,fact_json FROM agent_computer_facts WHERE run=? AND sequence>? ORDER BY sequence LIMIT 256")?.query_map(params![run.to_string(),after],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        if rows.is_empty() {
            break;
        }
        for (sequence, raw) in rows {
            unsigned(sequence)?;
            if let Fact::SubjectObserved { subject } = parse(raw)? {
                pin(c, run, &subject.capture)?;
            }
            after = sequence;
        }
    }
    Ok(())
}
pub(super) fn rebuild(c: &Connection) -> Result<(), StoreError> {
    for table in [
        "agent_computer_native_turn_fences",
        "agent_computer_native_bindings",
        "agent_computer_subjects",
        "agent_computer_activities",
        "agent_computer_stops",
        "agent_computer_authorizations",
        "agent_computer_revocations",
        "agent_computer_grants",
    ] {
        c.execute(&format!("DELETE FROM {table}"), [])?;
    }
    let mut after = 0i64;
    loop {
        let rows=c.prepare_cached("SELECT sequence,run,schema_version,fact_json FROM agent_computer_facts WHERE sequence>? ORDER BY sequence LIMIT 256")?.query_map([after],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,u32>(2)?,r.get::<_,String>(3)?)))?.collect::<Result<Vec<_>,_>>()?;
        if rows.is_empty() {
            break;
        }
        for (sequence, run_id, version, raw) in rows {
            unsigned(sequence)?;
            if version != VERSION {
                return Err(invalid("unsupported computer fact schema"));
            }
            let run_id: RunId = serde_json::from_value(serde_json::Value::String(run_id))?;
            fold(c, sequence, &run(c, run_id)?, &parse(raw)?)?;
            after = sequence;
        }
    }
    let mut after = String::new();
    loop {
        let rows=c.prepare_cached("SELECT r.session,r.request,o.eligible FROM agent_interaction_requests r JOIN agent_interaction_outcomes o ON o.request=r.request WHERE r.request>? ORDER BY r.request LIMIT 256")?.query_map([&after],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,bool>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
        if rows.is_empty() {
            break;
        }
        for (session, request, eligible) in rows {
            let record = crate::interactions::sql::read(c, &session, &request)?
                .ok_or_else(|| invalid("computer canonical outcome missing"))?;
            fold_outcome(c, &record, eligible)?;
            after = request;
        }
    }
    Ok(())
}
