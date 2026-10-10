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

//! UI integration tests: the production conversation view in a headless
//! window, fed by a scripted Host transport and by frames recorded from a
//! real Host (`crates/host-protocol/fixtures`) or built from the TS decoder
//! shapes.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::component::diff::DiffMode;
use gpui_kit::component::v_flex;
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AppContext as _, Context, ElementId, Entity, IntoElement, ParentElement as _, Pixels, Render,
    Styled as _, TestAppContext, Window, WindowHandle, px, size,
};
use host_client::{ConnectionEvent, HostEvent};
use host_protocol::{
    HostAccepted, HostFrame, MessageContent, MessagePlacement, Outcome, PushFrame,
};
use serde_json::{Value, json};
use transcript_model::{ItemKey, ToolStatus};
use workspace::{
    ConnectionCatalog, HostRequestError, HostSession, HostTransport, ProjectSelection,
};

use shared::copy::conversation as copy;

use crate::rows::{RowBody, RowKey, ToolNote, ToolRow};
use crate::{
    COMMIT_INTERVAL, Composer, ComposerAction, ConversationPhase, ConversationState,
    ConversationView, SendOutcome, TurnActivity, footer_element_id, item_element_id,
};

type Reply = Result<Value, HostRequestError>;

/// Answers each operation from a queue of scripted replies, in order, and
/// records every request. `subscription.ready` and `subscription.close`
/// succeed unless scripted. A reply may be held until the test releases it.
/// With no scripted reply, a responder the test set may answer.
#[derive(Default)]
struct ScriptedHost {
    replies: Mutex<HashMap<String, VecDeque<Scripted>>>,
    requests: Mutex<Vec<(String, Value)>>,
    responder: Mutex<Option<Responder>>,
}

/// Answers an operation's input, or leaves it to the defaults.
type Responder = Box<dyn FnMut(&str, &Value) -> Option<Reply> + Send>;

enum Scripted {
    Now(Reply),
    Held(async_channel::Receiver<Reply>),
}

impl ScriptedHost {
    fn reply(&self, operation: &str, reply: Reply) {
        self.push(operation, Scripted::Now(reply));
    }

    /// Scripts a reply that arrives when the returned sender sends it.
    fn hold(&self, operation: &str) -> async_channel::Sender<Reply> {
        let (sender, receiver) = async_channel::bounded(1);
        self.push(operation, Scripted::Held(receiver));
        sender
    }

    /// Answers what nothing scripted answers with `responder`.
    fn respond_with(&self, responder: impl FnMut(&str, &Value) -> Option<Reply> + Send + 'static) {
        *self.responder.lock().expect("responder") = Some(Box::new(responder));
    }

    fn push(&self, operation: &str, scripted: Scripted) {
        let mut replies = self.replies.lock().expect("replies");
        replies.entry(operation.to_owned()).or_default().push_back(scripted);
    }

    fn requests(&self, operation: &str) -> Vec<Value> {
        let requests = self.requests.lock().expect("requests");
        requests.iter().filter(|(op, _)| op == operation).map(|(_, input)| input.clone()).collect()
    }

    fn operations(&self) -> Vec<String> {
        self.requests.lock().expect("requests").iter().map(|(op, _)| op.clone()).collect()
    }
}

impl HostTransport for ScriptedHost {
    fn request(&self, operation: &'static str, input: Value, _: Duration) -> Boxed<Reply> {
        self.requests.lock().expect("requests").push((operation.to_owned(), input.clone()));
        let scripted =
            self.replies.lock().expect("replies").get_mut(operation).and_then(VecDeque::pop_front);
        let scripted = scripted.or_else(|| {
            let mut responder = self.responder.lock().expect("responder");
            responder.as_mut().and_then(|respond| respond(operation, &input)).map(Scripted::Now)
        });
        match scripted {
            Some(Scripted::Now(reply)) => Box::pin(async move { reply }),
            Some(Scripted::Held(receiver)) => Box::pin(async move {
                receiver.recv().await.unwrap_or(Err(HostRequestError::NotConnected))
            }),
            None if matches!(operation, "subscription.ready" | "subscription.close") => {
                let id = input["subscriptionId"].clone();
                Box::pin(async move { Ok(json!({"subscriptionId": id})) })
            }
            None => Box::pin(async move {
                Err(HostRequestError::Transport(format!("unscripted {operation}").into()))
            }),
        }
    }
}

fn accepted(host_epoch: &str) -> HostAccepted {
    serde_json::from_value(json!({
        "kind": "accepted", "rootId": "r", "hostEpoch": host_epoch, "connectionId": "c",
        "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
        "compositionRevision": "3", "state": "ready"
    }))
    .expect("accepted")
}

struct Harness {
    transport: Arc<ScriptedHost>,
    host: Entity<HostSession>,
    state: Entity<ConversationState>,
    view: Entity<ConversationView>,
    /// Present when the window stacks the composer under the transcript.
    composer: Option<Entity<Composer>>,
    window: WindowHandle<Root>,
}

/// The transcript above the composer, stacked as the shell stacks them.
struct Pane {
    view: Entity<ConversationView>,
    composer: Entity<Composer>,
}

impl Render for Pane {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        v_flex().size_full().child(self.view.clone()).child(self.composer.clone())
    }
}

impl Harness {
    fn open(transport: Arc<ScriptedHost>, host_epoch: &str, cx: &mut TestAppContext) -> Self {
        Self::build(transport, host_epoch, false, cx)
    }

    fn open_with_composer(
        transport: Arc<ScriptedHost>,
        host_epoch: &str,
        cx: &mut TestAppContext,
    ) -> Self {
        Self::build(transport, host_epoch, true, cx)
    }

    fn build(
        transport: Arc<ScriptedHost>,
        host_epoch: &str,
        with_composer: bool,
        cx: &mut TestAppContext,
    ) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
        });
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone())
        });
        host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Connection(ConnectionEvent::Connected {
                    accepted: accepted(host_epoch),
                }),
                cx,
            )
        });
        let state = cx.new(|cx| ConversationState::new(host.clone(), cx));
        let (mut view, mut composer) = (None, None);
        let window = cx.open_window(size(px(900.), px(800.)), |window, cx| {
            let conversation = cx.new(|cx| ConversationView::new(state.clone(), cx));
            view = Some(conversation.clone());
            if !with_composer {
                return Root::new(conversation, window, cx);
            }
            let connections = cx.new(|cx| ConnectionCatalog::new(host.clone(), cx));
            let projects = cx.new(|cx| {
                let source = std::rc::Rc::new(workspace::UnavailableProjectCatalog);
                ProjectSelection::new(host.clone(), source, cx)
            });
            let draft =
                cx.new(|cx| Composer::new(state.clone(), connections, projects, window, cx));
            composer = Some(draft.clone());
            let pane = cx.new(|_| Pane { view: conversation, composer: draft });
            Root::new(pane, window, cx)
        });
        Self { transport, host, state, view: view.expect("view"), composer, window }
    }

    fn composer(&self) -> &Entity<Composer> {
        self.composer.as_ref().expect("a harness opened with the composer")
    }

    fn action(&self, cx: &mut TestAppContext) -> ComposerAction {
        self.composer().read_with(cx, |composer, cx| composer.action(cx))
    }

    fn select(&self, session_id: &str, cx: &mut TestAppContext) {
        let session_id = Some(session_id.to_owned().into());
        self.state.update(cx, |state, cx| state.select_session(session_id, cx));
        settle(cx);
    }

    fn push(&self, frame: PushFrame, cx: &mut TestAppContext) {
        self.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Push(frame), cx));
        cx.run_until_parked();
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut gpui_kit::Window, &mut gpui_kit::App) -> R,
    ) -> R {
        let result = cx
            .update_window(self.window.into(), |_, window, cx| {
                window.render_frame(cx);
                f(window, cx)
            })
            .expect("window");
        cx.run_until_parked();
        result
    }

    fn rows(&self, cx: &mut TestAppContext) -> Vec<RowBody> {
        self.view.read_with(cx, |view, _| view.rows().iter().map(|row| row.body.clone()).collect())
    }

    fn phase(&self, cx: &mut TestAppContext) -> ConversationPhase {
        self.state.read_with(cx, |state, _| state.phase().clone())
    }
}

/// Lets queued work run and every coalescing window close.
fn settle(cx: &mut TestAppContext) {
    cx.run_until_parked();
    cx.executor().advance_clock(COMMIT_INTERVAL * 2);
    cx.run_until_parked();
}

fn frame(value: Value) -> PushFrame {
    match HostFrame::decode(value).expect("frame") {
        HostFrame::Push(frame) => frame,
        other => panic!("not a push frame: {other:?}"),
    }
}

/// One line of a recorded sequence.
enum Line {
    Request { operation: String, input: Value },
    Response { operation: String, result: Value },
    Push(PushFrame),
}

fn lines(text: &str) -> Vec<Line> {
    text.lines()
        .map(|line| {
            let value: Value = serde_json::from_str(line).expect("line is JSON");
            if value.get("input").is_some() {
                return Line::Request {
                    operation: value["operation"].as_str().expect("operation").to_owned(),
                    input: value["input"].clone(),
                };
            }
            match HostFrame::decode(value).expect("host frame") {
                HostFrame::Response(response) => {
                    let Outcome::Ok(result) = response.outcome else { panic!("recorded failure") };
                    Line::Response { operation: response.operation, result }
                }
                HostFrame::Push(frame) => Line::Push(frame),
                HostFrame::Handshake(_) => panic!("handshake inside a sequence"),
            }
        })
        .collect()
}

/// Replays a recorded sequence: the recorded `subscription.open` and page
/// results answer this client's requests, and the recorded subscription
/// frames arrive in order. Returns the harness and the turn id.
fn replay(sequence: &str, cx: &mut TestAppContext) -> (Harness, String) {
    let lines = lines(sequence);
    let transport = Arc::new(ScriptedHost::default());
    let mut session_id = String::new();
    let mut turn_id = String::new();
    let mut host_epoch = String::new();
    for line in &lines {
        match line {
            Line::Request { operation, input } if operation == "turn.start" => {
                turn_id = input["turnId"].as_str().expect("turnId").to_owned();
            }
            Line::Response { operation, result } if operation == "subscription.open" => {
                session_id =
                    result["snapshot"]["session"]["sessionId"].as_str().expect("id").to_owned();
                host_epoch = result["hostEpoch"].as_str().expect("epoch").to_owned();
                transport.reply(operation, Ok(result.clone()));
            }
            Line::Response { operation, result } if operation == "session.transcript.page" => {
                transport.reply(operation, Ok(result.clone()));
            }
            _ => {}
        }
    }
    let harness = Harness::open(transport, &host_epoch, cx);
    harness.select(&session_id, cx);
    for line in lines {
        if let Line::Push(frame @ PushFrame::Subscription(_)) = line {
            harness.push(frame, cx);
        }
    }
    settle(cx);
    (harness, turn_id)
}

