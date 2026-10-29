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

//! App decisions and profile persistence have one authority: the Root control
//! transaction. Session partitions only read those facts through their existing
//! read-only attachment. The only cross-writer wait is partition -> control;
//! control callbacks never wait for a partition, a gate, or a human response.
use super::{RootStore, SessionStore, gates};
use crate::connection::BoxFuture;
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
use sqlx::{Connection, SqliteConnection};
use std::sync::Arc;
pub(super) mod activity;

// Only the existing Root active-work barrier is extended, with no new lock or
// authority state. App control ends this dependency at source SQL cleanup before
// any human wait or physical action; a browser service receipt retains it through
// settlement SQL cleanup. Accepted execution already owns the same barrier.
struct ControlDependency(Arc<gates::Gates>);
impl Drop for ControlDependency {
    fn drop(&mut self) {
        self.0.finish_work();
    }
}

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

async fn revision(connection: &mut SqliteConnection, key: &str) -> Result<u64, StoreError> {
    let value: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM computer_app_profile_authority WHERE target_key=?",
    )
    .bind(key)
    .fetch_optional(connection)
    .await?;
    let value = value.unwrap_or(0);
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("invalid computer app authority revision"))
}

#[derive(Clone)]
struct Source {
    session: String,
    turn: String,
    run: String,
    invocation: Option<Invocation>,
    basis: PermissionBasis,
    request_id: Option<String>,
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
            request_id: Some(record.request_id.clone()),
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
            request_id: None,
            app: None,
        }
    }
    async fn live(&self, connection: &mut SqliteConnection) -> Result<bool, StoreError> {
        if let Some((target, display)) = &self.app
            && activity::stopped(
                connection,
                &self.session,
                &self.turn,
                &activity::instance_key(target, display)?,
            )
            .await?
        {
            return Ok(false);
        }
        if crate::sessions::removal::read(connection, &self.session)
            .await?
            .is_some()
            || crate::workspace_bindings::permission_basis(connection, &self.session).await?
                != Some(self.basis)
        {
            return Ok(false);
        }
        Ok(turns::read(connection, &self.session, None)
            .await?
            .is_some_and(|turn| {
                turn.invocation.turn_id == self.turn
                    && turn.invocation.run_id == self.run
                    && self
                        .invocation
                        .as_ref()
                        .is_none_or(|expected| expected == &turn.invocation)
                    && !matches!(turn.state, turns::InvocationState::Ended { .. })
            }))
    }
}

impl SessionStore {
    pub(super) fn control_dependency(
        &self,
    ) -> Result<Option<crate::connection::custody::Custody>, StoreError> {
        if self.execution.is_some() {
            return Ok(None);
        }
        self.gates.start_work()?;
        Ok(Some(Arc::new(ControlDependency(self.gates.clone()))))
    }

    async fn control_source(&self) -> Result<EventLog, StoreError> {
        let dependency = self.control_dependency()?;
        let partition = self.scoped().await?;
        Ok(if let Some(dependency) = dependency {
            partition.scoped(dependency)
        } else {
            partition
        })
    }

