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

//! State-root discovery, ownership and mutually exclusive leases.

mod lock;
pub use lock::{FileLease, private_directory};

#[cfg(windows)]
pub mod windows;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub const ROOT_MARKER: &str = ".maka-storage-root.json";
pub const ROOT_DATABASE: &str = "runtime-rust.sqlite";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootNamespaces {
    pub ownership: PathBuf,
    pub control: PathBuf,
}

impl RootNamespaces {
    pub fn for_current_account() -> io::Result<Self> {
        let home = maka_sandbox::account_home()?;
        #[cfg(target_os = "macos")]
        return Ok(Self {
            ownership: home.join("Library/Application Support/Maka/state-root-owners"),
            control: home.join("Library/Caches/Maka/runtime-hosts"),
        });
        #[cfg(target_os = "linux")]
        return Ok(Self {
            ownership: home.join(".local/share/Maka/state-root-owners"),
            control: home.join(".cache/maka/runtime-hosts"),
        });
        #[cfg(windows)]
        return Ok(Self {
            ownership: home.join("AppData/Local/Maka/state-root-owners"),
            control: home.join("AppData/Local/Maka/runtime-hosts"),
        });
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    root_id: String,
}

type MountedIdentity = (u64, u64);

/// Owns the durable root lease. It cannot be cloned or fabricated.
pub struct RootOwner {
    capability_changes: tokio::sync::watch::Sender<()>,
    pub(crate) operation_live: std::sync::Arc<crate::applications::operations::LiveOperations>,
    canonical_path: PathBuf,
    marker: Marker,
    #[cfg(unix)]
    marker_path: PathBuf,
    mounted_identity: MountedIdentity,
    #[cfg(unix)]
    root_dir: File,
    #[cfg(unix)]
    fast_canonical_path: bool,
    #[cfg(unix)]
    marker_file: File,
    #[cfg(unix)]
    marker_identity: MountedIdentity,
    #[cfg(unix)]
    marker_bytes: Vec<u8>,
    control_directory: PathBuf,
    control_identity: MountedIdentity,
    lock_path: PathBuf,
    durable_lease: File,
}

/// A verified location, not a writer lease. Every mutation still needs RootOwner.
#[derive(Debug, Clone)]
pub struct RootLocation {
    canonical_path: PathBuf,
    root_id: String,
}

impl RootLocation {
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }

    pub fn root_id(&self) -> &str {
        &self.root_id
    }
}

/// Inspect only an existing native root. Never initialize, repair or acquire it.
pub fn resolve(path: &Path) -> io::Result<RootLocation> {
    let (canonical_path, marker, _) = inspect(path)?;
    Ok(RootLocation {
        canonical_path,
        root_id: marker.root_id,
    })
}

fn inspect(path: &Path) -> io::Result<(PathBuf, Marker, MountedIdentity)> {
    let canonical_path = path.canonicalize()?;
    let identity = directory_identity(&canonical_path)?;
    check_layout(&canonical_path)?;
    let marker = read_marker(&canonical_path)?;
    if directory_identity(&canonical_path)? != identity
        || canonical_path.canonicalize()? != canonical_path
    {
        return Err(io::Error::other("root identity collision"));
    }
    Ok((canonical_path, marker, identity))
}

/// Verify an existing native root without taking its writer lease, or initialize an empty one.
pub fn initialize(path: &Path, namespaces: &RootNamespaces) -> io::Result<String> {
    if !path.join(ROOT_MARKER).exists() {
        return Ok(RootOwner::create(path, namespaces)?.root_id().to_owned());
    }
    Ok(resolve(path)?.root_id)
}

/// Prepare a Root path without changing an existing directory's permissions.
pub fn prepare_directory(path: &Path) -> io::Result<PathBuf> {
    #[cfg(not(windows))]
    fs::create_dir_all(path)?;
    #[cfg(windows)]
    match windows::create_private_directory(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(error) => return Err(error),
    }
    path.canonicalize()
}

