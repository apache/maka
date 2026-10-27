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

    /// A selected native executor checks its original capability grant in the
    /// same transaction as T1. Revocation cannot race a separate grant read.
    /// This compares existing authority; it neither creates a grant nor runs effects.
    pub async fn append_capability_dispatch(
        &self,
        event: &EventWrite,
        target: &maka_agent_facts::interaction::GrantTarget,
        basis: &maka_agent_facts::workspace::PermissionBasis,
    ) -> Result<u64, CommitError> {
        if !matches!(event.event().fact, Fact::ToolDispatched { .. }) {
            return Err(CommitError::Rejected(
                "capability admission requires a tool dispatch".into(),
            ));
        }
        self.append_batch_checked(std::slice::from_ref(event), Some((target.clone(), *basis)))
            .await
            .map(|sequences| sequences[0])
            .map_err(commit_error)
    }

    async fn append_batch_checked(
        &self,
        events: &[EventWrite],
        capability: Option<(
            maka_agent_facts::interaction::GrantTarget,
            maka_agent_facts::workspace::PermissionBasis,
        )>,
    ) -> Result<Vec<u64>, StoreError> {
        for event in events {
            self.check_bound_session(&event.event().invocation.session_id)?;
        }
        self.validate_root()?;
        let events = events.to_vec();
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
                    for event in &events {
                        if let Some((target, basis)) = &capability
                            && crate::interactions::capability_grant(
                                &mut transaction,
                                &event.event().invocation.session_id,
                                target,
                            )
                            .await?
                            .is_none_or(|grant| grant.basis != Some(*basis))
                        {
                            return Err(StoreError::PermissionRevoked);
                        }
                        let result = Self::append_in_transaction(&mut transaction, event).await?;
                        let sequence = match result {
                            AppendResult::Existing(sequence) => sequence,
                            AppendResult::Inserted(sequence) => {
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
        let previous: Option<(i64, String)> =
            sqlx::query_as("SELECT sequence, event_json FROM runtime_events WHERE event_id = ?")
                .bind(&event.id)
                .fetch_optional(&mut *transaction)
                .await?;
        if let Some((sequence, previous)) = previous {
            if previous != json {
                return Err(StoreError::EventConflict);
            }
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
        }
        let sequence =
            ingress::insert(transaction, event, json, ingress::Position::Admitted).await?;
        crate::message_sources::insert(transaction, event).await?;
        crate::tool_payloads::insert(transaction, write).await?;
        crate::artifacts::freeze_tool_media(transaction, event, sequence).await?;
        crate::composition::insert(transaction, write).await?;
        crate::usage::valuation::append(transaction, write).await?;
        crate::root_store::usage_meter::append(transaction, event).await?;
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
        crate::transcript::directory::record_event(transaction, event, sequence).await?;
        Ok(AppendResult::Inserted(sequence))
    }
}

fn commit_error(error: StoreError) -> CommitError {
    match error {
        StoreError::CommitUnknown(error) => CommitError::OutcomeUnknown(error.to_string()),
        StoreError::OperationUnknown => CommitError::OutcomeUnknown(error.to_string()),
        StoreError::SessionRetired => CommitError::Retired,
        StoreError::PermissionRevoked => CommitError::PermissionRevoked,
        other => CommitError::Rejected(other.to_string()),
    }
}

pub(crate) enum AppendResult {
    Existing(u64),
    Inserted(u64),
}

impl EventLog {
    pub async fn append(&self, event: &EventWrite) -> Result<u64, CommitError> {
        Ok(self.append_batch(std::slice::from_ref(event)).await?[0])
    }
}

impl EventSink for EventLog {
    fn commit(self: std::sync::Arc<Self>, event: EventWrite) -> CommitFuture {
        Box::pin(async move { self.append(&event).await })
    }
}
