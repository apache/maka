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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use windows::Win32::Foundation::{
    ERROR_INVALID_WINDOW_HANDLE, FILETIME, HANDLE, HWND, LPARAM, WAIT_OBJECT_0, WAIT_TIMEOUT,
    WPARAM,
};
use windows::Win32::Storage::Packaging::Appx::{
    GetApplicationUserModelId, VerifyApplicationUserModelId,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess,
    WaitForSingleObject,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GWL_EXSTYLE, GWL_STYLE, GetShellWindow, GetWindow, GetWindowLongW,
    GetWindowThreadProcessId, IsWindowVisible, PostMessageW, SW_MINIMIZE, ShowWindowAsync,
    WM_CLOSE, WS_EX_TOOLWINDOW, WS_MINIMIZEBOX,
};
use windows::core::{BOOL, Error, HSTRING, Owned, PWSTR};

pub(super) struct Instance {
    pub(super) token: String,
    pid: u32,
    process: Owned<HANDLE>,
    windows: Vec<HWND>,
}

fn owner(window: HWND) -> u32 {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    pid
}

unsafe extern "system" fn collect(window: HWND, param: LPARAM) -> BOOL {
    if unsafe {
        IsWindowVisible(window).as_bool()
            && GetWindow(window, GW_OWNER).is_err()
            && GetWindowLongW(window, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 == 0
    } {
        // SAFETY: EnumWindows synchronously borrows the map passed by find.
        let windows = unsafe { &mut *(param.0 as *mut BTreeMap<u32, Vec<HWND>>) };
        windows.entry(owner(window)).or_default().push(window);
    }
    true.into()
}

pub(super) enum Identity<'a> {
    Executable(PathBuf),
    AppId(&'a str),
}

impl<'a> Identity<'a> {
    pub(super) fn for_target(
        id: &'a str,
        target: Option<&str>,
        arguments: Option<&str>,
    ) -> Result<Option<Self>, String> {
        if arguments.is_some() {
            return Ok(None);
        }
        if let Some(target) = target {
            let path = Path::new(target);
            if !path.is_absolute()
                || !path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
            {
                return Ok(None);
            }
            return match path.canonicalize() {
                Ok(path) => Ok(Some(Self::Executable(path))),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error.to_string()),
            };
        }
        Ok(
            (unsafe { VerifyApplicationUserModelId(&HSTRING::from(id)) }.is_ok())
                .then_some(Self::AppId(id)),
        )
    }
    fn matches(&self, process: HANDLE) -> bool {
        match self {
            Self::Executable(expected) => {
                let mut path = vec![0; 32768];
                let mut size = path.len() as u32;
                if unsafe {
                    QueryFullProcessImageNameW(
                        process,
                        PROCESS_NAME_WIN32,
                        PWSTR(path.as_mut_ptr()),
                        &mut size,
                    )
                }
                .is_err()
                {
                    return false;
                }
                use std::os::windows::ffi::OsStringExt;
                std::fs::canonicalize(std::ffi::OsString::from_wide(&path[..size as usize]))
                    .is_ok_and(|path| path == *expected)
            }
            Self::AppId(expected) => {
                let mut name = [0; 256];
                let mut size = name.len() as u32;
                unsafe {
                    GetApplicationUserModelId(process, &mut size, Some(PWSTR(name.as_mut_ptr())))
                }
                .is_ok()
                    && size > 0
                    && String::from_utf16(&name[..size as usize - 1])
                        .is_ok_and(|actual| actual.eq_ignore_ascii_case(expected))
            }
        }
    }
}

pub(super) fn find(identity: Identity<'_>) -> Result<Option<Instance>, String> {
    let mut windows = BTreeMap::<u32, Vec<HWND>>::new();
    unsafe { EnumWindows(Some(collect), LPARAM((&mut windows as *mut _) as isize)) }
        .map_err(|e| e.to_string())?;
    let shell = owner(unsafe { GetShellWindow() });
    let mut found = None;
    for (pid, windows) in windows {
        if pid == 0 || pid == shell || pid == std::process::id() {
            continue;
        }
        let rights = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
        let Ok(handle) = (unsafe { OpenProcess(rights, false, pid) }) else {
            continue;
        };
        // SAFETY: each successfully opened process handle is owned until the operation ends.
        let process = unsafe { Owned::new(handle) };
        if !identity.matches(*process) {
            continue;
        }
        if found.is_some() {
            return Ok(None);
        }
        let (mut start, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        unsafe { GetProcessTimes(*process, &mut start, &mut exit, &mut kernel, &mut user) }
            .map_err(|e| e.to_string())?;
        let token = format!("{pid}:{}:{}", start.dwHighDateTime, start.dwLowDateTime);
        found = Some(Instance {
            pid,
            process,
            windows,
            token,
        });
    }
    Ok(found)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Action {
    Minimize,
    Restart,
    Quit,
    ForceQuit,
}

impl Instance {
    pub(super) fn act(self, action: Action) -> Result<(), String> {
        match action {
            Action::ForceQuit => {
                // The retained query handle pins this PID while acquiring terminate access.
                let handle = unsafe { OpenProcess(PROCESS_TERMINATE, false, self.pid) }
                    .map_err(|e| e.to_string())?;
                let terminate = unsafe { Owned::new(handle) };
                unsafe { TerminateProcess(*terminate, 1) }.map_err(|e| e.to_string())?
            }
            Action::Minimize => {
                let mut minimized = false;
                for window in self.windows {
                    if owner(window) == self.pid
                        && unsafe {
                            GetWindowLongW(window, GWL_STYLE) as u32 & WS_MINIMIZEBOX.0 != 0
                        }
                    {
                        minimized |= unsafe { ShowWindowAsync(window, SW_MINIMIZE) }.as_bool();
                    }
                }
                return if minimized {
                    Ok(())
                } else {
                    Err("No application window could be minimized.".into())
                };
            }
            Action::Quit | Action::Restart => {
                for window in self.windows {
                    if owner(window) != self.pid {
                        continue;
                    }
                    if let Err(error) =
                        unsafe { PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0)) }
                        && error.code() != ERROR_INVALID_WINDOW_HANDLE.to_hresult()
                    {
                        return Err(error.to_string());
                    }
                }
            }
        }
        match unsafe { WaitForSingleObject(*self.process, 15_000) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err("The application is still running. Check for unsaved documents or a system tray window.".into()),
            _ => Err(Error::from_thread().to_string()),
        }
    }
}
