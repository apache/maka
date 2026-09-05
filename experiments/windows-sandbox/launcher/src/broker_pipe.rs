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

use std::ffi::{OsStr, c_void};
use std::iter;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_PIPE_CONNECTED, GetLastError, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_FIRST_PIPE_INSTANCE, FlushFileBuffers, PIPE_ACCESS_DUPLEX, ReadFile, WriteFile,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_WAIT,
};

use crate::broker_authorization::BrokerAuthorizer;
use crate::broker_framing::{MAX_BROKER_MESSAGE_BYTES, decode_frame, encode_frame};
use crate::broker_pipe_security::{pipe_security_sddl, validate_pipe_name};
use crate::protocol::{BrokerLaunchOutcome, BrokerLaunchRequest, BrokerLaunchResponse};
use crate::windows_launcher;

pub fn serve_once(pipe_name: &str, account_sid: &str, profile_digest: &str) -> Result<(), String> {
    validate_pipe_name(pipe_name).map_err(|error| format!("invalid broker pipe: {error:?}"))?;
    let sddl = pipe_security_sddl(account_sid)
        .map_err(|error| format!("invalid broker account SID: {error:?}"))?;
    unsafe { serve_once_with_security(pipe_name, &sddl, profile_digest) }
}

unsafe fn serve_once_with_security(
    pipe_name: &str,
    sddl: &str,
    profile_digest: &str,
) -> Result<(), String> {
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let sddl_wide = wide(sddl);
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(last_error(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        ));
    }
    let mut attributes: SECURITY_ATTRIBUTES = unsafe { zeroed() };
    attributes.nLength = size_of::<SECURITY_ATTRIBUTES>() as u32;
    attributes.lpSecurityDescriptor = descriptor as *mut c_void;
    attributes.bInheritHandle = 0;
    let pipe_name_wide = wide(pipe_name);
    let pipe = unsafe {
        CreateNamedPipeW(
            pipe_name_wide.as_ptr(),
            // FIRST_PIPE_INSTANCE makes creation fail closed when the name is
            // already taken: without it a same-user process could pre-create
            // the pipe and impersonate the broker toward the client.
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            (MAX_BROKER_MESSAGE_BYTES + 4) as u32,
            (MAX_BROKER_MESSAGE_BYTES + 4) as u32,
            5_000,
            &attributes,
        )
    };
    unsafe { LocalFree(descriptor as *mut c_void) };
    if pipe == INVALID_HANDLE_VALUE {
        return Err(last_error("CreateNamedPipeW"));
    }

    let result = (|| -> Result<(), String> {
        if unsafe { ConnectNamedPipe(pipe, null_mut()) } == 0
            && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED
        {
            return Err(last_error("ConnectNamedPipe"));
        }
        let mut client_pid = 0;
        if unsafe { GetNamedPipeClientProcessId(pipe, &mut client_pid) } == 0 {
            return Err(last_error("GetNamedPipeClientProcessId"));
        }
        let mut prefix = [0u8; 4];
        unsafe { read_exact(pipe, &mut prefix)? };
        let payload_length = u32::from_le_bytes(prefix) as usize;
        if payload_length == 0 || payload_length > MAX_BROKER_MESSAGE_BYTES {
            return Err("invalid broker payload length".to_owned());
        }
        let mut buffer = Vec::with_capacity(4 + payload_length);
        buffer.extend_from_slice(&prefix);
        buffer.resize(4 + payload_length, 0);
        unsafe { read_exact(pipe, &mut buffer[4..])? };
        let payload = decode_frame(&buffer).map_err(|error| format!("invalid frame: {error:?}"))?;
        let request: BrokerLaunchRequest = serde_json::from_slice(payload)
            .map_err(|error| format!("invalid broker request: {error}"))?;
        let request_id = request.request_id.clone();
        let mut authorizer = BrokerAuthorizer::new([profile_digest.to_owned()]);
        let outcome = match authorizer.authorize(&request, client_pid) {
            Ok(()) => match windows_launcher::launch_appcontainer(&request.launch) {
                Ok(exit_code) => BrokerLaunchOutcome::Completed { exit_code },
                Err(message) => BrokerLaunchOutcome::Rejected {
                    code: "appcontainer_launch_failed".to_owned(),
                    message,
                },
            },
            Err(error) => BrokerLaunchOutcome::Rejected {
                code: error.code().to_owned(),
                message: error.message(),
            },
        };
        let response = BrokerLaunchResponse {
            version: 1,
            request_id,
            outcome,
        };
        let response_payload = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
        let response_frame = encode_frame(&response_payload)
            .map_err(|error| format!("response frame rejected: {error:?}"))?;
        unsafe { write_all(pipe, &response_frame)? };
        if unsafe { FlushFileBuffers(pipe) } == 0 {
            return Err(last_error("FlushFileBuffers(broker response)"));
        }
        Ok(())
    })();
    unsafe {
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }
    result
}

unsafe fn read_exact(pipe: *mut c_void, mut buffer: &mut [u8]) -> Result<(), String> {
    while !buffer.is_empty() {
        let mut bytes_read = 0;
        if unsafe {
            ReadFile(
                pipe,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut bytes_read,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("ReadFile(broker request)"));
        }
        if bytes_read == 0 {
            return Err("broker client closed before completing the frame".to_owned());
        }
        buffer = &mut buffer[bytes_read as usize..];
    }
    Ok(())
}

unsafe fn write_all(pipe: *mut c_void, mut buffer: &[u8]) -> Result<(), String> {
    while !buffer.is_empty() {
        let mut bytes_written = 0;
        if unsafe {
            WriteFile(
                pipe,
                buffer.as_ptr(),
                buffer.len() as u32,
                &mut bytes_written,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("WriteFile(broker response)"));
        }
        if bytes_written == 0 {
            return Err("broker response write made no progress".to_owned());
        }
        buffer = &buffer[bytes_written as usize..];
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
