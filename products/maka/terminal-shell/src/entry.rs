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

//! Runs the NSH application against one launcher-selected public Host.

use crate::terminal;
use maka_host_runtime::application::host::startup;
use maka_workbench::bindings::Bindings;
use nsh_core::{
    Points, Size,
    platform::{Environment, Idiom, Renderer},
};
use nsh_engine::EngineConfig;
use std::{
    io::{self, IsTerminal},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

/// Options for the default `maka` entry and the `maka terminal-shell` command.
#[derive(clap::Args, Default)]
#[command(version, about = "Maka terminal application using NSH")]
pub struct Args {
    /// Business Host Root (default: ~/.maka/application/host).
    #[arg(long)]
    root: Option<PathBuf>,
    /// Existing Agent session to display initially; otherwise open the session picker.
    #[arg(long)]
    session: Option<String>,
}

impl Args {
    fn root_path(&self) -> Result<PathBuf, String> {
        if let Some(root) = &self.root {
            return std::path::absolute(root).map_err(|error| error.to_string());
        }
        #[cfg(unix)]
        let home = std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
            .ok_or("home directory unavailable; select --root")?;
        #[cfg(windows)]
        let home = maka_sandbox::account_home().map_err(|error| error.to_string())?;
        Ok(home.join(".maka/application/host"))
    }

    /// Runs against the selected public Host using the caller's Tokio runtime.
    /// Host cleanup completes before an error is returned to the caller.
    pub async fn run(self) -> Result<(), String> {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            return Err("the terminal shell requires a terminal on stdin and stdout".into());
        }
        if self.session.as_ref().is_some_and(String::is_empty) {
            return Err("session must not be empty".into());
        }
        let stop = Arc::new(AtomicBool::new(false));
        // Install before opening any Host session or entering terminal modes.
        let mut signals = Signals::watch(stop.clone()).map_err(|error| error.to_string())?;
        let path = self.root_path()?;
        let launcher = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut native = tokio::select! {
            result = startup::connect_root(&launcher, &path) => result?,
            _ = &mut signals.0 => return Ok(()),
        };
        if stop.load(Ordering::Acquire) {
            return native.close().await;
        }
        let (client, client_directory) =
            maka_workbench::host::admit(native, &path, "terminal").await?;
        let runtime = tokio::runtime::Handle::current();
        let bindings = Bindings::new(client, runtime.clone());
        let mut config = configuration(bindings.registry(self.session), runtime);
        config.context = config.context.with(bindings.reload());
        config.data_dir = Some(client_directory);
        config.assets = Some(bindings.assets());
        config.chunk_loader = Some(bindings.chunk_loader());
        let (result, gpu_worker) = if stop.load(Ordering::Acquire) {
            (Ok(()), None)
        } else {
            tokio::task::spawn_blocking(move || {
                let mut gpu_worker = None;
                // Keep the native renderer owner outside the same panic boundary
                // that Tokio previously supplied for this blocking terminal task.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    terminal::run(config, stop.clone(), &mut gpu_worker)
                }));
                stop.store(true, Ordering::Release);
                if let Some(worker) = &gpu_worker {
                    worker.thread().unpark();
                }
                let result = result.unwrap_or_else(|panic| {
                    let message = panic
                        .downcast_ref::<&str>()
                        .copied()
                        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
                        .unwrap_or("unknown panic");
                    Err(format!("terminal worker panicked: {message}"))
                });
                (result, gpu_worker)
            })
            .await
            .unwrap_or_else(|error| (Err(format!("terminal worker: {error}")), None))
        };
        // Terminal restoration precedes Host-scope cleanup. A blocked GPU must
        // not retain that scope, but its native resources must finish before
        // the runtime and process can exit.
        let cleanup = bindings
            .close()
            .await
            .map_err(|error| format!("terminal Host cleanup: {error}"));
        let gpu_cleanup = if let Some(worker) = gpu_worker {
            tokio::task::spawn_blocking(move || {
                worker
                    .join()
                    .map_err(|_| "terminal GPUI worker panicked".to_owned())?
            })
            .await
            .map_err(|error| format!("terminal GPUI join: {error}"))
            .and_then(|result| result)
        } else {
            Ok(())
        };
        let errors: Vec<_> = [result, cleanup, gpu_cleanup]
            .into_iter()
            .filter_map(Result::err)
            .collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

fn configuration(
    registry: nsh_core::element::Registry,
    runtime: tokio::runtime::Handle,
) -> EngineConfig {
    let viewport = Size::new(Points(960.0), Points(640.0));
    EngineConfig {
        viewport,
        environment: Environment {
            renderer: Renderer::Terminal,
            idiom: Idiom::Desktop,
            window: viewport,
            ..Default::default()
        },
        ..maka_workbench::configuration(registry, runtime)
    }
}

struct Signals(tokio::task::JoinHandle<()>);
impl Signals {
    fn watch(stop: Arc<AtomicBool>) -> io::Result<Self> {
        #[cfg(unix)]
        let (mut interrupt, mut terminate) = (
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?,
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?,
        );
        #[cfg(windows)]
        let (mut interrupt, mut terminate) = (
            tokio::signal::windows::ctrl_c()?,
            tokio::signal::windows::ctrl_break()?,
        );
        Ok(Self(tokio::spawn(async move {
            tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
            stop.store(true, Ordering::Release);
        })))
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        self.0.abort();
    }
}
