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
pub const RUST_ROOT_MARKER: &str = ".maka-rust-runtime.json";
pub const ROOT_DATABASE: &str = "runtime-rust.sqlite";
const PROTOTYPE: &[u8] = b"{\"schemaVersion\":1,\"runtime\":\"rust-prototype\"}\n";
const REMOUNT_STAGING: &str = ".maka-storage-root.next";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootNamespaces {
    pub ownership: PathBuf,
    pub control: PathBuf,
}

impl RootNamespaces {
    pub fn for_current_account() -> io::Result<Self> {
        let home = lock::account_home()?;
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
#[serde(rename_all = "camelCase")]
struct Marker {
    schema_version: u8,
    kind: String,
    root_id: String,
    root_identity: Identity,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Identity {
    dev: String,
    ino: String,
}

/// Owns the durable root lease. It cannot be cloned or fabricated.
pub struct RootOwner {
    canonical_path: PathBuf,
    marker: Marker,
    control_directory: PathBuf,
    control_identity: Identity,
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
    let (canonical_path, marker) = inspect(path)?;
    Ok(RootLocation {
        canonical_path,
        root_id: marker.root_id,
    })
}

/// Explicitly confirm an unchanged Linux directory after its filesystem was
/// remounted. Equal inode numbers alone do not establish identity across volumes.
/// A matching root is a read-only no-op, including while its Host is running.
pub fn repair_after_remount(
    path: &Path,
    expected_root_id: &str,
    namespaces: &RootNamespaces,
) -> io::Result<()> {
    let canonical_path = path.canonicalize()?;
    let identity = directory_identity(&canonical_path)?;
    check_layout(&canonical_path)?;
    let previous = read_marker(&canonical_path)?;
    if previous.root_id != expected_root_id
        || directory_identity(&canonical_path)? != identity
        || canonical_path.canonicalize()? != canonical_path
    {
        return Err(io::Error::other("root changed before remount confirmation"));
    }
    if previous.root_identity == identity {
        return Ok(());
    }
    if !cfg!(target_os = "linux") || previous.root_identity.ino != identity.ino {
        return Err(io::Error::other("root is not an unchanged Linux remount"));
    }
    let mut next = previous.clone();
    next.root_identity = identity;
    // Use the same ownership lock as normal Host startup, not executor.lock
    // or FileLease: Linux OFD locks are distinct from flock.
    let owner = RootOwner::acquire(canonical_path, next, namespaces, false)?;
    let validate = || {
        owner.check_directory()?;
        owner.validate_leases()?;
        if read_marker(&owner.canonical_path)? != previous {
            return Err(io::Error::other(
                "root marker changed during remount confirmation",
            ));
        }
        owner.check_directory()
    };
    validate()?;
    let staging = owner.canonical_path.join(REMOUNT_STAGING);
    match staging.symlink_metadata() {
        Ok(metadata) if metadata.is_file() => fs::remove_file(&staging)?,
        Ok(_) => return Err(io::Error::other("remount staging is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&staging)?;
    file.write_all(&serde_json::to_vec(&owner.marker)?)?;
    file.sync_all()?;
    lock::stable(&file, &staging)?;
    validate()?;
    fs::rename(&staging, owner.canonical_path.join(ROOT_MARKER))?;
    // On an uncertain rename/fsync result, stop. The next call re-reads the
    // official marker; it never promotes or trusts an abandoned staging file.
    File::open(&owner.canonical_path)?.sync_all()?;
    owner.validate_current()
}

fn inspect(path: &Path) -> io::Result<(PathBuf, Marker)> {
    let canonical_path = path.canonicalize()?;
    let identity = directory_identity(&canonical_path)?;
    check_layout(&canonical_path)?;
    let marker = read_marker(&canonical_path)?;
    if marker.root_identity != identity
        || directory_identity(&canonical_path)? != identity
        || canonical_path.canonicalize()? != canonical_path
    {
        return Err(io::Error::other("root identity collision"));
    }
    Ok((canonical_path, marker))
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
    /// Initialize a nonexistent or empty disposable directory. Never adopt existing state.
    pub fn create(path: &Path, namespaces: &RootNamespaces) -> io::Result<Self> {
        let path = prepare_directory(path)?;
        if fs::read_dir(&path)?.next().is_some() {
            return Err(io::Error::other(
                "refusing to initialize a nonempty State Root",
            ));
        }
        lock::private_directory(&path)?;
        let identity = directory_identity(&path)?;
        let marker = Marker {
            schema_version: 1,
            kind: "interactive".into(),
            root_id: hex::encode(Sha256::digest(uuid::Uuid::new_v4().as_bytes())),
            root_identity: identity,
        };
        publish(&path, ROOT_MARKER, &serde_json::to_vec(&marker)?)?;
        publish(&path, RUST_ROOT_MARKER, PROTOTYPE)?;
        Self::open(&path, namespaces)
    }

    /// Open only a marked Rust prototype root, rejecting legacy layouts before database access.
    pub fn open(path: &Path, namespaces: &RootNamespaces) -> io::Result<Self> {
        let (canonical_path, marker) = inspect(path)?;
        let owner = Self::acquire(canonical_path, marker, namespaces, false)?;
        owner.validate_current()?;
        Ok(owner)
    }

    /// Acquire an existing Root without creating or repairing coordination state.
    /// Uses the same exclusive ownership protocol as ordinary startup.
    pub fn open_existing(path: &Path, namespaces: &RootNamespaces) -> io::Result<Self> {
        let (canonical_path, marker) = inspect(path)?;
        let owner = Self::acquire(canonical_path, marker, namespaces, true)?;
        owner.validate_current()?;
        Ok(owner)
    }

    fn acquire(
        canonical_path: PathBuf,
        marker: Marker,
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
        Ok(Self {
            canonical_path,
            marker,
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
    pub fn kind(&self) -> &str {
        &self.marker.kind
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
        let marker = read_marker(&self.canonical_path)?;
        self.check_directory()?;
        if marker != self.marker {
            return Err(io::Error::other("root marker identity changed"));
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
        #[cfg(not(windows))]
        let (dev, ino) = lock::identity(&metadata)?;
        #[cfg(windows)]
        let (dev, ino) = {
            let identity = windows::file_identity(directory)?;
            (identity.volume, identity.index)
        };
        let identity = Identity {
            dev: dev.to_string(),
            ino: ino.to_string(),
        };
        if identity != self.marker.root_identity {
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
        if self.canonical_path.canonicalize()? != self.canonical_path
            || directory_identity(&self.canonical_path)? != self.marker.root_identity
        {
            return Err(io::Error::other("root directory identity changed"));
        }
        Ok(())
    }
}

fn directory_identity(path: &Path) -> io::Result<Identity> {
    let metadata = path.symlink_metadata()?;
    if !metadata.is_dir() {
        return Err(io::Error::other("State Root must be a directory"));
    }
    #[cfg(not(windows))]
    let (dev, ino) = lock::identity(&metadata)?;
    #[cfg(windows)]
    let (dev, ino) = {
        let file = windows::open_nofollow(path, false)?;
        let identity = windows::file_identity(&file)?;
        (identity.volume, identity.index)
    };
    Ok(Identity {
        dev: dev.to_string(),
        ino: ino.to_string(),
    })
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

fn read_marker(path: &Path) -> io::Result<Marker> {
    let marker: Marker = serde_json::from_slice(&read_bounded(&path.join(ROOT_MARKER))?)?;
    if marker.schema_version != 1
        || marker.kind != "interactive"
        || marker.root_id.len() != 64
        || !marker
            .root_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(io::Error::other("invalid State Root marker"));
    }
    Ok(marker)
}

fn check_layout(path: &Path) -> io::Result<()> {
    if read_bounded(&path.join(RUST_ROOT_MARKER))? != PROTOTYPE {
        return Err(io::Error::other(
            "not a Rust prototype root; legacy state is unsupported",
        ));
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        let core_file = matches!(
            name.to_str(),
            Some(
                ROOT_MARKER
                    | REMOUNT_STAGING
                    | RUST_ROOT_MARKER
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
