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

fn settings_projection(configuration: &Value, redacted: bool) -> (Value, bool) {
    let url = configuration.get("url");
    let display_url = url
        .and_then(Value::as_str)
        .and_then(crate::mcp::display_http_url);
    let has_literal_credentials = (url.is_some() && !matches!(display_url, Some((_, false))))
        || ["env", "headers"].iter().any(|key| {
            configuration.get(key).is_some_and(|value| {
                !value.is_null() && !value.as_object().is_some_and(|fields| fields.is_empty())
            })
        });
    let configuration = if redacted {
        serde_json::Value::Object(
            [
                "type",
                "url",
                "command",
                "args",
                "cwd",
                "disabled",
                "passEnv",
                "headerEnv",
            ]
            .into_iter()
            .filter_map(|key| {
                let value = if key == "url" {
                    Value::String(display_url.as_ref()?.0.clone())
                } else {
                    configuration.get(key)?.clone()
                };
                Some((key.to_owned(), value))
            })
            .collect(),
        )
    } else {
        configuration.clone()
    };
    (configuration, has_literal_credentials)
}

#[derive(Clone)]
pub(super) struct Location {
    pub(super) id: LocationId,
    pub(super) root: Arc<Dir>,
    pub(super) path: PathBuf,
}
impl Location {
    pub(super) fn file_path(&self) -> String {
        self.path.join("mcp.json").to_string_lossy().into_owned()
    }
    pub(super) fn ensure_dir(&self) -> Result<bool, String> {
        let name = self.id.configuration_directory();
        match self.root.create_dir(name) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }
    pub(super) fn remove_dir_if_empty(&self) {
        let _ = self.root.remove_dir(self.id.configuration_directory());
    }
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
    pub(super) async fn mcp_locations(
        &self,
        workspace: Option<Workspace>,
    ) -> Result<Vec<Location>, String> {
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
                let redacted = input.redacted;
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
                                let (configuration, has_literal_credentials) =
                                    settings_projection(configuration, redacted);
                                servers.push(McpConfigurationEntry {
                                    name: name.clone(),
                                    configuration,
                                    has_literal_credentials,
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
                        if let Err(error) = owner
                            .mcp_projects
                            .drop_stale_for_scope(Some(&input.workspace))
                            .await
                        {
                            tracing::warn!(error = %error, "MCP stale snapshot retirement failed after decision update");
                        }
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
                                let server = serde_json::Value::Object(server);
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
                    let scope_workspace = matches!(
                        input.location,
                        LocationId::ProjectMaka | LocationId::ProjectAgents
                    )
                    .then_some(workspace.as_ref())
                    .flatten();
                    if let Err(error) = owner
                        .mcp_projects
                        .drop_stale_for_scope(scope_workspace)
                        .await
                    {
                        tracing::warn!(error = %error, "MCP stale snapshot retirement failed after configuration save");
                    }
                }
                Ok(outcome)
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_mcp_inventory_omits_literal_credentials_but_preserves_environment_references() {
        let document = serde_json::json!({
            "type": "http", "url": "https://example.test/mcp",
            "headers": {"Authorization": "literal-token"},
            "env": {"TOKEN": "literal-env"},
            "headerEnv": {"X-API-Key": "API_TOKEN"},
        });
        let (mobile, has_literal_credentials) = settings_projection(&document, true);
        assert!(has_literal_credentials);
        assert_eq!(
            mobile,
            serde_json::json!({
                "type":"http", "url":"https://example.test/mcp", "headerEnv":{"X-API-Key":"API_TOKEN"}
            })
        );
        assert_eq!(settings_projection(&document, false), (document, true));
    }
    #[test]
    fn mobile_mcp_inventory_omits_http_query_credentials_without_changing_the_saved_url() {
        let document = serde_json::json!({
            "type": "http", "url": "https://example.test/mcp?token=literal-url-token"
        });
        assert_eq!(
            settings_projection(&document, true),
            (
                serde_json::json!({"type":"http","url":"https://example.test/mcp"}),
                true
            )
        );
        assert_eq!(settings_projection(&document, false), (document, true));
    }
}
