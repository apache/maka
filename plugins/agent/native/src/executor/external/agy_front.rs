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
use futures_util::StreamExt;
use maka_process::isolated::{Descriptor, SessionSpool, TaskOwner};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::watch;
use tokio_util::codec::{FramedRead, LinesCodec};

/// Private helper mode for a single isolated Antigravity ACP Run.
pub const FRONT_HELPER: &str = "--maka-agy-acp-front";

const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Serialize, Deserialize)]
struct Launch {
    executable: PathBuf,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    resource: Descriptor,
}

pub(super) struct Session {
    pub stdin: ChildStdin,
    pub stdout: BufReader<Box<dyn AsyncRead + Unpin + Send>>,
    pub child: Child,
}

pub(super) enum OpenError {
    BeforeLaunch(Box<TaskOwner>, Error),
    Closed(Error),
    Unconfirmed(Error),
}

pub(super) async fn open(
    config: &NativeCommand,
    cwd: &str,
    owner: TaskOwner,
    cancellation: &CancellationToken,
    retired: &CancellationToken,
) -> Result<Session, OpenError> {
    let resolved = match runtime::resolve(config, cwd).await.require() {
        Ok(resolved) => resolved.executable,
        Err(error) => return Err(OpenError::BeforeLaunch(Box::new(owner), error)),
    };
    let resource = match owner.prepare_session(resolved.clone()).await {
        Ok(resource) => resource,
        Err(error) => return Err(OpenError::BeforeLaunch(Box::new(owner), provider(error))),
    };
    let start = match serde_json::to_vec(&Launch {
        executable: resolved,
        args: config.args.clone(),
        env: config.env.clone(),
        resource: resource.clone(),
    }) {
        Ok(start) => start,
        Err(error) => return Err(OpenError::BeforeLaunch(Box::new(owner), provider(error))),
    };

    let mut command = tokio::process::Command::new(owner.helper_executable());
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB);
    let mut child = match command
        .arg(FRONT_HELPER)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return Err(OpenError::BeforeLaunch(Box::new(owner), provider(error))),
    };
    // Helper is now running and owns the session spool; seal/reap via wait_for_close on any error.
    drop(owner);

    let mut stdin = child.stdin.take().expect("piped helper stdin");
    let mut stdout: BufReader<Box<dyn AsyncRead + Unpin + Send>> =
        BufReader::new(Box::new(child.stdout.take().expect("piped helper stdout")));

    let ready = async {
        stdin.write_all(&start).await.map_err(provider)?;
        stdin.write_all(b"\n").await.map_err(provider)?;
        stdin.flush().await.map_err(provider)?;
        let mut line = String::new();
        let read = tokio::select! {
            biased;
            () = retired.cancelled() => return Err(Error::ObservationRetired),
            () = cancellation.cancelled() => return Err(Error::Cancelled),
            result = tokio::time::timeout(runtime::SETUP_TIMEOUT, stdout.read_line(&mut line)) => {
                result
                    .map_err(|_| provider("agy ACP supervisor timed out during startup"))?
                    .map_err(provider)?
            }
        };
        if read == 0 {
            return Err(provider("agy ACP supervisor exited during startup"));
        }
        let status = line.trim_end_matches(['\r', '\n']);
        if status != "ready" {
            return Err(provider(status));
        }
        Ok(())
    }
    .await;

    match ready {
        Ok(()) => Ok(Session {
            stdin,
            stdout,
            child,
        }),
        Err(error) => {
            drop(stdin);
            drop(stdout);
            match wait_for_close(&resource, child).await {
                Ok(()) => Err(OpenError::Closed(error)),
                Err(_) => Err(OpenError::Unconfirmed(error)),
            }
        }
    }
}

pub(super) async fn wait_for_close(resource: &Descriptor, mut child: Child) -> io::Result<()> {
    use maka_process::isolated::{EvidenceInterest, EvidenceWatch, cleanup_evidence};
    let mut watch = EvidenceWatch::open(resource, EvidenceInterest::Cleanup)
        .await
        .map_err(io::Error::other)?;
    let observed = tokio::select! {
        result = watch.wait() => {
            let result = result.map_err(io::Error::other);
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            result
        }
        status = child.wait() => {
            let status = status?;
            match cleanup_evidence(resource).await.map_err(io::Error::other)? {
                Some(_) => Ok(()),
                None => Err(io::Error::other(format!(
                    "agy ACP supervisor exited ({status}) without a session closure receipt"
                ))),
            }
        }
    };
    watch.close().await.map_err(io::Error::other)?;
    observed
}

fn provider(error: impl std::fmt::Display) -> Error {
    Error::Provider(error.to_string())
}