/// The page inputs a sequence recorded, in order.
fn recorded_page_inputs(sequence: &str) -> Vec<Value> {
    lines(sequence)
        .into_iter()
        .filter_map(|line| match line {
            Line::Request { operation, input } if operation == "session.transcript.page" => {
                Some(input)
            }
            _ => None,
        })
        .collect()
}

const STOP_AFTER_START: &str =
    include_str!("../../host-protocol/fixtures/sequences/stop_after_start.jsonl");
const FAILED_TURN: &str = include_str!("../../host-protocol/fixtures/sequences/failed_turn.jsonl");
const STOP_MID_STREAM: &str =
    include_str!("../../host-protocol/fixtures/sequences/stop_mid_stream.jsonl");
const PLAIN_TEXT: &str = include_str!("../../host-protocol/fixtures/sequences/plain_text.jsonl");
const OPEN_RESPONSE: &str =
    include_str!("../../host-protocol/fixtures/subscription_open.response.json");

fn footer_label(harness: &Harness, turn_id: &str, cx: &mut TestAppContext) -> Option<String> {
    harness.with_window(cx, |window, _| {
        window.within(footer_element_id(turn_id)).find("turn-status").label().map(str::to_owned)
    })
}

/// The outcome a turn's footer names first: its label is the outcome, then
/// when the turn started and its model.
fn footer_outcome(harness: &Harness, turn_id: &str, cx: &mut TestAppContext) -> Option<String> {
    footer_label(harness, turn_id, cx)
        .map(|label| label.split(copy::FOOTER_SEPARATOR.en()).next().unwrap_or_default().to_owned())
}

#[gpui_kit::test]
fn bootstrap_from_the_open_fixture_renders_its_turn(cx: &mut TestAppContext) {
    let response: Value = serde_json::from_str(OPEN_RESPONSE).expect("fixture");
    let open = response["result"].clone();
    let session_id = open["snapshot"]["session"]["sessionId"].as_str().expect("id").to_owned();
    let turn_id = open["snapshot"]["rootTurn"]["turnId"].as_str().expect("turn").to_owned();
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open.clone()));
    let harness = Harness::open(transport.clone(), open["hostEpoch"].as_str().expect("epoch"), cx);

    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("conversation-placeholder").label(),
            Some(copy::NO_SESSION_TITLE.en()),
            "nothing selected yet"
        );
    });
    harness.select(&session_id, cx);

    assert_eq!(harness.phase(cx), ConversationPhase::Live);
    assert_eq!(
        transport.requests("subscription.open"),
        [json!({"sessionId": session_id, "transcript": {"kind": "tail", "maxBytes": 16384}})]
    );
    assert_eq!(
        transport.requests("subscription.ready"),
        [json!({"subscriptionId": open["subscriptionId"]})],
        "ready follows the open, or the Host holds every frame"
    );
    assert_eq!(transport.operations()[..2], ["subscription.open", "subscription.ready"]);
    let rows = harness.rows(cx);
    assert!(
        matches!(&rows[0], RowBody::User { text, .. } if text.starts_with("Reply with exactly")),
        "{rows:?}"
    );
    assert!(matches!(rows.last(), Some(RowBody::Footer(_))), "{rows:?}");
    harness.with_window(cx, |window, _| {
        assert!(window.find(item_element_id(&turn_id, &ItemKey::User(turn_id.clone()))).visible());
    });
    assert_eq!(footer_outcome(&harness, &turn_id, cx).as_deref(), Some(copy::TURN_FINISHED.en()));
}

#[gpui_kit::test]
fn a_stopped_turn_replays_to_a_stopped_footer(cx: &mut TestAppContext) {
    let (harness, turn_id) = replay(STOP_AFTER_START, cx);
    assert_eq!(
        harness.transport.requests("session.transcript.page"),
        recorded_page_inputs(STOP_AFTER_START),
        "the same catch-up reads as the recorder"
    );
    harness.with_window(cx, |window, _| {
        assert!(window.find(item_element_id(&turn_id, &ItemKey::User(turn_id.clone()))).visible());
    });
    assert_eq!(footer_outcome(&harness, &turn_id, cx).as_deref(), Some(copy::TURN_CANCELLED.en()));
    harness.state.read_with(cx, |state, _| assert_eq!(state.turn_activity(), TurnActivity::Idle));
}

#[gpui_kit::test]
fn a_failed_turn_replays_to_a_failed_footer_with_the_reason(cx: &mut TestAppContext) {
    let (harness, turn_id) = replay(FAILED_TURN, cx);
    assert_eq!(
        harness.transport.requests("session.transcript.page"),
        recorded_page_inputs(FAILED_TURN)
    );
    let label = footer_label(&harness, &turn_id, cx).expect("label");
    assert!(label.starts_with("Failed: "), "{label}");
    assert!(label.contains("[redacted]"), "the Host's redacted reason is shown: {label}");
}

#[gpui_kit::test]
fn a_turn_stopped_mid_stream_keeps_its_tools_and_partial_text(cx: &mut TestAppContext) {
    let (harness, turn_id) = replay(STOP_MID_STREAM, cx);
    assert_eq!(
        harness.transport.requests("session.transcript.page"),
        recorded_page_inputs(STOP_MID_STREAM)
    );
    let rows = harness.rows(cx);
    let tools = rows.iter().filter(|row| matches!(row, RowBody::Tool(_))).count();
    assert_eq!(tools, 1, "{rows:?}");
    assert!(
        rows.iter().any(|row| matches!(row, RowBody::Text { text, .. } if text.starts_with("The"))),
        "{rows:?}"
    );
    assert_eq!(footer_outcome(&harness, &turn_id, cx).as_deref(), Some(copy::TURN_CANCELLED.en()));
}

#[gpui_kit::test]
fn a_plain_turn_replays_to_a_finished_footer(cx: &mut TestAppContext) {
    let (harness, turn_id) = replay(PLAIN_TEXT, cx);
    assert_eq!(
        harness.transport.requests("session.transcript.page"),
        recorded_page_inputs(PLAIN_TEXT)
    );
    assert_eq!(footer_outcome(&harness, &turn_id, cx).as_deref(), Some(copy::TURN_FINISHED.en()));
    let label = footer_label(&harness, &turn_id, cx).expect("label");
    // The outcome, the start time, and the model the reply's durable row
    // names. The time is relative to now ("2 hours ago", then "yesterday",
    // later a date), so only its presence is checked.
    let parts: Vec<&str> = label.split(copy::FOOTER_SEPARATOR.en()).collect();
    assert!(parts.len() == 3 && !parts[1].trim().is_empty(), "{label}");
    assert_eq!(parts[2], "qwen2.5:7b", "{label}");
}

// Synthetic frames, built from the shapes the TS decoders accept
// (`packages/runtime-host/src/protocol/session-continuity.ts`,
// `packages/core/src/interaction.ts`), as in transcript-model's
// `tests/synthetic.rs`. No real Host recording contains a prompt yet.

const EPOCH: &str = "epoch-1";
const SESSION: &str = "s1";
const SUBSCRIPTION: &str = "sub-1";
const TURN: &str = "t1";
const RUN: &str = "run-1";

fn snapshot(revision: u64, root: Value, pending: Vec<Value>) -> Value {
    json!({
        "schemaVersion": 5,
        "session": {"sessionId": SESSION, "metadataRevision": 1, "status": "running",
                    "createdAt": 1, "isArchived": false},
        "projectionRevision": revision,
        "rootTurn": root,
        "goal": null,
        "queue": {"hostEpoch": EPOCH, "queueRevision": 0, "steering": [], "followup": []},
        "interactions": {"pending": pending}
    })
}

fn open_result(subscription: &str) -> Value {
    open_result_for(SESSION, subscription)
}

fn open_result_for(session: &str, subscription: &str) -> Value {
    let mut snapshot = snapshot(1, Value::Null, vec![]);
    snapshot["session"]["sessionId"] = json!(session);
    json!({
        "hostEpoch": EPOCH,
        "subscriptionId": subscription,
        "nextSequence": 1,
        "snapshot": snapshot,
        "activeAssistantStreams": [],
        "transcript": {"durable": {
            "kind": "page", "sessionId": session, "direction": "older", "throughSequence": null,
            "rawBytes": 0, "fragments": [], "nextCursor": null, "endsAtTurnBoundary": true
        }}
    })
}

fn root(status: &str) -> Value {
    let mut root = json!({"sessionId": SESSION, "turnId": TURN, "runId": RUN, "status": status});
    if matches!(status, "completed" | "cancelled") {
        root["terminalEventId"] = json!("end");
    }
    root
}

fn page(through: u64, rows: &[(u64, Value)]) -> Value {
    let mut raw = 0;
    let fragments: Vec<Value> = rows
        .iter()
        .map(|(sequence, row)| {
            let bytes = serde_json::to_vec(row).expect("row");
            raw += bytes.len();
            json!({
                "sequence": sequence, "byteOffset": 0, "totalBytes": bytes.len(),
                "payloadDigest": null,
                "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
            })
        })
        .collect();
    json!({
        "kind": "page", "sessionId": SESSION, "direction": "newer", "throughSequence": through,
        "rawBytes": raw, "fragments": fragments, "nextCursor": null, "endsAtTurnBoundary": true
    })
}

/// Frames of one subscription with consecutive sequences.
struct Frames {
    sequence: u64,
    revision: u64,
}

impl Frames {
    fn new() -> Self {
        Self { sequence: 1, revision: 1 }
    }

    fn next(&mut self, kind: &str, fields: Value) -> PushFrame {
        let mut value = json!({
            "kind": kind, "hostEpoch": EPOCH, "subscriptionId": SUBSCRIPTION,
            "sequence": self.sequence
        });
        for (key, field) in fields.as_object().expect("object") {
            value[key] = field.clone();
        }
        self.sequence += 1;
        frame(value)
    }

