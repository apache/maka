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
use super::{AppendResult, PreparedAppend};
use crate::{
    EventLog, StoreError,
    writeback::{Notification, Prepared, Statement},
};
use maka_agent_facts::event::{EventWrite, Fact};

pub(crate) struct WriteAppend {
    events: Vec<EventWrite>,
    prepared: Option<Vec<PreparedAppend>>,
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
            prepared: None,
        })
    }
}
impl Statement for WriteAppend {
    const PREPARE_OFF_THREAD: bool = true;
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.prepared = Some(
            self.events
                .iter()
                .map(PreparedAppend::new)
                .collect::<Result<_, _>>()?,
        );
        Ok(self)
    }
    type Value = Vec<u64>;
    type Output = Vec<u64>;
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        {
            let (sequences, inserted, activation_changed) = prepare_request(
                connection,
                &self.events,
                self.prepared
                    .expect("writer prepares append material before transaction"),
            )?;
            Ok(Prepared {
                value: sequences,
                changed: inserted.is_some(),
                notification: inserted.map_or(Notification::None, |sequence| {
                    if activation_changed {
                        Notification::ActivationSequence(sequence)
                    } else {
                        Notification::Sequence(sequence)
                    }
                }),
            })
        }
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
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

fn prepare_request(
    connection: &rusqlite::Connection,
    events: &[EventWrite],
    prepared: Vec<PreparedAppend>,
) -> Result<(Vec<u64>, Option<u64>, bool), StoreError> {
    let mut sequences = Vec::with_capacity(events.len());
    let mut inserted = None;
    let mut activation_changed = false;
    for (event, material) in events.iter().zip(prepared) {
        sequences.push(
            match EventLog::append_prepared_in_transaction(connection, event, material)? {
                AppendResult::Existing(sequence) => sequence,
                AppendResult::ActivationChanged(sequence) => {
                    activation_changed = true;
                    inserted = Some(sequence);
                    sequence
                }
                AppendResult::Inserted(sequence) => {
                    inserted = Some(sequence);
                    sequence
                }
            },
        );
    }
    crate::context::validate_batch(connection, events)?;
    Ok((sequences, inserted, activation_changed))
}

#[cfg(test)]
mod tests;
