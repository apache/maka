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

//! Custody of admitted browser input and temporary page producers.
//!
//! The operation custodian and caller poll one Shared future. Only the fixed
//! releases of actually issued resources use its captured transport admission.

use super::*;
use futures_util::{FutureExt, future::BoxFuture};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Held(usize);

#[derive(Clone)]
enum Release {
    Screencast,
    ScreencastFrame {
        session_id: serde_json::Number,
    },
    Mouse {
        session: Option<String>,
        params: Value,
    },
    Key {
        modifier: u32,
        previous_modifiers: u32,
        project: Arc<dyn Fn(u32) -> Value + Send + Sync>,
    },
}
impl Release {
    fn request(&self, modifiers: u32) -> (Option<&str>, &'static str, Value) {
        match self {
            Self::Screencast => (None, "Page.stopScreencast", json!({})),
            Self::ScreencastFrame { session_id } => (
                None,
                "Page.screencastFrameAck",
                json!({"sessionId": session_id}),
            ),
            Self::Mouse { session, params } => (
                session.as_deref(),
                "Input.dispatchMouseEvent",
                params.clone(),
            ),
            Self::Key { project, .. } => {
                let mut params = project(modifiers);
                params["type"] = json!("keyUp");
                if let Some(params) = params.as_object_mut() {
                    params.remove("text");
                    params.remove("unmodifiedText");
                    params.remove("commands");
                }
                (None, "Input.dispatchKeyEvent", params)
            }
        }
    }
}
#[derive(Clone, Copy)]
enum ReleaseMethod {
    Screencast,
    ScreencastFrame,
    Mouse,
    Key,
}
impl ReleaseMethod {
    fn name(self) -> &'static str {
        match self {
            Self::Screencast => "Page.stopScreencast",
            Self::ScreencastFrame => "Page.screencastFrameAck",
            Self::Mouse => "Input.dispatchMouseEvent",
            Self::Key => "Input.dispatchKeyEvent",
        }
    }
}
#[derive(Clone)]
struct ReleaseCommand {
    session: Option<String>,
    method: ReleaseMethod,
    params: Value,
}
enum HeldState {
    Issued(Release),
    Releasing(ReleaseCommand),
    Unconfirmed(ReleaseCommand),
}
impl HeldState {
    fn method(&self) -> &'static str {
        match self {
            Self::Issued(Release::Screencast) => ReleaseMethod::Screencast.name(),
            Self::Issued(Release::ScreencastFrame { .. }) => ReleaseMethod::ScreencastFrame.name(),
            Self::Issued(Release::Mouse { .. }) => ReleaseMethod::Mouse.name(),
            Self::Issued(Release::Key { .. }) => ReleaseMethod::Key.name(),
            Self::Releasing(command) | Self::Unconfirmed(command) => command.method.name(),
        }
    }
}
#[derive(Default)]
struct Dispatch {
    pending: usize,
    accepted: usize,
    uncertain: usize,
}
impl Dispatch {
    fn may_have_run(&self) -> bool {
        self.pending != 0 || self.accepted != 0 || self.uncertain != 0
    }
    fn accepted_or_unknown(&self) -> bool {
        self.accepted != 0 || self.uncertain != 0
    }
}
#[derive(Clone, Copy)]
enum BodyProgress {
    Unpolled,
    Polled,
}
enum Completion {
    Running,
    Confirmed,
    Unconfirmed(ToolError),
}
struct State {
    held: Vec<Option<HeldState>>,
    dispatch: Dispatch,
    body: BodyProgress,
    cleanup_failure: Option<ToolError>,
    modifiers: u32,
    completion: Completion,
    // This is the original admission/lifetime gate, not proof of release.
    admission: Option<extension::OwnedInputAdmission>,
}

