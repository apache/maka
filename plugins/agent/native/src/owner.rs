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
use maka_agent_engine::{Engine, RunError};

pub(crate) mod access;
mod assistant;
mod attachments;
mod auxiliary;
mod checkpoints;
mod compaction;
mod completions;
mod computer_apps;
mod context;
mod continuation;
mod creation;
mod discovery;
mod execution;
pub(crate) use access::RunAccess;
mod capture;
mod capture_budget;
mod catalog;
mod driver_assembly;
mod driver_cells;
mod driver_executor;
mod driver_executor_inputs;
mod driver_executor_publication;
mod driver_external_effects;
mod send;
use send::NativeMutation;
mod bot;
mod cleanup_driver;
mod cleanup_source;
mod driver;
mod driver_cleanup;
mod driver_model;
mod external_setup;
mod files;
mod fork;
mod git;
mod global_instructions;
mod goal;
mod imports;
mod initialization;
mod interactions;
mod lifecycle;
mod mcp;
mod models;
mod notifications;
mod patches;
mod predictions;
mod preferences;
mod presets;
mod projects;
mod queue;
mod recall;
mod recap;
mod runs;
mod scheduler;
pub(crate) mod setup;
mod skills;
mod steering;
mod system_permission;
mod title;
mod todo;
mod work;
mod worktrees;
use maka_agent_facts::composition::SourceKind;
use maka_agent_facts::composition::SourceRevision;
use maka_agent_facts::configuration::policy::RuntimePolicySnapshot;
use maka_agent_facts::durable::ExecutionIdentity;
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

/// Live preparation captured by this activation; durable inputs are frozen into RunSpec separately.
#[derive(Clone)]
struct CapturedRun {
    mcp_catalog: Option<Arc<crate::mcp::Catalog>>,
    mcp_revision: Option<String>,
    client_mcp: Option<crate::mcp::ClientGeneration>,
    compaction_prompt: Option<String>,
    collaboration_mode: CollaborationMode,
    background_kind: BackgroundKind,
    tool_discovery: bool,
    allowed_tools: Option<Vec<String>>,
    background: Option<ScheduledTarget>,
    internal_tools: Arc<Vec<maka_agent_facts::tools::ToolDefinition>>,
    internal_bindings: Arc<BTreeMap<String, Option<String>>>,
    behavior: Option<SystemPrompt>,
    model: Option<crate::model::AcceptedModel>,
    executor: Option<crate::executor::Accepted>,
    workspace: Workspace,
    binding: maka_sandbox::workspace::BindingStamp,
    fingerprint: String,
    language: Language,
}
#[derive(Clone, Default, PartialEq, Eq)]
enum BackgroundKind {
    #[default]
    Interactive,
    Schedule {
        task_id: String,
    },
    Goal(Uuid),
}
#[derive(Clone)]
struct Control {
    compacting: bool,
    preview:
        tokio::sync::watch::Receiver<Option<Arc<maka_agent_facts::model::assembly::AttemptCut>>>,
    execution: ExecutionIdentity,
    access: std::sync::Weak<access::RunAccess>,
    basis: Arc<CapturedRun>,
    cancellation: CancellationToken,
}
#[derive(Clone)]
struct PreparingRun {
    run: maka_agent_facts::durable::RunId,
    cancellation: CancellationToken,
    completion: futures_util::future::Shared<
        BoxFuture<'static, maka_plugin_core::operation::OperationCleanup>,
    >,
}
#[derive(Default)]
struct Runs {
    closing: bool,
    controls: BTreeMap<String, Control>,
    preparing: BTreeMap<String, PreparingRun>,
    /// A failed probe only becomes runnable again after its Run gains evidence.
    failed_frontiers: BTreeMap<String, (maka_agent_facts::durable::RunId, u64)>,
    /// Original execution custody retained after its worker has ended.
    retained_cleanup: BTreeMap<String, Vec<Arc<driver_cleanup::RetainedScope>>>,
}
impl Runs {
    fn busy(&self, session: &str) -> bool {
        self.controls.contains_key(session)
            || self.preparing.contains_key(session)
            || self.retained_cleanup.contains_key(session)
    }
}
struct CreationPolicy {
    permissions: WorkspacePermissions,
    tools: Option<Vec<String>>,
    caller: Option<maka_agent_state::CallerFence>,
}

