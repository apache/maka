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
use futures_util::{SinkExt, StreamExt};
use std::{future::Future, time::Duration};
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
pub(super) fn instruction_message(text: &str) -> String {
    format!("<maka_system_instructions>\n{text}\n</maka_system_instructions>")
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
                    "--approval-mode"
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
pub(super) async fn executable(config: &NativeCommand, cwd: &str) -> Option<PathBuf> {
    let executable = std::path::Path::new(&config.executable);
    let candidates = if executable.is_absolute() {
        vec![executable.to_owned()]
    } else if executable.components().count() > 1 {
        vec![std::path::Path::new(cwd).join(executable)]
    } else {
        let search = config
            .env
            .get("PATH")
            .map(std::ffi::OsString::from)
            .or_else(|| std::env::var_os("PATH"))?;
        let mut candidates = Vec::new();
        for directory in std::env::split_paths(&search) {
            let directory = if directory.is_absolute() {
                directory
            } else {
                std::path::Path::new(cwd).join(directory)
            };
            candidates.push(directory.join(executable));
            #[cfg(windows)]
            for extension in ["exe", "cmd", "bat"] {
                candidates.push(directory.join(executable).with_extension(extension));
            }
        }
        candidates
    };
    for path in candidates {
        if let Ok(metadata) = tokio::fs::metadata(&path).await {
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
            return Some(path);
        }
    }
    None
}
pub(super) async fn command(
    config: &NativeCommand,
    cwd: &str,
) -> Result<maka_process::Command, Error> {
    let executable = executable(config, cwd).await.ok_or_else(|| {
        Error::Provider("Native executable is unavailable on the configured PATH".into())
    })?;
    let mut command = maka_process::Command::new(executable, cwd);
    for arg in &config.args {
        command.arg(arg);
    }
    for (key, value) in &config.env {
        command.env(key, value);
    }
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
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    cancellation: CancellationToken,
    steering: &mut steering::Steering,
) -> Result<Outcome, Error> {
    let retained = bridge.clone();
    let running = &mut *journal;
    let result = match runtime {
        NativeRuntime::Claude => {
            claude::execute(
                config,
                cwd,
                &request,
                storage,
                running,
                output,
                bridge,
                cancellation.clone(),
                steering,
            )
            .await
        }
        NativeRuntime::Antigravity => {
            agy::execute(
                config,
                cwd,
                &request,
                storage,
                running,
                output,
                bridge,
                cancellation.clone(),
                steering,
            )
            .await
        }
        NativeRuntime::Codex => match codex::proxy(config, cwd, cancellation.clone()).await {
            Err(error) => Err(error),
            Ok(proxy) => {
                pipe(
                    proxy,
                    Transport::WebSocket,
                    Some(bridge.clone()),
                    cancellation.clone(),
                    |io| async move {
                        codex::execute(io, &request, storage, running, output, bridge, steering)
                            .await
                    },
                )
                .await
            }
        },
    };
    let closed = retained.close().await;
    let mut result = match (result, closed) {
        (Err(Error::CleanupUnconfirmed), _) | (_, Err(Error::CleanupUnconfirmed)) => {
            Err(Error::CleanupUnconfirmed)
        }
        (_, Err(error)) => Err(error),
        (result, Ok(())) => result,
    };
    result = if cancellation.is_cancelled()
        && !matches!(
            result,
            Err(Error::CleanupUnconfirmed | Error::Unknown | Error::Persistence(_))
        ) {
        Err(Error::Cancelled)
    } else {
        result
    };
    // An uncorrelated/missing terminal stays fenced; never turn a crashed request into a replayable one.
    if matches!(result, Ok(_) | Err(Error::Cancelled))
        && let Err(error) = journal.ready(storage).await
    {
        result = Err(error);
    }
    retained.settled(&result);
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
    async fn send(&mut self, value: Value) -> Result<(), Error> {
        let mut text = serde_json::to_string(&value).map_err(|e| Error::Invalid(e.to_string()))?;
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
                    if reader
                        .read(&mut bytes)
                        .await
                        .map_err(|_| Error::CleanupUnconfirmed)?
                        == 0
                    {
                        return Ok(());
                    }
                }
            }
            Self::WebSocket(socket) => {
                // Closing this client retires only the proxy connection, never the shared daemon.
                let _ = socket.as_mut().close(None).await;
                let _ = socket.get_mut().writer_mut().shutdown().await;
                let mut bytes = [0u8; 8192];
                loop {
                    if socket
                        .get_mut()
                        .reader_mut()
                        .read(&mut bytes)
                        .await
                        .map_err(|_| Error::CleanupUnconfirmed)?
                        == 0
                    {
                        break;
                    }
                }
                Ok(())
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
    events: std::collections::VecDeque<(Value, usize)>,
    pub cancellation: CancellationToken,
    pub interrupt: Option<tokio::sync::oneshot::Sender<()>>,
    exited: CancellationToken,
    pub failed: CancellationToken,
    exit_deadline: Option<tokio::time::Instant>,
}
impl Pipe {
    pub async fn send(&mut self, value: Value) -> Result<(), Error> {
        tokio::select! {
            biased;
            () = self.cancellation.cancelled() => Err(Error::Cancelled),
            result = self.wire.send(value) => result,
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
            tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(Error::Cancelled),
                () = failed.cancelled() => return Err(Error::Unknown),
                () = async { match deadline { Some(deadline) => tokio::time::sleep_until(deadline).await, None => std::future::pending().await } } => return Err(Error::CleanupUnconfirmed),
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
        let _ = tokio::time::timeout(Duration::from_secs(1), self.wire.send(value)).await;
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
    async fn drain(&mut self) -> Result<(), Error> {
        self.wire.drain().await
    }
}

pub(super) async fn pipe<T, F, Fut>(
    command: maka_process::Command,
    transport: Transport,
    bridge: Option<Arc<mcp::Bridge>>,
    cancellation: CancellationToken,
    protocol: F,
) -> Result<T, Error>
where
    F: FnOnce(Pipe) -> Fut,
    Fut: Future<Output = (Result<T, Error>, Pipe)>,
{
    pipe_owned(command, transport, bridge, cancellation, None, protocol).await
}

#[cfg(unix)]
pub(super) async fn interruptible_pipe<T, F, Fut>(
    command: maka_process::Command,
    transport: Transport,
    bridge: Option<Arc<mcp::Bridge>>,
    cancellation: CancellationToken,
    protocol: F,
) -> Result<T, Error>
where
    F: FnOnce(Pipe) -> Fut,
    Fut: Future<Output = (Result<T, Error>, Pipe)>,
{
    let interrupt = tokio::sync::oneshot::channel();
    pipe_owned(
        command,
        transport,
        bridge,
        cancellation,
        Some(interrupt),
        protocol,
    )
    .await
}

async fn pipe_owned<T, F, Fut>(
    command: maka_process::Command,
    transport: Transport,
    bridge: Option<Arc<mcp::Bridge>>,
    cancellation: CancellationToken,
    interrupt: Option<(
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    )>,
    protocol: F,
) -> Result<T, Error>
where
    F: FnOnce(Pipe) -> Fut,
    Fut: Future<Output = (Result<T, Error>, Pipe)>,
{
    let (interrupt_send, mut interrupt_receive) = match interrupt {
        Some((send, receive)) => (Some(send), Some(receive)),
        None => (None, None),
    };
    let mut process = match maka_process::pipe::spawn(command).await {
        Ok(process) => process,
        Err(error) => {
            let closed = match &bridge {
                Some(bridge) => bridge.close().await,
                None => Ok(()),
            };
            return closed.and(Err(process_error(error)));
        }
    };
    let exited = CancellationToken::new();
    let settle = CancellationToken::new();
    let lifecycle = async {
        let result = async {
            loop {
                tokio::select! {
                    biased;
                    status = process.child.wait() => {
                        status.map_err(|_| Error::CleanupUnconfirmed)?;
                        return Ok(());
                    }
                    request = async {
                        match interrupt_receive.as_mut() {
                            Some(receive) => receive.await,
                            None => std::future::pending().await,
                        }
                    } => {
                        interrupt_receive = None;
                        if request.is_err() { continue; }
                        if let Some(bridge) = &bridge { bridge.close_admission(); }
                        #[cfg(unix)]
                        let signalled = process.child.interrupt_group();
                        #[cfg(not(unix))]
                        let signalled: std::io::Result<bool> = Err(std::io::Error::other("native SIGINT unavailable"));
                        if signalled.is_ok()
                            && let Ok(Ok(_)) = tokio::time::timeout(INTERRUPT_TIMEOUT, process.child.wait()).await
                        {
                            return Ok(());
                        }
                        // Force is cleanup only: even a reaped tree cannot prove native interruption.
                        process.child.terminate().map_err(|_| Error::CleanupUnconfirmed)?;
                        tokio::time::timeout(Duration::from_secs(4), process.child.wait()).await
                            .map_err(|_| Error::CleanupUnconfirmed)?
                            .map_err(|_| Error::CleanupUnconfirmed)?;
                        return Err(Error::CleanupUnconfirmed);
                    }
                    () = settle.cancelled() => {
                        match tokio::time::timeout(Duration::from_millis(500), process.child.wait()).await {
                            Ok(status) => { status.map_err(|_| Error::CleanupUnconfirmed)?; }
                            Err(_) => {
                                process.child.terminate().map_err(|_| Error::CleanupUnconfirmed)?;
                                tokio::time::timeout(Duration::from_secs(4), process.child.wait()).await
                                    .map_err(|_| Error::CleanupUnconfirmed)?
                                    .map_err(|_| Error::CleanupUnconfirmed)?;
                            }
                        }
                        return Ok(());
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
                let io = Pipe {
                    wire,
                    next_id: 0,
                    line_bytes: 0,
                    parsing: None,
                    events: Default::default(),
                    cancellation,
                    interrupt: interrupt_send,
                    exited: exited.clone(),
                    failed: bridge
                        .as_ref()
                        .map_or_else(CancellationToken::new, |bridge| bridge.failed.clone()),
                    exit_deadline: None,
                };
                let (result, io) = protocol(io).await;
                (result, Some(io))
            }
            Err(error) => (Err(error), None),
        };
        let host = match &bridge {
            Some(bridge) => bridge.close().await,
            None => Ok(()),
        };
        settle.cancel();
        if let Some(mut io) = io {
            tokio::time::timeout(Duration::from_secs(6), io.drain())
                .await
                .map_err(|_| Error::CleanupUnconfirmed)??;
        }
        host?;
        result
    };
    let stderr = async {
        let mut bytes = [0u8; 8192];
        loop {
            let read = tokio::select! {
                biased;
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
    status?;
    diagnostics?;
    result
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_overrides_cannot_change_permission_or_interactive_protocol() {
        let configured = NativeCommand {
            executable: "fixture".into(),
            args: [
                "-c",
                "approval_policy=on-request",
                "--config",
                "model=custom",
                "--enable",
                "custom_feature",
                "--disable",
                "another_feature",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            env: BTreeMap::new(),
        };
        assert!(validate_command(NativeRuntime::Codex, &configured).is_ok());
        for (runtime, args) in [
            (NativeRuntime::Claude, vec!["--print"]),
            (NativeRuntime::Claude, vec!["-phello"]),
            (NativeRuntime::Claude, vec!["--permission-mode=default"]),
            (NativeRuntime::Codex, vec!["--sandbox=read-only"]),
            (NativeRuntime::Codex, vec!["--listen=stdio://"]),
            (NativeRuntime::Antigravity, vec!["--mode=default"]),
        ] {
            let config = NativeCommand {
                executable: "fixture".into(),
                args: args.into_iter().map(str::to_owned).collect(),
                env: BTreeMap::new(),
            };
            assert!(validate_command(runtime, &config).is_err(), "{runtime:?}");
        }
    }
}
