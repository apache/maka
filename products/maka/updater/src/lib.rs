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

//! Channel-isolated self-update for packaged Maka desktop and CLI installations,
//! built directly on `nsh-updater` and Maka's durable Host restart flow.

use futures_util::StreamExt as _;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_host_runtime::application::host::Client as HostClient;
use nsh_updater::install::{Installation, Staged};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::ffi::OsString;
use std::{
    io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt as _;
use uuid::Uuid;

pub use nsh_updater::install::Staged as StagedUpdate;

/// Application identifier shared across desktop bundles and `latest.json`.
pub const APP_ID: &str = "org.apache.maka.desktop";
/// Default GitHub repository hosting releases and nightly prereleases.
pub const DEFAULT_REPO: &str = "apache/maka";
/// Environment variable carrying a custom State Root across an update restart.
pub const RESTART_ROOT_ENV: &str = "MAKA_RESTART_ROOT";
/// Environment variable naming the exiting desktop PID on Windows restarts.
pub const RESTART_WAIT_PID_ENV: &str = "MAKA_RESTART_WAIT_PID";

/// Default bound when waiting for a retiring Host to release its Root lease.
pub const HOST_STOP_TIMEOUT: Duration = Duration::from_secs(15);
const HOST_STOP_POLL: Duration = Duration::from_millis(100);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
#[cfg(unix)]
const WAIT_LIMIT_SECS: u64 = 15;

/// Update channel stamped at build time. Channels are strictly isolated:
/// nightly builds only track nightly prereleases, release builds only track
/// official releases, and development builds never check for updates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Dev,
    Nightly,
    Release,
}

impl Channel {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("nightly") => Self::Nightly,
            Some("release") => Self::Release,
            _ => Self::Dev,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Nightly => "nightly",
            Self::Release => "release",
        }
    }
}

/// Immutable build identity stamped at compile time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub channel: Channel,
    pub version: String,
    pub repo: String,
    #[serde(skip_serializing)]
    pub public_key: Option<String>,
}

impl BuildInfo {
    /// Reads the build identity compiled into this binary.
    pub fn current() -> Self {
        let channel = Channel::parse(option_env!("MAKA_UPDATE_CHANNEL"));
        let version = option_env!("MAKA_BUILD_VERSION")
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(env!("CARGO_PKG_VERSION"))
            .to_owned();
        let repo = option_env!("MAKA_UPDATE_REPO")
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(DEFAULT_REPO)
            .to_owned();
        let public_key = option_env!("MAKA_UPDATE_PUBLIC_KEY")
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned);
        Self {
            channel,
            version,
            repo,
            public_key,
        }
    }

    /// Builds the `nsh-updater` configuration for this channel, or `None` for
    /// development builds.
    pub fn config(&self) -> Result<Option<nsh_updater::Config>, Error> {
        match self.channel {
            Channel::Dev => Ok(None),
            Channel::Nightly => {
                let public_key = self.public_key.clone().ok_or(Error::MissingPublicKey)?;
                let mut config = nsh_updater::Config::default();
                config.id = APP_ID.to_owned();
                config.version = self.version.clone();
                config.url = Some(format!(
                    "https://github.com/{}/releases/download/nightly/{}",
                    self.repo,
                    nsh_updater::MANIFEST
                ));
                config.public_key = Some(public_key);
                config.validate()?;
                Ok(Some(config))
            }
            Channel::Release => {
                let mut config = nsh_updater::Config::default();
                config.id = APP_ID.to_owned();
                config.version = self.version.clone();
                config.github = Some(self.repo.clone());
                config.public_key = self.public_key.clone();
                config.validate()?;
                Ok(Some(config))
            }
        }
    }
}

/// Update offered for this machine and channel.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub notes: Option<String>,
    pub url: String,
    pub sha256: Option<String>,
    pub size: Option<u64>,
}

