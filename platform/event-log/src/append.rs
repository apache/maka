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

use maka_agent_facts::event::CommitError;
use maka_agent_facts::event::CommitFuture;
use maka_agent_facts::event::EventSink;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::interaction::GrantCapability;
use rusqlite::OptionalExtension;

use crate::{EventLog, StoreError, sequence_number};

pub(crate) mod history;
pub(crate) mod ingress;
pub(crate) mod write;

#[derive(Clone, Copy)]
pub(crate) enum ComputerLane {
    Native,
    Other,
}

pub(crate) struct ComputerAppDispatch<'a> {
    pub(crate) target: &'a maka_agent_facts::interaction::GrantTarget,
    pub(crate) display: &'a maka_agent_facts::interaction::ComputerAppDisplay,
}

struct CapabilityAdmission {
    lane: ComputerLane,
    targets: Vec<maka_agent_facts::interaction::GrantTarget>,
    basis: maka_agent_facts::workspace::PermissionBasis,
    app: Option<(
        maka_agent_facts::interaction::GrantTarget,
        maka_agent_facts::interaction::ComputerAppDisplay,
    )>,
}

impl EventLog {
    /// Commit ordered facts atomically, validating each against the preceding
    /// facts in this transaction. Exact replays return their original sequence
    /// until Session removal completes, after which all writes are rejected.
    /// This must not enclose effects: live dispatch and outcome remain separate.
    pub async fn append_batch(&self, events: &[EventWrite]) -> Result<Vec<u64>, CommitError> {
        for event in events {
            self.check_bound_session(&event.event().invocation.session_id)
                .map_err(commit_error)?;
        }
        if let Some(statement) = write::WriteAppend::from_events(events) {
            return self
                .connection
                .write(
                    statement,
                    self.commits.sessions(
                        events
                            .iter()
                            .map(|event| event.event().invocation.session_id.as_str()),
                    ),
                )
                .await
                .map_err(commit_error);
        }
        self.append_batch_checked(events, None)
            .await
            .map_err(commit_error)
    }

    /// A selected native executor checks all its original capability grants in the
    /// same transaction as T1. Revocation cannot race a separate grant read.
    /// Prefix facts use ordinary validation; only the last dispatch checks authority.
    /// This neither creates a grant nor runs effects.
    pub async fn append_capability_dispatch(
        &self,
        prefix: &[EventWrite],
        event: &EventWrite,
        targets: &[maka_agent_facts::interaction::GrantTarget],
        basis: &maka_agent_facts::workspace::PermissionBasis,
    ) -> Result<maka_agent_facts::event::PrefixReceipt, CommitError> {
        self.append_granted_dispatch(prefix, event, targets, basis, None, ComputerLane::Other)
            .await
    }

    pub(crate) async fn append_computer_app_dispatch(
        &self,
        prefix: &[EventWrite],
        event: &EventWrite,
        targets: &[maka_agent_facts::interaction::GrantTarget],
        app: ComputerAppDispatch<'_>,
        basis: &maka_agent_facts::workspace::PermissionBasis,
        lane: ComputerLane,
    ) -> Result<maka_agent_facts::event::PrefixReceipt, CommitError> {
        self.append_granted_dispatch(
            prefix,
            event,
            targets,
            basis,
            Some((app.target.clone(), app.display.clone())),
            lane,
        )
        .await
    }

    /// Native-only Computer Use checks logical-Turn interruption in the
    /// same transaction as grant admission, prefix facts and T1.
    pub async fn append_native_computer_dispatch(
        &self,
        prefix: &[EventWrite],
        event: &EventWrite,
        targets: &[maka_agent_facts::interaction::GrantTarget],
        basis: &maka_agent_facts::workspace::PermissionBasis,
    ) -> Result<maka_agent_facts::event::PrefixReceipt, CommitError> {
        self.append_granted_dispatch(prefix, event, targets, basis, None, ComputerLane::Native)
            .await
    }

