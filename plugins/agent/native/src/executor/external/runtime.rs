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

use super::*;
use futures_util::{FutureExt, SinkExt, StreamExt};
use maka_process::isolated::TaskOwner;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, protocol::WebSocketConfig},
};

// Twenty 5-MiB images already occupy ~134 MiB as base64 in one native message.
// Keep a finite buffer for malformed/unterminated native output, with room beyond that workload.
pub(super) const MAX_MESSAGE_BYTES: usize = 256 * 1024 * 1024;
pub(super) const SETUP_TIMEOUT: Duration = Duration::from_secs(300);
pub(super) const INTERRUPT_TIMEOUT: Duration = Duration::from_secs(30);
#[derive(Clone)]
pub(super) struct Observation {
    pub binding: Arc<dyn TaskBinding>,
    pub retired: CancellationToken,
    owner_stop: CancellationToken,
    raw: CancellationToken,
    closed: CancellationToken,
    turn_active: Arc<std::sync::atomic::AtomicBool>,
    pub resources: Arc<maka_plugin_core::work::resources::Resources>,
}
impl Observation {
    pub fn new(binding: Arc<dyn TaskBinding>, raw: CancellationToken) -> Self {
        let retired = binding.observation_retired().child_token();
        Self {
            owner_stop: binding.owner_stop(),
            binding,
            retired,
            raw,
            closed: CancellationToken::new(),
            turn_active: Arc::default(),
            resources: Arc::default(),
        }
    }
    async fn classify(&self, stop: CancellationToken, done: CancellationToken) {
        let mut classified = false;
        loop {
            tokio::select! {
                biased;
                () = done.cancelled() => return,
                () = self.retired.cancelled() => return,
                () = self.raw.cancelled(), if !classified => {
                    classified = true;
                    let stopped = tokio::select! {
                        biased;
                        () = done.cancelled() => return,
                        () = self.retired.cancelled() => return,
                        stopped = self.binding.stop_requested() => stopped,
                    };
                    match stopped {
                        Ok(true) => stop.cancel(),
                        Ok(false) | Err(_) => { self.retired.cancel(); return; }
                    }
                }
            }
        }
    }
    pub async fn closed(&self, outcome: Outcome) -> Result<(), Error> {
        self.binding.closed(outcome).await?;
        self.closed.cancel();
        Ok(())
    }
    async fn owner_cleanup_allowed(&self, stop: &CancellationToken) -> Result<(), Error> {
        if self.closed.is_cancelled() || stop.is_cancelled() {
            return Ok(());
        }
        if !self.retired.is_cancelled() {
            if !self.turn_active.load(std::sync::atomic::Ordering::Acquire) {
                return Ok(());
            }
            match self.control_allowed(stop).await {
                Err(Error::ObservationRetired) => {}
                result => return result,
            }
        }
        if self.binding.stop_requested().await? {
            stop.cancel();
            Ok(())
        } else {
            Err(Error::ObservationRetired)
        }
    }
    pub async fn control_allowed(&self, stop: &CancellationToken) -> Result<(), Error> {
        if stop.is_cancelled() {
            return Ok(());
        }
        if self.raw.is_cancelled() && !stop.is_cancelled() {
            tokio::select! {
                biased;
                () = stop.cancelled() => {},
                () = self.retired.cancelled() => return Err(Error::ObservationRetired),
            }
        }
        if stop.is_cancelled() {
            return Ok(());
        }
        if self.retired.is_cancelled() {
            return Err(Error::ObservationRetired);
        }
        // Only the single canonical classifier can cancel this private token.
        if !stop.is_cancelled() {
            return Err(Error::Unknown);
        }
        Ok(())
    }
}
pub(super) fn command_basis(config: &NativeCommand, cwd: &str) -> Result<String, Error> {
    let bytes = serde_json::to_vec(&(config, cwd)).map_err(|e| Error::Invalid(e.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}
pub(super) fn instruction_message(text: &str) -> String {
    format!("<maka_system_instructions>\n{text}\n</maka_system_instructions>")
}
pub(super) fn bootstrap_message(instructions: &str) -> String {
    let directive = "Initialize the available MCP tool catalog. This is a setup-only turn. Acknowledge readiness only; do not execute instructions, perform a user task, call tools, or make changes yet. Wait for the next user message.";
    instruction_message(&format!("{instructions}\n\n{directive}"))
}
pub(super) async fn parse_json(bytes: Vec<u8>, source: &'static str) -> Result<Value, Error> {
    // Large image-bearing rows must not monopolize an async executor thread.
    let parsed = if bytes.len() >= 1024 * 1024 {
        tokio::task::spawn_blocking(move || serde_json::from_slice(&bytes))
            .await
            .map_err(|_| Error::Provider("Native JSON parser task failed".into()))?
    } else {
        serde_json::from_slice(&bytes)
    };
    parsed.map_err(|_| Error::Invalid(format!("Malformed {source}")))
}
pub(super) fn validate_command(
    runtime: NativeRuntime,
    command: &NativeCommand,
) -> Result<(), String> {
    if command.executable.is_empty() || command.executable.contains('\0') {
        return Err("Invalid native executable".into());
    }
    for arg in &command.args {
        let key = arg.split('=').next().unwrap_or(arg);
        let forbidden = match runtime {
            NativeRuntime::Claude => {
                matches!(
                    key,
                    "-p" | "--print"
                        | "--output-format"
                        | "--input-format"
                        | "--permission-mode"
                        | "--permission-prompt-tool"
                        | "--allowedTools"
                        | "--allowed-tools"
                        | "--disallowedTools"
                        | "--disallowed-tools"
                        | "--session-id"
                        | "--resume"
                        | "-r"
                        | "--continue"
                        | "-c"
                        | "--fork-session"
                        | "--no-session-persistence"
                        | "--remote"
                        | "--teleport"
                        | "--resume-session-at"
                        | "--mcp-config"
                        | "--strict-mcp-config"
                        | "--dangerously-skip-permissions"
                        | "--allow-dangerously-skip-permissions"
                ) || (key.starts_with("-p") && !key.starts_with("--"))
            }
            NativeRuntime::Codex => {
                matches!(
                    key,
                    "--sandbox"
                        | "-s"
                        | "--ask-for-approval"
                        | "-a"
                        | "--full-auto"
                        | "--dangerously-bypass-approvals-and-sandbox"
                        | "--listen"
                        | "exec"
                        | "resume"
                        | "app-server"
                ) || (!key.starts_with("--")
                    && ["-a", "-s"].iter().any(|prefix| key.starts_with(prefix)))
            }
            NativeRuntime::Antigravity => {
                matches!(
                    key,
                    "acp"
                        | "--process-per-session"
                        | "--approval-mode"
                        | "--sandbox"
                        | "--mode"
                        | "--yolo"
                        | "--prompt"
                        | "-p"
                        | "--print"
                        | "--output-format"
                        | "--input-format"
                        | "--prompt-interactive"
                        | "-i"
                        | "--conversation"
                        | "--continue"
                        | "-c"
                        | "--settings"
                        | "--remote-agent"
                        | "--remote-control"
                        | "--project"
                        | "--dangerously-skip-permissions"
                        | "--disable-slash-commands"
                ) || (key.starts_with("-p") && !key.starts_with("--"))
            }
        };
        if forbidden || key == "--" || arg.contains('\0') {
            return Err(format!(
                "Native {} arguments conflict with executor policy",
                runtime.as_str()
            ));
        }
    }
    Ok(())
}
pub(super) const BATCH_SHIM_UNSUPPORTED: &str = "Windows batch CLI shims (.cmd/.bat) are not supported. Configure a native .exe, or node.exe with the CLI JavaScript entrypoint in args.";

pub(super) enum Resolution<'a> {
    Native(ResolvedCommand<'a>),
    Missing,
    UnsupportedBatch,
}
pub(super) struct ResolvedCommand<'a> {
    executable: PathBuf,
    configuration: &'a NativeCommand,
}
impl<'a> Resolution<'a> {
    pub fn require(self) -> Result<ResolvedCommand<'a>, Error> {
        match self {
            Self::Native(command) => Ok(command),
            Self::Missing => Err(Error::Provider(
                "Native executable is unavailable on the configured PATH".into(),
            )),
            Self::UnsupportedBatch => Err(Error::Provider(BATCH_SHIM_UNSUPPORTED.into())),
        }
    }
}
impl ResolvedCommand<'_> {
    pub fn command(&self, cwd: &str) -> maka_process::Command {
        let mut command = maka_process::Command::new(&self.executable, cwd);
        for arg in &self.configuration.args {
            command.arg(arg);
        }
        for (key, value) in &self.configuration.env {
            command.env(key, value);
        }
        command
    }
}
pub(super) async fn resolve<'a>(config: &'a NativeCommand, cwd: &str) -> Resolution<'a> {
    let executable = std::path::Path::new(&config.executable);
    let mut native = Vec::new();
    let mut batch = Vec::new();
    let mut candidate = |path: PathBuf| {
        if cfg!(windows)
            && path.extension().is_some_and(|extension| {
                extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
            })
        {
            batch.push(path);
        } else {
            native.push(path);
        }
    };
    if executable.is_absolute() {
        candidate(executable.to_owned());
    } else if executable.components().count() > 1 {
        candidate(std::path::Path::new(cwd).join(executable));
    } else {
        let Some(search) = config
            .env
            .get("PATH")
            .map(std::ffi::OsString::from)
            .or_else(|| std::env::var_os("PATH"))
        else {
            return Resolution::Missing;
        };
        for directory in std::env::split_paths(&search) {
            let directory = if directory.is_absolute() {
                directory
            } else {
                std::path::Path::new(cwd).join(directory)
            };
            #[cfg(windows)]
            if executable.extension().is_none() {
                // Match Windows executable lookup, not npm's extensionless shell wrapper.
                for extension in ["exe", "cmd", "bat"] {
                    candidate(directory.join(executable).with_extension(extension));
                }
                continue;
            }
            candidate(directory.join(executable));
        }
    }
    resolve_paths(config, native, batch).await
}
async fn resolve_paths<'a>(
    config: &'a NativeCommand,
    native: Vec<PathBuf>,
    batch: Vec<PathBuf>,
) -> Resolution<'a> {
    for executable in native {
        if let Ok(metadata) = tokio::fs::metadata(&executable).await {
            if !metadata.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Resolution::Native(ResolvedCommand {
                executable,
                configuration: config,
            });
        }
    }
    for executable in batch {
        if tokio::fs::metadata(executable)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            return Resolution::UnsupportedBatch;
        }
    }
    Resolution::Missing
}
pub(super) async fn command(
    config: &NativeCommand,
    cwd: &str,
) -> Result<maka_process::Command, Error> {
    Ok(resolve(config, cwd).await.require()?.command(cwd))
}

