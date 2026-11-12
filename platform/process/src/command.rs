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

#[cfg(any(target_os = "linux", windows))]
mod cleanup;
#[cfg(windows)]
mod windows;
#[cfg(any(target_os = "linux", windows))]
pub(crate) use cleanup::Cleanup;

use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

/// Captured launch data shared by native pipe and PTY transports. It deliberately
/// does not try to reverse-engineer platform-specific std::Command internals.
pub struct Command {
    #[cfg(target_os = "macos")]
    pub(crate) private_stdio: bool,
    #[cfg(unix)]
    pub(crate) external_owner: Option<PathBuf>,
    pub(crate) executable: PathBuf,
    pub(crate) args: Vec<Argument>,
    pub(crate) cwd: WorkingDirectory,
    pub(crate) selection: OnceLock<Arc<()>>,
    pub(crate) directory: Option<std::sync::Arc<crate::directory::Directory>>,
    pub(crate) environment: BTreeMap<OsString, OsString>,
    pub(crate) sandbox: maka_sandbox::Sandbox,
    pub(crate) network_route: maka_network::Policy,
    #[cfg(unix)]
    proxy: Option<maka_network::proxy::Proxy>,
    #[cfg(target_os = "macos")]
    proxy_address: Option<std::net::SocketAddr>,
    #[cfg(target_os = "linux")]
    network_helper: Option<PathBuf>,
    #[cfg(windows)]
    backend: Option<std::sync::Arc<dyn crate::bootstrap::Backend>>,
    #[cfg(windows)]
    startup_cancellation: tokio_util::sync::CancellationToken,
    #[cfg(windows)]
    launch: Option<crate::bootstrap::Launch>,
    #[cfg(windows)]
    write_token: Option<std::sync::Arc<maka_sandbox::windows::WriteToken>>,
    #[cfg(target_os = "linux")]
    files: Vec<std::fs::File>,
    #[cfg(target_os = "linux")]
    pub(crate) mount_lease: Option<maka_sandbox::launch::MountLease>,
}

pub(crate) enum WorkingDirectory {
    Captured(PathBuf),
    PrivateWorkspace,
}
impl WorkingDirectory {
    pub(crate) fn is_absolute(&self) -> bool {
        match self {
            Self::Captured(path) => path.is_absolute(),
            Self::PrivateWorkspace => false,
        }
    }
    pub(crate) fn captured(&self) -> &PathBuf {
        match self {
            Self::Captured(path) => path,
            Self::PrivateWorkspace => {
                unreachable!("private command must be consumed by its TaskOwner")
            }
        }
    }
}

/// Only successful platform preparation can construct a native launch. Keeping
/// conversion off Command makes forgetting the sandbox a compile-time error.
pub(crate) struct Prepared(Command);

#[cfg_attr(windows, derive(serde::Serialize, serde::Deserialize))]
pub(crate) enum Argument {
    Quoted(OsString),
    #[cfg(windows)]
    Verbatim(OsString),
}

impl AsRef<OsStr> for Argument {
    fn as_ref(&self) -> &OsStr {
        match self {
            Self::Quoted(value) => value,
            #[cfg(windows)]
            Self::Verbatim(value) => value,
        }
    }
}

#[cfg(windows)]
impl Argument {
    pub(crate) fn command_line(&self) -> std::io::Result<String> {
        let value = self
            .as_ref()
            .to_str()
            .ok_or_else(|| std::io::Error::other("PTY arguments must be UTF-8"))?;
        Ok(match self {
            Self::Quoted(_) => crate::shell::command::quote(value),
            Self::Verbatim(_) => value.into(),
        })
    }
}

impl Command {
    pub fn new(executable: impl Into<PathBuf>, cwd: impl Into<PathBuf>) -> Self {
        Self::with_directory(executable.into(), WorkingDirectory::Captured(cwd.into()))
    }

    /// No ambient or placeholder cwd. Only TaskOwner may consume this command.
    pub fn private_task(executable: impl Into<PathBuf>) -> Self {
        Self::with_directory(executable.into(), WorkingDirectory::PrivateWorkspace)
    }

    /// Selected launch data, never permission to read or execute this path.
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    fn with_directory(executable: PathBuf, cwd: WorkingDirectory) -> Self {
        Self {
            #[cfg(unix)]
            external_owner: None,
            #[cfg(target_os = "macos")]
            private_stdio: false,
            executable,
            args: Vec::new(),
            cwd,
            selection: OnceLock::new(),
            directory: None,
            environment: crate::environment::inherit(std::env::vars_os()),
            sandbox: maka_sandbox::Sandbox::Disabled,
            network_route: maka_network::Policy::default(),
            #[cfg(unix)]
            proxy: None,
            #[cfg(target_os = "macos")]
            proxy_address: None,
            #[cfg(target_os = "linux")]
            network_helper: None,
            #[cfg(windows)]
            backend: None,
            #[cfg(windows)]
            startup_cancellation: tokio_util::sync::CancellationToken::new(),
            #[cfg(windows)]
            launch: None,
            #[cfg(windows)]
            write_token: None,
            #[cfg(target_os = "linux")]
            files: Vec::new(),
            #[cfg(target_os = "linux")]
            mount_lease: None,
        }
    }

