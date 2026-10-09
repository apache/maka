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

//! Connecting to the Host of a State Root, and starting one when none
//! answers.
//!
//! Mirrors `connectOrSpawnRuntimeHostWithDependencies` in
//! `packages/runtime-host/src/client/connect-or-spawn.ts`:
//!
//! 1. Prepare the State Root (create it and its marker if needed, see
//!    [`super::state_root`]).
//! 2. Until the election deadline (75 s, `DEFAULT_ELECTION_DEADLINE_MS`;
//!    [`ELECTION_DEADLINE_ENV`] overrides it, 1–120000 ms): read the
//!    registration and connect to it. A connection that completes the
//!    handshake wins.
//! 3. When nothing answered (no registration, a stale one, a refused or
//!    stalled connection, a draining Host) and no candidate of this call is
//!    still running, spawn a candidate, at most one every 250 ms
//!    (`MIN_CANDIDATE_INTERVAL_MS`). Two launchers racing is safe: a
//!    candidate that cannot take the State Root's owner lock exits with 2
//!    and never registers.
//! 4. Between polls wait 20 ms, doubling to 250 ms, with ±25% jitter
//!    (`DEFAULT_BACKOFF_MIN_MS`, `DEFAULT_BACKOFF_MAX_MS`).
//! 5. A candidate exit code that names a permanent startup failure ends the
//!    election with that failure and the candidate's startup diagnostic; a
//!    transient one (`internal_startup_failure`, `local_ipc_security_failed`)
//!    is retried with a new candidate and reported only if the deadline
//!    passes. Otherwise the deadline yields `startup_timeout`, or
//!    `host_unresponsive` when an endpoint accepted the socket but never
//!    completed the handshake.
//! 6. The startup diagnostic files are tidied as in TS (see
//!    [`super::startup`]): the reported one is kept as
//!    `startup-diagnostic.json`, one no longer reported is deleted, and a
//!    connection deletes the recorded failure's file and
//!    `startup-diagnostic.json` (`retireCandidateStartupDiagnostic`).
//!
//! Each poll gets 2.5 s for the socket and the handshake together
//! (`DEFAULT_CONNECT_TIMEOUT_MS` 500 plus `DEFAULT_HANDSHAKE_TIMEOUT_MS` 2000 in
//! `client/connection.ts`).
//!
//! Differences from the TS election, all deliberate:
//!
//! - It returns once the handshake completes. The TS election also waits,
//!   within the same deadline, for `host.status` to report `ready`
//!   (`waitForRuntimeHostReady` in `client/wait-for-ready.ts`, polling every
//!   25 ms); here the caller does that, as the supervisor does for every
//!   connection ([`crate::Connection::wait_until_ready`]).
//! - It does not pre-check a managed deployment or the root's composition
//!   binding. A candidate refuses a managed root itself (exit 80,
//!   `managed_root_requires_operator`), which ends the election the same way.
//! - A missing Node or entry point, or a spawn refused with `ENOENT` or
//!   `EACCES`, fails at once instead of being retried until the deadline.
//! - Every `incompatible` answer ends the election. The TS election ends
//!   only on `blocked_by_residency` and, on `wait_for_idle_exit`, keeps
//!   polling until that Host idles out and a candidate can replace it. Here
//!   the window says at once which epochs differ and what to update
//!   ([`crate::HostBlocker`]); a candidate from the same checkout would
//!   usually be refused the same way, after up to the whole deadline.
//! - A failed handshake with a Host whose registration names another
//!   compatibility epoch ends it too
//!   ([`ConnectError::RegisteredEpochMismatch`]), instead of being retried
//!   until the deadline.

use std::ffi::OsString;
use std::fmt;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use async_io::Timer;
use host_protocol::{ClientHello, HostLifecycleState, HostRegistration};
use thiserror::Error;

use super::candidate::{CandidateProcess, CandidateSpec, spawn_candidate};
use super::installation::{InstallationError, MakaInstallation, NodeError, NodeRuntime};
use super::startup::{
    StartupDiagnostic, StartupFailureReason, clear_startup_diagnostic, read_startup_diagnostic,
    select_startup_diagnostic,
};
use super::state_root::{PreparedRoot, StateRootError, prepare_state_root};
use crate::discovery::{control_namespace, discover_registration};
use crate::{AttemptReporter, ConnectError, Connected, DiscoveryError};
#[cfg(any(unix, windows))]
use crate::{ConnectOptions, Connection};

