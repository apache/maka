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

use crate::windows::checked;
use maka_sandbox::windows::Account;
use serde::{Serialize, de::DeserializeOwned};
use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, BorrowedHandle},
    ptr,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES,
    },
    System::{Pipes::GetNamedPipeClientProcessId, Threading::GetProcessId},
};

pub struct Endpoint {
    id: Uuid,
    server: NamedPipeServer,
}
pub struct Channel(NamedPipeServer);

impl Endpoint {
    pub fn new(account: &Account) -> io::Result<Self> {
        Self::principal(account.sid())
    }

    pub(super) fn current_user() -> io::Result<Self> {
        Self::principal("OW")
    }

    pub(super) fn administrative() -> io::Result<Self> {
        Self::principal("BA")
    }

    fn principal(identity: &str) -> io::Result<Self> {
        let id = Uuid::new_v4();
        // Only validated account SIDs or the built-in Administrators alias.
        let sddl: Vec<_> = format!("D:P(A;;GA;;;OW)(A;;GA;;;SY)(A;;GRGW;;;{identity})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = ptr::null_mut();
        checked(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        })?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let server = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .max_instances(1)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    name(id),
                    (&attributes as *const SECURITY_ATTRIBUTES)
                        .cast_mut()
                        .cast(),
                )
        };
        unsafe {
            LocalFree(descriptor);
        }
        Ok(Self {
            id,
            server: server?,
        })
    }

    pub fn id(&self) -> Uuid {
        self.id
    }

    /// No credential or command is sent until the connecting process matches
    /// the live process handle returned by the account launch.
    pub async fn accept(
        self,
        process: BorrowedHandle<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> io::Result<Channel> {
        let expected = unsafe { GetProcessId(process.as_raw_handle()) };
        if expected == 0 {
            return Err(io::Error::last_os_error());
        }
        let process = process.try_clone_to_owned()?;
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(cancelled()),
            connected = self.server.connect() => connected,
            status = crate::windows::wait_process(&process) => {
                Err(io::Error::other(format!("sandbox helper exited before connecting: {}", status?)))
            }
        }?;
        let mut client = 0;
        checked(unsafe { GetNamedPipeClientProcessId(self.server.as_raw_handle(), &mut client) })?;
        if client != expected {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "unexpected sandbox runner peer",
            ));
        }
        Ok(Channel(self.server))
    }
}
impl Channel {
    pub async fn send(&mut self, request: &impl Serialize) -> io::Result<()> {
        send(&mut self.0, request).await
    }
    pub async fn receive<T: DeserializeOwned>(&mut self) -> io::Result<T> {
        receive(&mut self.0).await
    }
}
pub(super) fn name(id: Uuid) -> String {
    format!(r"\\.\pipe\maka-sandbox-{id}")
}

pub(super) async fn send(
    output: &mut (impl AsyncWrite + Unpin),
    value: &impl Serialize,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if u32::try_from(bytes.len()).is_err() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "sandbox frame exceeds limit",
        ));
    }
    output.write_u32_le(bytes.len() as u32).await?;
    output.write_all(&bytes).await?;
    output.flush().await
}
pub(super) async fn receive<T: DeserializeOwned>(
    input: &mut (impl AsyncRead + Unpin),
) -> io::Result<T> {
    let size = input.read_u32_le().await? as usize;
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

pub(super) fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "sandbox launch cancelled")
}
