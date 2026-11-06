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
            .map_err(|error| match error.underlying() {
                StoreError::CommitUnknown(error) => CommitError::OutcomeUnknown(error.to_string()),
                StoreError::OperationUnknown => CommitError::OutcomeUnknown(error.to_string()),
                StoreError::SessionRetired => CommitError::Retired,
                other => CommitError::Rejected(other.to_string()),
            })
    }
    pub async fn has_pending_steering(&self, invocation: &Invocation) -> Result<bool, StoreError> {
        self.check_bound_session(&invocation.session_id)?;
        let invocation = invocation.clone();
        self.connection.read(move |db| {
            Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id=? AND json_extract(record_json,'$.source.disposition')='steering' AND COALESCE(json_extract(record_json,'$.steering_invocation.invocation_id'),json_extract(record_json,'$.invocation.invocation_id'))=?)", rusqlite::params![&invocation.session_id, &invocation.invocation_id], |row| row.get(0))?)
        }).await
    }

    pub async fn unread_tool_results(
        &self,
        invocation: &Invocation,
        observed: u64,
    ) -> Result<bool, StoreError> {
        self.check_bound_session(&invocation.session_id)?;
        let invocation = invocation.invocation_id.clone();
        let observed = i64::try_from(observed).map_err(|_| StoreError::PrefixTooLarge)?;
        self.connection.read(move |db| {
            Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM runtime_events s WHERE s.invocation_id=? AND s.kind='tool_settled' AND s.sequence>? AND EXISTS(SELECT 1 FROM runtime_events y WHERE y.invocation_id=s.invocation_id AND y.operation_id=s.operation_id AND (y.kind='tool_yielded' OR y.kind='tool_dispatched' AND json_extract(y.event_header,'$.fact.call.origin.kind')='code_cell')))", rusqlite::params![invocation, observed], |row| row.get(0))?)
        }).await
    }

    /// Serialize the foreground observation with actual tool settlement.
    pub async fn yield_running_tools(&self, invocation: &Invocation) -> Result<(), StoreError> {
        self.check_bound_session(&invocation.session_id)?;
        let invocation = invocation.clone();
        let commits = self.commits.session(&invocation.session_id);
        self.connection.run(move |connection| {
            let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
            let calls: Vec<(String, String)> = tx.prepare_cached(concat!("WITH ", crate::model_items::accepted_calls!(),
                " SELECT c.step_id,c.call FROM accepted_calls c WHERE c.invocation_id=? AND json_extract(c.call,'$.provider_executed')=0 AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=c.invocation_id AND d.operation_id=c.step_id || ':' || json_extract(c.call,'$.id') AND d.kind IN ('tool_dispatched','tool_rejected')) ORDER BY c.sequence"))?.query_map(rusqlite::params![&invocation.invocation_id], |row| Ok((row.get(0)?, row.get(1)?,)))?.collect::<Result<Vec<_>, _>>()?;
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
                match Self::append_in_transaction(&tx, &write)? {
                    AppendResult::Inserted(sequence) | AppendResult::ActivationChanged(sequence) => high = Some(sequence),
                    AppendResult::Existing(_) => return Err(StoreError::EventConflict),
                }
            }
            let operations: Vec<String> = tx.prepare_cached("SELECT d.operation_id FROM runtime_events d WHERE d.invocation_id=? AND d.kind='tool_dispatched' AND json_extract(d.event_header,'$.fact.call.origin.kind')='provider' AND NOT EXISTS(SELECT 1 FROM runtime_events s WHERE s.invocation_id=d.invocation_id AND s.operation_id=d.operation_id AND s.kind IN ('tool_settled','tool_yielded')) ORDER BY d.sequence")?.query_map(rusqlite::params![&invocation.invocation_id], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
            for operation_id in operations {
                let write = EventWrite::plain(RuntimeEvent::new(invocation.clone(), Fact::ToolYielded { operation_id }))
                    .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
                match Self::append_in_transaction(&tx, &write)? {
                    AppendResult::Inserted(sequence) | AppendResult::ActivationChanged(sequence) => high = Some(sequence),
                    AppendResult::Existing(_) => return Err(StoreError::EventConflict),
                }
            }
            tx.commit().map_err(StoreError::CommitUnknown)?;
            if let Some(high) = high { commits.publish(high); }
            Ok(())
        }).await
    }

    async fn commit_steering(
        &self,
        invocation: &Invocation,
    ) -> Result<Vec<maka_agent_facts::message::RootSourceMessage>, StoreError> {
        // Only an empty snapshot bypasses the writer; deliveries are rechecked below.
        let session = invocation.session_id.clone();
        let pending: bool = self
            .connection
            .read_interruptible(move |connection| {
                {
                    connection
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id=?)",
                            rusqlite::params![session],
                            |row| row.get(0),
                        )
                        .map_err(Into::into)
                }
            })
            .await?;
        if !pending {
            return Ok(Vec::new());
        }
        let invocation = invocation.clone();
        let commits = self.commits.session(&invocation.session_id);
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let pending = crate::message_admissions::pending(&tx, &invocation.session_id)?;
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
                    match Self::append_in_transaction(&tx, &event)? {
                        AppendResult::Inserted(sequence)
                        | AppendResult::ActivationChanged(sequence) => high = Some(sequence),
                        AppendResult::Existing(_) => return Err(StoreError::EventConflict),
                    }
                    delivered.push(admission.source);
                }
                if let Some(high) = high {
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.publish(high);
                } else {
                    tx.rollback()?;
                }
                Ok(delivered)
            })
            .await
    }
}