fn intersect_tools(
    requested: Option<Vec<String>>,
    ceiling: Option<Vec<String>>,
) -> Option<Vec<String>> {
    match (requested, ceiling) {
        (Some(names), Some(ceiling)) => Some(
            names
                .into_iter()
                .filter(|name| ceiling.contains(name))
                .collect(),
        ),
        (requested, ceiling) => requested.or(ceiling),
    }
}

pub(crate) struct Owner {
    model_reader_process: maka_process::lifetime::ProcessIdentity,
    pub store: Arc<RootStore>,
    helper: std::path::PathBuf,
    pricing: Option<Arc<dyn maka_agent_engine::pricing::Pricing>>,
    pub(super) durable: maka_agent_state::Store,
    pub(super) services: maka_host_runtime::application::NativeServices,
    wake_notify: tokio::sync::Notify,
    physical_changes: tokio::sync::watch::Sender<()>,
    pub recall: Arc<recall::Recall>,
    scheduler: Arc<scheduler::Scheduler>,
    todo: Arc<todo::Todo>,
    bot: Arc<bot::Bot>,
    goals: Arc<goal::Goals>,
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
    configured_locale: LanguagePreference,
    native_language: Language,
    pub workspace_roots: Vec<workspace::Root>,
    instruction_home: Option<Arc<cap_std::fs::Dir>>,
    pub import_roots: Vec<workspace::Root>,
    pub(crate) managed_worktrees: std::path::PathBuf,
    /// The user's home directory, which a leading `~` in a caller's path
    /// stands for.
    pub home: Option<std::path::PathBuf>,
    code_executor: maka_tools::CodeExecutor,
    tools: crate::tools::Declarations,
    internal_registrations: Vec<maka_agent_facts::tools::ToolRegistration>,
    mcp: crate::mcp::Servers,
    mcp_projects: Arc<crate::mcp::Projects>,
    tool_basis: Arc<Vec<crate::tools::SelectedTool>>,
    host_tools: Vec<String>,
    resource_reads: Vec<String>,
    discovery_reads: Vec<String>,
    editing_tools: Vec<(String, maka_agent_facts::execution::EditingTools)>,
    skills: Option<skills::Library>,
    pub(super) executors: crate::executor::Executors,
    runs: Arc<runs::Registry>,
    workers: TaskTracker,
    cleanup_workers: TaskTracker,
    producers: TaskTracker,
    producer_gate: Arc<Mutex<()>>,
    stop: CancellationToken,
}
impl Owner {
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
            .custody
            .as_deref()
            .ok_or("agent_work_custody_unavailable")?;
        self.store
            .session_for_work(custody, &context.execution.session_id)
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
        self: &Arc<Self>,
        input: maka_agent_api::executor::setup::Input,
        context: maka_host_runtime::application::Context,
    ) -> Result<maka_host_runtime::application::HandlerValue, String> {
        let context = Arc::new(context);
        let binding = self.executors.setup_binding(&input.executor)?;
        let purpose = match &input.action {
            maka_agent_api::executor::setup::Action::Check => setup::SetupPurpose::Check,
            maka_agent_api::executor::setup::Action::Authenticate { .. } => {
                setup::SetupPurpose::Authenticate
            }
        };
        let source = self.setup_source(context.clone(), binding, purpose)?;
        self.executors.setup(input, &context, source).await
    }

    pub async fn open(
        context: NativeContext,
        input: Value,
        catalog: Arc<maka_providers::catalog::Catalog>,
        durable: maka_agent_state::Store,
        helper: std::path::PathBuf,
        pricing: Option<Arc<dyn maka_agent_engine::pricing::Pricing>>,
    ) -> Result<Arc<Self>, initialization::InitializationError> {
        let model_reader_process =
            tokio::task::spawn_blocking(maka_process::lifetime::ProcessIdentity::current)
                .await
                .map_err(|_| "agent_model_process_capture_worker_failed")?
                .map_err(|_| "agent_model_process_capture_failed")?;
        let mut additional = Vec::new();
        let mut internal_bindings = BTreeMap::new();
        if !jsonschema_valid(&input) {
            return Err("agent_configuration_invalid".into());
        }
        let settings: Configuration =
            serde_json::from_value(input).map_err(|_| "agent_configuration_invalid")?;
        let persistence = context.persistence().ok_or("agent_requires_persistence")?;
        durable
            .validate_root(
                &persistence
                    .store()
                    .data_writer()
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
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
        );
        let managed_worktrees = root.canonical_path().join("subagent-worktrees");
        let workspace_specs = settings.workspace_roots.clone();
        let import_specs = settings.import_roots.clone();
        let managed = managed_worktrees.clone();
        let root_path = root.canonical_path().to_owned();
        let (workspace_roots, import_roots) = tokio::task::spawn_blocking(move || {
            Ok::<_, String>((
                workspace::open_projects(workspace_specs, &managed)?,
                workspace::open(import_specs, &root_path)?,
            ))
        })
        .await
        .map_err(|_| "agent_workspace_configuration_worker_failed")??;
        let home = std::env::home_dir();
        let workers = TaskTracker::new();
        let stop = CancellationToken::new();
        let revision = SourceRevision {
            kind: SourceKind::ModelProvider,
            name: IMPLEMENTATION.into(),
            package_id: context.package().id.clone(),
            entry_id: IMPLEMENTATION.into(),
            activation: context.activation().epoch().to_string(),
            revision: context.package().revision.clone(),
        };
        // Match Codex's five-minute stream idle allowance for slow model steps.
        let models = ModelExecutor::for_source(Duration::from_secs(300), revision.clone())
            .map_err(|_| "agent_executor_unavailable")?;
        let run_owner = maka_agent_facts::durable::RunOwner {
            deployment: data_source.deployment,
            namespace: data_source.namespace.clone(),
        };
        let auxiliary = auxiliary::Auxiliary::new(models.clone(), run_owner.clone());
        let code_executor = maka_tools::CodeExecutor::new(maka_code_runtime::CellLimits::default())
            .and_then(|executor| {
                executor.with_python_worker(helper.with_file_name(if cfg!(windows) {
                    "maka-python-worker.exe"
                } else {
                    "maka-python-worker"
                }))
            })
            .map_err(|_| "agent_executor_unavailable")?;
        let configured_locale = LanguagePreference::from_locale(&settings.locale);
        let native_language = maka_config::language::native_language();
        let skills = skills::Library::select(&context, &settings, revision.clone())?;
        let instruction_home = assistant::open_home(settings.assistant.as_ref())?;
        let executors = crate::executor::Executors::capture(
            &context,
            &settings.executors,
            settings.external.as_ref(),
        )?;
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
            durable: durable.clone(),
            owner: run_owner,
            prefix: prefix.clone(),
            data_source: data_source.clone(),
            enabled: settings.recall,
            stop: stop.clone(),
            workers: workers.clone(),
            services: context.services(),
        });
        let recall_tools = if settings.recall {
            recall.tools()
        } else {
            vec![]
        };
        let internal_host_tools = recall_tools
            .iter()
            .map(|tool| tool.definition.name.clone())
            .collect::<Vec<_>>();
        additional.extend(recall_tools);
        let scheduler = Arc::new(scheduler::Scheduler::new(
            persistence.store().clone(),
            prefix.clone(),
        ));
        if settings.scheduled_tasks {
            additional.extend(scheduler.tools());
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
            maka_plugin_core::storage::Namespace::new(
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
            return Err(initialization::InitializationError::owned(
                format!("agent_bot_unavailable: {error}"),
                configuration,
                None,
                persistence.store().clone(),
            ));
        }
        if settings.bot {
            additional.extend(bot.tools());
        }
        let internal_registrations = additional.clone();
        let mut mcp = match crate::mcp::Servers::open(&settings.mcp_servers, &configuration).await {
            Ok(mcp) => mcp,
            Err(error) => {
                return Err(initialization::InitializationError::owned(
                    error.message,
                    configuration,
                    error.material,
                    persistence.store().clone(),
                ));
            }
        };
        additional.append(&mut mcp.registrations);
        internal_bindings.append(&mut mcp.bindings);
        let internal_tools: Vec<_> = additional
            .iter()
            .map(|tool| tool.definition.clone())
            .collect();
        let prepared_tools = crate::tools::catalog(context.services(), &settings.tools, additional);
        let crate::tools::Catalog {
            tools,
            basis: tool_basis,
            editing: editing_tools,
            host_tools,
            resource_reads,
            discovery_reads,
        } = match prepared_tools {
            Ok(tools) => tools,
            Err(error) => {
                let mcp_cleanup = mcp.close().await;
                let (message, material) = match mcp_cleanup {
                    Ok(()) => (error, None),
                    Err(cleanup) => (
                        format!("{error}; MCP cleanup: {}", cleanup.message),
                        Some(cleanup.material),
                    ),
                };
                return Err(initialization::InitializationError::owned(
                    message,
                    configuration,
                    material,
                    persistence.store().clone(),
                ));
            }
        };
        let credentials = crate::model::Credentials {
            #[cfg(test)]
            observation: None,
            executor: models.clone(),
            inventory: Arc::new(crate::model::codex_inventory::Authority::new(
                workers.clone(),
                stop.clone(),
            )),
            refresh: Arc::new(crate::model::oauth::Authority::new(
                workers.clone(),
                stop.clone(),
            )),
        };
        let mcp_projects = Arc::new(crate::mcp::Projects::new(
            crate::mcp::Catalog {
                revision: None,
                client_mcp: None,
                live_bindings: mcp.live_bindings.clone(),
                _parent: None,
                _layer_owner: None,
                tools: tools.clone(),
                definitions: Arc::new(internal_tools),
                bindings: Arc::new(internal_bindings),
            },
            prefix.clone(),
            instruction_home.clone().zip(
                settings
                    .assistant
                    .as_ref()
                    .and_then(|assistant| assistant.home.as_ref())
                    .map(std::path::PathBuf::from),
            ),
            durable.clone(),
            maka_agent_facts::durable::RunOwner {
                deployment: data_source.deployment,
                namespace: data_source.namespace.clone(),
            },
            configuration.clone(),
            workers.clone(),
            stop.child_token(),
        ));
        let owner = Arc::new(Self {
            helper,
            pricing,
            goals,
            auxiliary,
            todo,
            bot,
            recap_storage,
            scheduler,
            recall,
            store: persistence.store().clone(),
            model_reader_process,
            durable,
            services: context.services().clone(),
            wake_notify: tokio::sync::Notify::new(),
            physical_changes: tokio::sync::watch::channel(()).0,
            prefix,
            data_source,
            workspace_roots,
            import_roots,
            managed_worktrees,
            home,
            revision,
            configured_locale,
            native_language,
            instruction_home,
            settings,
            configuration,
            catalog,
            credentials,
            code_executor,
            tools,
            internal_registrations,
            mcp,
            mcp_projects,
            tool_basis: Arc::new(tool_basis),
            host_tools: host_tools.into_iter().chain(internal_host_tools).collect(),
            resource_reads,
            discovery_reads,
            editing_tools,
            skills,
            executors,
            runs: Arc::default(),
            titles: title::Registry::default(),
            workers,
            cleanup_workers: TaskTracker::new(),
            producers: TaskTracker::new(),
            producer_gate: Arc::default(),
            stop,
        });
        if let Err(error) = owner.durable.ensure_diagnostics(owner.run_owner()).await {
            return Err(initialization::InitializationError::instance(
                error.to_string(),
                owner,
            ));
        }
        if let Err(error) = owner.restore_discovery().await {
            return Err(initialization::InitializationError::instance(error, owner));
        }
        Ok(owner)
    }
    #[cfg(test)]
    pub(crate) fn with_model_observation(
        mut self: Arc<Self>,
        observation: crate::model::Observation,
    ) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .expect("install fixture observation before publishing the Native owner")
            .credentials
            .observation = Some(observation);
        self
    }

    pub(crate) fn physical_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.physical_changes.subscribe()
    }
    fn physical_availability_changed(&self) {
        self.physical_availability_changed_after(true);
    }
    fn physical_availability_changed_after(&self, retry_ready: bool) {
        self.physical_changes.send_modify(|_| {});
        self.goals.execution_changed();
        self.scheduler.execution_changed();
        if retry_ready {
            self.wake_notify.notify_one();
            if let Ok(root) = self.store.owned_root() {
                root.capability_source_changed();
            }
        }
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
        if scope
            .identity
            .agent()
            .is_some_and(|execution| execution.session_id == id)
        {
            let custody = scope.work_custody().ok_or("agent_work_custody_required")?;
            self.store
                .session_for_work(custody.as_ref(), id)
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
    pub(in crate::owner) async fn mutable_session(
        &self,
        id: &str,
    ) -> Result<SessionRecord<ResolvedConfiguration>, String> {
        self.session(id).await
    }
    pub(crate) fn caller_store(
        &self,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<maka_event_log::SessionStore, String> {
        let execution = scope.identity.agent().ok_or("agent_execution_required")?;
        let custody = scope.work_custody().ok_or("agent_work_custody_required")?;
        self.store
            .session_for_work(custody.as_ref(), &execution.session_id)
            .map_err(|error| error.to_string())
    }

    async fn creation_policy(
        &self,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<CreationPolicy, String> {
        let Some(invocation) = scope.identity.agent() else {
            return Ok(CreationPolicy {
                permissions: self.settings.permissions.clone(),
                tools: None,
                caller: None,
            });
        };
        let store = self.caller_store(scope)?;
        let caller = store
            .get::<StoredSessionConfiguration>()
            .await
            .map_err(|error| error.to_string())?
            .filter(|session| !session.archived)
            .ok_or("agent_session_unavailable")?;
        let caller = resolve_session(caller)?.configuration;
        let custody = scope.work_custody().ok_or("agent_work_custody_required")?;
        let writer = self
            .store
            .data_writer_for_work(custody.as_ref(), &invocation.session_id)
            .map_err(|error| error.to_string())?;
        let view = self
            .durable
            .with_data_writer(writer)
            .map_err(|error| error.to_string())?
            .frontier(invocation.run_id)
            .await
            .map_err(|error| error.to_string())?;
        if view.spec.session_id != invocation.session_id
            || !matches!(
                view.spec.origin,
                maka_agent_facts::durable::RunOrigin::Local
            )
            || view.stopped
            || view.terminal.is_some()
        {
            return Err("agent_execution_closed".into());
        }
        if view.spec.permission_basis != caller.permission_basis() {
            return Err("agent_session_configuration_changed".into());
        }
        if self.settings.bot {
            self.bot.load().await.map_err(|error| error.to_string())?;
        }
        let fence = maka_agent_state::CallerFence {
            execution: invocation.clone(),
            expected_basis: Some(view.spec.permission_basis),
        };
        Ok(CreationPolicy {
            permissions: caller.permissions,
            // The Bot delegates workers; its own conversational tool list is not their ceiling.
            tools: if self.settings.bot && self.bot.is(&invocation.session_id) {
                None
            } else {
                caller.tools
            },
            caller: Some(fence),
        })
    }

    pub async fn create(
        self: &Arc<Self>,
        input: Create,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<Created>, String> {
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                owner
                    .create_inner(input, &operation, &scope, creation::Purpose::Session)
                    .await
                    .map(creation::PreparedCreation::into_session)
            })
        })
        .await
    }
    async fn create_inner(
        &self,
        input: Create,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
        purpose: creation::Purpose,
    ) -> Result<creation::PreparedCreation, String> {
        if let Some(reason) = metadata_rejection(&input.title, &input.labels) {
            return Ok(creation::PreparedCreation::Rejected(reason));
        }
        let applied_preset = if let Some(id) = input.preset_id {
            if input.backend.is_some() {
                return Ok(creation::PreparedCreation::Rejected(
                    Rejection::PresetBackendConflict,
                ));
            }
            let Some(detail) = self
                .preset(maka_agent_api::preset::PresetRead { id })
                .await?
            else {
                return Ok(creation::PreparedCreation::Rejected(
                    Rejection::PresetNotFound,
                ));
            };
            use maka_agent_api::preset::{AppliedPreset, PresetAvailability};
            let reason = match detail.availability {
                PresetAvailability::Available => None,
                PresetAvailability::Disabled => Some(Rejection::PresetDisabled),
                PresetAvailability::ModelUnavailable => Some(Rejection::PresetModelUnavailable),
                PresetAvailability::ThinkingLevelUnavailable => {
                    Some(Rejection::PresetThinkingLevelUnavailable)
                }
            };
            if let Some(reason) = reason {
                return Ok(creation::PreparedCreation::Rejected(reason));
            }
            let p = detail.preset;
            Some(AppliedPreset {
                id: p.id,
                revision: p.revision,
                name: p.name,
                instruction: p.instruction,
                model: p.model,
                thinking_level: p.thinking_level,
            })
        } else {
            None
        };
        let backend = if let Some(p) = &applied_preset {
            Some(BackendPreference::Model {
                connection_id: p.model.connection_id.clone(),
                model_id: p.model.model_id.clone(),
                thinking_level: p.thinking_level,
            })
        } else {
            self.use_bot_model(scope, input.backend).await?
        };
        if let Some(backend) = &backend
            && !self.backend_available(backend).await?
        {
            return Ok(creation::PreparedCreation::Rejected(
                if applied_preset.is_some() {
                    Rejection::PresetModelUnavailable
                } else {
                    Rejection::ToolsUnavailable
                },
            ));
        }
        let id = self.operation_id(operation);
        let admission = self.runs.session(&id).await;
        if admission.state().await.closing {
            return Ok(creation::PreparedCreation::Rejected(Rejection::Closed));
        }
        let policy = self.creation_policy(scope).await?;
        let mut permissions = policy.permissions;
        if scope.identity.agent().is_none() {
            let defaults = self
                .configuration
                .runtime_policy()
                .await
                .map_err(|_| "agent_settings_unavailable")?
                .policy
                .chat_defaults;
            permissions.access = match defaults.sandbox_mode {
                SandboxMode::ReadOnly => WorkspaceAccess::ReadOnly,
                SandboxMode::WorkspaceWrite => WorkspaceAccess::WorkspaceWrite,
                SandboxMode::DangerFullAccess => WorkspaceAccess::DangerFullAccess,
            };
        }
        let mut tools = intersect_tools(input.tools, policy.tools);
        // SendUser and sleep follow Bot identity, never a requested tool list.
        if tools.as_ref().is_some_and(|names| {
            names
                .iter()
                .any(|name| name == bot::SEND_USER || name == bot::SLEEP)
        }) {
            return Ok(creation::PreparedCreation::Rejected(
                Rejection::ToolsUnavailable,
            ));
        }
        if let Some(names) = &mut tools {
            names.sort();
            if names.windows(2).any(|pair| pair[0] == pair[1]) {
                return Ok(creation::PreparedCreation::Rejected(
                    Rejection::ToolsUnavailable,
                ));
            }
        }
        let (selected, project) = match input.workspace {
            WorkspaceSelection::IsolatedGit { path } => {
                let Some(workspace) = self.isolated_workspace(&path, operation, scope).await?
                else {
                    return Ok(creation::PreparedCreation::Rejected(
                        Rejection::WorkspaceUnavailable,
                    ));
                };
                (workspace, None)
            }
            WorkspaceSelection::Project { project, path } => {
                let Some(prepared) = self.select_project(project, &path).await? else {
                    return Ok(creation::PreparedCreation::Rejected(
                        Rejection::WorkspaceUnavailable,
                    ));
                };
                (prepared.workspace, Some(prepared.project))
            }
            WorkspaceSelection::Directory { path } => {
                let Some(prepared) = self.create_project_workspace(&path).await? else {
                    return Ok(creation::PreparedCreation::Rejected(
                        Rejection::WorkspaceUnavailable,
                    ));
                };
                (prepared.workspace, Some(prepared.project))
            }
            WorkspaceSelection::Session { session_id } => {
                if !self.owns(&session_id) {
                    return Ok(creation::PreparedCreation::Rejected(
                        Rejection::SessionUnavailable,
                    ));
                }
                let Some(session) = self
                    .store
                    .get_session::<StoredSessionConfiguration>(&session_id)
                    .await
                    .map_err(|_| "agent_store_unavailable")?
                else {
                    return Ok(creation::PreparedCreation::Rejected(
                        Rejection::SessionUnavailable,
                    ));
                };
                let session = resolve_session(session)?;
                // A user may start a conversation in the workspace of one they archived;
                // an Agent may not derive from a conversation that was put away.
                if (session.archived && scope.identity.agent().is_some())
                    || !self
                        .project_accepts_session(&session.configuration.workspace)
                        .await?
                {
                    return Ok(creation::PreparedCreation::Rejected(
                        Rejection::SessionUnavailable,
                    ));
                }
                if workspace::validate(
                    &self.workspace_roots,
                    &session.configuration.workspace,
                    &self.managed_worktrees,
                )
                .await
                .is_err()
                {
                    return Ok(creation::PreparedCreation::Rejected(
                        Rejection::WorkspaceUnavailable,
                    ));
                }
                (session.configuration.workspace, None)
            }
        };
        if let Some(names) = &tools
            && names.iter().any(|name| !self.tools.contains(name))
        {
            // A ceiling containing only baseline tools never starts project servers.
            let root = self
                .store
                .owned_root()
                .map_err(|error| error.to_string())?
                .canonical_path()
                .to_path_buf();
            let workspace = selected.clone();
            let access = permissions.access;
            let (sandbox, _) =
                tokio::task::spawn_blocking(move || workspace::sandbox(&workspace, access, &root))
                    .await
                    .map_err(|error| error.to_string())??;
            let floor = sandbox
                .intersect(scope.sandbox_floor())
                .map_err(|error| error.to_string())?;
            let catalog = self.mcp_projects.available(&selected, &floor).await?;
            if names
                .iter()
                .any(|name| !self.tools.contains(name) && !catalog.tools.contains(name))
            {
                return Ok(creation::PreparedCreation::Rejected(
                    Rejection::ToolsUnavailable,
                ));
            }
        }
        let parent_session_id = scope
            .identity
            .agent()
            .map(|source| source.session_id.clone());
        self.prepare_created_session(
            &id,
            operation,
            &selected,
            project,
            scope,
            policy.caller,
            purpose,
            applied_preset.as_ref().map(|p| presets::CreationFence {
                scope: self.prefix.clone(),
                id: p.id.clone(),
                revision: p.revision,
            }),
            move |binding| StoredSessionConfiguration {
                parent_session_id,
                backend,
                applied_preset,
                compaction_prompt: None,
                collaboration_mode: CollaborationMode::Agent,
                tools,
                title: input.title,
                title_is_manual: !input.automatic_title,
                pinned: false,
                labels: input.labels,
                workspace: binding,
                permissions,
                boundary_revision: 0,
            },
        )
        .await
    }
    pub async fn metadata(
        self: &Arc<Self>,
        input: Metadata,
        scope: &maka_capabilities::call::Scope,
        _operation: &maka_plugin_core::operation::RecoveryRef,
    ) -> Result<NativeMutation<MetadataResult>, String> {
        if input.permissions.is_some()
            && !matches!(
                scope.identity,
                maka_capabilities::call::Identity::Remote { .. }
            )
        {
            return Ok(NativeMutation::Returned(MetadataResult::Rejected {
                reason: Rejection::PermissionChangeRequiresUser,
            }));
        }
        if let Some(reason) = metadata_rejection(&input.title, &input.labels) {
            return Ok(NativeMutation::Returned(MetadataResult::Rejected {
                reason,
            }));
        }
        if !self.owns(&input.session_id) {
            return Ok(NativeMutation::Returned(MetadataResult::Rejected {
                reason: Rejection::SessionUnavailable,
            }));
        }
        let ordered = Arc::new(self.runs.ordered(&input.session_id).await);
        if self.stop.is_cancelled()
            || scope.cancellation.is_cancelled()
            || self.runs.state().await.closing
        {
            return Ok(NativeMutation::Returned(MetadataResult::Rejected {
                reason: Rejection::Closed,
            }));
        }
        let Some(record) = self
            .canonical_catalog()?
            .record(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(NativeMutation::Returned(MetadataResult::Rejected {
                reason: Rejection::SessionUnavailable,
            }));
        };
        if record.metadata.archived {
            return Ok(NativeMutation::Returned(MetadataResult::Rejected {
                reason: Rejection::SessionUnavailable,
            }));
        }
        if record.metadata.revision != input.expected_revision {
            return Ok(NativeMutation::Returned(MetadataResult::RevisionConflict {
                expected: input.expected_revision,
                actual: record.metadata.revision,
            }));
        }
        let configuration: StoredSessionConfiguration =
            serde_json::from_value(record.metadata.configuration.clone())
                .map_err(|error| format!("agent_session_configuration_invalid: {error}"))?;
        let invalidate_grants = input.permissions.as_ref().is_some_and(|change| {
            change.settings.access != configuration.permissions.access || change.revoke_grants
        });
        // Live Runs retain their original approval ceiling.
        let enabling_requests = input.permissions.as_ref().is_some_and(|change| {
            change.settings.request_permissions && !configuration.permissions.request_permissions
        });
        let guard = if invalidate_grants || enabling_requests {
            let busy = self.runs.state().await.busy(&input.session_id)
                || self.mcp_projects.has_any_client(&input.session_id);
            let guard = self
                .durable
                .quiescence_guard(self.run_owner(), input.session_id.clone())
                .map_err(|error| error.to_string())?;
            if busy
                || !guard
                    .observe()
                    .await
                    .map_err(|error| error.to_string())?
                    .is_quiescent()
            {
                return Ok(NativeMutation::Returned(MetadataResult::Rejected {
                    reason: Rejection::Busy,
                }));
            }
            Some(guard)
        } else {
            None
        };
        self.prepare_configuration(record, ordered, guard, move |configuration| {
            if (input.permissions.is_none() && input.pinned.is_none())
                || configuration.title != input.title
            {
                configuration.title_is_manual = true;
            }
            configuration.title = input.title;
            configuration.labels = input.labels;
            if let Some(pinned) = input.pinned {
                configuration.pinned = pinned;
            }
            if invalidate_grants {
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
            Ok(())
        })
        .await
    }
    pub(super) async fn tool_names(
        self: &Arc<Self>,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<crate::contract::ToolNames, String> {
        self.resource_work(scope, |owner, scope| {
            Box::pin(async move {
                let catalog = owner
                    .mcp_projects
                    .capture_global(scope.sandbox_floor())
                    .await?;
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
        basis: &CapturedRun,
        editing: Option<maka_agent_facts::execution::EditingTools>,
    ) -> Result<crate::tools::Declarations, String> {
        let catalog = match &basis.mcp_catalog {
            Some(catalog) => catalog.clone(),
            None => self.mcp_projects.catalog(basis.mcp_revision.as_deref())?,
        };
        Ok(self.select_catalog_tools(
            &catalog.tools,
            Some(session),
            basis.allowed_tools.as_deref(),
            editing,
        ))
    }
    fn select_catalog_tools(
        &self,
        catalog: &crate::tools::Declarations,
        session: Option<&str>,
        allowed_tools: Option<&[String]>,
        editing: Option<maka_agent_facts::execution::EditingTools>,
    ) -> crate::tools::Declarations {
        let bot = session.is_some_and(|session| self.bot.is(session));
        let investigation = session.is_some_and(|id| {
            self.scheduler
                .investigation
                .read()
                .unwrap()
                .as_ref()
                .is_some_and(|active| active == id)
        });
        let excluded: Vec<_> = catalog
            .definitions()
            .map(|definition| definition.name.as_str())
            .filter(|name| {
                let bot_only = *name == bot::SEND_USER || *name == bot::SLEEP;
                let memory = *name == discovery::MEMORY;
                (*name == discovery::COMPLETE && !investigation)
                    || (*name == discovery::CONTEXT && (!investigation || !self.settings.recall))
                    || (memory && (!self.settings.scheduled_tasks || !(bot || investigation)))
                    || (bot_only && !bot)
                    || (!(bot && (bot_only || memory))
                        && allowed_tools.is_some_and(|allowed| {
                            !allowed.iter().any(|allowed| allowed.as_str() == *name)
                        }))
                    || editing.is_some_and(|editing| {
                        self.editing_tools
                            .iter()
                            .any(|(tool, style)| tool.as_str() == *name && *style != editing)
                    })
            })
            .collect();
        catalog.excluding(&excluded)
    }
    fn external_catalog(&self, selected: maka_tools::ToolCatalog) -> maka_tools::ToolCatalog {
        let excluded = selected
            .names()
            .into_iter()
            .filter(|name| !self.host_tools.contains(name))
            .collect::<Vec<_>>();
        let mut catalog =
            selected.excluding(&excluded.iter().map(String::as_str).collect::<Vec<_>>());
        for name in &self.resource_reads {
            catalog = catalog.with_description(name, "Read only Maka Session attachment:<id> and archive:<event-id> resources. Workspace files and task resources are unavailable. Pass the complete page.next object unchanged to continue. Image resources are unsupported by this external runtime.");
        }
        catalog
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
        // The producer gate fences actual completion delivery. Durable
        // subscriptions can wait for work or authority across Host lifetimes.
        if !runs.controls.is_empty()
            || !runs.preparing.is_empty()
            || !self.workers.is_empty()
            || !self.cleanup_workers.is_empty()
            || self.auxiliary.resources.has_pending()
            || self.goals.keeps_host_awake()
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
            owner.cleanup_workers.close();
            owner.cleanup_workers.wait().await;
            let scheduler = owner.scheduler.finish().await;
            let todo = owner.todo.finish().await;
            let bot = owner.bot.finish().await;
            let goals = owner.goals.finish().await;
            let recap = owner.recap_storage.finish().await;
            let executors = owner.executors.finish().await;
            let auxiliary = owner.auxiliary.resources.finish().await;
            let projects = owner.mcp_projects.close().await;
            let mcp = owner.mcp.close().await.map_err(|error| {
                let diagnostic = error.message.clone();
                owner.mcp_projects.retain_transport_cleanup(error);
                diagnostic
            });
            let configuration = owner.configuration.shutdown().await;
            if let Err(error) = &configuration {
                tracing::error!(stage = "configuration_store_shutdown", cause = crate::diagnostics::config_cause(error),
                    activation = %owner.revision.activation, instance = ?owner.data_source.namespace,
                    "Agent configuration store cleanup failed");
            }
            owner.try_confirm_retained_scopes().await;
            let runs = owner.runs.lock().await;
            if !runs.retained_cleanup.is_empty() || !runs.preparing.is_empty() {
                return Err("agent_cleanup_unconfirmed".into());
            }
            projects?;
            mcp?;
            scheduler?;
            todo?;
            bot?;
            goals?;
            recap?;
            executors?;
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

pub(crate) fn owns_session(prefix: &str, id: &str) -> bool {
    id.strip_prefix(prefix).is_some_and(|tail| {
        tail.len() == 32
            && tail
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
