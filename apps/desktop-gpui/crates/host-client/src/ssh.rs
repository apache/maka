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

//! Remote Hosts behind SSH: a `-L` forward through the system `ssh`, and the
//! operator activation that starts a managed Host over SSH before the
//! forward.
//!
//! Mirrors `openRuntimeHostSshTunnel` in
//! `packages/runtime-host/src/client/ssh-tunnel.ts` and
//! `activateRuntimeHostSshOperator` / `runtimeHostSshOperatorRemoteCommand`
//! in `client/ssh-operator-activation.ts`, in batch mode only: `ssh` runs
//! with `BatchMode=yes` and no terminal, so it never asks about a host key or
//! for a password. When it fails, the log it wrote says why, and
//! [`SshFailure`] names the cause.
//!
//! The tunnel: `ssh -v -E <log> -N -T -o ExitOnForwardFailure=yes …
//! -L 127.0.0.1:<free port>:127.0.0.1:<remote port> [-p N] <destination>`.
//! It is ready when the log says `Local forwarding listening on 127.0.0.1
//! port <free port>.`; a port another process took in the meantime is
//! retried with a new one, three times in all. The destination's OpenSSH
//! configuration must not add forwards of its own (`ssh -G`).
//!
//! Differences from Desktop: `ssh` is stopped with SIGKILL (Windows:
//! `TerminateProcess`), not SIGTERM first, because a safe SIGTERM needs a
//! crate this client does not otherwise use; OpenSSH then cannot tell a
//! `ProxyCommand` to exit, which sees its pipes close instead. On Windows
//! only `ssh` itself is ended, not its process tree (`taskkill /t`).

use std::ffi::OsStr;
use std::io;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, Instant};

use async_io::Timer;
use async_process::{Child, Command};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures_lite::{AsyncRead, AsyncReadExt as _, future};
use host_protocol::{
    ACTIVATION_FRAME_MAX_BYTES, ActivationFrame, ActivationResult, OperatorCommand,
    OperatorPlatform, RemoteHostUrl, decode_activation_frame,
};
use serde::Serialize;
use thiserror::Error;

use crate::connection::until;

/// `SSH_BATCH_START_TIMEOUT_MS`: how long the forward may take to come up,
/// and the `ConnectTimeout` it implies.
const SSH_START_TIMEOUT: Duration = Duration::from_secs(15);

/// `SSH_LOCAL_BIND_ATTEMPTS`.
const SSH_LOCAL_BIND_ATTEMPTS: u32 = 3;

/// How often the forward's log is read while waiting for it.
const READINESS_POLL: Duration = Duration::from_millis(50);

/// `SSH_STOP_TIMEOUT_MS`: how long closing waits for `ssh` to exit.
const SSH_STOP_TIMEOUT: Duration = Duration::from_secs(2);

/// `DEFAULT_TIMEOUT_MS` in `ssh-operator-activation.ts`.
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(120);

/// The activation output limit: one frame and its prefix, with slack.
const ACTIVATION_OUTPUT_MAX_BYTES: usize = ACTIVATION_FRAME_MAX_BYTES + 256;

/// How much of the activation's stderr is kept to explain an SSH failure.
const STDERR_TAIL_MAX_BYTES: usize = 16 * 1024;

/// `ssh` exits with 255 when ssh itself fails, as opposed to the remote
/// command (`ssh(1)`, EXIT STATUS).
const SSH_FAILURE_EXIT_CODE: i32 = 255;

/// Why `ssh` could not connect, read from what it logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SshFailure {
    /// The host key is not in `known_hosts`, or it changed. Batch mode
    /// cannot ask whether to trust it.
    HostKeyNotVerified,
    /// No key, agent identity, or other non-interactive method was accepted.
    /// Batch mode cannot ask for a password or passphrase.
    AuthenticationFailed,
    /// The host name does not resolve.
    UnknownHost,
    /// The host did not accept a connection on the SSH port.
    Unreachable,
    /// Nothing in the log says.
    Unknown,
}

