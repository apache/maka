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

//! App decisions, dispatch and profile consent share the Root transaction.
use super::{RootStore, SessionStore, gates};
use crate::append::ComputerAppDispatch;
use crate::interactions::InteractionCommit;
use crate::interactions::records::{
    authority_key, decode, encode, equivalent, invalid, read_local as read,
};
use crate::{EventLog, StoreError, turns};
use maka_agent_facts::event::{CommitError, EventWrite, Fact, Invocation};
use maka_agent_facts::interaction::{
    ClosureReason, ComputerAppDecision, GrantScope, GrantTarget, InteractionOutcome,
    InteractionRecord, InteractionRequest, MAX_SAFE_INTEGER, SessionGrant, entity_id,
};
use maka_agent_facts::workspace::PermissionBasis;
use rusqlite::{Connection as SqliteConnection, OptionalExtension};
use std::sync::Arc;
pub(super) mod activity;

fn app_key(target: &GrantTarget) -> Result<String, StoreError> {
    target.validate().map_err(invalid)?;
    if !matches!(target.scope, GrantScope::ComputerApp { .. }) {
        return Err(invalid("computer app authority requires an app target"));
    }
    Ok(serde_json::to_string(&(
        &target.provider_id,
        &target.contract_id,
        target.capability,
        &target.scope,
    ))?)
}

fn revision(connection: &SqliteConnection, key: &str) -> Result<u64, StoreError> {
    let value: Option<i64> = connection
        .query_row(
            "SELECT revision FROM computer_app_profile_authority WHERE target_key=?",
            rusqlite::params![key],
            |row| row.get(0),
        )
        .optional()?;
    let value = value.unwrap_or(0);
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("invalid computer app authority revision"))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceAccess {
    Inactive,
    Managed,
    FullAccess,
}

#[derive(Clone)]
struct Source {
    session: String,
    turn: String,
    run: String,
    invocation: Option<Invocation>,
    basis: PermissionBasis,
    app: Option<(
        GrantTarget,
        maka_agent_facts::interaction::ComputerAppDisplay,
    )>,
}
impl Source {
    fn request(
        record: &InteractionRecord,
        invocation: Option<&Invocation>,
    ) -> Result<Self, StoreError> {
        let InteractionRequest::ComputerApp {
            basis,
            target,
            display,
            ..
        } = &record.request
        else {
            return Err(invalid("expected computer app request"));
        };
        if invocation.is_some_and(|invocation| {
            invocation.session_id != record.session_id
                || invocation.turn_id != record.turn_id
                || invocation.run_id != record.run_id
        }) {
            return Err(invalid("interaction does not belong to invocation"));
        }
        Ok(Self {
            session: record.session_id.clone(),
            turn: record.turn_id.clone(),
            run: record.run_id.clone(),
            invocation: invocation.cloned(),
            basis: *basis,
            app: Some((target.clone(), display.clone())),
        })
    }
    fn invocation(invocation: &Invocation, basis: PermissionBasis) -> Self {
        Self {
            session: invocation.session_id.clone(),
            turn: invocation.turn_id.clone(),
            run: invocation.run_id.clone(),
            invocation: Some(invocation.clone()),
            basis,
            app: None,
        }
    }
    fn live(&self, connection: &SqliteConnection) -> Result<bool, StoreError> {
        if let Some((target, display)) = &self.app
            && activity::stopped(
                connection,
                &self.session,
                &self.turn,
                &activity::instance_key(target, display)?,
            )?
        {
            return Ok(false);
        }
        if crate::sessions::removal::read(connection, &self.session)?.is_some()
            || crate::workspace_bindings::permission_basis(connection, &self.session)?
                != Some(self.basis)
        {
            return Ok(false);
        }
        Ok(
            turns::read(connection, &self.session, None)?.is_some_and(|turn| {
                turn.invocation.turn_id == self.turn
                    && turn.invocation.run_id == self.run
                    && self
                        .invocation
                        .as_ref()
                        .is_none_or(|expected| expected == &turn.invocation)
                    && !matches!(turn.state, turns::InvocationState::Ended { .. })
            }),
        )
    }
}

