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

//! One private workspace and one external owner for an admitted native task.
//! Descriptors locate evidence; they never authorize restart or publication.

mod baseline;
pub use baseline::{BaselineEntry, BaselineReader};
mod candidate;
pub use candidate::{CandidateCapture, FrozenCandidate};
mod evidence;
pub use evidence::{
    CleanupEvidence, ClosedEvidence, EvidenceInterest, EvidenceWatch, cleanup_evidence,
    closed_evidence,
};
mod home;
pub use home::{FrozenHome, HomeCapture, HomeEntries, HomeEntry, HomeEntryKind};
mod helper;
#[cfg(unix)]
pub mod step_annotations;
#[cfg(unix)]
pub(crate) use helper::ExternalOwner;
mod snapshot;

use crate::Command;
pub use helper::run_helper;
use maka_sandbox::{
    Network, Sandbox,
    filesystem::{Access, Policy, Rule},
};
use serde::{Deserialize, Serialize};
pub use snapshot::{FileIdentity, SnapshotFile, SnapshotKind, SnapshotProof};
use std::{
    ffi::OsString,
    io,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

pub const HELPER: &str = "--maka-isolated-task-helper";

const INITIAL_HOME_DIRECTORIES: &[&str] = &[
    ".codex",
    ".claude",
    ".config",
    ".cache",
    ".local",
    ".local/share",
    ".local/state",
];

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("isolated task isolation unavailable: {0}")]
    IsolationUnavailable(String),
    #[error("candidate capture observed a structural change at {0:?}")]
    CaptureUnstable(PathBuf),
    #[error("candidate capture unsupported: {0}")]
    CaptureUnsupported(String),
    #[error("isolated task cancelled before launch")]
    Cancelled,
    #[error("isolated task: {0}")]
    Io(#[from] io::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("{0}")]
    Closed(Error),
    #[error("{0}")]
    Unconfirmed(FailedSpawn),
}

/// Consumed launch custody, never permission to retry a launch.
pub struct FailedSpawn {
    cause: Error,
    cleanup: Option<io::Error>,
    _custody: std::sync::Arc<std::sync::Mutex<SpawnCustody>>,
}
impl std::fmt::Display for FailedSpawn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.cause, f)?;
        if let Some(error) = &self.cleanup {
            write!(f, "; launch material cleanup unconfirmed: {error}")?;
        }
        Ok(())
    }
}
impl std::fmt::Debug for FailedSpawn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for FailedSpawn {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}

struct SpawnCustody {
    _owner: TaskOwner,
    #[cfg(unix)]
    directory: Option<std::fs::File>,
    #[cfg(unix)]
    material: LaunchMaterial,
}
#[cfg(unix)]
enum LaunchMaterial {
    NotCreated,
    Present(std::fs::File),
    Unlinked(std::fs::File),
}
impl SpawnCustody {
    #[cfg(unix)]
    fn write_inputs(&mut self, receipt: &[u8], manifest: &[u8]) -> io::Result<()> {
        use rustix::fs::{Mode, OFlags, openat};
        use std::io::Write;
        let resource = evidence::open_resource(&self._owner.resource)?;
        let dirs = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let owner: std::fs::File = openat(&resource, "owner", dirs, Mode::empty())?.into();
        let flags =
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mode = Mode::RUSR | Mode::WUSR;
        {
            let mut file: std::fs::File = openat(&owner, "task.json", flags, mode)?.into();
            file.write_all(receipt)?;
            file.sync_all()?;
        }
        owner.sync_all()?;
        let directory: std::fs::File = openat(&resource, "launch", dirs, Mode::empty())?.into();
        self.directory = Some(directory);
        let directory = self.directory.as_ref().expect("original launch directory");
        let file: std::fs::File = openat(directory, "material.json", flags, mode)?.into();
        self.material = LaunchMaterial::Present(file);
        let LaunchMaterial::Present(file) = &mut self.material else {
            unreachable!()
        };
        file.write_all(manifest)?;
        file.sync_all()?;
        directory.sync_all()
    }
    #[cfg(not(unix))]
    fn write_inputs(&mut self, _: &[u8], _: &[u8]) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "private task launch unavailable",
        ))
    }
    #[cfg(unix)]
    fn remove_material(&mut self) -> io::Result<()> {
        use rustix::fs::{AtFlags, unlinkat};
        match &self.material {
            LaunchMaterial::NotCreated => return Ok(()),
            LaunchMaterial::Present(file) => {
                let directory = self.directory.as_ref().expect("original launch directory");
                let current = evidence::open_regular(directory, "material.json")?;
                if snapshot::identity(&current.metadata()?) != snapshot::identity(&file.metadata()?)
                {
                    return Err(io::Error::other(
                        "launch material differs from original file",
                    ));
                }
                // Before helper spawn, only this consumed owner can mutate this private entry.
                unlinkat(directory, "material.json", AtFlags::empty())?;
            }
            LaunchMaterial::Unlinked(_) => {}
        }
        self.material = match std::mem::replace(&mut self.material, LaunchMaterial::NotCreated) {
            LaunchMaterial::Present(file) | LaunchMaterial::Unlinked(file) => {
                LaunchMaterial::Unlinked(file)
            }
            LaunchMaterial::NotCreated => unreachable!("original material held"),
        };
        self.directory
            .as_ref()
            .expect("original launch directory")
            .sync_all()?;
        self.material = LaunchMaterial::NotCreated;
        Ok(())
    }
    #[cfg(not(unix))]
    fn remove_material(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(unix)]
