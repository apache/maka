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
use std::{path::Path, time::Duration};
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
    Opened { session_id: String },
    Event { event: Value },
    Result { result: Final },
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

pub(super) async fn execute(
    executable: &Path,
    args: &[String],
    cwd: &str,
    request: Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    cancellation: CancellationToken,
) -> Result<Outcome, Error> {
    let running = &mut *journal;
    let result = supervise(executable, args, cwd, |input, stdout, settle| async move {
        communicate(
            input,
            stdout,
            request,
            storage,
            running,
            output,
            &cancellation,
            &settle,
        )
        .await
    })
    .await;
    let result = result.and_then(|protocol| protocol.map_err(|_| Error::CleanupUnconfirmed));
    if !matches!(&result, Err(Error::CleanupUnconfirmed)) {
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
    F: FnOnce(maka_process::pipe::Input, maka_process::pipe::Output, CancellationToken) -> Fut,
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
        let work = protocol(process.stdin, process.stdout, settle.clone());
        tokio::pin!(work);
        let result = tokio::select! {
            biased;
            result = &mut work => result,
            () = finished.cancelled() => {
                // Escaped descendants may keep pipes open after root exit. Drain buffered
                // receipts, but never infer native disposal from process-group disappearance.
                tokio::time::timeout(Duration::from_secs(1), &mut work).await
                    .unwrap_or(Err(Error::CleanupUnconfirmed))
            }
        };
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
        |mut input, stdout, settle| async move {
            write(&mut input, request).await?;
            let mut lines = BufReader::new(stdout).lines();
            let mut cancelled = false;
            loop {
                let line = tokio::select! {
                    biased;
                    () = cancellation.cancelled(), if !cancelled => {
                        cancelled = true;
                        cancel(&mut input, &settle).await;
                        continue;
                    }
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

#[allow(clippy::too_many_arguments)]
async fn communicate(
    mut input: maka_process::pipe::Input,
    stdout: maka_process::pipe::Output,
    request: Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    cancellation: &CancellationToken,
    settle: &CancellationToken,
) -> Result<(Outcome, Option<Error>), Error> {
    write(&mut input, request).await?;
    let mut lines = BufReader::new(stdout).lines();
    let mut sequence = 0;
    let mut opened = false;
    let mut cancelled = false;
    let mut failure = None;
    loop {
        let line = tokio::select! {
            biased;
            () = cancellation.cancelled(), if !cancelled => {
                cancelled = true;
                cancel(&mut input, settle).await;
                continue;
            }
            line = lines.next_line() => line.map_err(|e| Error::Provider(e.to_string()))?,
        }
        .ok_or(Error::Unknown)?;
        let frame: Frame =
            serde_json::from_str(&line).map_err(|e| Error::Invalid(e.to_string()))?;
        if frame.sequence != sequence + 1 {
            return Err(Error::Invalid("OAR output sequence changed".into()));
        }
        sequence = frame.sequence;
        match frame.body {
            Body::Opened { session_id } => {
                if opened {
                    return Err(Error::Invalid("OAR opened twice".into()));
                }
                opened = true;
                if let Err(error) = journal.opened(storage, session_id).await {
                    failure = Some(error);
                    cancelled = true;
                    cancel(&mut input, settle).await;
                    continue;
                }
            }
            Body::Event { event } => {
                if !opened {
                    return Err(Error::Invalid(
                        "OAR output preceded native session identity".into(),
                    ));
                }
                if cancelled {
                    continue;
                }
                if let Err(error) = projection::emit(event, output.as_ref()).await {
                    failure = Some(error);
                    cancelled = true;
                    cancel(&mut input, settle).await;
                    continue;
                }
            }
            Body::Result { result } => {
                if !opened && !matches!(result, Final::Rejected { .. }) {
                    return Err(Error::Invalid(
                        "OAR result preceded native session identity".into(),
                    ));
                }
                let _ = input.shutdown().await;
                return Ok((result.outcome(), failure));
            }
        }
        if let Err(error) = write(
            &mut input,
            serde_json::json!({"kind":"ack", "sequence":sequence}),
        )
        .await
        {
            failure.get_or_insert(error);
            cancelled = true;
            cancel(&mut input, settle).await;
        }
    }
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