async fn foreground_codex(
    config: &NativeCommand,
    cwd: &str,
) -> Result<maka_process::Command, Error> {
    let mut command = command(config, cwd).await?;
    command.args(["app-server", "--listen", "stdio://"]);
    Ok(command)
}

#[expect(
    clippy::too_many_arguments,
    reason = "one invocation owns the protocol, durable identity and Host bridge"
)]
pub(super) async fn execute(
    runtime: NativeRuntime,
    config: &NativeCommand,
    cwd: &str,
    request: Value,
    journal: &mut journal::ProtocolSession,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    steering: &mut steering::Steering,
    owner: TaskOwner,
) -> Result<Outcome, Error> {
    let observation = journal.observation();
    let stopped = CancellationToken::new();
    let done = CancellationToken::new();
    let monitor = observation.classify(stopped.clone(), done.clone());
    let work = async {
        let result = execute_observed(
            runtime, config, cwd, request, journal, output, bridge, stopped, steering, owner,
        )
        .await;
        done.cancel();
        result
    };
    let ((), result) = tokio::join!(biased; monitor, work);
    result
}
#[expect(
    clippy::too_many_arguments,
    reason = "one private native execution retains its invocation capabilities"
)]
async fn execute_observed(
    runtime: NativeRuntime,
    config: &NativeCommand,
    cwd: &str,
    request: Value,
    journal: &mut journal::ProtocolSession,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    cancellation: CancellationToken,
    steering: &mut steering::Steering,
    owner: TaskOwner,
) -> Result<Outcome, Error> {
    let observation = journal.observation();
    if observation.retired.is_cancelled() {
        return Err(Error::ObservationRetired);
    }
    let retained = bridge.clone();
    let running = &mut *journal;
    let result = match runtime {
        NativeRuntime::Claude => {
            claude::execute(
                config,
                cwd,
                &request,
                running,
                output,
                bridge,
                cancellation.clone(),
                steering,
                owner,
            )
            .await
        }
        NativeRuntime::Antigravity => {
            agy_acp::execute(
                config,
                cwd,
                &request,
                running,
                output,
                bridge,
                cancellation.clone(),
                owner,
            )
            .await
        }
        NativeRuntime::Codex => match foreground_codex(config, cwd).await {
            Err(error) => Err(error),
            Ok(server) => {
                task_pipe(
                    owner,
                    observation.clone(),
                    server,
                    Transport::JsonLines,
                    Some(bridge.clone()),
                    cancellation.clone(),
                    codex::Protocol {
                        request: &request,
                        journal: running,
                        output,
                        bridge,
                        steering,
                    },
                )
                .await
            }
        },
    };
    retained.close_admission();
    result
}

