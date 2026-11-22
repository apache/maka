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

use super::{PrivateSecurity, checked, validate_private, wide};
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
};
use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    GetFileInformationByHandle, MOVEFILE_WRITE_THROUGH, MoveFileExW, READ_CONTROL, WRITE_DAC,
};

/// Exclusive creation with an explicit account owner, including under elevated
/// tokens whose default object owner can be the Administrators group.
pub fn create_private_file(path: &Path) -> io::Result<File> {
    let security = PrivateSecurity::current_account()?;
    let name = wide(path.as_os_str())?;
    // SAFETY: inputs live for the call; CREATE_NEW cannot follow an existing entry.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &security.attributes(),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreateFileW transfers one owned handle to File.
    let file = unsafe { File::from_raw_handle(handle) };
    validate_private(&file)?;
    Ok(file)
}

/// Same volume/file-index representation used by Node's bigint stat on Windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub volume: u64,
    pub index: u64,
    pub links: u32,
}

/// Windows has no portable directory fsync. Publish a previously flushed marker
/// with a write-through rename; omitting REPLACE_EXISTING preserves no-clobber.
pub fn publish_file(source: &Path, target: &Path) -> io::Result<()> {
    let source = wide(source.as_os_str())?;
    let target = wide(target.as_os_str())?;
    // SAFETY: both paths are NUL-terminated and live for the synchronous call.
    checked(unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) })
}
pub fn file_identity(file: &File) -> io::Result<FileIdentity> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: valid held handle, correctly sized writable information record.
    checked(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) })?;
    Ok(FileIdentity {
        volume: u64::from(info.dwVolumeSerialNumber),
        index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        links: info.nNumberOfLinks,
    })
}

fn reject_reparse(file: &File) -> io::Result<()> {
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "reparse points are not authority objects",
        ))
    } else {
        Ok(())
    }
}

/// Opens the named entry itself, including directories, refusing reparse points.
pub fn open_nofollow(path: &Path, write: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(write)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    reject_reparse(&file)?;
    Ok(file)
}

/// Create the final directory with a private ACL atomically. An existing
/// current-account directory may be tightened, never adopted from another owner.
pub fn private_directory(path: &Path) -> io::Result<()> {
    let security = PrivateSecurity::current_account()?;
    if let Err(error) = create_directory(path, &security)
        && error.kind() != io::ErrorKind::AlreadyExists
    {
        return Err(error);
    }
    let file = open_directory(path)?;
    security.restrict(&file).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("private directory {}: {error}", path.display()),
        )
    })
}

/// Create a new private directory; never change an existing entry.
pub fn create_private_directory(path: &Path) -> io::Result<()> {
    let security = PrivateSecurity::current_account()?;
    create_directory(path, &security)?;
    validate_private(&open_directory(path)?)
}

fn create_directory(path: &Path, security: &PrivateSecurity) -> io::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let path_wide = wide(path.as_os_str())?;
    // SAFETY: pathname and descriptor remain valid for this synchronous call.
    checked(unsafe { CreateDirectoryW(path_wide.as_ptr(), &security.attributes()) })
}

fn open_directory(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .access_mode(READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    reject_reparse(&file)?;
    if !file.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private directory required",
        ));
    }
    Ok(file)
}