/// One actual resource on the existing canonical Host.tabs lease. No owner,
/// session, target, public handle, or permission cache is allocated here.
pub(super) struct Resource {
    turn: String,
    execution: crate::ExecutionCorrelation,
    epoch: crate::desktop::NativeEpochId,
    state: Mutex<State>,
}
impl Resource {
    fn new(
        admission: extension::OwnedInputAdmission,
        turn: &str,
        execution: &crate::ExecutionCorrelation,
        epoch: crate::desktop::NativeEpochId,
    ) -> Self {
        Self {
            turn: turn.to_owned(),
            execution: execution.clone(),
            epoch,
            state: Mutex::new(State {
                held: Vec::new(),
                dispatch: Dispatch::default(),
                body: BodyProgress::Unpolled,
                cleanup_failure: None,
                modifiers: 0,
                completion: Completion::Running,
                admission: Some(admission),
            }),
        }
    }
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .expect("owned browser input lock poisoned")
    }
    pub(super) fn belongs(
        &self,
        turn: Option<&str>,
        execution: Option<&crate::ExecutionCorrelation>,
        epoch: Option<crate::desktop::NativeEpochId>,
    ) -> bool {
        turn.is_none_or(|turn| self.turn == turn)
            && execution.is_none_or(|execution| &self.execution == execution)
            && epoch.is_none_or(|epoch| self.epoch == epoch)
    }
    pub(super) fn check_settled(&self) -> Result<(), ToolError> {
        match &self.state().completion {
            Completion::Confirmed => Ok(()),
            Completion::Running => Err(ToolError::CleanupUnconfirmed(
                "the original owned input sequence is still pending; custody retained".into(),
            )),
            Completion::Unconfirmed(error) => Err(error.clone()),
        }
    }
    fn interrupted(&self, message: &str) -> ToolError {
        let state = self.state();
        // DOWN counts do not describe the entire sequence: leading movement,
        // scroll, UI and cleanup requests can have effects without a press.
        // Only a genuinely never-polled body provides this local no-effect
        // proof. Once polled, the original continuation remains authoritative.
        if matches!(state.body, BodyProgress::Polled) || state.dispatch.may_have_run() {
            unknown(format!(
                "{message}; original input custody retained; do not replay"
            ))
        } else {
            failed(message)
        }
    }
    fn issued(&self, release: Release, modifiers: Option<u32>) -> Held {
        let mut state = self.state();
        state.dispatch.pending += 1;
        if let Some(modifiers) = modifiers {
            state.modifiers = modifiers;
        }
        let held = Held(state.held.len());
        state.held.push(Some(HeldState::Issued(release)));
        held
    }
    fn press_finished(&self, held: Held, outcome: &anyhow::Result<Value>) {
        use cua_driver_core::browser::{
            CdpFailureDisposition,
            cdp_ws::{CdpReplyError, ExtensionCdpRefusal},
        };
        let mut state = self.state();
        state.dispatch.pending -= 1;
        let Err(error) = outcome else {
            state.dispatch.accepted += 1;
            return;
        };
        let disposition = error
            .downcast_ref::<CdpReplyError>()
            .map(CdpReplyError::disposition)
            .or_else(|| {
                error
                    .downcast_ref::<ExtensionCdpRefusal>()
                    .map(ExtensionCdpRefusal::disposition)
            });
        match disposition {
            // Only the trusted producer can say this original call did not run.
            Some(CdpFailureDisposition::NotDispatched) => {
                if let Some(HeldState::Issued(Release::Key {
                    previous_modifiers, ..
                })) = state.held[held.0].take()
                {
                    state.modifiers = previous_modifiers;
                }
            }
            Some(CdpFailureDisposition::ReplyFailure) => {}
            _ => {
                state.dispatch.uncertain += 1;
            }
        }
    }
    fn take_release(&self, held: Held) -> Option<ReleaseCommand> {
        let mut state = self.state();
        let slot = state.held.get_mut(held.0)?;
        let release = match slot.take() {
            Some(HeldState::Issued(release)) => release,
            other => {
                *slot = other;
                return None;
            }
        };
        if let Release::Key { modifier, .. } = &release {
            state.modifiers &= !modifier;
        }
        let (session, _, params) = release.request(state.modifiers);
        let command = ReleaseCommand {
            session: session.map(str::to_owned),
            method: match release {
                Release::Screencast => ReleaseMethod::Screencast,
                Release::ScreencastFrame { .. } => ReleaseMethod::ScreencastFrame,
                Release::Mouse { .. } => ReleaseMethod::Mouse,
                Release::Key { .. } => ReleaseMethod::Key,
            },
            params,
        };
        // Retain the exact attempted UP payload and source route even after a
        // terminal Err future is discarded. It is evidence, never a retry queue.
        state.held[held.0] = Some(HeldState::Releasing(command.clone()));
        Some(command)
    }
    fn release_finished(&self, held: Held, result: &Result<Value, ToolError>) {
        let mut state = self.state();
        match result {
            Ok(_) => state.held[held.0] = None,
            Err(error) => {
                let slot = state.held[held.0].take();
                state.held[held.0] = match slot {
                    Some(HeldState::Releasing(command)) => Some(HeldState::Unconfirmed(command)),
                    other => other,
                };
                state.cleanup_failure = Some(ToolError::CleanupUnconfirmed(format!(
                    "owned input release was not acknowledged: {error}; custody retained"
                )));
            }
        }
    }
    fn finish(&self) -> Result<(), ToolError> {
        let mut state = self.state();
        if state.held.iter().any(Option::is_some) || state.cleanup_failure.is_some() {
            let error = state.cleanup_failure.clone().unwrap_or_else(|| {
                let method = state
                    .held
                    .iter()
                    .flatten()
                    .next()
                    .map(HeldState::method)
                    .unwrap_or("input");
                ToolError::CleanupUnconfirmed(format!(
                    "owned {method} release remains unconfirmed; custody retained"
                ))
            });
            state.completion = Completion::Unconfirmed(error.clone());
            // Keep the original admission and lifetime permit on this actual
            // lease even after a local custodian drops a terminal Err future.
            Err(error)
        } else {
            state.completion = Completion::Confirmed;
            drop(state.admission.take());
            Ok(())
        }
    }
}

