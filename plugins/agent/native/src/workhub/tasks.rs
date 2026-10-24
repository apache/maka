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

mod catalog;
mod controls;
mod dependencies;
pub(crate) mod graph;
mod notifications;
mod preparation;
use super::*;
use crate::tools::ToolRequest;
use contract::{Task, TaskStatus};
use futures_util::FutureExt;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::language::Language;
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_facts::tools::PreparationFuture;
use maka_agent_facts::tools::PreparedEffect;
use maka_agent_facts::tools::ToolCallContext;
use maka_agent_facts::tools::ToolDefinition;
use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolHandler;
use maka_agent_facts::tools::ToolNesting;
use maka_agent_facts::tools::ToolPreparer;
use maka_agent_facts::tools::ToolRegistration;
use maka_agent_facts::tools::ToolSemantics;
use maka_capabilities::call::Attachments;
use maka_capabilities::call::Identity;
use maka_host_runtime::application::{Binding, NativeContext, NativeServices};
use maka_plugin_core::{
    deployment::DeploymentRef,
    operation::{OperationCleanup, OperationOutcome, OperationReply, Receipt, RecoveryRef},
};
use preparation::{Target, Transfer};
use schemars::JsonSchema;
use sha2::{Digest, Sha256};
use std::{
    panic::AssertUnwindSafe,
    sync::{
        OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const NAME: &str = "workhub_tasks";
pub(crate) type Link = Arc<OnceLock<Weak<Hub>>>;
#[derive(Clone)]
pub(super) struct Tasks {
    pub(crate) graphs: Arc<graph::Graphs>,
    services: NativeServices,
    source: DeploymentRef,
    pub(super) workers: BTreeMap<String, Option<Binding>>,
    failed: Arc<AtomicBool>,
    link: Link,
}
impl Tasks {
    pub(super) fn bindings(&self) -> BTreeMap<String, Option<String>> {
        self.workers
            .iter()
            .map(|(name, binding)| {
                (
                    name.clone(),
                    binding
                        .as_ref()
                        .map(|binding| binding.execution_basis().into()),
                )
            })
            .collect()
    }
    pub fn cleanup_failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Input {
    ReadPatch {
        control_id: String,
        offset: u64,
    },
    Presets,
    Tools {
        worker: String,
    },
    CancelPending {
        task_id: String,
    },
    RoutePreset {
        #[serde(default)]
        #[schemars(extend("uniqueItems" = true))]
        dependencies: Vec<String>,
        preset: String,
        title: String,
        workspace: crate::contract::DirectorySelection,
        note: String,
    },
    Control {
        task_id: String,
        action: controls::Action,
    },
    Controls {
        after: Option<String>,
    },
    InspectControl {
        control_id: String,
    },
    AdvanceControl {
        control_id: String,
    },
    Workers,
    Executors {
        worker: String,
    },
    Assignments {
        after: Option<String>,
    },
    Sessions {
        worker: String,
        after: Option<String>,
    },
    Directories {
        worker: String,
        location: crate::contract::Directories,
    },
    Route(Route),
    Wait {
        task_id: String,
    },
    Inspect {
        task_id: String,
        cursor: Option<crate::contract::AnswerCursor>,
    },
    Advance {
        task_id: String,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Route {
    #[serde(default)]
    #[schemars(extend("uniqueItems" = true))]
    dependencies: Vec<String>,
    worker: String,
    target: Target,
    note: String,
    model: Option<crate::ModelSelection>,
    thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    executor: Option<maka_agent_api::executor::Selection>,
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DeliveryMethod {
    #[default]
    Send,
    Execute,
}
impl DeliveryMethod {
    fn method(self) -> &'static str {
        match self {
            Self::Send => "send",
            Self::Execute => "execute",
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Assignment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    graph: Option<graph::TaskSource>,
    #[serde(default)]
    dependencies: Vec<String>,
    source: Invocation,
    tool_operation: String,
    worker: String,
    binding: String,
    operation: Uuid,
    #[serde(default)]
    delivery: DeliveryMethod,
    input: Value,
    target: Target,
    attachments: Vec<Transfer>,
    return_route: crate::owner::ReturnRoute,
    notification: Option<notifications::Notification>,
}
struct Call<'a> {
    worker: &'a str,
    binding: &'a str,
    operation: Uuid,
    method: &'a str,
    input: &'a Value,
    attachment: Option<&'a Transfer>,
}
enum DispatchObservation {
    Pending,
    Unavailable,
    Reply(Box<OperationReply>),
}
pub(super) fn prepare(
    context: &NativeContext,
    value: Value,
) -> Result<(Value, Tasks, Vec<ToolRegistration>, Link), String> {
    if !jsonschema::validator_for(&configuration_schema())
        .expect("WorkHub schema")
        .is_valid(&value)
    {
        return Err("workhub_configuration_invalid".into());
    }
    let settings: contract::Configuration =
        serde_json::from_value(value).map_err(|_| "workhub_configuration_invalid")?;
    let services = context.services();
    let mut workers = BTreeMap::new();
    for name in settings.workers {
        let bindings = services
            .imports()
            .find(|(alias, _)| *alias == name)
            .ok_or("workhub_worker_import_missing")?
            .1;
        if bindings.len() > 1
            || bindings
                .iter()
                .any(|binding| binding.contract() != &crate::contract())
            || workers.insert(name, bindings.first().cloned()).is_some()
        {
            return Err("workhub_worker_import_invalid".into());
        }
    }
    let link = Arc::new(OnceLock::new());
    let graphs = Arc::new(graph::Graphs::new(link.clone(), !workers.is_empty()));
    let mut additional = if workers.is_empty() {
        vec![]
    } else {
        vec![ToolRegistration {
        definition: ToolDefinition {
            provider: None, name: NAME.into(),
            description: "Coordinate work through selected Agent services. Workers, sessions, presets, tools, executors and directories expose available targets and published choices. route sends the original request, attachments and note; route_preset freezes the preset's worker, model, thinking level and tool restrictions. New targets use complete directory selections and either model/thinkingLevel or executor/settings. Executor settings use the worker backend, not Host model credentials; executor tasks cannot resume as native invocations. tools: null uses installed tools; [] disables tools. Restricted sessions cannot use external executors.

Dependencies are existing taskIds; successful final answers are frozen into downstream input. Deferred tasks advance automatically and notify this conversation; failed or shared dependencies reject downstream work. Replacement work requires an explicit route. cancel_pending applies only before input resolution; already_resolved is not a confirmed stop. Use control stop for admitted work.

Preparation and admission are not completion. wait observes an admitted task until completion, input needed, pause or unavailability. inspect reads original answer pages with the exact returned cursor. After an uncertain reply, inspect the original taskId; advance resumes only that frozen dispatch. Unknown status or a resource capture requirement does not authorize a new route or recapture. Preparation receipts stay with the original task.

control freezes stop/resume on observed work; shared delivery cannot control the whole Run, and a stop request is not confirmed termination. Recover missing replies with controls/inspect_control or advance_control for the original operation.

New targets or presets can select isolatedWorkspace: a separate Git worktree from a clean published repository. The source remains unchanged. After completion, control snapshot_patch captures an immutable patch of the original result. read_patch uses its controlId and exact next offset for every page. Busy requires a new explicit snapshot control after cleanup; capturing a patch does not apply it to the source.

Sessions returns ID-ordered excerpts and an after cursor; reuse it unchanged, or browse afresh for earlier changes.".into(),
            input_schema: schemars::schema_for!(ToolRequest<Input>).into(), output_schema: None, freeform: None,
        },
        nesting: ToolNesting::DirectOnly, semantics: ToolSemantics::ExclusiveStep,
        handler: ToolHandler::Prepared(Arc::new(Tool(link.clone()))),
    }]
    };
    if !workers.is_empty() {
        additional.extend(graph::registrations(link.clone()));
    }
    Ok((
        serde_json::to_value(settings.agent).map_err(|_| "workhub_configuration_invalid")?,
        Tasks {
            graphs,
            services,
            source: context
                .persistence()
                .ok_or("workhub_requires_persistence")?
                .source()
                .clone(),
            workers,
            failed: Arc::new(AtomicBool::new(false)),
            link: link.clone(),
        },
        additional,
        link,
    ))
}
struct Tool(Link);
impl ToolPreparer for Tool {
    fn names(&self) -> Vec<String> {
        vec![NAME.into()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        _: CancellationToken,
    ) -> PreparationFuture {
        let hub = self.0.get().and_then(Weak::upgrade);
        Box::pin(async move {
            let hub = hub
                .filter(|_| name == NAME)
                .ok_or(ToolRejection::Unavailable)?;
            let input = serde_json::from_value::<ToolRequest<Input>>(input)
                .map_err(|_| ToolRejection::InvalidInput {
                    message: "Invalid WorkHub task input".into(),
                })?
                .request;
            // Actual ToolCallContext supplies the source, never model JSON.
            hub.coordinator_source(&context)
                .await
                .map_err(|_| ToolRejection::Unavailable)?;
            // A graph supervisor cannot bypass its frozen scheduling authority
            // after Stop/Leave through the ordinary WorkHub entry point.
            if matches!(
                &input,
                Input::Route(_)
                    | Input::RoutePreset { .. }
                    | Input::CancelPending { .. }
                    | Input::Control {
                        action: controls::Action::Stop | controls::Action::Resume { .. },
                        ..
                    }
            ) {
                let configuration = hub
                    .agent
                    .0
                    .tool_store(&context)
                    .map_err(|_| ToolRejection::Unavailable)?
                    .invocation_configuration(&context.invocation)
                    .await
                    .map_err(|_| ToolRejection::Unavailable)?
                    .ok_or(ToolRejection::Unavailable)?;
                if configuration
                    .orchestration_mode
                    .as_str()
                    .starts_with("maka.graph.")
                    || configuration
                        .orchestration_mode
                        .as_str()
                        .starts_with("maka.swarm.")
                {
                    return Err(ToolRejection::PolicyDenied {
                        message: "graph_decision_required: use update_agent_graph".into(),
                    });
                }
            }
            Ok(PreparedEffect::new(move |cancel| {
                Box::pin(async move {
                    hub.tasks_input(input, context, cancel)
                        .await
                        .map(Into::into)
                        .map_err(|error| {
                            if hub.tasks.cleanup_failed() {
                                ToolError::CleanupUnconfirmed(error)
                            } else {
                                ToolError::OutcomeUnknown(error)
                            }
                        })
                })
            }))
        })
    }
}
impl Hub {
    async fn source_language(
        &self,
        invocation: &Invocation,
        execution: Option<&dyn maka_agent_facts::tools::ExecutionCustody>,
    ) -> Result<Language, String> {
        let store = match execution {
            Some(execution) => self
                .agent
                .0
                .store
                .session_for_execution(execution, invocation)
                .map_err(|error| error.to_string())?,
            None => self
                .agent
                .0
                .store
                .session(&invocation.session_id)
                .await
                .map_err(|error| error.to_string())?,
        };
        store
            .invocation_configuration(invocation)
            .await
            .map_err(|_| "workhub_source_unavailable")?
            .map(|configuration| configuration.language)
            .ok_or_else(|| "workhub_source_unavailable".into())
    }
    async fn coordinator_source(
        &self,
        context: &ToolCallContext,
    ) -> Result<maka_event_log::turns::TurnBoundary, String> {
        let invocation = &context.invocation;
        if !self.agent.0.owns(&invocation.session_id) {
            return Err("workhub_source_unavailable".into());
        }
        let store = self.agent.0.tool_store(context)?;
        let boundary = store
            .invocation_boundary(&invocation.session_id, &invocation.invocation_id)
            .await
            .map_err(|_| "workhub_source_unavailable")?
            .ok_or("workhub_source_unavailable")?
            .0;
        if boundary.invocation != *invocation {
            return Err("workhub_source_invalid".into());
        }
        Ok(boundary)
    }
    fn task_key(&self, id: &str) -> Result<String, String> {
        if id.len() != 67
            || !id.starts_with("wt_")
            || !id[3..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("workhub_task_invalid".into());
        }
        Ok(format!("{}tasks/{id}", self.agent.0.prefix))
    }
    pub(super) async fn task_list(&self, after: Option<String>) -> Result<Value, String> {
        self.task_list_scope(after, None).await
    }
    async fn task_list_scope(
        &self,
        after: Option<String>,
        session: Option<&str>,
    ) -> Result<Value, String> {
        self.task_catalog().list(after, session).await
    }
    fn task_catalog(&self) -> catalog::Catalog<'_> {
        catalog::Catalog {
            store: &self.agent.0.store,
            prefix: &self.agent.0.prefix,
        }
    }

    async fn assignment(&self, id: &str) -> Result<Assignment, String> {
        let record = self
            .agent
            .0
            .store
            .plugin_data(&namespace(), &self.task_key(id)?)
            .await
            .map_err(|_| "workhub_store_unavailable")?
            .ok_or("workhub_task_missing")?;
        let Data::Present(value) = record.data else {
            return Err("workhub_task_removed".into());
        };
        let record: Assignment =
            serde_json::from_value(value).map_err(|_| "workhub_task_invalid")?;
        if !self.agent.0.owns(&record.source.session_id)
            || record.graph.as_ref().map_or_else(
                || task_id(&record.source, &record.tool_operation),
                |graph| graph::graph_task_id(&graph.graph_id, &graph.work_id),
            ) != id
            || record.operation != child_id(id)
        {
            return Err("workhub_task_invalid".into());
        }
        Ok(record)
    }

    async fn tasks_input(
        &self,
        input: Input,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        if self.tasks.cleanup_failed() || cancellation.is_cancelled() {
            return Err("workhub_closed".into());
        }
        match &input {
            Input::CancelPending { task_id }
            | Input::Control { task_id, .. }
            | Input::Wait { task_id }
            | Input::Inspect { task_id, .. }
            | Input::Advance { task_id } => {
                if self.assignment(task_id).await?.source.session_id
                    != context.invocation.session_id
                {
                    return Err("workhub_task_source_invalid".into());
                }
            }
            Input::ReadPatch { control_id, .. }
            | Input::InspectControl { control_id }
            | Input::AdvanceControl { control_id } => {
                self.require_control_session(control_id, &context.invocation.session_id)
                    .await?;
            }
            _ => {}
        }
        let input = if let Input::RoutePreset {
            preset,
            title,
            workspace,
            note,
            dependencies,
        } = input
        {
            let id = task_id(&context.invocation, &context.operation_id);
            if self
                .agent
                .0
                .store
                .plugin_data(&namespace(), &self.task_key(&id)?)
                .await
                .map_err(|_| "workhub_store_unavailable")?
                .is_some()
            {
                return self
                    .task_with_execution(&id, true, None, context.execution.clone(), cancellation)
                    .await;
            }
            let (preset, model) = self.resolve_preset(&preset).await?;
            Input::Route(Route {
                dependencies,
                worker: preset.worker,
                target: Target::New {
                    isolated_workspace: preset.isolated_workspace,
                    title,
                    workspace,
                    tools: Some(preset.tools),
                },
                note,
                model: Some(model),
                thinking_level: preset.thinking_level,
                executor: None,
            })
        } else {
            input
        };
        let catalog_method = if matches!(input, Input::Tools { .. }) {
            "tools"
        } else {
            "executors"
        };
        match input {
            Input::ReadPatch { control_id, offset } => {
                self.read_control_patch(
                    &control_id,
                    offset,
                    context.execution.clone(),
                    cancellation,
                )
                .await
            }
            Input::RoutePreset { .. } => unreachable!("preset resolved above"),
            Input::CancelPending { task_id } => self.cancel_pending(&task_id, cancellation).await,
            Input::Presets => serde_json::to_value(self.presets().await?)
                .map_err(|_| "workhub_encoding_failed".into()),
            Input::Control { task_id, action } => {
                self.control_start(&task_id, action, context, cancellation)
                    .await
            }
            Input::Controls { after } => {
                self.controls_scope(after, Some(&context.invocation.session_id))
                    .await
            }
            Input::InspectControl { control_id } => {
                self.control(&control_id, false, context.execution.clone(), cancellation)
                    .await
            }
            Input::AdvanceControl { control_id } => {
                self.control(&control_id, true, context.execution.clone(), cancellation)
                    .await
            }
            Input::Assignments { after } => {
                self.task_list_scope(after, Some(&context.invocation.session_id))
                    .await
            }
            Input::Workers => Ok(
                serde_json::json!({"workers":self.tasks.workers.iter().map(|(name,binding)| serde_json::json!({"name":name,"available":binding.is_some()})).collect::<Vec<_>>()}),
            ),
            Input::Tools { worker } | Input::Executors { worker } => {
                self.tasks
                    .workers
                    .get(&worker)
                    .and_then(Option::as_ref)
                    .ok_or("workhub_worker_unavailable")?;
                let request = self.tasks.services.request_with_execution(
                    Identity::Agent {
                        invocation: context.invocation,
                        operation_id: Some(context.operation_id),
                    },
                    cancellation,
                    context
                        .execution
                        .clone()
                        .ok_or("workhub_execution_custody_unavailable")?,
                )?;
                self.observe_request(&request, async {
                    request
                        .call(
                            &worker,
                            0,
                            catalog_method.into(),
                            serde_json::json!({}),
                            Attachments::default(),
                        )?
                        .await
                })
                .await
            }
            Input::Directories { worker, location } => {
                self.tasks
                    .workers
                    .get(&worker)
                    .and_then(Option::as_ref)
                    .ok_or("workhub_worker_unavailable")?;
                let request = self.tasks.services.request_with_execution(
                    Identity::Agent {
                        invocation: context.invocation,
                        operation_id: Some(context.operation_id),
                    },
                    cancellation,
                    context
                        .execution
                        .clone()
                        .ok_or("workhub_execution_custody_unavailable")?,
                )?;
                self.observe_request(&request, async {
                    let page = request
                        .call(
                            &worker,
                            0,
                            "directories".into(),
                            serde_json::to_value(location)
                                .map_err(|_| "workhub_directory_invalid")?,
                            Attachments::default(),
                        )?
                        .await?;
                    preparation::directory_page(page)
                })
                .await
            }
            Input::Sessions { worker, after } => {
                self.tasks
                    .workers
                    .get(&worker)
                    .and_then(Option::as_ref)
                    .ok_or("workhub_worker_unavailable")?;
                let request = self.tasks.services.request_with_execution(
                    Identity::Agent {
                        invocation: context.invocation,
                        operation_id: Some(context.operation_id),
                    },
                    cancellation,
                    context
                        .execution
                        .clone()
                        .ok_or("workhub_execution_custody_unavailable")?,
                )?;
                self.observe_request(&request, async {
                    // Each model turn changes the global catalog revision. Refresh at the
                    // original anchor explicitly; do not reuse or silently relax a fence.
                    let position = after.as_ref().map_or_else(||serde_json::json!({"kind":"start"}),|cursor|serde_json::json!({"kind":"at","cursor":cursor}));
                    let mut page = request.call(&worker, 0, "list".into(), serde_json::json!({"filter":"all","position":position}), Attachments::default())?.await?;
                    if let Some(anchor) = after.as_deref() {
                        let rows = page["sessions"].as_array().ok_or("workhub_sessions_invalid")?;
                        if !rows.iter().any(|row|row["id"].as_str().is_some_and(|id|id > anchor)) && !page["after"].is_null() {
                            // A maximum-size summary can fill a native page on its own.
                            // Continue that newly read page with its actual revision.
                            page = request.call(&worker, 0, "list".into(), serde_json::json!({"filter":"all","position":{"kind":"after","cursor":page["after"],"revision":page["revision"]}}),Attachments::default())?.await?;
                        }
                    }
                    session_page(page, after.as_deref())

                }).await
            }
            Input::Route(route) => {
                let id = task_id(&context.invocation, &context.operation_id);
                // A same-tool replay reads its original decision before today's capabilities.
                if self
                    .agent
                    .0
                    .store
                    .plugin_data(&namespace(), &self.task_key(&id)?)
                    .await
                    .map_err(|_| "workhub_store_unavailable")?
                    .is_none()
                {
                    let (assignment, title) =
                        self.prepare_assignment(&context, &id, route, None).await?;
                    if cancellation.is_cancelled() {
                        return Err("workhub_cancelled".into());
                    }
                    let mut mutations = self.task_catalog().acceptance_mutations(
                        &context,
                        vec![(id.clone(), assignment.worker.clone(), title)],
                        maka_agent_authority::now(),
                    )?;
                    mutations.push(Mutation {
                        key: self.task_key(&id)?,
                        expected_revision: None,
                        data: Data::Present(
                            serde_json::to_value(assignment)
                                .map_err(|_| "workhub_encoding_failed")?,
                        ),
                    });
                    match self
                        .agent
                        .0
                        .store
                        .plugin_data_batch(&namespace(), mutations)
                        .await
                    {
                        Ok(_) | Err(maka_event_log::StoreError::RevisionConflict { .. }) => {}
                        Err(_) => return Err("workhub_route_commit_unknown".into()),
                    }
                }
                self.task_with_execution(&id, true, None, context.execution.clone(), cancellation)
                    .await
            }
            Input::Wait { task_id } => self.wait_task(&task_id, context, cancellation).await,
            Input::Inspect { task_id, cursor } => {
                self.task_with_execution(
                    &task_id,
                    false,
                    cursor,
                    context.execution.clone(),
                    cancellation,
                )
                .await
            }
            Input::Advance { task_id } => {
                self.task_with_execution(
                    &task_id,
                    true,
                    None,
                    context.execution.clone(),
                    cancellation,
                )
                .await
            }
        }
    }
    /// Freeze one original task without dispatching it. Graph decisions use
    /// this same assignment in their atomic schedule/outbox transaction.
    async fn prepare_assignment(
        &self,
        context: &ToolCallContext,
        id: &str,
        route: Route,
        graph: Option<graph::TaskSource>,
    ) -> Result<(Assignment, String), String> {
        let Route {
            dependencies,
            worker,
            target,
            note,
            model,
            thinking_level,
            executor,
        } = route;
        let binding = self
            .tasks
            .workers
            .get(&worker)
            .and_then(Option::as_ref)
            .ok_or("workhub_worker_unavailable")?;
        let original = self.coordinator_source(&context).await?;
        let language = self
            .agent
            .0
            .tool_store(&context)?
            .invocation_configuration(&context.invocation)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("workhub_source_unavailable")?
            .language;
        let maka_agent_facts::input::InvocationInput::Message {
            content,
            source_messages,
            ..
        } = original.root_input()
        else {
            return Err("workhub_source_unavailable".into());
        };
        target.validate()?;
        self.validate_dependencies(&dependencies).await?;
        for dependency in &dependencies {
            if self.assignment(dependency).await?.source.session_id != context.invocation.session_id
            {
                return Err("workhub_dependency_source_invalid".into());
            }
        }
        if note.trim().is_empty() || note.contains('\0') {
            return Err("workhub_route_invalid".into());
        }
        let (delivery, mut input) = match (model, executor) {
            (Some(model), None) => (
                DeliveryMethod::Send,
                serde_json::json!({"model":model,"thinkingLevel":thinking_level}),
            ),
            (None, Some(executor)) if thinking_level.is_none() => (
                DeliveryMethod::Execute,
                serde_json::json!({"executor":executor}),
            ),
            _ => return Err("workhub_execution_selection_invalid".into()),
        };
        let attachments = self
            .transfers(&context, content.attachments.as_deref().unwrap_or_default())
            .await?;
        let original = if source_messages.len() == 1 {
            &source_messages[0].unprepared_content.text
        } else {
            &content.text
        };
        let title = excerpt(
            match &target {
                Target::New { title, .. } => title,
                Target::Existing { .. } if graph.is_some() => &note,
                Target::Existing { .. } => original,
            },
            128,
        );
        let message = if graph.is_some() {
            match language {
                Language::En => format!("Task:\n{note}"),
                Language::ZhCn => format!("任务：\n{note}"),
                Language::ZhTw => format!("任務：\n{note}"),
            }
        } else {
            match language {
                Language::En => format!(
                    "Original user request:\n{original}\n\nCoordinator instructions:\n{note}"
                ),
                Language::ZhCn => format!("原始用户请求：\n{original}\n\n协调者指令：\n{note}"),
                Language::ZhTw => format!("原始使用者請求：\n{original}\n\n協調者指令：\n{note}"),
            }
        };
        input["message"] = serde_json::json!(message);
        Ok((
            Assignment {
                graph,
                dependencies,
                return_route: self.agent.0.return_route(&context.invocation).await?,
                notification: None,
                source: context.invocation.clone(),
                tool_operation: context.operation_id.clone(),
                worker,
                binding: binding.execution_basis().into(),
                operation: child_id(id),
                delivery,
                input,
                target,
                attachments,
            },
            title,
        ))
    }
    async fn wait_task(
        &self,
        id: &str,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        let current = self
            .task_with_execution(
                id,
                false,
                None,
                context.execution.clone(),
                cancellation.clone(),
            )
            .await?;
        if !waiting(&current) {
            return Ok(current);
        }
        let assignment = self.assignment(id).await?;
        let delivery = self
            .delivery(id, &assignment)
            .await?
            .ok_or("workhub_delivery_missing")?;
        let request = self.tasks.services.request_with_execution(
            Identity::Agent {
                invocation: context.invocation,
                operation_id: Some(context.operation_id),
            },
            cancellation.clone(),
            context
                .execution
                .clone()
                .ok_or("workhub_execution_custody_unavailable")?,
        )?;
        self.observe_request(&request, async {
            let original = self.agent.0.store.application_intent(
                self.tasks.source.deployment, self.agent.0.data_source.namespace.clone(), assignment.operation,
            ).await.map_err(|_| "workhub_original_operation_unavailable")?
                .ok_or("workhub_original_operation_missing")?;
            let observed = self.observe_original(&request, &assignment, &original.reference, &delivery.session_id).await?;
            let through = observed["through"].as_u64().ok_or("workhub_observation_invalid")?;
            let mut subscription = request.subscribe(&assignment.worker, 0, "watch".into(), serde_json::json!({"sessionId":delivery.session_id,"after":through}), Attachments::default())?.await?;
            loop {
                // Re-read after admission to cover completion between observe and watch.
                let current = self.task_with_execution(id, false, None, context.execution.clone(), cancellation.clone()).await?;
                if !waiting(&current) { return Ok(current); }
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => return Err("workhub_cancelled".into()),
                    value = subscription.recv() => if value.is_none() {return Err("workhub_observation_closed".into());},
                }
            }
            // Dropping demand cancels only watch. The original request finish joins
            // the actual subscription executor, never the worker's independent Run.
        }).await
    }
    /// Source comparison permits only observation through a currently authorized
    /// import. It never makes a replacement binding eligible for dispatch.
    async fn observe_original(
        &self,
        request: &maka_host_runtime::application::NativeRequest,
        assignment: &Assignment,
        original: &RecoveryRef,
        session: &str,
    ) -> Result<Value, String> {
        let binding = self
            .tasks
            .workers
            .get(&assignment.worker)
            .and_then(Option::as_ref)
            .ok_or("workhub_worker_unavailable")?;
        if original.source.state_domain != self.tasks.source.state_domain
            || original.source.deployment != self.tasks.source.deployment
            || binding.provider().instance() != &original.namespace
            || binding.export() != original.export
            || !original
                .contract
                .matches(binding.contract(), &original.method)
                .unwrap_or(false)
            || original.method != assignment.delivery.method()
            || original.operation != assignment.operation
        {
            return Err("workhub_original_source_changed".into());
        }
        let observed = request
            .call(
                &assignment.worker,
                0,
                "observe".into(),
                serde_json::json!({"sessionId":session}),
                Attachments::default(),
            )?
            .await?;
        let expected = crate::contract::DataSource {
            state_domain: original.source.state_domain.clone(),
            deployment: original.source.deployment,
            namespace: original.namespace.clone(),
        };
        let actual: crate::contract::DataSource =
            serde_json::from_value(observed["session"]["dataSource"].clone())
                .map_err(|_| "workhub_original_source_invalid")?;
        if actual != expected || observed["session"]["id"] != session {
            return Err("workhub_original_source_changed".into());
        }
        Ok(observed)
    }
    async fn observe_request<T>(
        &self,
        request: &maka_host_runtime::application::NativeRequest,
        observation: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let mut business = Box::pin(AssertUnwindSafe(observation).catch_unwind());
        let result = tokio::select! {
            biased;
            result = &mut business => result,
            _ = request.scope().cancellation.cancelled() => {
                // Reach the original cleanup budget while the Host retains the actual
                // admitted callback. Keep its original observer after confirmed cleanup.
                self.finish(request).await?;
                business.await
            }
        }
        .unwrap_or_else(|_| Err("workhub_observation_unknown".into()));
        self.finish(request).await?;
        result
    }
    async fn finish(
        &self,
        request: &maka_host_runtime::application::NativeRequest,
    ) -> Result<(), String> {
        if request.finish().await.is_err() {
            self.tasks.failed.store(true, Ordering::Release);
            return Err("workhub_cleanup_unconfirmed".into());
        }
        Ok(())
    }
    async fn dispatch(
        &self,
        request: &maka_host_runtime::application::NativeRequest,
        call: Call<'_>,
        advance: bool,
    ) -> Result<DispatchObservation, String> {
        let same_binding = self
            .tasks
            .workers
            .get(call.worker)
            .and_then(Option::as_ref)
            .is_some_and(|binding| binding.execution_basis() == call.binding);
        let recorded = self
            .agent
            .0
            .store
            .application_intent(
                self.tasks.source.deployment,
                self.agent.0.data_source.namespace.clone(),
                call.operation,
            )
            .await
            .map_err(|_| "workhub_original_operation_unavailable")?;
        if let Some(recorded) = recorded {
            let reference = recorded.reference;
            let observed = request.recover(reference.clone())?.await?;
            if observed.is_some() || !advance || !same_binding || call.attachment.is_some() {
                return Ok(DispatchObservation::Reply(Box::new(OperationReply {
                    reference,
                    receipt: observed.map_or(Receipt::NotRecorded, |observation| {
                        Receipt::Recorded {
                            outcome: observation.outcome,
                            cleanup: observation.cleanup,
                        }
                    }),
                })));
            }
        } else if !advance {
            return Ok(DispatchObservation::Pending);
        }
        if !same_binding {
            return Ok(DispatchObservation::Unavailable);
        }
        let attachments = if let Some(transfer) = call.attachment {
            self.transfer_resource(request, transfer).await?
        } else {
            maka_host_runtime::application::CallResources::default()
        };
        Ok(DispatchObservation::Reply(Box::new(
            request
                .mutate(
                    call.worker,
                    0,
                    call.method.into(),
                    call.input.clone(),
                    call.operation,
                    attachments,
                )?
                .await?,
        )))
    }
    pub(super) async fn task(
        &self,
        id: &str,
        advance: bool,
        cursor: Option<crate::contract::AnswerCursor>,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        self.task_with_execution(id, advance, cursor, None, cancellation)
            .await
    }
    pub(super) async fn task_with_execution(
        &self,
        id: &str,
        advance: bool,
        cursor: Option<crate::contract::AnswerCursor>,
        execution: Option<Arc<dyn maka_agent_facts::tools::ExecutionCustody>>,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        if self.tasks.cleanup_failed() {
            return Err("workhub_closed".into());
        }
        let assignment = self.assignment(id).await?;
        let metadata = self.task_catalog().metadata(id, &assignment).await?;
        // The graph gate orders stop/finish against new physical dispatch. Reads
        // still recover the original operation after the current epoch closes.
        let _graph_gate = if advance && assignment.graph.is_some() {
            Some(self.tasks.graphs.gate.lock().await)
        } else {
            None
        };
        let advance = advance && self.graph_can_advance(&assignment).await?;

        if assignment.graph.is_some()
            && self.graph_retired(&assignment).await?
            && self
                .agent
                .0
                .store
                .application_intent(
                    self.tasks.source.deployment,
                    self.agent.0.data_source.namespace.clone(),
                    assignment.operation,
                )
                .await
                .map_err(|_| "workhub_original_operation_unavailable")?
                .is_none()
        {
            // No original dispatch was admitted. Preparations have already joined
            // before releasing the graph gate; a retired epoch cannot send later.
            return encode_task(id, &assignment, &metadata, TaskStatus::Cancelled);
        }
        let dependency_input = match self
            .dependency_input(
                id,
                &assignment,
                advance,
                execution.clone(),
                cancellation.clone(),
            )
            .await?
        {
            Ok(input) => input,
            Err(status) => return encode_task(id, &assignment, &metadata, status),
        };
        if advance && !assignment.dependencies.is_empty() {
            let source = match &execution {
                Some(execution) => crate::owner::resolve_session(
                    self.agent
                        .0
                        .store
                        .session_for_execution(execution.as_ref(), &assignment.source)
                        .map_err(|error| error.to_string())?
                        .get::<maka_agent_api::session::StoredSessionConfiguration>()
                        .await
                        .map_err(|error| error.to_string())?
                        .ok_or("workhub_source_unavailable")?,
                )?,
                None => self.agent.0.session(&assignment.source.session_id).await?,
            };
            if source.archived
                || source.configuration.workspace != assignment.return_route.workspace
                || source.configuration.binding != assignment.return_route.binding
            {
                return encode_task(id, &assignment, &metadata, TaskStatus::Unavailable);
            }
        }
        let same_binding = self
            .tasks
            .workers
            .get(&assignment.worker)
            .and_then(Option::as_ref)
            .is_some_and(|binding| binding.execution_basis() == assignment.binding);
        let identity = Identity::Agent {
            invocation: assignment.source.clone(),
            operation_id: Some(assignment.tool_operation.clone()),
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
            let delivery = match self.prepare_delivery(id, &assignment, &request, advance).await? {
                Ok(delivery) => delivery,
                Err(status) => return encode_task(id, &assignment, &metadata, status),
            };
            let mut input = assignment.input.clone();
            if let Some(message) = dependency_input { input["message"] = serde_json::json!(message); }
            input["sessionId"] = serde_json::json!(delivery.session_id);
            input["attachments"] = serde_json::json!(delivery.attachments);
            let reply = match self.dispatch(&request, Call {
                worker: &assignment.worker, binding: &assignment.binding,
                operation: assignment.operation, method: assignment.delivery.method(), input: &input, attachment: None,
            }, advance).await? {
                DispatchObservation::Pending => None,
                DispatchObservation::Unavailable => return encode_task(id, &assignment, &metadata, TaskStatus::Unavailable),
                DispatchObservation::Reply(reply) => Some(*reply),
            };
            let status = match reply {
                None => TaskStatus::Pending,
                Some(OperationReply {
                    receipt:
                        Receipt::Recorded {
                            outcome: OperationOutcome::Returned { value },
                            cleanup: OperationCleanup::Confirmed,
                        },
                    reference,
                }) => {
                    if value["sessionId"] != delivery.session_id {
                        return Err("workhub_delivery_invalid".into());
                    }
                    let session = delivery.session_id;
                    let readable = same_binding || (
                        matches!(value["kind"].as_str(), Some("started" | "queued"))
                        && self.observe_original(&request, &assignment, &reference, &session).await.is_ok()
                    );
                    match value["kind"].as_str() {
                        Some("started") => TaskStatus::Started {
                            progress: if readable {
                                async {
                                    request.call(
                                        &assignment.worker, 0, "work".into(),
                                        serde_json::json!({"sessionId":session,"target":{"kind":"invocation","invocationId":value["invocationId"]},"cursor":cursor}),
                                        Attachments::default(),
                                    )?.await
                                }.await.ok().and_then(|value| serde_json::from_value(value).ok())
                            } else { None },
                            session_id: session,
                            invocation_id: value["invocationId"]
                                .as_str()
                                .ok_or("workhub_delivery_invalid")?
                                .into(),
                        },
                        Some("queued") => TaskStatus::Queued {
                            progress: if readable {
                                async {
                                    request.call(
                                        &assignment.worker, 0, "work".into(),
                                        serde_json::json!({"sessionId":session,"target":{"kind":"message","messageId":value["messageId"]},"cursor":cursor}),
                                        Attachments::default(),
                                    )?.await
                                }.await.ok().and_then(|value| serde_json::from_value(value).ok())
                            } else { None },
                            session_id: session,
                            message_id: value["messageId"]
                                .as_str()
                                .ok_or("workhub_delivery_invalid")?
                                .into(),
                        },
                        Some("rejected") => TaskStatus::Rejected {
                            reason: "worker_rejected_input".into(),
                        },
                        _ => return Err("workhub_delivery_invalid".into()),
                    }
                }
                Some(_) => TaskStatus::Uncertain,
            };
            encode_task(id, &assignment, &metadata, status)
        }).await
    }
}
fn encode_task(
    id: &str,
    assignment: &Assignment,
    metadata: &catalog::Metadata,
    status: TaskStatus,
) -> Result<Value, String> {
    serde_json::to_value(Task {
        task_id: id.into(),
        title: metadata.title.clone(),
        accepted_at: metadata.accepted_at,
        dependencies: assignment.dependencies.clone(),
        worker: assignment.worker.clone(),
        operation: assignment.operation,
        status,
    })
    .map_err(|_| "workhub_encoding_failed".into())
}
fn task_id(invocation: &Invocation, operation: &str) -> String {
    format!(
        "wt_{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(invocation, operation)).expect("actual tool identity")
        ))
    )
}
fn child_id(id: &str) -> Uuid {
    let digest = Sha256::digest(id.as_bytes());
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn session_page(page: Value, after: Option<&str>) -> Result<Value, String> {
    let source = page["sessions"]
        .as_array()
        .ok_or("workhub_sessions_invalid")?;
    let source = source
        .iter()
        .filter(|row| after.is_none_or(|cursor| row["id"].as_str().is_some_and(|id| id > cursor)))
        .collect::<Vec<_>>();
    let mut sessions = Vec::new();
    for session in source.iter().take(4) {
        sessions.push(serde_json::json!({
            "id":session["id"], "titleExcerpt":excerpt(session["title"].as_str().ok_or("workhub_sessions_invalid")?,64),
            "workspaceExcerpt":excerpt(session["workspace"]["path"].as_str().ok_or("workhub_sessions_invalid")?,96),
            "activity":session["activity"], "archived":session["archived"],
        }));
    }
    let after = if source.len() > sessions.len() || !page["after"].is_null() {
        sessions.last().map(|last| last["id"].clone())
    } else {
        None
    };
    Ok(serde_json::json!({"sessions":sessions,"after":after}))
}
fn excerpt(text: &str, bytes: usize) -> String {
    let end = text.floor_char_boundary(text.len().min(bytes));
    if end == text.len() {
        text.into()
    } else {
        format!("{}…", &text[..end])
    }
}

fn waiting(task: &Value) -> bool {
    let progress = &task["status"]["progress"];
    progress["kind"] == "pending"
        || (progress["kind"] == "delivered"
            && progress["pendingInteractions"] == 0
            && matches!(
                progress["execution"]["state"].as_str(),
                Some("admitted" | "running")
            ))
}
