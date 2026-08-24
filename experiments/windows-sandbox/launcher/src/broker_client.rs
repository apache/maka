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
    CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING, ReadFile, WriteFile};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;

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
    request.client_pid = unsafe { GetCurrentProcessId() };
    request.validate()?;
    // The packaged path is a same-process one-shot launch. Authorize and hand
    // off directly instead of routing through a synchronous named-pipe thread;
    // the standalone pipe modes remain only as transport experiments.
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
    windows_launcher::launch_appcontainer(&request.launch)
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