impl From<rustix::io::Errno> for Error {
    fn from(error: rustix::io::Errno) -> Self {
        Self::Io(error.into())
    }
}

/// An evidence address, not a process handle, lease or authority to publish.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub resource_ref: PathBuf,
}

/// Non-serializable, single-use launch custody for one admitted private process.
/// Dropping it preserves candidates; it cannot publish anything to the source.
pub struct TaskOwner {
    resource: PathBuf,
    helper_executable: PathBuf,
    read_ceiling: Policy,
    bound_command: Option<BoundCommand>,
    home_capture: HomeCapture,
    home_seed: home::SeedState,
    #[cfg(target_os = "macos")]
    account_home: Option<PathBuf>,
    step_annotation_hook: Option<PathBuf>,
    snapshot: SnapshotProof,
    sandbox: Sandbox,
    cancellation: CancellationToken,
}

struct BoundCommand {
    identity: std::sync::Arc<()>,
    executable: PathBuf,
    _file: std::fs::File,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Manifest {
    Snapshot {
        source: PathBuf,
        policy: Policy,
    },
    Task {
        executable: PathBuf,
        args: Vec<OsString>,
        environment: Vec<(OsString, OsString)>,
        sandbox: Sandbox,
        size: Option<maka_plugin_core::terminal::TerminalSize>,
        #[serde(default)]
        step_annotation_hook: Option<PathBuf>,
    },
}

/// Safe launch identity, never argv, credentials or restart material.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskReceipt {
    Task {
        executable: PathBuf,
        #[serde(rename = "terminalSize")]
        terminal_size: Option<maka_plugin_core::terminal::TerminalSize>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Started {
    helper_pid: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChildExited {
    resource: PathBuf,
    snapshot: FileIdentity,
}

/// An OS/process closure only. Native business completion is a separate protocol fact.
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Closure {
    NeverLaunched {
        resource: PathBuf,
        snapshot: FileIdentity,
    },
    GroupClosed {
        resource: PathBuf,
        snapshot: FileIdentity,
        exit_code: Option<i32>,
        signal: Option<i32>,
        original_group_closed: bool,
        streams_drained: bool,
    },
}
impl Closure {
    fn is_closed(&self) -> bool {
        match self {
            Self::NeverLaunched { .. } => true,
            Self::GroupClosed {
                original_group_closed,
                streams_drained,
                ..
            } => *original_group_closed && *streams_drained,
        }
    }
}

/// Consumes launch custody before a durable no-launch observation can be made.
/// This object has no spawn/control methods and retains the original material on I/O failure.
pub struct NoLaunchSeal {
    owner: TaskOwner,
    recording: tokio::sync::Mutex<()>,
    snapshot: std::sync::Arc<std::sync::OnceLock<FileIdentity>>,
}
impl NoLaunchSeal {
    pub async fn record(&self) -> Result<(), Error> {
        let _recording = self.recording.lock().await;
        let resource = self.owner.resource.clone();
        let frozen = self.snapshot.clone();
        tokio::task::spawn_blocking(move || {
            #[cfg(target_os = "macos")]
            {
                let pinned = evidence::pin(&resource)?;
                if frozen.get().is_none() {
                    let _ = frozen.set(evidence::snapshot_identity(&pinned.owner)?);
                }
                let snapshot = *frozen.get().expect("original frozen snapshot identity");
                publish_proof(
                    &resource,
                    "closure.json",
                    &Closure::NeverLaunched {
                        resource: resource.clone(),
                        snapshot,
                    },
                )
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (resource, frozen);
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "native no-launch proof unavailable",
                ))
            }
        })
        .await
        .map_err(io::Error::other)?
        .map_err(Error::Io)
    }
}

impl TaskOwner {
    pub fn into_no_launch_seal(self) -> NoLaunchSeal {
        NoLaunchSeal {
            owner: self,
            recording: tokio::sync::Mutex::new(()),
            snapshot: std::sync::Arc::default(),
        }
    }
    /// Trusted startup selects this Maka CLI helper once; snapshot and launch
    /// retain the same selection. It is never inferred from the current process.
    pub async fn prepare(
        source: &Path,
        state_root: &Path,
        helper_executable: &Path,
        actual: &Sandbox,
        privacy: &Policy,
        cancellation: CancellationToken,
    ) -> Result<Self, Error> {
        if !cfg!(target_os = "macos") {
            return Err(Error::IsolationUnavailable(
                "this platform has no proven persistent native task boundary".into(),
            ));
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if !helper_executable.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "isolated task helper must be an absolute trusted launch executable",
            )
            .into());
        }
        let helper_executable = helper_executable.to_owned();
        let source = tokio::fs::canonicalize(source).await?;
        let state_root = tokio::fs::canonicalize(state_root).await?;
        let mut reads = match actual {
            Sandbox::Managed { filesystem, .. } => filesystem.clone(),
            Sandbox::Disabled => Policy::uniform(Access::Read),
            Sandbox::External { .. } => {
                return Err(Error::IsolationUnavailable(
                    "cannot capture an external read ceiling locally".into(),
                ));
            }
        };
        for rule in &mut reads.rules {
            rule.access = rule.access.intersect(Access::Read);
        }
        reads.default = reads.default.intersect(Access::Read);
        // StateRoot is never a source for a private task, even in full access mode.
        reads.deny_globs.push(literal_glob(&state_root)?);
        reads.compile().map_err(sandbox_error)?;
        let probe = Sandbox::Managed {
            filesystem: reads.clone(),
            network: Network::Denied,
        };
        // Execute the real wrapper before copying a byte or starting any CLI.
        let status = launch_snapshot_command(Path::new("/usr/bin/true"), &source, &probe, &[])?
            .status()
            .await?;
        if !status.success() {
            return Err(Error::IsolationUnavailable(format!(
                "OS sandbox probe failed: {status}"
            )));
        }
        let namespace = tokio::task::spawn_blocking(maka_sandbox::native_task_namespace)
            .await
            .map_err(io::Error::other)??;
        if namespace.starts_with(&source)
            || source.starts_with(&namespace)
            || namespace.starts_with(&state_root)
        {
            return Err(Error::IsolationUnavailable(
                "private task namespace overlaps source or StateRoot".into(),
            ));
        }
        // Sibling jobs must not read one another's bearer-bearing inputs or
        // protocol spool, regardless of the user's ordinary read preset.
        reads
            .rules
            .retain(|rule| !rule.path.starts_with(&namespace));
        reads.rules.push(Rule::subtree(&namespace, Access::Deny));
        let read_ceiling = reads;
        let reads = read_ceiling
            .compile()
            .map_err(sandbox_error)?
            .intersect(&privacy.compile().map_err(sandbox_error)?)
            .map_err(sandbox_error)?
            .policy()
            .clone();
        let helper_path = helper_executable.clone();
        let helper_ceiling = read_ceiling.clone();
        let helper_executable = tokio::task::spawn_blocking(move || {
            selected_executable(&helper_path, &helper_ceiling, &Sandbox::Disabled, None)
                .map(|(path, _)| path)
        })
        .await
        .map_err(io::Error::other)??;
        let resource = tokio::task::spawn_blocking(move || -> io::Result<PathBuf> {
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&namespace) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    let metadata = std::fs::symlink_metadata(&namespace)?;
                    if !metadata.is_dir() || metadata.file_type().is_symlink() {
                        return Err(io::Error::other(
                            "private task namespace is not an owned directory",
                        ));
                    }
                }
                Err(e) => return Err(e),
            }
            let path = tempfile::Builder::new()
                .prefix("maka-native-task-")
                .tempdir_in(&namespace)?
                .keep();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
            }
            for child in [
                "workspace",
                "baseline",
                "home",
                "tmp",
                "owner",
                "launch",
                "inputs",
            ] {
                std::fs::create_dir_all(path.join(child))?;
            }
            for directory in INITIAL_HOME_DIRECTORIES {
                std::fs::create_dir_all(path.join("home").join(directory))?;
            }
            Ok(path)
        })
        .await
        .map_err(io::Error::other)??;
        let resource = tokio::fs::canonicalize(resource).await?;
        if resource.starts_with(&source) || resource.starts_with(&state_root) {
            return Err(Error::IsolationUnavailable(
                "private task directory overlaps protected source or Root".into(),
            ));
        }
        let mut copy_policy = reads.clone();
        // These metadata/copy exceptions belong only to trusted private custody,
        // never to the source read ceiling recorded in SnapshotProof.
        copy_policy.rules.push(Rule::exact(
            resource
                .parent()
                .ok_or_else(|| io::Error::other("private namespace"))?,
            Access::Read,
        ));
        copy_policy
            .rules
            .push(Rule::subtree(&resource, Access::Write));
        // The trusted copier may load its actual helper, not expand the
        // snapshot's source read policy or any caller denial.
        copy_policy
            .rules
            .push(Rule::exact(&helper_executable, Access::Read));
        let copy_sandbox = Sandbox::Managed {
            filesystem: copy_policy,
            network: Network::Denied,
        };
        write_json_new(
            &resource.join("owner/manifest.json"),
            &Manifest::Snapshot {
                source: source.clone(),
                policy: reads.clone(),
            },
        )
        .await?;
        let args = [OsString::from(HELPER), resource.clone().into_os_string()];
        let mut copy = launch_snapshot_command(&helper_executable, &source, &copy_sandbox, &args)?;
        let stderr = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(resource.join("owner/snapshot.stderr"))
            .await?
            .into_std()
            .await;
        copy.stderr(std::process::Stdio::from(stderr));
        copy.kill_on_drop(true);
        let mut child = copy.spawn()?;
        let status = tokio::select! {
            result = child.wait() => result?,
            _ = cancellation.cancelled() => { child.kill().await?; return Err(Error::Cancelled); }
        };
        if !status.success() {
            return Err(Error::IsolationUnavailable(format!(
                "authorized workspace snapshot failed: {status}; evidence {}",
                resource.display()
            )));
        }
        let snapshot: SnapshotProof =
            serde_json::from_slice(&tokio::fs::read(resource.join("owner/snapshot.json")).await?)
                .map_err(io::Error::other)?;
        let mut execution = reads;
        execution.rules.push(Rule::exact(
            resource
                .parent()
                .ok_or_else(|| io::Error::other("private namespace"))?,
            Access::Read,
        ));
        // Remove all original writes. Only these independently owned directories
        // may be changed; equal-path or nested source grants cannot reopen them.
        execution.rules.push(Rule::subtree(&resource, Access::Deny));
        execution.rules.push(Rule::exact(&resource, Access::Read));
        for child in ["workspace", "home", "tmp"] {
            execution
                .rules
                .push(Rule::subtree(resource.join(child), Access::Write));
        }
        execution
            .rules
            .push(Rule::subtree(resource.join("inputs"), Access::Read));
        execution
            .deny_globs
            .push(literal_glob(&resource.join("owner"))?);
        execution
            .deny_globs
            .push(literal_glob(&resource.join("launch"))?);
        execution
            .deny_globs
            .push(literal_glob(&resource.join("baseline"))?);
        let network = match actual {
            Sandbox::Managed { network, .. } => network.clone(),
            _ => Network::Allowed,
        };
        let sandbox = Sandbox::Managed {
            filesystem: execution,
            network,
        };
        // Validate the filesystem compiler now. Restricted network preparation
        // itself belongs to the helper that will retain the live gateway.
        if let Sandbox::Managed { filesystem, .. } = &sandbox {
            filesystem.compile().map_err(sandbox_error)?;
        }
        let home_resource = resource.clone();
        let home_capture =
            tokio::task::spawn_blocking(move || HomeCapture::from_resource(&home_resource))
                .await
                .map_err(io::Error::other)??;
        Ok(Self {
            resource,
            helper_executable,
            read_ceiling,
            bound_command: None,
            home_capture,
            home_seed: home::SeedState::Fresh,
            #[cfg(target_os = "macos")]
            account_home: None,
            step_annotation_hook: None,
            snapshot,
            sandbox,
            cancellation,
        })
    }

    /// Root validates the original trusted binding/config selection first.
    /// Native validation runs off-executor; only this unlaunched owner's code load is narrowed.
    /// Snapshot bytes/proof and caller ceilings are never changed or recaptured.
    pub async fn bind_command(
        &mut self,
        selected: &Command,
        current_caller: &Sandbox,
    ) -> Result<(), Error> {
        if self.bound_command.is_some() {
            return Err(Error::IsolationUnavailable(
                "private owner already bound to its original command".into(),
            ));
        }
        let identity = selected
            .selection
            .get_or_init(|| std::sync::Arc::new(()))
            .clone();
        let path = selected.executable().to_owned();
        let search_path = selected
            .environment
            .get(std::ffi::OsStr::new("PATH"))
            .cloned()
            .or_else(|| std::env::var_os("PATH"));
        let workspace = self.workspace();
        let source = self.snapshot.source().to_owned();
        let original = self.read_ceiling.clone();
        let current = current_caller.clone();
        let (executable, file) = tokio::task::spawn_blocking(move || {
            let path = configured_executable(&path, search_path.as_deref(), &workspace)?;
            selected_executable(&path, &original, &current, Some((&workspace, &source)))
        })
        .await
        .map_err(io::Error::other)??;
        let Sandbox::Managed { filesystem, .. } = &mut self.sandbox else {
            return Err(Error::IsolationUnavailable(
                "private execution profile is unavailable".into(),
            ));
        };
        // The owner's existing private-workspace grant needs no namespace
        // exception. Code outside it gets only the selected-file load rule.
        if !filesystem
            .compile()
            .map_err(sandbox_error)?
            .access(&executable)
            .can_read()
        {
            filesystem
                .rules
                .push(Rule::exact(&executable, Access::Read));
            filesystem.compile().map_err(sandbox_error)?;
        }
        self.bound_command = Some(BoundCommand {
            identity,
            executable,
            _file: file,
        });
        Ok(())
    }

    pub fn workspace(&self) -> PathBuf {
        self.resource.join("workspace")
    }

    /// Some native CLIs look up OS credentials in the current account's HOME.
    /// Only the CLI's profile directory may be written outside the task.
    #[cfg(target_os = "macos")]
    pub async fn use_account_profile(&mut self, directory: &str) -> Result<(), Error> {
        let source = self.snapshot.source().to_owned();
        let directory = PathBuf::from(directory);
        let (home, profile) = tokio::task::spawn_blocking(move || {
            let home = maka_sandbox::account_home()?.canonicalize()?;
            let profile = home.join(directory);
            if profile.canonicalize()? != profile
                || profile == home
                || !profile.starts_with(&home)
                || !profile.is_dir()
                || profile.starts_with(&source)
                || source.starts_with(&profile)
            {
                return Err(Error::IsolationUnavailable(
                    "native CLI profile overlaps the workspace or leaves the account home".into(),
                ));
            }
            Ok::<_, Error>((home, profile))
        })
        .await
        .map_err(io::Error::other)??;
        let Sandbox::Managed { filesystem, .. } = &mut self.sandbox else {
            return Err(Error::IsolationUnavailable(
                "private execution profile is unavailable".into(),
            ));
        };
        if !filesystem
            .compile()
            .map_err(sandbox_error)?
            .access(&profile)
            .can_read()
        {
            return Err(Error::IsolationUnavailable(
                "native CLI profile is outside the task's read ceiling".into(),
            ));
        }
        filesystem.rules.push(Rule::subtree(profile, Access::Write));
        filesystem.compile().map_err(sandbox_error)?;
        self.account_home = Some(home);
        Ok(())
    }
    /// Retain original HOME custody before consuming this owner in spawn.
    pub fn home_capture(&self) -> HomeCapture {
        self.home_capture.clone()
    }

    /// Stream a broker-authorized immutable profile into this fresh HOME.
    /// Entries must be depth-first, parent-before-child, like FrozenHome::entries,
    /// with read-only regular file backings. Native blocking I/O; failure
    /// permanently forbids launch and reseeding.
    pub fn seed_home(
        &mut self,
        entries: impl IntoIterator<Item = Result<HomeEntry, Error>>,
    ) -> Result<(), Error> {
        home::seed(self, entries)
    }

    pub fn home(&self) -> PathBuf {
        self.resource.join("home")
    }
    pub fn codex_home(&self) -> PathBuf {
        self.resource.join("home/.codex")
    }
    pub fn claude_config_dir(&self) -> PathBuf {
        self.resource.join("home/.claude")
    }
    /// Host materializes admitted inputs here; the job cannot replace parents.
    pub fn inputs(&self) -> PathBuf {
        self.resource.join("inputs")
    }
    pub fn tmp(&self) -> PathBuf {
        self.resource.join("tmp")
    }
    #[cfg(target_os = "macos")]
    pub fn record_step_annotations(&mut self, hook: &Path) -> io::Result<&Path> {
        let relative = hook.strip_prefix(self.inputs()).map_err(io::Error::other)?;
        if relative.as_os_str().is_empty()
            || !relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
        {
            return Err(io::Error::other(
                "invalid private step annotation hook path",
            ));
        }
        self.step_annotation_hook = Some(relative.to_owned());
        Ok(&self.helper_executable)
    }
    pub fn descriptor(&self) -> Descriptor {
        Descriptor {
            resource_ref: self.resource.clone(),
        }
    }
    pub fn snapshot(&self) -> &SnapshotProof {
        &self.snapshot
    }

    /// Capture only this live owner's original immutable baseline. This cannot
    /// be reconstructed from a descriptor or used to launch/control a task.
    pub async fn baseline_reader(&self) -> Result<BaselineReader, Error> {
        let resource = self.resource.clone();
        let proof = self.snapshot.clone();
        tokio::task::spawn_blocking(move || {
            BaselineReader::from_resource(&evidence::open_resource(&resource)?, proof)
        })
        .await
        .map_err(io::Error::other)?
        .map_err(Error::Io)
    }

    /// Mint custody only from this admitted live owner, never a descriptor.
    /// Performs native I/O and clones the proof; call on a blocking worker.
    pub fn candidate_capture(&self) -> Result<CandidateCapture, Error> {
        CandidateCapture::from_owner(self)
    }

    pub async fn spawn_pipe(self, command: Command) -> Result<crate::pipe::Spawned, SpawnError> {
        self.spawn(command, None).await
    }
    pub async fn spawn_pty(
        self,
        command: Command,
        size: maka_plugin_core::terminal::TerminalSize,
    ) -> Result<crate::pipe::Spawned, SpawnError> {
        self.spawn(command, Some(size)).await
    }
    async fn spawn(
        self,
        mut command: Command,
        size: Option<maka_plugin_core::terminal::TerminalSize>,
    ) -> Result<crate::pipe::Spawned, SpawnError> {
        if self.cancellation.is_cancelled() {
            return Err(SpawnError::Closed(Error::Cancelled));
        }
        if let Some(bound) = &self.bound_command {
            if selected_identity_differs(&command, &bound.identity) {
                return Err(SpawnError::Closed(Error::IsolationUnavailable(
                    "private spawn changed its original selected command".into(),
                )));
            }
            command.executable = bound.executable.clone();
        }
        if matches!(self.home_seed, home::SeedState::Failed) {
            return Err(SpawnError::Closed(Error::CaptureUnsupported(
                "private HOME seed failed; launch is forbidden".into(),
            )));
        }
        if command.network_route != maka_network::Policy::default() {
            return Err(SpawnError::Closed(Error::IsolationUnavailable(
                "a non-transferable custom network route cannot be owned by the helper".into(),
            )));
        }
        // Command is captured data, never authority. Its policy cannot override
        // the Run ceiling or the mandatory private task boundary.
        let sandbox = self
            .sandbox
            .intersect(&command.sandbox)
            .map_err(|error| SpawnError::Closed(sandbox_error(error)))?;
        let home = self.home();
        #[cfg(target_os = "macos")]
        let home = self.account_home.clone().unwrap_or(home);
        for (key, path) in [
            ("HOME", home.clone()),
            ("USERPROFILE", home),
            ("CODEX_HOME", self.codex_home()),
            ("CLAUDE_CONFIG_DIR", self.claude_config_dir()),
            ("TMPDIR", self.tmp()),
            ("TMP", self.tmp()),
            ("TEMP", self.tmp()),
            ("XDG_CONFIG_HOME", self.home().join(".config")),
            ("XDG_CACHE_HOME", self.home().join(".cache")),
            ("XDG_DATA_HOME", self.home().join(".local/share")),
            ("XDG_STATE_HOME", self.home().join(".local/state")),
        ] {
            command
                .environment
                .insert(key.into(), path.into_os_string());
        }
        for key in [
            "SSH_AUTH_SOCK",
            "SSH_AGENT_PID",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
            "CLAUDE_CODE_SSE_PORT",
            "CLAUDE_CODE_ENTRYPOINT",
            "CODEX_THREAD_ID",
            "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_INDEX_FILE",
        ] {
            command.environment.remove(std::ffi::OsStr::new(key));
        }
        let args = command
            .args
            .into_iter()
            .map(|arg| arg.as_ref().to_owned())
            .collect();
        let receipt = TaskReceipt::Task {
            executable: command.executable.clone(),
            terminal_size: size,
        };
        let manifest = Manifest::Task {
            executable: command.executable,
            args,
            environment: command.environment.into_iter().collect(),
            sandbox,
            size,
            step_annotation_hook: self.step_annotation_hook.clone(),
        };
        // Protocol evidence must not become a credential/configuration store.
        // Argv can contain secrets too, so retain neither argv nor environment.
        let receipt = serde_json::to_vec(&receipt)
            .map_err(|error| SpawnError::Closed(Error::Io(io::Error::other(error))))?;
        let manifest = serde_json::to_vec(&manifest)
            .map_err(|error| SpawnError::Closed(Error::Io(io::Error::other(error))))?;
        let mut launch = Command::new(&self.helper_executable, self.workspace());
        launch.env_clear().arg(HELPER).arg(&self.resource);
        #[cfg(target_os = "macos")]
        {
            launch.private_stdio = true;
        }
        #[cfg(unix)]
        {
            launch.external_owner = Some(self.resource.clone());
        }
        // The worker and failed result share one custody so a worker panic cannot discard it.
        let custody = std::sync::Arc::new(std::sync::Mutex::new(SpawnCustody {
            _owner: self,
            #[cfg(unix)]
            directory: None,
            #[cfg(unix)]
            material: LaunchMaterial::NotCreated,
        }));
        let work = custody.clone();
        let written = tokio::task::spawn_blocking(move || {
            let mut original = work.lock().unwrap();
            if let Err(error) = original.write_inputs(&receipt, &manifest) {
                let cause = Error::Io(error);
                return Err(match original.remove_material() {
                    Ok(()) => SpawnError::Closed(cause),
                    Err(cleanup) => SpawnError::Unconfirmed(FailedSpawn {
                        cause,
                        cleanup: Some(cleanup),
                        _custody: work.clone(),
                    }),
                });
            }
            Ok(())
        })
        .await;
        match written {
            Ok(result) => result?,
            Err(error) => {
                return Err(SpawnError::Unconfirmed(FailedSpawn {
                    cause: Error::Io(io::Error::other(error)),
                    cleanup: None,
                    _custody: custody,
                }));
            }
        }
        match crate::pipe::spawn(launch).await {
            Ok(spawned) => Ok(spawned),
            Err(error) => {
                let cause = Error::Io(io::Error::other(error.to_string()));
                let work = custody.clone();
                let cleaned =
                    tokio::task::spawn_blocking(move || work.lock().unwrap().remove_material())
                        .await;
                Err(match cleaned {
                    Ok(Ok(())) => SpawnError::Closed(cause),
                    Ok(Err(cleanup)) => SpawnError::Unconfirmed(FailedSpawn {
                        cause,
                        cleanup: Some(cleanup),
                        _custody: custody,
                    }),
                    Err(error) => SpawnError::Unconfirmed(FailedSpawn {
                        cause,
                        cleanup: Some(io::Error::other(error)),
                        _custody: custody,
                    }),
                })
            }
        }
    }
}

