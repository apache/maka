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

//! Append-only requests/outcomes and atomically derived Session grants.
mod browser;
pub(crate) mod lifecycle;
#[cfg(test)]
mod pending_tests;
pub(crate) mod permissions;
pub(crate) mod records;
pub use permissions::PermissionGrant;

use crate::{EventLog, StoreError};
use maka_agent_facts::interaction::Decision;
use maka_agent_facts::interaction::GrantTarget;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use maka_agent_facts::interaction::SessionGrant;
use maka_agent_facts::interaction::entity_id;
use records::{invalid, read_local};
use rusqlite::OptionalExtension;

/// A conflicting retry returns the actual canonical fact, never the candidate.
pub struct InteractionCommit {
    pub matches: bool,
    pub record: InteractionRecord,
}

impl EventLog {
    /// Publish for the exact live execution in the insertion transaction.
    pub async fn establish_run_interaction(
        &self,
        invocation: &maka_agent_facts::event::Invocation,
        request: &InteractionRecord,
    ) -> Result<InteractionCommit, StoreError> {
        if request.session_id != invocation.session_id
            || request.turn_id != invocation.turn_id
            || request.run_id != invocation.run_id
        {
            return Err(invalid("interaction does not belong to invocation"));
        }
        entity_id(&invocation.invocation_id).map_err(invalid)?;
        self.establish(request, Some(invocation.clone())).await
    }

    pub async fn establish_interaction(
        &self,
        request: &InteractionRecord,
    ) -> Result<InteractionCommit, StoreError> {
        self.establish(request, None).await
    }

    async fn establish(
        &self,
        request: &InteractionRecord,
        invocation: Option<maka_agent_facts::event::Invocation>,
    ) -> Result<InteractionCommit, StoreError> {
        request.validate().map_err(invalid)?;
        if matches!(request.request, InteractionRequest::ComputerApp { .. }) {
            return Err(invalid("computer application consent is owned by the Root"));
        }
        if request.outcome.is_some() {
            return Err(invalid("request establishment cannot include an outcome"));
        }
        self.check_bound_session(&request.session_id)?;
        let expected_session = self.expected_session.clone();
        let encoded = records::encode(request)?;
        let request = request.clone();
        let commits = self.commits.session(&request.session_id);
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                require_local_identity(&tx, &request.request_id, &request.session_id)?;
                if let Some(mut record) = read_local(&tx, &request.request_id)? {
                    Self::require_session_scope(expected_session.as_deref(), &record.session_id)?;
                    let outcome = record.outcome.take();
                    let matches = record == request;
                    record.outcome = outcome;
                    return Ok(InteractionCommit { matches, record });
                }
                crate::sessions::removal::require_accepting(&tx, &request.session_id)?;
                if let Some(invocation) = invocation {
                    let turn = crate::turns::read(&tx, &request.session_id, None)?
                        .ok_or_else(|| invalid("interaction invocation is unavailable"))?;
                    if turn.invocation != invocation
                        || matches!(turn.state, crate::turns::InvocationState::Ended { .. })
                    {
                        return Err(invalid("interaction invocation is no longer active"));
                    }
                }
                permissions::require_revision(&tx, &request)?;
                tx.execute(
                    "INSERT INTO interaction_requests VALUES (?, ?, ?, ?)",
                    rusqlite::params![
                        &request.request_id,
                        &request.session_id,
                        request.created_at as i64,
                        encoded
                    ],
                )?;
                crate::sessions::advance_revision(&tx, &request.session_id)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                commits.metadata();
                Ok(InteractionCommit {
                    matches: true,
                    record: request,
                })
            })
            .await
    }

    /// First outcome wins. Only that outcome can create its matching grant.
    /// Callers cannot accidentally grant another provider, scope, or Session.
    pub async fn commit_interaction_outcome(
        &self,
        request_id: &str,
        outcome: InteractionOutcome,
    ) -> Result<InteractionCommit, StoreError> {
        entity_id(request_id).map_err(invalid)?;
        outcome.validate().map_err(invalid)?;
        if matches!(outcome, InteractionOutcome::ComputerAppDecision { .. }) {
            return Err(invalid("computer application consent is owned by the Root"));
        }
        let expected_session = self.expected_session.clone();
        let request_id = request_id.to_owned();
        let commits = self.commits.notice();
        self.connection
            .run(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
                    let mut record = read_local(&tx, &request_id)
                        ?
                        .ok_or_else(|| invalid("interaction request not found"))?;
                    Self::require_session_scope(expected_session.as_deref(), &record.session_id)?;
                    require_local_identity(&tx, &request_id, &record.session_id)?;
                    if matches!(record.request, InteractionRequest::ComputerApp { .. }) {
                        return Err(invalid("computer application consent is owned by the Root"));
                    }
                    outcome
                        .validate_for_request(&record.request)
                        .map_err(invalid)?;
                    if let Some(existing) = &record.outcome {
                        return Ok(InteractionCommit {
                            matches: records::equivalent(existing, &outcome),
                            record,
                        });
                    }
                    if matches!(
                        &outcome,
                        InteractionOutcome::PermissionsDecision {
                            decision: maka_sandbox::grant::Decision::Allow { .. },
                            ..
                        }
                        | InteractionOutcome::ClientCapabilityDecision { decision: Decision::Allow, .. }
                        | InteractionOutcome::SessionApprovalDecision { decision: Decision::Allow, .. }
                    ) {
                        permissions::require_revision(&tx, &record)?;
                    }
                    tx.execute("INSERT INTO interaction_outcomes VALUES (?, ?)", rusqlite::params![&request_id, records::encode(&outcome)?])
                        ?;
                    if let InteractionOutcome::ClientCapabilityDecision {
                        decision: Decision::Allow,
                        committed_at,
                    } = &outcome
                    {
                        let InteractionRequest::ClientCapability { target, basis, .. } = &record.request
                        else {
                            return Err(invalid("grant outcome requires capability request"));
                        };
                        let grant = SessionGrant {
                            session_id: record.session_id.clone(),
                            target: target.clone(),
                            granted_at: *committed_at,
                            basis: *basis,
                        };
                        tx.execute("INSERT INTO client_capability_session_grants VALUES (?, ?)
                             ON CONFLICT(authority_key) DO UPDATE SET record_json=excluded.record_json
                             WHERE json_type(excluded.record_json,'$.basis')='object'
", rusqlite::params![records::authority_key(&grant.session_id, &grant.target)?, records::encode(&grant)?])
                        ?;
                    }
                    let approval_ready = crate::native_approvals::waits_for_interaction(&tx, &request_id)?;
                    let commits = commits.for_session(&record.session_id);
                    record.outcome = Some(outcome);
                    crate::sessions::advance_revision(&tx, &record.session_id)?;
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.metadata();
                    if approval_ready { commits.activations(); }
                    Ok(InteractionCommit {
                        matches: true,
                        record,
                    })
                }
            })
            .await
    }

    pub async fn interaction(
        &self,
        request_id: &str,
    ) -> Result<Option<InteractionRecord>, StoreError> {
        entity_id(request_id).map_err(invalid)?;
        let expected_session = self.expected_session.clone();
        let request_id = request_id.to_owned();
        self.connection
            .read_interruptible(move |connection| {
                let record =
                    records::read_scoped(connection, &request_id, expected_session.as_deref())?;
                if let Some(record) = &record {
                    Self::require_session_scope(expected_session.as_deref(), &record.session_id)?;
                }
                Ok(record)
            })
            .await
    }

    pub async fn pending_interactions(
        &self,
        session_id: &str,
    ) -> Result<Vec<InteractionRecord>, StoreError> {
        entity_id(session_id).map_err(invalid)?;
        let session_id = session_id.to_owned();
        self.connection
            .read_interruptible(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let result = pending(&tx, &session_id)?;
                tx.commit()?;
                Ok(result)
            })
            .await
    }

    pub async fn client_capability_grant(
        &self,
        session_id: &str,
        target: &GrantTarget,
    ) -> Result<Option<SessionGrant>, StoreError> {
        let session_id = session_id.to_owned();
        let target = target.clone();
        self.connection
            .read_interruptible(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let result = capability_grant(&tx, &session_id, &target)?;
                tx.commit()?;
                Ok(result)
            })
            .await
    }
}

