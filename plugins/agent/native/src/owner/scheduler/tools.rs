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
use crate::tools::ToolRequest;
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_facts::tools::*;
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "mode",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Input {
    Create {
        title: String,
        intent_body: String,
        schedule: TaskSchedule,
        timezone: String,
        #[serde(default)]
        misfire: TaskMisfire,
        effect: Target,
        max_fires: Option<u32>,
        expires_at: Option<i64>,
    },
    List {
        after: Option<String>,
    },
    Pause {
        task_id: String,
        revision: u64,
    },
    Resume {
        task_id: String,
        revision: u64,
    },
    Delete {
        task_id: String,
        revision: u64,
    },
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Target {
    Reminder,
    Session,
    AgentRun,
}
impl Scheduler {
    pub fn tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        vec![ToolRegistration {
            definition: ToolDefinition { provider: None, name: "ScheduledTask".into(),
                description: "Manage this conversation's scheduled tasks. Create saves a paused proposal requiring user approval of its exact execution in Scheduled tasks; model calls cannot grant background access. Session and agent_run use this conversation's workspace and model. Times are Unix milliseconds; timezone is an IANA name. List returns tasks and revisions. Resume requires existing user approval.".into(),
                input_schema: serde_json::to_value(schemars::schema_for!(ToolRequest<Input>)).expect("task tool schema"),
                output_schema: None, freeform: None },
            nesting: ToolNesting::DirectOnly, semantics: ToolSemantics::ExclusiveStep,
            handler: ToolHandler::Prepared(self.clone()),
        }]
    }
}
impl ToolPreparer for Scheduler {
    fn names(&self) -> Vec<String> {
        vec!["ScheduledTask".into()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let owner = self.link.get().and_then(Weak::upgrade);
        Box::pin(async move {
            if name != "ScheduledTask" || owner.is_none() {
                return Err(ToolRejection::Unavailable);
            }
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            let input = serde_json::from_value::<ToolRequest<Input>>(input)
                .map_err(|error| ToolRejection::InvalidInput {
                    message: error.to_string(),
                })?
                .request;
            let owner = owner.expect("checked owner");
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    if cancellation.is_cancelled() {
                        return Err(failed("Scheduled task cancelled"));
                    }
                    let runs = owner.runs.lock().await;
                    if runs.closing || !owner.settings.scheduled_tasks {
                        return Err(failed("Scheduled tasks unavailable"));
                    }
                    let captured = owner.clone();
                    let job = owner
                        .workers
                        .spawn(async move { captured.scheduled_tool(input, context).await });
                    drop(runs);
                    let value = job.await.map_err(failed)?.map_err(failed)?;
                    Ok(value.into())
                })
            }))
        })
    }
}
impl Owner {
    async fn scheduled_tool(
        &self,
        input: Input,
        context: ToolCallContext,
    ) -> Result<Value, String> {
        let _gate = self.scheduler.gate.lock().await;
        self.tool_store(&context)?
            .get::<StoredSessionConfiguration>()
            .await
            .map_err(|error| error.to_string())?
            .ok_or("agent_session_unavailable")?;
        let boundary = self
            .tool_store(&context)?
            .invocation_boundary(
                &context.invocation.session_id,
                &context.invocation.invocation_id,
            )
            .await
            .map_err(reason)?
            .ok_or("scheduler_invocation_unavailable")?
            .0;
        if boundary.invocation != context.invocation
            || matches!(
                boundary.state,
                maka_event_log::turns::InvocationState::Ended { .. }
            )
        {
            return Err("scheduler_invocation_closed".into());
        }
        let identity = hex::encode(Sha256::digest(
            serde_json::to_vec(&(&context.invocation, &context.operation_id)).map_err(reason)?,
        ));
        let key = format!("tool:{identity}");
        let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&input).map_err(reason)?));
        if let Some(record) = self
            .scheduler
            .storage
            .read(key.clone())
            .await
            .map_err(reason)?
        {
            let receipt = record.data.value().ok_or("scheduler_receipt_invalid")?;
            if receipt["fingerprint"] != fingerprint {
                return Err("scheduler_receipt_conflict".into());
            }
            return Ok(receipt["result"].clone());
        }
        let mut catalog = self.scheduler.load().await?;
        if let Input::List { after } = &input {
            let mut tasks = catalog.plans.values().filter(|saved| after.as_ref().is_none_or(|after| saved.plan.task.id > *after) && matches!(&saved.plan.task.created_by, Creator::Agent { session_id } if session_id == &context.invocation.session_id))
                .take(21).map(Saved::summary).collect::<Vec<_>>();
            let more = tasks.len() > 20;
            tasks.truncate(20);
            let next = more.then(|| tasks.last().expect("nonempty task page").id.clone());
            return Ok(serde_json::json!({ "tasks": tasks, "nextCursor": next }));
        }
        let (id, plan) = match input {
            Input::Create {
                title,
                intent_body,
                schedule,
                timezone,
                misfire,
                effect,
                max_fires,
                expires_at,
            } => {
                let effect = if matches!(effect, Target::Reminder) {
                    ScheduledEffect::Reminder
                } else {
                    let runs = self.runs.lock().await;
                    let control = runs
                        .controls
                        .get(&context.invocation.session_id)
                        .filter(|control| control.invocation == context.invocation)
                        .ok_or("scheduler_invocation_closed")?;
                    let accepted = control
                        .basis
                        .model
                        .as_ref()
                        .ok_or("scheduler_model_unavailable")?;
                    let catalog = self.configuration.catalog().await.map_err(reason)?;
                    let connection = catalog
                        .connections
                        .iter()
                        .find(|row| row.connection_id == accepted.binding.connection_id)
                        .ok_or("scheduler_model_unavailable")?;
                    let model = ModelSelection {
                        connection_id: connection.connection_id.clone(),
                        revision: connection.revision,
                        model_id: accepted.binding.model.clone(),
                    };
                    let session = self
                        .tool_store(&context)?
                        .get::<StoredSessionConfiguration>()
                        .await
                        .map_err(|error| error.to_string())?
                        .ok_or("agent_session_unavailable")?;
                    let session = resolve_session(session)?;
                    let target = ScheduledTarget {
                        session_id: session.id,
                        workspace: session.configuration.workspace,
                        permissions: session.configuration.permissions,
                        boundary_revision: session.configuration.boundary_revision,
                        binding: session.configuration.binding,
                    };
                    let thinking_level = accepted.thinking_level;
                    if matches!(effect, Target::Session) {
                        ScheduledEffect::Session {
                            target,
                            model,
                            thinking_level,
                        }
                    } else {
                        ScheduledEffect::AgentRun {
                            target,
                            model,
                            thinking_level,
                        }
                    }
                };
                let id = format!("task-{identity}");
                let mut plan = Plan::create(
                    id.clone(),
                    maka_scheduler::task::Create {
                        title,
                        intent_body,
                        schedule,
                        effect,
                        max_fires,
                        expires_at,
                    },
                    Creator::Agent {
                        session_id: context.invocation.session_id,
                    },
                    timezone,
                    now() as i64,
                )
                .map_err(reason)?;
                plan.misfire = misfire;
                plan = plan.pause(now() as i64);
                (id, Some(plan))
            }
            Input::Pause {
                ref task_id,
                revision,
            }
            | Input::Resume {
                ref task_id,
                revision,
            }
            | Input::Delete {
                ref task_id,
                revision,
            } => {
                let saved = catalog.plans.get(task_id).ok_or("scheduler_task_missing")?;
                if saved.revision != revision {
                    return Err("scheduler_revision_changed".into());
                }
                if !matches!(&saved.plan.task.created_by, Creator::Agent { session_id } if session_id == &context.invocation.session_id)
                {
                    return Err("scheduler_task_outside_conversation".into());
                }
                let plan = match input {
                    Input::Pause { .. } => Some(saved.plan.pause(now() as i64)),
                    Input::Resume { .. } => {
                        let Some(approval) = &saved.plan.authorization else {
                            return Err("scheduler_user_approval_required".into());
                        };
                        if let Approval::Execution { basis } = approval {
                            self.validate_background(basis).await?;
                        }
                        Some(saved.plan.resume(now() as i64).map_err(reason)?)
                    }
                    _ => {
                        if saved.plan.pending.is_some() {
                            return Err("scheduler_trigger_pending".into());
                        }
                        None
                    }
                };
                (task_id.clone(), plan)
            }
            Input::List { .. } => unreachable!(),
        };
        let revision = catalog.plans.get(&id).map_or(1, |saved| saved.revision + 1);
        let result = serde_json::json!({ "taskId": id, "revision": revision, "approved": plan.as_ref().is_some_and(|p| p.authorization.is_some()) });
        let receipt = Mutation {
            key,
            expected_revision: None,
            data: Data::Present(
                serde_json::json!({ "fingerprint": fingerprint, "result": result }),
            ),
        };
        self.scheduler
            .commit(&mut catalog, &id, plan, Some(receipt))
            .await?;
        self.scheduler.wake.notify_one();
        Ok(result)
    }
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
