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

use super::{Executions, Result, failure};
use maka_event_log::{
    StoreError,
    message_admissions::{MessageSubmitReceipt, PendingMessageAdmission},
};
use maka_protocol::{OperationErrorCode as Code, message::SubmitResult};
use maka_runtime::{
    event::Invocation,
    message::{MessageDisposition, Placement, RootSourceMessage},
};

impl Executions {
    /// Caller retains the Session admission gate and the current cleanup owner.
    pub(super) async fn queue_message(
        &self,
        epoch: &str,
        invocation: Invocation,
        mut source: RootSourceMessage,
        root_id: &str,
        prepared: Option<crate::execution::input::PreparedMessageInput>,
        native: (
            &super::native::NativeInput,
            &maka_config::plugin_authorization::Principal,
        ),
    ) -> Result<SubmitResult> {
        if source.submitted_intent.is_some() {
            return Err(failure(
                Code::SessionBusy,
                "Exact Turn intent requires an idle Session",
            ));
        }
        let mut required_tools = Default::default();
        if let Some(prepared) = prepared {
            source.message.content = prepared.content;
            match prepared.selection {
                crate::execution::input::Outcome::Ready {
                    required_tools: requirements,
                } => {
                    required_tools = requirements;
                }
                crate::execution::input::Outcome::Blocked { message } => {
                    return Ok(SubmitResult::Blocked {
                        message,
                        preparation: source.message.content.preparation,
                    });
                }
            };
        }
        self.validate_message_content(
            &invocation.session_id,
            &source.message.content.clone().into(),
            root_id,
        )
        .await?;
        source.disposition = match source.submitted_placement {
            Placement::CurrentTurn => MessageDisposition::Steering,
            Placement::NextTurn => MessageDisposition::Followup,
        };
        let admission = PendingMessageAdmission {
            required_tools,
            invocation,
            steering_invocation: None,
            source,
            admitted_at: u64::try_from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(super::internal)?
                    .as_millis(),
            )
            .map_err(super::internal)?,
        };
        loop {
            let mut observation = self
                .log
                .session_projection::<crate::session::SessionConfiguration>(
                    &admission.invocation.session_id,
                )
                .await
                .map_err(|e| self.message_storage_error(e))?
                .ok_or_else(|| failure(Code::NotFound, "Session does not exist"))?;
            if observation.session.archived {
                return Err(failure(Code::SessionArchived, "Session is archived"));
            }
            let revision = observation.message_queue.revision;
            observation.message_queue.entries.push(admission.clone());
            crate::server::messages::capacity::validate(epoch, observation)?;
            let _native_admission = native
                .0
                .admit(self, &admission.invocation.session_id, native.1)
                .await?;
            match self
                .log
                .admit_queued_message(epoch, revision, admission.clone())
                .await
            {
                Ok(receipt) => return result(receipt),
                // Only canonical consumption can race this gate-held snapshot;
                // it removes pending rows, so revalidation cannot starve.
                Err(StoreError::RevisionConflict { .. }) => continue,
                Err(error) => return Err(self.message_storage_error(error)),
            }
        }
    }

    pub(crate) fn message_storage_error(&self, error: StoreError) -> maka_protocol::OperationError {
        let code = match &error {
            StoreError::CommitUnknown(_) | StoreError::OperationUnknown => {
                self.begin_drain();
                Code::OutcomeUnknown
            }
            StoreError::SessionNotFound => Code::NotFound,
            StoreError::SessionBusy | StoreError::PrefixTooLarge => Code::SessionBusy,
            StoreError::RevisionConflict { .. } | StoreError::InvalidTransition(_) => {
                Code::OperationConflict
            }
            _ => Code::InternalFailure,
        };
        failure(code, &error.to_string())
    }
}

pub(super) fn result(receipt: MessageSubmitReceipt) -> Result<SubmitResult> {
    Ok(match receipt.disposition {
        MessageDisposition::Steering => SubmitResult::Steering {
            preparation: receipt.preparation,
            queue_revision: Some(receipt.queue_revision),
        },
        MessageDisposition::Followup => SubmitResult::Followup {
            preparation: receipt.preparation,
            queue_revision: Some(receipt.queue_revision),
        },
        MessageDisposition::TurnStarted => {
            return Err(failure(
                Code::InternalFailure,
                "Invalid queued admission receipt",
            ));
        }
    })
}
