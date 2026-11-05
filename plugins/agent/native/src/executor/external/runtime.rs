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
use std::{future::Future, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_LINE: usize = 8 * 1024 * 1024;
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
                        | "--config"
                        | "-c"
                        | "--enable"
                        | "--disable"
                        | "--listen"
                        | "exec"
                        | "resume"
                        | "app-server"
                ) || (!key.starts_with("--")
                    && ["-c", "-a", "-s"]
                        .iter()
                        .any(|prefix| key.starts_with(prefix)))
            }
            NativeRuntime::Antigravity => matches!(
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
            ),
        };
        if forbidden || arg.contains('\0') {
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
    tools: tools::Tools,
    cancellation: CancellationToken,
) -> Result<Outcome, Error> {
    let bridge = mcp::Bridge::open(tools).await?;
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
            )
            .await
        }
        NativeRuntime::Antigravity | NativeRuntime::Codex => {
            let mut plan = match command(config, cwd).await {
                Ok(plan) => plan,
                Err(error) => {
                    bridge.close().await?;
                    return Err(error);
                }
            };
            if runtime == NativeRuntime::Antigravity {
                plan.arg("acp").arg("--dangerously-skip-permissions");
            } else {
                plan.arg("app-server");
                plan.env("MAKA_NATIVE_MCP_TOKEN", bridge.bearer());
            }
            pipe(
                plan,
                Some(bridge.clone()),
                cancellation.clone(),
                |io| async move {
                    match runtime {
                        NativeRuntime::Antigravity => {
                            agy::execute(io, &request, storage, running, output, bridge).await
                        }
                        NativeRuntime::Codex => {
                            codex::execute(io, &request, storage, running, output, bridge).await
                        }
                        NativeRuntime::Claude => unreachable!("Claude uses the native PTY"),
                    }
                },
            )
            .await
        }
    };
    let result = if cancellation.is_cancelled()
        && !matches!(
            result,
            Err(Error::CleanupUnconfirmed | Error::Unknown | Error::Persistence(_))
        ) {
        Err(Error::Cancelled)
    } else {
        result
    };
    // An uncorrelated/missing terminal stays fenced; never turn a crashed request into a replayable one.
    if matches!(result, Ok(_) | Err(Error::Cancelled)) {
        journal.ready(storage).await?;
    }
    result
}

pub(super) struct Pipe {
    pub input: maka_process::pipe::Input,
    reader: BufReader<maka_process::pipe::Output>,
    buffer: Vec<u8>,
    next_id: u64,
    line_bytes: usize,
    cancellation: CancellationToken,
    exited: CancellationToken,
    failed: CancellationToken,
    exit_deadline: Option<tokio::time::Instant>,
}
impl Pipe {
    pub async fn send(&mut self, value: Value) -> Result<(), Error> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| Error::Invalid(e.to_string()))?;
        bytes.push(b'\n');
        tokio::select! {
            biased;
            () = self.cancellation.cancelled() => Err(Error::Cancelled),
            result = self.input.write_all(&bytes) => result.map_err(|e| Error::Provider(e.to_string())),
        }
    }
    pub async fn notify(&mut self, method: &str, params: Value) -> Result<(), Error> {
        self.send(serde_json::json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }
    async fn line(&mut self) -> Result<Value, Error> {
        loop {
            let available = self
                .reader
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
            if self.buffer.len() + count > MAX_LINE {
                return Err(Error::Invalid("Native protocol line exceeds 8 MiB".into()));
            }
            let complete = available[count - 1] == b'\n';
            self.buffer.extend_from_slice(&available[..count]);
            self.reader.consume(count);
            if complete {
                self.line_bytes = self.buffer.len();
                let parsed = serde_json::from_slice(&self.buffer)
                    .map_err(|_| Error::Invalid("Malformed native JSON-RPC line".into()));
                self.buffer.clear();
                return parsed;
            }
        }
    }
    pub async fn next(&mut self) -> Result<Value, Error> {
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
        let mut bytes = serde_json::to_vec(&value).expect("native control is JSON");
        bytes.push(b'\n');
        let _ = tokio::time::timeout(Duration::from_secs(1), self.input.write_all(&bytes)).await;
    }
    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<(Value, Vec<Value>), Error> {
        let id = self.begin(method, params).await?;
        let mut events = Vec::new();
        let mut buffered_bytes = 0;
        let deadline = tokio::time::sleep(Duration::from_secs(30));
        tokio::pin!(deadline);
        loop {
            let value = tokio::select! { biased; value = self.next() => value?, () = &mut deadline => return Err(Error::Provider(format!("Native {method} timed out"))) };
            if value.get("id").and_then(Value::as_u64) == Some(id) && value.get("method").is_none()
            {
                if value.get("error").is_some() {
                    return Err(Error::Provider(format!(
                        "Native {method} rejected the request"
                    )));
                }
                return Ok((
                    value
                        .get("result")
                        .cloned()
                        .ok_or_else(|| Error::Invalid("Native RPC has no result".into()))?,
                    events,
                ));
            }
            if value.get("method").is_some() && value.get("id").is_some() {
                return self.unsupported(value).await;
            }
            // Startup/load notifications can contain historical tools; consume without projection or retention.
            if method != "turn/start" {
                continue;
            }
            buffered_bytes += self.line_bytes;
            if events.len() == 128 || buffered_bytes > MAX_LINE {
                return Err(Error::Invalid(
                    "Too many native events before RPC acknowledgement".into(),
                ));
            }
            events.push(value);
        }
    }
    pub async fn unsupported<T>(&mut self, request: Value) -> Result<T, Error> {
        self.send(serde_json::json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"Interactive native callbacks are unsupported; use the captured Host tools"}})).await?;
        Err(Error::Invalid(
            "Native runtime requested unsupported interactive input".into(),
        ))
    }
    async fn drain(&mut self) -> Result<(), Error> {
        let _ = self.input.shutdown().await;
        let mut bytes = [0u8; 8192];
        loop {
            if self
                .reader
                .read(&mut bytes)
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?
                == 0
            {
                return Ok(());
            }
        }
    }
}

