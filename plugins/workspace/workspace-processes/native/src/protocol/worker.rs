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
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

pub(super) async fn run(
    owner: &Processes,
    context: &Context,
    id: Uuid,
    command: maka_process::Command,
    input: mpsc::Receiver<Write>,
    session: Option<(&maka_event_log::SessionStore, &ResolvedConfiguration)>,
) -> Result<Completion, ToolError> {
    if context.scope().cancellation.is_cancelled() || owner.drain.is_cancelled() {
        return Ok(Completion::Failed {
            message: "Process cancelled before launch".into(),
        });
    }
    // Keep startup polled through cancellation: it may already own native
    // sandbox/network resources. Only the resulting lifecycle can settle it.
    let mut process = match maka_process::pipe::spawn(command).await {
        Ok(process) => process,
        Err(error @ ToolError::CleanupUnconfirmed(_)) => return Err(error),
        Err(error) => {
            return Ok(Completion::Failed {
                message: error.to_string(),
            });
        }
    };
    let finished = CancellationToken::new();
    let fault = CancellationToken::new();
    let failure = Mutex::new(None);
    let lifecycle = async {
        let result = tokio::select! {
            biased;
            () = context.scope().cancellation.cancelled() => None,
            () = owner.drain.cancelled() => None,
            () = fault.cancelled() => None,
            result = process.child.wait() => Some(result),
        };
        let stopped = result.is_none();
        let result = match result {
            Some(result) => result.map_err(|e| e.to_string()),
            None => match process.child.terminate() {
                Err(error) => Err(error.to_string()),
                Ok(()) => tokio::time::timeout(Duration::from_secs(4), process.child.wait())
                    .await
                    .map_err(|_| "Protocol process cleanup timed out".to_owned())
                    .and_then(|r| r.map_err(|e| e.to_string())),
            },
        };
        finished.cancel();
        result
            .map(|status| (status, stopped))
            .map_err(ToolError::CleanupUnconfirmed)
    };
    let output = async {
        context
            .emit(serde_json::to_value(Progress::Started { id }).expect("process started"))
            .await?;
        let ((), ()) = tokio::join!(
            report(
                read(process.stdout, Stream::Stdout, context, &finished),
                &failure,
                &fault
            ),
            report(
                read(process.stderr, Stream::Stderr, context, &finished),
                &failure,
                &fault
            ),
        );
        Ok(())
    };
    let monitor = async {
        let Some((store, configuration)) = session else {
            finished.cancelled().await;
            return Ok(());
        };
        let mut changes = store.subscribe_commits().map_err(|e| e.to_string())?;
        loop {
            changes.borrow_and_update();
            let current = store
                .get_session::<maka_agent_api::session::StoredSessionConfiguration>(
                    &context
                        .scope()
                        .identity
                        .agent()
                        .expect("validated invocation")
                        .session_id,
                )
                .await
                .map_err(|e| e.to_string())?;
            let current = current
                .filter(|s| !s.archived)
                .ok_or("Protocol process Session unavailable")?;
            let current = maka_agent_authority::permissions::resolve_session(current)
                .map_err(|e| e.to_string())?;
            if current.configuration.permission_basis() != configuration.permission_basis()
                || current.configuration.workspace != configuration.workspace
            {
                return Err("Protocol process permissions changed".into());
            }
            if store
                .session_retirement(&current.id)
                .await
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err("Protocol process Session is retiring".into());
            }
            tokio::select! {
                biased;
                () = finished.cancelled() => return Ok(()),
                changed = changes.changed() => changed.map_err(|e| e.to_string())?,
            }
        }
    };
    let (result, (), (), ()) = tokio::join!(
        lifecycle,
        report(write(process.stdin, input, &finished), &failure, &fault),
        report(output, &failure, &fault),
        report(monitor, &failure, &fault),
    );
    let (status, stopped) = result?;
    let error = failure.into_inner().unwrap();
    Ok(Completion::Exited {
        code: status.code(),
        success: status.success() && !stopped && error.is_none(),
        stopped,
        error,
    })
}
async fn write(
    mut stdin: maka_process::pipe::Input,
    mut input: mpsc::Receiver<Write>,
    finished: &CancellationToken,
) -> Result<(), String> {
    loop {
        let request = tokio::select! {
            biased;
            () = finished.cancelled() => return Ok(()),
            request = input.recv() => request,
        };
        let Some(request) = request else {
            return Ok(());
        };
        let Some(bytes) = request.bytes else {
            // ChildStdin::shutdown may be a no-op for a pipe. Drop the owned
            // handle before confirming EOF; pending requests are also closed.
            drop(stdin);
            input.close();
            let _ = request.reply.send(Ok(Written {
                bytes: 0,
                closed: true,
            }));
            return Ok(());
        };
        let count = bytes.len();
        let result = tokio::select! {
            biased;
            () = finished.cancelled() => Err("Protocol process ended during input".into()),
            result = stdin.write_all(&bytes) => result.map_err(|e| e.to_string()),
        };
        let error = result.as_ref().err().cloned();
        let _ = request.reply.send(result.map(|()| Written {
            bytes: count,
            closed: false,
        }));
        if let Some(error) = error {
            return Err(error);
        }
    }
}
async fn report(
    future: impl Future<Output = Result<(), String>>,
    failure: &Mutex<Option<String>>,
    fault: &CancellationToken,
) {
    if let Err(error) = future.await {
        failure.lock().unwrap().get_or_insert(error);
        fault.cancel();
    }
}
async fn read(
    mut source: impl AsyncRead + Unpin,
    stream: Stream,
    context: &Context,
    finished: &CancellationToken,
) -> Result<(), String> {
    let drain = async {
        finished.cancelled().await;
        tokio::time::sleep(Duration::from_secs(1)).await;
    };
    tokio::pin!(drain);
    let mut buffer = vec![0; CHUNK_BYTES];
    loop {
        let count = tokio::select! {
            count = source.read(&mut buffer) => count.map_err(|e| e.to_string())?,
            () = &mut drain => return Err("Protocol output drain timed out".into()),
        };
        if count == 0 {
            return Ok(());
        }
        let value = serde_json::to_value(Progress::Output {
            stream,
            bytes: buffer[..count].to_vec(),
        })
        .expect("process output");
        tokio::select! {
            result = context.emit(value) => result?,
            () = &mut drain => return Err("Protocol output drain timed out".into()),
        }
    }
}
