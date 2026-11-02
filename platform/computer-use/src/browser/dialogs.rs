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

//! Connection-local dialog state. This module neither discovers targets nor
//! grants access. Its adapter must admit an exact page/child session before
//! supplying events, and authorize the bound page before preparing an action.
//!
//! Confirmation borrows an owned transport future instead of spawning or
//! dropping accepted work. A Pending disposition must remain in the caller's
//! extension custody until the RPC settles, even when a close event already proved
//! the public operation successful.

use crate::protocol::DialogAction;
use maka_agent_facts::tools::ToolError;
use serde::Serialize;
use std::{
    future::{Future, poll_fn},
    pin::Pin,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

const CLOSE_TIMEOUT: Duration = Duration::from_secs(60);

/// One route on the already bound page connection; None means its main target.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct DialogTarget {
    pub session: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum DialogType {
    Alert,
    BeforeUnload,
    Confirm,
    Prompt,
}

impl DialogType {
    pub fn name(self) -> &'static str {
        match self {
            Self::Alert => "alert",
            Self::BeforeUnload => "beforeunload",
            Self::Confirm => "confirm",
            Self::Prompt => "prompt",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct DialogMetadata {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: DialogType,
}

#[derive(Clone, Debug, serde::Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum DialogControl {
    Prompt,
    Accept,
    Dismiss,
}

#[derive(Clone, Debug, serde::Deserialize, Serialize)]
pub(super) struct DialogRef {
    pub id: String,
    pub control: DialogControl,
}

#[derive(Clone, Debug)]
pub(super) struct ActiveDialog {
    pub metadata: DialogMetadata,
    pub target: DialogTarget,
    pub message: String,
    pub prompt_text: String,
    pub url: String,
}

impl ActiveDialog {
    pub fn ax_nodes(&self, title: &str) -> Vec<serde_json::Value> {
        use serde_json::json;
        let key = |name: &str| format!("javascript-dialog:{}:{name}", self.metadata.id);
        let mut nodes = vec![
            json!({"nodeId":key("root"),"role":{"value":"RootWebArea"},"name":{"value":title},"childIds":[key("dialog")]}),
            json!({"nodeId":key("dialog"),"parentId":key("root"),"role":{"value":"alertdialog"},"name":{"value":reqwest::Url::parse(&self.url).ok().and_then(|url|url.host_str().map(|host|format!("{host} says"))).unwrap_or_else(||"This page says".into())},"properties":[{"name":"modal","value":{"value":true}}]}),
            json!({"nodeId":key("message"),"parentId":key("dialog"),"role":{"value":"StaticText"},"name":{"value":self.message}}),
        ];
        let mut children = vec![key("message")];
        if self.metadata.kind == DialogType::Prompt {
            children.push(key("prompt"));
            nodes.push(json!({"nodeId":key("prompt"),"parentId":key("dialog"),"role":{"value":"textbox"},"name":{"value":"Response"},"value":{"value":self.prompt_text},"properties":[{"name":"focused","value":{"value":true}}],"makaDialog":DialogRef{id:self.metadata.id.clone(),control:DialogControl::Prompt}}));
        }
        if self.metadata.kind != DialogType::Alert {
            children.push(key("dismiss"));
            nodes.push(json!({"nodeId":key("dismiss"),"parentId":key("dialog"),"role":{"value":"button"},"name":{"value":if self.metadata.kind==DialogType::BeforeUnload{"Stay"}else{"Cancel"}},"makaDialog":DialogRef{id:self.metadata.id.clone(),control:DialogControl::Dismiss}}));
        }
        children.push(key("accept"));
        nodes.push(json!({"nodeId":key("accept"),"parentId":key("dialog"),"role":{"value":"button"},"name":{"value":if self.metadata.kind==DialogType::BeforeUnload{"Leave"}else{"OK"}},"makaDialog":DialogRef{id:self.metadata.id.clone(),control:DialogControl::Accept}}));
        nodes[1]["childIds"] = json!(children);
        nodes
    }
}

/// Only trusted, ordered events from the adapter's admitted source routes.
pub(super) enum DialogEvent {
    Opening {
        target: DialogTarget,
        kind: DialogType,
        message: String,
        default_prompt: String,
        url: String,
    },
    Closed {
        target: DialogTarget,
    },
    Detached {
        target: DialogTarget,
    },
    Disconnected,
}

/// Fixed Page.handleJavaScriptDialog parameters; there is no arbitrary method.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DialogRequest {
    pub target: DialogTarget,
    pub accept: bool,
    pub prompt_text: Option<String>,
}

struct State {
    namespace: String,
    sequence: u64,
    revision: u64,
    active: Option<ActiveDialog>,
    witnesses: Vec<Weak<CloseWitness>>,
    disconnected: bool,
}

#[derive(Clone)]
pub(super) struct Dialogs {
    state: Arc<Mutex<State>>,
    changes: watch::Sender<u64>,
}

impl Default for Dialogs {
    fn default() -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            state: Arc::new(Mutex::new(State {
                // Rebinding a connection cannot make an old public dialog
                // object valid again, even if its local counter starts over.
                namespace: uuid::Uuid::new_v4().to_string(),
                sequence: 0,
                revision: 0,
                active: None,
                witnesses: Vec::new(),
                disconnected: false,
            })),
            changes,
        }
    }
}

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

