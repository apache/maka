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

//! UI integration tests: the production window content in a headless window,
//! driven through clicks and keys, against a scripted Host transport. The
//! composer reaches the Host through the real conversation state.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    Action as _, App, AppContext as _, ElementId, Entity, TestAppContext, WindowHandle, px, size,
};
use host_client::{ConnectionEvent, HostEvent};
use host_protocol::{HostAccepted, HostFrame, PushFrame};
use serde_json::{Value, json};
use workspace::actions::{AddConnection, FocusComposer, NewSession, OpenCommandPalette};
use workspace::{
    HostRequestError, HostRequester, HostSession, HostTransport, ProjectCatalogError,
    ProjectCatalogSource, ProjectEntry, RemoteHost, WindowHost,
};

use crate::Workbench;

type Reply = Result<Value, HostRequestError>;

pub(crate) const EPOCH: &str = "e1";

/// Lists a fixed set of sessions, accepts `session.create`, opens an empty
/// subscription for any session, and admits every turn. Scripted replies
/// take precedence, in order; a held reply arrives when the test sends it.
/// Records every request.
#[derive(Default)]
pub(crate) struct ScriptedHost {
    sessions: Mutex<Vec<Value>>,
    /// Whether a `get` answers with the listed session, so the composer
    /// shows its pickers; otherwise it answers with the list, which the
    /// composer cannot read and so keeps them hidden.
    answers_get: Mutex<bool>,
    pub(crate) creates: Mutex<usize>,
    replies: Mutex<HashMap<String, VecDeque<Reply>>>,
    held: Mutex<HashMap<String, VecDeque<async_channel::Receiver<Reply>>>>,
    pub(crate) requests: Mutex<Vec<(String, Value)>>,
    /// Each task's terminals as `runtime.resource.query` lists them; a
    /// start adds a running one.
    terminals: Mutex<HashMap<String, Vec<Value>>>,
    starts: Mutex<usize>,
    /// Each task's files as `artifact.query` lists them, and the revision
    /// of the list (moved by every change).
    artifacts: Mutex<HashMap<String, Vec<Value>>>,
    artifact_revision: Mutex<u64>,
    /// Each task's Turns as `session.turns.query` lists them.
    turns: Mutex<HashMap<String, Vec<Value>>>,
}

impl ScriptedHost {
    pub(crate) fn new(sessions: Vec<Value>) -> Arc<Self> {
        Arc::new(Self { sessions: Mutex::new(sessions), ..Self::default() })
    }

    pub(crate) fn reply(&self, operation: &str, reply: Reply) {
        let mut replies = self.replies.lock().expect("replies");
        replies.entry(operation.to_owned()).or_default().push_back(reply);
    }

    pub(crate) fn hold(&self, operation: &str) -> async_channel::Sender<Reply> {
        let (sender, receiver) = async_channel::bounded(1);
        let mut held = self.held.lock().expect("held");
        held.entry(operation.to_owned()).or_default().push_back(receiver);
        sender
    }

    /// Answers `get` with the listed session (see `answers_get`).
    pub(crate) fn answer_gets(&self) {
        *self.answers_get.lock().expect("answers_get") = true;
    }

    /// Sets the Turns `session.turns.query` lists for task `session`.
    pub(crate) fn set_turns(&self, session: &str, turns: Vec<Value>) {
        self.turns.lock().expect("turns").insert(session.to_owned(), turns);
    }

    /// Sets the sessions the catalog lists.
    pub(crate) fn set_sessions(&self, sessions: Vec<Value>) {
        *self.sessions.lock().expect("sessions") = sessions;
    }

    /// The sessions the catalog lists now.
    pub(crate) fn sessions(&self) -> Vec<Value> {
        self.sessions.lock().expect("sessions").clone()
    }

    /// Sets the terminals task `session` lists.
    pub(crate) fn set_terminals(&self, session: &str, names: &[&str]) {
        let resources = names.iter().map(|name| terminal_resource(session, name)).collect();
        self.terminals.lock().expect("terminals").insert(session.to_owned(), resources);
    }

    /// Sets the files task `session` lists, moving the list's revision.
    pub(crate) fn set_artifacts(&self, session: &str, artifacts: Vec<Value>) {
        self.artifacts.lock().expect("artifacts").insert(session.to_owned(), artifacts);
        *self.artifact_revision.lock().expect("revision") += 1;
    }

    pub(crate) fn requests(&self, operation: &str) -> Vec<Value> {
        let requests = self.requests.lock().expect("requests");
        requests.iter().filter(|(op, _)| op == operation).map(|(_, input)| input.clone()).collect()
    }

    /// The texts of every `turn.message.submit`, in order.
    pub(crate) fn sent(&self) -> Vec<String> {
        self.requests("turn.message.submit")
            .iter()
            .map(|input| input["content"]["text"].as_str().expect("text").to_owned())
            .collect()
    }
}

/// The turn id the scripted Host starts for a submitted message.
pub(crate) fn started_turn(input: &Value) -> String {
    format!("turn-{}", input["messageId"].as_str().expect("messageId"))
}

