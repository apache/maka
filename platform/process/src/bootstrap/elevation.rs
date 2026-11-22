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

mod caller;
use super::{Endpoint, channel};
use crate::windows::{checked, owned};
pub use caller::Caller;
use serde::{Serialize, de::DeserializeOwned};
use std::{
    io,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr,
    time::Duration,
};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use windows_sys::Win32::{
    System::{
        Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize},
        Pipes::GetNamedPipeServerProcessId,
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
    },
    UI::Shell::{
        SEE_MASK_FLAG_NO_UI, SEE_MASK_NO_CONSOLE, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
        SHELLEXECUTEINFOW, ShellExecuteExW,
    },
};

pub const ELEVATED_SETUP: &str = "__maka-sandbox-setup";

/// A user-authorized, one-shot helper, not a privileged command service.
/// Its request handler must own durable recovery before performing OS effects.
/// Once delivered, accepted work may finish even if its caller disconnects.
/// The caller owns the operation deadline, including consent and completion.
pub async fn administrative<Request: Serialize, Response: DeserializeOwned>(
    executable: &Path,
    request: &Request,
) -> io::Result<Response> {
    let endpoint = Endpoint::administrative()?;
    let executable = executable.to_owned();
    let id = endpoint.id();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // ShellExecute's consent dialog may wait for a human. A dedicated short-
    // lived STA, rather than Tokio's blocking pool, keeps runtime shutdown and
    // unrelated work independent of that wait. A late helper sees a closed pipe.
    std::thread::Builder::new()
        .name("sandbox-consent".into())
        .spawn(move || {
            let _ = sender.send(start(&executable, id));
        })?;
    let process = receiver.await.map_err(io::Error::other)??;
    // Unlike command execution, this one-shot privileged helper has no running
    // execution owner. Preserve its existing initial handoff deadline locally;
    // an admitted administrative operation itself still owns completion.
    let cancellation = tokio_util::sync::CancellationToken::new();
    let mut connection = tokio::time::timeout(
        Duration::from_secs(15),
        endpoint.accept(process.as_handle(), &cancellation),
    )
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "sandbox setup helper did not connect",
        )
    })??;
    tokio::time::timeout(Duration::from_secs(15), connection.send(request))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "sandbox setup was not admitted"))??;
    connection.receive().await
}

pub struct AdministrativeRequest<T> {
    pub value: T,
    pub caller: Caller,
    connection: NamedPipeClient,
}
impl<T> AdministrativeRequest<T> {
    pub async fn respond(self, response: &impl Serialize) -> io::Result<()> {
        let mut connection = self.connection;
        tokio::time::timeout(
            Duration::from_secs(15),
            channel::send(&mut connection, response),
        )
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "sandbox setup reply was not collected",
            )
        })?
    }
}

/// The elevated helper accepts exactly one bounded request from the captured
/// Host process running the same executable. No authority is taken from argv
/// beyond the random local rendezvous and the expected caller identity.
pub async fn receive_administrative<T: DeserializeOwned>(
    endpoint: uuid::Uuid,
    expected_host: u32,
) -> io::Result<AdministrativeRequest<T>> {
    let host = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, expected_host) })?;
    let mut image = vec![0u16; 32768];
    let mut length = image.len() as u32;
    checked(unsafe {
        QueryFullProcessImageNameW(host.as_raw_handle(), 0, image.as_mut_ptr(), &mut length)
    })?;
    let image =
        PathBuf::from(String::from_utf16(&image[..length as usize]).map_err(io::Error::other)?);
    if dunce::canonicalize(image)? != dunce::canonicalize(std::env::current_exe()?)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unexpected setup caller executable",
        ));
    }
    let caller = Caller::capture(host.as_handle())?;
    let mut connection = ClientOptions::new().open(channel::name(endpoint))?;
    let mut server = 0;
    checked(unsafe { GetNamedPipeServerProcessId(connection.as_raw_handle(), &mut server) })?;
    if server != expected_host {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unexpected setup caller peer",
        ));
    }
    let value = tokio::time::timeout(Duration::from_secs(15), channel::receive(&mut connection))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "sandbox setup was not admitted"))??;
    Ok(AdministrativeRequest {
        value,
        caller,
        connection,
    })
}

fn start(executable: &Path, endpoint: uuid::Uuid) -> io::Result<OwnedHandle> {
    if !executable.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "setup executable must be absolute",
        ));
    }
    let result = unsafe {
        CoInitializeEx(
            ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    if result < 0 {
        return Err(io::Error::other(format!(
            "initialize consent apartment: HRESULT 0x{:08x}",
            result as u32
        )));
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _apartment = Apartment;
    let executable = wide(executable.as_os_str())?;
    let parameters = wide(std::ffi::OsStr::new(&format!(
        "{ELEVATED_SETUP} {endpoint} {}",
        std::process::id()
    )))?;
    let verb = wide(std::ffi::OsStr::new("runas"))?;
    let mut request = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS
            | SEE_MASK_NOASYNC
            | SEE_MASK_FLAG_NO_UI
            | SEE_MASK_NO_CONSOLE,
        lpVerb: verb.as_ptr(),
        lpFile: executable.as_ptr(),
        lpParameters: parameters.as_ptr(),
        nShow: 0,
        ..Default::default()
    };
    checked(unsafe { ShellExecuteExW(&mut request) })?;
    owned(request.hProcess)
}
fn wide(value: &std::ffi::OsStr) -> io::Result<Vec<u16>> {
    let mut value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "NUL in setup launch",
        ));
    }
    value.push(0);
    Ok(value)
}
