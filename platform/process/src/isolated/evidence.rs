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

use super::ChildExited;
use super::{BaselineReader, Descriptor, Error, SnapshotProof, TaskReceipt};
use super::{Closure, Started};
use std::{fs::File, io, path::PathBuf};

mod watch {
    use super::*;
    use notify::{Config, EventHandler, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use tokio::sync::mpsc as wake;

    struct Handler {
        changed: wake::Sender<()>,
        failed: Arc<AtomicBool>,
        settled: mpsc::Sender<()>,
        owner: PathBuf,
        target: PathBuf,
    }
    impl EventHandler for Handler {
        fn handle_event(&mut self, event: notify::Result<notify::Event>) {
            match event {
                Ok(event) if matches!(event.kind, EventKind::Access(_)) && !event.need_rescan() => {
                    return;
                }
                Ok(event)
                    if !event.need_rescan()
                        && !event.paths.is_empty()
                        && !event
                            .paths
                            .iter()
                            .any(|path| path == &self.target || path == &self.owner) =>
                {
                    return;
                }
                Err(_) => {
                    self.failed.store(true, Ordering::Release);
                }
                _ => {}
            }
            let _ = self.changed.try_send(());
        }
    }
    impl Drop for Handler {
        fn drop(&mut self) {
            let _ = self.settled.send(());
        }
    }

    struct Registration {
        pinned: Arc<Pinned>,
        watcher: Option<RecommendedWatcher>,
        settled: Option<mpsc::Receiver<()>>,
        runtime: tokio::runtime::Handle,
    }
    fn settle(watcher: RecommendedWatcher, settled: mpsc::Receiver<()>) -> io::Result<()> {
        drop(watcher);
        settled.recv().map_err(io::Error::other)
    }
    impl Drop for Registration {
        fn drop(&mut self) {
            if let (Some(watcher), Some(settled)) = (self.watcher.take(), self.settled.take()) {
                let pinned = self.pinned.clone();
                // Abandonment is not an ACK; the caller retains its resource ticket.
                self.runtime.spawn_blocking(move || {
                    let _settled = settle(watcher, settled);
                    drop(pinned);
                });
            }
        }
    }
    pub struct EvidenceWatch {
        pinned: Arc<Pinned>,
        interest: EvidenceInterest,
        checking: Option<tokio::task::JoinHandle<io::Result<bool>>>,
        registration: Registration,
        changed: wake::Receiver<()>,
        failed: Arc<AtomicBool>,
    }
    impl EvidenceWatch {
        pub async fn open(
            descriptor: &Descriptor,
            interest: EvidenceInterest,
        ) -> Result<Self, Error> {
            let path = descriptor.resource_ref.clone();
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                let pinned = Arc::new(pin(&path)?);
                let owner = path.join("owner");
                let target = owner.join(match interest {
                    EvidenceInterest::ChildExited => "exited.json",
                    EvidenceInterest::Cleanup => "closure.json",
                });
                let (send, changed) = wake::channel(1);
                let (done, settled) = mpsc::channel();
                let failed = Arc::new(AtomicBool::new(false));
                let handler = Handler {
                    changed: send,
                    failed: failed.clone(),
                    settled: done,
                    owner: owner.clone(),
                    target,
                };
                let mut watcher = match RecommendedWatcher::new(
                    handler,
                    Config::default().with_follow_symlinks(false),
                ) {
                    Ok(watcher) => watcher,
                    Err(error) => {
                        settled.recv().map_err(io::Error::other)?;
                        return Err(io::Error::other(error));
                    }
                };
                if let Err(error) = watcher.watch(&owner, RecursiveMode::NonRecursive) {
                    settle(watcher, settled)?;
                    return Err(io::Error::other(error));
                }
                let mut registration = Registration {
                    pinned: pinned.clone(),
                    watcher: Some(watcher),
                    settled: Some(settled),
                    runtime,
                };
                let checked = (|| {
                    if file_identity(&pinned.owner)? != file_identity(&pin(&path)?.owner)? {
                        return Err(invalid("original evidence watch directory changed"));
                    }
                    Ok(())
                })();
                if let Err(error) = checked {
                    settle(
                        registration.watcher.take().unwrap(),
                        registration.settled.take().unwrap(),
                    )?;
                    return Err(error);
                }
                Ok(Self {
                    pinned,
                    interest,
                    checking: None,
                    registration,
                    changed,
                    failed,
                })
            })
            .await
            .map_err(io::Error::other)?
            .map_err(Error::Io)
        }
        pub async fn wait(&mut self) -> Result<(), Error> {
            loop {
                if self.checking.is_none() {
                    let pinned = self.pinned.clone();
                    let interest = self.interest;
                    self.checking = Some(tokio::task::spawn_blocking(move || {
                        ready(&pinned, interest)
                    }));
                }
                let checked = self.checking.as_mut().expect("original level read").await;
                self.checking = None;
                if checked.map_err(io::Error::other)?? {
                    return Ok(());
                }
                self.changed().await?;
            }
        }
        /// Wait only for a hint; the caller owns and joins its authoritative level read.
        pub async fn changed(&mut self) -> Result<(), Error> {
            if self.failed.load(Ordering::Acquire) {
                return Err(io::Error::other("original evidence notification unavailable").into());
            }
            self.changed
                .recv()
                .await
                .ok_or_else(|| io::Error::other("original evidence observer closed"))?;
            if self.failed.load(Ordering::Acquire) {
                return Err(io::Error::other("original evidence notification unavailable").into());
            }
            Ok(())
        }
        pub async fn close(mut self) -> Result<(), Error> {
            if let Some(checking) = self.checking.take() {
                // Only its completion is a resource fence; the level result is not a cleanup proof.
                let _level = checking.await;
            }
            let watcher = self.registration.watcher.take().expect("original watcher");
            let settled = self
                .registration
                .settled
                .take()
                .expect("original watcher fence");
            let pinned = self.pinned.clone();
            tokio::task::spawn_blocking(move || {
                let result = settle(watcher, settled);
                drop(pinned);
                result
            })
            .await
            .map_err(io::Error::other)??;
            Ok(())
        }
    }
}
pub use watch::EvidenceWatch;
#[derive(Clone, Copy)]
pub enum EvidenceInterest {
    ChildExited,
    Cleanup,
}
pub enum CleanupEvidence {
    NeverLaunched {
        snapshot: Option<SnapshotProof>,
    },
    TaskClosed {
        snapshot: Option<SnapshotProof>,
        receipt: TaskReceipt,
    },
}
impl CleanupEvidence {
    pub fn snapshot(&self) -> Option<&SnapshotProof> {
        match self {
            Self::NeverLaunched { snapshot } | Self::TaskClosed { snapshot, .. } => {
                snapshot.as_ref()
            }
        }
    }
}
pub(super) struct Pinned {
    pub(super) resource: File,
    pub(super) owner: File,
    pub(super) path: PathBuf,
}
pub(super) fn pin(path: &std::path::Path) -> io::Result<Pinned> {
    let resource = open_resource(path)?;
    let owner = directory(&resource, "owner")?;
    check_directory(&owner, false)?;
    Ok(Pinned {
        resource,
        owner,
        path: path.to_owned(),
    })
}
fn snapshot(pinned: &Pinned) -> io::Result<Option<SnapshotProof>> {
    let proof: Option<SnapshotProof> = read_json(open_regular(&pinned.owner, "snapshot.json")?)?;
    if proof
        .as_ref()
        .is_some_and(|proof| proof.resource_ref() != pinned.path)
    {
        return Err(invalid("original snapshot resource affinity changed"));
    }
    Ok(proof)
}
fn task_receipt(pinned: &Pinned) -> io::Result<TaskReceipt> {
    let started: Started = read_json(open_regular(&pinned.owner, "started.json")?)?;
    if started.helper_pid == 0 {
        return Err(invalid("invalid original owner receipt"));
    }
    read_json(open_regular(&pinned.owner, "task.json")?)
}
pub(super) fn snapshot_identity(owner: &File) -> io::Result<super::FileIdentity> {
    file_identity(&open_regular(owner, "snapshot.json")?)
}
fn read_closure(pinned: &Pinned) -> io::Result<Option<Closure>> {
    let Some(file) = open_optional(&pinned.owner, "closure.json")? else {
        return Ok(None);
    };
    let closure: Closure = read_json(file)?;
    let (resource, snapshot) = match &closure {
        Closure::NeverLaunched { resource, snapshot }
        | Closure::SessionClosed { resource, snapshot }
        | Closure::GroupClosed {
            resource, snapshot, ..
        } => (resource, snapshot),
    };
    if resource != &pinned.path
        || *snapshot != snapshot_identity(&pinned.owner)?
        || !closure.is_closed()
    {
        return Err(invalid(
            "closure proof differs from original resource or is incomplete",
        ));
    }
    Ok(Some(closure))
}
fn read_cleanup(pinned: &Pinned) -> io::Result<Option<CleanupEvidence>> {
    let Some(closure) = read_closure(pinned)? else {
        return Ok(None);
    };
    let snapshot = snapshot(pinned)?;
    match closure {
        Closure::NeverLaunched { .. } => Ok(Some(CleanupEvidence::NeverLaunched { snapshot })),
        Closure::SessionClosed { .. }
        | Closure::GroupClosed {
            original_group_closed: true,
            streams_drained: true,
            ..
        } => Ok(Some(CleanupEvidence::TaskClosed {
            snapshot,
            receipt: task_receipt(pinned)?,
        })),
        _ => Err(invalid("original task group or streams are not closed")),
    }
}
pub(super) fn group_closed(resource: &std::path::Path) -> io::Result<bool> {
    let pinned = pin(resource)?;
    if !matches!(read_closure(&pinned)?, Some(Closure::GroupClosed { .. })) {
        return Ok(false);
    }
    task_receipt(&pinned)?;
    Ok(true)
}
pub async fn cleanup_evidence(descriptor: &Descriptor) -> Result<Option<CleanupEvidence>, Error> {
    let path = descriptor.resource_ref.clone();
    {
        tokio::task::spawn_blocking(move || read_cleanup(&pin(&path)?))
            .await
            .map_err(io::Error::other)?
            .map_err(Error::Io)
    }
}
fn ready(pinned: &Pinned, interest: EvidenceInterest) -> io::Result<bool> {
    match interest {
        EvidenceInterest::Cleanup => Ok(read_closure(pinned)?.is_some()),
        EvidenceInterest::ChildExited => {
            let Some(file) = open_optional(&pinned.owner, "exited.json")? else {
                return Ok(false);
            };
            let exited: ChildExited = read_json(file)?;
            if exited.resource != pinned.path
                || exited.snapshot != snapshot_identity(&pinned.owner)?
            {
                return Err(invalid("child exit proof differs from original resource"));
            }
            task_receipt(pinned)?;
            Ok(true)
        }
    }
}

