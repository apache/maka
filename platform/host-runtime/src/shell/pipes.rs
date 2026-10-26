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

use super::{
    Result, ShellError, Update,
    handle::StopState,
    terminal::Decoder,
    worker::{exit_outcome, failed, finished, now},
};
use maka_agent_facts::shell_run::PipeStream;
use maka_agent_facts::shell_run::ShellOutcome;
use maka_agent_facts::shell_run::ShellOutput;
use maka_agent_facts::shell_run::ShellPatch;
use maka_agent_facts::shell_run::ShellRun;
use maka_agent_facts::shell_run::ShellState;
use maka_agent_facts::tools::ToolError;
use maka_event_log::StoreError;
use maka_event_log::root_store::SessionStore;
use maka_process::{ObservedProcess, PipeEvent, ProcessOutcome, Termination};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

pub(super) async fn run(
    log: SessionStore,
    mut record: ShellRun,
    mut process: ObservedProcess,
    updates: &watch::Sender<Update>,
    cancellation: &CancellationToken,
    drain: &CancellationToken,
    stop: &Mutex<StopState>,
) -> Result<()> {
    if cancellation.is_cancelled() {
        return Err(ShellError::CancelledBeforeAdmission);
    }
    record = match log.create_shell_run(record).await {
        Ok(record) => record,
        Err(error) => {
            if matches!(
                error,
                StoreError::CommitUnknown(_) | StoreError::OperationUnknown
            ) {
                drain.cancel();
            }
            return Err(error.into());
        }
    };
    // The prepared native future has not been polled before T1.
    let mut stdout = Decoder::default();
    let mut stderr = Decoder::default();
    let mut persistence_error = None;
    let mut events_open = true;
    let result = loop {
        tokio::select! {
            biased;
            event = process.events.recv(), if events_open => {
                let Some(event) = event else { events_open = false; continue; };
                if persistence_error.is_some() { continue; }
                let mut running = false;
                observe(event, &mut record, &mut stdout, &mut stderr, &mut running);
                // Coalesce at most the bounded queue, without starving cleanup.
                for _ in 0..7 {
                    let Ok(event) = process.events.try_recv() else { break; };
                    observe(event, &mut record, &mut stdout, &mut stderr, &mut running);
                }
                if running {
                    if let Err(error) = persist(&log, &mut record, Some(ShellState::Running), updates).await {
                        drain.cancel();
                        cancellation.cancel();
                        persistence_error = Some(error);
                    }
                } else {
                    updates.send_replace(Some(Ok(Arc::new(record.clone().into()))));
                }
            }
            result = &mut process.completion => break result,
        }
    };
    // Completion owns native teardown. Consume any final observations before
    // publishing the complete bounded native capture and terminal state.
    let mut running = false;
    while let Ok(event) = process.events.try_recv() {
        observe(event, &mut record, &mut stdout, &mut stderr, &mut running);
    }
    if let Some(error) = persistence_error {
        return Err(error); // Never repair commit uncertainty with a guessed T2.
    }
    let outcome = match result {
        Ok(captured) => {
            let latest_stream = match &record.output {
                ShellOutput::Pipes { latest_stream, .. } => *latest_stream,
                ShellOutput::Pty { .. } => unreachable!(),
            };
            record.output = ShellOutput::Pipes {
                stdout: captured.stdout,
                stderr: captured.stderr,
                latest_stream,
                stdout_truncated: captured.stdout_truncated,
                stderr_truncated: captured.stderr_truncated,
            };
            match captured.outcome {
                ProcessOutcome::Exited(status) => exit_outcome(status),
                ProcessOutcome::Interrupted {
                    reason: Termination::Cancelled,
                    signal_applied,
                } => {
                    stop.lock().unwrap().signal_applied = Some(signal_applied);
                    ShellOutcome::Cancelled { message: None }
                }
                ProcessOutcome::Interrupted {
                    reason: Termination::Timeout,
                    ..
                } => ShellOutcome::TimedOut { message: None },
            }
        }
        Err(error @ ToolError::CleanupUnconfirmed(_)) => {
            drain.cancel();
            return Err(error.into());
        }
        Err(error) => failed(&error),
    };
    if running && record.state == ShellState::Starting {
        persist(&log, &mut record, Some(ShellState::Running), updates)
            .await
            .inspect_err(|_| drain.cancel())?;
    }
    persist(&log, &mut record, Some(finished(outcome)?), updates)
        .await
        .inspect_err(|_| drain.cancel())
}

fn observe(
    event: PipeEvent,
    record: &mut ShellRun,
    stdout_decoder: &mut Decoder,
    stderr_decoder: &mut Decoder,
    running: &mut bool,
) {
    let (stream, bytes) = match event {
        PipeEvent::Started => {
            *running = true;
            return;
        }
        PipeEvent::Output { stream, bytes } => (stream, bytes),
    };
    let ShellOutput::Pipes {
        stdout,
        stderr,
        latest_stream,
        stdout_truncated,
        stderr_truncated,
    } = &mut record.output
    else {
        unreachable!()
    };
    let (target, truncated, decoder) = match stream {
        PipeStream::Stdout => (stdout, stdout_truncated, stdout_decoder),
        PipeStream::Stderr => (stderr, stderr_truncated, stderr_decoder),
    };
    target.push_str(&decoder.decode(&bytes, false));
    let mut start = target.len().saturating_sub(65_536);
    while !target.is_char_boundary(start) {
        start += 1;
    }
    if start > 0 {
        target.drain(..start);
        *truncated = true;
    }
    *latest_stream = Some(stream);
}

async fn persist(
    log: &SessionStore,
    record: &mut ShellRun,
    state: Option<ShellState>,
    updates: &watch::Sender<Update>,
) -> Result<()> {
    *record = log
        .patch_shell_run(
            &record.session_id,
            &record.id,
            ShellPatch {
                state,
                output: Some(record.output.clone()),
                updated_at: Some(now()?),
                ..Default::default()
            },
        )
        .await?;
    updates.send_replace(Some(Ok(Arc::new(record.clone().into()))));
    Ok(())
}
