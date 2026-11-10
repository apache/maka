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

use super::{
    BaselineEntry, BaselineReader, CaptureCost, Error, SnapshotFile, SnapshotProof, TaskOwner,
};
#[cfg(target_os = "macos")]
use super::{FileIdentity, SnapshotKind};
#[cfg(target_os = "macos")]
use std::{collections::BTreeMap, ffi::OsStr, path::PathBuf};
use std::{fs::File, io, path::Path, sync::Arc};

/// Original private working-tree custody, not business completion or Root
/// publication authority. Only the live owner can mint it; paths cannot.
#[derive(Clone)]
pub struct CandidateCapture {
    input: Arc<CaptureInput>,
}
struct CaptureInput {
    resource: File,
    #[cfg(target_os = "macos")]
    working: File,
    proof: SnapshotProof,
}
/// An immutable selected artifact. Each file is an exact physical COW clone.
/// Its inventory is complete for this artifact, not a filesystem-wide atomic
/// cut or proof of all writes at Known, absence of ABA, or producer quiescence.
/// Dropping this handle leaves the protected artifact intact.
pub struct FrozenCandidate {
    input: Arc<CaptureInput>,
    directory: File,
    entries: Vec<SnapshotFile>,
    cost: CaptureCost,
}
impl CandidateCapture {
    #[cfg(target_os = "macos")]
    pub(super) fn from_owner(owner: &TaskOwner) -> Result<Self, Error> {
        let resource = super::evidence::open_resource(&owner.resource)?;
        // Verify the original baseline identity before capturing working custody.
        BaselineReader::from_resource(&resource, owner.snapshot.clone())?;
        let working = directory_at(&resource, OsStr::new("workspace"))?;
        Ok(Self {
            input: Arc::new(CaptureInput {
                resource,
                working,
                proof: owner.snapshot.clone(),
            }),
        })
    }
    #[cfg(not(target_os = "macos"))]
    pub(super) fn from_owner(_: &TaskOwner) -> Result<Self, Error> {
        Err(Error::CaptureUnsupported(
            "physical candidate COW unavailable".into(),
        ))
    }

    /// Caller supplies real Known/current-Root admission. This only freezes
    /// private bytes; it never reads or writes the original shared source.
    /// Observed structural changes fail the whole capture, without retries.
    pub async fn freeze(&self) -> Result<FrozenCandidate, Error> {
        let input = self.input.clone();
        tokio::task::spawn_blocking(move || freeze(input))
            .await
            .map_err(io::Error::other)?
    }
}
impl FrozenCandidate {
    pub fn snapshot(&self) -> &SnapshotProof {
        &self.input.proof
    }
    pub fn entries(&self) -> &[SnapshotFile] {
        &self.entries
    }
    pub fn capture_cost(&self) -> CaptureCost {
        self.cost
    }
    /// Native I/O; call on a blocking worker. No closure or task restart needed.
    pub fn baseline_reader(&self) -> io::Result<BaselineReader> {
        BaselineReader::from_resource(&self.input.resource, self.input.proof.clone())
    }
    /// Read immutable artifact entries only; never follow working-tree paths.
    #[cfg(unix)]
    pub fn open_entry(&self, relative: &Path) -> io::Result<BaselineEntry> {
        super::baseline::open_entry(&self.directory, &self.entries, relative)
    }
    #[cfg(not(unix))]
    pub fn open_entry(&self, _: &Path) -> io::Result<BaselineEntry> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "candidate reader unavailable",
        ))
    }
}
#[cfg(not(target_os = "macos"))]
fn freeze(_: Arc<CaptureInput>) -> Result<FrozenCandidate, Error> {
    Err(Error::CaptureUnsupported(
        "physical candidate COW unavailable".into(),
    ))
}

