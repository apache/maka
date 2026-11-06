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

//! Bounded directory capture. Caller attestations never become filesystem fencing.
use super::*;
use crate::checkpoints::{WorkspaceCapture, WorkspaceEntry, WorkspaceSnapshot};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    path::Path,
};

#[cfg(test)]
thread_local! { pub(super) static AFTER_SCAN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) }; }

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inventory {
    entries: Vec<WorkspaceEntry>,
}

fn relative(path: &str) -> Result<(), StoreError> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\\')
        || path.contains(':')
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.ends_with(['.', ' ']))
    {
        return Err(invalid("nonportable checkpoint workspace path"));
    }
    Ok(())
}

fn excluded(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | ".DS_Store" | "__pycache__" | ".cache" | ".maka-workspace.json"
    )
}

fn secret(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == ".env"
        || name.starts_with(".env.")
            && !matches!(
                name.as_str(),
                ".env.example" | ".env.sample" | ".env.template"
            )
        || matches!(
            name.as_str(),
            ".ssh" | ".aws" | ".gnupg" | "credentials.json" | "id_rsa" | "id_ed25519"
        )
}

fn stamp(meta: &cap_std::fs::Metadata) -> Result<String, StoreError> {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        Ok(format!(
            "{}:{}:{}:{}:{}:{}:{:?}",
            meta.dev(),
            meta.ino(),
            meta.len(),
            meta.mode(),
            meta.ctime(),
            meta.ctime_nsec(),
            meta.modified()?
        ))
    }
    #[cfg(not(unix))]
    {
        Ok(format!(
            "{}:{:?}:{:?}",
            meta.len(),
            meta.file_type(),
            meta.modified()?
        ))
    }
}

fn scan(dir: &Dir, root: &Path) -> Result<BTreeMap<String, String>, StoreError> {
    // The repository controls what belongs to its workspace. The capability
    // handle is still used to open every selected path without following links.
    let walk = ignore::WalkBuilder::new(root)
        .hidden(false)
        .parents(false)
        .git_global(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| {
            entry.depth() == 0
                || entry
                    .file_name()
                    .to_str()
                    .is_none_or(|name| !excluded(name) && !secret(name))
        })
        .build();
    let mut output = BTreeMap::new();
    let mut folded = BTreeSet::new();
    for entry in walk {
        let entry =
            entry.map_err(|error| invalid(format!("checkpoint workspace scan: {error}")))?;
        if let Some(error) = entry.error() {
            return Err(invalid(format!(
                "checkpoint workspace ignore rules: {error}"
            )));
        }
        if entry.depth() == 0 {
            continue;
        }
        let path = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| invalid("checkpoint workspace path escaped root"))?
            .to_str()
            .ok_or_else(|| invalid("non-UTF8 checkpoint workspace path"))?;
        relative(path)?;
        if !folded.insert(path.to_lowercase()) {
            return Err(invalid("checkpoint workspace path collision"));
        }
        let (parent, name) = parent(dir, path)?;
        let metadata = parent.symlink_metadata(&name)?;
        if !metadata.is_dir() && !metadata.is_file() {
            return Err(invalid(
                "checkpoint workspace links and special files are unsupported",
            ));
        }
        output.insert(path.to_owned(), stamp(&metadata)?);
    }
    Ok(output)
}

fn parent(dir: &Dir, path: &str) -> Result<(Dir, String), StoreError> {
    relative(path)?;
    let mut parts = path.split('/').collect::<Vec<_>>();
    let name = parts.pop().unwrap().to_owned();
    let mut current = dir.try_clone()?;
    for part in parts {
        current = current.open_dir_nofollow(part)?;
    }
    Ok((current, name))
}

