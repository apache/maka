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

use super::Binding;
use crate::workspace::{invalid, options};
use cap_std::{ambient_authority, fs::Dir};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::Path,
};

pub(super) const OWNER: &str = "maka-owner.json";

pub(super) struct AllocationLock(File);
impl Drop for AllocationLock {
    fn drop(&mut self) {
        // Explicit unlock also releases an open-file-description lock inherited
        // by a concurrent fork, before that child reaches exec/close.
        let _ = self.0.unlock();
    }
}

/// OS releases this lock on crash; no stale PID or lease timeout protocol.
pub(super) fn lock(root: &Path, binding: &Binding) -> io::Result<AllocationLock> {
    let root = Dir::open_ambient_dir(root, ambient_authority())?;
    match root.create_dir(&binding.id) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let path = binding.directory.parent().expect("validated layout");
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(invalid("worktree allocation directory is a symlink"));
    }
    let directory = root.open_dir(&binding.id)?;
    let file = directory
        .open_with(
            "allocation.lock",
            options().read(true).write(true).create(true),
        )?
        .into_std();
    file.try_lock().map_err(io::Error::from)?;
    let lock = AllocationLock(file);
    if !path.join(OWNER).try_exists()? {
        for entry in directory.entries()? {
            if entry?.file_name() != "allocation.lock" {
                return Err(invalid("refusing to adopt an unowned allocation directory"));
            }
        }
    }
    publish(path, binding)?;
    Ok(lock)
}

pub(super) fn publish(directory: &Path, binding: &Binding) -> io::Result<()> {
    let bytes = serde_json::to_vec(binding)?;
    match write_new(&directory.join(OWNER), &bytes) {
        Ok(()) => sync(directory),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => verify(directory, binding),
        Err(e) => Err(e),
    }
}

pub(super) fn verify(directory: &Path, binding: &Binding) -> io::Result<()> {
    if fs::symlink_metadata(directory)?.file_type().is_symlink() {
        return Err(invalid("worktree metadata directory is a symlink"));
    }
    let dir = Dir::open_ambient_dir(directory, ambient_authority())?;
    let mut bytes = Vec::new();
    dir.open_with(OWNER, options().read(true))?
        .read_to_end(&mut bytes)?;
    let owner: Binding = serde_json::from_slice(&bytes)?;
    if owner != *binding {
        return Err(invalid("worktree is owned by another allocation"));
    }
    Ok(())
}

pub(super) fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("metadata path has no parent"))?;
    let dir = Dir::open_ambient_dir(parent, ambient_authority())?;
    let temporary = format!(".maka-{}.tmp", uuid::Uuid::new_v4());
    let mut file = dir.open_with(&temporary, options().write(true).create_new(true))?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        dir.hard_link(&temporary, &dir, path.file_name().expect("file path"))
    })();
    let cleanup = dir.remove_file(&temporary);
    result?;
    cleanup
}

pub(super) fn sync(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(windows)]
    let _ = path;
    Ok(())
}
