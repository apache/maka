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

//! Immutable snapshots of user-selected files and clipboard image encoders.
use crate::budget::{Kind, NativeBudget, Permit};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use maka_capabilities::call::ReadResource;
use maka_plugin_core::contract::binary_resource_type;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{io::Read, ops::Range, path::Path, sync::Arc};

#[derive(Clone, Debug, Serialize)]
pub struct FileDescriptor {
    pub name: String,
    pub bytes: usize,
    pub digest: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum FileError {
    #[error("selected path is not an absolute regular file")]
    InvalidFile,
    #[error("selected file could not be read")]
    ReadFailed,
    #[error("native resource budget exhausted")]
    BudgetExhausted,
}
impl From<crate::budget::BudgetExhausted> for FileError {
    fn from(_: crate::budget::BudgetExhausted) -> Self {
        Self::BudgetExhausted
    }
}

const CHUNK: usize = 64 * 1024;
struct Chunk {
    bytes: Vec<u8>,
    _permit: Permit,
}
/// Contains only immutable bytes, descriptors and allocation permits, no native lease.
pub struct FileSnapshot {
    chunks: Vec<Chunk>,
    descriptor: FileDescriptor,
}

/// Bounded native byte producer. Encoders write directly into the same immutable
/// chunks as a selected file, without a second buffer or temporary file owner.
pub struct FileSnapshotWriter {
    budget: NativeBudget,
    name: String,
    chunks: Vec<Chunk>,
    bytes: usize,
    hash: Sha256,
    error: Option<FileError>,
}
impl FileSnapshotWriter {
    pub fn new(name: &str, budget: NativeBudget) -> Result<Self, FileError> {
        if name.is_empty() || name.chars().any(char::is_control) {
            return Err(FileError::InvalidFile);
        }
        Ok(Self {
            budget,
            name: name.into(),
            chunks: Vec::new(),
            bytes: 0,
            hash: Sha256::new(),
            error: None,
        })
    }
    pub fn finish(self) -> Result<Arc<FileSnapshot>, FileError> {
        if let Some(error) = self.error {
            return Err(error);
        }
        Ok(Arc::new(FileSnapshot {
            chunks: self.chunks,
            descriptor: FileDescriptor {
                name: self.name,
                bytes: self.bytes,
                digest: format!("sha256:{}", hex::encode(self.hash.finalize())),
            },
        }))
    }
    fn write_bytes(&mut self, mut bytes: &[u8]) -> Result<(), FileError> {
        if let Some(error) = self.error {
            return Err(error);
        }
        while !bytes.is_empty() {
            if self
                .chunks
                .last()
                .is_none_or(|chunk| chunk.bytes.len() == CHUNK)
            {
                let permit = self.budget.reserve(Kind::Encoded, CHUNK)?;
                self.chunks.push(Chunk {
                    bytes: Vec::with_capacity(CHUNK),
                    _permit: permit,
                });
            }
            let chunk = self.chunks.last_mut().unwrap();
            let count = (CHUNK - chunk.bytes.len()).min(bytes.len());
            chunk.bytes.extend_from_slice(&bytes[..count]);
            self.hash.update(&bytes[..count]);
            self.bytes += count;
            bytes = &bytes[count..];
        }
        Ok(())
    }
}
impl std::io::Write for FileSnapshotWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        match self.write_bytes(bytes) {
            Ok(()) => Ok(bytes.len()),
            Err(error) => {
                self.error = Some(error);
                Err(std::io::Error::other(error))
            }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
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
        if range.end > self.bytes() || range.end.checked_sub(range.start).is_none_or(|n| n > CHUNK)
        {
            return Err("invalid file resource range or exceeds 64 KiB".into());
        }
        let mut out = Vec::with_capacity(range.end - range.start);
        let mut start = range.start;
        while start < range.end {
            let chunk = &self.chunks[start / CHUNK].bytes;
            let offset = start % CHUNK;
            let count = (chunk.len() - offset).min(range.end - start);
            out.extend_from_slice(&chunk[offset..offset + count]);
            start += count;
        }
        Ok(out)
    }
}
/// Runs only in an admitted original native worker, after actual user selection.
pub fn read_selected(path: &Path, budget: &NativeBudget) -> Result<Arc<FileSnapshot>, FileError> {
    if !path.is_absolute() {
        return Err(FileError::InvalidFile);
    }
    let name = path.file_name().ok_or(FileError::InvalidFile)?;
    let directory = Dir::open_ambient_dir(
        path.parent().ok_or(FileError::InvalidFile)?,
        ambient_authority(),
    )
    .map_err(|_| FileError::ReadFailed)?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = directory
        .open_with(name, &options)
        .map_err(|_| FileError::InvalidFile)?;
    let metadata = file.metadata().map_err(|_| FileError::ReadFailed)?;
    if !metadata.is_file() {
        return Err(FileError::InvalidFile);
    }
    let mut chunks = Vec::new();
    let mut total = 0;
    let mut hash = Sha256::new();
    loop {
        // Probe without an allocation: exact-size and empty files need no extra permit.
        let mut first = [0];
        if file.read(&mut first).map_err(|_| FileError::ReadFailed)? == 0 {
            break;
        }
        let permit = budget.reserve(Kind::Encoded, CHUNK)?;
        let mut bytes = Vec::with_capacity(CHUNK);
        bytes.push(first[0]);
        (&mut file)
            .take((CHUNK - 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| FileError::ReadFailed)?;
        hash.update(&bytes);
        total += bytes.len();
        let last = bytes.len() < CHUNK;
        chunks.push(Chunk {
            bytes,
            _permit: permit,
        });
        if last {
            break;
        }
    }
    let after = file.metadata().map_err(|_| FileError::ReadFailed)?;
    if total as u64 != metadata.len()
        || after.len() != metadata.len()
        || after.modified().ok() != metadata.modified().ok()
    {
        return Err(FileError::ReadFailed);
    }
    Ok(Arc::new(FileSnapshot {
        chunks,
        descriptor: FileDescriptor {
            name: name.to_string_lossy().into_owned(),
            bytes: total,
            digest: format!("sha256:{}", hex::encode(hash.finalize())),
        },
    }))
}