impl HostTransport for ScriptedHost {
    fn request(&self, operation: &'static str, input: Value, _: Duration) -> Boxed<Reply> {
        self.requests.lock().expect("requests").push((operation.to_owned(), input.clone()));
        let held = self.held.lock().expect("held").get_mut(operation).and_then(VecDeque::pop_front);
        if let Some(held) = held {
            return Box::pin(async move {
                held.recv().await.unwrap_or(Err(HostRequestError::NotConnected))
            });
        }
        let scripted =
            self.replies.lock().expect("replies").get_mut(operation).and_then(VecDeque::pop_front);
        let result = match (scripted, operation) {
            (Some(reply), _) => reply,
            (None, "session.catalog.query")
                if input["kind"] == "get" && *self.answers_get.lock().expect("answers_get") =>
            {
                let sessions = self.sessions.lock().expect("sessions");
                let session = sessions.iter().find(|session| session["id"] == input["sessionId"]);
                Ok(json!({"kind": "session", "session": session}))
            }
            (None, "session.catalog.query") => Ok(json!({
                "kind": "page",
                "revision": format!("sha256:{}", "0".repeat(64)),
                "sessions": *self.sessions.lock().expect("sessions"),
                "nextCursor": null
            })),
            (None, "session.create") => {
                *self.creates.lock().expect("creates") += 1;
                let id = input["sessionId"].as_str().expect("id");
                let workspace = &input["workspace"];
                let mut created = match workspace["path"].as_str() {
                    Some(path) => session(id, "New chat", path, "active"),
                    None => session(id, "New chat", DEMO_PATH, "active"),
                };
                if workspace["kind"] == "project" {
                    created["workspace"]["target"] = workspace.clone();
                }
                Ok(created)
            }
            (None, "subscription.open") => {
                let id = input["sessionId"].as_str().expect("sessionId");
                Ok(open_result(id))
            }
            (None, "subscription.ready" | "subscription.close") => {
                Ok(json!({"subscriptionId": input["subscriptionId"]}))
            }
            (None, "turn.message.submit") => Ok(json!({
                "disposition": "turn_started",
                "turnId": started_turn(&input),
                "skillInvocation": {"loaded": [], "failed": [], "receipts": []}
            })),
            (None, "session.remove") => {
                // A side chat's fork leaves the catalog with its removal.
                self.sessions.lock().expect("sessions").retain(|session| {
                    session["id"] != input["sessionId"]
                        || !session["labels"]
                            .as_array()
                            .is_some_and(|labels| labels.contains(&json!("mode:side_conversation")))
                });
                Ok(json!({"kind": "removed", "sessionId": input["sessionId"]}))
            }
            (None, "session.turns.query") => {
                let session = input["sessionId"].as_str().expect("session");
                let turns = self.turns.lock().expect("turns").get(session).cloned();
                Ok(json!({"sessionId": session, "throughSequence": 40,
                          "contributions": turns.unwrap_or_default(), "nextPosition": null}))
            }
            // A side chat's fork: the source's projection with the label
            // and the parent, listed from now on.
            (None, "session.branch.create") => {
                let source = input["sourceSessionId"].as_str().expect("source");
                let target = input["targetSessionId"].as_str().expect("target");
                let mut sessions = self.sessions.lock().expect("sessions");
                let Some(mut fork) =
                    sessions.iter().find(|session| session["id"] == source).cloned()
                else {
                    return Box::pin(async move {
                        Err(HostRequestError::Operation {
                            operation: "session.branch.create",
                            code: host_protocol::HostOperationErrorCode::NotFound,
                            message: "Source Session does not exist".into(),
                        })
                    });
                };
                fork["id"] = json!(target);
                fork["revision"] = json!(2);
                fork["labels"] = json!(["mode:side_conversation"]);
                fork["parentSessionId"] = json!(source);
                if let Some(turn) = input["sourceTurnId"].as_str() {
                    fork["branchOfTurnId"] = json!(turn);
                }
                if !sessions.iter().any(|session| session["id"] == target) {
                    sessions.push(fork.clone());
                }
                Ok(json!({"kind": "committed", "session": fork}))
            }
            (None, "turn.stop") => Ok(json!({
                "sessionId": input["sessionId"], "turnId": input["turnId"],
                "runId": input["runId"], "status": "cancelled", "terminalEventId": "end",
                "abortSource": "renderer.stop_button"
            })),
            (None, "subscription.pty_interest.set") => {
                Ok(json!({"subscriptionId": input["subscriptionId"]}))
            }
            (None, "runtime.resource.query") if input["kind"] == "list_start" => {
                let session = input["sessionId"].as_str().expect("session");
                let terminals = self.terminals.lock().expect("terminals");
                let resources = terminals.get(session).cloned().unwrap_or_default();
                Ok(json!({"kind": "page", "sessionId": session, "revision": "sha256:00",
                          "resources": resources, "nextCursor": null}))
            }
            (None, "runtime.resource.start") => {
                let session = input["sessionId"].as_str().expect("session").to_owned();
                let name = {
                    let mut starts = self.starts.lock().expect("starts");
                    *starts += 1;
                    format!("started-{starts}")
                };
                let resource = terminal_resource(&session, &name);
                self.terminals
                    .lock()
                    .expect("terminals")
                    .entry(session)
                    .or_default()
                    .push(resource.clone());
                Ok(json!({"resource": resource["result"]}))
            }
            (None, "runtime.resource.controller.acquire") => Ok(json!({
                "controllerId": input["controllerId"], "nextSequence": 1,
                "pty": {"sessionId": input["sessionId"], "ref": input["ref"], "sequence": 0,
                        "buffer": "", "size": {"cols": 80, "rows": 24}}
            })),
            (None, "runtime.resource.controller.control") => {
                Ok(json!({"controllerId": input["controllerId"], "sequence": input["sequence"]}))
            }
            (None, "runtime.resource.controller.release") => {
                Ok(json!({"controllerId": input["controllerId"], "released": true}))
            }
            (None, "runtime.resource.stop") => {
                let session = input["sessionId"].as_str().expect("session");
                let reference = input["ref"].as_str().expect("ref");
                if let Some(terminals) = self.terminals.lock().expect("terminals").get_mut(session)
                {
                    terminals.retain(|terminal| terminal["result"]["ref"] != reference);
                }
                Ok(json!({}))
            }
            (None, "artifact.query")
                if matches!(input["kind"].as_str(), Some("list_start" | "get")) =>
            {
                let session = input["sessionId"].as_str().expect("session");
                let artifacts = self.artifacts.lock().expect("artifacts");
                let listed = artifacts.get(session).cloned().unwrap_or_default();
                let revision =
                    format!("sha256:{:064x}", *self.artifact_revision.lock().expect("revision"));
                if input["kind"] == "get" {
                    Ok(json!({"kind": "artifact", "sessionId": session, "revision": revision,
                              "artifact": null}))
                } else {
                    Ok(json!({"kind": "page", "sessionId": session, "revision": revision,
                              "artifacts": listed, "nextCursor": null}))
                }
            }
            // The Trace face's reads: a task that has not run.
            (None, "execution.inspect.query") => Ok(json!({
                "kind": "session_trace_page", "schemaVersion": 1,
                "sessionId": input["sessionId"], "turns": [],
                "coverage": {"modelCalls": "none", "turnsMissingModelCalls": [],
                             "turnsWithFewerModelCallsThanSteps": [], "unreadableRecords": 0,
                             "oversizedRuns": 0},
                "nextCursor": null
            })),
            (None, "context.diagnostics.query") => {
                Ok(json!({"status": "unavailable", "reason": "no_completed_request"}))
            }
            (None, "usage.query") if input["kind"] == "summary" => Ok(json!({
                "kind": "summary",
                "summary": {"range": {"from": 0, "to": 1}, "totalRequests": 0, "totalCostUsd": 0,
                    "totalTokens": {"input": 0, "output": 0, "cacheMiss": 0, "cacheRead": 0,
                                    "cacheWrite": 0, "reasoning": 0, "total": 0},
                    "cacheHitRequests": 0, "cacheCreateRequests": 0, "errorRequests": 0,
                    "totalDurationMs": 0},
                "provenance": {"coverage": {"attempts": 0, "pricedAttempts": 0,
                    "unpricedAttempts": 0, "usageReportedAttempts": 0, "usagePartialAttempts": 0,
                    "usageMissingAttempts": 0}, "legacyRecords": 0, "unreadableRecords": 0,
                    "pendingRepairs": 0}
            })),
            (None, other) => Err(HostRequestError::Transport(format!("unexpected {other}").into())),
        };
        Box::pin(async move { result })
    }
}

/// A file of task `session` a subagent wrote back, as `artifact.query`
/// lists it.
pub(crate) fn artifact(session: &str, id: &str, name: &str) -> Value {
    json!({
        "id": id, "sessionId": session, "turnId": "t1", "createdAt": 1, "name": name,
        "kind": "file", "sizeBytes": 3, "source": "subagent_writeback"
    })
}

/// The ref of the terminal `name`.
pub(crate) fn terminal_ref(name: &str) -> String {
    format!("maka://runtime/background-tasks/{name}")
}

/// A running terminal of task `session`, as `runtime.resource.query` lists
/// it.
pub(crate) fn terminal_resource(session: &str, name: &str) -> Value {
    json!({
        "sessionId": session, "ownership": {"kind": "local"},
        "sourceTurnId": format!("desktop-terminal-{name}"),
        "sourceToolCallId": format!("desktop-terminal-{name}"),
        "result": {"kind": "shell_run", "ref": terminal_ref(name), "mode": "pty",
                   "status": "running", "cwd": "/w", "cmd": "exec \"$SHELL\" -l",
                   "startedAt": 1, "updatedAt": 2, "revision": 2}
    })
}

