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

use std::{fs::File, io, path::Path};

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Host log must be private, regular, singly linked, and stably named",
    )
}

pub(super) fn capture(path: &Path) -> io::Result<File> {
    let parent = path.parent().ok_or_else(denied)?;
    maka_event_log::root::private_directory(parent)?;
    open(path, true)?.ok_or_else(denied)
}

pub(super) fn read(path: &Path) -> io::Result<Option<File>> {
    open(path, false)
}

#[cfg(unix)]
pub(super) fn identity(file: &File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
pub(super) fn identity(file: &File) -> io::Result<(u64, u64)> {
    let id = maka_event_log::root::windows::file_identity(file)?;
    Ok((id.volume, id.index))
}

#[cfg(unix)]
fn directory(path: &Path) -> io::Result<File> {
    use std::{
        fs::OpenOptions,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(denied());
    }
    Ok(file)
}

#[cfg(unix)]
fn open(path: &Path, create: bool) -> io::Result<Option<File>> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        },
    };
    let parent = path.parent().ok_or_else(denied)?;
    let directory = match directory(parent) {
        Ok(directory) => directory,
        Err(error) if !create && error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    // The basename is fixed by Source, never accepted from a wire request.
    let name = CString::new("host.stderr.log").map_err(io::Error::other)?;
    let flags = libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | libc::O_CLOEXEC
        | if create {
            libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT
        } else {
            libc::O_RDONLY
        };
    // SAFETY: owned directory FD and NUL-terminated fixed basename; mode is only
    // used for O_CREAT. Relative open pins the checked containing directory.
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags, 0o600) };
    if fd < 0 {
        let error = io::Error::last_os_error();
        if !create && error.kind() == io::ErrorKind::NotFound {
            stable_directory(&directory, parent)?;
            return Ok(None);
        }
        return Err(error);
    }
    // SAFETY: openat returned exactly one new owned FD.
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(denied());
    }
    let mut named = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: live directory/name and correctly sized output storage.
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            named.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstatat initialized the entire record.
    let named = unsafe { named.assume_init() };
    // libc's device ID width differs between macOS and Linux.
    #[allow(clippy::unnecessary_cast)]
    let named_device = named.st_dev as u64;
    if (metadata.dev(), metadata.ino()) != (named_device, named.st_ino) {
        return Err(denied());
    }
    stable_directory(&directory, parent)?;
    Ok(Some(file))
}

#[cfg(unix)]
fn stable_directory(file: &File, path: &Path) -> io::Result<()> {
    let named = directory(path)?;
    if identity(file)? != identity(&named)? {
        return Err(denied());
    }
    Ok(())
}

#[cfg(windows)]
fn directory(path: &Path) -> io::Result<File> {
    use maka_event_log::root::windows::{open_nofollow, validate_private};
    let file = open_nofollow(path, false)?;
    validate_private(&file)?;
    if !file.metadata()?.is_dir() {
        return Err(denied());
    }
    Ok(file)
}

#[cfg(windows)]
fn open(path: &Path, create: bool) -> io::Result<Option<File>> {
    use maka_event_log::root::windows::{file_identity, open_nofollow, validate_private};
    let parent = path.parent().ok_or_else(denied)?;
    let parent_handle = match directory(parent) {
        Ok(file) => file,
        Err(error) if !create && error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let opened = if create {
        append(path)
    } else {
        open_nofollow(path, false)
    };
    let file = match opened {
        Ok(file) => file,
        Err(error) if !create && error.kind() == io::ErrorKind::NotFound => {
            if identity(&parent_handle)? != identity(&directory(parent)?)? {
                return Err(denied());
            }
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    validate_private(&file)?;
    let id = file_identity(&file)?;
    if !file.metadata()?.is_file() || id.links != 1 {
        return Err(denied());
    }
    let named = open_nofollow(path, false)?;
    if identity(&file)? != identity(&named)?
        || identity(&parent_handle)? != identity(&directory(parent)?)?
    {
        return Err(denied());
    }
    Ok(Some(file))
}

#[cfg(windows)]
fn append(path: &Path) -> io::Result<File> {
    use maka_event_log::root::windows::PrivateSecurity;
    use std::{
        os::windows::{ffi::OsStrExt, fs::MetadataExt, io::FromRawHandle},
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FILE_APPEND_DATA, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_ALWAYS,
        },
    };
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let security = PrivateSecurity::current_account()?;
    // SAFETY: owned pathname/private descriptor remain live for CreateFileW;
    // append-only access and shared delete allow readers and replacement.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | FILE_APPEND_DATA,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &security.attributes(),
            OPEN_ALWAYS,
            FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreateFileW transfers one owned handle.
    let file = unsafe { File::from_raw_handle(handle) };
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(denied());
    }
    Ok(file)
}
