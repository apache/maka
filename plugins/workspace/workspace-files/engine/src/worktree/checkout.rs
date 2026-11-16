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

use super::{Binding, interrupted, ownership};
use crate::workspace::invalid;
use std::{fs, io, path::Path, sync::atomic::AtomicBool};

/// Features needing independent compatibility work fail before allocating files.
/// Configured external filters are not executed outside Host process ownership.
pub(super) fn supported(repo: &gix::Repository) -> io::Result<()> {
    let config = repo.config_snapshot();
    if config.boolean("core.sparseCheckout") == Some(true)
        || config.plumbing().sections_by_name("filter").is_some()
    {
        return Err(invalid(
            "isolated worktrees do not yet support sparse checkout or external filters",
        ));
    }
    let index = repo
        .index_from_tree(&repo.head_tree_id().map_err(io::Error::other)?)
        .map_err(io::Error::other)?;
    if index
        .entries()
        .iter()
        .any(|e| e.mode == gix::index::entry::Mode::COMMIT)
    {
        return Err(invalid("isolated worktrees do not yet support submodules"));
    }
    Ok(())
}

pub(super) fn materialize(binding: &Binding, cancel: &AtomicBool) -> io::Result<()> {
    let repo = gix::open::Options::isolated()
        .strict_config(true)
        .open(&binding.common_dir)
        .map_err(io::Error::other)?
        .to_thread_local();
    supported(&repo)?;
    let base =
        gix::hash::ObjectId::from_hex(binding.base_commit.as_bytes()).map_err(io::Error::other)?;
    let tree = repo
        .find_object(base)
        .map_err(io::Error::other)?
        .peel_to_tree()
        .map_err(io::Error::other)?
        .id;
    let mut index = repo.index_from_tree(&tree).map_err(io::Error::other)?;
    let allocation = binding.directory.parent().expect("validated layout");
    let admin = binding.admin();
    let staging = allocation.join("checkout");
    let ready = allocation.join("checkout-ready");
    if ready.try_exists()? {
        if fs::read(&ready)? != b"ready\n" || !staging.is_dir() {
            return Err(invalid(
                "published worktree is missing; refusing to reset Session changes",
            ));
        }
        ownership::verify(&admin, binding)?;
        fs::rename(&staging, &binding.directory)?;
        return ownership::sync(allocation);
    }
    if admin.try_exists()? {
        ownership::verify(&admin, binding)?;
    } else {
        fs::create_dir_all(admin.parent().expect("worktrees directory"))?;
        fs::create_dir(&admin)?;
        ownership::publish(&admin, binding)?;
    }
    // Retry interrupted metadata publication without overwriting foreign values.
    metadata(&admin.join("commondir"), &path_line(&binding.common_dir)?)?;
    metadata(
        &admin.join("gitdir"),
        &path_line(&binding.directory.join(".git"))?,
    )?;
    metadata(
        &admin.join("HEAD"),
        format!("ref: {}\n", binding.branch()).as_bytes(),
    )?;
    metadata(&admin.join("locked"), b"Maka Session workspace\n")?;
    ownership::sync(&admin)?;
    // Allocation is a Host operation, not a user commit. It must work without
    // global Git identity and must not alter repository configuration.
    use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit};
    let identity = gix::actor::Signature {
        name: "Maka".into(),
        email: "host@maka.invalid".into(),
        time: gix::date::Time::now_utc(),
    };
    let mut time = Default::default();
    let edits = [binding.base_ref(), binding.branch()]
        .into_iter()
        .map(|reference| {
            Ok(RefEdit {
                name: reference.try_into().map_err(io::Error::other)?,
                deref: false,
                change: Change::Update {
                    log: LogChange {
                        message: "Maka isolated workspace".into(),
                        ..Default::default()
                    },
                    expected: PreviousValue::ExistingMustMatch(gix::refs::Target::Object(base)),
                    new: gix::refs::Target::Object(base),
                },
            })
        })
        .collect::<io::Result<Vec<_>>>()?;
    repo.edit_references_as(edits, Some(identity.to_ref(&mut time)))
        .map_err(io::Error::other)?;
    interrupted(cancel)?;
    reset_candidate(&staging)?;
    fs::create_dir(&staging)?;
    let mut options = repo
        .checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
        .map_err(io::Error::other)?;
    options.destination_is_initially_empty = true;
    options.thread_limit = Some(2);
    let outcome = gix::worktree::state::checkout(
        &mut index,
        &staging,
        repo.objects.clone().into_arc()?,
        &gix::progress::Discard,
        &gix::progress::Discard,
        cancel,
        options,
    )
    .map_err(io::Error::other)?;
    interrupted(cancel)?;
    if !outcome.collisions.is_empty()
        || !outcome.errors.is_empty()
        || !outcome.delayed_paths_unknown.is_empty()
        || !outcome.delayed_paths_unprocessed.is_empty()
    {
        return Err(invalid("isolated checkout did not materialize every file"));
    }
    ownership::write_new(
        &staging.join(".git"),
        format!("gitdir: {}\n", path_text(&admin)?).as_bytes(),
    )?;
    index.set_path(admin.join("index"));
    index.write(Default::default()).map_err(io::Error::other)?;
    ownership::sync(&admin)?;
    ownership::sync(&staging)?;
    ownership::write_new(&ready, b"ready\n")?;
    ownership::sync(allocation)?;
    fs::rename(&staging, &binding.directory)?;
    ownership::sync(allocation)
}

fn metadata(path: &Path, bytes: &[u8]) -> io::Result<()> {
    match ownership::write_new(path, bytes) {
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            if fs::symlink_metadata(path)?.file_type().is_symlink() || fs::read(path)? != bytes {
                return Err(invalid("unpublished worktree metadata changed"));
            }
            Ok(())
        }
        other => other,
    }
}

fn reset_candidate(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => fs::remove_dir_all(path),
        Ok(_) => Err(invalid(
            "unexpected entry in unpublished worktree allocation",
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
fn path_text(path: &Path) -> io::Result<&str> {
    path.to_str()
        .filter(|s| !s.contains(['\r', '\n']))
        .ok_or_else(|| invalid("Git metadata requires a UTF-8 path without newlines"))
}
fn path_line(path: &Path) -> io::Result<Vec<u8>> {
    Ok(format!("{}\n", path_text(path)?).into_bytes())
}
