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
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use maka_agent_state::discovery::StagedArtifact;
use maka_event_log::root::RootOwner;
use std::{
    io::{self, Read, Write},
    path::Component,
};

const MAX_BYTES: usize = 512 * 1024;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct StageArtifact {
    pub topic_id: TopicId,
    relative_path: String,
    content: String,
    purpose: String,
    #[serde(default)]
    input_paths: Vec<String>,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(super) fn validate_path(topic: &TopicId, path: &str) -> io::Result<()> {
    if topic.0.trim().is_empty() || topic.0.contains('/') || path.trim().is_empty() {
        return Err(invalid(
            "provide one topic directory and a relative artifact path",
        ));
    }
    for value in [topic.0.as_str(), path] {
        maka_packages::validate_path(value)
            .map_err(|_| invalid("invalid relative artifact path"))?;
    }
    Ok(())
}

fn child(parent: &Dir, name: &str, create: bool) -> io::Result<Dir> {
    match parent.open_dir_nofollow(name) {
        Err(e) if create && e.kind() == io::ErrorKind::NotFound => {
            match parent.create_dir(name) {
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
                result => result?,
            }
            parent.open_dir_nofollow(name)
        }
        result => result,
    }
}

pub(super) fn discovery_dir(root: &RootOwner, create: bool) -> io::Result<Dir> {
    let handle =
        Dir::open_ambient_dir(root.canonical_path(), cap_std::ambient_authority())?.into_std_file();
    root.validate_directory_handle(&handle)?;
    child(&Dir::from_std_file(handle), "discovery", create)
}

fn destination<'a>(
    root: &RootOwner,
    topic: &TopicId,
    path: &'a str,
    create: bool,
) -> io::Result<(Dir, &'a str)> {
    let staging = child(&discovery_dir(root, create)?, "staging", create)?;
    let mut dir = child(&staging, &topic.0, create)?;
    let mut parts = path.split('/');
    let leaf = parts.next_back().expect("validated relative path");
    for part in parts {
        dir = child(&dir, part, create)?;
    }
    Ok((dir, leaf))
}

pub(super) fn read_text(dir: &Dir, name: &str, limit: usize) -> io::Result<String> {
    let mut opts = OpenOptions::new();
    opts.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    cap_std::fs::OpenOptionsExt::custom_flags(&mut opts, libc::O_NONBLOCK);
    let file = dir.open_with(name, &opts)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > limit as u64 {
        return Err(invalid("expected a bounded regular file"));
    }
    let mut text = String::new();
    file.take((limit + 1) as u64).read_to_string(&mut text)?;
    if text.len() > limit {
        return Err(invalid("file exceeds size limit"));
    }
    Ok(text)
}

pub(super) fn write_text(dir: &Dir, name: &str, content: &str) -> io::Result<()> {
    match dir.symlink_metadata(name) {
        Ok(meta) if !meta.is_file() => return Err(invalid("destination must be a regular file")),
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => (),
    }
    let temp = format!(".{}.tmp", Uuid::new_v4());
    let mut opts = OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    cap_std::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut file = dir.open_with(&temp, &opts)?;
    let result = (|| {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        dir.rename(&temp, dir, name)
    })();
    if result.is_err()
        && let Err(e) = dir.remove_file(&temp)
    {
        tracing::warn!(%e, "Could not remove temporary discovery file");
    }
    result
}

struct Inputs {
    root: std::path::PathBuf,
    directory: Dir,
    policy: maka_sandbox::filesystem::Compiled,
}