/// Read-only original provider resources. This proves group/stream closure,
/// never native business success, workspace quiescence or publication authority.
/// Seek the same open files back to zero for a second parser pass.
pub struct ClosedEvidence {
    pub stdin: File,
    pub stdout: File,
    /// A PTY merges stderr into stdout; there is no independent stderr resource.
    pub stderr: Option<File>,
    pub snapshot: Option<SnapshotProof>,
    pub receipt: TaskReceipt,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    resource: File,
}
impl ClosedEvidence {
    /// Call on a blocking worker. Only the immutable original baseline is
    /// opened; the possibly still changing working tree is not observed here.
    pub fn baseline_reader(&self) -> io::Result<BaselineReader> {
        BaselineReader::from_resource(
            &self.resource,
            self.snapshot
                .clone()
                .ok_or_else(|| invalid("live task has no baseline"))?,
        )
    }
}

/// Observe only the original owner. Missing closure is still unknown/running;
/// this function neither creates a TaskOwner nor starts/controls any process.
/// The caller must select the descriptor from its admitted original resource
/// receipt and independently validate the original native protocol identities.
pub async fn closed_evidence(descriptor: &Descriptor) -> Result<Option<ClosedEvidence>, Error> {
    if !super::os::SUPPORTED {
        return Err(Error::IsolationUnavailable(
            "native task evidence is unavailable on this platform".into(),
        ));
    }
    let resource = descriptor.resource_ref.clone();
    tokio::task::spawn_blocking(move || read_closed(resource))
        .await
        .map_err(io::Error::other)?
        .map_err(Error::Io)
}

