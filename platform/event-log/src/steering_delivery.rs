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

use crate::{EventLog, StoreError, append::AppendResult};
use maka_agent_facts::event::CommitError;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::message::MessageDisposition;
use sqlx::Connection;

#[cfg(test)]
mod tests;

impl EventLog {
    /// Select and commit the exact pending steering batch at a settled model boundary.
    /// Cancellation after this commits must never put delivered messages back in the queue.
    pub async fn commit_pending_steering(
        &self,
        invocation: &Invocation,
    ) -> Result<Vec<maka_agent_facts::message::RootSourceMessage>, CommitError> {
        self.commit_steering(invocation)
            .await
            .map_err(|error| match error {
                StoreError::CommitUnknown(error) => CommitError::OutcomeUnknown(error.to_string()),
                StoreError::OperationUnknown => CommitError::OutcomeUnknown(error.to_string()),
                StoreError::SessionRetired => CommitError::Retired,
                other => CommitError::Rejected(other.to_string()),
            })
    }
    pub async fn has_pending_steering(&self, invocation: &Invocation) -> Result<bool, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&invocation.session_id)?;
        let invocation = invocation.clone();
        self.connection.read(move |db| Box::pin(async move {
            Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id=? AND json_extract(record_json,'$.source.disposition')='steering' AND COALESCE(json_extract(record_json,'$.steering_invocation.invocation_id'),json_extract(record_json,'$.invocation.invocation_id'))=?)")
                .bind(&invocation.session_id).bind(&invocation.invocation_id).fetch_one(db).await?)
        })).await
    }

    pub async fn unread_tool_results(
        &self,
        invocation: &Invocation,
        observed: u64,
    ) -> Result<bool, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&invocation.session_id)?;
        let invocation = invocation.invocation_id.clone();
        let observed = i64::try_from(observed).map_err(|_| StoreError::PrefixTooLarge)?;
        self.connection.read(move |db| Box::pin(async move {
            Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events s WHERE s.invocation_id=? AND s.kind='tool_settled' AND s.sequence>? AND EXISTS(SELECT 1 FROM runtime_events y WHERE y.invocation_id=s.invocation_id AND y.operation_id=s.operation_id AND (y.kind='tool_yielded' OR y.kind='tool_dispatched' AND json_extract(y.event_header,'$.fact.call.origin.kind')='code_cell')))")
                .bind(invocation).bind(observed).fetch_one(db).await?)
        })).await
    }

    /// Serialize the foreground observation with actual tool settlement.
    pub async fn yield_running_tools(&self, invocation: &Invocation) -> Result<(), StoreError> {
        self.validate_root()?;
        self.check_bound_session(&invocation.session_id)?;
        let invocation = invocation.clone();
        let commits = self.commits.session(&invocation.session_id);
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let calls: Vec<(String, String)> = sqlx::query_as(concat!("WITH ", crate::model_items::accepted_calls!(),
                " SELECT c.step_id,c.call FROM accepted_calls c WHERE c.invocation_id=? AND json_extract(c.call,'$.provider_executed')=0 AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=c.invocation_id AND d.operation_id=c.step_id || ':' || json_extract(c.call,'$.id') AND d.kind IN ('tool_dispatched','tool_rejected')) ORDER BY c.sequence"))
                .bind(&invocation.invocation_id).fetch_all(&mut *tx).await?;
            let mut high = None;
            for (step_id, call) in calls {
                let call: maka_agent_facts::model::ModelToolCall = serde_json::from_str(&call)?;
                let write = EventWrite::plain(RuntimeEvent::new(invocation.clone(), Fact::ToolRejected {
                    operation_id: format!("{step_id}:{}", call.id),
                    call: maka_agent_facts::tool_call::ToolCallIdentity::provider(step_id, call.id),
                    name: call.name,
                    input: call.input,
                    reason: maka_agent_facts::tool_call::ToolRejection::Superseded,
                })).map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
                match Self::append_in_transaction(&mut tx, &write).await? {
                    AppendResult::Inserted(sequence) | AppendResult::ActivationChanged(sequence) => high = Some(sequence),
                    AppendResult::Existing(_) => return Err(StoreError::EventConflict),
                }
            }
            let operations: Vec<String> = sqlx::query_scalar("SELECT d.operation_id FROM runtime_events d WHERE d.invocation_id=? AND d.kind='tool_dispatched' AND json_extract(d.event_header,'$.fact.call.origin.kind')='provider' AND NOT EXISTS(SELECT 1 FROM runtime_events s WHERE s.invocation_id=d.invocation_id AND s.operation_id=d.operation_id AND s.kind IN ('tool_settled','tool_yielded')) ORDER BY d.sequence")
                .bind(&invocation.invocation_id).fetch_all(&mut *tx).await?;
            for operation_id in operations {
                let write = EventWrite::plain(RuntimeEvent::new(invocation.clone(), Fact::ToolYielded { operation_id }))
                    .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
                match Self::append_in_transaction(&mut tx, &write).await? {
                    AppendResult::Inserted(sequence) | AppendResult::ActivationChanged(sequence) => high = Some(sequence),
                    AppendResult::Existing(_) => return Err(StoreError::EventConflict),
                }
            }
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            if let Some(high) = high { commits.publish(high); }
            Ok(())
        })).await
    }

    async fn commit_steering(
        &self,
        invocation: &Invocation,
    ) -> Result<Vec<maka_agent_facts::message::RootSourceMessage>, StoreError> {
        self.validate_root()?;
        // Only an empty snapshot bypasses the writer; deliveries are rechecked below.
        let session = invocation.session_id.clone();
        let pending: bool = self
            .connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id=?)",
                    )
                    .bind(session)
                    .fetch_one(connection)
                    .await
                    .map_err(Into::into)
                })
            })
            .await?;
        if !pending {
            return Ok(Vec::new());
        }
        let invocation = invocation.clone();
        let commits = self.commits.session(&invocation.session_id);
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let pending =
                        crate::message_admissions::pending(&mut tx, &invocation.session_id).await?;
                    let mut delivered = Vec::new();
                    let mut high = None;
                    for admission in pending.into_iter().filter(|admission| {
                        *admission.steering_target() == invocation
                            && admission.source.disposition == MessageDisposition::Steering
                    }) {
                        let event = EventWrite::plain(RuntimeEvent::new(
                            invocation.clone(),
                            Fact::MessageSteered {
                                message: Box::new(admission.source.message.clone()),
                                source: Box::new(admission.source.clone()),
                            },
                        ))
                        .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
                        match Self::append_in_transaction(&mut tx, &event).await? {
                            AppendResult::Inserted(sequence)
                            | AppendResult::ActivationChanged(sequence) => high = Some(sequence),
                            AppendResult::Existing(_) => return Err(StoreError::EventConflict),
                        }
                        delivered.push(admission.source);
                    }
                    if let Some(high) = high {
                        tx.commit().await.map_err(StoreError::CommitUnknown)?;
                        commits.publish(high);
                    } else {
                        tx.rollback().await?;
                    }
                    Ok(delivered)
                })
            })
            .await
    }
}
