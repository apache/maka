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

use super::ownership::OwnedHandle;
use crate::{
    control::Result,
    model::{packaged_application_id, windows_application_id},
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::{Component, Path, Prefix},
    time::{Duration, Instant},
};
use windows::{
    ApplicationModel::AppInfo,
    Foundation::Size,
    Win32::{
        Foundation::{
            APPMODEL_ERROR_NO_APPLICATION, ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES,
            ERROR_SUCCESS, GENERIC_READ, HANDLE, HGLOBAL,
        },
        Graphics::GdiPlus::{
            GdipCreateBitmapFromHICON, GdipCreateBitmapFromScan0, GdipCreateBitmapFromStream,
            GdipDeleteGraphics, GdipDisposeImage, GdipDrawImageRectI, GdipGetImageGraphicsContext,
            GdipGetImageHeight, GdipGetImageWidth, GdipGraphicsClear, GdipSaveImageToStream,
            GdiplusShutdown, GdiplusStartup, GdiplusStartupInput, Ok as GDIP_OK,
        },
        Security::Cryptography::{
            CRYPT_STRING, CRYPT_STRING_BASE64, CRYPT_STRING_NOCRLF, CryptBinaryToStringW,
        },
        Storage::{
            FileSystem::{
                BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
                FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
                GetFileInformationByHandle, GetFileVersionInfoSizeW, GetFileVersionInfoW,
                GetFinalPathNameByHandleW, OPEN_EXISTING, VOLUME_NAME_DOS, VerQueryValueW,
            },
            Packaging::Appx::{
                APPLICATION_USER_MODEL_ID_MAX_LENGTH, GetApplicationUserModelId,
                VerifyApplicationUserModelId,
            },
        },
        System::{
            Com::StructuredStorage::CreateStreamOnHGlobal,
            Com::{
                COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize, IStream, STATFLAG_NONAME,
                STREAM_SEEK_SET,
            },
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Registry::{
                HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_WOW64_64KEY,
                REG_OPTION_OPEN_LINK, REG_SZ, REG_VALUE_TYPE, RegCloseKey, RegOpenKeyExW,
                RegQueryValueExW,
            },
            Threading::{
                OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                QueryFullProcessImageNameW,
            },
            WinRT::{
                CreateStreamOverRandomAccessStream, RO_INIT_MULTITHREADED, RoInitialize,
                RoUninitialize,
            },
        },
        UI::{
            Shell::ExtractIconExW,
            WindowsAndMessaging::{DestroyIcon, HICON},
        },
    },
    core::{GUID, HRESULT, HSTRING, PCWSTR, PWSTR, w},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Resolution {
    Resolved,
    Registered,
    NotRunning,
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Application {
    bundle_identifier: String,
    name: String,
    icon_data_url: Option<String>,
    resolution: Resolution,
}

#[derive(Default)]
struct Candidate {
    path: Option<String>,
    application_user_model_id: Option<String>,
    unavailable: bool,
}

impl Candidate {
    fn observe(&mut self, observation: Option<(String, Option<String>)>) {
        if self.unavailable {
            return;
        }
        match observation {
            Some((path, identity))
                if self.path.as_ref().is_none_or(|previous| {
                    previous == &path && self.application_user_model_id == identity
                }) =>
            {
                self.path = Some(path);
                self.application_user_model_id = identity;
            }
            _ => {
                // A shared executable does not establish a shared packaged identity.
                self.path = None;
                self.application_user_model_id = None;
                self.unavailable = true;
            }
        }
    }

    fn resolution(&self) -> Resolution {
        if self.unavailable {
            Resolution::Unavailable
        } else if self.path.is_some() {
            Resolution::Resolved
        } else {
            Resolution::NotRunning
        }
    }
}

/// Read identity from the caller's held process handle, never a title, HWND guess
/// or package inventory. The caller must retain that handle and compare this
/// result again at its final source fence. Only explicit OS absence is `None`.
pub(super) fn process_application_user_model_id(process: HANDLE) -> Result<Option<String>> {
    let mut units = [0u16; APPLICATION_USER_MODEL_ID_MAX_LENGTH as usize];
    let mut length = units.len() as u32;
    let status =
        unsafe { GetApplicationUserModelId(process, &mut length, Some(PWSTR(units.as_mut_ptr()))) };
    let identity = decode_application_user_model_id(status.0, &units, length)?;
    if let Some(value) = &identity {
        verified_packaged_identity(value)?;
    }
    Ok(identity)
}

fn verified_packaged_identity(value: &str) -> Result<()> {
    packaged_application_id(value).ok_or("invalid_application_identity")?;
    let wide: Vec<u16> = value.encode_utf16().chain([0]).collect();
    if unsafe { VerifyApplicationUserModelId(PCWSTR(wide.as_ptr())) } != ERROR_SUCCESS {
        return Err("invalid_application_identity".into());
    }
    Ok(())
}

fn decode_application_user_model_id(
    status: u32,
    units: &[u16],
    length: u32,
) -> Result<Option<String>> {
    if status == APPMODEL_ERROR_NO_APPLICATION.0 {
        return Ok(None);
    }
    if status != ERROR_SUCCESS.0 {
        return Err("application_identity_unavailable".into());
    }
    let length = length as usize;
    if !(2..=APPLICATION_USER_MODEL_ID_MAX_LENGTH as usize).contains(&length)
        || length > units.len()
        || units[length - 1] != 0
        || units[..length - 1].contains(&0)
    {
        return Err("invalid_application_identity".into());
    }
    let value = String::from_utf16(&units[..length - 1])?;
    if value.chars().any(char::is_control) {
        return Err("invalid_application_identity".into());
    }
    Ok(Some(value))
}

fn enumeration_has_entry(result: windows::core::Result<()>) -> Result<bool> {
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.code() == HRESULT::from_win32(ERROR_NO_MORE_FILES.0) => Ok(false),
        Err(_) => Err("application_enumeration_failed".into()),
    }
}

pub(super) fn lookup(ids: &[String]) -> Result<Vec<Application>> {
    if ids.len() > 32
        || ids.iter().any(|id| {
            windows_application_id(id).as_ref() != Some(id)
                && id
                    .strip_prefix("winapp.")
                    .is_none_or(|value| packaged_application_id(value).is_none())
        })
    {
        return Err("invalid_application_identifiers".into());
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let executable_ids: Vec<_> = ids
        .iter()
        .filter(|id| id.starts_with("win32."))
        .cloned()
        .collect();
    let candidates = running_candidates(&executable_ids, deadline)?;
    let mut values = Vec::with_capacity(ids.len());
    let mut registered = Vec::new();
    for id in ids {
        check_deadline(deadline)?;
        if let Some(aumid) = id.strip_prefix("winapp.") {
            let mut value = Application {
                bundle_identifier: id.clone(),
                name: id.clone(),
                icon_data_url: None,
                resolution: Resolution::Unavailable,
            };
            if let Ok((name, image)) = packaged_application(aumid, deadline) {
                value.name = name;
                value.icon_data_url = image;
                value.resolution = Resolution::Registered;
            }
            values.push(value);
            continue;
        }
        let candidate = &candidates[id];
        let mut value = Application {
            bundle_identifier: id.clone(),
            name: id.clone(),
            icon_data_url: None,
            resolution: candidate.resolution(),
        };
        if let Some(path) = &candidate.path {
            let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
            value.name = display_name(PCWSTR(wide.as_ptr()))
                .unwrap_or_else(|| executable_stem(id).to_owned());
            value.icon_data_url = icon(PCWSTR(wide.as_ptr()));
        } else if value.resolution == Resolution::NotRunning {
            match registered_application(id, deadline) {
                Ok(Some((name, image))) => {
                    value.name = name;
                    value.icon_data_url = image;
                    value.resolution = Resolution::Registered;
                    registered.push(id.clone());
                }
                Ok(None) => {}
                Err(_) => value.resolution = Resolution::Unavailable,
            }
        }
        values.push(value);
    }
    // A process starting during registry/file inspection cannot hide a same-stem conflict.
    if !registered.is_empty() {
        let current = running_candidates(&registered, deadline)?;
        for value in &mut values {
            if value.resolution == Resolution::Registered
                && value.bundle_identifier.starts_with("win32.")
                && current[&value.bundle_identifier].resolution() != Resolution::NotRunning
            {
                value.name = value.bundle_identifier.clone();
                value.icon_data_url = None;
                value.resolution = Resolution::Unavailable;
            }
        }
    }
    check_deadline(deadline)?;
    Ok(values)
}

fn packaged_application(aumid: &str, deadline: Instant) -> Result<(String, Option<String>)> {
    verified_packaged_identity(aumid)?;
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }
    unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
    let _apartment = Apartment;
    let read = || -> Result<(AppInfo, String, String)> {
        check_deadline(deadline)?;
        let info = AppInfo::GetFromAppUserModelId(&HSTRING::from(aumid))?;
        let family = aumid
            .split_once('!')
            .ok_or("invalid_application_identity")?
            .0;
        if info.AppUserModelId()? != aumid || info.PackageFamilyName()? != family {
            return Err("application_identity_changed".into());
        }
        let version = info.Package()?.Id()?.FullName()?.to_string();
        let name = info.DisplayInfo()?.DisplayName()?.to_string();
        if version.is_empty()
            || name.trim().is_empty()
            || name.len() > 512
            || name.chars().any(char::is_control)
        {
            return Err("application_metadata_unavailable".into());
        }
        Ok((info, version, name))
    };
    let (info, version, name) = read()?;
    let image = (|| -> Option<String> {
        let logo = info
            .DisplayInfo()
            .ok()?
            .GetLogo(Size {
                Width: 48.0,
                Height: 48.0,
            })
            .ok()?;
        let stream = logo.OpenReadAsync().ok()?.join().ok()?;
        check_deadline(deadline).ok()?;
        if !(1..=256 * 1024).contains(&stream.Size().ok()?) {
            return None;
        }
        let stream: IStream = unsafe { CreateStreamOverRandomAccessStream(&stream).ok()? };
        render_icon(None, Some(&stream))
    })();
    let (_, after_version, after_name) = read()?;
    if version != after_version || name != after_name {
        return Err("application_metadata_changed".into());
    }
    check_deadline(deadline)?;
    Ok((name, image))
}

fn check_deadline(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        return Err("application_lookup_timeout".into());
    }
    Ok(())
}

