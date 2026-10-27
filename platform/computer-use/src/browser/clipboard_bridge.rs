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

//! Owned main-world Clipboard bindings. Page requests select no transport,
//! frame, origin or invocation; all of those come from this attachment's CDP.

use super::*;
use crate::browser_clipboard::{Items, Store};
use crate::{BrowserAttachmentAuthorization, BrowserAttachmentOrigin, BrowserHostEffects};
use cua_driver_core::browser::cdp_ws::CdpEvent;
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

const SCRIPT: &str = include_str!("clipboard-page.js");
const CONTROL: &str = "globalThis.__makaVirtualClipboard";

pub(super) struct Backend {
    pub provider: BrowserConnection,
    pub generation: String,
    pub store: Arc<Store>,
}

impl Backend {
    pub fn new(provider: BrowserConnection, generation: String) -> Self {
        Self {
            provider,
            generation,
            store: Arc::default(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct FrameIdentity {
    id: String,
    loader: String,
    parent: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct Context {
    unique: String,
    frame: String,
    origin: BrowserAttachmentOrigin,
}

#[derive(Clone, Default)]
enum DocumentScript {
    #[default]
    Absent,
    Installed(String),
    Unconfirmed,
}

#[derive(Clone, Copy, Default)]
enum InstallationProgress {
    #[default]
    Unstarted,
    Queued,
    Started,
    Settled,
}

struct InstallationState {
    progress: InstallationProgress,
    active: bool,
    script: DocumentScript,
    failure: Option<String>,
}

impl Default for InstallationState {
    fn default() -> Self {
        Self {
            progress: InstallationProgress::Unstarted,
            active: true,
            script: DocumentScript::Absent,
            failure: None,
        }
    }
}

struct Installation {
    name: String,
    parent: Option<String>,
    state: Mutex<InstallationState>,
    changed: Notify,
}

impl Installation {
    fn new(parent: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            name: format!("__makaClipboard_{}", uuid::Uuid::new_v4().simple()),
            parent,
            state: Mutex::default(),
            changed: Notify::new(),
        })
    }

    fn complete(&self, result: &Result<(), ToolError>) {
        let mut state = self.state.lock().unwrap();
        state.progress = match state.progress {
            // Rejection or close-before-poll dispatched no installation effect.
            InstallationProgress::Queued => InstallationProgress::Unstarted,
            InstallationProgress::Started => InstallationProgress::Settled,
            progress => progress,
        };
        state.failure = result.as_ref().err().map(ToString::to_string);
        self.changed.notify_waiters();
    }

    async fn settled(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if matches!(
                self.state.lock().unwrap().progress,
                InstallationProgress::Unstarted | InstallationProgress::Settled
            ) {
                return;
            }
            changed.await;
        }
    }
}

#[derive(Clone)]
struct Capability {
    authorization: Arc<dyn BrowserAttachmentAuthorization>,
    host: Arc<dyn BrowserHostEffects>,
}

struct State {
    open: bool,
    capability: Option<Capability>,
    routes: HashMap<Option<String>, Arc<Installation>>,
    contexts: HashMap<(Option<String>, i64), Context>,
    frames: HashMap<(Option<String>, String), FrameIdentity>,
}

struct Shared {
    state: Mutex<State>,
    stop: CancellationToken,
    store: Arc<Store>,
    socket: Cdp,
}

pub(super) struct Bridge {
    shared: Arc<Shared>,
    cleanup: Arc<Mutex<CleanupState>>,
    turn: String,
}

type Completion = watch::Receiver<Option<Result<(), ToolError>>>;

struct CleanupOwner {
    shared: Arc<Shared>,
    worker: tokio::task::JoinHandle<()>,
    initialization: Completion,
}

enum CleanupState {
    Open(CleanupOwner),
    Closing(Completion),
    Terminal {
        result: Result<(), ToolError>,
        _owner: Option<CleanupOwner>,
    },
}

async fn completed(mut pending: Completion) -> Result<Result<(), ToolError>, ToolError> {
    loop {
        if let Some(result) = pending.borrow().clone() {
            return Ok(result);
        }
        pending.changed().await.map_err(|error| {
            ToolError::CleanupUnconfirmed(format!(
                "Clipboard lifecycle completion was lost: {error}"
            ))
        })?;
    }
}

fn collect_frames(tree: &Value, output: &mut Vec<FrameIdentity>) {
    let frame = &tree["frame"];
    if let (Some(id), Some(loader)) = (frame["id"].as_str(), frame["loaderId"].as_str()) {
        output.push(FrameIdentity {
            id: id.into(),
            loader: loader.into(),
            parent: frame["parentId"].as_str().map(str::to_owned),
        });
    }
    if let Some(children) = tree["childFrames"].as_array() {
        for child in children {
            collect_frames(child, output);
        }
    }
}

fn update_tree(state: &mut State, session: &Option<String>, tree: &Value) {
    let mut frames = Vec::new();
    collect_frames(tree, &mut frames);
    state.frames.retain(|(route, _), _| route != session);
    for frame in frames {
        state
            .frames
            .insert((session.clone(), frame.id.clone()), frame);
    }
}

fn current(
    state: &State,
    session: &Option<String>,
    installation: &Arc<Installation>,
    context_id: i64,
    context: &Context,
    frame: &FrameIdentity,
) -> bool {
    state.open
        && state.capability.is_some()
        && state
            .routes
            .get(session)
            .is_some_and(|actual| Arc::ptr_eq(actual, installation))
        && installation.state.lock().unwrap().active
        && state.contexts.get(&(session.clone(), context_id)) == Some(context)
        && state.frames.get(&(session.clone(), context.frame.clone())) == Some(frame)
}

async fn install(
    shared: &Arc<Shared>,
    session: Option<String>,
    installation: Arc<Installation>,
) -> Result<(), ToolError> {
    installation.state.lock().unwrap().progress = InstallationProgress::Started;
    let result = async {
        for method in ["Runtime.enable", "Page.enable"] {
            shared.socket.connection.call(session.as_deref(), method, json!({})).await.map_err(Cdp::failure)?;
        }
        let tree = shared.socket.connection.call_observation(session.as_deref(), "Page.getFrameTree", json!({})).await.map_err(Cdp::failure)?;
        {
            let mut state = shared.state.lock().unwrap();
            if !state.open { return Ok(()); }
            update_tree(&mut state, &session, &tree["frameTree"]);
        }
        shared.socket.connection.call(session.as_deref(), "Runtime.addBinding", json!({"name":installation.name})).await.map_err(Cdp::failure)?;
        let source = format!("({SCRIPT})({})", json!(installation.name));
        let reply = shared.socket.connection.call(session.as_deref(), "Page.addScriptToEvaluateOnNewDocument", json!({"source":source,"runImmediately":true})).await.map_err(Cdp::failure);
        let reply=match reply {
            Ok(reply)=>reply,
            Err(error)=>{
                if matches!(&error,ToolError::OutcomeUnknown(_)) {
                    installation.state.lock().unwrap().script=DocumentScript::Unconfirmed;
                }
                return Err(error);
            }
        };
        let script=match reply["identifier"].as_str() {
            Some(id)=>DocumentScript::Installed(id.into()),
            None=>{
                installation.state.lock().unwrap().script=DocumentScript::Unconfirmed;
                return Err(ToolError::CleanupUnconfirmed("Clipboard installation returned no document-script identity".into()));
            }
        };
        installation.state.lock().unwrap().script=script;
        let verified = shared.socket.connection.call(session.as_deref(), "Runtime.evaluate", json!({
            "expression":format!("{CONTROL}?.bindingName === {}",json!(installation.name)),"returnByValue":true
        })).await.map_err(Cdp::failure)?;
        if verified["result"]["value"] != true {
            return Err(failed("Clipboard bridge installation failed"));
        }
        Ok(())
    }.await;
    installation.complete(&result);
    result
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "lowercase")]
enum PageOperation {
    Read,
    Write { items: Items },
}

fn request_id(value: &Value) -> Option<i64> {
    let id = value["id"].as_f64()?;
    (id.is_finite() && id.fract() == 0.0 && id.abs() <= 9_007_199_254_740_991.0)
        .then_some(id as i64)
}

struct RequestDocument {
    session: Option<String>,
    installation: Arc<Installation>,
    context_id: i64,
    context: Context,
    frame: FrameIdentity,
}

async fn answer(
    shared: Arc<Shared>,
    document: RequestDocument,
    capability: Capability,
    payload: Value,
) -> Result<(), ToolError> {
    let RequestDocument {
        session,
        installation,
        context_id,
        context,
        frame,
    } = document;
    let Some(id) = request_id(&payload) else {
        return Ok(());
    };
    let request = serde_json::from_value::<PageOperation>(payload);
    let authorization = capability
        .authorization
        .check(context.origin.clone(), shared.stop.clone())
        .await;
    let mut observed = Vec::new();
    if authorization.is_ok() {
        let tree = shared
            .socket
            .connection
            .call_observation(session.as_deref(), "Page.getFrameTree", json!({}))
            .await
            .map_err(Cdp::failure)?;
        collect_frames(&tree["frameTree"], &mut observed);
    }
    let response = if let Err(error) = authorization {
        let state = shared.state.lock().unwrap();
        if !current(
            &state,
            &session,
            &installation,
            context_id,
            &context,
            &frame,
        ) {
            return Ok(());
        }
        // An owned bridge may reject its own pending promise after revocation;
        // this fixed notification carries no clipboard contents or new grant.
        json!({"id":id,"ok":false,"error":error.to_string()})
    } else {
        if !observed.contains(&frame) {
            return Ok(());
        }
        loop {
            if let Err(error) = capability
                .authorization
                .check(context.origin.clone(), shared.stop.clone())
                .await
            {
                break json!({"id":id,"ok":false,"error":error.to_string()});
            }
            let Some(mut items) = shared.store.try_access() else {
                shared.store.wait_available().await;
                continue;
            };
            let state = shared.state.lock().unwrap();
            if !current(
                &state,
                &session,
                &installation,
                context_id,
                &context,
                &frame,
            ) {
                return Ok(());
            }
            // No await separates this fresh canonical check from the memory
            // operation. Waiting for another page call's lock rechecks it.
            break match request {
                Ok(PageOperation::Read) => json!({"id":id,"ok":true,"items":&*items}),
                Ok(PageOperation::Write { items: replacement }) => {
                    *items = replacement.into_vec();
                    json!({"id":id,"ok":true})
                }
                Err(error) => json!({"id":id,"ok":false,"error":error.to_string()}),
            };
        }
    };
    {
        let state = shared.state.lock().unwrap();
        if !current(
            &state,
            &session,
            &installation,
            context_id,
            &context,
            &frame,
        ) {
            return Ok(());
        }
    }
    let response = serde_json::to_string(&response).expect("Clipboard reply JSON");
    let expression = format!(
        "{CONTROL}?.bindingName === {} && {CONTROL}.respond({})",
        json!(installation.name),
        json!(response)
    );
    shared
        .socket
        .connection
        .call(
            session.as_deref(),
            "Runtime.evaluate",
            json!({
                "uniqueContextId":context.unique,"expression":expression,"returnByValue":true
            }),
        )
        .await
        .map_err(Cdp::failure)
        .map(|_| ())
}

fn observe(shared: &Arc<Shared>, event: CdpEvent) {
    let session = event.session_id;
    let mut state = shared.state.lock().unwrap();
    if !state.open
        || state
            .routes
            .get(&session)
            .is_none_or(|route| !route.state.lock().unwrap().active)
    {
        return;
    }
    match event.method.as_str() {
        "Runtime.executionContextCreated" => {
            let value = &event.params["context"];
            if value["auxData"]["isDefault"] != true {
                return;
            }
            let (Some(id), Some(unique), Some(frame)) = (
                value["id"].as_i64(),
                value["uniqueId"].as_str(),
                value["auxData"]["frameId"].as_str(),
            ) else {
                return;
            };
            let origin = match value["origin"].as_str() {
                Some(origin) if !matches!(origin, "" | "null" | "://") => {
                    BrowserAttachmentOrigin::Site(origin.into())
                }
                _ => BrowserAttachmentOrigin::Opaque,
            };
            state.contexts.insert(
                (session, id),
                Context {
                    unique: unique.into(),
                    frame: frame.into(),
                    origin,
                },
            );
        }
        "Runtime.executionContextDestroyed" => {
            if let Some(id) = event.params["executionContextId"].as_i64() {
                state.contexts.remove(&(session, id));
            }
        }
        "Runtime.executionContextsCleared" => {
            state.contexts.retain(|(route, _), _| route != &session)
        }
        "Page.frameNavigated" => {
            let value = &event.params["frame"];
            let (Some(id), Some(loader)) = (value["id"].as_str(), value["loaderId"].as_str())
            else {
                return;
            };
            state
                .contexts
                .retain(|(route, _), context| route != &session || context.frame != id);
            state.frames.insert(
                (session, id.into()),
                FrameIdentity {
                    id: id.into(),
                    loader: loader.into(),
                    parent: value["parentId"].as_str().map(str::to_owned),
                },
            );
        }
        "Page.frameDetached" => {
            if let Some(id) = event.params["frameId"].as_str() {
                let mut removed = std::collections::HashSet::from([id.to_owned()]);
                loop {
                    let before = removed.len();
                    for ((route, _), frame) in &state.frames {
                        if route == &session
                            && frame
                                .parent
                                .as_ref()
                                .is_some_and(|parent| removed.contains(parent))
                        {
                            removed.insert(frame.id.clone());
                        }
                    }
                    if before == removed.len() {
                        break;
                    }
                }
                state
                    .frames
                    .retain(|(route, id), _| route != &session || !removed.contains(id));
                state.contexts.retain(|(route, _), context| {
                    route != &session || !removed.contains(&context.frame)
                });
            }
        }
        "Target.attachedToTarget" if event.params["targetInfo"]["type"] == "iframe" => {
            let Some(child) = event.params["sessionId"].as_str().map(str::to_owned) else {
                return;
            };
            if state.routes.contains_key(&Some(child.clone())) {
                return;
            }
            let Some(capability) = state.capability.clone() else {
                return;
            };
            let installation = Installation::new(session);
            installation.state.lock().unwrap().progress = InstallationProgress::Queued;
            state
                .routes
                .insert(Some(child.clone()), installation.clone());
            let future_shared = shared.clone();
            let future_installation = installation.clone();
            // Teardown takes this same lock before closing the producer.
            let accepted=capability.host.spawn(Box::pin(async move {
                let result=async {
                    if !future_shared.state.lock().unwrap().open {return Ok(());}
                    future_installation.state.lock().unwrap().progress=InstallationProgress::Started;
                    future_shared.socket.connection.call(Some(&child),"Target.setAutoAttach",json!({"autoAttach":true,"waitForDebuggerOnStart":false,"flatten":true})).await.map_err(Cdp::failure)?;
                    install(&future_shared,Some(child),future_installation.clone()).await
                }.await;
                future_installation.complete(&result);
                result
            }));
            if let Err(error) = accepted {
                installation.complete(&Err(error));
            }
        }
        "Target.detachedFromTarget" => {
            if let Some(child) = event.params["sessionId"].as_str() {
                let mut removed = std::collections::HashSet::from([child.to_owned()]);
                loop {
                    let before = removed.len();
                    for (route, installation) in &state.routes {
                        if installation
                            .parent
                            .as_ref()
                            .is_some_and(|parent| removed.contains(parent))
                            && let Some(route) = route
                        {
                            removed.insert(route.clone());
                        }
                    }
                    if before == removed.len() {
                        break;
                    }
                }
                state.contexts.retain(|(route, _), _| {
                    route.as_ref().is_none_or(|route| !removed.contains(route))
                });
                state.frames.retain(|(route, _), _| {
                    route.as_ref().is_none_or(|route| !removed.contains(route))
                });
                for (route, installation) in &state.routes {
                    if route.as_ref().is_some_and(|route| removed.contains(route)) {
                        installation.state.lock().unwrap().active = false;
                    }
                }
                // Retain installation identities for physical cleanup; a
                // detached route can no longer provide a current context.
            }
        }
        "Runtime.bindingCalled" => {
            let Some(installation) = state.routes.get(&session).cloned() else {
                return;
            };
            if event.params["name"].as_str() != Some(installation.name.as_str()) {
                return;
            }
            let Some(context_id) = event.params["executionContextId"].as_i64() else {
                return;
            };
            let Some(context) = state.contexts.get(&(session.clone(), context_id)).cloned() else {
                return;
            };
            let Some(frame) = state
                .frames
                .get(&(session.clone(), context.frame.clone()))
                .cloned()
            else {
                return;
            };
            let Some(capability) = state.capability.clone() else {
                return;
            };
            let Some(payload) = event.params["payload"]
                .as_str()
                .and_then(|value| serde_json::from_str(value).ok())
            else {
                return;
            };
            if request_id(&payload).is_none() {
                return;
            }
            let _ = capability.host.spawn(Box::pin(answer(
                shared.clone(),
                RequestDocument {
                    session,
                    installation,
                    context_id,
                    context,
                    frame,
                },
                capability.clone(),
                payload,
            )));
        }
        _ => {}
    }
}

impl Bridge {
    pub async fn install(
        tab: &mut Tab,
        store: Arc<Store>,
        authorization: Arc<dyn BrowserAttachmentAuthorization>,
        host: Arc<dyn BrowserHostEffects>,
        turn: &str,
    ) -> Result<(), ToolError> {
        let socket = tab
            .socket
            .as_ref()
            .ok_or_else(|| failed("tab connection unavailable"))?
            .clone();
        let mut events = socket.connection.subscribe();
        let frames = tab.frames().await?;
        let mut routes = HashMap::from([(None, Installation::new(None))]);
        for frame in &frames {
            if let Some(session) = &frame.session {
                let parent = frame
                    .parent
                    .as_ref()
                    .and_then(|id| frames.iter().find(|parent| &parent.id == id))
                    .and_then(|parent| parent.session.clone());
                routes
                    .entry(Some(session.clone()))
                    .or_insert_with(|| Installation::new(parent));
            }
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                open: true,
                capability: Some(Capability {
                    authorization,
                    host: host.clone(),
                }),
                routes,
                contexts: HashMap::new(),
                frames: HashMap::new(),
            }),
            stop: CancellationToken::new(),
            store,
            socket,
        });
        let observed = shared.clone();
        let worker = tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                observe(&observed, event);
            }
            let mut state = observed.state.lock().unwrap();
            state.open = false;
            state.capability = None;
        });
        let initial: Vec<_> = shared
            .state
            .lock()
            .unwrap()
            .routes
            .iter()
            .map(|(route, installation)| (route.clone(), installation.clone()))
            .collect();
        let (reply, pending) = watch::channel(None);
        // The Tab owns the bridge before any installation effect is admitted.
        // Cancelling the caller therefore leaves its original owner in place.
        tab.clipboard = Some(Self {
            shared: shared.clone(),
            cleanup: Arc::new(Mutex::new(CleanupState::Open(CleanupOwner {
                shared: shared.clone(),
                worker,
                initialization: pending.clone(),
            }))),
            turn: turn.into(),
        });
        let installing = shared.clone();
        let installed = reply.clone();
        let accepted = host.spawn(Box::pin(async move {
            let result = async {
                for (route, installation) in initial {
                    if !installing.state.lock().unwrap().open {
                        break;
                    }
                    install(&installing, route, installation).await?;
                }
                Ok(())
            }
            .await;
            installed.send_replace(Some(result.clone()));
            result
        }));
        if let Err(error) = accepted {
            reply.send_replace(Some(Err(error)));
        }
        if let Err(error) = completed(pending).await.and_then(std::convert::identity) {
            let cleanup = tab
                .clipboard
                .as_mut()
                .expect("Clipboard owner is installed before Host admission")
                .cleanup()
                .await;
            return match cleanup {
                Ok(()) => Err(error),
                Err(cleanup) => Err(cleanup),
            };
        }
        Ok(())
    }

    pub fn turn(&self) -> &str {
        &self.turn
    }

    pub fn is_open(&self) -> bool {
        let state = self.shared.state.lock().unwrap();
        state.open
            && state.routes.values().all(|installation| {
                let installation = installation.state.lock().unwrap();
                !installation.active || installation.failure.is_none()
            })
    }

    pub fn update(
        &self,
        authorization: Option<Arc<dyn BrowserAttachmentAuthorization>>,
        host: Option<Arc<dyn BrowserHostEffects>>,
    ) {
        let mut state = self.shared.state.lock().unwrap();
        if state.open {
            state.capability = authorization
                .zip(host)
                .map(|(authorization, host)| Capability {
                    authorization,
                    host,
                });
        }
    }

    pub fn begin_close(&self) {
        {
            let mut state = self.shared.state.lock().unwrap();
            state.open = false;
            state.capability = None;
        }
        self.shared.stop.cancel();
        if let CleanupState::Open(owner) = &*self.cleanup.lock().unwrap() {
            owner.worker.abort();
        }
    }

    pub async fn cleanup(&mut self) -> Result<(), ToolError> {
        self.begin_close();
        enum Action {
            Observe(Completion),
            Start {
                owner: CleanupOwner,
                reply: watch::Sender<Option<Result<(), ToolError>>>,
                pending: Completion,
            },
            Complete(Result<(), ToolError>),
        }
        let action = {
            let mut cleanup = self.cleanup.lock().unwrap();
            match &*cleanup {
                CleanupState::Closing(pending) => Action::Observe(pending.clone()),
                CleanupState::Terminal { result, .. } => Action::Complete(result.clone()),
                CleanupState::Open(_) => {
                    let (reply, pending) = watch::channel(None);
                    match std::mem::replace(&mut *cleanup, CleanupState::Closing(pending.clone())) {
                        CleanupState::Open(owner) => Action::Start {
                            owner,
                            reply,
                            pending,
                        },
                        _ => unreachable!("Clipboard cleanup starts only from its open owner"),
                    }
                }
            }
        };
        let pending = match action {
            Action::Observe(pending) => pending,
            Action::Complete(result) => return result,
            Action::Start {
                owner,
                reply,
                pending,
            } => {
                let cleanup = self.cleanup.clone();
                // Lifecycle teardown must also drain after Host admission has
                // closed. An observer cannot cancel the original CDP commands.
                tokio::spawn(async move {
                    let mut owner = owner;
                    let result = owner.cleanup().await;
                    let retained = result.is_err().then_some(owner);
                    *cleanup.lock().unwrap() = CleanupState::Terminal {
                        result: result.clone(),
                        _owner: retained,
                    };
                    reply.send_replace(Some(result));
                });
                pending
            }
        };
        completed(pending).await?
    }
}