/// The one project the Host lists: new tasks go into it.
pub(crate) const DEMO_PATH: &str = "/work/demo";

struct DemoProject;

impl ProjectCatalogSource for DemoProject {
    fn list(&self, _: &HostRequester) -> Boxed<Result<Vec<ProjectEntry>, ProjectCatalogError>> {
        Box::pin(async { Ok(vec![ProjectEntry::new("p1", "Demo", DEMO_PATH)]) })
    }
}

pub(crate) fn session(id: &str, name: &str, path: &str, status: &str) -> Value {
    json!({
        "id": id, "revision": 1,
        "workspace": {"target": {"kind": "host_path", "path": path}, "hostCwd": path},
        "createdAt": 1, "activityAt": 2, "name": name, "isFlagged": false, "isArchived": false,
        "labels": [], "labelsTruncated": false, "hasUnread": false, "status": status,
        "backend": "ai-sdk", "llmConnectionId": null, "llmConnectionSlug": "env",
        "connectionLocked": false, "model": "m", "permissionMode": "ask",
        "collaborationMode": "agent", "orchestrationMode": "default"
    })
}

/// A session in the Host's one project (`p1`), run in `path`.
pub(crate) fn session_in_project(id: &str, name: &str, path: &str) -> Value {
    let mut session = session(id, name, path, "active");
    session["workspace"]["target"] = json!({"kind": "project", "projectId": "p1"});
    session
}

fn snapshot(session_id: &str, revision: u64, root: Value) -> Value {
    json!({
        "schemaVersion": 5,
        "session": {"sessionId": session_id, "metadataRevision": 1, "status": "active",
                    "createdAt": 1, "isArchived": false},
        "projectionRevision": revision,
        "rootTurn": root,
        "goal": null,
        "queue": {"hostEpoch": EPOCH, "queueRevision": 0, "steering": [], "followup": []},
        "interactions": {"pending": []}
    })
}

/// An empty session: no turn yet.
fn open_result(session_id: &str) -> Value {
    json!({
        "hostEpoch": EPOCH,
        "subscriptionId": format!("sub-{session_id}"),
        "nextSequence": 1,
        "snapshot": snapshot(session_id, 1, Value::Null),
        "activeAssistantStreams": [],
        "transcript": {"durable": {
            "kind": "page", "sessionId": session_id, "direction": "older", "throughSequence": null,
            "rawBytes": 0, "fragments": [], "nextCursor": null, "endsAtTurnBoundary": true
        }}
    })
}

pub(crate) fn accepted() -> HostAccepted {
    serde_json::from_value(json!({
        "kind": "accepted", "rootId": "r", "hostEpoch": EPOCH, "connectionId": "c",
        "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
        "compositionRevision": "3", "state": "ready"
    }))
    .expect("accepted")
}

pub(crate) struct Harness {
    host: Entity<HostSession>,
    pub(crate) transport: Arc<ScriptedHost>,
    pub(crate) workbench: Entity<Workbench>,
    pub(crate) window: WindowHandle<Root>,
    /// The next frame sequence and projection revision of each subscription.
    sequences: HashMap<String, (u64, u64)>,
}

impl Harness {
    pub(crate) fn open(sessions: Vec<Value>, cx: &mut TestAppContext) -> Self {
        Self::with_transport(ScriptedHost::new(sessions), cx)
    }

    pub(crate) fn with_transport(transport: Arc<ScriptedHost>, cx: &mut TestAppContext) -> Self {
        Self::on_host(transport, WindowHost::Local, cx)
    }

    /// The window on `window_host`, whose requests go to `transport`.
    fn on_host(
        transport: Arc<ScriptedHost>,
        window_host: WindowHost,
        cx: &mut TestAppContext,
    ) -> Self {
        Self::with_projects(transport, window_host, Rc::new(DemoProject), cx)
    }

    /// The window on `window_host`, whose requests go to `transport`, with
    /// the projects `projects` lists.
    pub(crate) fn with_projects(
        transport: Arc<ScriptedHost>,
        window_host: WindowHost,
        projects: Rc<dyn ProjectCatalogSource>,
        cx: &mut TestAppContext,
    ) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            // Overlays slide in on the wall clock; with motion reduced they
            // settle on their first frame, so clicks land where they show.
            cx.set_reduce_motion(true);
        });
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone())
                .for_host(window_host)
        });
        let mut workbench = None;
        let window = cx.open_window(size(px(1200.), px(700.)), |window, cx| {
            let view = cx.new(|cx| Workbench::new(host.clone(), projects, window, cx));
            workbench = Some(view.clone());
            Root::new(view, window, cx)
        });
        let harness = Self {
            host,
            transport,
            workbench: workbench.expect("workbench"),
            window,
            sequences: HashMap::new(),
        };
        harness.feed(ConnectionEvent::Connected { accepted: accepted() }, cx);
        harness
    }

    pub(crate) fn feed(&self, event: ConnectionEvent, cx: &mut TestAppContext) {
        self.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Connection(event), cx));
        settle(cx);
    }

    pub(crate) fn push(&self, frame: PushFrame, cx: &mut TestAppContext) {
        self.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Push(frame), cx));
        settle(cx);
    }

    /// Sends the next projection of `session_id`'s subscription with `root`.
    pub(crate) fn project(&mut self, session_id: &str, root: Value, cx: &mut TestAppContext) {
        let subscription = format!("sub-{session_id}");
        let (sequence, revision) = self.sequences.entry(subscription.clone()).or_insert((1, 1));
        *revision += 1;
        let value = json!({
            "kind": "subscription.session_projection", "hostEpoch": EPOCH,
            "subscriptionId": subscription, "sequence": *sequence,
            "snapshot": snapshot(session_id, *revision, root)
        });
        *sequence += 1;
        self.push(frame(value), cx);
    }

    /// Sends the next `session_domain_changed` of `session_id`'s
    /// subscription, for `domain`.
    pub(crate) fn domain_changed(
        &mut self,
        session_id: &str,
        domain: &str,
        cx: &mut TestAppContext,
    ) {
        let subscription = format!("sub-{session_id}");
        let (sequence, _) = self.sequences.entry(subscription.clone()).or_insert((1, 1));
        let value = json!({
            "kind": "subscription.session_domain_changed", "hostEpoch": EPOCH,
            "subscriptionId": subscription, "sequence": *sequence, "sessionId": session_id,
            "domain": domain
        });
        *sequence += 1;
        self.push(frame(value), cx);
    }

    pub(crate) fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut gpui_kit::Window, &mut App) -> R,
    ) -> R {
        let result = cx
            .update_window(self.window.into(), |_, window, cx| {
                window.render_frame(cx);
                f(window, cx)
            })
            .expect("window");
        settle(cx);
        result
    }

    pub(crate) fn draft_id(&self, cx: &mut TestAppContext) -> ElementId {
        let draft = self
            .workbench
            .read_with(cx, |workbench, cx| workbench.composer().read(cx).draft().entity_id());
        ("input", draft).into()
    }

    pub(crate) fn draft(&self, cx: &mut TestAppContext) -> String {
        self.workbench.read_with(cx, |workbench, cx| {
            workbench.composer().read(cx).draft().read(cx).value().to_string()
        })
    }

    /// Whether the new task's draft shows: no task selected, by choice.
    pub(crate) fn drafting(&self, cx: &mut TestAppContext) -> bool {
        self.workbench.read_with(cx, |workbench, cx| {
            workbench.sidebar().read(cx).catalog().read(cx).is_draft()
        })
    }

    /// The selected task's id.
    pub(crate) fn selected(&self, cx: &mut TestAppContext) -> Option<String> {
        self.workbench.read_with(cx, |workbench, cx| {
            let catalog = workbench.sidebar().read(cx).catalog().read(cx);
            catalog.selected_id().map(ToString::to_string)
        })
    }
}

