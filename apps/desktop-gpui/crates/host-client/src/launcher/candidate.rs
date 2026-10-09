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

//! Spawning one Host candidate process.
//!
//! Mirrors `launchDetachedRuntimeHostCandidate` and `spawnCandidate` in
//! `packages/runtime-host/src/client/launcher.ts`, the launch the TS CLI and
//! Maka Desktop use for a local root:
//!
//! - command: `<node> <entrypoint> --root <canonical root> --expected-root-id
//!   <rootId> --startup-attempt-id <uuid v4>`, then `--initial-connection-timeout-ms`,
//!   `--idle-grace-ms` and `--generation` when set, in that order (the
//!   options `parseInteractiveRuntimeHostCandidateArguments` in
//!   `packages/runtime-host/src/candidate-cli.ts` accepts; it rejects any
//!   other flag);
//! - working directory: the directory of the Node executable;
//! - environment: this process's, plus `MAKA_RUNTIME_HOST_STDERR_PIPE=1`
//!   (`RUNTIME_HOST_STDERR_PIPE_ENV` in `process-diagnostics.ts`), which makes
//!   the Host ignore a broken stderr pipe once its launcher is gone.
//!   `MAKA_HOSTED_INITIALIZATION` is set only by `connectOwnedRuntimeHost`
//!   for incognito hosted runtimes, which this client does not start;
//! - stdin and stdout discarded, stderr piped: the last 4 KiB are kept for
//!   the exit report (`CANDIDATE_STDERR_MAX_BYTES`);
//! - detached: the Host outlives the launcher. `closeOnLauncherExit` (an IPC
//!   guard that retires the Host when its launcher dies) is used by the TS
//!   CLI only for temporary `npx` installations, so it is not implemented.
//!
//! Node's `detached: true` makes the child a session leader (`setsid`). This
//! crate forbids `unsafe`, so the child gets its own process group instead
//! (`process_group(0)`): a Ctrl-C in the terminal that started the app does
//! not reach the Host, which is the property that matters here. On Windows
//! the child gets the creation flags libuv uses for a detached, hidden
//! spawn (see `WINDOWS_DETACHED_CREATION_FLAGS`); that path has not been run
//! on Windows yet, since preparing a State Root is not implemented there.
//!
//! The candidate is an ephemeral Host (`lifecycleMode: ephemeral`,
//! `startInteractiveRuntimeHostCandidate` in `server/candidate.ts`). It exits
//! on its own when no client connected within its initial connection
//! timeout, or when the last client has been gone for its idle grace
//! (`#armInitialConnectionDeadline` and `#scheduleIdleIfNeeded` in
//! `server/host-kernel.ts`; both default to 30 s, `DEFAULT_IDLE_GRACE_MS`).
//! A launcher therefore never stops the Host it started.