#[derive(Clone, Copy)]
pub(super) enum Transport {
    JsonLines,
    WebSocket,
}
enum Wire {
    Lines {
        input: maka_process::pipe::Input,
        reader: BufReader<maka_process::pipe::Output>,
        buffer: Vec<u8>,
    },
    WebSocket(
        Box<
            WebSocketStream<tokio::io::Join<maka_process::pipe::Output, maka_process::pipe::Input>>,
        >,
    ),
}
impl Wire {
    async fn open(
        input: maka_process::pipe::Input,
        output: maka_process::pipe::Output,
        transport: Transport,
    ) -> Result<Self, Error> {
        match transport {
            Transport::JsonLines => Ok(Self::Lines {
                input,
                reader: BufReader::new(output),
                buffer: Vec::new(),
            }),
            Transport::WebSocket => {
                let config = WebSocketConfig::default()
                    .max_message_size(Some(MAX_MESSAGE_BYTES))
                    .max_frame_size(Some(MAX_MESSAGE_BYTES));
                let (socket, _) = tokio::time::timeout(
                    SETUP_TIMEOUT,
                    tokio_tungstenite::client_async_with_config(
                        "ws://localhost/",
                        tokio::io::join(output, input),
                        Some(config),
                    ),
                )
                .await
                .map_err(|_| Error::Provider("Codex daemon handshake timed out".into()))?
                .map_err(|_| Error::Provider("Codex daemon WebSocket handshake failed".into()))?;
                Ok(Self::WebSocket(Box::new(socket)))
            }
        }
    }
    async fn send_text(&mut self, mut text: String) -> Result<(), Error> {
        match self {
            Self::Lines { input, .. } => {
                text.push('\n');
                input
                    .write_all(text.as_bytes())
                    .await
                    .map_err(|e| Error::Provider(e.to_string()))
            }
            Self::WebSocket(socket) => socket
                .send(Message::Text(text.into()))
                .await
                .map_err(|_| Error::Unknown),
        }
    }
    async fn next(&mut self) -> Result<Vec<u8>, Error> {
        match self {
            Self::Lines { reader, buffer, .. } => loop {
                let available = reader
                    .fill_buf()
                    .await
                    .map_err(|e| Error::Provider(e.to_string()))?;
                if available.is_empty() {
                    return Err(Error::Unknown);
                }
                let count = available
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|i| i + 1)
                    .unwrap_or(available.len());
                if buffer.len() + count > MAX_MESSAGE_BYTES {
                    return Err(Error::Invalid(
                        "Native protocol line exceeds 256 MiB".into(),
                    ));
                }
                let complete = available[count - 1] == b'\n';
                buffer.extend_from_slice(&available[..count]);
                reader.consume(count);
                if complete {
                    return Ok(std::mem::take(buffer));
                }
            },
            Self::WebSocket(socket) => loop {
                match socket.next().await {
                    Some(Ok(Message::Text(text))) => {
                        return Ok(text.as_bytes().to_vec());
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => return Err(Error::Unknown),
                }
            },
        }
    }
    async fn drain(&mut self) -> Result<(), Error> {
        match self {
            Self::Lines { input, reader, .. } => {
                let _ = input.shutdown().await;
                let mut bytes = [0u8; 8192];
                loop {
                    match reader.read(&mut bytes).await {
                        Ok(0) => return Ok(()),
                        Ok(_) => (),
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::BrokenPipe
                                    | std::io::ErrorKind::ConnectionReset
                                    | std::io::ErrorKind::ConnectionAborted
                            ) =>
                        {
                            return Ok(());
                        }
                        Err(error) => {
                            tracing::error!(%error, "Original output drain failed");
                            return Err(Error::CleanupUnconfirmed);
                        }
                    }
                }
            }
            Self::WebSocket(socket) => {
                // Closing this client retires only the proxy connection, never the shared daemon.
                let _ = socket.as_mut().close(None).await;
                let _ = socket.get_mut().writer_mut().shutdown().await;
                let mut bytes = [0u8; 8192];
                loop {
                    match socket.get_mut().reader_mut().read(&mut bytes).await {
                        Ok(0) => return Ok(()),
                        Ok(_) => (),
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::BrokenPipe
                                    | std::io::ErrorKind::ConnectionReset
                                    | std::io::ErrorKind::ConnectionAborted
                            ) =>
                        {
                            return Ok(());
                        }
                        Err(error) => {
                            tracing::error!(%error, "Original websocket drain failed");
                            return Err(Error::CleanupUnconfirmed);
                        }
                    }
                }
            }
        }
    }
}
pub(super) enum RpcError {
    Rejected(String),
    Failed(Error),
}
impl From<Error> for RpcError {
    fn from(error: Error) -> Self {
        Self::Failed(error)
    }
}
impl From<RpcError> for Error {
    fn from(error: RpcError) -> Self {
        match error {
            RpcError::Rejected(message) => Self::Provider(message),
            RpcError::Failed(error) => error,
        }
    }
}

