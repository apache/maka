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
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_facts::tools::*;
use maka_agent_facts::{
    durable::{ContentRef, RunId},
    input::RunInput,
};
use maka_tool_catalog::input::ToolRequest;
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
    Discovery,
}
impl Scheduler {
    pub fn tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        let mut tools = vec![ToolRegistration {
            definition: ToolDefinition { provider: None, name: "ScheduledTask".into(),
                description: "Manage this conversation's scheduled tasks. Create normally saves a paused proposal requiring user approval. While handling an approved discovery's report, the Bot can schedule a one-time discovery follow-up under that plan's unchanged approval. Check approved in the result. If a discovery follow-up needs approval, ask the user to approve it in Proactive Discovery. Keep successful background scheduling confirmations internal and share material findings separately. Session and agent_run use this conversation's workspace and model. Discovery runs a fresh investigation using approved Session permissions, silent unless it reports a finding. Times are Unix milliseconds; timezone is an IANA name. List returns tasks and revisions. Resume requires existing user approval.".into(),
                input_schema: serde_json::to_value(schemars::schema_for!(ToolRequest<Input>)).expect("task tool schema"),
                output_schema: None, freeform: None },
            nesting: ToolNesting::Nestable, semantics: ToolSemantics::ExclusiveStep,
            handler: ToolHandler::Prepared(self.clone()),
        }];
        tools.push(self.discovery_tool());
        tools.push(self.discovery_memory_tool());
        tools.push(self.discovery_context_tool());
        tools
    }
}
impl ToolPreparer for Scheduler {
    fn names(&self) -> Vec<String> {
        vec![
            "ScheduledTask".into(),
            super::super::discovery::COMPLETE.into(),
            super::super::discovery::MEMORY.into(),
            super::super::discovery::CONTEXT.into(),
        ]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let owner = self.link.get().and_then(Weak::upgrade);
        if name == super::super::discovery::COMPLETE {
            return self.prepare_discovery(input, context, cancellation);
        }
        if name == super::super::discovery::MEMORY {
            return self.prepare_discovery_memory(input, context, cancellation);
        }
        if name == super::super::discovery::CONTEXT {
            return self.prepare_discovery_context(input, context, cancellation);
        }
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
            use maka_agent_facts::display::Text;
            let title = match &input {
                Input::Create { title, .. } => {
                    let (en, zh, tw) = ("Propose a scheduled task", "提议定时任务", "提議排程任務");
                    if let Some(title) = Text::single_line(title) {
                        let title = title.fallback;
                        Text::localized(
                            &format!("{en} · {title}"),
                            &format!("{zh} · {title}"),
                            &format!("{tw} · {title}"),
                        )
                    } else {
                        Text::localized(en, zh, tw)
                    }
                }
                Input::List { .. } => {
                    Text::localized("List scheduled tasks", "列出定时任务", "列出排程任務")
                }
                Input::Pause { .. } => {
                    Text::localized("Pause scheduled task", "暂停定时任务", "暫停排程任務")
                }
                Input::Resume { .. } => {
                    Text::localized("Resume scheduled task", "恢复定时任务", "恢復排程任務")
                }
                Input::Delete { .. } => {
                    Text::localized("Delete scheduled task", "删除定时任务", "刪除排程任務")
                }
            };
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    if cancellation.is_cancelled() {
                        return Err(failed("Scheduled task cancelled"));
                    }
                    let runs = owner.runs.state().await;
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
            })
            .titled(title)
            .presented("maka.agent.Builtin@1/ScheduledTask".into()))
        })
    }
}
impl Owner {
    async fn followup_approval(
        &self,
        catalog: &repository::Catalog,
        plan: &Plan,
        run: RunId,
        input: &ContentRef,
        at: i64,
    ) -> Result<Option<Approval>, String> {
        let (ScheduledEffect::Discovery { .. }, TaskSchedule::Once { run_at }) =
            (&plan.task.effect, &plan.task.schedule)
        else {
            return Ok(None);
        };
        let RunInput::Message {
            source_messages, ..
        } = self.run_content(run, input).await.map_err(reason)?
        else {
            return Ok(None);
        };
        let [source] = source_messages.as_slice() else {
            return Ok(None);
        };
        let Some(MessageOrigin::BotWorker { session_id }) = &source.message.origin else {
            return Ok(None);
        };
        for saved in catalog.plans.values() {
            let parent = &saved.plan;
            let Some(Approval::Discovery {
                approval,
                recall,
                session_tools,
                authority: DiscoveryAuthority::User { generation },
            }) = &parent.authorization
            else {
                continue;
            };
            if parent.task.effect != plan.task.effect
                || parent.task.status != Status::Active
                || parent
                    .task
                    .expires_at
                    .is_some_and(|expiry| at.max(*run_at) >= expiry)
                || (*recall && !self.settings.recall)
            {
                continue;
            }
            let Some(fire) = parent.task.runs.iter().find(|fire| {
                fire.outcome == Outcome::Ok
                    && fire.session_id.as_ref() == Some(session_id)
                    && source.message.message_id
                        == format!("m_{}", super::super::discovery::report_identity(&fire.id))
            }) else {
                continue;
            };
            if self.scheduler.completed_report_generation(&fire.id).await? == Some(*generation) {
                return Ok(Some(Approval::Discovery {
                    approval: approval.clone(),
                    recall: *recall,
                    session_tools: *session_tools,
                    authority: DiscoveryAuthority::Followup {
                        grant: FollowupGrant {
                            task_id: parent.task.id.clone(),
                            generation: *generation,
                        },
                    },
                }));
            }
        }
        Ok(None)
    }

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
        let view = self
            .durable
            .frontier(context.execution.run_id)
            .await
            .map_err(reason)?;
        if view.spec.session_id != context.execution.session_id
            || view.spec.turn_id != context.execution.turn_id
            || view.stopped
            || view.terminal.is_some()
        {
            return Err("scheduler_invocation_closed".into());
        }
        let identity = hex::encode(Sha256::digest(
            serde_json::to_vec(&(&context.execution, &context.operation_id)).map_err(reason)?,
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
            let mut tasks = catalog.plans.values().filter(|saved| after.as_ref().is_none_or(|after| saved.plan.task.id > *after) && matches!(&saved.plan.task.created_by, Creator::Agent { session_id } if session_id == &context.execution.session_id))
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
                    let runs = self.runs.state().await;
                    let control = runs
                        .controls
                        .get(&context.execution.session_id)
                        .filter(|control| control.execution == context.execution)
                        .ok_or("scheduler_invocation_closed")?;
                    let accepted = control
                        .basis
                        .model
                        .as_ref()
                        .ok_or("scheduler_model_unavailable")?;
                    let model = ModelSelection {
                        connection_id: accepted.binding.connection_id.clone(),
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
                    if matches!(effect, Target::Discovery) {
                        if !self.settings.bot || !self.bot.is(&context.execution.session_id) {
                            return Err("discovery_requires_bot".into());
                        }
                        ScheduledEffect::Discovery {
                            target,
                            model,
                            thinking_level,
                        }
                    } else if matches!(effect, Target::Session) {
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
                let at = now() as i64;
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
                        session_id: context.execution.session_id,
                    },
                    timezone,
                    at,
                )
                .map_err(reason)?;
                plan.misfire = misfire;
                plan.authorization = self
                    .followup_approval(&catalog, &plan, view.run, &view.spec.input, at)
                    .await?;
                if plan.authorization.is_none() {
                    plan = plan.pause(at);
                }
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
                if !matches!(&saved.plan.task.created_by, Creator::Agent { session_id } if session_id == &context.execution.session_id)
                {
                    return Err("scheduler_task_outside_conversation".into());
                }
                let plan = match input {
                    Input::Pause { .. } => Some(pause_plan(&saved.plan, now() as i64)),
                    Input::Resume { .. } => {
                        let Some(approval) = &saved.plan.authorization else {
                            return Err("scheduler_user_approval_required".into());
                        };
                        if let Some(grant) = approval.followup_grant()
                            && !self.scheduler.followup_is_current(grant).await?
                        {
                            return Err("scheduler_user_approval_required".into());
                        }
                        if let Approval::Execution { approval }
                        | Approval::Discovery { approval, .. } = approval
                        {
                            let basis = self
                                .approve_background(
                                    &approval.target,
                                    approval.model.clone(),
                                    approval.thinking_level,
                                    BackgroundKind::Schedule {
                                        task_id: saved.plan.task.id.clone(),
                                    },
                                )
                                .await?;
                            self.validate_background(&basis).await?;
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
