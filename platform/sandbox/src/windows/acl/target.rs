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

use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io,
    mem::size_of,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
    ptr,
};
use uuid::Uuid;
use windows_sys::Win32::{Foundation::INVALID_HANDLE_VALUE, Storage::FileSystem::*};

/// Durable ACL target identity, not a pathname. Recovery reopens the original
/// object after rename and never revokes permissions on a replacement at its
/// former path. Only local volumes supporting persistent file IDs are admitted.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    volume: Uuid,
    serial: u64,
    file: [u8; 16],
}

pub enum Removal {
    Removed,
    InUse,
    Preserved,
}

impl Target {
    pub fn capture(path: &Path) -> io::Result<(Self, File)> {
        Self::capture_shared(
            path,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
        )
    }

    /// Pin a protection boundary against rename/deletion until native execution
    /// settles. Independent executions may retain their own read-shared pins.
    pub fn pin(path: &Path) -> io::Result<(Self, File)> {
        Self::capture_shared(
            path,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
        )
    }

    /// Pin a native filesystem boundary without acquiring ACL mutation rights.
    pub fn pin_read(path: &Path) -> io::Result<(Self, File)> {
        Self::capture_shared(
            path,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            READ_CONTROL | FILE_READ_ATTRIBUTES,
        )
    }

    fn capture_shared(
        path: &Path,
        share: FILE_SHARE_MODE,
        access: FILE_ACCESS_RIGHTS,
    ) -> io::Result<(Self, File)> {
        crate::path::validate(path).map_err(io::Error::other)?;
        let file = OpenOptions::new()
            .access_mode(access)
            .share_mode(share)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        reject_reparse(&file)?;
        let info = identity(&file)?;
        let opened = final_name(&file, VOLUME_NAME_DOS)?;
        let opened = opened.strip_prefix(r"\\?\").unwrap_or(&opened);
        if !crate::path::compare(path, Path::new(opened)).is_eq() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "ACL target changed or contains an unresolved alias",
            ));
        }
        let path = final_name(&file, VOLUME_NAME_GUID)?;
        let volume = path
            .strip_prefix(r"\\?\Volume{")
            .and_then(|rest| rest.split_once(r"}\"))
            .and_then(|(id, _)| id.parse().ok())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    "ACL recovery requires a local volume identity",
                )
            })?;
        let target = Self {
            volume,
            serial: info.VolumeSerialNumber,
            file: info.FileId.Identifier,
        };
        // A file-ID query alone does not prove that this filesystem supports
        // reopening it. Establish that while the original object is still live.
        if target
            .reopen_shared(
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            )?
            .is_none()
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "filesystem cannot recover this object's persistent identity",
            ));
        }
        Ok((target, file))
    }

    /// None means the object has been deleted, not that its volume is offline.
    /// Missing/inaccessible volumes remain errors so the journal stays intact.
    pub fn reopen(&self) -> io::Result<Option<File>> {
        self.reopen_shared(
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )
    }

    /// Remove only the original empty synthetic object. Exclusive write/delete
    /// sharing prevents a concurrent writer from adding data after inspection.
    /// Never recursively deletes, follows a replacement pathname, or removes an
    /// object another execution still pins.
    pub fn remove_empty(&self) -> io::Result<Removal> {
        let pinned = match self.reopen_shared(
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        ) {
            Ok(Some(file)) => file,
            Ok(None) => return Ok(Removal::Removed),
            Err(error) if error.raw_os_error() == Some(32) => return Ok(Removal::InUse),
            Err(error) => return Err(error),
        };
        // Windows rejects disposition changes on an open-by-ID handle. Resolve
        // its current name, then pin that name for deletion and compare IDs.
        // A rename/replacement during this transition is never adopted.
        let name = final_name(&pinned, VOLUME_NAME_GUID)?;
        let file = match OpenOptions::new()
            .access_mode(DELETE | FILE_READ_ATTRIBUTES | READ_CONTROL)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(name)
        {
            Ok(file) => file,
            Err(error)
                if error.raw_os_error() == Some(32) || error.kind() == io::ErrorKind::NotFound =>
            {
                return Ok(Removal::InUse);
            }
            Err(error) => return Err(error),
        };
        reject_reparse(&file)?;
        let current = identity(&file)?;
        if current.VolumeSerialNumber != self.serial || current.FileId.Identifier != self.file {
            return Ok(Removal::InUse);
        }
        let metadata = file.metadata()?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if metadata.is_file() && (metadata.len() != 0 || info.nNumberOfLinks != 1) {
            return Ok(Removal::Preserved);
        }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(32) => Ok(Removal::InUse),
                Some(145) => Ok(Removal::Preserved),
                _ => Err(error),
            };
        }
        drop(file);
        drop(pinned);
        Ok(Removal::Removed)
    }

    fn reopen_shared(&self, access: u32, share: FILE_SHARE_MODE) -> io::Result<Option<File>> {
        let volume = open(
            Path::new(&format!(r"\\?\Volume{{{}}}\", self.volume)),
            FILE_READ_ATTRIBUTES,
        )?;
        if identity(&volume)?.VolumeSerialNumber != self.serial {
            return Err(io::Error::other("ACL recovery volume identity changed"));
        }
        let descriptor = FILE_ID_DESCRIPTOR {
            dwSize: size_of::<FILE_ID_DESCRIPTOR>() as u32,
            Type: ExtendedFileIdType,
            Anonymous: FILE_ID_DESCRIPTOR_0 {
                ExtendedFileId: FILE_ID_128 {
                    Identifier: self.file,
                },
            },
        };
        let handle = unsafe {
            OpenFileById(
                volume.as_raw_handle(),
                &descriptor,
                access,
                share,
                ptr::null(),
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let error = io::Error::last_os_error();
            // NTFS reports a deleted file reference as INVALID_PARAMETER,
            // including for its 64-bit form. Capture already verified this
            // descriptor against a live object; volume errors were checked
            // separately above. Never apply this classification to path opens.
            return if error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(87) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        let file = unsafe { File::from_raw_handle(handle) };
        reject_reparse(&file)?;
        let info = identity(&file)?;
        if info.VolumeSerialNumber != self.serial || info.FileId.Identifier != self.file {
            return Err(io::Error::other("ACL recovery object identity changed"));
        }
        Ok(Some(file))
    }
}

fn open(path: &Path, access: u32) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}
fn reject_reparse(file: &File) -> io::Result<()> {
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "ACL target is a reparse point",
        ));
    }
    Ok(())
}
fn identity(file: &File) -> io::Result<FILE_ID_INFO> {
    let mut identity = FILE_ID_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut identity as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(identity)
}

