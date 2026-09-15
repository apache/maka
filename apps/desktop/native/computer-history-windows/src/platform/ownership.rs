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

use crate::control::{Result, validate_home, validate_local_drive};
use std::{
    ffi::OsString,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Component, Path, PathBuf, Prefix},
};
use windows::{
    Win32::{
        Foundation::{
            CloseHandle, ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY, FILETIME, GetLastError, HANDLE,
            WAIT_TIMEOUT,
        },
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE, GetFileInformationByHandle, GetFinalPathNameByHandleW,
            GetVolumeInformationByHandleW, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, VOLUME_NAME_GUID,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Pipes::{CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE},
            Threading::{
                GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
            },
        },
    },
    core::PCWSTR,
};

pub(super) struct OwnedHandle(pub HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub(super) struct Parent(OwnedHandle);

impl Parent {
    pub fn open(expected: u32) -> Result<Self> {
        if expected <= 1 || expected == unsafe { GetCurrentProcessId() } {
            return Err("invalid_parent".into());
        }
        unsafe {
            let process_list = OwnedHandle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?);
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            Process32FirstW(process_list.0, &mut entry)?;
            loop {
                if entry.th32ProcessID == GetCurrentProcessId() {
                    if entry.th32ParentProcessID != expected {
                        return Err("invalid_parent".into());
                    }
                    break;
                }
                Process32NextW(process_list.0, &mut entry)?;
            }
            let handle = OwnedHandle(OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                expected,
            )?);
            // A recycled PID cannot be accepted as the original launching process.
            if creation_time(handle.0)? > creation_time(GetCurrentProcess())? {
                return Err("invalid_parent".into());
            }
            let parent = Self(handle);
            if !parent.alive() {
                return Err("parent_exited".into());
            }
            Ok(parent)
        }
    }

    pub fn alive(&self) -> bool {
        unsafe { WaitForSingleObject(self.0.0, 0) == WAIT_TIMEOUT }
    }
}

unsafe fn creation_time(handle: HANDLE) -> Result<u64> {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)?;
    }
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

fn pipe_name(home: &Path) -> Result<String> {
    validate_home(home)?;
    let path: Vec<u16> = home.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        // Keep the directory identity based on the same volume/file-index fields as Node stat.
        let handle = OwnedHandle(CreateFileW(
            PCWSTR(path.as_ptr()),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )?);
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        GetFileInformationByHandle(handle.0, &mut info)?;
        if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0)
            != FILE_ATTRIBUTE_DIRECTORY.0
        {
            return Err("history_home_must_be_a_real_directory".into());
        }
        // Resolve SUBST/mapped aliases using the opened object, not its input drive letter.
        // Network shares have no volume GUID; failure or truncation is a closed rejection.
        let mut final_path = vec![0u16; 32768];
        let length =
            GetFinalPathNameByHandleW(handle.0, &mut final_path, VOLUME_NAME_GUID) as usize;
        if length == 0 || length >= final_path.len() {
            return Err("history_requires_local_ntfs".into());
        }
        let final_path = PathBuf::from(OsString::from_wide(&final_path[..length]));
        validate_local_drive(&volume_guid_root(&final_path)?)?;
        let mut filesystem = [0u16; 32];
        GetVolumeInformationByHandleW(handle.0, None, None, None, None, Some(&mut filesystem))?;
        let end = filesystem
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(filesystem.len());
        if !String::from_utf16_lossy(&filesystem[..end]).eq_ignore_ascii_case("NTFS") {
            return Err("history_requires_local_ntfs".into());
        }
        let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        Ok(format!(
            r"\\.\pipe\maka-history-{:x}-{:x}",
            info.dwVolumeSerialNumber, index
        ))
    }
}

