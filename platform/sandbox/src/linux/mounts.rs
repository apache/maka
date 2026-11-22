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

//! Missing mount targets are published atomically from a private staging area.
//! A locked descriptor, retained by bubblewrap's PID 1, is the lifetime proof.
//! Recovery never infers ownership from a pathname, empty directory, PID or age.

use crate::Error;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
        },
    },
    path::{Path, PathBuf},
};

const RECORD: &str = "targets.json";

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
struct Target {
    path: PathBuf,
    device: u64,
    inode: u64,
    nonce: [u8; 16],
    directory: bool,
}

/// Retain until native cleanup has completed, then call `finish` on a blocking
/// worker. Dropping the handle only releases its lease; the next preparation
/// recovers any uncollected targets, including after Host termination.
pub struct MountLease {
    roots: Vec<PathBuf>,
    directory: PathBuf,
    lock: Option<File>,
}

impl MountLease {
    pub fn finish(mut self) -> Result<(), Error> {
        let released = options()
            .read(true)
            .write(true)
            .open(self.directory.join("lease"))?;
        self.lock.take();
        // bubblewrap's outer monitor can report exit just before its namespace
        // reaper closes --sync-fd. A concurrent fork may also briefly inherit a
        // CLOEXEC copy. Observe the kernel lease, not merely the root's exit.
        acquire(&released)?;
        drop(released);
        let _gate = gate(&self.roots[0])?;
        collect(&self.roots).map(|_| ())
    }
}

pub(super) struct Registry {
    root: PathBuf,
    roots: Vec<PathBuf>,
    directory: PathBuf,
    lock: File,
    targets: Vec<Target>,
    known: BTreeSet<Target>,
    _gate: File,
}