/// Overrides the election deadline, in milliseconds
/// (`ELECTION_DEADLINE_MS_ENV_VAR`).
pub const ELECTION_DEADLINE_ENV: &str = "MAKA_RUNTIME_HOST_ELECTION_DEADLINE_MS";

/// Sets `--idle-grace-ms` for spawned candidates (`IDLE_GRACE_MS_ENV_VAR`).
pub const IDLE_GRACE_ENV: &str = "MAKA_RUNTIME_HOST_IDLE_GRACE_MS";

const DEFAULT_ELECTION_DEADLINE: Duration = Duration::from_millis(75_000);
const BACKOFF_MIN: Duration = Duration::from_millis(20);
const BACKOFF_MAX: Duration = Duration::from_millis(250);
const MIN_CANDIDATE_INTERVAL: Duration = Duration::from_millis(250);
const POLL_CONNECT_TIMEOUT: Duration = Duration::from_millis(2_500);
/// The largest duration any of these settings accepts
/// (`requireOptionalTimeout`).
const MAX_SETTING_MS: u64 = 120_000;

/// How [`connect_or_spawn`] starts a Host. [`Default`] follows the TS
/// launcher: deadline and idle grace from the environment or their defaults,
/// Node and the installation discovered when a candidate is needed.
#[derive(Debug, Clone, Default)]
pub struct LaunchOptions {
    election_deadline: Option<Duration>,
    idle_grace: Option<Duration>,
    generation: Option<String>,
    installation: Option<MakaInstallation>,
    node: Option<NodeRuntime>,
    env_remove: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
    control_namespace: Option<PathBuf>,
}

impl LaunchOptions {
    /// Replaces the election deadline (1 ms to 120 s).
    pub fn election_deadline(mut self, deadline: Duration) -> Self {
        self.election_deadline = Some(deadline);
        self
    }

    /// `--idle-grace-ms` for spawned candidates (0 to 120 s). Without it the
    /// Host's default applies (30 s).
    pub fn idle_grace(mut self, grace: Duration) -> Self {
        self.idle_grace = Some(grace);
        self
    }

    /// `--generation` for spawned candidates.
    pub fn generation(mut self, generation: impl Into<String>) -> Self {
        self.generation = Some(generation.into());
        self
    }

    /// Launches from `installation` instead of discovering one.
    pub fn installation(mut self, installation: MakaInstallation) -> Self {
        self.installation = Some(installation);
        self
    }

    /// Runs candidates with `node` instead of discovering it.
    pub fn node(mut self, node: NodeRuntime) -> Self {
        self.node = Some(node);
        self
    }

    /// Removes `key` from the environment candidates inherit.
    pub fn env_remove(mut self, key: impl Into<OsString>) -> Self {
        self.env_remove.push(key.into());
        self
    }

    /// Sets `key` in the candidates' environment.
    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// Looks for registrations under `namespace` instead of the platform
    /// control namespace. Only fake candidates write there.
    #[cfg(all(test, unix))]
    pub(crate) fn control_namespace(mut self, namespace: impl Into<PathBuf>) -> Self {
        self.control_namespace = Some(namespace.into());
        self
    }
}

/// Told about progress inside [`connect_or_spawn`].
pub trait LaunchObserver: Send + Sync {
    /// A candidate was spawned; the election now waits for it to register.
    fn candidate_spawned(&self, candidate: &CandidateProcess) -> impl Future<Output = ()> + Send;
}

impl LaunchObserver for () {
    async fn candidate_spawned(&self, _: &CandidateProcess) {}
}

impl LaunchObserver for AttemptReporter {
    async fn candidate_spawned(&self, candidate: &CandidateProcess) {
        self.host_starting(candidate.pid()).await;
    }
}

/// A handshaken connection to the Host of a State Root.
#[derive(Debug)]
#[non_exhaustive]
pub struct Launched {
    /// Not necessarily ready yet: wait with
    /// [`crate::Connection::wait_until_ready`] while driving the pump.
    pub connected: Connected,
    pub root: PreparedRoot,
    /// The registration the connection was opened from.
    pub registration: HostRegistration,
    /// The candidate this call spawned, when it became the Host reached.
    pub spawned: Option<CandidateProcess>,
}