fn volume_guid_root(path: &Path) -> Result<PathBuf> {
    let mut components = path.components();
    if let Some(Component::Prefix(prefix)) = components.next()
        && let Prefix::Verbatim(volume) = prefix.kind()
        && matches!(components.next(), Some(Component::RootDir))
        && let Some(guid) = volume
            .to_str()
            .and_then(|name| name.strip_prefix("Volume{"))
            .and_then(|name| name.strip_suffix('}'))
        && guid.len() == 36
        && uuid::Uuid::parse_str(guid).is_ok()
    {
        return Ok(format!(r"\\?\Volume{{{guid}}}\").into());
    }
    Err("history_requires_local_ntfs".into())
}

/// Validate storage without acquiring the named pipe, including while it is owned.
pub(super) fn validate_storage(home: &Path) -> Result<()> {
    pipe_name(home).map(|_| ())
}

pub(super) fn acquire(home: &Path) -> Result<OwnedHandle> {
    let name: Vec<u16> = pipe_name(home)?.encode_utf16().chain(Some(0)).collect();
    unsafe {
        // No connection is accepted and no history is ever sent over this pipe.
        let handle = CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            0,
            0,
            0,
            None,
        );
        if handle.is_invalid() {
            // Windows can report either FIRST_PIPE_INSTANCE denial or the
            // existing pipe's one-instance limit. Both mean admission is held.
            if matches!(GetLastError(), ERROR_ACCESS_DENIED | ERROR_PIPE_BUSY) {
                return Err("recorder_occupied".into());
            }
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(OwnedHandle(handle))
    }
}

pub(super) fn active(home: &Path) -> Result<bool> {
    match acquire(home) {
        Ok(_handle) => Ok(false),
        Err(error) if error.to_string() == "recorder_occupied" => Ok(true),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_admission_rejects_duplicates_and_releases_on_close() {
        let home = std::env::temp_dir().join(format!("maka-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        let lock = acquire(&home).unwrap();
        validate_storage(&home).unwrap();
        assert!(active(&home).unwrap());
        assert_eq!(
            acquire(&home).err().unwrap().to_string(),
            "recorder_occupied"
        );
        drop(lock);
        assert!(!active(&home).unwrap());
        std::fs::remove_dir(home).unwrap();
    }

    #[test]
    fn local_ntfs_home_accepts_drive_and_verbatim_names_without_taking_ownership() {
        let home = std::env::temp_dir().join(format!("maka-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        let canonical = std::fs::canonicalize(&home).unwrap();
        assert!(matches!(
            canonical.components().next(),
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_))
        ));
        let ordinary = PathBuf::from(
            canonical
                .as_os_str()
                .to_str()
                .unwrap()
                .strip_prefix(r"\\?\")
                .unwrap(),
        );
        validate_storage(&ordinary).unwrap();
        validate_storage(&canonical).unwrap();
        assert_eq!(
            pipe_name(&ordinary).unwrap(),
            pipe_name(&canonical).unwrap()
        );
        let lock = acquire(&ordinary).unwrap();
        validate_storage(&canonical).unwrap();
        assert_eq!(
            acquire(&canonical).err().unwrap().to_string(),
            "recorder_occupied"
        );
        drop(lock);
        std::fs::remove_dir(&home).unwrap();
        assert!(validate_storage(&ordinary).is_err());
    }

    #[test]
    fn handle_volume_roots_must_be_guid_paths_not_network_or_device_names() {
        let root = r"\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\";
        assert_eq!(
            volume_guid_root(&Path::new(root).join(r"history\child")).unwrap(),
            Path::new(root),
        );
        for path in [
            r"\\server\share\history",
            r"\\?\UNC\server\share\history",
            r"\\?\C:\history",
            r"\\.\C:\history",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\history",
            r"\\?\Volume{not-a-guid}\history",
        ] {
            assert!(volume_guid_root(Path::new(path)).is_err(), "{path}");
        }
    }

    #[test]
    fn parent_cannot_be_the_recorder_itself() {
        assert!(Parent::open(unsafe { GetCurrentProcessId() }).is_err());
        assert!(Parent::open(1).is_err());
    }
}