pub(super) fn mouse_release(down: &Value) -> Value {
    let mut up = down.clone();
    up["type"] = json!("mouseReleased");
    if up.get("buttons").is_some() {
        up["buttons"] = json!(0);
    }
    up
}

/// Mechanical access to the exact route captured before the first press.
/// It cannot attach, navigate, transfer a claim, or issue an arbitrary cleanup.
#[derive(Clone)]
pub(super) struct Sequence {
    socket: Cdp,
    resource: Arc<Resource>,
    cancellation: CancellationToken,
}
impl Sequence {
    pub(super) async fn start_screencast(&self, params: Value) -> Result<Option<Held>, ToolError> {
        check_input(&self.cancellation)?;
        if let Some(dialogs) = &self.socket.dialogs {
            dialogs.synchronize().await;
            dialogs.state.check_method("Page.startScreencast")?;
        }
        let _admission = self.socket.preparation.before_request().await?;
        check_input(&self.cancellation)?;
        let held = self.resource.issued(Release::Screencast, None);
        let result = match &self.socket.extension_context {
            Some(context) => {
                self.socket
                    .connection
                    .call_with_extension_context(context, None, "Page.startScreencast", params)
                    .await
            }
            None => {
                self.socket
                    .connection
                    .call(None, "Page.startScreencast", params)
                    .await
            }
        };
        self.resource.press_finished(held, &result);
        match result {
            Ok(_) => Ok(Some(held)),
            Err(error) => {
                use cua_driver_core::browser::{CdpFailureDisposition, cdp_ws::CdpReplyError};
                // The matched protocol method-not-found reply establishes that
                // no screencast producer was created. Host refusal and unknown
                // transport outcomes never become an observation fallback.
                if let Some(reply) = error.downcast_ref::<CdpReplyError>()
                    && reply.method() == "Page.startScreencast"
                    && reply.code().is_some()
                    && reply.disposition() == CdpFailureDisposition::ReplyFailure
                {
                    if reply.code() == Some(-32601) {
                        self.resource.state().held[held.0] = None;
                    }
                    // Other matched Chrome errors still require the already
                    // registered stop to settle before selecting fallback.
                    return Ok(None);
                }
                Err(Cdp::failure(error))
            }
        }
    }
    pub(super) fn screencast_frame(&self, session_id: serde_json::Number) -> Held {
        // Only an event from this sequence's captured CDP connection reaches
        // this method; the number is an ACK token, never a grant or target.
        let mut state = self.resource.state();
        let held = Held(state.held.len());
        state
            .held
            .push(Some(HeldState::Issued(Release::ScreencastFrame {
                session_id,
            })));
        held
    }
    async fn press(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
        release: Release,
    ) -> Result<Held, ToolError> {
        check_input(&self.cancellation)?;
        if let Some(dialogs) = &self.socket.dialogs {
            dialogs.synchronize().await;
            dialogs.state.check_method(method)?;
        }
        // Each new DOWN retains the ordinary current permission check. This
        // check precedes the issued entry and cannot authorize a cleanup UP.
        let _admission = self.socket.preparation.before_request().await?;
        check_input(&self.cancellation)?;
        let modifiers = matches!(&release, Release::Key { .. })
            .then(|| params["modifiers"].as_u64().unwrap_or(0) as u32);
        let held = self.resource.issued(release, modifiers);
        // There is no observation timeout/select around this Required future.
        // Its one continuation is retained before any first poll can reach here.
        let result = match &self.socket.extension_context {
            Some(context) => {
                self.socket
                    .connection
                    .call_with_extension_context(context, session, method, params)
                    .await
            }
            None => self.socket.connection.call(session, method, params).await,
        };
        self.resource.press_finished(held, &result);
        if let Some(dialogs) = &self.socket.dialogs {
            dialogs.synchronize().await;
        }
        result.map_err(Cdp::failure)?;
        Ok(held)
    }
    pub(super) async fn mouse_down(
        &self,
        session: Option<&str>,
        params: Value,
    ) -> Result<Held, ToolError> {
        let up = mouse_release(&params);
        self.press(
            session,
            "Input.dispatchMouseEvent",
            params,
            Release::Mouse {
                session: session.map(str::to_owned),
                params: up,
            },
        )
        .await
    }
    pub(super) async fn key_down(
        &self,
        params: Value,
        modifier: u32,
        project: impl Fn(u32) -> Value + Send + Sync + 'static,
    ) -> Result<Held, ToolError> {
        let previous_modifiers = self.resource.state().modifiers;
        self.press(
            None,
            "Input.dispatchKeyEvent",
            params,
            Release::Key {
                modifier,
                previous_modifiers,
                project: Arc::new(project),
            },
        )
        .await
    }
    pub(super) fn mouse_position(&self, held: Held, point: [f64; 2]) {
        if let Some(Some(HeldState::Issued(Release::Mouse { params, .. }))) =
            self.resource.state().held.get_mut(held.0)
        {
            params["x"] = json!(point[0]);
            params["y"] = json!(point[1]);
        }
    }
    pub(super) async fn release(&self, held: Held) -> Result<(), ToolError> {
        let Some(command) = self.resource.take_release(held) else {
            return Ok(());
        };
        let session = command.session.as_deref();
        let method = command.method.name();
        let params = command.params;
        // SAME connection/session/wire and pre-issued operation admission. No
        // fresh Agent grant, Host lock, cancellation check, or arbitrary method.
        let result = match &self.socket.extension_context {
            Some(context) => {
                self.socket
                    .connection
                    .call_with_extension_context(context, session, method, params)
                    .await
            }
            None => self.socket.connection.call(session, method, params).await,
        }
        .map_err(Cdp::failure);
        self.resource.release_finished(held, &result);
        if let Some(dialogs) = &self.socket.dialogs {
            dialogs.synchronize().await;
        }
        result.map(|_| ())
    }
    async fn cleanup(&self) -> Result<(), ToolError> {
        let count = self.resource.state().held.len();
        // Attempt every owned key/button even when a sibling UP failed. An
        // attempted/unknown UP is never reissued by this or a later Stop.
        for index in (0..count).rev() {
            let _ = self.release(Held(index)).await;
        }
        self.resource.finish()
    }
}