/// Lets queued work run and the conversation's coalescing window close.
pub(crate) fn settle(cx: &mut TestAppContext) {
    cx.run_until_parked();
    cx.executor().advance_clock(conversation::COMMIT_INTERVAL * 2);
    cx.run_until_parked();
}

pub(crate) fn frame(value: Value) -> PushFrame {
    match HostFrame::decode(value).expect("frame") {
        HostFrame::Push(frame) => frame,
        other => panic!("not a push frame: {other:?}"),
    }
}

pub(crate) fn root(turn_id: &str, run_id: &str, status: &str) -> Value {
    let mut root = json!({"sessionId": "s1", "turnId": turn_id, "runId": run_id, "status": status});
    if matches!(status, "completed" | "cancelled" | "failed") {
        root["terminalEventId"] = json!("end");
    }
    root
}

#[gpui_kit::test]
fn enter_sends_and_shift_enter_inserts_a_newline(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    let draft = harness.draft_id(cx);

    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
        // Enter on a blank draft sends nothing.
        window.press("enter", cx);
        window.input("hello", cx);
        window.press("shift-enter", cx);
        window.input("world", cx);
    });
    assert_eq!(harness.draft(cx), "hello\nworld", "Shift+Enter kept the draft and added a line");
    assert!(harness.transport.sent().is_empty());

    harness.with_window(cx, |window, cx| window.press("enter", cx));
    assert_eq!(harness.transport.sent(), ["hello\nworld"]);
    let submit = &harness.transport.requests("turn.message.submit")[0];
    assert_eq!(submit["sessionId"], "s1");
    assert_eq!(submit["placement"], "next_turn");
    assert!(submit["messageId"].as_str().is_some_and(|id| !id.is_empty()), "a fresh id");
    assert_eq!(harness.draft(cx), "", "the draft clears once the Host accepts");
}

#[gpui_kit::test]
fn the_send_button_and_its_key_binding_send_the_same_way(cx: &mut TestAppContext) {
    let mut harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input("one", cx);
    });
    harness.with_window(cx, |window, cx| window.click("send-message", cx));
    // The admitted turn runs until the Host reports it finished.
    let turn_id = started_turn(&harness.transport.requests("turn.message.submit")[0]);
    harness.project("s1", root(&turn_id, "run-started", "completed"), cx);
    harness.with_window(cx, |window, cx| {
        window.input("two", cx);
        window.press("secondary-enter", cx);
    });
    assert_eq!(harness.transport.sent(), ["one", "two"]);
}

#[gpui_kit::test]
fn the_draft_clears_only_once_the_host_accepts(cx: &mut TestAppContext) {
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", "/work/a", "active")]);
    let accept = transport.hold("turn.message.submit");
    let harness = Harness::with_transport(transport, cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input("hello", cx);
        window.press("enter", cx);
        // In flight: a second Enter and the button send nothing more.
        window.press("enter", cx);
        window.click("send-message", cx);
    });
    assert_eq!(harness.transport.sent(), ["hello"], "one send while the first is in flight");
    assert_eq!(harness.draft(cx), "hello", "kept until the Host answers");

    let input = harness.transport.requests("turn.message.submit").remove(0);
    accept
        .try_send(Ok(json!({
            "disposition": "turn_started", "turnId": started_turn(&input),
            "skillInvocation": {"loaded": [], "failed": [], "receipts": []}
        })))
        .expect("accept");
    settle(cx);
    assert_eq!(harness.draft(cx), "", "cleared once accepted");
}

#[gpui_kit::test]
fn a_refused_send_keeps_the_draft_and_says_why(cx: &mut TestAppContext) {
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", "/work/a", "active")]);
    transport.reply(
        "turn.message.submit",
        Err(HostRequestError::Operation {
            operation: "turn.message.submit",
            code: host_protocol::HostOperationErrorCode::ModelUnavailable,
            message: "no model is configured".into(),
        }),
    );
    let harness = Harness::with_transport(transport, cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input("hello", cx);
        window.press("enter", cx);
    });
    assert_eq!(harness.transport.sent(), ["hello"]);
    assert_eq!(harness.draft(cx), "hello", "a refused message stays in the draft");
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("composer-error").label(),
            Some("Couldn’t send the message. No model is configured.")
        );
    });
}

#[gpui_kit::test]
fn stop_follows_the_turn_not_the_catalog(cx: &mut TestAppContext) {
    let mut harness = Harness::open(vec![session("s1", "Busy", "/work/a", "running")], cx);
    // The catalog says running, but no turn runs: the round button offers
    // Send, not Stop.
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("stop-turn").is_none());
        assert!(window.find("send-message").visible());
    });

    harness.project("s1", root("t1", "r1", "running"), cx);
    harness.with_window(cx, |window, cx| window.click("stop-turn", cx));
    assert_eq!(
        harness.transport.requests("turn.stop"),
        [json!({"sessionId": "s1", "turnId": "t1", "runId": "r1"})]
    );
}

#[gpui_kit::test]
fn the_disconnected_strip_appears_and_content_stays(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("host-disconnected").is_none());
        assert_eq!(
            window.find("sidebar-footer").label(),
            Some("Local Host, Connected, data folder .dev-root")
        );
    });

    harness.feed(
        ConnectionEvent::Disconnected { reason: "the Runtime Host closed the connection".into() },
        cx,
    );
    harness.with_window(cx, |window, _| {
        let strip = window.find("host-disconnected");
        assert!(strip.visible());
        assert!(window.find("reconnect").visible());
        assert!(window.find("serve-command").visible());
        // The session list is still there beside the main pane.
        let row = window.find(shared::domain_element_id("session-row", "s1"));
        assert!(row.visible());
        // The task has no turn, so its content is the empty state.
        assert!(window.find("empty-state").visible());
        // One banner: Retry and the reason are inside it.
        let banner = strip.bounds();
        assert!(banner.contains(&window.find("reconnect").bounds().center()));
        let reason = window.find("host-disconnected-reason").bounds();
        assert!(banner.contains(&reason.center()));
        // 16 in, the glyph, 8, then the text: the scheduled notice's
        // recipe, with no ring.
        assert_eq!(reason.left() - banner.left(), px(40.));
        // Retry is Desktop's small button, centred on the title's line,
        // 12 under the banner's top.
        let retry = window.find("reconnect").bounds();
        assert_eq!(retry.size.height, px(28.));
        assert_eq!(retry.center().y - banner.top(), px(22.));
        // The draft's one line says why nothing can be sent; the controls
        // row keeps its controls (disabled) and adds no sentence.
        assert_eq!(window.find("composer-note").label(), None);
        assert!(window.find("composer-attach").visible());
    });
    assert_eq!(
        harness.workbench.read_with(cx, |w, cx| w.composer().read(cx).placeholder()),
        shared::copy::conversation::COMPOSER_OFFLINE.en()
    );
    // Offline, Enter keeps the draft instead of handing it to nobody.
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input("later", cx);
        window.press("enter", cx);
    });
    assert_eq!(harness.draft(cx), "later");
    assert!(harness.transport.sent().is_empty());

    harness.feed(ConnectionEvent::Connected { accepted: accepted() }, cx);
    assert_eq!(
        harness.workbench.read_with(cx, |w, cx| w.composer().read(cx).placeholder()),
        shared::copy::conversation::COMPOSER_PLACEHOLDER.en(),
        "connected again, the usual line"
    );
    assert_eq!(
        harness.transport.requests("subscription.open").len(),
        2,
        "reopened after reconnect"
    );
    harness.with_window(cx, |window, cx| {
        assert!(window.try_find("host-disconnected").is_none(), "the strip goes away");
        window.press("enter", cx);
    });
    assert_eq!(harness.transport.sent(), ["later"]);
}

