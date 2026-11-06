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

//! Pending queue control state. Revisions fence edits against canonical delivery.
use crate::{EventLog, StoreError, message_admissions::PendingMessageAdmission};
use maka_agent_facts::event::Invocation;
use maka_agent_facts::input::MessageInput;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub(crate) mod edit;
mod receipts;
pub use receipts::{QueueCommand, QueueCommandKind, QueueReceipt};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MessageQueue {
    pub revision: u64,
    pub entries: Vec<PendingMessageAdmission>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum QueueEdit {
    RetractAll {
        cancellation_id: String,
    },
    Retract {
        message_id: String,
        cancellation_id: String,
    },
    Promote {
        message_id: String,
        invocation: Invocation,
    },
    Update {
        message_id: String,
        content: Box<MessageInput>,
        unprepared_content: Box<MessageInput>,
        required_tools: std::collections::BTreeSet<String>,
    },
    Reorder {
        message_ids: Vec<String>,
    },
}

#[derive(Debug)]
pub(crate) struct QueueChange {
    pub queue: MessageQueue,
    pub retracted: Vec<PendingMessageAdmission>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageDelivery {
    Delivered,
    Cancelled,
    Unknown,
}

impl EventLog {
    pub async fn message_delivery(
        &self,
        session: &str,
        message: &str,
    ) -> Result<MessageDelivery, StoreError> {
        self.check_bound_session(session)?;
        let session = session.to_owned();
        let message = message.to_owned();
        self.connection.read(move |db| {
            let state: String = db.query_row("SELECT CASE WHEN EXISTS(SELECT 1 FROM message_cancellations WHERE session_id=?1 AND message_id=?2) THEN 'cancelled' WHEN EXISTS(SELECT 1 FROM message_sources WHERE session_id=?1 AND message_id=?2) THEN 'delivered' ELSE 'unknown' END", rusqlite::params![session, message], |row| row.get(0))?;
            Ok(match state.as_str() {
                "cancelled" => MessageDelivery::Cancelled,
                "delivered" => MessageDelivery::Delivered,
                _ => MessageDelivery::Unknown,
            })
        }).await
    }

    /// Read the control revision without loading the potentially large pending bodies.
    pub async fn message_queue_revision(&self, session: &str) -> Result<u64, StoreError> {
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| revision(connection, &session))
            .await
    }
    pub async fn message_queue(&self, session: &str) -> Result<MessageQueue, StoreError> {
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                read(&tx, &session)
            })
            .await
    }

    /// The SQL owner completes accepted edits even if the caller stops awaiting.
    /// Host admission supplies the preflighted revision; engine consumption uses
    /// the same revision, so an edit never silently races delivered content.
    pub async fn edit_message_queue(
        &self,
        session: &str,
        expected_revision: u64,
        edit: QueueEdit,
        command: QueueCommand,
    ) -> Result<QueueReceipt, StoreError> {
        crate::sessions::validate_id(session)?;
        command.validate()?;
        if command.kind != edit.command_kind() {
            return Err(invalid("queue command kind does not match edit"));
        }
        let session = session.to_owned();
        let commits = self.commits.session(&session);
        self.connection
            .run(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(
                        connection,
                        rusqlite::TransactionBehavior::Immediate,
                    )?;
                    if let Some(receipt) = receipts::read(&tx, &session, &command)? {
                        return Ok(receipt);
                    }
                    let previous = read(&tx, &session)?;
                    if previous.revision != expected_revision {
                        return Err(StoreError::RevisionConflict {
                            expected: expected_revision.to_string(),
                            actual: previous.revision.to_string(),
                        });
                    }
                    let archived: Option<bool> = tx
                        .query_row(
                            "SELECT archived FROM session_control WHERE id = ?",
                            rusqlite::params![&session],
                            |row| row.get(0),
                        )
                        .optional()?;
                    match archived {
                        None => return Err(StoreError::SessionNotFound),
                        Some(true) => {
                            return Err(StoreError::InvalidTransition(
                                "Session is archived".into(),
                            ));
                        }
                        Some(false) => {}
                    }
                    let mut change = edit::apply(&tx, &session, previous, edit)?;
                    if change.changed {
                        change.result.queue.revision = bump(&tx, &session)?;
                    }
                    let receipt = QueueReceipt {
                        revision: change.result.queue.revision,
                        retracted: if command.kind == QueueCommandKind::RetractAll {
                            change.result.retracted
                        } else {
                            Vec::new()
                        },
                    };
                    receipts::insert(&tx, &session, &command, &receipt)?;
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    if change.changed {
                        // A wakeup is not a new execution fact. The same high-water is
                        // enough to refresh a projection whose queue control changed.
                        commits.metadata();
                    }
                    Ok(receipt)
                }
            })
            .await
    }

    pub async fn message_cancelled(
        &self,
        session: &str,
        message: &str,
    ) -> Result<bool, StoreError> {
        crate::sessions::validate_id(session)?;
        crate::sessions::validate_id(message)?;
        let session = session.to_owned();
        let message = message.to_owned();
        self.connection
            .read(move |connection| cancelled(connection, &session, &message))
            .await
    }
}

pub(crate) fn read(connection: &Connection, session: &str) -> Result<MessageQueue, StoreError> {
    Ok(MessageQueue {
        revision: revision(connection, session)?,
        entries: crate::message_admissions::pending(connection, session)?,
    })
}
pub(super) fn revision(connection: &Connection, session: &str) -> Result<u64, StoreError> {
    let revision: Option<i64> = connection
        .query_row(
            "SELECT revision FROM message_queue_state WHERE session_id = ?",
            rusqlite::params![session],
            |row| row.get(0),
        )
        .optional()?;
    u64::try_from(revision.unwrap_or(0)).map_err(|_| invalid("invalid queue revision"))
}
pub(crate) fn bump(connection: &Connection, session: &str) -> Result<u64, StoreError> {
    let next = revision(connection, session)?
        .checked_add(1)
        .filter(|n| *n <= maka_agent_facts::configuration::validation::MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("message queue revision exhausted"))?;
    connection.execute(
        "INSERT INTO message_queue_state(session_id, revision) VALUES (?, ?)
                ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision",
        rusqlite::params![session, next as i64],
    )?;
    Ok(next)
}
pub(crate) fn cancelled(
    connection: &Connection,
    session: &str,
    message: &str,
) -> Result<bool, StoreError> {
    Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM message_cancellations WHERE session_id = ? AND message_id = ?)", rusqlite::params![session, message], |row| row.get(0))?)
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