async fn complete_sequence(
    cleanup: Sequence,
    mut future: BoxFuture<'static, Result<(), ToolError>>,
) -> Result<(), ToolError> {
    let result = if cleanup.cancellation.is_cancelled() {
        Err(failed(
            "Browser input cancelled before its original sequence started",
        ))
    } else {
        // Track the first poll of this SAME retained body, including all of its
        // Required awaits. This is not a peer assertion or a replacement future.
        std::future::poll_fn(|context| {
            cleanup.resource.state().body = BodyProgress::Polled;
            future.as_mut().poll(context)
        })
        .await
    };
    if let Err(error) = &result
        && required_completion(Err(error.clone())).is_err()
    {
        // Preserve actual cleanup/persistence failures. The body's external
        // outcome remains in result; acknowledged releases settle input custody.
        let mut state = cleanup.resource.state();
        if state.cleanup_failure.is_none() {
            state.cleanup_failure = Some(error.clone());
        }
    }
    let released = cleanup.cleanup().await;
    cleanup.resource.check_settled()?;
    released?;
    result.map_err(|error| {
        if matches!(error, ToolError::Failed(_))
            && cleanup.resource.state().dispatch.accepted_or_unknown()
        {
            unknown(format!(
                "{error}; physical input already began; do not replay"
            ))
        } else {
            error
        }
    })
}

