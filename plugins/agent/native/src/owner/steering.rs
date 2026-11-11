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

use super::*;
use maka_agent_facts::durable::{ExecutionIdentity, UnixMillis};
use maka_agent_state::{Head, queue as durable_queue};

impl Owner {
    #[expect(
        clippy::too_many_arguments,
        reason = "steering keeps message input, target execution, captured policy and original call authority explicit"
    )]
    pub(super) async fn steer_message(
        self: &Arc<Self>,
        text: String,
        attachments: Vec<String>,
        execution: &ExecutionIdentity,
        basis: &CapturedRun,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
        completion_request: Option<completions::CompletionRequest>,
    ) -> Result<NativeMutation<SendResult>, String> {
        let session = execution.session_id.as_str();
        let target = self
            .durable
            .frontier(execution.run_id)
            .await
            .map_err(|error| error.to_string())?;
        if target.spec.session_id != session
            || target.spec.owner != self.run_owner()
            || !parent
                .sandbox_floor()
                .contains(&target.spec.permission_ceiling.sandbox)
                .map_err(|error| error.to_string())?
        {
            return Err("agent_steering_isolation_unavailable".into());
        }
        let mut basis = basis.clone();
        basis.fingerprint = operation.fingerprint.clone();
        let mut unprepared: MessageInput = text.into();
        unprepared.attachments = self.attachment_refs(session, attachments, parent).await?;
        let (message, required_tools) = match self
            .prepare_skills(
                unprepared.clone(),
                basis.language,
                Some(basis.workspace.clone()),
                parent,
                self.skill_tool_names(
                    session,
                    &basis,
                    basis.model.as_ref().and_then(|model| model.editing_tools),
                )?,
            )
            .await?
        {
            skills::Input::Ready {
                message,
                required_tools,
            } => (message, required_tools),
            skills::Input::Rejected { reason, skills } => {
                return Ok(NativeMutation::Returned(SendResult::Rejected {
                    session_id: session.into(),
                    reason,
                    skills,
                }));
            }
        };
        let source = RootSourceMessage {
            message: DeliveredMessage {
                origin: match &parent.identity {
                    maka_capabilities::call::Identity::Agent { execution, .. } => {
                        Some(MessageOrigin::Session {
                            execution: execution.clone(),
                        })
                    }
                    _ => None,
                },
                message_id: format!("m_{}", self.operation_id(operation)),
                submitted_content_digest: unprepared
                    .content_digest()
                    .map_err(|_| "agent_message_invalid")?,
                content: message,
            },
            unprepared_content: unprepared,
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::Steering,
            submitted_intent: None,
        };
        let (request, contents) = self
            .freeze_request(session, source, &basis, required_tools, operation, parent)
            .await?;
        let command_id = self.control_id(operation, "steer_message");
        let at = UnixMillis(now().try_into().expect("Unix milliseconds"));
        let Some(view) = self.session_run(session, execution.run_id).await? else {
            return Err("agent_execution_unavailable".into());
        };
        if view.stopped || view.terminal.is_some() {
            return Ok(NativeMutation::Returned(SendResult::Rejected {
                session_id: session.into(),
                reason: SendRejection::TurnStopped,
                skills: None,
            }));
        }
        let queue = self
            .durable
            .queue()
            .read(session.into())
            .await
            .map_err(|error| error.to_string())?;
        let command = durable_queue::QueueCommand {
            id: command_id,
            at,
            expected_revision: queue.revision,
            edit: durable_queue::QueueEdit::Enqueue {
                request: Box::new(request.clone()),
                placement: durable_queue::Placement::Steering {
                    run: execution.run_id,
                    expected_head: Head::from(&view),
                },
            },
        };
        let completion = completion_request
            .as_ref()
            .map(|_| CompletionRegistration::Registered);
        let writer = self.durable.queue();
        let change = if let Some(completion_request) = completion_request {
            writer.prepare_with(
                session.into(),
                command,
                contents,
                None,
                None,
                self.completion_statement(session, &request.message_id, completion_request)?,
            )
        } else {
            writer.prepare(session.into(), command, contents)
        };
        Ok(NativeMutation::Commit {
            value: SendResult::Queued {
                completion,
                session_id: session.into(),
                message_id: request.message_id,
                revision: queue
                    .revision
                    .checked_add(1)
                    .ok_or("agent_queue_revision_exhausted")?,
            },
            change,
        })
    }
}
