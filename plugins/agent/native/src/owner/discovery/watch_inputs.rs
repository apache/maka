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
use cap_std::fs::Dir;
use maka_event_log::root::RootOwner;
use std::{
    io,
    path::{Component, Path, PathBuf},
};

/// Persist the original ceiling and session binding. Only a freshly opened directory grants access.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct WatchAuthority {
    pub target: ScheduledTarget,
    read_floor: maka_sandbox::Sandbox,
    workspace_reads: bool,
    pub plan: Option<String>,
    pub effect_ceiling: maka_sandbox::Sandbox,
}

impl Owner {
    pub(super) async fn watch_authority(
        &self,
        context: &ToolCallContext,
        name: &str,
        topic: &TopicId,
    ) -> Result<WatchAuthority, ToolError> {
        let access = self.discovery_call_access(context, name).await?;
        let read_floor = access.workspace_sandbox_floor().await?;
        let approval_ceiling = access.spec().approval_ceiling();
        let session = &context.execution.session_id;
        let thread = self
            .discovery
            .thread_topic(session.clone())
            .await
            .map_err(dossiers::write_error)?;
        let (target, plan, workspace_reads, effect_ceiling) = if let Some(bound) = thread {
            if &bound != topic {
                return Err(ToolError::Failed("discovery_wrong_topic".into()));
            }
            let config = self
                .session(session)
                .await
                .map_err(ToolError::Failed)?
                .configuration;
            let reads = config
                .tools
                .as_ref()
                .is_none_or(|tools| self.discovery_reads_files(tools));
            (
                ScheduledTarget {
                    session_id: session.clone(),
                    workspace: config.workspace,
                    permissions: config.permissions,
                    boundary_revision: config.boundary_revision,
                    binding: config.binding,
                },
                None,
                reads,
                approval_ceiling,
            )
        } else {
            let job = self
                .scheduler
                .investigation()
                .await
                .map_err(ToolError::Failed)?
                .1
                .ok_or_else(|| ToolError::Failed("discovery_not_active".into()))?;
            self.check_discovery_invocation(context, &job)
                .await
                .map_err(ToolError::Failed)?;
            (
                job.approval.target,
                Some(job.task_id),
                self.discovery_reads_files(&job.tools.names),
                job.approval
                    .sandbox_ceiling
                    .unwrap_or(maka_sandbox::Sandbox::Disabled),
            )
        };
        if self
            .discovery
            .get_dossier(topic.clone())
            .await
            .map_err(dossiers::write_error)?
            .is_none()
        {
            return Err(ToolError::Failed("discovery_topic_missing".into()));
        }
        Ok(WatchAuthority {
            target,
            read_floor,
            workspace_reads,
            plan,
            effect_ceiling,
        })
    }

    pub(super) async fn watch_inputs(
        &self,
        authority: &WatchAuthority,
        topic: TopicId,
    ) -> Result<WatchInputs, String> {
        let config = self.session(&authority.target.session_id).await?;
        check_target(&config, &authority.target)?;
        let workspace = &config.configuration.workspace;
        let (root, dir, _) = workspace::open_workspace_observation(
            &self.workspace_roots,
            workspace,
            &self.managed_worktrees,
        )
        .await?;
        let ceiling = access::reserved_sandbox_floor(&self.store, workspace)
            .await?
            .intersect(&authority.read_floor)
            .map_err(reason)?;
        let maka_sandbox::Sandbox::Managed { filesystem, .. } = ceiling else {
            return Err("workspace read access unavailable".into());
        };
        Ok(WatchInputs {
            state: self.store.owned_root().map_err(reason)?,
            topic,
            root,
            dir,
            roots: self.workspace_roots.clone(),
            reads: authority.workspace_reads
                && config
                    .configuration
                    .tools
                    .as_ref()
                    .is_none_or(|tools| self.discovery_reads_files(tools)),
            policy: filesystem.compile().map_err(reason)?,
        })
    }
}

