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

//! One complete current-file capture, not a durable artifact or an atomic filesystem snapshot.
use super::*;
use cap_fs_ext::MetadataExt;
use cap_std::fs::Metadata;
use maka_agent_facts::artifact::content_digest;
use std::io::Read;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentFileContent")]
pub enum FileContent {
    Text,
    Image { mime_type: String },
}

/// Bytes stay within this resource's original native worker until delivery ends.
#[derive(Debug)]
pub struct FileSnapshot {
    pub version: String,
    pub digest: String,
    pub content: FileContent,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub enum FileCapture {
    Ready(FileSnapshot),
    Absent,
    Changed,
    Binary { bytes: u64 },
    Unsupported { file_kind: FileKind },
}

pub const MAX_EDIT_BYTES: usize = 2 * 1024 * 1024;

impl Directory {
    /// Read relative to a captured workspace directory, preserving opaque path bytes.
    pub fn read_file(
        &self,
        path: &WorkspacePath,
        expected_version: Option<&str>,
        cancel: &AtomicBool,
    ) -> io::Result<FileCapture> {
        expose(self.capture_file(path, expected_version, cancel))
    }

    fn capture_file(
        &self,
        path: &WorkspacePath,
        expected_version: Option<&str>,
        cancel: &AtomicBool,
    ) -> io::Result<FileCapture> {
        let (directory, name) = match self.file_parent(path, cancel) {
            Ok(parent) => parent,
            Err(reason) if reason.kind() == io::ErrorKind::NotFound => {
                return Ok(FileCapture::Absent);
            }
            Err(reason) => return Err(reason),
        };
        let name = name.as_os_str();
        directory.validate_inner()?;
        let target = directory.anchors.last().expect("file parent anchor");

        let visible = match target.directory.symlink_metadata(name) {
            Ok(value) => value,
            Err(reason) if reason.kind() == io::ErrorKind::NotFound => {
                directory.validate_inner()?;
                return Ok(FileCapture::Absent);
            }
            Err(reason) => return Err(reason),
        };
        let kind = if visible.file_type().is_symlink() {
            FileKind::Symlink
        } else if visible.is_dir() {
            FileKind::Directory
        } else if visible.is_file() {
            FileKind::File
        } else {
            FileKind::Other
        };
        if kind != FileKind::File {
            return Ok(FileCapture::Unsupported { file_kind: kind });
        }
        let mut file = target
            .directory
            .open_with(name, crate::workspace::options().read(true))?;
        let before = file.metadata()?;
        if !same_file(&before, &visible) {
            return Ok(FileCapture::Changed);
        }
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 8192];
        let mut reader = (&mut file).take(before.len());
        while reader.limit() != 0 {
            interrupted(cancel)?;
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                return Ok(FileCapture::Changed);
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
        interrupted(cancel)?;
        let after = file.metadata()?;
        let visible = match target.directory.symlink_metadata(name) {
            Ok(value) => value,
            Err(reason) if reason.kind() == io::ErrorKind::NotFound => {
                return Ok(FileCapture::Changed);
            }
            Err(reason) => return Err(reason),
        };
        directory.validate_inner()?;
        self.validate_inner()?;
        if !same_version(&before, &after)?
            || !same_version(&before, &visible)?
            || bytes.len() as u64 != before.len()
        {
            return Ok(FileCapture::Changed);
        }
        let digest = content_digest(&bytes);
        let version = self.file_version(&directory, path, &before, &digest)?;
        if expected_version.is_some_and(|expected| expected != version) {
            return Ok(FileCapture::Changed);
        }
        let content = if let Ok(mime_type) = crate::image::validate(&bytes) {
            FileContent::Image {
                mime_type: mime_type.into(),
            }
        } else if !bytes.contains(&0) && std::str::from_utf8(&bytes).is_ok() {
            FileContent::Text
        } else {
            return Ok(FileCapture::Binary {
                bytes: bytes.len() as u64,
            });
        };
        interrupted(cancel)?;
        Ok(FileCapture::Ready(FileSnapshot {
            version,
            digest,
            content,
            data: bytes,
        }))
    }