    fn projection(&mut self, root: Value, pending: Vec<Value>) -> PushFrame {
        self.revision += 1;
        let snapshot = snapshot(self.revision, root, pending);
        self.next("subscription.session_projection", json!({"snapshot": snapshot}))
    }

    fn advanced(&mut self, through: u64) -> PushFrame {
        self.next(
            "subscription.transcript_advanced",
            json!({"sessionId": SESSION, "throughSequence": through}),
        )
    }

    fn event(&mut self, event: Value) -> PushFrame {
        self.next(
            "subscription.session_event",
            json!({"sessionId": SESSION, "runId": RUN, "event": event}),
        )
    }

    fn delta(&mut self, message: &str, start: u64, text: &str) -> PushFrame {
        self.next(
            "subscription.session_delta",
            json!({"sessionId": SESSION, "delta": {
                "kind": "text", "turnId": TURN, "runId": RUN, "messageId": message,
                "startOffset": start, "text": text
            }}),
        )
    }
}

fn permission_request() -> Value {
    json!({"kind": "permission", "toolUseId": "c1", "prompt": {
        "kind": "tool_permission", "toolName": "Bash", "category": "shell_unsafe",
        "reason": "shell_dangerous", "review": {"kind": "command", "command": "ls -la"},
        "rememberForTurnAllowed": true
    }})
}

/// `InteractionSandboxBoundaryRequest` (`packages/core/src/interaction.ts`).
fn sandbox_request() -> Value {
    json!({
        "kind": "sandbox_boundary",
        "expansion": {"filesystem": {"entries": [
            {"path": "/Users/me/Documents", "access": "read", "scope": "subtree"}
        ]}},
        "justification": "List the documents folder."
    })
}

fn interaction(request: Value, status: &str, outcome: Value) -> Value {
    json!({
        "schemaVersion": 1, "interactionId": "i1", "sessionId": SESSION, "turnId": TURN,
        "runId": RUN, "revision": if status == "pending" { 1 } else { 2 },
        "request": request, "status": status, "outcome": outcome
    })
}

/// Opens the synthetic session and brings its turn to `running`, with the
/// prompt row durable.
fn start_turn(cx: &mut TestAppContext) -> (Harness, Frames) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    let frames = run_turn(&harness, Frames::new(), cx);
    (harness, frames)
}

/// Brings the open synthetic session's turn to `running`, with the prompt
/// row durable.
fn run_turn(harness: &Harness, frames: Frames, cx: &mut TestAppContext) -> Frames {
    run_turn_sent_at(harness, frames, 10, cx)
}

/// [`run_turn`] with the prompt sent at `sent_at`, Host wall-clock
/// milliseconds.
fn run_turn_sent_at(
    harness: &Harness,
    mut frames: Frames,
    sent_at: u64,
    cx: &mut TestAppContext,
) -> Frames {
    let prompt = json!({"type": "user", "id": TURN, "turnId": TURN, "ts": sent_at,
                        "text": "List the files"});
    harness.transport.reply("session.transcript.page", Ok(page(23, &[(16, prompt)])));
    harness.push(frames.projection(root("admitted"), vec![]), cx);
    harness.push(frames.advanced(23), cx);
    harness.push(frames.projection(root("running"), vec![]), cx);
    settle(cx);
    frames
}

/// Raises `request` as a pending prompt after a Tool call.
fn raise_prompt(request: Value, cx: &mut TestAppContext) -> (Harness, Frames) {
    let (harness, mut frames) = start_turn(cx);
    harness.push(
        frames.event(json!({
            "type": "tool_start", "id": "e1", "turnId": TURN, "ts": 11, "toolUseId": "c1",
            "toolName": "Bash", "activityKind": "command", "argsPreview": {"command": "ls -la"},
            "stepId": "s1"
        })),
        cx,
    );
    let pending = interaction(request, "pending", Value::Null);
    harness.push(frames.projection(root("waiting_for_user"), vec![pending]), cx);
    settle(cx);
    (harness, frames)
}

fn prompt_id() -> ElementId {
    item_element_id(TURN, &ItemKey::Interaction("i1".into()))
}

/// A full key press. `press` sends only the key-down; a focused Button
/// activates on the key-up, as it does on a real keyboard.
fn press_and_release(window: &mut gpui_kit::Window, key: &str, cx: &mut gpui_kit::App) {
    window.press(key, cx);
    let keystroke = gpui_kit::Keystroke::parse(key).expect("keystroke");
    window.dispatch_event(gpui_kit::PlatformInput::KeyUp(gpui_kit::KeyUpEvent { keystroke }), cx);
    window.render_frame(cx);
}

/// Presses Tab until `id` inside `row` has focus, then asserts it has.
/// The window starts without focus (in the app it starts in the composer),
/// and Root's Tab binding needs a focused element, so focus enters at the
/// first Tab stop.
fn tab_to(window: &mut gpui_kit::Window, row: ElementId, id: &'static str, cx: &mut gpui_kit::App) {
    if window.focused(cx).is_none() {
        window.focus_next(cx);
        window.render_frame(cx);
    }
    for _ in 0..6 {
        if window.within(row.clone()).find(id).focused() == Some(true) {
            return;
        }
        window.press("tab", cx);
    }
    assert_eq!(window.within(row).find(id).focused(), Some(true), "Tab reaches {id}");
}

#[gpui_kit::test]
fn a_permission_prompt_answers_from_allow_and_never_from_escape(cx: &mut TestAppContext) {
    let (harness, _) = raise_prompt(permission_request(), cx);
    let answered = harness.transport.hold("interaction.answer");

    harness.with_window(cx, |window, cx| {
        let prompt = window.within(prompt_id());
        assert_eq!(prompt.find("prompt-title").label(), Some("Allow Bash?"));
        assert!(prompt.find("allow").visible());
        assert!(prompt.find("deny").visible());
        // The waiting words sit in the card beside the decision, not below it.
        assert_eq!(prompt.find("prompt-waiting").label(), Some(copy::TURN_WAITING.en()));
        assert!(window.within(footer_element_id(TURN)).try_find("turn-status").is_none());
        tab_to(window, prompt_id(), "allow", cx);
        press_and_release(window, "escape", cx);
    });
    assert!(harness.transport.requests("interaction.answer").is_empty(), "Escape never answers");

    harness.with_window(cx, |window, cx| window.within(prompt_id()).click("allow", cx));
    assert_eq!(
        harness.transport.requests("interaction.answer"),
        [json!({"sessionId": SESSION, "interactionId": "i1",
                "answer": {"kind": "permission", "decision": "allow", "rememberForTurn": false}})]
    );

    // In flight: neither button takes a second answer.
    harness.with_window(cx, |window, cx| {
        window.within(prompt_id()).click("allow", cx);
        window.within(prompt_id()).click("deny", cx);
    });
    assert_eq!(harness.transport.requests("interaction.answer").len(), 1, "no double submission");

    let snapshot = interaction(
        permission_request(),
        "answered",
        json!({"kind": "permission_answer", "reviewer": "user", "committedAt": 12,
               "decision": "allow", "rememberForTurn": false}),
    );
    answered.try_send(Ok(snapshot)).expect("release");
    settle(cx);
    harness.with_window(cx, |window, _| {
        let prompt = window.within(prompt_id());
        assert_eq!(prompt.find("prompt-outcome").label(), Some(copy::ALLOWED.en()));
        assert!(prompt.try_find("allow").is_none(), "an answered prompt has no buttons");
    });
}

#[gpui_kit::test]
fn the_keyboard_answers_a_prompt_with_enter_on_a_focused_button(cx: &mut TestAppContext) {
    let (harness, _) = raise_prompt(permission_request(), cx);
    harness.transport.hold("interaction.answer");
    harness.with_window(cx, |window, cx| {
        tab_to(window, prompt_id(), "deny", cx);
        press_and_release(window, "enter", cx);
    });
    assert_eq!(
        harness.transport.requests("interaction.answer")[0]["answer"],
        json!({"kind": "permission", "decision": "deny", "rememberForTurn": false})
    );
}

#[gpui_kit::test]
fn a_refused_answer_shows_inline_and_can_be_retried(cx: &mut TestAppContext) {
    let (harness, _) = raise_prompt(permission_request(), cx);
    harness.transport.reply(
        "interaction.answer",
        Err(HostRequestError::Operation {
            operation: "interaction.answer",
            code: host_protocol::HostOperationErrorCode::OperationConflict,
            message: "the prompt changed".into(),
        }),
    );
    harness.with_window(cx, |window, cx| window.within(prompt_id()).click("deny", cx));
    harness.with_window(cx, |window, _| {
        let label = window.within(prompt_id()).find("answer-error").label().map(str::to_owned);
        assert_eq!(label.as_deref(), Some("Couldn’t send the answer. The prompt changed."));
    });
    assert_eq!(
        harness.transport.requests("interaction.answer")[0]["answer"],
        json!({"kind": "permission", "decision": "deny", "rememberForTurn": false})
    );

    harness.transport.hold("interaction.answer");
    harness.with_window(cx, |window, cx| window.within(prompt_id()).click("allow", cx));
    assert_eq!(
        harness.transport.requests("interaction.answer").len(),
        2,
        "the prompt takes a retry"
    );
}

#[gpui_kit::test]
fn a_sandbox_boundary_prompt_lists_the_access_and_answers_it(cx: &mut TestAppContext) {
    let (harness, _) = raise_prompt(sandbox_request(), cx);
    let rows = harness.rows(cx);
    let grants = rows.iter().find_map(|row| match row {
        RowBody::Prompt(prompt) => match &prompt.body {
            crate::rows::PromptBody::SandboxBoundary { grants, .. } => {
                Some(grants.iter().map(|grant| grant.text.to_string()).collect::<Vec<_>>())
            }
            _ => None,
        },
        _ => None,
    });
    assert_eq!(
        grants.expect("a sandbox prompt row"),
        ["Read /Users/me/Documents and everything in it"]
    );
    harness.transport.reply(
        "interaction.answer",
        Ok(interaction(
            sandbox_request(),
            "answered",
            json!({"kind": "sandbox_boundary_decision", "decision": "allow", "status": "approved",
                   "committedAt": 12}),
        )),
    );
    harness.with_window(cx, |window, cx| {
        let prompt = window.within(prompt_id());
        assert_eq!(prompt.find("prompt-title").label(), Some(copy::SANDBOX_TITLE.en()));
        tab_to(window, prompt_id(), "allow", cx);
        press_and_release(window, "escape", cx);
    });
    assert!(harness.transport.requests("interaction.answer").is_empty(), "Escape never answers");

    harness.with_window(cx, |window, cx| window.within(prompt_id()).click("allow", cx));
    assert_eq!(
        harness.transport.requests("interaction.answer"),
        [json!({"sessionId": SESSION, "interactionId": "i1",
                "answer": {"kind": "sandbox_boundary", "decision": "allow"}})]
    );
    settle(cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.within(prompt_id()).find("prompt-outcome").label(),
            Some(copy::ALLOWED.en())
        );
    });
}

