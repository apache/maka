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

use super::invalid;
use std::{io, path::Path};

pub(crate) fn has_repository(path: &Path) -> io::Result<bool> {
    let Some(directory) = repository_directory(path)? else {
        return Ok(false);
    };
    Ok(!is_empty_metadata_directory(&directory.join(".git"))?)
}

// Empty metadata carries no Git indirection. It can be an uninitialized
// repository or a live native sandbox's mount target, and must not make
// discovery select a different enclosing repository.
pub(crate) fn is_empty_metadata_directory(entry: &Path) -> io::Result<bool> {
    Ok(entry.symlink_metadata()?.is_dir()
        && std::fs::read_dir(entry)?.next().transpose()?.is_none())
}

/// Resolve metadata for ordinary repositories and linked worktrees without
/// executing Git or consulting global configuration. Call on a blocking worker.
pub fn metadata(path: &Path) -> io::Result<Vec<std::path::PathBuf>> {
    let Some(directory) = repository_directory(path)? else {
        return Ok(Vec::new());
    };
    let entry = directory.join(".git");
    if is_empty_metadata_directory(&entry)? {
        return Ok(vec![dunce::canonicalize(entry)?]);
    }
    let repository = discover(directory)?;
    let mut paths = vec![
        dunce::canonicalize(directory.join(".git"))?,
        dunce::canonicalize(repository.git_dir())?,
        dunce::canonicalize(repository.common_dir())?,
    ];
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn repository_directory(path: &Path) -> io::Result<Option<&Path>> {
    for ancestor in path.ancestors() {
        match ancestor.join(".git").symlink_metadata() {
            Ok(_) => return Ok(Some(ancestor)),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

/// Repository-local metadata only: no Git executable, ambient discovery overrides,
/// global configuration or config includes. Handles remain on the blocking worker.
pub(crate) fn discover(path: &Path) -> io::Result<gix::Repository> {
    // Open the nearest entry explicitly: invalid nested metadata must not make
    // discovery silently select a different enclosing repository.
    let directory =
        repository_directory(path)?.ok_or_else(|| invalid("workspace has no Git repository"))?;
    gix::open::Options::isolated()
        .strict_config(true)
        .open(directory)
        .map_err(|error| invalid(&format!("workspace Git discovery failed: {error}")))
}