#[cfg(target_os = "macos")]
#[derive(Eq, PartialEq)]
pub(super) struct Observation {
    pub(super) identity: FileIdentity,
    pub(super) mode: u32,
    pub(super) kind: ObservedKind,
}
#[cfg(target_os = "macos")]
#[derive(Eq, PartialEq)]
pub(super) enum ObservedKind {
    File,
    // Positive structural-activity detection only, not a no-change witness or
    // content-equality shortcut. File content timestamps are never compared.
    Directory { change: (i64, i64) },
    Symlink(PathBuf),
}
#[cfg(target_os = "macos")]
fn freeze(input: Arc<CaptureInput>) -> Result<FrozenCandidate, Error> {
    use rustix::fs::{CloneFlags, Mode, OFlags, fchmod, fclonefileat, mkdirat, symlinkat};
    let before = inventory(&input.working)?;
    let current = directory_at(&input.resource, OsStr::new("workspace"))?;
    ensure(
        &before[Path::new("")],
        &observe_file(&current)?,
        Path::new(""),
    )?;
    let owner = directory_at(&input.resource, OsStr::new("owner"))?;
    // tempfile supplies random create-new names; creation itself is anchored to
    // the original owner FD, not a path-derived publication grant.
    let directory = tempfile::Builder::new()
        .prefix("frozen-")
        .disable_cleanup(true)
        .make_in(input.proof.resource_ref().join("owner"), |path| {
            let name = path
                .file_name()
                .ok_or_else(|| io::Error::other("candidate name"))?;
            mkdirat(&owner, name, Mode::RWXU)?;
            directory_at(&owner, name)
        })?
        .into_file();
    let mut entries = Vec::with_capacity(before.len().saturating_sub(1));
    let mut cost = CaptureCost::default();
    for (relative, original) in &before {
        if relative.as_os_str().is_empty() {
            continue;
        }
        let parent = checked_parent(&input.working, relative, &before)?;
        let destination = parent_at(&directory, relative)?;
        let name = relative
            .file_name()
            .ok_or_else(|| io::Error::other("candidate name"))?;
        let kind = match &original.kind {
            ObservedKind::File => {
                let source: File = rustix::fs::openat(
                    &parent,
                    name,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|e| capture_error(relative, e.into()))?
                .into();
                ensure(original, &observe_file(&source)?, relative)?;
                match fclonefileat(&source, &destination, name, CloneFlags::NOOWNERCOPY) {
                    Ok(()) => {}
                    Err(rustix::io::Errno::XDEV | rustix::io::Errno::OPNOTSUPP) => {
                        return Err(Error::CaptureUnsupported(format!(
                            "no exact physical COW at {}",
                            relative.display()
                        )));
                    }
                    Err(error) => return Err(error.into()),
                }
                let frozen: File = rustix::fs::openat(
                    &destination,
                    name,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                    Mode::empty(),
                )?
                .into();
                let metadata = frozen.metadata()?;
                let cloned = observe_file(&frozen)?;
                if cloned.kind != ObservedKind::File
                    || cloned.mode != original.mode
                    || cloned.identity == original.identity
                {
                    return Err(Error::CaptureUnstable(relative.clone()));
                }
                fchmod(&frozen, Mode::RUSR)?;
                ensure(original, &observe_file(&source)?, relative)?;
                cost.cow_clones += 1;
                cost.logical_file_bytes += metadata.len();
                SnapshotKind::File
            }
            ObservedKind::Directory { .. } => {
                let source = directory_at(&parent, name).map_err(|e| capture_error(relative, e))?;
                ensure(original, &observe_file(&source)?, relative)?;
                mkdirat(&destination, name, Mode::RWXU)?;
                SnapshotKind::Directory
            }
            ObservedKind::Symlink(raw) => {
                ensure(original, &observe_at(&parent, name)?, relative)?;
                let source_target = source_link(&input.proof, relative, raw)?;
                symlinkat(&source_target, &destination, name)?;
                SnapshotKind::Symlink {
                    source_target,
                    working_target: raw.clone(),
                }
            }
        };
        let frozen = observe_at(&destination, name)?;
        entries.push(SnapshotFile {
            relative_path: relative.clone(),
            mode: original.mode,
            identity: frozen.identity,
            kind,
        });
    }
    let after = inventory(&input.working)?;
    if before != after {
        let path = before
            .keys()
            .chain(after.keys())
            .find(|path| before.get(*path) != after.get(*path))
            .cloned()
            .unwrap_or_default();
        return Err(Error::CaptureUnstable(path));
    }
    let current = directory_at(&input.resource, OsStr::new("workspace"))?;
    ensure(
        &before[Path::new("")],
        &observe_file(&current)?,
        Path::new(""),
    )?;
    for entry in entries.iter().rev() {
        if matches!(entry.kind, SnapshotKind::Directory) {
            let parent = parent_at(&directory, &entry.relative_path)?;
            let file = directory_at(
                &parent,
                entry
                    .relative_path
                    .file_name()
                    .ok_or_else(|| io::Error::other("candidate name"))?,
            )?;
            fchmod(&file, Mode::RUSR | Mode::XUSR)?;
        }
    }
    fchmod(&directory, Mode::RUSR | Mode::XUSR)?;
    Ok(FrozenCandidate {
        input,
        directory,
        entries,
        cost,
    })
}