/// Byte-level download progress.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("nightly updates require a compiled MAKA_UPDATE_PUBLIC_KEY")]
    MissingPublicKey,
    #[error("this installation cannot self-update in place: {0}")]
    NotInstallable(String),
    #[error("update request failed: {0}")]
    Http(String),
    #[error("{0}")]
    Updater(#[from] nsh_updater::Error),
    #[error("Host did not stop before applying update: {0}")]
    HostStop(String),
    #[error("{0}")]
    Io(#[from] io::Error),
}

/// Enforces channel boundaries on top of `nsh-updater`'s SemVer ordering:
/// release builds never accept prereleases; nightly builds only accept
/// `-nightly.*` prereleases.
pub fn accepts_version(channel: Channel, version: &str) -> bool {
    let Ok(parsed) = semver::Version::parse(version) else {
        return false;
    };
    match channel {
        Channel::Dev => false,
        Channel::Release => parsed.pre.is_empty(),
        Channel::Nightly => parsed.pre.as_str().starts_with("nightly."),
    }
}

/// Resolves the self-updatable installation directory for `exe`.
///
/// Only self-contained desktop/CLI installations qualify:
/// - macOS: `<Name>.app/Contents/MacOS/<exe>` with sibling `maka` inside the bundle.
/// - Linux/Windows: a directory holding `<exe>` and sibling `maka[.exe]`,
///   excluding Cargo build output directories.
fn installation_root_and_rel(exe: &Path) -> Result<(PathBuf, PathBuf), Error> {
    let parent = exe
        .parent()
        .ok_or_else(|| Error::NotInstallable("executable has no parent directory".into()))?;

    #[cfg(target_os = "macos")]
    {
        if let Some(bundle) = app_bundle(exe) {
            if !parent.join("maka").is_file() {
                return Err(Error::NotInstallable(
                    "Maka.app is not self-contained (missing bundled maka launcher)".into(),
                ));
            }
            let rel = exe.strip_prefix(bundle).map_err(|_| {
                Error::NotInstallable("executable is not inside Maka.app bundle".into())
            })?;
            return Ok((bundle.to_path_buf(), rel.to_path_buf()));
        }
        return Err(Error::NotInstallable(
            "macOS self-updates require a self-contained Maka.app bundle".into(),
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        if is_cargo_target_dir(parent) {
            return Err(Error::NotInstallable(
                "development build under Cargo target directory".into(),
            ));
        }
        let launcher_name = if cfg!(windows) { "maka.exe" } else { "maka" };
        if !parent.join(launcher_name).is_file() {
            return Err(Error::NotInstallable(format!(
                "missing sibling {launcher_name} beside executable"
            )));
        }
        let rel = exe.strip_prefix(parent).map_err(|_| {
            Error::NotInstallable("executable is not inside installation directory".into())
        })?;
        Ok((parent.to_path_buf(), rel.to_path_buf()))
    }
}

pub fn installation_for_executable(exe: &Path) -> Result<Installation, Error> {
    let (root, _) = installation_root_and_rel(exe)?;
    Installation::directory(&root, exe)
        .ok_or_else(|| Error::NotInstallable("installation directory is not valid".into()))
}

/// Resolves the current running process's self-updatable installation.
pub fn current_installation() -> Result<Installation, Error> {
    let exe = std::env::current_exe()?.canonicalize()?;
    installation_for_executable(&exe)
}

/// Whether this running installation can replace itself in place.
pub fn can_install() -> bool {
    current_installation().is_ok_and(|install| install.can_install())
}

/// Returns the staging directory path `nsh-updater` creates for the current
/// process beside `exe`'s installation root, so callers can confirm it is still
/// present before retiring the Host.
pub fn current_staged_dir() -> Result<PathBuf, Error> {
    let exe = std::env::current_exe()?.canonicalize()?;
    let (root, _) = installation_root_and_rel(&exe)?;
    let name = root
        .file_name()
        .ok_or_else(|| Error::NotInstallable("installation root has no file name".into()))?;
    let parent = root.parent().unwrap_or(&root);
    let mut staged =
        std::ffi::OsString::from(format!(".nsh-updater-staged-{}-", std::process::id()));
    staged.push(name);
    Ok(parent.join(staged))
}

/// Removes leftover files from previous updates while preserving any staging
/// directory owned by another still-running process.
pub fn remove_stale_leftovers() {
    let Ok(exe) = std::env::current_exe().and_then(|p| p.canonicalize()) else {
        return;
    };
    let Ok((root, rel_exe)) = installation_root_and_rel(&exe) else {
        return;
    };
    remove_stale_leftovers_for(&root, &rel_exe);
}

fn remove_stale_leftovers_for(root: &Path, relative_executable: &Path) {
    const STAGED_PREFIX: &str = ".nsh-updater-staged-";
    const OLD_MARKER: &str = ".nsh-updater-old-";
    let my_pid = std::process::id();
    let parent = root.parent().unwrap_or(root);
    if let (Some(app_name), Ok(entries)) = (root.file_name(), std::fs::read_dir(parent)) {
        let app_name = app_name.to_string_lossy();
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let text = file_name.to_string_lossy();
            let stale_stage =
                stale_owner_entry(&text, STAGED_PREFIX, my_pid) == Some(app_name.as_ref());
            let stale_old = stale_owner_entry(&text, OLD_MARKER, my_pid) == Some(app_name.as_ref());
            if stale_stage || stale_old {
                let path = entry.path();
                let _ = if path.is_dir() {
                    std::fs::remove_dir_all(&path)
                } else {
                    std::fs::remove_file(&path)
                };
            }
        }
    }

    let mut dir = root.to_path_buf();
    let mut components = relative_executable.components();
    components.next_back();
    loop {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let file_name = entry.file_name();
                let text = file_name.to_string_lossy();
                if stale_owner_entry(&text, OLD_MARKER, my_pid).is_some() {
                    let path = entry.path();
                    let _ = if path.is_dir() {
                        std::fs::remove_dir_all(&path)
                    } else {
                        std::fs::remove_file(&path)
                    };
                }
            }
        }
        match components.next() {
            Some(component) => dir.push(component),
            None => break,
        }
    }
}