impl Registry {
    pub fn open(cwd: &Path) -> Result<Self, Error> {
        // A predictable private directory allows recovery across Host restarts.
        // Validate ownership and mode before opening any bookkeeping beneath it.
        // Fixed per-user roots keep separate Hosts coordinated even when their
        // TMPDIR/HOME environments differ. /tmp may be tmpfs while projects are
        // on the user's home filesystem; staging must support both layouts.
        let temporary = Path::new("/tmp").canonicalize()?;
        let mut parents = vec![temporary];
        if let Some(home) = home()? {
            let home = home.canonicalize()?;
            if home.metadata()?.dev() != parents[0].metadata()?.dev() {
                let cache = home.join(".cache");
                fs::create_dir_all(&cache)?;
                parents.push(cache.canonicalize()?);
            }
        }
        let roots: Vec<_> = parents
            .into_iter()
            .map(private_root)
            .collect::<Result<_, _>>()?;
        let device = cwd.metadata()?.dev();
        let root = roots
            .iter()
            .find(|root| root.metadata().is_ok_and(|m| m.dev() == device))
            .unwrap_or(&roots[0])
            .clone();
        let gate = gate(&roots[0])?;
        let known = collect(&roots)?;
        let directory = root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&directory)?;
        let lock = options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.join("lease"))?;
        lock.try_lock().map_err(io::Error::from)?;
        Ok(Self {
            root,
            roots,
            directory,
            lock,
            targets: Vec::new(),
            known,
            _gate: gate,
        })
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// Existing synthetic targets may belong to another live command. Record
    /// our reference before releasing the registry gate, so its cleanup cannot
    /// remove a target while this command is being prepared or running.
    pub fn retain(&mut self, path: &Path) -> Result<(), Error> {
        for target in self.known.iter().filter(|target| target.path == path) {
            if matches(target)? && !self.targets.contains(target) {
                self.targets.push(target.clone());
                self.persist()?;
                break;
            }
        }
        Ok(())
    }

    pub fn create(&mut self, path: &Path, directory: bool) -> Result<(), Error> {
        let device = path
            .parent()
            .expect("absolute mount target")
            .metadata()?
            .dev();
        let stage_root =
            self.roots
                .iter()
                .find(|root| {
                    root.metadata()
                        .is_ok_and(|metadata| metadata.dev() == device)
                })
                .ok_or_else(|| {
                    Error::Unsupported(
            "missing protected paths must share a filesystem with a sandbox mount registry".into()
        )
                })?;
        // One authoritative lease can protect targets on both /tmp and home.
        // Publication still needs same-filesystem staging. A secondary private
        // directory contains no target journal: the primary journal owns every
        // public target, including through crash recovery. The global admission
        // lock excludes collection while this staging directory is in use.
        let staging = if stage_root == &self.root {
            self.directory.clone()
        } else {
            let directory = stage_root.join(uuid::Uuid::new_v4().to_string());
            fs::create_dir(&directory)?;
            options()
                .write(true)
                .create_new(true)
                .open(directory.join("lease"))?;
            directory
        };
        let stage = staging.join(self.targets.len().to_string());
        if directory {
            fs::create_dir(&stage)?;
        } else {
            options()
                .write(true)
                .create_new(true)
                .open(&stage)?
                .sync_all()?;
        }
        let staged = options().read(true).open(&stage)?;
        let metadata = staged.metadata()?;
        let nonce = *uuid::Uuid::new_v4().as_bytes();
        // The marker survives rename but not inode reuse. Set it before the
        // identity record or public path exists; unsupported xattrs fail closed.
        let marked = unsafe {
            libc::fsetxattr(
                staged.as_raw_fd(),
                c"user.maka-sandbox-owner".as_ptr(),
                nonce.as_ptr().cast(),
                nonce.len(),
                libc::XATTR_CREATE,
            )
        };
        if marked != 0 {
            return Err(io::Error::last_os_error().into());
        }
        staged.sync_all()?;
        let target = Target {
            path: path.to_owned(),
            device: metadata.dev(),
            inode: metadata.ino(),
            nonce,
            directory,
        };
        self.targets.push(target);
        // Identity is durable BEFORE publication. Interrupted preparations leave
        // only private staging files, never an unowned workspace placeholder.
        self.persist()?;
        let source = CString::new(stage.as_os_str().as_bytes()).map_err(invalid)?;
        let destination = CString::new(path.as_os_str().as_bytes()).map_err(invalid)?;
        // No replacement, including a concurrently created empty directory.
        // Both paths are absolute and their C strings remain live for this call.
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EXDEV) {
                return Err(Error::Unsupported(
                    "missing protected paths must share a filesystem with the sandbox mount registry".into()
                ));
            }
            return Err(error.into());
        }
        File::open(path.parent().expect("absolute mount target"))?.sync_all()?;
        if staging != self.directory {
            fs::remove_dir_all(staging)?;
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), Error> {
        let pending = self.directory.join("pending.json");
        let mut file = options()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&pending)?;
        let bytes = serde_json::to_vec(&self.targets).map_err(invalid)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(pending, self.directory.join(RECORD))?;
        File::open(&self.directory)?.sync_all()?;
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }

    pub fn abort(self) -> Result<(), Error> {
        let lease = MountLease {
            roots: self.roots,
            directory: self.directory,
            lock: Some(self.lock),
        };
        drop(self._gate);
        lease.finish()
    }

    pub fn finish(self) -> Result<(MountLease, File), Error> {
        let prepared = (|| {
            self.persist()?;
            self.lock.try_clone().map_err(Error::from)
        })();
        let inherited = match prepared {
            Ok(inherited) => inherited,
            Err(error) => {
                self.abort()
                    .map_err(|cleanup| Error::CleanupUnconfirmed(cleanup.to_string()))?;
                return Err(error);
            }
        };
        // This duplicate shares the kernel lock. bubblewrap retains it in its
        // reaper (--sync-fd), closes it before exec of the model's command, and
        // releases it only when that sandbox has ended. Do not call unlock().
        Ok((
            MountLease {
                roots: self.roots,
                directory: self.directory,
                lock: Some(self.lock),
            },
            inherited,
        ))
    }
}

fn private_root(parent: PathBuf) -> Result<PathBuf, Error> {
    let root = parent.join(format!("maka-sandbox-mounts-{}", unsafe {
        libc::geteuid()
    }));
    match fs::DirBuilder::new().mode(0o700).create(&root) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = root.symlink_metadata()?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(Error::Invalid(
            "sandbox mount registry is not private".into(),
        ));
    }
    Ok(root)
}

fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .mode(0o600);
    options
}

fn gate(root: &Path) -> Result<File, Error> {
    let file = options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("lock"))?;
    acquire(&file)?;
    Ok(file)
}

