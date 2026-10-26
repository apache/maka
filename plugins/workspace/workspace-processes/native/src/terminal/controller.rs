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
use maka_agent_facts::terminal::input::encoded_actions_byte_len;
use maka_host_runtime::{
    application::Caller,
    shell::{ControlErrorKind, ControlInput, ShellHandle},
};
use std::sync::Mutex;
use uuid::Uuid;

pub(in super::super) struct Lease {
    pub controller: Controller,
    pub cancellation: CancellationToken,
    caller: Caller,
    handle: ShellHandle,
    next_sequence: u64,
    replay: Option<(Control, ControlReceipt)>,
}
struct Release {
    state: Arc<Mutex<Vec<Lease>>>,
    controller: Uuid,
    cancellation: CancellationToken,
    handle: ShellHandle,
}
impl Release {
    async fn finish(&self) {
        self.cancellation.cancel();
        let gate = self.handle.control_gate();
        let _joined = gate.lock().await;
        self.remove();
    }
    fn remove(&self) {
        self.state
            .lock()
            .unwrap()
            .retain(|lease| lease.controller.controller_id != self.controller);
    }
}
impl Drop for Release {
    fn drop(&mut self) {
        // Unexpected handler unwind also closes admission. Its resource Ticket
        // reports unconfirmed cleanup; the independent accepted control still joins.
        self.cancellation.cancel();
        self.remove();
    }
}
fn caller(context: &Context) -> Result<&Caller, ToolError> {
    context
        .caller()
        .ok_or_else(|| failed("Terminal control requires an authenticated caller"))
}
fn matches(lease: &Lease, controller: &Controller, caller: &Caller) -> bool {
    lease.controller == *controller && lease.caller == *caller
}
impl Processes {
    async fn terminal_authorize(
        &self,
        target: &Target,
        handle: &ShellHandle,
        context: &Context,
    ) -> Result<Arc<ShellObservation>, ToolError> {
        let current = self
            .terminal_session(&target.session_id, true, context)
            .await?;
        let record = handle
            .latest()
            .ok_or_else(|| failed("Terminal is not ready"))?
            .map_err(worker_error)?;
        if !record.state.active() || !record.output.is_pty() {
            return Err(failed("Only an active PTY can be controlled"));
        }
        if current.configuration.permission_basis() != record.permissions.basis {
            return Err(failed(
                "PTY launch permissions no longer match this Session; start a new terminal",
            ));
        }
        Ok(record)
    }
    pub(super) async fn terminal_acquire(
        &self,
        target: Target,
        context: &Context,
    ) -> Result<Value, ToolError> {
        let caller = caller(context)?.clone();
        let id = self.terminal_id(&target)?;
        let mut handle = self
            .resources
            .get(&target.session_id, id)
            .ok_or_else(|| failed("Active PTY is not available"))?;
        let gate = handle.control_gate();
        let guard = tokio::select! { biased;
            _ = context.scope().cancellation.cancelled() => return Err(failed("Terminal acquire cancelled")),
            guard = gate.lock() => guard,
        };
        let record = self.terminal_authorize(&target, &handle, context).await?;
        cancelled(&context.scope().cancellation)?;
        if self.drain.is_cancelled() {
            return Err(failed("Process owner is draining"));
        }
        // The Host creates a fresh controller ID for each original subscription.
        // A reopened subscription cannot reuse an old generation's sequence.
        let controller = Controller {
            target,
            controller_id: Uuid::new_v4(),
        };
        let cancellation = context.scope().cancellation.child_token();
        {
            let mut state = self.controllers.lock().unwrap();
            state.retain(|lease| !lease.cancellation.is_cancelled());
            if state
                .iter()
                .any(|lease| lease.controller.target == controller.target)
            {
                return Err(failed("Terminal already has a connected controller"));
            }
            state.push(Lease {
                controller: controller.clone(),
                cancellation: cancellation.clone(),
                caller,
                handle: handle.clone(),
                next_sequence: 1,
                replay: None,
            });
        }
        let release = Release {
            state: self.controllers.clone(),
            controller: controller.controller_id,
            cancellation: cancellation.clone(),
            handle: handle.clone(),
        };
        drop(guard);
        let result = async {
            let value = completed(LeaseUpdate {
                controller_id: controller.controller_id,
                next_sequence: Some(1),
                held: true,
                resource: snapshot((*record).clone())?,
            })?;
            tokio::select! { biased;
                _ = cancellation.cancelled() => {},
                emitted = context.emit(value) => emitted.map_err(failed)?,
            }
            loop {
                if cancellation.is_cancelled() || self.drain.is_cancelled() {
                    break;
                }
                if let Some(record) = handle.latest()
                    && !record.map_err(worker_error)?.state.active()
                {
                    break;
                }
                tokio::select! { biased;
                    _ = cancellation.cancelled() => break,
                    _ = self.drain.cancelled() => break,
                    record = handle.changed() => { record.map_err(worker_error)?; },
                }
            }
            Ok::<_, ToolError>(())
        }
        .await;
        // This fence waits for any input admitted by this lease before returning
        // its final result. It releases only the lease, never the background task.
        release.finish().await;
        result?;
        let record = handle
            .latest()
            .ok_or_else(|| failed("Terminal snapshot unavailable"))?
            .map_err(worker_error)?;
        completed(LeaseUpdate {
            controller_id: controller.controller_id,
            next_sequence: None,
            held: false,
            resource: snapshot((*record).clone())?,
        })
    }
    pub(super) async fn terminal_control(
        &self,
        input: Control,
        context: &Context,
    ) -> Result<ControlReceipt, ToolError> {
        let caller = caller(context)?;
        self.terminal_id(&input.controller.target)?;
        if input.controller.controller_id.is_nil()
            || input.sequence == 0
            || input.sequence > MAX_SEQUENCE
            || (input.actions.is_empty() && input.size.is_none())
        {
            return Err(failed("Invalid terminal control"));
        }
        if !input.actions.is_empty() {
            encoded_actions_byte_len(&input.actions).map_err(failed)?;
        }
        let handle = {
            let state = self.controllers.lock().unwrap();
            state
                .iter()
                .find(|lease| {
                    matches(lease, &input.controller, caller) && !lease.cancellation.is_cancelled()
                })
                .map(|lease| lease.handle.clone())
                .ok_or_else(|| failed("Terminal controller is not held by this caller"))?
        };
        let gate = handle.control_gate();
        let _guard = tokio::select! { biased;
            _ = context.scope().cancellation.cancelled() => return Err(failed("Terminal input cancelled before admission")),
            guard = gate.lock() => guard,
        };
        self.terminal_authorize(&input.controller.target, &handle, context)
            .await?;
        cancelled(&context.scope().cancellation)?;
        if self.drain.is_cancelled() {
            return Err(failed("Process owner is draining"));
        }
        let pending = {
            let state = self.controllers.lock().unwrap();
            let lease = state
                .iter()
                .find(|lease| {
                    matches(lease, &input.controller, caller) && !lease.cancellation.is_cancelled()
                })
                .ok_or_else(|| failed("Terminal controller subscription ended"))?;
            if let Some((previous, result)) = &lease.replay
                && previous.sequence == input.sequence
            {
                return if *previous == input {
                    Ok(result.clone())
                } else {
                    Err(failed(
                        "Controller sequence was retried with different input",
                    ))
                };
            }
            if input.sequence != lease.next_sequence {
                return Err(failed("Controller sequence is out of order"));
            }
            let data = if input.actions.is_empty() {
                ControlInput::Raw(String::new())
            } else {
                ControlInput::Interactive(input.actions.clone())
            };
            // Synchronous acceptance while the exact lease is still live. Its
            // later cancellation closes new admission, not this accepted effect.
            handle.enqueue_control(data, input.size, CancellationToken::new())
        };
        let result = match pending {
            Ok(receipt) => receipt.await,
            Err(error) => Err(error),
        };
        match result {
            Ok(result) => {
                let receipt = ControlReceipt {
                    controller_id: input.controller.controller_id,
                    sequence: input.sequence,
                    accepted_bytes: result.accepted_bytes,
                    resized: result.resized,
                    resize_changed: result.resize_changed,
                };
                if let Some(lease) = self
                    .controllers
                    .lock()
                    .unwrap()
                    .iter_mut()
                    .find(|lease| matches(lease, &input.controller, caller))
                {
                    lease.replay = Some((input.clone(), receipt.clone()));
                    if input.sequence == MAX_SEQUENCE {
                        lease.cancellation.cancel();
                    } else {
                        lease.next_sequence += 1;
                    }
                }
                Ok(receipt)
            }
            Err(error) => match error.kind {
                ControlErrorKind::Rejected => Err(failed(error)),
                ControlErrorKind::Unknown => Err(ToolError::CleanupUnconfirmed(error.to_string())),
                ControlErrorKind::Closed => {
                    if let Some(lease) = self
                        .controllers
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|lease| matches(lease, &input.controller, caller))
                    {
                        lease.cancellation.cancel();
                    }
                    let mut handle = handle;
                    handle.stop();
                    handle.drained().await.map_err(worker_error)?;
                    Err(failed(error))
                }
            },
        }
    }
    pub(super) async fn terminal_release(
        &self,
        controller: Controller,
        context: &Context,
    ) -> Result<Released, ToolError> {
        let caller = caller(context)?;
        self.terminal_session(&controller.target.session_id, false, context)
            .await?;
        self.terminal_id(&controller.target)?;
        if controller.controller_id.is_nil() {
            return Err(failed("Invalid terminal controller"));
        }
        let release = {
            let state = self.controllers.lock().unwrap();
            match state
                .iter()
                .find(|lease| lease.controller.target == controller.target)
            {
                Some(lease) if matches(lease, &controller, caller) => {
                    lease.cancellation.cancel();
                    Some(Release {
                        state: self.controllers.clone(),
                        controller: controller.controller_id,
                        cancellation: lease.cancellation.clone(),
                        handle: lease.handle.clone(),
                    })
                }
                Some(_) => {
                    return Err(failed(
                        "Terminal controller is held by another caller or subscription",
                    ));
                }
                None => None,
            }
        };
        if let Some(release) = &release {
            release.finish().await;
        }
        Ok(Released {
            controller_id: controller.controller_id,
            released: release.is_some(),
        })
    }
}
