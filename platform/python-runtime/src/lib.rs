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

//! Optional Python Code Mode interpreter. Each cell owns a disposable Monty
//! process; only the Host can admit tools, publish output or accept JSON drafts.
mod helpers;
mod protocol;
mod value;
pub mod worker;

use futures_util::{FutureExt, StreamExt, future::BoxFuture, stream::FuturesUnordered};
use maka_agent_facts::tools::ToolExecutor;
use maka_code_runtime::{
    CellAbort, CellContext, CellDiagnostic, CellLimits, CellResult, PreparedCell, ToolScope,
    VmBinding, complete,
};
use protocol::{Reply, Request, Start};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::Instant,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    runtime::Handle,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct CodeExecutor {
    limits: CellLimits,
    worker: PathBuf,
    physical_changed: tokio::sync::watch::Sender<()>,
}
impl CodeExecutor {
    pub fn new(limits: CellLimits) -> Result<Self, CellAbort> {
        let current = std::env::current_exe().map_err(internal)?;
        let worker = current
            .parent()
            .ok_or_else(|| internal("executable has no parent directory"))?
            .join(if cfg!(windows) {
                "maka-python-worker.exe"
            } else {
                "maka-python-worker"
            });
        Self::with_worker(limits, worker)
    }
    /// Embeddings supply their packaged worker explicitly. The model never
    /// chooses a command, environment or interpreter executable.
    pub fn with_worker(limits: CellLimits, worker: PathBuf) -> Result<Self, CellAbort> {
        if limits.timeout.is_zero()
            || limits.timeout.as_millis() > u64::MAX as u128
            || Instant::now().checked_add(limits.timeout).is_none()
            || limits.heap_bytes < 8 * 1024 * 1024
        {
            return Err(internal("invalid cell limits"));
        }
        Ok(Self {
            limits,
            worker,
            physical_changed: tokio::sync::watch::channel(()).0,
        })
    }
    pub fn limits(&self) -> &CellLimits {
        &self.limits
    }

    pub fn physical_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.physical_changed.subscribe()
    }

    pub async fn observe_binding(
        &self,
        binding: &VmBinding,
    ) -> maka_code_runtime::RuntimeVmObservation {
        maka_code_runtime::observe_binding(binding).await
    }

    pub fn release_binding(&self, _binding: &VmBinding) -> bool {
        false
    }

    /// Lease the actual worker and freeze the script before canonical VmBound.
    pub async fn prepare_module(
        &self,
        source: String,
        tools: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
        context: CellContext,
    ) -> Result<PreparedCell, CellAbort> {
        if cancellation.is_cancelled() {
            return Err(CellAbort::Cancelled);
        }
        let cancellation = cancellation.child_token();
        let executor = self.clone();
        let (ready, binding) = tokio::sync::oneshot::channel();
        let (start, gate) = tokio::sync::oneshot::channel();
        let (reply, result) = tokio::sync::oneshot::channel();
        let owner_cancel = cancellation.clone();
        // The owner survives a dropped observer through child reap and effect drain.
        tokio::spawn(async move {
            let outcome = std::panic::AssertUnwindSafe(executor.run(
                source,
                tools,
                owner_cancel,
                context,
                ready,
                gate,
            ))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(CellAbort::VmCleanupUnconfirmed(
                    "Python worker owner panicked".into(),
                ))
            });
            let _ = reply.send(outcome);
        });
        PreparedCell::from_owner(binding, start, result, cancellation).await
    }
    async fn run(
        &self,
        source: String,
        tools: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
        context: CellContext,
        ready: tokio::sync::oneshot::Sender<VmBinding>,
        gate: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<CellResult, CellAbort> {
        let names = tools.names();
        let mut unique = HashSet::new();
        if names
            .iter()
            .any(|name| !unique.insert(tool_identifier(name)))
        {
            return Err(internal("tool names collide after Python normalization"));
        }
        let scope = ToolScope::new(
            context.clone(),
            tools,
            cancellation.child_token(),
            Handle::current(),
        );
        let job_nonce = uuid::Uuid::new_v4();
        let mut command = tokio::process::Command::new(&self.worker);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: worker only uses pipes.
        let mut child = command
            .args([
                self.limits.heap_bytes.to_string(),
                self.limits.timeout.as_millis().to_string(),
                job_nonce.to_string(),
            ])
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                internal(format!(
                    "cannot start bundled Python worker {}: {error}",
                    self.worker.display()
                ))
            })?;
        let setup = async {
            let input = child.stdin.take().ok_or_else(|| internal("missing worker input"))?;
            let mut output = BufReader::new(child.stdout.take().ok_or_else(|| internal("missing worker output"))?);
            let frame = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(CellAbort::Cancelled),
                frame = receive(&mut output, self.limits.heap_bytes.saturating_add(4 * 1024 * 1024)) => frame?,
            };
            if !matches!(frame, Request::Prepared { job_nonce: nonce } if nonce == job_nonce) {
                return Err(internal("Python worker preparation nonce mismatch"));
            }
            let pid = child.id().ok_or_else(|| internal("Python worker has no process identity"))?;
            let binding = tokio::task::spawn_blocking(move || VmBinding::python_child(pid, job_nonce))
                .await.map_err(internal)?.map_err(internal)?;
            Ok::<_, CellAbort>((input, output, binding))
        }.await;
        let (mut input, mut output, binding) = match setup {
            Ok(setup) => setup,
            Err(error) => {
                reap(&mut child, &self.physical_changed).await?;
                return Err(error);
            }
        };
        let released = if ready.send(binding).is_err() {
            false
        } else {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => false,
                ack = gate => ack.is_ok(),
            }
        };
        if !released {
            drop(input);
            reap(&mut child, &self.physical_changed).await?;
            return Err(CellAbort::Cancelled);
        }
        let start = Start {
            job_nonce,
            source,
            names,
            metadata: context.metadata().to_vec(),
        };
        let result = tokio::select! {
            biased;
            _=cancellation.cancelled()=>Err(CellAbort::Cancelled),
            result=drive(&mut input,&mut output,start,&scope,&context,&self.limits)=>result,
        };
        scope.cancel();
        drop(input);
        let status = reap(&mut child, &self.physical_changed).await;
        scope.settle().await;
        let status = match status {
            Ok(status) => status,
            Err(error) => {
                return Err(match context.failure() {
                    Some(failure) => CellAbort::VmCleanupUnconfirmed(format!("{failure}; {error}")),
                    None => error,
                });
            }
        };
        if let Some(error) = context.failure() {
            return Err(CellAbort::Tool(error));
        }
        if cancellation.is_cancelled() {
            return Err(CellAbort::Cancelled);
        }
        if status.code() == Some(monty_types::OOM_EXIT_CODE) {
            return Ok(complete(
                Err(CellDiagnostic::limit("Python worker memory limit exceeded")),
                scope.calls(),
            ));
        }
        Ok(complete(result?, scope.calls()))
    }
}

