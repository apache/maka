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

//! Explicit service-to-tool projection. Imports describe bindings, not grants.
pub(crate) mod approval;
mod computer;
pub(crate) mod image;
mod shell;
mod title;
mod web;
use crate::contract::{ServiceTool, ToolConfirmation, ToolInput, ToolResult};
use futures_util::FutureExt;
use maka_agent_facts::execution::EditingTools;
use maka_agent_facts::language::Language;
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_facts::tool_output::ToolOutput;
use maka_agent_facts::tool_output::ToolSuccess;
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
use maka_event_log::{RootStore, SessionStore};
use maka_host_runtime::application::NativeServices;
use maka_plugin_core::{
    contract::{Interface, MethodMode},
    operation::{OperationCleanup, OperationOutcome, OperationReply, Receipt},
};
use maka_tool_catalog::input::Projection;
use maka_tools::ToolCatalog;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{panic::AssertUnwindSafe, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SelectedTool {
    selection: ServiceTool,
    binding: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeApprovalData {
    selected: SelectedTool,
    capture: NativeApprovalCapture,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum NativeApprovalCapture {
    Ordinary {},
    Web {
        basis: maka_web_api::contract::Basis,
    },
    Skill {
        tool_names: Vec<(String, Option<EditingTools>)>,
    },
}

impl NativeApprovalData {
    fn decode(value: Value) -> Result<Self, ToolError> {
        let data: Self = serde_json::from_value(value).map_err(|error| {
            ToolError::Failed(format!("native approval descriptor invalid: {error}"))
        })?;
        if data.selected.selection.confirmation != ToolConfirmation::Required
            || !matches!(
                (data.selected.selection.input, &data.capture),
                (
                    ToolInput::Json | ToolInput::Shell,
                    NativeApprovalCapture::Ordinary {}
                ) | (ToolInput::Web, NativeApprovalCapture::Web { .. })
                    | (ToolInput::Skill, NativeApprovalCapture::Skill { .. })
            )
        {
            return Err(ToolError::Failed(
                "native approval capture differs from selection".into(),
            ));
        }
        Ok(data)
    }
}

pub(crate) struct Catalog {
    pub tools: ToolCatalog,
    pub basis: Vec<SelectedTool>,
    /// Derived from actual bound contracts and methods, never display names.
    pub editing: Vec<(String, EditingTools)>,
    /// Planning eligibility follows the actual service contract and method.
    pub planning: Vec<String>,
    pub executor: Arc<dyn maka_agent_engine::NativeApprovalExecutor>,
}

pub(crate) fn catalog(
    services: NativeServices,
    store: Arc<RootStore>,
    configuration: Arc<maka_config::ConfigurationStore>,
    selected: &[ServiceTool],
    additional: Vec<ToolRegistration>,
    workers: tokio_util::task::TaskTracker,
) -> Result<Catalog, String> {
    let mut basis = Vec::new();
    let file_contract = maka_workspace_api::files::contract();
    let editing: Vec<_> = selected
        .iter()
        .filter_map(|selection| {
            let (_, bindings) = services
                .imports()
                .find(|(name, _)| *name == selection.import)?;
            let [binding] = bindings else {
                return None;
            };
            if binding.contract() != &file_contract {
                return None;
            }
            let style = match selection.method.as_str() {
                "write" | "edit" => EditingTools::Structured,
                "applyPatch" => EditingTools::ApplyPatch,
                _ => return None,
            };
            Some((selection.name.clone(), style))
        })
        .collect();
    let mut planning = Vec::new();
    let questions_contract = maka_interactions_api::questions::contract();
    let web_contract = maka_web_api::contract();
    let mut web_bindings = std::collections::BTreeMap::<String, Vec<Service>>::new();
    let mut computer_bindings = std::collections::BTreeMap::<String, Vec<Service>>::new();
    let mut shell_bindings = Vec::new();
    let mut skill_bindings = Vec::new();
    let skill_contract = maka_skills_api::contract();
    let tool_names: Arc<Vec<(String, Option<EditingTools>)>> = Arc::new(
        selected
            .iter()
            .map(|tool| tool.name.clone())
            .chain(additional.iter().map(|tool| tool.definition.name.clone()))
            .map(|name| {
                let style = editing
                    .iter()
                    .find(|(editor, _)| *editor == name)
                    .map(|(_, style)| *style);
                (name, style)
            })
            .collect(),
    );
    let mut native_services = Vec::new();
    let registrations = selected
        .iter()
        .map(|selection| {
            let bindings = services
                .imports()
                .find(|(name, _)| *name == selection.import)
                .map(|(_, bindings)| bindings)
                .ok_or("agent_tool_import_unavailable")?;
            let [binding] = bindings else {
                return Err("agent_tool_import_ambiguous".to_owned());
            };
            let Interface::Service { methods } = &binding.contract().interface else {
                return Err("agent_tool_contract_invalid".to_owned());
            };
            let method = methods
                .get(&selection.method)
                .ok_or("agent_tool_method_unavailable")?;
            // The actual binding owns the title meaning, never a tool alias.
            let title_kind = if binding.contract() == &file_contract {
                match selection.method.as_str() {
                    "readText" | "readImage" => Some(title::Kind::Read),
                    "write" => Some(title::Kind::Write),
                    "edit" => Some(title::Kind::Edit),
                    "applyPatch" => Some(title::Kind::Patch),
                    "glob" => Some(title::Kind::Glob),
                    "grep" => Some(title::Kind::Grep),
                    _ => None,
                }
            } else if binding.contract() == &web_contract {
                match selection.method.as_str() {
                    "fetch" => Some(title::Kind::Fetch),
                    "search" => Some(title::Kind::Search),
                    _ => None,
                }
            } else {
                None
            };
            if (binding.contract() == &file_contract
                && matches!(
                    selection.method.as_str(),
                    "readText" | "readImage" | "glob" | "grep"
                ))
                || (binding.contract() == &web_contract
                    && matches!(selection.method.as_str(), "fetch" | "search"))
                || (binding.contract() == &questions_contract && selection.method == "ask")
            {
                planning.push(selection.name.clone());
            }

            if !method.resources.is_empty()
                || match selection.result {
                    ToolResult::Json => method.mode == MethodMode::Subscription,
                    ToolResult::Image => method.mode != MethodMode::Subscription,
                    ToolResult::Computer => {
                        method.mode != MethodMode::Mutation
                            || binding.contract() != &maka_workspace_api::computer::contract()
                            || selection.nestable
                    }
                }
            {
                return Err("agent_tool_method_unsupported".to_owned());
            }
            if selection.description.trim().is_empty() {
                return Err("agent_tool_description_invalid".to_owned());
            }
            if let Some(key) = &selection.presentation {
                maka_agent_facts::display::validate_presentation(key)
                    .map_err(|_| "agent_tool_presentation_invalid".to_owned())?;
            }
            if let Some(title) = &selection.title {
                title
                    .validate()
                    .map_err(|_| "agent_tool_title_invalid".to_owned())?;
            }
            let input_schema = match selection.input {
                ToolInput::Shell => {
                    if binding.contract() != &maka_workspace_api::processes::contract()
                        || selection.method != "execute"
                        || selection.result != ToolResult::Json
                    {
                        return Err("agent_shell_tool_contract_invalid".into());
                    }
                    shell::schema(method.input.as_ref().clone(), true)
                }
                ToolInput::Json => {
                    if binding.contract() == &maka_web_api::contract()
                        && maka_web_api::contract::model_input_schema(&selection.method).is_some()
                    {
                        return Err("agent_web_tool_projection_required".into());
                    }
                    if binding.contract() == &skill_contract
                        && maka_skills_api::model_input_schema(&selection.method).is_some()
                    {
                        return Err("agent_skill_tool_projection_required".into());
                    }
                    method.input.as_ref().clone()
                }
                ToolInput::Web => {
                    if binding.contract() != &maka_web_api::contract()
                        || selection.result != ToolResult::Json
                    {
                        return Err("agent_web_tool_contract_invalid".into());
                    }
                    maka_web_api::contract::model_input_schema(&selection.method)
                        .ok_or("agent_web_tool_method_invalid")?
                }
                ToolInput::Skill => {
                    if binding.contract() != &skill_contract || selection.result != ToolResult::Json
                    {
                        return Err("agent_skill_tool_contract_invalid".into());
                    }
                    maka_skills_api::model_input_schema(&selection.method)
                        .ok_or("agent_skill_tool_method_invalid")?
                }
            };
            let (input_projection, input_schema) = if selection.input == ToolInput::Json {
                Projection::project(input_schema)
            } else {
                (Projection::Direct, input_schema)
            };
            basis.push(SelectedTool {
                selection: selection.clone(),
                binding: binding.execution_basis().into(),
            });
            let service = Service {
                services: services.clone(),
                store: store.clone(),
                binding: binding.execution_basis().into(),
                target: format!(
                    "{} · {} v{} · {} / {} · {}",
                    selection.import,
                    binding.contract().name,
                    binding.contract().version,
                    serde_json::to_string(binding.provider().instance())
                        .expect("instance identity"),
                    binding.export(),
                    binding
                        .provider()
                        .remote_target()
                        .map_or("local", |target| target.deployment.as_str())
                ),
                tool_names: tool_names.clone(),
                selection: selection.clone(),
                input_projection,
                title_kind,
                mode: method.mode,
                web_basis: None,
            };
            if selection.input == ToolInput::Skill {
                skill_bindings.push((selection.name.clone(), Arc::new(SkillBinding(service.clone()))));
            }
            if selection.result == ToolResult::Computer {
                computer_bindings
                    .entry(selection.import.clone())
                    .or_default()
                    .push(service.clone());
            }
            if selection.input == ToolInput::Shell {
                shell_bindings.push((
                    selection.name.clone(),
                    Arc::new(shell::Binding {
                        service: service.clone(),
                        configuration: configuration.clone(),
                        input: method.input.as_ref().clone(),
                    }),
                ));
            }
            if selection.input == ToolInput::Web {
                web_bindings
                    .entry(selection.import.clone())
                    .or_default()
                    .push(service.clone());
            }
            native_services.push(service.clone());
            let mut description = selection.description.clone();
            if binding.contract() == &file_contract && selection.method == "readText" {
                description.push_str("\n\nReads Session attachment and archived tool-result resources. Pass page.next unchanged to this tool to continue.");
            }
            Ok(ToolRegistration {
                definition: ToolDefinition {
                    provider: None,
                    name: selection.name.clone(),
                    description,
                    input_schema,
                    output_schema: match selection.result {
                        ToolResult::Json => Some(method.output.as_ref().clone()),
                        ToolResult::Image | ToolResult::Computer => None,
                    },
                    freeform: None,
                },
                nesting: if selection.nestable {
                    ToolNesting::Nestable
                } else {
                    ToolNesting::DirectOnly
                },
                semantics: if method.mode == MethodMode::Mutation {
                    ToolSemantics::ExclusiveStep
                } else {
                    ToolSemantics::Parallel
                },
                handler: ToolHandler::Prepared(Arc::new(service)),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut catalog = ToolCatalog::new(registrations.into_iter().chain(additional))
        .map_err(|_| "agent_tool_catalog_invalid")?;
    for (name, binding) in skill_bindings {
        catalog = catalog
            .with_request_binding([name].into(), binding)
            .map_err(|_| "agent_skill_binding_invalid")?;
    }
    for services in web_bindings.into_values() {
        let names = services
            .iter()
            .map(|service| service.selection.name.clone())
            .collect();
        catalog = catalog
            .with_request_binding(
                names,
                Arc::new(web::Binding {
                    services,
                    workers: workers.clone(),
                }),
            )
            .map_err(|_| "agent_web_binding_invalid")?;
    }
    for services in computer_bindings.into_values() {
        let names = services
            .iter()
            .map(|service| service.selection.name.clone())
            .collect();
        catalog = catalog
            .with_request_binding(
                names,
                Arc::new(computer::Binding {
                    services,
                    workers: workers.clone(),
                }),
            )
            .map_err(|_| "agent_computer_binding_invalid")?;
    }
    for (name, binding) in shell_bindings {
        catalog = catalog
            .with_request_binding([name].into(), binding)
            .map_err(|_| "agent_shell_binding_invalid")?;
    }
    Ok(Catalog {
        tools: catalog,
        basis,
        editing,
        planning,
        executor: Arc::new(ApprovalExecutor {
            services: native_services,
        }),
    })
}
struct ApprovalExecutor {
    services: Vec<Service>,
}

impl maka_agent_engine::NativeApprovalExecutor for ApprovalExecutor {
    fn prepare(
        &self,
        pending: maka_agent_facts::native_approval::NativeApprovalPending,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> futures_util::future::BoxFuture<'_, Result<PreparedEffect, ToolError>> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolError::Failed(
                    "native approval reconstruction cancelled".into(),
                ));
            }
            let data = NativeApprovalData::decode(pending.native.clone())?;
            if pending.invocation != context.invocation
                || pending.operation_id != context.operation_id
            {
                return Err(ToolError::Persistence(
                    "native approval identity differs".into(),
                ));
            }
            let mut service = self
                .services
                .iter()
                .find(|service| {
                    service.selection == data.selected.selection
                        && service.binding == data.selected.binding
                })
                .cloned()
                .ok_or_else(|| {
                    ToolError::Failed("native approval binding is stale or unavailable".into())
                })?;
            match data.capture {
                NativeApprovalCapture::Web { basis } => service.web_basis = Some(basis),
                NativeApprovalCapture::Skill { tool_names } => {
                    service.tool_names = Arc::new(tool_names)
                }
                NativeApprovalCapture::Ordinary {} => {}
            }
            let store = Arc::new(maka_agent_authority::permissions::execution(
                &service.store,
                &context.invocation,
                context.execution.as_deref(),
            )?);
            let configuration =
                maka_agent_authority::permissions::live(&store, &context.invocation).await?;
            let original_configuration = store
                .invocation_configuration(&context.invocation)
                .await
                .map_err(|error| ToolError::Persistence(error.to_string()))?
                .ok_or_else(|| {
                    ToolError::Persistence(
                        "native approval invocation configuration unavailable".into(),
                    )
                })?;
            if original_configuration.cwd != configuration.workspace.path
                || original_configuration.workspace_identity.as_ref()
                    != Some(&configuration.workspace.identity)
                || original_configuration
                    .workspace_binding
                    .map(|binding| binding.id)
                    != Some(configuration.binding.id)
            {
                return Err(ToolError::Failed(
                    "native approval workspace binding changed".into(),
                ));
            }
            if configuration
                .tools
                .as_ref()
                .is_some_and(|names| !names.contains(&service.selection.name))
            {
                return Err(ToolError::Failed(
                    "native approval tool permission withdrawn".into(),
                ));
            }
            if let Some(basis) = &service.web_basis {
                let capture = web::capture(&service, &context, &cancellation).await?;
                if !capture.available
                    || capture.basis != *basis
                    || (service.selection.method == "search"
                        && (capture.source != maka_web_api::settings::Source::Tavily
                            || !capture.credential_configured))
                {
                    return Err(ToolError::Failed(
                        "native approval Web capture is stale or unavailable".into(),
                    ));
                }
            }
            let original = store
                .native_approval_dispatch(&pending)
                .await
                .map_err(|error| ToolError::Persistence(error.to_string()))?;
            let maka_agent_facts::event::Fact::ToolDispatched {
                operation_id,
                name,
                input,
                call,
                ..
            } = original.event.fact
            else {
                return Err(ToolError::Persistence(
                    "native approval dispatch invalid".into(),
                ));
            };
            if original.sequence != pending.dispatch.sequence
                || original.event.id != pending.dispatch.event_id
                || original.event.invocation != context.invocation
                || operation_id != context.operation_id
                || name != service.selection.name
                || !matches!(
                    call.origin,
                    maka_agent_facts::tool_call::ToolOrigin::Provider { .. }
                )
            {
                return Err(ToolError::Persistence(
                    "native approval original dispatch differs".into(),
                ));
            }
            let input = service.input_projection.decode(input).map_err(|error| {
                ToolError::Failed(format!("native approval original input invalid: {error:?}"))
            })?;
            Ok(PreparedEffect::new(move |cancellation| {
                service.execute(input, context, store, cancellation)
            }))
        })
    }
}

#[derive(Clone)]
struct Service {
    web_basis: Option<maka_web_api::contract::Basis>,
    tool_names: Arc<Vec<(String, Option<EditingTools>)>>,
    services: NativeServices,
    store: Arc<RootStore>,
    binding: String,
    target: String,
    selection: ServiceTool,
    input_projection: Projection,
    title_kind: Option<title::Kind>,
    mode: MethodMode,
}
impl ToolPreparer for Service {
    fn names(&self) -> Vec<String> {
        vec![self.selection.name.clone()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let self_store = self.store.clone();
        let service_capture = self.web_basis.clone();
        let captured_names = self.tool_names.as_ref().clone();
        let tool_names = self.tool_names.clone();
        let web_basis = self.web_basis.clone();
        let services = self.services.clone();
        let store = self.store.clone();
        let binding = self.binding.clone();
        let target = self.target.clone();
        let selection = self.selection.clone();
        let input_projection = self.input_projection;
        let default_title = self.title_kind;
        let mode = self.mode;
        Box::pin(async move {
            #[cfg(test)]
            eprintln!(
                "native approval stage=prepare_enter operation={}",
                context.operation_id
            );
            let store = Arc::new(
                store
                    .session_for_execution(
                        context
                            .execution
                            .as_deref()
                            .ok_or(ToolRejection::Unavailable)?,
                        &context.invocation,
                    )
                    .map_err(|error| ToolRejection::PreparationFailed {
                        message: error.to_string(),
                    })?,
            );
            if name != selection.name {
                return Err(ToolRejection::Unavailable);
            }
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            // T1 records the exact model arguments, before native projection.
            let confirmation_input = input.clone();
            let input = input_projection.decode(input)?;
            // No request or effect is admitted until the existing ToolJournal T1.
            let title = selection
                .title
                .clone()
                .or_else(|| {
                    if selection.input == ToolInput::Shell {
                        shell::title(&input)
                    } else if selection.input == ToolInput::Skill {
                        maka_skills_api::model_title(&selection.method, &input)
                    } else {
                        (selection.result == ToolResult::Computer)
                            .then(|| computer::title(&selection.method, &input))
                    }
                })
                .or_else(|| default_title.and_then(|kind| kind.render(&input)));
            let presentation = selection.presentation.clone();
            let service = Service {
                web_basis,
                tool_names,
                services,
                store: self_store,
                binding: binding.clone(),
                target: target.clone(),
                selection: selection.clone(),
                input_projection,
                title_kind: default_title,
                mode,
            };
            #[cfg(test)]
            let diagnostic_operation = context.operation_id.clone();
            let execute_context = context.clone();
            let execute_store = store.clone();
            let approved = move |cancellation| {
                service.execute(input, execute_context, execute_store, cancellation)
            };
            let prepared = if selection.confirmation == ToolConfirmation::Required {
                let native = NativeApprovalData {
                    selected: SelectedTool {
                        selection: selection.clone(),
                        binding: binding.clone(),
                    },
                    capture: match selection.input {
                        ToolInput::Web => NativeApprovalCapture::Web {
                            basis: service_capture.ok_or_else(|| {
                                ToolRejection::PreparationFailed {
                                    message: "Web tool has no request capture".into(),
                                }
                            })?,
                        },
                        ToolInput::Skill => NativeApprovalCapture::Skill {
                            tool_names: captured_names,
                        },
                        ToolInput::Json | ToolInput::Shell => NativeApprovalCapture::Ordinary {},
                    },
                };
                PreparedEffect::native_approval(
                    move |cancellation| {
                        Box::pin(async move {
                            approval::establish(
                                store,
                                context,
                                approval::Selection {
                                    name: &selection.name,
                                    method: &selection.method,
                                    binding: &binding,
                                    service: &target,
                                },
                                &confirmation_input,
                                serde_json::to_value(native)
                                    .map_err(|error| ToolError::Persistence(error.to_string()))?,
                                cancellation,
                            )
                            .await
                        })
                    },
                    approved,
                )
            } else {
                PreparedEffect::new(approved)
            };
            let prepared = match presentation {
                Some(key) => prepared.presented(key),
                None => prepared,
            };
            #[cfg(test)]
            eprintln!(
                "native approval stage=prepare_return operation={}",
                diagnostic_operation
            );
            Ok(match title {
                Some(title) => prepared.titled(title),
                None => prepared,
            })
        })
    }
}
impl Service {
    fn execute(
        self,
        input: Value,
        context: ToolCallContext,
        store: Arc<SessionStore>,
        cancellation: CancellationToken,
    ) -> maka_agent_facts::tools::ToolFuture<ToolSuccess> {
        let Self {
            web_basis,
            tool_names,
            services,
            selection,
            mode,
            ..
        } = self;
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolError::Failed(
                    "service call cancelled before admission".into(),
                ));
            }
            let input = match selection.input {
                ToolInput::Json => input,
                ToolInput::Shell => {
                    let mut input = input;
                    if let Some(fields) = input.as_object_mut() {
                        fields.remove("title");
                    }
                    input
                }
                ToolInput::Web => {
                    let basis = web_basis.ok_or_else(|| {
                        ToolError::Failed("Web tool has no request capture".into())
                    })?;
                    serde_json::json!({"input":input,"basis":basis})
                }
                ToolInput::Skill => {
                    let configuration =
                        maka_agent_authority::permissions::live(&store, &context.invocation)
                            .await?;
                    let editing = store
                        .invocation_configuration(&context.invocation)
                        .await
                        .map_err(|error| ToolError::Failed(error.to_string()))?
                        .ok_or_else(|| {
                            ToolError::Failed("Skill call has no invocation configuration".into())
                        })?
                        .editing_tools;
                    let names: Vec<_> = tool_names
                        .iter()
                        .filter(|(name, style)| {
                            (editing.is_none() || style.is_none() || editing == *style)
                                && configuration
                                    .tools
                                    .as_ref()
                                    .is_none_or(|allowed| allowed.contains(name))
                        })
                        .map(|(name, _)| name)
                        .collect();
                    serde_json::json!({"input": input, "tools": names, "workspace":configuration.workspace})
                }
            };
            let invocation = context.invocation.clone();
            let operation = operation_id(&context);
            let execution = context
                .execution
                .clone()
                .ok_or_else(|| ToolError::Persistence("Execution custody unavailable".into()))?;
            let request = services
                .request_with_execution(
                    Identity::Agent {
                        invocation: context.invocation,
                        operation_id: Some(context.operation_id),
                    },
                    cancellation.clone(),
                    execution,
                )
                .map_err(ToolError::Failed)?;
            // Keep original request custody even if a native descriptor panics.
            let mut observation = None;
            let result = {
                let mut business = Box::pin(
                    AssertUnwindSafe(async {
                        match mode {
                            MethodMode::Query => {
                                let result = request
                                    .call(
                                        &selection.import,
                                        0,
                                        selection.method,
                                        input,
                                        Attachments::default(),
                                    )
                                    .map_err(ToolError::Failed)?
                                    .await
                                    .map_err(ToolError::Failed)?;
                                Ok(ToolSuccess::from(result))
                            }
                            MethodMode::Mutation => {
                                let language = store
                                    .invocation_configuration(&invocation)
                                    .await
                                    .map_err(|error| ToolError::Failed(error.to_string()))?
                                    .ok_or_else(|| {
                                        ToolError::Failed(
                                            "Service call has no invocation configuration".into(),
                                        )
                                    })?
                                    .language;
                                let observer = request
                                    .mutate(
                                        &selection.import,
                                        0,
                                        selection.method,
                                        input,
                                        operation,
                                        Attachments::default(),
                                    )
                                    .map_err(ToolError::Failed)?;
                                // This outer error is admission refusal, not an accepted
                                // effect result. Scope.finish still must confirm cleanup;
                                // every accepted mutation returns its original typed receipt.
                                let reply = observer.await.map_err(ToolError::Failed)?;
                                observation = Some(Box::new(reply.clone()));
                                if selection.result == ToolResult::Computer {
                                    computer::project(&store, &invocation, reply, language).await
                                } else {
                                    mutation_result(reply, language)
                                }
                            }
                            MethodMode::Subscription => {
                                image::read(
                                    &request,
                                    &selection.import,
                                    selection.method.clone(),
                                    input,
                                    &cancellation,
                                )
                                .await
                            }
                        }
                    })
                    .catch_unwind(),
                );
                tokio::select! {
                    biased;
                    result = &mut business => result,
                    _ = request.scope().cancellation.cancelled() => {
                        // Reach the original cleanup budget even when the native
                        // callback has not returned. Dropping this observer never
                        // drops the Host's actual admitted job or its fence.
                        request.finish().await.map_err(ToolError::CleanupUnconfirmed)?;
                        // A completed parent Ticket precedes the original Host
                        // reply in the same owner turn. Keep that exact observer.
                        business.await
                    }
                }
            }
            .unwrap_or_else(|_| {
                Err(ToolError::OutcomeUnknown(
                    "native tool observation panicked".into(),
                ))
            });
            if let Err(message) = request.finish().await {
                return Err(match observation {
                    Some(observation) => ToolError::OperationCleanupUnconfirmed {
                        message,
                        observation,
                    },
                    None => ToolError::CleanupUnconfirmed(message),
                });
            }
            // finish() cancels the request itself; only the original
            // Tool token can distinguish a stopped run at publication.
            if selection.result == ToolResult::Image
                && result.is_ok()
                && cancellation.is_cancelled()
            {
                return Err(ToolError::Failed(
                    "Image tool cancelled before publication".into(),
                ));
            }
            match (result, observation) {
                (Err(ToolError::CleanupUnconfirmed(message)), Some(observation)) => {
                    Err(ToolError::OperationCleanupUnconfirmed {
                        message,
                        observation,
                    })
                }
                (result, _) => result,
            }
        })
    }
}

