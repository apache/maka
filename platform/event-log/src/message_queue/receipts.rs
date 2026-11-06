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

//! Epoch-scoped receipts share the queue transaction, not an in-memory cache.
use super::{QueueEdit, invalid};
use crate::{EventLog, StoreError, message_admissions::PendingMessageAdmission};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueCommandKind {
    RetractAll,
    Retract,
    Promote,
    Update,
    Reorder,
}
impl QueueCommandKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::RetractAll => "retract_all",
            Self::Retract => "retract",
            Self::Promote => "promote",
            Self::Update => "update",
            Self::Reorder => "reorder",
        }
    }
}
impl QueueEdit {
    pub fn command_kind(&self) -> QueueCommandKind {
        match self {
            Self::RetractAll { .. } => QueueCommandKind::RetractAll,
            Self::Retract { .. } => QueueCommandKind::Retract,
            Self::Promote { .. } => QueueCommandKind::Promote,
            Self::Update { .. } => QueueCommandKind::Update,
            Self::Reorder { .. } => QueueCommandKind::Reorder,
        }
    }
}

#[derive(Clone, Debug)]
pub struct QueueCommand {
    pub host_epoch: String,
    pub command_id: String,
    pub kind: QueueCommandKind,
    pub fingerprint: String,
}
impl QueueCommand {
    pub(super) fn validate(&self) -> Result<(), StoreError> {
        crate::sessions::validate_id(&self.host_epoch)?;
        crate::sessions::validate_id(&self.command_id)?;
        if self.fingerprint.len() != 71
            || !self.fingerprint.starts_with("sha256:")
            || !self.fingerprint[7..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(invalid("invalid queue command fingerprint"));
        }
        Ok(())
    }
}

/// Only the result is retained. Ordinary edits do not duplicate queue contents.
/// Retraction retains the admitted entries; its JSON envelope is not a new
/// pending-content admission and must not prevent cancelling that queue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueReceipt {
    pub revision: u64,
    pub retracted: Vec<PendingMessageAdmission>,
}

impl EventLog {
    /// Called once by the root owner before publishing its new Host epoch.
    /// Old commands still fail closed at the Host boundary; they are never replayed.
    pub async fn begin_message_epoch(&self, epoch: &str) -> Result<(), StoreError> {
        crate::sessions::validate_id(epoch)?;
        let epoch = epoch.to_owned();
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                tx.execute(
                    "DELETE FROM queue_command_receipts WHERE host_epoch != ?",
                    rusqlite::params![&epoch],
                )?;
                tx.execute(
                    "DELETE FROM message_submit_receipts WHERE host_epoch != ?",
                    rusqlite::params![&epoch],
                )?;
                tx.execute(
                    "DELETE FROM message_interrupt_receipts WHERE host_epoch != ?",
                    rusqlite::params![epoch],
                )?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                Ok(())
            })
            .await
    }

    pub async fn queue_command_receipt(
        &self,
        session: &str,
        command: &QueueCommand,
    ) -> Result<Option<QueueReceipt>, StoreError> {
        crate::sessions::validate_id(session)?;
        command.validate()?;
        let session = session.to_owned();
        let command = command.clone();
        self.connection
            .read(move |connection| read(connection, &session, &command))
            .await
    }
}

pub(super) fn read(
    connection: &Connection,
    session: &str,
    command: &QueueCommand,
) -> Result<Option<QueueReceipt>, StoreError> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT fingerprint, receipt_json FROM queue_command_receipts
         WHERE host_epoch = ? AND session_id = ? AND operation = ? AND command_id = ?",
            rusqlite::params![
                &command.host_epoch,
                session,
                command.kind.as_str(),
                &command.command_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    row.map(|(fingerprint, json)| {
        if fingerprint != command.fingerprint {
            return Err(invalid("command identity belongs to another input"));
        }
        Ok(serde_json::from_str(&json)?)
    })
    .transpose()
}

pub(super) fn insert(
    connection: &Connection,
    session: &str,
    command: &QueueCommand,
    receipt: &QueueReceipt,
) -> Result<(), StoreError> {
    let json = serde_json::to_string(receipt)?;
    connection.execute(
        "INSERT INTO queue_command_receipts
         (host_epoch, session_id, operation, command_id, fingerprint, receipt_json)
         VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            &command.host_epoch,
            session,
            command.kind.as_str(),
            &command.command_id,
            &command.fingerprint,
            json
        ],
    )?;
    Ok(())
}
