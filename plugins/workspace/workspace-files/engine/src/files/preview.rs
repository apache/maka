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
        if let Err(reason) = directory.descend(parent, cancel) {
            if reason.kind() == io::ErrorKind::NotFound {
                self.validate_inner()?;
                return Ok(FileCapture::Absent);
            }
            return Err(reason);
        }
        directory.validate_inner()?;
        let target = directory.anchors.last().expect("file parent anchor");
        if directory.excluded_child(&target.path, name) {
            return Err(error("files_private"));
        }
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
        let version = content_digest(
            &serde_json::to_vec(&(
                self.directory_identity(),
                directory.directory_identity(),
                path,
                before.dev(),
                before.ino(),
                time(before.created().ok()),
                time(before.modified().ok()),
                &digest,
            ))
            .map_err(io::Error::other)?,
        );
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