impl std::fmt::Display for SshFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::HostKeyNotVerified => {
                "the host key is not known or has changed, and batch mode cannot ask; \
                 verify it by connecting once with ssh in a terminal"
            }
            Self::AuthenticationFailed => {
                "no key or agent identity was accepted, and batch mode cannot ask for a \
                 password; set up key or agent authentication"
            }
            Self::UnknownHost => "the host name does not resolve",
            Self::Unreachable => "the host did not accept the SSH connection",
            Self::Unknown => {
                "configure OpenSSH host verification and key or agent authentication; \
                 this client runs ssh in batch mode"
            }
        })
    }
}

/// Why an SSH transport could not be set up.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum SshError {
    /// The `ssh` executable could not be started (for example, not on
    /// `PATH`).
    #[error("could not run {program}")]
    Spawn {
        program: String,
        #[source]
        source: io::Error,
    },
    /// A local file operation for the tunnel failed.
    #[error("could not prepare the SSH tunnel")]
    Io(#[source] io::Error),
    /// `ssh -G` failed, so the configuration could not be checked.
    #[error("could not inspect the OpenSSH configuration for {destination} ({outcome})")]
    Configuration { destination: String, outcome: String },
    /// The destination's configuration adds `LocalForward`, `RemoteForward`,
    /// or `DynamicForward`, which the tunnel would open too.
    #[error(
        "the OpenSSH configuration for {destination} configures additional port forwarding; \
         remove that forwarding or use a dedicated SSH Host entry"
    )]
    ForwardingConfigured { destination: String },
    /// `ssh` exited or did not set the forward up in time.
    #[error("SSH to {destination} did not become ready ({outcome}): {failure}")]
    Failed { destination: String, outcome: String, failure: SshFailure },
    /// Every attempt lost its local port to another process.
    #[error("SSH could not bind the local forwarding port")]
    LocalBindConflict,
    /// The operator ran but did not report an activated Host.
    #[error(transparent)]
    Activation(#[from] ActivationError),
}

/// Why an operator activation did not produce an endpoint
/// (`RuntimeHostSshOperatorActivationError`).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum ActivationError {
    #[error("Runtime Host SSH operator returned too much output")]
    TooMuchOutput,
    #[error("Runtime Host SSH operator returned multiple or malformed frames")]
    Malformed,
    #[error("Runtime Host SSH activation timed out")]
    TimedOut,
    #[error("Runtime Host SSH activation was terminated")]
    Terminated,
    #[error("Runtime Host SSH activation exited with code {0}")]
    Exited(i32),
    /// The operator's error frame.
    #[error("{message}")]
    Refused { code: String, message: String },
    /// A result frame, but a non-zero exit or a different State Root.
    #[error("Runtime Host SSH activation returned an inconsistent result")]
    Inconsistent,
}

/// A running `ssh -N` forward. Dropping it kills `ssh`; [`Self::close`]
/// also waits for it and removes its log.
#[derive(Debug)]
pub(crate) struct SshTunnel {
    child: Child,
    log_dir: Option<PathBuf>,
}

impl SshTunnel {
    /// Resolves once `ssh` has exited, with how.
    pub(crate) async fn exited(&mut self) -> String {
        match self.child.status().await {
            Ok(status) => describe_status(status),
            Err(error) => format!("could not wait for ssh: {error}"),
        }
    }

