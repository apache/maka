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
use maka_event_log::message_queue::{MessageQueue, QueueCommand, QueueEdit};

impl MessageBasis {
    fn same_execution(&self, other: &Self) -> bool {
        self.mcp_revision == other.mcp_revision
            && self.language == other.language
            && self.compaction_prompt == other.compaction_prompt
            && self.collaboration_mode == other.collaboration_mode
            && self.tool_discovery == other.tool_discovery
            && self.background_kind == other.background_kind
            && self.background == other.background
            && self.model == other.model
            && self.executor == other.executor
            && self.internal_tools == other.internal_tools
            && self.internal_bindings == other.internal_bindings
            && self.behavior == other.behavior
            && self.workspace == other.workspace
            && self.binding == other.binding
            && self.tools == other.tools
    }
}
impl Owner {
    async fn pending_queue(&self, session: &str) -> Result<MessageQueue, String> {
        self.session(session).await?;
        let queue = self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .message_queue(session)
            .await
            .map_err(|_| "agent_queue_unavailable")?;
        if queue
            .entries
            .iter()
            .any(|entry| entry.execution.owner != self.prefix)
        {
            return Err("agent_queue_owner_invalid".into());
        }
        Ok(queue)
    }
    pub async fn queue(&self, session: &str) -> Result<Queue, String> {
        let queue = self.pending_queue(session).await?;
        Ok(Queue {
            revision: queue.revision,
            entries: queue
                .entries
                .iter()
                .map(|entry| QueueEntry {
                    origin: entry.source.message.origin.clone(),
                    message_id: entry.source.message.message_id.clone(),
                    kind: match entry.source.disposition {
                        MessageDisposition::TurnStarted => QueueKind::InFlight,
                        MessageDisposition::Steering => QueueKind::Steering,
                        MessageDisposition::Followup => QueueKind::Followup,
                    },
                    preview: if entry.source.unprepared_content.text.trim().is_empty() {
                        entry
                            .source
                            .unprepared_content
                            .attachments
                            .as_ref()
                            .and_then(|files| files.first())
                            .map_or("", |file| file.name.as_str())
                    } else {
                        &entry.source.unprepared_content.text
                    }
                    .chars()
                    .take(80)
                    .map(|c| if c.is_control() { ' ' } else { c })
                    .collect(),
                })
                .collect(),
        })
    }
    pub async fn queue_message(&self, input: QueueMessage) -> Result<QueueMessageResult, String> {
        let queue = self.pending_queue(&input.session_id).await?;
        if queue.revision != input.expected_revision {
            return Ok(QueueMessageResult::RevisionConflict {
                expected: input.expected_revision,
                actual: queue.revision,
            });
        }
        Ok(
            match queue
                .entries
                .iter()
                .find(|entry| entry.source.message.message_id == input.message_id)
            {
                Some(entry) => QueueMessageResult::Ready {
                    revision: queue.revision,
                    has_attachments: entry
                        .source
                        .unprepared_content
                        .attachments
                        .as_ref()
                        .is_some_and(|files| !files.is_empty()),
                    message: entry.source.unprepared_content.text.clone(),
                },
                None => {
                    let state = self
                        .store
                        .session(&input.session_id)
                        .await
                        .map_err(|error| error.to_string())?
                        .message_delivery(&input.session_id, &input.message_id)
                        .await
                        .map_err(|error| error.to_string())?;
                    QueueMessageResult::Missing {
                        reason: match state {
                            maka_event_log::message_queue::MessageDelivery::Delivered => {
                                QueueMessageMissingReason::Delivered
                            }
                            maka_event_log::message_queue::MessageDelivery::Cancelled => {
                                QueueMessageMissingReason::Cancelled
                            }
                            maka_event_log::message_queue::MessageDelivery::Unknown => {
                                QueueMessageMissingReason::Unknown
                            }
                        },
                    }
                }
            },
        )
    }
    pub async fn edit_queue(
        &self,
        input: QueueMutation,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<QueueMutationResult, String> {
        let admission = self.runs.session(&input.session_id).await;
        let runs = admission.state().await;
        let rejected = |reason| Ok(QueueMutationResult::Rejected { reason });
        if runs.closing {
            return rejected(QueueRejection::Closed);
        }
        let promotion = if matches!(&input.edit, QueueAction::Promote { .. }) {
            runs.controls.get(&input.session_id).cloned()
        } else {
            None
        };
        drop(runs);
        let queue = self.pending_queue(&input.session_id).await?;
        if queue.revision != input.expected_revision {
            return Ok(QueueMutationResult::RevisionConflict {
                expected: input.expected_revision,
                actual: queue.revision,
            });
        }
        let target = match &input.edit {
            QueueAction::Retract { message_id }
            | QueueAction::Promote { message_id }
            | QueueAction::Update { message_id, .. } => Some(message_id),
            QueueAction::Reorder { .. } => None,
        };
        let entry = match target {
            Some(id) => {
                let Some(entry) = queue
                    .entries
                    .iter()
                    .find(|entry| &entry.source.message.message_id == id)
                else {
                    return rejected(QueueRejection::Missing);
                };
                if entry.source.disposition == MessageDisposition::TurnStarted {
                    return rejected(QueueRejection::InFlight);
                }
                Some(entry)
            }
            None => None,
        };
        match &parent.identity {
            maka_capabilities::call::Identity::Remote { .. } => {}
            maka_capabilities::call::Identity::Agent { invocation, .. } => {
                let authored =
                    |entry: &maka_event_log::message_admissions::PendingMessageAdmission| {
                        matches!(&entry.source.message.origin,
                        Some(maka_agent_facts::message::MessageOrigin::Session { invocation: source })
                            if source.session_id == invocation.session_id)
                    };
                let permitted = match &input.edit {
                    QueueAction::Reorder { message_ids } => queue
                        .entries
                        .iter()
                        .filter(|entry| message_ids.contains(&entry.source.message.message_id))
                        .all(authored),
                    _ => authored(entry.expect("targeted queue edit")),
                };
                if !permitted {
                    return rejected(QueueRejection::NotYourMessage);
                }
            }
            _ => return rejected(QueueRejection::NotYourMessage),
        }
        let edit = match input.edit {
            QueueAction::Retract { message_id } => QueueEdit::Retract {
                message_id,
                cancellation_id: self.operation_id(operation),
            },
            QueueAction::Update {
                message_id,
                message,
            } => {
                let mut content = entry
                    .expect("targeted update")
                    .source
                    .unprepared_content
                    .clone();
                if message.trim().is_empty()
                    && content.attachments.as_ref().is_none_or(Vec::is_empty)
                {
                    return rejected(QueueRejection::InvalidEdit);
                }
                content.text = message;
                let unprepared = content;
                let basis: MessageBasis =
                    serde_json::from_value(entry.expect("targeted update").execution.basis.clone())
                        .map_err(|_| "agent_message_basis_invalid")?;
                let (message, required_tools) = match self
                    .prepare_skills(
                        unprepared.clone(),
                        basis.language,
                        Some(
                            self.session(&input.session_id)
                                .await?
                                .configuration
                                .workspace,
                        ),
                        parent,
                        self.skill_tool_names(
                            &input.session_id,
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
                    skills::Input::Rejected { .. } => return rejected(QueueRejection::InvalidEdit),
                };
                QueueEdit::Update {
                    message_id,
                    content: Box::new(message),
                    unprepared_content: Box::new(unprepared),
                    required_tools,
                }
            }
            QueueAction::Reorder { message_ids } => QueueEdit::Reorder { message_ids },
            QueueAction::Promote { message_id } => {
                let Some(control) = promotion.as_ref() else {
                    return rejected(QueueRejection::NotRunning);
                };
                let basis: MessageBasis = serde_json::from_value(
                    entry.expect("targeted promotion").execution.basis.clone(),
                )
                .map_err(|_| "agent_message_basis_invalid")?;
                if control.compacting
                    || control.basis.executor.as_ref().is_some_and(|executor| {
                        !matches!(
                            self.executors.active_delivery(executor),
                            crate::executor::ActiveDelivery::Steer
                        )
                    })
                    || !basis.same_execution(&control.basis)
                {
                    return rejected(QueueRejection::ExecutionChanged);
                }
                QueueEdit::Promote {
                    message_id,
                    invocation: control.invocation.clone(),
                }
            }
        };
        let command = QueueCommand {
            host_epoch: self.revision.activation.clone(),
            command_id: self.operation_id(operation),
            kind: edit.command_kind(),
            fingerprint: format!(
                "sha256:{}",
                operation
                    .fingerprint
                    .strip_prefix("sha256-")
                    .expect("validated operation fingerprint")
            ),
        };
        match self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .edit_message_queue(&input.session_id, input.expected_revision, edit, command)
            .await
        {
            Ok(receipt) => Ok(QueueMutationResult::Committed {
                revision: receipt.revision,
            }),
            Err(StoreError::RevisionConflict { actual, .. }) => {
                Ok(QueueMutationResult::RevisionConflict {
                    expected: input.expected_revision,
                    actual: actual.parse().expect("numeric queue revision"),
                })
            }
            Err(StoreError::InvalidTransition(_) | StoreError::PrefixTooLarge) => {
                rejected(QueueRejection::InvalidEdit)
            }
            Err(_) => Err("agent_queue_unavailable".into()),
        }
    }
}
