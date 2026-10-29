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
use maka_agent_facts::{
    configuration::mcp::{ServerConfiguration, Transport},
    tools::ToolDefinition,
};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, RwLock},
};
use tokio::sync::Mutex;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(crate) struct Catalog {
    pub tools: maka_tools::ToolCatalog,
    pub definitions: Arc<Vec<ToolDefinition>>,
    pub bindings: Arc<BTreeMap<String, Option<String>>>,
    pub planning: Vec<String>,
}
struct Snapshot {
    catalog: Arc<Catalog>,
    servers: Servers,
}
pub(crate) enum Prepared {
    Ready(Option<String>),
    Startup(Box<Proposal>),
}
pub(crate) struct Proposal {
    pub workspace: String,
    pub revision: String,
    file: files::FileConfiguration,
}
pub(crate) struct Projects {
    pub base: Arc<Catalog>,
    owner: String,
    global: Vec<ServerConfiguration>,
    global_names: BTreeMap<String, Vec<String>>,
    store: Arc<maka_event_log::RootStore>,
    configuration: Arc<maka_config::ConfigurationStore>,
    snapshots: RwLock<BTreeMap<String, Arc<Snapshot>>>,
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
        global: Vec<ServerConfiguration>,
        global_names: BTreeMap<String, Vec<String>>,
        store: Arc<maka_event_log::RootStore>,
        configuration: Arc<maka_config::ConfigurationStore>,
        workers: TaskTracker,
        stop: CancellationToken,
    ) -> Self {
        Self {
            base: Arc::new(base),
            owner,
            global,
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
        let workspace = workspace.clone();
        let (workspace, file) = tokio::task::spawn_blocking(move || {
            let path = Path::new(&workspace.path);
            let directory = maka_fs_tools::workspace::open_directory(path, &workspace.identity)
                .map_err(|_| "agent_workspace_unavailable".to_owned())?;
            let file = files::read(&directory, path)?;
            Ok::<_, String>((workspace, file))
        })
        .await
        .map_err(|_| "agent_mcp_configuration_unavailable")??;
        let workspace = maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&(
                &workspace.path,
                &workspace.identity,
                &workspace.directory_identity,
            ))
            .expect("workspace identity"),
        );
        let revision = maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&(&workspace, &self.global, &file)).expect("MCP configuration"),
        );
        Ok(Proposal {
            workspace,
            revision,
            file,
        })
    }
    pub async fn trusted(&self, proposal: &Proposal) -> Result<bool, String> {
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
                .get(revision)
                .map(|snapshot| snapshot.catalog.clone())
                .ok_or_else(|| "agent_tools_changed".into()),
        }
    }
    pub async fn available(&self, workspace: &Workspace) -> Result<Option<String>, String> {
        let proposal = self.proposal(workspace).await?;
        Ok(if self.catalog(Some(&proposal.revision)).is_ok() {
            Some(proposal.revision)
        } else {
            None
        })
    }
    pub async fn prepare(&self, workspace: &Workspace) -> Result<Prepared, String> {
        let proposal = self.proposal(workspace).await?;
        if proposal.file.path.is_none() {
            return Ok(Prepared::Ready(None));
        }
        if !self.trusted(&proposal).await? {
            return Err("agent_mcp_trust_required".into());
        }
        if self.catalog(Some(&proposal.revision)).is_ok() {
            return Ok(Prepared::Ready(Some(proposal.revision)));
        }
        Ok(Prepared::Startup(Box::new(proposal)))
    }
    pub async fn capture(
        self: &Arc<Self>,
        workspace: &Workspace,
    ) -> Result<Option<String>, String> {
        match self.prepare(workspace).await? {
            Prepared::Ready(revision) => Ok(revision),
            Prepared::Startup(proposal) => self.start(*proposal).await,
        }
    }
    pub async fn start(self: &Arc<Self>, proposal: Proposal) -> Result<Option<String>, String> {
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
                if owner.catalog(Some(&proposal.revision)).is_ok() {
                    return Ok(Some(proposal.revision));
                }
                if !owner.trusted(&proposal).await? {
                    return Err("agent_mcp_trust_required".into());
                }
                let selected = files::merge(&[], &[&proposal.file]);
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
                    .file
                    .servers
                    .keys()
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
                owner.snapshots.write().expect("MCP snapshots").insert(
                    proposal.revision.clone(),
                    Arc::new(Snapshot {
                        catalog: Arc::new(Catalog {
                            tools,
                            definitions: Arc::new(definitions),
                            bindings: Arc::new(bindings),
                            planning,
                        }),
                        servers,
                    }),
                );
                Ok(Some(proposal.revision))
            })
            .await
            .map_err(|_| "agent_mcp_startup_unknown".to_owned())?
    }
    pub fn retire(&self) {
        self.stop.cancel();
    }
    pub async fn close(&self) -> Result<(), String> {
        let snapshots: Vec<_> = self
            .snapshots
            .read()
            .expect("MCP snapshots")
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