#[gpui_kit::test]
fn starting_a_host_shows_progress_then_the_failure_and_retry(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    harness.feed(ConnectionEvent::Disconnected { reason: "closed".into() }, cx);
    harness.feed(ConnectionEvent::HostStarting { attempt: 1, pid: 42 }, cx);
    harness.with_window(cx, |window, _| {
        let starting = window.find("host-starting");
        assert!(starting.visible());
        assert_eq!(starting.label(), Some(shared::copy::HOST_STARTING.en()));
        assert!(window.try_find("host-disconnected").is_none(), "no failure while it starts");
        assert_eq!(
            window.find("sidebar-footer").label(),
            Some("Local Host, Starting…, data folder .dev-root")
        );
    });

    let reason = "no Node v22.19.0 or newer to run the Runtime Host; install one with nvm or set \
                  MAKA_NODE to its path.";
    harness.feed(ConnectionEvent::AttemptFailed { attempt: 1, reason: reason.into() }, cx);
    harness.feed(ConnectionEvent::Suspended { reason: reason.into(), blocker: None }, cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("host-starting").is_none());
        assert!(window.find("host-disconnected").visible());
        let retry = window.find("reconnect");
        assert!(retry.visible());
        assert_eq!(retry.label(), Some(shared::copy::RETRY.en()));
        // The manual command stays as the fallback.
        assert!(window.find("serve-command").visible());
    });

    harness.feed(ConnectionEvent::HostStarting { attempt: 1, pid: 43 }, cx);
    harness.feed(ConnectionEvent::Connected { accepted: accepted() }, cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("host-starting").is_none());
        assert!(window.try_find("host-disconnected").is_none());
    });
}

#[gpui_kit::test]
fn window_commands_reach_their_owners_from_the_keyboard(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    let draft = harness.draft_id(cx);
    // Focus starts in the session list.
    harness.with_window(cx, |window, cx| {
        window.click(shared::domain_element_id("session-row", "s1"), cx);
        assert_eq!(window.find("session-list").focused(), Some(true));
        window.press("secondary-l", cx);
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "Focus Composer");
    });
    harness.with_window(cx, |window, cx| window.press("secondary-n", cx));
    assert!(harness.drafting(cx), "New task opens the draft");
    assert_eq!(*harness.transport.creates.lock().expect("creates"), 0, "and creates nothing");
}

#[gpui_kit::test]
fn menu_commands_work_when_nothing_has_focus(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.blur(cx);
        assert!(window.focused(cx).is_none());
        // What a menu item does: dispatch to the window, here with no focus.
        window.dispatch_action(NewSession.boxed_clone(), cx);
    });
    assert!(harness.drafting(cx), "New task opens the draft");
    harness.with_window(cx, |window, cx| {
        window.blur(cx);
        window.dispatch_action(FocusComposer.boxed_clone(), cx);
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "Focus Composer");
    });
}

#[gpui_kit::test]
fn the_view_menu_shows_cmd_k_and_both_keys_open_the_palette(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    // What GPUI's macOS menu bar shows for an item: the first binding of its
    // action that fits the menu's stock context.
    let shown = cx.update(|cx| {
        let mut menu_context = gpui_kit::KeyContext::new_with_defaults();
        for name in ["Workspace", "Pane", "Editor"] {
            menu_context.add(name);
        }
        let keymap = cx.key_bindings();
        let keymap = keymap.borrow();
        let bindings: Vec<&gpui_kit::KeyBinding> =
            keymap.bindings_for_action(&OpenCommandPalette).collect();
        let fits = |binding: &&&gpui_kit::KeyBinding| {
            binding
                .predicate()
                .is_none_or(|predicate| predicate.eval(std::slice::from_ref(&menu_context)))
        };
        let shown = bindings.iter().find(fits).or(bindings.first()).expect("a binding");
        let keystroke = shown.keystrokes().first().expect("a keystroke");
        gpui_kit::AsKeystroke::as_keystroke(keystroke).clone()
    });
    assert_eq!(shown, gpui_kit::Keystroke::parse("secondary-k").expect("keystroke"), "⌘K");
    // With focus in the window, and with none.
    for (key, blur) in
        [("secondary-k", false), ("secondary-shift-p", false), ("secondary-shift-p", true)]
    {
        harness.with_window(cx, |window, cx| {
            if blur {
                window.blur(cx);
            }
            window.press(key, cx);
        });
        harness.with_window(cx, |window, cx| {
            assert!(window.find("command-palette").visible(), "{key} opens the palette");
            window.press("escape", cx);
        });
        harness.with_window(cx, |window, _| assert!(window.try_find("command-palette").is_none()));
    }
}

