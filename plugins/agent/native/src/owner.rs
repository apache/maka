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

use crate::{
    Configuration, IMPLEMENTATION, NativeContext, configuration_schema, contract::*, workspace,
};
use futures_util::future::BoxFuture;
use maka_agent_engine::{Engine, RunError, RunInput, RunWork};

mod assistant;
mod attachments;
mod auxiliary;
mod compaction;
mod computer_apps;
mod context;
mod execution;
mod files;
mod fork;
mod goal;
mod graph;
mod imports;
mod interactions;
mod lifecycle;
mod notifications;
mod plan;
mod preferences;
mod projects;
pub(crate) use notifications::ReturnRoute;
mod bot;
mod git;
mod global_instructions;
mod mcp;
mod patches;
mod queue;
mod recall;
mod recap;
mod runs;
mod scheduler;
mod skills;
mod title;
mod todo;
mod work;
mod worktrees;
use maka_agent_facts::composition::SourceKind;
use maka_agent_facts::composition::SourceRevision;
use maka_agent_facts::configuration::policy::RuntimePolicySnapshot;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::execution::*;
use maka_agent_facts::input::DeliveredMessage;
use maka_agent_facts::input::MessageInput;
use maka_agent_facts::language::{Language, LanguagePreference};
use maka_agent_facts::message::*;
use maka_config::ConfigurationStore;
use maka_event_log::{RootStore, sessions::SessionRecord};
use maka_model::ModelExecutor;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

use maka_agent_api::session::{ResolvedConfiguration, StoredSessionConfiguration};

pub(crate) fn resolve_session(
    session: SessionRecord<StoredSessionConfiguration>,
) -> Result<SessionRecord<ResolvedConfiguration>, String> {
    maka_agent_authority::permissions::resolve_session(session)
        .map_err(|_| "agent_workspace_binding_unavailable".into())
}

/// Frozen accepted message prerequisites, interpreted only by this Agent.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageBasis {
    #[serde(skip)]
    mcp_catalog: Option<Arc<crate::mcp::Catalog>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mcp_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    compaction_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    graph: Option<maka_graph::Epoch>,
    #[serde(default, skip_serializing_if = "is_agent_collaboration")]
    collaboration_mode: CollaborationMode,
    #[serde(default, skip_serializing_if = "BackgroundKind::is_schedule")]
    background_kind: BackgroundKind,
    #[serde(default)]
    tool_discovery: bool,
    #[serde(default)]
    allowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    background: Option<ScheduledTarget>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    internal_tools: Arc<Vec<maka_agent_facts::tools::ToolDefinition>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    internal_bindings: Arc<BTreeMap<String, Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    behavior: Option<SystemPrompt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<crate::model::AcceptedModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    executor: Option<crate::executor::Accepted>,
    workspace: Workspace,
    binding: maka_agent_facts::workspace::BindingStamp,
    fingerprint: String,
    tools: Arc<Vec<crate::tools::SelectedTool>>,
    #[serde(default, skip_serializing_if = "Language::is_english")]
    language: Language,
}
impl maka_agent_engine::NativeActivationBasis for MessageBasis {
    fn checkpoint_value(&self) -> serde_json::Result<Value> {
        serde_json::to_value(self)
    }
}
fn is_agent_collaboration(mode: &CollaborationMode) -> bool {
    *mode == CollaborationMode::Agent
}
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BackgroundKind {
    #[default]
    Schedule,
    Goal(Uuid),
    Plan(String),
}
impl BackgroundKind {
    fn is_schedule(&self) -> bool {
        *self == Self::Schedule
    }
}
enum Selection {
    Model(ModelSelection, Option<ThinkingLevel>),
    Executor(maka_agent_api::executor::Selection),
}
struct Submission {
    id: String,
    text: String,
    attachments: Vec<String>,
    selection: Selection,
}
enum PreparedBackend {
    Model(Box<(crate::model::Source, maka_agent_engine::PreparedModel)>),
    Executor(Box<crate::executor::Backend>),
}
#[derive(Clone)]
struct Control {
    compacting: bool,
    preview:
        tokio::sync::watch::Receiver<Option<Arc<maka_agent_facts::model::assembly::AttemptCut>>>,
    invocation: Invocation,
    basis: Arc<MessageBasis>,
    cancellation: CancellationToken,
    failure: Option<&'static str>,
}
#[derive(Default)]
struct Runs {
    closing: bool,
    controls: BTreeMap<String, Control>,
    preparing: BTreeMap<String, CancellationToken>,
    /// Sessions whose original execution has not confirmed physical cleanup.
    quarantined: BTreeSet<String>,
}
impl Runs {
    fn busy(&self, session: &str) -> bool {
        self.controls.contains_key(session) || self.preparing.contains_key(session)
    }
}
pub(crate) struct Owner {
    graphs: Option<Arc<crate::workhub::tasks::graph::Graphs>>,
    pub store: Arc<RootStore>,
    pub recall: Arc<recall::Recall>,
    scheduler: Arc<scheduler::Scheduler>,
    todo: Arc<todo::Todo>,
    bot: Arc<bot::Bot>,
    goals: Arc<goal::Goals>,
    plans: Arc<plan::Plans>,
    recap_storage: Arc<maka_host_runtime::storage::Storage>,
    auxiliary: auxiliary::Auxiliary,
    titles: title::Registry,
    pub settings: Configuration,
    pub prefix: String,
    pub data_source: DataSource,
    pub(crate) configuration: Arc<ConfigurationStore>,
    pub(crate) catalog: Arc<maka_providers::catalog::Catalog>,
    credentials: crate::model::Credentials,
    revision: SourceRevision,
    behavior: Option<BuiltinBehavior>,
    configured_locale: LanguagePreference,
    native_language: Language,
    pub workspace_roots: Vec<workspace::Root>,
    instruction_home: Option<Arc<cap_std::fs::Dir>>,
    pub import_roots: Vec<workspace::Root>,
    managed_worktrees: std::path::PathBuf,
    engine: Engine,
    tools: maka_tools::ToolCatalog,
    native_approval_executor: Arc<dyn maka_agent_engine::NativeApprovalExecutor>,
    mcp: crate::mcp::Servers,
    mcp_projects: Arc<crate::mcp::Projects>,
    tool_basis: Arc<Vec<crate::tools::SelectedTool>>,
    editing_tools: Vec<(String, maka_agent_facts::execution::EditingTools)>,
    skills: Option<skills::Library>,
    executors: crate::executor::Executors,
    runs: Arc<runs::Registry>,
    workers: TaskTracker,
    producers: TaskTracker,
    producer_gate: Arc<Mutex<()>>,
    #[cfg(test)]
    title_write_gate: std::sync::Mutex<Option<Arc<title::WriteGate>>>,
    #[cfg(all(test, target_os = "macos"))]
    file_native_hints: std::sync::atomic::AtomicBool,
    stop: CancellationToken,
}
#[derive(Clone, Copy)]
pub(crate) enum BuiltinBehavior {
    WorkHub,
}

