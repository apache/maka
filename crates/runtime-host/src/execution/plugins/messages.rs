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

use super::protocol;
use super::{BoundCommands, Error, Executions, SessionConfiguration, storage};
use maka_event_log::{
    StoreError, message_admissions::PendingMessageAdmission, message_resolution::MessageExecution,
};
use maka_plugins::execution::{
    Enqueue, Excerpt, MessageObservation, MessageReceipt, MessageState, Progress,
};
use maka_runtime::{
    input::DeliveredMessage,
    message::{MessageDisposition, Placement, RootSourceMessage},
};
use std::sync::Arc;

impl BoundCommands {
    pub(super) async fn read_message(
        &self,
        message: maka_plugins::execution::SessionMessage,
    ) -> Result<Option<MessageState>, Error> {
        message
            .validate()
            .map_err(|error| Error::Invalid(error.to_string()))?;
        let host = self.executions()?;
        let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
        self.authorize(&host, &message.session_id).await?;
        let observation = host
            .log
            .message_observation(
                &message.session_id,
                &message.message_id,
                message.cursor.as_ref().map_or(0, |cursor| cursor.offset),
            )
            .await
            .map_err(storage)?;
        if let Some(cursor) = &message.cursor {
            let invocation = match &observation.execution {
                MessageExecution::Owned(boundary) | MessageExecution::Shared(boundary) => {
                    &boundary.invocation
                }
                _ => return Err(Error::Conflict),
            };
            if invocation.invocation_id != cursor.invocation_id {
                return Err(Error::Conflict);
            }
        }
        Ok(project(
            observation,
            message.cursor.as_ref().map_or(0, |cursor| cursor.offset),
        ))
    }

    pub(super) async fn enqueue_message(&self, request: Enqueue) -> Result<MessageReceipt, Error> {
        let digest = request
            .digest()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let host = self.executions()?;
        let _submission = host
            .submissions
            .track(&request.invocation.session_id, &request.message_id);
        let mut prepared = None;
        loop {
            let gate = host.interactions.own_admission().await;
            let lease = self.context.admit().map_err(|_| Error::Revoked)?;
            self.authorize(&host, &request.invocation.session_id)
                .await?;
            if let Some(receipt) = host
                .log
                .plugin_message_receipt(&self.namespace, &request.operation_id)
                .await
                .map_err(storage)?
            {
                return if receipt.request_digest == digest {
                    Ok(receipt)
                } else {
                    Err(Error::Conflict)
                };
            }
            if self.submission_stop.is_cancelled() {
                return Err(Error::Revoked);
            }
            if host
                .active_session_owner(&request.invocation.session_id)
                .as_ref()
                != Some(&request.invocation)
            {
                return Err(Error::Conflict);
            }
            let Some(candidate) = prepared.take() else {
                let session = host
                    .log
                    .get_session::<SessionConfiguration>(&request.invocation.session_id)
                    .await
                    .map_err(storage)?
                    .ok_or(Error::NotFound)?;
                let tools = match request.placement {
                    Placement::CurrentTurn => Some(
                        host.active_tool_names(&request.invocation)
                            .ok_or(Error::Conflict)?,
                    ),
                    Placement::NextTurn => None,
                };
                drop(gate);
                prepared = Some(
                    host.prepare_message_input(session, request.content.clone(), None, tools)
                        .await
                        .map_err(protocol)?,
                );
                continue;
            };
            let Some((candidate, input_lease)) = candidate
                .commit(&host, &request.invocation.session_id)
                .await
                .map_err(protocol)?
            else {
                continue;
            };
            let required_tools = match candidate.selection {
                crate::execution::input::Outcome::Ready { required_tools } => required_tools,
                crate::execution::input::Outcome::Blocked { message } => {
                    return Err(Error::Invalid(message));
                }
            };
            host.validate_message_content(
                &request.invocation.session_id,
                &candidate.content.clone().into(),
                &self.root_id,
            )
            .await
            .map_err(protocol)?;
            let pending = PendingMessageAdmission {
                invocation: request.invocation.clone(),
                steering_invocation: None,
                source: RootSourceMessage {
                    unprepared_content: request.content.clone(),
                    message: DeliveredMessage {
                        message_id: request.message_id.clone(),
                        submitted_content_digest: request
                            .content
                            .content_digest()
                            .map_err(|e| Error::Invalid(e.to_string()))?,
                        content: candidate.content,
                    },
                    submitted_placement: request.placement,
                    disposition: match request.placement {
                        Placement::CurrentTurn => MessageDisposition::Steering,
                        Placement::NextTurn => MessageDisposition::Followup,
                    },
                    submitted_intent: None,
                },
                required_tools,
                admitted_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| Error::Host(e.to_string()))?
                    .as_millis()
                    .try_into()
                    .map_err(|_| Error::Host("clock overflow".into()))?,
            };
            let mut observation = host
                .log
                .session_projection::<SessionConfiguration>(&request.invocation.session_id)
                .await
                .map_err(storage)?
                .ok_or(Error::NotFound)?;
            observation.message_queue.entries.push(pending.clone());
            // Reserve the full epoch-field budget, independent of this process.
            crate::server::messages::capacity::validate(&"x".repeat(128), observation)
                .map_err(protocol)?;
            let namespace = self.namespace.clone();
            let (send, receive) = tokio::sync::oneshot::channel();
            let worker = host.clone();
            host.workers.spawn(async move {
                let result = worker
                    .log
                    .admit_plugin_message(&namespace, request, pending)
                    .await
                    .map_err(|error| stored(&worker, error));
                drop(input_lease);
                drop(gate);
                drop(lease);
                let _ = send.send(result);
            });
            return receive
                .await
                .map_err(|_| Error::OutcomeUnknown("queued message owner disappeared".into()))?;
        }
    }

    async fn queued_receipt(
        &self,
        host: &Executions,
        operation: &str,
    ) -> Result<MessageReceipt, Error> {
        let receipt = host
            .log
            .plugin_message_receipt(&self.namespace, operation)
            .await
            .map_err(storage)?
            .ok_or(Error::NotFound)?;
        self.authorize(host, &receipt.invocation.session_id).await?;
        Ok(receipt)
    }
    pub(super) async fn observe_message(
        &self,
        operation: String,
    ) -> Result<MessageObservation, Error> {
        let host = self.executions()?;
        let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
        let receipt = self.queued_receipt(&host, &operation).await?;
        observe(&host, receipt).await
    }
    pub(super) async fn retract_message(
        &self,
        operation: String,
    ) -> Result<MessageObservation, Error> {
        let host = self.executions()?;
        let gate = host.interactions.own_admission().await;
        let lease = self.context.admit().map_err(|_| Error::Revoked)?;
        let receipt = self.queued_receipt(&host, &operation).await?;
        let worker = host.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        host.workers.spawn(async move {
            let result = async {
                worker
                    .log
                    .retract_plugin_message(&receipt)
                    .await
                    .map_err(|e| stored(&worker, e))?;
                observe(&worker, receipt).await
            }
            .await;
            drop(gate);
            drop(lease);
            let _ = send.send(result);
        });
        receive
            .await
            .map_err(|_| Error::OutcomeUnknown("message retraction owner disappeared".into()))?
    }
}