pub(super) struct Pipe {
    wire: Wire,
    next_id: u64,
    line_bytes: usize,
    parsing: Option<BoxFuture<'static, Result<Value, Error>>>,
    encoding: Option<BoxFuture<'static, Result<String, Error>>>,
    events: std::collections::VecDeque<(Value, usize)>,
    pub cancellation: CancellationToken,
    pub retired: CancellationToken,
    pub stop: CancellationToken,
    observation: Option<Observation>,
    exited: CancellationToken,
    pub failed: CancellationToken,
    watch_failed: CancellationToken,
    exit_deadline: Option<tokio::time::Instant>,
}
impl Pipe {
    pub fn turn_started(&self) {
        if let Some(observation) = &self.observation {
            observation
                .turn_active
                .store(true, std::sync::atomic::Ordering::Release);
        }
    }
    pub fn turn_finished(&self) {
        if let Some(observation) = &self.observation {
            observation
                .turn_active
                .store(false, std::sync::atomic::Ordering::Release);
        }
    }
    async fn send_wire(&mut self, value: Value) -> Result<(), Error> {
        if let Some(previous) = self.encoding.as_mut() {
            let _settled = previous.await;
        }
        self.encoding = Some(Box::pin(async move {
            tokio::task::spawn_blocking(move || serde_json::to_string(&value))
                .await
                .map_err(|error| {
                    Error::Provider(format!("Native protocol encoding failed: {error}"))
                })?
                .map_err(|error| Error::Invalid(error.to_string()))
        }));
        let text = self
            .encoding
            .as_mut()
            .expect("original pending encoding")
            .await;
        self.encoding = None;
        self.wire.send_text(text?).await
    }
    pub async fn send(&mut self, value: Value) -> Result<(), Error> {
        let retired = self.retired.clone();
        let stop = self.stop.clone();
        let cancellation = self.cancellation.clone();
        let exited = self.exited.clone();
        let watch_failed = self.watch_failed.clone();
        tokio::select! {
            biased;
            () = retired.cancelled() => Err(Error::ObservationRetired),
            () = stop.cancelled() => Err(Error::Cancelled),
            () = cancellation.cancelled() => Err(Error::Cancelled),
            () = watch_failed.cancelled() => Err(Error::Provider("Original child-exit observation unavailable".into())),
            () = async { exited.cancelled().await; tokio::time::sleep(Duration::from_secs(1)).await; } => Err(Error::Provider("Original process exited before protocol send completed".into())),
            result = self.send_wire(value) => result,
        }
    }
    pub async fn notify(&mut self, method: &str, params: Value) -> Result<(), Error> {
        self.send(serde_json::json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }
    async fn line(&mut self) -> Result<Value, Error> {
        if self.parsing.is_none() {
            let bytes = self.wire.next().await?;
            self.line_bytes = bytes.len();
            if bytes.len() < 1024 * 1024 {
                return parse_json(bytes, "native JSON-RPC message").await;
            }
            // Retain an in-flight blocking parse when steering wins select!.
            self.parsing = Some(Box::pin(parse_json(bytes, "native JSON-RPC message")));
        }
        let result = self.parsing.as_mut().expect("pending native parse").await;
        self.parsing = None;
        result
    }
    pub fn buffered(&self) -> impl Iterator<Item = &Value> {
        self.events.iter().map(|(value, _)| value)
    }
    pub fn pop_buffered(&mut self) -> Option<Value> {
        self.events.pop_front().map(|(value, _)| value)
    }
    pub async fn next(&mut self) -> Result<Value, Error> {
        if self.retired.is_cancelled() {
            return Err(Error::ObservationRetired);
        }
        if let Some(value) = self.pop_buffered() {
            return Ok(value);
        }
        self.next_wire().await
    }
    async fn next_wire(&mut self) -> Result<Value, Error> {
        loop {
            if self.exited.is_cancelled() && self.exit_deadline.is_none() {
                self.exit_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(1));
            }
            let deadline = self.exit_deadline;
            let cancellation = self.cancellation.clone();
            let exited = self.exited.clone();
            let failed = self.failed.clone();
            let watch_failed = self.watch_failed.clone();
            let retired = self.retired.clone();
            tokio::select! {
                biased;
                () = retired.cancelled() => return Err(Error::ObservationRetired),
                () = cancellation.cancelled() => return Err(Error::Cancelled),
                () = failed.cancelled() => return Err(Error::Unknown),
                () = watch_failed.cancelled() => return Err(Error::Unknown),
                () = async { match deadline { Some(deadline) => tokio::time::sleep_until(deadline).await, None => std::future::pending().await } } => return Err(Error::Unknown),
                value = self.line() => return value,
                () = exited.cancelled(), if deadline.is_none() => {},
            }
        }
    }
    pub async fn begin(&mut self, method: &str, params: Value) -> Result<u64, Error> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        Ok(id)
    }
    pub async fn control(&mut self, method: &str, params: Value) {
        self.next_id += 1;
        let mut value = serde_json::json!({"jsonrpc":"2.0","method":method,"params":params});
        if method == "turn/interrupt" {
            value["id"] = self.next_id.into();
        }
        self.control_message(value).await;
    }
    pub async fn control_message(&mut self, value: Value) {
        let retired = self.retired.clone();
        let exited = self.exited.clone();
        if let Some(observation) = &self.observation {
            tokio::select! {
                biased;
                () = retired.cancelled() => return,
                () = exited.cancelled() => return,
                allowed = observation.control_allowed(&self.stop) => if allowed.is_err() { return; },
            }
        }
        tokio::select! {
            biased;
            () = retired.cancelled() => {},
            _ = tokio::time::timeout(Duration::from_secs(1), self.send_wire(value)) => {},
        }
    }
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.begin(method, params).await?;
        let mut buffered_bytes: usize = self.events.iter().map(|(_, bytes)| bytes).sum();
        let deadline = tokio::time::sleep(SETUP_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            let value = tokio::select! {
                biased;
                value = self.next_wire() => value?,
                () = &mut deadline => return Err(Error::Provider(format!("Native {method} timed out")).into()),
            };
            if value.get("id").and_then(Value::as_u64) == Some(id) && value.get("method").is_none()
            {
                if value.get("error").is_some() {
                    let code = value
                        .pointer("/error/code")
                        .and_then(Value::as_i64)
                        .ok_or_else(|| Error::Invalid("Native RPC rejection has no code".into()))?;
                    let reason = string(&value, "/error/message")?;
                    return Err(RpcError::Rejected(format!(
                        "Native {method} rejected ({code}): {reason}"
                    )));
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or_else(|| Error::Invalid("Native RPC has no result".into()).into());
            }
            if value.get("method").is_some() && value.get("id").is_some() {
                return self.unsupported(value).await.map_err(Into::into);
            }
            // Startup/load notifications may contain historical tools.
            if !matches!(method, "turn/start" | "turn/steer") {
                continue;
            }
            let retained = self.line_bytes.max(1024);
            buffered_bytes += retained;
            if buffered_bytes > MAX_MESSAGE_BYTES {
                return Err(Error::Invalid(
                    "Native events before RPC acknowledgement exceed the 256 MiB retention budget"
                        .into(),
                )
                .into());
            }
            // The Pipe, not the cancellable acknowledgement future, owns live events.
            self.events.push_back((value, retained));
        }
    }
    pub async fn unsupported<T>(&mut self, request: Value) -> Result<T, Error> {
        self.send(serde_json::json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"Interactive native callbacks are unsupported; use the captured Host tools"}})).await?;
        Err(Error::Invalid(
            "Native runtime requested unsupported interactive input".into(),
        ))
    }
    async fn settle_codecs(&mut self) {
        // Settle original CPU work even when its business observation was cancelled.
        if let Some(encoding) = self.encoding.as_mut() {
            let _settled = encoding.await;
        }
        self.encoding = None;
        if let Some(parsing) = self.parsing.as_mut() {
            let _settled = parsing.await;
        }
        self.parsing = None;
    }
    async fn drain(&mut self) -> Result<(), Error> {
        self.settle_codecs().await;
        self.wire.drain().await
    }
}