/// Why [`connect_or_spawn`] did not reach a Host.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum LaunchError {
    /// An override in the environment is not a valid duration; the TS
    /// launcher fails closed on these too (`durationMsFromEnvironment`).
    #[error(
        "{variable}={value:?} must be an integer number of milliseconds from {minimum} to {MAX_SETTING_MS}"
    )]
    Environment { variable: &'static str, value: String, minimum: u64 },
    #[error(transparent)]
    StateRoot(#[from] StateRootError),
    #[error(transparent)]
    Installation(#[from] InstallationError),
    #[error(transparent)]
    Node(#[from] NodeError),
    /// The operating system refused to start the candidate.
    #[error("cannot start {}", executable.display())]
    Spawn {
        executable: PathBuf,
        #[source]
        source: io::Error,
    },
    /// The control namespace is unusable (no home directory).
    #[error(transparent)]
    Discovery(DiscoveryError),
    /// A Host answered but cannot serve this client (incompatible protocol,
    /// epoch, composition, or State Root).
    #[error(transparent)]
    Connect(ConnectError),
    /// A candidate exited with a startup failure.
    #[error("{}", startup_text(*.reason, .diagnostic.as_deref(), .stderr))]
    Startup {
        reason: StartupFailureReason,
        pid: u32,
        startup_attempt_id: String,
        /// What the candidate wrote to its startup diagnostic file.
        diagnostic: Option<Box<StartupDiagnostic>>,
        /// The end of the candidate's stderr.
        stderr: String,
    },
    /// The deadline passed without a Host that completed the handshake.
    #[error("{}", timeout_text(.diagnostic))]
    Timeout { diagnostic: Box<ElectionDiagnostic> },
}

impl LaunchError {
    /// Whether another attempt cannot help without a person changing
    /// something.
    pub fn is_permanent(&self) -> bool {
        match self {
            Self::Environment { .. }
            | Self::StateRoot(_)
            | Self::Installation(_)
            | Self::Node(_)
            | Self::Spawn { .. } => true,
            Self::Discovery(error) => matches!(error, DiscoveryError::NoHomeDirectory),
            Self::Connect(error) => error.is_permanent(),
            Self::Startup { reason, .. } => reason.is_permanent(),
            Self::Timeout { .. } => false,
        }
    }
}

fn startup_text(
    reason: StartupFailureReason,
    diagnostic: Option<&StartupDiagnostic>,
    stderr: &str,
) -> String {
    let mut text = reason.message().to_owned();
    let details = diagnostic.map(StartupDiagnostic::error_text).filter(|text| !text.is_empty());
    match details {
        Some(details) => text.push_str(&format!(" Details: {details}")),
        None => {
            if let Some(tail) = stderr_tail(stderr) {
                text.push_str(&format!(" Host output: {tail}"));
            }
        }
    }
    text
}

/// The last few non-empty lines of `stderr`, joined.
fn stderr_tail(stderr: &str) -> Option<String> {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let start = lines.len().saturating_sub(3);
    let tail = lines[start..].join(" / ");
    (!tail.is_empty()).then_some(tail)
}

fn timeout_text(diagnostic: &ElectionDiagnostic) -> String {
    let seconds = diagnostic.deadline.as_secs_f64();
    if diagnostic.saw_endpoint_connected {
        format!(
            "A Runtime Host was found but did not become ready within {seconds:.0} s ({diagnostic}). \
             It may still be opening this State Root; retry once it settles, or set \
             {ELECTION_DEADLINE_ENV} to allow more time."
        )
    } else {
        format!(
            "Could not connect to a Runtime Host within {seconds:.0} s ({diagnostic}). Retry; the \
             Host may still be starting. If startup needs longer, set {ELECTION_DEADLINE_ENV} to \
             allow more time."
        )
    }
}

/// What an election that timed out saw (`RuntimeHostElectionDiagnostic`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ElectionDiagnostic {
    pub deadline: Duration,
    pub elapsed: Duration,
    pub candidate_launches: u32,
    pub saw_endpoint_connected: bool,
    pub not_registered: u32,
    pub connect_failed: u32,
    pub handshake_failed: u32,
    /// The last poll's failure, as text.
    pub last_failure: Option<String>,
    /// `pid` and `state` of the last registration read.
    pub last_registration: Option<(u32, HostLifecycleState)>,
    /// The last candidate: pid, and its exit code or signal once it ended.
    pub latest_candidate: Option<CandidateSummary>,
}

/// The last candidate of an election.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct CandidateSummary {
    pub pid: u32,
    pub startup_attempt_id: String,
    /// `None` while it runs.
    pub exit_code: Option<Option<i32>>,
    pub stderr: String,
}

impl fmt::Display for ElectionDiagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let launches = self.candidate_launches;
        write!(f, "{launches} Host start{}", if launches == 1 { "" } else { "s" })?;
        if let Some(candidate) = &self.latest_candidate {
            match candidate.exit_code {
                None => write!(f, ", pid {} still running", candidate.pid)?,
                Some(Some(code)) => write!(f, ", pid {} exited with code {code}", candidate.pid)?,
                Some(None) => write!(f, ", pid {} ended by a signal", candidate.pid)?,
            }
            if candidate.exit_code.is_some()
                && let Some(tail) = stderr_tail(&candidate.stderr)
            {
                write!(f, ": {tail}")?;
            }
        }
        if let Some(failure) = &self.last_failure {
            write!(f, "; last attempt: {failure}")?;
        }
        Ok(())
    }
}