#[gpui_kit::test]
fn streamed_text_commits_at_most_every_interval(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    let text = |harness: &Harness, cx: &mut TestAppContext| {
        harness.rows(cx).into_iter().find_map(|row| match row {
            RowBody::Text { text, .. } => Some(text.to_string()),
            _ => None,
        })
    };

    // The first change after a quiet period commits at once.
    harness.push(frames.delta("m1", 0, "Hello"), cx);
    assert_eq!(text(&harness, cx).as_deref(), Some("Hello"));
    // Inside the window the transcript moves on; the view does not yet.
    harness.push(frames.delta("m1", 5, ", world"), cx);
    assert_eq!(text(&harness, cx).as_deref(), Some("Hello"));
    harness.state.read_with(cx, |state, _| {
        let turn = state.transcript().and_then(|t| t.turn(TURN)).expect("turn");
        assert!(format!("{:?}", turn.items).contains("Hello, world"), "applied at once");
    });
    cx.executor().advance_clock(COMMIT_INTERVAL);
    cx.run_until_parked();
    assert_eq!(text(&harness, cx).as_deref(), Some("Hello, world"));

    // A turn that ends commits without waiting.
    harness.push(frames.delta("m1", 12, "!"), cx);
    harness.push(frames.projection(root("completed"), vec![]), cx);
    assert_eq!(text(&harness, cx).as_deref(), Some("Hello, world!"));
}

#[gpui_kit::test]
fn a_tool_card_expands_from_the_keyboard(cx: &mut TestAppContext) {
    let (harness, _) = raise_prompt(permission_request(), cx);
    let tool = item_element_id(TURN, &ItemKey::Tool("c1".into()));
    let expanded = |harness: &Harness, cx: &mut TestAppContext| {
        harness.rows(cx).into_iter().find_map(|row| match row {
            RowBody::Tool(tool) => Some((tool.expanded, tool.input.map(|input| input.to_string()))),
            _ => None,
        })
    };
    assert_eq!(expanded(&harness, cx), Some((false, None)), "collapsed by default");
    harness.with_window(cx, |window, cx| {
        tab_to(window, tool.clone(), "tool-toggle", cx);
        press_and_release(window, "enter", cx);
    });
    let (open, input) = expanded(&harness, cx).expect("tool row");
    assert!(open);
    assert!(input.expect("input").contains("\"command\": \"ls -la\""));
}

#[gpui_kit::test]
fn another_session_closes_the_subscription_and_a_gap_reopens_it(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    let reopened = harness.transport.hold("subscription.open");

    // A frame out of sequence: the transcript cannot follow any more.
    frames.sequence += 1;
    harness.push(frames.projection(root("running"), vec![]), cx);
    settle(cx);
    assert_eq!(
        harness.transport.requests("subscription.close"),
        [json!({"subscriptionId": SUBSCRIPTION})]
    );
    assert_eq!(harness.transport.requests("subscription.open").len(), 2);
    assert_eq!(harness.phase(cx), ConversationPhase::Opening);
    harness.with_window(cx, |window, _| {
        assert!(window.find("conversation-status").visible(), "the reopen is announced");
        assert!(
            window.find(item_element_id(TURN, &ItemKey::User(TURN.into()))).visible(),
            "the last transcript stays visible meanwhile"
        );
    });

    reopened.try_send(Ok(open_result("sub-2"))).expect("release");
    settle(cx);
    assert_eq!(harness.phase(cx), ConversationPhase::Live);
    assert_eq!(
        harness.transport.requests("subscription.ready").last(),
        Some(&json!({"subscriptionId": "sub-2"}))
    );

    harness.transport.reply("subscription.open", Ok(open_result_for("s2", "sub-3")));
    harness.select("s2", cx);
    assert_eq!(
        harness.transport.requests("subscription.close").last(),
        Some(&json!({"subscriptionId": "sub-2"}))
    );
    assert_eq!(harness.phase(cx), ConversationPhase::Live);
    assert!(harness.rows(cx).is_empty(), "another session starts empty");
    harness.select("s2", cx);
    assert_eq!(harness.transport.requests("subscription.open").len(), 3, "reselecting is a no-op");
}

#[gpui_kit::test]
fn commands_follow_the_turn_state(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    harness
        .state
        .read_with(cx, |state, _| assert_eq!(state.turn_activity(), TurnActivity::Running));
    // A message sent while the turn runs waits for it: the Host queues it.
    harness.transport.reply(
        "turn.message.submit",
        Ok(json!({"disposition": "followup", "queueRevision": 1,
                  "skillInvocation": {"loaded": [], "failed": [], "receipts": []}})),
    );
    let queued = harness.state.update(cx, |state, cx| {
        state.send_message(SESSION, MessageContent::text("again"), MessagePlacement::NextTurn, cx)
    });
    assert_eq!(cx.foreground_executor().block_test(queued), Ok(SendOutcome::Followup));
    let submit = &harness.transport.requests("turn.message.submit")[0];
    assert_eq!(
        (&submit["originHostEpoch"], &submit["placement"], &submit["content"]),
        (&json!(EPOCH), &json!("next_turn"), &json!({"text": "again"}))
    );

    harness.transport.reply(
        "turn.stop",
        Ok(json!({"sessionId": SESSION, "turnId": TURN, "runId": RUN, "status": "cancelled",
                  "terminalEventId": "end", "abortSource": "renderer.stop_button"})),
    );
    let stopped = harness.state.update(cx, |state, cx| state.stop_turn(SESSION, cx));
    assert_eq!(cx.foreground_executor().block_test(stopped), Ok(()));
    assert_eq!(
        harness.transport.requests("turn.stop"),
        [json!({"sessionId": SESSION, "turnId": TURN, "runId": RUN})]
    );

    harness.push(frames.projection(root("cancelled"), vec![]), cx);
    settle(cx);
    harness.state.read_with(cx, |state, _| assert_eq!(state.turn_activity(), TurnActivity::Idle));
    harness.transport.reply(
        "turn.message.submit",
        Ok(json!({"disposition": "turn_started", "turnId": "t2",
                  "skillInvocation": {"loaded": [], "failed": [], "receipts": []}})),
    );
    let sent = harness.state.update(cx, |state, cx| {
        state.send_message(SESSION, MessageContent::text("next"), MessagePlacement::NextTurn, cx)
    });
    assert_eq!(cx.foreground_executor().block_test(sent), Ok(SendOutcome::Started));
    let submits = harness.transport.requests("turn.message.submit");
    assert_eq!(submits[1]["content"], json!({"text": "next"}));
    assert_ne!(submits[0]["messageId"], submits[1]["messageId"], "a fresh message id each time");
    harness.state.read_with(cx, |state, _| {
        assert_eq!(
            state.turn_activity(),
            TurnActivity::Starting,
            "started before a frame shows it; Stop needs its run"
        );
    });
}

#[gpui_kit::test]
fn a_question_prompt_sends_the_picked_option(cx: &mut TestAppContext) {
    let question = json!({"kind": "question", "toolUseId": "c1", "questions": [
        {"question": "Which folder?", "options": [{"label": "src"}, {"label": "docs"}]}
    ]});
    let (harness, _) = raise_prompt(question, cx);
    harness.transport.hold("interaction.answer");
    // Nothing is picked yet, so Answer does nothing.
    harness.with_window(cx, |window, cx| window.within(prompt_id()).click("answer", cx));
    assert!(harness.transport.requests("interaction.answer").is_empty());

    harness.with_window(cx, |window, cx| {
        window.within(prompt_id()).click("option-0-1", cx);
        window.within(prompt_id()).click("answer", cx);
    });
    assert_eq!(
        harness.transport.requests("interaction.answer"),
        [json!({"sessionId": SESSION, "interactionId": "i1",
                "answer": {"kind": "question", "answers": ["docs"]}})]
    );
}

#[gpui_kit::test]
fn a_session_that_cannot_open_says_why_once_and_offers_retry(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply(
        "subscription.open",
        Err(HostRequestError::Transport("the connection dropped".into())),
    );
    let harness = Harness::open(transport.clone(), EPOCH, cx);
    harness.select(SESSION, cx);
    settle(cx);
    assert!(matches!(harness.phase(cx), ConversationPhase::Failed(_)));
    harness.with_window(cx, |window, cx| {
        let pane = window.find("conversation-placeholder");
        let label = pane.label().expect("the failure is announced").to_owned();
        assert!(label.starts_with(copy::OPEN_FAILED.en()), "{label}");
        assert_eq!(
            label.matches(copy::OPEN_FAILED.en()).count(),
            1,
            "what failed is said once: {label}"
        );
        assert!(window.find("conversation-retry").visible());
        transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
        window.click("conversation-retry", cx);
    });
    settle(cx);
    assert_eq!(harness.phase(cx), ConversationPhase::Live);
}

#[gpui_kit::test]
fn a_finished_turn_copies_its_reply_from_the_footer(cx: &mut TestAppContext) {
    let harness = reply_of(2, cx);
    let copy_label = |harness: &Harness, cx: &mut TestAppContext| {
        harness.with_window(cx, |window, _| {
            window.within(footer_element_id(TURN)).find("copy-reply").label().map(str::to_owned)
        })
    };
    assert_eq!(copy_label(&harness, cx).as_deref(), Some(copy::COPY_REPLY.en()));
    harness.with_window(cx, |window, cx| {
        // Hidden until the line is hovered (or the button has keyboard focus).
        assert!(!window.within(footer_element_id(TURN)).find("copy-reply").visible());
        window.within(footer_element_id(TURN)).hover("turn-status", cx);
        window.within(footer_element_id(TURN)).click("copy-reply", cx)
    });
    let copied = cx.read_from_clipboard().and_then(|item| item.text());
    assert_eq!(
        copied.as_deref(),
        Some(
            "Paragraph 1 of a reply longer than the window.\n\nParagraph 2 of a reply longer than the window."
        )
    );
    assert_eq!(copy_label(&harness, cx).as_deref(), Some(copy::REPLY_COPIED.en()));
    cx.executor().advance_clock(Duration::from_secs(3));
    cx.run_until_parked();
    assert_eq!(
        copy_label(&harness, cx).as_deref(),
        Some(copy::COPY_REPLY.en()),
        "only for a moment"
    );
    // The keyboard reaches it, and focus shows it.
    harness.with_window(cx, |window, cx| {
        // The pointer leaves the line first, so only focus can show it.
        window.hover(item_element_id(TURN, &ItemKey::User(TURN.into())), cx);
        assert!(!window.within(footer_element_id(TURN)).find("copy-reply").visible());
        tab_to(window, footer_element_id(TURN), "copy-reply", cx);
        assert!(window.within(footer_element_id(TURN)).find("copy-reply").visible());
    });
}