pub(super) async fn pipe<T, F, Fut>(
    command: maka_process::Command,
    bridge: Option<Arc<mcp::Bridge>>,
    cancellation: CancellationToken,
    protocol: F,
) -> Result<T, Error>
where
    F: FnOnce(Pipe) -> Fut,
    Fut: Future<Output = (Result<T, Error>, Pipe)>,
{
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
        let status = tokio::select! { result = process.child.wait() => result, () = settle.cancelled() => {
            match tokio::time::timeout(Duration::from_millis(500), process.child.wait()).await {
                Ok(status) => status,
                Err(_) => {
                    process.child.terminate().map_err(|_| Error::CleanupUnconfirmed)?;
                    tokio::time::timeout(Duration::from_secs(4), process.child.wait()).await.map_err(|_| Error::CleanupUnconfirmed)?
                }
            }
        }};
        status.map_err(|_| Error::CleanupUnconfirmed)
        }.await;
        if let Some(bridge) = &bridge {
            bridge.close_admission();
        }
        exited.cancel();
        result
    };
    let business = async {
        let io = Pipe {
            input: process.stdin,
            reader: BufReader::new(process.stdout),
            buffer: Vec::new(),
            next_id: 0,
            line_bytes: 0,
            cancellation,
            exited: exited.clone(),
            failed: bridge
                .as_ref()
                .map_or_else(CancellationToken::new, |bridge| bridge.failed.clone()),
            exit_deadline: None,
        };
        let (result, mut io) = protocol(io).await;
        let host = match &bridge {
            Some(bridge) => bridge.close().await,
            None => Ok(()),
        };
        settle.cancel();
        // A fixed drain deadline starts at settlement, independent of chatty output.
        let drain = tokio::time::timeout(Duration::from_secs(6), io.drain())
            .await
            .map_err(|_| Error::CleanupUnconfirmed)
            .and_then(|v| v);
        drain?;
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
        for (runtime, args) in [
            (NativeRuntime::Claude, vec!["--print"]),
            (NativeRuntime::Claude, vec!["-phello"]),
            (NativeRuntime::Claude, vec!["--permission-mode=default"]),
            (NativeRuntime::Codex, vec!["--sandbox=read-only"]),
            (
                NativeRuntime::Codex,
                vec!["-c", "approval_policy=on-request"],
            ),
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