#[gpui_kit::test]
fn tab_walks_the_sidebar_then_the_composer(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(shared::domain_element_id("session-row", "s1"), cx);
        // The sidebar's footer row follows the list.
        window.press("tab", cx);
        assert_eq!(window.find("sidebar-footer").focused(), Some(true), "list → footer");
        window.press("tab", cx);
        assert_eq!(window.find("footer-settings").focused(), Some(true), "footer → settings");
        // The header's folder button, before the title.
        window.press("tab", cx);
        assert_eq!(window.find("project-info").focused(), Some(true), "settings → folder");
        // The changes panel's button ends the header.
        window.press("tab", cx);
        assert_eq!(window.find("review-toggle").focused(), Some(true), "folder → Changes");
        // The task has no turn yet; its empty state is a line of text with
        // nothing to focus, so the context strip's folder name follows the
        // header, then the composer.
        window.press("tab", cx);
        let strip = "context-strip-project";
        assert_eq!(window.find(strip).focused(), Some(true), "Changes → the strip's folder");
        window.press("tab", cx);
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "the strip → composer");
        window.input("x", cx);
        window.press("tab", cx);
        assert_eq!(window.find("composer-attach").focused(), Some(true), "composer → +");
        window.press("tab", cx);
        // Nothing runs, so the round button is Send.
        assert_eq!(window.find("send-message").focused(), Some(true), "+ → Send");
        window.press("shift-tab", cx);
        window.press("shift-tab", cx);
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
        window.press("shift-tab", cx);
        assert_eq!(window.find(strip).focused(), Some(true), "composer → the strip");
        window.press("shift-tab", cx);
        assert_eq!(window.find("review-toggle").focused(), Some(true), "the strip → Changes");
        window.press("shift-tab", cx);
        assert_eq!(window.find("project-info").focused(), Some(true), "Changes → folder");
        window.press("shift-tab", cx);
        assert_eq!(window.find("footer-settings").focused(), Some(true), "folder → settings");
        window.press("shift-tab", cx);
        assert_eq!(window.find("sidebar-footer").focused(), Some(true), "settings → footer");
        window.press("shift-tab", cx);
        assert_eq!(window.find("session-list").focused(), Some(true), "footer → list");
        window.press("shift-tab", cx);
        let by_project = shared::domain_element_id("task-grouping", "project");
        assert_eq!(window.find(by_project).focused(), Some(true), "list → By project");
        window.press("shift-tab", cx);
        let by_time = shared::domain_element_id("task-grouping", "time");
        assert_eq!(window.find(by_time).focused(), Some(true), "By project → By time");
        // The pages' entries sit between New task and the grouping switch.
        for page in ["scheduled-tasks", "extensions"] {
            window.press("shift-tab", cx);
            let entry = shared::domain_element_id("sidebar-page", page);
            assert_eq!(window.find(entry).focused(), Some(true), "→ {page}");
        }
        window.press("shift-tab", cx);
        assert_eq!(window.find("new-session").focused(), Some(true), "Extensions → New task");
        // The app name row's search button opens the Search page.
        window.press("shift-tab", cx);
        let search = window.find("search-button");
        assert_eq!(search.focused(), Some(true), "New task → search");
        // Before the sidebar's rows come the window controls in its top
        // strip; Back and Forward are disabled, so the toggle is next.
        window.press("shift-tab", cx);
        assert_eq!(window.find("sidebar-toggle").focused(), Some(true), "search → toggle");
    });
}

/// Replays `stop_after_start` recorded from a real Host up to the running
/// turn: Send is refused while it runs, and Stop names the root turn.
#[gpui_kit::test]
fn send_queues_behind_a_running_turn_and_stop_names_it(cx: &mut TestAppContext) {
    let lines: Vec<Value> =
        include_str!("../../host-protocol/fixtures/sequences/stop_after_start.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).expect("JSON"))
            .collect();
    let response = |operation: &str| -> Vec<Value> {
        lines
            .iter()
            .filter(|line| line.get("ok").is_some() && line["operation"] == operation)
            .map(|line| line["result"].clone())
            .collect()
    };
    let open = response("subscription.open").remove(0);
    let session_id = open["snapshot"]["session"]["sessionId"].as_str().expect("id").to_owned();
    let transport = ScriptedHost::new(vec![session(&session_id, "Fixture", "/work/a", "active")]);
    let mut open = open;
    // This harness connects with its own epoch.
    open["hostEpoch"] = json!(EPOCH);
    transport.reply("subscription.open", Ok(open));
    for page in response("session.transcript.page") {
        transport.reply("session.transcript.page", Ok(page));
    }
    let harness = Harness::with_transport(transport, cx);
    let frames: Vec<PushFrame> = lines
        .iter()
        .filter(|line| line["kind"].as_str().is_some_and(|kind| kind.starts_with("subscription.")))
        .map(|line| {
            let mut line = line.clone();
            line["hostEpoch"] = json!(EPOCH);
            if let Some(queue) = line.pointer_mut("/snapshot/queue/hostEpoch") {
                *queue = json!(EPOCH);
            }
            frame(line)
        })
        .collect();
    let (running, rest) = frames.split_at(3);
    for frame in running {
        harness.push(frame.clone(), cx);
    }
    let turn = lines
        .iter()
        .find(|line| line.get("input").is_some() && line["operation"] == "turn.stop")
        .expect("the recorded stop")["input"]
        .clone();

    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        // An empty draft while the turn runs: the round button is Stop.
        assert!(window.try_find("send-message").is_none());
        assert!(window.find("stop-turn").visible());
        window.input("and then?", cx);
        // A draft turns it back into Send, which queues after the turn.
        assert_eq!(
            window.find("send-message").label(),
            Some(shared::copy::conversation::SEND_QUEUED.en())
        );
    });
    harness.transport.reply(
        "turn.message.submit",
        Ok(json!({"disposition": "followup", "queueRevision": 1,
                  "skillInvocation": {"loaded": [], "failed": [], "receipts": []}})),
    );
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    assert_eq!(harness.transport.sent(), ["and then?"], "sent while the turn runs");
    assert_eq!(harness.transport.requests("turn.message.submit")[0]["placement"], "next_turn");
    assert_eq!(harness.draft(cx), "", "the Host queued it");

    harness.with_window(cx, |window, cx| window.click("stop-turn", cx));
    assert_eq!(
        harness.transport.requests("turn.stop"),
        [turn],
        "Stop names the root turn and run the Host reported"
    );
    for frame in rest {
        harness.push(frame.clone(), cx);
    }
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("stop-turn").is_none(), "the turn stopped");
    });
}

/// Lets a deferred focus return (a dialog's waits out its closing
/// animation on the test clock) take effect.
fn wait_for_the_focus_return(harness: &Harness, cx: &mut TestAppContext) {
    cx.executor().advance_clock(Duration::from_millis(400));
    harness.with_window(cx, |_, _| {});
}

/// The heading of the Models page's connection group: "Connections", or
/// "Add connection" while the form shows.
fn connections_heading() -> ElementId {
    shared::domain_element_id("settings-group-title", "add-connection")
}

#[gpui_kit::test]
fn add_connection_opens_settings_from_the_model_menu_and_escape_returns_focus(
    cx: &mut TestAppContext,
) {
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", "/work/a", "active")]);
    *transport.answers_get.lock().expect("answers_get") = true;
    let harness = Harness::with_transport(transport, cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(shared::domain_element_id("session-row", "s1"), cx);
    });
    // The keyboard path: Tab from the draft past "+" to the model picker,
    // Enter opens its menu, Up reaches its last item, "Add connection…",
    // Enter.
    harness.with_window(cx, |window, cx| {
        window.press("secondary-l", cx);
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
        window.press("tab", cx);
        window.press("tab", cx);
        assert_eq!(window.find("composer-model").focused(), Some(true));
        window.press("enter", cx);
        assert!(window.find("popup-menu").visible());
        window.press("up", cx);
        window.press("enter", cx);
    });
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("popup-menu").is_none(), "the menu closed");
        assert!(window.find("settings-page").visible(), "settings opened");
        assert_eq!(
            window.find("settings-title").label(),
            Some(shared::copy::settings::SECTION_MODELS.en()),
            "at Models"
        );
        assert_eq!(
            window.find(connections_heading()).label(),
            Some(shared::copy::settings::ADD_CONNECTION_TITLE.en()),
            "on the provider catalog"
        );
        assert!(window.find("provider-catalog").visible());
        assert_eq!(window.find("provider-search").focused(), Some(true), "on its search");
    });
    // Escape in the search is the field's; from the first provider it
    // goes back.
    harness.with_window(cx, |window, cx| {
        window.press("escape", cx);
        assert!(window.find("provider-catalog").visible());
        window.press("tab", cx);
        window.press("escape", cx);
    });
    wait_for_the_focus_return(&harness, cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("settings-page").is_none(), "Escape goes back to the app");
        // The picker was not drawn while settings showed, so its focus went
        // with it; the composer it sits in takes focus.
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "focus is in the composer");
    });

    // The same command from the menu bar, with the draft focused: Escape
    // returns focus to the draft.
    harness.with_window(cx, |window, cx| {
        window.press("secondary-l", cx);
        window.dispatch_action(AddConnection.boxed_clone(), cx);
    });
    harness.with_window(cx, |window, cx| {
        assert!(window.find("provider-catalog").visible());
        window.press("tab", cx);
        window.press("escape", cx);
    });
    wait_for_the_focus_return(&harness, cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("settings-page").is_none());
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
    });
}

