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

mod client;
use super::{Servers, files};
use crate::contract::{McpServerView, McpView, Workspace};
use client::Client;
use maka_agent_facts::{configuration::mcp::Transport, tools::ToolDefinition};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::Mutex;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum McpLayerOrigin {
    Installation,
    File {
        location: maka_skills::LocationId,
        config_digest: String,
    },
    Client,
}

#[derive(Clone)]
pub(crate) struct LiveServer {
    pub origin: McpLayerOrigin,
    connection: super::Connection,
}
impl LiveServer {
    pub(crate) fn new(origin: McpLayerOrigin, connection: super::Connection) -> Self {
        Self { origin, connection }
    }
    fn available(&self) -> bool {
        self.connection.available()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub(crate) struct ClientGeneration(uuid::Uuid);
impl ClientGeneration {
    pub fn fresh() -> Self {
        Self(uuid::Uuid::new_v4())
    }
}
pub(crate) struct Catalog {
    pub revision: Option<String>,
    pub client_mcp: Option<ClientGeneration>,
    pub _parent: Option<Arc<Catalog>>,
    // Retains an original published layer's physical owner, not another lookup parent.
    pub _layer_owner: Option<Arc<Catalog>>,
    pub tools: crate::tools::Declarations,
    pub definitions: Arc<Vec<ToolDefinition>>,
    pub bindings: Arc<BTreeMap<String, Option<String>>>,
    pub(crate) live_bindings: Vec<super::LiveBinding>,
    pub(crate) live_servers: Arc<BTreeMap<String, LiveServer>>,
}
impl Catalog {
    /// A fresh worker shares workspace tools. The outer client layer belongs to its original Session.
    pub(crate) fn for_new_session(&self) -> &Self {
        if self.client_mcp.is_some() {
            self._parent
                .as_deref()
                .expect("a client layer overlays a workspace catalog")
        } else {
            self
        }
    }

    fn with_layer(
        parent: Arc<Self>,
        revision: String,
        overrides: &BTreeSet<String>,
        live_bindings: Vec<super::LiveBinding>,
        layer_servers: BTreeMap<String, LiveServer>,
        layer_owner: Option<Arc<Self>>,
    ) -> Result<Arc<Self>, String> {
        let mut inherited = BTreeMap::new();
        parent.collect_bindings(&mut inherited);
        let suppressed: Vec<_> = inherited
            .values()
            .filter(|binding| overrides.contains(&binding.binding.server))
            .map(|binding| binding.name())
            .collect();
        let tools = parent
            .tools
            .excluding(&suppressed)
            .with_additional(live_bindings.iter().map(super::LiveBinding::declaration))
            .map_err(|_| "agent_mcp_catalog_invalid")?;
        let mut definitions: Vec<_> = parent
            .definitions
            .iter()
            .filter(|tool| !suppressed.contains(&tool.name.as_str()))
            .cloned()
            .collect();
        definitions.extend(
            live_bindings
                .iter()
                .map(|binding| binding.definition.clone()),
        );
        let mut bindings: BTreeMap<_, _> = parent
            .bindings
            .iter()
            .filter(|(name, _)| !suppressed.contains(&name.as_str()))
            .map(|(name, binding)| (name.clone(), binding.clone()))
            .collect();
        bindings.extend(live_bindings.iter().map(|binding| {
            (
                binding.name().to_owned(),
                Some(binding.binding.generation.clone()),
            )
        }));
        let mut live_servers: BTreeMap<String, LiveServer> = parent
            .live_servers
            .iter()
            .filter(|(name, _)| !overrides.contains(*name))
            .map(|(name, live)| (name.clone(), live.clone()))
            .collect();
        live_servers.extend(layer_servers);
        Ok(Arc::new(Self {
            revision: Some(revision),
            client_mcp: None,
            _parent: Some(parent),
            _layer_owner: layer_owner,
            tools,
            definitions: Arc::new(definitions),
            bindings: Arc::new(bindings),
            live_bindings,
            live_servers: Arc::new(live_servers),
        }))
    }
    pub(crate) fn unavailable_selected_binding<'a>(
        &self,
        names: impl IntoIterator<Item = &'a str>,
    ) -> Option<&'a str> {
        let mut bindings = BTreeMap::new();
        self.collect_bindings(&mut bindings);
        names.into_iter().find(|name| {
            self.bindings.contains_key(*name)
                && !bindings
                    .get(*name)
                    .is_some_and(|binding| binding.available())
        })
    }
    pub(crate) fn for_run(
        &self,
        access: Arc<crate::owner::access::RunAccess>,
        tools: maka_tools::ToolCatalog,
    ) -> Result<maka_tools::ToolCatalog, String> {
        let mut bindings = BTreeMap::new();
        self.collect_bindings(&mut bindings);
        let handlers: Vec<_> = bindings
            .values()
            .filter(|binding| self.tools.contains(binding.name()))
            .map(|binding| {
                (
                    binding.name().to_owned(),
                    binding.run_handler(access.clone()),
                )
            })
            .collect();
        if handlers.is_empty() {
            return Ok(tools);
        }
        let names: Vec<_> = handlers.iter().map(|(name, _)| name.as_str()).collect();
        tools
            .excluding(&names)
            .with_rebound_from(self.tools.as_catalog(), handlers)
            .map_err(|error| error.to_string())
    }
    fn collect_bindings<'a>(&'a self, bindings: &mut BTreeMap<&'a str, &'a super::LiveBinding>) {
        if let Some(parent) = &self._parent {
            parent.collect_bindings(bindings);
        }
        for binding in &self.live_bindings {
            bindings.insert(binding.name(), binding);
        }
    }
    pub(crate) fn mcp_server_tools_by_origin(
        &self,
    ) -> BTreeMap<String, (McpLayerOrigin, Vec<String>)> {
        let mut servers: BTreeMap<String, (McpLayerOrigin, Vec<String>)> = self
            .live_servers
            .iter()
            .filter(|(_, live)| live.available())
            .map(|(name, live)| (name.clone(), (live.origin.clone(), Vec::new())))
            .collect();
        let mut bindings = BTreeMap::new();
        self.collect_bindings(&mut bindings);
        for binding in bindings.values() {
            if self.tools.contains(binding.name())
                && let Some((_, tools)) = servers.get_mut(binding.server())
            {
                tools.push(binding.name().to_owned());
            }
        }
        for (_, tools) in servers.values_mut() {
            tools.sort();
        }
        servers
    }
}
struct Snapshot {
    scope: String,
    acquired: AtomicU64,
    catalog: Arc<Catalog>,
    servers: Option<Servers>,
    // Exact server keys of this published file layer, including explicit tombstones.
    overrides: BTreeSet<String>,
    layer_servers: BTreeMap<String, LiveServer>,
}
impl Snapshot {
    /// This layer after `next` replaced it under the same revision. It keeps only the
    /// connections `next` did not take over.
    fn replaced_by(&self, next: &Self) -> Self {
        Self {
            scope: self.scope.clone(),
            acquired: AtomicU64::new(0),
            catalog: self.catalog.clone(),
            servers: self
                .servers
                .as_ref()
                .map(|servers| servers.except(next.servers.as_ref())),
            overrides: self.overrides.clone(),
            layer_servers: self.layer_servers.clone(),
        }
    }
}
#[derive(Default)]
struct Snapshots {
    revisions: BTreeMap<String, Arc<Snapshot>>,
    current: BTreeMap<String, String>,
    /// Scopes whose currently published revision has been superseded on disk
    /// while an active Run still holds it; cleared from `current` and closed as
    /// soon as the last active Run releases its catalog.
    pending_retirement: BTreeMap<String, String>,
    clients: BTreeMap<String, Client>,
    // Layers reopened under the same revision. Admitted Runs may still hold them;
    // the connections a layer did not hand over close once nothing references its catalog.
    replaced: Vec<Arc<Snapshot>>,
    /// Monotonic fence bumped on every consent decision or configuration retirement so
    /// an in-flight slow `start()` cannot publish a snapshot superseded while connecting.
    mutation_epoch: u64,
}
pub(crate) enum Prepared {
    Ready(Arc<Catalog>),
    Startup(Box<Proposal>),
}
pub(crate) struct Proposal {
    pub workspace: String,
    /// Merged global + project snapshot digest for runtime catalog caching.
    pub revision: String,
    /// Project-file-only digest for workspace consent (independent of global mcp.json edits).
    pub project_revision: Option<String>,
    workspace_ref: Option<Workspace>,
    epoch: u64,
    file: files::FileConfiguration,
    global: files::FileConfiguration,
}
impl Proposal {
    pub(crate) fn has_project_file(&self) -> bool {
        self.project_revision.is_some()
    }
    pub(crate) fn project_path(&self) -> Option<String> {
        self.file
            .path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
    }
    fn without_project(self) -> Self {
        let empty = files::FileConfiguration::default();
        let revision = maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&(Option::<String>::None, &self.global, &empty))
                .expect("global MCP configuration"),
        );
        Self {
            workspace: self.workspace,
            revision,
            project_revision: None,
            workspace_ref: self.workspace_ref,
            epoch: self.epoch,
            file: empty,
            global: self.global,
        }
    }
}
enum CleanupFailure {
    Transport(super::CloseError),
    Work(String),
}
impl CleanupFailure {
    fn message(&self) -> &str {
        match self {
            Self::Transport(error) => &error.message,
            Self::Work(message) => message,
        }
    }
}
pub(crate) struct Projects {
    pub base: Arc<Catalog>,
    owner: String,
    home: Option<(Arc<cap_std::fs::Dir>, std::path::PathBuf)>,
    store: maka_agent_state::Store,
    run_owner: maka_agent_facts::durable::RunOwner,
    configuration: Arc<maka_config::ConfigurationStore>,
    snapshots: RwLock<Snapshots>,
    opening: std::sync::Mutex<BTreeMap<String, std::sync::Weak<Mutex<()>>>>,
    cleanup_failures: std::sync::Mutex<Vec<CleanupFailure>>,
    workers: TaskTracker,
    stop: CancellationToken,
}
impl Projects {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        base: Catalog,
        owner: String,
        home: Option<(Arc<cap_std::fs::Dir>, std::path::PathBuf)>,
        store: maka_agent_state::Store,
        run_owner: maka_agent_facts::durable::RunOwner,
        configuration: Arc<maka_config::ConfigurationStore>,
        workers: TaskTracker,
        stop: CancellationToken,
    ) -> Self {
        Self {
            base: Arc::new(base),
            owner,
            home,
            store,
            run_owner,
            configuration,
            snapshots: RwLock::default(),
            opening: std::sync::Mutex::default(),
            cleanup_failures: std::sync::Mutex::new(Vec::new()),
            workers,
            stop,
        }
    }
    pub(crate) fn retain_transport_cleanup(&self, error: super::CloseError) {
        self.cleanup_failures
            .lock()
            .expect("MCP cleanup state")
            .push(CleanupFailure::Transport(error));
    }
    pub async fn proposal(&self, workspace: &Workspace) -> Result<Proposal, String> {
        self.propose(Some(workspace.clone())).await
    }
    fn bump_mutation_epoch(&self) {
        let mut snapshots = self.snapshots.write().expect("MCP snapshots");
        snapshots.mutation_epoch = snapshots.mutation_epoch.wrapping_add(1);
    }
    async fn propose(&self, workspace: Option<Workspace>) -> Result<Proposal, String> {
        let epoch = self.snapshots.read().expect("MCP snapshots").mutation_epoch;
        let home = self.home.clone();
        let workspace_ref = workspace.clone();
        tokio::task::spawn_blocking(move || {
            let global = files::global(
                home.as_ref()
                    .map(|(directory, path)| (directory.as_ref(), path.as_path())),
            )?;
            let (identity, file) = if let Some(workspace) = workspace {
                let (path, directory, observed) =
                    maka_workspace_support::capture_selected(&workspace)?;
                let file = files::layered(&directory, Path::new(&path))?;
                maka_fs_tools::directory::open(&path, &observed)
                    .map_err(|error| error.to_string())?;
                let identity = Self::workspace_key(&workspace);
                (identity, file)
            } else {
                (String::new(), files::FileConfiguration::default())
            };
            let revision = maka_agent_facts::artifact::content_digest(
                &serde_json::to_vec(&(file.path.as_ref().map(|_| &identity), &global, &file))
                    .expect("MCP configuration"),
            );
            let project_revision = file.path.as_ref().map(|_| {
                maka_agent_facts::artifact::content_digest(
                    &serde_json::to_vec(&(&identity, &file)).expect("project MCP configuration"),
                )
            });
            Ok(Proposal {
                workspace: identity,
                revision,
                project_revision,
                workspace_ref,
                epoch,
                file,
                global,
            })
        })
        .await
        .map_err(|error| error.to_string())?
    }
    pub(crate) fn project_revision_blocking(
        workspace: &Workspace,
    ) -> Result<Option<String>, String> {
        let (path, directory, observed) = maka_workspace_support::capture_selected(workspace)?;
        let file = files::layered(&directory, Path::new(&path))?;
        maka_fs_tools::directory::open(&path, &observed).map_err(|error| error.to_string())?;
        let identity = Self::workspace_key(workspace);
        Ok(file.path.as_ref().map(|_| {
            maka_agent_facts::artifact::content_digest(
                &serde_json::to_vec(&(&identity, &file)).expect("project MCP configuration"),
            )
        }))
    }
    pub(crate) async fn trust_project_revision(
        &self,
        workspace: &Workspace,
        project_revision: String,
    ) -> Result<(), String> {
        self.configuration
            .trust_project_mcp(
                self.owner.clone(),
                Self::workspace_key(workspace),
                project_revision,
            )
            .await
            .map_err(|_| "agent_mcp_trust_unconfirmed".to_owned())?;
        self.bump_mutation_epoch();
        Ok(())
    }
    pub(crate) async fn advance_project_trust(
        &self,
        workspace: &Workspace,
        expected_revision: String,
        next_revision: String,
    ) -> Result<bool, String> {
        let advanced = self
            .configuration
            .advance_project_mcp_trust(
                self.owner.clone(),
                Self::workspace_key(workspace),
                expected_revision,
                next_revision,
            )
            .await
            .map_err(|_| "agent_mcp_trust_unconfirmed".to_owned())?;
        if advanced {
            self.bump_mutation_epoch();
        }
        Ok(advanced)
    }
    pub async fn decision(
        &self,
        proposal: &Proposal,
    ) -> Result<Option<maka_config::ProjectMcpDecision>, String> {
        let Some(project_revision) = proposal.project_revision.as_ref() else {
            return Ok(Some(maka_config::ProjectMcpDecision::Trusted));
        };
        self.configuration
            .project_mcp_decision(
                self.owner.clone(),
                proposal.workspace.clone(),
                project_revision.clone(),
            )
            .await
            .map_err(|_| "agent_mcp_trust_unavailable".into())
    }
    pub async fn trusted(&self, proposal: &Proposal) -> Result<bool, String> {
        Ok(self.decision(proposal).await? == Some(maka_config::ProjectMcpDecision::Trusted))
    }
    pub async fn trust(&self, proposal: &Proposal) -> Result<(), String> {
        let Some(project_revision) = proposal.project_revision.as_ref() else {
            return Ok(());
        };
        self.configuration
            .trust_project_mcp(
                self.owner.clone(),
                proposal.workspace.clone(),
                project_revision.clone(),
            )
            .await
            .map_err(|_| "agent_mcp_trust_unconfirmed".to_owned())?;
        self.bump_mutation_epoch();
        Ok(())
    }
    pub async fn decline(&self, proposal: &Proposal) -> Result<(), String> {
        let Some(project_revision) = proposal.project_revision.as_ref() else {
            return Ok(());
        };
        self.configuration
            .decline_project_mcp(
                self.owner.clone(),
                proposal.workspace.clone(),
                project_revision.clone(),
            )
            .await
            .map_err(|_| "agent_mcp_trust_unconfirmed".to_owned())?;
        self.bump_mutation_epoch();
        Ok(())
    }
    pub async fn view(&self, proposal: &Proposal) -> Result<McpView, String> {
        let Some(path) = &proposal.file.path else {
            return Ok(McpView::Absent);
        };
        let mut servers = Vec::new();
        let mut disabled = Vec::new();
        for (name, config) in &proposal.file.servers {
            let Some(config) = config else {
                disabled.push(name.clone());
                continue;
            };
            let (launch, environment, headers) = match &config.transport {
                Transport::Stdio {
                    command,
                    args,
                    cwd,
                    env,
                    pass_env,
                } => (
                    format!(
                        "{} {} (cwd: {})",
                        command,
                        serde_json::to_string(args).expect("arguments"),
                        cwd
                    ),
                    env.keys()
                        .cloned()
                        .chain(pass_env.iter().map(|name| format!("{name} (Host)")))
                        .collect(),
                    Vec::new(),
                ),
                Transport::StreamableHttp {
                    url,
                    headers,
                    header_env,
                } => (
                    url.clone(),
                    Vec::new(),
                    headers
                        .keys()
                        .cloned()
                        .chain(
                            header_env
                                .iter()
                                .map(|(header, variable)| format!("{header} ← {variable} (Host)")),
                        )
                        .collect(),
                ),
            };
            servers.push(McpServerView {
                name: name.clone(),
                launch,
                environment,
                headers,
                preapproved: config.preapproved,
                read_only_tools: config.read_only_tools.clone(),
            });
        }
        let decision = self.decision(proposal).await?;
        Ok(McpView::Configuration {
            path: path.to_string_lossy().into_owned(),
            revision: proposal
                .project_revision
                .clone()
                .unwrap_or_else(|| proposal.revision.clone()),
            trusted: decision == Some(maka_config::ProjectMcpDecision::Trusted),
            declined: decision == Some(maka_config::ProjectMcpDecision::Declined),
            servers,
            disabled,
        })
    }
    pub fn catalog(&self, revision: Option<&str>) -> Result<Arc<Catalog>, String> {
        match revision {
            None => Ok(self.base.clone()),
            Some(revision) => self
                .snapshots
                .read()
                .expect("MCP snapshots")
                .revisions
                .get(revision)
                .map(|snapshot| {
                    snapshot.acquired.fetch_add(1, Ordering::Relaxed);
                    snapshot.catalog.clone()
                })
                .ok_or_else(|| "agent_tools_changed".into()),
        }
    }
    pub async fn available(
        self: &Arc<Self>,
        workspace: &Workspace,
        floor: &maka_sandbox::Sandbox,
    ) -> Result<Arc<Catalog>, String> {
        let proposal = self.proposal(workspace).await?;
        if !self.trusted(&proposal).await? {
            return self.capture_global(floor).await;
        }
        self.capture(workspace, floor).await
    }
    /// Completion reads a captured catalog without opening transports or changing admission.
    pub async fn observed(&self, workspace: Option<&Workspace>) -> Result<Arc<Catalog>, String> {
        let mut proposal = self.propose(workspace.cloned()).await?;
        if !self.trusted(&proposal).await? {
            proposal = self.propose(None).await?;
        }
        let snapshots = self.snapshots.read().expect("MCP snapshots");
        Ok(snapshots
            .revisions
            .get(&proposal.revision)
            .map(|snapshot| snapshot.catalog.clone())
            .unwrap_or_else(|| self.base.clone()))
    }
    fn workspace_key(workspace: &Workspace) -> String {
        maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&(&workspace.path, &workspace.worktree))
                .expect("workspace identity"),
        )
    }
    /// Compose only actual published capabilities. Files are proposals, not revocations.
    pub(crate) fn current_activation(
        &self,
        workspace: &Workspace,
        session: &str,
        activation: &Arc<Catalog>,
    ) -> Result<Arc<Catalog>, String> {
        let key = Self::workspace_key(workspace);
        let client_scope = format!("client:{session}");
        let snapshots = self.snapshots.read().expect("MCP snapshots");
        let mut layer = activation;
        while !Arc::ptr_eq(layer, &self.base) {
            let original = layer
                .revision
                .as_ref()
                .and_then(|revision| snapshots.revisions.get(revision))
                .into_iter()
                .chain(&snapshots.replaced)
                .find(|snapshot| Arc::ptr_eq(&snapshot.catalog, layer))
                .ok_or("agent_mcp_activation_unavailable")?;
            if !original.scope.is_empty() && original.scope != key && original.scope != client_scope
            {
                return Err("agent_mcp_activation_unavailable".into());
            }
            layer = layer
                ._parent
                .as_ref()
                .ok_or("agent_mcp_activation_unavailable")?;
        }
        let published = |scope: &str| -> Result<Option<Arc<Snapshot>>, String> {
            snapshots
                .current
                .get(scope)
                .map(|revision| {
                    snapshots
                        .revisions
                        .get(revision)
                        .cloned()
                        .ok_or_else(|| "agent_mcp_activation_unavailable".into())
                })
                .transpose()
        };
        let global =
            published("")?.map_or_else(|| self.base.clone(), |snapshot| snapshot.catalog.clone());
        let base = match published(&key)? {
            Some(project) => {
                let revision = maka_agent_facts::artifact::content_digest(
                    &serde_json::to_vec(&(
                        "mcp.published.layers",
                        &project.catalog.revision,
                        &global.revision,
                    ))
                    .expect("published MCP layers"),
                );
                Catalog::with_layer(
                    global,
                    revision,
                    &project.overrides,
                    project.catalog.live_bindings.clone(),
                    project.layer_servers.clone(),
                    Some(project.catalog.clone()),
                )?
            }
            None => global,
        };
        client::current(&snapshots, session, base)
    }
    /// Every server connection in this file layer and its parent file layers is usable,
    /// and none of those layers has been superseded under its revision.
    /// Installation servers below them change only by reactivation.
    fn layers_available(&self, catalog: &Arc<Catalog>) -> bool {
        let snapshots = self.snapshots.read().expect("MCP snapshots");
        let mut layer = catalog;
        while !Arc::ptr_eq(layer, &self.base) {
            let Some(snapshot) = layer
                .revision
                .as_ref()
                .and_then(|revision| snapshots.revisions.get(revision))
                .filter(|snapshot| Arc::ptr_eq(&snapshot.catalog, layer))
            else {
                return false;
            };
            if !snapshot.servers.as_ref().is_none_or(Servers::available) {
                return false;
            }
            let Some(parent) = layer._parent.as_ref() else {
                return false;
            };
            layer = parent;
        }
        true
    }
    /// The cached layer of `revision`. Holding its catalog keeps `prune` from closing it.
    fn cached(&self, revision: &str) -> Option<(Arc<Snapshot>, Arc<Catalog>)> {
        let snapshots = self.snapshots.read().expect("MCP snapshots");
        let snapshot = snapshots.revisions.get(revision)?;
        Some((snapshot.clone(), snapshot.catalog.clone()))
    }
    fn publish_reopened(snapshots: &mut Snapshots, revision: String, opened: Snapshot) {
        let opened = Arc::new(opened);
        if let Some(replaced) = snapshots.revisions.insert(revision, opened.clone()) {
            snapshots
                .replaced
                .push(Arc::new(replaced.replaced_by(&opened)));
        }
    }
    async fn verify_proposal_still_valid(&self, proposal: &Proposal) -> Result<(), String> {
        let fresh = self.propose(proposal.workspace_ref.clone()).await?;
        let effective = match self.decision(&fresh).await? {
            Some(maka_config::ProjectMcpDecision::Trusted) => fresh,
            Some(maka_config::ProjectMcpDecision::Declined) => fresh.without_project(),
            None => return Err("agent_mcp_trust_required".into()),
        };
        if effective.revision != proposal.revision {
            return Err(
                if proposal.file.path.is_some() && effective.file.path.is_none() {
                    "agent_mcp_trust_required".into()
                } else {
                    "agent_mcp_activation_unavailable".into()
                },
            );
        }
        Ok(())
    }
    async fn close_opened(
        &self,
        opened_project: Option<Snapshot>,
        previous_project_servers: Option<&Servers>,
        opened_global: Option<Snapshot>,
        previous_global_servers: Option<&Servers>,
    ) -> Option<String> {
        let mut cleanup_error = None;
        if let Some(opened) = opened_project
            && let Some(servers) = opened.servers
            && let Err(cleanup) = servers.except(previous_project_servers).close().await
        {
            cleanup_error.get_or_insert(cleanup.message.clone());
            self.retain_transport_cleanup(cleanup);
        }
        if let Some(opened) = opened_global
            && let Some(servers) = opened.servers
            && let Err(cleanup) = servers.except(previous_global_servers).close().await
        {
            cleanup_error.get_or_insert(cleanup.message.clone());
            self.retain_transport_cleanup(cleanup);
        }
        cleanup_error
    }
    async fn publish_cached(
        &self,
        proposal: &Proposal,
        catalog: &Arc<Catalog>,
        mut checked_epoch: u64,
    ) -> Result<(), String> {
        loop {
            let current_epoch = {
                let mut snapshots = self.snapshots.write().expect("MCP snapshots");
                if snapshots.mutation_epoch == checked_epoch {
                    if !snapshots
                        .revisions
                        .get(&proposal.revision)
                        .is_some_and(|snapshot| Arc::ptr_eq(&snapshot.catalog, catalog))
                    {
                        return Err("agent_mcp_activation_unavailable".into());
                    }
                    if proposal.file.path.is_some() {
                        let parent = catalog
                            ._parent
                            .as_ref()
                            .expect("published project layer owns its global parent");
                        match &parent.revision {
                            Some(revision) => {
                                snapshots.current.insert(String::new(), revision.clone());
                            }
                            None => {
                                snapshots.current.remove("");
                            }
                        }
                        snapshots
                            .current
                            .insert(proposal.workspace.clone(), proposal.revision.clone());
                    } else {
                        snapshots
                            .current
                            .insert(String::new(), proposal.revision.clone());
                        if !proposal.workspace.is_empty() {
                            Self::mark_scope_and_dependents_stale(
                                &mut snapshots,
                                &proposal.workspace,
                                None,
                            );
                        }
                    }
                    return Ok(());
                }
                snapshots.mutation_epoch
            };
            self.verify_proposal_still_valid(proposal).await?;
            checked_epoch = current_epoch;
        }
    }
    async fn prepared(
        &self,
        mut proposal: Proposal,
        floor: &maka_sandbox::Sandbox,
    ) -> Result<Prepared, String> {
        if !super::floor_allows_mcp(floor) {
            return Ok(Prepared::Ready(self.base.clone()));
        }
        match self.decision(&proposal).await? {
            Some(maka_config::ProjectMcpDecision::Trusted) => {}
            Some(maka_config::ProjectMcpDecision::Declined) => {
                proposal = proposal.without_project();
            }
            None => return Err("agent_mcp_trust_required".into()),
        }
        if proposal.file.path.is_none() && proposal.global.path.is_none() {
            let catalog = self.base.clone();
            {
                let mut snapshots = self.snapshots.write().expect("MCP snapshots");
                Self::mark_scope_and_dependents_stale(&mut snapshots, "", None);
                if !proposal.workspace.is_empty() {
                    Self::mark_scope_and_dependents_stale(
                        &mut snapshots,
                        &proposal.workspace,
                        None,
                    );
                }
            }
            self.prune().await?;
            return Ok(Prepared::Ready(catalog));
        }
        if let Ok(catalog) = self.catalog(Some(&proposal.revision))
            && self.layers_available(&catalog)
        {
            self.publish_cached(&proposal, &catalog, proposal.epoch)
                .await?;
            self.prune().await?;
            return Ok(Prepared::Ready(catalog));
        }
        Ok(Prepared::Startup(Box::new(proposal)))
    }
    pub async fn prepare(
        &self,
        workspace: &Workspace,
        floor: &maka_sandbox::Sandbox,
    ) -> Result<Prepared, String> {
        if !super::floor_allows_mcp(floor) {
            return Ok(Prepared::Ready(self.base.clone()));
        }
        self.prepared(self.proposal(workspace).await?, floor).await
    }
    pub async fn capture_global(
        self: &Arc<Self>,
        floor: &maka_sandbox::Sandbox,
    ) -> Result<Arc<Catalog>, String> {
        if !super::floor_allows_mcp(floor) {
            return Ok(self.base.clone());
        }
        match self.prepared(self.propose(None).await?, floor).await? {
            Prepared::Ready(revision) => Ok(revision),
            Prepared::Startup(proposal) => self.start(*proposal, floor).await,
        }
    }
    pub async fn capture(
        self: &Arc<Self>,
        workspace: &Workspace,
        floor: &maka_sandbox::Sandbox,
    ) -> Result<Arc<Catalog>, String> {
        match self.prepare(workspace, floor).await? {
            Prepared::Ready(revision) => Ok(revision),
            Prepared::Startup(proposal) => self.start(*proposal, floor).await,
        }
    }
    async fn open_layer(
        &self,
        file: &files::FileConfiguration,
        parent: Arc<Catalog>,
        scope: String,
        revision: String,
        floor: &maka_sandbox::Sandbox,
        previous: Option<&Servers>,
    ) -> Result<Snapshot, String> {
        let selected = files::merge(&[], &[file]);
        if !selected.is_empty() {
            super::require_compatible_floor(floor).map_err(str::to_owned)?;
        }
        let servers = match Servers::reopen(
            previous,
            &selected,
            &self.configuration,
            self.stop.clone(),
        )
        .await
        {
            Ok(servers) => servers,
            Err(error) => {
                if let Some(material) = error.material {
                    self.retain_transport_cleanup(super::CloseError {
                        message: error.message.clone(),
                        material,
                    });
                }
                return Err(error.message);
            }
        };
        let overrides = file.servers.keys().cloned().collect();
        let layer_servers: BTreeMap<String, LiveServer> = servers
            .server_connections()
            .filter_map(|(name, connection)| {
                let &location = file.server_locations.get(name)?;
                let config = file.servers.get(name)?.as_ref()?;
                Some((
                    name.to_owned(),
                    LiveServer::new(
                        McpLayerOrigin::File {
                            location,
                            config_digest: files::server_config_digest(config),
                        },
                        connection.clone(),
                    ),
                ))
            })
            .collect();
        let catalog = match Catalog::with_layer(
            parent,
            revision,
            &overrides,
            servers.live_bindings.clone(),
            layer_servers.clone(),
            None,
        ) {
            Ok(catalog) => catalog,
            Err(error) => {
                if let Err(cleanup) = servers.except(previous).close().await {
                    let message = format!("{error}; {}", cleanup.message);
                    self.retain_transport_cleanup(cleanup);
                    return Err(message);
                }
                return Err(error);
            }
        };
        Ok(Snapshot {
            scope,
            acquired: AtomicU64::new(0),
            catalog,
            servers: Some(servers),
            overrides,
            layer_servers,
        })
    }
    fn startup_gate(&self, revision: &str) -> Arc<Mutex<()>> {
        let mut gates = self.opening.lock().expect("MCP startup gates");
        gates.retain(|_, gate| gate.strong_count() > 0);
        let gate = gates
            .get(revision)
            .and_then(std::sync::Weak::upgrade)
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        gates.insert(revision.to_owned(), Arc::downgrade(&gate));
        gate
    }
    pub async fn start(
        self: &Arc<Self>,
        proposal: Proposal,
        floor: &maka_sandbox::Sandbox,
    ) -> Result<Arc<Catalog>, String> {
        let owner = self.clone();
        let floor = floor.clone();
        self.workers
            .spawn(async move {
                let gate_revision = proposal.revision.clone();
                let gate = owner.startup_gate(&gate_revision);
                let _opening = gate.lock().await;
                if owner.stop.is_cancelled() {
                    return Err("agent_closed".into());
                }
                if !super::floor_allows_mcp(&floor) {
                    return Ok(owner.base.clone());
                }
                let proposal = match owner.decision(&proposal).await? {
                    Some(maka_config::ProjectMcpDecision::Trusted) => proposal,
                    Some(maka_config::ProjectMcpDecision::Declined) => proposal.without_project(),
                    None => return Err("agent_mcp_trust_required".into()),
                };
                let mut checked_epoch = proposal.epoch;
                let current_epoch = owner
                    .snapshots
                    .read()
                    .expect("MCP snapshots")
                    .mutation_epoch;
                if current_epoch != checked_epoch {
                    owner.verify_proposal_still_valid(&proposal).await?;
                    checked_epoch = current_epoch;
                }
                // A cached layer with a retired connection is reopened under the same
                // revision. Its servers that are still connected keep their connection.
                if let Ok(catalog) = owner.catalog(Some(&proposal.revision))
                    && owner.layers_available(&catalog)
                {
                    owner
                        .publish_cached(&proposal, &catalog, checked_epoch)
                        .await?;
                    owner.prune().await?;
                    return Ok(catalog);
                }
                if let Some(error) = owner
                    .cleanup_failures
                    .lock()
                    .expect("MCP cleanup state")
                    .first()
                {
                    return Err(error.message().to_owned());
                }
                let empty = files::FileConfiguration::default();
                let global_revision = maka_agent_facts::artifact::content_digest(
                    &serde_json::to_vec(&(Option::<String>::None, &proposal.global, &empty))
                        .expect("global MCP configuration"),
                );
                let global_gate = (global_revision != gate_revision)
                    .then(|| owner.startup_gate(&global_revision));
                let _global_opening = match global_gate.as_ref() {
                    Some(gate) => Some(gate.lock().await),
                    None => None,
                };
                let previous_global = owner.cached(&global_revision);
                let previous_global_servers = previous_global
                    .as_ref()
                    .and_then(|(snapshot, _)| snapshot.servers.as_ref());
                let previous_project = owner.cached(&proposal.revision);
                let mut opened_global = None;
                let global = if proposal.global.path.is_none() {
                    owner.base.clone()
                } else if let Some((_, catalog)) = &previous_global
                    && owner.layers_available(catalog)
                {
                    catalog.clone()
                } else {
                    let opened = owner
                        .open_layer(
                            &proposal.global,
                            owner.base.clone(),
                            String::new(),
                            global_revision.clone(),
                            &floor,
                            previous_global_servers,
                        )
                        .await?;
                    let catalog = opened.catalog.clone();
                    opened_global = Some(opened);
                    catalog
                };
                let mut opened_project = None;
                let catalog = if proposal.file.path.is_none() {
                    global.clone()
                } else {
                    match owner
                        .open_layer(
                            &proposal.file,
                            global.clone(),
                            proposal.workspace.clone(),
                            proposal.revision.clone(),
                            &floor,
                            previous_project
                                .as_ref()
                                .and_then(|(snapshot, _)| snapshot.servers.as_ref()),
                        )
                        .await
                    {
                        Ok(opened) => {
                            let catalog = opened.catalog.clone();
                            opened_project = Some(opened);
                            catalog
                        }
                        Err(error) => {
                            if let Some(opened) = opened_global
                                && let Some(servers) = opened.servers
                                && let Err(cleanup) =
                                    servers.except(previous_global_servers).close().await
                            {
                                let message = format!("{error}; {}", cleanup.message);
                                owner.retain_transport_cleanup(cleanup);
                                return Err(message);
                            }
                            return Err(error);
                        }
                    }
                };
                let previous_project_servers = previous_project
                    .as_ref()
                    .and_then(|(snapshot, _)| snapshot.servers.as_ref());
                loop {
                    let next_epoch = {
                        let mut snapshots = owner.snapshots.write().expect("MCP snapshots");
                        if snapshots.mutation_epoch == checked_epoch {
                            let superseded_global = snapshots
                                .current
                                .get("")
                                .and_then(|rev| snapshots.revisions.get(rev))
                                .map(|snapshot| snapshot.catalog.clone())
                                .filter(|existing| !Arc::ptr_eq(existing, &global));
                            let superseded_project = (!proposal.workspace.is_empty())
                                .then(|| {
                                    snapshots
                                        .current
                                        .get(&proposal.workspace)
                                        .and_then(|rev| snapshots.revisions.get(rev))
                                        .map(|snapshot| snapshot.catalog.clone())
                                        .filter(|existing| !Arc::ptr_eq(existing, &catalog))
                                })
                                .flatten();
                            if let Some(opened) = opened_global {
                                Self::publish_reopened(
                                    &mut snapshots,
                                    global_revision.clone(),
                                    opened,
                                );
                            }
                            if proposal.global.path.is_some() {
                                snapshots.current.insert(String::new(), global_revision);
                            } else {
                                snapshots.current.remove("");
                            }
                            snapshots.pending_retirement.remove("");
                            if let Some(opened) = opened_project {
                                Self::publish_reopened(
                                    &mut snapshots,
                                    proposal.revision.clone(),
                                    opened,
                                );
                                snapshots.pending_retirement.remove(&proposal.workspace);
                                snapshots
                                    .current
                                    .insert(proposal.workspace.clone(), proposal.revision);
                            } else if !proposal.workspace.is_empty() {
                                snapshots.pending_retirement.remove(&proposal.workspace);
                                snapshots.current.remove(&proposal.workspace);
                            }
                            if let Some(old_global) = superseded_global {
                                Self::mark_dependents_of_catalog_stale(
                                    &mut snapshots,
                                    "",
                                    &old_global,
                                );
                            }
                            if let Some(old_project) = superseded_project {
                                Self::mark_dependents_of_catalog_stale(
                                    &mut snapshots,
                                    &proposal.workspace,
                                    &old_project,
                                );
                            }
                            break;
                        }
                        snapshots.mutation_epoch
                    };
                    if let Err(error) = owner.verify_proposal_still_valid(&proposal).await {
                        let cleanup = owner
                            .close_opened(
                                opened_project,
                                previous_project_servers,
                                opened_global,
                                previous_global_servers,
                            )
                            .await;
                        return Err(match cleanup {
                            Some(cleanup) => format!("{error}; {cleanup}"),
                            None => error,
                        });
                    }
                    checked_epoch = next_epoch;
                }
                drop((previous_global, previous_project));
                owner.prune().await?;
                Ok(catalog)
            })
            .await
            .map_err(|_| "agent_mcp_startup_unknown".to_owned())?
    }
    pub(crate) async fn prune(&self) -> Result<(), String> {
        loop {
            let mut retired = {
                let mut snapshots = self.snapshots.write().expect("MCP snapshots");
                let pending = std::mem::take(&mut snapshots.pending_retirement);
                for (scope, stale_revision) in pending {
                    if snapshots.current.get(&scope) != Some(&stale_revision) {
                        continue;
                    }
                    let idle = snapshots
                        .revisions
                        .get(&stale_revision)
                        .is_none_or(|snapshot| Arc::strong_count(&snapshot.catalog) == 1);
                    if idle {
                        snapshots.current.remove(&scope);
                    } else {
                        snapshots.pending_retirement.insert(scope, stale_revision);
                    }
                }
                let (unreferenced, held): (Vec<_>, Vec<_>) =
                    std::mem::take(&mut snapshots.replaced)
                        .into_iter()
                        .partition(|snapshot| Arc::strong_count(&snapshot.catalog) == 1);
                snapshots.replaced = held;
                unreferenced
            };
            let candidates: Vec<_> = {
                let snapshots = self.snapshots.read().expect("MCP snapshots");
                snapshots
                    .revisions
                    .iter()
                    .filter(|(revision, snapshot)| {
                        snapshots.current.get(&snapshot.scope) != Some(revision)
                            && Arc::strong_count(&snapshot.catalog) == 1
                    })
                    .map(|(revision, snapshot)| {
                        (
                            revision.clone(),
                            snapshot.clone(),
                            snapshot.acquired.load(Ordering::Relaxed),
                        )
                    })
                    .collect()
            };
            if !candidates.is_empty() {
                let retained: std::collections::BTreeSet<_> = self
                    .store
                    .referenced_mcp_revisions(self.run_owner.clone())
                    .await
                    .map_err(|error| error.to_string())?;
                let mut snapshots = self.snapshots.write().expect("MCP snapshots");
                let pruned: Vec<_> = candidates
                    .into_iter()
                    .filter_map(|(revision, original, acquired)| {
                        let snapshot = snapshots.revisions.get(&revision)?;
                        if !Arc::ptr_eq(snapshot, &original)
                            || snapshots.current.get(&snapshot.scope) == Some(&revision)
                            || retained.contains(&revision)
                            || Arc::strong_count(&snapshot.catalog) != 1
                            || snapshot.acquired.load(Ordering::Relaxed) != acquired
                        {
                            return None;
                        }
                        snapshots.revisions.remove(&revision)
                    })
                    .collect();
                let Snapshots {
                    revisions, current, ..
                } = &mut *snapshots;
                current.retain(|_, revision| revisions.contains_key(revision));
                retired.extend(pruned);
            }
            if retired.is_empty() {
                return Ok(());
            }
            let mut failure = None;
            for snapshot in retired {
                if let Some(servers) = &snapshot.servers
                    && let Err(error) = servers.close().await
                {
                    failure.get_or_insert(error.message.clone());
                    self.retain_transport_cleanup(error);
                }
            }
            if let Some(failure) = failure {
                return Err(failure);
            }
        }
    }
    /// Detach published snapshots whose on-disk configuration or trust decision
    /// changed so retired servers stop as soon as no active Run holds them.
    /// Global and project files are parsed independently so a corrupt project
    /// configuration cannot block retiring stale user-level servers.
    pub(crate) async fn drop_stale_for_scope(
        &self,
        workspace: Option<&Workspace>,
    ) -> Result<(), String> {
        let home = self.home.clone();
        let workspace_for_read = workspace.cloned();
        let (global_result, project_result) = tokio::task::spawn_blocking(move || {
            let global = files::global(
                home.as_ref()
                    .map(|(directory, path)| (directory.as_ref(), path.as_path())),
            );
            let project = workspace_for_read.map(|ws| {
                let identity = Self::workspace_key(&ws);
                let loaded = (|| {
                    let (path, directory, observed) =
                        maka_workspace_support::capture_selected(&ws)?;
                    let file = files::layered(&directory, Path::new(&path))?;
                    maka_fs_tools::directory::open(&path, &observed)
                        .map_err(|error| error.to_string())?;
                    Ok::<_, String>(file)
                })();
                (identity, loaded)
            });
            (global, project)
        })
        .await
        .map_err(|error| error.to_string())?;

        let mut first_error: Option<String> = None;
        let empty = files::FileConfiguration::default();
        let global_file = match global_result {
            Ok(global) => Some(global),
            Err(error) => {
                first_error.get_or_insert(error);
                None
            }
        };
        let global_revision = global_file.as_ref().and_then(|global| {
            global.path.is_some().then(|| {
                maka_agent_facts::artifact::content_digest(
                    &serde_json::to_vec(&(Option::<String>::None, global, &empty))
                        .expect("global MCP configuration"),
                )
            })
        });

        let project_desired: Option<(String, Option<String>)> = match project_result {
            None => None,
            Some((identity, Err(error))) => {
                first_error.get_or_insert(error);
                Some((identity, None))
            }
            Some((identity, Ok(file))) => {
                let desired = if let (Some(global), Some(_)) = (&global_file, &file.path) {
                    let project_revision = maka_agent_facts::artifact::content_digest(
                        &serde_json::to_vec(&(&identity, &file))
                            .expect("project MCP configuration"),
                    );
                    match self
                        .configuration
                        .project_mcp_decision(
                            self.owner.clone(),
                            identity.clone(),
                            project_revision,
                        )
                        .await
                    {
                        Ok(Some(maka_config::ProjectMcpDecision::Trusted)) => {
                            Some(maka_agent_facts::artifact::content_digest(
                                &serde_json::to_vec(&(Some(&identity), global, &file))
                                    .expect("MCP configuration"),
                            ))
                        }
                        Ok(_) => None,
                        Err(_) => {
                            first_error.get_or_insert_with(|| "agent_mcp_trust_unavailable".into());
                            None
                        }
                    }
                } else {
                    None
                };
                Some((identity, desired))
            }
        };

        {
            let mut snapshots = self.snapshots.write().expect("MCP snapshots");
            snapshots.mutation_epoch = snapshots.mutation_epoch.wrapping_add(1);
            let global_changed =
                snapshots.current.get("").map(String::as_str) != global_revision.as_deref();
            if global_changed {
                Self::mark_scope_and_dependents_stale(
                    &mut snapshots,
                    "",
                    global_revision.as_deref(),
                );
            }
            if let Some((identity, project_revision)) = project_desired {
                Self::mark_scope_and_dependents_stale(
                    &mut snapshots,
                    &identity,
                    project_revision.as_deref(),
                );
            }
        }
        if let Err(error) = self.prune().await {
            first_error.get_or_insert(error);
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
    fn catalog_depends_on(catalog: &Arc<Catalog>, target: &Arc<Catalog>) -> Option<usize> {
        let mut depth = 1;
        let mut current = catalog._parent.as_ref();
        while let Some(layer) = current {
            if Arc::ptr_eq(layer, target) {
                return Some(depth);
            }
            depth += 1;
            current = layer._parent.as_ref();
        }
        None
    }
    fn mark_dependents_of_catalog_stale(
        snapshots: &mut Snapshots,
        root_scope: &str,
        stale_catalog: &Arc<Catalog>,
    ) {
        let mut dependents: Vec<(usize, String)> = snapshots
            .current
            .iter()
            .filter_map(|(scope, rev)| {
                if scope == root_scope {
                    return None;
                }
                let snapshot = snapshots.revisions.get(rev)?;
                let depth = Self::catalog_depends_on(&snapshot.catalog, stale_catalog)?;
                Some((depth, scope.clone()))
            })
            .collect();
        // Retire deeper overlays (e.g. client compositions) before their parent layers.
        dependents.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        for (_, scope) in dependents {
            Self::mark_scope_stale(snapshots, scope, None);
        }
    }
    fn mark_scope_and_dependents_stale(
        snapshots: &mut Snapshots,
        root_scope: &str,
        desired: Option<&str>,
    ) {
        let Some(current_rev) = snapshots.current.get(root_scope).cloned() else {
            return;
        };
        if desired == Some(current_rev.as_str()) {
            return;
        }
        if let Some(stale_catalog) = snapshots
            .revisions
            .get(&current_rev)
            .map(|snapshot| snapshot.catalog.clone())
        {
            Self::mark_dependents_of_catalog_stale(snapshots, root_scope, &stale_catalog);
        }
        Self::mark_scope_stale(snapshots, root_scope.to_owned(), desired);
    }
    fn mark_scope_stale(snapshots: &mut Snapshots, scope: String, desired: Option<&str>) {
        let Some(current_rev) = snapshots.current.get(&scope).cloned() else {
            return;
        };
        if desired == Some(current_rev.as_str()) {
            return;
        }
        let idle = snapshots
            .revisions
            .get(&current_rev)
            .is_none_or(|snapshot| Arc::strong_count(&snapshot.catalog) == 1);
        if idle {
            snapshots.current.remove(&scope);
            snapshots.pending_retirement.remove(&scope);
        } else {
            snapshots.pending_retirement.insert(scope, current_rev);
        }
    }
    pub fn retire(&self) {
        self.stop.cancel();
    }
    pub async fn close(&self) -> Result<(), String> {
        let snapshots: Vec<_> = {
            let snapshots = self.snapshots.read().expect("MCP snapshots");
            snapshots
                .revisions
                .values()
                .chain(&snapshots.replaced)
                .cloned()
                .collect()
        };
        let mut error = self.close_clients().await.err();
        if let Some(failure) = self
            .cleanup_failures
            .lock()
            .expect("MCP cleanup state")
            .first()
        {
            error.get_or_insert(failure.message().to_owned());
        }
        for snapshot in snapshots {
            if let Some(servers) = &snapshot.servers
                && let Err(cause) = servers.close().await
            {
                error.get_or_insert(cause.message.clone());
                self.retain_transport_cleanup(cause);
            }
        }
        error.map_or(Ok(()), Err)
    }
}
