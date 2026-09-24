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

mod access;
mod artifacts;
mod authority;
mod bootstrap;
pub(crate) mod capabilities;
mod catalog_feed;
pub(crate) use catalog_feed::CatalogFeed;
pub(crate) mod configuration;
mod connection;
mod connection_effects;
mod context;
mod diagnostics;
mod dispatch;
mod execution_boundary;
mod handshake;
pub(crate) mod interactions;
mod listeners;
pub mod local;
pub(crate) mod messages;
mod navigation;
mod oauth;
mod onboarding;
mod operations;
mod outbound;
pub(crate) mod plugin_authorization;
mod plugin_remote;
pub(crate) mod pricing;
mod projects;
mod sandbox_setup;
pub(crate) use projects::Usage as ProjectUsage;
pub(crate) use projects::resolve_record as resolve_project_workspace;
mod registration;
mod resources;
pub(crate) mod retirement;
mod sessions;
pub(crate) use sessions::workspace::resolve_path as resolve_workspace_path;
mod subscriptions;
mod turns;
pub mod websocket;

use std::error::Error;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use maka_config::ConfigurationStore;
use maka_event_log::EventLog;
use maka_event_log::root::RootOwner;
use maka_protocol::handshake::Lifecycle;
use maka_transport::{MessageReader, MessageWriter};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use uuid::Uuid;

pub type HostError = Box<dyn Error + Send + Sync>;
pub use operations::Operations as HostOperations;
pub use projects::DirectoryRootSpec;
pub use registration::Registration;

/// Who owns process lifetime, independent of its deployment revision.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleMode {
    #[default]
    Ephemeral,
    Service,
}

pub struct HostOptions {
    /// Explicit non-secret, read-only inputs shared equally with all Host plugins.
    pub input_roots: maka_plugins::filesystem::ReadRoots,
    pub plugins: crate::plugins::Setup,
    pub lifecycle_mode: LifecycleMode,
    pub project_directory_roots: Option<Vec<DirectoryRootSpec>>,
    /// Explicit user skill root; library embedders do not inspect ambient home.
    pub skill_home: Option<std::path::PathBuf>,
    pub generation: Option<String>,
    pub handshake_timeout: Duration,
}

impl Default for HostOptions {
    fn default() -> Self {
        Self {
            input_roots: Default::default(),
            plugins: Default::default(),
            lifecycle_mode: LifecycleMode::Ephemeral,
            project_directory_roots: None,
            skill_home: None,
            generation: None,
            handshake_timeout: Duration::from_secs(2),
        }
    }
}

pub struct Host {
    plugins: crate::plugins::Platform,
    plugin_tasks: TaskTracker,
    plugin_remotes: plugin_remote::Registry,
    options: HostOptions,
    retirement: Arc<Mutex<retirement::Phase>>,
    accepted_connections: Mutex<std::collections::HashSet<Uuid>>,
    started: std::time::Instant,
    accepted_connection_revision: AtomicU64,
    executions: Arc<crate::execution::Executions>,
    shells: Arc<crate::shell::ShellResources>,
    controllers: crate::controllers::Controllers,
    capabilities: Arc<capabilities::Capabilities>,
    interactions: Arc<interactions::Interactions>,
    uploads: artifacts::Uploads,
    project_directories: projects::Directories,
    project_usage: ProjectUsage,
    // Log connections close before root authority is released.
    log: Arc<EventLog>,
    configuration: Arc<ConfigurationStore>,
    pricing: Arc<pricing::Catalog>,
    connection_effects: connection_effects::ConnectionEffects,
    oauth: oauth::Coordinator,
    changes: broadcast::Sender<serde_json::Value>,
    change_revision: Arc<AtomicU64>,
    access_revocations: broadcast::Sender<String>,
    access_changed: tokio::sync::Notify,
    session_catalog: Arc<catalog_feed::CatalogFeed>,
    subscriptions: subscriptions::Registry,
    root: Arc<RootOwner>,
    epoch: String,
    connections: AtomicUsize,
    draining: CancellationToken,
    requests: TaskTracker,
    commands: TaskTracker,
    diagnostic_log: Mutex<diagnostics::Log>,
}