    pub fn arg(&mut self, value: impl AsRef<OsStr>) -> &mut Self {
        self.args.push(Argument::Quoted(value.as_ref().to_owned()));
        self
    }

    pub fn env_clear(&mut self) -> &mut Self {
        self.environment.clear();
        self
    }

    /// Capture upstream routing without granting network access.
    pub fn network_route(mut self, route: maka_network::Policy) -> Self {
        self.network_route = route;
        self
    }

    #[cfg(target_os = "linux")]
    pub fn with_network_helper(mut self, helper: PathBuf) -> Self {
        self.network_helper = Some(helper);
        self
    }

    /// Explicit executor-owned installation; never inferred from environment or
    /// process-global state. Merely capturing it performs no native work.
    #[cfg(windows)]
    pub fn with_backend(mut self, backend: std::sync::Arc<dyn crate::bootstrap::Backend>) -> Self {
        self.backend = Some(backend);
        self
    }

    /// Connect admission to its actual execution owner. Startup still settles
    /// every acquired native resource before reporting cancellation.
    #[cfg(windows)]
    pub fn with_startup_cancellation(
        mut self,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Self {
        self.startup_cancellation = cancellation;
        self
    }

    /// Apply the runner's write-restricted token at process creation. This is
    /// only the token layer: the caller must already own account isolation,
    /// network rules and ACL lifetime. It cannot replace a managed policy.
    #[cfg(windows)]
    pub fn with_write_token(
        mut self,
        token: std::sync::Arc<maka_sandbox::windows::WriteToken>,
    ) -> Self {
        self.write_token = Some(token);
        self
    }

    /// Capture an already authorized policy without creating native resources.
    /// Dropping an unstarted plan never changes the filesystem. Windows verbatim
    /// arguments retain their original representation.
    pub fn sandbox(mut self, policy: &maka_sandbox::Sandbox) -> Result<Self, maka_sandbox::Error> {
        if !self.executable.is_absolute() {
            return Err(maka_sandbox::Error::Invalid(
                "sandbox executable must be absolute".into(),
            ));
        }
        if let maka_sandbox::Sandbox::Managed { filesystem, .. } = policy {
            filesystem.compile()?;
        }
        self.sandbox = policy.clone();
        Ok(self)
    }

    /// Only the accepted process owner calls this, and must await startup rather
    /// than race it against cancellation. Filesystem preparation runs off the
    /// async scheduler; the owner's admission fence covers preparation and spawn.
    pub(crate) async fn prepare(self) -> Result<Prepared, maka_agent_facts::tools::ToolError> {
        if matches!(self.cwd, WorkingDirectory::PrivateWorkspace) {
            return Err(crate::failed(
                "private command requires its original TaskOwner",
            ));
        }
        if matches!(self.sandbox, maka_sandbox::Sandbox::Disabled) {
            return Ok(Prepared(self));
        }
        #[cfg(target_os = "macos")]
        let mut command = self;
        #[cfg(target_os = "macos")]
        if let maka_sandbox::Sandbox::Managed {
            network: maka_sandbox::Network::Restricted { .. },
            ..
        } = &command.sandbox
        {
            let maka_sandbox::Sandbox::Managed { network, .. } = &command.sandbox else {
                unreachable!()
            };
            let (address, proxy) =
                maka_network::proxy::Proxy::start(network.clone(), command.network_route.clone())
                    .await
                    .map_err(crate::failed)?;
            let url = format!("http://{address}");
            for key in [
                "HTTP_PROXY",
                "http_proxy",
                "HTTPS_PROXY",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
            ] {
                command.env(key, &url);
            }
            command.env("NO_PROXY", "").env("no_proxy", "");
            command.proxy = Some(proxy);
            command.proxy_address = Some(address);
        }
        #[cfg(target_os = "linux")]
        let mut command = self;
        #[cfg(target_os = "linux")]
        if let maka_sandbox::Sandbox::Managed {
            network: network @ maka_sandbox::Network::Restricted { .. },
            ..
        } = &command.sandbox
        {
            use std::os::fd::AsRawFd;
            let helper = command
                .network_helper
                .take()
                .filter(|path| path.is_absolute())
                .ok_or_else(|| {
                    std::io::Error::other(
                        "restricted network requires the trusted CLI namespace helper",
                    )
                })
                .map_err(crate::failed)?;
            let (control, proxy) =
                crate::network_namespace::prepare(network.clone(), command.network_route.clone())
                    .map_err(crate::failed)?;
            let mut args = vec![
                Argument::Quoted(crate::network_namespace::HELPER.into()),
                Argument::Quoted(control.as_raw_fd().to_string().into()),
                Argument::Quoted(command.executable.into_os_string()),
            ];
            args.append(&mut command.args);
            command.args = args;
            command.executable = helper;
            command.files.push(control);
            command.proxy = Some(proxy);
        }
        #[cfg(windows)]
        let command = self;
        #[cfg(windows)]
        if let maka_sandbox::Sandbox::Managed {
            filesystem,
            network,
        } = &command.sandbox
        {
            let backend = command
                .backend
                .as_ref()
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "Windows sandbox execution requires an explicit installation",
                    )
                })
                .map_err(crate::failed)?;
            let launch = backend
                .prepare(
                    filesystem.clone(),
                    network.clone(),
                    command.network_route.clone(),
                    command.executable.clone(),
                    command.cwd.captured().clone(),
                )
                .await
                .map_err(crate::launch_error)?;
            let mut command = command;
            if let Some(address) = launch.proxy_address() {
                let url = format!("http://{address}");
                for key in [
                    "HTTP_PROXY",
                    "http_proxy",
                    "HTTPS_PROXY",
                    "https_proxy",
                    "ALL_PROXY",
                    "all_proxy",
                ] {
                    command.env(key, &url);
                }
                command.env("NO_PROXY", "").env("no_proxy", "");
            }
            command.launch = Some(launch);
            return Ok(Prepared(command));
        }
        // The asynchronous owner retains the live gateway while the native
        // compiler runs. A failed compiler or lost worker cannot detach it.
        #[cfg(unix)]
        let mut proxy = command.proxy.take();
        #[cfg(unix)]
        let private_network = proxy.is_some();
        #[cfg(windows)]
        let private_network = false;
        let prepared =
            tokio::task::spawn_blocking(move || command.prepare_native(private_network)).await;
        let error = match prepared {
            Ok(Ok(prepared)) => {
                #[cfg(unix)]
                let mut prepared = prepared;
                #[cfg(unix)]
                {
                    prepared.0.proxy = proxy;
                }
                return Ok(prepared);
            }
            Ok(Err(maka_sandbox::Error::CleanupUnconfirmed(message))) => {
                maka_agent_facts::tools::ToolError::CleanupUnconfirmed(message)
            }
            Ok(Err(error)) => crate::failed(error),
            Err(error) => maka_agent_facts::tools::ToolError::CleanupUnconfirmed(error.to_string()),
        };
        #[cfg(unix)]
        if let Some(proxy) = &mut proxy {
            proxy.close().await.map_err(|error| {
                maka_agent_facts::tools::ToolError::CleanupUnconfirmed(error.to_string())
            })?;
        }
        Err(error)
    }

    fn prepare_native(mut self, _private_network: bool) -> Result<Prepared, maka_sandbox::Error> {
        if let Some(name) = self
            .environment
            .keys()
            .find(|name| crate::environment::controls_loader(name))
        {
            return Err(maka_sandbox::Error::Invalid(format!(
                "{} controls the sandbox launcher's loader; set it inside the sandboxed command instead (for example with env)",
                name.to_string_lossy()
            )));
        }
        #[cfg(target_os = "linux")]
        let launch = if _private_network {
            self.sandbox.prepare_with_private_network(
                self.cwd.captured(),
                self.directory.as_ref().map(|dir| &dir.file),
            )?
        } else {
            self.sandbox.prepare_captured(
                self.cwd.captured(),
                self.directory.as_ref().map(|dir| &dir.file),
            )?
        };
        #[cfg(windows)]
        let launch = self.sandbox.prepare(self.cwd.captured())?;
        #[cfg(target_os = "macos")]
        let launch = match self.proxy_address {
            Some(address) => self
                .sandbox
                .prepare_with_proxy(self.cwd.captured(), address)?,
            None => self.sandbox.prepare(self.cwd.captured())?,
        };
        match launch {
            maka_sandbox::launch::Launch::Direct => {}
            maka_sandbox::launch::Launch::Wrapped {
                program,
                args,
                #[cfg(target_os = "linux")]
                files,
                #[cfg(target_os = "linux")]
                lease,
            } => {
                let mut wrapped: Vec<_> = args.into_iter().map(Argument::Quoted).collect();
                wrapped.push(Argument::Quoted(self.executable.into_os_string()));
                wrapped.append(&mut self.args);
                self.executable = program;
                self.args = wrapped;
                #[cfg(target_os = "linux")]
                {
                    self.files.extend(files);
                    self.mount_lease = Some(lease);
                }
            }
        }
        Ok(Prepared(self))
    }

    pub fn args<I, S>(&mut self, values: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args.extend(
            values
                .into_iter()
                .map(|v| Argument::Quoted(v.as_ref().to_owned())),
        );
        self
    }

    /// Append literal Windows command-line syntax without CRT argument quoting.
    /// The caller must supply the target program's quoting (e.g. cmd.exe /c).
    #[cfg(windows)]
    pub fn raw_arg(&mut self, value: impl AsRef<OsStr>) -> &mut Self {
        self.args
            .push(Argument::Verbatim(value.as_ref().to_owned()));
        self
    }

    pub fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self {
        let key = key.as_ref();
        #[cfg(windows)]
        self.environment.retain(|existing, _| {
            existing.to_string_lossy().to_uppercase() != key.to_string_lossy().to_uppercase()
        });
        self.environment
            .insert(key.to_owned(), value.as_ref().to_owned());
        self
    }
}