use std::ffi::{OsStr, OsString};
use std::io::{self, Read as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use async_lock::OnceCell;

/// Set in the candidate's environment (`RUNTIME_HOST_STDERR_PIPE_ENV`).
pub const STDERR_PIPE_ENV: &str = "MAKA_RUNTIME_HOST_STDERR_PIPE";

/// How much of the candidate's stderr is kept (`CANDIDATE_STDERR_MAX_BYTES`).
pub const CANDIDATE_STDERR_MAX_BYTES: usize = 4 * 1024;

/// What to spawn: the Node executable, the entry point, and the candidate
/// arguments.
#[derive(Debug, Clone)]
pub struct CandidateSpec {
    executable: PathBuf,
    entrypoint: PathBuf,
    root: PathBuf,
    root_id: String,
    initial_connection_timeout: Option<Duration>,
    idle_grace: Option<Duration>,
    generation: Option<String>,
    env_remove: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
}

impl CandidateSpec {
    /// A candidate for the prepared State Root `root` (its canonical path)
    /// with `root_id`, run as `<executable> <entrypoint> …`.
    pub fn new(
        executable: impl Into<PathBuf>,
        entrypoint: impl Into<PathBuf>,
        root: impl Into<PathBuf>,
        root_id: impl Into<String>,
    ) -> Self {
        Self {
            executable: executable.into(),
            entrypoint: entrypoint.into(),
            root: root.into(),
            root_id: root_id.into(),
            initial_connection_timeout: None,
            idle_grace: None,
            generation: None,
            env_remove: Vec::new(),
            env: Vec::new(),
        }
    }

    /// `--initial-connection-timeout-ms`: exit if no client connects within
    /// this long. The TS election passes the time left before its deadline.
    pub fn initial_connection_timeout(mut self, timeout: Duration) -> Self {
        self.initial_connection_timeout = Some(timeout);
        self
    }

    /// `--idle-grace-ms`: exit this long after the last client left.
    pub fn idle_grace(mut self, grace: Duration) -> Self {
        self.idle_grace = Some(grace);
        self
    }

    /// `--generation`.
    pub fn generation(mut self, generation: impl Into<String>) -> Self {
        self.generation = Some(generation.into());
        self
    }

    /// Removes `key` from the inherited environment.
    pub fn env_remove(mut self, key: impl Into<OsString>) -> Self {
        self.env_remove.push(key.into());
        self
    }

    /// Sets `key` in the candidate's environment.
    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// The arguments after the executable, for `startup_attempt_id`.
    pub fn arguments(&self, startup_attempt_id: &str) -> Vec<OsString> {
        let mut args: Vec<OsString> = vec![
            self.entrypoint.clone().into(),
            "--root".into(),
            self.root.clone().into(),
            "--expected-root-id".into(),
            self.root_id.clone().into(),
            "--startup-attempt-id".into(),
            startup_attempt_id.into(),
        ];
        let mut push = |key: &str, value: Option<String>| {
            if let Some(value) = value {
                args.push(key.into());
                args.push(value.into());
            }
        };
        push("--initial-connection-timeout-ms", self.initial_connection_timeout.map(millis));
        push("--idle-grace-ms", self.idle_grace.map(millis));
        push("--generation", self.generation.clone());
        args
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }
}

/// Whole milliseconds, rounded up the way `Math.ceil(remaining)` is.
fn millis(duration: Duration) -> String {
    let nanos = duration.as_nanos();
    nanos.div_ceil(1_000_000).to_string()
}

/// How a candidate process ended.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct CandidateExit {
    /// The exit code, or `None` when a signal ended it.
    pub code: Option<i32>,
    /// The signal that ended it, on Unix.
    pub signal: Option<i32>,
    /// The last [`CANDIDATE_STDERR_MAX_BYTES`] of its stderr.
    pub stderr: String,
    /// Whether earlier stderr output was dropped.
    pub stderr_truncated: bool,
}

/// A spawned candidate. Cheap to clone; every clone sees the same exit.
///
/// A dedicated thread drains the candidate's stderr for as long as this
/// process lives (a Host that writes to a full pipe could stall), then reaps
/// it and records how it ended. Dropping the handle does not stop the Host.
#[derive(Debug, Clone)]
pub struct CandidateProcess {
    pid: u32,
    startup_attempt_id: String,
    exit: Arc<OnceCell<CandidateExit>>,
}

impl CandidateProcess {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// The UUID passed as `--startup-attempt-id`; it names the startup
    /// diagnostic file of this attempt.
    pub fn startup_attempt_id(&self) -> &str {
        &self.startup_attempt_id
    }

    /// How it ended, if it has.
    pub fn try_exit(&self) -> Option<&CandidateExit> {
        self.exit.get()
    }

    /// Resolves once it has ended.
    pub async fn exited(&self) -> &CandidateExit {
        self.exit.wait().await
    }
}

/// The process creation flags libuv uses on Windows for Node's
/// `spawn(..., { detached: true, windowsHide: true })` with no inherited
/// stdio (`uv_spawn` in `src/win/process.c`): `DETACHED_PROCESS` (no
/// console) and `CREATE_NEW_PROCESS_GROUP` (no Ctrl-C from the launcher's
/// console), plus `CREATE_NO_WINDOW`, which Windows ignores next to
/// `DETACHED_PROCESS`. Values from `winbase.h`.
#[cfg(windows)]
const WINDOWS_DETACHED_CREATION_FLAGS: u32 = 0x0000_0008 | 0x0000_0200 | 0x0800_0000;

/// A new startup attempt id: a lowercase UUID v4 (`randomUUID()`), the
/// format `isCandidateStartupAttemptId` in `candidate-startup-failure.ts`
/// requires.
pub fn new_startup_attempt_id() -> String {
    uuid::Uuid::new_v4().hyphenated().to_string()
}