async fn observe(host: &Executions, receipt: MessageReceipt) -> Result<MessageObservation, Error> {
    let observation = host
        .log
        .message_observation(&receipt.invocation.session_id, &receipt.message_id, 0)
        .await
        .map_err(storage)?;
    let state = project(observation, 0)
        .ok_or_else(|| Error::Host("accepted message has no canonical owner".into()))?;
    Ok(MessageObservation { receipt, state })
}

fn project(
    observation: maka_event_log::observation::MessageObservation,
    offset: u64,
) -> Option<MessageState> {
    let exclusive = matches!(observation.execution, MessageExecution::Owned(_));
    let state = match observation.execution {
        MessageExecution::Pending => MessageState::Pending,
        MessageExecution::Cancelled => MessageState::Cancelled,
        MessageExecution::Missing => return None,
        MessageExecution::Owned(boundary) | MessageExecution::Shared(boundary) => {
            use maka_event_log::turns::InvocationState;
            let invocation = boundary.invocation;
            let progress = match boundary.state {
                InvocationState::Admitted | InvocationState::Running => Progress::Running,
                InvocationState::WaitingForUser => Progress::WaitingForUser,
                InvocationState::Ended {
                    outcome: maka_runtime::event::InvocationOutcome::HandoffPaused { .. },
                    ..
                } => Progress::Paused,
                InvocationState::Ended { outcome, .. } => Progress::Ended { outcome },
            };
            MessageState::Delivered {
                invocation: invocation.clone(),
                exclusive,
                progress: Box::new(progress),
                interactions: observation
                    .interactions
                    .into_iter()
                    .map(|record| {
                        use maka_plugins::execution::{InteractionKind, PendingInteraction};
                        use maka_runtime::interaction::InteractionRequest;
                        PendingInteraction {
                            request_id: record.request_id,
                            kind: match record.request {
                                InteractionRequest::Question { .. } => InteractionKind::Question,
                                InteractionRequest::Form { .. } => InteractionKind::Form,
                                InteractionRequest::Permissions { .. } => {
                                    InteractionKind::Permissions
                                }
                                InteractionRequest::ClientCapability { .. } => {
                                    InteractionKind::ClientCapability
                                }
                            },
                        }
                    })
                    .collect(),
                answer: observation.answer.map(|answer| Excerpt {
                    next: (!answer.complete).then(|| maka_plugins::execution::AnswerCursor {
                        invocation_id: invocation.invocation_id,
                        offset: offset + answer.text.len() as u64,
                    }),
                    text: answer.text,
                    complete: answer.complete,
                }),
            }
        }
    };
    Some(state)
}
fn stored(host: &Arc<Executions>, error: StoreError) -> Error {
    if matches!(
        error,
        StoreError::CommitUnknown(_) | StoreError::OperationUnknown
    ) {
        host.begin_drain();
    }
    storage(error)
}
