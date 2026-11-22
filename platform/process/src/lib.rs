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

//! Native process primitives executing captured, optionally sandboxed commands.
//! Durable background/PTY resource ownership belongs to the runtime.

#[cfg(windows)]
pub mod bootstrap;
mod command;
pub mod detached;
mod directory;
mod environment;
pub mod isolated;
pub mod lifetime;
pub mod pipe;
pub use command::Command;
#[cfg(target_os = "linux")]
pub mod network_namespace;
mod output;
pub mod system;
pub use output::{Captured as PipeResult, Outcome as ProcessOutcome, Termination};
#[cfg(unix)]
mod group;
mod process;
pub mod pty;
mod shell;
mod tail;
pub mod terminal;
#[cfg(windows)]
mod windows;

use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

// The wire name describes the capability, not a platform-specific executable.
pub const SHELL_NAME: &str = "Shell";
pub const SHELL_DESCRIPTION: &str = "Execute a command with the authorized filesystem and network access. Returns bounded stdout/stderr tails.";
const DEFAULT_TIMEOUT_MS: u64 = 120_000;

/// Bounded observations, not durable resource facts. Started precedes output.
#[derive(Debug)]
pub enum PipeEvent {
    Started,
    Output {
        stream: maka_plugin_core::shell_run::PipeStream,
        bytes: Vec<u8>,
    },
}

pub type PipeFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<PipeResult, ToolError>> + Send>>;

pub struct ObservedProcess {
    pub events: tokio::sync::mpsc::Receiver<PipeEvent>,
    /// Poll concurrently with events. Completion includes native cleanup and
    /// bounded pipe drain; dropping this future requests cancellation.
    pub completion: PipeFuture,
}

pub fn shell_schema() -> Value {
    schemars::schema_for!(Input).into()
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Input {
    #[schemars(length(min = 1))]
    command: String,
    /// Load the shell's login profile. Set false to skip it.
    #[serde(default = "default_login")]
    login: bool,
    #[serde(default = "default_timeout")]
    #[schemars(range(min = 1))]
    timeout_ms: u64,
}
fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_MS
}
fn default_login() -> bool {
    true
}

#[derive(Clone)]
pub struct ShellExecutor {
    cwd: PathBuf,
    directory: Option<std::sync::Arc<directory::Directory>>,
    shell: shell::ShellPlan,
    login: bool,
    sandbox: maka_sandbox::Sandbox,
    network_route: maka_network::Policy,
    #[cfg(target_os = "linux")]
    network_helper: Option<PathBuf>,
    #[cfg(windows)]
    backend: Option<std::sync::Arc<dyn bootstrap::Backend>>,
}

impl ShellExecutor {
    #[cfg(target_os = "linux")]
    pub fn with_network_helper(mut self, helper: PathBuf) -> Self {
        self.network_helper = Some(helper);
        self
    }
    pub fn with_network_route(mut self, route: maka_network::Policy) -> Self {
        self.network_route = route;
        self
    }
    #[cfg(windows)]
    pub fn with_backend(mut self, backend: std::sync::Arc<dyn bootstrap::Backend>) -> Self {
        self.backend = Some(backend);
        self
    }

    pub fn sandbox(&self) -> &maka_sandbox::Sandbox {
        &self.sandbox
    }

    /// Replace only the authorized policy; retain the captured cwd and shell.
    pub fn with_sandbox(&self, sandbox: maka_sandbox::Sandbox) -> Self {
        Self {
            sandbox,
            ..self.clone()
        }
    }

    /// Capture an already authorized isolation policy. This does not authorize
    /// execution; the Host still owns admission and durable dispatch.
    pub fn new(cwd: impl AsRef<Path>, sandbox: maka_sandbox::Sandbox) -> Result<Self, ToolError> {
        let cwd = std::fs::canonicalize(cwd).map_err(|e| failed(e.to_string()))?;
        #[cfg(windows)]
        let cwd = dunce::simplified(&cwd).to_owned();
        if !cwd.is_dir() || cwd.to_str().is_none() {
            return Err(failed("Shell cwd must be a UTF-8 directory"));
        }
        Ok(Self {
            cwd,
            directory: None,
            shell: shell::ShellPlan::detect(),
            login: true,
            sandbox,
            network_route: maka_network::Policy::default(),
            #[cfg(target_os = "linux")]
            network_helper: None,
            #[cfg(windows)]
            backend: None,
        })
    }