/// Parses `<prefix><pid>-<rest>` and returns `Some(rest)` only when `pid`
/// belongs to a different process that is no longer alive.
fn stale_owner_entry<'a>(text: &'a str, prefix: &str, my_pid: u32) -> Option<&'a str> {
    let rest = text.strip_prefix(prefix)?;
    let (pid_text, name) = rest.split_once('-')?;
    let pid = pid_text.parse::<u32>().ok()?;
    (pid != my_pid && !is_process_alive(pid)).then_some(name)
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: kill(pid, 0) sends no signal and only probes process existence.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn is_process_alive(pid: u32) -> bool {
    use std::ffi::c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    // SAFETY: OpenProcess/GetExitCodeProcess/CloseHandle check null handle and close it before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

/// Checks for a newer release on `info`'s channel.
pub async fn check(info: &BuildInfo) -> Result<Option<AvailableUpdate>, Error> {
    let Some(config) = info.config()? else {
        return Ok(None);
    };
    check_with_config(info.channel, &config, &nsh_updater::platform()).await
}

/// Checks a specific `nsh-updater` configuration and target platform.
pub async fn check_with_config(
    channel: Channel,
    config: &nsh_updater::Config,
    platform: &str,
) -> Result<Option<AvailableUpdate>, Error> {
    let client = http_client(REQUEST_TIMEOUT)?;
    let manifest_url = config.manifest_url();
    let manifest_bytes = fetch_bytes(&client, &manifest_url).await?;
    let signature = match config.signature_url() {
        Some(sig_url) => Some(fetch_bytes(&client, &sig_url).await?),
        None => None,
    };
    let Some(available) = config.check(&manifest_bytes, signature.as_deref(), platform)? else {
        return Ok(None);
    };
    if !accepts_version(channel, &available.version) {
        return Ok(None);
    }
    Ok(Some(AvailableUpdate {
        version: available.version,
        notes: available.notes,
        url: available.url,
        sha256: available.sha256,
        size: available.size,
    }))
}

struct PartFileGuard(Option<PathBuf>);

impl PartFileGuard {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for PartFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Streams `update` into `dir`, verifying its exact SHA-256 and byte length.
pub async fn download<F>(
    update: &AvailableUpdate,
    dir: &Path,
    mut on_progress: F,
) -> Result<PathBuf, Error>
where
    F: FnMut(Progress),
{
    let sha256 = update
        .sha256
        .as_deref()
        .ok_or_else(|| Error::NotInstallable("update manifest has no archive SHA-256".into()))?;
    let ext = archive_extension(&update.url).ok_or_else(|| {
        Error::NotInstallable(format!("unsupported archive format: {}", update.url))
    })?;
    tokio::fs::create_dir_all(dir).await?;

    let part_path = dir.join(format!(".maka-update-{}.part", Uuid::new_v4()));
    let final_path = dir.join(format!("maka-{}{ext}", sanitize_filename(&update.version)));

    let client = http_client(DOWNLOAD_TIMEOUT)?;
    let response = client
        .get(&update.url)
        .send()
        .await
        .map_err(|e| Error::Http(format!("{}: {e}", update.url)))?;
    if !response.status().is_success() {
        return Err(Error::Http(format!(
            "{}: HTTP {}",
            update.url,
            response.status()
        )));
    }
    let total = update.size.or_else(|| response.content_length());
    let mut verifier = nsh_updater::Download::new(sha256, update.size);
    // Declared before `file` so reverse drop order closes the handle before deleting
    // the `.part` file on error or async task cancellation.
    let mut part_guard = PartFileGuard(Some(part_path.clone()));
    let mut file = tokio::fs::File::create(&part_path).await?;
    let mut stream = response.bytes_stream();
    on_progress(Progress { received: 0, total });
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| Error::Http(format!("{}: {e}", update.url)))?;
        let received = verifier.update(&chunk)?;
        file.write_all(&chunk).await?;
        on_progress(Progress { received, total });
    }
    file.flush().await?;
    drop(file);
    verifier.finish()?;
    let _ = tokio::fs::remove_file(&final_path).await;
    tokio::fs::rename(&part_path, &final_path).await?;
    part_guard.disarm();
    Ok(final_path)
}