/// Reads a millisecond duration override from `variable`: `None` when unset
/// or blank, an error when it is not an integer from `minimum` to 120000.
pub(crate) fn duration_from_env(
    variable: &'static str,
    value: Option<OsString>,
    minimum: u64,
) -> Result<Option<Duration>, LaunchError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let text = value.to_string_lossy();
    if text.trim().is_empty() {
        return Ok(None);
    }
    let invalid = || LaunchError::Environment { variable, value: text.to_string(), minimum };
    let millis: u64 = text.trim().parse().map_err(|_| invalid())?;
    if !(minimum..=MAX_SETTING_MS).contains(&millis) {
        return Err(invalid());
    }
    Ok(Some(Duration::from_millis(millis)))
}

fn check_setting(
    variable: &'static str,
    value: Duration,
    minimum: u64,
) -> Result<Duration, LaunchError> {
    let millis = value.as_millis();
    if millis < u128::from(minimum) || millis > u128::from(MAX_SETTING_MS) {
        return Err(LaunchError::Environment { variable, value: format!("{millis}"), minimum });
    }
    Ok(value)
}

/// One failed poll, classified the way the TS election counts results.
#[cfg_attr(not(unix), allow(dead_code))]
enum Unavailable {
    NotRegistered,
    ConnectFailed(String),
    /// The endpoint accepted the socket; the handshake did not complete.
    HandshakeFailed(String),
}

