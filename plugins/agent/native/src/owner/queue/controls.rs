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
use crate::{executor::ActiveDelivery, owner::send::PreparedAgentSend};
use maka_agent_facts::durable::{RunSpec, UnixMillis};
use maka_agent_state::{ContentBlob, Head, queue as durable_queue};

fn same_execution(a: &RunSpec, b: &RunSpec) -> bool {
    a.owner == b.owner
        && a.workspace == b.workspace
        && a.permission_basis == b.permission_basis
        && a.permission_ceiling == b.permission_ceiling
        && a.approval_ceiling() == b.approval_ceiling()
        && a.backend == b.backend
        && a.collaboration == b.collaboration
        && a.language == b.language
        && a.tool_discovery == b.tool_discovery
        && a.allowed_tools == b.allowed_tools
        && a.mcp_revision == b.mcp_revision
        && a.compaction_prompt == b.compaction_prompt
        && a.system_prompt == b.system_prompt
        && a.tool_selection == b.tool_selection
        && a.budget == b.budget
}

impl Owner {
    async fn pending_queue(&self, session: &str) -> Result<durable_queue::Queue, String> {
        self.session(session).await?;
        let queue = self
            .durable
            .queue()
            .read(session.into())
            .await
            .map_err(|error| error.to_string())?;
        if queue
            .entries
            .iter()
            .any(|entry| entry.request.spec.owner != self.run_owner())
        {
            return Err("agent_queue_owner_invalid".into());
        }
        Ok(queue)
    }