fn read_closed(resource: PathBuf) -> io::Result<Option<ClosedEvidence>> {
    let Pinned {
        resource: resource_fd,
        owner,
        ..
    } = pin(&resource)?;

    let Some(closure_file) = open_optional(&owner, "closure.json")? else {
        return Ok(None);
    };
    let closure: Closure = read_json(closure_file)?;
    if !closure.is_closed() {
        return Err(invalid("original task group or streams are not closed"));
    }
    let (exit_code, signal) = match closure {
        Closure::GroupClosed {
            exit_code,
            signal,
            resource: original,
            snapshot,
            ..
        } => {
            if original != resource || snapshot != snapshot_identity(&owner)? {
                return Err(invalid("closure differs from original resource"));
            }
            (exit_code, signal)
        }
        Closure::SessionClosed {
            resource: original,
            snapshot,
        } => {
            if original != resource || snapshot != snapshot_identity(&owner)? {
                return Err(invalid("session closure differs from original resource"));
            }
            (None, None)
        }
        Closure::NeverLaunched { .. } => {
            return Err(invalid("unlaunched task has no native protocol stream"));
        }
    };
    let started: Started = read_json(open_regular(&owner, "started.json")?)?;
    if started.helper_pid == 0 {
        return Err(invalid("invalid original owner receipt"));
    }
    let receipt: TaskReceipt = read_json(open_regular(&owner, "task.json")?)?;
    let snapshot: Option<SnapshotProof> = read_json(open_regular(&owner, "snapshot.json")?)?;
    if snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.resource_ref() != resource)
    {
        return Err(invalid("original snapshot resource affinity changed"));
    }
    let TaskReceipt::Task { terminal_size, .. } = &receipt;
    let stderr = if terminal_size.is_none() {
        Some(open_regular(&owner, "stderr.bin")?)
    } else {
        None
    };
    // No file is opened with write/create/truncate, and every file is relative
    // to the already pinned owner directory, never a job-controlled workspace.
    let stdin = open_regular(&owner, "stdin.bin")?;
    let stdout = open_regular(&owner, "stdout.bin")?;
    Ok(Some(ClosedEvidence {
        stdin,
        stdout,
        stderr,
        snapshot,
        receipt,
        exit_code,
        signal,
        resource: resource_fd,
    }))
}