impl Drop for Host {
    fn drop(&mut self) {
        // Recovery starts before listener setup. Losing the last Host owner
        // must cancel it even when no listener ever reached its shutdown path.
        // Workers retain root authority until their cleanup completes.
        self.draining.cancel();
    }
}

impl Host {
    /// Observe shutdown without granting the observer cancellation authority.
    pub fn wait_for_drain(&self) -> impl Future<Output = ()> + Send + 'static + use<> {
        self.draining.clone().cancelled_owned()
    }

    pub async fn open(root: RootOwner) -> Result<Arc<Self>, HostError> {
        Self::open_with_global_instructions(root, None).await
    }

    /// Embedders explicitly supply user-global instructions; no ambient home
    /// directory is consulted by the library. The standalone CLI supplies it.
    pub async fn open_with_global_instructions(
        root: RootOwner,
        global_instructions: Option<std::path::PathBuf>,
    ) -> Result<Arc<Self>, HostError> {
        Self::open_with_options(root, global_instructions, HostOptions::default()).await
    }

    pub async fn open_with_options(
        root: RootOwner,
        global_instructions: Option<std::path::PathBuf>,
        mut options: HostOptions,
    ) -> Result<Arc<Self>, HostError> {
        if let Some(generation) = &options.generation {
            maka_protocol::codec::string(&serde_json::json!(generation), "generation", 128)?;
        }
        if options.handshake_timeout.is_zero()
            || options.handshake_timeout > Duration::from_secs(300)
        {
            return Err("handshake timeout must be in (0, 300s]".into());
        }
        root.validate_current()?;
        if options
            .skill_home
            .as_ref()
            .is_some_and(|home| !home.is_absolute())
        {
            return Err("Skill home must be an absolute directory".into());
        }
        let project_directories =
            projects::Directories::open(options.project_directory_roots.take())
                .map_err(|error| error.message)?;
        let root = Arc::new(root);
        access::purge(&root).await?;
        let log = Arc::new(EventLog::for_root(root.clone()).await?);
        maka_agent::recovery::recover(&log).await?;
        let recovered_at = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis(),
        )?;
        log.recover_shell_runs(recovered_at).await?;
        log.recover_host_effects().await?;
        log.recover_auxiliary_models().await?;
        let configuration = Arc::new(ConfigurationStore::for_root(root.clone()).await?);
        let draining = CancellationToken::new();
        let startup_guard = draining.clone().drop_guard();
        let capabilities = Arc::new(capabilities::Capabilities::default());
        let epoch = Uuid::new_v4().to_string();
        log.begin_message_epoch(&epoch).await?;
        let changes = broadcast::channel(64).0;
        let change_revision = Arc::new(AtomicU64::new(0));
        let pricing = pricing::Catalog::new(
            configuration.clone(),
            changes.clone(),
            change_revision.clone(),
        );
        let project_usage =
            ProjectUsage::new(log.clone(), changes.clone(), change_revision.clone());
        let session_catalog = Arc::new(catalog_feed::CatalogFeed::new(
            *log.subscribe_commits().borrow(),
            changes.clone(),
        ));
        let interactions = Arc::new(interactions::Interactions::new(
            log.clone(),
            draining.clone(),
            epoch.clone(),
            session_catalog.clone(),
        ));
        let runtime = maka_js_runtime::trusted::TrustedRuntime::default();
        let executions = Arc::new(crate::execution::Executions::new(
            log.clone(),
            configuration.clone(),
            draining.clone(),
            capabilities.clone(),
            interactions.clone(),
            crate::execution::ExecutionPaths {
                state_root: root.canonical_path().to_owned(),
            },
            runtime.clone(),
        )?);
        let mut setup = std::mem::take(&mut options.plugins);
        if let Some(home) = &options.skill_home {
            let root = maka_plugins::filesystem::ReadRoot::open(home).await?;
            options.input_roots.0.insert(
                "user-skills".into(),
                root.select(
                    [
                        ".maka/skills/".into(),
                        ".agents/skills/".into(),
                        ".maka/skill-sources/".into(),
                    ]
                    .into(),
                )?,
            );
        }
        crate::plugins::skills::install(&mut setup)?;
        crate::plugins::jev::install(&mut setup)?;
        crate::plugins::session_recap::install(&mut setup)?;
        crate::plugins::goal::install(&mut setup)?;
        crate::plugins::background_health::install(&mut setup)?;
        crate::plugins::web::install(&mut setup)?;
        crate::plugins::insights::install(&mut setup)?;
        crate::plugins::session_import::install(&mut setup)?;
        crate::plugins::external_agent::install(&mut setup)?;
        crate::plugins::todo::install(&mut setup)?;
        crate::plugins::recall::install(&mut setup)?;
        crate::plugins::assistant::install(&mut setup)?;
        crate::plugins::models::install(&mut setup, runtime.clone())?;
        if let Some(path) = global_instructions {
            match maka_plugins::filesystem::ReadRoot::open(path).await {
                Ok(root) => {
                    options.input_roots.0.insert(
                        "user-instructions".into(),
                        root.select(maka_assistant::input_files())?,
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        crate::plugins::graph::install(&mut setup)?;
        crate::plugins::workhub::install(&mut setup)?;
        crate::plugins::scheduler::install(&mut setup)?;
        if setup.loader.is_none() {
            setup.loader = Some(Arc::new(crate::plugins::javascript::Loader::new(
                &executions,
            )?));
        }
        let data_root = root.canonical_path().to_owned();
        let data = tokio::task::spawn_blocking(move || {
            maka_plugins::storage::Directories::open(&data_root)
        })
        .await??;
        let kernel = maka_plugins::kernel::Kernel::new(
            maka_plugins::services::Services::default(),
            executions.plugin_catalog.clone(),
        )
        .with_data(data.clone())
        .with_host(crate::plugins::host::Issuer::new(
            &executions,
            configuration.clone(),
            root.root_id().into(),
            std::mem::take(&mut options.input_roots),
            pricing.clone(),
            data,
        ));
        let (plugins, plugin_owner) = crate::plugins::Platform::open(
            log.clone(),
            Arc::new(crate::plugins::ExternalLoader(setup.loader)),
            setup.builtins,
            setup.layers,
            kernel,
            draining.clone(),
        )
        .await?;
        let plugin_tasks = TaskTracker::new();
        plugin_tasks.spawn(
            plugins
                .clone()
                .publish_catalog_changes(changes.clone(), draining.clone()),
        );
        let plugin_failure = draining.clone();
        plugin_tasks.spawn(async move {
            if let Err(error) = plugin_owner.await {
                eprintln!("plugin platform cleanup failed: {error}");
                plugin_failure.cancel();
            }
        });
        let host = Arc::new(Self {
            plugin_remotes: Default::default(),
            plugins,
            plugin_tasks,
            options,
            retirement: interactions.retirement.clone(),
            accepted_connections: Mutex::default(),
            started: std::time::Instant::now(),
            accepted_connection_revision: AtomicU64::new(0),
            shells: executions.shells.clone(),
            controllers: executions.controllers.clone(),
            executions,
            capabilities,
            interactions,
            uploads: Default::default(),
            project_directories,
            project_usage,
            log,
            configuration,
            pricing,
            connection_effects: connection_effects::ConnectionEffects::default(),
            oauth: oauth::Coordinator::default(),
            changes,
            change_revision,
            access_revocations: broadcast::channel(64).0,
            access_changed: tokio::sync::Notify::new(),
            session_catalog,
            subscriptions: Default::default(),
            root,
            epoch,
            connections: AtomicUsize::new(0),
            draining,
            requests: TaskTracker::new(),
            commands: TaskTracker::new(),
            diagnostic_log: Mutex::default(),
        });
        startup_guard.disarm();
        host.executions
            .start_handoff_recovery(host.epoch.clone(), host.plugins.clone());
        host.executions.start_removal_recovery();
        host.record_diagnostic(format_args!("Host ready: epoch {}", host.epoch));
        Ok(host)
    }

    pub fn root_id(&self) -> &str {
        self.root.root_id()
    }

    pub fn plugin_storage(
        &self,
        context: maka_plugins::fiber::Context,
    ) -> Result<Arc<dyn maka_plugins::storage::Store>, maka_plugins::Error> {
        Ok(Arc::new(crate::plugins::storage::BoundStore::new(
            self.log.clone(),
            self.configuration.clone(),
            context,
            self.requests.clone(),
            self.draining.clone(),
        )?))
    }

    pub fn plugin_credentials(
        &self,
        context: maka_plugins::fiber::Context,
    ) -> Result<Arc<dyn maka_plugins::credentials::Credentials>, maka_plugins::Error> {
        Ok(self.executions.plugin_store(context)?)
    }

    /// Explicit Host grant for background plugin execution. The capability is
    /// bound to this instance and these Sessions' current permission boundaries.
    pub async fn authorize_plugin_execution(
        &self,
        context: maka_plugins::fiber::Context,
        sessions: &[String],
    ) -> Result<
        std::sync::Arc<dyn maka_plugins::execution::Commands>,
        maka_plugins::execution::CommandError,
    > {
        self.executions
            .authorize_plugin(context, sessions, self.root_id(), CancellationToken::new())
            .await
    }
    pub fn control_directory(&self) -> &std::path::Path {
        self.root.control_directory()
    }

    /// An embedder's explicit grant remains restricted to the original persisted
    /// boundaries. Deserializing these records alone grants no authority.
    pub fn restore_plugin_execution(
        &self,
        context: maka_plugins::fiber::Context,
        boundaries: Vec<maka_plugins::execution::SessionBoundary>,
    ) -> Result<Arc<dyn maka_plugins::execution::Commands>, maka_plugins::execution::CommandError>
    {
        self.executions.restore_plugin_authority(
            context,
            boundaries,
            self.root_id(),
            CancellationToken::new(),
        )
    }

    /// Separately grant root creation from one fully explicit, frozen template.
    /// Ordinary Session execution grants never include this capability.
    pub fn authorize_plugin_root_execution(
        &self,
        context: maka_plugins::fiber::Context,
        approval: maka_plugins::execution::RootApproval,
    ) -> Result<Arc<dyn maka_plugins::execution::Commands>, maka_plugins::execution::CommandError>
    {
        self.executions.authorize_plugin_root(
            context,
            approval,
            self.root_id(),
            CancellationToken::new(),
        )
    }

    /// Candidate expiry observes accepted work; a disconnected model or PTY still owns residency.
    pub async fn wait_until_idle(&self, initial_timeout: Duration, idle_grace: Duration) {
        let initial = tokio::time::Instant::now() + initial_timeout;
        let mut idle_since = None;
        let mut observed = 0;
        loop {
            let now = tokio::time::Instant::now();
            let revision = self.accepted_connection_revision.load(Ordering::SeqCst);
            if revision != observed {
                // A complete activation/probe can occur between two polls.
                // Its absence from the live count must not erase that activity.
                idle_since = None;
                observed = revision;
            }
            // Recovery can admit work before the first client connection.
            // Read the recoverable producer before its Host-owned executions:
            // scheduler settlement is allowed only after Host admission.
            let idle = self.plugins.pending_background_work() == 0
                && self.connections.load(Ordering::SeqCst) == 0
                && self.requests.is_empty()
                && self.executions.active_count() == 0
                && self.shells.active_count() == 0
                && self.oauth.active_count() == 0;
            if idle {
                if (revision != 0 || now >= initial)
                    && now.duration_since(*idle_since.get_or_insert(now)) >= idle_grace
                {
                    return;
                }
            } else {
                idle_since = None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// The caller must enforce local-owner OS access before entering here.
    /// Remote transports use authenticated authority, never this entry point.
    pub async fn local_owner_connection(
        self: Arc<Self>,
        reader: impl MessageReader,
        writer: impl MessageWriter,
    ) -> Result<(), HostError> {
        self.authorized_connection(
            reader,
            writer,
            authority::Authority::LocalOwner,
            CancellationToken::new(),
        )
        .await
    }

    fn lifecycle(&self) -> Lifecycle {
        if self.draining.is_cancelled()
            || *self.retirement.lock().unwrap_or_else(|e| e.into_inner())
                == retirement::Phase::Retiring
        {
            Lifecycle::Draining
        } else {
            Lifecycle::Ready
        }
    }
}

struct ConnectionCount<'a>(&'a AtomicUsize);
impl Drop for ConnectionCount<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct AcceptedConnection<'a> {
    connections: &'a Mutex<std::collections::HashSet<Uuid>>,
    id: Uuid,
}
impl Drop for AcceptedConnection<'_> {
    fn drop(&mut self) {
        self.connections.lock().unwrap().remove(&self.id);
    }
}