impl RootOwner {
    /// Invalidates capability reads in this live Root; never a grant or a physical proof.
    pub fn capability_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.capability_changes.subscribe()
    }
    pub fn capability_source_changed(&self) {
        self.capability_changes.send_modify(|_| {});
    }
    /// Initialize a nonexistent or empty disposable directory. Never adopt existing state.
    pub fn create(path: &Path, namespaces: &RootNamespaces) -> io::Result<Self> {
        let path = prepare_directory(path)?;
        if fs::read_dir(&path)?.next().is_some() {
            return Err(io::Error::other(
                "refusing to initialize a nonempty State Root",
            ));
        }
        lock::private_directory(&path)?;
        let marker = Marker {
            root_id: hex::encode(Sha256::digest(uuid::Uuid::new_v4().as_bytes())),
        };
        publish(&path, ROOT_MARKER, &serde_json::to_vec(&marker)?)?;
        Self::open(&path, namespaces)
    }

    /// Open only a marked State Root, rejecting unmarked directories before database access.
    pub fn open(path: &Path, namespaces: &RootNamespaces) -> io::Result<Self> {
        let (canonical_path, marker, identity) = inspect(path)?;
        let owner = Self::acquire(canonical_path, marker, identity, namespaces, false)?;
        owner.validate_current()?;
        Ok(owner)
    }

    /// Acquire an existing Root without creating or repairing coordination state.
    /// Uses the same exclusive ownership protocol as ordinary startup.
    pub fn open_existing(path: &Path, namespaces: &RootNamespaces) -> io::Result<Self> {
        let (canonical_path, marker, identity) = inspect(path)?;
        let owner = Self::acquire(canonical_path, marker, identity, namespaces, true)?;
        owner.validate_current()?;
        Ok(owner)
    }

    fn acquire(
        canonical_path: PathBuf,
        marker: Marker,
        mounted_identity: MountedIdentity,
        namespaces: &RootNamespaces,
        existing_only: bool,
    ) -> io::Result<Self> {
        let directory = if existing_only {
            lock::existing_private_directory
        } else {
            lock::private_directory
        };
        directory(&namespaces.ownership)?;
        let lock_path = namespaces
            .ownership
            .join(format!("{}.lock", marker.root_id));
        let durable_lease = if existing_only {
            lock::acquire_existing(&lock_path)?
        } else {
            lock::acquire(&lock_path)?
        };
        directory(&namespaces.control)?;
        let control_directory = namespaces.control.join(&marker.root_id);
        directory(&control_directory)?;
        let control_identity = directory_identity(&control_directory)?;
        #[cfg(unix)]
        let marker_path = canonical_path.join(ROOT_MARKER);
        #[cfg(unix)]
        let root_dir = open_directory(&canonical_path, mounted_identity)?;
        #[cfg(unix)]
        let fast_canonical_path =
            fd_matches_canonical_path(&root_dir, &canonical_path).unwrap_or(false);
        #[cfg(unix)]
        let (marker_file, marker_identity, marker_bytes) =
            open_verified_marker(&marker_path, &marker)?;
        Ok(Self {
            capability_changes: tokio::sync::watch::channel(()).0,
            operation_live: std::sync::Arc::new(
                crate::applications::operations::LiveOperations::default(),
            ),
            canonical_path,
            marker,
            #[cfg(unix)]
            marker_path,
            mounted_identity,
            #[cfg(unix)]
            root_dir,
            #[cfg(unix)]
            fast_canonical_path,
            #[cfg(unix)]
            marker_file,
            #[cfg(unix)]
            marker_identity,
            #[cfg(unix)]
            marker_bytes,
            control_directory,
            control_identity,
            lock_path,
            durable_lease,
        })
    }

    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
    pub fn root_id(&self) -> &str {
        &self.marker.root_id
    }
    pub fn control_directory(&self) -> &Path {
        &self.control_directory
    }
    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }

    /// Call before root mutations. Detect path rebinding, marker replacement and lease unlinking.
    pub fn validate_current(&self) -> io::Result<()> {
        self.check_directory()?;
        self.check_marker()?;
        if directory_identity(&self.canonical_path)? != self.mounted_identity {
            return Err(io::Error::other("root directory identity changed"));
        }
        self.validate_leases()
    }

    /// Verify a captured directory before using it for domain data. Checking
    /// the pathname alone cannot detect a different handle captured during an
    /// intervening rename, even after the original pathname has been restored.
    pub fn validate_directory_handle(&self, directory: &File) -> io::Result<()> {
        self.validate_current()?;
        let metadata = directory.metadata()?;
        if !metadata.is_dir() {
            return Err(io::Error::other("State Root handle must be a directory"));
        }
        if file_identity(directory, &metadata)? != self.mounted_identity {
            return Err(io::Error::other(
                "State Root directory handle identity changed",
            ));
        }
        Ok(())
    }

    fn validate_leases(&self) -> io::Result<()> {
        lock::stable(&self.durable_lease, &self.lock_path)?;
        // Discovery is disposable, but its loss must fence this live owner:
        // another launcher can no longer discover or hand off this process.
        if directory_identity(&self.control_directory)? != self.control_identity {
            return Err(io::Error::other("Host control directory identity changed"));
        }
        Ok(())
    }

    fn check_directory(&self) -> io::Result<()> {
        #[cfg(unix)]
        if self.fast_canonical_path {
            if !fd_matches_canonical_path(&self.root_dir, &self.canonical_path)?
                || directory_identity(&self.canonical_path)? != self.mounted_identity
            {
                return Err(io::Error::other("root directory identity changed"));
            }
            return Ok(());
        }
        if self.canonical_path.canonicalize()? != self.canonical_path
            || directory_identity(&self.canonical_path)? != self.mounted_identity
        {
            return Err(io::Error::other("root directory identity changed"));
        }
        Ok(())
    }

    #[cfg(unix)]
    fn check_marker(&self) -> io::Result<()> {
        use std::os::unix::fs::FileExt;
        let named = self.marker_path.symlink_metadata()?;
        if !named.is_file() {
            return Err(io::Error::other("root marker is not a regular file"));
        }
        if lock::identity(&named)? == self.marker_identity
            && named.len() == self.marker_bytes.len() as u64
        {
            let mut buffer = [0u8; 1025];
            let max_read = (self.marker_bytes.len() + 1).min(buffer.len());
            let mut offset = 0usize;
            while offset < max_read {
                let read = self
                    .marker_file
                    .read_at(&mut buffer[offset..max_read], offset as u64)?;
                if read == 0 {
                    break;
                }
                offset += read;
            }
            if buffer[..offset] == self.marker_bytes[..] {
                return Ok(());
            }
        }
        let marker = read_marker(&self.canonical_path)?;
        self.check_directory()?;
        if marker != self.marker {
            return Err(io::Error::other("root marker identity changed"));
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn check_marker(&self) -> io::Result<()> {
        let marker = read_marker(&self.canonical_path)?;
        self.check_directory()?;
        if marker != self.marker {
            return Err(io::Error::other("root marker identity changed"));
        }
        Ok(())
    }
}

fn file_identity(_file: &File, _metadata: &fs::Metadata) -> io::Result<MountedIdentity> {
    #[cfg(unix)]
    return lock::identity(_metadata);
    #[cfg(windows)]
    {
        let identity = windows::file_identity(_file)?;
        Ok((identity.volume, identity.index))
    }
}

fn directory_identity(path: &Path) -> io::Result<MountedIdentity> {
    let metadata = path.symlink_metadata()?;
    if !metadata.is_dir() {
        return Err(io::Error::other("State Root must be a directory"));
    }
    #[cfg(unix)]
    return lock::identity(&metadata);
    #[cfg(windows)]
    file_identity(&windows::open_nofollow(path, false)?, &metadata)
}

fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    let file = lock::open_regular(path, false)?;
    let before = file.metadata()?;
    let mut bytes = Vec::new();
    (&file).take(1025).read_to_end(&mut bytes)?;
    lock::stable(&file, path)?;
    let after = file.metadata()?;
    if bytes.len() > 1024
        || before.len() != bytes.len() as u64
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return Err(io::Error::other("invalid or changing bounded marker"));
    }
    Ok(bytes)
}

