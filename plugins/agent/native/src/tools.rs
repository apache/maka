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

mod computer;
pub(crate) mod image;
mod shell;
pub(crate) mod title;
mod web;
use crate::contract::{ServiceTool, ToolConfirmation, ToolInput, ToolResult};
use crate::owner::access::RunAccess;
use futures_util::FutureExt;
use maka_agent_authority::permissions::Access;
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
use maka_host_runtime::application::{NativeServices, ServiceTarget};

use maka_plugin_core::operation::OperationResult;
use maka_plugin_core::{
    contract::{Interface, MethodMode},
    operation::{OperationOutcome, OperationReply, Receipt},
};
use maka_tool_catalog::input::Projection;
use maka_tools::ToolCatalog;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{panic::AssertUnwindSafe, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, PartialEq)]
pub(crate) struct SelectedTool {
    history_reader: Option<HistoryReader>,
    selection: ServiceTool,
    binding: String,
    pub(crate) discovery_group: crate::contract::DiscoveryToolGroup,
}

/// The tool selected by the Agent's configuration, resolved through its current
/// authorized service slot. An admitted operation captures its own binding.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ServiceSelection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    history_reader: Option<HistoryReader>,
    selection: ServiceTool,
}

#[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HistoryReader {
    Other,
    File,
    Session,
}

impl HistoryReader {
    pub(crate) fn builtin(name: &str) -> Option<Self> {
        if name == "Read" {
            Some(Self::File)
        } else if maka_agent_facts::memory::is_recall_output(name) {
            Some(Self::Session)
        } else {
            None
        }
    }
}

/// Frozen declarations and binding evidence. These bytes are never live tool authority.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectionSnapshot {
    pub definitions: Vec<ToolDefinition>,
    pub direct_only: std::collections::BTreeSet<String>,
    pub services: Vec<ServiceSelection>,
    pub internal_bindings: std::collections::BTreeMap<String, Option<String>>,
}

impl SelectedTool {
    pub(crate) fn name(&self) -> &str {
        &self.selection.name
    }
    pub(crate) fn permits_approval(&self, name: &str, method: &str, binding: &str) -> bool {
        self.selection.name == name
            && self.selection.method == method
            && self.binding == binding
            && self.selection.confirmation == ToolConfirmation::Preapproved
    }
    pub(crate) fn declaration(&self) -> ServiceSelection {
        ServiceSelection {
            history_reader: self.history_reader,
            selection: self.selection.clone(),
        }
    }
    fn services(&self, services: &NativeServices) -> Result<NativeServices, String> {
        if services.binding(&self.selection.target)?.execution_basis() != self.binding {
            return Err("original native tool binding changed".into());
        }
        services.select_method(&self.selection.target, &self.selection.method)
    }
}

fn reads_agent_history(method: &str) -> bool {
    matches!(
        method,
        "memory"
            | "memories"
            | "execution"
            | "continuationAvailability"
            | "work"
            | "sessionRead"
            | "history"
            | "historyLandmarks"
            | "historyPrompt"
            | "historyRequests"
            | "source"
            | "search"
            | "toolImage"
            | "attachmentImage"
    )
}

impl ServiceSelection {
    pub(crate) fn name(&self) -> &str {
        &self.selection.name
    }

    pub(crate) fn history_alias(self) -> Option<(String, HistoryReader)> {
        self.history_reader.map(|kind| (self.selection.name, kind))
    }
    fn matches(&self, live: &SelectedTool) -> bool {
        let admitted = &self.selection;
        let current = &live.selection;
        admitted.name == current.name
            && admitted.target == current.target
            && admitted.method == current.method
            && admitted.input == current.input
            && admitted.result == current.result
            && admitted.confirmation == current.confirmation
            && admitted.nestable == current.nestable
    }
}

impl SelectionSnapshot {
    pub(crate) fn matches_service(&self, name: &str, actual: &[SelectedTool]) -> bool {
        let original = self.services.iter().find(|tool| tool.name() == name);
        let current = actual.iter().find(|tool| tool.name() == name);
        match (original, current) {
            (Some(original), Some(current)) => original.matches(current),
            (None, None) => true,
            _ => false,
        }
    }