/// Connects to the Host registered for the State Root at `root`, spawning a
/// candidate when none answers (see the module docs). `observer` hears about
/// each spawned candidate while the election waits for it.
pub async fn connect_or_spawn(
    root: &Path,
    hello: ClientHello,
    options: &LaunchOptions,
    observer: &impl LaunchObserver,
) -> Result<Launched, LaunchError> {
    let deadline_budget = match options.election_deadline {
        Some(deadline) => check_setting("election deadline", deadline, 1)?,
        None => {
            duration_from_env(ELECTION_DEADLINE_ENV, std::env::var_os(ELECTION_DEADLINE_ENV), 1)?
                .unwrap_or(DEFAULT_ELECTION_DEADLINE)
        }
    };
    let idle_grace = match options.idle_grace {
        Some(grace) => Some(check_setting("idle grace", grace, 0)?),
        None => duration_from_env(IDLE_GRACE_ENV, std::env::var_os(IDLE_GRACE_ENV), 0)?,
    };
    let root = prepare_state_root(root).await?;
    let namespace = match &options.control_namespace {
        Some(namespace) => namespace.clone(),
        None => control_namespace().map_err(LaunchError::Discovery)?,
    };
    let control_directory = namespace.join(&root.root_id);

    // Root preparation settles before the deadline starts, as in TS.
    let started = Instant::now();
    let deadline = started + deadline_budget;
    let mut backoff = BACKOFF_MIN;
    let mut next_candidate_at = started;
    let mut launcher: Option<(NodeRuntime, MakaInstallation)> = None;
    let mut candidate: Option<CandidateProcess> = None;
    let mut candidate_running = false;
    let mut startup_failure: Option<CandidateProcess> = None;
    let mut diagnostic = ElectionDiagnostic { deadline: deadline_budget, ..Default::default() };

    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let budget = POLL_CONNECT_TIMEOUT.min(deadline - now);
        match poll(&control_directory, &root.root_id, hello.clone(), budget).await {
            Ok((connected, registration)) => {
                retire_startup_diagnostics(
                    &control_directory,
                    startup_failure.as_ref(),
                    candidate.as_ref().filter(|candidate| candidate.pid() != registration.pid),
                )
                .await;
                let spawned = candidate.filter(|candidate| candidate.pid() == registration.pid);
                return Ok(Launched { connected, root, registration, spawned });
            }
            Err(PollError::Permanent(error)) => return Err(LaunchError::Connect(error)),
            Err(PollError::Unavailable { reason, registration }) => {
                if registration.is_some() {
                    diagnostic.last_registration = registration;
                }
                match reason {
                    Unavailable::NotRegistered => {
                        diagnostic.not_registered += 1;
                        diagnostic.last_failure = Some("no Runtime Host is registered".to_owned());
                    }
                    Unavailable::ConnectFailed(text) => {
                        diagnostic.connect_failed += 1;
                        diagnostic.last_failure = Some(text);
                    }
                    Unavailable::HandshakeFailed(text) => {
                        diagnostic.handshake_failed += 1;
                        diagnostic.saw_endpoint_connected = true;
                        diagnostic.last_failure = Some(text);
                    }
                }
            }
        }

        // A candidate that ended since the last poll: remember a startup
        // failure, preferring a permanent one (as the TS election does).
        if candidate_running
            && let Some(current) = &candidate
            && let Some(exit) = current.try_exit()
        {
            candidate_running = false;
            let reason = exit.code.and_then(StartupFailureReason::from_exit_code);
            if let Some(reason) = reason {
                let replace = match &startup_failure {
                    None => true,
                    Some(previous) => {
                        !failure_reason(previous).is_some_and(StartupFailureReason::is_permanent)
                            && reason.is_permanent()
                    }
                };
                // The failure the election no longer reports loses its file.
                let obsolete = if replace {
                    startup_failure.replace(current.clone())
                } else {
                    Some(current.clone())
                };
                if let Some(obsolete) = obsolete {
                    clear_startup_diagnostic(
                        &control_directory,
                        Some(obsolete.startup_attempt_id()),
                    )
                    .await;
                }
            }
            if let Some(failure) = &startup_failure
                && failure_reason(failure).is_some_and(StartupFailureReason::is_permanent)
            {
                return Err(startup_error(failure, &control_directory, &root.root_id).await);
            }
        }

        let now = Instant::now();
        if !candidate_running && now >= next_candidate_at && now < deadline {
            if launcher.is_none() {
                launcher = Some(resolve_launcher(options).await?);
            }
            let (node, installation) = launcher.as_ref().expect("resolved just above");
            let mut spec = CandidateSpec::new(
                node.path(),
                installation.entrypoint(),
                &root.canonical_path,
                &root.root_id,
            )
            .initial_connection_timeout(deadline - now);
            if let Some(grace) = idle_grace {
                spec = spec.idle_grace(grace);
            }
            if let Some(generation) = &options.generation {
                spec = spec.generation(generation.clone());
            }
            for key in &options.env_remove {
                spec = spec.env_remove(key.clone());
            }
            for (key, value) in &options.env {
                spec = spec.env(key.clone(), value.clone());
            }
            let spawn_spec = spec.clone();
            match blocking::unblock(move || spawn_candidate(&spawn_spec)).await {
                Ok(spawned) => {
                    diagnostic.candidate_launches += 1;
                    observer.candidate_spawned(&spawned).await;
                    candidate = Some(spawned);
                    candidate_running = true;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                    ) =>
                {
                    return Err(LaunchError::Spawn {
                        executable: spec.executable().to_owned(),
                        source: error,
                    });
                }
                Err(error) => {
                    log::warn!("could not spawn a Runtime Host candidate: {error}");
                    diagnostic.last_failure = Some(format!("spawning a candidate failed: {error}"));
                }
            }
            next_candidate_at = now + MIN_CANDIDATE_INTERVAL;
        }

        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let jitter = 0.75 + fastrand::f64() * 0.5;
        let pause = backoff.mul_f64(jitter).max(Duration::from_millis(1)).min(deadline - now);
        Timer::after(pause).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }

    if let Some(failure) = &startup_failure {
        return Err(startup_error(failure, &control_directory, &root.root_id).await);
    }
    diagnostic.elapsed = started.elapsed();
    diagnostic.latest_candidate = candidate.map(|candidate| {
        let exit = candidate.try_exit();
        CandidateSummary {
            pid: candidate.pid(),
            startup_attempt_id: candidate.startup_attempt_id().to_owned(),
            exit_code: exit.map(|exit| exit.code),
            stderr: exit.map(|exit| exit.stderr.clone()).unwrap_or_default(),
        }
    });
    Err(LaunchError::Timeout { diagnostic: Box::new(diagnostic) })
}

