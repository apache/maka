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
use futures_util::{StreamExt, stream::FuturesUnordered};
use std::{collections::BTreeMap, path::Path, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[derive(Deserialize)]
struct Frame {
    sequence: u64,
    #[serde(flatten)]
    body: Body,
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Body {
    Opened {
        session_id: String,
    },
    Event {
        event: Value,
    },
    Result {
        result: Final,
    },
    ToolCall {
        call_id: u64,
        name: String,
        input: Value,
    },
    ToolCancel {
        call_id: u64,
    },
    HostToolsUnavailable {
        reason: String,
    },
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Final {
    Completed {
        text: String,
    },
    Aborted,
    Failed {
        reason: Option<String>,
        failure: Option<String>,
    },
    Rejected {
        code: String,
        message: String,
    },
}
impl Final {
    fn outcome(self) -> Outcome {
        match self {
            Self::Completed { text } => Outcome::Completed { text },
            Self::Aborted => Outcome::Cancelled { reason: None },
            Self::Failed { reason, failure } => Outcome::Failed {
                message: reason.unwrap_or_else(|| "External agent failed".into()),
                code: failure,
                recoverable: false,
            },
            Self::Rejected { code, message } => Outcome::Failed {
                message,
                code: Some(code),
                recoverable: false,
            },
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "one worker invocation retains its journal, tools and cleanup owners"
)]
pub(super) async fn execute(
    executable: &Path,
    args: &[String],
    cwd: &str,
    request: Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    tools: tools::Tools,
    cancellation: CancellationToken,
) -> Result<Outcome, Error> {
    let running = &mut *journal;
    let result = supervise(
        executable,
        args,
        cwd,
        |input, stdout, settle, exited| async move {
            communicate(
                input,
                stdout,
                request,
                storage,
                running,
                output,
                &cancellation,
                &settle,
                &exited,
                tools,
            )
            .await
        },
    )
    .await;
    let result = result.and_then(|protocol| protocol.map_err(|_| Error::CleanupUnconfirmed));
    if !matches!(
        &result,
        Err(Error::CleanupUnconfirmed) | Ok((_, Some(Error::CleanupUnconfirmed)))
    ) {
        journal.ready(storage).await?;
    }
    let (outcome, failure) = result?;
    failure.map_or(Ok(outcome), Err)
}

async fn supervise<T, F, Fut>(
    executable: &Path,
    args: &[String],
    cwd: &str,
    protocol: F,
) -> Result<Result<T, Error>, Error>
where
    F: FnOnce(
        maka_process::pipe::Input,
        maka_process::pipe::Output,
        CancellationToken,
        CancellationToken,
    ) -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
{
    let mut command = maka_process::Command::new(executable, cwd);
    for argument in args {
        command.arg(argument);
    }
    let mut process = maka_process::pipe::spawn(command)
        .await
        .map_err(|error| match error {
            maka_agent_facts::tools::ToolError::CleanupUnconfirmed(_) => Error::CleanupUnconfirmed,
            error => Error::Provider(error.to_string()),
        })?;
    let finished = CancellationToken::new();
    let settle = CancellationToken::new();
    let lifecycle = async {
        let result = async {
            let status = tokio::select! {
                result = process.child.wait() => result,
                () = settle.cancelled() => {
                    match tokio::time::timeout(Duration::from_secs(45), process.child.wait()).await {
                        Ok(result) => result,
                        Err(_) => {
                            process.child.terminate().map_err(|_| Error::CleanupUnconfirmed)?;
                            tokio::time::timeout(Duration::from_secs(4), process.child.wait()).await.map_err(|_| Error::CleanupUnconfirmed)?
                        }
                    }
                }
            };
            status.map_err(|_| Error::CleanupUnconfirmed)
        }.await;
        finished.cancel();
        result
    };
    let protocol = async {
        // The protocol owns admitted tool futures and must drain them on every exit.
        let result = protocol(
            process.stdin,
            process.stdout,
            settle.clone(),
            finished.clone(),
        )
        .await;
        settle.cancel();
        result
    };
    let diagnostics = async {
        let mut tail = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let read = tokio::select! {
                biased;
                () = finished.cancelled() => break,
                read = process.stderr.read(&mut buffer) => read,
            };
            match read {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    tail.extend_from_slice(&buffer[..count]);
                    if tail.len() > 8192 {
                        tail.drain(..tail.len() - 8192);
                    }
                }
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    };
    let (status, result, diagnostics) = tokio::join!(lifecycle, protocol, diagnostics);
    status?;
    if let Err(error) = &result {
        tracing::warn!(cause = %error, diagnostic = %diagnostics, "OAR protocol ended without a valid terminal receipt");
    }
    Ok(result)
}

pub(super) async fn query(
    executable: &Path,
    args: &[String],
    cwd: &str,
    request: Value,
    cancellation: CancellationToken,
) -> Result<Value, Error> {
    let expected = request
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid("Missing OAR query kind".into()))?
        .to_owned();
    supervise(
        executable,
        args,
        cwd,
        |mut input, stdout, settle, exited| async move {
            write(&mut input, request).await?;
            let mut lines = BufReader::new(stdout).lines();
            let mut cancelled = false;
            let exit = exit_grace(&exited);
            tokio::pin!(exit);
            loop {
                let line = tokio::select! {
                    biased;
                    () = cancellation.cancelled(), if !cancelled => {
                        cancelled = true;
                        cancel(&mut input, &settle).await;
                        continue;
                    }
                    () = &mut exit => return Err(Error::CleanupUnconfirmed),
                    line = lines.next_line() => line.map_err(|e| Error::Provider(e.to_string()))?,
                }
                .ok_or(Error::Unknown)?;
                let frame: Value =
                    serde_json::from_str(&line).map_err(|e| Error::Invalid(e.to_string()))?;
                if frame.get("sequence").and_then(Value::as_u64) != Some(1)
                    || frame.get("kind").and_then(Value::as_str) != Some(expected.as_str())
                {
                    return Err(Error::Invalid("Invalid OAR query result".into()));
                }
                let _ = input.shutdown().await;
                return frame
                    .get("value")
                    .cloned()
                    .ok_or_else(|| Error::Invalid("Missing OAR query result".into()));
            }
        },
    )
    .await?
    .map_err(|_| Error::CleanupUnconfirmed)
}

#[expect(
    clippy::too_many_arguments,
    reason = "worker protocol retains explicit persistence and cleanup owners"
)]
async fn communicate(
    mut input: maka_process::pipe::Input,
    stdout: maka_process::pipe::Output,
    request: Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    cancellation: &CancellationToken,
    settle: &CancellationToken,
    exited: &CancellationToken,
    tools: tools::Tools,
) -> Result<(Outcome, Option<Error>), Error> {
    let stopped = CancellationToken::new();
    let mut calls = BTreeMap::<u64, CancellationToken>::new();
    let mut pending = FuturesUnordered::<BoxFuture<'static, (u64, Value, Option<Error>)>>::new();
    let mut tool_failure = None;
    let result = async {
        write(&mut input, request).await?;
        let mut lines = BufReader::new(stdout).lines();
        let mut sequence = 0;
        let mut last_call = 0;
        let mut opened = false;
        let mut cancelled = false;
        let mut unavailable = false;
        let mut failure = None;
        let mut root_exited = false;
        let exit = exit_grace(exited);
        tokio::pin!(exit);
        loop {
            let line = tokio::select! {
                biased;
                () = cancellation.cancelled(), if !cancelled => {
                    cancelled = true;
                    stopped.cancel();
                    cancel(&mut input, settle).await;
                    continue;
                }
                () = &mut exit => return Err(Error::CleanupUnconfirmed),
                () = exited.cancelled(), if !root_exited => {
                    root_exited = true;
                    cancelled = true;
                    stopped.cancel();
                    continue;
                }
                completed = pending.next(), if !pending.is_empty() => {
                    let (call_id, result, fatal) = completed.expect("pending tool set is nonempty");
                    calls.remove(&call_id);
                    let fatal = record_failure(&mut tool_failure, fatal);
                    write(&mut input, serde_json::json!({"kind":"tool_result", "callId":call_id,"result":result})).await?;
                    if fatal {
                        cancelled = true;
                        stopped.cancel();
                        cancel(&mut input, settle).await;
                    }
                    continue;
                }
                line = lines.next_line() => line.map_err(|e| Error::Provider(e.to_string()))?,
            }.ok_or(Error::Unknown)?;
            let frame: Frame = serde_json::from_str(&line).map_err(|e| Error::Invalid(e.to_string()))?;
            if frame.sequence != sequence + 1 { return Err(Error::Invalid("OAR output sequence changed".into())); }
            sequence = frame.sequence;
            match frame.body {
                Body::Opened { session_id } => {
                    if opened { return Err(Error::Invalid("OAR opened twice".into())); }
                    opened = true;
                    if let Err(error) = journal.opened(storage, session_id).await {
                        failure = Some(error);
                        cancelled = true;
                        stopped.cancel();
                        cancel(&mut input, settle).await;
                        continue;
                    }
                }
                Body::Event { event } => {
                    if !opened { return Err(Error::Invalid("OAR output preceded native session identity".into())); }
                    if cancelled { continue; }
                    if let Err(error) = projection::emit(event, output.as_ref()).await {
                        failure = Some(error);
                        cancelled = true;
                        stopped.cancel();
                        cancel(&mut input, settle).await;
                        continue;
                    }
                }
                Body::ToolCall { call_id, name, input: arguments } => {
                    if !opened || unavailable || call_id > 9_007_199_254_740_991 || call_id != last_call + 1 {
                        return Err(Error::Invalid("Invalid OAR Host tool call identity".into()));
                    }
                    last_call = call_id;
                    if cancelled || cancellation.is_cancelled() || exited.is_cancelled() {
                        // Never admit another tool after Stop, including buffered calls.
                        write(&mut input, serde_json::json!({"kind":"tool_result","callId":call_id,"result":{"isError":true,"content":[{"type":"text","text":"Host tool call cancelled before admission"}]}})).await?;
                    } else {
                        let token = stopped.child_token();
                        calls.insert(call_id, token.clone());
                        let call = tools.invoke(name, arguments, token);
                        pending.push(Box::pin(async move { let (result, fatal) = call.await; (call_id, result, fatal) }));
                    }
                    // Acknowledge receipt separately from the original T2 settlement.
                }
                Body::ToolCancel { call_id } => {
                    if call_id == 0 || call_id > last_call { return Err(Error::Invalid("Invalid OAR Host tool cancellation".into())); }
                    // Cancellation can cross an already-settled reply on the pipe.
                    if let Some(token) = calls.get(&call_id) { token.cancel(); }
                }
                Body::HostToolsUnavailable { reason } => {
                    if !opened || unavailable || last_call != 0 { return Err(Error::Invalid("Invalid OAR Host tools refusal".into())); }
                    unavailable = true;
                    tracing::warn!(%reason, "OAR runtime refused Host tools");
                }
                Body::Result { result } => {
                    if !opened && !matches!(result, Final::Rejected { .. }) { return Err(Error::Invalid("OAR result preceded native session identity".into())); }
                    return Ok((result.outcome(), failure));
                }
            }
            if let Err(error) = write(&mut input, serde_json::json!({"kind":"ack","sequence":sequence})).await {
                failure.get_or_insert(error);
                cancelled = true;
                stopped.cancel();
                cancel(&mut input, settle).await;
            }
        }
    }.await;
    stopped.cancel();
    if result.is_err() {
        cancel(&mut input, settle).await;
    }
    // No terminal, protocol failure, EOF or process-exit path may drop a T1 owner.
    while let Some((call_id, reply, fatal)) = pending.next().await {
        calls.remove(&call_id);
        record_failure(&mut tool_failure, fatal);
        let _ = write(
            &mut input,
            serde_json::json!({"kind":"tool_result","callId":call_id,"result":reply}),
        )
        .await;
    }
    let _ = input.shutdown().await;
    if matches!(&result, Err(Error::CleanupUnconfirmed)) {
        return result;
    }
    if let Some(error) = tool_failure {
        return Ok((Outcome::Cancelled { reason: None }, Some(error)));
    }
    result
}

fn record_failure(current: &mut Option<Error>, failure: Option<Error>) -> bool {
    let Some(failure) = failure else {
        return false;
    };
    if current.is_none() || matches!(failure, Error::CleanupUnconfirmed) {
        *current = Some(failure);
    }
    true
}
async fn exit_grace(exited: &CancellationToken) {
    exited.cancelled().await;
    tokio::time::sleep(Duration::from_secs(1)).await;
}
async fn write(input: &mut maka_process::pipe::Input, value: Value) -> Result<(), Error> {
    let mut bytes = serde_json::to_vec(&value).map_err(|e| Error::Invalid(e.to_string()))?;
    bytes.push(b'\n');
    input
        .write_all(&bytes)
        .await
        .map_err(|e| Error::Provider(e.to_string()))
}

async fn cancel(input: &mut maka_process::pipe::Input, settle: &CancellationToken) {
    settle.cancel();
    if let Err(error) = write(input, serde_json::json!({"kind":"cancel"})).await {
        tracing::debug!(%error, "OAR cancel pipe closed; draining the original response");
    }
}
