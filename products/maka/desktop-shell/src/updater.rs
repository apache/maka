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

//! Desktop self-update controller shared across macOS, Windows and Linux.

use maka_updater::{AvailableUpdate, BuildInfo, Channel, Progress, StagedUpdate};
use nsh_engine::{HostChannel, JsonValue};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    runtime::Handle,
    sync::{mpsc, watch},
};
use uuid::Uuid;

const INITIAL_CHECK_DELAY: Duration = Duration::from_secs(8);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Status {
    Idle,
    UpToDate,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub channel: Channel,
    pub current_version: String,
    pub can_install: bool,
    pub status: Status,
    pub available: Option<AvailableUpdate>,
    pub progress: Option<Progress>,
    pub error: Option<String>,
}

struct State {
    snapshot: Snapshot,
    staged: Option<StagedUpdate>,
    archive: Option<PathBuf>,
}

struct SwapState {
    in_flight: bool,
    closing: bool,
}

struct SwapFence {
    state: Mutex<SwapState>,
    done: Condvar,
}

impl SwapFence {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(SwapState {
                in_flight: false,
                closing: false,
            }),
            done: Condvar::new(),
        })
    }

    fn try_begin(self: &Arc<Self>) -> Option<SwapGuard> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closing {
            return None;
        }
        state.in_flight = true;
        Some(SwapGuard(Arc::clone(self)))
    }

    fn close_and_wait(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closing = true;
        while state.in_flight {
            state = self.done.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
}

struct SwapGuard(Arc<SwapFence>);

impl Drop for SwapGuard {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.in_flight = false;
        self.0.done.notify_all();
    }
}

pub(crate) struct Controller {
    info: BuildInfo,
    root: PathBuf,
    active_host: watch::Receiver<(PathBuf, Uuid)>,
    updating: watch::Sender<bool>,
    exit: mpsc::UnboundedSender<()>,
    events: Arc<Mutex<Option<HostChannel>>>,
    runtime: Handle,
    swap: Arc<SwapFence>,
    state: Mutex<State>,
}