#[gpui_kit::test]
fn a_running_turn_offers_nothing_to_copy(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    harness.push(frames.delta("m1", 0, "Half a repl"), cx);
    settle(cx);
    harness.with_window(cx, |window, _| {
        assert!(window.within(footer_element_id(TURN)).try_find("copy-reply").is_none());
    });
}

/// A finished turn whose reply is several windows tall.
fn long_reply(cx: &mut TestAppContext) -> Harness {
    reply_of(120, cx)
}

/// A finished turn whose reply has `paragraphs` paragraphs.
fn reply_of(paragraphs: usize, cx: &mut TestAppContext) -> Harness {
    let (harness, mut frames) = start_turn(cx);
    let text: String = (1..=paragraphs)
        .map(|n| format!("Paragraph {n} of a reply longer than the window.\n\n"))
        .collect();
    harness.push(frames.delta("m1", 0, &text), cx);
    harness.push(frames.projection(root("completed"), vec![]), cx);
    settle(cx);
    harness
}

/// Where the transcript's rows scroll to: the list's top line, and the height
/// one page moves. The region has a 1 px border around the list, and the
/// list pads its top by 0.5 rem (8 px here).
fn transcript_geometry(harness: &Harness, cx: &mut TestAppContext) -> (Pixels, Pixels) {
    let region =
        harness.with_window(cx, |window, _| window.find("conversation-transcript").bounds());
    let viewport_height = region.size.height - px(2.);
    (region.top() + px(1.) + px(8.), viewport_height * 0.875)
}

fn row_top(harness: &Harness, id: ElementId, cx: &mut TestAppContext) -> Pixels {
    harness.with_window(cx, |window, _| window.find(id).bounds().top())
}

fn following_tail(harness: &Harness, cx: &mut TestAppContext) -> bool {
    harness.view.read_with(cx, |view, cx| view.scroller().read(cx).is_following_tail())
}

fn assert_near(actual: Pixels, expected: Pixels, what: &str) {
    let gap = f32::from((actual - expected).abs());
    assert!(gap < 1., "{what}: {actual:?}, expected {expected:?}");
}

#[gpui_kit::test]
fn the_keyboard_pages_through_the_transcript_and_jumps_to_its_ends(cx: &mut TestAppContext) {
    let harness = long_reply(cx);
    let user = item_element_id(TURN, &ItemKey::User(TURN.into()));
    let reply = item_element_id(TURN, &ItemKey::Text("m1".into()));
    let footer = footer_element_id(TURN);
    let press = |harness: &Harness, key: &str, cx: &mut TestAppContext| {
        harness.with_window(cx, |window, cx| window.press(key, cx));
    };
    assert!(following_tail(&harness, cx), "a transcript opens at its latest output");
    let (top_line, page) = transcript_geometry(&harness, cx);

    // The window starts without focus; the transcript is its first Tab stop.
    harness.with_window(cx, |window, cx| {
        window.focus_next(cx);
        window.render_frame(cx);
        assert_eq!(window.find("conversation-transcript").focused(), Some(true));
    });

    press(&harness, "home", cx);
    assert!(!following_tail(&harness, cx), "Home stops following new output");
    assert_near(row_top(&harness, user.clone(), cx), top_line, "Home shows the first message");
    harness.with_window(cx, |window, _| assert!(window.try_find(footer.clone()).is_none()));

    // PageDown and PageUp move by a page even inside a reply taller than
    // the window.
    let reply_top = row_top(&harness, reply.clone(), cx);
    press(&harness, "pagedown", cx);
    assert_near(row_top(&harness, reply.clone(), cx), reply_top - page, "PageDown");
    press(&harness, "pagedown", cx);
    assert_near(row_top(&harness, reply.clone(), cx), reply_top - page * 2., "second PageDown");
    press(&harness, "pageup", cx);
    assert_near(row_top(&harness, reply.clone(), cx), reply_top - page, "PageUp");
    press(&harness, "pageup", cx);
    assert_near(row_top(&harness, user.clone(), cx), top_line, "PageUp back to the first message");

    press(&harness, "end", cx);
    assert!(following_tail(&harness, cx), "End follows new output again");
    harness.with_window(cx, |window, _| assert!(window.find(footer.clone()).visible()));

    // From the followed end, PageUp still moves up by a page.
    let reply_top = row_top(&harness, reply.clone(), cx);
    press(&harness, "pageup", cx);
    assert!(!following_tail(&harness, cx));
    assert_near(row_top(&harness, reply.clone(), cx), reply_top + page, "PageUp from the end");
}

#[gpui_kit::test]
fn scrolling_keys_need_the_transcript_to_have_focus(cx: &mut TestAppContext) {
    let harness = long_reply(cx);
    harness.with_window(cx, |window, cx| {
        assert!(window.focused(cx).is_none());
        window.press("home", cx);
    });
    assert!(following_tail(&harness, cx), "Home without focus on the transcript does nothing");
}

/// At the followed end, the top row can start exactly on the list's top
/// line. Scrolling that row to the top then changes nothing, the list is
/// still at the bottom and follows the tail again, and a page anchored on it
/// would be undone; PageUp has to scroll the row before it instead.
#[gpui_kit::test]
fn page_up_leaves_the_end_when_a_row_starts_on_the_top_line(cx: &mut TestAppContext) {
    let harness = reply_of(30, cx);
    let reply = item_element_id(TURN, &ItemKey::Text("m1".into()));
    let footer = footer_element_id(TURN);
    // Size the window so the reply and the footer fill the list exactly:
    // list padding (8 px) twice, the region's border (1 px) and margin
    // (4 px) on both sides, and the footer row's 12 px bottom spacing.
    let (reply_top, footer_bounds) = harness.with_window(cx, |window, _| {
        (window.find(reply.clone()).bounds().top(), window.find(footer.clone()).bounds())
    });
    let list_height =
        px(16.) + (footer_bounds.top() - reply_top) + footer_bounds.size.height + px(12.);
    cx.simulate_window_resize(harness.window.into(), size(px(900.), list_height + px(10.)));
    settle(cx);
    harness.with_window(cx, |window, cx| {
        window.focus_next(cx);
        window.press("end", cx);
    });
    let (top_line, _) = transcript_geometry(&harness, cx);
    assert!(following_tail(&harness, cx));
    assert_near(row_top(&harness, reply.clone(), cx), top_line, "the reply starts on the top line");

    // Less than a page lies above the reply, so PageUp reaches the start.
    let user = item_element_id(TURN, &ItemKey::User(TURN.into()));
    harness.with_window(cx, |window, cx| window.press("pageup", cx));
    assert!(!following_tail(&harness, cx), "PageUp left the end");
    assert_near(row_top(&harness, user, cx), top_line, "PageUp");
}

/// A user message stands 24 px off the reply that follows it; the blocks of
/// one reply sit 12 px apart (review round 1, S10).
#[gpui_kit::test]
fn a_user_message_stands_apart_from_its_reply(cx: &mut TestAppContext) {
    let harness = reply_of(1, cx);
    let user = item_element_id(TURN, &ItemKey::User(TURN.into()));
    let reply = item_element_id(TURN, &ItemKey::Text("m1".into()));
    let footer = footer_element_id(TURN);
    let (user, reply, footer) = harness.with_window(cx, |window, _| {
        (window.find(user).bounds(), window.find(reply).bounds(), window.find(footer).bounds())
    });
    assert_near(reply.top() - user.bottom(), px(24.), "user message to reply");
    assert_near(footer.top() - reply.bottom(), px(12.), "reply to its footer");
}

/// A running turn whose Bash call printed `lines` lines, the first one
/// longer than the column, and whose reply after it runs past the window;
/// the transcript shows its start, with the call open.
fn open_long_tool_output(lines: usize, cx: &mut TestAppContext) -> Harness {
    let (harness, mut frames) = start_turn(cx);
    harness.push(
        frames.event(json!({
            "type": "tool_start", "id": "e1", "turnId": TURN, "ts": 11, "toolUseId": "c1",
            "toolName": "Bash", "activityKind": "command", "argsPreview": {"command": "seq"},
            "stepId": "s1"
        })),
        cx,
    );
    let long_line = "x".repeat(400);
    let output: String = std::iter::once(long_line)
        .chain((2..=lines).map(|n| format!("line {n}")))
        .collect::<Vec<_>>()
        .join("\n");
    harness.push(
        frames.event(json!({
            "type": "tool_output_delta", "id": "o1", "turnId": TURN, "ts": 12,
            "toolUseId": "c1", "seq": 1, "stream": "stdout", "chunk": output,
            "redacted": false, "createdAt": 12
        })),
        cx,
    );
    let reply: String = (1..=30).map(|n| format!("Paragraph {n} after the call.\n\n")).collect();
    harness.push(frames.delta("m1", 0, &reply), cx);
    settle(cx);
    let tool = item_element_id(TURN, &ItemKey::Tool("c1".into()));
    harness.with_window(cx, |window, cx| {
        window.focus_next(cx);
        window.press("home", cx);
        window.within(tool).click("tool-toggle", cx);
    });
    settle(cx);
    harness
}

/// Turns the mouse wheel over an open Tool row's output; `dy` < 0 scrolls
/// toward its end.
fn wheel_over_output(harness: &Harness, dy: f32, cx: &mut TestAppContext) {
    let tool = item_element_id(TURN, &ItemKey::Tool("c1".into()));
    harness.with_window(cx, |window, cx| {
        let delta = gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(dy)));
        window.within(tool).scroll("tool-output", delta, cx);
        window.render_frame(cx);
    });
}

