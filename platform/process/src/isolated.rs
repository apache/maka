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
#[cfg(unix)]
mod fs;
#[cfg(windows)]
#[path = "isolated/fs/windows.rs"]
mod fs;
pub use evidence::{
    CleanupEvidence, ClosedEvidence, EvidenceInterest, EvidenceWatch, cleanup_evidence,
    closed_evidence,
};
mod home;
pub use home::{FrozenHome, HomeCapture, HomeEntries, HomeEntry, HomeEntryKind};
mod helper;
mod os;
pub(crate) use helper::ExternalOwner;
pub use os::SandboxRuntime;
mod session;
mod snapshot;
pub use session::SessionSpool;

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
pub const PROBE: &str = "--probe";
#[cfg(windows)]
pub use helper::run_snapshot;

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
    directory: Option<std::fs::File>,
    #[cfg(unix)]
    material: LaunchMaterial,
    #[cfg(windows)]
    material: Option<std::fs::File>,
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
    #[cfg(windows)]
    fn write_inputs(&mut self, receipt: &[u8], manifest: &[u8]) -> io::Result<()> {
        use std::io::Write;
        let resource = evidence::open_resource(&self._owner.resource)?;
        let owner = fs::directory(&resource, "owner".as_ref())?;
        let mut file = fs::create(&owner, "task.json".as_ref())?;
        file.write_all(receipt)?;
        file.sync_all()?;
        let directory = fs::directory(&resource, "launch".as_ref())?;
        let file = fs::create(&directory, "material.json".as_ref())?;
        self.directory = Some(directory);
        let material = self.material.insert(file);
        material.write_all(manifest)?;
        material.sync_all()
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
    #[cfg(windows)]
    fn remove_material(&mut self) -> io::Result<()> {
        let Some(directory) = &self.directory else {
            return Ok(());
        };
        if let Some(file) = &self.material {
            let current = evidence::open_regular(directory, "material.json")?;
            if fs::identity(&current)? != fs::identity(file)? {
                return Err(io::Error::other(
                    "launch material differs from original file",
                ));
            }
            fs::mark_deleted(file)?;
            drop(current);
            drop(self.material.take());
        }
        if evidence::open_optional(directory, "material.json")?.is_some() {
            return Err(io::Error::other("launch material deletion unconfirmed"));
        }
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
    #[cfg(windows)]
    state_root: PathBuf,
    helper_executable: PathBuf,
    read_ceiling: Policy,
    bound_command: Option<BoundCommand>,
    home_capture: Option<HomeCapture>,
    home_seed: home::SeedState,
    snapshot: Option<SnapshotProof>,
    live_workspace: Option<PathBuf>,
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
        args: Vec<crate::command::Argument>,
        environment: Vec<(OsString, OsString)>,
        sandbox: Sandbox,
        size: Option<maka_plugin_core::terminal::TerminalSize>,
        #[serde(default)]
        cwd: Option<PathBuf>,
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
    SessionClosed {
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
            Self::NeverLaunched { .. } | Self::SessionClosed { .. } => true,
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
        })
        .await
        .map_err(io::Error::other)?
        .map_err(Error::Io)
    }
}

impl TaskOwner {
    pub fn helper_executable(&self) -> &Path {
        &self.helper_executable
    }

