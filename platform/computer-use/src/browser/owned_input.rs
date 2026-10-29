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

//! Custody of the original, already admitted DOWN -> UP sequence.
//!
//! The operation custodian and caller poll one Shared future. Only the fixed
//! releases of actually issued inputs use its captured transport admission.

use super::*;
use futures_util::{FutureExt, future::BoxFuture};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Held(usize);

#[derive(Clone)]
enum Release {
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
    Mouse,
    Key,
}
impl ReleaseMethod {
    fn name(self) -> &'static str {
        match self {
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
    uncertainty: Option<ToolError>,
    modifiers: u32,
    completion: Completion,
    // This is the original admission/lifetime gate, not proof of release.
    admission: Option<extension::OwnedInputAdmission>,
}

/// One actual resource on the existing canonical Host.tabs lease. No owner,
/// session, target, public handle, or permission cache is allocated here.
pub(super) struct Resource {
    turn: String,
    epoch: crate::desktop::NativeEpochId,
    state: Mutex<State>,
}
impl Resource {
    fn new(
        admission: extension::OwnedInputAdmission,
        turn: &str,
        epoch: crate::desktop::NativeEpochId,
    ) -> Self {
        Self {
            turn: turn.to_owned(),
            epoch,
            state: Mutex::new(State {
                held: Vec::new(),
                dispatch: Dispatch::default(),
                body: BodyProgress::Unpolled,
                uncertainty: None,
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
        epoch: Option<crate::desktop::NativeEpochId>,
    ) -> bool {
        turn.is_none_or(|turn| self.turn == turn) && epoch.is_none_or(|epoch| self.epoch == epoch)
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
                state.uncertainty = Some(unknown(format!(
                    "the owned input press outcome is unknown: {error}; do not replay"
                )))
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
                state.uncertainty = Some(ToolError::CleanupUnconfirmed(format!(
                    "owned input release was not acknowledged: {error}; custody retained"
                )));
            }
        }
    }
    fn finish(&self) -> Result<(), ToolError> {
        let mut state = self.state();
        if state.held.iter().any(Option::is_some) || state.uncertainty.is_some() {
            let error = state.uncertainty.clone().unwrap_or_else(|| {
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
        // A known UP ACK settles only that release. It cannot erase an unknown
        // preceding motion/UI/press effect or the original operation receipt.
        let mut state = cleanup.resource.state();
        if state.uncertainty.is_none() {
            state.uncertainty = Some(error.clone());
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
            error @ (ToolError::OutcomeUnknown(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::Persistence(_)
            | ToolError::OperationUnknown { .. }
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
            .socket
            .as_ref()
            .ok_or_else(|| failed("tab connection unavailable"))?
            .clone();
        let admission = socket.preparation.before_owned_input().await?;
        let resource = Arc::new(Resource::new(admission, &self.last_turn, self.cursor_epoch));
        let identity = self.identity()?;
        let mut branch = self.wait_observation_branch(socket.connection.subscribe())?;
        branch.origin_proof = self.origin_proof.clone();
        branch.cursor_world = self.cursor_world.clone();
        let stop = cancellation.child_token();
        self.cursor_host.lock().await.reserve_owned_input(
            identity,
            self.cursor_owner,
            &self.last_turn,
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

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::{sync::mpsc, task::JoinHandle};
    use tokio_tungstenite::tungstenite::Message;

    #[derive(Default)]
    struct Kept(Mutex<Vec<crate::CheckedSettlementFuture>>);
    impl crate::OperationSettlement for Kept {
        fn retain(
            &self,
            pending: crate::SettlementFuture,
        ) -> Result<(), (ToolError, crate::SettlementFuture)> {
            Err((failed("fixture requires checked custody"), pending))
        }
        fn retain_checked(
            &self,
            pending: crate::CheckedSettlementFuture,
        ) -> Result<(), (ToolError, crate::CheckedSettlementFuture)> {
            // Intentionally passive, matching the local operation Settlement.
            self.0.lock().unwrap().push(pending);
            Ok(())
        }
    }
    impl Kept {
        fn take(&self) -> crate::CheckedSettlementFuture {
            let mut kept = self.0.lock().unwrap();
            assert_eq!(
                kept.len(),
                1,
                "one original sequence, no replacement/replay"
            );
            kept.pop().unwrap()
        }
    }
    struct Wire {
        requests: mpsc::UnboundedReceiver<Value>,
        replies: mpsc::UnboundedSender<Value>,
        task: JoinHandle<()>,
        provider: Provider,
        generation: String,
    }
    impl Drop for Wire {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Wire {
        async fn request(&mut self) -> Value {
            tokio::time::timeout(Duration::from_secs(2), self.requests.recv())
                .await
                .unwrap()
                .unwrap()
        }
        fn ack(&self, request: &Value) {
            self.replies
                .send(json!({"id":request["id"],"result":{}}))
                .unwrap();
        }
        fn fail(&self, request: &Value) {
            self.replies.send(json!({"id":request["id"],"error":{"code":-32000,"message":"fixture release failed"}})).unwrap();
        }
    }
    async fn wire() -> (Cdp, Wire) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests, received) = mpsc::unbounded_channel();
        let (replies, mut outgoing) = mpsc::unbounded_channel::<Value>();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            loop {
                tokio::select! {
                    message=socket.next()=>match message {
                        Some(Ok(Message::Text(text)))=>requests.send(serde_json::from_str(&text).unwrap()).unwrap(),
                        Some(Ok(Message::Ping(_)))=>{},
                        _=>break,
                    },
                    reply=outgoing.recv()=>match reply {
                        Some(reply)=>socket.send(Message::Text(reply.to_string().into())).await.unwrap(),
                        None=>break,
                    },
                }
            }
        });
        let connection = BrowserConnection {
            id: "owned-input-fixture".into(),
            endpoint: format!("http://{address}"),
        };
        let generation = format!("ws://{address}");
        let socket = Cdp::connect(&generation, &connection).await.unwrap();
        (
            socket,
            Wire {
                requests: received,
                replies,
                task,
                provider: Provider::Cdp(connection),
                generation,
            },
        )
    }

    async fn sequence(socket: Cdp, cancellation: CancellationToken) -> Sequence {
        let admission = socket.preparation.before_owned_input().await.unwrap();
        Sequence {
            socket,
            resource: Arc::new(Resource::new(
                admission,
                "turn",
                crate::desktop::NativeEpochId::new(),
            )),
            cancellation,
        }
    }
    fn down() -> Value {
        json!({"type":"mousePressed","x":-2.75,"y":4096.125,"button":"right","buttons":2,"clickCount":2,"modifiers":10})
    }
    #[tokio::test]
    async fn caller_drop_leaves_same_original_press_and_owned_release_with_passive_local_custody() {
        let (socket, mut wire) = wire().await;
        let stop = CancellationToken::new();
        let input = sequence(socket.clone(), stop.clone()).await;
        let resource = input.resource.clone();
        let body_input = input.clone();
        let body: BoxFuture<'static, Result<(), ToolError>> = Box::pin(async move {
            body_input
                .mouse_down(Some("actual-child-session"), down())
                .await?;
            Ok(())
        });
        let kept = Arc::new(Kept::default());
        let observer = tokio::spawn(retained_sequence(
            kept.clone(),
            resource.clone(),
            stop.clone(),
            None,
            Box::pin(complete_sequence(input, body)),
        ));
        let press = wire.request().await;
        assert_eq!(press["method"], "Input.dispatchMouseEvent");
        assert_eq!(press["params"], down());
        assert_eq!(press["sessionId"], "actual-child-session");
        let owner = uuid::Uuid::new_v4();
        let identity = BrowserIdentity::of(&wire.provider, &wire.generation)
            .unwrap()
            .tab("actual-tab");
        let mut host = Host::default();
        host.reserve_owned_input(
            identity.clone(),
            owner,
            "turn",
            wire.provider.clone(),
            wire.generation.clone(),
            resource.clone(),
        )
        .unwrap();
        assert!(
            host.finish(owner, Some("turn")).await.is_err(),
            "pending original input still blocks owner cleanup"
        );

        observer.abort();
        assert!(observer.await.unwrap_err().is_cancelled());
        assert!(stop.is_cancelled());
        assert!(resource.check_settled().is_err());
        assert!(
            !socket.connection.is_closed(),
            "observer Drop must not fence the Required route"
        );
        // The existing custodian now drives the SAME pending PRESS, not an UP
        // guessed ahead of its ACK and not another mousePressed.
        let retained = tokio::spawn(kept.take());
        tokio::task::yield_now().await;
        assert!(matches!(
            wire.requests.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        wire.ack(&press);
        let release = wire.request().await;
        assert_eq!(release["method"], press["method"]);
        assert_eq!(release["sessionId"], press["sessionId"]);
        assert_eq!(
            release["params"],
            json!({"type":"mouseReleased","x":-2.75,"y":4096.125,"button":"right","buttons":0,"clickCount":2,"modifiers":10})
        );
        assert!(
            resource.check_settled().is_err(),
            "sent UP is not acknowledged UP"
        );
        wire.ack(&release);
        tokio::time::timeout(Duration::from_secs(2), retained)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        resource.check_settled().unwrap();
        assert_eq!(
            host.finish(owner, Some("turn")).await.unwrap(),
            vec![identity]
        );

        assert!(matches!(
            wire.requests.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
    #[tokio::test]
    async fn failed_up_keeps_cleanup_unconfirmed_and_is_not_replayed() {
        let (socket, mut wire) = wire().await;
        let input = sequence(socket, CancellationToken::new()).await;
        let resource = input.resource.clone();
        let press_input = input.clone();
        let pressing = tokio::spawn(async move { press_input.mouse_down(None, down()).await });
        let press = wire.request().await;
        wire.ack(&press);
        let held = pressing.await.unwrap().unwrap();
        let releasing_input = input.clone();
        let releasing = tokio::spawn(async move { releasing_input.release(held).await });
        let release = wire.request().await;
        wire.fail(&release);
        assert!(releasing.await.unwrap().is_err());
        assert!(matches!(
            input.cleanup().await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        assert!(matches!(
            resource.check_settled(),
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        assert!(matches!(
            wire.requests.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
    #[tokio::test]
    async fn leading_move_cancellation_is_unknown_and_keeps_the_same_required_call() {
        let method = "Input.dispatchMouseEvent";
        let params = json!({"type":"mouseMoved","x":-2.75,"y":4096.125,"buttons":0});
        let (socket, mut wire) = wire().await;
        let stop = CancellationToken::new();
        let input = sequence(socket.clone(), stop.clone()).await;
        let resource = input.resource.clone();
        let body_socket = socket.clone();
        let expected = params.clone();
        let kept = Arc::new(Kept::default());
        let observer = tokio::spawn(retained_sequence(
            kept.clone(),
            resource.clone(),
            stop.clone(),
            None,
            Box::pin(complete_sequence(
                input,
                Box::pin(async move {
                    body_socket.request_in(None, method, params).await?;
                    Ok(())
                }),
            )),
        ));
        let request = wire.request().await;
        assert_eq!(request["method"], method);
        assert_eq!(request["params"], expected);
        stop.cancel();
        let observed = observer.await.unwrap();
        assert!(
            matches!(observed, Err(ToolError::OutcomeUnknown(_))),
            "{method}: {observed:?}"
        );
        assert!(
            !socket.connection.is_closed(),
            "observer must not fence the original Required call"
        );
        let retained = tokio::spawn(kept.take());
        wire.ack(&request);
        retained.await.unwrap().unwrap();
        resource.check_settled().unwrap();
        assert!(
            matches!(
                wire.requests.try_recv(),
                Err(mpsc::error::TryRecvError::Empty)
            ),
            "no invented press/release/replay"
        );
    }
    #[tokio::test]
    async fn reverse_key_release_reprojects_existing_layout_after_duplicate_modifier_removal() {
        let (socket, mut wire) = wire().await;
        let input = sequence(socket, CancellationToken::new()).await;
        // One chord with a repeated modifier exercises release-mask projection.
        let keys = [("Control", 2, 2), ("Alt", 1, 3), ("Control", 2, 3)];
        for (key, bit, modifiers) in keys {
            let request_input = input.clone();
            let pressed = tokio::spawn(async move {
                request_input.key_down(json!({"type":"rawKeyDown","key":key,"code":key,"modifiers":modifiers}), bit,
                    move |remaining| json!({"type":"keyUp","key":key,"code":key,"modifiers":remaining})).await
            });
            let press = wire.request().await;
            wire.ack(&press);
            pressed.await.unwrap().unwrap();
        }
        let cleanup = tokio::spawn(async move { input.cleanup().await });
        for (key, remaining) in [("Control", 1), ("Alt", 0), ("Control", 0)] {
            let up = wire.request().await;
            assert_eq!(up["method"], "Input.dispatchKeyEvent");
            assert_eq!(up["params"]["key"], key);
            assert_eq!(up["params"]["type"], "keyUp");
            assert_eq!(up["params"]["modifiers"], remaining);
            assert!(up["params"].get("text").is_none());
            wire.ack(&up);
        }
        cleanup.await.unwrap().unwrap();
    }
}