    /// Pins are acquired before SQL. A short source writer transaction prevents
    /// terminal facts from crossing publication or an allowing response. The
    /// control transaction alone commits authority; no multi-database atomicity
    /// or replicated grant is assumed if the source reader later fails.
    async fn app_control<T: Send + 'static>(
        &self,
        source: Source,
        operation: impl for<'c> FnOnce(
            &'c mut SqliteConnection,
            bool,
        ) -> BoxFuture<'c, Result<T, StoreError>>
        + Send
        + 'static,
    ) -> Result<T, StoreError> {
        self.check_session(&source.session)?;
        source.basis.validate().map_err(invalid)?;
        // Accepted execution already owns its Binding pin. Reacquiring it can
        // deadlock behind a queued writer waiting for that same execution.
        // The source writer transaction also fences Session metadata commits.
        let partition = self.control_source().await?;
        let control = self.control.upgrade().ok_or(StoreError::ConnectionClosed)?;
        partition
            .connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    if let Some(request_id) = &source.request_id
                        && sqlx::query_scalar::<_, bool>(
                            "SELECT EXISTS(SELECT 1 FROM interaction_requests WHERE request_id=?)",
                        )
                        .bind(request_id)
                        .fetch_one(&mut *tx)
                        .await?
                    {
                        return Err(invalid(
                            "interaction ID already belongs to the Session partition",
                        ));
                    }
                    let live = source.live(&mut tx).await?;
                    let result = control
                        .connection
                        .run(move |connection| operation(connection, live))
                        .await;
                    tx.rollback().await?;
                    result
                })
            })
            .await
    }

    pub async fn computer_app_authority_revision(
        &self,
        target: &GrantTarget,
    ) -> Result<u64, StoreError> {
        self.owner()?;
        let key = app_key(target)?;
        let control = self.control.upgrade().ok_or(StoreError::ConnectionClosed)?;
        control
            .connection
            .read(move |connection| Box::pin(async move { revision(connection, &key).await }))
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
        self.app_control(source, move |connection, live| {
            Box::pin(async move {
                let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                if let Some(mut record) = read(&mut tx, &request.request_id).await? {
                    if record.session_id != request.session_id {
                        return Err(invalid("foreign Session interaction identity"));
                    }
                    let outcome = record.outcome.take();
                    let matches = record == request;
                    record.outcome = outcome;
                    return Ok(InteractionCommit { matches, record });
                }
                if !live {
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
                if revision(&mut tx, &app_key(target)?).await? != *authority_revision {
                    return Err(invalid(
                        "computer app authority changed before request publication",
                    ));
                }
                sqlx::query("INSERT INTO interaction_requests VALUES(?,?,?,?)")
                    .bind(&request.request_id)
                    .bind(&request.session_id)
                    .bind(request.created_at as i64)
                    .bind(encode(&request)?)
                    .execute(&mut *tx)
                    .await?;
                crate::sessions::advance_catalog(&mut tx).await?;
                tx.commit().await.map_err(StoreError::CommitUnknown)?;
                Ok(InteractionCommit {
                    matches: true,
                    record: request,
                })
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
        self.app_control(source, move |connection, live| {
            Box::pin(async move {
                let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                let mut actual = read(&mut tx, &record.request_id)
                    .await?
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
                ) && revision(&mut tx, &key).await? != *authority_revision;
                let selected = if allows && (!live || stale_profile) {
                    InteractionOutcome::Closure {
                        reason: ClosureReason::ProducerCancelled,
                        committed_at: outcome.committed_at(),
                    }
                } else {
                    outcome.clone()
                };
                sqlx::query("INSERT INTO interaction_outcomes VALUES(?,?)")
                    .bind(&actual.request_id)
                    .bind(encode(&selected)?)
                    .execute(&mut *tx)
                    .await?;
                if matches!(
                    selected,
                    InteractionOutcome::ComputerAppDecision {
                        decision: ComputerAppDecision::Always,
                        ..
                    }
                ) {
                    sqlx::query(
                        "INSERT INTO computer_app_profile_authority VALUES(?,?,?)
                    ON CONFLICT(target_key) DO UPDATE SET source_request=excluded.source_request
                    WHERE computer_app_profile_authority.revision=excluded.revision",
                    )
                    .bind(key)
                    .bind(*authority_revision as i64)
                    .bind(&actual.request_id)
                    .execute(&mut *tx)
                    .await?;
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
                    sqlx::query(
                        "INSERT INTO client_capability_session_grants VALUES(?,?)
                        ON CONFLICT(authority_key) DO UPDATE SET record_json=excluded.record_json",
                    )
                    .bind(authority_key(&grant.session_id, &grant.target)?)
                    .bind(encode(&grant)?)
                    .execute(&mut *tx)
                    .await?;
                }
                crate::sessions::advance_catalog(&mut tx).await?;
                tx.commit().await.map_err(StoreError::CommitUnknown)?;
                let matches = equivalent(&selected, &outcome);
                actual.outcome = Some(selected);
                Ok(InteractionCommit {
                    matches,
                    record: actual,
                })
            })
        })
        .await
    }

    /// This is an observation, never dispatch authority. Admission below checks
    /// the immutable decision again while fencing profile revocation through T1.
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
        self.app_control(source, move |connection, live| {
            Box::pin(async move {
                if !live {
                    return Ok(false);
                }
                let mut tx = connection.begin().await?;
                let granted =
                    granted(&mut tx, &invocation, &operation, &target, &key, basis).await?;
                tx.commit().await?;
                Ok(granted)
            })
        })
        .await
    }

    /// Existing broad tool authority and original source admission remain in the
    /// partition T1. The app read pin prevents profile revoke from passing that
    /// exact T1, then is released before potentially long native execution.
    pub async fn append_computer_app_dispatch(
        &self,
        prefix: &[EventWrite],
        event: &EventWrite,
        targets: &[GrantTarget],
        app: &GrantTarget,
        display: &maka_agent_facts::interaction::ComputerAppDisplay,
        basis: &PermissionBasis,
    ) -> Result<u64, CommitError> {
        self.append_app_dispatch_in_lane(
            prefix,
            event,
            targets,
            (app, display),
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
    ) -> Result<u64, CommitError> {
        self.append_app_dispatch_in_lane(
            prefix,
            event,
            targets,
            (app, display),
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
        app: (
            &GrantTarget,
            &maka_agent_facts::interaction::ComputerAppDisplay,
        ),
        basis: &PermissionBasis,
        lane: crate::append::ComputerLane,
    ) -> Result<u64, CommitError> {
        let (app, display) = app;
        let Fact::ToolDispatched { operation_id, .. } = &event.event().fact else {
            return Err(CommitError::Rejected(
                "app admission requires a native tool dispatch".into(),
            ));
        };
        let key = app_key(app).map_err(super::session_store::commit_error)?;
        let pin = self
            .gates
            .read([gates::Key::ComputerApp(key)])
            .await
            .map_err(super::session_store::commit_error)?;
        if !self
            .computer_app_granted(&event.event().invocation, operation_id, app, basis)
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
            .append_computer_app_dispatch(prefix, event, targets, (app, display), basis, lane)
            .await
    }

    pub(super) async fn close_computer_app_run(
        &self,
        invocation: &Invocation,
        reason: ClosureReason,
        now: u64,
    ) -> Result<usize, StoreError> {
        self.check_session(&invocation.session_id)?;
        let partition = self.control_source().await?;
        let control = self.control.upgrade().ok_or(StoreError::ConnectionClosed)?;
        let invocation = invocation.clone();
        let outcome = InteractionOutcome::Closure {
            reason,
            committed_at: now,
        };
        outcome.validate().map_err(invalid)?;
        let notice = partition.commits.session(&invocation.session_id);
        partition
            .connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let root_scope = invocation.clone();
                    let root_outcome = outcome.clone();
                    let root_count = control
                        .connection
                        .run(move |connection| {
                            Box::pin(async move {
                                close_control(connection, Some(&root_scope), &root_outcome).await
                            })
                        })
                        .await?;
                    let local_count = crate::interactions::lifecycle::close_in_transaction(
                        &mut tx,
                        Some(&invocation),
                        &outcome,
                    )
                    .await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    if local_count > 0 {
                        notice.metadata();
                    }
                    Ok(root_count + local_count)
                })
            })
            .await
    }
}