fn operation_id(context: &ToolCallContext) -> Uuid {
    let bytes = serde_json::to_vec(&(&context.invocation, &context.operation_id))
        .expect("Host tool identity");
    let digest = Sha256::digest(bytes);
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    // A deterministic nonnil UUID in the native Agent's actual caller namespace.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}
fn mutation_result(reply: OperationReply, language: Language) -> Result<ToolSuccess, ToolError> {
    let unknown = match language {
        Language::En => {
            "Native service result is unknown; inspect its original receipt before retrying."
        }
        Language::ZhCn => "原生服务结果未知；重试前请检查其原始回执。",
        Language::ZhTw => "原生服務結果未知；重試前請檢查其原始回執。",
    };
    match &reply.receipt {
        Receipt::Recorded { outcome, cleanup } => {
            if *cleanup != OperationCleanup::Confirmed {
                return Err(ToolError::CleanupUnconfirmed(
                    "native service cleanup is unconfirmed".into(),
                ));
            }
            match outcome {
                OperationOutcome::Returned { .. } => {
                    Ok(ToolOutput::Operation(Box::new(reply)).into())
                }
                OperationOutcome::Unknown { .. } | OperationOutcome::Unresolved => {
                    Err(ToolError::OperationUnknown {
                        message: unknown.into(),
                        observation: Box::new(reply),
                    })
                }
            }
        }
        Receipt::Unavailable { .. } => Err(ToolError::OperationUnknown {
            message: unknown.into(),
            observation: Box::new(reply),
        }),
        Receipt::NotRecorded => Err(ToolError::Failed(
            "native service operation was not recorded".into(),
        )),
    }
}

// Skills compare requirements with the actual workspace/request tool ceiling.
// Keeping this on the request binding also respects plans and editing styles.
struct SkillBinding(Service);
impl maka_tools::request::RequestBinding for SkillBinding {
    fn bind(
        &self,
        request: maka_tools::request::BindingRequest,
    ) -> maka_tools::request::BindingFuture {
        let mut service = self.0.clone();
        service.tool_names = Arc::new(
            request
                .available_tools
                .into_iter()
                .map(|name| (name, None))
                .collect(),
        );
        let name = service.selection.name.clone();
        Box::pin(async move {
            Ok(std::collections::BTreeMap::from([(
                name,
                maka_tools::request::BoundTool::Prepared(Arc::new(service) as Arc<dyn ToolPreparer>),
            )]))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_plugin_core::composition::InstanceId;
    use maka_plugin_core::contract::Transport;
    use maka_plugin_core::deployment::DeploymentRef;
    use maka_plugin_core::operation::{RecoveryContract, RecoveryProtocol, RecoveryRef};

    #[test]
    fn approval_descriptor_rejects_extra_authority_and_mismatched_capture() {
        let descriptor = serde_json::json!({
            "selected": { "selection": {
                "input": "json", "result": "json", "confirmation": "required",
                "name": "Read", "description": "Read file", "import": "Files", "method": "readText"
            }, "binding": "original" },
            "capture": { "kind": "ordinary" }
        });
        assert!(NativeApprovalData::decode(descriptor.clone()).is_ok());
        let mut extra = descriptor.clone();
        extra["execute"] = serde_json::json!({"method": "write"});
        assert!(NativeApprovalData::decode(extra).is_err());
        let mut extra = descriptor.clone();
        extra["capture"]["input"] = serde_json::json!({"path": "replacement"});
        assert!(NativeApprovalData::decode(extra).is_err());
        let mut mismatched = descriptor.clone();
        mismatched["selected"]["selection"]["input"] = "web".into();
        assert!(NativeApprovalData::decode(mismatched).is_err());
        let mut unapproved = descriptor;
        unapproved["selected"]["selection"]["confirmation"] = "preapproved".into();
        assert!(NativeApprovalData::decode(unapproved).is_err());
    }

    #[test]
    fn uncertain_service_projection_localizes_recovery_and_preserves_original_receipt() {
        let reference = RecoveryRef {
            source: DeploymentRef {
                state_domain: "a".repeat(64),
                deployment: Uuid::from_u128(1),
                revision: 3,
            },
            namespace: InstanceId(vec![Uuid::from_u128(2)]),
            export: "Service".into(),
            method: "apply".into(),
            operation: Uuid::from_u128(3),
            fingerprint: format!("sha256-{}", "b".repeat(64)),
            contract: RecoveryContract {
                name: "example.Service".into(),
                version: 1,
                transport: Transport::Remote,
                digest: format!("sha256-{}", "c".repeat(64)),
            },
            recovery: RecoveryProtocol::JournalV1,
        };
        reference.validate().unwrap();
        for receipt in [
            Receipt::Recorded {
                outcome: OperationOutcome::Unknown {
                    diagnostic: "原始诊断 / no reply".into(),
                },
                cleanup: OperationCleanup::Confirmed,
            },
            Receipt::Recorded {
                outcome: OperationOutcome::Unresolved,
                cleanup: OperationCleanup::Confirmed,
            },
            Receipt::Unavailable {
                diagnostic: "原始查询失败 / lookup failed".into(),
            },
        ] {
            let original = OperationReply {
                reference: reference.clone(),
                receipt,
            };
            for (language, original_receipt, retry) in [
                (Language::En, "original receipt", "retrying"),
                (Language::ZhCn, "原始回执", "重试"),
                (Language::ZhTw, "原始回執", "重試"),
            ] {
                let Err(ToolError::OperationUnknown {
                    message,
                    observation,
                }) = mutation_result(original.clone(), language)
                else {
                    panic!("uncertain receipt must remain an unknown operation");
                };
                assert!(message.contains(original_receipt) && message.contains(retry));
                assert_eq!(*observation, original);
            }
        }
    }
}
