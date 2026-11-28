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
        #[serde(default)]
        effect: Target,
        #[serde(default)]
        delivery: AutomationDelivery,
        /// Optional tool profile for a discovery proposal.
        worker_tools: Option<DiscoveryWorkerTools>,
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
    TestScript {
        source: String,
        /// Previous script state as JSON (at most 64 KiB compact). Omit or pass null to start without state.
        state: Option<Value>,
    },
}
#[derive(Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Target {
    #[default]
    Session,
    AgentRun,
    Discovery,
}
impl Scheduler {
    pub fn tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        let mut tools = vec![ToolRegistration {
            definition: ToolDefinition { provider: None, name: "ScheduledTask".into(),
                description: concat!(
                    "Manage this conversation's automations. Creation activates the rule immediately. When it triggers, intentBody is sent to the agent as the message body. ",
                    "For a model connection, the default is steering. Choose followup to wait for the next turn, or agent_run for a new conversation. To wake this conversation later, create an automation with the message you want to receive, then end the current turn. For external agents, the trigger starts a new turn in the same conversation. ",
                    "Use a time schedule or a sandboxed Deno script. Scripts run JavaScript or TypeScript in the conversation workspace, support npm:, jsr:, and node: imports, and default to 60-second checks. ",
                    "Print true, false, or JSON.stringify({trigger, dedupeKey, summary, data, state}) on the last non-empty stdout line. Only the boolean trigger is required in an object. Boolean checks fire on the first true and rearm on false. A true keyed check fires when its key differs from the last fired key, even across false checks. Summary and data accompany the message. ",
                    "Read previous JSON state from MAKA_AUTOMATION_STATE. Omit state to keep it or return null to clear it. Preview with mode test_script, source and optional state (executes once without saving a task). ",
                    "A new discovery plan waits for user approval. While handling an approved discovery's report, the Bot can schedule a one-time follow-up using the same tool profile and authority. Set workerTools when requesting a specific profile. Check approved in the result. If false, ask the user to approve the plan in Proactive Discovery. Keep successful background scheduling confirmations internal and share material findings separately. Only the user can resume a discovery plan they paused. ",
                    "Times are Unix milliseconds and timezone is an IANA name. List returns tasks and revisions.",
                ).into(),
                input_schema: serde_json::to_value(schemars::schema_for!(ToolRequest<Input>)).expect("task tool schema"),
                output_schema: None, freeform: None },
            nesting: ToolNesting::Nestable, semantics: ToolSemantics::ExclusiveStep,
            handler: ToolHandler::Prepared(self.clone()),
        }];
        tools.push(self.discovery_tool());
        tools.push(self.discovery_memory_tool());
        tools
    }
}
impl ToolPreparer for Scheduler {
    fn names(&self) -> Vec<String> {
        std::iter::once("ScheduledTask")
            .chain(super::super::discovery::VISIBLE_TOOLS.iter().copied())
            .map(str::to_owned)
            .collect()
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let owner = self.link.get().and_then(Weak::upgrade);
        if matches!(
            name.as_str(),
            super::super::discovery::UPSERT
                | super::super::discovery::FINISH
                | super::super::discovery::LIST
                | super::super::discovery::READ
                | super::super::discovery::REGISTER
                | super::super::discovery::PENDING
                | super::super::discovery::STAGE
                | super::super::discovery::WATCH_SCOPE
                | super::super::discovery::WORKSPACE_MAP
                | super::super::discovery::PREFERENCES
        ) {
            return self.prepare_dossier_tool(name, input, context, cancellation);
        }
        if name == super::super::discovery::COMPLETE {
            return self.prepare_discovery(input, context, cancellation);
        }
        if name == super::super::discovery::MEMORY {
            return self.prepare_discovery_memory(input, context, cancellation);
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
                    if let Some(title) = Text::single_line(title) {
                        let title = title.fallback;
                        Text::for_locales(|locale| {
                            maka_agent_facts::i18n::tool_title::create_automation_titled(
                                locale, &title,
                            )
                        })
                    } else {
                        Text::for_locales(|locale| {
                            maka_agent_facts::i18n::tool_title::create_automation(locale).to_owned()
                        })
                    }
                }
                Input::List { .. } => Text::for_locales(|locale| {
                    maka_agent_facts::i18n::tool_title::list_automations(locale).to_owned()
                }),
                Input::TestScript { .. } => Text::for_locales(|locale| {
                    maka_agent_facts::i18n::tool_title::test_automation_script(locale).to_owned()
                }),
                Input::Pause { .. } => Text::for_locales(|locale| {
                    maka_agent_facts::i18n::tool_title::pause_automation(locale).to_owned()
                }),
                Input::Resume { .. } => Text::for_locales(|locale| {
                    maka_agent_facts::i18n::tool_title::resume_automation(locale).to_owned()
                }),
                Input::Delete { .. } => Text::for_locales(|locale| {
                    maka_agent_facts::i18n::tool_title::delete_automation(locale).to_owned()
                }),
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
                    let job = owner.workers.spawn(async move {
                        captured.scheduled_tool(input, context, cancellation).await
                    });
                    drop(runs);
                    let value = job.await.map_err(failed)??;
                    Ok(value.into())
                })
            })
            .titled(title)
            .presented("maka.agent.Builtin@1/ScheduledTask".into()))
        })
    }
}
impl Owner {
    async fn scheduled_tool(
        &self,
        input: Input,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> Result<Value, ToolError> {
        let _gate = match &input {
            Input::TestScript { .. } => None,
            _ => Some(self.scheduler.gate.lock().await),
        };
        let (view, session) = async {
            let session = self
                .tool_store(&context)?
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
            Ok::<_, String>((view, session))
        }
        .await
        .map_err(failed)?;
        let current_session = || {
            let session = resolve_session(session)?;
            if session.archived
                || session.configuration.permission_basis() != view.spec.permission_basis
            {
                return Err("scheduler_authorization_changed".to_string());
            }
            Ok(session)
        };
        if let Input::TestScript { source, state } = input {
            let session = current_session().map_err(failed)?;
            return self
                .test_script(
                    &session.configuration,
                    &view.spec.permission_ceiling.sandbox,
                    source,
                    state,
                    cancellation,
                )
                .await;
        }
        let result: Result<Value, String> = async {
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
        let (id, mut plan) = match input {
            Input::Create {
                title,
                intent_body,
                schedule,
                timezone,
                misfire,
                effect,
                delivery,
                worker_tools,
                max_fires,
                expires_at,
            } => {
                let (effect, authorization) = {
                    let session = current_session()?;
                    let basis = {
                        let runs = self.runs.state().await;
                        runs.controls
                            .get(&context.execution.session_id)
                            .filter(|control| control.execution == context.execution)
                            .ok_or("scheduler_invocation_closed")?
                            .basis
                            .clone()
                    };
                    let target = ScheduledTarget {
                        session_id: session.id,
                        workspace: session.configuration.workspace,
                        permissions: session.configuration.permissions,
                        boundary_revision: session.configuration.boundary_revision,
                        binding: session.configuration.binding,
                    };
                    let sandbox_ceiling = Some(view.spec.permission_ceiling.sandbox);
                    match (&basis.model, &basis.executor) {
                        (Some(accepted), None) => {
                            let model = accepted.selection();
                            let thinking_level = accepted.thinking_level;
                            let effect = match effect {
                                Target::Discovery => {
                                    if !self.settings.bot
                                        || !self.bot.is(&context.execution.session_id)
                                    {
                                        return Err("discovery_requires_bot".into());
                                    }
                                    if matches!(schedule, TaskSchedule::Script { .. }) {
                                        return Err("discovery_requires_time_schedule".into());
                                    }
                                    ScheduledEffect::Discovery {
                                        target: target.clone(),
                                        model: model.clone(),
                                        thinking_level,
                                        worker_tools: worker_tools.unwrap_or_default(),
                                        selected_tools: None,
                                    }
                                }
                                Target::Session => ScheduledEffect::Session {
                                    delivery,
                                    target: target.clone(),
                                    model: model.clone(),
                                    thinking_level,
                                },
                                Target::AgentRun => ScheduledEffect::AgentRun {
                                    target: target.clone(),
                                    model: model.clone(),
                                    thinking_level,
                                },
                            };
                            let approval = if matches!(effect, ScheduledEffect::Discovery { .. }) {
                                None
                            } else {
                                Some(Approval::Execution {
                                    approval: BackgroundGrant::Model(
                                        super::super::notifications::BackgroundApproval {
                                            target,
                                            model,
                                            thinking_level,
                                            accepted_model: accepted.clone(),
                                            language: view.spec.language,
                                            sandbox_ceiling,
                                        },
                                    ),
                                })
                            };
                            (effect, approval)
                        }
                        (None, Some(executor)) if executor.selection.executor == "external" => {
                            if !matches!(effect, Target::Session) {
                                return Err(
                                    "External agents schedule follow-ups in their own conversation"
                                        .into(),
                                );
                            }
                            let selection = executor.selection.clone();
                            (
                                ScheduledEffect::ExecutorSession {
                                    target: target.clone(),
                                    selection: selection.clone(),
                                },
                                Some(Approval::Execution {
                                    approval: BackgroundGrant::Executor(ExecutorApproval {
                                        language: view.spec.language,
                                        target,
                                        selection,
                                        sandbox_ceiling,
                                    }),
                                }),
                            )
                        }
                        _ => return Err("scheduler_backend_unavailable".into()),
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
                plan.authorization = authorization;
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
                if saved.plan.edit_revision != revision {
                    return Err("scheduler_revision_changed".into());
                }
                if !matches!(&saved.plan.task.created_by, Creator::Agent { session_id } if session_id == &context.execution.session_id)
                {
                    return Err("scheduler_task_outside_conversation".into());
                }
                let plan = match input {
                    Input::Pause { .. } => Some(pause_plan(
                        &saved.plan,
                        now() as i64,
                        Some(PauseSource::Bot),
                    )),
                    Input::Resume { .. } => {
                        let Some(approval) = &saved.plan.authorization else {
                            if matches!(saved.plan.task.effect, ScheduledEffect::Discovery { .. }) {
                                return Err("scheduler_user_approval_required".into());
                            }
                            return Err("scheduler_execution_unavailable".into());
                        };
                        if let Some(grant) = approval.followup_grant()
                            && !self.scheduler.followup_is_current(grant).await?
                        {
                            return Err("scheduler_user_approval_required".into());
                        }
                        let basis = match approval {
                            Approval::Execution { approval } => {
                                self.prepare_scheduled_background(approval, &saved.plan.task.id)
                                    .await?
                            }
                            Approval::Discovery { approval, .. } => {
                                if saved.plan.pause_source != Some(PauseSource::Bot) {
                                    return Err("scheduler_user_resume_required".into());
                                }
                                self.prepare_approved_background(
                                    approval,
                                    BackgroundKind::Schedule {
                                        task_id: saved.plan.task.id.clone(),
                                    },
                                )
                                .await?
                            }
                            Approval::CancelledDiscovery { .. } => {
                                return Err("scheduler_execution_unavailable".into());
                            }
                        };
                        self.validate_background(&basis).await?;
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
            Input::List { .. } | Input::TestScript { .. } => unreachable!(),
        };
        let revision = catalog
            .plans
            .get(&id)
            .map_or(1, |saved| saved.plan.edit_revision + 1);
        if let Some(plan) = &mut plan {
            plan.edit_revision = revision;
        }
        let mut result = serde_json::json!({ "taskId": id, "revision": revision });
        if let Some(plan) = &plan
            && matches!(plan.task.effect, ScheduledEffect::Discovery { .. })
        {
            result["approved"] = serde_json::json!(plan.authorization.is_some());
        }
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
        .await;
        result.map_err(failed)
    }
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scheduled_task_uses_mode_for_test_script_with_object_state_schema_and_specific_errors() {
        let schema = maka_tool_catalog::input::inline_refs(
            serde_json::to_value(schemars::schema_for!(ToolRequest<Input>)).unwrap(),
        );
        let variants = schema["properties"]["request"]["oneOf"]
            .as_array()
            .expect("flat oneOf schema for mode-tagged Input");
        let test_script = variants
            .iter()
            .find(|variant| variant["properties"]["mode"]["const"] == "test_script")
            .expect("test_script mode variant");
        assert!(
            test_script["properties"]["state"].is_object(),
            "state property must be a schema object, got {}",
            test_script["properties"]["state"]
        );

        assert!(
            serde_json::from_value::<ToolRequest<Input>>(json!({
                "request": { "mode": "test_script", "source": "console.log(true)" }
            }))
            .is_ok()
        );
        let missing = serde_json::from_value::<ToolRequest<Input>>(json!({
            "request": { "mode": "create", "title": "t" }
        }))
        .err()
        .unwrap()
        .to_string();
        assert!(missing.contains("intentBody"), "{missing}");
        let unknown = serde_json::from_value::<ToolRequest<Input>>(json!({
            "request": { "mode": "list", "extra": 1 }
        }))
        .err()
        .unwrap()
        .to_string();
        assert!(unknown.contains("extra"), "{unknown}");
    }
}