/// An open Tool row's output longer than its block scrolls under the wheel
/// while the transcript stays put, and hands the wheel to the transcript at
/// either end of the output (F15: it used to take no wheel input at all).
#[gpui_kit::test]
fn a_long_tool_output_scrolls_inside_the_transcript(cx: &mut TestAppContext) {
    let harness = open_long_tool_output(60, cx);
    let key = format!("{TURN}/c1");
    let scroll = harness.view.read_with(cx, |view, _| view.detail_scroll(&key)).expect("handle");
    let tool = item_element_id(TURN, &ItemKey::Tool("c1".into()));
    let block = harness
        .with_window(cx, |window, _| window.within(tool.clone()).find("tool-output").bounds());
    assert_near(block.size.height, px(276.), "256 px of text and the block's padding");
    let end = scroll.max_offset();
    assert_eq!(end.x, px(0.), "a long line wraps instead of scrolling sideways");
    assert!(end.y > px(900.), "sixty lines and the wrapped one overflow the block: {end:?}");
    let offset = || scroll.offset().y;
    let top = |harness: &Harness, cx: &mut TestAppContext| row_top(harness, tool.clone(), cx);
    let at_rest = top(&harness, cx);

    wheel_over_output(&harness, -100., cx);
    assert_eq!(offset(), px(-100.), "the output scrolls");
    assert_eq!(top(&harness, cx), at_rest, "the transcript stays put");

    wheel_over_output(&harness, -5000., cx);
    assert_eq!(offset(), -end.y, "the output stops at its end");
    assert_eq!(top(&harness, cx), at_rest, "the transcript still stays put");

    wheel_over_output(&harness, -100., cx);
    assert_eq!(offset(), -end.y);
    let moved = top(&harness, cx);
    assert_near(moved, at_rest - px(100.), "past its end the wheel scrolls the transcript");

    wheel_over_output(&harness, 100., cx);
    assert_eq!(offset(), -end.y + px(100.), "back up, the output scrolls first");
    assert_eq!(top(&harness, cx), moved);

    wheel_over_output(&harness, 5000., cx);
    assert_eq!(offset(), px(0.));
    assert_eq!(top(&harness, cx), moved);
    wheel_over_output(&harness, 40., cx);
    assert_eq!(offset(), px(0.));
    assert_near(top(&harness, cx), moved + px(40.), "past its start the transcript scrolls");
}

/// An output that fits its block passes the wheel straight to the
/// transcript.
#[gpui_kit::test]
fn a_short_tool_output_leaves_the_wheel_to_the_transcript(cx: &mut TestAppContext) {
    let harness = open_long_tool_output(3, cx);
    let tool = item_element_id(TURN, &ItemKey::Tool("c1".into()));
    let at_rest = row_top(&harness, tool.clone(), cx);
    wheel_over_output(&harness, -60., cx);
    assert_near(row_top(&harness, tool, cx), at_rest - px(60.), "the transcript scrolls");
}

/// A running turn whose Edit call `c1` returned `diff`, its reply after it
/// running past the window; the transcript shows its start, with the call
/// open.
fn open_file_diff(diff: &str, cx: &mut TestAppContext) -> Harness {
    let (harness, mut frames) = start_turn(cx);
    harness.push(
        frames.event(json!({
            "type": "tool_start", "id": "e1", "turnId": TURN, "ts": 11, "toolUseId": "c1",
            "toolName": "Edit", "activityKind": "edit",
            "argsPreview": {"file_path": "src/lib.rs"}, "stepId": "s1"
        })),
        cx,
    );
    harness.push(frames.event(finished("c1")), cx);
    // A live result carries no content; its durable row does.
    let rows = [
        (
            32,
            json!({"type": "assistant", "id": "s1", "turnId": TURN, "ts": 10, "text": "",
                   "modelId": "m"}),
        ),
        (
            40,
            json!({"type": "tool_call", "id": "c1", "turnId": TURN, "ts": 11, "toolName": "Edit",
                   "activityKind": "edit", "stepId": "s1", "origin": "provider",
                   "modelVisibility": "visible", "args": {"file_path": "src/lib.rs"}}),
        ),
        (
            48,
            json!({"type": "tool_result", "id": "r1", "turnId": TURN, "ts": 12, "toolUseId": "c1",
                   "isError": false, "durationMs": 4,
                   "content": {"kind": "file_diff", "paths": ["src/lib.rs"], "diff": diff}}),
        ),
    ];
    harness.transport.reply("session.transcript.page", Ok(page(48, &rows)));
    harness.push(frames.advanced(48), cx);
    settle(cx);
    let reply: String = (1..=30).map(|n| format!("Paragraph {n} after the call.\n\n")).collect();
    harness.push(frames.delta("m1", 0, &reply), cx);
    settle(cx);
    let tool = item_element_id(TURN, &ItemKey::Tool("c1".into()));
    harness.with_window(cx, |window, cx| {
        window.focus_next(cx);
        window.press("home", cx);
        window.within(tool).click("tool-toggle", cx);
    });
    settle(cx);
    harness
}

/// Two hunks of `src/lib.rs`: three lines added and two removed.
const TWO_HUNK_DIFF: &str = "--- a/src/lib.rs\n+++ b/src/lib.rs\n\
    @@ -1,4 +1,4 @@\n use std::fmt;\n-fn old() {}\n+fn new() {}\n fn keep() {}\n \n\
    @@ -20,3 +20,4 @@\n fn a() {}\n-fn b() {}\n+fn b(x: u8) {}\n+fn c() {}\n fn d() {}";

/// An Edit's `file_diff` shows in the kit's Diff, with its line numbers,
/// and the card's header keeps the counts.
#[gpui_kit::test]
fn a_file_diff_shows_in_the_kit_diff(cx: &mut TestAppContext) {
    let harness = open_file_diff(TWO_HUNK_DIFF, cx);
    let row = tool_row(&harness, "c1", cx);
    assert_eq!((row.added, row.removed), (3, 2));
    let key = format!("{TURN}/c1");
    let state = harness.view.read_with(cx, |view, _| view.card_diff(&key)).expect("a Diff");
    state.read_with(cx, |state, _| {
        let [file] = state.files() else { panic!("one file: {:?}", state.files().len()) };
        assert_eq!(file.path().as_ref(), "src/lib.rs");
        assert_eq!((file.additions(), file.deletions()), (3, 2));
        assert_eq!(state.mode(), DiffMode::Unified);
    });
    assert!(card_shows(&harness, "c1", "tool-diff", cx));
    assert!(!card_shows(&harness, "c1", "tool-output", cx), "no plain text");
    let tool = item_element_id(TURN, &ItemKey::Tool("c1".into()));
    harness.with_window(cx, |window, _| {
        // The second hunk's numbers start at line 20 on both sides.
        assert_eq!(window.find_all_by_label("Select Modified line 20").len(), 1);
        assert_eq!(window.find_all_by_label("Select Original line 21").len(), 1);
        let card = window.within(tool);
        // Ten rows: five context lines, numbered on both sides, two removed
        // lines numbered on the old side and three added on the new.
        assert_eq!(card.find_all("source").len(), 10, "one row per line of the two hunks");
        let numbers: usize = (0..8usize).map(|ix| card.find_all(("line", ix)).len()).sum();
        assert_eq!(numbers, 15);
    });
}

/// A `file_diff` the kit's parser rejects shows as plain text, as before.
#[gpui_kit::test]
fn a_malformed_file_diff_falls_back_to_text(cx: &mut TestAppContext) {
    let harness = open_file_diff("@@ -1,3 +1,3 @@\n-x", cx);
    let key = format!("{TURN}/c1");
    assert!(harness.view.read_with(cx, |view, _| view.card_diff(&key)).is_none());
    assert!(card_shows(&harness, "c1", "tool-output", cx), "the diff shows as text");
    assert!(!card_shows(&harness, "c1", "tool-diff", cx));
}

/// Turns the mouse wheel over an open card's diff; `dy` < 0 scrolls
/// toward its end.
fn wheel_over_diff(harness: &Harness, dy: f32, cx: &mut TestAppContext) {
    let tool = item_element_id(TURN, &ItemKey::Tool("c1".into()));
    harness.with_window(cx, |window, cx| {
        let delta = gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(dy)));
        window.within(tool).scroll("tool-diff", delta, cx);
        window.render_frame(cx);
    });
}

/// A diff longer than its block scrolls under the wheel while the
/// transcript stays put and hands the wheel on at either end, as a long
/// output does (F15). The Diff itself is as tall as its rows, so its own
/// list never takes the wheel: the last row ends at the Diff's bottom.
#[gpui_kit::test]
fn a_long_file_diff_scrolls_inside_the_transcript(cx: &mut TestAppContext) {
    let added: String = (1..=60).map(|n| format!("\n+line {n}")).collect();
    let harness =
        open_file_diff(&format!("--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,60 @@{added}"), cx);
    let key = format!("{TURN}/c1");
    let scroll = harness.view.read_with(cx, |view, _| view.detail_scroll(&key)).expect("handle");
    let tool = item_element_id(TURN, &ItemKey::Tool("c1".into()));
    let (block, body, last) = harness.with_window(cx, |window, _| {
        let card = window.within(tool.clone());
        let rows = card.find_all("source");
        assert_eq!(rows.len(), 60);
        let last = rows.last().expect("rows").bounds();
        (card.find("tool-diff").bounds(), card.find("diff-body").bounds(), last)
    });
    assert_near(block.size.height, px(276.), "the card's 256 px cap and its padding");
    assert_near(last.bottom(), body.bottom(), "the Diff is as tall as its rows");
    let end = scroll.max_offset().y;
    assert!(end > px(500.), "sixty rows overflow the block: {end:?}");
    let offset = || scroll.offset().y;
    let top = |harness: &Harness, cx: &mut TestAppContext| row_top(harness, tool.clone(), cx);
    let at_rest = top(&harness, cx);

    wheel_over_diff(&harness, -100., cx);
    assert_eq!(offset(), px(-100.), "the diff scrolls");
    assert_eq!(top(&harness, cx), at_rest, "the transcript stays put");

    wheel_over_diff(&harness, -5000., cx);
    assert_eq!(offset(), -end, "the diff stops at its end");
    assert_eq!(top(&harness, cx), at_rest);

    wheel_over_diff(&harness, -100., cx);
    assert_eq!(offset(), -end);
    let moved = top(&harness, cx);
    assert_near(moved, at_rest - px(100.), "past its end the wheel scrolls the transcript");

    wheel_over_diff(&harness, 5000., cx);
    assert_eq!(offset(), px(0.));
    wheel_over_diff(&harness, 40., cx);
    assert_near(top(&harness, cx), moved + px(40.), "past its start the transcript scrolls");
}