impl SessionStore {
    /// Source admission and consent share one writer transaction.
    async fn app_control<T: Send + 'static>(
        &self,
        source: Source,
        operation: impl FnOnce(&SqliteConnection, SourceAccess) -> Result<T, StoreError>
        + Send
        + 'static,
    ) -> Result<T, StoreError> {
        self.check_session(&source.session)?;
        source.basis.validate().map_err(invalid)?;
        // Accepted execution already owns its Binding pin. Reacquiring it can
        // deadlock behind a queued writer waiting for that same execution.
        // The source writer transaction also fences Session metadata commits.
        let log = self.scoped().await?;
        log.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let access = if !source.live(&tx)? {
                    SourceAccess::Inactive
                } else if crate::workspace_bindings::full_access(
                    &tx,
                    &source.session,
                    &source.basis,
                )? {
                    SourceAccess::FullAccess
                } else {
                    SourceAccess::Managed
                };
                let result = operation(&tx, access)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                Ok(result)
            })
            .await
    }

    pub async fn computer_app_authority_revision(
        &self,
        target: &GrantTarget,
    ) -> Result<u64, StoreError> {
        self.owner()?;
        let key = app_key(target)?;
        let control = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        control
            .connection
            .read(move |connection| revision(connection, &key))
            .await
    }

    pub(super) async fn establish_computer_app(
        &self,
        invocation: &Invocation,
        request: &InteractionRecord,
    ) -> Result<InteractionCommit, StoreError> {
        request.validate().map_err(invalid)?;
        if request.outcome.is_some() {
            return Err(invalid("request establishment cannot include an outcome"));
        }
        let source = Source::request(request, Some(invocation))?;
        let request = request.clone();
        self.app_control(source, move |connection, access| {
            let tx = connection;
            if let Some(mut record) = read(tx, &request.request_id)? {
                if record.session_id != request.session_id {
                    return Err(invalid("foreign Session interaction identity"));
                }
                let outcome = record.outcome.take();
                let matches = record == request;
                record.outcome = outcome;
                return Ok(InteractionCommit { matches, record });
            }
            if access == SourceAccess::Inactive {
                return Err(invalid("computer app invocation is no longer active"));
            }
            let InteractionRequest::ComputerApp {
                target,
                authority_revision,
                ..
            } = &request.request
            else {
                unreachable!()
            };
            if revision(tx, &app_key(target)?)? != *authority_revision {
                return Err(invalid(
                    "computer app authority changed before request publication",
                ));
            }
            tx.execute(
                "INSERT INTO interaction_requests VALUES(?,?,?,?)",
                rusqlite::params![
                    &request.request_id,
                    &request.session_id,
                    request.created_at as i64,
                    encode(&request)?
                ],
            )?;
            crate::sessions::advance_revision(tx, &request.session_id)?;
            Ok(InteractionCommit {
                matches: true,
                record: request,
            })
        })
        .await
    }

    pub(super) async fn commit_computer_app(
        &self,
        record: InteractionRecord,
        outcome: InteractionOutcome,
    ) -> Result<InteractionCommit, StoreError> {
        self.check_session(&record.session_id)?;
        outcome
            .validate_for_request(&record.request)
            .map_err(invalid)?;
        if let Some(existing) = &record.outcome {
            return Ok(InteractionCommit {
                matches: equivalent(existing, &outcome),
                record,
            });
        }
        let source = Source::request(&record, None)?;
        self.app_control(source, move |connection, access| {
            let tx = connection;
            let mut actual = read(tx, &record.request_id)?
                .ok_or_else(|| invalid("computer app request disappeared"))?;
            if actual.session_id != record.session_id || actual.request != record.request {
                return Err(invalid("computer app source changed"));
            }
            if let Some(existing) = &actual.outcome {
                return Ok(InteractionCommit {
                    matches: equivalent(existing, &outcome),
                    record: actual,
                });
            }
            let InteractionRequest::ComputerApp {
                target,
                authority_revision,
                ..
            } = &actual.request
            else {
                unreachable!()
            };
            let key = app_key(target)?;
            let allows = matches!(
                outcome,
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Once
                        | ComputerAppDecision::Session
                        | ComputerAppDecision::Always,
                    ..
                }
            );
            let stale_profile = matches!(
                outcome,
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Always,
                    ..
                }
            ) && revision(tx, &key)? != *authority_revision;
            let selected = if allows && (access == SourceAccess::Inactive || stale_profile) {
                InteractionOutcome::Closure {
                    reason: ClosureReason::ProducerCancelled,
                    committed_at: outcome.committed_at(),
                }
            } else {
                outcome.clone()
            };
            tx.execute(
                "INSERT INTO interaction_outcomes VALUES(?,?)",
                rusqlite::params![&actual.request_id, encode(&selected)?],
            )?;
            if matches!(
                selected,
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Always,
                    ..
                }
            ) {
                tx.execute(
                    "INSERT INTO computer_app_profile_authority VALUES(?,?,?)
                    ON CONFLICT(target_key) DO UPDATE SET source_request=excluded.source_request
                    WHERE computer_app_profile_authority.revision=excluded.revision",
                    rusqlite::params![key, *authority_revision as i64, &actual.request_id],
                )?;
            }
            if matches!(
                selected,
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Session,
                    ..
                }
            ) {
                let InteractionRequest::ComputerApp { basis, .. } = &actual.request else {
                    unreachable!()
                };
                let grant = SessionGrant {
                    session_id: actual.session_id.clone(),
                    target: target.clone(),
                    granted_at: selected.committed_at(),
                    basis: Some(*basis),
                };
                tx.execute(
                    "INSERT INTO client_capability_session_grants VALUES(?,?)
                        ON CONFLICT(authority_key) DO UPDATE SET record_json=excluded.record_json",
                    rusqlite::params![
                        authority_key(&grant.session_id, &grant.target)?,
                        encode(&grant)?
                    ],
                )?;
            }
            crate::sessions::advance_revision(tx, &actual.session_id)?;
            let matches = equivalent(&selected, &outcome);
            actual.outcome = Some(selected);
            Ok(InteractionCommit {
                matches,
                record: actual,
            })
        })
        .await
    }

    /// Observe current Session policy or recorded consent, never dispatch authority.
    /// Admission below rechecks the permission basis and profile consent at T1.
    pub async fn computer_app_granted(
        &self,
        invocation: &Invocation,
        native_operation_id: &str,
        target: &GrantTarget,
        basis: &PermissionBasis,
    ) -> Result<bool, StoreError> {
        entity_id(native_operation_id).map_err(invalid)?;
        let key = app_key(target)?;
        let target = target.clone();
        let source = Source::invocation(invocation, *basis);
        let invocation = invocation.clone();
        let operation = native_operation_id.to_owned();
        let basis = *basis;
        self.app_control(source, move |connection, access| {
            if access == SourceAccess::Inactive {
                return Ok(false);
            }
            if access == SourceAccess::FullAccess {
                return Ok(true);
            }
            let tx = connection;
            let granted = granted(tx, &invocation, &operation, &target, &key, basis)?;
            Ok(granted)
        })
        .await
    }

    /// Existing broad tool authority and original source admission remain in the
    /// dispatch T1. The app read pin prevents profile revoke from passing that
    /// exact T1, then is released before potentially long native execution.
    pub async fn append_computer_app_dispatch(
        &self,
        prefix: &[EventWrite],
        event: &EventWrite,
        targets: &[GrantTarget],
        app: &GrantTarget,
        display: &maka_agent_facts::interaction::ComputerAppDisplay,
        basis: &PermissionBasis,
    ) -> Result<maka_agent_facts::event::PrefixReceipt, CommitError> {
        self.append_app_dispatch_in_lane(
            prefix,
            event,
            targets,
            ComputerAppDispatch {
                target: app,
                display,
            },
            basis,
            crate::append::ComputerLane::Other,
        )
        .await
    }

    pub async fn append_native_computer_app_dispatch(
        &self,
        prefix: &[EventWrite],
        event: &EventWrite,
        targets: &[GrantTarget],
        app: &GrantTarget,
        display: &maka_agent_facts::interaction::ComputerAppDisplay,
        basis: &PermissionBasis,
    ) -> Result<maka_agent_facts::event::PrefixReceipt, CommitError> {
        self.append_app_dispatch_in_lane(
            prefix,
            event,
            targets,
            ComputerAppDispatch {
                target: app,
                display,
            },
            basis,
            crate::append::ComputerLane::Native,
        )
        .await
    }

    async fn append_app_dispatch_in_lane(
        &self,
        prefix: &[EventWrite],
        event: &EventWrite,
        targets: &[GrantTarget],
        app: ComputerAppDispatch<'_>,
        basis: &PermissionBasis,
        lane: crate::append::ComputerLane,
    ) -> Result<maka_agent_facts::event::PrefixReceipt, CommitError> {
        let Fact::ToolDispatched { operation_id, .. } = &event.event().fact else {
            return Err(CommitError::Rejected(
                "app admission requires a native tool dispatch".into(),
            ));
        };
        let key = app_key(app.target).map_err(super::session_store::commit_error)?;
        let pin = self
            .gates
            .read([gates::Key::ComputerApp(key)])
            .await
            .map_err(super::session_store::commit_error)?;
        if !self
            .computer_app_granted(&event.event().invocation, operation_id, app.target, basis)
            .await
            .map_err(super::session_store::commit_error)?
        {
            return Err(CommitError::PermissionRevoked);
        }
        let log = self
            .scoped()
            .await
            .map_err(super::session_store::commit_error)?;
        log.scoped(Arc::new(pin))
            .append_computer_app_dispatch(prefix, event, targets, app, basis, lane)
            .await
    }

    pub(super) async fn close_computer_app_run(
        &self,
        invocation: &Invocation,
        reason: ClosureReason,
        now: u64,
    ) -> Result<usize, StoreError> {
        self.check_session(&invocation.session_id)?;
        let log = self.scoped().await?;
        let invocation = invocation.clone();
        let outcome = InteractionOutcome::Closure {
            reason,
            committed_at: now,
        };
        outcome.validate().map_err(invalid)?;
        let notice = log.commits.session(&invocation.session_id);
        log.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let (local_count, approval_ready) =
                    crate::interactions::lifecycle::close_notified_in_transaction(
                        &tx,
                        Some(&invocation),
                        &outcome,
                    )?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                if approval_ready {
                    notice.activations();
                }
                if local_count > 0 {
                    notice.metadata();
                }
                Ok(local_count)
            })
            .await
    }
}

