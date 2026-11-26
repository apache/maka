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

//! Native Windows process-security-environment isolation. The execution owner
//! retains this handle until the entire command tree is ready to settle.

mod availability;
mod policy;

pub use availability::is_available;

use crate::{Error, Network, filesystem};
use mxc_sdk::v1::{
    self, ContainerRequest, MxcProcess, SpawnExtendedOptions, SpawnStdio, TelemetryConfig,
    WaitResult,
};
use std::{
    ffi::{OsStr, OsString},
    io,
    os::windows::io::{AsHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    path::Path,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

// tracelogging 1.2.3 leaves these documented Advapi32 exports to its consumer.
#[link(name = "advapi32")]
unsafe extern "system" {}

/// A policy already checked against native PSEC capabilities. SDK types and
/// fallback dispatch remain private; a launch error never selects another tier.
pub struct PreparedPolicy {
    request: ContainerRequest,
}

impl PreparedPolicy {
    pub fn new(
        filesystem: &filesystem::Policy,
        network: &Network,
        cwd: &Path,
    ) -> Result<Self, Error> {
        if !is_available() {
            return Err(Error::Unsupported(
                "native Windows process security environments are unavailable".into(),
            ));
        }
        let request = policy::prepare(filesystem, network, cwd)?;
        if !availability::supports_deny_paths() {
            return Err(Error::Unsupported(
                "this Windows build cannot enforce native MXC deny paths".into(),
            ));
        }
        Ok(Self { request })
    }

    /// Launch inside the calling helper's inherited pipes or ConPTY. The process
    /// layer supplies its original Windows command line, including raw arguments.
    pub fn spawn_inherited(
        &self,
        command_line: &OsStr,
        cwd: &Path,
        environment: &[(OsString, OsString)],
    ) -> Result<Execution, Error> {
        crate::path::validate(cwd)?;
        let command_line = unicode(command_line, "command line")?;
        if command_line.is_empty() || command_line.contains('\0') {
            return Err(Error::Invalid("invalid Windows command line".into()));
        }
        let mut env = environment
            .iter()
            .map(|(key, value)| {
                let key = unicode(key, "environment variable name")?;
                let value = unicode(value, "environment variable value")?;
                if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
                    return Err(Error::Invalid("invalid Windows environment entry".into()));
                }
                Ok((key.to_owned(), value.to_owned()))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        // The native SDK needs these startup locations even for env_clear.
        // The helper receives them from the Host independently of the command
        // environment. Override aliases rather than accepting poisoned paths,
        // and retain the caller's explicit environment for every other key.
        for key in ["SystemRoot", "SystemDrive", "LOCALAPPDATA"] {
            let value = std::env::var(key)
                .ok()
                .filter(|value| !value.is_empty() && !value.contains('\0'))
                .ok_or_else(|| {
                    Error::Invalid(format!("MXC requires a nonempty Unicode Host {key}"))
                })?;
            env.retain(|(name, _)| !name.eq_ignore_ascii_case(key));
            env.push((key.to_owned(), value));
        }
        let mut request = self.request.clone();
        request.command = command_line.into();
        request.working_directory = Some(unicode(cwd.as_os_str(), "working directory")?.into());
        request.environment = Some(env);
        request.inherit_default_environment = Some(false);
        let mut options = SpawnExtendedOptions::default();
        options.stdio = SpawnStdio::Inherit;
        options.telemetry = Some(TelemetryConfig {
            enabled: Some(false),
        });
        // The free-form SDK message may include the original command or environment.
        let child = v1::spawn_with_extended_options(request, options).map_err(|error| {
            io::Error::other(format!(
                "MXC {} in {} ({})",
                error.code,
                error.operation.as_deref().unwrap_or("spawn"),
                error.native_code.as_deref().unwrap_or("no native code")
            ))
        })?;
        // The SDK retains the original process handle while we open this handle,
        // so the process object and its PID cannot be recycled between the calls.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                0,
                child.id(),
            )
        };
        if handle.is_null() {
            // Dropping child terminates its tree before releasing enforcement.
            return Err(io::Error::last_os_error().into());
        }
        // SAFETY: OpenProcess returned a fresh owned handle.
        let process = unsafe { OwnedHandle::from_raw_handle(handle) };
        Ok(Execution { child, process })
    }
}

/// Root exit observation does not release the Job or PSEC policy. In particular,
/// callers must not finish_tree merely because the foreground shell has exited.
pub struct Execution {
    child: MxcProcess,
    process: OwnedHandle,
}

impl Execution {
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<i32>> {
        self.child.try_wait()
    }

    pub fn terminate(&mut self) -> io::Result<()> {
        self.child.kill()
    }

    /// Complete execution ownership, terminating remaining descendants before
    /// releasing native policy. Call only at the real execution settlement.
    pub fn finish_tree(&mut self) -> io::Result<i32> {
        match self.child.wait()? {
            WaitResult::Exited(code) => Ok(code),
            WaitResult::TimedOut => Err(io::ErrorKind::TimedOut.into()),
        }
    }
}

impl AsHandle for Execution {
    fn as_handle(&self) -> BorrowedHandle<'_> {
        self.process.as_handle()
    }
}

fn unicode<'a>(value: &'a OsStr, name: &str) -> Result<&'a str, Error> {
    value
        .to_str()
        .ok_or_else(|| Error::Invalid(format!("MXC requires a Unicode {name}")))
}
