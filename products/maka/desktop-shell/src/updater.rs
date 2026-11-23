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
    future::Future,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    runtime::Handle,
    sync::{mpsc, oneshot, watch},
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

struct DownloadSlot {
    closing: bool,
    active: Option<tokio::task::JoinHandle<()>>,
}

struct TempFileGuard(Option<PathBuf>);

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self(Some(path))
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
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
    shutdown: watch::Sender<bool>,
    downloads: Mutex<DownloadSlot>,
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
        let (shutdown, _) = watch::channel(false);
        let controller = Arc::new(Self {
            info,
            root,
            active_host,
            updating,
            exit,
            events,
            runtime: runtime.clone(),
            swap: SwapFence::new(),
            shutdown,
            downloads: Mutex::new(DownloadSlot {
                closing: false,
                active: None,
            }),
            state: Mutex::new(State {
                snapshot,
                staged: None,
            }),
        });
        if controller.info.channel != Channel::Dev {
            let background = Arc::clone(&controller);
            let mut shutdown = controller.shutdown.subscribe();
            runtime.spawn(async move {
                tokio::select! {
                    biased;
                    _ = shutdown.wait_for(|&closed| closed) => return,
                    _ = tokio::time::sleep(INITIAL_CHECK_DELAY) => {}
                }
                background.check(false).await;
                let mut interval = tokio::time::interval(CHECK_INTERVAL);
                interval.tick().await;
                loop {
                    tokio::select! {
                        biased;
                        _ = shutdown.wait_for(|&closed| closed) => return,
                        _ = interval.tick() => {}
                    }
                    let snapshot = background.snapshot();
                    let can_recheck = matches!(snapshot.status, Status::Idle | Status::UpToDate)
                        || (snapshot.status == Status::Available && !snapshot.can_install);
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

    pub(crate) async fn check(self: &Arc<Self>, user_initiated: bool) -> Snapshot {
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

        let result = maka_updater::check(&self.info)
            .await
            .map_err(|error| error.to_string());
        let can_install = matches!(&result, Ok(Some(_))) && maka_updater::can_install();
        let (snapshot, auto_download) =
            self.apply_check_result(result, can_install, user_initiated);
        if let Some(available) = auto_download {
            let _ = self.spawn_download(available, user_initiated);
        }
        snapshot
    }

    fn apply_check_result(
        &self,
        result: Result<Option<AvailableUpdate>, String>,
        can_install: bool,
        user_initiated: bool,
    ) -> (Snapshot, Option<AvailableUpdate>) {
        match result {
            Ok(Some(available)) if can_install => {
                let to_download = available.clone();
                let snapshot = self.update_snapshot(|state| {
                    state.staged = None;
                    state.snapshot.can_install = true;
                    state.snapshot.status = Status::Downloading;
                    state.snapshot.available = Some(available);
                    state.snapshot.progress = Some(Progress {
                        received: 0,
                        total: to_download.size,
                    });
                    state.snapshot.error = None;
                });
                (snapshot, Some(to_download))
            }
            Ok(Some(available)) => {
                let snapshot = self.update_snapshot(|state| {
                    state.snapshot.can_install = false;
                    state.snapshot.status = Status::Available;
                    state.snapshot.available = Some(available);
                    state.snapshot.progress = None;
                    state.snapshot.error = None;
                });
                (snapshot, None)
            }
            Ok(None) => {
                let snapshot = self.update_snapshot(|state| {
                    state.snapshot.status = Status::UpToDate;
                    state.snapshot.available = None;
                    state.snapshot.progress = None;
                    state.snapshot.error = None;
                });
                (snapshot, None)
            }
            Err(message) => {
                let snapshot = if !user_initiated {
                    // Background checks stay quiet on transient network/offline failures.
                    self.update_snapshot(|state| {
                        state.snapshot.status = Status::Idle;
                        state.snapshot.progress = None;
                        state.snapshot.error = None;
                    })
                } else {
                    self.update_snapshot(|state| {
                        state.snapshot.status = Status::Error;
                        state.snapshot.progress = None;
                        state.snapshot.error = Some(message);
                    })
                };
                (snapshot, None)
            }
        }
    }

    pub(crate) async fn download(self: &Arc<Self>) -> Result<Snapshot, String> {
        if *self.shutdown.borrow() {
            return Err("Desktop is exiting; update download cancelled.".into());
        }
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

        let Some(result_rx) = self.spawn_download(available, true) else {
            return Err("Desktop is exiting; update download cancelled.".into());
        };
        result_rx
            .await
            .unwrap_or_else(|_| Err("Update download task stopped unexpectedly.".into()))
    }

    fn spawn_download(
        self: &Arc<Self>,
        available: AvailableUpdate,
        user_initiated: bool,
    ) -> Option<oneshot::Receiver<Result<Snapshot, String>>> {
        let downloader = Arc::clone(self);
        self.spawn_download_task(async move {
            downloader.perform_download(available, user_initiated).await
        })
    }

    fn spawn_download_task<F>(
        &self,
        future: F,
    ) -> Option<oneshot::Receiver<Result<Snapshot, String>>>
    where
        F: Future<Output = Result<Snapshot, String>> + Send + 'static,
    {
        let mut slot = self.downloads.lock().unwrap_or_else(|e| e.into_inner());
        if slot.closing {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        let handle = self.runtime.spawn(async move {
            let _ = tx.send(future.await);
        });
        slot.active = Some(handle);
        Some(rx)
    }

    async fn perform_download(
        self: &Arc<Self>,
        available: AvailableUpdate,
        user_initiated: bool,
    ) -> Result<Snapshot, String> {
        let installation = match maka_updater::current_installation() {
            Ok(install) if install.can_install() => install,
            Ok(_) => {
                let message =
                    "This installation directory is read-only; download the update manually."
                        .to_owned();
                self.fail_download(user_initiated, &message, true);
                return Err(message);
            }
            Err(error) => {
                let message = error.to_string();
                self.fail_download(user_initiated, &message, false);
                return Err(message);
            }
        };

        let download_dir = std::env::temp_dir().join("maka-updates");
        self.perform_download_with(
            available,
            user_initiated,
            download_dir,
            move |archive| async move {
                maka_updater::stage(installation, archive)
                    .await
                    .map_err(|error| error.to_string())
            },
        )
        .await
    }

    async fn perform_download_with<S, Fut>(
        self: &Arc<Self>,
        available: AvailableUpdate,
        user_initiated: bool,
        download_dir: PathBuf,
        stage: S,
    ) -> Result<Snapshot, String>
    where
        S: FnOnce(PathBuf) -> Fut,
        Fut: Future<Output = Result<StagedUpdate, String>>,
    {
        let mut shutdown = self.shutdown.subscribe();
        if *shutdown.borrow() {
            return Err("Update cancelled during shutdown.".into());
        }

        let mut last_emit = Instant::now() - PROGRESS_EMIT_INTERVAL;
        // Cancel only the in-flight HTTP transfer on shutdown so its `.part` guard cleans up
        // promptly; once staging begins, shutdown waits for unpack and archive removal together.
        let download_result = tokio::select! {
            biased;
            _ = shutdown.wait_for(|&closed| closed) => {
                return Err("Update cancelled during shutdown.".into());
            }
            result = maka_updater::download(&available, &download_dir, |progress| {
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
            }) => result,
        };
        let archive = match download_result {
            Ok(path) => path,
            Err(error) => {
                let message = error.to_string();
                self.fail_download(user_initiated, &message, false);
                return Err(message);
            }
        };
        let mut archive_guard = TempFileGuard::new(archive.clone());
        if *shutdown.borrow() {
            let _ = tokio::fs::remove_file(&archive).await;
            archive_guard.disarm();
            return Err("Update cancelled during shutdown.".into());
        }

        let staged_result = stage(archive.clone()).await;
        // stage() unpacks into its own scratch directory and no longer references the archive;
        // remove it immediately so deferring restart or exiting during staging leaves no stale
        // downloads behind.
        let _ = tokio::fs::remove_file(&archive).await;
        archive_guard.disarm();
        let staged = match staged_result {
            Ok(staged) => staged,
            Err(message) => {
                if *shutdown.borrow() {
                    return Err("Update cancelled during shutdown.".into());
                }
                self.fail_download(user_initiated, &message, false);
                return Err(message);
            }
        };

        if *shutdown.borrow() {
            let _ = tokio::task::spawn_blocking(move || drop(staged)).await;
            return Err("Update cancelled during shutdown.".into());
        }

        Ok(self.update_snapshot(|state| {
            state.staged = Some(staged);
            state.snapshot.status = Status::Ready;
            state.snapshot.progress = None;
            state.snapshot.error = None;
        }))
    }

    fn fail_download(&self, user_initiated: bool, message: &str, read_only: bool) {
        if read_only {
            self.update_snapshot(|state| {
                state.snapshot.can_install = false;
                state.snapshot.progress = None;
                if user_initiated {
                    state.snapshot.status = Status::Error;
                    state.snapshot.error = Some(message.to_owned());
                } else {
                    state.snapshot.status = Status::Available;
                    state.snapshot.error = None;
                }
            });
            return;
        }
        if !user_initiated {
            // Silent background download failures reset to Idle so the periodic timer can retry.
            self.update_snapshot(|state| {
                state.snapshot.status = Status::Idle;
                state.snapshot.available = None;
                state.snapshot.progress = None;
                state.snapshot.error = None;
            });
            return;
        }
        self.update_snapshot(|state| {
            state.snapshot.status = Status::Error;
            state.snapshot.progress = None;
            state.snapshot.error = Some(message.to_owned());
        });
    }

    pub(crate) async fn install_and_restart(&self) -> Result<(), String> {
        let staged = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if guard.snapshot.status != Status::Ready {
                return Err("No verified update is ready to install.".into());
            }
            let Some(staged) = guard.staged.take() else {
                return Err("No staged update found.".into());
            };
            guard.snapshot.status = Status::Installing;
            guard.snapshot.error = None;
            let snapshot = guard.snapshot.clone();
            drop(guard);
            self.emit(&snapshot);
            staged
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

    /// Closes admission for any new filesystem swap or download, waits for any
    /// in-flight swap to release its `RootLease`, cancels an active HTTP download
    /// so its `.part` file is cleaned up, and lets an in-progress stage finish
    /// unpacking and delete its downloaded archive before runtime shutdown.
    pub(crate) fn wait_for_in_flight_swap(&self) {
        self.swap.close_and_wait();
        let download = {
            let mut slot = self.downloads.lock().unwrap_or_else(|e| e.into_inner());
            slot.closing = true;
            slot.active.take()
        };
        self.shutdown.send_replace(true);
        if let Some(handle) = download {
            if tokio::runtime::Handle::try_current().is_err() {
                let _ = self.runtime.block_on(handle);
            } else {
                let runtime = self.runtime.clone();
                let _ = std::thread::spawn(move || {
                    let _ = runtime.block_on(handle);
                })
                .join();
            }
        }
        let staged = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .staged
            .take();
        drop(staged);
    }

    pub(crate) fn snapshot_json(&self) -> JsonValue {
        serde_json::to_value(self.snapshot()).unwrap_or(JsonValue::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::{Controller, DownloadSlot, Snapshot, State, Status, SwapFence};
    use maka_updater::{AvailableUpdate, BuildInfo, Channel};
    use std::{
        path::PathBuf,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        time::{Duration, Instant},
    };
    use tokio::{
        io::{AsyncReadExt as _, AsyncWriteExt as _},
        net::TcpListener,
        sync::{mpsc, watch},
    };
    use uuid::Uuid;

    fn test_controller(channel: Channel) -> (tokio::runtime::Runtime, Arc<Controller>) {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let (_host_tx, host_rx) = watch::channel((PathBuf::new(), Uuid::nil()));
        let (updating_tx, _updating_rx) = watch::channel(false);
        let (exit_tx, _exit_rx) = mpsc::unbounded_channel();
        let (shutdown, _) = watch::channel(false);
        let controller = Arc::new(Controller {
            info: BuildInfo {
                channel,
                version: "0.2.0-nightly.1".into(),
                repo: "apache/maka".into(),
                public_key: None,
            },
            root: PathBuf::new(),
            active_host: host_rx,
            updating: updating_tx,
            exit: exit_tx,
            events: Arc::default(),
            runtime: rt.handle().clone(),
            swap: SwapFence::new(),
            shutdown,
            downloads: Mutex::new(DownloadSlot {
                closing: false,
                active: None,
            }),
            state: Mutex::new(State {
                snapshot: Snapshot {
                    channel,
                    current_version: "0.2.0-nightly.1".into(),
                    can_install: true,
                    status: Status::Idle,
                    available: None,
                    progress: None,
                    error: None,
                },
                staged: None,
            }),
        });
        (rt, controller)
    }

    fn sample_update() -> AvailableUpdate {
        AvailableUpdate {
            version: "0.2.0-nightly.2".into(),
            notes: None,
            url: "https://example.invalid/maka.tar.gz".into(),
            sha256: None,
            size: Some(1024),
        }
    }

    #[test]
    fn check_result_starts_auto_download_when_installable_and_stays_available_when_read_only() {
        let (_rt, controller) = test_controller(Channel::Nightly);
        let (snapshot, auto) =
            controller.apply_check_result(Ok(Some(sample_update())), true, false);
        assert_eq!(snapshot.status, Status::Downloading);
        assert!(snapshot.can_install);
        assert_eq!(
            auto.as_ref().map(|u| u.version.as_str()),
            Some("0.2.0-nightly.2")
        );
        assert_eq!(snapshot.progress.as_ref().and_then(|p| p.total), Some(1024));

        let (_rt2, read_only) = test_controller(Channel::Nightly);
        let (snapshot, auto) =
            read_only.apply_check_result(Ok(Some(sample_update())), false, false);
        assert_eq!(snapshot.status, Status::Available);
        assert!(!snapshot.can_install);
        assert!(auto.is_none());
    }

    #[test]
    fn download_failure_is_silent_in_background_and_visible_when_user_initiated() {
        let (_rt, background) = test_controller(Channel::Nightly);
        background.apply_check_result(Ok(Some(sample_update())), true, false);
        background.fail_download(false, "network reset", false);
        let snap = background.snapshot();
        assert_eq!(snap.status, Status::Idle);
        assert!(snap.available.is_none());
        assert!(snap.error.is_none());

        let (_rt2, read_only_bg) = test_controller(Channel::Nightly);
        read_only_bg.apply_check_result(Ok(Some(sample_update())), true, false);
        read_only_bg.fail_download(false, "read-only", true);
        let snap = read_only_bg.snapshot();
        assert_eq!(snap.status, Status::Available);
        assert!(!snap.can_install);
        assert!(snap.error.is_none());

        let (_rt3, manual) = test_controller(Channel::Nightly);
        manual.apply_check_result(Ok(Some(sample_update())), true, true);
        manual.fail_download(true, "network reset", false);
        let snap = manual.snapshot();
        assert_eq!(snap.status, Status::Error);
        assert_eq!(snap.error.as_deref(), Some("network reset"));
    }

    #[test]
    fn shutdown_cancels_active_http_download_and_removes_part_file() {
        let (_rt, controller) = test_controller(Channel::Nightly);
        let dir = std::env::temp_dir().join(format!("maka-updater-part-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let (addr, _hold_tx) = controller.runtime.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (hold_tx, mut hold_rx) = tokio::sync::oneshot::channel::<()>();
            tokio::spawn(async move {
                if let Ok((mut stream, _)) = listener.accept().await {
                    let mut req = [0u8; 1024];
                    let _ = stream.read(&mut req).await;
                    let body_chunk = vec![b'x'; 16 * 1024];
                    let header = format!(
                        "HTTP/1.1 200 OK
Content-Length: {}
Connection: close

",
                        64 * 1024
                    );
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(&body_chunk).await;
                    let _ = stream.flush().await;
                    let _ = (&mut hold_rx).await;
                }
            });
            (addr, hold_tx)
        });

        let update = AvailableUpdate {
            version: "0.2.0-nightly.2".into(),
            notes: None,
            url: format!("http://{addr}/maka-0.2.0-nightly.2.tar.gz"),
            sha256: Some("0".repeat(64)),
            size: Some(64 * 1024),
        };
        let downloader = Arc::clone(&controller);
        let download_dir = dir.clone();
        controller
            .spawn_download_task(async move {
                downloader
                    .perform_download_with(update, false, download_dir, |_archive| async {
                        unreachable!("download should cancel before staging")
                    })
                    .await
            })
            .expect("download admitted before shutdown");

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let has_part = std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| entry.path().extension().and_then(|s| s.to_str()) == Some("part"));
            if has_part {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for .part file during HTTP download"
            );
            std::thread::sleep(Duration::from_millis(20));
        }

        controller.wait_for_in_flight_swap();
        let remaining: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name())
            .collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            remaining.is_empty(),
            "download directory should be empty after mid-download shutdown, found: {remaining:?}"
        );
    }

    #[test]
    fn shutdown_during_staging_waits_for_stage_and_removes_archive() {
        let (_rt, controller) = test_controller(Channel::Nightly);
        let dir = std::env::temp_dir().join(format!("maka-updater-stage-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let payload = b"test-archive-payload";
        let addr = controller.runtime.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                if let Ok((mut stream, _)) = listener.accept().await {
                    let mut req = [0u8; 1024];
                    let _ = stream.read(&mut req).await;
                    let header = format!(
                        "HTTP/1.1 200 OK
Content-Length: {}
Connection: close

",
                        payload.len()
                    );
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(payload).await;
                    let _ = stream.flush().await;
                }
            });
            addr
        });

        let update = AvailableUpdate {
            version: "0.2.0-nightly.2".into(),
            notes: None,
            url: format!("http://{addr}/maka-0.2.0-nightly.2.tar.gz"),
            sha256: Some("154e8705933ef8c47e8c89172335a60c0f1a38d27a778383d84ad9a9f88c15a0".into()),
            size: Some(payload.len() as u64),
        };
        let (stage_started_tx, stage_started_rx) = std::sync::mpsc::channel();
        let stage_finished = Arc::new(AtomicBool::new(false));
        let stage_finished_flag = Arc::clone(&stage_finished);
        let downloader = Arc::clone(&controller);
        let download_dir = dir.clone();
        controller
            .spawn_download_task(async move {
                downloader
                    .perform_download_with(update, false, download_dir, move |archive| async move {
                        assert!(
                            archive.exists(),
                            "downloaded archive must exist when staging starts"
                        );
                        let _ = stage_started_tx.send(());
                        tokio::task::spawn_blocking(move || {
                            std::thread::sleep(Duration::from_millis(150));
                            assert!(
                                archive.exists(),
                                "archive must remain present while staging unpacks it"
                            );
                        })
                        .await
                        .unwrap();
                        stage_finished_flag.store(true, Ordering::SeqCst);
                        Err("simulated unpack completion".into())
                    })
                    .await
            })
            .expect("download admitted before shutdown");

        stage_started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("staging should begin after HTTP download finishes");

        controller.wait_for_in_flight_swap();
        let remaining: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name())
            .collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            stage_finished.load(Ordering::SeqCst),
            "shutdown should wait for in-progress staging instead of aborting it"
        );
        assert!(
            remaining.is_empty(),
            "download directory should be empty after mid-staging shutdown, found: {remaining:?}"
        );
    }

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