    fn file_parent(
        &self,
        path: &WorkspacePath,
        cancel: &AtomicBool,
    ) -> io::Result<(Self, std::ffi::OsString)> {
        interrupted(cancel)?;
        self.validate_inner()?;
        let relative =
            gix::path::from_bstring(path.bytes().map_err(|_| error("files_invalid_path"))?)
                .map_err(|_| error("files_invalid_path"))?;
        let parent = relative
            .parent()
            .ok_or_else(|| error("files_invalid_path"))?;
        let name = relative
            .file_name()
            .ok_or_else(|| error("files_invalid_path"))?;
        let anchor = self.anchors.last().expect("target anchor");
        let mut directory = Self {
            anchors: vec![Anchor {
                path: anchor.path.clone(),
                directory: anchor.directory.try_clone()?,
                identity: anchor.identity.clone(),
            }],
            relative: self.relative.join(parent),
            private_root: self.private_root.clone(),
            control: self.control.clone(),
            managed: self.managed,
        };
        directory.descend(parent, cancel)?;
        directory.validate_inner()?;
        let target = directory.anchors.last().expect("file parent");
        if directory.excluded_child(&target.path, name) {
            return Err(error("files_private"));
        }
        Ok((directory, name.to_owned()))
    }

    fn file_version(
        &self,
        directory: &Self,
        path: &WorkspacePath,
        metadata: &Metadata,
        digest: &str,
    ) -> io::Result<String> {
        Ok(content_digest(
            &serde_json::to_vec(&(
                self.directory_identity(),
                directory.directory_identity(),
                path,
                metadata.dev(),
                metadata.ino(),
                time(metadata.created().ok()),
                time(metadata.modified().ok()),
                digest,
            ))
            .map_err(io::Error::other)?,
        ))
    }

    /// Replace an existing, single-link text file only while its captured version still matches.
    pub fn save_text(
        &self,
        path: &WorkspacePath,
        expected: &str,
        text: &str,
        policy: Option<&maka_sandbox::filesystem::Compiled>,
        cancel: &AtomicBool,
    ) -> io::Result<Option<String>> {
        use std::io::Write;
        if text.contains('\0') {
            return Err(error("files_invalid_text"));
        }
        let (parent, name) = match self.file_parent(path, cancel) {
            Ok(parent) => parent,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        let target = parent.anchors.last().expect("file parent");
        if policy.is_some_and(|p| {
            !p.access(&target.path.join(&name)).can_write() || !p.access(&target.path).can_write()
        }) {
            return Err(error("files_read_only"));
        }
        let dir = &target.directory;
        let mut opts = crate::workspace::options();
        let meta = match dir.symlink_metadata(&name) {
            Ok(meta) if meta.is_file() && meta.nlink() == 1 => meta,
            Ok(_) => return Ok(None),
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        let original = dir.open_with(&name, opts.read(true).write(true))?;
        if !same_version(&meta, &original.metadata()?)? {
            return Ok(None);
        }
        // A replaced file may be arbitrarily large. The editable capture was bounded.
        if meta.len() > MAX_EDIT_BYTES as u64 || text.len() > MAX_EDIT_BYTES {
            return Err(error("files_edit_size"));
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        (&original).take(meta.len() + 1).read_to_end(&mut bytes)?;
        if self.file_version(&parent, path, &meta, &content_digest(&bytes))? != expected {
            return Ok(None);
        }
        let temporary = format!(".maka-edit-{}", uuid::Uuid::new_v4());
        let mut staged = dir.open_with(
            &temporary,
            crate::workspace::options().write(true).create_new(true),
        )?;
        let apply = (|| {
            staged.write_all(text.as_bytes())?;
            staged.set_permissions(meta.permissions())?;
            let staged_meta = staged.metadata()?;
            let version = self.file_version(
                &parent,
                path,
                &staged_meta,
                &content_digest(text.as_bytes()),
            )?;
            let coordinator = crate::WriteCoordinator::shared();
            let _guard = coordinator
                .mutation
                .lock()
                .map_err(|_| io::Error::other("file writer lock poisoned"))?;
            interrupted(cancel)?;
            self.validate_inner()?;
            parent.validate_inner()?;
            let current = match dir.symlink_metadata(&name) {
                Ok(current) => current,
                Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(err) => return Err(err),
            };
            if current.nlink() != 1
                || !same_version(&meta, &current)?
                || current.permissions() != meta.permissions()
            {
                return Ok(None);
            }
            if !same_version(&staged_meta, &dir.symlink_metadata(&temporary)?)? {
                return Ok(None);
            }
            dir.rename(&temporary, dir, &name)?;
            Ok(Some(version))
        })();
        if !matches!(apply, Ok(Some(_))) {
            dir.remove_file(&temporary)?;
        }
        apply
    }
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.is_file() && right.is_file() && left.dev() == right.dev() && left.ino() == right.ino()
}

fn same_version(left: &Metadata, right: &Metadata) -> io::Result<bool> {
    Ok(same_file(left, right)
        && left.len() == right.len()
        && left.modified()? == right.modified()?
        && left.created().ok() == right.created().ok())
}

fn time(time: Option<cap_std::time::SystemTime>) -> Option<(u64, u32)> {
    time.and_then(|value| value.into_std().duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| (value.as_secs(), value.subsec_nanos()))
}