/// Past Desktop's 500 lines a diff is cut, still parses, and a note says
/// how many lines are left out.
#[gpui_kit::test]
fn a_diff_past_five_hundred_lines_is_cut_with_a_note(cx: &mut TestAppContext) {
    let added: String = (1..=600).map(|n| format!("\n+line {n}")).collect();
    let harness =
        open_file_diff(&format!("--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,600 @@{added}"), cx);
    let key = format!("{TURN}/c1");
    let state = harness.view.read_with(cx, |view, _| view.card_diff(&key)).expect("a Diff");
    // The header line and the hunk's lines up to the 500th.
    state.read_with(cx, |state, _| assert_eq!(state.files()[0].additions(), 497));
    assert!(card_shows(&harness, "c1", "tool-diff-hidden", cx));
    let row = tool_row(&harness, "c1", cx);
    assert_eq!(row.added, 600, "the header counts the whole diff");
    let diff = row.diff.expect("an open card's diff");
    assert_eq!(diff.hidden_lines, 103);
}

// Calls a code cell (`exec`) makes, in the shape a real Host gives them at
// epoch 197, with made-up content: each nested call is a row of its own,
// `<exec id>:nested:<uuid>` in the step `<exec id>:nested`. Live, the `exec`
// start carries no arguments, a `Read` start only its path (`shellRunRef`),
// and a result no content; the durable rows that hold them are announced
// once the turn ends.

const EXEC: &str = "call_e1";
const NESTED_READ: &str = "call_e1:nested:u1";
const NESTED_BASH: &str = "call_e1:nested:u2";
const SKILL_PATH: &str = "~/skills/demo/SKILL.md";

/// The Tool row of call `id`.
fn tool_row(harness: &Harness, id: &str, cx: &mut TestAppContext) -> ToolRow {
    harness.view.read_with(cx, |view, _| {
        view.rows()
            .iter()
            .find_map(|row| match (&row.key, &row.body) {
                (RowKey::Item { key: ItemKey::Tool(tool_id), .. }, RowBody::Tool(tool))
                    if tool_id == id =>
                {
                    Some(tool.clone())
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("no Tool row {id}"))
    })
}

/// Opens the card of call `id` with a click on its row.
fn open_tool(harness: &Harness, id: &str, cx: &mut TestAppContext) {
    let tool = item_element_id(TURN, &ItemKey::Tool(id.into()));
    harness.with_window(cx, |window, cx| window.within(tool).click("tool-toggle", cx));
    settle(cx);
}

/// Whether the open card of call `id` paints `element` (`tool-output` or
/// `tool-note`).
fn card_shows(harness: &Harness, id: &str, element: &'static str, cx: &mut TestAppContext) -> bool {
    let tool = item_element_id(TURN, &ItemKey::Tool(id.into()));
    harness.with_window(cx, |window, _| window.within(tool).try_find(element).is_some())
}

/// A `tool_start` as the Host sends it for a call inside the code cell.
fn nested_start(id: &str, tool_name: &str, extra: Value) -> Value {
    let mut start = json!({
        "type": "tool_start", "id": format!("{id}_call"), "turnId": TURN, "ts": 12,
        "toolUseId": id, "toolName": tool_name, "operationId": format!("op-{id}"),
        "stepId": format!("{EXEC}:nested")
    });
    for (key, value) in extra.as_object().expect("object") {
        start[key] = value.clone();
    }
    start
}

fn finished(id: &str) -> Value {
    json!({"type": "tool_result", "id": format!("{id}_response"), "turnId": TURN, "ts": 13,
           "toolUseId": id, "operationId": format!("op-{id}"), "status": "completed",
           "durationMs": 4})
}

/// A running turn whose code cell has read a file and run a silent
/// command, all finished.
fn run_code_cell(cx: &mut TestAppContext) -> (Harness, Frames) {
    let (harness, mut frames) = start_turn(cx);
    harness.push(
        frames.event(json!({
            "type": "tool_start", "id": "e_call", "turnId": TURN, "ts": 11, "toolUseId": EXEC,
            "toolName": "exec", "operationId": "op-exec", "stepId": "s1"
        })),
        cx,
    );
    let read = json!({"activityKind": "read", "shellRunRef": SKILL_PATH});
    harness.push(frames.event(nested_start(NESTED_READ, "Read", read)), cx);
    harness.push(frames.event(finished(NESTED_READ)), cx);
    let bash = json!({"activityKind": "command", "argsPreview": {"command": "true"}});
    harness.push(frames.event(nested_start(NESTED_BASH, "Bash", bash)), cx);
    harness.push(frames.event(finished(NESTED_BASH)), cx);
    harness.push(frames.event(finished(EXEC)), cx);
    settle(cx);
    (harness, frames)
}

/// The rows the Host announces once the code cell's turn ends.
fn code_cell_rows() -> Vec<(u64, Value)> {
    let nested = |mut row: Value| {
        row["stepId"] = json!(format!("{EXEC}:nested"));
        row["origin"] = json!("code_mode");
        row["modelVisibility"] = json!("hidden");
        row["parentToolCallId"] = json!(EXEC);
        row["parentOperationId"] = json!("op-exec");
        row
    };
    let file = json!({"content": "---\nname: demo\n---\n", "next": null, "offset": 0,
                      "returnedLines": 3, "totalLines": 3});
    let code = format!(
        "const skill = await tools.Read({{path: \"{SKILL_PATH}\"}});\n\
         await tools.Bash({{command: \"true\"}});\nreturn skill.content"
    );
    let silent = json!({"kind": "terminal", "cwd": "/w", "cmd": "true", "status": "succeeded",
                        "exitCode": 0, "output": {"mode": "pipes", "stdout": "", "stderr": "",
                        "stdoutTruncated": false, "stderrTruncated": false, "redacted": false}});
    let returned = json!({"ok": true,
                          "toolCalls": [{"index": 1, "name": "Read"}, {"index": 2, "name": "Bash"}],
                          "value": "---\nname: demo\n---\n"});
    vec![
        (
            32,
            json!({"type": "assistant", "id": "s1", "turnId": TURN, "ts": 10, "text": "",
                   "thinking": {"text": "Load the skill."}, "modelId": "m"}),
        ),
        (
            40,
            json!({"type": "tool_call", "id": EXEC, "turnId": TURN, "ts": 11, "toolName": "exec",
                   "stepId": "s1", "origin": "provider", "modelVisibility": "visible",
                   "args": {"code": code}}),
        ),
        (
            48,
            nested(json!({"type": "tool_call", "id": NESTED_READ, "turnId": TURN, "ts": 12,
                          "toolName": "Read", "activityKind": "read",
                          "args": {"path": SKILL_PATH}})),
        ),
        (
            56,
            nested(json!({"type": "tool_result", "id": "r-read", "turnId": TURN, "ts": 13,
                          "toolUseId": NESTED_READ, "isError": false, "durationMs": 4,
                          "content": {"kind": "json", "value": file}})),
        ),
        (
            64,
            nested(json!({"type": "tool_call", "id": NESTED_BASH, "turnId": TURN, "ts": 12,
                          "toolName": "Bash", "activityKind": "command",
                          "args": {"command": "true"}})),
        ),
        (
            72,
            nested(json!({"type": "tool_result", "id": "r-bash", "turnId": TURN, "ts": 13,
                          "toolUseId": NESTED_BASH, "isError": false, "durationMs": 4,
                          "content": silent})),
        ),
        (
            80,
            json!({"type": "tool_result", "id": "r-exec", "turnId": TURN, "ts": 14,
                   "toolUseId": EXEC, "isError": false, "durationMs": 9, "origin": "provider",
                   "modelVisibility": "visible",
                   "content": {"kind": "json", "value": returned}}),
        ),
        (
            96,
            json!({"type": "assistant", "id": "s2", "turnId": TURN, "ts": 15,
                   "text": "The skill is named demo.", "modelId": "m"}),
        ),
        (
            104,
            json!({"type": "turn_state", "id": "end", "turnId": TURN, "ts": 16,
                   "status": "completed"}),
        ),
    ]
}

/// A finished call inside a code cell says what it did while the turn
/// runs, and once the turn ends shows what it returned, as Maka Desktop
/// does (F20: a finished `exec` and its `Read` showed no summary, and their
/// open cards said "No output yet").
#[gpui_kit::test]
fn calls_inside_a_code_cell_show_their_summary_and_then_their_output(cx: &mut TestAppContext) {
    let (harness, mut frames) = run_code_cell(cx);
    let read = tool_row(&harness, NESTED_READ, cx);
    assert_eq!(
        (read.name.as_ref(), read.summary.as_deref(), read.status),
        ("Read", Some(SKILL_PATH), ToolStatus::Completed),
        "the Read names its file from the live start"
    );
    let exec = tool_row(&harness, EXEC, cx);
    assert_eq!((exec.summary, exec.status), (None, ToolStatus::Completed), "nothing to name yet");

    for id in [EXEC, NESTED_READ] {
        open_tool(&harness, id, cx);
    }
    let exec = tool_row(&harness, EXEC, cx);
    assert_eq!((exec.input, exec.output), (None, None));
    assert_eq!(exec.note, ToolNote::OutputAtTurnEnd, "finished, so not “no output yet”");
    assert!(card_shows(&harness, EXEC, "tool-note", cx));
    let read = tool_row(&harness, NESTED_READ, cx);
    assert!(read.input.expect("input").contains(SKILL_PATH));
    assert!(card_shows(&harness, NESTED_READ, "tool-output", cx));

    // The turn ends; its rows arrive with the arguments and results.
    harness.transport.reply("session.transcript.page", Ok(page(111, &code_cell_rows())));
    harness.push(frames.projection(root("completed"), vec![]), cx);
    harness.push(frames.advanced(111), cx);
    settle(cx);
    let exec = tool_row(&harness, EXEC, cx);
    let first_line = format!("const skill = await tools.Read({{path: \"{SKILL_PATH}\"}}); …");
    assert_eq!(exec.summary.as_deref(), Some(first_line.as_str()), "the script's first line");
    let output = exec.output.expect("exec output").to_string();
    assert!(output.starts_with("ok: true\ntoolCalls:\n  index: 1\n  name: Read\n"), "{output}");
    assert!(output.ends_with("value:\n  ---\n  name: demo\n  ---\n  "), "{output}");
    let read = tool_row(&harness, NESTED_READ, cx);
    assert_eq!(
        read.output.as_deref(),
        Some("---\nname: demo\n---\n\nnext: null\noffset: 0\nreturnedLines: 3\ntotalLines: 3"),
        "the file's text, then its paging, not escaped JSON"
    );
    assert!(card_shows(&harness, EXEC, "tool-output", cx));
    assert!(card_shows(&harness, NESTED_READ, "tool-output", cx));

    // A command that printed nothing says so, as Desktop's “No output”.
    open_tool(&harness, NESTED_BASH, cx);
    let bash = tool_row(&harness, NESTED_BASH, cx);
    assert_eq!((bash.input, bash.output, bash.note), (None, None, ToolNote::NoOutput));
    assert!(card_shows(&harness, NESTED_BASH, "tool-note", cx));
}

/// A call that runs and has produced nothing yet still says so.
#[gpui_kit::test]
fn a_running_call_with_nothing_yet_says_no_output_yet(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    harness.push(
        frames.event(json!({
            "type": "tool_start", "id": "e_call", "turnId": TURN, "ts": 11, "toolUseId": EXEC,
            "toolName": "exec", "operationId": "op-exec", "stepId": "s1"
        })),
        cx,
    );
    settle(cx);
    open_tool(&harness, EXEC, cx);
    let exec = tool_row(&harness, EXEC, cx);
    assert_eq!((exec.status, exec.input, exec.output), (ToolStatus::Running, None, None));
    assert_eq!(exec.note, ToolNote::NoOutputYet);
    assert!(card_shows(&harness, EXEC, "tool-note", cx));
}

// The composer, stacked under the transcript as the shell places it.

/// A `session.catalog.query` `get` answer for the synthetic session
/// (`decodeSessionCatalogProjection`).
fn catalog_session(model: &str, permission_mode: &str) -> Value {
    json!({"kind": "session", "session": {
        "id": SESSION, "revision": 1,
        "workspace": {"target": {"kind": "host_path", "path": "/w"}, "hostCwd": "/w"},
        "createdAt": 1, "activityAt": 2, "name": "Synthetic", "isFlagged": false,
        "isArchived": false, "labels": [], "labelsTruncated": false, "hasUnread": false,
        "status": "active", "backend": "ai-sdk", "llmConnectionId": null,
        "llmConnectionSlug": "env", "connectionLocked": false, "model": model,
        "permissionMode": permission_mode, "collaborationMode": "agent",
        "orchestrationMode": "default"
    }})
}

/// Opens the synthetic session, idle, with the composer under it.
fn open_composer(cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    transport.reply("session.catalog.query", Ok(catalog_session("glm-5.3", "ask")));
    let harness = Harness::open_with_composer(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness
}

fn fill(harness: &Harness, text: &str, cx: &mut TestAppContext) {
    let composer = harness.composer().clone();
    harness.with_window(cx, |window, cx| {
        composer.update(cx, |composer, cx| composer.fill(text, window, cx));
    });
}

#[gpui_kit::test]
fn the_round_button_sends_while_idle_and_stops_while_a_turn_runs(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    // Idle with an empty draft: Send, disabled, and no Stop beside it.
    // (This Kit release reports no disabled flag, so clicks prove it.)
    assert_eq!(
        harness.action(cx),
        ComposerAction::Send { enabled: false, busy: false, queues: false }
    );
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("send-message").label(), Some(copy::SEND.en()));
        assert!(window.try_find("stop-turn").is_none());
        window.click("send-message", cx);
    });
    assert!(harness.transport.requests("turn.message.submit").is_empty());
    fill(&harness, "hello", cx);
    assert_eq!(
        harness.action(cx),
        ComposerAction::Send { enabled: true, busy: false, queues: false }
    );

    // While a turn runs a draft is sent after it; an empty draft turns
    // the same button into Stop.
    let mut frames = run_turn(&harness, Frames::new(), cx);
    assert_eq!(
        harness.action(cx),
        ComposerAction::Send { enabled: true, busy: false, queues: true }
    );
    fill(&harness, "", cx);
    assert_eq!(harness.action(cx), ComposerAction::Stop { enabled: true, busy: false });
    let stopped = harness.transport.hold("turn.stop");
    harness.with_window(cx, |window, cx| {
        assert!(window.try_find("send-message").is_none(), "never Send and Stop together");
        assert_eq!(window.find("stop-turn").label(), Some(copy::STOP.en()));
        window.click("stop-turn", cx);
    });
    assert_eq!(
        harness.transport.requests("turn.stop"),
        [json!({"sessionId": SESSION, "turnId": TURN, "runId": RUN})]
    );
    // While the Host has not answered, Stop shows progress and takes no
    // second click.
    assert!(matches!(harness.action(cx), ComposerAction::Stop { enabled: false, busy: true }));
    harness.with_window(cx, |window, cx| window.click("stop-turn", cx));
    assert_eq!(harness.transport.requests("turn.stop").len(), 1);

    stopped
        .try_send(Ok(json!({"sessionId": SESSION, "turnId": TURN, "runId": RUN,
                            "status": "cancelled", "terminalEventId": "end",
                            "abortSource": "renderer.stop_button"})))
        .expect("answer");
    harness.push(frames.projection(root("cancelled"), vec![]), cx);
    settle(cx);
    // The turn ended: Send again, which starts a turn.
    fill(&harness, "hello", cx);
    assert_eq!(
        harness.action(cx),
        ComposerAction::Send { enabled: true, busy: false, queues: false }
    );
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("stop-turn").is_none());
        assert!(window.find("send-message").visible());
    });
}