enum SessionState {
    Opening {
        open_request_id: Option<u64>,
        resume_session_id: Option<String>,
    },
    Open {
        session_id: String,
    },
    Closing {
        close_id: u64,
    },
}

fn frames(read: impl AsyncRead) -> FramedRead<impl AsyncRead, LinesCodec> {
    FramedRead::new(
        read,
        LinesCodec::new_with_max_length(runtime::MAX_MESSAGE_BYTES),
    )
}

async fn write_line(dest: &mut (impl AsyncWrite + Unpin), row: &str) -> io::Result<()> {
    dest.write_all(row.as_bytes()).await?;
    dest.write_all(b"\n").await
}

async fn write_json_line(dest: &mut (impl AsyncWrite + Unpin), value: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    dest.write_all(&bytes).await
}

async fn copy_committed(
    mut file: tokio::fs::File,
    mut destination: impl AsyncWrite + Unpin,
    mut committed: watch::Receiver<u64>,
) -> io::Result<()> {
    let mut offset = 0;
    loop {
        let end = *committed.borrow_and_update();
        if end > offset {
            let copied =
                tokio::io::copy(&mut (&mut file).take(end - offset), &mut destination).await?;
            if copied != end - offset {
                return Err(io::Error::other("short ACP session transcript"));
            }
            destination.flush().await?;
            offset = end;
        }
        if committed.changed().await.is_err() {
            return Ok(());
        }
    }
}

async fn emit_output(
    spool: &mut SessionSpool,
    written: &watch::Sender<u64>,
    row: &str,
) -> io::Result<()> {
    spool.output.write_all(row.as_bytes()).await?;
    spool.output.write_all(b"\n").await?;
    spool.output.flush().await?;
    written.send_modify(|n| *n += row.len() as u64 + 1);
    Ok(())
}