impl Dialogs {
    pub async fn opened(&self) -> ActiveDialog {
        let mut changes = self.changes.subscribe();
        loop {
            if let Some(dialog) = self.current() {
                return dialog;
            }
            if changes.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
    fn publish(&self, state: &mut State) -> Result<(), ToolError> {
        state.revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| failed("dialog event identity exhausted"))?;
        self.changes.send_replace(state.revision);
        Ok(())
    }

    /// Before-unload opening yields the original automatic accept request.
    /// The adapter owns its dispatch and settlement; this state machine does
    /// not manufacture an invocation or retry an uncertain command.
    pub fn observe(&self, event: DialogEvent) -> Result<Option<DialogRequest>, ToolError> {
        let mut state = self.state.lock().unwrap();
        let automatic = match event {
            DialogEvent::Opening {
                target,
                kind,
                message,
                default_prompt,
                url,
            } => {
                if state.disconnected {
                    return Err(failed("dialog connection is closed"));
                }
                state.sequence = state
                    .sequence
                    .checked_add(1)
                    .ok_or_else(|| failed("dialog identity exhausted"))?;
                state.active = Some(ActiveDialog {
                    metadata: DialogMetadata {
                        id: format!("{}:{}", state.namespace, state.sequence),
                        kind,
                    },
                    target: target.clone(),
                    message,
                    prompt_text: default_prompt,
                    url,
                });
                (kind == DialogType::BeforeUnload).then_some(DialogRequest {
                    target,
                    accept: true,
                    prompt_text: None,
                })
            }
            DialogEvent::Closed { target } => {
                Self::witnesses(&mut state, |witness| {
                    if witness.target == target {
                        witness.closed.store(true, Ordering::SeqCst);
                    }
                });
                if state.active.as_ref().is_some_and(|d| d.target == target) {
                    state.active = None;
                }
                None
            }
            DialogEvent::Detached { target } => {
                Self::witnesses(&mut state, |witness| {
                    if witness.target == target {
                        witness.lost.store(true, Ordering::SeqCst);
                    }
                });
                if state.active.as_ref().is_some_and(|d| d.target == target) {
                    state.active = None;
                }
                None
            }
            DialogEvent::Disconnected => {
                state.disconnected = true;
                state.active = None;
                Self::witnesses(&mut state, |witness| {
                    witness.lost.store(true, Ordering::SeqCst);
                });
                None
            }
        };
        self.publish(&mut state)?;
        Ok(automatic)
    }

    fn witnesses(state: &mut State, mut visit: impl FnMut(&CloseWitness)) {
        state.witnesses.retain(|weak| {
            if let Some(witness) = weak.upgrade() {
                visit(&witness);
                true
            } else {
                false
            }
        });
    }

    pub fn current(&self) -> Option<ActiveDialog> {
        self.state.lock().unwrap().active.clone()
    }

    pub fn check_method(&self, method: &str) -> Result<(), ToolError> {
        if method == "Page.handleJavaScriptDialog" {
            return Ok(());
        }
        if let Some(dialog) = self.current() {
            return Err(failed(format!(
                "A {} JavaScript dialog is active; use tab.getJsDialog() to handle it first",
                dialog.metadata.kind.name()
            )));
        }
        Ok(())
    }

    pub fn replace_prompt(&self, id: &str, value: String) -> Result<(), ToolError> {
        let mut state = self.state.lock().unwrap();
        let dialog = state
            .active
            .as_mut()
            .filter(|d| d.metadata.id == id)
            .ok_or_else(|| failed("JavaScript dialog is no longer active"))?;
        if dialog.metadata.kind != DialogType::Prompt {
            return Err(failed("Only prompt dialogs accept text"));
        }
        dialog.prompt_text = value;
        self.publish(&mut state)
    }

    pub fn prepare_handle(
        &self,
        id: &str,
        action: DialogAction,
        prompt_text: Option<String>,
    ) -> Result<PreparedHandle, ToolError> {
        let mut state = self.state.lock().unwrap();
        let dialog = state
            .active
            .as_ref()
            .filter(|d| d.metadata.id == id)
            .ok_or_else(|| failed("JavaScript dialog is no longer active"))?;
        let (accept, prompt_text) = match action {
            DialogAction::Dismiss => (dialog.metadata.kind == DialogType::Alert, None),
            DialogAction::Accept => match dialog.metadata.kind {
                DialogType::Alert | DialogType::BeforeUnload => {
                    return Err(failed("This dialog type does not support accept()"));
                }
                DialogType::Confirm => {
                    if prompt_text.is_some() {
                        return Err(failed("Confirm dialogs do not accept prompt text"));
                    }
                    (true, None)
                }
                DialogType::Prompt => (
                    true,
                    Some(prompt_text.ok_or_else(|| failed("Prompt dialogs require prompt text"))?),
                ),
            },
        };
        let target = dialog.target.clone();
        Self::witnesses(&mut state, |_| {});
        let witness = Arc::new(CloseWitness {
            target: target.clone(),
            closed: AtomicBool::new(false),
            lost: AtomicBool::new(false),
        });
        state.witnesses.push(Arc::downgrade(&witness));
        Ok(PreparedHandle {
            dialogs: self.clone(),
            id: id.to_owned(),
            witness,
            request: DialogRequest {
                target,
                accept,
                prompt_text,
            },
            // Registered under the same lock used by observe, before any RPC
            // polling, so even an immediate close event remains observable.
            changes: self.changes.subscribe(),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DispatchDisposition {
    NotStarted,
    Pending,
    Settled,
}

#[derive(Debug)]
pub(super) struct HandleOutcome {
    pub result: Result<(), ToolError>,
    pub dispatch: DispatchDisposition,
}

pub(super) struct PreparedHandle {
    dialogs: Dialogs,
    id: String,
    witness: Arc<CloseWitness>,
    pub request: DialogRequest,
    changes: watch::Receiver<u64>,
}

enum Confirmation {
    Waiting,
    Closed,
    TargetLost,
}

struct CloseWitness {
    target: DialogTarget,
    closed: AtomicBool,
    lost: AtomicBool,
}

impl PreparedHandle {
    fn confirmation(&self) -> Confirmation {
        if self.witness.closed.load(Ordering::SeqCst) {
            Confirmation::Closed
        } else if self.witness.lost.load(Ordering::SeqCst) {
            Confirmation::TargetLost
        } else {
            Confirmation::Waiting
        }
    }

    /// `dispatch` must be an unpolled owned future for exactly `request`.
    /// Pending means its owner must keep polling it after this returns. Dropping
    /// an accepted Cua CDP future can close the socket and lose later events.
    pub async fn confirm<F>(
        mut self,
        mut dispatch: Pin<&mut F>,
        cancellation: &CancellationToken,
    ) -> HandleOutcome
    where
        F: Future<Output = Result<(), ToolError>> + Send + ?Sized,
    {
        if cancellation.is_cancelled() {
            return HandleOutcome {
                result: Err(failed("Dialog action cancelled before dispatch")),
                dispatch: DispatchDisposition::NotStarted,
            };
        }
        if !self
            .dialogs
            .current()
            .is_some_and(|d| d.metadata.id == self.id && d.target == self.request.target)
        {
            return HandleOutcome {
                result: Err(failed("JavaScript dialog is no longer active")),
                dispatch: DispatchDisposition::NotStarted,
            };
        }
        let started = AtomicBool::new(false);
        let mut settled = false;
        let rpc = poll_fn(|context| {
            started.store(true, Ordering::Relaxed);
            dispatch.as_mut().poll(context)
        });
        tokio::pin!(rpc);
        let deadline = tokio::time::Instant::now() + CLOSE_TIMEOUT;
        let result = loop {
            match self.confirmation() {
                Confirmation::Closed => break Ok(()),
                Confirmation::TargetLost => {
                    break Err(ToolError::OutcomeUnknown(
                        "Dialog target disconnected before its close was confirmed; do not replay"
                            .into(),
                    ));
                }
                Confirmation::Waiting => {}
            }
            tokio::select! {
                biased;
                changed=self.changes.changed()=>{
                    if changed.is_err() {
                        break Err(ToolError::OutcomeUnknown("Dialog event observation ended before close confirmation; do not replay".into()));
                    }
                }
                reply=&mut rpc, if !settled=>{
                    settled=true;
                    if let Err(error)=reply {
                        // A transport poll can synchronously deliver the
                        // close before producing its rejection. Preserve that
                        // earlier terminal fact even within one select poll.
                        break match self.confirmation() {
                            Confirmation::Closed=>Ok(()),
                            _=>Err(error),
                        };
                    }
                }
                _=cancellation.cancelled()=>{
                    break Err(ToolError::OutcomeUnknown("Dialog action cancelled before close confirmation; do not replay".into()));
                }
                _=tokio::time::sleep_until(deadline)=>{
                    break Err(ToolError::OutcomeUnknown("Timed out waiting for JavaScript dialog to close; do not replay".into()));
                }
            }
        };
        HandleOutcome {
            result,
            dispatch: if settled {
                DispatchDisposition::Settled
            } else if started.load(Ordering::Relaxed) {
                DispatchDisposition::Pending
            } else {
                DispatchDisposition::NotStarted
            },
        }
    }
}

#[derive(Clone)]
pub(super) struct Link {
    pub state: Dialogs,
    barriers: tokio::sync::mpsc::UnboundedSender<tokio::sync::oneshot::Sender<()>>,
}

impl Link {
    pub async fn synchronize(&self) {
        let (send, received) = tokio::sync::oneshot::channel();
        if self.barriers.send(send).is_ok() {
            let _ = received.await;
        }
    }
}

pub(super) struct Controller {
    pub link: Link,
    host: Arc<Mutex<Option<Arc<dyn crate::BrowserHostEffects>>>>,
    worker: tokio::task::JoinHandle<()>,
    lifecycle: ControllerLifecycle,
}

enum ControllerLifecycle {
    Open,
    Closing { failure: Option<ToolError> },
    Closed(Result<(), ToolError>),
}

fn route_event(
    event: cua_driver_core::browser::cdp_ws::CdpEvent,
    children: &mut std::collections::HashMap<String, Option<String>>,
    socket: &super::Cdp,
    observed: &Dialogs,
    capability: &Arc<Mutex<Option<Arc<dyn crate::BrowserHostEffects>>>>,
) {
    use serde_json::json;
    use std::collections::HashSet;
    if event
        .session_id
        .as_ref()
        .is_some_and(|session| !children.contains_key(session))
    {
        return;
    }
    if event.method == "Target.attachedToTarget" && event.params["targetInfo"]["type"] == "iframe" {
        if let Some(session) = event.params["sessionId"].as_str() {
            children.insert(session.into(), event.session_id);
            if let Some(host) = capability.lock().unwrap().as_ref() {
                for (method, params) in [
                    (
                        "Target.setAutoAttach",
                        json!({"autoAttach":true,"waitForDebuggerOnStart":false,"flatten":true}),
                    ),
                    ("Page.enable", json!({})),
                ] {
                    let session = session.to_owned();
                    let _ = socket.spawn_host_effect(
                        host,
                        move |socket| {
                            Box::pin(async move {
                                socket
                                    .request_in(Some(&session), method, params)
                                    .await
                                    .map(|_| ())
                            })
                        },
                        Box::new(|_| {}),
                    );
                }
            }
        }
        return;
    }
    if event.method == "Target.detachedFromTarget" {
        if let Some(session) = event.params["sessionId"].as_str() {
            let mut removed = HashSet::from([session.to_owned()]);
            loop {
                let before = removed.len();
                for (session, parent) in children.iter() {
                    if parent
                        .as_ref()
                        .is_some_and(|parent| removed.contains(parent))
                    {
                        removed.insert(session.clone());
                    }
                }
                if before == removed.len() {
                    break;
                }
            }
            for session in removed {
                children.remove(&session);
                let _ = observed.observe(DialogEvent::Detached {
                    target: DialogTarget {
                        session: Some(session),
                    },
                });
            }
        }
        return;
    }
    let target = DialogTarget {
        session: event.session_id,
    };
    let effect = match event.method.as_str() {
        "Page.javascriptDialogOpening" => {
            let kind = match event.params["type"].as_str() {
                Some("alert") => DialogType::Alert,
                Some("beforeunload") => DialogType::BeforeUnload,
                Some("confirm") => DialogType::Confirm,
                Some("prompt") => DialogType::Prompt,
                _ => return,
            };
            observed.observe(DialogEvent::Opening {
                target,
                kind,
                message: event.params["message"].as_str().unwrap_or_default().into(),
                default_prompt: event.params["defaultPrompt"]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                url: event.params["url"].as_str().unwrap_or_default().into(),
            })
        }
        "Page.javascriptDialogClosed" => observed.observe(DialogEvent::Closed { target }),
        _ => return,
    };
    if let Ok(Some(request)) = effect
        && let Some(host) = capability.lock().unwrap().as_ref()
    {
        let _ = socket.spawn_host_effect(
            host,
            move |socket| {
                Box::pin(async move {
                    socket
                        .request_in(
                            request.target.session.as_deref(),
                            "Page.handleJavaScriptDialog",
                            json!({"accept":request.accept}),
                        )
                        .await
                        .map(|_| ())
                })
            },
            Box::new(|_| {}),
        );
    }
}

async fn observe_events(
    mut events: tokio::sync::mpsc::UnboundedReceiver<cua_driver_core::browser::cdp_ws::CdpEvent>,
    mut waiting: tokio::sync::mpsc::UnboundedReceiver<tokio::sync::oneshot::Sender<()>>,
    mut route: impl FnMut(cua_driver_core::browser::cdp_ws::CdpEvent) + Send,
) {
    loop {
        tokio::select! {
            biased;
            barrier=waiting.recv()=>{
                let Some(reply)=barrier else {break;};
                // Include all already-queued events, not a future stream whose
                // producer may never stop. Queue length is a snapshot, no cap.
                let queued=events.len();
                for _ in 0..queued {
                    if let Ok(event)=events.try_recv() {route(event);}
                }
                let _=reply.send(());
            }
            event=events.recv()=>match event {
                Some(event)=>route(event),
                None=>break,
            },
        }
    }
}

impl Controller {
    pub fn start(socket: super::Cdp) -> Self {
        use std::collections::HashMap;
        let events = socket.connection.subscribe();
        let state = Dialogs::default();
        let observed = state.clone();
        let host: Arc<Mutex<Option<Arc<dyn crate::BrowserHostEffects>>>> = Arc::default();
        let capability = host.clone();
        let (barriers, waiting) = tokio::sync::mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            let mut children = HashMap::new();
            observe_events(events, waiting, |event| {
                route_event(event, &mut children, &socket, &observed, &capability);
            })
            .await;
            let _ = observed.observe(DialogEvent::Disconnected);
        });
        Self {
            link: Link { state, barriers },
            host,
            worker,
            lifecycle: ControllerLifecycle::Open,
        }
    }

    pub fn host_effects(&self, host: Option<Arc<dyn crate::BrowserHostEffects>>) {
        *self.host.lock().unwrap() = if matches!(self.lifecycle, ControllerLifecycle::Open) {
            host
        } else {
            None
        };
    }

    fn begin_close(&mut self) {
        if !matches!(self.lifecycle, ControllerLifecycle::Open) {
            return;
        }
        self.lifecycle = ControllerLifecycle::Closing { failure: None };
        // This lock also covers synchronous Host admission in route_event.
        self.host_effects(None);
        let failure = self
            .link
            .state
            .observe(DialogEvent::Disconnected)
            .err()
            .map(|error| {
                ToolError::CleanupUnconfirmed(format!(
                    "dialog disconnect observation failed: {error}"
                ))
            });
        self.worker.abort();
        self.lifecycle = ControllerLifecycle::Closing { failure };
    }

    /// Revoke event effects and confirm the original worker has stopped.
    /// Cancellation retains its join handle and any failure for the next call.
    pub async fn close(&mut self) -> Result<(), ToolError> {
        self.begin_close();
        if let ControllerLifecycle::Closed(result) = &self.lifecycle {
            return result.clone();
        }
        // Borrow the original handle: dropping this close future must never
        // detach it or replace its still-pending completion with success.
        let joined = match (&mut self.worker).await {
            Ok(()) => Ok(()),
            Err(error) if error.is_cancelled() => Ok(()),
            Err(error) => Err(ToolError::CleanupUnconfirmed(format!(
                "dialog event worker did not stop cleanly: {error}"
            ))),
        };
        let result = match (&self.lifecycle, joined) {
            (ControllerLifecycle::Closing { failure: None }, joined) => joined,
            (
                ControllerLifecycle::Closing {
                    failure: Some(error),
                },
                Ok(()),
            ) => Err(error.clone()),
            (
                ControllerLifecycle::Closing {
                    failure: Some(error),
                },
                Err(joined),
            ) => Err(ToolError::CleanupUnconfirmed(format!("{error}; {joined}"))),
            _ => unreachable!("dialog worker join requires an active close"),
        };
        self.lifecycle = ControllerLifecycle::Closed(result.clone());
        result
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        self.begin_close();
    }
}

impl super::Tab {
    pub(super) async fn active_dialog(&self) -> Option<ActiveDialog> {
        let controller = self.dialogs.as_ref()?;
        controller.link.synchronize().await;
        controller.link.state.current()
    }

    pub(super) fn observe_dialog(
        &mut self,
        dialog: ActiveDialog,
        kind: crate::protocol::ObservationKind,
        diff: bool,
        language: maka_agent_facts::language::Language,
    ) -> Result<serde_json::Value, ToolError> {
        use crate::protocol::ObservationKind;
        use serde_json::json;
        let message = format!(
            "Screenshot unavailable while a JavaScript {} dialog is open. Use getAXState() and its dialog controls.",
            dialog.metadata.kind.name()
        );
        if matches!(kind, ObservationKind::Screenshot) {
            return Ok(json!({"screenshotUnavailable":message}));
        }
        self.refs.clear();
        self.frame = None;
        let document = format!("javascript-dialog:{}", dialog.metadata.id);
        let (full, refs) = self
            .ax
            .render_dialog(&document, &dialog, &self.info.title, language)?;
        self.refs = refs;
        let full = if matches!(kind, ObservationKind::Both) {
            format!("{full}\n\n{message}")
        } else {
            full
        };
        let body = if diff {
            crate::session::display_diff(self.previous.as_deref(), &full, language)
        } else {
            full.clone()
        };
        self.previous = Some(full);
        Ok(json!({"state":format!("Tab {}: {}\n{body}",self.info.id,self.info.url)}))
    }

    pub(super) async fn dialog_action(
        &mut self,
        dialog: ActiveDialog,
        action: crate::protocol::Action,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<serde_json::Value, ToolError> {
        use crate::protocol::{Action, MouseButton, Position};
        let index = match &action {
            Action::Click {
                target: Position::Element(index),
                ..
            } => Some(*index),
            Action::SetValue { index, .. }
            | Action::TypeText {
                index: Some(index), ..
            }
            | Action::Paste {
                index: Some(index), ..
            }
            | Action::PressKey {
                index: Some(index), ..
            } => Some(*index),
            Action::Click {
                target: Position::Point(_),
                ..
            } => {
                return Err(failed(
                    "JavaScript dialog controls have no viewport coordinates; use an accessibility element index",
                ));
            }
            _ => None,
        };
        let control = if let Some(index) = index {
            match self.refs.get(&index) {
                Some(super::ElementRef::Dialog(reference))
                    if reference.id == dialog.metadata.id =>
                {
                    Some(reference.control.clone())
                }
                Some(super::ElementRef::Dialog(_)) => {
                    return Err(failed("JavaScript dialog is no longer active"));
                }
                _ => {
                    return Err(failed(
                        "A JavaScript dialog is blocking the requested page element",
                    ));
                }
            }
        } else {
            None
        };
        let state = self
            .dialogs
            .as_ref()
            .ok_or_else(|| failed("JavaScript dialog is no longer active"))?
            .link
            .state
            .clone();
        let selected = match action {
            Action::SetValue { value, .. } if matches!(control, Some(DialogControl::Prompt)) => {
                state.replace_prompt(&dialog.metadata.id, value)?;
                return Ok(serde_json::Value::Null);
            }
            Action::TypeText { text, .. }
                if dialog.metadata.kind == DialogType::Prompt
                    && matches!(control, None | Some(DialogControl::Prompt)) =>
            {
                state.replace_prompt(&dialog.metadata.id, dialog.prompt_text + &text)?;
                return Ok(serde_json::Value::Null);
            }
            Action::Click { options, .. } => {
                if options
                    .mouse_button
                    .is_some_and(|button| !matches!(button, MouseButton::Left))
                {
                    return Err(failed(
                        "JavaScript dialog controls only support left clicks",
                    ));
                }
                control
            }
            Action::PressKey { key, .. } => match key.to_lowercase().as_str() {
                "return" | "enter" => Some(if matches!(control, Some(DialogControl::Dismiss)) {
                    DialogControl::Dismiss
                } else {
                    DialogControl::Accept
                }),
                "escape" | "esc" => Some(DialogControl::Dismiss),
                _ => None,
            },
            _ => None,
        };
        let action = match selected {
            Some(DialogControl::Dismiss) => DialogAction::Dismiss,
            Some(DialogControl::Accept) if dialog.metadata.kind == DialogType::Alert => {
                DialogAction::Dismiss
            }
            Some(DialogControl::Accept) => DialogAction::Accept,
            _ => {
                return Err(failed(
                    "A JavaScript dialog is active; interact with its controls first",
                ));
            }
        };
        let text = if matches!(action, DialogAction::Accept)
            && dialog.metadata.kind == DialogType::Prompt
        {
            Some(
                state
                    .current()
                    .filter(|current| current.metadata.id == dialog.metadata.id)
                    .ok_or_else(|| failed("JavaScript dialog is no longer active"))?
                    .prompt_text,
            )
        } else {
            None
        };
        self.handle_dialog(&dialog.metadata.id, action, text, invocation, cancellation)
            .await
    }

    pub(super) async fn handle_dialog(
        &mut self,
        id: &str,
        action: DialogAction,
        prompt_text: Option<String>,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<serde_json::Value, ToolError> {
        let controller = self
            .dialogs
            .as_ref()
            .ok_or_else(|| failed("JavaScript dialog is no longer active"))?;
        controller.link.synchronize().await;
        let prepared = controller
            .link
            .state
            .prepare_handle(id, action, prompt_text)?;
        let request = prepared.request.clone();
        let events = controller.link.clone();
        let socket = self
            .socket
            .as_ref()
            .ok_or_else(|| failed("dialog connection is unavailable"))?
            .clone();
        let mut rpc: maka_agent_facts::tools::ToolFuture<()> = Box::pin(async move {
            let mut params = serde_json::json!({"accept":request.accept});
            if let Some(text) = request.prompt_text {
                params["promptText"] = serde_json::json!(text);
            }
            let result = socket
                .raw_call(
                    request.target.session.as_deref(),
                    "Page.handleJavaScriptDialog",
                    params,
                )
                .await;
            events.synchronize().await;
            result.map(|_| ()).map_err(super::Cdp::failure)
        });
        let outcome = prepared.confirm(rpc.as_mut(), cancellation).await;
        if outcome.dispatch == DispatchDisposition::Pending {
            // The physical close witness does not prove the pending transport
            // reply arrived. Keep that same request under checked custody.
            let pending: crate::CheckedSettlementFuture = Box::pin(async move {
                match rpc.await {
                    Ok(()) | Err(ToolError::Failed(_)) => Ok(()),
                    Err(error) => Err(error),
                }
            });
            match self
                .attachment_settlement
                .clone()
                .or_else(|| invocation.operation_settlement())
            {
                Some(host) => {
                    if let Err((error, pending)) = host.retain_checked(pending) {
                        pending.await?;
                        return Err(error);
                    }
                }
                None => pending.await?,
            }
        }
        outcome.result?;
        self.refs.clear();
        self.frame = None;
        Ok(serde_json::Value::Null)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod iframe_effect_tests {
    use super::*;
    use crate::{BrowserEffectScope, BrowserHostEffects, HostEffectFactory, HostEffectFuture};
    use cua_driver_core::browser::cdp_ws::{CdpConnection, CdpEvent};
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    #[derive(Default)]
    struct Host {
        ordinary: Mutex<Vec<HostEffectFuture>>,
        scoped: Mutex<Vec<HostEffectFactory>>,
    }
    impl BrowserHostEffects for Host {
        fn spawn(&self, pending: HostEffectFuture) -> Result<(), ToolError> {
            self.ordinary.lock().unwrap().push(pending);
            Ok(())
        }
        fn spawn_scoped_guarded(
            &self,
            factory: HostEffectFactory,
            _: Box<dyn FnOnce(ToolError) + Send>,
        ) -> Result<(), ToolError> {
            self.scoped.lock().unwrap().push(factory);
            Ok(())
        }
    }
    struct Server(tokio::task::JoinHandle<()>);
    impl Drop for Server {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    struct OpaqueScope;
    impl BrowserEffectScope for OpaqueScope {
        fn check_session_preparation(
            &self,
            _: crate::BrowserPreparationBinding,
            _: CancellationToken,
        ) -> crate::AuthorizationFuture {
            panic!("an unadmitted transport cannot promote a fixture Host scope");
        }
    }

    #[tokio::test]
    async fn iframe_setup_selects_scoped_admission_without_promoting_unadmitted_transport() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, mut requests) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let mut server = Server(tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut wire = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(message)) = wire.next().await {
                if message.is_close() {
                    break;
                }
                let request: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                sent.send(request.clone()).unwrap();
                if wire
                    .send(Message::Text(
                        json!({"id":request["id"],"result":{}}).to_string().into(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }));
        let connection = CdpConnection::connect_bounded(&format!("ws://{address}"), usize::MAX)
            .await
            .unwrap();
        let socket = crate::browser::Cdp {
            connection: Arc::new(connection),
            dialogs: None,
            extension_context: None,
            preparation: crate::browser::extension::PreparationTransport::NotRequired,
        };
        let mut old = socket.clone();
        old.preparation = crate::browser::extension::PreparationTransport::Unadmitted;
        let host = Arc::new(Host::default());
        let captured: Arc<Mutex<Option<Arc<dyn BrowserHostEffects>>>> =
            Arc::new(Mutex::new(Some(host.clone())));
        let observed = Dialogs::default();
        let mut children = std::collections::HashMap::new();
        let event = |session: &str| CdpEvent {
            method: "Target.attachedToTarget".into(),
            params: json!({"sessionId":session,"targetInfo":{"type":"iframe"}}),
            session_id: None,
            source_target_id: None,
            params_json: None,
        };
        route_event(
            event("unadmitted-child"),
            &mut children,
            &old,
            &observed,
            &captured,
        );
        assert!(host.ordinary.lock().unwrap().is_empty());
        let factories = std::mem::take(&mut *host.scoped.lock().unwrap());
        assert_eq!(factories.len(), 2);
        for factory in factories {
            assert!(matches!(
                factory(Arc::new(OpaqueScope)).await,
                Err(ToolError::Failed(_))
            ));
        }
        assert!(
            requests.try_recv().is_err(),
            "new opaque admission cannot bypass an unadmitted extension transport"
        );

        // This positive half is explicitly a generic CDP wire fixture. It proves
        // fixed request routing, not actual extension preparation or Host DB grants.
        route_event(
            event("current-child"),
            &mut children,
            &socket,
            &observed,
            &captured,
        );
        assert!(host.scoped.lock().unwrap().is_empty());
        let futures = std::mem::take(&mut *host.ordinary.lock().unwrap());
        assert_eq!(futures.len(), 2);
        for (pending, method) in futures
            .into_iter()
            .zip(["Target.setAutoAttach", "Page.enable"])
        {
            tokio::time::timeout(Duration::from_secs(2), pending)
                .await
                .unwrap()
                .unwrap();
            let request = requests.recv().await.unwrap();
            assert_eq!(request["method"], method);
            assert_eq!(request["sessionId"], "current-child");
        }
        assert!(requests.try_recv().is_err());
        server.0.abort();
        let _ = (&mut server.0).await;
    }
}