    pub(crate) fn selected_service(
        &self,
        services: &NativeServices,
        actual: &[SelectedTool],
        name: &str,
    ) -> Result<Option<(SelectedTool, NativeServices)>, String> {
        let Some(original) = self
            .services
            .iter()
            .find(|selected| selected.name() == name)
        else {
            if actual.iter().any(|selected| selected.name() == name) {
                return Err("native tool is absent from the original Run selection".into());
            }
            return Ok(None);
        };
        let current = actual
            .iter()
            .find(|tool| original.matches(tool))
            .ok_or("original native tool declaration changed")?;
        Ok(Some((current.clone(), current.services(services)?)))
    }
    pub(crate) fn validate_recovery_service(
        &self,
        services: &NativeServices,
        actual: &[SelectedTool],
        intent: &maka_event_log::applications::intents::CallerIntent,
        execution: &maka_agent_facts::durable::ExecutionIdentity,
        operation_id: &str,
        selected: &(SelectedTool, NativeServices),
    ) -> Result<(), String> {
        let descriptor: NativeToolRecovery = serde_json::from_value(intent.recovery.clone())
            .map_err(|error| format!("original native tool descriptor is unavailable: {error}"))?;
        if descriptor.kind != "agent_native_tool"
            || descriptor.version != 1
            || descriptor.correlation.execution != *execution
            || descriptor.correlation.operation_id != operation_id
            || operation_uuid(execution, &descriptor.correlation.operation_id)
                != intent.reference.operation
            || descriptor.correlation.tool_use_id
                != maka_agent_facts::tool_call::tool_use_id(
                    execution.run_id,
                    &descriptor.correlation.operation_id,
                )
            || descriptor.target != descriptor.selection.target
            || descriptor.method != descriptor.selection.method
        {
            return Err("original native tool descriptor differs from its caller intent".into());
        }
        let current = &selected.0;
        if !self
            .services
            .iter()
            .any(|original| original.matches(current))
            || !actual.contains(current)
        {
            return Err("original native tool selection or declaration changed".into());
        }
        if descriptor.selection != current.selection || descriptor.binding != current.binding {
            return Err("original native tool scope differs from its caller intent".into());
        }
        let binding = services.binding(&descriptor.selection.target)?;
        if binding.consumer().instance() != &intent.consumer
            || binding.provider().instance() != &intent.reference.namespace
            || binding.export() != intent.reference.export
            || descriptor.method != intent.reference.method
            || binding.execution_basis() != descriptor.binding
        {
            return Err("original native tool provider binding changed".into());
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeToolRecovery {
    kind: String,
    version: u32,
    correlation: NativeToolCorrelation,
    selection: ServiceTool,
    binding: String,
    target: ServiceTarget,
    method: String,
    input: Value,
    resources: Value,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeToolCorrelation {
    execution: maka_agent_facts::durable::ExecutionIdentity,
    operation_id: String,
    tool_use_id: String,
}

/// Validated tool metadata used by Session setup and Run admission.
#[derive(Clone)]
pub(crate) struct Declarations(ToolCatalog);

impl Declarations {
    pub fn names(&self) -> Vec<String> {
        self.0.names()
    }

    pub fn contains(&self, name: &str) -> bool {
        self.0.contains(name)
    }

    pub fn definitions(&self) -> impl Iterator<Item = &ToolDefinition> {
        self.0.definitions()
    }

    pub fn direct_only_names(&self) -> Vec<String> {
        self.0.direct_only().names()
    }

    pub fn excluding(&self, names: &[&str]) -> Self {
        Self(self.0.excluding(names))
    }

    pub fn with_additional(
        self,
        declarations: impl IntoIterator<Item = ToolRegistration>,
    ) -> Result<Self, maka_tool_catalog::CatalogError> {
        self.0.with_additional(declarations).map(Self)
    }

    pub(crate) fn as_catalog(&self) -> &ToolCatalog {
        &self.0
    }
}

struct PreparedServiceTool {
    selected: SelectedTool,
    services: NativeServices,
    target: String,
    computer: bool,
    network_ceiling: bool,
    file_ceiling: bool,
    input_projection: Projection,
    title_kind: Option<title::Kind>,
    presentation: Option<String>,
    mode: MethodMode,
    shell_input: Option<Arc<Value>>,
}

/// Pre-validated, pre-compiled Host tool catalog reused across Runs without
/// re-inlining schemas or recompiling JSON Schema validators.
pub(crate) struct PreparedCatalog {
    run_base: ToolCatalog,
    services: Vec<PreparedServiceTool>,
    tool_names: ToolNames,
}

pub(crate) struct Catalog {
    pub tools: Declarations,
    pub prepared: PreparedCatalog,
    pub basis: Vec<SelectedTool>,
    /// Derived from actual bound contracts and methods, never display names.
    pub editing: Vec<(String, EditingTools)>,
}

impl PreparedCatalog {
    pub(crate) fn for_run(
        &self,
        configuration: Arc<maka_config::ConfigurationStore>,
        workers: tokio_util::task::TaskTracker,
        access: Arc<RunAccess>,
    ) -> Result<ToolCatalog, String> {
        let mut web_bindings = std::collections::BTreeMap::<ServiceTarget, Vec<Service>>::new();
        let mut shell_bindings = Vec::new();
        let mut skill_bindings = Vec::new();
        let mut handlers = Vec::with_capacity(self.services.len());
        for template in &self.services {
            let service = Service {
                services: template.services.clone(),
                access: access.clone(),
                binding: template.selected.binding.clone(),
                target: template.target.clone(),
                tool_names: self.tool_names.clone(),
                selection: template.selected.selection.clone(),
                computer: template.computer,
                network_ceiling: template.network_ceiling,
                file_ceiling: template.file_ceiling,
                input_projection: template.input_projection,
                title_kind: template.title_kind,
                presentation: template.presentation.clone(),
                mode: template.mode,
                web_basis: None,
                shell: None,
            };
            match template.selected.selection.input {
                ToolInput::Skill => skill_bindings.push((
                    template.selected.selection.name.clone(),
                    Arc::new(SkillBinding(service.clone())),
                )),
                ToolInput::Shell => shell_bindings.push((
                    template.selected.selection.name.clone(),
                    Arc::new(shell::Binding {
                        service: service.clone(),
                        configuration: configuration.clone(),
                        input: template
                            .shell_input
                            .clone()
                            .expect("shell service tool captures input schema"),
                    }),
                )),
                ToolInput::Web => web_bindings
                    .entry(template.selected.selection.target.clone())
                    .or_default()
                    .push(service.clone()),
                ToolInput::Json => {}
            }
            handlers.push((
                template.selected.selection.name.clone(),
                ToolHandler::Prepared(Arc::new(service)),
            ));
        }
        let mut catalog = self
            .run_base
            .clone()
            .with_rebound_handlers(handlers)
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
        for (name, binding) in shell_bindings {
            catalog = catalog
                .with_request_binding([name].into(), binding)
                .map_err(|_| "agent_shell_binding_invalid")?;
        }
        Ok(catalog)
    }
}

pub(crate) fn catalog(
    services: NativeServices,
    selected: &[ServiceTool],
    additional: Vec<ToolRegistration>,
) -> Result<Catalog, String> {
    let mut basis = Vec::new();
    let mut prepared_services = Vec::with_capacity(selected.len());
    let file_contract = maka_workspace_api::files::contract();
    let editing: Vec<_> = selected
        .iter()
        .filter_map(|selection| {
            let binding = services.binding(&selection.target).ok()?;
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
    let computer_contract = maka_workspace_api::computer::contract();
    let web_contract = maka_web_api::contract();
    let skill_contract = maka_skills_api::contract();
    let agent_contract = maka_agent_api::contract::contract();
    let questions_contract = maka_interactions_api::questions::contract();
    let process_contract = maka_workspace_api::processes::contract();
    let deployment_contract =
        maka_plugin_core::deployment::management::deployment_manager_contract();
    let tool_names = ToolNames::Configured(
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
            .collect::<Vec<_>>()
            .into(),
    );
    let registrations = selected
        .iter()
        .map(|selection| {
            let binding = services.binding(&selection.target)?;
            let Interface::Service { methods } = &binding.contract().interface else {
                return Err("agent_tool_contract_invalid".to_owned());
            };
            let contract = binding.contract();
            let method = methods
                .get(&selection.method)
                .ok_or("agent_tool_method_unavailable")?;
            if method.resources.values().any(|resource| !resource.optional) {
                return Err("agent_tool_required_resources_unavailable".into());
            }
            // Tool aliases can change. The bound service and method supply both display meanings.
            use crate::contract::DiscoveryToolGroup as Group;
            use title::Kind;
            let (title_kind, discovery_group) = if contract == &file_contract {
                match selection.method.as_str() {
                    "read" => (Some(Kind::Read), Group::ReadFiles),
                    "write" => (Some(Kind::Write), Group::ModifyFiles),
                    "edit" => (Some(Kind::Edit), Group::ModifyFiles),
                    "applyPatch" => (Some(Kind::Patch), Group::ModifyFiles),
                    _ => (None, Group::Other),
                }
            } else if contract == &web_contract {
                match selection.method.as_str() {
                    "fetch" => (Some(Kind::Fetch), Group::Web),
                    "search" => (Some(Kind::Search), Group::Web),
                    _ => (None, Group::Other),
                }
            } else if contract == &agent_contract {
                match selection.method.as_str() {
                    "create" | "sessionCreate" => (Some(Kind::CreateSession), Group::Sessions),
                    "fork" => (Some(Kind::ForkSession), Group::Sessions),
                    "send" | "sessionSend" => (Some(Kind::SendSession), Group::Sessions),
                    "sessionList" | "sessionRead" => (None, Group::History),
                    "sessionManage" | "respond" | "sessionStop" | "presets" | "preset"
                    | "createPreset" | "updatePreset" | "deletePreset" => (None, Group::Sessions),
                    _ => (None, Group::Other),
                }
            } else if contract == &process_contract {
                (None, Group::Commands)
            } else if contract == &computer_contract {
                (None, Group::Desktop)
            } else if contract == &deployment_contract && method.mode == MethodMode::Mutation {
                (None, Group::PluginManagement)
            } else {
                (None, Group::Other)
            };
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
            let selected = SelectedTool {
                discovery_group,
                history_reader: if contract == &file_contract && selection.method == "read" {
                    Some(HistoryReader::File)
                } else if contract == &agent_contract && reads_agent_history(&selection.method) {
                    Some(HistoryReader::Session)
                } else if HistoryReader::builtin(&selection.name).is_some() {
                    Some(HistoryReader::Other)
                } else {
                    None
                },
                selection: selection.clone(),
                binding: binding.execution_basis().into(),
            };
            let presentation = selection.presentation.clone().or_else(|| {
                (contract == &agent_contract
                    || contract == &deployment_contract
                    || contract == &questions_contract
                    || contract == &computer_contract
                    || contract == &skill_contract
                    || (contract == &process_contract && selection.method == "health"))
                    .then(|| format!("{}@{}/{}", contract.name, contract.version, selection.method))
            });
            let target = format!(
                "{} · {} v{} · {} / {} · {}",
                selection.target.name(),
                binding.contract().name,
                binding.contract().version,
                serde_json::to_string(binding.provider().instance()).expect("instance identity"),
                binding.export(),
                binding
                    .provider()
                    .remote_target()
                    .map_or("local", |target| target.deployment.as_str())
            );
            prepared_services.push(PreparedServiceTool {
                services: selected.services(&services)?,
                selected: selected.clone(),
                target,
                computer: binding.contract().name == computer_contract.name
                    && binding.contract().version == 1,
                network_ceiling: selection.input == ToolInput::Web || contract == &process_contract,
                file_ceiling: contract == &file_contract
                    || (contract == &process_contract
                        && matches!(selection.method.as_str(), "execute" | "writeStdin")),
                input_projection,
                title_kind,
                presentation,
                mode: method.mode,
                shell_input: (selection.input == ToolInput::Shell)
                    .then(|| Arc::new(method.input.as_ref().clone())),
            });
            basis.push(selected);
            let mut description = selection.description.clone();
            if binding.contract() == &file_contract && selection.method == "read" {
                description.push_str("\n\nAlso reads Maka resources (maka://session/<id>, maka://session/<id>/tool-results/<event-id>, attachment:<id>, archive:<event-id>). Pass page.next unchanged to continue reading.");
            }
            if contract == &process_contract {
                let guidance = match selection.method.as_str() {
                    "execute" => "\n\nFor slow or long-running commands, set run_in_background: true to start a background process and return a snapshot with ref for ProcessRead, ProcessInput, BackgroundTaskHealth or ProcessStop, or set timeout_ms to enforce a deadline.",
                    "stop" => "\n\nPass the ref from a background Shell process snapshot (run_in_background: true).",
                    _ => "",
                };
                description.push_str(guidance);
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
                handler: ToolHandler::Declaration(selection.name.clone()),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let compiled = ToolCatalog::new(registrations.into_iter().chain(additional))
        .map_err(|_| "agent_tool_catalog_invalid")?;
    let run_base = compiled
        .clone()
        .with_always_visible(
            &editing
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
        )
        .map_err(|_| "agent_tool_catalog_invalid")?;
    Ok(Catalog {
        tools: Declarations(compiled),
        prepared: PreparedCatalog {
            run_base,
            services: prepared_services,
            tool_names,
        },
        basis,
        editing,
    })
}
#[derive(Clone)]
enum ToolNames {
    Configured(Arc<[(String, Option<EditingTools>)]>),
    Ceiling(Arc<[String]>),
}
impl ToolNames {
    fn iter(&self) -> impl Iterator<Item = (&str, Option<EditingTools>)> {
        let (configured, ceiling): (&[(String, Option<EditingTools>)], &[String]) = match self {
            Self::Configured(names) => (names, &[]),
            Self::Ceiling(names) => (&[], names),
        };
        configured
            .iter()
            .map(|(name, style)| (name.as_str(), *style))
            .chain(ceiling.iter().map(|name| (name.as_str(), None)))
    }
}

#[derive(Clone)]
struct Service {
    shell: Option<maka_agent_facts::configuration::policy::ShellPolicy>,
    web_basis: Option<maka_web_api::contract::Basis>,
    tool_names: ToolNames,
    services: NativeServices,
    access: Arc<RunAccess>,
    binding: String,
    target: String,
    selection: ServiceTool,
    computer: bool,
    /// Host Web effects and the workspace process tools ask for network per
    /// request, so their floor carries the Run's network approval ceiling.
    network_ceiling: bool,
    /// The workspace file and process tools ask for file writes per call, so
    /// their floor carries the Run's file approval ceiling.
    file_ceiling: bool,
    input_projection: Projection,
    title_kind: Option<title::Kind>,
    presentation: Option<String>,
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
        let service = self.clone();
        Box::pin(async move {
            let access = service.access.clone();
            access.check_tool(&context, &name).await.map_err(|error| {
                ToolRejection::PreparationFailed {
                    message: error.to_string(),
                }
            })?;
            let selection = service.selection.clone();
            let default_title = service.title_kind;
            let input_projection = service.input_projection;
            if name != selection.name {
                return Err(ToolRejection::Unavailable);
            }
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            let confirmation_input = input.clone();
            let input = input_projection.decode(input)?;
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
            let presentation = service.presentation.clone();
            let approval = if selection.confirmation == ToolConfirmation::Required {
                let target = access.target_for_context(&context).await.map_err(|error| {
                    ToolRejection::PreparationFailed {
                        message: error.to_string(),
                    }
                })?;
                let approval = if matches!(
                    target,
                    maka_agent_facts::durable::AuthorizationObligation::Tool { .. }
                ) {
                    access
                        .establish_service(
                            &context,
                            &selection.name,
                            &selection.method,
                            &service.binding,
                            &service.target,
                            &confirmation_input,
                            &cancellation,
                        )
                        .await
                        .map(|(_, approval)| approval)
                } else {
                    access
                        .confirm_service(
                            &context,
                            &selection.name,
                            &selection.method,
                            &service.binding,
                            &service.target,
                            &confirmation_input,
                            &cancellation,
                        )
                        .await
                }
                .map_err(|error| ToolRejection::PreparationFailed {
                    message: error.to_string(),
                })?;
                Some(approval)
            } else {
                None
            };
            let prepared =
                PreparedEffect::new(move |cancel| service.execute(input, context, access, cancel));
            let prepared = match approval {
                Some(id) => prepared.requiring_approval(id),
                None => prepared,
            };
            let prepared = match presentation {
                Some(key) => prepared.presented(key),
                None => prepared,
            };
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
        access: Arc<RunAccess>,
        cancellation: CancellationToken,
    ) -> maka_agent_facts::tools::ToolFuture<ToolSuccess> {
        let Self {
            shell,
            web_basis,
            tool_names,
            services,
            binding,
            selection,
            mode,
            computer,
            network_ceiling,
            file_ceiling,
            ..
        } = self;
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolError::Failed(
                    "service call cancelled before admission".into(),
                ));
            }
            access.check_tool(&context, &selection.name).await?;
            let input = match selection.input {
                ToolInput::Json => input,
                ToolInput::Shell => {
                    let mut input = input;
                    if let Some(fields) = input.as_object_mut() {
                        fields.remove("title");
                        fields.insert(
                            "shell".into(),
                            serde_json::to_value(shell.ok_or_else(|| {
                                ToolError::Failed("Shell tool has no request capture".into())
                            })?)
                            .map_err(|error| ToolError::Failed(error.to_string()))?,
                        );
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
                    let configuration = access.live_configuration().await?;
                    let editing = match &access.spec().backend {
                        maka_agent_facts::durable::BackendSpec::Model { descriptor, .. } => {
                            let owner_model: crate::model::AcceptedModel =
                                serde_json::from_slice(&access.content(descriptor.clone()).await?)
                                    .map_err(|error| ToolError::Persistence(error.to_string()))?;
                            owner_model.editing_tools
                        }
                        maka_agent_facts::durable::BackendSpec::Executor { .. } => None,
                        maka_agent_facts::durable::BackendSpec::Historical {} => {
                            return Err(ToolError::Failed(
                                "historical runs cannot execute native tools".into(),
                            ));
                        }
                    };
                    let names: Vec<_> = tool_names
                        .iter()
                        .filter(|(name, style)| {
                            (editing.is_none() || style.is_none() || editing == *style)
                                && configuration.tools.as_ref().is_none_or(|allowed| {
                                    allowed.iter().any(|allowed| allowed.as_str() == *name)
                                })
                        })
                        .map(|(name, _)| name)
                        .collect();
                    serde_json::json!({"input": input, "tools": names, "workspace":configuration.workspace})
                }
            };
            let operation = operation_uuid(&context.execution, &context.operation_id);
            let correlation = NativeToolCorrelation {
                execution: context.execution.clone(),
                operation_id: context.operation_id.clone(),
                tool_use_id: context.tool_use_id(),
            };
            let (base, approval) = if computer {
                (access.workspace_sandbox_floor().await?, None)
            } else if file_ceiling {
                access.file_approval_floors(&context.call.origin).await?
            } else {
                (access.sandbox_floor(&context.call.origin).await?, None)
            };
            let (mut floor, file_approval_base) = match approval {
                Some(approval) => (approval, (selection.method == "writeStdin").then_some(base)),
                None => (base, None),
            };
            let capsule = access
                .native_call(
                    context.clone(),
                    selection.name.clone(),
                    file_approval_base,
                    cancellation.clone(),
                    computer,
                )
                .await?;
            if network_ceiling && let maka_sandbox::Sandbox::Managed { network, .. } = &mut floor {
                // Network still requires a grant from the same tool family. The
                // ceiling is independent of the preset's base network, which a
                // process keeps until one applies. Process controls share it so
                // a PTY launched with a grant stays usable.
                *network = access.spec().network_approval_ceiling().clone();
            }
            let request = services
                .request_with_work_and_context(
                    Identity::Agent {
                        execution: context.execution.clone(),
                        operation_id: Some(context.operation_id.clone()),
                    },
                    cancellation.clone(),
                    access.custody().clone(),
                    capsule,
                )
                .map_err(ToolError::Failed)?
                .with_sandbox_floor(&floor)
                .map_err(ToolError::Failed)?;
            // Keep original request custody even if a native descriptor panics.
            let mut observation = None;
            let result = {
                let mut business = Box::pin(
                    AssertUnwindSafe(async {
                        match mode {
                            MethodMode::Query => {
                                let result = request
                                    .call_target(
                                        &selection.target,
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
                                let language = access.spec().language;
                                let resources =
                                    maka_host_runtime::application::CallResources::default();
                                let descriptors =
                                    resources.descriptors().map_err(ToolError::Failed)?;
                                let recovery = serde_json::to_value(NativeToolRecovery {
                                    kind: "agent_native_tool".into(),
                                    version: 1,
                                    correlation,
                                    selection: selection.clone(),
                                    binding,
                                    target: selection.target.clone(),
                                    method: selection.method.clone(),
                                    input: input.clone(),
                                    resources: serde_json::json!({
                                        "descriptors": descriptors,
                                        "reacquisition": {"kind": "none"},
                                    }),
                                })
                                .map_err(|error| ToolError::Failed(error.to_string()))?;
                                let observer = request
                                    .begin_mutation_target(
                                        &selection.target,
                                        selection.method,
                                        input,
                                        operation,
                                        recovery,
                                        resources,
                                    )
                                    .map_err(ToolError::Failed)?;
                                // This outer error is admission refusal, not an accepted
                                // effect result. Scope.finish still must confirm cleanup;
                                // accepted mutations retain their original completion channel.
                                let mutation = observer.await.map_err(ToolError::Failed)?;
                                let reference = mutation.reference.clone();
                                let completion = mutation.completion().await;
                                let reply = completion.reply;
                                if reply.reference != reference {
                                    return Err(ToolError::OutcomeUnknown(
                                        "Host mutation completion differs from its original reference"
                                            .into(),
                                    ));
                                }
                                observation = Some(Box::new(reply.clone()));
                                if let Err(message) = completion.cleanup {
                                    return Err(ToolError::OperationCleanupUnconfirmed {
                                        message,
                                        observation: Box::new(reply),
                                    });
                                }
                                if selection.result == ToolResult::Computer {
                                    computer::project(&access, reply, language).await
                                } else {
                                    mutation_result(reply, language)
                                }
                            }
                            MethodMode::Subscription => {
                                image::read(
                                    &request,
                                    &selection.target,
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
            if mode == MethodMode::Subscription && result.is_ok() && cancellation.is_cancelled() {
                return Err(ToolError::Failed(
                    "Tool subscription cancelled before publication".into(),
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

pub(crate) fn operation_uuid(
    execution: &maka_agent_facts::durable::ExecutionIdentity,
    operation_id: &str,
) -> Uuid {
    let bytes = serde_json::to_vec(&(execution, operation_id)).expect("Host tool identity");
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
            "The operation result is unknown. Check the current state and continue from there."
        }
        Language::ZhCn => "操作结果尚未确认，请检查当前状态后继续。",
        Language::ZhTw => "操作結果尚未確認，請檢查目前狀態後繼續。",
    };
    match &reply.receipt {
        Receipt::Recorded { outcome, .. } => match outcome {
            OperationOutcome::Returned { result } => {
                let failed = matches!(result, OperationResult::Failure { .. });
                Ok(ToolSuccess::from(ToolOutput::Operation(Box::new(reply)))
                    .reporting_error(failed))
            }
            OperationOutcome::NotExecuted { .. } => {
                Ok(ToolSuccess::from(ToolOutput::Operation(Box::new(reply))).reporting_error(true))
            }
            OperationOutcome::Unknown { .. } | OperationOutcome::Unresolved => {
                Err(ToolError::OperationUnknown {
                    message: unknown.into(),
                    observation: Box::new(reply),
                })
            }
        },
        Receipt::Unavailable { .. } => Err(ToolError::OperationUnknown {
            message: unknown.into(),
            observation: Box::new(reply),
        }),
        Receipt::NotRecorded => Err(ToolError::OperationUnknown {
            message: unknown.into(),
            observation: Box::new(reply),
        }),
    }
}

// Skills compare requirements with the actual workspace/request tool ceiling.
// Keeping this on the request binding also respects editing styles.
struct SkillBinding(Service);
impl maka_tools::request::RequestBinding for SkillBinding {
    fn bind(
        &self,
        request: maka_tools::request::BindingRequest,
    ) -> maka_tools::request::BindingFuture {
        let mut service = self.0.clone();
        service.tool_names = ToolNames::Ceiling(request.available_tools);
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
    use super::{SelectedTool, SelectionSnapshot};
    use serde_json::json;

    #[test]
    fn existing_tool_declaration_uses_current_binding_for_the_same_method() {
        let selection = json!({
            "name": "ModelList",
            "description": "List models.",
            "target": {"kind": "export", "name": "agent"},
            "method": "models",
            "result": "json",
            "confirmation": "preapproved"
        });
        let stored = serde_json::from_value::<SelectionSnapshot>(json!({
            "definitions": [],
            "directOnly": [],
            "services": [{
                "selection": selection,
                "binding": "sha256:ac28b16a6969b0d128053a6a8610f4ada2322ac005feec42869ed31343d4f17c"
            }],
            "internalBindings": {}
        }))
        .unwrap();
        let mut live = SelectedTool {
            history_reader: None,
            selection: serde_json::from_value(selection).unwrap(),
            discovery_group: crate::contract::DiscoveryToolGroup::Other,
            binding: "sha256:20379da95853ba9498588b280113bf12e6e59301840666f025af97879bb548ee"
                .into(),
        };
        assert!(stored.matches_service("ModelList", std::slice::from_ref(&live)));

        live.selection.method = "list".into();
        assert!(!stored.matches_service("ModelList", &[live]));
    }
}
