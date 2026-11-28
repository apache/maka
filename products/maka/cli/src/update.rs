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

use clap::Args as ClapArgs;
use maka_event_log::root::RootNamespaces;
use maka_host_runtime::{
    HostError,
    application::host::{Client as HostClient, discovery, protocol::Status as HostStatus, startup},
};
use maka_updater::{BuildInfo, Channel, RootLeaseAttempt};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(ClapArgs)]
#[command(version)]
pub(super) struct Args {
    /// Check for an available update without downloading or installing it.
    #[arg(long)]
    check: bool,
    /// Interrupt background durable runs on an otherwise idle Host when
    /// applying the update (still refuses while desktop or CLI sessions are
    /// connected).
    #[arg(long)]
    force: bool,
    /// State Root whose running Host should be stopped and restarted around
    /// the update (default: ~/.maka/application/host).
    #[arg(long)]
    root: Option<PathBuf>,
}

enum HostState {
    Live(Box<discovery::Discovery>, HostStatus),
    Closing,
    None,
}

async fn probe_host(root: &Path) -> HostState {
    let Ok(registered) = discovery::read(root) else {
        return HostState::None;
    };
    match HostClient::status(&registered.endpoint, Some(registered.host_epoch)).await {
        Ok(status) if !status.closed && !status.closing => {
            HostState::Live(Box::new(registered), status)
        }
        _ => HostState::Closing,
    }
}

fn active_sessions_error(sessions: usize) -> HostError {
    format!(
        "Maka Host has {sessions} active session(s) (such as an open Maka desktop window). \
         Apply the update from the Maka desktop window so it restarts cleanly, \
         or close active sessions and re-run `maka update`."
    )
    .into()
}

