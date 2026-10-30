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

use super::{Servers, files};
use crate::contract::{McpServerView, McpView, Workspace};
use maka_agent_facts::{configuration::mcp::Transport, tools::ToolDefinition};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::Mutex;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(crate) struct Catalog {
    pub revision: Option<String>,
    pub tools: maka_tools::ToolCatalog,
    pub definitions: Arc<Vec<ToolDefinition>>,
    pub bindings: Arc<BTreeMap<String, Option<String>>>,
    pub planning: Vec<String>,
}
struct Snapshot {
    scope: String,
    acquired: AtomicU64,
    catalog: Arc<Catalog>,
    servers: Servers,
}
#[derive(Default)]
struct Snapshots {
    revisions: BTreeMap<String, Arc<Snapshot>>,
    current: BTreeMap<String, String>,
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
pub(crate) struct Projects {
    pub base: Arc<Catalog>,
    owner: String,
    home: Option<(Arc<cap_std::fs::Dir>, std::path::PathBuf)>,
    global_names: BTreeMap<String, Vec<String>>,
    store: Arc<maka_event_log::RootStore>,
    configuration: Arc<maka_config::ConfigurationStore>,
    snapshots: RwLock<Snapshots>,
    opening: std::sync::Mutex<BTreeMap<String, std::sync::Weak<Mutex<()>>>>,
    cleanup_failure: std::sync::Mutex<Option<String>>,
    workers: TaskTracker,
    stop: CancellationToken,
}
impl Projects {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        base: Catalog,
        owner: String,
        global_names: BTreeMap<String, Vec<String>>,
        home: Option<(Arc<cap_std::fs::Dir>, std::path::PathBuf)>,
        store: Arc<maka_event_log::RootStore>,
        configuration: Arc<maka_config::ConfigurationStore>,
        workers: TaskTracker,
        stop: CancellationToken,
    ) -> Self {
        Self {
            base: Arc::new(base),
            owner,
            home,
            global_names,
            store,
            configuration,
            snapshots: RwLock::default(),
            opening: std::sync::Mutex::default(),
            cleanup_failure: std::sync::Mutex::new(None),
            workers,
            stop,
        }
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
                let identity = maka_agent_facts::artifact::content_digest(
                    &serde_json::to_vec(&(
                        &workspace.path,
                        &workspace.identity,
                        &workspace.directory_identity,
                    ))
                    .expect("workspace identity"),
                );
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
    ) -> Result<Arc<Catalog>, String> {
        let proposal = self.proposal(workspace).await?;
        if !self.trusted(&proposal).await? {
            return self.capture_global().await;
        }
        self.capture(workspace).await
    }
    fn supersede(&self, scope: &str, current: Option<&str>) {
        let mut snapshots = self.snapshots.write().expect("MCP snapshots");
        match current {
            Some(revision)
                if snapshots.current.contains_key(scope)
                    || snapshots.revisions.contains_key(revision) =>
            {
                snapshots.current.insert(scope.into(), revision.into());
            }
            Some(_) => {}
            None => {
                snapshots.current.remove(scope);
            }
        }
    }
    async fn prepared(&self, proposal: Proposal) -> Result<Prepared, String> {
        if proposal.file.path.is_none() && !proposal.workspace.is_empty() {
            self.supersede(&proposal.workspace, None);
        }
        let scope = if proposal.file.path.is_some() {
            proposal.workspace.as_str()
        } else {
            ""
        };
        self.supersede(
            scope,
            (proposal.file.path.is_some() || proposal.global.path.is_some())
                .then_some(proposal.revision.as_str()),
        );
        if proposal.file.path.is_none() && proposal.global.path.is_none() {
            return Ok(Prepared::Ready(self.base.clone()));
        }
        if !self.trusted(&proposal).await? {
            return Err("agent_mcp_trust_required".into());
        }
        if let Ok(catalog) = self.catalog(Some(&proposal.revision)) {
            return Ok(Prepared::Ready(catalog));
        }
        Ok(Prepared::Startup(Box::new(proposal)))
    }
    pub async fn prepare(&self, workspace: &Workspace) -> Result<Prepared, String> {
        self.prepared(self.proposal(workspace).await?).await
    }
    pub async fn capture_global(self: &Arc<Self>) -> Result<Arc<Catalog>, String> {
        match self.prepared(self.propose(None).await?).await? {
            Prepared::Ready(revision) => Ok(revision),
            Prepared::Startup(proposal) => self.start(*proposal).await,
        }
    }
    pub async fn capture(self: &Arc<Self>, workspace: &Workspace) -> Result<Arc<Catalog>, String> {
        match self.prepare(workspace).await? {
            Prepared::Ready(revision) => Ok(revision),
            Prepared::Startup(proposal) => self.start(*proposal).await,
        }
    }
    pub async fn start(self: &Arc<Self>, proposal: Proposal) -> Result<Arc<Catalog>, String> {
        // Opening belongs to Owner, even if the send/query observer disappears.
        // Shutdown cancels admissions, drains these workers, then closes all sessions.
        let owner = self.clone();
        self.workers
            .spawn(async move {
                let gate = {
                    let mut gates = owner.opening.lock().expect("MCP startup gates");
                    gates.retain(|_, gate| gate.strong_count() > 0);
                    let gate = gates
                        .get(&proposal.revision)
                        .and_then(std::sync::Weak::upgrade)
                        .unwrap_or_else(|| Arc::new(Mutex::new(())));
                    gates.insert(proposal.revision.clone(), Arc::downgrade(&gate));
                    gate
                };
                let _opening = gate.lock().await;
                if owner.stop.is_cancelled() {
                    return Err("agent_closed".into());
                }
                if let Ok(catalog) = owner.catalog(Some(&proposal.revision)) {
                    return Ok(catalog);
                }
                if !owner.trusted(&proposal).await? {
                    return Err("agent_mcp_trust_required".into());
                }
                let selected = files::merge(&[], &[&proposal.global, &proposal.file]);
                if let Some(error) = owner
                    .cleanup_failure
                    .lock()
                    .expect("MCP cleanup state")
                    .as_ref()
                {
                    return Err(error.clone());
                }
                let mut servers = match Servers::open_cancellable(
                    &selected,
                    owner.store.clone(),
                    &owner.configuration,
                    owner.stop.clone(),
                )
                .await
                {
                    Ok(servers) => servers,
                    Err(error) => {
                        if !error.cleanup_confirmed {
                            *owner.cleanup_failure.lock().expect("MCP cleanup state") =
                                Some(error.message.clone());
                        }
                        return Err(error.message);
                    }
                };
                let suppressed: Vec<_> = proposal
                    .global
                    .servers
                    .keys()
                    .chain(proposal.file.servers.keys())
                    .filter_map(|name| owner.global_names.get(name))
                    .flatten()
                    .map(String::as_str)
                    .collect();
                let tools = match owner
                    .base
                    .tools
                    .excluding(&suppressed)
                    .with_additional(std::mem::take(&mut servers.registrations))
                {
                    Ok(tools) => tools,
                    Err(_) => {
                        if let Err(error) = servers.close().await {
                            *owner.cleanup_failure.lock().expect("MCP cleanup state") =
                                Some(error.clone());
                            return Err(error);
                        }
                        return Err("agent_mcp_catalog_invalid".into());
                    }
                };
                let mut definitions: Vec<_> = owner
                    .base
                    .definitions
                    .iter()
                    .filter(|tool| !suppressed.contains(&tool.name.as_str()))
                    .cloned()
                    .collect();
                definitions.extend(
                    tools
                        .definitions()
                        .filter(|tool| servers.bindings.contains_key(&tool.name))
                        .cloned(),
                );
                let mut bindings: BTreeMap<_, _> = owner
                    .base
                    .bindings
                    .iter()
                    .filter(|(name, _)| !suppressed.contains(&name.as_str()))
                    .map(|(name, binding)| (name.clone(), binding.clone()))
                    .collect();
                bindings.extend(servers.bindings.clone());
                let mut planning: Vec<_> = owner
                    .base
                    .planning
                    .iter()
                    .filter(|name| !suppressed.contains(&name.as_str()))
                    .cloned()
                    .collect();
                planning.extend(servers.planning.clone());
                let catalog = Arc::new(Catalog {
                    revision: Some(proposal.revision.clone()),
                    tools,
                    definitions: Arc::new(definitions),
                    bindings: Arc::new(bindings),
                    planning,
                });
                let scope = if proposal.file.path.is_some() {
                    proposal.workspace
                } else {
                    String::new()
                };
                {
                    let mut snapshots = owner.snapshots.write().expect("MCP snapshots");
                    snapshots
                        .current
                        .insert(scope.clone(), proposal.revision.clone());
                    snapshots.revisions.insert(
                        proposal.revision,
                        Arc::new(Snapshot {
                            scope,
                            acquired: AtomicU64::new(0),
                            catalog: catalog.clone(),
                            servers,
                        }),
                    );
                }
                owner.prune().await?;
                Ok(catalog)
            })
            .await
            .map_err(|_| "agent_mcp_startup_unknown".to_owned())?
    }
    pub(crate) async fn prune(&self) -> Result<(), String> {
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
            .accepted_execution_references(&self.owner, "mcp_revision")
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
            let Snapshots { revisions, current } = &mut *snapshots;
            current.retain(|_, revision| revisions.contains_key(revision));
            retired
        };
        for snapshot in retired {
            if let Err(error) = snapshot.servers.close().await {
                *self.cleanup_failure.lock().expect("MCP cleanup state") = Some(error.clone());
                return Err(error);
            }
        }
        Ok(())
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
        let mut error = self
            .cleanup_failure
            .lock()
            .expect("MCP cleanup state")
            .clone();
        for snapshot in snapshots {
            if let Err(cause) = snapshot.servers.close().await {
                error.get_or_insert(cause);
            }
        }
        error.map_or(Ok(()), Err)
    }
}