    /// Stops `ssh` and removes the tunnel's log.
    pub(crate) async fn close(mut self) {
        if !matches!(self.child.try_status(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = until(Instant::now() + SSH_STOP_TIMEOUT, self.child.status()).await;
        }
        if let Some(directory) = self.log_dir.take() {
            let _ = async_fs::remove_dir_all(directory).await;
        }
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        // `kill_on_drop` ends the child; the log goes on the blocking pool.
        if let Some(directory) = self.log_dir.take() {
            blocking::unblock(move || std::fs::remove_dir_all(directory)).detach();
        }
    }
}

/// Opens a forward from a free port on this machine's loopback to
/// `127.0.0.1:<remote_port>` on `destination`, and returns it with the
/// WebSocket URL that reaches the Host through it.
pub(crate) async fn open_tunnel(
    program: &Path,
    destination: &str,
    ssh_port: Option<u16>,
    remote_port: u16,
    websocket_path: &str,
) -> Result<(SshTunnel, RemoteHostUrl), SshError> {
    check_configuration(program, destination, ssh_port).await?;
    for attempt in 1..=SSH_LOCAL_BIND_ATTEMPTS {
        let local_port = allocate_loopback_port().await.map_err(SshError::Io)?;
        let log_dir = private_temp_dir().await.map_err(SshError::Io)?;
        let log = log_dir.join("ssh.log");
        let mut command = ssh_command(program);
        command
            .args(tunnel_args(&log, local_port, remote_port, ssh_port, destination))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = match command.spawn() {
            Ok(child) => child,
            Err(source) => {
                let _ = async_fs::remove_dir_all(&log_dir).await;
                return Err(spawn_error(program, source));
            }
        };
        let mut tunnel = SshTunnel { child, log_dir: Some(log_dir) };
        match wait_for_forward(&mut tunnel, &log, local_port, destination).await {
            Ok(()) => {
                let url = format!("ws://127.0.0.1:{local_port}{websocket_path}");
                let url = RemoteHostUrl::parse(&url, false)
                    .map_err(|error| SshError::Io(io::Error::other(error)))?;
                return Ok((tunnel, url));
            }
            Err(SshError::LocalBindConflict) if attempt < SSH_LOCAL_BIND_ATTEMPTS => {
                tunnel.close().await;
            }
            Err(error) => {
                tunnel.close().await;
                return Err(error);
            }
        }
    }
    Err(SshError::LocalBindConflict)
}

/// The arguments `openRuntimeHostSshTunnel` passes, in its order.
fn tunnel_args(
    log: &Path,
    local_port: u16,
    remote_port: u16,
    ssh_port: Option<u16>,
    destination: &str,
) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec!["-v".into(), "-E".into(), log.into()];
    for arg in [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        &format!("ConnectTimeout={}", SSH_START_TIMEOUT.as_secs()),
        "-o",
        "BatchMode=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ClearAllForwardings=no",
        "-o",
        "ForkAfterAuthentication=no",
        "-L",
        &format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
    ] {
        args.push(arg.into());
    }
    if let Some(port) = ssh_port {
        args.push("-p".into());
        args.push(port.to_string().into());
    }
    args.push(destination.into());
    args
}

/// `readSshConfiguration` and `assertNoConfiguredForwarding`.
async fn check_configuration(
    program: &Path,
    destination: &str,
    ssh_port: Option<u16>,
) -> Result<(), SshError> {
    let mut command = ssh_command(program);
    command.args(["-G", "-o", "ControlMaster=no", "-o", "ControlPath=none"]);
    command.args(["-o", "ClearAllForwardings=no"]);
    if let Some(port) = ssh_port {
        command.arg("-p").arg(port.to_string());
    }
    command.arg(destination).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let failed =
        |outcome: String| SshError::Configuration { destination: destination.to_owned(), outcome };
    let output = until(Instant::now() + SSH_START_TIMEOUT, command.output())
        .await
        .ok_or_else(|| failed("timed out".to_owned()))?
        .map_err(|source| spawn_error(program, source))?;
    if !output.status.success() {
        return Err(failed(describe_status(output.status)));
    }
    let configured = String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let option = line.split_whitespace().next().unwrap_or("");
        ["localforward", "remoteforward", "dynamicforward"]
            .iter()
            .any(|name| option.eq_ignore_ascii_case(name))
    });
    if configured {
        Err(SshError::ForwardingConfigured { destination: destination.to_owned() })
    } else {
        Ok(())
    }
}