/// Unpacks and verifies `archive` beside `installation` without modifying
/// the installed files yet. Runs blocking filesystem/codesign work off the
/// async executor.
pub async fn stage(installation: Installation, archive: PathBuf) -> Result<Staged, Error> {
    tokio::task::spawn_blocking(move || installation.stage(&archive))
        .await
        .map_err(|e| Error::Io(io::Error::other(e.to_string())))?
        .map_err(Error::from)
}

/// Swaps a verified staged update into place off the async executor.
pub async fn finish(staged: Staged) -> Result<PathBuf, Error> {
    finish_with_guard(staged, ()).await
}

/// Swaps a verified staged update into place off the async executor while
/// keeping `guard` (such as a `RootLease` or launch lock) alive inside the
/// blocking thread until `staged.finish()` actually returns, even if the
/// awaiting future is cancelled.
pub async fn finish_with_guard<G: Send + 'static>(
    staged: Staged,
    guard: G,
) -> Result<PathBuf, Error> {
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        staged.finish()
    })
    .await
    .map_err(|e| Error::Io(io::Error::other(e.to_string())))?
    .map_err(Error::from)
}

/// Exclusive writer lease on a State Root held across installation file swaps
/// so no candidate Host can start while binaries are being replaced.
pub struct RootLease(#[allow(dead_code)] RootOwner);

impl std::fmt::Debug for RootLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RootLease").finish_non_exhaustive()
    }
}

/// Result of a non-blocking attempt to fence an existing State Root.
pub enum RootLeaseAttempt {
    /// The Root directory has not been initialized yet; no Host can own it.
    Absent,
    /// Exclusive writer lease acquired; hold across `finish()`.
    Acquired(RootLease),
    /// Another Host currently holds the Root (starting up or draining).
    Busy,
}

/// Gracefully interrupts and stops the running local Maka Host, then acquires
/// and returns the State Root's `RootOwner` writer lease so durable execution
/// has finished draining and no new Host can start while files are swapped.
pub async fn stop_host(root: &Path, endpoint: &Path, epoch: Uuid) -> Result<RootLease, Error> {
    if let Err(error) = HostClient::retire_with_options(endpoint, epoch, true, true).await {
        if HostClient::status(endpoint, Some(epoch))
            .await
            .is_ok_and(|status| !status.closed)
        {
            return Err(Error::HostStop(error.to_string()));
        }
    }
    wait_for_root_release(root, HOST_STOP_TIMEOUT).await
}

/// Atomically retires the running local Maka Host only when zero interactive
/// sessions are attached. With `interrupt = false`, also refuses while active
/// background runs are in flight; with `interrupt = true`, interrupts background
/// runs while still refusing connected desktop/CLI sessions under the Host's
/// `access_gate`. Returns `Ok(None)` without disturbing the Host when refused,
/// or `Ok(Some(RootLease))` once the Host has released its Root writer lease.
pub async fn try_stop_host_without_sessions(
    root: &Path,
    endpoint: &Path,
    epoch: Uuid,
    interrupt: bool,
) -> Result<Option<RootLease>, Error> {
    match HostClient::retire_if_no_sessions(endpoint, epoch, interrupt).await {
        Ok(true) => wait_for_root_release(root, HOST_STOP_TIMEOUT)
            .await
            .map(Some),
        Ok(false) => Ok(None),
        Err(error) => {
            if HostClient::status(endpoint, Some(epoch))
                .await
                .is_ok_and(|status| !status.closed)
            {
                return Err(Error::HostStop(error.to_string()));
            }
            wait_for_root_release(root, HOST_STOP_TIMEOUT)
                .await
                .map(Some)
        }
    }
}

/// Non-blocking attempt to acquire the exclusive `RootOwner` writer lease on
/// `root` without creating or modifying an uninitialized Root directory.
pub async fn try_acquire_root_lease(root: &Path) -> Result<RootLeaseAttempt, Error> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let namespaces =
            RootNamespaces::for_current_account().map_err(|e| Error::HostStop(e.to_string()))?;
        match RootOwner::open(&root, &namespaces) {
            Ok(owner) => Ok(RootLeaseAttempt::Acquired(RootLease(owner))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(RootLeaseAttempt::Absent),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(RootLeaseAttempt::Busy),
            Err(error) => Err(Error::HostStop(error.to_string())),
        }
    })
    .await
    .map_err(|e| Error::HostStop(e.to_string()))?
}