fn require_local_identity(
    connection: &rusqlite::Connection,
    request_id: &str,
    session_id: &str,
) -> Result<(), StoreError> {
    let root: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM interaction_requests WHERE request_id=? AND session_id=? AND json_extract(record_json,'$.request.kind')='computer_app')", rusqlite::params![request_id, session_id], |row| row.get(0))
    ?;
    if root {
        return Err(invalid("interaction identity belongs to the Root"));
    }
    Ok(())
}

/// Original grant and current permission boundary observed in one transaction.
pub(crate) fn capability_grant(
    connection: &rusqlite::Connection,
    session: &str,
    target: &GrantTarget,
) -> Result<Option<SessionGrant>, StoreError> {
    let key = records::authority_key(session, target)?;
    let raw: Option<String> = connection
        .query_row(
            "SELECT record_json FROM client_capability_session_grants WHERE authority_key = ?",
            rusqlite::params![&key],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let grant: SessionGrant = records::decode(&raw)?;
    grant.validate().map_err(invalid)?;
    if records::authority_key(&grant.session_id, &grant.target)? != key {
        return Err(invalid("stored Session grant authority changed"));
    }
    if let Some(basis) = grant.basis
        && crate::workspace_bindings::permission_basis(connection, session)? != Some(basis)
    {
        return Ok(None);
    }
    Ok(Some(grant))
}

const PENDING_INTERACTIONS: &str = "SELECT request_id,created_at FROM interaction_pending
    WHERE session_id=?1
    ORDER BY created_at,request_id";

/// Read inside the caller's observation transaction for a coherent projection.
pub(crate) fn pending(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<InteractionRecord>, StoreError> {
    let ids: Vec<String> = connection
        .prepare_cached(PENDING_INTERACTIONS)?
        .query_map(rusqlite::params![session_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut records = Vec::with_capacity(ids.len());
    for id in ids {
        records.push(
            records::read_scoped(connection, &id, Some(session_id))?
                .ok_or_else(|| invalid("stored interaction disappeared"))?,
        );
    }
    Ok(records)
}