impl StageArtifact {
    fn stage(
        self,
        state: &RootOwner,
        inputs: Option<Inputs>,
        stop: &CancellationToken,
    ) -> io::Result<StagedArtifact> {
        validate_path(&self.topic_id, &self.relative_path)?;
        if self.content.len() > MAX_BYTES
            || self.purpose.trim().is_empty()
            || self.purpose.len() > 1024
            || self.input_paths.len() > 64
        {
            return Err(invalid(
                "expected at most 512 KiB of content, a concise purpose and at most 64 inputs",
            ));
        }
        let mut input_hashes = BTreeMap::new();
        for path in self.input_paths {
            if input_hashes.contains_key(&path) {
                continue;
            }
            let inputs = inputs
                .as_ref()
                .ok_or_else(|| invalid("workspace read access required"))?;
            let absolute = inputs.root.join(&path);
            let relative = absolute
                .strip_prefix(&inputs.root)
                .map_err(|_| invalid("input outside authorized workspace"))?;
            if relative.as_os_str().is_empty()
                || relative
                    .components()
                    .any(|c| !matches!(c, Component::Normal(_)))
                || !inputs.policy.access(&absolute).can_read()
            {
                return Err(invalid("input outside authorized workspace"));
            }
            match changes::fingerprint_in(&inputs.directory, relative, stop) {
                Ok(Some(fp)) => {
                    input_hashes.insert(path, fp.hash);
                }
                Ok(None) => (),
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                    ) =>
                {
                    ()
                }
                Err(e) => return Err(e),
            }
        }
        if stop.is_cancelled() {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let (dir, name) = destination(state, &self.topic_id, &self.relative_path, true)?;
        write_text(&dir, name, &self.content)?;
        Ok(StagedArtifact {
            path: self.relative_path,
            purpose: self.purpose,
            sha256: hex::encode(Sha256::digest(self.content.as_bytes())),
            input_hashes,
        })
    }
}

impl Owner {
    pub(super) async fn stage_artifact(
        &self,
        context: &ToolCallContext,
        stage: StageArtifact,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let access = self.discovery_call_access(context, STAGE).await?;
        let session = &context.execution.session_id;
        let thread = self
            .discovery
            .thread_topic(session.clone())
            .await
            .map_err(dossiers::write_error)?;
        if let Some(topic) = &thread {
            if *topic != stage.topic_id {
                return Err(ToolError::Failed("discovery_wrong_topic".into()));
            }
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
            if !stage.input_paths.is_empty() && !self.discovery_reads_files(&job.tools.names) {
                return Err(ToolError::Failed(
                    "workspace read tools required to hash inputs".into(),
                ));
            }
        }
        let root = self.store.owned_root().map_err(dossiers::write_error)?;
        let inputs = if stage.input_paths.is_empty() {
            None
        } else {
            let selected = self
                .session(session)
                .await
                .map_err(ToolError::Failed)?
                .configuration
                .workspace;
            let floor = access.workspace_sandbox_floor().await?;
            let reserved = access::reserved_sandbox_floor(&self.store, &selected)
                .await
                .map_err(ToolError::Failed)?;
            let maka_sandbox::Sandbox::Managed { filesystem, .. } = reserved
                .intersect(&floor)
                .map_err(|e| ToolError::Failed(reason(e)))?
            else {
                return Err(ToolError::Failed("workspace read access required".into()));
            };
            let (root, directory, _) = workspace::open_workspace_observation(
                &self.workspace_roots,
                &selected,
                &self.managed_worktrees,
            )
            .await
            .map_err(ToolError::Failed)?;
            Some(Inputs {
                root,
                directory,
                policy: filesystem
                    .compile()
                    .map_err(|e| ToolError::Failed(reason(e)))?,
            })
        };
        let receipt = tokio::task::spawn_blocking(move || stage.stage(&root, inputs, &cancel))
            .await
            .map_err(|e| ToolError::OutcomeUnknown(reason(e)))?
            .map_err(|e| ToolError::Failed(reason(e)))?;
        let result = serde_json::json!(receipt);
        if let Some(topic) = thread {
            self.discovery
                .attach_thread_artifact(session.clone(), topic, receipt, UnixMillis(now() as i64))
                .await
                .map_err(dossiers::write_error)?;
        }
        Ok(result)
    }