pub(super) struct WatchInputs {
    state: Arc<RootOwner>,
    topic: TopicId,
    root: PathBuf,
    dir: Dir,
    roots: Vec<workspace::Root>,
    reads: bool,
    policy: maka_sandbox::filesystem::Compiled,
}

impl WatchInputs {
    fn location(&self, path: &str) -> io::Result<(String, Option<PathBuf>)> {
        let invalid = || {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "input outside authorized workspace or topic staging",
            )
        };
        let supplied = Path::new(path);
        if path.is_empty()
            || supplied
                .components()
                .any(|p| matches!(p, Component::ParentDir))
        {
            return Err(invalid());
        }
        let discovery = self.state.canonical_path().join("discovery");
        let staged = if supplied.is_absolute() {
            supplied.strip_prefix(&discovery).ok()
        } else {
            supplied.starts_with("staging").then_some(supplied)
        };
        if let Some(staged) = staged {
            let relative = staged
                .strip_prefix(Path::new("staging").join(&self.topic.0))
                .map_err(|_| invalid())?
                .to_str()
                .ok_or_else(invalid)?
                .replace(std::path::MAIN_SEPARATOR, "/");
            artifacts::validate_path(&self.topic, &relative)?;
            return Ok((
                format!("staging/{}/{relative}", self.topic.0),
                Some(staged.to_path_buf()),
            ));
        }
        let absolute: PathBuf = self.root.join(supplied).components().collect();
        if !self.reads
            || !self.policy.access(&absolute).can_read()
            || absolute.starts_with(self.state.control_directory())
            || absolute == self.state.lock_path()
        {
            return Err(invalid());
        }
        Ok((absolute.to_str().ok_or_else(invalid)?.to_owned(), None))
    }
    pub(super) fn hash(
        &self,
        path: &str,
        stop: &CancellationToken,
    ) -> io::Result<(String, String)> {
        let (key, staged) = self.location(path)?;
        let fp = if let Some(staged) = staged {
            let dir = artifacts::discovery_dir(&self.state, false)?;
            changes::fingerprint_in(&dir, &staged, stop)?
        } else {
            let absolute = Path::new(&key);
            if let Ok(relative) = absolute.strip_prefix(&self.root) {
                changes::fingerprint_in(&self.dir, relative, stop)?
            } else {
                let published = self
                    .roots
                    .iter()
                    .filter_map(workspace::Root::configured_directory)
                    .filter(|r| absolute.starts_with(r.path()))
                    .max_by_key(|r| r.path().components().count())
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "input outside authorized workspace roots",
                        )
                    })?;
                let dir = maka_fs_tools::directory::open(published.path(), &published.identity()?)?;
                changes::fingerprint_in(
                    &dir,
                    absolute
                        .strip_prefix(published.path())
                        .expect("matching root"),
                    stop,
                )?
            }
        }
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "input must be a regular file")
        })?;
        Ok((key, fp.hash))
    }
    pub(super) async fn snapshot(
        self,
        paths: Vec<String>,
        stop: CancellationToken,
    ) -> Result<BTreeMap<String, String>, String> {
        tokio::task::spawn_blocking(move || {
            paths
                .into_iter()
                .map(|p| self.hash(&p, &stop).map_err(|e| format!("{p}: {e}")))
                .collect()
        })
        .await
        .map_err(reason)?
    }
    pub(super) async fn changed(
        self,
        hashes: BTreeMap<String, String>,
        stop: CancellationToken,
    ) -> Result<Vec<String>, String> {
        tokio::task::spawn_blocking(move || {
            let mut changed = Vec::new();
            for (path, expected) in hashes {
                if stop.is_cancelled() {
                    return Err("discovery_confirmation_cancelled".into());
                }
                if !self
                    .hash(&path, &stop)
                    .is_ok_and(|(_, hash)| hash == expected)
                {
                    changed.push(path)
                }
            }
            Ok(changed)
        })
        .await
        .map_err(reason)?
    }
}
