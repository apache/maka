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

use super::{DiscoveryFailure, ScanError, Source, check_cancelled};
use maka_capabilities::filesystem::ReadError as FileError;
use maka_capabilities::filesystem::ReadViewInput;
use maka_capabilities::filesystem::Reader;
use maka_capabilities::filesystem::Symlinks;
use maka_capabilities::filesystem::entries::Kind;
use maka_capabilities::filesystem::entries::ReadFile;
use std::{
    collections::BTreeSet,
    ffi::{OsStr, OsString},
    io,
    path::{Component, Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

pub(super) struct Captured<'a, 'view> {
    reader: &'a Reader<'view>,
    path: PathBuf,
    files: BTreeSet<OsString>,
}
pub(super) enum EntriesError {
    Scan(ScanError),
    Read(DiscoveryFailure),
}
impl From<FileError> for EntriesError {
    fn from(error: FileError) -> Self {
        match error {
            FileError::Retired => Self::Scan(ScanError::Cancelled),
            FileError::Io(error) => Self::Read(classify(&error)),
            FileError::Invalid(_) => Self::Read(DiscoveryFailure::BlockedPath),
        }
    }
}
pub(crate) enum ReadError {
    Cancelled,
    Failure(DiscoveryFailure),
}
impl<'a, 'view> Captured<'a, 'view> {
    pub(super) fn open(
        source: &Source,
        reader: &'a Reader<'view>,
    ) -> Result<Self, DiscoveryFailure> {
        if source
            .directory
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(DiscoveryFailure::BlockedPath);
        }
        Ok(Self {
            reader,
            path: source.directory.clone(),
            files: BTreeSet::new(),
        })
    }

    pub(super) fn entries(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<Vec<OsString>, EntriesError> {
        let mut names = Vec::new();
        let path =
            portable(&self.path).map_err(|_| EntriesError::Read(DiscoveryFailure::BlockedPath))?;
        let result = self
            .reader
            .visit_directory(&path, Symlinks::Reject, |entry| {
                check_cancelled(cancellation).map_err(|_| FileError::Retired)?;
                let name = OsString::from(entry.name);
                if matches!(entry.kind, Kind::File) {
                    self.files.insert(name.clone());
                }
                names.push(name);
                Ok::<_, FileError>(())
            });
        match result {
            Ok(()) => {}
            Err(FileError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        names.sort();
        Ok(names)
    }

    pub(super) fn read_skill(
        &self,
        name: &OsStr,
        cancellation: &CancellationToken,
    ) -> Result<Option<Vec<u8>>, ReadError> {
        if self.files.contains(name) {
            return Ok(None);
        }
        let directory = self.path.join(name);
        read_view(self.reader, &directory.join("SKILL.md"), cancellation)
    }
}

pub(crate) fn read_view(
    reader: &Reader<'_>,
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<Vec<u8>>, ReadError> {
    check_cancelled(cancellation).map_err(|_| ReadError::Cancelled)?;
    let path = portable(path).map_err(|_| ReadError::Failure(DiscoveryFailure::BlockedPath))?;
    // One capability read opens one regular file and captures its initial prefix.
    // Reopening by pathname for each page could splice atomic replacements.
    let input = ReadViewInput {
        file: ReadFile {
            path,
            offset: 0,
            limit: usize::MAX,
        },
        symlinks: Symlinks::Reject,
    };
    let result = match reader.read(input) {
        Ok(page) if page.next_offset.is_none() => Ok(Some(page.bytes)),
        Ok(_) => Err(ReadError::Failure(DiscoveryFailure::ReadFailed)),
        Err(FileError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(FileError::Io(error)) => Err(read_error(error)),
        Err(FileError::Retired) => Err(ReadError::Cancelled),
        Err(FileError::Invalid(_)) => Err(ReadError::Failure(DiscoveryFailure::BlockedPath)),
    };
    check_cancelled(cancellation).map_err(|_| ReadError::Cancelled)?;
    result
}
fn portable(path: &Path) -> Result<String, ()> {
    path.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| match c {
            Component::Normal(name) => name.to_str().ok_or(()),
            _ => Err(()),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join("/"))
}

fn classify(error: &io::Error) -> DiscoveryFailure {
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ELOOP) {
        return DiscoveryFailure::BlockedPath;
    }
    if matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::NotADirectory
    ) {
        DiscoveryFailure::BlockedPath
    } else {
        DiscoveryFailure::ReadFailed
    }
}
fn read_error(error: io::Error) -> ReadError {
    ReadError::Failure(classify(&error))
}