fn selected_identity_differs(command: &Command, original: &std::sync::Arc<()>) -> bool {
    command
        .selection
        .get()
        .is_none_or(|actual| !std::sync::Arc::ptr_eq(actual, original))
}

// Resolve exactly once using this command's captured search path and the cwd
// that TaskOwner will actually use. Scope/read validation of the first selected
// executable is terminal: a denial must never pick a different PATH candidate.
#[cfg(unix)]
fn configured_executable(
    program: &Path,
    search_path: Option<&std::ffi::OsStr>,
    workspace: &Path,
) -> io::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    if program.as_os_str().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "configured program is empty",
        ));
    }
    if program.is_absolute() {
        return Ok(program.to_owned());
    }
    if program.as_os_str().as_encoded_bytes().contains(&b'/') {
        return Ok(workspace.join(program));
    }
    let default;
    let search_path = match search_path {
        Some(path) => path,
        None => {
            default = default_search_path()?;
            &default
        }
    };
    let mut non_executable = false;
    for directory in std::env::split_paths(search_path) {
        let directory = if directory.is_absolute() {
            directory
        } else {
            workspace.join(directory)
        };
        let candidate = directory.join(program);
        let metadata = match std::fs::metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(libc::ENOTDIR) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
            non_executable = true;
            continue;
        }
        return Ok(candidate);
    }
    Err(io::Error::new(
        if non_executable {
            io::ErrorKind::PermissionDenied
        } else {
            io::ErrorKind::NotFound
        },
        "configured executable was not found in the captured PATH",
    ))
}