fn running_candidates(ids: &[String], deadline: Instant) -> Result<BTreeMap<String, Candidate>> {
    let mut candidates: BTreeMap<String, Candidate> = ids
        .iter()
        .map(|id| (id.clone(), Candidate::default()))
        .collect();
    if !ids.is_empty() {
        unsafe {
            let list = OwnedHandle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?);
            let mut entry = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut has_entry = enumeration_has_entry(Process32FirstW(list.0, &mut entry))?;
            while has_entry {
                check_deadline(deadline)?;
                let length = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let filename = String::from_utf16_lossy(&entry.szExeFile[..length]).to_lowercase();
                if let Some(stem) = filename.strip_suffix(".exe")
                    && let Some(candidate) = candidates.get_mut(&format!("win32.{stem}"))
                    && !candidate.unavailable
                {
                    let path = (|| {
                        let handle = OwnedHandle(
                            OpenProcess(
                                PROCESS_QUERY_LIMITED_INFORMATION,
                                false,
                                entry.th32ProcessID,
                            )
                            .ok()?,
                        );
                        let identity = process_application_user_model_id(handle.0).ok()?;
                        let mut buffer = [0u16; 32768];
                        let mut length = buffer.len() as u32;
                        QueryFullProcessImageNameW(
                            handle.0,
                            PROCESS_NAME_WIN32,
                            PWSTR(buffer.as_mut_ptr()),
                            &mut length,
                        )
                        .ok()?;
                        let path = String::from_utf16(buffer.get(..length as usize)?).ok()?;
                        crate::control::windows_drive_root(Path::new(&path))
                            .and_then(|root| crate::control::validate_local_drive(&root))
                            .ok()?;
                        Path::new(&path)
                            .file_name()
                            .and_then(|s| s.to_str())
                            .filter(|s| s.eq_ignore_ascii_case(&filename))?;
                        if process_application_user_model_id(handle.0).ok()? != identity {
                            return None;
                        }
                        Some((path, identity))
                    })();
                    candidate.observe(path);
                }
                has_entry = enumeration_has_entry(Process32NextW(list.0, &mut entry))?;
            }
        }
    }
    Ok(candidates)
}

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn registry_path(hive: HKEY, filename: &str, deadline: Instant) -> Result<Option<String>> {
    let mut parent = None::<RegistryKey>;
    // Open only this fixed ancestry and requested key; never enumerate registrations.
    for part in [
        "Software",
        "Microsoft",
        "Windows",
        "CurrentVersion",
        "App Paths",
        filename,
    ] {
        check_deadline(deadline)?;
        let wide: Vec<u16> = part.encode_utf16().chain([0]).collect();
        let mut key = HKEY::default();
        let result = unsafe {
            RegOpenKeyExW(
                parent.as_ref().map_or(hive, |key| key.0),
                PCWSTR(wide.as_ptr()),
                Some(REG_OPTION_OPEN_LINK.0),
                KEY_QUERY_VALUE | KEY_WOW64_64KEY,
                &mut key,
            )
        };
        if result == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        result.ok()?;
        let key = RegistryKey(key);
        let mut bytes = 0;
        let link = unsafe {
            RegQueryValueExW(
                key.0,
                w!("SymbolicLinkValue"),
                None,
                None,
                None,
                Some(&mut bytes),
            )
        };
        if link != ERROR_FILE_NOT_FOUND {
            return Err("application_registration_unavailable".into());
        }
        parent = Some(key);
    }
    // A single fixed-size read rejects expansion, unterminated strings and growth races.
    let mut units = [0u16; 4096];
    let mut bytes = size_of_val(&units) as u32;
    let mut kind = REG_VALUE_TYPE::default();
    unsafe {
        RegQueryValueExW(
            parent.as_ref().unwrap().0,
            PCWSTR::null(),
            None,
            Some(&mut kind),
            Some(units.as_mut_ptr().cast()),
            Some(&mut bytes),
        )
        .ok()?;
    }
    if kind != REG_SZ
        || bytes < 4
        || bytes as usize > size_of_val(&units)
        || !bytes.is_multiple_of(2)
    {
        return Err("invalid_application_registration".into());
    }
    let units = &units[..bytes as usize / 2];
    if units.last() != Some(&0) || units[..units.len() - 1].contains(&0) {
        return Err("invalid_application_registration".into());
    }
    let path = String::from_utf16(&units[..units.len() - 1])?;
    registered_path(&path, filename)?;
    Ok(Some(path))
}