/// Waits until the log shows the forward listening, `ssh` exits, or
/// [`SSH_START_TIMEOUT`] passes (`waitForForward`).
async fn wait_for_forward(
    tunnel: &mut SshTunnel,
    log: &Path,
    port: u16,
    destination: &str,
) -> Result<(), SshError> {
    let marker = format!("Local forwarding listening on 127.0.0.1 port {port}.");
    let deadline = Instant::now() + SSH_START_TIMEOUT;
    let failed = |outcome: String, log: &str| SshError::Failed {
        destination: destination.to_owned(),
        outcome,
        failure: diagnose(log),
    };
    loop {
        let text = read_log(log).await?;
        if text.contains(&marker) {
            return Ok(());
        }
        if has_local_bind_conflict(&text, port) {
            return Err(SshError::LocalBindConflict);
        }
        if let Some(status) = tunnel.child.try_status().map_err(SshError::Io)? {
            // The last lines may have landed after the read above.
            let text = read_log(log).await?;
            if has_local_bind_conflict(&text, port) {
                return Err(SshError::LocalBindConflict);
            }
            return Err(failed(describe_status(status), &text));
        }
        if Instant::now() >= deadline {
            return Err(failed("timed out".to_owned(), &text));
        }
        Timer::after(READINESS_POLL).await;
    }
}

async fn read_log(log: &Path) -> Result<String, SshError> {
    match async_fs::read(log).await {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(SshError::Io(error)),
    }
}

/// `hasLocalBindConflict`: OpenSSH logs `bind [127.0.0.1]:<port>: Address
/// already in use` (Windows: `WSAEADDRINUSE`).
fn has_local_bind_conflict(log: &str, port: u16) -> bool {
    let port_marker = format!(":{port}:");
    log.lines().any(|line| {
        line.contains(&port_marker)
            && (line.contains("Address already in use")
                || line.contains("Only one usage of each socket address")
                || line.contains("WSAEADDRINUSE"))
    })
}

/// Reads OpenSSH's own messages for the reason it failed.
fn diagnose(log: &str) -> SshFailure {
    if log.contains("Host key verification failed")
        || log.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
    {
        SshFailure::HostKeyNotVerified
    } else if log.contains("Permission denied (")
        || log.contains("Too many authentication failures")
    {
        SshFailure::AuthenticationFailed
    } else if log.contains("Could not resolve hostname") {
        SshFailure::UnknownHost
    } else if [
        "Connection refused",
        "Connection timed out",
        "Operation timed out",
        "No route to host",
        "Network is unreachable",
        "Connection reset by peer",
    ]
    .iter()
    .any(|message| log.contains(message))
    {
        SshFailure::Unreachable
    } else {
        SshFailure::Unknown
    }
}

/// Runs `operator activate --framed --root-id <root_id>` on `destination`
/// over `ssh -T` and returns the endpoint it reports
/// (`activateRuntimeHostSshOperator`, batch mode).
pub(crate) async fn activate_operator(
    program: &Path,
    destination: &str,
    ssh_port: Option<u16>,
    operator: &OperatorCommand,
    root_id: &str,
) -> Result<ActivationResult, SshError> {
    let remote_command =
        operator_remote_command(operator, &["activate", "--framed", "--root-id", root_id]);
    let mut command = ssh_command(program);
    command.args(["-T", "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none"]);
    command.args(["-o", "ClearAllForwardings=yes", "-o", "RemoteCommand=none"]);
    command.arg("-o").arg(format!("ConnectTimeout={}", SSH_START_TIMEOUT.as_secs()));
    if let Some(port) = ssh_port {
        command.arg("-p").arg(port.to_string());
    }
    command
        .arg(destination)
        .arg(remote_command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|source| spawn_error(program, source))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let read = future::zip(read_capped(stdout, ACTIVATION_OUTPUT_MAX_BYTES), async {
        read_tail(stderr, STDERR_TAIL_MAX_BYTES).await
    });
    let outputs = until(Instant::now() + ACTIVATION_TIMEOUT, read).await;
    let timed_out = outputs.is_none();
    let (stdout, stderr) = outputs.unwrap_or((Capped::Overflow, String::new()));
    let overflow = matches!(stdout, Capped::Overflow);
    if timed_out || overflow {
        let _ = child.kill();
    }
    let status = until(Instant::now() + SSH_STOP_TIMEOUT, child.status())
        .await
        .transpose()
        .map_err(SshError::Io)?;
    if timed_out {
        return Err(ActivationError::TimedOut.into());
    }
    let Capped::Complete(stdout) = stdout else {
        return Err(ActivationError::TooMuchOutput.into());
    };
    let output = String::from_utf8_lossy(&stdout);
    let line = output.strip_suffix("\r\n").or_else(|| output.strip_suffix('\n')).unwrap_or(&output);
    if line.contains(['\n', '\r']) {
        return Err(ActivationError::Malformed.into());
    }
    let code = status.and_then(|status| status.code());
    match decode_activation_frame(line) {
        None => match code {
            Some(SSH_FAILURE_EXIT_CODE) => Err(SshError::Failed {
                destination: destination.to_owned(),
                outcome: format!("exited with code {SSH_FAILURE_EXIT_CODE}"),
                failure: diagnose(&stderr),
            }),
            Some(code) => Err(ActivationError::Exited(code).into()),
            None => Err(ActivationError::Terminated.into()),
        },
        Some(ActivationFrame::Error(failure)) => {
            Err(ActivationError::Refused { code: failure.code, message: failure.message }.into())
        }
        Some(ActivationFrame::Result(result)) => {
            if code == Some(0) && result.root_id == root_id {
                Ok(result)
            } else {
                Err(ActivationError::Inconsistent.into())
            }
        }
        Some(_) => Err(ActivationError::Malformed.into()),
    }
}

