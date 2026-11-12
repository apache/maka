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

//! Resolve a user's selected project directory without widening a subdirectory
//! to its enclosing repository. Git worktrees share the common-directory identity.

use super::{Workspace, git, invalid};
use std::{
    io,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectKind {
    Folder,
    Git {
        common_dir: PathBuf,
        is_worktree: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedProject {
    pub path: PathBuf,
    pub kind: ProjectKind,
    pub name: String,
}

impl ResolvedProject {
    /// Stable storage key for a resolved location; it is not a workspace UUID.
    pub fn identity(&self) -> io::Result<String> {
        let (prefix, path) = match &self.kind {
            ProjectKind::Folder => ("folder:", &self.path),
            ProjectKind::Git { common_dir, .. } => ("git:", common_dir),
        };
        Ok(format!("{prefix}{}", host_path(path)?))
    }
}

pub async fn resolve_selected(path: &Path) -> io::Result<ResolvedProject> {
    if !path.is_absolute() {
        return Err(invalid("project path must be absolute"));
    }
    // Match the Host's lexical normalization before following symlinks.
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    tokio::task::spawn_blocking(move || {
        let workspace = Workspace::capture(&normalized)?;
        let kind = if git::has_repository(&workspace.path)? {
            let repository = git::discover(&workspace.path)?;
            let root = repository
                .workdir()
                .ok_or_else(|| invalid("selected Git repository has no worktree"))?
                .canonicalize()?;
            if root == workspace.path {
                let common_dir = repository.common_dir().canonicalize()?;
                ProjectKind::Git {
                    is_worktree: repository.git_dir().canonicalize()? != common_dir,
                    common_dir,
                }
            } else {
                ProjectKind::Folder
            }
        } else {
            ProjectKind::Folder
        };
        workspace.validate_directory()?;
        host_path(&workspace.path)?;
        let name = default_name(&workspace.path, &kind)?;
        let resolved = ResolvedProject {
            path: workspace.path,
            kind,
            name,
        };
        resolved.identity()?;
        Ok(resolved)
    })
    .await
    .map_err(io::Error::other)?
}

fn default_name(path: &Path, kind: &ProjectKind) -> io::Result<String> {
    if let ProjectKind::Git { common_dir, .. } = kind {
        let name = if common_dir.file_name().is_some_and(|n| n == ".git") {
            common_dir
                .parent()
                .and_then(Path::file_name)
                .and_then(|n| n.to_str())
        } else {
            common_dir.file_name().and_then(|n| n.to_str())
        };
        if let Some(name) = name {
            let name = if common_dir.file_name().is_some_and(|n| n != ".git")
                && name.to_ascii_lowercase().ends_with(".git")
            {
                &name[..name.len() - 4]
            } else {
                name
            };
            if !name.is_empty() {
                return Ok(name.into());
            }
        }
    }
    Ok(path
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .unwrap_or(host_path(path)?.to_owned()))
}

/// Display/storage spelling excludes Windows' verbatim prefix when possible.
pub fn host_path(path: &Path) -> io::Result<&str> {
    dunce::simplified(path)
        .to_str()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| invalid("project path is not nonempty UTF-8"))
}
