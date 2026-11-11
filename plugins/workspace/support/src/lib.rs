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

use maka_agent_api::contract::{Directories, Directory, DirectoryPage, Workspace};
use maka_fs_tools::{
    directory,
    workspace::{self, directory::PublishedDirectory},
};
use maka_host_runtime::DirectoryRootSpec;
use maka_sandbox::workspace::DirectoryIdentity;
use std::{
    path::{Component, Path, PathBuf},
    sync::Arc,
};

pub const PAGE_BYTES: usize = 48 * 1024;

/// Shared file/command preset and immutable Maka protections. Installation
/// ceilings may further restrict commands, but never supply default authority.
pub fn sandbox(
    selected: &Workspace,
    access: maka_agent_api::contract::WorkspaceAccess,
    state_root: &Path,
) -> Result<(maka_sandbox::Sandbox, maka_sandbox::Sandbox), String> {
    use maka_agent_api::contract::WorkspaceAccess;
    use maka_sandbox::{
        Mode, Network, Sandbox,
        filesystem::{Access, Policy},
    };
    let mode = match access {
        WorkspaceAccess::ReadOnly => Mode::ReadOnly,
        WorkspaceAccess::WorkspaceWrite => Mode::WorkspaceWrite,
        WorkspaceAccess::DangerFullAccess => return Ok((Sandbox::Disabled, Sandbox::Disabled)),
    };
    let (base, metadata) = workspace::permissions::resolve(mode, Path::new(&selected.path))
        .map_err(|error| error.to_string())?;
    let private = Sandbox::Managed {
        filesystem: Policy {
            default: Access::Write,
            rules: private_rules(selected, state_root)?,
            deny_globs: vec![],
        },
        network: Network::Allowed,
    };
    let ceiling = metadata
        .intersect(&private)
        .map_err(|error| error.to_string())?;
    let base = base
        .intersect(&ceiling)
        .map_err(|error| error.to_string())?;
    Ok((base, ceiling))
}

/// The native Session record is the authority for the sole exception inside
/// private state. A caller-supplied path can never open this exception.
pub fn private_rules(
    selected: &Workspace,
    state_root: &Path,
) -> Result<Vec<maka_sandbox::filesystem::Rule>, String> {
    use maka_sandbox::filesystem::{Access, Rule};
    let state_root = PathBuf::from(host_path(state_root)?);
    let mut rules = vec![Rule::subtree(&state_root, Access::Deny)];
    if let Some(binding) = &selected.worktree {
        if binding.directory() != Path::new(&selected.path) {
            return Err("agent_workspace_unavailable".into());
        }
        maka_fs_tools::worktree::Worktrees::open(&state_root.join("subagent-worktrees"))
            .and_then(|worktrees| worktrees.inspect(binding))
            .map_err(|_| "agent_workspace_unavailable")?;
        rules.push(Rule::subtree(binding.directory(), Access::Write));
    }
    Ok(rules)
}
#[derive(Clone)]
pub struct Root {
    name: String,
    directory: Arc<PublishedDirectory>,
    temporary: Option<PathBuf>,
}

impl Root {
    pub fn execution_basis(&self) -> std::io::Result<(&Path, DirectoryIdentity, Option<&Path>)> {
        Ok((
            self.directory.path(),
            self.directory.identity()?,
            self.temporary.as_deref(),
        ))
    }