fn executable_stem(id: &str) -> &str {
    id.strip_prefix("win32.").unwrap_or(id)
}

fn registration(id: &str, deadline: Instant) -> Result<[Option<String>; 2]> {
    let filename = format!("{}.exe", executable_stem(id));
    // App Paths and its descendants are shared across WOW64 views on Windows 7+.
    // Read each hive's canonical view, avoiding the 32-bit system-link alias.
    Ok([
        registry_path(HKEY_CURRENT_USER, &filename, deadline)?,
        registry_path(HKEY_LOCAL_MACHINE, &filename, deadline)?,
    ])
}

fn registration_target(values: &[Option<String>; 2]) -> Result<Option<&str>> {
    let mut target: Option<&str> = None;
    for path in values.iter().flatten() {
        if target.is_some_and(|previous| previous != path) {
            return Err("ambiguous_application_registration".into());
        }
        target = Some(path);
    }
    Ok(target)
}

fn registered_path(path: &str, filename: &str) -> Result<()> {
    // Check raw components before Path normalizes away explicit dot segments.
    if path.chars().any(|c| c.is_control() || "\"%/".contains(c))
        || path.split('\\').skip(1).any(|part| {
            part.is_empty()
                || part.ends_with(['.', ' '])
                || part.contains([':', '*', '?', '<', '>', '|'])
        })
    {
        return Err("invalid_application_registration".into());
    }
    let path = Path::new(path);
    if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| !name.eq_ignore_ascii_case(filename))
    {
        return Err("invalid_application_registration".into());
    }
    crate::control::windows_drive_root(path)?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct FileIdentity {
    volume: u32,
    index: u64,
    size: u64,
    modified: u64,
}

