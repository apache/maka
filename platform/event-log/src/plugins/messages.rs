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

use super::invalid;
use crate::{
    EventLog, StoreError,
    message_admissions::{PendingMessageAdmission, insert},
};
use maka_agent_facts::message::MessageDisposition;
use maka_agent_ports::execution::Enqueue;
use maka_agent_ports::execution::MessageReceipt;
use maka_capabilities::storage::Namespace;
use rusqlite::{Connection, OptionalExtension};

impl EventLog {
    /// Admission and stable package receipt are one transaction. The Host has
    /// checked the exact live owner and retains its gate through settlement.
    pub async fn admit_plugin_message(
        &self,
        namespace: &Namespace,
        request: Enqueue,
        pending: PendingMessageAdmission,
    ) -> Result<MessageReceipt, StoreError> {
        let digest = request.digest().map_err(|e| invalid(&e.to_string()))?;
        let disposition = match request.placement {
            maka_agent_facts::message::Placement::CurrentTurn => MessageDisposition::Steering,
            maka_agent_facts::message::Placement::NextTurn => MessageDisposition::Followup,
        };
        if pending.source.message.message_id != request.message_id
            || pending.invocation != request.invocation
            || pending.source.disposition != disposition
            || pending.source.submitted_placement != request.placement
            || pending.source.submitted_intent.is_some()
            || pending.source.message.submitted_content_digest
                != request.content.content_digest()?
        {
            return Err(invalid("queued message does not match its receipt"));
        }
        let package = namespace.package().to_owned();
        let scope = String::from(namespace.scope().clone());
        let commits = self.commits.session(&request.invocation.session_id);
        self.connection
            .run(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
                    if let Some(receipt) =
                        read(&tx, &package, &scope, &request.invocation.session_id, &request.operation_id)?
                    {
                        if receipt.request_digest != digest {
                            return Err(StoreError::EventConflict);
                        }
                        return Ok(receipt);
                    }
                    let receipt = MessageReceipt {
                        invocation: request.invocation.clone(),
                        message_id: pending.source.message.message_id.clone(),
                        request_digest: digest,
                    };
                    if insert::insert(&tx, &pending, insert::Owner::Current)
                        ?
                        .is_none()
                    {
                        return Err(StoreError::EventConflict);
                    }
                    tx.execute("INSERT INTO plugin_message_receipts (package_id, scope_id, target_session_id, operation_id, receipt_json) VALUES (?, ?, ?, ?, ?)", rusqlite::params![package, scope, &request.invocation.session_id, request.operation_id, serde_json::to_string(&receipt)?])
                        ?;
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.metadata();
                    Ok(receipt)
                }
            })
            .await
    }
    /// Canonical consumption and retraction serialize on the same transaction.
    /// A delivered message is deliberately left alone, even in a shared Run.
    pub async fn retract_plugin_message(&self, receipt: &MessageReceipt) -> Result<(), StoreError> {
        let session = receipt.invocation.session_id.clone();
        let message = receipt.message_id.clone();
        for id in [&session, &message] {
            crate::sessions::validate_id(id)?;
        }
        let commits = self.commits.session(&session);
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let queue = crate::message_queue::read(&tx, &session)?;
                if !queue
                    .entries
                    .iter()
                    .any(|entry| entry.source.message.message_id == message)
                {
                    return Ok(());
                }
                let change = crate::message_queue::edit::apply(
                    &tx,
                    &session,
                    queue,
                    crate::message_queue::QueueEdit::Retract {
                        cancellation_id: format!("plugin-retract-{message}"),
                        message_id: message,
                    },
                )?;
                if change.changed {
                    crate::message_queue::bump(&tx, &session)?;
                }
                tx.commit().map_err(StoreError::CommitUnknown)?;
                commits.metadata();
                Ok(())
            })
            .await
    }

    pub async fn plugin_message_receipt(
        &self,
        namespace: &Namespace,
        operation: &maka_agent_ports::execution::SessionOperation,
    ) -> Result<Option<MessageReceipt>, StoreError> {
        operation
            .validate()
            .map_err(|error| invalid(&error.to_string()))?;
        crate::sessions::validate_id(&operation.session_id)?;
        let package = namespace.package().to_owned();
        let scope = String::from(namespace.scope().clone());
        let operation = operation.clone();
        self.connection
            .read(move |connection| {
                {
                    read(
                        connection,
                        &package,
                        &scope,
                        &operation.session_id,
                        &operation.operation_id,
                    )
                }
            })
            .await
    }
}
fn read(
    connection: &Connection,
    package: &str,
    scope: &str,
    session: &str,
    operation: &str,
) -> Result<Option<MessageReceipt>, StoreError> {
    let encoded: Option<Option<String>> = connection.query_row("SELECT CASE WHEN length(CAST(receipt_json AS BLOB)) <= 4096 THEN receipt_json END
         FROM plugin_message_receipts WHERE package_id = ? AND scope_id = ? AND target_session_id = ? AND operation_id = ?", rusqlite::params![package, scope, session, operation], |row| row.get(0)).optional()
    ?;
    encoded
        .map(|encoded| {
            let receipt: MessageReceipt =
                serde_json::from_str(&encoded.ok_or(StoreError::PrefixTooLarge)?)?;
            for id in [
                &receipt.invocation.session_id,
                &receipt.invocation.turn_id,
                &receipt.invocation.run_id,
                &receipt.invocation.invocation_id,
                &receipt.message_id,
            ] {
                crate::sessions::validate_id(id)?;
            }
            if receipt.invocation.session_id != session
                || !maka_agent_facts::archive::valid_projection_digest(&receipt.request_digest)
            {
                return Err(invalid("invalid queued message receipt"));
            }
            Ok(receipt)
        })
        .transpose()
}