    pub fn validate(&self, path: &Path) -> std::io::Result<()> {
        self.directory.validate(path)?;
        #[cfg(unix)]
        if let Some(protected) = &self.temporary {
            let child = path
                .strip_prefix(self.directory.path())
                .ok()
                .and_then(|relative| relative.components().next())
                .map(|child| self.directory.path().join(child))
                .ok_or(std::io::ErrorKind::PermissionDenied)?;
            if path.starts_with(protected) || !maka_sandbox::is_private_account_directory(&child)? {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
        }
        Ok(())
    }
}

pub fn open(specs: Vec<DirectoryRootSpec>, managed: &Path) -> Result<Vec<Root>, String> {
    let roots: Vec<_> = DirectoryRootSpec::normalize(specs)
        .map_err(|_| "agent_workspace_configuration_invalid")?
        .into_iter()
        .map(|spec| {
            if spec.path.starts_with(managed) {
                return Err("agent_workspace_configuration_invalid".into());
            }
            Ok(Root {
                name: spec.label,
                directory: Arc::new(
                    PublishedDirectory::open(&spec.path)
                        .map_err(|_| "agent_workspace_configuration_invalid")?,
                ),
                temporary: None,
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(roots)
}

pub fn open_projects(specs: Vec<DirectoryRootSpec>, managed: &Path) -> Result<Vec<Root>, String> {
    let roots = open(specs, managed)?;
    #[cfg(unix)]
    let roots = {
        let mut roots = roots;
        if let Some(home) = std::env::home_dir() {
            let namespace =
                maka_sandbox::native_task_namespace().map_err(|error| error.to_string())?;
            add_temporary_workspaces(&mut roots, &home, &std::env::temp_dir(), namespace)?;
        }
        roots
    };
    Ok(roots)
}

/// The default local locations include the account's private scratch directories.
/// The system temporary directory itself is never a selectable workspace.
#[cfg(unix)]
fn add_temporary_workspaces(
    roots: &mut Vec<Root>,
    home: &Path,
    temporary: &Path,
    protected: PathBuf,
) -> Result<(), String> {
    let home = home.canonicalize().map_err(|error| error.to_string())?;
    if !roots.iter().any(|root| root.directory.path() == home) {
        return Ok(());
    }
    let directory = PublishedDirectory::open(temporary).map_err(|error| error.to_string())?;
    if roots
        .iter()
        .any(|root| directory.path().starts_with(root.directory.path()))
    {
        return Ok(());
    }
    roots.push(Root {
        name: "Temporary".into(),
        directory: Arc::new(directory),
        temporary: Some(protected),
    });
    Ok(())
}
/// A directory found within a configured location, with the identity captured
/// as it was opened. Only a `Workspace` the Host persisted carries an identity
/// to the wire; callers name directories by path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Located {
    pub name: String,
    pub path: String,
    pub identity: DirectoryIdentity,
}

/// A caller's path as the directory it names: a leading `~` replaced by `home`,
/// relative paths refused, `.` and `..` resolved before symbolic links are
/// followed. None when nothing is there or the path is not a directory.
pub fn resolve_path(path: &str, home: Option<&Path>) -> Option<PathBuf> {
    let path = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            home?.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(path),
    };
    if !path.is_absolute() {
        return None;
    }
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
    let path = normalized.canonicalize().ok()?;
    path.is_dir().then_some(path)
}

/// The most specific configured location holding the canonical `path`, and
/// the directory as captured there.
fn find<'a>(roots: &'a [Root], path: &Path) -> Option<(&'a Root, Located)> {
    let root = roots
        .iter()
        .filter(|root| path.starts_with(root.directory.path()))
        .max_by_key(|root| root.directory.path().as_os_str().len())?;
    Some((root, capture(root, path)?))
}

/// The directory at `path` under `root`, opened and identified in one step.
/// Identity capture may use O_PATH; browsing also needs a readable directory.
fn capture(root: &Root, path: &Path) -> Option<Located> {
    if path
        .strip_prefix(root.directory.path())
        .ok()?
        .components()
        .any(|part| {
            part.as_os_str()
                .to_str()
                .is_none_or(|s| s.chars().any(char::is_control))
        })
    {
        return None;
    }
    let (path, identity) = directory::capture(path).ok()?;
    directory::open(&path, &identity)
        .and_then(|directory| directory.entries())
        .ok()?;
    root.validate(&path).ok()?;
    let name = if path == root.directory.path() {
        root.name.clone()
    } else {
        path.file_name()?.to_str()?.to_owned()
    };
    Some(Located {
        name,
        path: host_path(&path).ok()?,
        identity,
    })
}
fn host_path(path: &Path) -> Result<String, String> {
    let path = workspace::project::host_path(path).map_err(|_| "agent_directory_invalid")?;
    Ok(path.into())
}
fn entry(located: Located) -> Directory {
    Directory {
        name: located.name,
        path: located.path,
    }
}
fn root_page(roots: &[Root]) -> DirectoryPage {
    DirectoryPage::Roots {
        roots: roots
            .iter()
            .filter_map(|root| capture(root, root.directory.path()))
            .map(entry)
            .collect(),
    }
}
pub fn fits<T: serde::Serialize>(value: &T) -> bool {
    serde_json::to_value(value)
        .is_ok_and(|value| maka_plugin_core::json::check_delivery(&value, PAGE_BYTES).is_ok())
}
pub async fn query(
    roots: Vec<Root>,
    input: Directories,
    home: Option<&Path>,
) -> Result<DirectoryPage, String> {
    query_excluding(roots, input, home, None).await
}
pub async fn query_excluding(
    roots: Vec<Root>,
    input: Directories,
    home: Option<&Path>,
    excluded: Option<PathBuf>,
) -> Result<DirectoryPage, String> {
    let home = home.map(Path::to_owned);
    tokio::task::spawn_blocking(move || {
        let Directories::Children { path, after } = input else {
            return Ok(root_page(&roots));
        };
        let path = resolve_path(&path, home.as_deref()).ok_or("agent_directory_unavailable")?;
        let (root, selected) = find(&roots, &path).ok_or("agent_directory_unavailable")?;
        if excluded
            .as_ref()
            .is_some_and(|excluded| path.starts_with(excluded))
        {
            return Err("agent_directory_unavailable".into());
        }
        if after.as_ref().is_some_and(|name| {
            name.is_empty()
                || name.contains(['/', '\\', '\0'])
                || name.chars().any(char::is_control)
        }) {
            return Err("agent_directory_invalid".into());
        }
        let segments = path
            .strip_prefix(root.directory.path())
            .map_err(|_| "agent_directory_unavailable")?
            .components()
            .map(|part| part.as_os_str().to_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or("agent_directory_invalid")?;
        let mut names: Vec<_> = root
            .directory
            .directory_names(&segments)
            .map_err(|_| "agent_directory_unavailable")?
            .into_iter()
            .filter(|name| {
                !name.chars().any(char::is_control)
                    && after
                        .as_ref()
                        .is_none_or(|cursor| name.encode_utf16().cmp(cursor.encode_utf16()).is_gt())
            })
            .collect();
        if let Some(excluded) = &excluded {
            names.retain(|name| {
                root.directory
                    .resolve(&[segments.clone(), vec![name.clone()]].concat())
                    .is_ok_and(|path| !path.starts_with(excluded))
            });
        }
        let mut children = Vec::new();
        let mut remaining = names.iter();
        for name in remaining.by_ref() {
            let Some(child) = capture(root, &path.join(name)) else {
                continue;
            };
            children.push(entry(child));
            if children.len() == 32 {
                break;
            }
        }
        let mut page = DirectoryPage::Children {
            directory: entry(selected.clone()),
            after: remaining
                .next()
                .is_some()
                .then(|| children.last().expect("nonempty page").name.clone()),
            children,
        };
        while !fits(&page) {
            let DirectoryPage::Children {
                children, after, ..
            } = &mut page
            else {
                unreachable!()
            };
            if children.len() <= 1 {
                break;
            }
            children.pop();
            *after = children.last().map(|child| child.name.clone());
        }
        directory::open(&path, &selected.identity).map_err(|_| "agent_directory_unavailable")?;
        Ok(page)
    })
    .await
    .map_err(|_| "agent_directory_unavailable")?
}

/// The workspace at `path`, with its directory identity captured as the
/// directory is opened and its workspace marker ensured. None is a confirmed
/// pre-effect refusal. Marker initialization errors remain Unknown.
pub async fn initialize(
    roots: &[Root],
    path: &str,
    home: Option<&Path>,
    managed: &Path,
    private_root: &Path,
    control: &Path,
) -> Result<Option<Workspace>, String> {
    let roots = roots.to_vec();
    let path = path.to_owned();
    let home = home.map(Path::to_owned);
    let managed = managed.to_owned();
    let prepared = tokio::task::spawn_blocking(move || {
        let path = resolve_path(&path, home.as_deref())?;
        if path.starts_with(&managed) {
            return None;
        }
        let (root, located) = find(&roots, &path)?;
        let directory = directory::open(&path, &located.identity).ok()?;
        match workspace::read_directory_identity(path.clone(), directory.try_clone().ok()?) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
        Some((root.clone(), path, directory, located.identity))
    })
    .await
    .map_err(|_| "agent_workspace_unavailable")?;
    let Some((published, path, directory, directory_identity)) = prepared else {
        return Ok(None);
    };
    let identity = workspace::ensure_directory_identity(
        path.clone(),
        directory,
        private_root.to_owned(),
        control.to_owned(),
        None,
    )
    .await
    .map_err(|_| "agent_workspace_initialization_failed")?;
    published
        .validate(&path)
        .map_err(|_| "agent_workspace_initialization_failed")?;
    directory::open(&path, &directory_identity)
        .map_err(|_| "agent_workspace_initialization_failed")?;
    Ok(Some(Workspace {
        worktree: None,
        project_id: None,
        path: host_path(&path)?,
        directory_identity,
        identity,
    }))
}
pub async fn validate(roots: &[Root], selected: &Workspace, managed: &Path) -> Result<(), String> {
    open_workspace(roots, selected, managed).await.map(drop)
}

pub async fn open_workspace(
    roots: &[Root],
    selected: &Workspace,
    managed: &Path,
) -> Result<cap_std::fs::Dir, String> {
    let roots = roots.to_vec();
    let selected = selected.clone();
    let managed = managed.to_owned();
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&selected.path)
            .canonicalize()
            .map_err(|_| "agent_workspace_unavailable")?;
        if host_path(&path)? != selected.path {
            return Err("agent_workspace_unavailable".into());
        }
        let authorized = if let Some(binding) = &selected.worktree {
            directory::open(binding.source(), binding.source_identity())
                .map_err(|_| "agent_workspace_unavailable")?;
            if binding.directory() != Path::new(&selected.path) {
                return Err("agent_workspace_unavailable".into());
            }
            maka_fs_tools::worktree::Worktrees::open(&managed)
                .and_then(|worktrees| worktrees.inspect(binding))
                .map_err(|_| "agent_workspace_unavailable")?;
            binding.source()
        } else {
            if path.starts_with(&managed) {
                return Err("agent_workspace_unavailable".into());
            }
            path.as_path()
        };
        let root = roots
            .iter()
            .find(|root| root.validate(authorized).is_ok())
            .ok_or("agent_workspace_unavailable")?;
        let directory = directory::open(&path, &selected.directory_identity)
            .map_err(|_| "agent_workspace_unavailable")?;
        if workspace::read_directory_identity(
            path.clone(),
            directory
                .try_clone()
                .map_err(|_| "agent_workspace_unavailable")?,
        )
        .map_err(|_| "agent_workspace_unavailable")?
            != selected.identity
        {
            return Err("agent_workspace_unavailable".into());
        }
        root.validate(authorized)
            .map_err(|_| "agent_workspace_unavailable")?;
        Ok(directory)
    })
    .await
    .map_err(|_| "agent_workspace_unavailable")?
}