fn parse_marker(bytes: &[u8]) -> io::Result<Marker> {
    let marker: Marker = serde_json::from_slice(bytes)?;
    if marker.root_id.len() != 64
        || !marker
            .root_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(io::Error::other("invalid State Root marker"));
    }
    Ok(marker)
}

fn read_marker(path: &Path) -> io::Result<Marker> {
    parse_marker(&read_bounded(&path.join(ROOT_MARKER))?)
}

#[cfg(unix)]
fn open_directory(path: &Path, expected: MountedIdentity) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir() || lock::identity(&metadata)? != expected {
        return Err(io::Error::other("root directory identity changed"));
    }
    Ok(file)
}

#[cfg(unix)]
fn open_verified_marker(
    marker_path: &Path,
    expected: &Marker,
) -> io::Result<(File, MountedIdentity, Vec<u8>)> {
    let file = lock::open_regular(marker_path, false)?;
    let before = file.metadata()?;
    let mut bytes = Vec::new();
    (&file).take(1025).read_to_end(&mut bytes)?;
    lock::stable(&file, marker_path)?;
    let after = file.metadata()?;
    if bytes.len() > 1024
        || before.len() != bytes.len() as u64
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return Err(io::Error::other("invalid or changing bounded marker"));
    }
    let parsed = parse_marker(&bytes)?;
    if &parsed != expected {
        return Err(io::Error::other("root marker identity changed"));
    }
    Ok((file, lock::identity(&after)?, bytes))
}

