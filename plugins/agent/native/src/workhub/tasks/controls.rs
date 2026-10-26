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
use contract::{Control, ControlOutcome, ControlStatus};

#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Action {
    SnapshotPatch,
    Stop,
    Resume {
        model: crate::ModelSelection,
        thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    task_id: String,
    source: Invocation,
    tool_operation: String,
    selection: Selection,
}
/// Immutable command selection. Neither recovery nor a queue race may select a
/// newer invocation or silently replace an unsuccessful retraction with stop.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Selection {
    SnapshotPatch {
        session: String,
        invocation: String,
    },
    Stop {
        session: String,
        invocation: String,
    },
    Resume {
        session: String,
        invocation: String,
        high_water: u64,
        model: crate::ModelSelection,
        thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    },
    Retract {
        session: String,
        message: String,
        revision: u64,
    },
}
impl Selection {
    fn call(&self) -> (&'static str, Value) {
        match self {
            Self::SnapshotPatch {
                session,
                invocation,
            } => (
                "snapshotPatch",
                serde_json::json!({"sessionId":session,"invocationId":invocation}),
            ),
            Self::Stop {
                session,
                invocation,
            } => (
                "stop",
                serde_json::json!({"sessionId":session,"invocationId":invocation}),
            ),
            Self::Resume {
                session,
                invocation,
                high_water,
                model,
                thinking_level,
            } => (
                "resume",
                serde_json::json!({"sessionId":session,"sourceInvocationId":invocation,"sourceHighWater":high_water,"model":model,"thinkingLevel":thinking_level}),
            ),
            Self::Retract {
                session,
                message,
                revision,
            } => (
                "editQueue",
                serde_json::json!({"sessionId":session,"expectedRevision":revision,"edit":{"kind":"retract","messageId":message}}),
            ),
        }
    }
    fn outcome(&self, value: Value) -> Result<ControlOutcome, String> {
        let invalid = |_| "workhub_control_result_invalid".to_owned();
        Ok(match self {
            Self::SnapshotPatch { .. } => ControlOutcome::Patch {
                result: serde_json::from_value(value).map_err(invalid)?,
            },
            Self::Stop { .. } => ControlOutcome::Stop {
                result: serde_json::from_value(value).map_err(invalid)?,
            },
            Self::Resume { .. } => ControlOutcome::Resume {
                result: serde_json::from_value(value).map_err(invalid)?,
            },
            Self::Retract { .. } => ControlOutcome::Retract {
                result: serde_json::from_value(value).map_err(invalid)?,
            },
        })
    }
}