fn failure_reason(candidate: &CandidateProcess) -> Option<StartupFailureReason> {
    candidate.try_exit()?.code.and_then(StartupFailureReason::from_exit_code)
}

/// A connection won: deletes the diagnostic of the failure the election
/// recorded, of a candidate that failed without being observed (`loser`,
/// the latest candidate when it is not the Host that answered), and the one
/// an earlier election kept (`retireCandidateStartupDiagnostic`).
async fn retire_startup_diagnostics(
    control_directory: &Path,
    recorded: Option<&CandidateProcess>,
    loser: Option<&CandidateProcess>,
) {
    clear_startup_diagnostic(control_directory, None).await;
    if let Some(failure) = recorded {
        clear_startup_diagnostic(control_directory, Some(failure.startup_attempt_id())).await;
    }
    if let Some(candidate) = loser.filter(|candidate| failure_reason(candidate).is_some()) {
        clear_startup_diagnostic(control_directory, Some(candidate.startup_attempt_id())).await;
    }
}

/// The error for the startup failure of `candidate`, with its diagnostic,
/// which is then kept as `startup-diagnostic.json`.
async fn startup_error(
    candidate: &CandidateProcess,
    control_directory: &Path,
    root_id: &str,
) -> LaunchError {
    let exit = candidate.try_exit();
    let reason = failure_reason(candidate).unwrap_or(StartupFailureReason::InternalStartupFailure);
    let diagnostic =
        read_startup_diagnostic(control_directory, root_id, candidate.startup_attempt_id()).await;
    select_startup_diagnostic(control_directory, candidate.startup_attempt_id()).await;
    LaunchError::Startup {
        reason,
        pid: candidate.pid(),
        startup_attempt_id: candidate.startup_attempt_id().to_owned(),
        diagnostic: diagnostic.map(Box::new),
        stderr: exit.map(|exit| exit.stderr.clone()).unwrap_or_default(),
    }
}

/// The Node runtime and the installation from `options`, or discovered. The
/// entry point and the executable must exist.
async fn resolve_launcher(
    options: &LaunchOptions,
) -> Result<(NodeRuntime, MakaInstallation), LaunchError> {
    let installation = match &options.installation {
        Some(installation) => {
            if !async_fs::metadata(installation.entrypoint()).await.is_ok_and(|m| m.is_file()) {
                return Err(LaunchError::Spawn {
                    executable: installation.entrypoint().to_owned(),
                    source: io::Error::new(
                        io::ErrorKind::NotFound,
                        "the entry point does not exist",
                    ),
                });
            }
            installation.clone()
        }
        None => MakaInstallation::discover().await?,
    };
    let node = match &options.node {
        Some(node) => node.clone(),
        None => NodeRuntime::discover().await?,
    };
    log::info!(
        "starting Runtime Hosts with {} ({:?}{}) from {}",
        node.path().display(),
        node.source(),
        node.version().map(|version| format!(", {version}")).unwrap_or_default(),
        installation.entrypoint().display()
    );
    Ok((node, installation))
}

