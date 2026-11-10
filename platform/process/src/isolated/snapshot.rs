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

use maka_sandbox::filesystem::{Compiled, Policy};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

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
    pub inode: u64,
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
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&source_target, &base)?;
                std::os::unix::fs::symlink(&working_target, &work)?;
            }
            #[cfg(not(unix))]
            return Err(unsupported("snapshot symlinks unavailable"));
            SnapshotKind::Symlink {
                source_target,
                working_target,
            }
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
            clone_file(&input, &base, &mut proof.capture_cost)?;
            let base_file = open_file(&base)?;
            proof.capture_cost.logical_file_bytes += base_file.metadata()?.len();
            clone_file(&base_file, &work, &mut proof.capture_cost)?;
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

/// fclonefileat creates a new inode with independently writable COW contents.
/// Only explicit filesystem/cross-device lack of COW permits a byte copy;
/// permission and other errors remain errors rather than a disguised fallback.
fn clone_file(input: &fs::File, output: &Path, cost: &mut CaptureCost) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let parent = fs::File::open(
            output
                .parent()
                .ok_or_else(|| io::Error::other("clone destination parent"))?,
        )?;
        match rustix::fs::fclonefileat(
            input,
            &parent,
            output
                .file_name()
                .ok_or_else(|| io::Error::other("clone destination name"))?,
            rustix::fs::CloneFlags::NOOWNERCOPY,
        ) {
            Ok(()) => {
                cost.cow_clones += 1;
                return Ok(());
            }
            Err(rustix::io::Errno::XDEV | rustix::io::Errno::OPNOTSUPP) => {}
            Err(error) => return Err(error.into()),
        }
    }
    let mut source = input.try_clone()?;
    let mut destination = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(output)?;
    let bytes = io::copy(&mut source, &mut destination)?;
    cost.byte_copies += 1;
    cost.copied_bytes += bytes;
    Ok(())
}
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
#[cfg(not(unix))]
pub(super) fn identity(_: &fs::Metadata) -> FileIdentity {
    FileIdentity {
        device: 0,
        inode: 0,
    }
}
#[cfg(unix)]
fn mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o777
}
#[cfg(not(unix))]
fn mode(_: &fs::Metadata) -> u32 {
    0
}
#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}
#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) -> io::Result<()> {
    Ok(())
}
fn unsupported(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, message)
}