fn file_identity(handle: &OwnedHandle) -> Result<FileIdentity> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandle(handle.0, &mut info)?;
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0) != 0 {
        return Err("application_file_must_be_regular".into());
    }
    Ok(FileIdentity {
        volume: info.dwVolumeSerialNumber,
        index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        size: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
        modified: (u64::from(info.ftLastWriteTime.dwHighDateTime) << 32)
            | u64::from(info.ftLastWriteTime.dwLowDateTime),
    })
}

fn pin_registered_file(path: &str, deadline: Instant) -> Result<(Vec<OwnedHandle>, FileIdentity)> {
    let path = Path::new(path);
    crate::control::validate_local_drive(&crate::control::windows_drive_root(path)?)?;
    let mut held = Vec::new();
    // Hold each ancestor without delete sharing so path-based resource APIs cannot
    // follow a replacement junction. Hold the executable without write sharing too.
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        check_deadline(deadline)?;
        let is_file = ancestor == path;
        let wide: Vec<u16> = ancestor
            .as_os_str()
            .to_str()
            .ok_or("invalid_application_path")?
            .encode_utf16()
            .chain([0])
            .collect();
        let handle = OwnedHandle(unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                if is_file { GENERIC_READ.0 } else { 0 },
                if is_file {
                    FILE_SHARE_READ
                } else {
                    FILE_SHARE_READ | FILE_SHARE_WRITE
                },
                None,
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )?
        });
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe {
            GetFileInformationByHandle(handle.0, &mut info)?;
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
            || !is_file && info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0
        {
            return Err("application_path_must_not_redirect".into());
        }
        // A drive-letter alias must still resolve to a local DOS path, never UNC.
        let mut final_path = [0u16; 32768];
        let length =
            unsafe { GetFinalPathNameByHandleW(handle.0, &mut final_path, VOLUME_NAME_DOS) }
                as usize;
        if length == 0 || length >= final_path.len() {
            return Err("application_path_unavailable".into());
        }
        let final_path = String::from_utf16(&final_path[..length])?;
        crate::control::validate_local_drive(&crate::control::windows_drive_root(Path::new(
            &final_path,
        ))?)?;
        held.push(handle);
    }
    let identity = file_identity(held.last().unwrap())?;
    Ok((held, identity))
}