#[cfg_attr(not(unix), allow(dead_code))]
enum PollError {
    /// A Host is there and will not serve this client.
    Permanent(ConnectError),
    /// `registration` is the `pid` and `state` of the registration read.
    Unavailable { reason: Unavailable, registration: Option<(u32, HostLifecycleState)> },
}

/// Reads the registration in `control_directory` and connects to it
/// (`connectResolvedRuntimeHost`).
async fn poll(
    control_directory: &Path,
    root_id: &str,
    hello: ClientHello,
    budget: Duration,
) -> Result<(Connected, HostRegistration), PollError> {
    let registration = match discover_registration(control_directory).await {
        Ok(registration) => registration,
        Err(DiscoveryError::NotRegistered(_)) => {
            return Err(PollError::Unavailable {
                reason: Unavailable::NotRegistered,
                registration: None,
            });
        }
        Err(error) => {
            return Err(PollError::Unavailable {
                reason: Unavailable::ConnectFailed(crate::error_chain(&error).to_string()),
                registration: None,
            });
        }
    };
    if registration.root_id != root_id {
        return Err(PollError::Unavailable {
            reason: Unavailable::ConnectFailed(format!(
                "the registration names State Root {}",
                registration.root_id
            )),
            registration: Some((registration.pid, registration.state)),
        });
    }
    #[cfg(any(unix, windows))]
    {
        let options = ConnectOptions::default()
            .with_timeout(budget)
            .with_expected_root_id(root_id)
            .with_expected_host_epoch(registration.host_epoch.clone());
        let connected = Connection::connect(&registration.endpoint, hello, options)
            .await
            .map_err(|error| error.against_registration(&registration));
        match connected {
            Ok(connected) => Ok((connected, registration)),
            Err(error) if error.is_permanent() => Err(PollError::Permanent(error)),
            Err(error) => {
                let text = crate::error_chain(&error).to_string();
                let reason = match error {
                    ConnectError::Io(_) | ConnectError::Endpoint(_) => {
                        Unavailable::ConnectFailed(text)
                    }
                    _ => Unavailable::HandshakeFailed(text),
                };
                Err(PollError::Unavailable {
                    reason,
                    registration: Some((registration.pid, registration.state)),
                })
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (hello, budget);
        Err(PollError::Unavailable {
            reason: Unavailable::ConnectFailed(
                "local Runtime Host connections are not supported on this platform yet".to_owned(),
            ),
            registration: Some((registration.pid, registration.state)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_overrides_fail_closed() {
        let parse = |value: &str, minimum| {
            duration_from_env(ELECTION_DEADLINE_ENV, Some(value.into()), minimum)
        };
        assert_eq!(duration_from_env(ELECTION_DEADLINE_ENV, None, 1).expect("unset"), None);
        assert_eq!(parse("  ", 1).expect("blank"), None);
        assert_eq!(parse("90000", 1).expect("valid"), Some(Duration::from_secs(90)));
        assert_eq!(parse("0", 0).expect("zero idle grace"), Some(Duration::ZERO));
        for bad in ["0", "120001", "1.5", "-3", "soon"] {
            let error = parse(bad, 1).expect_err(bad);
            assert!(error.is_permanent());
            assert!(error.to_string().contains(ELECTION_DEADLINE_ENV), "{error}");
        }
    }

    #[test]
    fn a_timeout_explains_what_the_election_saw() {
        let diagnostic = ElectionDiagnostic {
            deadline: Duration::from_secs(75),
            candidate_launches: 1,
            latest_candidate: Some(CandidateSummary {
                pid: 7,
                startup_attempt_id: "a".to_owned(),
                exit_code: Some(Some(1)),
                stderr: "\nline one\n\nSyntaxError: bad\n".to_owned(),
            }),
            last_failure: Some("no Runtime Host is registered".to_owned()),
            ..Default::default()
        };
        let error = LaunchError::Timeout { diagnostic: Box::new(diagnostic) };
        assert!(!error.is_permanent());
        assert_eq!(
            error.to_string(),
            "Could not connect to a Runtime Host within 75 s (1 Host start, pid 7 exited with code \
             1: line one / SyntaxError: bad; last attempt: no Runtime Host is registered). Retry; \
             the Host may still be starting. If startup needs longer, set \
             MAKA_RUNTIME_HOST_ELECTION_DEADLINE_MS to allow more time."
        );
    }
}
