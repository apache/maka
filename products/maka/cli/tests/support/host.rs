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

use maka_host_runtime::application::host::Client;
use serde_json::Value;
use std::{
    path::PathBuf,
    process::{ExitStatus, Stdio},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, ChildStdout, Command},
};

pub type Result<T> = std::result::Result<T, String>;

#[allow(dead_code)]
pub struct Sandbox {
    pub directory: tempfile::TempDir,
    pub root: PathBuf,
    pub home: PathBuf,
    pub workspace: PathBuf,
    pub journal: PathBuf,
}
impl Sandbox {
    #[allow(dead_code)]
    pub async fn new() -> Result<Self> {
        let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                .await
                .map_err(|error| error.to_string())?;
        }
        let root = directory.path().join("root");
        let home = directory.path().join("home");
        let workspace = home.join("workspace");
        let journal = directory.path().join("client.db");
        tokio::fs::create_dir_all(&workspace)
            .await
            .map_err(|error| error.to_string())?;
        #[cfg(windows)]
        for folder in ["Local", "Roaming"] {
            tokio::fs::create_dir_all(home.join("AppData").join(folder))
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(Self {
            directory,
            root,
            home,
            workspace,
            journal,
        })
    }
}

pub fn command_for(
    executable: &std::path::Path,
    home: &std::path::Path,
    workspace: &std::path::Path,
) -> Command {
    let mut command = Command::new(executable);
    command
        .env_clear()
        .current_dir(workspace)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_STATE_HOME", home.join("state"))
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("CODEX_HOME", home.join("codex"))
        .env("CLAUDE_CONFIG_DIR", home.join("claude"))
        .env("ZDOTDIR", home)
        .env("LC_ALL", "en_US.UTF-8")
        // Keep public model metadata out of the loopback fixture catalog.
        .env("HTTPS_PROXY", "http://127.0.0.1:9")
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost");
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    if let Some(temp) = std::env::var_os("TMPDIR") {
        command.env("TMPDIR", temp);
    }
    #[cfg(windows)]
    {
        command
            .env("APPDATA", home.join("AppData/Roaming"))
            .env("LOCALAPPDATA", home.join("AppData/Local"));
        for key in [
            "SystemRoot",
            "SystemDrive",
            "ComSpec",
            "PATHEXT",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    command
}

#[allow(dead_code)]
pub fn command(sandbox: &Sandbox) -> Result<Command> {
    let executable = std::env::var_os("CARGO_BIN_EXE_maka")
        .ok_or("runner must supply runtime CARGO_BIN_EXE_maka")?;
    Ok(command_for(
        std::path::Path::new(&executable),
        &sandbox.home,
        &sandbox.workspace,
    ))
}

/// The caller stores this slot before awaiting startup, so failure can still
/// kill and reap the exact child. Drop is never evidence of physical cleanup.
pub struct Host {
    child: Child,
    stdout: BufReader<ChildStdout>,
    root: Option<PathBuf>,
    status: Option<ExitStatus>,
}
impl Host {
    #[allow(dead_code)]
    pub fn spawn(sandbox: &Sandbox) -> Result<Self> {
        let command = command(sandbox)?;
        Self::spawn_command(command, &sandbox.root)
    }

    #[allow(dead_code)]
    pub fn spawn_with(
        executable: &std::path::Path,
        root: &std::path::Path,
        home: &std::path::Path,
        workspace: &std::path::Path,
    ) -> Result<Self> {
        Self::spawn_command(command_for(executable, home, workspace), root)
    }

    fn spawn_command(mut command: Command, root: &std::path::Path) -> Result<Self> {
        command.args(["host", "serve", "--root"]).arg(root);
        let mut host = Self::spawn_service(command)?;
        host.root = Some(root.to_path_buf());
        Ok(host)
    }

    pub fn spawn_service(mut command: Command) -> Result<Self> {
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("spawn Host: {error}"))?;
        let stdout = BufReader::new(child.stdout.take().expect("explicit piped stdout"));
        Ok(Self {
            child,
            stdout,
            root: None,
            status: None,
        })
    }

    #[allow(dead_code)]
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    pub async fn ready(&mut self) -> Result<(Client, PathBuf)> {
        let mut line = String::new();
        if self
            .stdout
            .read_line(&mut line)
            .await
            .map_err(|error| error.to_string())?
            == 0
        {
            let status = self.child.wait().await.map_err(|error| {
                format!("original Host exited before ready (wait failed: {error})")
            })?;
            self.status = Some(status);
            let diagnostics = self
                .root
                .as_deref()
                .and_then(read_host_diagnostics_tail)
                .map(|tail| format!("\nHost diagnostics:\n{tail}"))
                .unwrap_or_default();
            return Err(format!(
                "original Host exited before ready ({status}){diagnostics}"
            ));
        }
        let ready: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        if ready["kind"] != "ready" {
            return Err(format!("unexpected Host startup: {ready}"));
        }
        let address = PathBuf::from(
            ready["socketPath"]
                .as_str()
                .ok_or("ready socketPath missing")?,
        );
        let epoch = serde_json::from_value(ready["hostEpoch"].clone())
            .map_err(|error| error.to_string())?;
        let mut client = Client::connect(&address, Some(epoch)).await?;
        let status = Client::status(&address, Some(epoch)).await?;
        if Some(status.pid.get()) != self.child.id() {
            return Err("ready endpoint does not belong to the held Host child".into());
        }
        loop {
            if let Some(error) = client.catalogue().startup_error() {
                return Err(format!("Host startup: {error:?}"));
            }
            let mut registered = true;
            for endpoint in ["agent", "settings", "receipts"] {
                registered &= client
                    .catalogue()
                    .describe(endpoint)?
                    .registration_epoch
                    .is_some();
            }
            if registered {
                break;
            }
            client.refresh().await?;
            tokio::task::yield_now().await;
        }
        Ok((client, address))
    }

    async fn wait_and_eof(&mut self) -> Result<ExitStatus> {
        let mut tail = Vec::new();
        let (eof, status) = tokio::join!(self.stdout.read_to_end(&mut tail), self.child.wait());
        // Keep the observed wait even if stdout failed; cleanup must not signal a reaped PID.
        let status = status.map_err(|error| format!("wait original Host: {error}"))?;
        self.status = Some(status);
        eof.map_err(|error| format!("Host stdout EOF: {error}"))?;
        Ok(status)
    }

    #[allow(dead_code)]
    pub async fn sigkill(&mut self) -> Result<()> {
        if let Some(status) = self.child.try_wait().map_err(|error| error.to_string())? {
            self.status = Some(status);
            return Err(format!("Host exited before SIGKILL: {status}"));
        }
        self.child
            .start_kill()
            .map_err(|error| format!("SIGKILL original Host: {error}"))?;
        let status = self.wait_and_eof().await?;
        #[cfg(unix)]
        let killed = std::os::unix::process::ExitStatusExt::signal(&status) == Some(libc::SIGKILL);
        #[cfg(windows)]
        let killed = status.code() == Some(1);
        if !killed {
            return Err(format!("Host was not killed by SIGKILL: {status}"));
        }
        Ok(())
    }

    pub async fn quit(&mut self, client: &mut Client) -> Result<()> {
        client.quit().await?;
        let status = self.wait_and_eof().await?;
        if !status.success() {
            return Err(format!("Host quit exit: {status}"));
        }
        Ok(())
    }

    pub async fn cleanup(&mut self) -> Result<()> {
        if self.status.is_some() {
            return Ok(());
        }
        if let Some(status) = self.child.try_wait().map_err(|error| error.to_string())? {
            self.status = Some(status);
            return Ok(());
        }
        self.child
            .start_kill()
            .map_err(|error| format!("cleanup SIGKILL: {error}"))?;
        self.wait_and_eof().await?;
        Ok(())
    }
}

fn read_host_diagnostics_tail(root: &std::path::Path) -> Option<String> {
    const MAX_BYTES: usize = 4096;
    let resolved = maka_event_log::root::resolve(root).ok()?;
    let namespaces = maka_event_log::root::RootNamespaces::for_current_account().ok()?;
    let source = maka_host_runtime::logs::Source::for_root(resolved.root_id(), &namespaces).ok()?;
    let bytes = std::fs::read(source.path()).ok()?;
    let start = bytes.len().saturating_sub(MAX_BYTES);
    let tail = String::from_utf8_lossy(&bytes[start..]).trim().to_owned();
    (!tail.is_empty()).then_some(tail)
}