    /// Use the very directory already admitted by the embedding. A pathname
    /// replacement cannot redirect the command between admission and spawn.
    pub fn from_directory(
        cwd: PathBuf,
        directory: std::fs::File,
        sandbox: maka_sandbox::Sandbox,
    ) -> Result<Self, ToolError> {
        if !cwd.is_absolute() || cwd.to_str().is_none() {
            return Err(failed("Shell cwd must be an absolute UTF-8 directory"));
        }
        let directory = directory::Directory::capture(&cwd, directory).map_err(failed)?;
        Ok(Self {
            cwd,
            directory: Some(std::sync::Arc::new(directory)),
            shell: shell::ShellPlan::detect(),
            login: true,
            sandbox,
            network_route: maka_network::Policy::default(),
            #[cfg(target_os = "linux")]
            network_helper: None,
            #[cfg(windows)]
            backend: None,
        })
    }

    /// Select an explicit Git for Windows Bash instead of the Windows auto plan.
    #[cfg(windows)]
    pub fn with_git_bash(mut self, executable: &Path) -> Result<Self, ToolError> {
        let path = dunce::canonicalize(executable).map_err(|e| failed(e.to_string()))?;
        if !path.is_file()
            || !path
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("bash.exe"))
        {
            return Err(failed("Git Bash must be an existing bash.exe"));
        }
        self.shell = shell::ShellPlan::GitBash(path);
        Ok(self)
    }
    pub fn description(&self) -> String {
        format!("{SHELL_DESCRIPTION} {}", self.shell.guidance())
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// Control command profile loading without changing the executable or permissions.
    pub fn with_login_shell(mut self, login: bool) -> Self {
        self.login = login;
        self
    }

    /// Capture the selected interactive login shell and its display command.
    /// The caller still owns durable admission before native PTY spawn.
    pub fn interactive_pty(&self) -> Result<(String, pty::PtyCommand), ToolError> {
        let (source, command) = self.shell.interactive(&self.cwd);
        Ok((source, self.capture(command)?))
    }

    /// The selected dialect and quoting match pipes, but stdin is a terminal.
    /// Capturing a plan performs no native effect.
    pub fn command_pty(&self, command: &str) -> Result<pty::PtyCommand, ToolError> {
        validate_command(command)?;
        self.prepare(command, true)
    }

    /// Capture a non-interactive launch and its authorized sandbox policy.
    pub fn command_pipes(&self, command: &str) -> Result<Command, ToolError> {
        validate_command(command)?;
        self.prepare(command, false)
    }

    /// Capture argv directly while retaining the authorized directory, sandbox
    /// and network route. Protocol processes must not pass arguments through a shell.
    pub fn command_program(
        &self,
        executable: impl Into<PathBuf>,
        args: &[String],
        environment: &std::collections::BTreeMap<String, String>,
    ) -> Result<Command, ToolError> {
        let mut command = Command::new(executable, self.cwd.clone());
        for arg in args {
            command.arg(arg);
        }
        for (key, value) in environment {
            command.env(key, value);
        }
        self.capture(command)
    }

    fn prepare(&self, source: &str, terminal: bool) -> Result<Command, ToolError> {
        self.capture(self.shell.command(&self.cwd, source, terminal, self.login))
    }

    fn capture(&self, mut command: Command) -> Result<Command, ToolError> {
        command.directory = self.directory.clone();
        #[cfg(target_os = "linux")]
        let command = match &self.network_helper {
            Some(helper) => command.with_network_helper(helper.clone()),
            None => command,
        };
        #[cfg(windows)]
        let command = match &self.backend {
            Some(backend) => command.with_backend(backend.clone()),
            None => command,
        };
        command
            .network_route(self.network_route.clone())
            .sandbox(&self.sandbox)
            .map_err(|e| failed(e.to_string()))
    }

    /// Prepare a background pipe execution. No process is started until
    /// completion is polled; the Host must first commit durable dispatch.
    pub fn observe(
        &self,
        command: String,
        timeout_ms: Option<u64>,
        cancellation: CancellationToken,
    ) -> Result<ObservedProcess, ToolError> {
        self.command_pipes(&command)?
            .observe(timeout_ms, cancellation)
    }
}

