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

use super::control::{Control, ControlError, Input, WriteReceipt};
use super::output::{Output, PtyStream};
use super::{ShellError, Update};
use maka_plugin_core::shell_run::ShellObservation;
use maka_plugin_core::terminal::TerminalSize;
use maka_plugin_core::terminal::input::InputAction;
use maka_plugin_core::terminal::input::encode_actions;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

/// A settled native stop, including whether this caller owned its first signal.
#[derive(Debug)]
pub struct StopReceipt {
    pub record: Arc<ShellObservation>,
    pub applied: bool,
}

pub(super) struct StopState {
    claimed: bool,
    // None is an unknown native signal outcome, never inferred from shell state.
    pub signal_applied: Option<bool>,
}

impl Default for StopState {
    fn default() -> Self {
        Self {
            claimed: false,
            signal_applied: Some(false),
        }
    }
}

#[derive(Clone)]
pub(super) struct PtyControl {
    pub(super) commands: mpsc::Sender<Control>,
    pub(super) output: Output,
}

#[derive(Clone)]
pub struct ShellHandle {
    // Shared across controller generations, including disconnect during input.
    pub(crate) control_gate: Arc<tokio::sync::Mutex<()>>,
    pub(super) snapshot: watch::Receiver<Update>,
    pub(super) cancellation: CancellationToken,
    pub(super) stop: Arc<Mutex<StopState>>,
    pub(super) pty: Option<PtyControl>,
}
impl ShellHandle {
    /// Original shared arbitration gate for trusted native adapters. Hold it
    /// through permission revalidation, enqueue and the native receipt.
    pub fn control_gate(&self) -> Arc<tokio::sync::Mutex<()>> {
        self.control_gate.clone()
    }

    /// Attach to the original ephemeral byte source; no source means no retained
    /// raw output, never a fabricated replay of the durable screen projection.
    pub fn output(&self, after: u64) -> super::Result<Option<PtyStream>> {
        self.pty
            .as_ref()
            .map(|pty| pty.output.stream(after))
            .transpose()
    }

    pub fn latest(&self) -> Update {
        self.snapshot.borrow().clone()
    }

    pub async fn changed(&mut self) -> Result<Arc<ShellObservation>, Arc<ShellError>> {
        self.snapshot
            .changed()
            .await
            .map_err(|_| Arc::new(ShellError::Rejected("shell worker closed")))?;
        self.snapshot
            .borrow_and_update()
            .clone()
            .expect("worker only publishes settled cuts")
    }

    pub async fn ready(&mut self) -> Result<Arc<ShellObservation>, Arc<ShellError>> {
        loop {
            if let Some(result) = self.latest() {
                return result;
            }
            self.changed().await?;
        }
    }

    pub async fn finished(&mut self) -> Result<Arc<ShellObservation>, Arc<ShellError>> {
        loop {
            if let Some(result) = self.latest() {
                let record = result?;
                if !record.state.active() {
                    return Ok(record);
                }
            }
            self.changed().await?;
        }
    }

    /// The last sender belongs to the worker, after native resources and its
    /// residency have been released. A terminal record alone is not this fence.
    pub async fn drained(&mut self) -> Result<Arc<ShellObservation>, Arc<ShellError>> {
        while self.snapshot.changed().await.is_ok() {}
        self.finished().await
    }

    /// Independent of queue/backpressure and of the lifetime of any RPC waiter.
    pub fn stop(&self) {
        self.claim_stop();
    }

    pub async fn stop_and_wait(&mut self) -> Result<StopReceipt, Arc<ShellError>> {
        let owner = self.claim_stop();
        let record = self.finished().await?;
        let applied = if owner {
            self.stop.lock().unwrap().signal_applied.ok_or_else(|| {
                Arc::new(ShellError::Process(
                    maka_agent_facts::tools::ToolError::CleanupUnconfirmed(
                        "shell termination signal outcome unknown".into(),
                    ),
                ))
            })?
        } else {
            false
        };
        Ok(StopReceipt { record, applied })
    }

    fn claim_stop(&self) -> bool {
        let mut stop = self.stop.lock().unwrap();
        if stop.claimed
            || self.cancellation.is_cancelled()
            || self
                .latest()
                .is_some_and(|result| !result.is_ok_and(|record| record.state.active()))
        {
            return false;
        }
        stop.claimed = true;
        self.cancellation.cancel();
        true
    }

    pub async fn input(&self, actions: Vec<InputAction>) -> Result<WriteReceipt, ControlError> {
        self.input_and_resize(actions, None).await
    }

    pub async fn input_and_resize(
        &self,
        actions: Vec<InputAction>,
        size: Option<TerminalSize>,
    ) -> Result<WriteReceipt, ControlError> {
        // Validate before waiting for queue capacity. Encode again on the
        // worker using the current screen cut; this preflight grants no effect.
        let record = self
            .latest()
            .ok_or_else(|| ControlError::new("PTY not ready", 0))?
            .map_err(|e| ControlError::new(e, 0))?;
        let Some(screen) = &record.preview else {
            return Err(ControlError::rejected("resource is not a PTY"));
        };
        encode_actions(&actions, screen.input, size.unwrap_or(screen.size))
            .map_err(ControlError::rejected)?;
        self.control(Input::Actions(actions), size, CancellationToken::new())
            .await
    }

    pub async fn resize(&self, size: TerminalSize) -> Result<(), ControlError> {
        self.write_raw(String::new(), Some(size)).await.map(|_| ())
    }

    /// Raw terminal input includes ESC/C0. Resize and complete input are one
    /// serialized command, validated before either can perform an effect.
    pub async fn write_raw(
        &self,
        input: String,
        size: Option<TerminalSize>,
    ) -> Result<WriteReceipt, ControlError> {
        if input.is_empty() && size.is_none() {
            return Err(ControlError::rejected("PTY input is empty"));
        }
        self.control(Input::Raw(input), size, CancellationToken::new())
            .await
    }

    pub(crate) async fn control(
        &self,
        input: Input,
        size: Option<TerminalSize>,
        cancellation: CancellationToken,
    ) -> Result<WriteReceipt, ControlError> {
        self.enqueue_control(input, size, cancellation)?.await
    }

    /// Queue admission is synchronous; callers may release their authorization
    /// gate before awaiting native I/O. A full queue accepts no input.
    pub fn enqueue_control(
        &self,
        input: Input,
        size: Option<TerminalSize>,
        cancellation: CancellationToken,
    ) -> Result<impl Future<Output = Result<WriteReceipt, ControlError>> + Send + use<>, ControlError>
    {
        if cancellation.is_cancelled() {
            return Err(ControlError::rejected(
                "PTY control cancelled before admission",
            ));
        }
        let (reply, response) = oneshot::channel();
        let commands = &self
            .pty
            .as_ref()
            .ok_or_else(|| ControlError::rejected("resource is not a PTY"))?
            .commands;
        let command = Control {
            input,
            size,
            reply,
            cancellation: cancellation.clone(),
        };
        commands.try_send(command).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => ControlError::rejected("PTY input queue is full"),
            mpsc::error::TrySendError::Closed(_) => ControlError::new("PTY closed", 0),
        })?;
        Ok(async move {
            response
                .await
                .map_err(|_| ControlError::unknown("PTY control outcome unknown"))?
        })
    }
}
