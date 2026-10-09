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

//! Where Skills live on this machine, for the actions Desktop's main
//! process runs locally: "Skill locations…" (`listSkillLocations` and
//! `resolveSkillLocation` in apps/desktop/src/main/skill-locations.ts) and
//! "Open SKILL.md" (`resolveSkillOpenPath` in
//! apps/desktop/src/main/skill-open-path.ts).
//!
//! The standard locations are Desktop's `STANDARD_SKILL_LOCATIONS`
//! (packages/core/src/skill-locations.ts), in precedence order, each under
//! the root of its scope: the project's folder, the workspace (the State
//! Root, which the Host scans as its data root), or the home directory. A
//! governance item's `ref` is `<scope>:<source>:<directory>`, so the folder
//! of an installed Skill follows from it. Every check that touches the file
//! system is blocking: call [`inspect_locations`], [`open_location`], and
//! [`resolve_skill_file`] on a background thread.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use shared::copy::Text;
use shared::copy::extensions as copy;

/// How far a path is followed through dangling symlinks before giving up
/// (`MAX_DANGLING_SYMLINK_HOPS`).
const MAX_DANGLING_SYMLINK_HOPS: usize = 32;

/// One of Desktop's standard Skill locations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SkillLocationRef {
    ProjectMaka,
    ProjectAgents,
    WorkspaceLegacy,
    UserMaka,
    UserAgents,
}

/// Whose directory a location is under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    Project,
    Workspace,
    User,
}

impl SkillLocationRef {
    /// Every location, in precedence order.
    pub const ALL: [Self; 5] = [
        Self::ProjectMaka,
        Self::ProjectAgents,
        Self::WorkspaceLegacy,
        Self::UserMaka,
        Self::UserAgents,
    ];

    /// Its `ref`, the prefix of the refs of the Skills found in it.
    pub fn key(self) -> &'static str {
        match self {
            Self::ProjectMaka => "project:maka",
            Self::ProjectAgents => "project:agents",
            Self::WorkspaceLegacy => "workspace:legacy",
            Self::UserMaka => "user:maka",
            Self::UserAgents => "user:agents",
        }
    }

    /// Its name in the Skill locations menu.
    pub fn label(self) -> Text {
        match self {
            Self::ProjectMaka => copy::LOCATION_PROJECT_MAKA,
            Self::ProjectAgents => copy::LOCATION_PROJECT_AGENTS,
            Self::WorkspaceLegacy => copy::LOCATION_WORKSPACE_LEGACY,
            Self::UserMaka => copy::LOCATION_USER_MAKA,
            Self::UserAgents => copy::LOCATION_USER_AGENTS,
        }
    }

    /// The location a `<scope>:<source>` pair names.
    pub fn of(scope: &str, source: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|location| location.key().split_once(':') == Some((scope, source)))
    }

    fn scope(self) -> Scope {
        match self {
            Self::ProjectMaka | Self::ProjectAgents => Scope::Project,
            Self::WorkspaceLegacy => Scope::Workspace,
            Self::UserMaka | Self::UserAgents => Scope::User,
        }
    }

    fn segments(self) -> &'static [&'static str] {
        match self {
            Self::ProjectMaka | Self::UserMaka => &[".maka", "skills"],
            Self::ProjectAgents | Self::UserAgents => &[".agents", "skills"],
            Self::WorkspaceLegacy => &["skills"],
        }
    }
}

/// The roots the locations are under.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SkillRoots {
    /// The project's folder on the Host, when a project is chosen.
    pub project: Option<PathBuf>,
    /// The State Root.
    pub workspace: PathBuf,
    pub home: PathBuf,
}

impl SkillRoots {
    pub fn new(project: Option<PathBuf>, workspace: PathBuf, home: PathBuf) -> Self {
        Self { project, workspace, home }
    }

    fn root(&self, location: SkillLocationRef) -> Option<&Path> {
        match location.scope() {
            Scope::Project => self.project.as_deref(),
            Scope::Workspace => Some(&self.workspace),
            Scope::User => Some(&self.home),
        }
    }

    /// The location's directory, unless it is a project's and no project
    /// is chosen.
    pub fn location_dir(&self, location: SkillLocationRef) -> Option<PathBuf> {
        let mut dir = self.root(location)?.to_path_buf();
        dir.extend(location.segments());
        Some(dir)
    }