/// Spawns the candidate `spec` describes. Returns once the process exists;
/// whether it becomes the Host shows in the registration it writes.
///
/// Spawning is a short synchronous system call; call it from a background
/// task, not from `render`.
pub fn spawn_candidate(spec: &CandidateSpec) -> io::Result<CandidateProcess> {
    let startup_attempt_id = new_startup_attempt_id();
    let mut command = Command::new(&spec.executable);
    command
        .args(spec.arguments(&startup_attempt_id))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(directory) = spec.executable.parent().filter(|_| spec.executable.is_absolute()) {
        command.current_dir(directory);
    }
    for key in &spec.env_remove {
        command.env_remove(key);
    }
    command.env(STDERR_PIPE_ENV, "1");
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(WINDOWS_DETACHED_CREATION_FLAGS);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    let exit = Arc::new(OnceCell::new());
    let stderr = child.stderr.take();
    let recorder = exit.clone();
    std::thread::Builder::new().name(format!("maka-host-candidate-{pid}")).spawn(move || {
        let (stderr, stderr_truncated) = drain_tail(stderr);
        let _ = recorder.set_blocking(reap(child, stderr, stderr_truncated));
    })?;
    log::info!(
        "spawned Runtime Host candidate {pid}: {}",
        display_command(spec.executable.as_os_str(), &spec.arguments(&startup_attempt_id))
    );
    Ok(CandidateProcess { pid, startup_attempt_id, exit })
}

/// Reads `stderr` to its end, keeping the last bytes.
fn drain_tail(stderr: Option<std::process::ChildStderr>) -> (String, bool) {
    let Some(mut stderr) = stderr else {
        return (String::new(), false);
    };
    let mut tail: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut buffer = [0u8; 4096];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                tail.extend_from_slice(&buffer[..read]);
                if tail.len() > CANDIDATE_STDERR_MAX_BYTES {
                    tail.drain(..tail.len() - CANDIDATE_STDERR_MAX_BYTES);
                    truncated = true;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    (String::from_utf8_lossy(&tail).into_owned(), truncated)
}

/// Waits for `child` on the calling (dedicated) thread.
fn reap(mut child: Child, stderr: String, stderr_truncated: bool) -> CandidateExit {
    let (code, signal) = match child.wait() {
        Ok(status) => (status.code(), exit_signal(&status)),
        Err(error) => {
            log::warn!("could not wait for Runtime Host candidate {}: {error}", child.id());
            (None, None)
        }
    };
    CandidateExit { code, signal, stderr, stderr_truncated }
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt as _;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// A command line for logs, each argument quoted when it needs to be.
pub fn display_command(executable: &OsStr, args: &[OsString]) -> String {
    std::iter::once(executable)
        .chain(args.iter().map(OsString::as_os_str))
        .map(|arg| {
            let arg = arg.to_string_lossy();
            if !arg.is_empty()
                && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@".contains(c))
            {
                arg.into_owned()
            } else {
                format!("'{}'", arg.replace('\'', r"'\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_arguments_follow_the_candidate_cli() {
        let spec = CandidateSpec::new("/node", "/maka/entry.js", "/root", "ab".repeat(32))
            .initial_connection_timeout(Duration::from_micros(74_999_001))
            .idle_grace(Duration::from_secs(2))
            .generation("g1");
        let args: Vec<String> = spec
            .arguments("11111111-2222-4333-8444-555555555555")
            .into_iter()
            .map(|arg| arg.into_string().expect("utf-8"))
            .collect();
        assert_eq!(
            args,
            [
                "/maka/entry.js",
                "--root",
                "/root",
                "--expected-root-id",
                &"ab".repeat(32),
                "--startup-attempt-id",
                "11111111-2222-4333-8444-555555555555",
                "--initial-connection-timeout-ms",
                "75000",
                "--idle-grace-ms",
                "2000",
                "--generation",
                "g1",
            ]
        );
        let bare = CandidateSpec::new("/node", "/e.js", "/r", "id").arguments("a");
        assert_eq!(bare.len(), 7, "optional flags are left out");
    }

    #[test]
    fn startup_attempt_ids_are_lowercase_uuid_v4() {
        let id = new_startup_attempt_id();
        let bytes = id.as_bytes();
        assert_eq!(id.len(), 36);
        assert_eq!(bytes[14], b'4');
        assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'));
        assert!(id.chars().all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn commands_are_quoted_for_logs() {
        let args =
            vec![OsString::from("--root"), OsString::from("/tmp/a b"), OsString::from("it's")];
        assert_eq!(
            display_command(OsStr::new("/usr/bin/node"), &args),
            r"/usr/bin/node --root '/tmp/a b' 'it'\''s'"
        );
    }
}
