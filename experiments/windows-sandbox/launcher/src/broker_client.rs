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

use std::ffi::OsStr;
use std::fs;
use std::iter;
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, FILETIME, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, OPEN_EXISTING, ReadFile, SYNCHRONIZE, WriteFile,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetProcessId, GetProcessTimes, OpenProcess,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::broker_authorization::BrokerAuthorizer;
use crate::broker_framing::{MAX_BROKER_MESSAGE_BYTES, decode_frame, encode_frame};
use crate::broker_pipe_security::validate_pipe_name;
use crate::protocol::{BrokerLaunchOutcome, BrokerLaunchRequest, BrokerLaunchResponse};
use crate::windows_launcher;

pub fn run_local(manifest_path: &str) -> Result<u8, String> {
    let source = fs::read_to_string(manifest_path)
        .map_err(|error| format!("read local broker manifest failed: {error}"))?;
    fs::remove_file(manifest_path)
        .map_err(|error| format!("remove local broker manifest failed: {error}"))?;
    let mut request: BrokerLaunchRequest = serde_json::from_str(&source)
        .map_err(|error| format!("invalid local broker manifest: {error}"))?;
    // The packaged broker is a direct child of Runtime Host. Bind the
    // manifest to that kernel-observed parent and keep a wait handle open for
    // the whole launch. The process creation-time check rejects a PID that was
    // reused after this broker was created. If Runtime Host dies, the broker
    // terminates and drains the AppContainer Job instead of leaving the worker
    // alive until timeout.
    let owner_pid = parent_process_id()?;
    request.client_pid = owner_pid;
    request.validate()?;
    let owner = unsafe {
        OpenProcess(
            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            owner_pid,
        )
    };
    if owner.is_null() {
        return Err(last_error("OpenProcess(local broker owner)"));
    }
    if let Err(error) = validate_owner_process(owner, owner_pid) {
        unsafe { CloseHandle(owner) };
        return Err(error);
    }
    // The packaged path is a same-process one-shot launch. Authorize and hand
    // off directly instead of routing through a synchronous named-pipe thread;
    // the standalone pipe modes remain only as transport experiments.
    let result = (|| {
        let mut authorizer = BrokerAuthorizer::new([request.profile_digest.clone()]);
        authorizer
            .authorize(&request, request.client_pid)
            .map_err(|error| {
                format!(
                    "broker rejected request ({}): {}",
                    error.code(),
                    error.message()
                )
            })?;
        windows_launcher::launch_appcontainer_owned(&request.launch, owner)
    })();
    unsafe { CloseHandle(owner) };
    result
}

fn validate_owner_process(owner: HANDLE, owner_pid: u32) -> Result<(), String> {
    let opened_pid = unsafe { GetProcessId(owner) };
    if opened_pid != owner_pid {
        return Err(format!(
            "local broker owner identity changed while opening process: expected pid {owner_pid}, got {opened_pid}"
        ));
    }
    let owner_started = process_creation_time(owner, "local broker owner")?;
    let broker_started = process_creation_time(unsafe { GetCurrentProcess() }, "local broker")?;
    if owner_started >= broker_started {
        return Err(
            "local broker parent process identity was reused after broker creation".to_owned(),
        );
    }
    Ok(())
}

fn process_creation_time(process: HANDLE, label: &str) -> Result<u64, String> {
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut user = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(last_error(&format!("GetProcessTimes({label})")));
    }
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

fn parent_process_id() -> Result<u32, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(last_error("CreateToolhelp32Snapshot(local broker owner)"));
    }
    let current = unsafe { GetCurrentProcessId() };
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found = None;
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while next {
        if entry.th32ProcessID == current {
            found = Some(entry.th32ParentProcessID);
            break;
        }
        next = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    found
        .filter(|pid| *pid > 0)
        .ok_or_else(|| "local broker parent process was not found".to_owned())
}