pub(super) trait PipeProtocol: Send {
    type Output: Send;
    fn run<'io>(self, io: &'io mut Pipe) -> BoxFuture<'io, Result<Self::Output, Error>>
    where
        Self: 'io;
}

pub(super) async fn pipe<P: PipeProtocol>(
    command: maka_process::Command,
    transport: Transport,
    bridge: Option<Arc<mcp::Bridge>>,
    cancellation: CancellationToken,
    protocol: P,
) -> Result<P::Output, Error> {
    pipe_unowned(command, transport, bridge, cancellation, protocol).await
}

pub(super) async fn task_pipe<P: PipeProtocol>(
    owner: TaskOwner,
    observation: Observation,
    command: maka_process::Command,
    transport: Transport,
    bridge: Option<Arc<mcp::Bridge>>,
    cancellation: CancellationToken,
    protocol: P,
) -> Result<P::Output, Error> {
    pipe_owned(
        command,
        transport,
        bridge,
        cancellation,
        (owner, observation),
        protocol,
    )
    .await
}

async fn pipe_owned<P: PipeProtocol>(
    command: maka_process::Command,
    transport: Transport,
    bridge: Option<Arc<mcp::Bridge>>,
    cancellation: CancellationToken,
    owner: (TaskOwner, Observation),
    protocol: P,
) -> Result<P::Output, Error> {
    let (owner, observation) = owner;
    let mut ticket = observation
        .resources
        .reserve()
        .map_err(|_| Error::ObservationRetired)?;
    ticket.start();
    let descriptor = owner.descriptor();
    let spawned = owner.spawn_pipe(command).await;
    let process = match spawned {
        Ok(process) => process,
        Err(maka_process::isolated::SpawnError::Closed(error)) => {
            ticket.complete(Ok(()));
            return Err(isolation_error(error));
        }
        Err(maka_process::isolated::SpawnError::Unconfirmed(failure)) => {
            ticket.unconfirmed(failure.to_string(), failure);
            return Err(Error::CleanupUnconfirmed);
        }
    };
    let retired = observation.retired.clone();
    let watch_failed = CancellationToken::new();
    let exit_watch = match maka_process::isolated::EvidenceWatch::open(
        &descriptor,
        maka_process::isolated::EvidenceInterest::ChildExited,
    )
    .await
    {
        Ok(watch) => Some(watch),
        Err(error) => {
            tracing::error!(%error, "Original child-exit notification unavailable");
            watch_failed.cancel();
            None
        }
    };
    let exited = CancellationToken::new();
    let settled = CancellationToken::new();
    let actual_done = CancellationToken::new();
    let exit_task = {
        let exited = exited.clone();
        let retired = retired.clone();
        let actual_done = actual_done.clone();
        let watch_failed = watch_failed.clone();
        tokio::spawn(async move {
            let Some(mut exit_watch) = exit_watch else {
                return Ok::<_, String>(());
            };
            let observed = tokio::select! {
                biased;
                () = retired.cancelled() => Ok(()),
                () = actual_done.cancelled() => Ok(()),
                result = exit_watch.wait() => {
                    if result.is_ok() { exited.cancel(); }
                    result
                }
            };
            if let Err(error) = observed {
                tracing::error!(%error, "Original child-exit observation unavailable");
                watch_failed.cancel();
            }
            exit_watch.close().await.map_err(|error| error.to_string())
        })
    };
    let child_task = {
        let observation = observation.clone();
        let settled = settled.clone();
        let cancellation = cancellation.clone();
        tokio::spawn(async move {
            let mut child = process.child;
            let physical =
                settle_original_child(&mut child, &observation, &cancellation, &settled).await;
            if physical.is_ok()
                && let Err(error) = observation
                    .binding
                    .cleanup(OperationCleanup::Confirmed)
                    .await
            {
                tracing::error!(%error, "Original task physical cleanup ACK remains pending");
            }
            actual_done.cancel();
            (physical, child)
        })
    };
    let stderr_task = tokio::spawn(async move {
        let mut stderr = process.stderr;
        let mut buffer = [0u8; 8192];
        let result = async {
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) => return Ok::<_, String>(()),
                    Ok(_) => (),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::BrokenPipe
                                | std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                        ) =>
                    {
                        return Ok(());
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
        .await;
        (result, stderr)
    });
    let mut opening = tokio::spawn(Wire::open(process.stdin, process.stdout, transport));
    let ready = tokio::select! {
        result = &mut opening => Some(result),
        () = retired.cancelled() => None,
        () = watch_failed.cancelled() => None,
        () = async { exited.cancelled().await; tokio::time::sleep(Duration::from_secs(1)).await; } => None,
    };
    let (opened, pending_open) = match ready {
        Some(result) => (
            result
                .map_err(|error| Error::Provider(error.to_string()))
                .and_then(|result| result),
            None,
        ),
        None => {
            (
                Err(if retired.is_cancelled() {
                    Error::ObservationRetired
                } else {
                    Error::Provider("Original protocol connection unavailable after child exit or watcher failure".into())
                }),
                Some(opening),
            )
        }
    };
    let (result, io) = match opened {
        Ok(wire) => {
            let mut io = Pipe {
                wire,
                next_id: 0,
                line_bytes: 0,
                parsing: None,
                encoding: None,
                events: Default::default(),
                cancellation: cancellation.clone(),
                retired: retired.clone(),
                stop: cancellation,
                observation: Some(observation.clone()),
                exited,
                failed: bridge
                    .as_ref()
                    .map_or_else(CancellationToken::new, |bridge| bridge.failed.clone()),
                watch_failed,
                exit_deadline: None,
            };
            let result = std::panic::AssertUnwindSafe(async { protocol.run(&mut io).await })
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err(Error::Unknown));
            (result, Some(io))
        }
        Err(error) => (Err(error), None),
    };
    settled.cancel();
    if let Some(bridge) = &bridge {
        bridge.close_admission();
    }
    let (finished, finish) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let drain = async {
            match io {
                Some(mut io) => {
                    let result = io.drain().await.map_err(|error| error.to_string());
                    (result, Some(io), None)
                }
                None => match pending_open {
                    Some(opening) => match opening.await {
                        Ok(Ok(mut wire)) => {
                            let result = wire.drain().await.map_err(|error| error.to_string());
                            (result, None, Some(wire))
                        }
                        Ok(Err(_)) | Err(_) => (Ok(()), None, None),
                    },
                    None => (Ok(()), None, None),
                },
            }
        };
        let host = async {
            use maka_agent_ports::executor::RootSettlementOwner;
            if let Some(bridge) = &bridge {
                if let Err(error) = bridge.close().await {
                    tracing::error!(%error, "Original bridge settlement remains pending");
                }
                bridge.clone().original_root_cleanup_signal().await;
            }
        };
        let (child, (drained, io, wire), diagnostics, watcher, ()) =
            tokio::join!(child_task, drain, stderr_task, exit_task, host);
        if let Err(error) = &drained {
            tracing::error!(%error, "Original output stream ended with an I/O error");
        }
        if let Ok((Err(error), _)) = &diagnostics {
            tracing::error!(%error, "Original diagnostic stream ended with an I/O error");
        }
        let error = child_error(&child)
            .or_else(|| match &diagnostics {
                Err(error) => Some(error.to_string()),
                _ => None,
            })
            .or_else(|| match &watcher {
                Ok(Err(error)) => Some(error.clone()),
                Err(error) => Some(error.to_string()),
                _ => None,
            });
        let physical = error.map_or(Ok(()), Err);
        if physical.is_ok() {
            drop((child, io, wire, diagnostics, bridge));
            ticket.complete(Ok(()));
        } else {
            tracing::error!(child = ?child_error(&child), ?drained, ?watcher, "Original physical resources retained");
            ticket.unconfirmed(
                physical
                    .as_ref()
                    .expect_err("original settlement failure")
                    .clone(),
                (child, io, wire, diagnostics, bridge),
            );
        }
        let _ = finished.send(physical);
    });
    if !matches!(
        tokio::time::timeout(Duration::from_secs(6), finish).await,
        Ok(Ok(Ok(())))
    ) {
        tracing::warn!("Original physical pipe settlement retained beyond observer drain budget");
    }
    result
}