#[gpui_kit::test]
fn send_shows_progress_until_the_host_admits_the_turn(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    let admitted = harness.transport.hold("turn.message.submit");
    fill(&harness, "hello", cx);
    harness.with_window(cx, |window, cx| window.click("send-message", cx));
    assert_eq!(
        harness.action(cx),
        ComposerAction::Send { enabled: false, busy: true, queues: false }
    );
    harness.with_window(cx, |window, cx| window.click("send-message", cx));
    assert_eq!(harness.transport.requests("turn.message.submit").len(), 1, "one send in flight");

    admitted
        .try_send(Ok(json!({"disposition": "turn_started", "turnId": TURN,
                            "skillInvocation": {"loaded": [], "failed": [], "receipts": []}})))
        .expect("admit");
    settle(cx);
    // Started, but no frame shows the turn yet: Stop has no run to name.
    assert_eq!(
        harness.action(cx),
        ComposerAction::Send { enabled: false, busy: true, queues: false }
    );
    let mut frames = Frames::new();
    harness.push(frames.projection(root("running"), vec![]), cx);
    settle(cx);
    assert_eq!(harness.action(cx), ComposerAction::Stop { enabled: true, busy: false });
    harness.with_window(cx, |window, _| assert!(window.find("stop-turn").visible()));
}

#[gpui_kit::test]
fn the_composer_shows_the_session_model_and_permission_mode(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    assert_eq!(
        harness.transport.requests("session.catalog.query"),
        [json!({"kind": "get", "sessionId": SESSION})]
    );
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("composer-model").label(), Some("Model: glm-5.3"));
        assert_eq!(window.find("composer-permission-mode").label(), Some("Permission mode: Auto"));
    });
    // Tab walks the draft, "+", the two pickers, then the round button
    // (enabled once there is text; a disabled button is no Tab stop).
    fill(&harness, "hello", cx);
    harness.with_window(cx, |window, cx| {
        for id in ["composer-attach", "composer-model", "composer-permission-mode", "send-message"]
        {
            window.press("tab", cx);
            assert_eq!(window.find(id).focused(), Some(true), "Tab reaches {id}");
        }
    });

    // No connection catalog could be read (the query is unscripted): the
    // model menu says so instead of listing nothing.
    harness.with_window(cx, |window, cx| {
        window.click("composer-model", cx);
        let menu = window.within("popup-menu");
        assert_eq!(menu.find(ElementId::Integer(0)).label(), Some(copy::MODELS_FAILED.en()));
        window.press("escape", cx);
    });
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("popup-menu").is_none(), "Escape closes the menu");
    });

    // A projection at a newer session revision reads the settings again.
    harness.transport.reply("session.catalog.query", Ok(catalog_session("qwen2.5:7b", "explore")));
    let mut frames = Frames::new();
    let mut newer = snapshot(2, Value::Null, vec![]);
    newer["session"]["metadataRevision"] = json!(2);
    harness.push(frames.next("subscription.session_projection", json!({"snapshot": newer})), cx);
    settle(cx);
    assert_eq!(harness.transport.requests("session.catalog.query").len(), 2);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("composer-model").label(), Some("Model: qwen2.5:7b"));
        assert_eq!(
            window.find("composer-permission-mode").label(),
            Some("Permission mode: Read only")
        );
    });
    // The same revision again reads nothing.
    let mut same = snapshot(3, Value::Null, vec![]);
    same["session"]["metadataRevision"] = json!(2);
    harness.push(frames.next("subscription.session_projection", json!({"snapshot": same})), cx);
    settle(cx);
    assert_eq!(harness.transport.requests("session.catalog.query").len(), 2);
}

#[gpui_kit::test]
fn without_settings_the_pickers_stay_hidden(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    // `session.catalog.query` is unscripted, so the read fails.
    let harness = Harness::open_with_composer(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("composer-model").is_none());
        assert!(window.try_find("composer-permission-mode").is_none());
        assert!(window.find("send-message").visible());
    });
}

#[gpui_kit::test]
fn fill_replaces_the_draft_and_focuses_it_without_sending(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    fill(&harness, "first", cx);
    fill(&harness, "Summarize this repository", cx);
    let draft = harness.composer().read_with(cx, |composer, _| composer.draft().clone());
    assert_eq!(draft.read_with(cx, |draft, _| draft.value()), "Summarize this repository");
    let draft_id = draft.entity_id();
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find(ElementId::from(("input", draft_id))).focused(), Some(true));
        // The caret is at the end: typing appends.
        window.input("!", cx);
    });
    assert_eq!(draft.read_with(cx, |draft, _| draft.value()), "Summarize this repository!");
    assert!(harness.transport.requests("turn.message.submit").is_empty(), "filling sends nothing");
}

mod attachments;
mod edits;
mod find;
mod history;
mod links;
mod pty;
mod queue;
mod reasoning;
mod reconnect;
mod settings;
mod side_chat;
mod syntax;
mod turn_start;
mod turn_status;
