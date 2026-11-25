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

#[path = "tree.rs"]
mod tree;
use super::FileIdentity;
use crate::windows::checked;
use maka_event_log::root::windows::{PrivateSecurity, validate_protected_private};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::{self, Write},
    mem::{offset_of, size_of, size_of_val},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::MetadataExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
    ptr,
};
pub(super) use tree::{copy_tree, create_entry, open_relative};
use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as nt},
    Win32::{
        Foundation::{
            GENERIC_READ, GENERIC_WRITE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError,
            UNICODE_STRING,
        },
        Storage::FileSystem::*,
        System::IO::IO_STATUS_BLOCK,
    },
};

fn status(value: i32) -> io::Result<()> {
    if value < 0 {
        // SAFETY: pure mapping from the status returned by the native operation.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(value) } as i32,
        ));
    }
    Ok(())
}

fn component(name: &OsStr) -> io::Result<Vec<u16>> {
    let wide: Vec<_> = name.encode_wide().collect();
    if Path::new(name).file_name() != Some(name)
        || wide.is_empty()
        || wide.iter().any(|c| matches!(*c, 0 | 58 | 47 | 92))
        || wide.len() > (u16::MAX / 2) as usize
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected one Windows file name",
        ));
    }
    Ok(wide)
}

/// The kernel resolves one component relative to the live directory handle.
/// A reparse point is opened as data and refused before returning the handle.
fn open_at(
    parent: &File,
    name: &OsStr,
    access: u32,
    disposition: u32,
    options: u32,
    security: Option<&PrivateSecurity>,
    share: u32,
) -> io::Result<File> {
    let mut wide = component(name)?;
    let bytes = size_of_val(&wide[..]) as u16;
    let name = UNICODE_STRING {
        Buffer: wide.as_mut_ptr(),
        Length: bytes,
        MaximumLength: bytes,
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: security
            .map_or(ptr::null(), |s| s.attributes().lpSecurityDescriptor.cast()),
        ..Default::default()
    };
    let mut handle = ptr::null_mut();
    // SAFETY: the directory, descriptor, name and out parameters live through synchronous create.
    status(unsafe {
        nt::NtCreateFile(
            &mut handle,
            access | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &attributes,
            &mut IO_STATUS_BLOCK::default(),
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            disposition,
            options | nt::FILE_OPEN_REPARSE_POINT | nt::FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    })?;
    // SAFETY: successful NtCreateFile transferred ownership of one file handle.
    let file = unsafe { File::from_raw_handle(handle) };
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "reparse point in task resource",
        ));
    }
    Ok(file)
}
const SHARE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

/// Callers own the enumeration cursor. Concurrent captures open their own
/// directory handles relative to the pinned resource before starting a scan.
pub(in crate::isolated) fn names(directory: &File) -> io::Result<Vec<OsString>> {
    use windows_sys::Win32::Foundation::STATUS_NO_MORE_FILES;
    let mut restart = true;
    let mut buffer = [0u64; 2048];
    let mut result = Vec::new();
    loop {
        let mut block = IO_STATUS_BLOCK::default();
        // SAFETY: the file is synchronous and the aligned buffer outlives the query.
        let code = unsafe {
            nt::NtQueryDirectoryFile(
                directory.as_raw_handle(),
                ptr::null_mut(),
                None,
                ptr::null(),
                &mut block,
                buffer.as_mut_ptr().cast(),
                size_of_val(&buffer) as u32,
                nt::FileNamesInformation,
                false,
                ptr::null(),
                restart,
            )
        };
        restart = false;
        if code == STATUS_NO_MORE_FILES {
            return Ok(result);
        }
        status(code).map_err(|e| io::Error::other(format!("enumerate directory: {e}")))?;
        let mut offset = 0;
        loop {
            // SAFETY: FileNamesInformation returns aligned, linked records ending with offset zero.
            let record = unsafe {
                buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<nt::FILE_NAMES_INFORMATION>()
            };
            let (next, name) = unsafe {
                let count = (*record).FileNameLength as usize / 2;
                (
                    (*record).NextEntryOffset,
                    std::slice::from_raw_parts(
                        ptr::addr_of!((*record).FileName).cast::<u16>(),
                        count,
                    ),
                )
            };
            if name != [46] && name != [46, 46] {
                result.push(OsString::from_wide(name));
            }
            if next == 0 {
                break;
            }
            offset += next as usize;
        }
    }
}

