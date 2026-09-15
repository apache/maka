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
use crate::{control::Result, model::windows_application_id};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::HGLOBAL,
        Graphics::GdiPlus::{
            GdipCreateBitmapFromHICON, GdipCreateBitmapFromScan0, GdipDeleteGraphics,
            GdipDisposeImage, GdipDrawImageRectI, GdipGetImageGraphicsContext, GdipGraphicsClear,
            GdipSaveImageToStream, GdiplusShutdown, GdiplusStartup, GdiplusStartupInput,
            Ok as GDIP_OK,
        },
        Security::Cryptography::{
            CRYPT_STRING, CRYPT_STRING_BASE64, CRYPT_STRING_NOCRLF, CryptBinaryToStringW,
        },
        Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
        System::{
            Com::StructuredStorage::CreateStreamOnHGlobal,
            Com::{
                COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize, STATFLAG_NONAME,
                STREAM_SEEK_SET,
            },
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                QueryFullProcessImageNameW,
            },
        },
        UI::{
            Shell::ExtractIconExW,
            WindowsAndMessaging::{DestroyIcon, HICON},
        },
    },
    core::{GUID, PCWSTR, PWSTR, w},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Application {
    bundle_identifier: String,
    name: String,
    icon_data_url: Option<String>,
}

pub(super) fn lookup(ids: &[String]) -> Result<Vec<Application>> {
    if ids.len() > 32
        || ids
            .iter()
            .any(|id| windows_application_id(id).as_ref() != Some(id))
    {
        return Err("invalid_application_identifiers".into());
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut paths: BTreeMap<String, BTreeSet<String>> =
        ids.iter().map(|id| (id.clone(), BTreeSet::new())).collect();
    if !ids.is_empty() {
        unsafe {
            let list = OwnedHandle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?);
            let mut entry = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            Process32FirstW(list.0, &mut entry)?;
            loop {
                if Instant::now() >= deadline {
                    return Err("application_lookup_timeout".into());
                }
                let length = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let filename = String::from_utf16_lossy(&entry.szExeFile[..length]).to_lowercase();
                if let Some(stem) = filename.strip_suffix(".exe")
                    && let Some(candidates) = paths.get_mut(&format!("win32.{stem}"))
                    && let Ok(handle) = OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION,
                        false,
                        entry.th32ProcessID,
                    )
                {
                    let handle = OwnedHandle(handle);
                    let mut buffer = [0u16; 32768];
                    let mut length = buffer.len() as u32;
                    if QueryFullProcessImageNameW(
                        handle.0,
                        PROCESS_NAME_WIN32,
                        PWSTR(buffer.as_mut_ptr()),
                        &mut length,
                    )
                    .is_ok()
                        && let Ok(path) = String::from_utf16(&buffer[..length as usize])
                        && crate::control::windows_drive_root(Path::new(&path))
                            .and_then(|root| crate::control::validate_local_drive(&root))
                            .is_ok()
                        && Path::new(&path)
                            .file_name()
                            .and_then(|s| s.to_str())
                            .is_some_and(|s| s.eq_ignore_ascii_case(&filename))
                    {
                        candidates.insert(path.to_lowercase());
                    }
                }
                if Process32NextW(list.0, &mut entry).is_err() {
                    break;
                }
            }
        }
    }
    ids.iter()
        .map(|id| {
            if Instant::now() >= deadline {
                return Err("application_lookup_timeout".into());
            }
            let mut value = Application {
                bundle_identifier: id.clone(),
                name: id.clone(),
                icon_data_url: None,
            };
            if let Some(paths) = paths.get(id).filter(|paths| paths.len() == 1) {
                let path = paths.first().unwrap();
                let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
                let wide = PCWSTR(wide.as_ptr());
                value.name = display_name(wide)
                    .unwrap_or_else(|| id.trim_start_matches("win32.").to_owned());
                value.icon_data_url = icon(wide);
            }
            Ok(value)
        })
        .collect()
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
            if ExtractIconExW(path, 0, Some(&mut handle), None, 1) != 1 || handle.is_invalid() {
                return None;
            }
            if GdipCreateBitmapFromHICON(handle, &mut source) != GDIP_OK {
                return None;
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