impl Args {
    pub(super) async fn run(self) -> Result<(), HostError> {
        let info = BuildInfo::current();
        if info.channel == Channel::Dev {
            println!(
                "Maka {} (dev build): automatic updates are disabled for local development builds.",
                info.version
            );
            return Ok(());
        }
        // Clean up renamed Windows binaries and dead-PID staging directories
        // left behind by prior CLI updates.
        let _ = tokio::task::spawn_blocking(maka_updater::remove_stale_leftovers).await;

        println!(
            "Checking {} channel (current: {})...",
            info.channel.as_str(),
            info.version
        );
        let Some(available) = maka_updater::check(&info)
            .await
            .map_err(|error| HostError::from(error.to_string()))?
        else {
            println!("Maka {} is already up to date.", info.version);
            return Ok(());
        };
        println!(
            "Update available: {} -> {}",
            info.version, available.version
        );
        if self.check {
            println!("Download: {}", available.url);
            return Ok(());
        }
        let installation = maka_updater::current_installation()
            .map_err(|error| HostError::from(error.to_string()))?;
        if !installation.can_install() {
            return Err(format!(
                "This installation directory is not writable; download manually from {}",
                available.url
            )
            .into());
        }

        let root = crate::application::root_path(self.root)?;
        // Fast check before downloading; authoritative state is re-probed after staging.
        if let HostState::Live(_, status) = probe_host(&root).await
            && status.sessions > 0
        {
            return Err(active_sessions_error(status.sessions));
        }

        println!("Downloading {}...", available.url);
        let download_dir = std::env::temp_dir().join("maka-updates");
        let archive = maka_updater::download(&available, &download_dir, |_| {})
            .await
            .map_err(|error| HostError::from(error.to_string()))?;
        let staged = match maka_updater::stage(installation, archive.clone()).await {
            Ok(staged) => staged,
            Err(error) => {
                let _ = tokio::fs::remove_file(&archive).await;
                return Err(error.to_string().into());
            }
        };

        let fence_deadline = Instant::now() + maka_updater::HOST_STOP_TIMEOUT;
        let (lease, launch_lock, stopped_host) = loop {
            match probe_host(&root).await {
                HostState::Live(registered, status) => {
                    if status.sessions > 0 {
                        drop(staged);
                        let _ = tokio::fs::remove_file(&archive).await;
                        return Err(active_sessions_error(status.sessions));
                    }
                    if self.force {
                        println!("Stopping Maka Host (active runs will resume on restart)...");
                    } else {
                        println!("Stopping idle Maka Host...");
                    }
                    match maka_updater::try_stop_host_without_sessions(
                        &root,
                        &registered.endpoint,
                        registered.host_epoch,
                        self.force,
                    )
                    .await
                    {
                        Ok(Some(lease)) => break (Some(lease), None, true),
                        Ok(None) => {
                            drop(staged);
                            let _ = tokio::fs::remove_file(&archive).await;
                            return Err(if self.force {
                                "Maka Host now has an active session (such as an open Maka desktop window). \
                                 Apply the update from the Maka desktop window so it restarts cleanly, \
                                 or close active sessions and re-run `maka update`."
                                    .into()
                            } else {
                                "Maka Host became busy while downloading the update (active session or running task). \
                                 Apply the update from the Maka desktop window so it restarts cleanly, \
                                 or wait for active work to finish and re-run `maka update` \
                                 (use `--force` to interrupt background runs when no sessions are open)."
                                    .into()
                            });
                        }
                        Err(error) => {
                            drop(staged);
                            let _ = tokio::fs::remove_file(&archive).await;
                            return Err(error.to_string().into());
                        }
                    }
                }
                HostState::Closing => {
                    println!("Waiting for retiring Maka Host to finish draining...");
                    match maka_updater::wait_for_root_release(
                        &root,
                        maka_updater::HOST_STOP_TIMEOUT,
                    )
                    .await
                    {
                        Ok(lease) => break (Some(lease), None, false),
                        Err(error) => {
                            drop(staged);
                            let _ = tokio::fs::remove_file(&archive).await;
                            return Err(error.to_string().into());
                        }
                    }
                }
                HostState::None => {
                    // Acquire the same per-path launch lock used by first-time Host
                    // startup so an Absent Root cannot be initialized concurrently
                    // while we swap binaries.
                    let root_for_lock = root.clone();
                    let launch_result = tokio::task::spawn_blocking(move || {
                        let namespaces = RootNamespaces::for_current_account()?;
                        crate::deployment::acquire_launch_lock(&root_for_lock, &namespaces)
                    })
                    .await
                    .map_err(|error| HostError::from(error.to_string()));
                    let launch = match launch_result {
                        Ok(Ok(launch)) => launch,
                        Ok(Err(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            if Instant::now() >= fence_deadline {
                                drop(staged);
                                let _ = tokio::fs::remove_file(&archive).await;
                                return Err(
                                    "Another Maka Host is starting up or holding the State Root; \
                                     wait a moment and re-run `maka update`."
                                        .into(),
                                );
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        }
                        Ok(Err(error)) => {
                            drop(staged);
                            let _ = tokio::fs::remove_file(&archive).await;
                            return Err(error.to_string().into());
                        }
                        Err(error) => {
                            drop(staged);
                            let _ = tokio::fs::remove_file(&archive).await;
                            return Err(error);
                        }
                    };
                    match maka_updater::try_acquire_root_lease(&root).await {
                        Ok(RootLeaseAttempt::Absent) => break (None, Some(launch), false),
                        Ok(RootLeaseAttempt::Acquired(lease)) => {
                            break (Some(lease), Some(launch), false);
                        }
                        Ok(RootLeaseAttempt::Busy) => {
                            drop(launch);
                            if Instant::now() >= fence_deadline {
                                drop(staged);
                                let _ = tokio::fs::remove_file(&archive).await;
                                return Err(
                                    "Another Maka Host is starting up or holding the State Root; \
                                     wait a moment and re-run `maka update`."
                                        .into(),
                                );
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        Err(error) => {
                            drop(launch);
                            drop(staged);
                            let _ = tokio::fs::remove_file(&archive).await;
                            return Err(error.to_string().into());
                        }
                    }
                }
            }
        };

        // Move the Root lease and launch lock into the blocking swap thread so
        // they remain held until staged.finish() actually returns.
        let new_executable = maka_updater::finish_with_guard(staged, (lease, launch_lock))
            .await
            .map_err(|error| HostError::from(error.to_string()))?;
        let _ = tokio::fs::remove_file(&archive).await;

        if stopped_host {
            println!("Starting updated Maka Host to resume durable runs...");
            match startup::connect_root(&new_executable, &root).await {
                Ok(mut client) => {
                    let _ = client.close().await;
                    println!("Updated Maka to {} and restarted Host.", available.version);
                }
                Err(error) => {
                    return Err(format!(
                        "Updated Maka to {}, but failed to restart Host: {error}",
                        available.version
                    )
                    .into());
                }
            }
        } else {
            println!("Updated Maka to {}.", available.version);
        }
        Ok(())
    }
}