type Pending = FuturesUnordered<BoxFuture<'static, (u32, Result<Value, CellDiagnostic>)>>;
async fn drive(
    input: &mut ChildStdin,
    output: &mut BufReader<ChildStdout>,
    start: Start,
    scope: &Arc<ToolScope>,
    context: &CellContext,
    limits: &CellLimits,
) -> Result<Result<Value, CellDiagnostic>, CellAbort> {
    send(input, &start).await?;
    // Loading the trusted executable and initializing transport precede user
    // execution, just as V8 construction precedes its execution clock. The
    // owning cancellation token remains active through this handshake.
    if !matches!(
        receive(output, limits.heap_bytes.saturating_add(4 * 1024 * 1024)).await?,
        Request::Ready { job_nonce } if job_nonce == start.job_nonce
    ) {
        return Err(internal("Python worker omitted its ready frame"));
    }
    let mut remaining = limits.timeout;
    let mut pending = Pending::new();
    let mut ready = BTreeMap::new();
    let mut admitted = HashSet::new();
    loop {
        let started = Instant::now();
        let request = tokio::time::timeout(
            remaining,
            receive(output, limits.heap_bytes.saturating_add(4 * 1024 * 1024)),
        )
        .await;
        remaining = remaining.saturating_sub(started.elapsed());
        let request = match request {
            Ok(request) => request?,
            Err(_) => {
                return Ok(Err(CellDiagnostic::limit(
                    "Python execution budget exceeded",
                )));
            }
        };
        let reply = match request {
            Request::Prepared { .. } | Request::Ready { .. } => {
                return Err(internal("duplicate Python worker ready frame"));
            }
            Request::Complete { error } => {
                return Ok(match error {
                    Some(error) => Err(error),
                    None => Ok(Value::Null),
                });
            }
            Request::Call {
                id,
                name,
                mut args,
                kwargs,
            } => {
                if let Some(name) = name.strip_prefix("tool:") {
                    let input = match (args.len(), kwargs.is_empty()) {
                        (1, true) => Ok(args.remove(0)),
                        (0, false) => Ok(Value::Object(kwargs)),
                        (0, true) => Ok(serde_json::json!({})),
                        _ => Err(helpers::error(
                            "tool expects one JSON argument or keyword arguments",
                        )),
                    };
                    match input.and_then(|input| {
                        protocol::validate_json(&input)?;
                        scope.start(name.into(), input)
                    }) {
                        Ok(receiver) => {
                            if !admitted.insert(id) {
                                return Err(internal("duplicate Python call identity"));
                            }
                            pending.push(Box::pin(async move {
                                (
                                    id,
                                    receiver
                                        .await
                                        .unwrap_or_else(|_| {
                                            Err(helpers::error("tool outcome unavailable"))
                                        })
                                        .and_then(|value| {
                                            protocol::validate_json(&value)?;
                                            Ok(value)
                                        }),
                                )
                            }));
                            Reply::Pending
                        }
                        Err(error) => Reply::Error { error },
                    }
                } else if let Some(name) = name.strip_prefix("helper:") {
                    let outcome = if matches!(name, "load" | "store") {
                        let helper = name.to_owned();
                        let context = context.clone();
                        tokio::task::spawn_blocking(move || {
                            helpers::invoke(&helper, args, kwargs, &context)
                        })
                        .await
                        .map_err(internal)?
                    } else {
                        helpers::invoke(name, args, kwargs, context)
                    };
                    match outcome.and_then(|value| {
                        protocol::validate_json(&value)?;
                        Ok(value)
                    }) {
                        Ok(_) if name == "exit" => return Ok(Ok(Value::Null)),
                        Ok(_) if name == "yield_control" => {
                            admitted.insert(id);
                            pending.push(Box::pin(async move {
                                tokio::task::yield_now().await;
                                (id, Ok(Value::Null))
                            }));
                            Reply::Pending
                        }
                        Ok(value) => Reply::Return { value },
                        Err(error) => Reply::Error { error },
                    }
                } else {
                    Reply::Error {
                        error: helpers::error("unknown external function"),
                    }
                }
            }
            Request::Sleep {
                id,
                duration,
                asynchronous,
            } => {
                if Instant::now().checked_add(duration).is_none() {
                    Reply::Error {
                        error: helpers::error("sleep duration is too large"),
                    }
                } else if asynchronous {
                    admitted.insert(id);
                    pending.push(Box::pin(async move {
                        tokio::time::sleep(duration).await;
                        (id, Ok(Value::Null))
                    }));
                    Reply::Pending
                } else {
                    tokio::time::sleep(duration).await;
                    Reply::Return { value: Value::Null }
                }
            }
            Request::Resolve { ids } => {
                if ids.is_empty() || ids.iter().any(|id| !admitted.contains(id)) {
                    return Err(internal("unknown pending Python call"));
                }
                while !ids.iter().any(|id| ready.contains_key(id)) {
                    let (id, result) = pending
                        .next()
                        .await
                        .ok_or_else(|| internal("Python futures lost their owner"))?;
                    ready.insert(id, result);
                }
                let results = ids
                    .into_iter()
                    .filter_map(|id| {
                        ready.remove(&id).map(|result| {
                            admitted.remove(&id);
                            (id, result)
                        })
                    })
                    .collect();
                Reply::Resolved { results }
            }
        };
        send(input, &reply).await?;
    }
}
async fn send(input: &mut ChildStdin, message: &impl serde::Serialize) -> Result<(), CellAbort> {
    let mut bytes = serde_json::to_vec(message).map_err(internal)?;
    bytes.push(b'\n');
    input.write_all(&bytes).await.map_err(internal)?;
    input.flush().await.map_err(internal)
}
async fn receive(
    output: &mut BufReader<ChildStdout>,
    max_bytes: usize,
) -> Result<Request, CellAbort> {
    let mut line = Vec::new();
    loop {
        let bytes = output.fill_buf().await.map_err(internal)?;
        if bytes.is_empty() {
            return Err(internal("Python worker ended without a terminal frame"));
        }
        let end = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1);
        let count = end.unwrap_or(bytes.len());
        if line.len().saturating_add(count) > max_bytes {
            return Err(internal("Python worker frame exceeds its memory budget"));
        }
        line.extend_from_slice(&bytes[..count]);
        output.consume(count);
        if end.is_some() {
            return protocol::decode(&line).map_err(internal);
        }
    }
}
async fn reap(
    child: &mut Child,
    physical_changed: &tokio::sync::watch::Sender<()>,
) -> Result<std::process::ExitStatus, CellAbort> {
    let cleanup =
        |error| CellAbort::VmCleanupUnconfirmed(format!("Python worker cleanup: {error}"));
    let status = match child.try_wait().map_err(cleanup)? {
        Some(status) => status,
        None => {
            child.start_kill().map_err(cleanup)?;
            child.wait().await.map_err(cleanup)?
        }
    };
    physical_changed.send_replace(());
    Ok(status)
}

fn internal(error: impl std::fmt::Display) -> CellAbort {
    CellAbort::Internal(error.to_string())
}

pub fn tool_identifier(name: &str) -> String {
    let mut result: String = name
        .chars()
        .enumerate()
        .map(|(index, ch)| {
            if ch == '_' || ch.is_ascii_alphabetic() || (index > 0 && ch.is_ascii_digit()) {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if result.is_empty() {
        result.push('_');
    }
    // Keywords cannot be attributes in Python source, even after a dot.
    if [
        "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
        "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
        "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
        "try", "while", "with", "yield",
    ]
    .contains(&result.as_str())
    {
        result.push('_');
    }
    result
}
