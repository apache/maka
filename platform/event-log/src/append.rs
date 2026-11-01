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
use sqlx::{Connection, SqliteConnection};

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
            self.validate_root().map_err(commit_error)?;
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
        self.validate_root()?;
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
            .run(move |connection| {
                Box::pin(async move {
                    let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let mut sequences = Vec::with_capacity(events.len());
                    let mut last_inserted = None;
                    let mut activation_changed = false;
                    for (index, event) in events.iter().enumerate() {
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
                                    &mut transaction,
                                    &event.event().invocation,
                                )
                                .await?;
                            }
                            for target in targets {
                                if crate::interactions::capability_grant(
                                    &mut transaction,
                                    &event.event().invocation.session_id,
                                    target,
                                )
                                .await?
                                .is_none_or(|grant| grant.basis != Some(*basis))
                                {
                                    return Err(StoreError::PermissionRevoked);
                                }
                            }
                            if let Some((target, display)) = app {
                                crate::root_store::require_computer_app_running(
                                    &mut transaction,
                                    &event.event().invocation,
                                    target,
                                    display,
                                )
                                .await?;
                            }
                        }
                        let result = Self::append_in_transaction(&mut transaction, event).await?;
                        if let Some(CapabilityAdmission {
                            app: Some((target, display)),
                            ..
                        }) = admission
                        {
                            crate::root_store::record_computer_app_activity(
                                &mut transaction,
                                event.event(),
                                target,
                                display,
                            )
                            .await?;
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
                    crate::context::validate_batch(&mut transaction, &events).await?;
                    if let Some(sequence) = last_inserted {
                        transaction
                            .commit()
                            .await
                            .map_err(StoreError::CommitUnknown)?;
                        commits.publish(sequence);
                        if activation_changed {
                            commits.activations();
                        }
                    } else {
                        transaction.rollback().await?;
                    }
                    drop(events);
                    Ok(sequences)
                })
            })
            .await
    }

    pub(crate) async fn append_in_transaction(
        transaction: &mut SqliteConnection,
        write: &EventWrite,
    ) -> Result<AppendResult, StoreError> {
        let event = write.event();
        crate::recovery::require_local(transaction, &event.invocation.invocation_id).await?;
        let removal =
            crate::sessions::removal::read(transaction, &event.invocation.session_id).await?;
        if removal == Some(crate::sessions::SessionRetirement::Removed) {
            return Err(StoreError::SessionRetired);
        }
        let json = serde_json::to_string(event)?;
        let previous=sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT e.sequence,e.event_header,{columns} FROM runtime_events e {joins} WHERE e.event_id=?",
            columns=crate::canonical::COLUMNS,joins=crate::canonical::JOINS,
        ))).bind(&event.id).fetch_optional(&mut *transaction).await?;
        if let Some(previous) = previous {
            use sqlx::Row;
            let sequence: i64 = previous.try_get(0)?;
            if crate::canonical::json(&previous)?.as_ref() != json {
                return Err(StoreError::EventConflict);
            }
            drop(previous);
            crate::tool_payloads::verify_replay(transaction, write).await?;
            crate::composition::verify_replay(transaction, write).await?;
            crate::usage::valuation::verify_replay(transaction, write).await?;
            crate::archive::verify_replay(transaction, event).await?;
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
        history::validate(transaction, event).await?;
        if matches!(event.fact, Fact::InvocationOpened { .. }) {
            crate::sessions::retain(transaction, &event.invocation.session_id).await?;
            let archived: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ? AND archived = 1)",
            )
            .bind(&event.invocation.session_id)
            .fetch_one(&mut *transaction)
            .await?;
            if archived {
                return Err(StoreError::InvalidTransition(
                    "cannot admit an archived session".into(),
                ));
            }
            if crate::sessions::has_active_invocation(transaction, &event.invocation.session_id)
                .await?
            {
                return Err(StoreError::InvalidTransition(
                    "session already has an unsealed invocation".into(),
                ));
            }
        }
        crate::handoff::validate_admission(transaction, event).await?;
        crate::message_identity::validate(transaction, event).await?;
        crate::message_admissions::consume(transaction, event).await?;
        if matches!(event.fact, Fact::InvocationEnded { .. }) {
            crate::interactions::lifecycle::require_closed(transaction, &event.invocation).await?;
            crate::native_approvals::require_terminal(transaction, &event.invocation).await?;
        }
        let checkpoint_changed: bool = if matches!(
            event.fact,
            Fact::ModelRequested { .. } | Fact::InvocationEnded { .. }
        ) {
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_checkpoints WHERE invocation_id=? AND active=1)")
                .bind(&event.invocation.invocation_id).fetch_one(&mut *transaction).await?
        } else {
            false
        };
        crate::native_approvals::append_model_request(transaction, write).await?;
        let sequence =
            ingress::insert(transaction, event, json, ingress::Position::Admitted).await?;
        let activation_changed =
            crate::native_approvals::append_settlement(transaction, event).await?;
        if matches!(event.fact, Fact::InvocationEnded { .. }) {
            crate::native_approvals::retire_terminal(transaction, &event.invocation).await?;
        }
        crate::message_sources::insert(transaction, event).await?;
        crate::tool_payloads::insert(transaction, write).await?;
        crate::artifacts::freeze_tool_media(transaction, event, sequence).await?;
        crate::composition::insert(transaction, write).await?;
        crate::usage::valuation::append(transaction, write).await?;
        crate::root_store::usage_meter::append(transaction, event).await?;
        if matches!(&event.fact, Fact::InvocationEnded { outcome } if !matches!(outcome, maka_agent_facts::event::InvocationOutcome::HandoffPaused { .. }))
        {
            // App Stop owns the logical Turn, so physical handoffs retain its
            // source selection. A terminal boundary releases the event FK and
            // its dependent Stop state in this same canonical transaction.
            sqlx::query("DELETE FROM computer_app_turn_activity WHERE session_id=? AND turn_id=?")
                .bind(&event.invocation.session_id)
                .bind(&event.invocation.turn_id)
                .execute(&mut *transaction)
                .await?;
        }
        if matches!(event.fact, Fact::InvocationEnded { .. }) {
            crate::sessions::read_state::mark_unread(
                transaction,
                &event.invocation.session_id,
                &event.invocation.invocation_id,
            )
            .await?;
        }
        if matches!(
            event.fact,
            Fact::InvocationOpened { .. }
                | Fact::MessageSteered { .. }
                | Fact::ModelCompleted { .. }
                | Fact::ModelInterrupted { .. }
                | Fact::InvocationEnded { .. }
        ) {
            crate::sessions::project_execution(transaction, sequence).await?;
            crate::sessions::advance_revision(transaction, &event.invocation.session_id).await?;
        }
        Ok(if activation_changed || checkpoint_changed {
            AppendResult::ActivationChanged(sequence)
        } else {
            AppendResult::Inserted(sequence)
        })
    }
}

fn commit_error(error: StoreError) -> CommitError {
    match error {
        StoreError::CommitUnknown(error) => CommitError::OutcomeUnknown(error.to_string()),
        StoreError::OperationUnknown => CommitError::OutcomeUnknown(error.to_string()),
        StoreError::SessionRetired => CommitError::Retired,
        StoreError::PermissionRevoked => CommitError::PermissionRevoked,
        StoreError::NativeTurnInterrupted => CommitError::NativeTurnInterrupted,
        other => CommitError::Rejected(other.to_string()),
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