#[cfg(target_os = "macos")]
fn inventory(root: &File) -> Result<BTreeMap<PathBuf, Observation>, Error> {
    let mut entries = BTreeMap::new();
    inventory_directory(root, Path::new(""), &mut entries)?;
    Ok(entries)
}
#[cfg(target_os = "macos")]
fn inventory_directory(
    directory: &File,
    relative: &Path,
    entries: &mut BTreeMap<PathBuf, Observation>,
) -> Result<(), Error> {
    use std::os::unix::ffi::OsStrExt;
    let original = observe_file(directory)?;
    for entry in rustix::fs::Dir::read_from(directory)? {
        let entry = entry?;
        let bytes = entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        let name = OsStr::from_bytes(bytes);
        let path = relative.join(name);
        let observed = observe_at(directory, name).map_err(|e| capture_error(&path, e))?;
        if matches!(observed.kind, ObservedKind::Directory { .. }) {
            let child = directory_at(directory, name).map_err(|e| capture_error(&path, e))?;
            ensure(&observed, &observe_file(&child)?, &path)?;
            inventory_directory(&child, &path, entries)?;
        } else if entries.insert(path.clone(), observed).is_some() {
            return Err(Error::CaptureUnstable(path));
        }
    }
    ensure(&original, &observe_file(directory)?, relative)?;
    if entries.insert(relative.into(), original).is_some() {
        return Err(Error::CaptureUnstable(relative.into()));
    }
    Ok(())
}
#[cfg(target_os = "macos")]
pub(super) fn observe_file(file: &File) -> io::Result<Observation> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    let kind = if metadata.is_file() {
        ObservedKind::File
    } else if metadata.is_dir() {
        ObservedKind::Directory {
            change: (metadata.ctime(), metadata.ctime_nsec()),
        }
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "candidate opened object changed type",
        ));
    };
    Ok(Observation {
        identity: super::snapshot::identity(&metadata),
        mode: metadata.mode() & 0o777,
        kind,
    })
}
#[cfg(target_os = "macos")]
pub(super) fn observe_at(directory: &File, name: &OsStr) -> io::Result<Observation> {
    use rustix::fs::{AtFlags, FileType, readlinkat, statat};
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let stat = statat(directory, name, AtFlags::SYMLINK_NOFOLLOW)?;
    let kind = match FileType::from_raw_mode(stat.st_mode as _) {
        FileType::RegularFile => ObservedKind::File,
        FileType::Directory => ObservedKind::Directory {
            change: (stat.st_ctime, stat.st_ctime_nsec),
        },
        FileType::Symlink => ObservedKind::Symlink(PathBuf::from(OsString::from_vec(
            readlinkat(directory, name, Vec::new())?.into_bytes(),
        ))),
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "candidate contains device, socket or non-file resource",
            ));
        }
    };
    Ok(Observation {
        identity: FileIdentity {
            device: stat.st_dev as u64,
            inode: stat.st_ino,
        },
        mode: stat.st_mode as u32 & 0o777,
        kind,
    })
}
#[cfg(target_os = "macos")]
pub(super) fn directory_at(parent: &File, name: &OsStr) -> io::Result<File> {
    Ok(rustix::fs::openat(
        parent,
        name,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::DIRECTORY
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )?
    .into())
}
#[cfg(target_os = "macos")]
fn parent_at(root: &File, relative: &Path) -> io::Result<File> {
    let mut parent = root.try_clone()?;
    if let Some(path) = relative.parent() {
        for component in path.components() {
            parent = directory_at(&parent, component.as_os_str())?;
        }
    }
    Ok(parent)
}
#[cfg(target_os = "macos")]
fn checked_parent(
    root: &File,
    relative: &Path,
    before: &BTreeMap<PathBuf, Observation>,
) -> Result<File, Error> {
    let mut parent = root.try_clone()?;
    let mut path = PathBuf::new();
    ensure(&before[Path::new("")], &observe_file(&parent)?, &path)?;
    if let Some(ancestors) = relative.parent() {
        for component in ancestors.components() {
            path.push(component.as_os_str());
            parent = directory_at(&parent, component.as_os_str())
                .map_err(|e| capture_error(&path, e))?;
            ensure(
                before
                    .get(&path)
                    .ok_or_else(|| Error::CaptureUnstable(path.clone()))?,
                &observe_file(&parent)?,
                &path,
            )?;
        }
    }
    Ok(parent)
}
#[cfg(target_os = "macos")]
pub(super) fn ensure(
    expected: &Observation,
    actual: &Observation,
    relative: &Path,
) -> Result<(), Error> {
    if expected != actual {
        Err(Error::CaptureUnstable(relative.into()))
    } else {
        Ok(())
    }
}
#[cfg(target_os = "macos")]
pub(super) fn capture_error(relative: &Path, error: io::Error) -> Error {
    match error.raw_os_error() {
        Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP | libc::ESTALE) => {
            Error::CaptureUnstable(relative.into())
        }
        _ if error.kind() == io::ErrorKind::Unsupported => {
            Error::CaptureUnsupported(error.to_string())
        }
        _ => Error::Io(error),
    }
}
#[cfg(target_os = "macos")]
fn source_link(proof: &SnapshotProof, relative: &Path, raw: &Path) -> Result<PathBuf, Error> {
    use std::path::Component;
    if let Ok(index) = proof
        .files()
        .binary_search_by(|e| e.relative_path.as_path().cmp(relative))
    {
        if let SnapshotKind::Symlink {
            source_target,
            working_target,
        } = &proof.files()[index].kind
        {
            if working_target == raw {
                return Ok(source_target.clone());
            }
        }
    }
    let working = proof.resource_ref().join("workspace");
    let (root, target) = if raw.is_absolute() {
        if let Ok(suffix) = raw.strip_prefix(&working) {
            (working.as_path(), proof.source().join(suffix))
        } else if raw.starts_with(proof.source()) {
            (proof.source(), raw.to_owned())
        } else {
            return Err(Error::CaptureUnsupported(
                "candidate symlink targets external resource".into(),
            ));
        }
    } else {
        (working.as_path(), raw.to_owned())
    };
    let absolute = if raw.is_absolute() {
        raw.to_owned()
    } else {
        working
            .join(relative.parent().unwrap_or(Path::new("")))
            .join(raw)
    };
    let mut normalized = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    if !normalized.starts_with(root) {
        return Err(Error::CaptureUnsupported(
            "candidate symlink escapes workspace".into(),
        ));
    }
    Ok(target)
}