    /// The folder of the Skill `skill_ref` names, as Desktop shows it (the
    /// path as joined, symlinks not followed); `None` for a custom
    /// location, a project's without a project, or a ref that is not
    /// `<scope>:<source>:<directory>`.
    pub fn skill_dir(&self, skill_ref: &str) -> Option<PathBuf> {
        let (scope, rest) = skill_ref.split_once(':')?;
        let (source, name) = rest.split_once(':')?;
        let plain = Path::new(name).components().count() == 1
            && matches!(Path::new(name).components().next(), Some(Component::Normal(_)));
        if !plain {
            return None;
        }
        Some(self.location_dir(SkillLocationRef::of(scope, source)?)?.join(name))
    }
}

/// Whether a location's directory can be opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocationStatus {
    Available,
    /// Not there yet; opening it creates it.
    Missing,
    /// A symlink or a file, or a path that leads out of its root.
    BlockedPath,
    ReadFailed,
}

/// A standard location as the Skill locations menu lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SkillLocation {
    pub location: SkillLocationRef,
    /// Its directory, canonical when it (or an ancestor) exists.
    pub path: PathBuf,
    pub status: LocationStatus,
}

/// Why a location did not open (`ResolveSkillLocationResult` reasons).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocationFailure {
    Missing,
    BlockedPath,
    ReadFailed,
    CreateFailed,
}

impl LocationFailure {
    /// Desktop's `openLocationFailures` text.
    pub fn reason(self) -> Text {
        match self {
            Self::Missing => copy::LOCATION_DIR_MISSING,
            Self::BlockedPath => copy::LOCATION_DIR_BLOCKED,
            Self::ReadFailed => copy::LOCATION_DIR_READ_FAILED,
            Self::CreateFailed => copy::LOCATION_CREATE_FAILED,
        }
    }
}

/// Why a SKILL.md did not open (`ResolveSkillOpenPathResult` reasons).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenFailure {
    InvalidId,
    Missing,
    BlockedPath,
    NotFile,
}

impl OpenFailure {
    /// Desktop's `openFailures` text.
    pub fn reason(self) -> Text {
        match self {
            Self::InvalidId => copy::TRY_AGAIN_LATER,
            Self::Missing => copy::OPEN_MISSING,
            Self::BlockedPath => copy::OPEN_BLOCKED,
            Self::NotFile => copy::OPEN_NOT_FILE,
        }
    }
}

/// The standard locations under `roots` (the project's only when a project
/// is chosen), with whether each can be opened.
pub fn inspect_locations(roots: &SkillRoots) -> Vec<SkillLocation> {
    SkillLocationRef::ALL
        .into_iter()
        .filter_map(|location| {
            let root = roots.root(location)?;
            let dir = roots.location_dir(location)?;
            let (status, path) = inspect_directory(root, &dir);
            Some(SkillLocation { location, path: path.unwrap_or(dir), status })
        })
        .collect()
}

/// `inspectDirectory`: the directory `target` under `root`, and its
/// canonical path when there is one.
fn inspect_directory(root: &Path, target: &Path) -> (LocationStatus, Option<PathBuf>) {
    let Ok(root_real) = fs::canonicalize(root) else {
        return (LocationStatus::ReadFailed, None);
    };
    match fs::symlink_metadata(target) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            match canonical_allow_missing(target) {
                Ok(real) if real.starts_with(&root_real) => (LocationStatus::Missing, Some(real)),
                Ok(_) => (LocationStatus::BlockedPath, None),
                Err(_) => (LocationStatus::ReadFailed, None),
            }
        }
        Err(_) => (LocationStatus::ReadFailed, None),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            (LocationStatus::BlockedPath, None)
        }
        Ok(_) => match fs::canonicalize(target) {
            Ok(real) if !real.starts_with(&root_real) => (LocationStatus::BlockedPath, None),
            Ok(real) if readable_dir(&real) => (LocationStatus::Available, Some(real)),
            _ => (LocationStatus::ReadFailed, None),
        },
    }
}

/// Whether the directory can be listed (`opendir`).
#[allow(clippy::disallowed_methods)] // Called only from the background location checks.
fn readable_dir(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok()
}

/// The directory of `location`, created (only this user may open it) when
/// it is missing and `create_if_missing`, for opening in the file manager.
pub fn open_location(
    roots: &SkillRoots,
    location: SkillLocationRef,
    create_if_missing: bool,
) -> Result<PathBuf, LocationFailure> {
    let (Some(root), Some(dir)) = (roots.root(location), roots.location_dir(location)) else {
        return Err(LocationFailure::ReadFailed);
    };
    match inspect_directory(root, &dir) {
        (LocationStatus::Available, Some(path)) => Ok(path),
        (LocationStatus::BlockedPath, _) => Err(LocationFailure::BlockedPath),
        (LocationStatus::Missing, _) if create_if_missing => {
            create_contained_dir(root, &dir).ok_or(LocationFailure::CreateFailed)
        }
        (LocationStatus::Missing, _) => Err(LocationFailure::Missing),
        _ => Err(LocationFailure::ReadFailed),
    }
}

