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

use crate::{failed, scoped::Authority, write::check_cancelled};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
#[cfg(unix)]
use cap_std::fs::OpenOptionsExt;
use cap_std::fs::{Dir, File, Metadata, OpenOptions};
use maka_agent_facts::tools::ToolError;
use std::{
    ffi::OsString,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tokio_util::sync::CancellationToken;

mod delete;
mod publication;
#[cfg(windows)]
mod windows;

type Identity = (u64, u64);
#[derive(Clone, Copy)]
pub(crate) enum ReadMode {
    None,
    Required,
    Preview,
    Permissions,
}
fn identity(metadata: &Metadata) -> Identity {
    (metadata.dev(), metadata.ino())
}
fn io_error(error: io::Error) -> ToolError {
    ToolError::Io {
        kind: error.kind(),
        message: format!("Write filesystem error: {error}"),
    }
}
fn unknown(error: impl std::fmt::Display) -> ToolError {
    ToolError::OutcomeUnknown(format!("Write may have modified the file: {error}"))
}

pub(crate) struct Target {
    root: Dir,
    relative_parent: PathBuf,
    parent: Dir,
    name: OsString,
    existing: Option<File>,
    managed: bool,
}

impl Target {
    pub(crate) fn capture(
        authority: &Authority,
        path: &Path,
        read: ReadMode,
    ) -> Result<Self, ToolError> {
        let mut error = failed("path is outside the admitted Write roots");
        for route in authority.routes(path)? {
            let (root, managed) = route
                .root
                .authorize_write(&route.relative)
                .map_err(io_error)?;
            match Self::capture_route(root, &route.relative, read, managed) {
                Ok(target) => return Ok(target),
                Err(reason) => error = reason,
            }
        }
        Err(error)
    }

    fn capture_route(
        root: Dir,
        relative: &Path,
        read: ReadMode,
        managed: bool,
    ) -> Result<Self, ToolError> {
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err(failed("Write does not support parent (..) path components"));
        }
        let name = relative
            .file_name()
            .ok_or_else(|| failed("Write requires a file basename"))?
            .to_owned();
        let relative_parent = relative.parent().unwrap_or(Path::new("")).to_owned();
        let parent = open_parent(&root, &relative_parent).map_err(io_error)?;
        let existing = match parent.symlink_metadata(&name) {
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Err(failed("Write supports only regular files, not symlinks"));
                }
                let file = parent
                    .open_with(
                        &name,
                        file_options(false)
                            .read(!matches!(read, ReadMode::None))
                            .write(!matches!(read, ReadMode::Permissions)),
                    )
                    .or_else(|error| {
                        if matches!(read, ReadMode::Preview)
                            && error.kind() == io::ErrorKind::PermissionDenied
                        {
                            parent.open_with(&name, &file_options(false))
                        } else {
                            Err(error)
                        }
                    })
                    .map_err(io_error)?;
                let opened = file.metadata().map_err(io_error)?;
                if !opened.is_file() || identity(&opened) != identity(&metadata) {
                    return Err(failed("Write target changed during capture"));
                }
                if managed && opened.nlink() != 1 {
                    return Err(failed(
                        "Managed writes cannot modify a multiply-linked file",
                    ));
                }
                Some(file)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error(error)),
        };
        Ok(Self {
            root,
            relative_parent,
            parent,
            name,
            existing,
            managed,
        })
    }

    fn visible(&self, expected: Option<Identity>) -> Result<(), ToolError> {
        let routed_parent = open_parent(&self.root, &self.relative_parent).map_err(io_error)?;
        if identity(&routed_parent.dir_metadata().map_err(io_error)?)
            != identity(&self.parent.dir_metadata().map_err(io_error)?)
        {
            return Err(failed("Write parent changed"));
        }
        for parent in [&self.parent, &routed_parent] {
            match (expected, parent.symlink_metadata(&self.name)) {
                (None, Err(error)) if error.kind() == io::ErrorKind::NotFound => {}
                (Some(expected), Ok(metadata))
                    if metadata.is_file()
                        && identity(&metadata) == expected
                        && (!self.managed || metadata.nlink() == 1) => {}
                _ => return Err(failed("Write target changed")),
            }
        }
        Ok(())
    }

    fn validate(&self) -> Result<(), ToolError> {
        let expected = self
            .existing
            .as_ref()
            .map(|file| file.metadata().map(|m| identity(&m)))
            .transpose()
            .map_err(io_error)?;
        self.visible(expected)
    }

    pub(crate) fn prepare(
        &mut self,
        mutation: crate::mutation::Mutation,
        path: &str,
        cancellation: &CancellationToken,
    ) -> Result<(String, serde_json::Value), ToolError> {
        self.validate()?;
        mutation.prepare(self.existing.as_mut(), path, cancellation)
    }

    pub(crate) fn apply(
        mut self,
        bytes: &[u8],
        cancellation: &CancellationToken,
        started: &AtomicBool,
    ) -> Result<(), ToolError> {
        self.validate()?;
        check_cancelled(cancellation)?;
        // From here errors are conservative unknown, except an exclusive create
        // that failed before producing a file. Never reopen an existing target.
        started.store(true, Ordering::SeqCst);
        let mut file = match self.existing.take() {
            Some(file) => file,
            None => match self.parent.open_with(&self.name, &file_options(true)) {
                Ok(file) => file,
                Err(error) => {
                    started.store(false, Ordering::SeqCst);
                    return Err(io_error(error));
                }
            },
        };
        let metadata = file.metadata().map_err(unknown)?;
        if !metadata.is_file() || (self.managed && metadata.nlink() != 1) {
            return Err(unknown("write target changed after admission"));
        }
        file.write_all(bytes).map_err(unknown)?;

        file.set_len(bytes.len() as u64).map_err(unknown)?;
        self.visible(Some(identity(&metadata))).map_err(unknown)?;
        // Cancellation cannot interrupt this drained mutation. A successful
        // write and visibility check establish a known result despite a request.
        Ok(())
    }
}

fn file_options(create: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(create)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK);
    options
}

/// Walk each component through held handles and refuse all symlinks.
fn open_parent(root: &Dir, path: &Path) -> io::Result<Dir> {
    let mut parent = root.try_clone()?;
    for part in path.components() {
        match part {
            Component::CurDir => continue,
            Component::Normal(name) => {
                parent = parent.open_dir_nofollow(name)?;
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "unsupported parent component",
                ));
            }
        }
    }
    Ok(parent)
}