pub(super) fn capture(
    objects: &Objects,
    request: &Request,
    source: &WorkspaceCapture,
) -> Result<WorkspaceSnapshot, StoreError> {
    if !source.root.is_absolute() || source.identity.is_empty() {
        return Err(invalid("invalid checkpoint workspace binding"));
    }
    let source_path = std::fs::canonicalize(&source.root)?;
    let root_path = objects.owner.canonical_path();
    if source_path.starts_with(root_path) || root_path.starts_with(&source_path) {
        return Err(invalid("checkpoint workspace overlaps state root"));
    }
    let dir = Dir::open_ambient_dir(&source_path, cap_std::ambient_authority())?;
    let before_root = stamp(&dir.dir_metadata()?)?;
    let before = scan(&dir, &source_path)?;
    #[cfg(test)]
    AFTER_SCAN.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
    let mut entries = Vec::new();
    let mut linked = false;
    for (path, expected) in &before {
        objects.owner.validate_current()?;
        let (parent, name) = parent(&dir, path)?;
        let metadata = parent.symlink_metadata(&name)?;
        if stamp(&metadata)? != *expected {
            return Err(invalid("checkpoint workspace changed during capture"));
        }
        if metadata.is_dir() {
            entries.push(WorkspaceEntry::Directory { path: path.clone() });
            continue;
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let mut file = parent.open_with(&name, &options)?;
        if !file.metadata()?.is_file() || stamp(&file.metadata()?)? != *expected {
            return Err(invalid("checkpoint workspace file changed"));
        }
        use sha2::{Digest, Sha256};
        let mut buffer = [0u8; 65536];
        let object = if metadata.len() <= buffer.len() as u64 {
            let mut copied = 0usize;
            loop {
                let n = file.read(&mut buffer[copied..])?;
                if n == 0 {
                    break;
                }
                copied += n;
                if copied as u64 > metadata.len() || copied == buffer.len() {
                    if copied as u64 > metadata.len() {
                        return Err(invalid("checkpoint workspace size limit or source change"));
                    }
                    break;
                }
            }
            let extra = if copied == buffer.len() {
                let mut probe = [0u8; 1];
                file.read(&mut probe)?
            } else {
                0
            };
            if extra != 0
                || copied as u64 != metadata.len()
                || stamp(&file.metadata()?)? != *expected
                || stamp(&parent.symlink_metadata(&name)?)? != *expected
            {
                return Err(invalid("checkpoint workspace changed during capture"));
            }
            let object = ObjectRef {
                digest: hex::encode(Sha256::digest(&buffer[..copied])),
                bytes: copied as u64,
            };
            if !objects.has(&object)? {
                let mut staged = objects.create(request, "workspace-file")?;
                staged.write_all(&buffer[..copied])?;
                staged.sync_all()?;
                drop(staged);
                let staging = objects.staging(request, "workspace-file")?;
                objects.link_staged(&staging, &object)?;
                std::fs::remove_file(staging)?;
                linked = true;
            }
            object
        } else {
            let mut staged = objects.create(request, "workspace-file")?;
            let mut hash = Sha256::new();
            let mut copied = 0u64;
            loop {
                let n = file.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                copied += n as u64;
                if copied > metadata.len() {
                    return Err(invalid("checkpoint workspace size limit or source change"));
                }
                hash.update(&buffer[..n]);
                staged.write_all(&buffer[..n])?;
            }
            if copied != metadata.len()
                || stamp(&file.metadata()?)? != *expected
                || stamp(&parent.symlink_metadata(&name)?)? != *expected
            {
                return Err(invalid("checkpoint workspace changed during capture"));
            }
            let object = ObjectRef {
                digest: hex::encode(hash.finalize()),
                bytes: copied,
            };
            let staging = objects.staging(request, "workspace-file")?;
            if objects.has(&object)? {
                drop(staged);
                std::fs::remove_file(staging)?;
            } else {
                staged.sync_all()?;
                drop(staged);
                objects.link_staged(&staging, &object)?;
                std::fs::remove_file(staging)?;
                linked = true;
            }
            object
        };
        #[cfg(unix)]
        let executable = {
            use cap_std::fs::MetadataExt;
            metadata.mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        entries.push(WorkspaceEntry::File {
            path: path.clone(),
            object,
            executable,
        });
    }
    let after = scan(&dir, &source_path)?;
    let named = Dir::open_ambient_dir(&source.root, cap_std::ambient_authority())?;
    if before != after
        || before_root != stamp(&dir.dir_metadata()?)?
        || before_root != stamp(&named.dir_metadata()?)?
    {
        return Err(invalid("checkpoint workspace changed during capture"));
    }
    if linked {
        objects.sync_objects()?;
    }
    let encoded = serde_json::to_vec(&Inventory { entries })?;
    let mut file = objects.create(request, "workspace")?;
    file.write_all(&encoded)?;
    file.sync_all()?;
    drop(file);
    Ok(WorkspaceSnapshot {
        identity: source.identity.clone(),
        consistency: source.consistency,
        inventory: objects.publish(&objects.staging(request, "workspace")?)?,
    })
}

pub(super) fn inventory(
    objects: &Objects,
    snapshot: &WorkspaceSnapshot,
) -> Result<Vec<WorkspaceEntry>, StoreError> {
    let inventory: Inventory = serde_json::from_reader(objects.read(&snapshot.inventory)?)?;
    let mut paths = BTreeSet::new();
    let mut directories = BTreeSet::new();
    let mut total = 0u64;
    for entry in &inventory.entries {
        let path = match entry {
            WorkspaceEntry::Directory { path } | WorkspaceEntry::File { path, .. } => path,
        };
        relative(path)?;
        // Reject case aliases even when the publishing filesystem happens to allow them.
        if !paths.insert(path.to_lowercase()) {
            return Err(invalid("checkpoint workspace path collision"));
        }
        if let Some((parent, _)) = path.rsplit_once('/')
            && !directories.contains(parent)
        {
            return Err(invalid("checkpoint workspace parent missing"));
        }
        match entry {
            WorkspaceEntry::Directory { path } => {
                directories.insert(path.as_str());
            }
            WorkspaceEntry::File { object, .. } => {
                total = total
                    .checked_add(object.bytes)
                    .ok_or_else(|| invalid("checkpoint workspace size overflow"))?;
            }
        }
    }
    Ok(inventory.entries)
}

pub(super) fn verify(objects: &Objects, snapshot: &WorkspaceSnapshot) -> Result<(), StoreError> {
    for entry in inventory(objects, snapshot)? {
        if let WorkspaceEntry::File { object, .. } = entry {
            objects.read(&object)?;
        }
    }
    Ok(())
}

/// The caller supplies an exclusively owned, empty destination.
pub(super) fn materialize_in(
    objects: &Objects,
    snapshot: &WorkspaceSnapshot,
    dir: &Dir,
) -> Result<(), StoreError> {
    let entries = inventory(objects, snapshot)?;
    if dir.entries()?.next().is_some() {
        return Err(invalid("checkpoint workspace destination is occupied"));
    }
    for entry in entries {
        match entry {
            WorkspaceEntry::Directory { path } => {
                let (parent, name) = parent(dir, &path)?;
                parent.create_dir(&name)?;
            }
            WorkspaceEntry::File {
                path,
                object,
                executable,
            } => {
                let (parent, name) = parent(dir, &path)?;
                let mut source = objects.read(&object)?;
                let mut options = OpenOptions::new();
                options
                    .write(true)
                    .create_new(true)
                    .follow(FollowSymlinks::No);
                #[cfg(unix)]
                {
                    use cap_std::fs::OpenOptionsExt;
                    options.mode(if executable { 0o700 } else { 0o600 });
                }
                #[cfg(not(unix))]
                let _ = executable;
                let mut target = parent.open_with(name, &options)?;
                std::io::copy(&mut source, &mut target)?;
                target.sync_all()?;
            }
        }
    }
    // Persist directory entries from leaves toward the root before publishing readiness.
    fn sync(dir: &Dir) -> Result<(), StoreError> {
        for entry in dir.entries()? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                sync(&dir.open_dir_nofollow(entry.file_name())?)?;
            }
        }
        // cap-std directory handles can be O_PATH on Linux; reopen the same
        // directory for I/O rather than passing a path-only descriptor to fsync.
        dir.open(".")?.sync_all()?;
        Ok(())
    }
    sync(dir)
}