/// Session consent uses the existing canonical derived Session grant. Once is
/// read from its exact immutable native-effect outcome. Neither follows the
/// mutable profile revision: removing Always cannot erase independent scopes.
fn granted(
    connection: &SqliteConnection,
    invocation: &Invocation,
    operation: &str,
    target: &GrantTarget,
    key: &str,
    basis: PermissionBasis,
) -> Result<bool, StoreError> {
    let profile: Option<String> = connection
        .query_row(
            "SELECT source_request FROM computer_app_profile_authority WHERE target_key=?",
            rusqlite::params![key],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    if let Some(id) = profile {
        let record = read(connection, &id)?
            .ok_or_else(|| invalid("computer app profile source disappeared"))?;
        let InteractionRequest::ComputerApp {
            target,
            authority_revision,
            ..
        } = &record.request
        else {
            return Err(invalid("computer app profile source changed kind"));
        };
        if app_key(target)? != key
            || *authority_revision != revision(connection, key)?
            || !matches!(
                record.outcome,
                Some(InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Always,
                    ..
                })
            )
        {
            return Err(invalid("computer app profile source changed authority"));
        }
        return Ok(true);
    }
    let session_key = authority_key(&invocation.session_id, target)?;
    let session: Option<String> = connection
        .query_row(
            "SELECT record_json FROM client_capability_session_grants WHERE authority_key=?",
            rusqlite::params![&session_key],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(session) = session {
        let grant: SessionGrant = decode(&session)?;
        grant.validate().map_err(invalid)?;
        if authority_key(&grant.session_id, &grant.target)? != session_key {
            return Err(invalid("computer app Session authority changed"));
        }
        if grant.basis == Some(basis) {
            return Ok(true);
        }
    }
    let id: Option<String> = connection
        .query_row(
            "SELECT request_id FROM interaction_requests
        WHERE session_id=? AND json_extract(record_json,'$.request.kind')='computer_app'
        AND json_extract(record_json,'$.request.nativeOperationId')=?",
            rusqlite::params![&invocation.session_id, operation],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = id {
        let record =
            read(connection, &id)?.ok_or_else(|| invalid("computer app outcome disappeared"))?;
        let InteractionRequest::ComputerApp {
            target,
            basis: approved,
            native_operation_id,
            ..
        } = &record.request
        else {
            return Err(invalid("computer app outcome changed kind"));
        };
        if app_key(target)? != key || approved != &basis {
            return Ok(false);
        }
        match record.outcome {
            Some(InteractionOutcome::ComputerAppDecision {
                decision: ComputerAppDecision::Once,
                ..
            }) if record.turn_id == invocation.turn_id
                && record.run_id == invocation.run_id
                && native_operation_id == operation =>
            {
                return Ok(true);
            }
            _ => {}
        }
    }
    Ok(false)
}

fn close_control(
    connection: &SqliteConnection,
    invocation: Option<&Invocation>,
    outcome: &InteractionOutcome,
) -> Result<usize, StoreError> {
    let tx =
        rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
    let count = crate::interactions::lifecycle::close_in_transaction(&tx, invocation, outcome)?;
    if count > 0 {
        crate::sessions::advance_catalog(&tx)?;
        tx.commit().map_err(StoreError::CommitUnknown)?;
    } else {
        tx.rollback()?;
    }
    Ok(count)
}

impl EventLog {
    /// A shared workspace relocation already owns its Binding writer and control
    /// transaction. Only the permission epoch changes invalidate pending app
    /// requests; metadata-only alias changes preserve their original consent.
    pub(crate) fn close_computer_app_binding_in_transaction(
        connection: &SqliteConnection,
        binding: uuid::Uuid,
        epoch: u64,
        now: u64,
    ) -> Result<usize, StoreError> {
        let outcome = InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            committed_at: now,
        };
        outcome.validate().map_err(invalid)?;
        let ids: Vec<String> = connection
            .prepare_cached(
                "SELECT pending.request_id FROM interaction_pending pending
            CROSS JOIN interaction_requests request ON request.request_id=pending.request_id
            WHERE json_extract(request.record_json,'$.request.kind')='computer_app'
            AND json_extract(request.record_json,'$.request.basis.binding.id')=?",
            )?
            .query_map(rusqlite::params![binding.to_string()], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut count = 0;
        for id in ids {
            let record =
                read(connection, &id)?.ok_or_else(|| invalid("pending app request disappeared"))?;
            if matches!(record.request,InteractionRequest::ComputerApp { basis,.. } if basis.binding.id==binding && basis.binding.permission_epoch!=epoch)
            {
                connection.execute(
                    "INSERT INTO interaction_outcomes VALUES(?,?)",
                    rusqlite::params![id, encode(&outcome)?],
                )?;
                count += 1;
            }
        }
        Ok(count)
    }
}

impl RootStore {
    /// Host-only profile operation. It neither stops an in-flight physical action
    /// nor removes independent Once/Session consent. The app gate is held only
    /// through native T1, so revocation does not wait for a long accepted action.
    pub async fn revoke_computer_app_profile_grant(
        &self,
        target: &GrantTarget,
    ) -> Result<u64, StoreError> {
        self.require_open()?;
        let key = app_key(target)?;
        let pin = self
            .gates
            .write([gates::Key::ComputerApp(key.clone())])
            .await?;
        self.log.scoped(Arc::new(pin)).connection.run(move |connection| {
            let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
            let current = revision(&tx, &key)?;
            let next = current.checked_add(1).filter(|next| *next <= MAX_SAFE_INTEGER)
                .ok_or_else(|| invalid("computer app authority revision exhausted"))?;
            tx.execute("INSERT INTO computer_app_profile_authority VALUES(?,?,NULL)
                ON CONFLICT(target_key) DO UPDATE SET revision=excluded.revision,source_request=NULL", rusqlite::params![key, next as i64])?;
            crate::sessions::advance_catalog(&tx)?;
            tx.commit().map_err(StoreError::CommitUnknown)?;
            Ok(next)
        }).await
    }

    pub(super) async fn close_abandoned_computer_apps(
        &self,
        now: u64,
        custody: crate::connection::custody::Custody,
    ) -> Result<usize, StoreError> {
        let outcome = InteractionOutcome::Closure {
            reason: ClosureReason::HostRestarted,
            committed_at: now,
        };
        self.log
            .scoped(custody)
            .connection
            .run(move |connection| close_control(connection, None, &outcome))
            .await
    }
}

#[cfg(test)]
mod tests;
