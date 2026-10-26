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

use super::records::{invalid, read};
use crate::{EventLog, StoreError};
use maka_agent_facts::event::Invocation;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use maka_agent_facts::interaction::entity_id;
use maka_agent_facts::workspace::PermissionBasis;
use maka_sandbox::grant::{Decision, Permissions, Scope};
use sqlx::Connection;

/// A projection of an immutable approval outcome, never another grant ledger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionGrant {
    pub request_id: String,
    pub permissions: Permissions,
    pub scope: Scope,
}

pub(super) async fn require_revision(
    connection: &mut sqlx::SqliteConnection,
    record: &InteractionRecord,
) -> Result<(), StoreError> {
    let expected = match &record.request {
        InteractionRequest::Permissions { basis, .. }
        | InteractionRequest::ClientCapability {
            basis: Some(basis), ..
        } => Some(*basis),
        _ => None,
    };
    if let Some(expected) = expected
        && crate::workspace_bindings::permission_basis(connection, &record.session_id).await?
            != Some(expected)
    {
        return Err(invalid("permission request has a stale Session boundary"));
    }
    Ok(())
}

impl EventLog {
    /// Caller must separately admit this exact effect. A once grant belongs to
    /// its original Run/tool-use identity, not every operation with equal args.
    /// Session policy changes invalidate all approvals from the previous basis.
    /// Without a tool-use identity, only Turn and Session grants are visible.
    pub async fn permission_grants(
        &self,
        invocation: &Invocation,
        tool_use_id: Option<&str>,
        basis: &PermissionBasis,
    ) -> Result<Vec<PermissionGrant>, StoreError> {
        self.validate_root()?;
        for id in [
            &invocation.session_id,
            &invocation.turn_id,
            &invocation.run_id,
        ] {
            entity_id(id).map_err(invalid)?;
        }
        if tool_use_id.is_some_and(|id| id.is_empty()) || basis.validate().is_err() {
            return Err(invalid("invalid permission observation identity"));
        }
        let invocation = invocation.clone();
        let basis = *basis;
        let tool_use_id = tool_use_id.map(str::to_owned);
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            if crate::workspace_bindings::permission_basis(&mut tx, &invocation.session_id).await? != Some(basis) {
                return Ok(Vec::new());
            }
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT request.request_id FROM interaction_requests AS request
                 JOIN interaction_outcomes AS outcome ON outcome.request_id = request.request_id
                 WHERE request.session_id = ?
                 AND json_extract(request.record_json, '$.request.kind') = 'permissions'
                 AND json_extract(request.record_json, '$.request.basis.boundaryRevision') = ?
                 AND json_extract(request.record_json, '$.request.basis.binding.id') = ?
                 AND json_extract(request.record_json, '$.request.basis.binding.permissionEpoch') = ?
                 AND json_extract(outcome.outcome_json, '$.kind') = 'permissions_decision'
                 AND json_extract(outcome.outcome_json, '$.decision.decision') = 'allow'
                 AND (json_extract(outcome.outcome_json, '$.decision.scope') = 'session'
                      OR (json_extract(request.record_json, '$.turnId') = ?
                          AND (json_extract(outcome.outcome_json, '$.decision.scope') = 'turn'
                               OR (json_extract(outcome.outcome_json, '$.decision.scope') = 'once'
                                   AND json_extract(request.record_json, '$.runId') = ?
                                   AND json_extract(request.record_json, '$.request.toolUseId') = ?))))
                 ORDER BY request.created_at, request.request_id",
            ).bind(&invocation.session_id).bind(basis.boundary_revision as i64).bind(basis.binding.id.to_string()).bind(basis.binding.permission_epoch as i64).bind(&invocation.turn_id)
                .bind(&invocation.run_id).bind(&tool_use_id).fetch_all(&mut *tx).await?;
            let mut grants = Vec::with_capacity(ids.len());
            for id in ids {
                let record = read(&mut tx, &id).await?.ok_or_else(|| invalid("permission outcome disappeared"))?;
                let Some(InteractionOutcome::PermissionsDecision { decision: Decision::Allow { permissions, scope }, .. }) = record.outcome else {
                    return Err(invalid("permission outcome changed kind"));
                };
                grants.push(PermissionGrant { request_id: id, permissions, scope });
            }
            tx.commit().await?;
            Ok(grants)
        })).await
    }
}

/// Called only inside the owning metadata CAS. Existing first-writer outcomes
/// stay immutable; the new revision makes those earlier grants inapplicable.
pub(crate) async fn close_previous_basis(
    connection: &mut sqlx::SqliteConnection,
    session: &str,
    previous: PermissionBasis,
    now: u64,
) -> Result<usize, StoreError> {
    let current = crate::workspace_bindings::permission_basis(connection, session)
        .await?
        .ok_or_else(|| invalid("Session permission boundary disappeared"))?;
    if current == previous {
        return Ok(0);
    }
    if current.boundary_revision < previous.boundary_revision
        || (current.binding == previous.binding
            && current.boundary_revision <= previous.boundary_revision)
    {
        return Err(invalid("Session permission boundary must advance"));
    }
    let closure = InteractionOutcome::Closure {
        reason: maka_agent_facts::interaction::ClosureReason::ProducerCancelled,
        committed_at: now,
    };
    let mut closed = 0;
    for record in super::pending(connection, session).await? {
        if matches!(record.request,
            InteractionRequest::Permissions { basis, .. }
            | InteractionRequest::ClientCapability { basis: Some(basis), .. }
            if basis == previous)
        {
            closure
                .validate_for_request(&record.request)
                .map_err(invalid)?;
            sqlx::query("INSERT INTO interaction_outcomes VALUES (?, ?)")
                .bind(&record.request_id)
                .bind(super::records::encode(&closure)?)
                .execute(&mut *connection)
                .await?;
            closed += 1;
        }
    }
    Ok(closed)
}