    /// Record the executable before passing the original Run to a shared protocol owner.
    pub async fn prepare_session(&self, executable: PathBuf) -> Result<Descriptor, Error> {
        if self.live_workspace.is_none() || self.cancellation.is_cancelled() {
            return Err(Error::IsolationUnavailable(
                "shared session requires an admitted live workspace".into(),
            ));
        }
        write_json_new(
            &self.resource.join("owner/task.json"),
            &TaskReceipt::Task {
                executable,
                terminal_size: None,
            },
        )
        .await?;
        Ok(self.descriptor())
    }

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
        runtime: &SandboxRuntime,
        cancellation: CancellationToken,
    ) -> Result<Self, Error> {
        Self::prepare_owner(
            source,
            state_root,
            helper_executable,
            actual,
            Some(privacy),
            runtime,
            cancellation,
        )
        .await
    }

    /// Native CLI consent authorizes the original workspace and account.
    /// Keep the launch and output collection under the helper's ownership.
    pub async fn prepare_live(
        source: &Path,
        state_root: &Path,
        helper_executable: &Path,
        cancellation: CancellationToken,
    ) -> Result<Self, Error> {
        Self::prepare_owner(
            source,
            state_root,
            helper_executable,
            &Sandbox::Disabled,
            None,
            &SandboxRuntime::default(),
            cancellation,
        )
        .await
    }

    async fn prepare_owner(
        source: &Path,
        state_root: &Path,
        helper_executable: &Path,
        actual: &Sandbox,
        privacy: Option<&Policy>,
        runtime: &SandboxRuntime,
        cancellation: CancellationToken,
    ) -> Result<Self, Error> {
        if !os::SUPPORTED {
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
        let source = os::canonical(source).await?;
        let state_root = os::canonical(state_root).await?;
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
        let namespace = tokio::task::spawn_blocking(maka_sandbox::native_task_namespace)
            .await
            .map_err(io::Error::other)??;
        if (privacy.is_some() && namespace.starts_with(&source))
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
        let reads = privacy
            .map(|privacy| {
                Ok::<_, Error>(
                    read_ceiling
                        .compile()
                        .map_err(sandbox_error)?
                        .intersect(&privacy.compile().map_err(sandbox_error)?)
                        .map_err(sandbox_error)?
                        .policy()
                        .clone(),
                )
            })
            .transpose()?;
        let helper_path = helper_executable.clone();
        let helper_ceiling = read_ceiling.clone();
        let helper_executable = tokio::task::spawn_blocking(move || {
            selected_executable(&helper_path, &helper_ceiling, &Sandbox::Disabled, None)
                .map(|(path, _)| path)
        })
        .await
        .map_err(io::Error::other)??;
        if privacy.is_some() {
            let probe = Sandbox::Managed {
                filesystem: read_ceiling.clone(),
                network: Network::Denied,
            };
            let mut command = Command::new(&helper_executable, &source);
            command.env_clear().arg(HELPER).arg(PROBE);
            let mut diagnostics = Vec::new();
            let status = run_sandboxed_helper(
                runtime.apply(command.sandbox(&probe).map_err(sandbox_error)?),
                &cancellation,
                &mut diagnostics,
            )
            .await?;
            if !status.success() {
                return Err(Error::IsolationUnavailable(format!(
                    "OS sandbox probe failed: {status}: {}",
                    String::from_utf8_lossy(&diagnostics).trim(),
                )));
            }
        }
        let resource = tokio::task::spawn_blocking(move || -> io::Result<PathBuf> {
            #[cfg(unix)]
            let path = {
                let builder = std::fs::DirBuilder::new();
                #[cfg(unix)]
                let builder = {
                    use std::os::unix::fs::DirBuilderExt;
                    let mut builder = builder;
                    builder.mode(0o700);
                    builder
                };
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
                path
            };
            #[cfg(windows)]
            let path = fs::create_resource(&namespace)?;
            Ok(path)
        })
        .await
        .map_err(io::Error::other)??;
        let resource = os::canonical(&resource).await?;
        if (privacy.is_some() && resource.starts_with(&source)) || resource.starts_with(&state_root)
        {
            return Err(Error::IsolationUnavailable(
                "private task directory overlaps protected source or Root".into(),
            ));
        }
        let (snapshot, sandbox) = if let Some(reads) = reads {
            let mut copy_policy = reads.clone();
            // These metadata/copy exceptions belong only to trusted private custody,
            // never to the source read ceiling recorded in SnapshotProof.
            let namespace = resource.parent().expect("task resource has a namespace");
            os::allow_traversal(&mut copy_policy, namespace);
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
            #[cfg(windows)]
            let stderr = {
                let path = resource.clone();
                let file = tokio::task::spawn_blocking(move || {
                    let owner = evidence::pin(&path)?.owner;
                    fs::create(&owner, "snapshot.json".as_ref())?;
                    fs::create(&owner, "snapshot.stderr".as_ref())
                })
                .await
                .map_err(io::Error::other)??;
                tokio::fs::File::from_std(file)
            };
            let mut copy = Command::new(&helper_executable, &source);
            copy.env_clear().arg(HELPER);
            #[cfg(windows)]
            copy.arg("--snapshot");
            copy.arg(&resource);
            #[cfg(unix)]
            let stderr = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(resource.join("owner/snapshot.stderr"))
                .await?;
            let status = run_sandboxed_helper(
                runtime.apply(copy.sandbox(&copy_sandbox).map_err(sandbox_error)?),
                &cancellation,
                stderr,
            )
            .await?;
            #[cfg(windows)]
            if status.code() == Some(helper::SNAPSHOT_UNSTABLE) {
                let path = resource.clone();
                let changed = tokio::task::spawn_blocking(move || {
                    evidence::read_json(evidence::open_regular(
                        &evidence::pin(&path)?.owner,
                        "snapshot.json",
                    )?)
                })
                .await
                .map_err(io::Error::other)??;
                return Err(Error::CaptureUnstable(changed));
            }
            if !status.success() {
                return Err(Error::IsolationUnavailable(format!(
                    "authorized workspace snapshot failed: {status}; evidence {}",
                    resource.display()
                )));
            }
            let path = resource.clone();
            let snapshot: SnapshotProof = tokio::task::spawn_blocking(move || {
                evidence::read_json(evidence::open_regular(
                    &evidence::pin(&path)?.owner,
                    "snapshot.json",
                )?)
            })
            .await
            .map_err(io::Error::other)??;
            let mut execution = reads;
            os::allow_traversal(&mut execution, namespace);
            // Remove all original writes. Only these independently owned directories
            // may be changed; equal-path or nested source grants cannot reopen them.
            execution.rules.push(Rule::subtree(&resource, Access::Deny));
            os::allow_traversal(&mut execution, &resource);
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
            (Some(snapshot), sandbox)
        } else {
            write_json_new(
                &resource.join("owner/snapshot.json"),
                &Option::<SnapshotProof>::None,
            )
            .await?;
            (None, Sandbox::Disabled)
        };
        let home_capture = if snapshot.is_some() {
            let home_resource = resource.clone();
            Some(
                tokio::task::spawn_blocking(move || HomeCapture::from_resource(&home_resource))
                    .await
                    .map_err(io::Error::other)??,
            )
        } else {
            None
        };
        Ok(Self {
            resource,
            #[cfg(windows)]
            state_root,
            helper_executable,
            read_ceiling,
            bound_command: None,
            home_capture,
            home_seed: home::SeedState::Fresh,
            snapshot,
            live_workspace: privacy.is_none().then_some(source),
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
        #[cfg(unix)]
        let search_path = selected
            .environment
            .get(std::ffi::OsStr::new("PATH"))
            .cloned()
            .or_else(|| std::env::var_os("PATH"));
        #[cfg(windows)]
        let search_path = selected
            .environment
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
            .map(|(_, v)| v.clone());
        let workspace = self.workspace();
        let source = self.snapshot.as_ref().map_or_else(
            || workspace.clone(),
            |snapshot| snapshot.source().to_owned(),
        );
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
        self.live_workspace
            .clone()
            .unwrap_or_else(|| self.resource.join("workspace"))
    }

    /// Retain original HOME custody before consuming this owner in spawn.
    pub fn home_capture(&self) -> Option<&HomeCapture> {
        self.home_capture.as_ref()
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
    pub fn descriptor(&self) -> Descriptor {
        Descriptor {
            resource_ref: self.resource.clone(),
        }
    }
    pub fn snapshot(&self) -> Option<&SnapshotProof> {
        self.snapshot.as_ref()
    }

    /// Capture only this live owner's original immutable baseline. This cannot
    /// be reconstructed from a descriptor or used to launch/control a task.
    pub async fn baseline_reader(&self) -> Result<BaselineReader, Error> {
        let resource = self.resource.clone();
        let proof = self
            .snapshot
            .clone()
            .ok_or_else(|| io::Error::other("live task has no baseline"))?;
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
        if self.live_workspace.is_none() {
            let home = self.home();
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
                command.env(key, path);
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
                command.remove_env(std::ffi::OsStr::new(key));
            }
        } else {
            // The process uses the account profile and task-private temporary files.
            for key in ["TMPDIR", "TMP", "TEMP"] {
                command.env(key, self.tmp());
            }
        }
        let receipt = TaskReceipt::Task {
            executable: command.executable.clone(),
            terminal_size: size,
        };
        let manifest = Manifest::Task {
            executable: command.executable,
            args: command.args,
            environment: command.environment.into_iter().collect(),
            sandbox,
            size,
            cwd: self.live_workspace.clone(),
        };
        // Protocol evidence must not become a credential/configuration store.
        // Argv can contain secrets too, so retain neither argv nor environment.
        let receipt = serde_json::to_vec(&receipt)
            .map_err(|error| SpawnError::Closed(Error::Io(io::Error::other(error))))?;
        let manifest = serde_json::to_vec(&manifest)
            .map_err(|error| SpawnError::Closed(Error::Io(io::Error::other(error))))?;
        // The helper owns its spool and uses relative socket names. Only the
        // actual CLI changes into the live workspace via the manifest.
        let mut launch = Command::new(&self.helper_executable, self.resource.join("workspace"));
        launch.env_clear().arg(HELPER).arg(&self.resource);
        #[cfg(windows)]
        launch.arg("--root").arg(&self.state_root);
        os::set_helper_namespace(&mut launch, &self.resource);
        os::private_stdio(&mut launch);
        launch.external_owner = Some(self.resource.clone());
        // The worker and failed result share one custody so a worker panic cannot discard it.
        let custody = std::sync::Arc::new(std::sync::Mutex::new(SpawnCustody {
            _owner: self,
            directory: None,
            #[cfg(unix)]
            material: LaunchMaterial::NotCreated,
            #[cfg(windows)]
            material: None,
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

#[cfg(windows)]
fn configured_executable(
    path: &Path,
    search: Option<&std::ffi::OsStr>,
    workspace: &Path,
) -> io::Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path.into());
    }
    if path.components().count() != 1 {
        return Ok(workspace.join(path));
    }
    for directory in std::env::split_paths(search.unwrap_or_default()).filter(|p| p.is_absolute()) {
        let mut candidate = directory.join(path);
        if candidate.extension().is_none() {
            candidate.set_extension("exe");
        }
        match candidate.metadata() {
            Ok(meta) if meta.is_file() => return Ok(candidate),
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "selected executable is absent from captured PATH",
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
    let canonical = dunce::canonicalize(path)?;
    let path = dunce::simplified(path);
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
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&canonical)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if file.metadata()?.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(Error::IsolationUnavailable(
                "selected executable is a reparse point".into(),
            ));
        }
    }
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

async fn run_sandboxed_helper(
    mut command: Command,
    cancellation: &CancellationToken,
    mut diagnostics: impl tokio::io::AsyncWrite + Unpin,
) -> Result<std::process::ExitStatus, Error> {
    use tokio::io::AsyncWriteExt;
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    os::private_stdio(&mut command);
    let crate::pipe::Spawned {
        mut child,
        stdin,
        mut stdout,
        mut stderr,
    } = crate::pipe::spawn(command)
        .await
        .map_err(io::Error::other)?;
    drop(stdin);
    let output = async move {
        let mut discarded = tokio::io::sink();
        tokio::try_join!(
            tokio::io::copy(&mut stdout, &mut discarded),
            tokio::io::copy(&mut stderr, &mut diagnostics),
        )?;
        diagnostics.flush().await
    };
    let wait = async {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                child.terminate().await?;
                child.wait().await?;
                Ok(None)
            }
            status = child.wait() => status.map(Some),
        }
    };
    let (status, output) = tokio::join!(wait, output);
    let status = status?;
    output?;
    status.ok_or(Error::Cancelled)
}
async fn write_json_new(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    #[cfg(windows)]
    {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            let owner = path.parent().expect("owner file");
            let pinned = evidence::pin(owner.parent().expect("task resource"))?;
            let mut file = fs::create(&pinned.owner, path.file_name().expect("owner file name"))?;
            file.write_all(&bytes)?;
            file.sync_all()
        })
        .await
        .map_err(io::Error::other)?
    }
    #[cfg(unix)]
    {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .await?;
        file.write_all(&bytes).await?;
        file.sync_all().await
    }
}

#[cfg(unix)]
fn publish_proof(resource: &Path, name: &str, value: &impl Serialize) -> io::Result<()> {
    use rustix::fs::{AtFlags, Mode, OFlags, openat, unlinkat};
    use std::io::Write;
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
            fs::rename_noreplace(owner, &pending, name)
        })();
        if written.is_err() {
            let _ = unlinkat(owner, pending.as_str(), AtFlags::empty());
        }
        written?;
    }
    owner.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn publish_proof(resource: &Path, name: &str, value: &impl Serialize) -> io::Result<()> {
    use std::io::Read;
    let owner = evidence::pin(resource)?.owner;
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if let Some(mut file) = evidence::open_optional(&owner, name)? {
        let mut original = Vec::new();
        file.read_to_end(&mut original)?;
        if original != bytes {
            return Err(io::Error::other("original immutable evidence differs"));
        }
        return Ok(());
    }
    fs::publish(&owner, name, &bytes)
}

#[cfg(all(test, windows))]
mod windows_tests;