#[cfg(target_os = "macos")]
fn fd_matches_canonical_path(file: &File, expected: &Path) -> io::Result<bool> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    let mut buffer = [0u8; libc::MAXPATHLEN as usize];
    // SAFETY: `file` is a live open descriptor for the duration of this call,
    // and `F_GETPATH` writes a NUL-terminated path into a buffer of at least
    // `MAXPATHLEN` bytes.
    let status = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
    if status == -1 {
        return Err(io::Error::last_os_error());
    }
    let len = buffer
        .iter()
        .position(|&byte| byte == 0)
        .ok_or_else(|| io::Error::other("unterminated F_GETPATH result"))?;
    Ok(&buffer[..len] == expected.as_os_str().as_bytes())
}

#[cfg(target_os = "linux")]
fn fd_matches_canonical_path(file: &File, expected: &Path) -> io::Result<bool> {
    use std::os::fd::AsRawFd;
    let link = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
    Ok(link == expected)
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn fd_matches_canonical_path(_file: &File, _expected: &Path) -> io::Result<bool> {
    Ok(false)
}

fn check_layout(path: &Path) -> io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        let core_file = matches!(
            name.to_str(),
            Some(
                ROOT_MARKER
                    | ROOT_DATABASE
                    | "runtime-rust.sqlite-wal"
                    | "runtime-rust.sqlite-shm"
                    | "runtime-rust.sqlite.writer.lock"
                    | "configuration-rust.sqlite"
                    | "configuration-rust.sqlite-journal"
                    | "configuration-rust.sqlite-wal"
                    | "configuration-rust.sqlite-shm"
            )
        );
        let kind = entry.file_type()?;
        // Root owns its core files, not the names or layouts of domain data.
        // A reserved file cannot become a directory. Domain files and
        // directories are opaque here; aliases and special files are refused.
        let supported = if core_file {
            kind.is_file()
        } else {
            kind.is_file() || kind.is_dir()
        };
        if !supported {
            return Err(io::Error::other(format!(
                "unsupported files in Rust prototype root: {name:?}"
            )));
        }
        #[cfg(windows)]
        windows::open_nofollow(&entry.path(), false)?;
    }
    Ok(())
}

fn publish(root: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let temp = root.join(format!("{name}.{}.tmp", uuid::Uuid::new_v4()));
    #[cfg(not(windows))]
    let mut file = {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&temp)?
    };
    #[cfg(windows)]
    let mut file = windows::create_private_file(&temp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(not(windows))]
        {
            fs::hard_link(&temp, root.join(name))?;
            File::open(root)?.sync_all()
        }
        #[cfg(windows)]
        windows::publish_file(&temp, &root.join(name))
    })();
    let cleanup = match fs::remove_file(&temp) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    };
    result.and(cleanup)
}