impl CleanupOwner {
    async fn cleanup(&mut self) -> Result<(), ToolError> {
        let mut failures = Vec::new();
        match (&mut self.worker).await {
            Ok(()) => {}
            Err(error) if error.is_cancelled() => {}
            Err(error) => failures.push(format!("Clipboard event worker failed: {error}")),
        }
        let initialization = completed(self.initialization.clone()).await?;
        let installations: Vec<_> = self
            .shared
            .state
            .lock()
            .unwrap()
            .routes
            .iter()
            .map(|(route, installation)| (route.clone(), installation.clone()))
            .collect();
        for (route, installation) in installations {
            installation.settled().await;
            let (progress, active, script) = {
                let state = installation.state.lock().unwrap();
                (state.progress, state.active, state.script.clone())
            };
            if matches!(progress, InstallationProgress::Unstarted) {
                // No original installation effect was polled for this route.
                self.retire(&route, &installation);
                continue;
            }
            if !active {
                // Detaching a CDP session does not prove its document or
                // installed script was destroyed.
                failures.push("Clipboard route detached before cleanup was confirmed".into());
                continue;
            }
            let mut route_failures = Vec::new();
            let script = match script {
                DocumentScript::Absent => None,
                DocumentScript::Installed(id) => Some(id),
                DocumentScript::Unconfirmed => {
                    route_failures.push(
                        "Clipboard document-script installation has no confirmed identity".into(),
                    );
                    None
                }
            };
            let expression = format!(
                "(() => {{ if ({CONTROL}?.bindingName === {}) {CONTROL}.cleanup(); return {CONTROL}?.bindingName !== {}; }})()",
                json!(installation.name),
                json!(installation.name),
            );
            for (method, params) in [
                (
                    "Runtime.evaluate",
                    json!({"expression":expression,"returnByValue":true}),
                ),
                (
                    "Page.removeScriptToEvaluateOnNewDocument",
                    json!({"identifier":script}),
                ),
                ("Runtime.removeBinding", json!({"name":installation.name})),
                // This bound socket has no other Runtime event consumer.
                // Re-enabling after cleanup must replay its current contexts.
                ("Runtime.disable", json!({})),
            ] {
                if method == "Page.removeScriptToEvaluateOnNewDocument" && script.is_none() {
                    continue;
                }
                match self
                    .shared
                    .socket
                    .connection
                    .call(route.as_deref(), method, params)
                    .await
                {
                    Err(error) => route_failures.push(format!("{method}: {error}")),
                    Ok(reply) if reply.get("exceptionDetails").is_some() => {
                        route_failures.push(format!(
                            "Clipboard cleanup JavaScript failed: {}",
                            reply["exceptionDetails"]
                        ));
                    }
                    Ok(reply)
                        if method == "Runtime.evaluate" && reply["result"]["value"] != true =>
                    {
                        route_failures.push("Clipboard page cleanup was not confirmed".into());
                    }
                    Ok(_) => {}
                }
            }
            if route_failures.is_empty() {
                self.retire(&route, &installation);
            } else {
                failures.extend(route_failures);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            if let Err(error) = initialization {
                failures.insert(0, error.to_string());
            }
            Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
        }
    }

    fn retire(&self, route: &Option<String>, installation: &Arc<Installation>) {
        let mut state = self.shared.state.lock().unwrap();
        if state
            .routes
            .get(route)
            .is_some_and(|actual| Arc::ptr_eq(actual, installation))
        {
            state.routes.remove(route);
            state.contexts.retain(|(session, _), _| session != route);
            state.frames.retain(|(session, _), _| session != route);
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.begin_close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cua_driver_core::browser::cdp_ws::CdpConnection;
    use futures_util::{SinkExt, StreamExt};
    use tokio::{net::TcpListener, sync::mpsc};
    use tokio_tungstenite::tungstenite::Message;

    struct Wire {
        requests: mpsc::UnboundedReceiver<Value>,
        replies: mpsc::UnboundedSender<Value>,
        server: tokio::task::JoinHandle<()>,
    }

    impl Wire {
        async fn request(&mut self) -> Value {
            tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
                .await
                .expect("fixture must receive the original CDP request")
                .expect("fixture CDP connection must stay open")
        }

        fn reply(&self, request: &Value, result: Value) {
            self.replies
                .send(json!({"id":request["id"],"result":result}))
                .unwrap();
        }
    }

    impl Drop for Wire {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    async fn socket() -> (Cdp, Wire) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests, received) = mpsc::unbounded_channel();
        let (replies, mut queued) = mpsc::unbounded_channel::<Value>();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() {
                    break;
                }
                let request = serde_json::from_str(message.to_text().unwrap()).unwrap();
                if requests.send(request).is_err() {
                    break;
                }
                let Some(reply) = queued.recv().await else {
                    break;
                };
                if socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let connection = CdpConnection::connect_bounded(&format!("ws://{address}"), usize::MAX)
            .await
            .unwrap();
        (
            Cdp {
                connection: Arc::new(connection),
                dialogs: None,
            },
            Wire {
                requests: received,
                replies,
                server,
            },
        )
    }

    async fn installed_bridge() -> (Bridge, Wire) {
        let (socket, wire) = socket().await;
        let installation = Installation::new(None);
        {
            let mut state = installation.state.lock().unwrap();
            state.progress = InstallationProgress::Settled;
            state.script = DocumentScript::Installed("script".into());
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                open: true,
                capability: None,
                routes: HashMap::from([(None, installation)]),
                contexts: HashMap::new(),
                frames: HashMap::new(),
            }),
            stop: CancellationToken::new(),
            store: Arc::default(),
            socket,
        });
        let (_, initialization) = watch::channel(Some(Ok(())));
        let worker = tokio::spawn(std::future::pending());
        (
            Bridge {
                shared: shared.clone(),
                cleanup: Arc::new(Mutex::new(CleanupState::Open(CleanupOwner {
                    shared,
                    worker,
                    initialization,
                }))),
                turn: "turn".into(),
            },
            wire,
        )
    }

    fn tab(socket: Cdp) -> Tab {
        Tab {
            provider: BrowserConnection {
                id: "fixture".into(),
                endpoint: "http://127.0.0.1".into(),
            },
            generation: "fixture".into(),
            info: TabInfo {
                id: "page".into(),
                title: "fixture".into(),
                url: "https://fixture.example".into(),
                kind: "page".into(),
                websocket: None,
            },
            socket: Some(socket),
            frame: None,
            refs: HashMap::new(),
            frames: frames::Frames::default(),
            ax: ax::Projection::default(),
            previous: None,
            capture: None,
            navigation: None,
            cursor_world: None,
            cursor_epoch: crate::desktop::NativeEpochId::new(),
            cursor_owner: uuid::Uuid::new_v4(),
            cursor_host: Arc::new(tokio::sync::Mutex::new(Host::default())),
            cursor_spec: None,
            last_turn: "turn".into(),
            dialogs: None,
            dialog_host: None,
            clipboard: None,
            clipboard_store: Arc::default(),
            clipboard_authorization: None,
        }
    }

    struct Authority;

    impl BrowserAttachmentAuthorization for Authority {
        fn check(
            &self,
            _origin: BrowserAttachmentOrigin,
            _cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
    }

    #[derive(Default)]
    struct HostEffects {
        tasks: Mutex<Vec<tokio::task::JoinHandle<Result<(), ToolError>>>>,
    }

    impl BrowserHostEffects for HostEffects {
        fn spawn(&self, unpolled: crate::HostEffectFuture) -> Result<(), ToolError> {
            self.tasks.lock().unwrap().push(tokio::spawn(unpolled));
            Ok(())
        }
    }

    struct RejectedHost;

    impl BrowserHostEffects for RejectedHost {
        fn spawn(&self, _unpolled: crate::HostEffectFuture) -> Result<(), ToolError> {
            Err(failed("fixture Host admission rejected"))
        }
    }

    fn frame_tree() -> Value {
        json!({"frameTree":{"frame":{"id":"main","loaderId":"document","url":"https://fixture.example"}}})
    }

    async fn acknowledge_cleanup(wire: &mut Wire, first: Value, failure: Option<&str>) {
        let mut first = Some(first);
        for method in [
            "Runtime.evaluate",
            "Page.removeScriptToEvaluateOnNewDocument",
            "Runtime.removeBinding",
            "Runtime.disable",
        ] {
            let request = match first.take() {
                Some(request) => request,
                None => wire.request().await,
            };
            assert_eq!(request["method"], method, "cleanup request order");
            if method == "Runtime.evaluate" {
                if let Some(failure) = failure {
                    wire.replies
                        .send(json!({"id":request["id"],"error":{"code":-32000,"message":failure}}))
                        .unwrap();
                } else {
                    wire.reply(&request, json!({"result":{"value":true}}));
                }
            } else {
                wire.reply(&request, json!({}));
            }
        }
    }

    #[tokio::test]
    async fn cancelled_cleanup_observer_keeps_the_original_requests_and_join() {
        let (mut bridge, mut wire) = installed_bridge().await;
        let mut first = Box::pin(bridge.cleanup());
        let request = tokio::select! {
            result = &mut first => panic!("cleanup completed without its ACK: {result:?}"),
            request = wire.request() => request,
        };
        drop(first);
        assert!(!bridge.shared.socket.connection.is_closed());
        assert!(!bridge.is_open());
        assert_eq!(bridge.shared.state.lock().unwrap().routes.len(), 1);
        acknowledge_cleanup(&mut wire, request, None).await;
        bridge.cleanup().await.unwrap();
        assert!(bridge.shared.state.lock().unwrap().routes.is_empty());
        assert!(matches!(
            &*bridge.cleanup.lock().unwrap(),
            CleanupState::Terminal {
                result: Ok(()),
                _owner: None,
            }
        ));
        bridge.cleanup().await.unwrap();
        assert!(wire.requests.try_recv().is_err(), "cleanup was replayed");
    }

    #[tokio::test]
    async fn failed_cleanup_retains_its_original_owner_cause_and_completion() {
        let (mut bridge, mut wire) = installed_bridge().await;
        let shared = bridge.shared.clone();
        let mut first = Box::pin(bridge.cleanup());
        let request = tokio::select! {
            result = &mut first => panic!("cleanup completed without its ACK: {result:?}"),
            request = wire.request() => request,
        };
        acknowledge_cleanup(&mut wire, request, Some("fixture cleanup rejected")).await;
        let failure = first.await.unwrap_err().to_string();
        assert!(failure.contains("fixture cleanup rejected"));
        assert_eq!(bridge.shared.state.lock().unwrap().routes.len(), 1);
        {
            let state = bridge.cleanup.lock().unwrap();
            let CleanupState::Terminal {
                _owner: Some(owner),
                ..
            } = &*state
            else {
                panic!("failed cleanup must retain its original owner");
            };
            assert!(Arc::ptr_eq(&owner.shared, &shared));
            assert!(owner.worker.is_finished(), "producer join was not observed");
        }
        assert_eq!(bridge.cleanup().await.unwrap_err().to_string(), failure);
        assert!(
            wire.requests.try_recv().is_err(),
            "failed cleanup was replayed"
        );
    }

    #[tokio::test]
    async fn unconfirmed_installation_keeps_its_cause_after_other_cleanup_acks() {
        let (mut bridge, mut wire) = installed_bridge().await;
        bridge
            .shared
            .state
            .lock()
            .unwrap()
            .routes
            .get(&None)
            .unwrap()
            .state
            .lock()
            .unwrap()
            .script = DocumentScript::Unconfirmed;
        {
            let mut state = bridge.cleanup.lock().unwrap();
            let CleanupState::Open(owner) = &mut *state else {
                panic!("fixture must retain its original open owner");
            };
            let (_, pending) = watch::channel(Some(Err(ToolError::OutcomeUnknown(
                "fixture installation has no script ACK".into(),
            ))));
            owner.initialization = pending;
        }
        let mut cleanup = Box::pin(bridge.cleanup());
        for method in [
            "Runtime.evaluate",
            "Runtime.removeBinding",
            "Runtime.disable",
        ] {
            let request = tokio::select! {
                result = &mut cleanup => panic!("cleanup ended before {method}: {result:?}"),
                request = wire.request() => request,
            };
            assert_eq!(request["method"], method, "unknown script cleanup order");
            wire.reply(
                &request,
                if method == "Runtime.evaluate" {
                    json!({"result":{"value":true}})
                } else {
                    json!({})
                },
            );
        }
        let failure = cleanup.await.unwrap_err().to_string();
        assert!(failure.contains("fixture installation has no script ACK"));
        assert!(failure.contains("no confirmed identity"));
        assert_eq!(bridge.shared.state.lock().unwrap().routes.len(), 1);
        assert_eq!(bridge.cleanup().await.unwrap_err().to_string(), failure);
        assert!(
            wire.requests.try_recv().is_err(),
            "unknown cleanup was replayed"
        );
    }

    #[tokio::test]
    async fn detached_route_is_not_physical_cleanup_evidence() {
        let (mut bridge, mut wire) = installed_bridge().await;
        bridge
            .shared
            .state
            .lock()
            .unwrap()
            .routes
            .get(&None)
            .unwrap()
            .state
            .lock()
            .unwrap()
            .active = false;
        let failure = bridge.cleanup().await.unwrap_err().to_string();
        assert!(failure.contains("route detached before cleanup was confirmed"));
        assert_eq!(bridge.shared.state.lock().unwrap().routes.len(), 1);
        assert!(wire.requests.try_recv().is_err());
        assert_eq!(bridge.cleanup().await.unwrap_err().to_string(), failure);
    }

    #[tokio::test]
    async fn cancelled_initial_installation_keeps_the_tab_owner_and_original_ack() {
        let (socket, mut wire) = socket().await;
        let mut tab = tab(socket);
        let store = tab.clipboard_store.clone();
        let host = Arc::new(HostEffects::default());
        let mut installing = Box::pin(Bridge::install(
            &mut tab,
            store,
            Arc::new(Authority),
            host.clone(),
            "turn",
        ));
        for method in [
            "Target.setAutoAttach",
            "Page.getFrameTree",
            "Runtime.enable",
            "Page.enable",
            "Page.getFrameTree",
            "Runtime.addBinding",
        ] {
            let request = tokio::select! {
                result = &mut installing => panic!("installation ended before {method}: {result:?}"),
                request = wire.request() => request,
            };
            assert_eq!(request["method"], method, "initial installation order");
            wire.reply(
                &request,
                if method == "Page.getFrameTree" {
                    frame_tree()
                } else {
                    json!({})
                },
            );
        }
        let request = tokio::select! {
            result = &mut installing => panic!("installation ended before script ACK: {result:?}"),
            request = wire.request() => request,
        };
        assert_eq!(request["method"], "Page.addScriptToEvaluateOnNewDocument");
        drop(installing);
        let original = tab.clipboard.as_ref().unwrap().shared.clone();
        assert!(!original.socket.connection.is_closed());
        tab.clipboard.as_ref().unwrap().begin_close();
        wire.reply(&request, json!({"identifier":"script"}));
        let verification = wire.request().await;
        assert_eq!(verification["method"], "Runtime.evaluate");
        assert!(
            !verification["params"]["expression"]
                .as_str()
                .unwrap()
                .contains(".cleanup()"),
            "the original installation must finish before cleanup starts"
        );
        wire.reply(&verification, json!({"result":{"value":true}}));
        let tasks = std::mem::take(&mut *host.tasks.lock().unwrap());
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert!(Arc::ptr_eq(
            &tab.clipboard.as_ref().unwrap().shared,
            &original
        ));
        let mut cleanup = Box::pin(tab.cleanup_clipboard());
        let request = tokio::select! {
            result = &mut cleanup => panic!("cleanup ended before its ACK: {result:?}"),
            request = wire.request() => request,
        };
        acknowledge_cleanup(&mut wire, request, None).await;
        cleanup.await.unwrap();
        assert!(tab.clipboard.is_none());
        assert!(
            wire.requests.try_recv().is_err(),
            "installation was replayed"
        );
    }

    #[tokio::test]
    async fn rejected_installation_is_settled_before_cleanup_without_new_host_admission() {
        let (socket, mut wire) = socket().await;
        let mut tab = tab(socket);
        let store = tab.clipboard_store.clone();
        let mut installing = Box::pin(Bridge::install(
            &mut tab,
            store,
            Arc::new(Authority),
            Arc::new(RejectedHost),
            "turn",
        ));
        for method in ["Target.setAutoAttach", "Page.getFrameTree"] {
            let request = tokio::select! {
                result = &mut installing => panic!("installation ended before {method}: {result:?}"),
                request = wire.request() => request,
            };
            assert_eq!(request["method"], method, "rejected installation order");
            let result = match method {
                "Page.getFrameTree" => frame_tree(),
                _ => json!({}),
            };
            wire.reply(&request, result);
        }
        let result = tokio::select! {
            result = &mut installing => result,
            request = wire.request() => panic!(
                "rejected unpolled installation dispatched an effect: {request}"
            ),
        };
        drop(installing);
        assert!(matches!(
            result,
            Err(ToolError::Failed(message)) if message == "fixture Host admission rejected"
        ));
        let bridge = tab.clipboard.as_ref().unwrap();
        assert!(!bridge.is_open());
        assert!(bridge.shared.state.lock().unwrap().routes.is_empty());
        tab.cleanup_clipboard().await.unwrap();
        assert!(tab.clipboard.is_none());
        assert!(wire.requests.try_recv().is_err());
    }
}