enum Capped {
    Complete(Vec<u8>),
    Overflow,
}

/// Reads `stream` to its end, or stops at more than `max` bytes.
async fn read_capped(stream: Option<impl AsyncRead + Unpin>, max: usize) -> Capped {
    let Some(mut stream) = stream else {
        return Capped::Complete(Vec::new());
    };
    let mut output = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return Capped::Complete(output),
            Ok(read) => {
                output.extend_from_slice(&buffer[..read]);
                if output.len() > max {
                    return Capped::Overflow;
                }
            }
        }
    }
}

/// Reads `stream` to its end, keeping the last `max` bytes.
async fn read_tail(stream: Option<impl AsyncRead + Unpin>, max: usize) -> String {
    let Some(mut stream) = stream else {
        return String::new();
    };
    let mut tail = Vec::new();
    let mut buffer = [0u8; 4096];
    while let Ok(read @ 1..) = stream.read(&mut buffer).await {
        tail.extend_from_slice(&buffer[..read]);
        if tail.len() > max {
            tail.drain(..tail.len() - max);
        }
    }
    String::from_utf8_lossy(&tail).into_owned()
}

/// The payload the Windows activation script decodes. Field order is the
/// order `JSON.stringify` writes in `runtimeHostSshOperatorRemoteCommand`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsPayload<'a> {
    executable: &'a str,
    args: &'a [String],
    environment: Empty,
    module_path: &'a str,
    deployment_root: &'a str,
    missing_operator_is_success: bool,
}

/// Serializes as `{}`.
#[derive(Serialize)]
struct Empty {}

/// `runtimeHostSshOperatorRemoteCommand` with no environment: the command
/// line `ssh` asks the remote shell to run.
pub(crate) fn operator_remote_command(operator: &OperatorCommand, args: &[&str]) -> String {
    let (executable, args) = operator.invocation(args);
    let module_path = match operator {
        OperatorCommand::Node { platform: OperatorPlatform::Win32, module_path, .. } => module_path,
        _ => {
            let words = std::iter::once(&executable).chain(&args).map(|word| quote_posix(word));
            return format!("exec {}", words.collect::<Vec<_>>().join(" "));
        }
    };
    let payload = WindowsPayload {
        executable: &executable,
        args: &args,
        environment: Empty {},
        module_path,
        deployment_root: win32_dirname(module_path),
        missing_operator_is_success: false,
    };
    let payload = STANDARD.encode(serde_json::to_vec(&payload).expect("the payload is JSON"));
    let script = [
        format!(
            "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{payload}'))|ConvertFrom-Json"
        ),
        "if($p.missingOperatorIsSuccess -and -not (Test-Path -LiteralPath $p.modulePath -PathType Leaf)){if(-not (Test-Path -LiteralPath $p.deploymentRoot)){exit 0}else{exit 1}}".to_owned(),
        "foreach($e in $p.environment.psobject.Properties){[Environment]::SetEnvironmentVariable($e.Name,[string]$e.Value,'Process')}".to_owned(),
        "$code=1".to_owned(),
        "try{& ([string]$p.executable) @($p.args|ForEach-Object {[string]$_});$code=if($null -eq $LASTEXITCODE){1}else{$LASTEXITCODE}}catch{$code=1}".to_owned(),
        "exit $code".to_owned(),
    ]
    .join(";");
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        STANDARD.encode(utf16)
    )
}