    pub(crate) async fn read_dossier_artifact(
        &self,
        query: DossierArtifactRead,
    ) -> Result<String, String> {
        validate_path(&query.topic_id, &query.path).map_err(reason)?;
        let digest = self
            .discovery
            .artifact(query.topic_id.clone(), query.path.clone())
            .await
            .map_err(reason)?
            .ok_or("discovery_artifact_not_listed")?
            .sha256
            .ok_or("discovery_artifact_unverified")?;
        let root = self.store.owned_root().map_err(reason)?;
        let topic = query.topic_id.clone();
        let text = tokio::task::spawn_blocking(move || {
            let (dir, name) = destination(&root, &query.topic_id, &query.path, false)?;
            let text = read_text(&dir, name, MAX_BYTES)?;
            if hex::encode(Sha256::digest(text.as_bytes())) != digest {
                return Err(invalid("staged artifact has changed"));
            }
            Ok(text)
        })
        .await
        .map_err(reason)?
        .map_err(reason)?;
        self.record_discovery_outcome(&topic, "opened a staged artifact")
            .await;
        Ok(text)
    }

    pub(super) async fn discovery_call_access(
        &self,
        context: &ToolCallContext,
        name: &str,
    ) -> Result<Arc<RunAccess>, ToolError> {
        let access = self
            .runs
            .state()
            .await
            .controls
            .get(&context.execution.session_id)
            .and_then(|c| c.access.upgrade())
            .ok_or_else(|| ToolError::Failed("agent_run_access_expired".into()))?;
        access.check_tool(context, name).await?;
        Ok(access)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_event_log::root::RootNamespaces;

    #[test]
    fn discovery_stage_is_atomic_bounded_and_confined_to_one_topic() {
        let base = tempfile::tempdir().unwrap();
        let root = RootOwner::create(
            &base.path().join("state"),
            &RootNamespaces {
                ownership: base.path().join("owners"),
                control: base.path().join("control"),
            },
        )
        .unwrap();
        let stage = |topic: &str, path: &str, content: &str| {
            StageArtifact {
                topic_id: TopicId(topic.into()),
                relative_path: path.into(),
                content: content.into(),
                purpose: "Review".into(),
                input_paths: vec![],
            }
            .stage(&root, None, &CancellationToken::new())
        };
        let target = root
            .canonical_path()
            .join("discovery/staging/brief/notes/a.md");
        stage("brief", "notes/a.md", "first").unwrap();
        let mut previous = std::fs::File::open(&target).unwrap();
        let receipt = stage("brief", "notes/a.md", "修订").unwrap();
        let mut old = String::new();
        previous.read_to_string(&mut old).unwrap();
        assert_eq!(old, "first");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "修订");
        assert_eq!(receipt.sha256, hex::encode(Sha256::digest("修订")));
        assert_eq!(
            std::fs::read_dir(target.parent().unwrap()).unwrap().count(),
            1
        );
        for (topic, path) in [
            ("", "x"),
            ("..", "x"),
            ("a/b", "x"),
            ("brief", ""),
            ("brief", "../b"),
            ("brief", "notes/../../b"),
            ("brief", "/tmp/a"),
            ("brief", "C:\\b"),
            ("brief", "..\\x"),
            ("brief", "d//x"),
        ] {
            assert!(stage(topic, path, "x").is_err(), "{topic}/{path}");
        }
        assert!(stage("brief", "notes/a.md", &"x".repeat(MAX_BYTES + 1)).is_err());
        #[cfg(unix)]
        {
            let outside = base.path().join("outside");
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(outside.join("file"), "original").unwrap();
            let staging = root.canonical_path().join("discovery/staging");
            for (link, dest, topic, path) in [
                (
                    staging.join("linked-topic"),
                    outside.clone(),
                    "linked-topic",
                    "file",
                ),
                (
                    staging.join("brief/linked-dir"),
                    outside.clone(),
                    "brief",
                    "linked-dir/file",
                ),
                (
                    staging.join("brief/linked-file"),
                    outside.join("file"),
                    "brief",
                    "linked-file",
                ),
            ] {
                std::os::unix::fs::symlink(dest, link).unwrap();
                assert!(stage(topic, path, "changed").is_err());
            }
            assert_eq!(
                std::fs::read_to_string(outside.join("file")).unwrap(),
                "original"
            );
        }
    }
}