fn final_name(file: &File, flags: GETFINALPATHNAMEBYHANDLE_FLAGS) -> io::Result<String> {
    let mut name = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            name.as_mut_ptr(),
            name.len() as u32,
            flags,
        )
    } as usize;
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length >= name.len() {
        return Err(io::Error::other("ACL target path exceeds Windows limit"));
    }
    String::from_utf16(&name[..length]).map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_identity_survives_rename_and_does_not_adopt_a_replacement_or_deleted_id() {
        let directory = tempfile::tempdir().unwrap();
        for is_directory in [false, true] {
            let original = directory
                .path()
                .join(if is_directory { "directory" } else { "file" });
            if is_directory {
                std::fs::create_dir(&original).unwrap();
            } else {
                std::fs::write(&original, []).unwrap();
            }
            let (target, file) = Target::capture(&original).unwrap();
            drop(file);
            let moved = original.with_extension("moved");
            std::fs::rename(&original, &moved).unwrap();
            std::fs::write(&original, "replacement").unwrap();
            assert!(target.reopen().unwrap().is_some());
            assert!(matches!(target.remove_empty().unwrap(), Removal::Removed));
            assert!(!moved.exists());
            assert_eq!(std::fs::read_to_string(&original).unwrap(), "replacement");
            assert!(
                target.reopen().unwrap().is_none(),
                "deleted identity must not be recovered"
            );
        }
    }
}