pub(super) fn open_resource(resource: &std::path::Path) -> io::Result<File> {
    let namespace = maka_sandbox::native_task_namespace()?;
    let name = resource
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|name| {
            name.starts_with("maka-native-task-") && name.len() > "maka-native-task-".len()
        })
        .ok_or_else(|| invalid("invalid task resource name"))?;
    if !resource.is_absolute()
        || resource.parent() != Some(namespace.as_path())
        || maka_sandbox::canonical_policy_path(&namespace)? != namespace
        || maka_sandbox::canonical_policy_path(resource)? != resource
    {
        return Err(invalid(
            "task evidence must name its canonical private namespace resource",
        ));
    }
    #[cfg(unix)]
    let namespace_fd: File =
        rustix::fs::open(&namespace, directory_flags(), rustix::fs::Mode::empty())?.into();
    #[cfg(windows)]
    let namespace_fd = maka_event_log::root::windows::open_nofollow(&namespace, false)?;
    check_directory(&namespace_fd, false)?;
    let resource_fd: File = directory(&namespace_fd, name)?;
    check_directory(&resource_fd, true)?;
    Ok(resource_fd)
}
#[cfg(unix)]
fn directory_flags() -> rustix::fs::OFlags {
    use rustix::fs::OFlags;
    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
}
fn directory(parent: &File, name: &str) -> io::Result<File> {
    #[cfg(unix)]
    return Ok(
        rustix::fs::openat(parent, name, directory_flags(), rustix::fs::Mode::empty())?.into(),
    );
    #[cfg(windows)]
    super::fs::directory(parent, name.as_ref())
}
fn file_identity(file: &File) -> io::Result<super::FileIdentity> {
    #[cfg(unix)]
    return Ok(super::snapshot::identity(&file.metadata()?));
    #[cfg(windows)]
    super::fs::identity(file)
}
#[cfg(windows)]
fn check_directory(file: &File, _: bool) -> io::Result<()> {
    if !file.metadata()?.is_dir() {
        return Err(invalid("expected private directory"));
    }
    maka_event_log::root::windows::validate_protected_private(file)
}
#[cfg(windows)]
pub(super) fn open_optional(owner: &File, name: &str) -> io::Result<Option<File>> {
    match super::fs::read(owner, name.as_ref(), false) {
        Ok(file) => {
            super::fs::private_file(&file)?;
            Ok(Some(file))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn check_directory(file: &File, private: bool) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & if private { 0o077 } else { 0o022 } != 0
    {
        return Err(invalid(
            "task evidence directory ownership or permissions changed",
        ));
    }
    Ok(())
}
#[cfg(unix)]
pub(super) fn open_optional(owner: &File, name: &str) -> io::Result<Option<File>> {
    use rustix::fs::{Mode, OFlags, openat};
    use std::os::unix::fs::MetadataExt;
    let file: File = match openat(
        owner,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd.into(),
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(invalid(
            "task evidence must be a private original regular file",
        ));
    }
    Ok(Some(file))
}
pub(super) fn open_regular(owner: &File, name: &str) -> io::Result<File> {
    open_optional(owner, name)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("original task evidence missing: {name}"),
        )
    })
}
pub(super) fn read_json<T: serde::de::DeserializeOwned>(file: File) -> io::Result<T> {
    serde_json::from_reader(file).map_err(io::Error::other)
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