fn registered_application(id: &str, deadline: Instant) -> Result<Option<(String, Option<String>)>> {
    let before = registration(id, deadline)?;
    let Some(path) = registration_target(&before)? else {
        return Ok(None);
    };
    let (held, identity) = pin_registered_file(path, deadline)?;
    check_deadline(deadline)?;
    let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
    let name =
        display_name(PCWSTR(wide.as_ptr())).unwrap_or_else(|| executable_stem(id).to_owned());
    let image = icon(PCWSTR(wide.as_ptr()));
    let after = registration(id, deadline)?;
    let (_current, current_identity) = pin_registered_file(path, deadline)?;
    if before != after
        || identity != current_identity
        || identity != file_identity(held.last().unwrap())?
    {
        return Err("application_registration_changed".into());
    }
    Ok(Some((name, image)))
}

fn display_name(path: PCWSTR) -> Option<String> {
    unsafe {
        let size = GetFileVersionInfoSizeW(path, None);
        if size == 0 || size > 1024 * 1024 {
            return None;
        }
        let mut bytes = vec![0u8; size as usize];
        GetFileVersionInfoW(path, None, size, bytes.as_mut_ptr().cast()).ok()?;
        let mut translations = std::ptr::null_mut();
        let mut length = 0;
        if !VerQueryValueW(
            bytes.as_ptr().cast(),
            w!("\\VarFileInfo\\Translation"),
            &mut translations,
            &mut length,
        )
        .as_bool()
            || length < 4
            || !inside(&bytes, translations, length as usize)
        {
            return None;
        }
        let translations =
            std::slice::from_raw_parts(translations.cast::<u16>(), length as usize / 2);
        for translation in translations.chunks_exact(2).take(8) {
            let query: Vec<u16> = format!(
                "\\StringFileInfo\\{:04x}{:04x}\\FileDescription",
                translation[0], translation[1]
            )
            .encode_utf16()
            .chain([0])
            .collect();
            let mut text = std::ptr::null_mut();
            let mut length = 0;
            if VerQueryValueW(
                bytes.as_ptr().cast(),
                PCWSTR(query.as_ptr()),
                &mut text,
                &mut length,
            )
            .as_bool()
                && length > 1
                && length <= 513
                && inside(&bytes, text, length as usize * 2)
            {
                let wide = std::slice::from_raw_parts(text.cast::<u16>(), length as usize);
                let value = String::from_utf16(
                    &wide[..wide.iter().position(|c| *c == 0).unwrap_or(wide.len())],
                )
                .ok()?;
                let value = value.trim();
                if !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control) {
                    return Some(value.to_owned());
                }
            }
        }
        None
    }
}

fn inside(bytes: &[u8], pointer: *mut std::ffi::c_void, length: usize) -> bool {
    let start = pointer as usize;
    start.is_multiple_of(align_of::<u16>())
        && start >= bytes.as_ptr() as usize
        && start
            .checked_add(length)
            .is_some_and(|end| end <= bytes.as_ptr() as usize + bytes.len())
}

fn icon(path: PCWSTR) -> Option<String> {
    render_icon(Some(path), None)
}

