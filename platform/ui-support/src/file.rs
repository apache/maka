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

//! Immutable, file-backed snapshots of user-selected files and clipboard images.
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use maka_capabilities::call::ReadResource;
use maka_plugin_core::contract::binary_resource_type;
use memmap2::Mmap;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Write},
    ops::Range,
    path::Path,
    sync::Arc,
};

#[derive(Clone, Debug, Serialize)]
pub struct FileDescriptor {
    pub name: String,
    pub bytes: usize,
    pub digest: String,
}

#[derive(Debug, thiserror::Error)]
pub enum FileError {
    #[error("selected path is not an absolute regular file")]
    InvalidFile,
    #[error("selected file changed while it was being captured")]
    Changed,
    #[error("selected file snapshot: {0}")]
    Io(#[from] io::Error),
}

/// Resource reads share the transport's 64 KiB chunk size, not a whole-file limit.
pub const FILE_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub struct FileSnapshot {
    mapping: Option<Mmap>,
    _file: File,
    descriptor: FileDescriptor,
}

/// Encoders write directly into a private temporary file. Finished snapshots are read-only.
pub struct FileSnapshotWriter {
    file: File,
    name: String,
    bytes: usize,
    hash: Sha256,
}
impl FileSnapshotWriter {
    pub fn new(name: &str) -> Result<Self, FileError> {
        if name.is_empty() || name.chars().any(char::is_control) {
            return Err(FileError::InvalidFile);
        }
        Ok(Self {
            file: tempfile::tempfile()?,
            name: name.into(),
            bytes: 0,
            hash: Sha256::new(),
        })
    }
    pub fn finish(mut self) -> Result<Arc<FileSnapshot>, FileError> {
        self.file.flush()?;
        let mapping = if self.bytes == 0 {
            None
        } else {
            // SAFETY: the anonymous file is private and its only writable handle moves
            // into this immutable snapshot. No method changes its contents or length.
            Some(unsafe { Mmap::map(&self.file)? })
        };
        Ok(Arc::new(FileSnapshot {
            mapping,
            _file: self.file,
            descriptor: FileDescriptor {
                name: self.name,
                bytes: self.bytes,
                digest: format!("sha256:{}", hex::encode(self.hash.finalize())),
            },
        }))
    }
}
impl Write for FileSnapshotWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = self.file.write(bytes)?;
        self.hash.update(&bytes[..count]);
        self.bytes = self.bytes.checked_add(count).ok_or_else(|| {
            io::Error::other("selected file exceeds the addressable resource range")
        })?;
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}
impl ReadResource for FileSnapshot {
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        binary_resource_type()
    }
    fn bytes(&self) -> usize {
        self.descriptor.bytes
    }
    fn metadata(&self) -> Value {
        serde_json::to_value(&self.descriptor).expect("file descriptor")
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        if range.end > self.bytes()
            || range
                .end
                .checked_sub(range.start)
                .is_none_or(|n| n > FILE_CHUNK_BYTES)
        {
            return Err("invalid file resource range or exceeds 64 KiB".into());
        }
        Ok(self.mapping.as_deref().unwrap_or_default()[range].to_vec())
    }
}

/// Runs in a blocking worker after an explicit native file selection.
pub fn read_selected(path: &Path) -> Result<Arc<FileSnapshot>, FileError> {
    if !path.is_absolute() {
        return Err(FileError::InvalidFile);
    }
    let name = path.file_name().ok_or(FileError::InvalidFile)?;
    let directory = Dir::open_ambient_dir(
        path.parent().ok_or(FileError::InvalidFile)?,
        ambient_authority(),
    )?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = directory.open_with(name, &options)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(FileError::InvalidFile);
    }
    let mut writer = FileSnapshotWriter::new(&name.to_string_lossy())?;
    let bytes = io::copy(&mut file, &mut writer)?;
    let after = file.metadata()?;
    if bytes != metadata.len()
        || after.len() != metadata.len()
        || after.modified().ok() != metadata.modified().ok()
    {
        return Err(FileError::Changed);
    }
    writer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_keep_selected_bytes_after_source_changes_and_allow_empty_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selected.bin");
        std::fs::write(&path, b"original selected bytes").unwrap();
        let snapshot = read_selected(&path).unwrap();
        std::fs::write(&path, b"changed").unwrap();
        assert_eq!(snapshot.bytes(), 23);
        assert_eq!(snapshot.read(0..8).unwrap(), b"original");
        assert_eq!(snapshot.read(9..17).unwrap(), b"selected");

        std::fs::write(&path, b"").unwrap();
        let empty = read_selected(&path).unwrap();
        assert_eq!(empty.bytes(), 0);
        assert_eq!(empty.read(0..0).unwrap(), b"");
        assert_eq!(
            empty.metadata()["digest"],
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