#[cfg(unix)]
fn default_search_path() -> io::Result<OsString> {
    use std::os::unix::ffi::OsStringExt;
    // SAFETY: the first call queries the OS execution-search default size; the
    // second receives a buffer of that exact capacity. No process is launched.
    let size = unsafe { libc::confstr(libc::_CS_PATH, std::ptr::null_mut(), 0) };
    if size == 0 {
        return Err(io::Error::other(
            "OS default executable search path is unavailable",
        ));
    }
    let mut bytes = vec![0u8; size];
    let written = unsafe { libc::confstr(libc::_CS_PATH, bytes.as_mut_ptr().cast(), bytes.len()) };
    if written != size || bytes.last() != Some(&0) {
        return Err(io::Error::other(
            "OS default executable search path changed",
        ));
    }
    bytes.pop();
    Ok(OsString::from_vec(bytes))
}

#[cfg(not(unix))]
fn configured_executable(_: &Path, _: Option<&std::ffi::OsStr>, _: &Path) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "private task executable resolution is unavailable on this platform",
    ))
}

fn selected_executable(
    path: &Path,
    original: &Policy,
    current: &Sandbox,
    private_workspace: Option<(&Path, &Path)>,
) -> Result<(PathBuf, std::fs::File), Error> {
    if !path.is_absolute() {
        return Err(Error::IsolationUnavailable(
            "selected executable must be absolute".into(),
        ));
    }
    let canonical = std::fs::canonicalize(path)?;
    let original = original.compile().map_err(sandbox_error)?;
    let current = match current {
        Sandbox::Disabled => Policy::uniform(Access::Read),
        Sandbox::Managed { filesystem, .. } => filesystem.clone(),
        Sandbox::External { .. } => {
            return Err(Error::IsolationUnavailable(
                "selected executable has no local caller ceiling".into(),
            ));
        }
    }
    .compile()
    .map_err(sandbox_error)?;
    // A program in this owner's copied workspace is checked against its
    // original source location, not a blanket exception to namespace denial.
    // Other private tasks, inputs and owner material never receive this mapping.
    let mapped = private_workspace.and_then(|(workspace, source)| {
        canonical
            .strip_prefix(workspace)
            .ok()
            .map(|relative| source.join(relative))
    });
    let spelling = if let Some(mapped) = &mapped {
        mapped.as_path()
    } else if path.components().any(|part| {
        matches!(
            part,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        canonical.as_path()
    } else {
        path
    };
    let target = mapped.as_deref().unwrap_or(canonical.as_path());
    for spelling in [spelling, target] {
        if !original.access(spelling).can_read() || !current.access(spelling).can_read() {
            return Err(Error::IsolationUnavailable(
                "selected executable is denied by the original or current caller ceiling".into(),
            ));
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let file = options.open(&canonical)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(Error::IsolationUnavailable(
            "selected executable is not an ordinary regular file".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(Error::IsolationUnavailable(
                "selected regular file is not executable".into(),
            ));
        }
    }
    Ok((canonical, file))
}

fn literal_glob(path: &Path) -> Result<String, Error> {
    let text = path
        .to_str()
        .ok_or_else(|| Error::IsolationUnavailable("non UTF-8 isolation boundary".into()))?;
    // Boundary paths are literals, not user-defined patterns.
    if text.contains(['*', '?', '[', ']', '{', '}']) {
        return Err(Error::IsolationUnavailable(
            "isolation boundary contains glob syntax".into(),
        ));
    }
    Ok(text.into())
}
fn sandbox_error(error: maka_sandbox::Error) -> Error {
    Error::IsolationUnavailable(error.to_string())
}

fn launch_snapshot_command(
    executable: &Path,
    cwd: &Path,
    sandbox: &Sandbox,
    args: &[OsString],
) -> Result<tokio::process::Command, Error> {
    let launch = sandbox.prepare(cwd).map_err(sandbox_error)?;
    let mut command = match launch {
        maka_sandbox::launch::Launch::Direct => {
            return Err(Error::IsolationUnavailable(
                "snapshot requires OS enforcement".into(),
            ));
        }
        maka_sandbox::launch::Launch::Wrapped {
            program,
            args: prefix,
            ..
        } => {
            let mut c = tokio::process::Command::new(program);
            c.args(prefix).arg(executable);
            c
        }
    };
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    Ok(command)
}
async fn write_json_new(path: &Path, value: &impl Serialize) -> io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(&bytes).await?;
    file.sync_all().await
}

#[cfg(target_os = "macos")]
fn publish_proof(resource: &Path, name: &str, value: &impl Serialize) -> io::Result<()> {
    use rustix::fs::{AtFlags, Mode, OFlags, openat, unlinkat};
    use std::io::Write;
    use std::os::fd::AsRawFd;
    let pinned = evidence::pin(resource)?;
    let owner = &pinned.owner;
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if let Some(mut existing) = evidence::open_optional(owner, name)? {
        use std::io::Read;
        let mut original = Vec::new();
        existing.read_to_end(&mut original)?;
        if original != bytes {
            return Err(io::Error::other("original immutable evidence differs"));
        }
    } else {
        let pending = format!(".{name}.pending");
        let mut file: std::fs::File = openat(
            owner,
            pending.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )?
        .into();
        let written = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            let from = std::ffi::CString::new(pending.as_str()).map_err(io::Error::other)?;
            let to = std::ffi::CString::new(name).map_err(io::Error::other)?;
            // SAFETY: both owned directory FDs are pinned for this call; the C strings
            // remain live. EXCL atomically refuses replacement of immutable evidence.
            if unsafe {
                libc::renameatx_np(
                    owner.as_raw_fd(),
                    from.as_ptr(),
                    owner.as_raw_fd(),
                    to.as_ptr(),
                    libc::RENAME_EXCL,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        })();
        if written.is_err() {
            let _ = unlinkat(owner, pending.as_str(), AtFlags::empty());
        }
        written?;
    }
    owner.sync_all()?;
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn publish_proof(_: &Path, _: &str, _: &impl Serialize) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "native physical proof unavailable",
    ))
}