impl Hub {
    pub(super) async fn read_control_patch(
        &self,
        id: &str,
        offset: u64,
        execution: Option<Arc<dyn maka_agent_facts::tools::ExecutionCustody>>,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        let intent = self.control_intent(id).await?;
        let Selection::SnapshotPatch {
            session,
            invocation,
        } = intent.selection
        else {
            return Err("workhub_control_has_no_patch".into());
        };
        let assignment = self.assignment(&intent.task_id).await?;
        if !self
            .tasks
            .workers
            .get(&assignment.worker)
            .and_then(Option::as_ref)
            .is_some_and(|binding| binding.execution_basis() == assignment.binding)
        {
            return Err("workhub_original_worker_unavailable".into());
        }
        let identity = Identity::Agent {
            invocation: intent.source,
            operation_id: Some(intent.tool_operation),
        };
        let request = match execution {
            Some(execution) => {
                self.tasks
                    .services
                    .request_with_execution(identity, cancellation, execution)
            }
            None => self.tasks.services.request(identity, cancellation),
        }?;
        self.observe_request(&request, async {
            let value = request.call(&assignment.worker, 0, "readPatch".into(), serde_json::json!({"execution":{"sessionId":session,"invocationId":invocation},"offset":offset}), Attachments::default())?.await?;
            let page: crate::contract::PatchPage = serde_json::from_value(value).map_err(|_| "workhub_patch_invalid")?;
            serde_json::to_value(page).map_err(|_| "workhub_encoding_failed".into())
        }).await
    }
    fn control_key(&self, id: &str) -> Result<String, String> {
        let suffix = id.strip_prefix("wc_").ok_or("workhub_control_invalid")?;
        // Reuse the exact bounded digest validation used for task identities.
        self.task_key(&format!("wt_{suffix}"))?;
        Ok(format!("{}controls/{id}", self.agent.0.prefix))
    }
    async fn control_intent(&self, id: &str) -> Result<Intent, String> {
        let record = self
            .agent
            .0
            .store
            .plugin_data(&namespace(), &self.control_key(id)?)
            .await
            .map_err(|_| "workhub_store_unavailable")?
            .ok_or("workhub_control_missing")?;
        let Data::Present(value) = record.data else {
            return Err("workhub_control_removed".into());
        };
        let intent: Intent =
            serde_json::from_value(value).map_err(|_| "workhub_control_invalid")?;
        if !self.agent.0.owns(&intent.source.session_id)
            || control_id(&intent.source, &intent.tool_operation) != id
        {
            return Err("workhub_control_invalid".into());
        }
        Ok(intent)
    }
    pub(super) async fn require_control_session(
        &self,
        id: &str,
        session: &str,
    ) -> Result<(), String> {
        let intent = self.control_intent(id).await?;
        if self.assignment(&intent.task_id).await?.source.session_id != session {
            return Err("workhub_control_source_invalid".into());
        }
        Ok(())
    }
    pub(in crate::workhub) async fn controls(
        &self,
        after: Option<String>,
    ) -> Result<Value, String> {
        self.controls_scope(after, None).await
    }
    pub(super) async fn controls_scope(
        &self,
        after: Option<String>,
        session: Option<&str>,
    ) -> Result<Value, String> {
        let prefix = format!("{}controls/", self.agent.0.prefix);
        let page = self
            .agent
            .0
            .store
            .plugin_data_scan(
                &namespace(),
                maka_capabilities::storage::Scan {
                    prefix: prefix.clone(),
                    after: after
                        .as_deref()
                        .map(|id| self.control_key(id))
                        .transpose()?,
                },
            )
            .await
            .map_err(|_| "workhub_store_unavailable")?;
        let more = page.entries.len() > 16 || page.next_after.is_some();
        let mut entries = Vec::new();
        let mut last = None;
        for entry in page.entries.into_iter().take(16) {
            let id = entry
                .key
                .strip_prefix(&prefix)
                .ok_or("workhub_control_invalid")?
                .to_owned();
            self.control_key(&id)?;
            last = Some(id.clone());
            if let Data::Present(value) = entry.record.data {
                let intent: Intent =
                    serde_json::from_value(value).map_err(|_| "workhub_control_invalid")?;
                if session.is_some_and(|id| intent.source.session_id != id) {
                    continue;
                }
                entries.push(serde_json::json!({"taskId":intent.task_id,"controlId":id}));
            }
        }
        Ok(serde_json::json!({"entries":entries,"after":if more {last} else {None}}))
    }
    pub(super) async fn control_start(
        &self,
        task: &str,
        action: Action,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        let id = control_id(&context.invocation, &context.operation_id);
        let key = self.control_key(&id)?;
        if self
            .agent
            .0
            .store
            .plugin_data(&namespace(), &key)
            .await
            .map_err(|_| "workhub_store_unavailable")?
            .is_none()
        {
            let assignment = self.assignment(task).await?;
            let value = self
                .task_with_execution(
                    task,
                    false,
                    None,
                    context.execution.clone(),
                    cancellation.clone(),
                )
                .await?;
            let observed: Task =
                serde_json::from_value(value).map_err(|_| "workhub_task_invalid")?;
            let (progress, message) = match observed.status {
                TaskStatus::Started { progress, .. } => (progress, None),
                TaskStatus::Queued {
                    progress,
                    message_id,
                    ..
                } => (progress, Some(message_id)),
                _ => return Ok(rejected("work_unavailable")),
            };
            let session = self
                .delivery(task, &assignment)
                .await?
                .ok_or("workhub_delivery_missing")?
                .session_id;
            let selection = match progress {
                Some(crate::contract::Work::Delivered { shared: true, .. }) => {
                    return Ok(rejected("shared_work"));
                }
                Some(crate::contract::Work::Delivered { execution, .. }) => {
                    // Read-only work evidence supplies selection, never new permission.
                    if execution.session_id != session {
                        return Err("workhub_delivery_invalid".into());
                    }
                    match action {
                        Action::SnapshotPatch => Selection::SnapshotPatch {
                            session,
                            invocation: execution.invocation_id,
                        },
                        Action::Stop => Selection::Stop {
                            session,
                            invocation: execution.invocation_id,
                        },
                        Action::Resume {
                            model,
                            thinking_level,
                        } => Selection::Resume {
                            session,
                            invocation: execution.invocation_id,
                            high_water: execution.high_water,
                            model,
                            thinking_level,
                        },
                    }
                }
                Some(crate::contract::Work::Pending) if matches!(action, Action::Stop) => {
                    let message = message.ok_or("workhub_delivery_invalid")?;
                    let identity = Identity::Agent {
                        invocation: context.invocation.clone(),
                        operation_id: Some(context.operation_id.clone()),
                    };
                    let request = match &context.execution {
                        Some(execution) => self.tasks.services.request_with_execution(
                            identity,
                            cancellation.clone(),
                            execution.clone(),
                        ),
                        None => self.tasks.services.request(identity, cancellation.clone()),
                    }?;
                    let queue = self
                        .observe_request(&request, async {
                            request
                                .call(
                                    &assignment.worker,
                                    0,
                                    "queue".into(),
                                    serde_json::json!({"sessionId":session}),
                                    Attachments::default(),
                                )?
                                .await
                        })
                        .await?;
                    if !queue["entries"].as_array().is_some_and(|entries| {
                        entries.iter().any(|entry| entry["messageId"] == message)
                    }) {
                        return Ok(rejected("work_changed"));
                    }
                    Selection::Retract {
                        session,
                        message,
                        revision: queue["revision"].as_u64().ok_or("workhub_queue_invalid")?,
                    }
                }
                _ => return Ok(rejected("work_unavailable")),
            };
            if cancellation.is_cancelled() {
                return Err("workhub_cancelled".into());
            }
            let intent = Intent {
                task_id: task.into(),
                source: context.invocation,
                tool_operation: context.operation_id,
                selection,
            };
            match self
                .agent
                .0
                .store
                .plugin_data_batch(
                    &namespace(),
                    vec![Mutation {
                        key,
                        expected_revision: None,
                        data: Data::Present(
                            serde_json::to_value(intent).map_err(|_| "workhub_encoding_failed")?,
                        ),
                    }],
                )
                .await
            {
                Ok(_) | Err(maka_event_log::StoreError::RevisionConflict { .. }) => {}
                Err(_) => return Err("workhub_control_commit_unknown".into()),
            }
        }
        self.control(&id, true, context.execution.clone(), cancellation)
            .await
    }
    pub(in crate::workhub) async fn control(
        &self,
        id: &str,
        advance: bool,
        execution: Option<Arc<dyn maka_agent_facts::tools::ExecutionCustody>>,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        if self.tasks.cleanup_failed() {
            return Err("workhub_closed".into());
        }
        let intent = self.control_intent(id).await?;
        let assignment = self.assignment(&intent.task_id).await?;
        let operation = child_id(id);
        let identity = Identity::Agent {
            invocation: intent.source,
            operation_id: Some(intent.tool_operation),
        };
        let request = match execution {
            Some(execution) => {
                self.tasks
                    .services
                    .request_with_execution(identity, cancellation, execution)
            }
            None => self.tasks.services.request(identity, cancellation),
        }?;
        let (method, input) = intent.selection.call();
        self.observe_request(&request, async {
            let status = match self
                .dispatch(
                    &request,
                    Call {
                        worker: &assignment.worker,
                        binding: &assignment.binding,
                        operation,
                        method,
                        input: &input,
                        attachment: None,
                    },
                    advance,
                )
                .await?
            {
                DispatchObservation::Pending => ControlStatus::Pending,
                DispatchObservation::Unavailable => ControlStatus::Unavailable,
                DispatchObservation::Reply(reply) => match reply.receipt {
                    Receipt::Recorded {
                        outcome: OperationOutcome::Returned { value },
                        cleanup: OperationCleanup::Confirmed,
                    } => ControlStatus::Returned {
                        outcome: intent.selection.outcome(value)?,
                    },
                    _ => ControlStatus::Uncertain,
                },
            };
            serde_json::to_value(Control {
                task_id: intent.task_id,
                control_id: id.into(),
                operation,
                status,
            })
            .map_err(|_| "workhub_encoding_failed".into())
        })
        .await
    }
}
fn control_id(source: &Invocation, operation: &str) -> String {
    format!("wc_{}", &task_id(source, operation)[3..])
}
fn rejected(reason: &str) -> Value {
    serde_json::json!({"kind":"rejected","reason":reason})
}
