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

use maka_host_runtime::{
    HostError,
    application::host::{Client, discovery},
};
use std::{path::PathBuf, process::ExitCode};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

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
    /// Business Host Root to initialize or reopen.
    #[arg(long)]
    root: PathBuf,
}

impl Args {
    pub(super) async fn run(self) -> Result<ExitCode, HostError> {
        let stop = CancellationToken::new();
        let _signals = crate::signals::watch(stop.clone())?;
        let root = self.root.clone();
        let mut client = tokio::select! {
            result = crate::deployment::connect_local(root.clone()) => result?,
            _ = stop.cancelled() => return Ok(ExitCode::SUCCESS),
        };
        let result = self.launch(&client, &stop).await;
        // Detach, as the terminal does: the Host finishes the work it accepted
        // and then stops once no client is left.
        let mut cleanup = client.close().await;
        // A Host that stopped while the window was open (the window then
        // moved to the Root's next Host) has no client left to detach.
        if cleanup.is_err() && !runs(&root, client.epoch()).await {
            cleanup = Ok(());
        }
        match (result, cleanup) {
            (Ok(code), Ok(())) => {
                #[cfg(windows)]
                std::process::exit(code);
                #[cfg(unix)]
                Ok(ExitCode::from(code as u8))
            }
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(cleanup)) => Err(format!("desktop Host cleanup: {cleanup}").into()),
            (Err(error), Err(cleanup)) => {
                Err(format!("{error}; desktop Host cleanup: {cleanup}").into())
            }
        }
    }

    async fn launch(self, client: &Client, stop: &CancellationToken) -> Result<i32, HostError> {
        let registered = discovery::read(&self.root)?;
        if registered.host_epoch != client.epoch() || &registered.source != client.source() {
            return Err("application Host changed during desktop startup admission".into());
        }
        registered.verify(&Client::status(&registered.endpoint, Some(client.epoch())).await?)?;
        if stop.is_cancelled() {
            return Ok(0);
        }
        let launcher = std::env::current_exe()?;
        let executable = launcher.with_file_name(SHELL);
        let mut child = Command::new(&executable)
            .env("MAKA_HOST_ROOT", std::path::absolute(&self.root)?)
            .env("MAKA_HOST_ENDPOINT", &registered.endpoint)
            .env("MAKA_HOST_EPOCH", registered.host_epoch.to_string())
            // The shell starts the Root's next Host through it.
            .env("MAKA_LAUNCHER", &launcher)
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("{}: {error}", executable.display()))?;
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

/// Whether the Host with `epoch` still serves `root` and is not closing. A
/// Host that does not answer within two seconds counts as running.
async fn runs(root: &std::path::Path, epoch: uuid::Uuid) -> bool {
    match discovery::read(root) {
        Ok(registered) if registered.host_epoch == epoch => {
            let status = Client::status(&registered.endpoint, Some(epoch));
            match tokio::time::timeout(std::time::Duration::from_secs(2), status).await {
                Ok(status) => status.is_ok_and(|status| !status.closing && !status.closed),
                Err(_) => true,
            }
        }
        _ => false,
    }
}