#[gpui_kit::test]
fn settings_opens_with_its_shortcut_and_escape_returns_focus(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.press("secondary-l", cx);
        window.press("secondary-,", cx);
    });
    harness.with_window(cx, |window, cx| {
        assert!(window.find("settings-page").visible());
        // Models on first use, as in Maka Desktop.
        assert_eq!(window.find("settings-title").label(), Some("Models"));
        assert_eq!(window.find("settings-nav").focused(), Some(true));
        // Keys reach the section list; a second press keeps the section
        // shown, the one it remembers.
        window.press("up", cx);
        window.press("secondary-,", cx);
    });
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("settings-title").label(), Some("Workspace"));
        window.press("escape", cx);
    });
    wait_for_the_focus_return(&harness, cx);
    harness.with_window(cx, |window, cx| {
        assert!(window.try_find("settings-page").is_none());
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "back to the draft");
        window.press("secondary-,", cx);
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("settings-title").label(), Some("Workspace"), "the last shown");
    });
}

#[gpui_kit::test]
fn the_footer_settings_button_opens_settings(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("footer-settings").label(), Some("Settings"));
        window.click("footer-settings", cx);
    });
    harness.with_window(cx, |window, _| {
        assert!(window.find("settings-page").visible());
        assert_eq!(window.find("settings-title").label(), Some("Models"));
    });
}

/// Settings take the sidebar's column and the plate, inside the same window
/// chrome; Back to app shows the task, the draft, and the transcript's view
/// as they were, with focus where it was.
#[gpui_kit::test]
fn settings_take_the_sidebars_place_and_back_to_app_restores_the_task(cx: &mut TestAppContext) {
    let harness = Harness::open(
        vec![
            session("s1", "Alpha", "/work/a", "active"),
            session("s2", "Beta", "/work/b", "active"),
        ],
        cx,
    );
    let draft = harness.draft_id(cx);
    let conversation =
        harness.workbench.read_with(cx, |workbench, _| workbench.conversation().entity_id());
    harness.with_window(cx, |window, cx| {
        window.click(shared::domain_element_id("session-row", "s2"), cx);
    });
    let plate = harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input("half a thought", cx);
        window.press("secondary-,", cx);
        window.find("main-pane").bounds()
    });
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("sidebar-column").is_none(), "the sidebar gives way");
        assert!(window.find("settings-column").visible());
        assert!(window.find("sidebar-chrome").visible(), "the traffic lights' strip stays");
        assert!(window.try_find("session-list").is_none());
        assert!(window.try_find(draft.clone()).is_none(), "the composer gives way");
        assert_eq!(window.find("main-pane").bounds(), plate, "the plate keeps its place");
        let page = window.find("settings-page").bounds();
        assert!(plate.contains(&page.origin), "the page is on the plate");
        assert!(window.try_find("session-title").is_none(), "the page has the title");
        assert_eq!(window.find("settings-nav").focused(), Some(true));
    });
    harness.with_window(cx, |window, cx| window.click("settings-back", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("settings-page").is_none());
        assert!(window.find("sidebar-column").visible());
        let row = window.find(shared::domain_element_id("session-row", "s2"));
        assert_eq!(row.selected(), Some(true), "the same task");
        assert_eq!(window.find("session-title").label(), Some("Beta"));
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "focus is back in the draft");
    });
    assert_eq!(harness.draft(cx), "half a thought", "the draft survives the round trip");
    assert_eq!(
        harness.workbench.read_with(cx, |workbench, _| workbench.conversation().entity_id()),
        conversation,
        "the same transcript view, with its own scroll position"
    );
}

/// What acts on the task view leaves settings first (a new task, the
/// composer, a task from the palette); what only makes sense beside it
/// (Send, the sidebar toggle, Back and Forward) waits.
#[gpui_kit::test]
fn task_commands_leave_settings_or_wait_for_them(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    let draft = harness.draft_id(cx);
    let open = |cx: &mut TestAppContext| {
        harness.workbench.read_with(cx, |workbench, _| workbench.settings_open())
    };
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input("not yet", cx);
        window.press("secondary-,", cx);
    });
    assert!(open(cx));
    harness.with_window(cx, |window, cx| {
        window.press("secondary-b", cx);
        window.press("secondary-enter", cx);
        window.press("secondary-[", cx);
    });
    assert!(open(cx), "they wait");
    assert!(harness.workbench.read_with(cx, |workbench, _| workbench.sidebar_visible()));
    assert!(harness.transport.sent().is_empty(), "the hidden draft is not sent");
    harness.with_window(cx, |window, cx| window.press("secondary-l", cx));
    assert!(!open(cx), "Focus composer leaves settings");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
    });
    harness.with_window(cx, |window, cx| window.press("secondary-,", cx));
    assert!(open(cx));
    harness.with_window(cx, |window, cx| window.press("secondary-n", cx));
    assert!(!open(cx), "New task leaves settings");
    assert!(harness.drafting(cx));
    assert_eq!(*harness.transport.creates.lock().expect("creates"), 0);
}

/// New task (⌘N) from a page shows the new task, and Back returns to the
/// page, not to the task that was behind it; Send waits while a page
/// hides the draft.
#[gpui_kit::test]
fn new_task_leaves_a_page_and_back_returns_to_it(cx: &mut TestAppContext) {
    use session::SidebarPage;
    use workspace::actions::{OpenExtensions, OpenScheduledTasks};
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(shared::domain_element_id("session-row", "s1"), cx);
    });
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input("not now", cx);
        window.dispatch_action(OpenExtensions.boxed_clone(), cx);
    });
    let page = |cx: &mut TestAppContext| harness.workbench.read_with(cx, |w, _| w.page());
    assert_eq!(page(cx), Some(SidebarPage::Extensions));
    harness.with_window(cx, |window, cx| window.press("secondary-enter", cx));
    assert!(harness.transport.sent().is_empty(), "the hidden draft is not sent");
    harness.with_window(cx, |window, cx| window.press("secondary-n", cx));
    assert!(harness.drafting(cx));
    assert_eq!(page(cx), None, "the new task shows");
    harness.with_window(cx, |window, cx| window.press("secondary-[", cx));
    assert_eq!(page(cx), Some(SidebarPage::Extensions), "Back returns to the page");
    // The sidebar's New task button leaves the page too.
    harness.with_window(cx, |window, cx| window.click("new-session", cx));
    assert!(harness.drafting(cx));
    assert_eq!(page(cx), None, "the button shows the new task");
    assert_eq!(*harness.transport.creates.lock().expect("creates"), 0, "nothing is created");
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
        let sidebar = harness.workbench.read(cx).sidebar().read(cx);
        assert_eq!(sidebar.open_page(), None, "no page entry stays selected");
    });
    // And the palette's New task, from the other page.
    harness
        .with_window(cx, |window, cx| window.dispatch_action(OpenScheduledTasks.boxed_clone(), cx));
    assert_eq!(page(cx), Some(SidebarPage::ScheduledTasks));
    harness.with_window(cx, |window, cx| window.press("cmd-k", cx));
    harness.with_window(cx, |window, cx| window.input("new task", cx));
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    assert_eq!(page(cx), None, "the palette's New task shows the task");
}