fn render_icon(path: Option<PCWSTR>, stream: Option<&IStream>) -> Option<String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()?;
        let mut token = 0;
        let input = GdiplusStartupInput {
            GdiplusVersion: 1,
            ..Default::default()
        };
        let mut handle = HICON::default();
        let mut source = std::ptr::null_mut();
        let mut bitmap = std::ptr::null_mut();
        let mut graphics = std::ptr::null_mut();
        let result = (|| {
            if GdiplusStartup(&mut token, &input, std::ptr::null_mut()) != GDIP_OK {
                return None;
            }
            if let Some(path) = path {
                if ExtractIconExW(path, 0, Some(&mut handle), None, 1) != 1
                    || handle.is_invalid()
                    || GdipCreateBitmapFromHICON(handle, &mut source) != GDIP_OK
                {
                    return None;
                }
            } else {
                if GdipCreateBitmapFromStream(stream?, &mut source) != GDIP_OK {
                    return None;
                }
                let mut width = 0;
                let mut height = 0;
                if GdipGetImageWidth(source.cast(), &mut width) != GDIP_OK
                    || GdipGetImageHeight(source.cast(), &mut height) != GDIP_OK
                    || !(1..=512).contains(&width)
                    || !(1..=512).contains(&height)
                {
                    return None;
                }
            }
            // PixelFormat32bppARGB; GDI+ writes an RGBA8 PNG for the shared decoder.
            if GdipCreateBitmapFromScan0(48, 48, 0, 0x26200a, None, &mut bitmap) != GDIP_OK {
                return None;
            }
            if GdipGetImageGraphicsContext(bitmap.cast(), &mut graphics) != GDIP_OK {
                return None;
            }
            if GdipGraphicsClear(graphics, 0) != GDIP_OK
                || GdipDrawImageRectI(graphics, source.cast(), 0, 0, 48, 48) != GDIP_OK
            {
                return None;
            }
            let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true).ok()?;
            let png = GUID::from_u128(0x557cf406_1a04_11d3_9a73_0000f81ef32e);
            if GdipSaveImageToStream(bitmap.cast(), &stream, &png, std::ptr::null()) != GDIP_OK {
                return None;
            }
            let mut stat = Default::default();
            stream.Stat(&mut stat, STATFLAG_NONAME).ok()?;
            let size = stat.cbSize;
            if !(33..=48 * 1024).contains(&size) {
                return None;
            }
            stream.Seek(0, STREAM_SEEK_SET, None).ok()?;
            let mut bytes = vec![0; size as usize];
            let mut count = 0;
            stream
                .Read(
                    bytes.as_mut_ptr().cast(),
                    bytes.len() as u32,
                    Some(&mut count),
                )
                .ok()
                .ok()?;
            if count as usize != bytes.len() || bytes.get(24..29) != Some(&[8, 6, 0, 0, 0]) {
                return None;
            }
            let flags = CRYPT_STRING(CRYPT_STRING_BASE64.0 | CRYPT_STRING_NOCRLF);
            let mut length = 0;
            if !CryptBinaryToStringW(&bytes, flags, None, &mut length).as_bool() {
                return None;
            }
            let mut text = vec![0u16; length as usize];
            if !CryptBinaryToStringW(&bytes, flags, Some(PWSTR(text.as_mut_ptr())), &mut length)
                .as_bool()
            {
                return None;
            }
            let end = text.iter().position(|c| *c == 0).unwrap_or(text.len());
            Some(format!(
                "data:image/png;base64,{}",
                String::from_utf16(&text[..end]).ok()?
            ))
        })();
        if !graphics.is_null() {
            GdipDeleteGraphics(graphics);
        }
        if !bitmap.is_null() {
            GdipDisposeImage(bitmap.cast());
        }
        if !source.is_null() {
            GdipDisposeImage(source.cast());
        }
        if !handle.is_invalid() {
            let _ = DestroyIcon(handle);
        }
        if token != 0 {
            GdiplusShutdown(token);
        }
        CoUninitialize();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::ERROR_ACCESS_DENIED;

    #[test]
    fn executable_stems_preserve_name_prefixes_after_the_scheme() {
        for (id, stem) in [
            ("win32.editor", "editor"),
            ("win32.win32.editor", "win32.editor"),
            ("win32.win32.win32.editor", "win32.win32.editor"),
            ("win32.win32", "win32"),
            ("win32.editor.preview-1", "editor.preview-1"),
            ("win32.win32.editor_preview-1", "win32.editor_preview-1"),
        ] {
            assert_eq!(windows_application_id(id).as_deref(), Some(id));
            assert_eq!(executable_stem(id), stem, "{id}");
        }
    }

    #[test]
    fn absence_requires_no_matches_and_uncertainty_cannot_be_overwritten() {
        let path = Some((String::from("c:\\program files\\editor.exe"), None));
        let other = Some((String::from("c:\\other\\editor.exe"), None));
        for (observations, expected) in [
            (vec![], Resolution::NotRunning),
            (vec![path.clone(), path.clone()], Resolution::Resolved),
            (vec![None], Resolution::Unavailable),
            (
                vec![path.clone(), None, path.clone()],
                Resolution::Unavailable,
            ),
            (vec![None, path.clone()], Resolution::Unavailable),
            (
                vec![path.clone(), other, path.clone()],
                Resolution::Unavailable,
            ),
        ] {
            let mut candidate = Candidate::default();
            for observed in observations {
                candidate.observe(observed);
            }
            assert_eq!(candidate.resolution(), expected);
            assert_eq!(candidate.path.is_some(), expected == Resolution::Resolved);
        }
    }

    #[test]
    fn shared_executable_cannot_merge_distinct_packaged_identities() {
        let path = String::from("c:\\program files\\host.exe");
        let app = Some(String::from("Synthetic.Package_123456789abcd!Editor"));
        let other = Some(String::from("Synthetic.Package_123456789abcd!Reader"));
        for identities in [
            [app.clone(), other, app.clone()],
            [None, app.clone(), None],
            [app.clone(), None, app.clone()],
        ] {
            let mut candidate = Candidate::default();
            for identity in identities {
                candidate.observe(Some((path.clone(), identity)));
            }
            assert_eq!(candidate.resolution(), Resolution::Unavailable);
            assert!(candidate.path.is_none());
            assert!(candidate.application_user_model_id.is_none());
        }
        let mut candidate = Candidate::default();
        for _ in 0..2 {
            candidate.observe(Some((path.clone(), app.clone())));
        }
        assert_eq!(candidate.resolution(), Resolution::Resolved);
        assert_eq!(candidate.application_user_model_id, app);
    }

    #[test]
    fn process_paths_preserve_case_and_case_only_conflicts_fail_closed() {
        let original = r"C:\Apps\Editor.exe";
        let app = Some(String::from("Synthetic.Package_123456789abcd!Editor"));
        for identity in [None, app] {
            let mut candidate = Candidate::default();
            for _ in 0..2 {
                candidate.observe(Some((original.to_owned(), identity.clone())));
            }
            assert_eq!(candidate.resolution(), Resolution::Resolved);
            assert_eq!(candidate.path.as_deref(), Some(original));
            assert_eq!(candidate.application_user_model_id, identity);

            for other in [r"C:\Apps\editor.exe", r"C:\apps\Editor.exe"] {
                for paths in [[original, other], [other, original]] {
                    let mut candidate = Candidate::default();
                    for path in paths {
                        candidate.observe(Some((path.to_owned(), identity.clone())));
                    }
                    // A later duplicate cannot erase the conflict in this enumeration.
                    candidate.observe(Some((original.to_owned(), identity.clone())));
                    assert_eq!(candidate.resolution(), Resolution::Unavailable);
                    assert!(candidate.path.is_none());
                    assert!(candidate.application_user_model_id.is_none());
                }
            }
            let mut recovered = Candidate::default();
            recovered.observe(Some((original.to_owned(), identity.clone())));
            assert_eq!(recovered.resolution(), Resolution::Resolved);
            assert_eq!(recovered.path.as_deref(), Some(original));
        }
    }

    #[test]
    fn process_identity_decoder_preserves_exact_os_identity_and_nul_bound() {
        let identity = "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App";
        let units: Vec<u16> = identity.encode_utf16().chain([0]).collect();
        assert_eq!(
            decode_application_user_model_id(0, &units, units.len() as u32).unwrap(),
            Some(identity.to_owned())
        );
        let maximum = vec![b'a' as u16; APPLICATION_USER_MODEL_ID_MAX_LENGTH as usize - 1];
        let units: Vec<u16> = maximum.iter().copied().chain([0]).collect();
        assert_eq!(
            decode_application_user_model_id(0, &units, units.len() as u32)
                .unwrap()
                .unwrap()
                .len(),
            maximum.len()
        );
        for (units, length) in [
            (vec![], 0),
            (vec![0], 1),
            (vec![b'a' as u16, 0], 3),
            (vec![b'a' as u16, b'b' as u16], 2),
            (vec![b'a' as u16, 0, b'b' as u16, 0], 4),
            (vec![0xd800, 0], 2),
            (vec![b'\n' as u16, 0], 2),
            (
                vec![b'a' as u16; APPLICATION_USER_MODEL_ID_MAX_LENGTH as usize + 1],
                APPLICATION_USER_MODEL_ID_MAX_LENGTH + 1,
            ),
        ] {
            assert!(decode_application_user_model_id(0, &units, length).is_err());
        }
    }

    #[test]
    fn process_identity_errors_never_authorize_win32_fallback() {
        assert_eq!(
            decode_application_user_model_id(APPMODEL_ERROR_NO_APPLICATION.0, &[], 0).unwrap(),
            None
        );
        for status in [5, 6, 87, 122, 15700, u32::MAX] {
            assert!(
                decode_application_user_model_id(status, &[b'a' as u16, 0], 2).is_err(),
                "{status}"
            );
        }
    }

    #[test]
    fn windows_verifies_packaged_keys_without_installation_or_discovery() {
        for value in [
            "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App".to_owned(),
            format!("{}_8wekyb3d8bbwe!{}", "N".repeat(50), "A".repeat(64)),
        ] {
            verified_packaged_identity(&value).unwrap();
        }
        for value in [
            "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App/other",
            "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App\0",
            "Microsoft.WindowsNotepad_8wekyb3d8bbwe!应用",
            "not-a-packaged-identity",
        ] {
            assert!(verified_packaged_identity(value).is_err());
        }
    }

    #[test]
    fn enumeration_errors_cannot_authorize_a_closed_application() {
        assert!(enumeration_has_entry(Ok(())).unwrap());
        assert!(
            !enumeration_has_entry(Err(windows::core::Error::from_hresult(
                HRESULT::from_win32(ERROR_NO_MORE_FILES.0),
            )))
            .unwrap()
        );
        assert!(
            enumeration_has_entry(Err(windows::core::Error::from_hresult(
                HRESULT::from_win32(ERROR_ACCESS_DENIED.0),
            )))
            .is_err()
        );
    }

    #[test]
    fn registration_paths_are_exact_local_executables_not_commands_or_navigation() {
        for path in [
            r"C:\Apps\editor.exe",
            r"c:\Program Files\Editor\EDITOR.EXE",
            "C:\\\u{5e94}\u{7528}\\editor.exe",
        ] {
            registered_path(path, "editor.exe").unwrap();
        }
        for path in [
            r"editor.exe",
            r"C:editor.exe",
            r"\Apps\editor.exe",
            r"\\server\share\editor.exe",
            r"\\?\C:\Apps\editor.exe",
            r"\\.\C:\Apps\editor.exe",
            r"C:\Apps\.\editor.exe",
            r"C:\Apps\..\editor.exe",
            r"C:\Apps\\editor.exe",
            r"C:\Apps.\editor.exe",
            r"C:\Apps \editor.exe",
            r"C:\Apps:stream\editor.exe",
            r"C:\Apps\editor.exe:stream",
            r"C:\Apps\editor.exe::$DATA",
            r"C:\Apps*\editor.exe",
            r"C:\Apps?\editor.exe",
            r"C:\Apps|other\editor.exe",
            r"C:\Apps<other>\editor.exe",
            r#""C:\Program Files\editor.exe""#,
            r"C:\Apps\editor.exe --flag",
            r"C:\Apps\editor.exe ",
            r"%LOCALAPPDATA%\Apps\editor.exe",
            r"C:/Apps/editor.exe",
            r"C:\Apps\other.exe",
            r"C:\Apps\editor.exe\",
            "C:\\Apps\\\0editor.exe",
        ] {
            assert!(registered_path(path, "editor.exe").is_err(), "{path:?}");
        }
    }

    #[test]
    fn absent_registration_is_not_an_unavailable_shared_registry_view() {
        let id = format!("win32.maka-reg-{}", uuid::Uuid::new_v4());
        let values = lookup(std::slice::from_ref(&id)).unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].bundle_identifier, id);
        assert_eq!(values[0].resolution, Resolution::NotRunning);
        assert_eq!(values[0].name, id);
        assert!(values[0].icon_data_url.is_none());
    }

    #[test]
    fn registration_hives_must_agree_without_precedence() {
        assert_eq!(registration_target(&[None, None]).unwrap(), None);
        for slot in 0..2 {
            let mut values = [None, None];
            values[slot] = Some(String::from(r"C:\Apps\editor.exe"));
            assert_eq!(
                registration_target(&values).unwrap(),
                values[slot].as_deref()
            );
            for conflict in 0..2 {
                if slot == conflict {
                    continue;
                }
                values[conflict] = Some(String::from(r"C:\Other\editor.exe"));
                assert!(registration_target(&values).is_err());
                values[conflict] = None;
            }
        }
        for other in [r"C:\Other\editor.exe", r"c:\apps\EDITOR.EXE"] {
            assert!(
                registration_target(&[
                    Some(String::from(r"C:\Apps\editor.exe")),
                    Some(String::from(other)),
                ])
                .is_err(),
                "do not assume case-insensitive directories"
            );
        }
        assert!(
            registration_target(&[
                Some(String::from(r"C:\Apps\editor.exe")),
                Some(String::from(r"C:\Apps\editor.exe")),
            ])
            .is_ok()
        );
    }

    #[test]
    fn registration_requires_an_existing_regular_file_and_live_deadline() {
        let root = std::env::temp_dir().join(format!("maka-app-pin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join("editor.exe");
        let path = executable.to_str().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        assert!(
            pin_registered_file(path, deadline).is_err(),
            "stale registration"
        );
        std::fs::create_dir(&executable).unwrap();
        assert!(
            pin_registered_file(path, deadline).is_err(),
            "directory is not executable metadata"
        );
        std::fs::remove_dir(&executable).unwrap();
        std::fs::write(&executable, b"synthetic regular file").unwrap();
        let (held, identity) = pin_registered_file(path, deadline).unwrap();
        assert_eq!(identity, file_identity(held.last().unwrap()).unwrap());
        assert!(
            std::fs::write(&executable, b"replacement").is_err(),
            "pin excludes content replacement"
        );
        assert!(
            std::fs::remove_file(&executable).is_err(),
            "pin excludes removal"
        );
        assert!(pin_registered_file(path, Instant::now()).is_err());
        drop(held);
        std::fs::remove_file(&executable).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }
}