impl Owner {
    async fn has_parked_invocation(&self, session: &str) -> Result<bool, String> {
        match async {
            self.store
                .session(session)
                .await?
                .activation_checkpoint(session)
                .await
        }
        .await
        {
            Ok(checkpoint) => Ok(checkpoint.is_some()),
            Err(
                maka_event_log::StoreError::SessionNotFound
                | maka_event_log::StoreError::SessionRetired,
            ) => Ok(false),
            Err(_) => Err("agent_execution_unavailable".into()),
        }
    }

    pub(crate) fn preview_epoch(&self) -> &str {
        &self.revision.activation
    }

    pub(crate) async fn preview_reader(
        &self,
        session: &str,
    ) -> Option<
        tokio::sync::watch::Receiver<Option<Arc<maka_agent_facts::model::assembly::AttemptCut>>>,
    > {
        self.runs
            .lock()
            .await
            .controls
            .get(session)
            .map(|control| control.preview.clone())
    }

    pub(crate) fn tool_store(
        &self,
        context: &maka_agent_facts::tools::ToolCallContext,
    ) -> Result<maka_event_log::SessionStore, String> {
        let custody = context
            .execution
            .as_deref()
            .ok_or("agent_execution_custody_unavailable")?;
        self.store
            .session_for_execution(custody, &context.invocation)
            .map_err(|error| error.to_string())
    }
    pub(crate) fn resolve_language(&self, snapshot: &RuntimePolicySnapshot) -> Language {
        snapshot
            .policy
            .language
            .unwrap_or(self.configured_locale)
            .resolve(self.native_language)
    }

    pub(crate) async fn executor_setup(
        &self,
        input: maka_agent_api::executor::setup::Input,
        context: maka_host_runtime::application::Context,
    ) -> Result<Value, String> {
        self.executors.setup(input, context).await
    }