pub fn run(pipe_name: &str, manifest_path: &str) -> Result<u8, String> {
    validate_pipe_name(pipe_name).map_err(|error| format!("invalid broker pipe: {error:?}"))?;
    let source = fs::read_to_string(manifest_path)
        .map_err(|error| format!("read broker manifest failed: {error}"))?;
    fs::remove_file(manifest_path)
        .map_err(|error| format!("remove broker manifest failed: {error}"))?;
    let mut request: BrokerLaunchRequest = serde_json::from_str(&source)
        .map_err(|error| format!("invalid broker manifest: {error}"))?;
    request.client_pid = unsafe { GetCurrentProcessId() };
    request.validate()?;

    let payload = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    let frame =
        encode_frame(&payload).map_err(|error| format!("invalid request frame: {error:?}"))?;
    let pipe = connect(pipe_name)?;
    let result = unsafe { exchange(pipe, &frame) };
    unsafe { CloseHandle(pipe) };
    let response = result?;
    if response.request_id != request.request_id || response.version != 1 {
        return Err("broker response identity does not match the request".to_owned());
    }
    match response.outcome {
        BrokerLaunchOutcome::Completed { exit_code } => Ok(exit_code),
        BrokerLaunchOutcome::Rejected { code, message } => {
            Err(format!("broker rejected request ({code}): {message}"))
        }
        BrokerLaunchOutcome::Started { .. } => {
            Err("broker returned unsupported asynchronous outcome".to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parent_process_id, validate_owner_process};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    #[test]
    fn resolves_a_real_parent_process_without_self_binding() {
        let parent = parent_process_id().expect("test harness parent process");
        let current = unsafe { GetCurrentProcessId() };
        assert_ne!(parent, 0);
        assert_ne!(parent, current);
    }

    #[test]
    fn validates_a_real_parent_process_before_waiting_on_it() {
        let parent = parent_process_id().expect("test harness parent process");
        let handle =
            unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, parent) };
        assert!(!handle.is_null(), "OpenProcess(test harness parent)");
        let result = validate_owner_process(handle, parent);
        unsafe { CloseHandle(handle) };
        result.expect("parent process identity must be pinned before waiting");
    }
}

fn connect(pipe_name: &str) -> Result<HANDLE, String> {
    let name = wide(pipe_name);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let pipe = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if pipe != INVALID_HANDLE_VALUE {
            return Ok(pipe);
        }
        if Instant::now() >= deadline {
            return Err(last_error("connect broker pipe"));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

unsafe fn exchange(pipe: HANDLE, frame: &[u8]) -> Result<BrokerLaunchResponse, String> {
    unsafe { write_all(pipe, frame)? };
    let mut prefix = [0u8; 4];
    unsafe { read_exact(pipe, &mut prefix)? };
    let payload_length = u32::from_le_bytes(prefix) as usize;
    if payload_length == 0 || payload_length > MAX_BROKER_MESSAGE_BYTES {
        return Err("invalid broker response length".to_owned());
    }
    let mut response_frame = Vec::with_capacity(4 + payload_length);
    response_frame.extend_from_slice(&prefix);
    response_frame.resize(4 + payload_length, 0);
    unsafe { read_exact(pipe, &mut response_frame[4..])? };
    let payload = decode_frame(&response_frame)
        .map_err(|error| format!("invalid response frame: {error:?}"))?;
    serde_json::from_slice(payload).map_err(|error| format!("invalid broker response: {error}"))
}

unsafe fn read_exact(pipe: HANDLE, mut buffer: &mut [u8]) -> Result<(), String> {
    while !buffer.is_empty() {
        let mut read = 0;
        if unsafe {
            ReadFile(
                pipe,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("read broker response"));
        }
        if read == 0 {
            return Err("broker closed before completing the response".to_owned());
        }
        buffer = &mut buffer[read as usize..];
    }
    Ok(())
}

unsafe fn write_all(pipe: HANDLE, mut buffer: &[u8]) -> Result<(), String> {
    while !buffer.is_empty() {
        let mut written = 0;
        if unsafe {
            WriteFile(
                pipe,
                buffer.as_ptr(),
                buffer.len() as u32,
                &mut written,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("write broker request"));
        }
        if written == 0 {
            return Err("broker request write made no progress".to_owned());
        }
        buffer = &buffer[written as usize..];
    }
    Ok(())
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(iter::once(0))
        .collect()
}

fn last_error(operation: &str) -> String {
    format!("{operation} failed: {}", std::io::Error::last_os_error())
}