fn required_completion(result: Result<(), ToolError>) -> Result<(), ToolError> {
    match result {
        Err(
            error @ (ToolError::CleanupUnconfirmed(_)
            | ToolError::Persistence(_)
            | ToolError::OperationCleanupUnconfirmed { .. }),
        ) => Err(error),
        _ => Ok(()),
    }
}

struct StopObserver(CancellationToken);
impl Drop for StopObserver {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
async fn retained_sequence(
    settlement: Arc<dyn crate::OperationSettlement>,
    resource: Arc<Resource>,
    cancellation: CancellationToken,
    deadline: Option<tokio::time::Instant>,
    future: BoxFuture<'static, Result<(), ToolError>>,
) -> Result<(), ToolError> {
    let _stop = StopObserver(cancellation.clone());
    if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
        cancellation.cancel();
    }
    let future = future.shared();
    let retained = future.clone();
    if let Err((error, pending)) =
        settlement.retain_checked(Box::pin(async move { required_completion(retained.await) }))
    {
        // A refusal returns the SAME continuation intact. Fence subsequent
        // unsent input and drain it locally; do not wait for a passive retainer.
        cancellation.cancel();
        let _ = future.await;
        pending.await?;
        return Err(error);
    }
    let timeout = async move {
        match deadline {
            Some(deadline) => tokio::time::sleep_until(deadline).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(timeout);
    tokio::select! { biased;
        result=future=>result,
        ()=cancellation.cancelled()=>Err(resource.interrupted("Browser input cancelled")),
        ()=&mut timeout=>Err(resource.interrupted("CUA click input deadline exceeded")),
    }
}

impl Tab {
    pub(super) async fn owned_input(
        &self,
        cancellation: &CancellationToken,
        deadline: Option<tokio::time::Instant>,
        body: impl FnOnce(Tab, Sequence, CancellationToken) -> BoxFuture<'static, Result<(), ToolError>>
        + Send,
    ) -> Result<(), ToolError> {
        check_input(cancellation)?;
        let settlement = self
            .attachment_settlement
            .clone()
            .ok_or_else(|| failed("Browser input requires its original Host settlement custody"))?;
        let socket = self
            .connection
            .as_ref()
            .map(TabConnection::socket)
            .ok_or_else(|| failed("tab connection unavailable"))?
            .clone();
        let admission = socket.preparation.before_owned_input().await?;
        let resource = Arc::new(Resource::new(
            admission,
            &self.last_turn,
            &self.last_execution,
            self.cursor_epoch,
        ));
        let identity = self.identity()?;
        let mut branch = self.wait_observation_branch(socket.connection.subscribe())?;
        branch.origin_proof = self.origin_proof.clone();
        branch.cursor_world = self.cursor_world.clone();
        let stop = cancellation.child_token();
        self.cursor_host.lock().await.reserve_owned_input(
            identity,
            self.cursor_owner,
            &self.last_turn,
            &self.last_execution,
            self.provider.clone(),
            self.generation.clone(),
            resource.clone(),
        )?;
        let sequence = Sequence {
            socket,
            resource: resource.clone(),
            cancellation: stop.clone(),
        };
        // Cleanup and all Required awaits stay in this one retained future.
        let cleanup = sequence.clone();
        let future = body(branch, sequence, stop.clone());
        let complete = Box::pin(complete_sequence(cleanup, future));
        retained_sequence(settlement, resource, stop, deadline, complete).await
    }
    pub(super) async fn check_owned_input(&self) -> Result<(), ToolError> {
        self.cursor_host
            .lock()
            .await
            .check_owned_input(&self.identity()?)
    }
}