impl Controller {
    pub(crate) fn new(
        root: PathBuf,
        active_host: watch::Receiver<(PathBuf, Uuid)>,
        updating: watch::Sender<bool>,
        exit: mpsc::UnboundedSender<()>,
        events: Arc<Mutex<Option<HostChannel>>>,
        runtime: Handle,
    ) -> Arc<Self> {
        maka_updater::remove_stale_leftovers();
        let info = BuildInfo::current();
        let can_install = info.channel != Channel::Dev && maka_updater::can_install();
        let snapshot = Snapshot {
            channel: info.channel,
            current_version: info.version.clone(),
            can_install,
            status: Status::Idle,
            available: None,
            progress: None,
            error: None,
        };
        let controller = Arc::new(Self {
            info,
            root,
            active_host,
            updating,
            exit,
            events,
            runtime: runtime.clone(),
            swap: SwapFence::new(),
            state: Mutex::new(State {
                snapshot,
                staged: None,
                archive: None,
            }),
        });
        if controller.info.channel != Channel::Dev {
            let background = Arc::clone(&controller);
            runtime.spawn(async move {
                tokio::time::sleep(INITIAL_CHECK_DELAY).await;
                background.check(false).await;
                let mut interval = tokio::time::interval(CHECK_INTERVAL);
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let can_recheck = matches!(
                        background.snapshot().status,
                        Status::Idle | Status::UpToDate
                    );
                    if can_recheck {
                        background.check(false).await;
                    }
                }
            });
        }
        controller
    }

    pub(crate) fn runtime(&self) -> &Handle {
        &self.runtime
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot
            .clone()
    }

    fn emit(&self, snapshot: &Snapshot) {
        if let Ok(value) = serde_json::to_value(snapshot)
            && let Some(channel) = self
                .events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
        {
            let _ = channel.send("updater.state", value);
        }
    }

    fn update_snapshot(&self, mutate: impl FnOnce(&mut State)) -> Snapshot {
        let snapshot = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            mutate(&mut guard);
            guard.snapshot.clone()
        };
        self.emit(&snapshot);
        snapshot
    }

    pub(crate) async fn check(&self, user_initiated: bool) -> Snapshot {
        if self.info.channel == Channel::Dev {
            return self.snapshot();
        }
        {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(
                guard.snapshot.status,
                Status::Checking | Status::Downloading | Status::Ready | Status::Installing
            ) {
                return guard.snapshot.clone();
            }
            guard.snapshot.status = Status::Checking;
            guard.snapshot.error = None;
            let snapshot = guard.snapshot.clone();
            drop(guard);
            self.emit(&snapshot);
        }

        match maka_updater::check(&self.info).await {
            Ok(Some(available)) => {
                let can_install = maka_updater::can_install();
                self.update_snapshot(|state| {
                    state.snapshot.can_install = can_install;
                    state.snapshot.status = Status::Available;
                    state.snapshot.available = Some(available);
                    state.snapshot.progress = None;
                    state.snapshot.error = None;
                })
            }
            Ok(None) => self.update_snapshot(|state| {
                state.snapshot.status = Status::UpToDate;
                state.snapshot.available = None;
                state.snapshot.progress = None;
                state.snapshot.error = None;
            }),
            Err(error) => {
                if !user_initiated {
                    // Background checks stay quiet on transient network/offline failures.
                    return self.update_snapshot(|state| {
                        state.snapshot.status = Status::Idle;
                        state.snapshot.error = None;
                    });
                }
                self.update_snapshot(|state| {
                    state.snapshot.status = Status::Error;
                    state.snapshot.error = Some(error.to_string());
                })
            }
        }
    }

    pub(crate) async fn download(self: &Arc<Self>) -> Result<Snapshot, String> {
        let available = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if guard.snapshot.status == Status::Ready {
                return Ok(guard.snapshot.clone());
            }
            if matches!(
                guard.snapshot.status,
                Status::Downloading | Status::Installing
            ) {
                return Err("An update operation is already in progress.".into());
            }
            let Some(available) = guard.snapshot.available.clone() else {
                return Err("No update is currently available.".into());
            };
            guard.snapshot.status = Status::Downloading;
            guard.snapshot.progress = Some(Progress {
                received: 0,
                total: available.size,
            });
            guard.snapshot.error = None;
            guard.staged = None;
            let snapshot = guard.snapshot.clone();
            drop(guard);
            self.emit(&snapshot);
            available
        };

        let installation = match maka_updater::current_installation() {
            Ok(install) if install.can_install() => install,
            Ok(_) => {
                let message =
                    "This installation directory is read-only; download the update manually."
                        .to_owned();
                self.set_error(&message);
                return Err(message);
            }
            Err(error) => {
                let message = error.to_string();
                self.set_error(&message);
                return Err(message);
            }
        };

        let download_dir = std::env::temp_dir().join("maka-updates");
        let mut last_emit = Instant::now() - PROGRESS_EMIT_INTERVAL;
        let archive = match maka_updater::download(&available, &download_dir, |progress| {
            let finished = progress
                .total
                .is_some_and(|total| progress.received >= total);
            if finished || last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL {
                last_emit = Instant::now();
                let snapshot = {
                    let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    guard.snapshot.progress = Some(progress);
                    guard.snapshot.clone()
                };
                self.emit(&snapshot);
            }
        })
        .await
        {
            Ok(path) => path,
            Err(error) => {
                let message = error.to_string();
                self.set_error(&message);
                return Err(message);
            }
        };

        let staged = match maka_updater::stage(installation, archive.clone()).await {
            Ok(staged) => staged,
            Err(error) => {
                let _ = tokio::fs::remove_file(&archive).await;
                let message = error.to_string();
                self.set_error(&message);
                return Err(message);
            }
        };

        Ok(self.update_snapshot(|state| {
            state.staged = Some(staged);
            state.archive = Some(archive);
            state.snapshot.status = Status::Ready;
            state.snapshot.error = None;
        }))
    }

    pub(crate) async fn install_and_restart(&self) -> Result<(), String> {
        let (staged, archive) = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if guard.snapshot.status != Status::Ready {
                return Err("No verified update is ready to install.".into());
            }
            let Some(staged) = guard.staged.take() else {
                return Err("No staged update found.".into());
            };
            let archive = guard.archive.take();
            guard.snapshot.status = Status::Installing;
            guard.snapshot.error = None;
            let snapshot = guard.snapshot.clone();
            drop(guard);
            self.emit(&snapshot);
            (staged, archive)
        };

        // Confirm the staged directory is still intact on disk before stopping the Host.
        if let Ok(staged_dir) = maka_updater::current_staged_dir()
            && !staged_dir.is_dir()
        {
            drop(staged);
            let message =
                "Staged update files are no longer on disk; please download the update again."
                    .to_owned();
            self.set_error(&message);
            return Err(message);
        }

        // Pause Host reconnection before stopping the Host so follow() does not
        // spawn the old Host binary while we swap files; clearing resumes it on failure.
        self.updating.send_replace(true);

        let (endpoint, epoch) = self.active_host.borrow().clone();
        let lease = match maka_updater::stop_host(&self.root, &endpoint, epoch).await {
            Ok(lease) => lease,
            Err(error) => {
                self.updating.send_replace(false);
                let message = error.to_string();
                self.update_snapshot(|state| {
                    state.staged = Some(staged);
                    state.archive = archive;
                    state.snapshot.status = Status::Ready;
                    state.snapshot.error = Some(message.clone());
                });
                return Err(message);
            }
        };

        // Admit the swap only if desktop shutdown has not begun, then move both
        // the Root writer lease and SwapGuard into the blocking swap thread so
        // async cancellation cannot release the lease early.
        let Some(swap_guard) = self.swap.try_begin() else {
            drop(staged);
            drop(lease);
            self.updating.send_replace(false);
            return Err(
                "Desktop is exiting; update installation cancelled before file swap.".into(),
            );
        };
        let new_executable =
            match maka_updater::finish_with_guard(staged, (lease, swap_guard)).await {
                Ok(path) => path,
                Err(error) => {
                    self.updating.send_replace(false);
                    let message = error.to_string();
                    self.set_error(&message);
                    return Err(message);
                }
            };
        if let Some(archive) = archive {
            let _ = tokio::fs::remove_file(archive).await;
        }

        if let Err(error) = maka_updater::spawn_restarted_desktop(&new_executable, Some(&self.root))
        {
            self.updating.send_replace(false);
            let message = format!(
                "Update installed, but failed to relaunch automatically ({error}). Please restart Maka."
            );
            self.set_error(&message);
            return Err(message);
        }
        let _ = self.exit.send(());
        Ok(())
    }

    fn set_error(&self, message: &str) {
        self.update_snapshot(|state| {
            state.snapshot.status = Status::Error;
            state.snapshot.error = Some(message.to_owned());
        });
    }

    /// Closes admission for any new filesystem swap and blocks normal desktop
    /// shutdown until any already-admitted swap finishes and releases its `RootLease`.
    pub(crate) fn wait_for_in_flight_swap(&self) {
        self.swap.close_and_wait();
    }

    pub(crate) fn snapshot_json(&self) -> JsonValue {
        serde_json::to_value(self.snapshot()).unwrap_or(JsonValue::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::SwapFence;
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    #[test]
    fn swap_fence_blocks_shutdown_until_swap_guard_drops_and_rejects_late_admission() {
        let fence = SwapFence::new();
        let guard = fence.try_begin().expect("swap admitted before shutdown");
        let waiter_fence = Arc::clone(&fence);
        let started = Instant::now();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            drop(guard);
        });
        waiter_fence.close_and_wait();
        assert!(started.elapsed() >= Duration::from_millis(90));
        releaser.join().unwrap();
        // Once shutdown has closed admission, no late task may begin a new swap.
        assert!(fence.try_begin().is_none());
        fence.close_and_wait();
    }
}
