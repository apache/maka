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
use std::fs;
#[cfg(not(windows))]
use std::fs::Metadata;
use std::{
    fs::{File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

/// A stable, exclusively locked file. Never unlink it as part of cleanup.
pub struct FileLease {
    file: File,
    path: PathBuf,
}

impl FileLease {
    /// Observe an existing executor lease without creating or deleting its file.
    /// This is a point-in-time hint, never permission to steal an authority.
    pub fn is_held(path: &Path) -> io::Result<bool> {
        let file = open_regular(path, false)?;
        match file.try_lock().map_err(io::Error::from) {
            Ok(()) => {
                let result = stable(&file, path);
                file.unlock()?;
                result.map(|()| false)
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(true),
            Err(error) => Err(error),
        }
    }

    pub fn acquire(path: &Path) -> io::Result<Self> {
        let file = open_regular(path, true)?;
        Self::lock(file, path)
    }

    /// Acquire the same stable lease without creating or repairing its file.
    pub fn acquire_existing(path: &Path) -> io::Result<Self> {
        let file = open_regular(path, false)?;
        #[cfg(unix)]
        validate_private_file(&file)?;
        Self::lock(file, path)
    }

    fn lock(file: File, path: &Path) -> io::Result<Self> {
        file.try_lock().map_err(io::Error::from)?;
        let lease = Self {
            file,
            path: path.to_owned(),
        };
        lease.validate()?;
        Ok(lease)
    }

    pub fn validate(&self) -> io::Result<()> {
        stable(&self.file, &self.path)
    }
}

#[cfg(unix)]
pub(super) fn identity(metadata: &Metadata) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Ok((metadata.dev(), metadata.ino()))
}

pub(super) fn open_regular(path: &Path, create: bool) -> io::Result<File> {
    open_regular_with(path, create, create)
}

fn open_regular_with(path: &Path, create: bool, write: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(write).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    }
    let file = options.open(path)?;
    stable(&file, path)?;
    Ok(file)
}

#[cfg(not(windows))]
pub(super) fn stable(file: &File, path: &Path) -> io::Result<()> {
    let actual = file.metadata()?;
    let named = path.symlink_metadata()?;
    if !actual.is_file() || !named.is_file() || identity(&actual)? != identity(&named)? {
        return Err(io::Error::other(
            "root authority file was replaced or is not regular",
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn stable(file: &File, path: &Path) -> io::Result<()> {
    let named = super::windows::open_nofollow(path, false)?;
    let actual = super::windows::file_identity(file)?;
    let current = super::windows::file_identity(&named)?;
    if !file.metadata()?.is_file()
        || !named.metadata()?.is_file()
        || (actual.volume, actual.index) != (current.volume, current.index)
    {
        return Err(io::Error::other(
            "root authority file was replaced or is not regular",
        ));
    }
    Ok(())
}

pub(super) fn acquire(path: &Path) -> io::Result<File> {
    let file = open_regular(path, true)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    lock_root(file, path)
}

pub(super) fn acquire_existing(path: &Path) -> io::Result<File> {
    // Linux's original OFD write-range lock requires a write-capable descriptor,
    // even though inspection never writes or repairs the coordination file.
    let file = open_regular_with(path, false, true)?;
    #[cfg(unix)]
    validate_private_file(&file)?;
    lock_root(file, path)
}

fn lock_root(file: File, path: &Path) -> io::Result<File> {
    #[cfg(any(target_os = "macos", windows))]
    file.try_lock().map_err(io::Error::from)?;
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        // Match fs-native-extensions: Linux uses open-file-description range locks.
        let mut lock: libc::flock = unsafe { std::mem::zeroed() };
        lock.l_type = libc::F_WRLCK as _;
        lock.l_whence = libc::SEEK_SET as _;
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_OFD_SETLK, &lock) } == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    stable(&file, path)?;
    Ok(file)
}

#[cfg(unix)]
fn validate_private_file(file: &File) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "existing Root authority file must be private to this account",
        ));
    }
    Ok(())
}

pub(super) fn existing_private_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = path.symlink_metadata().map_err(|error| {
            io::Error::new(
                error.kind(),
                format!(
                    "existing Root coordination directory {}: {error}",
                    path.display()
                ),
            )
        })?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "existing Root coordination directory must be private to this account",
            ));
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        let file = super::windows::open_nofollow(path, false)?;
        if !file.metadata()?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "existing Root coordination directory required",
            ));
        }
        super::windows::validate_private(&file)
    }
}

pub fn private_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
        let metadata = path.symlink_metadata()?;
        if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::other(
                "root authority directory is not owned by this account",
            ));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        for ancestor in path.ancestors().filter(|path| !path.as_os_str().is_empty()) {
            File::open(ancestor)?.sync_all()?;
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        super::windows::private_directory(path)
    }
}
