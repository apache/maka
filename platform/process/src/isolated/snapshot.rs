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

#[cfg(unix)]
use maka_sandbox::filesystem::Compiled;
use maka_sandbox::filesystem::Policy;
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::{fs, path::Component};

/// Capture facts, not permissions or content hashes. The immutable baseline
/// owns original bytes; only selected candidates need content hashing later.
/// Per-entry physical clones do not claim a filesystem-wide atomic source cut.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotProof {
    source: PathBuf,
    resource_ref: PathBuf,
    source_identity: FileIdentity,
    baseline_identity: FileIdentity,
    read_policy: Policy,
    files: Vec<SnapshotFile>,
    capture_cost: CaptureCost,
}
impl SnapshotProof {
    pub fn source(&self) -> &Path {
        &self.source
    }
    pub fn resource_ref(&self) -> &Path {
        &self.resource_ref
    }
    pub fn source_identity(&self) -> FileIdentity {
        self.source_identity
    }
    pub fn read_policy(&self) -> &Policy {
        &self.read_policy
    }
    pub fn files(&self) -> &[SnapshotFile] {
        &self.files
    }
    pub(super) fn baseline_identity(&self) -> FileIdentity {
        self.baseline_identity
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileIdentity {
    pub device: u64,
    #[cfg(unix)]
    pub inode: u64,
    #[cfg(windows)]
    pub inode: [u8; 16],
}
#[derive(Clone, Copy, Default, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureCost {
    cow_clones: u64,
    byte_copies: u64,
    copied_bytes: u64,
    logical_file_bytes: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotFile {
    pub relative_path: PathBuf,
    /// Original source mode, not the forced read-only baseline mode.
    pub mode: u32,
    pub identity: FileIdentity,
    pub kind: SnapshotKind,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SnapshotKind {
    File,
    Directory,
    Symlink {
        source_target: PathBuf,
        working_target: PathBuf,
    },
}

#[cfg(windows)]
pub(super) fn capture(
    source: &Path,
    resource: &Path,
    policy: &Policy,
) -> io::Result<SnapshotProof> {
    use super::fs::{copy_tree, identity};
    use maka_event_log::root::windows::open_nofollow;
    let policy = policy.compile().map_err(io::Error::other)?;
    let input = open_nofollow(source, false)?;
    let base = open_nofollow(&resource.join("baseline"), false)?;
    let work = open_nofollow(&resource.join("workspace"), false)?;
    let (files, bytes) = copy_tree(&input, &base, |p| policy.access(&source.join(p)).can_read())
        .map_err(io::Error::other)?;
    for entry in &files {
        let name = entry.relative_path.to_string_lossy().replace('\\', "/");
        if (name.eq_ignore_ascii_case(".git") && !matches!(entry.kind, SnapshotKind::Directory))
            || name.eq_ignore_ascii_case(".git/commondir")
            || name.eq_ignore_ascii_case(".git/objects/info/alternates")
        {
            return Err(unsupported(
                "shared git metadata cannot form an independent snapshot",
            ));
        }
    }
    let (_, working_bytes) = copy_tree(&base, &work, |_| true).map_err(io::Error::other)?;
    if identity(&input)? != identity(&open_nofollow(source, false)?)? {
        return Err(io::Error::other(super::Error::CaptureUnstable(
            source.into(),
        )));
    }
    let count = files
        .iter()
        .filter(|f| matches!(f.kind, SnapshotKind::File))
        .count() as u64;
    Ok(SnapshotProof {
        source: source.into(),
        resource_ref: resource.into(),
        source_identity: identity(&input)?,
        baseline_identity: identity(&base)?,
        read_policy: policy.policy().clone(),
        files,
        capture_cost: CaptureCost {
            cow_clones: 0,
            byte_copies: 2 * count,
            copied_bytes: bytes + working_bytes,
            logical_file_bytes: bytes,
        },
    })
}

#[cfg(unix)]
pub(super) fn capture(
    source: &Path,
    resource: &Path,
    policy: &Policy,
) -> io::Result<SnapshotProof> {
    let policy = policy.compile().map_err(io::Error::other)?;
    let baseline = resource.join("baseline");
    let working = resource.join("workspace");
    let source_meta = fs::metadata(source)?;
    let mut proof = SnapshotProof {
        source: source.into(),
        resource_ref: resource.into(),
        source_identity: identity(&source_meta),
        baseline_identity: identity(&fs::metadata(&baseline)?),
        read_policy: policy.policy().clone(),
        files: Vec::new(),
        capture_cost: CaptureCost::default(),
    };
    copy_directory(
        source,
        &baseline,
        &working,
        Path::new(""),
        &policy,
        &mut proof,
    )?;
    set_mode(&baseline, 0o500)?;
    set_mode(&working, mode(&source_meta))?;
    proof
        .files
        .sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(proof)
}

#[cfg(unix)]
fn copy_directory(
    source: &Path,
    baseline: &Path,
    working: &Path,
    relative: &Path,
    policy: &Compiled,
    proof: &mut SnapshotProof,
) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let relative = relative.join(entry.file_name());
        if !policy.access(&from).can_read() {
            continue;
        }
        let original = fs::symlink_metadata(&from)?;
        if relative == Path::new(".git") && !original.is_dir() {
            return Err(unsupported(
                "linked/shared git metadata cannot form an independent task snapshot",
            ));
        }
        if relative == Path::new(".git/commondir")
            || relative == Path::new(".git/objects/info/alternates")
        {
            return Err(unsupported(
                "git common/alternate stores need an independent snapshot",
            ));
        }
        let base = baseline.join(entry.file_name());
        let work = working.join(entry.file_name());
        let kind = if original.file_type().is_symlink() {
            let source_target = fs::read_link(&from)?;
            let target = normalized_target(&proof.source, &relative, &source_target)?;
            if !policy.access(&target).can_read() {
                continue;
            }
            #[cfg(unix)]
            {
                let target_relative = target
                    .strip_prefix(&proof.source)
                    .map_err(|_| unsupported("workspace symlink targets an external resource"))?;
                // Preserve relative links byte-for-byte. Absolute source links must
                // instead name the corresponding independently owned working entry.
                let working_target = if source_target.is_absolute() {
                    proof.resource_ref.join("workspace").join(target_relative)
                } else {
                    source_target.clone()
                };
                std::os::unix::fs::symlink(&source_target, &base)?;
                std::os::unix::fs::symlink(&working_target, &work)?;
                SnapshotKind::Symlink {
                    source_target,
                    working_target,
                }
            }
            #[cfg(not(unix))]
            return Err(unsupported("snapshot symlinks unavailable"));
        } else if original.is_dir() {
            fs::create_dir(&base)?;
            fs::create_dir(&work)?;
            copy_directory(&from, &base, &work, &relative, policy, proof)?;
            set_mode(&base, 0o500)?;
            set_mode(&work, mode(&original))?;
            SnapshotKind::Directory
        } else if original.is_file() {
            let input = open_file(&from)?;
            if !input.metadata()?.is_file() {
                return Err(io::Error::other("snapshot source changed type"));
            }
            clone_file(&input, &base, &relative, &mut proof.capture_cost)?;
            let base_file = open_file(&base)?;
            proof.capture_cost.logical_file_bytes += base_file.metadata()?.len();
            clone_file(&base_file, &work, &relative, &mut proof.capture_cost)?;
            set_mode(&work, mode(&original))?;
            set_mode(&base, 0o400)?;
            SnapshotKind::File
        } else {
            return Err(unsupported(
                "workspace contains a device, socket or non-snapshot resource",
            ));
        };
        proof.files.push(SnapshotFile {
            relative_path: relative,
            mode: mode(&original),
            identity: identity(&fs::symlink_metadata(&base)?),
            kind,
        });
    }
    Ok(())
}

#[cfg(unix)]
fn clone_file(
    input: &fs::File,
    output: &Path,
    relative: &Path,
    cost: &mut CaptureCost,
) -> io::Result<()> {
    let parent = fs::File::open(output.parent().expect("snapshot entry has a parent"))?;
    let name = output.file_name().expect("snapshot entry has a name");
    match super::fs::copy_file(input, &parent, name, relative).map_err(io::Error::other)? {
        super::fs::Copy::Reflink => cost.cow_clones += 1,
        super::fs::Copy::Bytes(bytes) => {
            cost.byte_copies += 1;
            cost.copied_bytes += bytes;
        }
    }
    Ok(())
}
#[cfg(unix)]
fn open_file(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}
#[cfg(unix)]
fn normalized_target(source: &Path, relative: &Path, target: &Path) -> io::Result<PathBuf> {
    let absolute = if target.is_absolute() {
        target.into()
    } else {
        source
            .join(relative.parent().unwrap_or(Path::new("")))
            .join(target)
    };
    let mut result = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    if !result.starts_with(source) {
        return Err(unsupported(
            "workspace symlink targets an external resource",
        ));
    }
    Ok(result)
}
#[cfg(unix)]
pub(super) fn identity(metadata: &fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}
#[cfg(unix)]
fn mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o777
}
#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}
fn unsupported(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, message)
}