fn child_error(
    result: &Result<(Result<(), String>, maka_process::pipe::Child), tokio::task::JoinError>,
) -> Option<String> {
    match result {
        Ok((Err(error), child)) => {
            #[cfg(unix)]
            if child.local_resources_closed() {
                return None;
            }
            #[cfg(not(unix))]
            let _ = child;
            Some(error.clone())
        }
        Err(error) => Some(error.to_string()),
        _ => None,
    }
}

pub(super) async fn settle_original_child(
    child: &mut maka_process::pipe::Child,
    observation: &Observation,
    stop: &CancellationToken,
    settled: &CancellationToken,
) -> Result<(), String> {
    tokio::select! {
        biased;
        result = async {
            match original_child_wait(child, observation, stop, settled).await {
                Ok(()) => Ok(()),
                Err(error) => {
                    tracing::debug!(%error, "Original child still owned after observation ended");
                    child.wait().await.map(|_| ()).map_err(|error| error.to_string())
                }
            }
        } => result,
        () = observation.owner_stop.cancelled() => {
            child.terminate().await.map_err(|error| error.to_string())?;
            child.wait().await.map(|_| ()).map_err(|error| error.to_string())
        }
    }
}

async fn original_child_wait(
    child: &mut maka_process::pipe::Child,
    observation: &Observation,
    stop: &CancellationToken,
    settled: &CancellationToken,
) -> Result<(), Error> {
    tokio::select! {
        biased;
        status = child.wait() => status.map(|_| ()).map_err(|_| Error::CleanupUnconfirmed),
        () = settled.cancelled() => {
            match tokio::time::timeout(Duration::from_millis(500), async {
                tokio::select! {
                    biased;
                    status = child.wait() => status.map(|_| ()).map_err(|_| Error::CleanupUnconfirmed),
                    () = observation.retired.cancelled() => {
                        observation.owner_cleanup_allowed(stop).await?;
                        child.terminate().await.map_err(|_| Error::CleanupUnconfirmed)?;
                        child.wait().await.map(|_| ()).map_err(|_| Error::CleanupUnconfirmed)
                    }
                }
            }).await {
                Ok(result) => result,
                Err(_) => {
                    tokio::select! {
                        status = child.wait() => return status.map(|_| ()).map_err(|_| Error::CleanupUnconfirmed),
                        allowed = observation.owner_cleanup_allowed(stop) => allowed?,
                    }
                    child.terminate().await.map_err(|_| Error::CleanupUnconfirmed)?;
                    tokio::time::timeout(Duration::from_secs(4), child.wait()).await.map_err(|_| Error::CleanupUnconfirmed)?.map(|_| ()).map_err(|_| Error::CleanupUnconfirmed)
                }
            }
        }
        () = observation.retired.cancelled() => {
            observation.owner_cleanup_allowed(stop).await?;
            child.terminate().await.map_err(|_| Error::CleanupUnconfirmed)?;
            tokio::time::timeout(Duration::from_secs(4), child.wait()).await.map_err(|_| Error::CleanupUnconfirmed)?.map(|_| ()).map_err(|_| Error::CleanupUnconfirmed)
        },
    }
}

