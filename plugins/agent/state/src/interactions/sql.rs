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
use crate::{
    Change,
    fold::{self, RunView},
    store::{Mode, invalid},
};
use maka_agent_facts::cells::{CellEvent, CellId, CellOwner, CellStatus};
use maka_agent_facts::external_effects::ExternalEffectKey;
use maka_sandbox::workspace::{BindingRef, BindingStamp};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

fn bind_u64(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("SQLite integer exceeds signed 64-bit range"))
}
fn read_u64(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(column)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn encode<T: Serialize>(value: &T) -> Result<String, StoreError> {
    Ok(serde_json::to_string(value)?)
}
fn id(value: &str) -> Result<(), StoreError> {
    entity_id(value).map_err(invalid)
}
fn revision(c: &Connection, session: &str) -> Result<u64, StoreError> {
    Ok(c.query_row(
        "SELECT revision FROM agent_interaction_heads WHERE session=?",
        [session],
        |r| read_u64(r, 0),
    )
    .optional()?
    .unwrap_or(0))
}
fn advance(c: &Connection, session: &str) -> Result<u64, StoreError> {
    let next = revision(c, session)?
        .checked_add(1)
        .filter(|v| *v <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("interaction revision exhausted"))?;
    c.execute("INSERT INTO agent_interaction_heads VALUES(?,?) ON CONFLICT(session) DO UPDATE SET revision=excluded.revision",params![session,bind_u64(next)?])?;
    Ok(next)
}
/// The policy boundary is resolved in the same Root transaction as the answer
/// or admission. Serialized request bytes cannot mint a current boundary.
pub(crate) fn current_basis(
    c: &Connection,
    session: &str,
) -> Result<Option<PermissionBasis>, StoreError> {
    let raw: Option<String> = c
        .query_row(
            "SELECT configuration FROM session_control WHERE id=?1 AND archived=0
             AND NOT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1 AND remove_session!=0)",
            [session],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else { return Ok(None) };
    let config: Value = serde_json::from_str(&raw)?;
    let Some(workspace) = config.get("workspace") else {
        return Ok(None);
    };
    let reference: BindingRef = serde_json::from_value(workspace.clone())?;
    reference.validate().map_err(invalid)?;
    let epoch: u64 = c
        .query_row(
            "SELECT permission_epoch FROM workspace_bindings WHERE id=?",
            [reference.id.to_string()],
            |r| read_u64(r, 0),
        )
        .optional()?
        .ok_or_else(|| invalid("Session workspace binding disappeared"))?;
    let stamp = BindingStamp {
        id: reference.id,
        permission_epoch: epoch,
    };
    let local = config
        .get("boundary_revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("Session permission boundary missing"))?;
    Ok(Some(PermissionBasis {
        binding: stamp,
        boundary_revision: reference.boundary_revision(local, stamp).map_err(invalid)?,
    }))
}
fn basis(request: &InteractionRequest) -> Option<PermissionBasis> {
    match request {
        InteractionRequest::Permissions { basis, .. }
        | InteractionRequest::SessionApproval { basis, .. }
        | InteractionRequest::ComputerApp { basis, .. } => Some(*basis),
        InteractionRequest::ClientCapability { basis, .. } => *basis,
        _ => None,
    }
}
fn live(view: &RunView) -> bool {
    !view.stopped && view.terminal.is_none() && matches!(view.spec.origin, RunOrigin::Local)
}
fn identity(view: &RunView, execution: &ExecutionIdentity) -> bool {
    // turn_id is presentation only and intentionally excluded from authority.
    view.run == execution.run_id && view.spec.session_id == execution.session_id
}
fn positive(outcome: &InteractionOutcome) -> bool {
    matches!(
        outcome,
        InteractionOutcome::PermissionsDecision {
            decision: PermissionDecision::Allow { .. },
            ..
        } | InteractionOutcome::SessionApprovalDecision {
            decision: Decision::Allow,
            ..
        } | InteractionOutcome::ServiceApprovalDecision {
            decision: Decision::Allow,
            ..
        } | InteractionOutcome::ClientCapabilityDecision {
            decision: Decision::Allow,
            ..
        } | InteractionOutcome::ComputerAppDecision {
            decision: ComputerAppDecision::Once
                | ComputerAppDecision::Session
                | ComputerAppDecision::Always,
            ..
        }
    )
}
fn post_admission(binding: &ApprovalBinding) -> bool {
    matches!(&binding.phase, ApprovalPhase::Host { .. })
}
fn tool_id(request: &InteractionRequest) -> Option<&str> {
    match request {
        InteractionRequest::Permissions { tool_use_id, .. } => tool_use_id.as_deref(),
        InteractionRequest::SessionApproval { tool_use_id, .. }
        | InteractionRequest::ServiceApproval { tool_use_id, .. }
        | InteractionRequest::ClientCapability { tool_use_id, .. } => Some(tool_use_id),
        _ => None,
    }
}
fn require_boundary(c: &Connection, record: &InteractionRecord) -> Result<(), StoreError> {
    let captured: Option<String> = c
        .query_row(
            "SELECT basis_json FROM agent_interaction_requests WHERE session=? AND request=?",
            params![record.execution.session_id, record.request_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let captured: Option<PermissionBasis> =
        captured.map(|raw| serde_json::from_str(&raw)).transpose()?;
    let current = current_basis(c, &record.execution.session_id)?;
    if captured.is_some_and(|expected| current != Some(expected))
        || basis(&record.request).is_some_and(|expected| current != Some(expected))
    {
        return Err(invalid("interaction permission boundary changed"));
    }
    Ok(())
}
fn pin(c: &Connection, run: RunId, reference: &ContentRef) -> Result<(), StoreError> {
    reference.validate().map_err(invalid)?;
    let content: i64 = c
        .query_row(
            "SELECT id FROM contents WHERE content_sha256=? AND length(payload)=?",
            params![reference.digest, bind_u64(reference.bytes)?],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| invalid("approval evidence bytes missing"))?;
    c.execute(
        "INSERT OR IGNORE INTO agent_content_pins VALUES(?,?)",
        params![run.to_string(), content],
    )?;
    Ok(())
}
pub(super) fn binding(
    c: &Connection,
    session: &str,
    request: &str,
) -> Result<Option<ApprovalBinding>, StoreError> {
    let raw: Option<String> = c
        .query_row(
            "SELECT binding_json FROM agent_interaction_requests WHERE session=? AND request=?",
            params![session, request],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    raw.map(|raw| Ok(serde_json::from_str(&raw)?)).transpose()
}
pub(crate) fn read(
    c: &Connection,
    session: &str,
    request: &str,
) -> Result<Option<InteractionRecord>, StoreError> {
    id(session)?;
    id(request)?;
    let row: Option<(String,Option<String>)> = c.query_row("SELECT r.record_json,o.outcome_json FROM agent_interaction_requests r LEFT JOIN agent_interaction_outcomes o ON o.request=r.request WHERE r.session=? AND r.request=?",params![session,request],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(record, outcome)| {
        let mut record: InteractionRecord = serde_json::from_str(&record)?;
        record.outcome = outcome.map(|raw| serde_json::from_str(&raw)).transpose()?;
        record.validate().map_err(invalid)?;
        if record.execution.session_id != session || record.request_id != request {
            return Err(invalid("interaction identity corrupt"));
        }
        Ok(record)
    })
    .transpose()
}
pub(super) fn establish(
    c: &Connection,
    run: RunId,
    expected: Head,
    record: InteractionRecord,
    approval: Option<ApprovalBinding>,
    contents: Vec<ContentBlob>,
) -> Result<(InteractionRecord, bool), StoreError> {
    record.validate().map_err(invalid)?;
    if record.outcome.is_some() || record.execution.run_id != run {
        return Err(invalid("invalid Agent interaction establishment"));
    }
    let session = &record.execution.session_id;
    // Resolve uncertain original writes before applying current head/Stop checks.
    if let Some(mut original) = read(c, session, &record.request_id)? {
        let outcome = original.outcome.take();
        if original != record || binding(c, session, &record.request_id)? != approval {
            return Err(StoreError::EventConflict);
        }
        original.outcome = outcome;
        return Ok((original, false));
    }
    let collision: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_interaction_requests WHERE request=?1 OR (approval IS NOT NULL AND approval=?2))",
        params![record.request_id, approval.as_ref().map(|b| b.approval.to_string())], |row| row.get(0))?;
    if collision {
        return Err(StoreError::EventConflict);
    }
    let view = crate::sql::load(c, run, &[], false)?;
    if !live(&view) || !identity(&view, &record.execution) {
        return Err(invalid("Run cannot establish interactions"));
    }
    let actual = Head::from(&view);
    if actual != expected {
        return Err(StoreError::RevisionConflict {
            expected: encode(&expected)?,
            actual: encode(&actual)?,
        });
    }
    require_boundary(c, &record)?;
    if matches!(record.request, InteractionRequest::ComputerApp { .. }) {
        crate::computer::sql::validate_request(c, &record)?;
    }
    let captured_basis = current_basis(c, session)?;
    if approval.is_some() && captured_basis.is_none() {
        return Err(invalid(
            "tool approval requires a current permission boundary",
        ));
    }
    if matches!(
        record.request,
        InteractionRequest::ClientCapability { basis: None, .. }
    ) {
        return Err(invalid(
            "Agent capability request requires a permission boundary",
        ));
    }
    if (tool_id(&record.request).is_some()
        || matches!(record.request, InteractionRequest::Permissions { .. }))
        && approval.is_none()
    {
        return Err(invalid(
            "tool permission request requires exact approval binding",
        ));
    }
    for blob in contents {
        blob.store(c)?;
    }
    if let Some(binding) = &approval {
        if let InteractionRequest::Permissions { target, .. } = &record.request
            && target != &binding.target
        {
            return Err(invalid(
                "permission target differs from canonical obligation",
            ));
        }
        if !target_pending(c, &view, binding, post_admission(binding))? {
            return Err(invalid("approval obligation no longer eligible"));
        }
        let expected_tool = match &record.request {
            InteractionRequest::Permissions { .. } => match &binding.target {
                AuthorizationObligation::Tool { tool } => Some(
                    maka_agent_facts::tool_call::tool_use_id(run, &fold::tool_key(tool)),
                ),
                AuthorizationObligation::Cell { .. } => None,
                AuthorizationObligation::External { operation, .. } => Some(
                    maka_agent_facts::tool_call::tool_use_id(run, &operation.to_string()),
                ),
            },
            _ => Some(maka_agent_facts::tool_call::tool_use_id(
                run,
                &operation_string(c, run, &binding.target)?,
            )),
        };
        if tool_id(&record.request) != expected_tool.as_deref() {
            return Err(invalid(
                "approval display tool identity differs from its original obligation",
            ));
        }
        pin(c, run, &binding.input)?;
        for resource in &binding.resources {
            match resource {
                ResourceRecovery::Reference { descriptor } => pin(c, run, descriptor)?,
                ResourceRecovery::Unavailable { .. } => {
                    return Err(invalid("cannot approve unrecoverable resources"));
                }
            }
        }
    }
    let revision = advance(c, session)?;
    c.execute("INSERT INTO agent_interaction_requests(request,session,run,created_at,revision,record_json,basis_json,approval,binding_json) VALUES(?,?,?,?,?,?,?,?,?)",params![record.request_id,session,run.to_string(),bind_u64(record.created_at)?,bind_u64(revision)?,encode(&record)?,captured_basis.as_ref().map(encode).transpose()?,approval.as_ref().map(|b|b.approval.to_string()),approval.as_ref().map(encode).transpose()?])?;
    c.execute(
        "INSERT INTO agent_interaction_pending VALUES(?,?,?)",
        params![session, bind_u64(record.created_at)?, record.request_id],
    )?;
    Ok((record, true))
}
pub(crate) fn active_session(c: &Connection, session: &str) -> Result<bool, StoreError> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?1 AND archived=0)
         AND NOT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1 AND remove_session!=0)",
        [session], |row| row.get(0),
    )?)
}
pub(super) fn fenced_answer(
    c: &Connection,
    session: &str,
    request: &str,
    outcome: InteractionOutcome,
    caller: Option<&CallerFence>,
) -> Result<(AnswerSettlement, bool), StoreError> {
    if !active_session(c, session)? {
        return Ok((AnswerSettlement::Unavailable, false));
    }
    if let Some(caller) = caller {
        match caller.status(c)? {
            CallerStatus::Current => {}
            CallerStatus::Unavailable => return Ok((AnswerSettlement::Unavailable, false)),
            CallerStatus::AuthorizationChanged => {
                return Ok((AnswerSettlement::AuthorizationChanged, false));
            }
        }
    }
    let (record, changed) = answer(c, session, request, outcome)?;
    Ok((AnswerSettlement::Recorded(record), changed))
}
pub(super) fn answer(
    c: &Connection,
    session: &str,
    request: &str,
    outcome: InteractionOutcome,
) -> Result<(InteractionRecord, bool), StoreError> {
    let mut record =
        read(c, session, request)?.ok_or_else(|| invalid("interaction request missing"))?;
    if record.outcome.is_some() {
        return Ok((record, false));
    }
    outcome
        .validate_for_request(&record.request)
        .map_err(invalid)?;
    let binding = binding(c, session, request)?;
    let post = binding.as_ref().is_some_and(post_admission);
    let target = binding.as_ref().and_then(approval_fact);
    let targets: Vec<_> = target.iter().collect();
    let view = crate::sql::load(c, record.execution.run_id, &targets, false)?;
    if !identity(&view, &record.execution) {
        return Err(invalid("interaction execution changed"));
    }
    let pending_tool = match &binding {
        Some(binding) => target_pending(c, &view, binding, post_admission(binding))?,
        None => true,
    };
    let refusal = if live(&view) && pending_tool && !post && outcome.is_approval_refusal() {
        binding.as_ref().and_then(|binding| match &binding.target {
            AuthorizationObligation::Tool { tool } => Some(Fact::ApprovalRefused {
                approval: binding.approval,
                tool: tool.clone(),
                outcome: outcome.clone(),
            }),
            _ => None,
        })
    } else {
        None
    };
    let mut eligible = positive(&outcome) && live(&view) && pending_tool;
    if eligible && matches!(record.request, InteractionRequest::ComputerApp { .. }) {
        eligible = crate::computer::sql::eligible(c, &record)?;
    }
    if eligible {
        require_boundary(c, &record)?;
        if matches!(record.request, InteractionRequest::ComputerApp { .. }) {
            crate::computer::sql::validate_request(c, &record)?;
        }
    }
    let revision = advance(c, session)?;
    c.execute(
        "INSERT INTO agent_interaction_outcomes VALUES(?,?,?,?,?)",
        params![
            request,
            session,
            bind_u64(revision)?,
            encode(&outcome)?,
            eligible
        ],
    )?;
    let source_fact = if eligible && !post {
        binding.as_ref().and_then(approval_fact)
    } else {
        refusal
    };
    if let Some(fact) = source_fact {
        let change = Change::new(
            fact,
            UnixMillis(
                i64::try_from(outcome.committed_at())
                    .map_err(|_| invalid("answer time overflow"))?,
            ),
        );
        crate::sql::append(
            c,
            view.run,
            Some(Head::from(&view)),
            &[change],
            crate::sql::AppendMaterial {
                contents: vec![],
                artifacts: &crate::artifacts::ArtifactBatch::default(),
            },
            &Mode::Control,
            None,
        )?;
    }
    record.outcome = Some(outcome);
    fold_answer(c, &record, binding.as_ref(), eligible)?;
    Ok((record, true))
}
fn fold_answer(
    c: &Connection,
    record: &InteractionRecord,
    binding: Option<&ApprovalBinding>,
    eligible: bool,
) -> Result<(), StoreError> {
    c.execute(
        "DELETE FROM agent_interaction_pending WHERE request=?",
        [&record.request_id],
    )?;
    if matches!(record.request, InteractionRequest::ComputerApp { .. }) {
        crate::computer::sql::fold_outcome(c, record, eligible)?;
    }
    if !eligible {
        return Ok(());
    }
    let session = &record.execution.session_id;
    match (&record.request, record.outcome.as_ref()) {
        (
            InteractionRequest::Permissions { basis, .. },
            Some(InteractionOutcome::PermissionsDecision {
                decision: PermissionDecision::Allow { permissions, scope },
                ..
            }),
        ) => {
            if *scope == PermissionScope::Once && binding.is_none() {
                return Err(invalid("once permission lacks a tool binding"));
            }
            let scope = match scope {
                PermissionScope::Once => "once",
                PermissionScope::Run => "run",
                PermissionScope::Session => "session",
            };
            c.execute(
                "INSERT INTO agent_interaction_grants VALUES(?,?,?,?,?,?,?,?)",
                params![
                    record.request_id,
                    session,
                    record.execution.run_id.to_string(),
                    encode(basis)?,
                    scope,
                    binding.map(|b| b.approval.to_string()),
                    binding.map(|b| encode(&b.target)).transpose()?,
                    encode(permissions)?
                ],
            )?;
        }
        (
            InteractionRequest::ClientCapability { target, basis, .. },
            Some(InteractionOutcome::ClientCapabilityDecision {
                decision: Decision::Allow,
                committed_at,
            }),
        ) => {
            let grant = SessionGrant {
                session_id: session.clone(),
                target: target.clone(),
                granted_at: *committed_at,
                basis: *basis,
            };
            c.execute("INSERT INTO agent_interaction_capabilities VALUES(?,?,?,?) ON CONFLICT(session,target) DO UPDATE SET request=excluded.request,grant_json=excluded.grant_json",params![session,encode(target)?,record.request_id,encode(&grant)?])?;
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn pending(
    c: &Connection,
    session: &str,
    after: Option<&PendingCursor>,
    limit: u32,
) -> Result<Pending, StoreError> {
    id(session)?;
    if !(1..=1024).contains(&limit) {
        return Err(invalid("page size must be 1..=1024"));
    }
    if let Some(after) = after {
        id(&after.request_id)?;
        if after.created_at > MAX_SAFE_INTEGER {
            return Err(invalid("invalid pending cursor"));
        }
    }
    let mut query = c.prepare_cached(
        "SELECT p.request FROM agent_interaction_pending p
        JOIN agent_interaction_requests q ON q.request=p.request JOIN agent_runs r ON r.run=q.run
        WHERE p.session=?1 AND r.terminal IS NULL AND (p.created_at,p.request)>(?2,?3)
        ORDER BY p.created_at,p.request LIMIT ?4",
    )?;
    let ids: Vec<String> = query
        .query_map(
            params![
                session,
                after
                    .map(|a| bind_u64(a.created_at))
                    .transpose()?
                    .unwrap_or(-1),
                after.map(|a| a.request_id.as_str()).unwrap_or(""),
                limit + 1
            ],
            |r| r.get(0),
        )?
        .collect::<Result<_, _>>()?;
    let has_more = ids.len() > limit as usize;
    let mut records = Vec::with_capacity(ids.len().min(limit as usize));
    for request in ids.into_iter().take(limit as usize) {
        records.push(
            read(c, session, &request)?
                .ok_or_else(|| invalid("pending interaction disappeared"))?,
        );
    }
    let next = if has_more {
        records.last().map(|r| PendingCursor {
            created_at: r.created_at,
            request_id: r.request_id.clone(),
        })
    } else {
        None
    };
    Ok(Pending {
        revision: revision(c, session)?,
        records,
        next,
    })
}
fn unconsumed(
    c: &Connection,
    run: RunId,
    approval: ApprovalId,
    target: &AuthorizationObligation,
) -> Result<bool, StoreError> {
    match target {
        AuthorizationObligation::Tool { .. } => Ok(c.query_row(
            "SELECT json_extract(body,'$.consumed')=0 FROM agent_approvals WHERE run=? AND key=?",
            params![run.to_string(), approval.to_string()], |r|r.get(0)).optional()?.unwrap_or(false)),
        AuthorizationObligation::Cell { cell,operation } => {
            let cell = crate::cells::read_cell(c, run, *cell)?;
            Ok(cell.children.get(operation).is_some_and(|child| child.approvals.get(&approval)==Some(&false) && !child.admitted && !child.known()))
        }
        AuthorizationObligation::External { task, operation } => {
            let original = crate::external_effects::read_original(c,run,&ExternalEffectKey { task:*task,operation:*operation })?;
            Ok(!original.admitted && !original.known())
        },
    }
}
pub(super) fn grants(
    c: &Connection,
    execution: &ExecutionIdentity,
    target: Option<&AuthorizationObligation>,
    expected: PermissionBasis,
) -> Result<Vec<PermissionGrant>, StoreError> {
    id(&execution.session_id)?;
    expected.validate().map_err(invalid)?;
    let view = crate::sql::load(c, execution.run_id, &[], false)?;
    if !identity(&view, execution)
        || !live(&view)
        || current_basis(c, &execution.session_id)? != Some(expected)
    {
        return Ok(vec![]);
    }
    type GrantRow = (
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
    );
    let rows: Vec<GrantRow> = c.prepare_cached("SELECT request,permissions,approval,scope,run,target FROM agent_interaction_grants WHERE session=?1 AND basis=?2 AND (scope='session' OR (run=?3 AND (scope='run' OR (scope='once' AND target=?4)))) ORDER BY request")?.query_map(params![execution.session_id,encode(&expected)?,execution.run_id.to_string(),target.map(encode).transpose()?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?.collect::<Result<_,_>>()?;
    let mut grants = Vec::with_capacity(rows.len());
    for (request, permissions, approval, scope, original_run, original_target) in rows {
        let scope = match scope.as_str() {
            "once" => PermissionScope::Once,
            "run" => PermissionScope::Run,
            "session" => PermissionScope::Session,
            _ => return Err(invalid("unknown permission scope")),
        };
        let approval: Option<ApprovalId> = approval
            .map(|v| serde_json::from_value(Value::String(v)))
            .transpose()?;
        let original_target: Option<AuthorizationObligation> = original_target
            .map(|v| serde_json::from_str(&v))
            .transpose()?;
        let matches =
            original_run == execution.run_id.to_string() && original_target.as_ref() == target;
        let (approval_id, once_available) = match (approval, original_target.as_ref()) {
            (Some(approval), Some(original_target)) if matches => {
                let binding = binding(c, &execution.session_id, &request)?
                    .ok_or_else(|| invalid("permission grant has no original binding"))?;
                if binding.approval != approval || binding.target != *original_target {
                    return Err(invalid("permission grant differs from original binding"));
                }
                match &binding.phase {
                    ApprovalPhase::Preparation => {
                        if unconsumed(c, execution.run_id, approval, original_target)?
                            && target_pending(c, &view, &binding, false)?
                        {
                            (Some(approval), true)
                        } else {
                            (
                                None,
                                scope == PermissionScope::Once
                                    && target_pending(c, &view, &binding, true)?,
                            )
                        }
                    }
                    ApprovalPhase::Host { .. } => (
                        None,
                        scope == PermissionScope::Once && target_pending(c, &view, &binding, true)?,
                    ),
                }
            }
            _ => (None, false),
        };
        if scope == PermissionScope::Once && !once_available {
            continue;
        }
        grants.push(PermissionGrant {
            approval_id,
            request_id: request,
            permissions: serde_json::from_str(&permissions)?,
            scope,
        });
    }
    Ok(grants)
}

pub(super) fn capability(
    c: &Connection,
    session: &str,
    target: &GrantTarget,
) -> Result<Option<SessionGrant>, StoreError> {
    id(session)?;
    let raw: Option<String> = c
        .query_row(
            "SELECT grant_json FROM agent_interaction_capabilities WHERE session=? AND target=?",
            params![session, encode(target)?],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else { return Ok(None) };
    let grant: SessionGrant = serde_json::from_str(&raw)?;
    grant.validate().map_err(invalid)?;
    if grant.session_id != session || grant.target != *target {
        return Err(invalid("capability projection identity corrupt"));
    }
    if grant.basis.is_none() || current_basis(c, session)? != grant.basis {
        return Ok(None);
    }
    Ok(Some(grant))
}
/// This check runs inside the canonical ToolAdmitted transaction. The caller
/// additionally enforces ApprovalConsumed and ToolAdmitted share that batch.
pub(crate) fn consume(
    c: &Connection,
    run: RunId,
    tool: &ToolKey,
    approval: ApprovalId,
    input: &ContentRef,
    resources: &[ResourceRecovery],
) -> Result<(), StoreError> {
    let (record, binding) = approved(c, run, approval)?;
    if binding.target != (AuthorizationObligation::Tool { tool: tool.clone() })
        || binding.input != *input
        || binding.resources != resources
    {
        return Err(invalid("approval changed tool, input or resources"));
    }
    let view = crate::sql::load(c, run, &[], false)?;
    if !live(&view) {
        return Err(invalid("approval cannot admit after Stop or terminal"));
    }
    require_boundary(c, &record)?;
    Ok(())
}
fn approved(
    c: &Connection,
    run: RunId,
    approval: ApprovalId,
) -> Result<(InteractionRecord, ApprovalBinding), StoreError> {
    let row: Option<(String,String,String,bool)> = c.query_row("SELECT r.record_json,r.binding_json,o.outcome_json,o.eligible FROM agent_interaction_requests r JOIN agent_interaction_outcomes o ON o.request=r.request WHERE r.run=? AND r.approval=?",params![run.to_string(),approval.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let (raw, binding, outcome, eligible) =
        row.ok_or_else(|| invalid("approval has no canonical human answer"))?;
    let mut record: InteractionRecord = serde_json::from_str(&raw)?;
    let binding: ApprovalBinding = serde_json::from_str(&binding)?;
    let outcome: InteractionOutcome = serde_json::from_str(&outcome)?;
    if !eligible
        || !positive(&outcome)
        || binding.approval != approval
        || record.execution.run_id != run
        || post_admission(&binding)
    {
        return Err(invalid("approval is not an eligible answer"));
    }
    record.outcome = Some(outcome);
    Ok((record, binding))
}
pub(crate) fn validate_approval_refusal(
    c: &Connection,
    run: RunId,
    approval: ApprovalId,
    tool: &ToolKey,
    expected: &InteractionOutcome,
) -> Result<(), StoreError> {
    let row:Option<(String,String,String,bool)> = c.query_row(
        "SELECT r.record_json,r.binding_json,o.outcome_json,o.eligible FROM agent_interaction_requests r JOIN agent_interaction_outcomes o ON o.request=r.request AND o.session=r.session WHERE r.run=? AND r.approval=?",
        params![run.to_string(),approval.to_string()],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
    ).optional()?;
    let (record, binding, outcome, eligible) =
        row.ok_or_else(|| invalid("approval refusal has no original negative answer"))?;
    let record: InteractionRecord = serde_json::from_str(&record)?;
    let binding: ApprovalBinding = serde_json::from_str(&binding)?;
    let outcome: InteractionOutcome = serde_json::from_str(&outcome)?;
    outcome
        .validate_for_request(&record.request)
        .map_err(invalid)?;
    if eligible
        || !outcome.is_approval_refusal()
        || outcome != *expected
        || record.execution.run_id != run
        || binding.approval != approval
        || binding.target != (AuthorizationObligation::Tool { tool: tool.clone() })
        || post_admission(&binding)
    {
        return Err(invalid(
            "approval refusal differs from its original negative answer/tool",
        ));
    }
    Ok(())
}

pub(crate) fn validate_approval(
    c: &Connection,
    run: RunId,
    approval: ApprovalId,
    tool: &ToolKey,
    input_digest: &str,
) -> Result<(), StoreError> {
    let (_, binding) = approved(c, run, approval)?;
    if binding.target != (AuthorizationObligation::Tool { tool: tool.clone() })
        || binding.input.digest != input_digest
    {
        return Err(invalid(
            "approval fact differs from original answer binding",
        ));
    }
    Ok(())
}
pub(super) fn rebuild(c: &Connection, session: &str) -> Result<u64, StoreError> {
    id(session)?;
    c.execute(
        "DELETE FROM agent_interaction_pending WHERE session=?",
        [session],
    )?;
    c.execute(
        "DELETE FROM agent_interaction_grants WHERE session=?",
        [session],
    )?;
    c.execute(
        "DELETE FROM agent_interaction_capabilities WHERE session=?",
        [session],
    )?;
    c.execute("INSERT INTO agent_interaction_pending SELECT r.session,r.created_at,r.request FROM agent_interaction_requests r LEFT JOIN agent_interaction_outcomes o ON o.request=r.request WHERE r.session=? AND o.request IS NULL",[session])?;
    // Canonical per-session revisions order capability overwrites deterministically.
    let mut after = 0u64;
    loop {
        let rows:Vec<(String,u64,bool)>=c.prepare_cached("SELECT request,revision,eligible FROM agent_interaction_outcomes WHERE session=? AND revision>? ORDER BY revision LIMIT 256")?.query_map(params![session,bind_u64(after)?],|r|Ok((r.get(0)?,read_u64(r,1)?,r.get(2)?)))?.collect::<Result<_,_>>()?;
        if rows.is_empty() {
            break;
        }
        for (request, revision, eligible) in rows {
            let record = read(c, session, &request)?
                .ok_or_else(|| invalid("canonical interaction disappeared"))?;
            fold_answer(
                c,
                &record,
                binding(c, session, &request)?.as_ref(),
                eligible,
            )?;
            after = revision;
        }
    }
    let revision:u64=c.query_row("SELECT max(coalesce((SELECT max(revision) FROM agent_interaction_requests WHERE session=?1),0),coalesce((SELECT max(revision) FROM agent_interaction_outcomes WHERE session=?1),0))",[session],|r|read_u64(r,0))?;
    c.execute("INSERT INTO agent_interaction_heads VALUES(?,?) ON CONFLICT(session) DO UPDATE SET revision=excluded.revision",params![session,bind_u64(revision)?])?;
    Ok(revision)
}
fn operation_string(
    c: &Connection,
    run: RunId,
    target: &AuthorizationObligation,
) -> Result<String, StoreError> {
    match target {
        AuthorizationObligation::Tool { tool } => Ok(fold::tool_key(tool)),
        AuthorizationObligation::Cell { cell, operation } => Ok(format!("cell:{cell}:{operation}")),
        AuthorizationObligation::External { task, operation } => {
            let key = ExternalEffectKey {
                task: *task,
                operation: *operation,
            };
            let original = crate::external_effects::read_original(c, run, &key)?;
            Ok(
                crate::external_effects::read_descriptor(c, run, &key, &original.descriptor)?
                    .operation_id,
            )
        }
    }
}
fn approval_fact(binding: &ApprovalBinding) -> Option<Fact> {
    if post_admission(binding) {
        return None;
    }
    Some(match &binding.target {
        AuthorizationObligation::Tool { tool } => Fact::ApprovalRecorded {
            approval: binding.approval,
            tool: tool.clone(),
            input_digest: binding.input.digest.clone(),
            expires_at: None,
        },
        AuthorizationObligation::Cell { cell, operation } => Fact::Cell {
            event: CellEvent::ChildApprovalRecorded {
                cell: *cell,
                operation: *operation,
                approval: binding.approval,
                input: binding.input.clone(),
                resources: binding.resources.clone(),
            },
        },
        // The original External Admitted event itself consumes the answer. No
        // invented Model/Cell approval event is needed for this independent owner.
        AuthorizationObligation::External { .. } => return None,
    })
}

fn target_pending(
    c: &Connection,
    view: &RunView,
    binding: &ApprovalBinding,
    post: bool,
) -> Result<bool, StoreError> {
    let expected_original = match &binding.phase {
        ApprovalPhase::Preparation => None,
        ApprovalPhase::Host { original } => {
            if !post {
                return Ok(false);
            }
            original
                .validate()
                .map_err(|error| invalid(error.to_string()))?;
            Some(original)
        }
    };
    // A preparation answer may remain usable inside its original admitted
    // operation only through that operation's real consumption evidence.
    let consumed_preparation = post && expected_original.is_none();
    match &binding.target {
        AuthorizationObligation::Tool { tool: key } => {
            let raw: String = c
                .query_row(
                    "SELECT body FROM agent_tools WHERE run=? AND key=?",
                    params![view.run.to_string(), fold::tool_key(key)],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| invalid("approval tool obligation missing"))?;
            let tool: fold::Tool = serde_json::from_str(&raw)?;
            let actual: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_attempt_ids WHERE run=? AND attempt=?)",
                params![view.run.to_string(), key.attempt.to_string()],
                |row| row.get(0),
            )?;
            if tool.key != *key || !actual {
                return Err(invalid(
                    "approval tool attempt differs from canonical obligation",
                ));
            }
            if let Some(ToolDecision::Approved {
                input, resources, ..
            }) = &tool.decision
            {
                if *input != binding.input || *resources != binding.resources {
                    return Err(invalid(
                        "approval input/resources differ from frozen tool decision",
                    ));
                }
            } else if post {
                return Ok(false);
            }
            if tool.admitted != post
                || tool.accepted.is_some()
                || tool.prohibited_before_host.is_some()
                || matches!(tool.decision, Some(ToolDecision::Rejected { .. }))
            {
                return Ok(false);
            }
            if post {
                let Some(original) = &tool.original else {
                    return Ok(false);
                };
                original
                    .validate()
                    .map_err(|error| invalid(error.to_string()))?;
                if expected_original.is_some_and(|expected| expected != original) {
                    return Ok(false);
                }
            } else if tool.original.is_some() {
                return Ok(false);
            }
            if consumed_preparation {
                let raw: Option<String> = c
                    .query_row(
                        "SELECT body FROM agent_approvals WHERE run=? AND key=?",
                        params![view.run.to_string(), binding.approval.to_string()],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(raw) = raw else { return Ok(false) };
                let approval: fold::Approval = serde_json::from_str(&raw)?;
                return Ok(approval.consumed
                    && approval.tool == *key
                    && approval.input_digest == binding.input.digest
                    && matches!(&tool.decision, Some(ToolDecision::Approved { approval: Some(actual), .. }) if *actual == binding.approval));
            }
            Ok(true)
        }
        AuthorizationObligation::Cell { cell, operation } => {
            if operation.is_nil() {
                return Err(invalid("nil Cell child operation"));
            }
            let cell = crate::cells::read_cell(c, view.run, *cell)?;
            let CellOwner::Agent { link, .. } = &cell.owner else {
                return Err(invalid(
                    "Standalone Cell is not an Agent authorization obligation",
                ));
            };
            if link.run != view.run {
                return Err(invalid("Cell approval differs from original AgentStepLink"));
            }
            let actual: bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_attempt_ids WHERE run=? AND step=? AND attempt=?)",params![link.run.to_string(),link.step.to_string(),link.attempt.to_string()],|row|row.get(0))?;
            if !actual {
                return Err(invalid("Cell owner Step/attempt is not canonical"));
            }
            let child = cell
                .children
                .get(operation)
                .ok_or_else(|| invalid("Cell child has no original prepared obligation"))?;
            if child.input != binding.input || child.resources != binding.resources {
                return Err(invalid(
                    "Cell approval changed exact original input/resources",
                ));
            }
            if !matches!(cell.status, CellStatus::Running)
                || child.admitted != post
                || child.known()
            {
                return Ok(false);
            }
            if post {
                let Some(original) = &child.reference else {
                    return Ok(false);
                };
                original
                    .validate()
                    .map_err(|error| invalid(error.to_string()))?;
                if expected_original.is_some_and(|expected| expected != original) {
                    return Ok(false);
                }
            } else if child.reference.is_some() {
                return Ok(false);
            }
            Ok(!consumed_preparation || child.approvals.get(&binding.approval) == Some(&true))
        }
        AuthorizationObligation::External { task, operation } => {
            let key = ExternalEffectKey {
                task: *task,
                operation: *operation,
            };
            let original = crate::external_effects::read_original(c, view.run, &key)?;
            let descriptor =
                crate::external_effects::read_descriptor(c, view.run, &key, &original.descriptor)?;
            let input = crate::ContentBlob::json(&descriptor.input)?;
            if !identity(view, &descriptor.execution)
                || input.reference() != &binding.input
                || descriptor.resources != binding.resources
            {
                return Err(invalid(
                    "External approval differs from its original immutable call descriptor",
                ));
            }
            if original.admitted != post || original.known() {
                return Ok(false);
            }
            if post {
                if !view.external.as_ref().is_some_and(|current| {
                    current.task == *task && current.admitted && current.closed.is_none()
                }) {
                    return Ok(false);
                }
                let Some(reference) = &original.reference else {
                    return Ok(false);
                };
                reference
                    .validate()
                    .map_err(|error| invalid(error.to_string()))?;
                if expected_original.is_some_and(|expected| expected != reference) {
                    return Ok(false);
                }
            } else if original.reference.is_some() {
                return Ok(false);
            }
            Ok(!consumed_preparation || original.admission_approval == Some(binding.approval))
        }
    }
}
pub(crate) fn validate_cell_approval(
    c: &Connection,
    run: RunId,
    cell: CellId,
    operation: Uuid,
    approval: ApprovalId,
    input: &ContentRef,
    resources: &[ResourceRecovery],
) -> Result<(), StoreError> {
    let (record, binding) = approved(c, run, approval)?;
    if binding.target != (AuthorizationObligation::Cell { cell, operation })
        || binding.input != *input
        || binding.resources != resources
    {
        return Err(invalid(
            "Cell approval differs from canonical human answer binding",
        ));
    }
    let view = crate::sql::load(c, run, &[], false)?;
    if !live(&view) || !target_pending(c, &view, &binding, false)? {
        return Err(invalid(
            "Cell approval cannot authorize a stopped or settled obligation",
        ));
    }
    require_boundary(c, &record)
}
pub(crate) fn consume_cell_approval(
    c: &Connection,
    run: RunId,
    cell: CellId,
    operation: Uuid,
    approval: ApprovalId,
    input: &ContentRef,
    resources: &[ResourceRecovery],
) -> Result<(), StoreError> {
    validate_cell_approval(c, run, cell, operation, approval, input, resources)?;
    let view = crate::cells::read_cell(c, run, cell)?;
    let child = view
        .children
        .get(&operation)
        .ok_or_else(|| invalid("Cell child disappeared before approval consumption"))?;
    if child.approvals.get(&approval) != Some(&false) {
        return Err(invalid("Cell approval is absent or already consumed"));
    }
    Ok(())
}
pub(crate) fn consume_external_approval(
    c: &Connection,
    run: RunId,
    key: &ExternalEffectKey,
    approval: ApprovalId,
    descriptor: &ContentRef,
) -> Result<(), StoreError> {
    let (record, binding) = approved(c, run, approval)?;
    let target = AuthorizationObligation::External {
        task: key.task,
        operation: key.operation,
    };
    if binding.target != target {
        return Err(invalid(
            "External approval targets another original operation",
        ));
    }
    let original = crate::external_effects::read_original(c, run, key)?;
    if original.descriptor != *descriptor || original.admitted || original.known() {
        return Err(invalid(
            "External approval is consumed or its original descriptor changed",
        ));
    }
    let view = crate::sql::load(c, run, &[], false)?;
    if !live(&view) || !target_pending(c, &view, &binding, false)? {
        return Err(invalid(
            "External effect is no longer eligible for admission",
        ));
    }
    require_boundary(c, &record)
}
pub(super) fn external_approval(
    c: &Connection,
    execution: &ExecutionIdentity,
    key: ExternalEffectKey,
    expected: PermissionBasis,
) -> Result<Option<ApprovalId>, StoreError> {
    expected.validate().map_err(invalid)?;
    let view = crate::sql::load(c, execution.run_id, &[], false)?;
    if !identity(&view, execution)
        || !live(&view)
        || current_basis(c, &execution.session_id)? != Some(expected)
    {
        return Ok(None);
    }
    let original = crate::external_effects::read_original(c, view.run, &key)?;
    if original.admitted || original.known() {
        return Ok(None);
    }
    let target = AuthorizationObligation::External {
        task: key.task,
        operation: key.operation,
    };
    let candidate:Option<String>=c.query_row("SELECT r.approval FROM agent_interaction_requests r JOIN agent_interaction_outcomes o ON o.request=r.request WHERE r.run=? AND r.session=? AND json_extract(r.binding_json,'$.target')=? AND r.basis_json=? AND json_extract(r.binding_json,'$.phase.kind')='preparation' AND o.eligible=1 AND json_extract(o.outcome_json,'$.kind') IN ('service_approval_decision','permissions_decision') ORDER BY r.revision DESC LIMIT 1",params![view.run.to_string(),execution.session_id,encode(&target)?,encode(&expected)?],|r|r.get(0)).optional()?;
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    let approval: ApprovalId = serde_json::from_value(Value::String(candidate))?;
    let (record, binding) = approved(c, view.run, approval)?;
    if !target_pending(c, &view, &binding, false)? {
        return Ok(None);
    }
    require_boundary(c, &record)?;
    Ok(Some(approval))
}
