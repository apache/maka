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
use sqlx::{Connection, SqliteConnection};

impl EventLog {
    /// Admission and stable package receipt are one transaction. The Host has
    /// checked the exact live owner and retains its gate through settlement.
    pub async fn admit_plugin_message(
        &self,
        namespace: &Namespace,
        request: Enqueue,
        pending: PendingMessageAdmission,
    ) -> Result<MessageReceipt, StoreError> {
        self.validate_root()?;
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
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    if let Some(receipt) =
                        read(&mut tx, &package, &scope, &request.invocation.session_id, &request.operation_id).await?
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
                    if insert::insert(&mut tx, &pending, insert::Owner::Current)
                        .await?
                        .is_none()
                    {
                        return Err(StoreError::EventConflict);
                    }
                    sqlx::query("INSERT INTO plugin_message_receipts (package_id, scope_id, target_session_id, operation_id, receipt_json) VALUES (?, ?, ?, ?, ?)")
                        .bind(package)
                        .bind(scope)
                        .bind(&request.invocation.session_id)
                        .bind(request.operation_id)
                        .bind(serde_json::to_string(&receipt)?)
                        .execute(&mut *tx)
                        .await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    commits.metadata();
                    Ok(receipt)
                })
            })
            .await
    }
    /// Canonical consumption and retraction serialize on the same transaction.
    /// A delivered message is deliberately left alone, even in a shared Run.
    pub async fn retract_plugin_message(&self, receipt: &MessageReceipt) -> Result<(), StoreError> {
        self.validate_root()?;
        let session = receipt.invocation.session_id.clone();
        let message = receipt.message_id.clone();
        for id in [&session, &message] {
            crate::sessions::validate_id(id)?;
        }
        let commits = self.commits.session(&session);
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let queue = crate::message_queue::read(&mut tx, &session).await?;
                    if !queue
                        .entries
                        .iter()
                        .any(|entry| entry.source.message.message_id == message)
                    {
                        return Ok(());
                    }
                    let change = crate::message_queue::edit::apply(
                        &mut tx,
                        &session,
                        queue,
                        crate::message_queue::QueueEdit::Retract {
                            cancellation_id: format!("plugin-retract-{message}"),
                            message_id: message,
                        },
                    )
                    .await?;
                    if change.changed {
                        crate::message_queue::bump(&mut tx, &session).await?;
                    }
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    commits.metadata();
                    Ok(())
                })
            })
            .await
    }

    pub async fn plugin_message_receipt(
        &self,
        namespace: &Namespace,
        operation: &maka_agent_ports::execution::SessionOperation,
    ) -> Result<Option<MessageReceipt>, StoreError> {
        self.validate_root()?;
        operation
            .validate()
            .map_err(|error| invalid(&error.to_string()))?;
        crate::sessions::validate_id(&operation.session_id)?;
        let package = namespace.package().to_owned();
        let scope = String::from(namespace.scope().clone());
        let operation = operation.clone();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    read(
                        connection,
                        &package,
                        &scope,
                        &operation.session_id,
                        &operation.operation_id,
                    )
                    .await
                })
            })
            .await
    }
}
async fn read(
    connection: &mut SqliteConnection,
    package: &str,
    scope: &str,
    session: &str,
    operation: &str,
) -> Result<Option<MessageReceipt>, StoreError> {
    let encoded: Option<Option<String>> = sqlx::query_scalar(
        "SELECT CASE WHEN length(CAST(receipt_json AS BLOB)) <= 4096 THEN receipt_json END
         FROM plugin_message_receipts WHERE package_id = ? AND scope_id = ? AND target_session_id = ? AND operation_id = ?",
    )
    .bind(package)
    .bind(scope)
    .bind(session)
    .bind(operation)
    .fetch_optional(connection)
    .await?;
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
