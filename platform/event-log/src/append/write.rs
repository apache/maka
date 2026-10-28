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

//! Canonical appends eligible for the shared writer receipt boundary.
use super::AppendResult;
use crate::{
    EventLog, StoreError,
    writeback::{Notification, Prepared, Statement},
};
use maka_agent_facts::event::{EventWrite, Fact};
use sqlx::SqliteConnection;

pub(crate) struct WriteAppend {
    events: Vec<EventWrite>,
}
impl WriteAppend {
    pub(crate) fn from_events(events: &[EventWrite]) -> Option<Self> {
        (!events.is_empty()
            && events.iter().all(|write| {
                matches!(
                    &write.event().fact,
                    Fact::InvocationOpened { .. }
                        | Fact::ModelRequested { .. }
                        | Fact::ModelObserved { .. }
                        | Fact::ModelCompleted { .. }
                        | Fact::ModelInterrupted { .. }
                        | Fact::ToolDispatched { .. }
                        | Fact::ToolRejected { .. }
                        | Fact::ToolSettled { .. }
                )
            }))
        .then(|| Self {
            events: events.to_vec(),
        })
    }
}
impl Statement for WriteAppend {
    type Value = Vec<u64>;
    type Output = Vec<u64>;
    fn execute(
        self,
        connection: &mut SqliteConnection,
    ) -> crate::connection::BoxFuture<'_, Result<Prepared<Self::Value>, StoreError>> {
        Box::pin(async move {
            let (sequences, inserted) = prepare_request(connection, &self.events).await?;
            Ok(Prepared {
                value: sequences,
                changed: inserted.is_some(),
                notification: inserted.map_or(Notification::None, Notification::Sequence),
            })
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn reusable_after_rollback(&self) -> bool {
        // These requests previously used Run. Preserve recovery after a failed
        // opening/main/tool request; pure observation storage faults retire the owner.
        !self
            .events
            .iter()
            .all(|write| matches!(write.event().fact, Fact::ModelObserved { .. }))
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::SessionNotFound
                | StoreError::SessionBusy
                | StoreError::Sealed
                | StoreError::ImportedInvocation
                | StoreError::EventConflict
                | StoreError::ArtifactConflict
                | StoreError::TranscriptConflict
                | StoreError::SessionRetired
                | StoreError::PermissionRevoked
                | StoreError::InvalidTransition(_)
                | StoreError::HistoryTurnMissing
                | StoreError::HistoryTurnSplit
                | StoreError::HistoryUnsettled
                | StoreError::HistoryProviderEffectUnresolved
                | StoreError::MaterialCollected
        )
    }
}

async fn prepare_request(
    connection: &mut SqliteConnection,
    events: &[EventWrite],
) -> Result<(Vec<u64>, Option<u64>), StoreError> {
    let mut sequences = Vec::with_capacity(events.len());
    let mut inserted = None;
    for event in events {
        sequences.push(
            match EventLog::append_in_transaction(connection, event).await? {
                AppendResult::Existing(sequence) => sequence,
                AppendResult::Inserted(sequence) => {
                    inserted = Some(sequence);
                    sequence
                }
            },
        );
    }
    crate::context::validate_batch(connection, events).await?;
    Ok((sequences, inserted))
}

#[cfg(test)]
mod tests;