pub(in crate::isolated) fn directory(parent: &File, name: &OsStr) -> io::Result<File> {
    open_at(
        parent,
        name,
        GENERIC_READ,
        nt::FILE_OPEN,
        nt::FILE_DIRECTORY_FILE,
        None,
        SHARE,
    )
}
pub(in crate::isolated) fn read(parent: &File, name: &OsStr, delete: bool) -> io::Result<File> {
    open_at(
        parent,
        name,
        GENERIC_READ | if delete { DELETE } else { 0 },
        nt::FILE_OPEN,
        nt::FILE_NON_DIRECTORY_FILE,
        None,
        SHARE,
    )
}
pub(in crate::isolated) fn create(parent: &File, name: &OsStr) -> io::Result<File> {
    open_at(
        parent,
        name,
        GENERIC_READ | GENERIC_WRITE | DELETE,
        nt::FILE_CREATE,
        nt::FILE_NON_DIRECTORY_FILE,
        Some(&PrivateSecurity::current_account()?),
        SHARE,
    )
}
pub(in crate::isolated) fn mkdir(parent: &File, name: &OsStr) -> io::Result<File> {
    open_at(
        parent,
        name,
        GENERIC_READ,
        nt::FILE_CREATE,
        nt::FILE_DIRECTORY_FILE,
        Some(&PrivateSecurity::current_account()?),
        SHARE,
    )
}
pub(in crate::isolated) fn private_file(file: &File) -> io::Result<()> {
    validate_protected_private(file)?;
    let mut info = FILE_STANDARD_INFO::default();
    // SAFETY: the class, buffer type and size agree, and the handle stays open.
    checked(unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileStandardInfo,
            ptr::from_mut(&mut info).cast(),
            size_of_val(&info) as u32,
        )
    })?;
    if info.NumberOfLinks != 1 || info.Directory {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "private evidence must be a single-link regular file",
        ));
    }
    Ok(())
}
pub(in crate::isolated) fn identity(file: &File) -> io::Result<FileIdentity> {
    let info = maka_sandbox::windows::file_identity(file)?;
    Ok(FileIdentity {
        device: info.VolumeSerialNumber,
        inode: info.FileId.Identifier,
    })
}
pub(in crate::isolated) fn mark_deleted(file: &File) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    // SAFETY: file owns DELETE access and disposition matches FileDispositionInfoEx.
    checked(unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfoEx,
            ptr::from_ref(&disposition).cast(),
            size_of_val(&disposition) as u32,
        )
    })
}
pub(in crate::isolated) fn rename_noreplace(
    file: &File,
    directory: &File,
    name: &OsStr,
) -> io::Result<()> {
    let name = component(name)?;
    let bytes = size_of_val(&name[..]);
    let length = (offset_of!(nt::FILE_RENAME_INFORMATION, FileName) + bytes)
        .max(size_of::<nt::FILE_RENAME_INFORMATION>());
    let mut storage = vec![0usize; length.div_ceil(size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<nt::FILE_RENAME_INFORMATION>();
    // SAFETY: zeroed, pointer-aligned storage fits the header and UTF-16 tail.
    // ReplaceIfExists stays false. Both source and destination parent are held.
    unsafe {
        (*info).RootDirectory = directory.as_raw_handle();
        (*info).FileNameLength = bytes as u32;
        ptr::copy_nonoverlapping(
            name.as_ptr(),
            ptr::addr_of_mut!((*info).FileName).cast(),
            name.len(),
        );
        status(nt::NtSetInformationFile(
            file.as_raw_handle(),
            &mut IO_STATUS_BLOCK::default(),
            info.cast(),
            length as u32,
            nt::FileRenameInformation,
        ))
    }
}
pub(in crate::isolated) fn publish(directory: &File, name: &str, bytes: &[u8]) -> io::Result<()> {
    let mut file = create(directory, OsStr::new(&format!(".{name}.pending")))?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        rename_noreplace(&file, directory, OsStr::new(name))
    })();
    if result.is_err() {
        mark_deleted(&file)?;
    }
    result
}

pub(in crate::isolated) fn ensure_namespace(namespace: &Path) -> io::Result<File> {
    use maka_event_log::root::windows::{create_private_directory, open_nofollow};
    match create_private_directory(namespace) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let parent = open_nofollow(namespace, false)?;
    validate_protected_private(&parent)?;
    Ok(parent)
}

pub(super) fn create_resource(namespace: &Path) -> io::Result<std::path::PathBuf> {
    let parent = ensure_namespace(namespace)?;
    let name = format!("maka-native-task-{}", uuid::Uuid::new_v4());
    let resource = mkdir(&parent, name.as_ref())?;
    // Protected child boundaries never inherit `resource`'s Deny ACE (nor
    // expose `owner`/`launch` during snapshot capture). Only initial HOME
    // subdirectories stay inheritable so `home`'s execution grant propagates.
    for name in ["workspace", "baseline", "tmp", "owner", "launch", "inputs"] {
        mkdir(&resource, name.as_ref())?;
    }
    let home = mkdir(&resource, "home".as_ref())?;
    for path in super::INITIAL_HOME_DIRECTORIES {
        let path = Path::new(path);
        let mut parent = home.try_clone()?;
        for part in path.parent().expect("HOME directory parent").components() {
            parent = directory(&parent, part.as_os_str())?;
        }
        create_entry(
            &parent,
            path.file_name().expect("initial HOME directory"),
            true,
        )?;
    }
    Ok(namespace.join(name))
}

pub(super) fn open_output(parent: &File, name: &OsStr) -> io::Result<File> {
    open_at(
        parent,
        name,
        GENERIC_WRITE,
        nt::FILE_OPEN,
        nt::FILE_NON_DIRECTORY_FILE,
        None,
        SHARE,
    )
}

pub(super) fn read_only_backing(file: &File) -> io::Result<bool> {
    let mut access = nt::FILE_ACCESS_INFORMATION::default();
    // SAFETY: query the granted access mask of this exact backing handle.
    status(unsafe {
        nt::NtQueryInformationFile(
            file.as_raw_handle(),
            &mut IO_STATUS_BLOCK::default(),
            ptr::from_mut(&mut access).cast(),
            size_of_val(&access) as u32,
            nt::FileAccessInformation,
        )
    })?;
    Ok(
        file.metadata()?.is_file()
            && access.AccessFlags & (FILE_WRITE_DATA | FILE_APPEND_DATA) == 0,
    )
}
