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
    ) -> Result<usize, CommitError> {
        self.commit_steering(invocation)
            .await
            .map_err(|error| match error {
                StoreError::CommitUnknown(error) => CommitError::OutcomeUnknown(error.to_string()),
                StoreError::OperationUnknown => CommitError::OutcomeUnknown(error.to_string()),
                StoreError::SessionRetired => CommitError::Retired,
                other => CommitError::Rejected(other.to_string()),
            })
    }
    async fn commit_steering(&self, invocation: &Invocation) -> Result<usize, StoreError> {
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
            return Ok(0);
        }
        let invocation = invocation.clone();
        let commits = self.commits.session(&invocation.session_id);
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let pending =
                        crate::message_admissions::pending(&mut tx, &invocation.session_id).await?;
                    let mut count = 0;
                    let mut high = None;
                    for admission in pending.into_iter().filter(|admission| {
                        *admission.steering_target() == invocation
                            && admission.source.disposition == MessageDisposition::Steering
                    }) {
                        let event = EventWrite::plain(RuntimeEvent::new(
                            invocation.clone(),
                            Fact::MessageSteered {
                                message: Box::new(admission.source.message.clone()),
                                source: Box::new(admission.source),
                            },
                        ))
                        .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
                        match Self::append_in_transaction(&mut tx, &event).await? {
                            AppendResult::Inserted(sequence)
                            | AppendResult::ActivationChanged(sequence) => high = Some(sequence),
                            AppendResult::Existing(_) => return Err(StoreError::EventConflict),
                        }
                        count += 1;
                    }
                    if let Some(high) = high {
                        tx.commit().await.map_err(StoreError::CommitUnknown)?;
                        commits.publish(high);
                    } else {
                        tx.rollback().await?;
                    }
                    Ok(count)
                })
            })
            .await
    }
}