impl Prepared {
    #[cfg(unix)]
    pub(crate) fn take_external_owner(&mut self) -> Option<PathBuf> {
        self.0.external_owner.take()
    }
    /// A failed/cancelled startup still owns every acquired preparation guard.
    /// Attempt every cleanup before reporting a sticky unconfirmed result.
    pub(crate) async fn abort(mut self) -> Result<(), maka_agent_facts::tools::ToolError> {
        let mut failure = None;
        #[cfg(unix)]
        if let Some(proxy) = &mut self.0.proxy
            && let Err(error) = proxy.close().await
        {
            failure = Some(error.to_string());
        }
        #[cfg(target_os = "linux")]
        if let Err(error) = Cleanup::from(self.0.mount_lease.take()).finish().await {
            failure.get_or_insert_with(|| error.to_string());
        }
        #[cfg(windows)]
        if let Some(launch) = self.0.launch.take()
            && let Err(error) = launch.abort().await
        {
            failure = Some(error.to_string());
        }
        match failure {
            Some(message) => Err(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(
                message,
            )),
            None => Ok(()),
        }
    }
    #[cfg(unix)]
    pub(crate) fn take_proxy(&mut self) -> Option<maka_network::proxy::Proxy> {
        self.0.proxy.take()
    }
    #[cfg(windows)]
    pub(crate) fn take_launch(&mut self) -> Option<crate::bootstrap::Launch> {
        self.0.launch.take()
    }