    async fn append_granted_dispatch(
        &self,
        prefix: &[EventWrite],
        event: &EventWrite,
        targets: &[maka_agent_facts::interaction::GrantTarget],
        basis: &maka_agent_facts::workspace::PermissionBasis,
        app: Option<(
            maka_agent_facts::interaction::GrantTarget,
            maka_agent_facts::interaction::ComputerAppDisplay,
        )>,
        lane: ComputerLane,
    ) -> Result<maka_agent_facts::event::PrefixReceipt, CommitError> {
        if !matches!(event.event().fact, Fact::ToolDispatched { .. }) {
            return Err(CommitError::Rejected(
                "capability admission requires a tool dispatch".into(),
            ));
        }
        if targets.is_empty() {
            return Err(CommitError::Rejected(
                "capability admission requires at least one grant target".into(),
            ));
        }
        self.append_batch_checked(
            prefix,
            Some((
                event,
                CapabilityAdmission {
                    lane,
                    targets: targets.to_vec(),
                    basis: *basis,
                    app,
                },
            )),
        )
        .await
        .map(maka_agent_facts::event::PrefixReceipt::from_sequences)
        .map_err(commit_error)
    }

    async fn append_batch_checked(
        &self,
        events: &[EventWrite],
        dispatch: Option<(&EventWrite, CapabilityAdmission)>,
    ) -> Result<Vec<u64>, StoreError> {
        for event in events {
            self.check_bound_session(&event.event().invocation.session_id)?;
        }
        if let Some((last, _)) = &dispatch {
            self.check_bound_session(&last.event().invocation.session_id)?;
        }
        let mut events = events.to_vec();
        let capability = dispatch.map(|(last, admission)| {
            events.push(last.clone());
            admission
        });
        let commits = self.commits.sessions(
            events
                .iter()
                .map(|event| event.event().invocation.session_id.as_str()),
        );
        self.connection
            .run_prepared(
                move || {
                    let prepared = events
                        .iter()
                        .map(PreparedAppend::new)
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok((events, capability, commits, prepared))
                },
                |connection, (events, capability, commits, prepared)| {
                    let transaction = rusqlite::Transaction::new_unchecked(
                        connection,
                        rusqlite::TransactionBehavior::Immediate,
                    )?;
                    let mut sequences = Vec::with_capacity(events.len());
                    let mut last_inserted = None;
                    let mut activation_changed = false;
                    for (index, (event, material)) in events.iter().zip(prepared).enumerate() {
                        let admission = capability.as_ref().filter(|_| index + 1 == events.len());
                        if let Some(admission) = admission {
                            let CapabilityAdmission {
                                lane,
                                targets,
                                basis,
                                app,
                            } = admission;
                            if matches!(lane, ComputerLane::Native) {
                                crate::native_computer::require_native_turn_running(
                                    &transaction,
                                    &event.event().invocation,
                                )?;
                            }
                            let full_access = crate::workspace_bindings::full_access(
                                &transaction,
                                &event.event().invocation.session_id,
                                basis,
                            )?;
                            for target in targets {
                                let unrestricted = full_access
                                    && matches!(
                                        target.capability,
                                        GrantCapability::ComputerUse
                                            | GrantCapability::ComputerAudio
                                            | GrantCapability::Browser
                                            | GrantCapability::BrowserHistory
                                            | GrantCapability::BrowserDownload
                                            | GrantCapability::BrowserUpload
                                    );
                                if !unrestricted
                                    && crate::interactions::capability_grant(
                                        &transaction,
                                        &event.event().invocation.session_id,
                                        target,
                                    )?
                                    .is_none_or(|grant| grant.basis != Some(*basis))
                                {
                                    return Err(StoreError::PermissionRevoked);
                                }
                            }
                            if let Some((target, display)) = app {
                                crate::root_store::require_computer_app_running(
                                    &transaction,
                                    &event.event().invocation,
                                    target,
                                    display,
                                )?;
                            }
                        }
                        let result =
                            Self::append_prepared_in_transaction(&transaction, event, material)?;
                        if let Some(CapabilityAdmission {
                            app: Some((target, display)),
                            ..
                        }) = admission
                        {
                            crate::root_store::record_computer_app_activity(
                                &transaction,
                                event.event(),
                                target,
                                display,
                            )?;
                        }
                        activation_changed |= matches!(result, AppendResult::ActivationChanged(_));
                        let sequence = match result {
                            AppendResult::Existing(sequence) => sequence,
                            AppendResult::Inserted(sequence)
                            | AppendResult::ActivationChanged(sequence) => {
                                last_inserted = Some(sequence);
                                sequence
                            }
                        };
                        sequences.push(sequence);
                    }
                    crate::context::validate_batch(&transaction, &events)?;
                    if let Some(sequence) = last_inserted {
                        transaction.commit().map_err(StoreError::CommitUnknown)?;
                        commits.publish(sequence);
                        if activation_changed {
                            commits.activations();
                        }
                    } else {
                        transaction.rollback()?;
                    }
                    drop(events);
                    Ok(sequences)
                },
            )
            .await
    }