fn menu_item(key: &str) -> ElementId {
    shared::domain_element_id("menu-item", key)
}

/// The folder button before the title names where the task runs: a task's
/// project by name over its folder, or a task's folder when it is in no
/// project; a task in a root folder with no project has none, as in
/// Desktop. Open project folder opens the folder and Copy path copies it.
#[gpui_kit::test]
fn the_header_says_which_folder_the_task_runs_in(cx: &mut TestAppContext) {
    let harness = Harness::open(
        vec![
            session_in_project("s1", "Alpha", "/work/demo/app"),
            session("s2", "Beta", "/work/other", "active"),
            session("s3", "Gamma", "/", "active"),
        ],
        cx,
    );
    let opened = Rc::new(std::cell::RefCell::new(Vec::new()));
    harness.workbench.update(cx, |workbench, _| {
        let opened = opened.clone();
        workbench.set_folder_opener(move |path, _| opened.borrow_mut().push(path.to_owned()));
    });
    harness.with_window(cx, |window, cx| {
        let button = window.find("project-info");
        assert_eq!(button.label(), Some("Project information"));
        assert!(button.bounds().right() <= window.find("session-title").bounds().left());
        window.click("project-info", cx);
    });
    assert!(harness.workbench.read_with(cx, |workbench, _| workbench.project_menu_open()));
    harness.with_window(cx, |window, cx| {
        let mut menu = window.within("menu");
        assert_eq!(menu.find("menu-heading").label(), Some("Demo"), "the project's name");
        assert_eq!(menu.find("menu-heading-path").label(), Some("/work/demo/app"));
        let open = menu.find(menu_item("open-project-folder"));
        assert_eq!(open.label(), Some("Open project folder"));
        let copy = menu.find(menu_item("copy-project-path"));
        assert_eq!(copy.label(), Some("Copy path"));
        assert!(open.bounds().top() < copy.bounds().top());
        menu.click(menu_item("open-project-folder"), cx);
    });
    assert_eq!(*opened.borrow(), [PathBuf::from("/work/demo/app")]);
    assert!(!harness.workbench.read_with(cx, |workbench, _| workbench.project_menu_open()));
    harness.with_window(cx, |window, cx| window.click("project-info", cx));
    harness.with_window(cx, |window, cx| {
        window.within("menu").click(menu_item("copy-project-path"), cx);
    });
    let copied = cx.read_from_clipboard().and_then(|item| item.text());
    assert_eq!(copied.as_deref(), Some("/work/demo/app"));

    // A task in no project: its folder by name.
    harness.with_window(cx, |window, cx| {
        window.click(shared::domain_element_id("session-row", "s2"), cx);
    });
    harness.with_window(cx, |window, cx| window.click("project-info", cx));
    harness.with_window(cx, |window, cx| {
        let menu = window.within("menu");
        assert_eq!(menu.find("menu-heading").label(), Some("other"));
        assert_eq!(menu.find("menu-heading-path").label(), Some("/work/other"));
        assert!(menu.try_find(menu_item("open-project-folder")).is_some());
        window.press("escape", cx);
    });

    // A task in `/` and no project: no folder to name.
    harness.with_window(cx, |window, cx| {
        window.click(shared::domain_element_id("session-row", "s3"), cx);
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("session-title").label(), Some("Gamma"));
        assert!(window.try_find("project-info").is_none());
    });
}

/// `--open-project-menu` opens the same menu as a click on the folder
/// button, and nothing for a task that shows no button.
#[gpui_kit::test]
fn a_launch_can_open_the_project_menu(cx: &mut TestAppContext) {
    let harness = Harness::open(
        vec![
            session_in_project("s1", "Alpha", "/work/demo/app"),
            session("s3", "Gamma", "/", "active"),
        ],
        cx,
    );
    let opened = cx
        .update_window(harness.window.into(), |_, window, cx| {
            harness.workbench.update(cx, |workbench, cx| workbench.open_project_menu(window, cx))
        })
        .expect("window");
    assert!(opened);
    cx.run_until_parked();
    assert!(harness.workbench.read_with(cx, |workbench, _| workbench.project_menu_open()));
    harness.with_window(cx, |window, cx| {
        let menu = window.within("menu");
        assert_eq!(menu.find("menu-heading").label(), Some("Demo"));
        assert!(menu.try_find(menu_item("copy-project-path")).is_some());
        window.press("escape", cx);
    });
    assert!(!harness.workbench.read_with(cx, |workbench, _| workbench.project_menu_open()));

    harness.with_window(cx, |window, cx| {
        window.click(shared::domain_element_id("session-row", "s3"), cx);
    });
    let opened = cx
        .update_window(harness.window.into(), |_, window, cx| {
            harness.workbench.update(cx, |workbench, cx| workbench.open_project_menu(window, cx))
        })
        .expect("window");
    assert!(!opened, "a task in `/` has no folder button");
    assert!(!harness.workbench.read_with(cx, |workbench, _| workbench.project_menu_open()));
}

/// A remote Host's folders are not on this machine: the menu names the
/// project and its folder and copies the path, but offers no Open. A long
/// path wraps rather than widen the menu.
#[gpui_kit::test]
fn a_remote_hosts_task_offers_no_open_folder(cx: &mut TestAppContext) {
    let path = format!("/srv/{}demo", "a-rather-long-folder-name/".repeat(4));
    let transport =
        host_protocol::RemoteTransport::tls("wss://box.example.com/runtime-host").expect("tls");
    let profile = host_client::RemoteHostProfile::new("box", "Box", &"a".repeat(64), transport)
        .expect("profile");
    let credential = host_protocol::AccessCredential::new("mrha_x").expect("credential");
    let harness = Harness::on_host(
        ScriptedHost::new(vec![session_in_project("s1", "Alpha", &path)]),
        WindowHost::Remote(RemoteHost::new(profile, credential)),
        cx,
    );
    harness.with_window(cx, |window, cx| window.click("project-info", cx));
    harness.with_window(cx, |window, _| {
        let menu = window.within("menu");
        assert_eq!(menu.find("menu-heading").label(), Some("Demo"));
        let shown = menu.find("menu-heading-path");
        assert_eq!(shown.label(), Some(path.as_str()));
        assert!(shown.bounds().size.width <= px(320.), "{:?}", shown.bounds());
        assert!(shown.bounds().size.height >= px(40.), "wrapped: {:?}", shown.bounds());
        assert!(menu.try_find(menu_item("open-project-folder")).is_none());
        assert!(menu.try_find(menu_item("copy-project-path")).is_some());
    });
}
