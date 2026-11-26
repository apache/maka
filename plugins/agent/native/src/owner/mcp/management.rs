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

use super::*;
use crate::mcp::files;
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use maka_skills::LocationId;
use std::{
    io::{self, Write},
    path::{Path, PathBuf},
};

struct Location {
    id: LocationId,
    root: Arc<Dir>,
    path: PathBuf,
}
impl Location {
    fn directory(&self, create: bool) -> Result<Option<Dir>, String> {
        let name = self.id.configuration_directory();
        if create {
            match self.root.create_dir(name) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        match self.root.open_dir_nofollow(name) {
            Ok(dir) => Ok(Some(dir)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    pub(super) fn read(&self) -> Result<files::DocumentFile, String> {
        match self.directory(false)? {
            Some(directory) => files::document(&directory),
            None => Ok(files::DocumentFile {
                value: serde_json::json!({"mcpServers":{}}),
                revision: maka_agent_facts::artifact::content_digest(b""),
            }),
        }
    }
    pub(super) fn write(&self, value: &Value) -> Result<(), String> {
        let directory = self
            .directory(true)?
            .ok_or("MCP configuration directory unavailable")?;
        let name = format!(".mcp-{}.json", Uuid::new_v4());
        let result = (|| {
            let mut file = directory
                .open_with(
                    &name,
                    cap_std::fs::OpenOptions::new().write(true).create_new(true),
                )
                .map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use cap_std::fs::PermissionsExt;
                file.set_permissions(cap_std::fs::Permissions::from_mode(0o600))
                    .map_err(|error| error.to_string())?;
            }
            let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
            file.write_all(&bytes).map_err(|error| error.to_string())?;
            file.write_all(
                b"
",
            )
            .map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            directory
                .rename(&name, &directory, "mcp.json")
                .map_err(|error| error.to_string())
        })();
        if result.is_err() {
            let _ = directory.remove_file(&name);
        }
        result
    }
}
impl Owner {
    async fn mcp_locations(&self, workspace: Option<Workspace>) -> Result<Vec<Location>, String> {
        let project = match workspace {
            Some(workspace) => {
                let (path, directory, _) = workspace::open_workspace_observation(
                    &self.workspace_roots,
                    &workspace,
                    &self.managed_worktrees,
                )
                .await?;
                debug_assert!(Path::new(&workspace.path).is_absolute());
                Some((Arc::new(directory), path))
            }
            None => None,
        };
        let home = self.instruction_home.clone().zip(
            self.settings
                .assistant
                .as_ref()
                .and_then(|assistant| assistant.home.as_ref())
                .map(PathBuf::from),
        );
        tokio::task::spawn_blocking(move || {
            Ok(LocationId::ALL
                .into_iter()
                .filter_map(|id| {
                    let (root, path) =
                        if matches!(id, LocationId::ProjectMaka | LocationId::ProjectAgents) {
                            project.as_ref()?
                        } else {
                            home.as_ref()?
                        };
                    Some(Location {
                        id,
                        root: root.clone(),
                        path: path.join(id.configuration_directory()),
                    })
                })
                .collect())
        })
        .await
        .map_err(|error| error.to_string())?
    }
    pub(crate) async fn mcp_configurations(
        self: &Arc<Self>,
        input: McpConfigurations,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<McpConfigurationList, String> {
        self.resource_work(scope, move |owner, _scope| {
            Box::pin(async move {
                let workspace = input.workspace.clone();
                let locations = owner.mcp_locations(input.workspace).await?;
                let project_trust = if let Some(workspace) = workspace.as_ref() {
                    if let Ok(proposal) = owner.mcp_projects.proposal(workspace).await
                        && let (Some(path), Some(revision)) =
                            (proposal.project_path(), proposal.project_revision.as_ref())
                    {
                        let decision = match owner.mcp_projects.decision(&proposal).await? {
                            Some(maka_config::ProjectMcpDecision::Trusted) => {
                                ProjectMcpTrustDecision::Trusted
                            }
                            Some(maka_config::ProjectMcpDecision::Declined) => {
                                ProjectMcpTrustDecision::Declined
                            }
                            None => ProjectMcpTrustDecision::Undecided,
                        };
                        Some(ProjectMcpTrustStatus {
                            path,
                            revision: revision.clone(),
                            decision,
                        })
                    } else {
                        None
                    }
                } else {
                    None
                };
                tokio::task::spawn_blocking(move || {
                    let mut selected = BTreeMap::new();
                    let mut output = Vec::new();
                    for location in locations {
                        let document = location.read()?;
                        let mut servers = Vec::new();
                        if let Some(entries) = document.value["mcpServers"].as_object() {
                            for (name, configuration) in entries {
                                let shadowed_by = selected.get(name).copied();
                                selected.entry(name.clone()).or_insert(location.id);
                                servers.push(McpConfigurationEntry {
                                    name: name.clone(),
                                    configuration: configuration.clone(),
                                    shadowed_by,
                                });
                            }
                        }
                        output.push(McpConfigurationLocation {
                            location: location.id,
                            path: location
                                .path
                                .join("mcp.json")
                                .to_string_lossy()
                                .into_owned(),
                            revision: document.revision,
                            servers,
                        });
                    }
                    Ok(McpConfigurationList {
                        locations: output,
                        project_trust,
                    })
                })
                .await
                .map_err(|error| error.to_string())?
            })
        })
        .await
    }
    pub(crate) async fn set_project_mcp_decision(
        self: &Arc<Self>,
        input: McpProjectTrustChange,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<McpProjectTrustChangeResult, String> {
        self.resource_work(scope, move |owner, _scope| {
            Box::pin(async move {
                workspace::validate(
                    &owner.workspace_roots,
                    &input.workspace,
                    &owner.managed_worktrees,
                )
                .await?;
                let proposal = owner.mcp_projects.proposal(&input.workspace).await?;
                if proposal.project_revision.as_deref() != Some(input.revision.as_str()) {
                    return Ok(McpProjectTrustChangeResult::Changed);
                }
                match input.decision {
                    ProjectMcpDecisionInput::Trusted => {
                        owner.mcp_projects.trust(&proposal).await?;
                    }
                    ProjectMcpDecisionInput::Declined => {
                        owner.mcp_projects.decline(&proposal).await?;
                        let _ = owner
                            .mcp_projects
                            .drop_stale_for_scope(Some(&input.workspace))
                            .await;
                    }
                }
                owner
                    .store
                    .owned_root()
                    .map_err(|_| "agent_root_unavailable")?
                    .capability_source_changed();
                Ok(McpProjectTrustChangeResult::Saved)
            })
        })
        .await
    }
    pub(crate) async fn manage_mcp_server(
        self: &Arc<Self>,
        input: McpConfigurationChange,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<McpConfigurationResult, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let workspace = input.workspace.clone();
                let locations = owner.mcp_locations(input.workspace).await?;
                let location = locations
                    .into_iter()
                    .find(|location| location.id == input.location)
                    .ok_or("MCP configuration location unavailable")?;
                let root = owner
                    .store
                    .owned_root()
                    .map_err(|error| error.to_string())?;
                let outcome = tokio::task::spawn_blocking(move || {
                    let result = (|| {
                        root.validate_current().map_err(|error| error.to_string())?;
                        let _lease = maka_event_log::root::FileLease::acquire(
                            &root.canonical_path().join("mcp-management.lock"),
                        )
                        .map_err(|error| error.to_string())?;
                        let document = location.read()?;
                        if document.revision != input.revision {
                            return Ok(McpConfigurationResult::Changed);
                        }
                        let mut value = document.value;
                        let entries = value
                            .as_object_mut()
                            .ok_or("MCP configuration must be an object")?
                            .entry("mcpServers")
                            .or_insert_with(|| serde_json::json!({}))
                            .as_object_mut()
                            .ok_or("mcpServers must be an object")?;
                        match input.change {
                            McpServerChange::Save { configuration } => {
                                let fields = configuration
                                    .as_object()
                                    .ok_or("MCP server configuration must be an object")?;
                                let mut server = entries
                                    .get(&input.name)
                                    .and_then(Value::as_object)
                                    .cloned()
                                    .unwrap_or_default();
                                // Replace form-owned fields; retain settings this form does not edit.
                                for key in [
                                    "type",
                                    "command",
                                    "args",
                                    "cwd",
                                    "env",
                                    "passEnv",
                                    "url",
                                    "headers",
                                    "headerEnv",
                                    "disabled",
                                ] {
                                    server.remove(key);
                                }
                                server.extend(fields.clone());
                                let server = Value::Object(server);
                                files::validate_server(
                                    &input.name,
                                    server.clone(),
                                    &location.path,
                                )?;
                                entries.insert(input.name, server);
                            }
                            McpServerChange::Delete => {
                                entries.remove(&input.name);
                            }
                        }
                        if scope.cancellation.is_cancelled() {
                            return Err("MCP configuration change cancelled".into());
                        }
                        location.write(&value)?;
                        root.capability_source_changed();
                        Ok(McpConfigurationResult::Saved)
                    })();
                    Ok::<_, String>(match result {
                        Ok(result) => result,
                        Err(reason) => McpConfigurationResult::Rejected { reason },
                    })
                })
                .await
                .map_err(|error| error.to_string())??;
                if matches!(outcome, McpConfigurationResult::Saved) {
                    let _ = owner
                        .mcp_projects
                        .drop_stale_for_scope(workspace.as_ref())
                        .await;
                }
                Ok(outcome)
            })
        })
        .await
    }
}