pub async fn serve_front() -> io::Result<()> {
    let mut host_in = frames(tokio::io::stdin());
    let first = host_in
        .next()
        .await
        .ok_or(io::ErrorKind::UnexpectedEof)?
        .map_err(io::Error::other)?;
    let launch: Launch = serde_json::from_str(&first)?;
    let stdout_path = launch.resource.resource_ref.join("owner/stdout.bin");
    let mut spool = SessionSpool::open(launch.resource).await?;
    let mut host_out = tokio::io::stdout();

    let spawn = async {
        let profile = agy::host_agent_directory()
            .await
            .map_err(io::Error::other)?;
        let temp = tempfile::Builder::new().prefix("maka-agy-").tempdir()?;
        let mut cmd = maka_process::Command::new(launch.executable, &profile);
        for arg in launch.args {
            cmd.arg(arg);
        }
        for (key, value) in launch.env {
            cmd.env(key, value);
        }
        for key in ["TMPDIR", "TMP", "TEMP"] {
            cmd.env(key, temp.path());
        }
        cmd.args([
            "acp",
            "--process-per-session",
            "--dangerously-skip-permissions",
            "--agent",
            agy::HOST_AGENT,
            "--add-dir",
        ])
        .arg(&profile);
        let spawned = maka_process::pipe::spawn(cmd)
            .await
            .map_err(io::Error::other)?;
        Ok::<_, io::Error>((temp, spawned))
    }
    .await;

    let (_temp, spawned) = match spawn {
        Ok(started) => started,
        Err(error) => {
            let _ = host_out.write_all(format!("{error}\n").as_bytes()).await;
            let _ = host_out.flush().await;
            let _ = spool.seal().await;
            return Err(error);
        }
    };

    let maka_process::pipe::Spawned {
        mut child,
        mut stdin,
        stdout,
        mut stderr,
    } = spawned;

    let diagnostics =
        tokio::spawn(async move { tokio::io::copy(&mut stderr, &mut tokio::io::stderr()).await });
    let stdout_reader = match tokio::fs::File::open(&stdout_path).await {
        Ok(file) => file,
        Err(error) => {
            let _ = host_out.write_all(format!("{error}\n").as_bytes()).await;
            let _ = host_out.flush().await;
            let _ = child.terminate().await;
            let _ = child.wait().await;
            let _ = diagnostics.await;
            let _ = spool.seal().await;
            return Err(error);
        }
    };

    host_out.write_all(b"ready\n").await?;
    host_out.flush().await?;

    let (written, committed) = watch::channel(0u64);
    let forward = tokio::spawn(async move {
        if let Err(error) = copy_committed(stdout_reader, host_out, committed).await
            && !matches!(
                error.kind(),
                io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
            )
        {
            eprintln!("agy ACP session output: {error}");
        }
    });

    let mut agy_out = frames(stdout);
    let mut state = SessionState::Opening {
        open_request_id: None,
        resume_session_id: None,
    };
    let mut max_client_id = 0u64;
    let mut host_detached = false;
    let mut close_deadline: Option<tokio::time::Instant> = None;

    let pump: io::Result<()> = async {
        loop {
            tokio::select! {
                row = host_in.next(), if !host_detached => match row {
                    Some(Ok(row)) => {
                        write_line(&mut spool.input, &row).await?;
                        spool.input.flush().await?;
                        let msg: Value = serde_json::from_str(&row)?;
                        if let Some(id) = msg["id"].as_u64() {
                            max_client_id = max_client_id.max(id);
                            if let SessionState::Opening { open_request_id, resume_session_id } = &mut state
                                && matches!(msg["method"].as_str(), Some("session/new" | "session/resume"))
                            {
                                *open_request_id = Some(id);
                                *resume_session_id = msg
                                    .pointer("/params/sessionId")
                                    .and_then(Value::as_str)
                                    .filter(|_| msg["method"] == "session/resume")
                                    .map(str::to_owned);
                            }
                        }
                        if let Err(error) = write_line(&mut stdin, &row).await {
                            if error.kind() == io::ErrorKind::BrokenPipe {
                                break;
                            }
                            return Err(error);
                        }
                    }
                    Some(Err(_)) | None => {
                        host_detached = true;
                        match &state {
                            SessionState::Open { session_id } => {
                                let close_id = max_client_id.saturating_add(1);
                                let close = json!({
                                    "jsonrpc": "2.0",
                                    "id": close_id,
                                    "method": "session/close",
                                    "params": { "sessionId": session_id }
                                });
                                if write_json_line(&mut stdin, &close).await.is_err() {
                                    break;
                                }
                                state = SessionState::Closing { close_id };
                                close_deadline = Some(tokio::time::Instant::now() + CLOSE_TIMEOUT);
                            }
                            SessionState::Opening { .. } | SessionState::Closing { .. } => break,
                        }
                    }
                },
                row = agy_out.next() => match row {
                    Some(Ok(row)) => {
                        let msg: Value = serde_json::from_str(&row)?;
                        if let SessionState::Closing { close_id } = state
                            && msg["id"].as_u64() == Some(close_id)
                            && msg.get("method").is_none()
                        {
                            break;
                        }
                        if let SessionState::Opening {
                            open_request_id: Some(req_id),
                            resume_session_id,
                        } = &state
                            && msg["id"].as_u64() == Some(*req_id)
                            && msg.get("method").is_none()
                            && msg.get("result").is_some()
                            && let Some(sid) = msg
                                .pointer("/result/sessionId")
                                .and_then(Value::as_str)
                                .or(resume_session_id.as_deref())
                        {
                            state = SessionState::Open {
                                session_id: sid.to_owned(),
                            };
                        }
                        if host_detached && msg.get("method").is_some() && let Some(id) = msg.get("id") {
                            let reply = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": { "code": -32601, "message": "Unsupported ACP callback" }
                            });
                            let _ = write_json_line(&mut stdin, &reply).await;
                            continue;
                        }
                        emit_output(&mut spool, &written, &row).await?;
                    }
                    Some(Err(error)) => return Err(io::Error::other(error)),
                    None => break,
                },
                () = async {
                    match close_deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                } => break,
            }
        }
        Ok(())
    }
    .await;

    let mut result = pump;
    if let Err(error) = child.terminate().await {
        result = result.and(Err(error));
    }
    if let Err(error) = child.wait().await {
        result = result.and(Err(error));
    }
    // A final prompt reply can still be buffered in the pipe after the process group exits.
    while let Some(row) = agy_out.next().await {
        match row {
            Ok(row) => {
                if let SessionState::Closing { close_id } = state
                    && serde_json::from_str::<Value>(&row).is_ok_and(|msg| {
                        msg["id"].as_u64() == Some(close_id) && msg.get("method").is_none()
                    })
                {
                    continue;
                }
                if let Err(error) = emit_output(&mut spool, &written, &row).await {
                    result = result.and(Err(error));
                    break;
                }
            }
            Err(error) => {
                result = result.and(Err(io::Error::other(error)));
                break;
            }
        }
    }
    drop(written);
    if let Err(error) = forward.await {
        result = result.and(Err(io::Error::other(error)));
    }
    match diagnostics.await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => result = result.and(Err(error)),
        Err(error) => result = result.and(Err(io::Error::other(error))),
    }
    if let Err(error) = spool.seal().await {
        result = result.and(Err(error));
    }
    result
}