    async fn queued_source(
        &self,
        session: &str,
        request: &durable_queue::PreparedRequest,
    ) -> Result<RootSourceMessage, String> {
        let bytes = self
            .durable
            .queue()
            .content(session.into(), request.id.clone(), request.source.clone())
            .await
            .map_err(|error| error.to_string())?;
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())
    }

    pub async fn queue(&self, session: &str) -> Result<Queue, String> {
        let queue = self.pending_queue(session).await?;
        let mut entries = Vec::with_capacity(queue.entries.len());
        for entry in queue.entries {
            let source = self.queued_source(session, &entry.request).await?;
            let content = &source.unprepared_content;
            let text = if content.text.trim().is_empty() {
                content
                    .quotes
                    .iter()
                    .flatten()
                    .find(|quote| !quote.text.trim().is_empty())
                    .map(|quote| quote.text.as_str())
                    .or_else(|| {
                        content
                            .attachments
                            .iter()
                            .flatten()
                            .next()
                            .map(|file| file.name.as_str())
                    })
                    .unwrap_or_default()
            } else {
                &content.text
            };
            entries.push(QueueEntry {
                origin: source.message.origin,
                message_id: entry.request.message_id,
                kind: match entry.placement {
                    durable_queue::Placement::Followup
                    | durable_queue::Placement::Completion { .. } => QueueKind::Followup,
                    durable_queue::Placement::Steering { .. } => QueueKind::Steering,
                    durable_queue::Placement::Held => QueueKind::Held,
                },
                preview: text
                    .chars()
                    .take(80)
                    .map(|c| if c.is_control() { ' ' } else { c })
                    .collect(),
            });
        }
        Ok(Queue {
            revision: queue.revision,
            entries,
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
        if let Some(entry) = queue
            .entries
            .iter()
            .find(|entry| entry.request.message_id == input.message_id)
        {
            let source = self
                .queued_source(&input.session_id, &entry.request)
                .await?;
            let content = source.unprepared_content;
            return Ok(QueueMessageResult::Ready {
                revision: queue.revision,
                has_attachments: content
                    .attachments
                    .as_ref()
                    .is_some_and(|files| !files.is_empty()),
                message: content.text,
                quotes: content.quotes.unwrap_or_default(),
            });
        }
        let resolution = self
            .durable
            .queue()
            .resolve_message(input.session_id, input.message_id)
            .await
            .map_err(|error| error.to_string())?;
        Ok(QueueMessageResult::Missing {
            reason: match resolution {
                durable_queue::MessageResolution::Delivered { .. } => {
                    QueueMessageMissingReason::Delivered
                }
                durable_queue::MessageResolution::Cancelled => QueueMessageMissingReason::Cancelled,
                durable_queue::MessageResolution::Missing
                | durable_queue::MessageResolution::Pending => QueueMessageMissingReason::Unknown,
            },
        })
    }

    pub async fn edit_queue(
        self: &Arc<Self>,
        input: QueueMutation,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<QueueMutationResult>, String> {
        let admission = self.runs.session(&input.session_id).await;
        let runs = admission.state().await;
        let rejected = |reason| {
            Ok(NativeMutation::Returned(QueueMutationResult::Rejected {
                reason,
            }))
        };
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
            return Ok(NativeMutation::Returned(
                QueueMutationResult::RevisionConflict {
                    expected: input.expected_revision,
                    actual: queue.revision,
                },
            ));
        }
        let message_ids = match &input.edit {
            QueueAction::Retract { message_id }
            | QueueAction::Promote { message_id }
            | QueueAction::Update { message_id, .. } => vec![message_id],
            QueueAction::Reorder { message_ids } => message_ids.iter().collect(),
        };
        let mut targets = Vec::with_capacity(message_ids.len());
        for id in message_ids {
            let Some(entry) = queue
                .entries
                .iter()
                .find(|entry| &entry.request.message_id == id)
            else {
                return rejected(QueueRejection::Missing);
            };
            let source = self
                .queued_source(&input.session_id, &entry.request)
                .await?;
            match &parent.identity {
                maka_capabilities::call::Identity::Remote { .. } => {}
                maka_capabilities::call::Identity::Agent { execution, .. } => {
                    if !matches!(&source.message.origin, Some(MessageOrigin::Session { execution: author }) if author.session_id == execution.session_id)
                    {
                        return rejected(QueueRejection::NotYourMessage);
                    }
                }
                _ => return rejected(QueueRejection::NotYourMessage),
            }
            if matches!(
                &input.edit,
                QueueAction::Update { .. } | QueueAction::Promote { .. }
            ) && (!matches!(&entry.request.spec.trigger, Trigger::Message { .. })
                || entry.request.spec.budget_basis.is_some()
                || matches!(&source.message.origin, Some(MessageOrigin::Goal { .. })))
            {
                return rejected(QueueRejection::InvalidEdit);
            }
            targets.push((entry, source));
        }
        let mut contents = Vec::new();
        let mut followup = None;
        let edit = match input.edit {
            QueueAction::Retract { .. } => durable_queue::QueueEdit::Retract {
                request: targets[0].0.request.id.clone(),
            },
            QueueAction::Reorder { .. } => durable_queue::QueueEdit::Reorder {
                requests: targets
                    .iter()
                    .map(|(entry, _)| entry.request.id.clone())
                    .collect(),
            },
            QueueAction::Promote { .. } => {
                let Some(view) = self.latest_session_run(&input.session_id).await? else {
                    return rejected(QueueRejection::NotRunning);
                };
                if view.blocks_followup()
                    || promotion.as_ref().is_some_and(|control| control.compacting)
                    || !same_execution(&targets[0].0.request.spec, &view.spec)
                {
                    return rejected(QueueRejection::ExecutionChanged);
                }
                if let Some(revision) = self
                    .durable
                    .queue()
                    .pending_steer_revision(
                        input.session_id.clone(),
                        targets[0].0.request.id.clone(),
                        view.run,
                    )
                    .await
                    .map_err(|error| error.to_string())?
                {
                    return Ok(NativeMutation::Returned(
                        if revision == input.expected_revision {
                            QueueMutationResult::Committed { revision }
                        } else {
                            QueueMutationResult::RevisionConflict {
                                expected: input.expected_revision,
                                actual: revision,
                            }
                        },
                    ));
                }
                let handoff = self
                    .durable
                    .queue()
                    .interrupt_handoff(&view)
                    .await
                    .map_err(|error| error.to_string())?;
                if let Some(handoff) = handoff {
                    followup = Some(durable_queue::Followup::Resume(handoff));
                } else {
                    let Some(control) = promotion else {
                        return rejected(QueueRejection::NotRunning);
                    };
                    if control.execution.run_id != view.run
                        || view.stopped
                        || view.terminal.is_some()
                    {
                        return rejected(QueueRejection::ExecutionChanged);
                    }
                    match self.active_delivery(&view).await? {
                        ActiveDelivery::InterruptResume => {
                            followup = Some(durable_queue::Followup::Interrupt {
                                run: view.run,
                                stop: self.control_id(operation, "edit_queue:steering_interrupt"),
                            });
                        }
                        ActiveDelivery::Queue => return rejected(QueueRejection::ExecutionChanged),
                        ActiveDelivery::Steer => {}
                    }
                }
                durable_queue::QueueEdit::Promote {
                    request: targets[0].0.request.id.clone(),
                    target: durable_queue::SteeringTarget {
                        run: view.run,
                        expected_head: Head::from(&view),
                    },
                }
            }
            QueueAction::Update { message, .. } => {
                let (entry, source) = targets.pop().expect("targeted update");
                let mut source = source;
                source.unprepared_content.text = message;
                if !source.unprepared_content.has_content() {
                    return rejected(QueueRejection::InvalidEdit);
                }
                let bytes = self
                    .durable
                    .queue()
                    .content(
                        input.session_id.clone(),
                        entry.request.id.clone(),
                        entry.request.spec.tool_selection.clone(),
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                let selection: crate::tools::SelectionSnapshot =
                    serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
                let tools = selection
                    .definitions
                    .into_iter()
                    .map(|definition| definition.name)
                    .collect();
                let workspace = self
                    .session(&input.session_id)
                    .await?
                    .configuration
                    .workspace;
                if workspace.path != entry.request.spec.workspace {
                    return rejected(QueueRejection::ExecutionChanged);
                }
                let (message, required_tools) = match self
                    .prepare_skills(
                        source.unprepared_content.clone(),
                        entry.request.spec.language,
                        Some(workspace),
                        parent,
                        tools,
                    )
                    .await?
                {
                    skills::Input::Ready {
                        message,
                        required_tools,
                    } => (message, required_tools),
                    skills::Input::Rejected { .. } => return rejected(QueueRejection::InvalidEdit),
                };
                source.message.content = message;
                let source_blob = ContentBlob::json(&source).map_err(|error| error.to_string())?;
                let input_bytes = self
                    .durable
                    .queue()
                    .content(
                        input.session_id.clone(),
                        entry.request.id.clone(),
                        entry.request.spec.input.clone(),
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                let mut run_input: maka_agent_facts::input::RunInput =
                    serde_json::from_slice(&input_bytes).map_err(|error| error.to_string())?;
                let maka_agent_facts::input::RunInput::Message {
                    content,
                    source_messages,
                    ..
                } = &mut run_input
                else {
                    return Err("agent_queue_input_invalid".into());
                };
                *content = source.message.content.clone();
                *source_messages = vec![source.clone()];
                let input_blob =
                    ContentBlob::json(&run_input).map_err(|error| error.to_string())?;
                let mut request = entry.request.clone();
                request.source = source_blob.reference().clone();
                request.spec.input = input_blob.reference().clone();
                request.required_tools = required_tools;
                contents.extend([source_blob, input_blob]);
                durable_queue::QueueEdit::Update {
                    request: Box::new(request),
                }
            }
        };
        let command = durable_queue::QueueCommand {
            id: self.control_id(operation, "edit_queue"),
            at: UnixMillis(now().try_into().expect("Unix milliseconds")),
            expected_revision: input.expected_revision,
            edit,
        };
        let queue = self.durable.queue();
        let change = match followup {
            Some(fence) => self.message_writer(parent)?.prepare(PreparedAgentSend {
                queue: durable_queue::PreparedEnqueue {
                    session: input.session_id,
                    command,
                    contents,
                    followup: Some(fence),
                    work_fence: None,
                },
                completion: None,
                order: Some(Arc::new(admission.into_ordered())),
            }),
            None => queue.prepare(input.session_id, command, contents),
        };
        Ok(NativeMutation::Commit {
            value: QueueMutationResult::Committed {
                revision: input
                    .expected_revision
                    .checked_add(1)
                    .ok_or("agent_queue_revision_exhausted")?,
            },
            change,
        })
    }
}