/// Waits until no live Host holds the exclusive `RootOwner` writer lease on
/// `root` and returns the acquired lease so callers can hold it across file swap.
pub async fn wait_for_root_release(root: &Path, timeout: Duration) -> Result<RootLease, Error> {
    let root = root.to_path_buf();
    let deadline = Instant::now() + timeout;
    tokio::task::spawn_blocking(move || {
        let namespaces =
            RootNamespaces::for_current_account().map_err(|e| Error::HostStop(e.to_string()))?;
        loop {
            match RootOwner::open(&root, &namespaces) {
                Ok(owner) => return Ok(RootLease(owner)),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(Error::HostStop(
                            "timed out waiting for Maka Host to finish draining and release its Root writer lease"
                                .into(),
                        ));
                    }
                    std::thread::sleep(HOST_STOP_POLL);
                }
                Err(error) => return Err(Error::HostStop(error.to_string())),
            }
        }
    })
    .await
    .map_err(|e| Error::HostStop(e.to_string()))?
}

/// Schedules `new_executable` to start once this process exits, stripping stale
/// `MAKA_HOST_*` connection variables so the restarted desktop launches the new
/// Host binary and lets durable execution resume active runs.
pub fn spawn_restarted_desktop(new_executable: &Path, root: Option<&Path>) -> Result<(), Error> {
    let pid = std::process::id();
    let mut command = restart_command(new_executable, root, pid);
    for stale in [
        "MAKA_HOST_ROOT",
        "MAKA_HOST_ENDPOINT",
        "MAKA_HOST_EPOCH",
        "MAKA_LAUNCHER",
    ] {
        command.env_remove(stale);
    }
    if let Some(root) = root {
        command.env(RESTART_ROOT_ENV, root);
    } else {
        command.env_remove(RESTART_ROOT_ENV);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    command.spawn().map(drop).map_err(Error::from)
}

#[cfg(unix)]
fn restart_command(new_executable: &Path, root: Option<&Path>, pid: u32) -> Command {
    let tries = WAIT_LIMIT_SECS * 10;
    let script = format!(
        r#"i=0; while kill -0 "$0" 2>/dev/null && [ $i -lt {tries} ]; do sleep 0.1; i=$((i+1)); done; exec "$@""#
    );
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(script).arg(pid.to_string());
    if cfg!(target_os = "macos")
        && root.is_none()
        && let Some(bundle) = app_bundle(new_executable)
    {
        command.args(["/usr/bin/open", "-n"]).arg(bundle);
    } else {
        command.arg(new_executable);
    }
    command
}

#[cfg(windows)]
fn restart_command(new_executable: &Path, _root: Option<&Path>, pid: u32) -> Command {
    let mut command = Command::new(new_executable);
    command.env(RESTART_WAIT_PID_ENV, pid.to_string());
    command
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .user_agent(format!("maka-updater/{}", env!("CARGO_PKG_VERSION")))
        .timeout(timeout)
        .build()
        .map_err(|e| Error::Http(e.to_string()))
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, Error> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| Error::Http(format!("{url}: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::Http(format!("{url}: HTTP {}", response.status())));
    }
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| Error::Http(format!("{url}: {e}")))
}

fn archive_extension(url: &str) -> Option<&'static str> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    if path.ends_with(".tar.gz") {
        Some(".tar.gz")
    } else if path.ends_with(".tgz") {
        Some(".tgz")
    } else if path.ends_with(".zip") {
        Some(".zip")
    } else {
        None
    }
}

fn sanitize_filename(version: &str) -> String {
    version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Returns the enclosing macOS app for an executable in its `Contents/MacOS` directory.
#[cfg(unix)]
pub fn app_bundle(exe: &Path) -> Option<&Path> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == OsString::from("MacOS")
        && contents.file_name()? == OsString::from("Contents")
        && bundle.extension()? == OsString::from("app"))
    .then_some(bundle)
}

