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
}
impl Catalog {
    fn with_layer(
        parent: Arc<Self>,
        revision: String,
        overrides: &BTreeSet<String>,
        live_bindings: Vec<super::LiveBinding>,
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
        Ok(Arc::new(Self {
            revision: Some(revision),
            client_mcp: None,
            _parent: Some(parent),
            _layer_owner: layer_owner,
            tools,
            definitions: Arc::new(definitions),
            bindings: Arc::new(bindings),
            live_bindings,
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
        let registrations: Vec<_> = bindings
            .values()
            .filter(|binding| self.tools.contains(binding.name()))
            .map(|binding| binding.for_run(access.clone()))
            .collect();
        let names: Vec<_> = registrations
            .iter()
            .map(|registration| registration.definition.name.as_str())
            .collect();
        tools
            .excluding(&names)
            .with_additional(registrations)
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
}
struct Snapshot {
    scope: String,
    acquired: AtomicU64,
    catalog: Arc<Catalog>,
    servers: Option<Servers>,
    // Exact server keys of this published file layer, including explicit tombstones.
    overrides: BTreeSet<String>,
}
#[derive(Default)]
struct Snapshots {
    revisions: BTreeMap<String, Arc<Snapshot>>,
    current: BTreeMap<String, String>,
    clients: BTreeMap<String, Client>,
}
pub(crate) enum Prepared {
    Ready(Arc<Catalog>),
    Startup(Box<Proposal>),
}
pub(crate) struct Proposal {
    pub workspace: String,
    pub revision: String,
    file: files::FileConfiguration,
    global: files::FileConfiguration,
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
    async fn propose(&self, workspace: Option<Workspace>) -> Result<Proposal, String> {
        let home = self.home.clone();
        tokio::task::spawn_blocking(move || {
            let global = files::global(
                home.as_ref()
                    .map(|(directory, path)| (directory.as_ref(), path.as_path())),
            )?;
            let (identity, file) = if let Some(workspace) = workspace {
                let path = Path::new(&workspace.path);
                let directory = maka_fs_tools::directory::open(path, &workspace.directory_identity)
                    .map_err(|error| error.to_string())?;
                if maka_fs_tools::workspace::read_directory_identity(
                    path.to_owned(),
                    directory.try_clone().map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?
                    != workspace.identity
                {
                    return Err("agent_workspace_unavailable".into());
                }
                let file = files::layered(&directory, path)?;
                let identity = Self::workspace_key(&workspace);
                (identity, file)
            } else {
                (String::new(), files::FileConfiguration::default())
            };
            let revision = maka_agent_facts::artifact::content_digest(
                &serde_json::to_vec(&(file.path.as_ref().map(|_| &identity), &global, &file))
                    .expect("MCP configuration"),
            );
            Ok(Proposal {
                workspace: identity,
                revision,
                file,
                global,
            })
        })
        .await
        .map_err(|error| error.to_string())?
    }
    pub async fn trusted(&self, proposal: &Proposal) -> Result<bool, String> {
        if proposal.file.path.is_none() {
            return Ok(true);
        }
        self.configuration
            .project_mcp_trusted(
                self.owner.clone(),
                proposal.workspace.clone(),
                proposal.revision.clone(),
            )
            .await
            .map_err(|_| "agent_mcp_trust_unavailable".into())
    }
    pub async fn trust(&self, proposal: &Proposal) -> Result<(), String> {
        self.configuration
            .trust_project_mcp(
                self.owner.clone(),
                proposal.workspace.clone(),
                proposal.revision.clone(),
            )
            .await
            .map_err(|_| "agent_mcp_trust_unconfirmed".into())
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
        Ok(McpView::Configuration {
            path: path.to_string_lossy().into_owned(),
            revision: proposal.revision.clone(),
            trusted: self.trusted(proposal).await?,
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
            &serde_json::to_vec(&(
                &workspace.path,
                &workspace.identity,
                &workspace.directory_identity,
            ))
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
                .filter(|snapshot| Arc::ptr_eq(&snapshot.catalog, layer))
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
                    Some(project.catalog.clone()),
                )?
            }
            None => global,
        };
        client::current(&snapshots, session, base)
    }
    fn publish_cached(&self, proposal: &Proposal, catalog: &Arc<Catalog>) -> Result<(), String> {
        let mut snapshots = self.snapshots.write().expect("MCP snapshots");
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
                snapshots.current.remove(&proposal.workspace);
            }
        }
        Ok(())
    }
    async fn prepared(
        &self,
        proposal: Proposal,
        floor: &maka_sandbox::Sandbox,
    ) -> Result<Prepared, String> {
        if !self.trusted(&proposal).await? {
            return Err("agent_mcp_trust_required".into());
        }
        if !files::merge(&[], &[&proposal.global, &proposal.file]).is_empty() {
            super::require_compatible_floor(floor).map_err(str::to_owned)?;
        }
        if proposal.file.path.is_none() && proposal.global.path.is_none() {
            let catalog = self.base.clone();
            {
                let mut snapshots = self.snapshots.write().expect("MCP snapshots");
                snapshots.current.remove("");
                if !proposal.workspace.is_empty() {
                    snapshots.current.remove(&proposal.workspace);
                }
            }
            self.prune().await?;
            return Ok(Prepared::Ready(catalog));
        }
        if let Ok(catalog) = self.catalog(Some(&proposal.revision)) {
            self.publish_cached(&proposal, &catalog)?;
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
        self.prepared(self.proposal(workspace).await?, floor).await
    }
    pub async fn capture_global(
        self: &Arc<Self>,
        floor: &maka_sandbox::Sandbox,
    ) -> Result<Arc<Catalog>, String> {
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
    ) -> Result<Snapshot, String> {
        let selected = files::merge(&[], &[file]);
        if !selected.is_empty() {
            super::require_compatible_floor(floor).map_err(str::to_owned)?;
        }
        let servers = match Servers::open_cancellable(
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
        let catalog = match Catalog::with_layer(
            parent,
            revision,
            &overrides,
            servers.live_bindings.clone(),
            None,
        ) {
            Ok(catalog) => catalog,
            Err(error) => {
                if let Err(cleanup) = servers.close().await {
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
                let gate = owner.startup_gate(&proposal.revision);
                let _opening = gate.lock().await;
                if owner.stop.is_cancelled() {
                    return Err("agent_closed".into());
                }
                if !owner.trusted(&proposal).await? {
                    return Err("agent_mcp_trust_required".into());
                }
                if !files::merge(&[], &[&proposal.global, &proposal.file]).is_empty() {
                    super::require_compatible_floor(&floor).map_err(str::to_owned)?;
                }
                if let Ok(catalog) = owner.catalog(Some(&proposal.revision)) {
                    owner.publish_cached(&proposal, &catalog)?;
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
                let global_gate = (global_revision != proposal.revision)
                    .then(|| owner.startup_gate(&global_revision));
                let _global_opening = match global_gate.as_ref() {
                    Some(gate) => Some(gate.lock().await),
                    None => None,
                };
                let mut opened_global = None;
                let global = if proposal.global.path.is_none() {
                    owner.base.clone()
                } else if let Ok(catalog) = owner.catalog(Some(&global_revision)) {
                    catalog
                } else {
                    let opened = owner
                        .open_layer(
                            &proposal.global,
                            owner.base.clone(),
                            String::new(),
                            global_revision.clone(),
                            &floor,
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
                                && let Err(cleanup) = servers.close().await
                            {
                                let message = format!("{error}; {}", cleanup.message);
                                owner.retain_transport_cleanup(cleanup);
                                return Err(message);
                            }
                            return Err(error);
                        }
                    }
                };
                {
                    let mut snapshots = owner.snapshots.write().expect("MCP snapshots");
                    if let Some(opened) = opened_global {
                        snapshots
                            .revisions
                            .insert(global_revision.clone(), Arc::new(opened));
                    }
                    if proposal.global.path.is_some() {
                        snapshots.current.insert(String::new(), global_revision);
                    } else {
                        snapshots.current.remove("");
                    }
                    if let Some(opened) = opened_project {
                        snapshots
                            .revisions
                            .insert(proposal.revision.clone(), Arc::new(opened));
                        snapshots
                            .current
                            .insert(proposal.workspace, proposal.revision);
                    } else if !proposal.workspace.is_empty() {
                        snapshots.current.remove(&proposal.workspace);
                    }
                }
                owner.prune().await?;
                Ok(catalog)
            })
            .await
            .map_err(|_| "agent_mcp_startup_unknown".to_owned())?
    }
    pub(crate) async fn prune(&self) -> Result<(), String> {
        loop {
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
            if candidates.is_empty() {
                return Ok(());
            }
            let retained: std::collections::BTreeSet<_> = self
                .store
                .referenced_mcp_revisions(self.run_owner.clone())
                .await
                .map_err(|error| error.to_string())?;
            let retired: Vec<_> = {
                let mut snapshots = self.snapshots.write().expect("MCP snapshots");
                let retired = candidates
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
                retired
            };
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
    pub fn retire(&self) {
        self.stop.cancel();
    }
    pub async fn close(&self) -> Result<(), String> {
        let snapshots: Vec<_> = self
            .snapshots
            .read()
            .expect("MCP snapshots")
            .revisions
            .values()
            .cloned()
            .collect();
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