    pub(crate) fn append_in_transaction(
        transaction: &rusqlite::Connection,
        write: &EventWrite,
    ) -> Result<AppendResult, StoreError> {
        let prepared = PreparedAppend::new(write)?;
        Self::append_prepared_in_transaction(transaction, write, prepared)
    }

    fn append_prepared_in_transaction(
        transaction: &rusqlite::Connection,
        write: &EventWrite,
        prepared: PreparedAppend,
    ) -> Result<AppendResult, StoreError> {
        let PreparedAppend { canonical, tool } = prepared;
        let event = write.event();
        crate::recovery::require_local(transaction, &event.invocation.invocation_id)?;
        let removal = crate::sessions::removal::read(transaction, &event.invocation.session_id)?;
        if removal == Some(crate::sessions::SessionRetirement::Removed) {
            return Err(StoreError::SessionRetired);
        }
        let json = &canonical.json;
        let previous=transaction.prepare_cached(&(format!(
            "SELECT e.sequence,e.event_header,{columns} FROM runtime_events e {joins} WHERE e.event_id=?",
            columns=crate::canonical::COLUMNS,joins=crate::canonical::JOINS,
        )))?.query_row(rusqlite::params![&event.id], |row| Ok((row.get::<_,i64>(0)?, crate::canonical::json(row).map(|v|v.into_owned())))).optional()?;
        if let Some((sequence, previous)) = previous {
            if previous? != *json {
                return Err(StoreError::EventConflict);
            }
            crate::tool_payloads::verify_replay(transaction, write)?;
            crate::composition::verify_replay(transaction, write)?;
            crate::usage::valuation::verify_replay(transaction, write)?;
            crate::archive::verify_replay(transaction, event)?;
            return Ok(AppendResult::Existing(sequence_number(sequence)?));
        }
        if removal.is_some()
            && matches!(
                event.fact,
                Fact::ModelRequested { .. }
                    | Fact::ToolDispatched { .. }
                    | Fact::ExecutorStarted { .. }
                    | Fact::MessageSteered { .. }
            )
        {
            return Err(StoreError::SessionRetired);
        }
        history::validate(transaction, event)?;
        if matches!(event.fact, Fact::InvocationOpened { .. }) {
            crate::sessions::retain(transaction, &event.invocation.session_id)?;
            let archived: bool = transaction
                .prepare_cached(
                    "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ? AND archived = 1)",
                )?
                .query_row(rusqlite::params![&event.invocation.session_id], |row| {
                    row.get(0)
                })?;
            if archived {
                return Err(StoreError::InvalidTransition(
                    "cannot admit an archived session".into(),
                ));
            }
            if crate::sessions::has_active_invocation(transaction, &event.invocation.session_id)? {
                return Err(StoreError::InvalidTransition(
                    "session already has an unsealed invocation".into(),
                ));
            }
        }
        crate::handoff::validate_admission(transaction, event)?;
        crate::message_identity::validate(transaction, event)?;
        crate::message_admissions::consume(transaction, event)?;
        if matches!(event.fact, Fact::InvocationEnded { .. }) {
            crate::interactions::lifecycle::require_closed(transaction, &event.invocation)?;
            crate::native_approvals::require_terminal(transaction, &event.invocation)?;
        }
        let checkpoint_changed: bool = if matches!(
            event.fact,
            Fact::ModelRequested { .. } | Fact::InvocationEnded { .. }
        ) {
            transaction.prepare_cached("SELECT EXISTS(SELECT 1 FROM native_approval_checkpoints WHERE invocation_id=? AND active=1)")?.query_row(rusqlite::params![&event.invocation.invocation_id], |row| row.get(0))?
        } else {
            false
        };
        crate::native_approvals::append_model_request(transaction, write)?;
        let sequence =
            ingress::insert_prepared(transaction, event, canonical, ingress::Position::Admitted)?;
        let activation_changed = crate::native_approvals::append_settlement(transaction, event)?;
        if matches!(event.fact, Fact::InvocationEnded { .. }) {
            crate::native_approvals::retire_terminal(transaction, &event.invocation)?;
        }
        crate::message_sources::insert(transaction, event)?;
        crate::tool_payloads::insert_prepared(transaction, write, tool)?;
        crate::artifacts::freeze_tool_media(transaction, event, sequence)?;
        crate::composition::insert(transaction, write)?;
        crate::usage::valuation::append(transaction, write)?;
        crate::root_store::usage_meter::append(transaction, event)?;
        if matches!(&event.fact, Fact::InvocationEnded { outcome } if !matches!(outcome, maka_agent_facts::event::InvocationOutcome::HandoffPaused { .. }))
        {
            // App Stop owns the logical Turn, so physical handoffs retain its
            // source selection. A terminal boundary releases the event FK and
            // its dependent Stop state in this same canonical transaction.
            transaction
                .prepare_cached(
                    "DELETE FROM computer_app_turn_activity WHERE session_id=? AND turn_id=?",
                )?
                .execute(rusqlite::params![
                    &event.invocation.session_id,
                    &event.invocation.turn_id
                ])?;
        }
        if matches!(event.fact, Fact::InvocationEnded { .. }) {
            crate::sessions::read_state::mark_unread(
                transaction,
                &event.invocation.session_id,
                &event.invocation.invocation_id,
            )?;
        }
        if matches!(
            event.fact,
            Fact::InvocationOpened { .. }
                | Fact::MessageSteered { .. }
                | Fact::ModelCompleted { .. }
                | Fact::ModelInterrupted { .. }
                | Fact::InvocationEnded { .. }
        ) {
            crate::sessions::project_execution(transaction, sequence)?;
            crate::sessions::advance_revision(transaction, &event.invocation.session_id)?;
        }
        Ok(if activation_changed || checkpoint_changed {
            AppendResult::ActivationChanged(sequence)
        } else {
            AppendResult::Inserted(sequence)
        })
    }
}