async fn pipe_unowned<P: PipeProtocol>(
    command: maka_process::Command,
    transport: Transport,
    bridge: Option<Arc<mcp::Bridge>>,
    cancellation: CancellationToken,
    protocol: P,
) -> Result<P::Output, Error> {
    let retired = CancellationToken::new();
    let soft_stop = cancellation.clone();
    let spawned = maka_process::pipe::spawn(command)
        .await
        .map_err(process_error);
    let mut process = match spawned {
        Ok(process) => process,
        Err(error) => {
            let closed = match &bridge {
                Some(bridge) => bridge.close().await,
                None => Ok(()),
            };
            return closed.and(Err(error));
        }
    };
    let exited = CancellationToken::new();
    let settle = CancellationToken::new();
    let lifecycle = async {
        let result = async {
            tokio::select! {
                biased;
                () = retired.cancelled() => Err(Error::ObservationRetired),
                status = process.child.wait() => status.map(|_| ()).map_err(|_| Error::CleanupUnconfirmed),
                () = settle.cancelled() => {
                    match tokio::time::timeout(Duration::from_millis(500), private_wait(&mut process.child, &retired)).await {
                        Ok(result) => result,
                        Err(_) => {
                            if retired.is_cancelled() { return Err(Error::ObservationRetired); }
                    process.child.terminate().await.map_err(|_| Error::CleanupUnconfirmed)?;
                            tokio::time::timeout(Duration::from_secs(4), private_wait(&mut process.child, &retired)).await.map_err(|_| Error::CleanupUnconfirmed)?
                        }
                    }
                }
            }
        }.await;
        if let Some(bridge) = &bridge {
            bridge.close_admission();
        }
        exited.cancel();
        result
    };
    let business = async {
        let opened = Wire::open(process.stdin, process.stdout, transport).await;
        let (result, io) = match opened {
            Ok(wire) => {
                let mut io = Pipe {
                    wire,
                    next_id: 0,
                    line_bytes: 0,
                    parsing: None,
                    encoding: None,
                    events: Default::default(),
                    cancellation,
                    retired: retired.clone(),
                    stop: soft_stop.clone(),
                    observation: None,
                    exited: exited.clone(),
                    failed: bridge
                        .as_ref()
                        .map_or_else(CancellationToken::new, |bridge| bridge.failed.clone()),
                    watch_failed: CancellationToken::new(),
                    exit_deadline: None,
                };
                let result = std::panic::AssertUnwindSafe(async { protocol.run(&mut io).await })
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| Err(Error::Unknown));
                (result, Some(io))
            }
            Err(error) => (Err(error), None),
        };
        let host = match &bridge {
            Some(bridge) => bridge.close().await,
            None => Ok(()),
        };
        if !retired.is_cancelled() {
            settle.cancel();
        }
        if let Some(mut io) = io {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
            // The wire budget cannot turn an original CPU worker into detached work.
            io.settle_codecs().await;
            if !retired.is_cancelled() {
                if tokio::time::Instant::now() >= deadline {
                    return Err(Error::CleanupUnconfirmed);
                }
                tokio::select! {
                    biased;
                    () = retired.cancelled() => {},
                    result = tokio::time::timeout_at(deadline, io.wire.drain()) => result.map_err(|_| Error::CleanupUnconfirmed)??,
                }
            }
        }
        host?;
        result
    };
    let stderr = async {
        let mut bytes = [0u8; 8192];
        loop {
            let read = tokio::select! {
                biased;
                () = retired.cancelled() => return Ok(()),
                () = exited.cancelled() => return tokio::time::timeout(Duration::from_secs(1), async {
                    loop { if process.stderr.read(&mut bytes).await.map_err(|_| Error::CleanupUnconfirmed)? == 0 { return Ok::<_, Error>(()); } }
                }).await.map_err(|_| Error::CleanupUnconfirmed)?,
                result = process.stderr.read(&mut bytes) => result.map_err(|_| Error::CleanupUnconfirmed)?,
            };
            if read == 0 {
                return Ok(());
            }
        }
    };
    let (status, result, diagnostics) = tokio::join!(lifecycle, business, stderr);
    if matches!(&result, Err(Error::Persistence(_))) {
        return result;
    }
    status?;
    diagnostics?;
    result
}
pub(super) async fn private_wait(
    child: &mut maka_process::pipe::Child,
    retired: &CancellationToken,
) -> Result<(), Error> {
    tokio::select! {
        biased;
        () = retired.cancelled() => Err(Error::ObservationRetired),
        status = child.wait() => status.map(|_| ()).map_err(|_| Error::CleanupUnconfirmed),
    }
}
pub(super) fn isolation_error(error: maka_process::isolated::Error) -> Error {
    match error {
        maka_process::isolated::Error::IsolationUnavailable(message) => {
            Error::IsolationUnavailable(message)
        }
        maka_process::isolated::Error::CaptureUnstable(_) => Error::Unknown,
        maka_process::isolated::Error::CaptureUnsupported(message) => {
            Error::IsolationUnavailable(message)
        }
        maka_process::isolated::Error::Cancelled => Error::Cancelled,
        maka_process::isolated::Error::Io(error) => Error::Provider(error.to_string()),
    }
}
pub(super) fn process_error(error: maka_agent_facts::tools::ToolError) -> Error {
    match error {
        maka_agent_facts::tools::ToolError::CleanupUnconfirmed(_) => Error::CleanupUnconfirmed,
        error => Error::Provider(error.to_string()),
    }
}
pub(super) fn string<'a>(value: &'a Value, pointer: &str) -> Result<&'a str, Error> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::Invalid(format!("Native response missing {pointer}")))
}
