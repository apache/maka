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

use maka_host_runtime::HostError;
use std::{path::PathBuf, process::ExitCode};
#[cfg(not(target_os = "macos"))]
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "macos")]
mod disclaimed;

/// The shell beside this launcher. macOS shows a process with the name and icon
/// of the bundle its executable is in, so there it runs from inside `Maka.app`.
pub(crate) const SHELL: &str = if cfg!(target_os = "macos") {
    "Maka.app/Contents/MacOS/maka-desktop-shell"
} else if cfg!(windows) {
    "maka-desktop-shell.exe"
} else {
    "maka-desktop-shell"
};

#[derive(clap::Args)]
#[command(version)]
pub(super) struct Args {
    /// Business Host Root to initialize or reopen (default: ~/.maka/application/host).
    #[arg(long)]
    root: Option<PathBuf>,
    /// Run the Host in this WSL distribution.
    #[cfg(windows)]
    #[arg(long, requires_all = ["wsl_maka", "wsl_root"], conflicts_with = "root")]
    wsl: Option<String>,
    /// Absolute path to the Linux Maka executable.
    #[cfg(windows)]
    #[arg(long, requires = "wsl")]
    wsl_maka: Option<String>,
    /// Absolute path to the WSL Host Root.
    #[cfg(windows)]
    #[arg(long, requires = "wsl")]
    wsl_root: Option<String>,
}

impl Args {
    pub(super) async fn run(self) -> Result<ExitCode, HostError> {
        let stop = CancellationToken::new();
        #[cfg(windows)]
        crate::windows::detach_private_desktop_console()?;
        let _signals = crate::signals::watch(stop.clone())?;
        #[cfg(windows)]
        if let Some(distro) = self.wsl {
            let maka = self.wsl_maka.ok_or("--wsl-maka is required")?;
            let root = self.wsl_root.ok_or("--wsl-root is required")?;
            if !maka.starts_with('/') || !root.starts_with('/') {
                return Err("WSL executable and Root must be absolute Linux paths".into());
            }
            let directory = maka_sandbox::account_home()?
                .join(".maka")
                .join("wsl-desktop");
            let mut child = Command::new(
                std::env::current_exe()?
                    .canonicalize()?
                    .with_file_name(SHELL),
            )
            .env("MAKA_DESKTOP_WSL_DISTRO", distro)
            .env("MAKA_DESKTOP_WSL_MAKA", maka)
            .env("MAKA_DESKTOP_WSL_ROOT", root)
            .env("MAKA_DESKTOP_WSL_CLIENT_DIR", directory)
            .kill_on_drop(true)
            .spawn()?;
            tokio::select! {
                status = child.wait() => std::process::exit(status?.code().unwrap_or(1)),
                _ = stop.cancelled() => {
                    child.kill().await?;
                    return Ok(ExitCode::SUCCESS);
                }
            }
        }
        let root = crate::application::root_path(self.root)?;
        match std::fs::metadata(&root) {
            Ok(meta) if !meta.is_dir() => {
                std::fs::create_dir_all(&root)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
                return Err(error.into());
            }
            _ => {}
        }
        let code = Self::launch(&root, &stop).await?;
        #[cfg(windows)]
        std::process::exit(code);
        #[cfg(unix)]
        Ok(ExitCode::from(code as u8))
    }

    async fn launch(root: &std::path::Path, stop: &CancellationToken) -> Result<i32, HostError> {
        if stop.is_cancelled() {
            return Ok(0);
        }
        let launcher = std::env::current_exe()?.canonicalize()?;
        let executable = desktop_shell_path(&launcher);
        let root = std::path::absolute(root)?;
        #[cfg(target_os = "macos")]
        let child = {
            let variables: [(&str, Option<&std::ffi::OsStr>); 4] = [
                ("MAKA_HOST_ROOT", Some(root.as_ref())),
                ("MAKA_HOST_ENDPOINT", None),
                ("MAKA_HOST_EPOCH", None),
                ("MAKA_LAUNCHER", Some(launcher.as_ref())),
            ];
            disclaimed::Shell::spawn(&executable, &variables)
        };
        #[cfg(not(target_os = "macos"))]
        let child = Command::new(&executable)
            .env("MAKA_HOST_ROOT", &root)
            .env("MAKA_LAUNCHER", &launcher)
            .env_remove("MAKA_HOST_ENDPOINT")
            .env_remove("MAKA_HOST_EPOCH")
            .kill_on_drop(true)
            .spawn();
        let mut child = child.map_err(|error| format!("{}: {error}", executable.display()))?;
        let waited = tokio::select! {
            status = child.wait() => status,
            _ = stop.cancelled() => {
                // Stop and reap only the shell admitted by this launcher.
                child.kill().await?;
                return Ok(0);
            }
        };
        let status = match waited {
            Ok(status) => status,
            Err(error) => {
                if let Err(cleanup) = child.kill().await {
                    return Err(format!("desktop wait: {error}; child cleanup: {cleanup}").into());
                }
                return Err(error.into());
            }
        };
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            Ok(status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)))
        }
        #[cfg(windows)]
        {
            Ok(status.code().unwrap_or(1))
        }
    }
}

/// Resolves `maka-desktop-shell` beside `launcher`.
/// On macOS, a self-contained `Maka.app` places `maka` right beside
/// `maka-desktop-shell` inside `Contents/MacOS/`; dev/npm layouts place
/// `Maka.app` next to `maka`.
fn desktop_shell_path(launcher: &std::path::Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    if maka_updater::app_bundle(launcher).is_some() {
        return launcher.with_file_name("maka-desktop-shell");
    }
    launcher.with_file_name(SHELL)
}

/// The staged app owns the UI. Plain Cargo builds produce a sibling executable.
#[cfg(target_os = "macos")]
pub(super) fn exec_shell(
    mode: &str,
    options: &[(&str, Option<&std::ffi::OsStr>)],
    flags: &[(&str, bool)],
) -> Result<(), HostError> {
    use std::os::unix::process::CommandExt;

    let launcher = std::env::current_exe()?.canonicalize()?;
    let bundled = desktop_shell_path(&launcher);
    let shell = if bundled.try_exists()? {
        bundled
    } else {
        launcher.with_file_name("maka-desktop-shell")
    };
    let mut command = std::process::Command::new(&shell);
    command.arg(mode).env("MAKA_LAUNCHER", launcher);
    for &(name, value) in options {
        if let Some(value) = value {
            // Keep leading dashes and non-UTF-8 path bytes in the option's value.
            let mut argument = std::ffi::OsString::from(name);
            argument.push("=");
            argument.push(value);
            command.arg(argument);
        }
    }
    for &(name, enabled) in flags {
        if enabled {
            command.arg(name);
        }
    }
    let error = command.exec();
    Err(format!("{}: {error}", shell.display()).into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn desktop_launches_the_bundled_shell_in_both_layouts() {
        let build = tempfile::tempdir().unwrap();
        let shell = "maka-desktop-shell";
        std::fs::write(build.path().join(shell), []).unwrap();
        let bundled = build.path().join("Maka.app/Contents/MacOS");
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(bundled.join(shell), []).unwrap();

        assert_eq!(
            desktop_shell_path(&build.path().join("maka")),
            bundled.join(shell)
        );
        assert_eq!(
            desktop_shell_path(&bundled.join("maka")),
            bundled.join(shell)
        );
    }
}