fn acquire(file: &File) -> Result<(), Error> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            Err(error) => return Err(io::Error::from(error).into()),
        }
    }
}

fn collect(roots: &[PathBuf]) -> Result<BTreeSet<Target>, Error> {
    let mut active = BTreeSet::new();
    let mut retired = Vec::new();
    for root in roots {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            if entry.file_name() == "lock" {
                continue;
            }
            if !entry.file_type()?.is_dir()
                || entry
                    .file_name()
                    .to_str()
                    .is_none_or(|s| uuid::Uuid::parse_str(s).is_err())
            {
                return Err(Error::Invalid(
                    "unexpected sandbox mount registry entry".into(),
                ));
            }
            let directory = entry.path();
            let lock = match options()
                .read(true)
                .write(true)
                .open(directory.join("lease"))
            {
                Ok(lock) => lock,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    // A crash before creating the lease cannot have published targets.
                    fs::remove_dir(&directory)?;
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            let targets = read(&directory)?;
            match lock.try_lock() {
                Ok(()) => retired.push((directory, lock, targets)),
                Err(std::fs::TryLockError::WouldBlock) => active.extend(targets),
                Err(error) => return Err(io::Error::from(error).into()),
            }
        }
    }
    // Children may belong to another retired preparation. Collect globally in
    // child-first order before deleting any journal, otherwise a parent's first
    // nonempty result could orphan it when that child's journal is processed.
    let mut targets: Vec<_> = retired.iter().flat_map(|(_, _, targets)| targets).collect();
    targets.sort_by_key(|target| std::cmp::Reverse(target.path.components().count()));
    targets.dedup();
    for target in targets {
        if active.contains(target) || !matches(target)? {
            continue;
        }
        let removed = if target.directory {
            fs::remove_dir(&target.path)
        } else {
            fs::remove_file(&target.path)
        };
        match removed {
            Ok(()) => {
                File::open(target.path.parent().expect("recorded absolute path"))?.sync_all()?
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(error) => return Err(error.into()),
        }
    }
    for (directory, _lock, _) in retired {
        // Only an exclusively locked, Host-private lease directory is removed.
        // Published paths above are never recursively deleted.
        fs::remove_dir_all(directory)?;
    }
    Ok(active)
}

fn read(directory: &Path) -> Result<Vec<Target>, Error> {
    let file = match options().read(true).open(directory.join(RECORD)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    let mut file = file;
    file.read_to_end(&mut bytes)?;
    let targets: Vec<Target> = serde_json::from_slice(&bytes).map_err(invalid)?;
    for target in &targets {
        crate::path::validate(&target.path)?;
    }
    Ok(targets)
}

fn matches(target: &Target) -> Result<bool, Error> {
    match target.path.symlink_metadata() {
        Ok(metadata) => {
            if metadata.dev() != target.device
                || metadata.ino() != target.inode
                || metadata.is_dir() != target.directory
                || !(target.directory || metadata.is_file() && metadata.len() == 0)
            {
                return Ok(false);
            }
            let file = options()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
                .open(&target.path)?;
            let observed = file.metadata()?;
            if observed.dev() != target.device || observed.ino() != target.inode {
                return Ok(false);
            }
            let mut nonce = [0u8; 16];
            let length = unsafe {
                libc::fgetxattr(
                    file.as_raw_fd(),
                    c"user.maka-sandbox-owner".as_ptr(),
                    nonce.as_mut_ptr().cast(),
                    nonce.len(),
                )
            };
            if length < 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(libc::ENODATA) {
                    Ok(false)
                } else {
                    Err(error.into())
                };
            }
            Ok(length == nonce.len() as isize && nonce == target.nonce)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn invalid(error: impl std::fmt::Display) -> Error {
    Error::Invalid(error.to_string())
}

fn home() -> Result<Option<PathBuf>, Error> {
    let mut buffer = vec![0u8; 65_536];
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    // Scratch storage and output pointers remain live until pw_dir is copied.
    let status = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status).into());
    }
    if result.is_null() {
        return Ok(None);
    }
    let entry = unsafe { entry.assume_init() };
    if entry.pw_dir.is_null() {
        return Ok(None);
    }
    let directory = unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) }.to_bytes();
    Ok((!directory.is_empty()).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(directory))))
}
