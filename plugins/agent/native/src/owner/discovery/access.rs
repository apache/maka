/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use super::*;
use maka_event_log::{
    StoreError,
    root_store::DataWriter,
    writeback::{Prepared, Statement},
};
use maka_sandbox::{
    Network, Sandbox,
    filesystem::{Access, Policy, Rule, Scope},
};
use std::path::Path;

const EXCLUSIONS: &str = "discovery/exclusions";

impl scheduler::Scheduler {
    pub(in crate::owner) async fn discovery_exclusions(
        &self,
    ) -> Result<DiscoveryExclusions, String> {
        let record = self.storage.read(EXCLUSIONS.into()).await.map_err(reason)?;
        Ok(DiscoveryExclusions {
            revision: record.as_ref().map(|record| record.revision),
            entries: record
                .and_then(|record| record.data.value().cloned())
                .map(serde_json::from_value)
                .transpose()
                .map_err(reason)?
                .unwrap_or_default(),
        })
    }
}

impl Owner {
    pub(crate) fn check_discovery_settings_access(
        &self,
        session: &str,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<(), String> {
        if scope.identity.agent().is_some() || scope.work_custody().is_some() {
            return Err("discovery_settings_user_action_required".into());
        }
        if !self.settings.bot || !self.settings.scheduled_tasks || !self.bot.is(session) {
            return Err("discovery_requires_bot".into());
        }
        Ok(())
    }

    pub(crate) async fn change_discovery_exclusions(
        &self,
        input: ChangeDiscoveryExclusions,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<DiscoveryExclusionsResult>, String> {
        self.check_discovery_settings_access(&input.session_id, scope)?;
        let entries = tokio::task::spawn_blocking(move || normalize_exclusions(input.entries))
            .await
            .map_err(reason)??;
        let gate = Arc::new(self.scheduler.gate.clone().lock_owned().await);
        let current = self.scheduler.discovery_exclusions().await?;
        if current.revision != input.revision {
            return Ok(NativeMutation::Returned(
                DiscoveryExclusionsResult::Conflict,
            ));
        }
        if current.entries == entries {
            return Ok(NativeMutation::Returned(
                DiscoveryExclusionsResult::Committed {
                    exclusions: current,
                },
            ));
        }
        // An admitted worker owns an immutable OS sandbox until it settles.
        if self.scheduler.investigation().await?.1.is_some() {
            return Ok(NativeMutation::Returned(
                DiscoveryExclusionsResult::InvestigationRunning,
            ));
        }
        let writer = self.store.data_writer().map_err(reason)?;
        let change = writer
            .prepare_result(|writer| {
                Ok(ExclusionChange {
                    gate,
                    storage: self.scheduler.storage.clone(),
                    writer,
                    revision: current.revision,
                    entries,
                })
            })
            .map_err(reason)?;
        Ok(NativeMutation::Computed { change })
    }

    pub(in crate::owner) async fn discovery_tool_preview(
        &self,
        basis: &CapturedRun,
        target: &ScheduledTarget,
        profile: DiscoveryWorkerTools,
    ) -> Result<(scheduler::DiscoveryToolGrant, Vec<DiscoveryToolOption>), String> {
        let source = self.session(&target.session_id).await?;
        check_target(&source, target)?;
        let catalog = basis
            .mcp_catalog
            .as_ref()
            .ok_or("discovery_tool_catalog_unavailable")?;
        let exclusions = self.scheduler.discovery_exclusions().await?;
        let editing = basis.model.as_ref().and_then(|model| model.editing_tools);
        let configured = self
            .bot
            .configured_tool_ceiling(&source.id, source.configuration.tools.as_deref());
        let mut names = self
            .select_catalog_tools(&catalog.tools, None, configured, editing)
            .names();
        names.retain(|name| self.settings.recall || !RECALL_TOOLS.contains(&name.as_str()));
        names.sort_unstable();
        let options: Vec<_> = names
            .into_iter()
            .map(|name| {
                let group = self.discovery_tool_group(&name, catalog);
                let available = group_available(group, profile, &exclusions.entries);
                DiscoveryToolOption {
                    name,
                    group,
                    available,
                }
            })
            .collect();
        let names = options
            .iter()
            .filter(|option| option.available && profile.allows(option.group))
            .map(|option| option.name.clone())
            .collect();
        Ok((scheduler::DiscoveryToolGrant { profile, names }, options))
    }

    pub(super) fn discovery_worker_tools(
        &self,
        granted: &scheduler::DiscoveryToolGrant,
        configured: Option<&[String]>,
        catalog: &crate::mcp::Catalog,
        exclusions: &[DiscoveryExclusion],
    ) -> Vec<String> {
        granted
            .names
            .iter()
            .filter(|name| {
                let group = self.discovery_tool_group(name, catalog);
                (self.settings.recall || !RECALL_TOOLS.contains(&name.as_str()))
                    && configured.is_none_or(|configured| configured.contains(name))
                    && granted.profile.allows(group)
                    && group_available(group, granted.profile, exclusions)
            })
            .cloned()
            .chain(std::iter::once(COMPLETE.to_owned()))
            .chain(
                granted
                    .profile
                    .allows(DiscoveryToolGroup::ReadHistory)
                    .then(|| MEMORY.to_owned()),
            )
            .collect()
    }

    fn discovery_tool_group(
        &self,
        name: &str,
        catalog: &crate::mcp::Catalog,
    ) -> DiscoveryToolGroup {
        use DiscoveryToolGroup::*;
        if catalog.bindings.get(name).is_some_and(Option::is_some) {
            return Extensions;
        }
        if RECALL_TOOLS.contains(&name) || matches!(name, "SessionList" | "SessionRead") {
            return ReadHistory;
        }
        if let Some(tool) = self.tool_basis.iter().find(|tool| tool.name() == name) {
            return tool.discovery_group;
        }
        if self.discovery_reads.iter().any(|tool| tool == name) {
            return ReadFiles;
        }
        match name {
            "ScheduledTask" | "CreateGoal" | "GetGoal" | "GoalStatus" => ManageSessions,
            _ => Extensions,
        }
    }

    pub(in crate::owner) fn read_only_discovery_tool(&self, name: &str) -> bool {
        self.discovery_reads.iter().any(|tool| tool == name)
            || RECALL_TOOLS.contains(&name)
            || matches!(name, "SessionList" | "SessionRead")
    }
}

pub(in crate::owner) fn worker_permissions(
    profile: DiscoveryWorkerTools,
    permissions: &WorkspacePermissions,
) -> WorkspacePermissions {
    if profile.allows(DiscoveryToolGroup::ModifyFiles) {
        permissions.clone()
    } else {
        WorkspacePermissions {
            // Host HTTP still uses the Session's destination approval. The
            // captured process and file floor remains read-only.
            request_permissions: permissions.request_permissions
                && profile.allows(DiscoveryToolGroup::Network),
            ..super::permissions()
        }
    }
}

pub(in crate::owner) fn uses_base_catalog(
    profile: DiscoveryWorkerTools,
    exclusions: &[DiscoveryExclusion],
) -> bool {
    !profile.allows(DiscoveryToolGroup::Extensions)
        || !group_available(DiscoveryToolGroup::Extensions, profile, exclusions)
}

fn group_available(
    group: DiscoveryToolGroup,
    profile: DiscoveryWorkerTools,
    exclusions: &[DiscoveryExclusion],
) -> bool {
    use DiscoveryToolGroup::*;
    match group {
        // Delegation and external tools may have an independent execution environment.
        ManageSessions | Extensions | Desktop => {
            exclusions.is_empty()
                && [ReadFiles, ReadHistory, ModifyFiles, RunCommands, Network]
                    .into_iter()
                    .all(|permission| profile.allows(permission))
        }
        // These subprocess backends only snapshot matches at launch.
        RunCommands if !cfg!(target_os = "macos") => !exclusions
            .iter()
            .any(|rule| matches!(rule, DiscoveryExclusion::Suffix { .. })),
        _ => true,
    }
}

pub(super) fn run_restriction(
    profile: DiscoveryWorkerTools,
    exclusions: &[DiscoveryExclusion],
) -> Result<Option<Sandbox>, String> {
    let network = if profile.allows(DiscoveryToolGroup::Network) {
        Network::Allowed
    } else {
        Network::Denied
    };
    if exclusions.is_empty() && network == Network::Allowed {
        return Ok(None);
    }
    let mut filesystem = Policy::uniform(Access::Write);
    for rule in exclusions {
        match rule {
            DiscoveryExclusion::Directory { path } => {
                filesystem.rules.push(Rule::subtree(path, Access::Deny));
            }
            DiscoveryExclusion::File { path } => {
                filesystem.rules.push(Rule::exact(path, Access::Deny));
            }
            DiscoveryExclusion::Suffix { suffix } => {
                let mut pattern = if cfg!(windows) { "**/*" } else { "/**/*" }.to_owned();
                for c in suffix.chars() {
                    if c.is_ascii_alphabetic() {
                        pattern.extend(['[', c.to_ascii_lowercase(), c.to_ascii_uppercase(), ']']);
                    } else {
                        pattern.push(c);
                    }
                }
                filesystem.deny_globs.push(pattern);
            }
        }
    }
    filesystem.compile().map_err(reason)?;
    Ok(Some(Sandbox::Managed {
        filesystem,
        network,
    }))
}

fn normalize_exclusions(
    entries: Vec<DiscoveryExclusion>,
) -> Result<Vec<DiscoveryExclusion>, String> {
    let mut result = BTreeSet::new();
    for entry in entries {
        let normalized = match &entry {
            DiscoveryExclusion::Suffix { suffix } => {
                let suffix = suffix.trim().strip_prefix('.').unwrap_or(suffix.trim());
                if suffix.is_empty()
                    || !suffix
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
                    || !suffix.chars().any(|c| c.is_ascii_alphanumeric())
                {
                    return Err("discovery_invalid_exclusion_suffix".into());
                }
                DiscoveryExclusion::Suffix {
                    suffix: format!(".{}", suffix.to_ascii_lowercase()),
                }
            }
            DiscoveryExclusion::Directory { path } | DiscoveryExclusion::File { path } => {
                let directory = matches!(entry, DiscoveryExclusion::Directory { .. });
                let path = Path::new(path.trim());
                let rule = Rule {
                    path: path.to_owned(),
                    scope: if directory {
                        Scope::Subtree
                    } else {
                        Scope::Exact
                    },
                    access: Access::Read,
                };
                let mut permissions = maka_fs_tools::workspace::permissions::materialize(
                    maka_sandbox::grant::Permissions {
                        filesystem: vec![rule],
                        network: Network::Denied,
                    },
                )
                .map_err(|_| "discovery_invalid_exclusion_path")?;
                let path = permissions
                    .filesystem
                    .pop()
                    .expect("one materialized path")
                    .path;
                match std::fs::metadata(&path) {
                    Ok(meta) if meta.is_dir() == directory => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    _ => return Err("discovery_invalid_exclusion_path".into()),
                }
                let path = path
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "discovery_invalid_exclusion_path")?;
                if directory {
                    DiscoveryExclusion::Directory { path }
                } else {
                    DiscoveryExclusion::File { path }
                }
            }
        };
        result.insert(normalized);
    }
    let entries: Vec<_> = result.into_iter().collect();
    run_restriction(DiscoveryWorkerTools::Session, &entries)?;
    Ok(entries)
}

struct ExclusionChange {
    gate: Arc<tokio::sync::OwnedMutexGuard<()>>,
    storage: Arc<maka_host_runtime::storage::Storage>,
    writer: DataWriter,
    revision: Option<u64>,
    entries: Vec<DiscoveryExclusion>,
}

impl Statement for ExclusionChange {
    type Value = DiscoveryExclusionsResult;
    type Output = DiscoveryExclusionsResult;

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        vec![self.gate.clone()]
    }

    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        let write = mutation(EXCLUSIONS.into(), self.revision, &self.entries)
            .map_err(StoreError::InvalidTransition)?;
        let prepared = self
            .storage
            .prepare_statement(vec![write], &self.writer)?
            .execute(connection)?;
        Ok(Prepared {
            value: DiscoveryExclusionsResult::Committed {
                exclusions: DiscoveryExclusions {
                    revision: Some(prepared.value[0].revision),
                    entries: self.entries,
                },
            },
            changed: prepared.changed,
            notification: prepared.notification,
        })
    }

    fn committed(value: Self::Value) -> Self::Output {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error.underlying(),
            StoreError::RevisionConflict { .. } | StoreError::InvalidTransition(_)
        )
    }
}