/// `ensureContainedDirectory`: `target` created inside `root`, and its
/// canonical path, unless it would resolve outside `root`.
fn create_contained_dir(root: &Path, target: &Path) -> Option<PathBuf> {
    let root_real = fs::canonicalize(root).ok()?;
    let target_real = canonical_allow_missing(target).ok()?;
    if !target_real.starts_with(&root_real) {
        return None;
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(&target_real).ok()?;
    let metadata = fs::symlink_metadata(target).ok()?;
    let created = fs::canonicalize(target).ok()?;
    (metadata.is_dir() && !metadata.file_type().is_symlink() && created.starts_with(&root_real))
        .then_some(created)
}

/// `realpathAllowMissing`: the canonical path of `target` even when its
/// last segments do not exist yet, following a dangling symlink by hand.
fn canonical_allow_missing(target: &Path) -> std::io::Result<PathBuf> {
    let mut cursor = target.to_path_buf();
    let mut missing = Vec::new();
    let mut hops = 0;
    loop {
        match fs::canonicalize(&cursor) {
            Ok(real) => return Ok(missing.iter().rev().fold(real, |path, name| path.join(name))),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if let Ok(link) = fs::read_link(&cursor) {
                    hops += 1;
                    if hops > MAX_DANGLING_SYMLINK_HOPS {
                        return Err(error);
                    }
                    cursor = cursor.parent().map_or(link.clone(), |parent| parent.join(&link));
                    continue;
                }
                let (Some(parent), Some(name)) = (cursor.parent(), cursor.file_name()) else {
                    return Err(error);
                };
                missing.push(name.to_owned());
                cursor = parent.to_path_buf();
            }
            Err(error) => return Err(error),
        }
    }
}

/// The SKILL.md of the Skill `skill_ref` names, once it is a regular file
/// inside its scope's root (symlinks followed and checked).
pub fn resolve_skill_file(roots: &SkillRoots, skill_ref: &str) -> Result<PathBuf, OpenFailure> {
    if !skill_ref.contains(':') || skill_ref.len() > 512 {
        return Err(OpenFailure::InvalidId);
    }
    let (scope, rest) = skill_ref.split_once(':').ok_or(OpenFailure::InvalidId)?;
    let source = rest.split_once(':').map(|(source, _)| source).ok_or(OpenFailure::Missing)?;
    let location = SkillLocationRef::of(scope, source).ok_or(OpenFailure::Missing)?;
    let root = roots.root(location).ok_or(OpenFailure::Missing)?;
    let dir = roots.skill_dir(skill_ref).ok_or(OpenFailure::Missing)?;
    let root_real = fs::canonicalize(root).map_err(|_| OpenFailure::Missing)?;
    let file = fs::canonicalize(dir.join("SKILL.md")).map_err(|_| OpenFailure::Missing)?;
    if !file.starts_with(&root_real) {
        return Err(OpenFailure::BlockedPath);
    }
    match fs::metadata(&file) {
        Ok(metadata) if metadata.is_file() => Ok(file),
        Ok(_) => Err(OpenFailure::NotFile),
        Err(_) => Err(OpenFailure::Missing),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ref_names_its_skills_folder_under_its_scope() {
        let roots = SkillRoots::new(Some("/work/demo".into()), "/state".into(), "/Users/me".into());
        assert_eq!(
            roots.skill_dir("project:maka:review"),
            Some(PathBuf::from("/work/demo/.maka/skills/review"))
        );
        assert_eq!(
            roots.skill_dir("workspace:legacy:research brief"),
            Some(PathBuf::from("/state/skills/research brief"))
        );
        assert_eq!(
            roots.skill_dir("user:agents:x"),
            Some(PathBuf::from("/Users/me/.agents/skills/x"))
        );
        assert_eq!(roots.skill_dir("custom:0:x"), None);
        assert_eq!(roots.skill_dir("user:maka:../x"), None);
        assert_eq!(roots.skill_dir("user:maka"), None);
        let without_project = SkillRoots::new(None, "/state".into(), "/Users/me".into());
        assert_eq!(without_project.skill_dir("project:maka:review"), None);
        assert_eq!(
            inspect_locations(&without_project).iter().map(|l| l.location).collect::<Vec<_>>(),
            [
                SkillLocationRef::WorkspaceLegacy,
                SkillLocationRef::UserMaka,
                SkillLocationRef::UserAgents
            ]
        );
    }
}
