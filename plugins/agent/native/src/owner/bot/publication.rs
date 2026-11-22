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

//! Commit a notified decision and its outbox attribution in one Root transaction.
use super::*;
use maka_event_log::{
    StoreError as RootError,
    root_store::DataWriter,
    writeback::{Prepared, Statement},
};
use maka_host_runtime::storage::Storage;
use rusqlite::Connection;

struct RecordNotification {
    bot: Arc<Bot>,
    memory: Arc<Storage>,
    writer: DataWriter,
    session: String,
    message: String,
    publication: DiscoveryPublication,
    writes: Vec<Mutation>,
}

fn notification_error(error: &RootError) -> ToolError {
    match error {
        RootError::Shared(cause) => notification_error(cause),
        RootError::CommitUnknown(_)
        | RootError::OperationUnknown
        | RootError::RollbackFailed { .. } => ToolError::OutcomeUnknown(error.to_string()),
        _ => ToolError::Failed(error.to_string()),
    }
}

impl Owner {
    pub(in crate::owner) async fn commit_discovery_notification(
        &self,
        session: String,
        message: String,
        publication: DiscoveryPublication,
        writes: Vec<Mutation>,
    ) -> Result<(), ToolError> {
        let writer = self
            .store
            .data_writer()
            .map_err(|e| ToolError::Failed(e.to_string()))?;
        writer
            .write(RecordNotification {
                bot: self.bot.clone(),
                memory: self.scheduler.storage.clone(),
                writer: writer.clone(),
                session,
                message,
                publication,
                writes,
            })
            .await
            .map_err(|error| notification_error(&error))
    }
}

impl RecordNotification {
    fn read<T: serde::de::DeserializeOwned>(
        &self,
        db: &Connection,
        key: &str,
    ) -> Result<(u64, T), RootError> {
        let entry = self
            .bot
            .storage
            .read_in_transaction(db, key, &self.writer)?
            .ok_or_else(|| RootError::InvalidTransition("notification_not_recorded".into()))?;
        let value = entry
            .data
            .value()
            .ok_or_else(|| RootError::InvalidTransition("notification_not_recorded".into()))?;
        Ok((entry.revision, serde_json::from_value(value.clone())?))
    }

    fn links(&self, db: &Connection) -> Result<Vec<Mutation>, RootError> {
        let (_, call): (_, Call) = self.read(db, &call_key(&self.session, &self.message))?;
        if call.message_id != self.message {
            return Err(RootError::InvalidTransition(
                "notification_not_recorded".into(),
            ));
        }
        let mut writes = Vec::new();
        let mut turn_id = None;
        for sequence in call.first..call.first + call.count {
            let key = message_key(&self.session, sequence);
            let (revision, mut part): (_, BotMessage) = self.read(db, &key)?;
            if sequence == call.first {
                if let Some(original) = part.discovery {
                    // SendUser and a late link both publish every part of a call atomically.
                    return if original == self.publication {
                        Ok(Vec::new())
                    } else {
                        Err(RootError::InvalidTransition(
                            "notification_linked_to_another_discovery".into(),
                        ))
                    };
                }
                turn_id = part.turn_id.clone();
            }
            part.discovery = Some(self.publication.clone());
            writes.push(Mutation {
                key,
                expected_revision: Some(revision),
                data: Data::Present(serde_json::to_value(part)?),
            });
        }
        let key = head_key(&self.session);
        let (revision, mut head): (_, Head) = self.read(db, &key)?;
        head.discovery_link = Some(BotDiscoveryLink {
            revision: head.discovery_link.map_or(1, |link| link.revision + 1),
            message_id: call.message_id,
            turn_id,
            discovery: self.publication.clone(),
        });
        writes.push(Mutation {
            key,
            expected_revision: Some(revision),
            data: Data::Present(serde_json::to_value(head)?),
        });
        Ok(writes)
    }
}

impl Statement for RecordNotification {
    type Value = Option<tokio::sync::watch::Sender<()>>;
    type Output = ();

    fn execute(self, db: &Connection) -> Result<Prepared<Self::Value>, RootError> {
        let links = self.links(db)?;
        let memory = self
            .memory
            .prepare_statement(self.writes, &self.writer)?
            .execute(db)?;
        let mut notification = memory.notification;
        let changed = !links.is_empty();
        if changed {
            let outbox = self
                .bot
                .storage
                .prepare_statement(links, &self.writer)?
                .execute(db)?;
            notification = notification.combine(outbox.notification);
        }
        Ok(Prepared {
            value: changed.then(|| self.bot.changed.clone()),
            changed: memory.changed || changed,
            notification,
        })
    }

    fn committed(changes: Self::Value) {
        if let Some(changes) = changes {
            changes.send_replace(());
        }
    }

    fn isolated_rejection(error: &RootError) -> bool {
        matches!(
            error.underlying(),
            RootError::InvalidTransition(_) | RootError::RevisionConflict { .. }
        )
    }
}
