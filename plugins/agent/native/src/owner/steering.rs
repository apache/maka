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

impl Owner {
    pub(super) async fn steer_message(
        self: &Arc<Self>,
        text: String,
        attachments: Vec<String>,
        invocation: &Invocation,
        basis: &MessageBasis,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<SendResult, String> {
        let session = invocation.session_id.as_str();
        let mut basis = basis.clone();
        basis.fingerprint = operation.fingerprint.clone();
        let mut unprepared: MessageInput = text.into();
        unprepared.attachments = self.attachment_refs(session, attachments).await?;
        let (message, required_tools) = match self
            .prepare_skills(
                unprepared.clone(),
                basis.language,
                Some(basis.workspace.clone()),
                parent,
                self.selected_tools(
                    session,
                    &basis,
                    false,
                    basis.model.as_ref().and_then(|model| model.editing_tools),
                )?
                .names(),
            )
            .await?
        {
            skills::Input::Ready {
                message,
                required_tools,
            } => (message, required_tools),
            skills::Input::Rejected { reason, skills } => {
                return Ok(SendResult::Rejected {
                    session_id: session.into(),
                    reason,
                    skills,
                });
            }
        };
        let source = RootSourceMessage {
            message: DeliveredMessage {
                origin: parent.identity.agent().cloned().map(|invocation| {
                    maka_agent_facts::message::MessageOrigin::Session { invocation }
                }),
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
        let pending = maka_event_log::message_admissions::PendingMessageAdmission {
            execution: maka_event_log::message_admissions::PendingExecution {
                owner: self.prefix.clone(),
                basis: serde_json::to_value(&basis).map_err(|error| error.to_string())?,
            },
            invocation: invocation.clone(),
            steering_invocation: None,
            source,
            required_tools,
            admitted_at: now(),
        };
        let store = self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?;
        loop {
            let revision = store
                .message_queue_revision(session)
                .await
                .map_err(|error| error.to_string())?;
            match store
                .admit_queued_message(&self.revision.activation, revision, pending.clone())
                .await
            {
                Ok(receipt) => {
                    return Ok(SendResult::Queued {
                        session_id: session.into(),
                        message_id: pending.source.message.message_id.clone(),
                        revision: receipt.queue_revision,
                    });
                }
                Err(maka_event_log::StoreError::RevisionConflict { .. }) => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
    }
}
