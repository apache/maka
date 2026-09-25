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

use super::{Executions, Result, failure, internal};
use maka_protocol::{
    OperationErrorCode as Code,
    message::{SubmitInput, SubmitResult},
    turn::TurnStartInput,
};
use maka_runtime::{
    input::{DeliveredMessage, MessageInput},
    message::{MessageDisposition, RootSourceMessage, SubmittedTurnIntent},
};
use uuid::Uuid;

mod native;
mod queued;
mod submissions;
pub(super) use submissions::Submissions;

impl Executions {
    pub(crate) async fn submit(
        self: &std::sync::Arc<Self>,
        input: SubmitInput,
        connection_id: Uuid,
        root_id: &str,
        epoch: &str,
        principal: &maka_config::plugin_authorization::Principal,
    ) -> Result<SubmitResult> {
        let _submission = self.submissions.track(&input.session_id, &input.message_id);
        let mut native = None;
        let mut prepared = None;
        let mut queued: Option<(
            maka_runtime::event::Invocation,
            Result<super::input::PreparedMessageInput>,
        )> = None;
        loop {
            let admission = self.lock_admission().await;
            if self.shutdown.is_cancelled() {
                return Err(failure(Code::HostDraining, "Host is draining"));
            }
            let content: MessageInput = input.content.clone().into();
            let digest = content.content_digest().map_err(internal)?;
            let intent = (!input.input_selections.is_empty() || input.turn_orchestration.is_some())
                .then(|| SubmittedTurnIntent {
                    input_selections: input.input_selections.clone(),
                    turn_orchestration: input.turn_orchestration.clone(),
                });
            if input.origin_host_epoch == epoch
                && let Some(receipt) = self
                    .log
                    .message_submit_receipt(epoch, &input.session_id, &input.message_id)
                    .await
                    .map_err(|error| self.message_storage_error(error))?
            {
                if receipt.content_digest != digest
                    || receipt.submitted_placement != input.placement
                    || receipt.submitted_intent != intent
                {
                    return Err(failure(
                        Code::OperationConflict,
                        "Message identity belongs to another input",
                    ));
                }
                return queued::result(receipt);
            }
            // Canonical proof precedes epoch/configuration/archive checks. A lost
            // response is not permission to create another root or call a model.
            if let Some(proof) = self
                .log
                .root_message(&input.session_id, &input.message_id)
                .await
                .map_err(internal)?
            {
                let source = proof.source();
                if source.message.submitted_content_digest != digest
                    || source.submitted_placement != input.placement
                    || source.submitted_intent != intent
                {
                    return Err(failure(
                        Code::OperationConflict,
                        "Message identity belongs to another input",
                    ));
                }
                return Ok(match source.disposition {
                    MessageDisposition::TurnStarted => SubmitResult::TurnStarted {
                        turn_id: proof.opening().event.invocation.turn_id.clone(),
                        preparation: source.message.content.preparation.clone(),
                    },
                    MessageDisposition::Steering => SubmitResult::Steering {
                        preparation: source.message.content.preparation.clone(),
                        queue_revision: None,
                    },
                    MessageDisposition::Followup => SubmitResult::Followup {
                        preparation: source.message.content.preparation.clone(),
                        queue_revision: None,
                    },
                });
            }
            if input.origin_host_epoch != epoch {
                return Err(failure(
                    Code::OutcomeUnknown,
                    "Message admission cannot be proven across Host Epochs",
                ));
            }
            if self
                .log
                .message_cancelled(&input.session_id, &input.message_id)
                .await
                .map_err(internal)?
            {
                return Err(failure(
                    Code::OperationConflict,
                    "Message was durably cancelled",
                ));
            }
            if self
                .log
                .steering_message(&input.session_id, &input.message_id)
                .await
                .map_err(internal)?
                .is_some()
            {
                return Err(failure(
                    Code::OutcomeUnknown,
                    "Original steering admission receipt is unavailable",
                ));
            }
            if native.is_none() {
                native = Some(native::NativeInput::capture(self, &input, principal).await?);
            }
            let native = native.as_ref().expect("captured native input authority");
            // Revalidate even retries that need another preparation. A changed
            // registration/configuration must fail, never rescue an old input.
            drop(native.admit(self, &input.session_id, principal).await?);
            let source = RootSourceMessage {
                unprepared_content: content.clone(),
                message: DeliveredMessage {
                    message_id: input.message_id.clone(),
                    content,
                    submitted_content_digest: digest,
                },
                submitted_placement: input.placement,
                disposition: MessageDisposition::TurnStarted,
                submitted_intent: intent,
            };
            let active = self
                .active
                .lock()
                .unwrap()
                .values()
                .find(|run| run.invocation.session_id == input.session_id)
                .map(|run| run.invocation.clone());
            if let Some(invocation) = active {
                native.check_active(self, &invocation).await?;
                let (skills, _input_admission) = if source.submitted_intent.is_none() {
                    match queued.take() {
                        Some((owner, candidate)) if owner == invocation => {
                            let candidate = candidate?;
                            if let Some(environment) = candidate.environment() {
                                native.check_environment(environment)?;
                            }
                            let Some((candidate, admission)) =
                                candidate.commit(self, &input.session_id).await?
                            else {
                                continue;
                            };
                            (Some(candidate), admission)
                        }
                        _ => {
                            let session = self
                                .log
                                .get_session::<crate::session::SessionConfiguration>(
                                    &input.session_id,
                                )
                                .await
                                .map_err(internal)?
                                .ok_or_else(|| failure(Code::NotFound, "Session does not exist"))?;
                            let tools = if source.submitted_placement
                                == maka_runtime::message::Placement::CurrentTurn
                            {
                                Some(self.active_tool_names(&invocation).ok_or_else(|| {
                                    failure(
                                        Code::OperationConflict,
                                        "Steering target is no longer active",
                                    )
                                })?)
                            } else {
                                None
                            };
                            drop(admission);
                            let candidate = self
                                .prepare_message_input(
                                    session,
                                    source.message.content.clone(),
                                    Some(connection_id),
                                    tools,
                                )
                                .await;
                            queued = Some((invocation, candidate));
                            continue;
                        }
                    }
                } else {
                    (None, None)
                };
                return self
                    .queue_message(
                        epoch,
                        invocation,
                        source,
                        root_id,
                        skills,
                        (native, principal),
                    )
                    .await;
            }
            if !self
                .log
                .pending_messages(&input.session_id)
                .await
                .map_err(internal)?
                .is_empty()
            {
                return Err(failure(
                    Code::SessionBusy,
                    "Session has live or pending work",
                ));
            }
            self.log
                .validate_message_identity(&input.session_id, &input.message_id)
                .await
                .map_err(|error| match error {
                    maka_event_log::StoreError::InvalidTransition(reason) => {
                        failure(Code::OperationConflict, &reason)
                    }
                    other => internal(other),
                })?;
            let Some(candidate) = prepared.take() else {
                drop(admission);
                prepared = Some(
                    async {
                        let environment = self
                            .prepare_environment(
                                &input.session_id,
                                Some(connection_id),
                                maka_client_capability::BindingMode::Strict,
                                input
                                    .turn_orchestration
                                    .as_ref()
                                    .map(|intent| intent.mode.clone()),
                            )
                            .await?;
                        environment
                            .expand(input.content.clone().into(), input.input_selections.clone())
                            .await
                    }
                    .await,
                );
                continue;
            };
            let (environment, content, selection) = candidate?;
            native.check_environment(&environment)?;
            let Some((environment, _input_admission)) =
                environment.commit(self, &input.session_id).await?
            else {
                continue;
            };
            if let super::input::Outcome::Blocked { message } = selection {
                return Ok(SubmitResult::Blocked {
                    message,
                    preparation: content.preparation,
                });
            }
            let preparation = content.preparation.clone();
            let mut source = source;
            source.message.content = content.clone();
            let mut run = self
                .prepare_message(
                    TurnStartInput {
                        session_id: input.session_id.clone(),
                        turn_id: Uuid::new_v4().to_string(),
                        content: content.clone().into(),
                        // Original input intent stays in the source identity.
                        // Preparation below uses this Run's actual frozen tools.
                        input_selections: Default::default(),
                        turn_orchestration: input.turn_orchestration,
                        max_steps: None,
                    },
                    super::prepare::MessageOrigin::Client { root_id },
                    None,
                    vec![source],
                    environment,
                )
                .await?;
            run.message(content)?;
            // Opening and original source identity commit together before any model
            // or tool effect. There is no separately accepted, unstarted idle row.
            let _native_admission = native.admit(self, &input.session_id, principal).await?;
            let turn = self.launch(run).await?;
            return Ok(SubmitResult::TurnStarted {
                turn_id: turn.turn_id,
                preparation,
            });
        }
    }
}