fn commit_error(error: StoreError) -> CommitError {
    match error.underlying() {
        StoreError::CommitUnknown(_) => CommitError::OutcomeUnknown(error.to_string()),
        StoreError::OperationUnknown => CommitError::OutcomeUnknown(error.to_string()),
        StoreError::SessionRetired => CommitError::Retired,
        StoreError::PermissionRevoked => CommitError::PermissionRevoked,
        StoreError::NativeTurnInterrupted => CommitError::NativeTurnInterrupted,
        _ => CommitError::Rejected(error.to_string()),
    }
}

struct PreparedAppend {
    canonical: crate::canonical::PreparedCanonical,
    tool: crate::tool_payloads::PreparedToolWrite,
}
impl PreparedAppend {
    fn new(write: &EventWrite) -> Result<Self, StoreError> {
        Ok(Self {
            canonical: crate::canonical::PreparedCanonical::new(
                write.event(),
                serde_json::to_string(write.event())?,
            )?,
            tool: crate::tool_payloads::prepare(write)?,
        })
    }
}

pub(crate) enum AppendResult {
    Existing(u64),
    Inserted(u64),
    ActivationChanged(u64),
}

impl EventLog {
    pub async fn append(&self, event: &EventWrite) -> Result<u64, CommitError> {
        Ok(self.append_batch(std::slice::from_ref(event)).await?[0])
    }
}

impl EventSink for EventLog {
    fn commit_with_prefix(
        self: std::sync::Arc<Self>,
        prefix: &[EventWrite],
        last: EventWrite,
    ) -> maka_agent_facts::event::PrefixCommitFuture {
        let mut events = prefix.to_vec();
        events.push(last);
        Box::pin(async move {
            self.append_batch(&events)
                .await
                .map(maka_agent_facts::event::PrefixReceipt::from_sequences)
        })
    }

    fn commit(self: std::sync::Arc<Self>, event: EventWrite) -> CommitFuture {
        Box::pin(async move { self.append(&event).await })
    }
}