impl Command {
    /// Run a program with standard input and collect its output after its process tree exits.
    pub async fn run_with_input(
        self,
        input: Vec<u8>,
        timeout_ms: u64,
        cancellation: CancellationToken,
    ) -> Result<PipeResult, ToolError> {
        validate_timeout(timeout_ms)?;
        self.run_captured(Some(input), Some(timeout_ms), cancellation, None)
            .await
    }

    async fn run_captured(
        self,
        input: Option<Vec<u8>>,
        timeout_ms: Option<u64>,
        cancellation: CancellationToken,
        observer: Option<tokio::sync::mpsc::Sender<PipeEvent>>,
    ) -> Result<PipeResult, ToolError> {
        // The worker owns termination even if its caller drops the future.
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        tokio::spawn(process::run(
            self,
            input,
            timeout_ms,
            cancellation,
            observer,
        ))
        .await
        .map_err(|e| ToolError::CleanupUnconfirmed(format!("Process worker lost: {e}")))?
    }

    /// No native resources exist until completion is polled. The accepted worker
    /// owns sandbox preparation, process startup and cleanup as one lifecycle.
    pub fn observe(
        self,
        timeout_ms: Option<u64>,
        cancellation: CancellationToken,
    ) -> Result<ObservedProcess, ToolError> {
        if timeout_ms.is_some_and(|ms| validate_timeout(ms).is_err()) {
            return Err(failed("invalid background shell command or timeout"));
        }
        let (observer, events) = tokio::sync::mpsc::channel(8);
        let completion =
            Box::pin(self.run_captured(None, timeout_ms, cancellation, Some(observer)));
        Ok(ObservedProcess { events, completion })
    }
}

impl ToolExecutor for ShellExecutor {
    fn names(&self) -> Vec<String> {
        vec![SHELL_NAME.into()]
    }

    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let executor = self.clone();
        Box::pin(async move {
            if name != SHELL_NAME {
                return Err(failed("unsupported tool"));
            }
            let input: Input = serde_json::from_value(input).map_err(|e| failed(e.to_string()))?;
            validate_command(&input.command)?;
            if validate_timeout(input.timeout_ms).is_err() {
                return Err(failed(
                    "Shell requires a nonempty command and positive timeout_ms",
                ));
            }
            let executor = executor.with_login_shell(input.login);
            let plan = executor.prepare(&input.command, false)?;
            let captured = plan
                .run_captured(None, Some(input.timeout_ms), cancellation, None)
                .await?;
            Ok(captured.into_output(executor.cwd, input.command))
        })
    }
}

fn failed(message: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(message.to_string())
}

/// Native I/O APIs may carry an already classified cleanup failure. Preserve
/// that fact when crossing back into the tool lifecycle; never inspect text.
#[cfg(windows)]
fn launch_error(error: std::io::Error) -> ToolError {
    error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<ToolError>())
        .cloned()
        .unwrap_or_else(|| failed(error))
}

pub fn validate_command(command: &str) -> Result<(), ToolError> {
    if command.trim().is_empty() || command.contains('\0') {
        return Err(failed(
            "Shell requires a nonempty command of at most 64 KiB without NUL",
        ));
    }
    Ok(())
}

/// Validate only the native clock representation of a requested deadline.
pub fn validate_timeout(ms: u64) -> Result<(), ToolError> {
    if ms == 0
        || std::time::Instant::now()
            .checked_add(std::time::Duration::from_millis(ms))
            .is_none()
    {
        return Err(failed(
            "shell timeout is not a positive representable duration",
        ));
    }
    Ok(())
}

async fn timeout(ms: Option<u64>) {
    match ms {
        Some(ms) => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
        None => std::future::pending().await,
    }
}

#[cfg(target_os = "macos")]
mod stdio_exec;