/// `quotePosix`: single quotes, with each `'` written as `'"'"'`.
fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'"'"'"#))
}

/// Node's `path.win32.dirname`.
fn win32_dirname(path: &str) -> &str {
    let bytes = path.as_bytes();
    let separator = |index: usize| matches!(bytes.get(index), Some(b'\\' | b'/'));
    let len = bytes.len();
    if len == 0 {
        return ".";
    }
    if len == 1 {
        return if separator(0) { path } else { "." };
    }
    let mut root_end = None;
    let mut offset = 0;
    if separator(0) {
        root_end = Some(1);
        offset = 1;
        if separator(1) {
            // A UNC root: `\\server\share\`.
            let mut j = 2;
            let mut last = j;
            while j < len && !separator(j) {
                j += 1;
            }
            if j < len && j != last {
                last = j;
                while j < len && separator(j) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !separator(j) {
                        j += 1;
                    }
                    if j == len {
                        return path;
                    }
                    if j != last {
                        root_end = Some(j + 1);
                        offset = j + 1;
                    }
                }
            }
        }
    } else if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let end = if len > 2 && separator(2) { 3 } else { 2 };
        root_end = Some(end);
        offset = end;
    }
    let mut end = None;
    let mut matched_slash = true;
    for index in (offset..len).rev() {
        if separator(index) {
            if !matched_slash {
                end = Some(index);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end.or(root_end) {
        Some(end) => &path[..end],
        None => ".",
    }
}

/// A free TCP port on `127.0.0.1` (`allocateLoopbackPort`). Another process
/// can take it before `ssh` binds it; the caller retries then.
async fn allocate_loopback_port() -> io::Result<u16> {
    let listener = async_net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    Ok(listener.local_addr()?.port())
}

/// A new directory only this user can enter, for the tunnel's log.
async fn private_temp_dir() -> io::Result<PathBuf> {
    let path =
        std::env::temp_dir().join(format!("maka-gpui-ssh-{}", uuid::Uuid::new_v4().simple()));
    // Only Unix sets a mode; elsewhere the builder stays as created.
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = async_fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use async_fs::unix::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(&path).await?;
    Ok(path)
}

/// `program` with no console window on Windows (`windowsHide`), killed if
/// its handle is dropped.
fn ssh_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.kill_on_drop(true);
    #[cfg(windows)]
    {
        use async_process::windows::CommandExt as _;
        /// `CREATE_NO_WINDOW` (`winbase.h`).
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn spawn_error(program: &Path, source: io::Error) -> SshError {
    SshError::Spawn { program: display_program(program.as_os_str()), source }
}

fn display_program(program: &OsStr) -> String {
    program.to_string_lossy().into_owned()
}

fn describe_status(status: ExitStatus) -> String {
    if let Some(code) = status.code() {
        return format!("exited with code {code}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        if let Some(signal) = status.signal() {
            return format!("ended by signal {signal}");
        }
    }
    "exited".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";

    fn activate_args() -> [&'static str; 4] {
        ["activate", "--framed", "--root-id", ROOT_ID]
    }

    /// `runtimeHostSshOperatorRemoteCommand` at the pin, recorded with Node
    /// 24.18.
    #[test]
    fn posix_remote_commands_match_the_typescript_quoting() {
        let node = OperatorCommand::node(
            OperatorPlatform::Posix,
            "/opt/maka/node/bin/node",
            "/home/o'neil/.maka/runtime-host/operator.mjs",
        )
        .expect("valid");
        assert_eq!(
            operator_remote_command(&node, &activate_args()),
            format!(
                "exec '/opt/maka/node/bin/node' '/home/o'\"'\"'neil/.maka/runtime-host/operator.mjs' \
                 'activate' '--framed' '--root-id' '{ROOT_ID}'"
            )
        );
        let legacy = OperatorCommand::legacy_posix("/usr/local/bin/maka-operator").expect("valid");
        assert_eq!(
            operator_remote_command(&legacy, &activate_args()),
            format!(
                "exec '/usr/local/bin/maka-operator' 'activate' '--framed' '--root-id' '{ROOT_ID}'"
            )
        );
    }

    #[test]
    fn the_windows_remote_command_matches_the_typescript_encoding() {
        let node = OperatorCommand::node(
            OperatorPlatform::Win32,
            "C:\\Program Files\\Maka\\node.exe",
            "C:\\Users\\me\\AppData\\Local\\Maka\\runtime-host\\operator.mjs",
        )
        .expect("valid");
        assert_eq!(
            operator_remote_command(&node, &activate_args()),
            include_str!("../tests/fixtures/win32-activation-command.txt").trim_end()
        );
    }

    /// `path.win32.dirname` at Node 24.18.
    #[test]
    fn win32_dirname_matches_node() {
        for (path, dirname) in [
            ("C:\\Users\\me\\operator.mjs", "C:\\Users\\me"),
            ("C:\\operator.mjs", "C:\\"),
            ("C:/Users/me/operator.mjs", "C:/Users/me"),
            ("\\\\server\\share\\operator.mjs", "\\\\server\\share\\"),
            ("\\\\server\\share\\dir\\operator.mjs", "\\\\server\\share\\dir"),
            ("C:\\Users\\me\\dir\\", "C:\\Users\\me"),
            ("\\operator.mjs", "\\"),
            ("C:\\", "C:\\"),
            ("C:", "C:"),
            ("C:operator.mjs", "C:"),
            ("//server/share/x/op.mjs", "//server/share/x"),
        ] {
            assert_eq!(win32_dirname(path), dirname, "{path}");
        }
    }

    #[test]
    fn tunnel_arguments_follow_the_typescript_order() {
        let args = tunnel_args(Path::new("/tmp/x/ssh.log"), 40001, 7000, Some(2222), "me@box");
        let args: Vec<_> = args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(
            args,
            [
                "-v",
                "-E",
                "/tmp/x/ssh.log",
                "-N",
                "-T",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ConnectTimeout=15",
                "-o",
                "BatchMode=yes",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "-o",
                "ClearAllForwardings=no",
                "-o",
                "ForkAfterAuthentication=no",
                "-L",
                "127.0.0.1:40001:127.0.0.1:7000",
                "-p",
                "2222",
                "me@box",
            ]
        );
    }

    #[test]
    fn ssh_logs_name_the_failure() {
        for (log, failure) in [
            (
                "debug1: Connecting to box [10.0.0.2] port 22.\r\nNo ED25519 host key is known for box and you have requested strict checking.\r\nHost key verification failed.\r\n",
                SshFailure::HostKeyNotVerified,
            ),
            ("me@box: Permission denied (publickey,password).", SshFailure::AuthenticationFailed),
            (
                "ssh: Could not resolve hostname nowhere: nodename nor servname provided",
                SshFailure::UnknownHost,
            ),
            ("ssh: connect to host box port 22: Connection refused", SshFailure::Unreachable),
            ("ssh: connect to host box port 22: Operation timed out", SshFailure::Unreachable),
            ("debug1: something else", SshFailure::Unknown),
        ] {
            assert_eq!(diagnose(log), failure, "{log}");
        }
        assert!(has_local_bind_conflict(
            "bind [127.0.0.1]:40001: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 40001",
            40001
        ));
        assert!(!has_local_bind_conflict("bind [127.0.0.1]:40002: Address already in use", 40001));
    }
}