/// Session consent uses the existing canonical derived Session grant. Once is
/// read from its exact immutable native-effect outcome. Neither follows the
/// mutable profile revision: removing Always cannot erase independent scopes.
async fn granted(
    connection: &mut SqliteConnection,
    invocation: &Invocation,
    operation: &str,
    target: &GrantTarget,
    key: &str,
    basis: PermissionBasis,
) -> Result<bool, StoreError> {
    let profile: Option<String> = sqlx::query_scalar(
        "SELECT source_request FROM computer_app_profile_authority WHERE target_key=?",
    )
    .bind(key)
    .fetch_optional(&mut *connection)
    .await?
    .flatten();
    if let Some(id) = profile {
        let record = read(connection, &id)
            .await?
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
            || *authority_revision != revision(connection, key).await?
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
    let session: Option<String> = sqlx::query_scalar(
        "SELECT record_json FROM client_capability_session_grants WHERE authority_key=?",
    )
    .bind(&session_key)
    .fetch_optional(&mut *connection)
    .await?;
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
    let id: Option<String> = sqlx::query_scalar(
        "SELECT request_id FROM interaction_requests
        WHERE session_id=? AND json_extract(record_json,'$.request.kind')='computer_app'
        AND json_extract(record_json,'$.request.nativeOperationId')=?",
    )
    .bind(&invocation.session_id)
    .bind(operation)
    .fetch_optional(&mut *connection)
    .await?;
    if let Some(id) = id {
        let record = read(connection, &id)
            .await?
            .ok_or_else(|| invalid("computer app outcome disappeared"))?;
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

async fn close_control(
    connection: &mut SqliteConnection,
    invocation: Option<&Invocation>,
    outcome: &InteractionOutcome,
) -> Result<usize, StoreError> {
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    let count =
        crate::interactions::lifecycle::close_in_transaction(&mut tx, invocation, outcome).await?;
    if count > 0 {
        crate::sessions::advance_catalog(&mut tx).await?;
        tx.commit().await.map_err(StoreError::CommitUnknown)?;
    } else {
        tx.rollback().await?;
    }
    Ok(count)
}

impl EventLog {
    /// A shared workspace relocation already owns its Binding writer and control
    /// transaction. Only the permission epoch changes invalidate pending app
    /// requests; metadata-only alias changes preserve their original consent.
    pub(crate) async fn close_computer_app_binding_in_transaction(
        connection: &mut SqliteConnection,
        binding: uuid::Uuid,
        epoch: u64,
        now: u64,
    ) -> Result<usize, StoreError> {
        let outcome = InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            committed_at: now,
        };
        outcome.validate().map_err(invalid)?;
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT pending.request_id FROM interaction_pending pending
            CROSS JOIN interaction_requests request ON request.request_id=pending.request_id
            WHERE json_extract(request.record_json,'$.request.kind')='computer_app'
            AND json_extract(request.record_json,'$.request.basis.binding.id')=?",
        )
        .bind(binding.to_string())
        .fetch_all(&mut *connection)
        .await?;
        let mut count = 0;
        for id in ids {
            let record = read(connection, &id)
                .await?
                .ok_or_else(|| invalid("pending app request disappeared"))?;
            if matches!(record.request,InteractionRequest::ComputerApp { basis,.. } if basis.binding.id==binding && basis.binding.permission_epoch!=epoch)
            {
                sqlx::query("INSERT INTO interaction_outcomes VALUES(?,?)")
                    .bind(id)
                    .bind(encode(&outcome)?)
                    .execute(&mut *connection)
                    .await?;
                count += 1;
            }
        }
        Ok(count)
    }

    /// RootStore passes its control owner into the accepted source metadata job.
    /// Root facts retire after the source boundary commits, before that actor
    /// accepts another response/publication. The readonly attachment stays so.
    pub(crate) async fn close_computer_app_previous_basis(
        &self,
        session: &str,
        previous: PermissionBasis,
        now: u64,
    ) -> Result<usize, StoreError> {
        let session = session.to_owned();
        let outcome = InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            committed_at: now,
        };
        outcome.validate().map_err(invalid)?;
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx=connection.begin_with("BEGIN IMMEDIATE").await?;
            let ids:Vec<String>=sqlx::query_scalar("SELECT request_id FROM interaction_pending WHERE session_id=?")
                .bind(session).fetch_all(&mut *tx).await?;
            let mut count=0;
            for id in ids {
                let record=read(&mut tx,&id).await?.ok_or_else(||invalid("pending app request disappeared"))?;
                if matches!(record.request,InteractionRequest::ComputerApp { basis,.. } if basis==previous) {
                    sqlx::query("INSERT INTO interaction_outcomes VALUES(?,?)").bind(id).bind(encode(&outcome)?).execute(&mut *tx).await?;
                    count+=1;
                }
            }
            if count>0 {
                crate::sessions::advance_catalog(&mut tx).await?;
                tx.commit().await.map_err(StoreError::CommitUnknown)?;
            } else { tx.rollback().await?; }
            Ok(count)
        })).await
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
        self.control.scoped(Arc::new(pin)).connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let current = revision(&mut tx, &key).await?;
            let next = current.checked_add(1).filter(|next| *next <= MAX_SAFE_INTEGER)
                .ok_or_else(|| invalid("computer app authority revision exhausted"))?;
            sqlx::query("INSERT INTO computer_app_profile_authority VALUES(?,?,NULL)
                ON CONFLICT(target_key) DO UPDATE SET revision=excluded.revision,source_request=NULL")
                .bind(key).bind(next as i64).execute(&mut *tx).await?;
            crate::sessions::advance_catalog(&mut tx).await?;
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            Ok(next)
        })).await
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
        self.control
            .scoped(custody)
            .connection
            .run(move |connection| {
                Box::pin(async move { close_control(connection, None, &outcome).await })
            })
            .await
    }
}

#[cfg(test)]
mod tests;