    pub async fn open(
        context: NativeContext,
        input: Value,
        catalog: Arc<maka_providers::catalog::Catalog>,
    ) -> Result<Arc<Self>, String> {
        Self::open_behavior(context, input, None, vec![], BTreeMap::new(), None, catalog).await
    }
    pub(crate) async fn open_behavior(
        context: NativeContext,
        input: Value,
        behavior: Option<BuiltinBehavior>,
        mut additional: Vec<maka_agent_facts::tools::ToolRegistration>,
        mut internal_bindings: BTreeMap<String, Option<String>>,
        graphs: Option<Arc<crate::workhub::tasks::graph::Graphs>>,
        catalog: Arc<maka_providers::catalog::Catalog>,
    ) -> Result<Arc<Self>, String> {
        let implementation = match behavior {
            Some(BuiltinBehavior::WorkHub) => maka_agent_api::workhub::IMPLEMENTATION,
            None => IMPLEMENTATION,
        };
        if !jsonschema_valid(&input) {
            return Err("agent_configuration_invalid".into());
        }
        let settings: Configuration =
            serde_json::from_value(input).map_err(|_| "agent_configuration_invalid")?;
        let persistence = context.persistence().ok_or("agent_requires_persistence")?;
        let root = persistence
            .store()
            .owned_root()
            .map_err(|_| "agent_root_unavailable")?;
        let data_source = DataSource {
            state_domain: persistence.source().state_domain.clone(),
            deployment: persistence.source().deployment,
            namespace: context.activation().instance().clone(),
        };
        let prefix = maka_agent_authority::session_namespace(
            &persistence.source().state_domain,
            persistence.source().deployment,
            context.activation().instance(),
            implementation != IMPLEMENTATION,
        );
        let managed_worktrees = root.canonical_path().join("subagent-worktrees");
        let workspace_roots =
            workspace::open(settings.workspace_roots.clone(), &managed_worktrees)?;
        let import_roots = if settings.import_roots.is_empty() {
            Vec::new()
        } else {
            workspace::open(settings.import_roots.clone(), root.canonical_path())?
        };
        let cells = maka_tools::CodeExecutor::new(maka_code_runtime::CellLimits::default())
            .map_err(|_| "agent_executor_unavailable")?;
        let workers = TaskTracker::new();
        let stop = CancellationToken::new();
        let revision = SourceRevision {
            kind: SourceKind::ModelProvider,
            name: implementation.into(),
            package_id: context.package().id.clone(),
            entry_id: implementation.into(),
            activation: context.activation().epoch().to_string(),
            revision: context.package().revision.clone(),
        };
        // Match Codex's five-minute stream idle allowance for slow model steps.
        let models = ModelExecutor::for_source(Duration::from_secs(300), revision.clone())
            .map_err(|_| "agent_executor_unavailable")?;
        let auxiliary = auxiliary::Auxiliary::new(revision.clone())?;
        let configured_locale = LanguagePreference::from_locale(&settings.locale);
        let native_language = maka_config::language::native_language();
        let skills = skills::Library::select(&context, &settings, revision.clone())?;
        let instruction_home = assistant::open_home(settings.assistant.as_ref())?;
        let executors = crate::executor::Executors::capture(&context, &settings.executors)?;
        let configuration = Arc::new(
            ConfigurationStore::for_root(root)
                .await
                .map_err(|error| {
                    tracing::error!(stage = "configuration_store_open", cause = crate::diagnostics::config_cause(&error),
                        activation = %context.activation().epoch(), instance = ?context.activation().instance(),
                        "Agent configuration store failed to open");
                    "agent_configuration_unavailable"
                })?,
        );
        let recall = Arc::new(recall::Recall {
            store: persistence.store().clone(),
            configuration: configuration.clone(),
            prefix: prefix.clone(),
            data_source: data_source.clone(),
            enabled: settings.recall,
            stop: stop.clone(),
            workers: workers.clone(),
            services: context.services(),
        });
        if settings.recall {
            additional.extend(recall.tools());
        }
        let scheduler = Arc::new(scheduler::Scheduler::new(
            persistence.store().clone(),
            prefix.clone(),
        ));
        if settings.scheduled_tasks {
            additional.extend(scheduler.tools());
        }
        let plans = Arc::new(plan::Plans::new(
            persistence.store().clone(),
            prefix.clone(),
        ));
        if settings.plans {
            additional.extend(plans.tools());
        }
        let goals = Arc::new(goal::Goals::new(
            persistence.store().clone(),
            prefix.clone(),
        ));
        if settings.goals {
            additional.extend(goals.tools());
        }
        let todo = Arc::new(todo::Todo::new(persistence.store().clone(), prefix.clone()));
        let recap_storage = Arc::new(maka_host_runtime::storage::Storage::new(
            persistence.store().clone(),
            prefix.clone(),
            maka_capabilities::storage::Namespace::new(
                "maka.session-recap",
                maka_plugin_core::scope::Scope::Profile,
            )
            .expect("recap namespace"),
        ));
        if settings.todo {
            additional.extend(todo.tools());
        }
        let bot = Arc::new(bot::Bot::new(persistence.store().clone(), prefix.clone()));
        // Bot identity must be known before activation schedules queued work.
        if let Err(error) = bot.load().await {
            configuration
                .shutdown()
                .await
                .map_err(|_| "agent_configuration_cleanup_unconfirmed")?;
            return Err(format!("agent_bot_unavailable: {error}"));
        }
        if settings.bot {
            additional.extend(bot.tools());
        }
        let mut mcp = match crate::mcp::Servers::open(
            &settings.mcp_servers,
            persistence.store().clone(),
            &configuration,
        )
        .await
        {
            Ok(mcp) => mcp,
            Err(error) => {
                configuration
                    .shutdown()
                    .await
                    .map_err(|_| "agent_configuration_cleanup_unconfirmed")?;
                return Err(error);
            }
        };
        additional.append(&mut mcp.registrations);
        internal_bindings.append(&mut mcp.bindings);
        let internal_tools: Vec<_> = additional
            .iter()
            .map(|tool| tool.definition.clone())
            .collect();
        let prepared_tools = crate::tools::catalog(
            context.services(),
            persistence.store().clone(),
            configuration.clone(),
            &settings.tools,
            additional,
            workers.clone(),
        )
        .and_then(|mut catalog| {
            catalog.planning.extend(mcp.planning.iter().cloned());
            if settings.plans {
                catalog.planning.push("SubmitPlan".into());
                catalog.tools = catalog
                    .tools
                    .with_always_visible(&["SubmitPlan", "update_plan", "cancel_plan"])
                    .and_then(|tools| {
                        tools.with_request_binding(
                            ["SubmitPlan", "update_plan", "cancel_plan"]
                                .into_iter()
                                .map(str::to_owned)
                                .collect(),
                            plans.clone(),
                        )
                    })
                    .map_err(|error| error.to_string())?;
            }
            if graphs.as_ref().is_some_and(|graphs| graphs.enabled()) {
                catalog.tools = catalog
                    .tools
                    .with_always_visible(crate::workhub::tasks::graph::NAMES)
                    .map_err(|error| error.to_string())?;
            }
            if settings.goals {
                catalog.tools = catalog
                    .tools
                    .with_always_visible(&["GoalStatus"])
                    .map_err(|error| error.to_string())?;
            }
            // The Bot's only voice and its rules must not hide behind tool discovery.
            // Other Sessions never select SendUser, so this does not reach them.
            if settings.bot {
                catalog.tools = catalog
                    .tools
                    .with_always_visible(&[bot::SEND_USER, bot::SLEEP])
                    .map_err(|error| error.to_string())?;
            }
            if settings.recall {
                catalog
                    .planning
                    .extend(["Recall", "RecallMore", "RecallMaterial"].map(str::to_owned));
                catalog.tools = catalog
                    .tools
                    .with_request_binding(
                        maka_agent_facts::tools::ToolPreparer::names(recall.as_ref())
                            .into_iter()
                            .collect(),
                        recall.clone(),
                    )
                    .map_err(|error| error.to_string())?;
            }
            Ok(catalog)
        });
        let crate::tools::Catalog {
            tools,
            basis: tool_basis,
            editing: editing_tools,
            planning: planning_tools,
            executor: native_approval_executor,
        } = match prepared_tools {
            Ok(tools) => tools,
            Err(error) => {
                let mcp_cleanup = mcp.close().await;
                configuration
                    .shutdown()
                    .await
                    .map_err(|error| {
                        tracing::error!(stage = "configuration_store_shutdown", cause = crate::diagnostics::config_cause(&error),
                            activation = %context.activation().epoch(), instance = ?context.activation().instance(),
                            "Agent configuration store cleanup failed");
                        "agent_configuration_cleanup_unconfirmed"
                    })?;
                mcp_cleanup?;
                return Err(error);
            }
        };
        let credentials = crate::model::Credentials {
            executor: models.clone(),
            refresh: Arc::new(crate::model::oauth::Authority::new(
                workers.clone(),
                stop.clone(),
            )),
        };
        let engine = Engine::with_resources(
            models,
            cells,
            Some(Arc::new(crate::model::Prices(configuration.clone()))),
            context.services().model_preparation_resources(),
        )
        .map_err(|error| error.to_string())?;
        let mcp_projects = Arc::new(crate::mcp::Projects::new(
            crate::mcp::Catalog {
                revision: None,
                tools: tools.clone(),
                definitions: Arc::new(internal_tools),
                bindings: Arc::new(internal_bindings),
                planning: planning_tools.clone(),
            },
            prefix.clone(),
            mcp.names.clone(),
            instruction_home.clone().zip(
                settings
                    .assistant
                    .as_ref()
                    .and_then(|assistant| assistant.home.as_ref())
                    .map(std::path::PathBuf::from),
            ),
            persistence.store().clone(),
            configuration.clone(),
            workers.clone(),
            stop.child_token(),
        ));
        Ok(Arc::new(Self {
            graphs,
            plans,
            goals,
            auxiliary,
            todo,
            bot,
            recap_storage,
            scheduler,
            recall,
            store: persistence.store().clone(),
            prefix,
            data_source,
            workspace_roots,
            import_roots,
            managed_worktrees,
            revision,
            behavior,
            configured_locale,
            native_language,
            instruction_home,
            settings,
            configuration,
            catalog,
            credentials,
            engine,
            tools,
            native_approval_executor,
            mcp,
            mcp_projects,
            tool_basis: Arc::new(tool_basis),
            editing_tools,
            skills,
            executors,
            runs: Arc::default(),
            titles: title::Registry::default(),
            workers,
            producers: TaskTracker::new(),
            producer_gate: Arc::default(),
            #[cfg(test)]
            title_write_gate: std::sync::Mutex::default(),
            #[cfg(all(test, target_os = "macos"))]
            file_native_hints: std::sync::atomic::AtomicBool::new(true),
            stop,
        }))
    }
    pub fn operation_id(&self, operation: &maka_plugin_core::operation::RecoveryRef) -> String {
        // Use the actual complete original reference. UUIDs alone do not name
        // operations across provider namespaces or deployments. The Host journal
        // still rejects conflicting reuse inside its original operation namespace.
        let bytes = serde_json::to_vec(operation).expect("admitted operation reference");
        let digest = hex::encode(Sha256::digest(bytes));
        format!("{}{}", self.prefix, &digest[..32])
    }
    pub fn owns(&self, id: &str) -> bool {
        owns_session(&self.prefix, id)
    }
    pub async fn require_session(&self, id: &str) -> Result<(), String> {
        if !self.owns(id) {
            return Err("agent_session_unavailable".into());
        }
        if self.store.session_is_available(id).await.map_err(|error| {
            tracing::error!(
                stage = "session_availability",
                session_id = id,
                cause = ?error,
                "Agent session availability read failed"
            );
            "agent_store_unavailable".to_owned()
        })? {
            Ok(())
        } else {
            Err("agent_session_unavailable".into())
        }
    }
    pub(crate) async fn scoped_store(
        &self,
        scope: &maka_capabilities::call::Scope,
        id: &str,
    ) -> Result<maka_event_log::SessionStore, String> {
        if !self.owns(id) {
            return Err("agent_session_unavailable".into());
        }
        if let (Some(invocation), Some(execution)) = (
            scope
                .identity
                .agent()
                .filter(|invocation| invocation.session_id == id),
            scope.execution(),
        ) {
            self.store
                .session_for_execution(execution.as_ref(), invocation)
                .map_err(|error| match error {
                    maka_event_log::StoreError::SessionNotFound => {
                        "agent_session_unavailable".to_owned()
                    }
                    other => other.to_string(),
                })
        } else {
            self.store.session(id).await.map_err(|error| match error {
                maka_event_log::StoreError::SessionNotFound => {
                    "agent_session_unavailable".to_owned()
                }
                other => other.to_string(),
            })
        }
    }
    pub(crate) async fn scoped_session(
        &self,
        scope: &maka_capabilities::call::Scope,
        id: &str,
    ) -> Result<SessionRecord<ResolvedConfiguration>, String> {
        let session = self
            .scoped_store(scope, id)
            .await?
            .get::<StoredSessionConfiguration>()
            .await
            .map_err(|error| match error {
                maka_event_log::StoreError::Json(_) => "agent_store_unavailable".to_owned(),
                other => other.to_string(),
            })?
            .ok_or("agent_session_unavailable")?;
        resolve_session(session)
    }
    pub async fn session(&self, id: &str) -> Result<SessionRecord<ResolvedConfiguration>, String> {
        if !self.owns(id) {
            return Err("agent_session_unavailable".into());
        }
        let session = self
            .store
            .get_session::<StoredSessionConfiguration>(id)
            .await
            .map_err(|_| "agent_store_unavailable".to_owned())?
            .ok_or("agent_session_unavailable")?;
        resolve_session(session)
    }
    pub async fn create(
        self: &Arc<Self>,
        input: Create,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<Created, String> {
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move { owner.create_inner(input, &operation, &scope).await })
        })
        .await
    }
    async fn create_inner(
        &self,
        input: Create,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<Created, String> {
        if let Some(reason) = metadata_rejection(&input.title, &input.labels) {
            return Ok(Created::Rejected { reason });
        }
        let id = self.operation_id(operation);
        let admission = self.runs.session(&id).await;
        if admission.state().await.closing {
            return Ok(Created::Rejected {
                reason: Rejection::Closed,
            });
        }
        let mut tools = input.tools;
        // SendUser and sleep follow Bot identity, never a requested tool list.
        if tools.as_ref().is_some_and(|names| {
            names
                .iter()
                .any(|name| name == bot::SEND_USER || name == bot::SLEEP)
        })
        {
            return Ok(Created::Rejected {
                reason: Rejection::ToolsUnavailable,
            });
        }
        if let Some(names) = &mut tools {
            names.sort();
            if names.windows(2).any(|pair| pair[0] == pair[1]) {
                return Ok(Created::Rejected {
                    reason: Rejection::ToolsUnavailable,
                });
            }
        }
        let selected = match input.workspace {
            WorkspaceSelection::IsolatedGit { selection } => {
                let Some(workspace) = self.isolated_workspace(selection, operation, scope).await?
                else {
                    return Ok(Created::Rejected {
                        reason: Rejection::WorkspaceUnavailable,
                    });
                };
                workspace
            }
            WorkspaceSelection::Project { project, selection } => {
                let Some(workspace) = self.select_project(project, selection).await? else {
                    return Ok(Created::Rejected {
                        reason: Rejection::WorkspaceUnavailable,
                    });
                };
                workspace
            }
            WorkspaceSelection::Directory { selection } => {
                let Some(workspace) = self.create_project_workspace(selection).await? else {
                    return Ok(Created::Rejected {
                        reason: Rejection::WorkspaceUnavailable,
                    });
                };
                workspace
            }
            WorkspaceSelection::Session { session_id } => {
                if !self.owns(&session_id) {
                    return Ok(Created::Rejected {
                        reason: Rejection::SessionUnavailable,
                    });
                }
                let Some(session) = self
                    .store
                    .get_session::<StoredSessionConfiguration>(&session_id)
                    .await
                    .map_err(|_| "agent_store_unavailable")?
                else {
                    return Ok(Created::Rejected {
                        reason: Rejection::SessionUnavailable,
                    });
                };
                let session = resolve_session(session)?;
                if session.archived
                    || !self
                        .project_accepts_session(&session.configuration.workspace)
                        .await?
                {
                    return Ok(Created::Rejected {
                        reason: Rejection::SessionUnavailable,
                    });
                }
                if workspace::validate(
                    &self.workspace_roots,
                    &session.configuration.workspace,
                    &self.managed_worktrees,
                )
                .await
                .is_err()
                {
                    return Ok(Created::Rejected {
                        reason: Rejection::WorkspaceUnavailable,
                    });
                }
                if let Some(parent) = session.configuration.tools {
                    tools = Some(match tools {
                        None => parent,
                        Some(names) => names
                            .into_iter()
                            .filter(|name| parent.contains(name))
                            .collect(),
                    });
                }
                session.configuration.workspace
            }
        };
        if let Some(names) = &tools
            && names.iter().any(|name| !self.tools.contains(name))
        {
            // A ceiling containing only baseline tools never starts project servers.
            let catalog = self.mcp_projects.available(&selected).await?;
            if names
                .iter()
                .any(|name| !self.tools.contains(name) && !catalog.tools.contains(name))
            {
                return Ok(Created::Rejected {
                    reason: Rejection::ToolsUnavailable,
                });
            }
        }
        let binding = self
            .store
            .attach_workspace(&self.prefix, &selected)
            .await
            .map_err(|_| "agent_workspace_binding_unavailable")?;
        let record = self
            .store
            .create_session(
                &id,
                &operation.fingerprint,
                &StoredSessionConfiguration {
                    parent_session_id: scope
                        .identity
                        .agent()
                        .map(|source| source.session_id.clone()),
                    backend: None,
                    compaction_prompt: None,
                    collaboration_mode: CollaborationMode::Agent,
                    tools,
                    title: input.title,
                    title_is_manual: !input.automatic_title,
                    pinned: false,
                    labels: input.labels,
                    workspace: binding,
                    permissions: self.settings.permissions.clone(),
                    boundary_revision: 0,
                },
                now(),
            )
            .await
            .map_err(|_| "agent_creation_failed")?;
        Ok(Created::Created {
            session: Box::new(crate::service::summary(
                self,
                resolve_session(
                    record
                        .get()
                        .await
                        .map_err(|_| "agent_creation_failed")?
                        .ok_or("agent_creation_failed")?,
                )?,
            )),
        })
    }
    pub async fn mark_read(&self, input: MarkRead) -> Result<MarkReadResult, String> {
        let runs = self.runs.lock().await;
        if runs.closing {
            return Ok(MarkReadResult::Rejected {
                reason: Rejection::Closed,
            });
        }
        if !self.owns(&input.session_id) {
            return Ok(MarkReadResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        let session = self
            .store
            .get_session::<StoredSessionConfiguration>(&input.session_id)
            .await
            .map_err(|_| "agent_store_unavailable")?;
        if session.is_none_or(|session| session.archived) {
            return Ok(MarkReadResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        // The original store compares the exposed message with the durable tail
        // inside its transaction. A stale reader cannot clear a newer message.
        let record = self
            .store
            .set_session_read_marker::<StoredSessionConfiguration>(
                &input.session_id,
                &input.message_id,
            )
            .await
            .map_err(|_| "agent_read_marker_failed")?;
        Ok(MarkReadResult::Observed {
            session: Box::new(crate::service::summary(self, resolve_session(record)?)),
        })
    }
    pub async fn metadata(&self, input: Metadata) -> Result<MetadataResult, String> {
        if let Some(reason) = metadata_rejection(&input.title, &input.labels) {
            return Ok(MetadataResult::Rejected { reason });
        }
        let runs = self.runs.lock().await;
        if runs.closing {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::Closed,
            });
        }
        if !self.owns(&input.session_id) {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        let Some(session) = self
            .store
            .get_session::<StoredSessionConfiguration>(&input.session_id)
            .await
            .map_err(|_| "agent_store_unavailable")?
        else {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        };
        if session.archived {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        use maka_event_log::sessions::SessionMutation;
        let mode_changed = input
            .collaboration_mode
            .is_some_and(|mode| mode != session.configuration.collaboration_mode);
        if mode_changed {
            if self.graph_selected(&input.session_id).await? {
                return Ok(MetadataResult::Rejected {
                    reason: Rejection::Busy,
                });
            }
            if input.collaboration_mode == Some(CollaborationMode::Plan) && !self.settings.plans {
                return Ok(MetadataResult::Rejected {
                    reason: Rejection::ToolsUnavailable,
                });
            }
            if runs.busy(&input.session_id)
                || self.has_parked_invocation(&input.session_id).await?
                || !self.store.session(&input.session_id).await.map_err(|error| error.to_string())?.message_queue(&input.session_id).await.map_err(|_| "agent_queue_unavailable")?.entries.is_empty()
                || self.store.session(&input.session_id).await.map_err(|error| error.to_string())?.latest_turn_boundary(&input.session_id).await.map_err(|_| "agent_execution_unavailable")?
                    .is_some_and(|boundary| matches!(boundary.state, maka_event_log::turns::InvocationState::Ended { outcome: maka_agent_facts::event::InvocationOutcome::HandoffPaused { .. }, .. })) {
                return Ok(MetadataResult::Rejected { reason: Rejection::Busy });
            }
        }
        let permissions = input.permissions.is_some() || mode_changed;
        let update = move |configuration: &mut StoredSessionConfiguration| {
            // Policy changes do not turn an automatic title into a manual title.
            if (input.collaboration_mode.is_none()
                && input.permissions.is_none()
                && input.pinned.is_none())
                || configuration.title != input.title
            {
                configuration.title_is_manual = true;
            }
            configuration.title = input.title;
            configuration.labels = input.labels;
            if let Some(pinned) = input.pinned {
                configuration.pinned = pinned;
            }
            if mode_changed
                || input.permissions.as_ref().is_some_and(|change| {
                    change.settings != configuration.permissions || change.revoke_grants
                })
            {
                configuration.boundary_revision = configuration
                    .boundary_revision
                    .checked_add(1)
                    .filter(|revision| *revision <= maka_agent_facts::interaction::MAX_SAFE_INTEGER)
                    .ok_or_else(|| {
                        maka_event_log::StoreError::InvalidTransition(
                            "permission boundary revision exhausted".into(),
                        )
                    })?;
            }
            if let Some(change) = input.permissions {
                configuration.permissions = change.settings;
            }
            if let Some(mode) = input.collaboration_mode {
                configuration.collaboration_mode = mode;
            }
            Ok(())
        };
        let changed = if permissions {
            self.store
                .update_session_permissions(
                    &input.session_id,
                    input.expected_revision,
                    now(),
                    update,
                )
                .await
        } else {
            self.store
                .update_session_metadata(&input.session_id, input.expected_revision, update)
                .await
        }
        .map_err(|_| "agent_metadata_failed")?;
        match changed {
            SessionMutation::Committed(record) => Ok(MetadataResult::Committed {
                session: Box::new(crate::service::summary(self, resolve_session(*record)?)),
            }),
            SessionMutation::RevisionConflict { expected, actual } => {
                Ok(MetadataResult::RevisionConflict { expected, actual })
            }
        }
    }
    pub(super) async fn tool_names(
        self: &Arc<Self>,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<crate::contract::ToolNames, String> {
        self.resource_work(scope, |owner, _scope| {
            Box::pin(async move {
                let catalog = owner.mcp_projects.capture_global().await?;
                Ok(crate::contract::ToolNames {
                    names: catalog.tools.names(),
                })
            })
        })
        .await
    }
    fn selected_tools(
        &self,
        session: &str,
        basis: &MessageBasis,
        discovery: bool,
        editing: Option<maka_agent_facts::execution::EditingTools>,
    ) -> Result<maka_tools::ToolCatalog, String> {
        let catalog = match &basis.mcp_catalog {
            Some(catalog) => catalog.clone(),
            None => self.mcp_projects.catalog(basis.mcp_revision.as_deref())?,
        };
        let selected = plan::select(&catalog.tools, basis, &catalog.planning);
        // SendUser and sleep are granted by Bot identity, independent of the tool list.
        let bot = self.bot.is(session);
        let excluded: Vec<_> = selected
            .definitions()
            .map(|definition| definition.name.as_str())
            .filter(|name| {
                let speaks = *name == bot::SEND_USER || *name == bot::SLEEP;
                (speaks && !bot)
                    || (basis.graph.is_none() && crate::workhub::tasks::graph::NAMES.contains(name))
                    || (!(speaks && bot)
                        && basis.allowed_tools.as_ref().is_some_and(|allowed| {
                            !allowed.iter().any(|allowed| allowed.as_str() == *name)
                        }))
                    || editing.is_some_and(|editing| {
                        self.editing_tools
                            .iter()
                            .any(|(tool, style)| tool.as_str() == *name && *style != editing)
                    })
            })
            .collect();
        let selected = selected.excluding(&excluded);
        let selected = if discovery {
            selected.with_discovery()
        } else {
            selected
        };
        Ok(selected)
    }
    pub async fn send(
        self: &Arc<Self>,
        input: Send,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<crate::contract::SendResult, String> {
        let Send {
            session_id: id,
            message: text,
            model: selection,
            thinking_level,
            attachments,
        } = input;
        self.submit(
            Submission {
                id,
                text,
                attachments,
                selection: Selection::Model(selection, thinking_level),
            },
            operation,
            parent,
        )
        .await
    }
    pub async fn execute(
        self: &Arc<Self>,
        input: Execute,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<SendResult, String> {
        self.submit(
            Submission {
                id: input.session_id,
                text: input.message,
                attachments: input.attachments,
                selection: Selection::Executor(input.executor),
            },
            operation,
            parent,
        )
        .await
    }
    async fn submit(
        self: &Arc<Self>,
        input: Submission,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<SendResult, String> {
        let Submission {
            id,
            text,
            attachments,
            selection,
        } = input;
        if text.trim().is_empty() && attachments.is_empty() {
            return Err("agent_message_invalid".into());
        }
        let admission = self.runs.session(&id).await;
        let queued = {
            let runs = admission.state().await;
            if runs.closing {
                return Err("agent_closed".into());
            }
            if runs.quarantined.contains(&id) {
                return Err("agent_cleanup_unconfirmed".into());
            }
            let current = runs.controls.get(&id);
            if let Some(reason) = current.and_then(|control| control.failure) {
                return Err(reason.into());
            }
            current.map(|control| control.invocation.clone())
        };
        let queued = match queued {
            Some(invocation) => Some(invocation),
            None => self
                .store
                .session(&id)
                .await
                .map_err(|error| error.to_string())?
                .activation_checkpoint(&id)
                .await
                .map_err(|_| "agent_execution_unavailable")?
                .map(|parked| parked.checkpoint.invocation),
        };
        let session = self.session(&id).await?;
        if session.archived {
            return Err("agent_session_configuration_changed".into());
        }
        let backend = match selection {
            Selection::Model(selection, thinking_level) => PreparedBackend::Model(Box::new(
                crate::model::Source::select(
                    self.configuration.clone(),
                    self.catalog.clone(),
                    self.credentials.clone(),
                    selection,
                    thinking_level,
                    id.clone(),
                    self.revision.clone(),
                )
                .await
                .map_err(public_error)?,
            )),
            Selection::Executor(selection) => {
                if session.configuration.tools.is_some() {
                    return Err("agent_executor_cannot_enforce_tool_selection".into());
                }
                PreparedBackend::Executor(Box::new(self.executors.select(selection)?))
            }
        };
        let (model, executor) = match &backend {
            PreparedBackend::Model(value) => (Some(value.0.accepted.clone()), None),
            PreparedBackend::Executor(value) => (None, Some(value.accepted.clone())),
        };
        workspace::validate(
            &self.workspace_roots,
            &session.configuration.workspace,
            &self.managed_worktrees,
        )
        .await?;
        let external = executor.is_some();
        if session.configuration.collaboration_mode == CollaborationMode::Plan
            && (!self.settings.plans || external)
        {
            return Err("agent_planning_unavailable".into());
        }
        let snapshot = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|_| "agent_preferences_unavailable")?;
        let language = self.resolve_language(&snapshot);
        // Preserve ordinary send ordering. Only actual external startup leaves
        // the admission gate; parsing and a cached catalog do not reorder work.
        let (admission, queued, selected_catalog) = if external {
            (admission, queued, self.mcp_projects.base.clone())
        } else {
            match self
                .mcp_projects
                .prepare(&session.configuration.workspace)
                .await?
            {
                crate::mcp::Prepared::Ready(revision) => (admission, queued, revision),
                crate::mcp::Prepared::Startup(proposal) => {
                    drop(admission);
                    let revision = self.mcp_projects.start(*proposal).await?;
                    let admission = self.runs.session(&id).await;
                    let queued = {
                        let runs = admission.state().await;
                        if runs.closing || self.stop.is_cancelled() {
                            return Err("agent_closed".into());
                        }
                        if runs.quarantined.contains(&id) {
                            return Err("agent_cleanup_unconfirmed".into());
                        }
                        let current = runs.controls.get(&id);
                        if let Some(reason) = current.and_then(|control| control.failure) {
                            return Err(reason.into());
                        }
                        current.map(|control| control.invocation.clone())
                    };
                    let queued = match queued {
                        Some(invocation) => Some(invocation),
                        None => self
                            .store
                            .session(&id)
                            .await
                            .map_err(|error| error.to_string())?
                            .activation_checkpoint(&id)
                            .await
                            .map_err(|_| "agent_execution_unavailable")?
                            .map(|parked| parked.checkpoint.invocation),
                    };
                    let current = self.session(&id).await?;
                    if current.configuration != session.configuration || current.archived {
                        return Err("agent_session_configuration_changed".into());
                    }
                    (admission, queued, revision)
                }
            }
        };
        let mut basis = MessageBasis {
            mcp_revision: selected_catalog.revision.clone(),
            mcp_catalog: Some(selected_catalog.clone()),
            language,
            compaction_prompt: Some(self.effective_compaction_prompt(
                session.configuration.compaction_prompt.as_deref(),
                &snapshot,
                language,
            )),
            graph: None,
            collaboration_mode: session.configuration.collaboration_mode,
            background_kind: BackgroundKind::Schedule,
            tool_discovery: !external && self.settings.tool_discovery,
            allowed_tools: session.configuration.tools.clone(),
            background: None,
            internal_tools: if external {
                Arc::default()
            } else {
                selected_catalog.definitions.clone()
            },
            internal_bindings: if external {
                Arc::default()
            } else {
                selected_catalog.bindings.clone()
            },
            behavior: self.bot_behavior(
                &id,
                self.capture_behavior(&session.configuration.workspace, &snapshot, language)
                    .await?,
                &snapshot,
                language,
            ),
            model,
            executor,
            workspace: session.configuration.workspace.clone(),
            binding: session.configuration.binding,
            fingerprint: operation.fingerprint.clone(),
            tools: if external {
                Arc::default()
            } else {
                self.tool_basis.clone()
            },
        };
        self.prepare_plan_behavior(&id, &mut basis).await?;
        self.prepare_graph_behavior(&id, &mut basis, queued.is_none())
            .await?;
        let identity = self.operation_id(operation);
        let invocation = queued.clone().unwrap_or_else(|| Invocation {
            session_id: id.clone(),
            turn_id: format!("t_{identity}"),
            run_id: format!("r_{identity}"),
            invocation_id: format!("i_{identity}"),
        });
        let mut message: MessageInput = text.into();
        message.attachments = self.attachment_refs(&id, attachments).await?;
        let unprepared = message;
        let (message, required_tools) = match self
            .prepare_skills(
                unprepared.clone(),
                language,
                Some(session.configuration.workspace.clone()),
                parent,
                if basis.executor.is_some() {
                    vec![]
                } else {
                    self.selected_tools(
                        &id,
                        &basis,
                        false,
                        basis.model.as_ref().and_then(|model| model.editing_tools),
                    )?
                    .names()
                },
            )
            .await?
        {
            skills::Input::Ready {
                message,
                required_tools,
            } => (message, required_tools),
            skills::Input::Rejected { reason, skills } => {
                return Ok(SendResult::Rejected {
                    session_id: id,
                    reason,
                    skills,
                });
            }
        };
        let delivered = RootSourceMessage {
            message: DeliveredMessage {
                origin: None,
                message_id: format!("m_{identity}"),
                submitted_content_digest: unprepared
                    .content_digest()
                    .map_err(|_| "agent_message_invalid")?,
                content: message.clone(),
            },
            unprepared_content: unprepared,
            submitted_placement: if queued.is_some() {
                Placement::NextTurn
            } else {
                Placement::CurrentTurn
            },
            disposition: if queued.is_some() {
                MessageDisposition::Followup
            } else {
                MessageDisposition::TurnStarted
            },
            submitted_intent: None,
        };
        let pending = maka_event_log::message_admissions::PendingMessageAdmission {
            execution: maka_event_log::message_admissions::PendingExecution {
                owner: self.prefix.clone(),
                basis: serde_json::to_value(&basis).expect("accepted message basis"),
            },
            invocation: invocation.clone(),
            steering_invocation: None,
            source: delivered.clone(),
            required_tools,
            admitted_at: now(),
        };
        if queued.is_some() {
            loop {
                let revision = self
                    .store
                    .session(&id)
                    .await
                    .map_err(|error| error.to_string())?
                    .message_queue_revision(&id)
                    .await
                    .map_err(|_| "agent_queue_unavailable")?;
                match self
                    .store
                    .session(&pending.invocation.session_id)
                    .await
                    .map_err(|error| error.to_string())?
                    .admit_queued_message(&self.revision.activation, revision, pending.clone())
                    .await
                {
                    Ok(receipt) => {
                        return Ok(SendResult::Queued {
                            session_id: id,
                            message_id: delivered.message.message_id,
                            revision: receipt.queue_revision,
                        });
                    }
                    Err(maka_event_log::StoreError::RevisionConflict { .. }) => continue,
                    Err(_) => return Err("agent_admission_failed".into()),
                }
            }
        }
        let basis = Arc::new(basis);
        let input = self
            .input(invocation.clone(), backend, basis.clone(), delivered)
            .await?;
        self.store
            .session(&pending.invocation.session_id)
            .await
            .map_err(|error| error.to_string())?
            .admit_message(pending)
            .await
            .map_err(|_| "agent_admission_failed")?;
        let cancellation = self.stop.child_token();
        let running = match self.start(input, cancellation.clone()).await {
            Ok(running) => running,
            Err(error) => {
                if error.is_cleanup_unconfirmed() {
                    admission.state().await.quarantined.insert(id.clone());
                }
                return Err(public_error(error));
            }
        };
        self.publish(&mut *admission.state().await, &running, basis);
        let owner = self.clone();
        self.workers
            .spawn(async move { owner.drive(running).await });
        Ok(crate::contract::SendResult::Started {
            session_id: invocation.session_id.clone(),
            invocation_id: invocation.invocation_id,
            message_id: format!("m_{identity}"),
        })
    }
}
fn metadata_rejection(title: &str, labels: &[String]) -> Option<Rejection> {
    if title.trim().is_empty() || title.chars().any(char::is_control) {
        Some(Rejection::TitleInvalid)
    } else if labels
        .iter()
        .any(|label| label.trim().is_empty() || label.chars().any(char::is_control))
    {
        Some(Rejection::LabelsInvalid)
    } else {
        None
    }
}

impl Owner {
    pub(crate) fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        let producer = self.producer_gate.clone().try_lock_owned().ok()?;
        let runs = self.runs.clone().try_lock_owned().ok()?;
        if !runs.controls.is_empty()
            || !runs.preparing.is_empty()
            || !runs.quarantined.is_empty()
            || !self.workers.is_empty()
            || !self.auxiliary.resources.is_idle()
            || self.goals.keeps_host_awake()
            || self.plans.keeps_host_awake()
            || self
                .graphs
                .as_ref()
                .is_some_and(|graphs| graphs.keeps_host_awake())
        {
            return None;
        }
        Some(Box::new(Idle {
            runs,
            _producer: producer,
            stop: self.stop.clone(),
        }))
    }
    pub fn retiring(&self) {
        self.mcp_projects.retire();
    }
    pub fn close(self: &Arc<Self>) -> BoxFuture<'static, Result<(), String>> {
        let owner = self.clone();
        Box::pin(async move {
            // Wake pending external startup before waiting for lifecycle readers.
            owner.stop.cancel();
            {
                let mut runs = owner.runs.lock().await;
                runs.closing = true;
                owner.stop.cancel();
            }
            owner.producers.close();
            owner.producers.wait().await;
            owner.workers.close();
            owner.workers.wait().await;
            owner.engine.drain().await;
            let scheduler = owner.scheduler.finish().await;
            let todo = owner.todo.finish().await;
            let bot = owner.bot.finish().await;
            let goals = owner.goals.finish().await;
            let plans = owner.plans.finish().await;
            let graph = match &owner.graphs {
                Some(graphs) => graphs.finish().await,
                None => Ok(()),
            };
            let recap = owner.recap_storage.finish().await;
            let auxiliary = owner.auxiliary.resources.finish().await;
            let projects = owner.mcp_projects.close().await;
            let mcp = owner.mcp.close().await;
            let configuration = owner.configuration.shutdown().await;
            if let Err(error) = &configuration {
                tracing::error!(stage = "configuration_store_shutdown", cause = crate::diagnostics::config_cause(error),
                    activation = %owner.revision.activation, instance = ?owner.data_source.namespace,
                    "Agent configuration store cleanup failed");
            }
            let runs = owner.runs.lock().await;
            if !runs.quarantined.is_empty() || !runs.preparing.is_empty() {
                return Err("agent_cleanup_unconfirmed".into());
            }
            projects?;
            mcp?;
            scheduler?;
            todo?;
            bot?;
            goals?;
            plans?;
            graph?;
            recap?;
            auxiliary.map_err(|error| error.to_string())?;
            configuration.map_err(|_| "agent_configuration_cleanup_unconfirmed".into())
        })
    }
}
struct Idle {
    runs: runs::Exclusive,
    _producer: tokio::sync::OwnedMutexGuard<()>,
    stop: CancellationToken,
}
impl maka_host_runtime::application::NativeRetirement for Idle {
    fn commit(mut self: Box<Self>) {
        self.runs.closing = true;
        self.stop.cancel();
    }
}
use maka_agent_authority::now;
fn jsonschema_valid(input: &Value) -> bool {
    jsonschema::validator_for(&configuration_schema())
        .expect("configuration schema")
        .is_valid(input)
}

fn public_error(error: RunError) -> String {
    match error {
        RunError::Busy => "agent_session_busy",
        RunError::Cancelled => "agent_cancelled",
        RunError::CleanupUnconfirmed => "agent_cleanup_unconfirmed",
        _ => "agent_execution_unavailable",
    }
    .into()
}

#[cfg(test)]
mod tests;

pub(crate) fn owns_session(prefix: &str, id: &str) -> bool {
    id.strip_prefix(prefix).is_some_and(|tail| {
        tail.len() == 32
            && tail
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
