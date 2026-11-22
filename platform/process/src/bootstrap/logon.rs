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

use crate::windows::{checked, job::Job, owned, wait_process};
use maka_sandbox::windows::{Account, Desktop, ExecutionJob, Password};
use std::{
    fs::File,
    io,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, BorrowedHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    process::ExitStatus,
    sync::Arc,
};
use windows_sys::Win32::System::Threading::*;

pub const RUNNER: &str = "__maka-sandbox-runner";

/// Captured, already-authorized installation resources. Construction does not
/// start a process; the execution owner calls start only after admission.
pub struct Identity {
    pub account: Account,
    pub password: Password,
    pub desktop: Arc<Desktop>,
    pub job: Arc<ExecutionJob>,
    pub leases: Vec<File>,
}

/// Retain for the entire command tree, not merely until the bootstrap replies.
/// Dropping it kills its tree while preserving the installation's other work.
pub struct Runner {
    process: OwnedHandle,
    pub(crate) job: Job,
    pid: u32,
    _desktop: Arc<Desktop>,
    _execution: Arc<ExecutionJob>,
    _leases: Vec<File>,
    cleanup: crate::command::Cleanup,
    proxy: Option<Arc<maka_network::proxy::Proxy>>,
    closing_proxy: Option<maka_network::proxy::Proxy>,
}

impl Identity {
    pub async fn start(self, executable: PathBuf, endpoint: uuid::Uuid) -> io::Result<Runner> {
        tokio::task::spawn_blocking(move || self.start_native(&executable, endpoint))
            .await
            .map_err(io::Error::other)?
    }

    fn start_native(self, executable: &Path, endpoint: uuid::Uuid) -> io::Result<Runner> {
        if !executable.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "runner executable must be absolute",
            ));
        }
        let executable = wide(executable.as_os_str())?;
        // WithLogon has a 1024 UTF-16 command-line limit. Command bodies and
        // credentials never enter argv: only this random local endpoint does.
        let mut line = wide(std::ffi::OsStr::new(&format!(
            "maka {RUNNER} {endpoint} {}",
            std::process::id()
        )))?;
        let account = wide(std::ffi::OsStr::new(&self.account.name()))?;
        let domain = [b'.' as u16, 0];
        let mut desktop = wide(std::ffi::OsStr::new(self.desktop.name()))?;
        let system = std::env::var_os("SystemRoot")
            .ok_or_else(|| io::Error::other("SystemRoot is missing"))?;
        let cwd = wide(&system)?;
        // Trusted bootstrap does not inherit the Host's secrets or controls.
        let mut environment = wide(std::ffi::OsStr::new(&format!(
            "SystemRoot={}",
            system.to_string_lossy()
        )))?;
        environment.push(0);
        let startup = STARTUPINFOW {
            cb: size_of::<STARTUPINFOW>() as u32,
            lpDesktop: desktop.as_mut_ptr(),
            ..Default::default()
        };
        let job = Job(self.job.as_handle().try_clone_to_owned()?);
        let mut process = PROCESS_INFORMATION::default();
        checked(unsafe {
            CreateProcessWithLogonW(
                account.as_ptr(),
                domain.as_ptr(),
                self.password.as_wide().as_ptr(),
                0,
                executable.as_ptr(),
                line.as_mut_ptr(),
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environment.as_ptr().cast(),
                cwd.as_ptr(),
                &startup,
                &mut process,
            )
        })
        .map_err(|error| context("create account runner", error))?;
        let process_handle = owned(process.hProcess)?;
        let thread = owned(process.hThread)?;
        // The runner remains suspended until its unique command-tree Job owns it.
        // Secondary Logon may already have assigned a service-owned parent.
        let result = (|| {
            self.job
                .assign(process_handle.as_handle())
                .map_err(|error| context("attach execution Job", error))?;
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        })();
        if let Err(error) = result {
            unsafe {
                TerminateProcess(process_handle.as_raw_handle(), 130);
                WaitForSingleObject(process_handle.as_raw_handle(), 5_000);
            }
            return Err(error);
        }
        Ok(Runner {
            process: process_handle,
            job,
            pid: process.dwProcessId,
            _desktop: self.desktop,
            _execution: self.job,
            _leases: self.leases,
            cleanup: crate::command::Cleanup::Complete,
            proxy: None,
            closing_proxy: None,
        })
    }
}

impl Runner {
    pub fn with_proxy(mut self, proxy: Option<Arc<maka_network::proxy::Proxy>>) -> Self {
        self.proxy = proxy;
        self
    }
    /// Install the executor's durable settlement action before publishing this
    /// runner. Native tree drain always precedes revoking its permissions.
    pub fn with_cleanup(
        mut self,
        cleanup: impl FnOnce() -> io::Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.cleanup = crate::command::Cleanup::new(cleanup);
        self
    }

    pub async fn finish(&mut self) -> io::Result<()> {
        self.terminate()?;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !self.job.is_empty()? {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Ok::<_, io::Error>(())
        })
        .await
        .map_err(|_| io::Error::other("sandbox runner tree exit is unconfirmed"))??;
        if let Some(proxy) = self.proxy.take() {
            self.closing_proxy = Arc::into_inner(proxy);
        }
        if let Some(proxy) = &mut self.closing_proxy {
            proxy.close().await?;
            self.closing_proxy = None;
        }
        self.cleanup.finish().await
    }

    pub fn id(&self) -> u32 {
        self.pid
    }
    pub async fn wait(&self) -> io::Result<ExitStatus> {
        wait_process(&self.process).await
    }
    pub fn terminate(&self) -> io::Result<()> {
        self.job.terminate(130)
    }
}
impl AsHandle for Runner {
    fn as_handle(&self) -> BorrowedHandle<'_> {
        self.process.as_handle()
    }
}
impl Drop for Runner {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}
fn wide(value: &std::ffi::OsStr) -> io::Result<Vec<u16>> {
    let mut result: Vec<_> = value.encode_wide().collect();
    if result.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded NUL"));
    }
    result.push(0);
    Ok(result)
}

fn context(operation: &str, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{operation}: {error}"))
}