#[cfg(not(target_os = "macos"))]
fn is_cargo_target_dir(dir: &Path) -> bool {
    let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if !matches!(name, "debug" | "release") {
        return false;
    }
    dir.ancestors()
        .skip(1)
        .take(2)
        .any(|p| p.file_name().and_then(|n| n.to_str()) == Some("target"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest as _, Sha256};
    use std::collections::BTreeMap;
    use tokio::io::AsyncReadExt as _;

    const TEST_PUBLIC_KEY: &str = "oGP7zSYfzVnmOd519QY4J2Xqr44gvInzQLuz0lzR54E=";
    const TEST_SECRET_KEY: &str = "5V38Ej8EjohdJV5f3Zwfe1/XAnAZt8tf9aQGn0IOFK8=";

    #[test]
    fn channel_isolation_rejects_cross_channel_versions() {
        assert!(!accepts_version(Channel::Dev, "0.2.0"));
        assert!(!accepts_version(Channel::Dev, "0.2.0-nightly.20261121.1"));

        assert!(accepts_version(Channel::Release, "0.2.1"));
        assert!(!accepts_version(
            Channel::Release,
            "0.2.1-nightly.20261121.1"
        ));
        assert!(!accepts_version(Channel::Release, "0.2.1-rc.1"));

        assert!(accepts_version(
            Channel::Nightly,
            "0.2.0-nightly.20261121.1"
        ));
        assert!(!accepts_version(Channel::Nightly, "0.2.1"));
        assert!(!accepts_version(Channel::Nightly, "0.2.1-rc.1"));
    }

    #[test]
    fn nightly_config_requires_public_key_and_targets_nightly_tag() {
        let missing = BuildInfo {
            channel: Channel::Nightly,
            version: "0.2.0-nightly.20261121.1".into(),
            repo: "apache/maka".into(),
            public_key: None,
        };
        assert!(matches!(missing.config(), Err(Error::MissingPublicKey)));

        let valid = BuildInfo {
            public_key: Some(TEST_PUBLIC_KEY.into()),
            ..missing
        };
        let config = valid.config().unwrap().unwrap();
        assert_eq!(
            config.manifest_url(),
            "https://github.com/apache/maka/releases/download/nightly/latest.json"
        );
        assert_eq!(
            config.signature_url().as_deref(),
            Some("https://github.com/apache/maka/releases/download/nightly/latest.json.sig")
        );
    }

    #[test]
    fn release_config_targets_github_latest_release() {
        let info = BuildInfo {
            channel: Channel::Release,
            version: "0.2.0".into(),
            repo: "apache/maka".into(),
            public_key: None,
        };
        let config = info.config().unwrap().unwrap();
        assert_eq!(
            config.manifest_url(),
            "https://github.com/apache/maka/releases/latest/download/latest.json"
        );
    }

    #[test]
    fn node_nightly_manifest_signature_verifies_with_nsh_updater() {
        let sample = br#"{"id":"org.apache.maka.desktop","version":"0.2.0-nightly.20261121.2"}"#;
        let node_sig = b"FRCQsh5Ht43NYGF8hgM462ZZF8aFoMF9A+sNGmBl1Ux95o7RLh+iOts2qjRLdNoT1Yx+nG45bofDfhq5YKUiCg==";
        nsh_updater::verify(TEST_PUBLIC_KEY, sample, node_sig).unwrap();
    }

    #[test]
    fn dev_channel_disables_updates() {
        let info = BuildInfo {
            channel: Channel::Dev,
            version: "0.2.0".into(),
            repo: "apache/maka".into(),
            public_key: Some(TEST_PUBLIC_KEY.into()),
        };
        assert!(info.config().unwrap().is_none());
    }

    async fn serve_once(routes: BTreeMap<String, Vec<u8>>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for _ in 0..routes.len() + 2 {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let Ok(n) = socket.read(&mut buf).await else {
                        return;
                    };
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("/");
                    let (status, body) = match routes.get(path) {
                        Some(bytes) => ("200 OK", bytes.as_slice()),
                        None => ("404 Not Found", b"not found".as_slice()),
                    };
                    let header = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(header.as_bytes()).await;
                    let _ = socket.write_all(body).await;
                });
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn signed_nightly_check_and_verified_download_round_trip() {
        let archive_bytes = b"fake-tar-gz-payload-for-hash-verification".to_vec();
        let sha256 = Sha256::digest(&archive_bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();

        let mut platforms = BTreeMap::new();
        let mut asset = nsh_updater::Asset::default();
        asset.url = "Maka-nightly-test.tar.gz".into();
        asset.sha256 = Some(sha256.clone());
        asset.size = Some(archive_bytes.len() as u64);
        platforms.insert(nsh_updater::platform(), asset);

        let mut manifest = nsh_updater::Manifest::default();
        manifest.id = APP_ID.into();
        manifest.version = "0.2.0-nightly.20261121.2".into();
        manifest.notes = Some("Nightly test".into());
        manifest.platforms = platforms;

        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let sig_bytes = nsh_updater::sign(TEST_SECRET_KEY, &manifest_bytes)
            .unwrap()
            .into_bytes();

        let mut routes = BTreeMap::new();
        routes.insert("/latest.json".into(), manifest_bytes);
        routes.insert("/latest.json.sig".into(), sig_bytes);
        routes.insert("/Maka-nightly-test.tar.gz".into(), archive_bytes.clone());
        let base = serve_once(routes).await;

        let mut config = nsh_updater::Config::default();
        config.id = APP_ID.into();
        config.version = "0.2.0-nightly.20261121.1".into();
        config.url = Some(format!("{base}/latest.json"));
        config.public_key = Some(TEST_PUBLIC_KEY.into());

        // Release channel must ignore a nightly prerelease even if pointed at the same manifest.
        let cross = check_with_config(Channel::Release, &config, &nsh_updater::platform())
            .await
            .unwrap();
        assert!(cross.is_none());

        // Nightly channel accepts the newer nightly build.
        let found = check_with_config(Channel::Nightly, &config, &nsh_updater::platform())
            .await
            .unwrap()
            .expect("expected nightly update");
        assert_eq!(found.version, "0.2.0-nightly.20261121.2");

        // Download verifies exact SHA-256 and preserves archive extension.
        let temp = tempfile::tempdir().unwrap();
        let mut last_received = 0;
        let path = download(&found, temp.path(), |p| last_received = p.received)
            .await
            .unwrap();
        assert_eq!(last_received, archive_bytes.len() as u64);
        assert!(path.to_string_lossy().ends_with(".tar.gz"));
        assert_eq!(std::fs::read(&path).unwrap(), archive_bytes);
    }

    #[tokio::test]
    async fn download_rejects_corrupted_bytes_and_cleans_part_file() {
        let mut routes = BTreeMap::new();
        routes.insert("/bad.tar.gz".into(), b"corrupted".to_vec());
        let base = serve_once(routes).await;

        let update = AvailableUpdate {
            version: "0.2.0-nightly.20261121.3".into(),
            notes: None,
            url: format!("{base}/bad.tar.gz"),
            sha256: Some("0".repeat(64)),
            size: Some(9),
        };
        let temp = tempfile::tempdir().unwrap();
        let err = download(&update, temp.path(), |_| {}).await.unwrap_err();
        assert!(matches!(err, Error::Updater(_)));
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_installation_requires_self_contained_app_bundle() {
        let temp = tempfile::tempdir().unwrap();
        let macos_dir = temp.path().join("Maka.app/Contents/MacOS");
        std::fs::create_dir_all(&macos_dir).unwrap();
        let shell = macos_dir.join("maka-desktop-shell");
        std::fs::write(&shell, b"shell").unwrap();

        // Without bundled sibling `maka`, in-place update is refused.
        assert!(installation_for_executable(&shell).is_err());

        // With sibling `maka`, the whole Maka.app bundle is the installation root.
        std::fs::write(macos_dir.join("maka"), b"cli").unwrap();
        let install = installation_for_executable(&shell).unwrap();
        assert!(install.can_install());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stage_and_finish_replaces_directory_from_tar_gz_archive() {
        use flate2::{Compression, write::GzEncoder};
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let installed = temp.path().join("maka");
        std::fs::create_dir_all(&installed).unwrap();
        let exe = installed.join("maka-desktop-shell");
        std::fs::write(&exe, b"#!/bin/sh\necho old\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(installed.join("maka"), b"#!/bin/sh\necho old-cli\n").unwrap();
        std::fs::set_permissions(
            installed.join("maka"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        let archive_path = temp.path().join("maka-new.tar.gz");
        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let encoder = GzEncoder::new(file, Compression::default());
            let mut builder = tar::Builder::new(encoder);
            for (name, bytes) in [
                (
                    "maka/maka-desktop-shell",
                    b"#!/bin/sh\necho new\n".as_slice(),
                ),
                ("maka/maka", b"#!/bin/sh\necho new-cli\n".as_slice()),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, name, bytes).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap();
        }

        let install = Installation::directory(&installed, &exe).unwrap();
        let staged = stage(install, archive_path).await.unwrap();
        let replaced_exe = finish(staged).await.unwrap();
        assert_eq!(replaced_exe, exe);
        assert_eq!(std::fs::read(&exe).unwrap(), b"#!/bin/sh\necho new\n");
        assert_eq!(
            std::fs::read(installed.join("maka")).unwrap(),
            b"#!/bin/sh\necho new-cli\n"
        );
    }

    #[tokio::test]
    async fn wait_for_root_release_blocks_until_writer_lease_is_dropped() {
        let temp = tempfile::tempdir().unwrap();
        let root_path = temp.path().join("host-root");
        let namespaces = RootNamespaces::for_current_account().unwrap();
        let owner = RootOwner::create(&root_path, &namespaces).unwrap();

        // While the writer lease is held, a short wait must fail rather than claiming Host stopped.
        let err = wait_for_root_release(&root_path, Duration::from_millis(150))
            .await
            .unwrap_err();
        assert!(matches!(err, Error::HostStop(_)));

        // Releasing the lease allows wait_for_root_release to acquire and hold the lease.
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            drop(owner);
        });
        let lease = wait_for_root_release(&root_path, Duration::from_secs(3))
            .await
            .unwrap();
        releaser.join().unwrap();

        // While the updater holds RootLease, no candidate can acquire the Root.
        assert!(matches!(
            try_acquire_root_lease(&root_path).await.unwrap(),
            RootLeaseAttempt::Busy
        ));
        drop(lease);
        assert!(matches!(
            try_acquire_root_lease(&root_path).await.unwrap(),
            RootLeaseAttempt::Acquired(_)
        ));
        assert!(matches!(
            try_acquire_root_lease(&temp.path().join("missing-root"))
                .await
                .unwrap(),
            RootLeaseAttempt::Absent
        ));
    }

    #[test]
    fn remove_stale_leftovers_preserves_live_pid_stage_and_old_backups_and_deletes_dead_ones() {
        let temp = tempfile::tempdir().unwrap();
        let app_dir = temp.path().join("maka");
        std::fs::create_dir_all(&app_dir).unwrap();

        // Spawn a short-lived child so we have a real live PID distinct from our own PID.
        #[cfg(unix)]
        let mut child = Command::new("/bin/sleep").arg("10").spawn().unwrap();
        #[cfg(windows)]
        let mut child = Command::new("cmd")
            .args(["/C", "timeout /T 10 /NOBREAK > NUL"])
            .spawn()
            .unwrap();
        let live_pid = child.id();

        let live_stage = temp
            .path()
            .join(format!(".nsh-updater-staged-{live_pid}-maka"));
        let dead_stage = temp.path().join(".nsh-updater-staged-99999999-maka");
        let live_old_dir = temp
            .path()
            .join(format!(".nsh-updater-old-{live_pid}-maka"));
        let dead_old_dir = temp.path().join(".nsh-updater-old-99999999-maka");
        let live_old_file = app_dir.join(format!(".nsh-updater-old-{live_pid}-maka.exe"));
        let dead_old_file = app_dir.join(".nsh-updater-old-99999999-maka.exe");
        std::fs::create_dir_all(&live_stage).unwrap();
        std::fs::create_dir_all(&dead_stage).unwrap();
        std::fs::create_dir_all(&live_old_dir).unwrap();
        std::fs::create_dir_all(&dead_old_dir).unwrap();
        std::fs::write(&live_old_file, b"live-rollback").unwrap();
        std::fs::write(&dead_old_file, b"dead-leftover").unwrap();

        remove_stale_leftovers_for(&app_dir, Path::new("maka-desktop-shell"));

        let _ = child.kill();
        let _ = child.wait();

        assert!(
            live_stage.is_dir(),
            "live process staging directory must not be deleted"
        );
        assert!(
            !dead_stage.exists(),
            "dead process staging directory should be cleaned"
        );
        assert!(
            live_old_dir.is_dir(),
            "live process directory rollback backup must not be deleted"
        );
        assert!(
            !dead_old_dir.exists(),
            "dead process directory backup should be cleaned"
        );
        assert!(
            live_old_file.is_file(),
            "live process file rollback backup must not be deleted"
        );
        assert!(
            !dead_old_file.exists(),
            "dead process renamed binary leftover should be cleaned"
        );
    }

    #[tokio::test]
    async fn cancelled_download_removes_partial_file() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (hold_tx, hold_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let header = "HTTP/1.1 200 OK\r\nContent-Length: 262144\r\nConnection: close\r\n\r\n";
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&vec![0x5au8; 131_072]).await;
            let _ = socket.flush().await;
            let _ = hold_rx.await;
        });

        let dir = tempfile::tempdir().unwrap();
        let update = AvailableUpdate {
            version: "0.2.0-nightly.99".into(),
            notes: None,
            url: format!("http://{addr}/maka.tar.gz"),
            sha256: Some("0".repeat(64)),
            size: Some(262_144),
        };
        let (received_tx, received_rx) = tokio::sync::oneshot::channel::<()>();
        let mut received_tx = Some(received_tx);
        let download_dir = dir.path().to_path_buf();
        let task = tokio::spawn(async move {
            let _ = download(&update, &download_dir, |progress| {
                if progress.received >= 65_536
                    && let Some(tx) = received_tx.take()
                {
                    let _ = tx.send(());
                }
            })
            .await;
        });

        received_rx.await.unwrap();
        task.abort();
        let _ = task.await;
        let _ = hold_tx.send(());
        let _ = server.await;

        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            leftovers.is_empty(),
            "expected no .part leftovers after abort, found: {leftovers:?}"
        );
    }
}
