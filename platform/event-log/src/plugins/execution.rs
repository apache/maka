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
use maka_agent_facts::message::Placement;
use maka_agent_ports::execution::Observation;
use maka_agent_ports::execution::Progress;
use maka_agent_ports::execution::Receipt;
use maka_agent_ports::execution::Submit;
use maka_capabilities::storage::Namespace;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

impl EventLog {
    /// Observe pending admission and canonical delivery in one read transaction.
    pub async fn plugin_execution_progress(
        &self,
        namespace: &Namespace,
        operation: &maka_agent_ports::execution::SessionOperation,
    ) -> Result<Option<Observation>, StoreError> {
        operation
            .validate()
            .map_err(|error| invalid(&error.to_string()))?;
        crate::sessions::validate_id(&operation.session_id)?;
        let operation = operation.clone();
        let package = namespace.package().to_owned();
        let scope = String::from(namespace.scope().clone());
        self.connection
            .read(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Deferred)?;
                    let Some(receipt) = read(
                        &tx,
                        &package,
                        &scope,
                        &operation.session_id,
                        &operation.operation_id,
                    )
                    ?
                    else {
                        return Ok(None);
                    };
                    let invocation = &receipt.invocation;
                    let boundary = crate::turns::read(
                        &tx,
                        &invocation.session_id,
                        Some(&invocation.turn_id),
                    )
                    ?;
                    let mut attention_id = None;
                    let (progress, terminal_event_id) = match boundary {
                        Some(boundary) => {
                            if boundary.root_invocation() != invocation {
                                return Err(StoreError::EventConflict);
                            }
                            use crate::turns::InvocationState;
                            match boundary.state {
                                InvocationState::Admitted | InvocationState::Running => {
                                    (Progress::Running, None)
                                }
                                InvocationState::WaitingForUser => {
                                    let mut requests = crate::interactions::pending(
                                        &tx,
                                        &invocation.session_id,
                                    )
                                    ?
                                    .into_iter()
                                    .filter(|request| {
                                        request.run_id == boundary.invocation.run_id
                                            && request.turn_id == boundary.invocation.turn_id
                                    })
                                    .map(|request| request.request_id)
                                    .collect::<Vec<_>>();
                                    requests.sort_unstable();
                                    attention_id = Some(format!(
                                        "sha256:{}",
                                        hex::encode(Sha256::digest(serde_json::to_vec(&requests)?))
                                    ));
                                    (Progress::WaitingForUser, None)
                                }
                                InvocationState::Ended {
                                    outcome:
                                        maka_agent_facts::event::InvocationOutcome::HandoffPaused {
                                            ..
                                        },
                                    event_id,
                                } => {
                                    attention_id = Some(event_id);
                                    (Progress::Paused, None)
                                }
                                InvocationState::Ended { outcome, event_id } => {
                                    (Progress::Ended { outcome }, Some(event_id))
                                }
                            }
                        }
                        None => {
                            let pending = crate::message_admissions::read(
                                &tx,
                                &invocation.session_id,
                                &receipt.message_id,
                            )
                            ?
                            .ok_or_else(|| {
                                invalid("accepted execution has no pending or canonical owner")
                            })?;
                            if pending.invocation != *invocation {
                                return Err(StoreError::EventConflict);
                            }
                            (Progress::Pending, None)
                        }
                    };
                    let through_sequence = crate::observation::high_water(&tx)?;
                    tx.commit()?;
                    Ok(Some(Observation {
                        receipt,
                        progress,
                        through_sequence,
                        terminal_event_id,
                        attention_id,
                    }))
                }
            })
            .await
    }

    /// The caller authorizes the current instance and owns Session admission.
    /// The SQL owner commits accepted work and its stable receipt together even
    /// if the caller loses its response. No plugin generation or Host epoch is a key.
    pub async fn admit_plugin_execution(
        &self,
        namespace: &Namespace,
        request: Submit,
        pending: PendingMessageAdmission,
    ) -> Result<Receipt, StoreError> {
        request
            .validate()
            .map_err(|error| invalid(&error.to_string()))?;
        let digest = request
            .digest()
            .map_err(|error| invalid(&error.to_string()))?;
        let expected_placement = if request.orchestration_mode.is_some() {
            Placement::CurrentTurn
        } else {
            Placement::NextTurn
        };
        if pending.invocation.session_id != request.session_id
            || pending.steering_invocation.is_some()
            || pending.source.disposition != MessageDisposition::TurnStarted
            || pending.source.submitted_placement != expected_placement
            || pending.source.message.submitted_content_digest
                != request.content.content_digest()?
            || pending
                .source
                .submitted_intent
                .as_ref()
                .and_then(|intent| intent.turn_orchestration.as_ref())
                .map(|o| &o.mode)
                != request.orchestration_mode.as_ref()
            || pending
                .source
                .submitted_intent
                .as_ref()
                .is_some_and(|intent| !intent.input_selections.is_empty())
        {
            return Err(invalid("prepared execution does not match its submission"));
        }
        let package = namespace.package().to_owned();
        let scope = String::from(namespace.scope().clone());
        let commits = self.commits.session(&request.session_id);
        self.connection
            .run(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
                    if let Some(receipt) =
                        read(&tx, &package, &scope, &request.session_id, &request.operation_id)?
                    {
                        if receipt.content_digest != digest
                            || receipt.invocation.session_id != request.session_id
                        {
                            return Err(StoreError::EventConflict);
                        }
                        return Ok(receipt);
                    }
                    let receipt = Receipt {
                        invocation: pending.invocation.clone(),
                        message_id: pending.source.message.message_id.clone(),
                        content_digest: digest,
                    };
                    if insert::insert(&tx, &pending, insert::Owner::Unsealed)
                        ?
                        .is_none()
                    {
                        return Err(StoreError::EventConflict);
                    }
                    tx.execute("INSERT INTO plugin_execution_receipts (package_id, scope_id, target_session_id, operation_id, receipt_json) VALUES (?, ?, ?, ?, ?)", rusqlite::params![&package, &scope, &request.session_id, &request.operation_id, serde_json::to_string(&receipt)?])
                        ?;
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.metadata();
                    Ok(receipt)
                }
            })
            .await
    }

    pub async fn plugin_execution_receipt(
        &self,
        namespace: &Namespace,
        operation: &maka_agent_ports::execution::SessionOperation,
    ) -> Result<Option<Receipt>, StoreError> {
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
) -> Result<Option<Receipt>, StoreError> {
    let row: Option<Option<String>> = connection.query_row("SELECT CASE WHEN length(CAST(receipt_json AS BLOB)) <= 4096 THEN receipt_json END
         FROM plugin_execution_receipts WHERE package_id = ? AND scope_id = ? AND target_session_id = ? AND operation_id = ?", rusqlite::params![package, scope, session, operation], |row| row.get(0)).optional()
    ?;
    row.map(|encoded| {
        let receipt: Receipt = serde_json::from_str(&encoded.ok_or(StoreError::PrefixTooLarge)?)?;
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
            || !maka_agent_facts::archive::valid_projection_digest(&receipt.content_digest)
        {
            return Err(invalid("invalid plugin execution receipt"));
        }
        Ok(receipt)
    })
    .transpose()
}
