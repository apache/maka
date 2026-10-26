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

use super::{PendingMessageAdmission, insert, invalid};
use crate::{EventLog, StoreError};
use maka_agent_facts::input::InputReceipt;
use maka_agent_facts::message::MessageDisposition;
use maka_agent_facts::message::Placement;
use maka_agent_facts::message::RootSourceMessage;
use maka_agent_facts::message::SubmittedTurnIntent;
use serde::{Deserialize, Serialize};
use sqlx::{Connection, SqliteConnection};

/// Original submit evidence survives later editing, promotion and cancellation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageSubmitReceipt {
    pub execution_digest: String,
    pub content_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<maka_agent_facts::message::MessageOrigin>,
    pub submitted_placement: Placement,
    pub submitted_intent: Option<SubmittedTurnIntent>,
    pub disposition: MessageDisposition,
    pub preparation: Vec<InputReceipt>,
    pub queue_revision: u64,
}
impl MessageSubmitReceipt {
    pub fn matches(&self, source: &RootSourceMessage) -> bool {
        self.content_digest == source.message.submitted_content_digest
            && self.origin == source.message.origin
            && self.submitted_placement == source.submitted_placement
            && self.submitted_intent == source.submitted_intent
    }
}
impl EventLog {
    pub async fn message_submit_receipt(
        &self,
        epoch: &str,
        session: &str,
        message: &str,
    ) -> Result<Option<MessageSubmitReceipt>, StoreError> {
        self.validate_root()?;
        for id in [epoch, session, message] {
            crate::sessions::validate_id(id)?;
        }
        let (epoch, session, message) = (epoch.to_owned(), session.to_owned(), message.to_owned());
        self.connection
            .run(move |connection| {
                Box::pin(async move { read(connection, &epoch, &session, &message).await })
            })
            .await
    }

    /// Host holds the live Session owner and preflights this revision. Receipt,
    /// reservation and queue revision commit together in the existing SQL owner.
    pub async fn admit_queued_message(
        &self,
        epoch: &str,
        expected_revision: u64,
        admission: PendingMessageAdmission,
    ) -> Result<MessageSubmitReceipt, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(epoch)?;
        admission.validate()?;
        if admission.source.disposition == MessageDisposition::TurnStarted {
            return Err(invalid("queue submit cannot create initial root work"));
        }
        let epoch = epoch.to_owned();
        let mut execution = serde_json::to_value(&admission.execution)?;
        execution.sort_all_objects();
        let execution_digest =
            maka_agent_facts::artifact::content_digest(&serde_json::to_vec(&execution)?);
        let commits = self.commits.session(&admission.invocation.session_id);
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let session = &admission.invocation.session_id;
                    let message = &admission.source.message.message_id;
                    if let Some(receipt) = read(&mut tx, &epoch, session, message).await? {
                        if !receipt.matches(&admission.source)
                            || receipt.execution_digest != execution_digest
                        {
                            return Err(invalid("message identity belongs to another input"));
                        }
                        return Ok(receipt);
                    }
                    let revision = crate::message_queue::revision(&mut tx, session).await?;
                    if revision != expected_revision {
                        return Err(StoreError::RevisionConflict {
                            expected: expected_revision.to_string(),
                            actual: revision.to_string(),
                        });
                    }
                    let queue_revision =
                        insert::insert(&mut tx, &admission, insert::Owner::Current)
                            .await?
                            .ok_or_else(|| {
                                invalid("pending admission has no matching epoch receipt")
                            })?;
                    let source = &admission.source;
                    let receipt = MessageSubmitReceipt {
                        execution_digest,
                        content_digest: source.message.submitted_content_digest.clone(),
                        origin: source.message.origin.clone(),
                        submitted_placement: source.submitted_placement,
                        submitted_intent: source.submitted_intent.clone(),
                        disposition: source.disposition,
                        preparation: source.message.content.preparation.clone(),
                        queue_revision,
                    };
                    let encoded = serde_json::to_string(&receipt)?;
                    sqlx::query("INSERT INTO message_submit_receipts VALUES (?, ?, ?, ?)")
                        .bind(&epoch)
                        .bind(session)
                        .bind(message)
                        .bind(encoded)
                        .execute(&mut *tx)
                        .await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    commits.metadata();
                    Ok(receipt)
                })
            })
            .await
    }
}
async fn read(
    connection: &mut SqliteConnection,
    epoch: &str,
    session: &str,
    message: &str,
) -> Result<Option<MessageSubmitReceipt>, StoreError> {
    let json: Option<String> = sqlx::query_scalar(
        "SELECT receipt_json
         FROM message_submit_receipts WHERE host_epoch = ? AND session_id = ? AND message_id = ?",
    )
    .bind(epoch)
    .bind(session)
    .bind(message)
    .fetch_optional(connection)
    .await?;
    json.map(|json| serde_json::from_str(&json).map_err(StoreError::from))
        .transpose()
}
