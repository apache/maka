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

use super::{Binding, Worktrees, ownership};
use crate::workspace::invalid;
use std::{fs, io, path::Path};

const RETIRED: &str = "retired";

impl Worktrees {
    /// Permanently retire an allocation after all users and writers have drained.
    /// Retry after interruption. Keep user branches and commits; the tiny owned
    /// allocation tombstone prevents a stale binding from recreating the checkout.
    pub fn remove(&self, binding: &Binding) -> io::Result<()> {
        self.validate(binding)?;
        let _owner = ownership::lock(&self.root, binding)?;
        let allocation = binding.directory.parent().expect("validated layout");
        let admin = binding.admin();
        let retired = is_retired(binding)?;
        if directory_exists(&admin)? {
            // The owner is removed last. An empty directory is the only valid
            // interruption point after unlinking it and before removing admin.
            if !retired || fs::read_dir(&admin)?.next().is_some() {
                ownership::verify(&admin, binding)?;
            }
        }
        directory_exists(&binding.directory)?;
        directory_exists(&allocation.join("checkout"))?;
        if !retired {
            ownership::write_new(&allocation.join(RETIRED), b"retired\n")?;
            ownership::sync(allocation)?;
        }
        let repo = gix::open::Options::isolated()
            .strict_config(true)
            .open(&binding.common_dir)
            .map_err(io::Error::other)?
            .to_thread_local();
        let base = gix::hash::ObjectId::from_hex(binding.base_commit.as_bytes())
            .map_err(io::Error::other)?;
        for name in [binding.base_ref(), binding.branch()] {
            if let Some(reference) = repo.try_find_reference(&name).map_err(io::Error::other)? {
                // Do not remove a branch the user advanced, or a replaced ref.
                // delete() compares the observed target under the Git ref lock.
                if reference.target() == gix::refs::TargetRef::Object(&base) {
                    reference.delete().map_err(io::Error::other)?;
                }
            }
        }
        remove_directory(&binding.directory)?;
        remove_directory(&allocation.join("checkout"))?;
        remove_file(&allocation.join("checkout-ready"))?;
        if directory_exists(&admin)? {
            for entry in fs::read_dir(&admin)? {
                let entry = entry?;
                if entry.file_name() == ownership::OWNER {
                    continue;
                }
                if entry.file_type()?.is_dir() {
                    fs::remove_dir_all(entry.path())?;
                } else {
                    fs::remove_file(entry.path())?;
                }
            }
            ownership::sync(&admin)?;
            remove_file(&admin.join(ownership::OWNER))?;
            fs::remove_dir(&admin)?;
            ownership::sync(admin.parent().expect("worktree admin parent"))?;
        }
        ownership::sync(allocation)
    }
}

pub(super) fn require_live(binding: &Binding) -> io::Result<()> {
    if is_retired(binding)? {
        Err(invalid("worktree allocation is retired"))
    } else {
        Ok(())
    }
}

fn is_retired(binding: &Binding) -> io::Result<bool> {
    let path = binding
        .directory
        .parent()
        .expect("validated layout")
        .join(RETIRED);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && fs::read(&path)? == b"retired\n" => Ok(true),
        Ok(_) => Err(invalid("invalid worktree retirement marker")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn directory_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(true),
        Ok(_) => Err(invalid("owned worktree directory was replaced")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn remove_directory(path: &Path) -> io::Result<()> {
    if directory_exists(path)? {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

fn remove_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}