    #[cfg(windows)]
    pub(crate) fn startup_cancellation(&self) -> tokio_util::sync::CancellationToken {
        self.0.startup_cancellation.clone()
    }

    #[cfg(windows)]
    pub(crate) fn directory(&self) -> Option<std::sync::Arc<crate::directory::Directory>> {
        self.0.directory.clone()
    }

    #[cfg(windows)]
    pub(crate) fn runner_plan(self) -> crate::bootstrap::protocol::Plan {
        crate::bootstrap::protocol::Plan {
            executable: self.0.executable,
            args: self.0.args,
            cwd: self.0.cwd.captured().clone(),
            environment: self.0.environment.into_iter().collect(),
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn take_mount_lease(&mut self) -> Option<maka_sandbox::launch::MountLease> {
        self.0.mount_lease.take()
    }

    #[cfg(unix)]
    pub(crate) fn isolate_stdio(
        &self,
        command: &mut tokio::process::Command,
    ) -> std::io::Result<()> {
        #[cfg(target_os = "macos")]
        if self.0.private_stdio {
            crate::stdio_exec::install(command)?;
        }
        #[cfg(not(target_os = "macos"))]
        let _ = command;
        Ok(())
    }

    #[cfg(unix)]
    pub(crate) fn unix(&mut self) -> tokio::process::Command {
        let plan = &mut self.0;
        let mut command = tokio::process::Command::new(&plan.executable);
        command
            .args(&plan.args)
            .current_dir(plan.cwd.captured())
            .env_clear()
            .envs(&plan.environment);
        if let Some(directory) = plan.directory.clone() {
            use std::os::fd::AsRawFd;
            // Only async-signal-safe fchdir runs in the child. The captured
            // descriptor remains live in this closure through exec.
            unsafe {
                command.pre_exec(move || {
                    if libc::fchdir(directory.file.as_raw_fd()) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        #[cfg(target_os = "linux")]
        if !plan.files.is_empty() {
            use std::os::fd::AsRawFd;
            let files = std::mem::take(&mut plan.files);
            // Keep the pinned descriptors alive with Command. Clear CLOEXEC
            // only after fork, never in the multithreaded Host.
            unsafe {
                command.pre_exec(move || {
                    for file in &files {
                        if libc::fcntl(file.as_raw_fd(), libc::F_SETFD, 0) == -1 {
                            return Err(std::io::Error::last_os_error());
                        }
                    }
                    Ok(())
                });
            }
        }
        command
    }
}
