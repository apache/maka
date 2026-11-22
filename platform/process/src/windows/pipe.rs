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

use super::checked;
use std::{
    fs::{File, OpenOptions},
    io,
    mem::size_of,
    os::windows::io::AsRawHandle,
    ptr,
};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::{
    Foundation::{HANDLE_FLAG_INHERIT, LocalFree, SetHandleInformation},
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        SECURITY_ATTRIBUTES,
    },
    System::Pipes::GetNamedPipeClientProcessId,
};

/// One connected, owner-only output pipe. Only its write end is inherited.
pub(crate) async fn output() -> io::Result<(NamedPipeServer, File)> {
    connected(true, true).await
}

pub(crate) async fn input() -> io::Result<(NamedPipeServer, File)> {
    connected(false, true).await
}

/// The ConPTY ends are synchronous and never inherited by the child.
pub(crate) async fn pty_output() -> io::Result<(NamedPipeServer, File)> {
    connected(true, false).await
}

pub(crate) async fn pty_input() -> io::Result<(NamedPipeServer, File)> {
    connected(false, false).await
}

async fn connected(inbound: bool, inherit: bool) -> io::Result<(NamedPipeServer, File)> {
    let name = format!(r"\\.\pipe\maka-shell-{}", uuid::Uuid::new_v4());
    let server = {
        let descriptor: Vec<_> = "D:P(A;;GA;;;OW)(A;;GA;;;SY)"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut security = ptr::null_mut();
        // SAFETY: input is terminated; Windows owns the returned allocation.
        unsafe {
            checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                descriptor.as_ptr(),
                SDDL_REVISION_1,
                &mut security,
                ptr::null_mut(),
            ))?;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: security,
            bInheritHandle: 0,
        };
        // SAFETY: descriptor and attributes remain live through creation.
        let server = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .access_inbound(inbound)
                .access_outbound(!inbound)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    &name,
                    (&attributes as *const SECURITY_ATTRIBUTES)
                        .cast_mut()
                        .cast(),
                )
        };
        // SAFETY: this allocation came from the conversion above, creation copied it.
        unsafe {
            LocalFree(security);
        }
        server?
    };
    let writer = OpenOptions::new()
        .write(inbound)
        .read(!inbound)
        .open(&name)?;
    server.connect().await?;
    let mut peer = 0;
    // SAFETY: both handles are owned here; no child exists yet.
    unsafe {
        checked(GetNamedPipeClientProcessId(
            server.as_raw_handle(),
            &mut peer,
        ))?;
        if peer != std::process::id() {
            return Err(io::Error::other("unexpected shell pipe peer"));
        }
        checked(SetHandleInformation(
            writer.as_raw_handle(),
            HANDLE_FLAG_INHERIT,
            if inherit { HANDLE_FLAG_INHERIT } else { 0 },
        ))?;
    }
    Ok((server, writer))
}
