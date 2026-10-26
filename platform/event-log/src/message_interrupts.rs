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

//! Stop fences and queue cancellation share the existing SQL commit owner.
use crate::{
    EventLog, StoreError,
    message_queue::{self, QueueEdit, QueueReceipt},
};
use maka_agent_facts::event::Invocation;
use sqlx::{Connection, SqliteConnection};

#[derive(Clone, Debug)]
pub struct InterruptCommand {
    pub host_epoch: String,
    pub session_id: String,
    pub interrupt_id: String,
    pub turn_id: String,
    pub run_id: String,
}
impl InterruptCommand {
    fn validate(&self) -> Result<(), StoreError> {
        for id in [
            &self.host_epoch,
            &self.session_id,
            &self.interrupt_id,
            &self.turn_id,
            &self.run_id,
        ] {
            crate::sessions::validate_id(id)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InterruptReceipt {
    Conflict,
    Fenced(QueueReceipt),
}

impl EventLog {
    pub async fn message_interrupt_receipt(
        &self,
        command: &InterruptCommand,
    ) -> Result<Option<InterruptReceipt>, StoreError> {
        self.validate_root()?;
        command.validate()?;
        let command = command.clone();
        self.connection
            .run(move |connection| Box::pin(async move { read(connection, &command).await }))
            .await
    }

    /// The caller holds the Host admission gate and supplies its exact cleanup
    /// owner. SQL serializes this fence against the engine's source consumption.
    pub async fn interrupt_message_queue(
        &self,
        command: &InterruptCommand,
        expected_revision: u64,
        owner: Option<&Invocation>,
    ) -> Result<InterruptReceipt, StoreError> {
        self.validate_root()?;
        command.validate()?;
        let (command, owner, commits) = (
            command.clone(),
            owner.cloned(),
            self.commits.session(&command.session_id),
        );
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            if let Some(receipt) = read(&mut tx, &command).await? {
                return Ok(receipt);
            }
            let archived: Option<bool> = sqlx::query_scalar("SELECT archived FROM session_control WHERE id = ?")
                .bind(&command.session_id).fetch_optional(&mut *tx).await?;
            match archived {
                None => return Err(StoreError::SessionNotFound),
                Some(true) => return Err(invalid("Session is archived")),
                Some(false) => {}
            }
            let matches_owner = owner.as_ref().is_some_and(|owner|
                owner.session_id == command.session_id && owner.turn_id == command.turn_id && owner.run_id == command.run_id);
            let active = if let Some(owner) = owner.as_ref().filter(|_| matches_owner) {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM local_runtime_events o WHERE o.kind = 'invocation_opened'
                     AND o.invocation_id = ? AND json_extract(o.event_json, '$.invocation') = json(?)
                     AND o.sequence = (SELECT MAX(n.sequence) FROM local_runtime_events n
                         WHERE n.kind = 'invocation_opened' AND json_extract(n.event_json, '$.invocation.session_id') = ?))"
                ).bind(&owner.invocation_id).bind(serde_json::to_string(owner)?)
                    .bind(&owner.session_id).fetch_one(&mut *tx).await?
            } else { false };
            let mut changed = false;
            let fence = if active {
                let previous: Option<String> = sqlx::query_scalar(
                    "SELECT fence_json FROM message_interrupt_receipts
                     WHERE host_epoch = ? AND session_id = ? AND run_id = ? AND fence_json IS NOT NULL LIMIT 1"
                ).bind(&command.host_epoch).bind(&command.session_id).bind(&command.run_id)
                    .fetch_optional(&mut *tx).await?;
                if let Some(previous) = previous {
                    Some(decode(&previous)?)
                } else {
                    let queue = message_queue::read(&mut tx, &command.session_id).await?;
                    if queue.revision != expected_revision {
                        return Err(StoreError::RevisionConflict {
                            expected: expected_revision.to_string(), actual: queue.revision.to_string(),
                        });
                    }
                    let change = message_queue::edit::apply(
                        &mut tx, &command.session_id, queue,
                        QueueEdit::RetractAll { cancellation_id: command.interrupt_id.clone() },
                    ).await?;
                    let revision = message_queue::bump(&mut tx, &command.session_id).await?;
                    changed = true; // Even an empty queue closes a new admission generation.
                    Some(QueueReceipt { revision, retracted: change.result.retracted })
                }
            } else { None };
            let encoded = fence.as_ref().map(serde_json::to_string).transpose()?;
            sqlx::query("INSERT INTO message_interrupt_receipts(host_epoch, session_id, interrupt_id, turn_id, run_id, fence_json) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(&command.host_epoch).bind(&command.session_id).bind(&command.interrupt_id)
                .bind(&command.turn_id).bind(&command.run_id).bind(encoded).execute(&mut *tx).await?;
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            if changed { commits.metadata(); }
            Ok(fence.map_or(InterruptReceipt::Conflict, InterruptReceipt::Fenced))
        })).await
    }
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
fn decode(value: &str) -> Result<QueueReceipt, StoreError> {
    Ok(serde_json::from_str(value)?)
}
async fn read(
    connection: &mut SqliteConnection,
    command: &InterruptCommand,
) -> Result<Option<InterruptReceipt>, StoreError> {
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT turn_id, run_id, fence_json FROM message_interrupt_receipts
         WHERE host_epoch = ? AND session_id = ? AND interrupt_id = ?",
    )
    .bind(&command.host_epoch)
    .bind(&command.session_id)
    .bind(&command.interrupt_id)
    .fetch_optional(connection)
    .await?;
    row.map(|(turn, run, fence)| {
        if turn != command.turn_id || run != command.run_id {
            return Err(invalid("Interrupt identity belongs to another input"));
        }
        fence
            .map(|value| decode(&value).map(InterruptReceipt::Fenced))
            .unwrap_or(Ok(InterruptReceipt::Conflict))
    })
    .transpose()
}

pub(crate) async fn fenced(
    connection: &mut SqliteConnection,
    session: &str,
    run: &str,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM message_interrupt_receipts
         WHERE session_id = ? AND run_id = ? AND fence_json IS NOT NULL)",
    )
    .bind(session)
    .bind(run)
    .fetch_one(connection)
    .await?)
}