/// Re-observe a published directory without creating a workspace marker.
pub async fn selected(
    roots: Vec<Root>,
    path: &str,
    home: Option<&Path>,
    managed: PathBuf,
) -> Result<Option<Located>, String> {
    resolve(roots, path, home, managed, true)
        .await
        .map(|directory| directory.map(|(located, _)| located))
}
/// A published directory as it is, marker or not; `excluded` and below is
/// not published.
pub async fn observed(
    roots: Vec<Root>,
    path: &str,
    home: Option<&Path>,
    excluded: PathBuf,
) -> Result<Option<Located>, String> {
    resolve(roots, path, home, excluded, false)
        .await
        .map(|directory| directory.map(|(located, _)| located))
}
pub async fn open_directory(
    roots: &[Root],
    selected: &Located,
    excluded: &Path,
) -> Result<cap_std::fs::Dir, String> {
    let (current, directory) = resolve(
        roots.to_vec(),
        &selected.path,
        None,
        excluded.to_owned(),
        false,
    )
    .await?
    .ok_or("agent_directory_unavailable")?;
    if current.path != selected.path || current.identity != selected.identity {
        return Err("agent_directory_unavailable".into());
    }
    Ok(directory)
}
async fn resolve(
    roots: Vec<Root>,
    path: &str,
    home: Option<&Path>,
    excluded: PathBuf,
    workspace_marker: bool,
) -> Result<Option<(Located, cap_std::fs::Dir)>, String> {
    let path = path.to_owned();
    let home = home.map(Path::to_owned);
    tokio::task::spawn_blocking(move || {
        let path = resolve_path(&path, home.as_deref())?;
        if path.starts_with(&excluded) {
            return None;
        }
        let (root, located) = find(&roots, &path)?;
        let directory = directory::open(&path, &located.identity).ok()?;
        if workspace_marker {
            match workspace::read_directory_identity(path.clone(), directory.try_clone().ok()?) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return None,
            }
        }
        root.validate(&path).ok()?;
        Some((located, directory))
    })
    .await
    .map_err(|_| "agent_directory_unavailable".into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn default_home_accepts_private_scratch_workspaces_only() {
        let parent = tempfile::tempdir().unwrap();
        let home = parent.path().join("home");
        let temp = parent.path().join("tmp");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&temp).unwrap();
        let protected = tempfile::tempdir_in(&temp).unwrap();
        let scratch = tempfile::tempdir_in(&temp).unwrap();
        let shared = tempfile::tempdir_in(&temp).unwrap();
        for private in [&protected, &scratch] {
            std::fs::set_permissions(private.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        std::fs::set_permissions(shared.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut roots = open(
            vec![DirectoryRootSpec {
                label: "~".into(),
                path: home.clone(),
            }],
            protected.path(),
        )
        .unwrap();
        add_temporary_workspaces(
            &mut roots,
            &home,
            &temp,
            protected.path().canonicalize().unwrap(),
        )
        .unwrap();

        for (path, available) in [
            (scratch.path(), true),
            (shared.path(), false),
            (protected.path(), false),
            (&temp, false),
        ] {
            let result = selected(
                roots.clone(),
                path.to_str().unwrap(),
                None,
                parent.path().join("managed"),
            )
            .await
            .unwrap();
            assert_eq!(result.is_some(), available, "{}", path.display());
        }
    }
}
