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

//! The terminal owner against a scripted Host: the conversation state's
//! real subscription carries the output, the Host's answers follow the
//! shapes of the recorded `terminal.jsonl` sequence.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conversation::ConversationState;
use futures_lite::future::Boxed;
use gpui_kit::{AppContext as _, Entity, TestAppContext};
use host_client::{ConnectionEvent, HostEvent};
use host_protocol::{HostAccepted, HostFrame, HostOperationErrorCode, PushFrame};
use serde_json::{Value, json};
use workspace::{HostRequestError, HostSession, HostTransport};

use crate::hydration::MAX_PENDING_CHUNKS;
use crate::terminal::{RESYNC_DELAY, RESYNC_SETTLE};
use crate::{
    CloseState, Inventory, StartState, Terminal, TerminalPhase, Terminals, TerminalsShown,
};

pub(crate) type Reply = Result<Value, HostRequestError>;

pub(crate) const EPOCH: &str = "epoch-1";
pub(crate) const SESSION: &str = "s1";
pub(crate) const OTHER: &str = "s2";

pub(crate) fn reference(name: &str) -> String {
    format!("maka://runtime/background-tasks/{name}")
}

pub(crate) enum Scripted {
    Now(Reply),
    Held(async_channel::Receiver<Reply>),
}

/// A Host whose answers a test scripts per operation, in order, with
/// defaults for the rest: subscriptions open as `sub-1`, `sub-2`, …; lists
/// answer the task's inventory; controls, releases and stops succeed; an
/// acquire answers an empty screen.
#[derive(Default)]
pub(crate) struct ScriptedHost {
    replies: Mutex<HashMap<String, VecDeque<Scripted>>>,
    requests: Mutex<Vec<(String, Value)>>,
    inventories: Mutex<HashMap<String, Vec<Value>>>,
    /// The subscription last opened and the sequence of its next frame.
    subscription: Mutex<(String, u64)>,
    opens: Mutex<u32>,
}

impl ScriptedHost {
    pub(crate) fn reply(&self, operation: &str, reply: Reply) {
        self.push(operation, Scripted::Now(reply));
    }

    pub(crate) fn hold(&self, operation: &str) -> async_channel::Sender<Reply> {
        let (sender, receiver) = async_channel::bounded(1);
        self.push(operation, Scripted::Held(receiver));
        sender
    }

    pub(crate) fn push(&self, operation: &str, scripted: Scripted) {
        let mut replies = self.replies.lock().expect("replies");
        replies.entry(operation.to_owned()).or_default().push_back(scripted);
    }

    pub(crate) fn requests(&self, operation: &str) -> Vec<Value> {
        let requests = self.requests.lock().expect("requests");
        requests.iter().filter(|(op, _)| op == operation).map(|(_, input)| input.clone()).collect()
    }

    /// The terminal operations asked for, in order.
    pub(crate) fn terminal_operations(&self) -> Vec<String> {
        let requests = self.requests.lock().expect("requests");
        requests
            .iter()
            .filter_map(|(op, input)| match op.as_str() {
                "runtime.resource.query" => {
                    Some(format!("query {}", input["kind"].as_str().unwrap_or("")))
                }
                "subscription.pty_interest.set" => Some(op.clone()),
                op if op.starts_with("runtime.resource.") => {
                    Some(op.trim_start_matches("runtime.resource.").to_owned())
                }
                _ => None,
            })
            .collect()
    }

    pub(crate) fn set_inventory(&self, session: &str, resources: Vec<Value>) {
        self.inventories.lock().expect("inventories").insert(session.to_owned(), resources);
    }

    fn default_reply(&self, operation: &str, input: &Value) -> Reply {
        match operation {
            "subscription.open" => {
                let mut opens = self.opens.lock().expect("opens");
                *opens += 1;
                let subscription = format!("sub-{opens}");
                *self.subscription.lock().expect("subscription") = (subscription.clone(), 1);
                let session = input["sessionId"].as_str().expect("session");
                Ok(open_result(session, &subscription))
            }
            "subscription.ready" | "subscription.close" | "subscription.pty_interest.set" => {
                Ok(json!({"subscriptionId": input["subscriptionId"]}))
            }
            "runtime.resource.query" if input["kind"] == "list_start" => {
                let session = input["sessionId"].as_str().expect("session");
                let resources = self
                    .inventories
                    .lock()
                    .expect("inventories")
                    .get(session)
                    .cloned()
                    .unwrap_or_default();
                Ok(json!({"kind": "page", "sessionId": session, "revision": "sha256:00",
                          "resources": resources, "nextCursor": null}))
            }
            "runtime.resource.controller.acquire" => {
                Ok(acquire_result(&input["controllerId"], 1, 0, "", 80, 24))
            }
            "runtime.resource.controller.control" => {
                Ok(json!({"controllerId": input["controllerId"], "sequence": input["sequence"]}))
            }
            "runtime.resource.controller.release" => {
                Ok(json!({"controllerId": input["controllerId"], "released": true}))
            }
            "runtime.resource.stop" => Ok(json!({})),
            _ => Err(HostRequestError::Transport(format!("unscripted {operation}").into())),
        }
    }
}

impl HostTransport for ScriptedHost {
    fn request(&self, operation: &'static str, input: Value, _: Duration) -> Boxed<Reply> {
        self.requests.lock().expect("requests").push((operation.to_owned(), input.clone()));
        let scripted =
            self.replies.lock().expect("replies").get_mut(operation).and_then(VecDeque::pop_front);
        match scripted {
            Some(Scripted::Now(reply)) => Box::pin(async move { reply }),
            Some(Scripted::Held(receiver)) => Box::pin(async move {
                receiver.recv().await.unwrap_or(Err(HostRequestError::NotConnected))
            }),
            None => {
                let reply = self.default_reply(operation, &input);
                Box::pin(async move { reply })
            }
        }
    }
}

pub(crate) fn open_result(session: &str, subscription: &str) -> Value {
    json!({
        "hostEpoch": EPOCH,
        "subscriptionId": subscription,
        "nextSequence": 1,
        "snapshot": {
            "schemaVersion": 5,
            "session": {"sessionId": session, "metadataRevision": 1, "status": "active",
                        "createdAt": 1, "isArchived": false},
            "projectionRevision": 1,
            "rootTurn": null,
            "goal": null,
            "queue": {"hostEpoch": EPOCH, "queueRevision": 0, "steering": [], "followup": []},
            "interactions": {"pending": []}
        },
        "activeAssistantStreams": [],
        "transcript": {"durable": {
            "kind": "page", "sessionId": session, "direction": "older", "throughSequence": null,
            "rawBytes": 0, "fragments": [], "nextCursor": null, "endsAtTurnBoundary": true
        }}
    })
}

pub(crate) fn acquire_result(
    controller: &Value,
    next_sequence: u64,
    sequence: u64,
    buffer: &str,
    cols: u16,
    rows: u16,
) -> Value {
    json!({
        "controllerId": controller, "nextSequence": next_sequence,
        "pty": {"sessionId": SESSION, "ref": reference("r1"), "sequence": sequence,
                "buffer": buffer, "size": {"cols": cols, "rows": rows}}
    })
}

/// A resource as `runtime.resource.query` lists it.
pub(crate) fn resource(session: &str, name: &str, status: &str, launch: &str, mode: &str) -> Value {
    let mut state = json!({
        "kind": "shell_run", "ref": reference(name), "mode": mode, "status": status,
        "cwd": "/w", "cmd": "exec \"$SHELL\" -l", "startedAt": 1, "updatedAt": 2, "revision": 2
    });
    match status {
        "completed" => {
            state["completedAt"] = json!(3);
            state["exitCode"] = json!(0);
        }
        "cancelled" => {
            state["completedAt"] = json!(3);
            state["exitCode"] = json!(130);
        }
        "orphaned" => state["failureMessage"] = json!("the Host restarted"),
        _ => {}
    }
    json!({
        "sessionId": session, "ownership": {"kind": "local"},
        "sourceTurnId": launch, "sourceToolCallId": launch, "result": state
    })
}

pub(crate) fn terminal_resource(session: &str, name: &str, status: &str) -> Value {
    resource(session, name, status, &format!("desktop-terminal-{name}"), "pty")
}

/// A one-page answer to `list_start`.
pub(crate) fn page(session: &str, resources: Vec<Value>) -> Value {
    json!({"kind": "page", "sessionId": session, "revision": "sha256:00",
           "resources": resources, "nextCursor": null})
}

pub(crate) fn get_result(session: &str, resource: Option<Value>) -> Reply {
    Ok(json!({"kind": "resource", "sessionId": session, "revision": "sha256:01",
              "resource": resource}))
}

pub(crate) fn accepted() -> HostAccepted {
    serde_json::from_value(json!({
        "kind": "accepted", "rootId": "r", "hostEpoch": EPOCH, "connectionId": "c",
        "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
        "compositionRevision": "3", "state": "ready"
    }))
    .expect("accepted")
}

pub(crate) fn operation_error(code: HostOperationErrorCode, message: &str) -> Reply {
    Err(HostRequestError::Operation { operation: "op", code, message: message.into() })
}

/// Lets queued work run and every timer (the conversation's commit window,
/// the terminal's batch window) pass.
pub(crate) fn settle(cx: &mut TestAppContext) {
    cx.run_until_parked();
    cx.executor().advance_clock(Duration::from_millis(300));
    cx.run_until_parked();
}

pub(crate) struct Harness {
    pub(crate) transport: Arc<ScriptedHost>,
    pub(crate) host: Entity<HostSession>,
    pub(crate) conversation: Entity<ConversationState>,
    pub(crate) terminals: Entity<Terminals>,
}

impl Harness {
    /// A window on `SESSION`, whose terminals are `inventory`.
    pub(crate) fn new(inventory: Vec<Value>, cx: &mut TestAppContext) -> Self {
        let transport = Arc::new(ScriptedHost::default());
        transport.set_inventory(SESSION, inventory);
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone())
        });
        let conversation = cx.new(|cx| ConversationState::new(host.clone(), cx));
        let terminals = cx.new(|cx| Terminals::new(host.clone(), conversation.clone(), cx));
        let harness = Self { transport, host, conversation, terminals };
        harness.connect(cx);
        harness.select(SESSION, cx);
        harness
    }

    pub(crate) fn connect(&self, cx: &mut TestAppContext) {
        self.feed(ConnectionEvent::Connected { accepted: accepted() }, cx);
    }

    pub(crate) fn feed(&self, event: ConnectionEvent, cx: &mut TestAppContext) {
        self.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Connection(event), cx));
        settle(cx);
    }

    pub(crate) fn select(&self, session: &str, cx: &mut TestAppContext) {
        let session = Some(session.to_owned().into());
        self.conversation.update(cx, |state, cx| state.select_session(session, cx));
        settle(cx);
    }

    pub(crate) fn show(&self, cx: &mut TestAppContext) {
        self.terminals.update(cx, |terminals, cx| terminals.set_shown(TerminalsShown::Face, cx));
        settle(cx);
    }

    pub(crate) fn terminal(&self, index: usize, cx: &mut TestAppContext) -> Entity<Terminal> {
        self.terminals.read_with(cx, |terminals, _| terminals.terminals()[index].clone())
    }

    pub(crate) fn count(&self, cx: &mut TestAppContext) -> usize {
        self.terminals.read_with(cx, |terminals, _| terminals.terminals().len())
    }

    pub(crate) fn start_state(&self, cx: &mut TestAppContext) -> StartState {
        self.terminals.read_with(cx, |terminals, _| terminals.start_state().clone())
    }

    pub(crate) fn phase(
        &self,
        terminal: &Entity<Terminal>,
        cx: &mut TestAppContext,
    ) -> TerminalPhase {
        terminal.read_with(cx, |terminal, _| terminal.phase().clone())
    }

    pub(crate) fn text(&self, terminal: &Entity<Terminal>, cx: &mut TestAppContext) -> String {
        terminal.read_with(cx, |terminal, _| terminal.content().text())
    }

    pub(crate) fn push(&self, value: Value, cx: &mut TestAppContext) {
        self.push_now(value, cx);
        settle(cx);
    }

    /// [`Self::push`] with no time passing: what the frame sets off runs,
    /// and no timer fires.
    pub(crate) fn push_now(&self, value: Value, cx: &mut TestAppContext) {
        let HostFrame::Push(frame @ PushFrame::Subscription(_)) =
            HostFrame::decode(value).expect("frame")
        else {
            panic!("not a subscription frame");
        };
        self.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Push(frame), cx));
        cx.run_until_parked();
    }

    /// A PTY data frame of `name` on the current subscription.
    pub(crate) fn pty_frame(&self, name: &str, sequence: u64, data: &str, reset: bool) -> Value {
        let mut frame = json!({
            "kind": "subscription.runtime_resource_pty_data", "hostEpoch": EPOCH,
            "subscriptionId": self.subscription(), "sessionId": SESSION,
            "ref": reference(name), "ptySequence": sequence, "data": data
        });
        if reset {
            frame["reset"] = json!(true);
        }
        frame
    }

    pub(crate) fn subscription(&self) -> String {
        self.transport.subscription.lock().expect("subscription").0.clone()
    }

    /// Output of `name` with `sequence` on the current subscription.
    pub(crate) fn output(&self, name: &str, sequence: u64, data: &str, cx: &mut TestAppContext) {
        self.push(self.pty_frame(name, sequence, data, false), cx);
    }

    pub(crate) fn output_reset(&self, name: &str, sequence: u64, cx: &mut TestAppContext) {
        self.push(self.pty_frame(name, sequence, "", true), cx);
    }

    /// A `runtime_resource` domain change naming `(source session, name)`s,
    /// on `SESSION`'s subscription.
    pub(crate) fn changed(&self, changes: &[(&str, &str)], cx: &mut TestAppContext) {
        self.changed_in(SESSION, changes, cx);
    }

    /// The same on the subscription of `subscribed`, the selected task.
    pub(crate) fn changed_in(
        &self,
        subscribed: &str,
        changes: &[(&str, &str)],
        cx: &mut TestAppContext,
    ) {
        let sequence = {
            let mut subscription = self.transport.subscription.lock().expect("subscription");
            subscription.1 += 1;
            subscription.1 - 1
        };
        let resources: Vec<Value> = changes
            .iter()
            .map(|(source, name)| json!({"sourceSessionId": source, "ref": reference(name)}))
            .collect();
        self.push(
            json!({
                "kind": "subscription.session_domain_changed", "hostEpoch": EPOCH,
                "subscriptionId": self.subscription(), "sequence": sequence,
                "sessionId": subscribed, "domain": "runtime_resource", "resources": resources
            }),
            cx,
        );
    }

    pub(crate) fn controls(&self) -> Vec<(u64, Value)> {
        self.transport
            .requests("runtime.resource.controller.control")
            .into_iter()
            .map(|input| (input["sequence"].as_u64().expect("sequence"), input["control"].clone()))
            .collect()
    }

    pub(crate) fn last_interest(&self) -> Value {
        self.transport
            .requests("subscription.pty_interest.set")
            .last()
            .map(|input| input["refs"].clone())
            .unwrap_or(Value::Null)
    }
}

#[gpui_kit::test]
fn interest_is_set_before_the_acquire_and_the_snapshot_replays_at_its_size(
    cx: &mut TestAppContext,
) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    let terminal = harness.terminal(0, cx);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Detached);
    assert!(harness.transport.requests("runtime.resource.controller.acquire").is_empty());
    terminal.update(cx, |terminal, cx| terminal.set_grid(100, 30, cx));

    let acquire = harness.transport.hold("runtime.resource.controller.acquire");
    harness.show(cx);
    assert_eq!(
        harness.transport.terminal_operations(),
        ["query list_start", "subscription.pty_interest.set", "controller.acquire"]
    );
    assert_eq!(harness.last_interest(), json!([reference("r1")]));
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Attaching);

    // Output that arrives while the acquire is in flight waits for it; what
    // the snapshot already holds is dropped.
    harness.output("r1", 2, "old", cx);
    harness.output("r1", 4, "y", cx);
    harness.output("r1", 3, "x", cx);
    let controller =
        harness.transport.requests("runtime.resource.controller.acquire")[0]["controllerId"]
            .clone();
    // The snapshot was written for 80 columns: its 90-character line
    // reflows onto one row at 100.
    let buffer = format!("{}\r\n$ ", "a".repeat(90));
    acquire.try_send(Ok(acquire_result(&controller, 5, 2, &buffer, 80, 24))).expect("acquire");
    settle(cx);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
    let text = harness.text(&terminal, cx);
    assert!(text.starts_with(&format!("{}\n$ xy", "a".repeat(90))), "{text:?}");
    // One resize, numbered from the acquire's nextSequence.
    assert_eq!(harness.controls(), [(5, json!({"kind": "resize", "cols": 100, "rows": 30}))]);

    harness.output("r1", 4, "y", cx);
    harness.output("r1", 5, "z", cx);
    assert!(harness.text(&terminal, cx).contains("$ xyz"));

    // One control in flight; what is typed meanwhile goes in the next.
    let control = harness.transport.hold("runtime.resource.controller.control");
    terminal.update(cx, |terminal, cx| terminal.input("e", cx));
    settle(cx);
    terminal.update(cx, |terminal, cx| terminal.input("c", cx));
    terminal.update(cx, |terminal, cx| terminal.input("ho\r", cx));
    settle(cx);
    assert_eq!(harness.controls().len(), 2);
    control.try_send(Ok(json!({"controllerId": controller, "sequence": 6}))).expect("control");
    settle(cx);
    assert_eq!(
        harness.controls()[1..],
        [
            (6, json!({"kind": "input", "input": "e"})),
            (7, json!({"kind": "input", "input": "cho\r"})),
        ]
    );
}

#[gpui_kit::test]
fn a_gap_and_a_reset_frame_each_acquire_again(cx: &mut TestAppContext) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.show(cx);
    let terminal = harness.terminal(0, cx);
    harness.output("r1", 1, "a", cx);
    assert_eq!(harness.transport.requests("runtime.resource.controller.acquire").len(), 1);

    // Chunk 2 never came: the picture cannot be trusted past it.
    harness.output("r1", 3, "c", cx);
    let acquires = harness.transport.requests("runtime.resource.controller.acquire");
    assert_eq!(acquires.len(), 2);
    assert_eq!(acquires[0]["controllerId"], acquires[1]["controllerId"], "one id per resource");

    harness.output_reset("r1", 4, cx);
    assert_eq!(harness.transport.requests("runtime.resource.controller.acquire").len(), 3);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
}

#[gpui_kit::test]
fn breaks_in_the_output_acquire_once_per_burst_and_back_off_until_an_attach_settles(
    cx: &mut TestAppContext,
) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.show(cx);
    let terminal = harness.terminal(0, cx);
    let acquires =
        |harness: &Harness| harness.transport.requests("runtime.resource.controller.acquire").len();
    let wait = |cx: &mut TestAppContext, millis: u64| {
        cx.executor().advance_clock(Duration::from_millis(millis));
        cx.run_until_parked();
    };
    let controller =
        harness.transport.requests("runtime.resource.controller.acquire")[0]["controllerId"]
            .clone();
    let answer = |held: &async_channel::Sender<Reply>, sequence: u64| {
        let snapshot = acquire_result(&controller, 1, sequence, "", 80, 24);
        held.try_send(Ok(snapshot)).expect("acquire");
    };
    assert_eq!(acquires(&harness), 1);

    // A burst of reset frames, as the Host sends under heavy output: one
    // acquire, after the first wait.
    let mut held = harness.transport.hold("runtime.resource.controller.acquire");
    for sequence in 1..=20 {
        harness.push_now(harness.pty_frame("r1", sequence, "", true), cx);
    }
    wait(cx, RESYNC_DELAY.as_millis() as u64 - 1);
    assert_eq!(acquires(&harness), 1, "it waits");
    wait(cx, 1);
    assert_eq!(acquires(&harness), 2, "one for the whole burst");

    // More output than can wait for the snapshot on its way: that snapshot
    // is no good, and the next acquire waits twice as long.
    let backlog = 21..=(21 + MAX_PENDING_CHUNKS as u64);
    for sequence in backlog {
        harness.push_now(harness.pty_frame("r1", sequence, "y", false), cx);
    }
    answer(&held, 20);
    cx.run_until_parked();
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Attaching);
    held = harness.transport.hold("runtime.resource.controller.acquire");
    wait(cx, 199);
    assert_eq!(acquires(&harness), 2);
    wait(cx, 1);
    assert_eq!(acquires(&harness), 3);

    // Each attach breaks again at once: the wait doubles, up to a second.
    let mut sequence = 200;
    for delay in [400, 800, 1000, 1000] {
        answer(&held, sequence);
        cx.run_until_parked();
        assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
        held = harness.transport.hold("runtime.resource.controller.acquire");
        sequence += 1;
        harness.push_now(harness.pty_frame("r1", sequence, "", true), cx);
        let before = acquires(&harness);
        wait(cx, delay - 1);
        assert_eq!(acquires(&harness), before, "waits {delay} ms");
        wait(cx, 1);
        assert_eq!(acquires(&harness), before + 1);
    }

    // An attach that holds settles: the next break waits the first wait.
    answer(&held, sequence);
    cx.run_until_parked();
    wait(cx, RESYNC_SETTLE.as_millis() as u64);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
    harness.push_now(harness.pty_frame("r1", sequence + 1, "", true), cx);
    let before = acquires(&harness);
    wait(cx, RESYNC_DELAY.as_millis() as u64);
    assert_eq!(acquires(&harness), before + 1);
    assert_eq!(before + 1, 8, "eight acquires for 25 resets and a backlog");
}

#[gpui_kit::test]
fn a_controller_held_elsewhere_is_its_own_state(cx: &mut TestAppContext) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.transport.reply(
        "runtime.resource.controller.acquire",
        operation_error(
            HostOperationErrorCode::OperationConflict,
            "Runtime Resource already has a connected controller",
        ),
    );
    harness.show(cx);
    let terminal = harness.terminal(0, cx);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::HeldElsewhere);
    assert_eq!(harness.last_interest(), json!([]), "no output without the seat");
    terminal.update(cx, |terminal, cx| terminal.input("ls\r", cx));
    settle(cx);
    assert!(harness.controls().is_empty());

    terminal.update(cx, |terminal, cx| terminal.retry(cx));
    settle(cx);
    assert_eq!(harness.transport.requests("runtime.resource.controller.acquire").len(), 2);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
}

#[gpui_kit::test]
fn a_state_read_answering_before_the_acquire_leaves_the_attach_to_it(cx: &mut TestAppContext) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    let acquire = harness.transport.hold("runtime.resource.controller.acquire");
    harness.show(cx);
    let terminal = harness.terminal(0, cx);
    // As the Host publishes it: the start's move to running comes after
    // the start's answer, so it can be read while the acquire is out.
    harness.transport.reply(
        "runtime.resource.query",
        get_result(SESSION, Some(terminal_resource(SESSION, "r1", "running"))),
    );
    harness.changed(&[(SESSION, "r1")], cx);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Attaching);
    assert_eq!(harness.last_interest(), json!([reference("r1")]), "the interest stays");

    let controller =
        harness.transport.requests("runtime.resource.controller.acquire")[0]["controllerId"]
            .clone();
    acquire.try_send(Ok(acquire_result(&controller, 1, 0, "$ ", 80, 24))).expect("acquire");
    settle(cx);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
    assert_eq!(harness.last_interest(), json!([reference("r1")]));
    harness.output("r1", 1, "ok", cx);
    assert!(harness.text(&terminal, cx).starts_with("$ ok"), "the output streams in");
    assert_eq!(harness.transport.requests("runtime.resource.controller.acquire").len(), 1);
}

#[gpui_kit::test]
fn an_acquire_answering_after_the_attach_gave_up_lets_the_seat_go(cx: &mut TestAppContext) {
    let harness = Harness::new(
        vec![
            terminal_resource(SESSION, "r1", "running"),
            terminal_resource(SESSION, "r2", "running"),
        ],
        cx,
    );
    let acquire = harness.transport.hold("runtime.resource.controller.acquire");
    harness.show(cx);
    let first = harness.terminal(0, cx);
    let second = harness.terminal(1, cx);
    assert_eq!(harness.phase(&second, cx), TerminalPhase::Live);
    // The interest without r2 cannot be set: r1, still attaching, fails.
    harness
        .transport
        .reply("subscription.pty_interest.set", Err(HostRequestError::Transport("refused".into())));
    harness.terminals.update(cx, |terminals, cx| terminals.close(&second, cx));
    settle(cx);
    assert!(matches!(harness.phase(&first, cx), TerminalPhase::Failed(_)));

    let controller =
        harness.transport.requests("runtime.resource.controller.acquire")[0]["controllerId"]
            .clone();
    acquire.try_send(Ok(acquire_result(&controller, 1, 0, "$ ", 80, 24))).expect("acquire");
    settle(cx);
    assert!(matches!(harness.phase(&first, cx), TerminalPhase::Failed(_)), "Retry still offered");
    let released = harness.transport.requests("runtime.resource.controller.release");
    assert_eq!(released.len(), 1, "the seat it got is let go");
    assert_eq!(released[0]["controllerId"], controller);
}

#[gpui_kit::test]
fn a_state_read_failing_after_a_failed_acquire_fails_the_attach_with_retry(
    cx: &mut TestAppContext,
) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.transport.reply(
        "runtime.resource.controller.acquire",
        operation_error(
            HostOperationErrorCode::OperationConflict,
            "Only an active PTY Runtime Resource can be controlled",
        ),
    );
    // The read that follows to tell why times out.
    harness.transport.reply(
        "runtime.resource.query",
        Err(HostRequestError::Transport("the request timed out".into())),
    );
    harness.show(cx);
    let terminal = harness.terminal(0, cx);
    let phase = harness.phase(&terminal, cx);
    assert!(
        matches!(&phase, TerminalPhase::Failed(message) if message.contains("timed out")),
        "{phase:?}"
    );
    assert_eq!(harness.last_interest(), json!([]));

    terminal.update(cx, |terminal, cx| terminal.retry(cx));
    settle(cx);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
    assert_eq!(harness.last_interest(), json!([reference("r1")]));
    assert_eq!(harness.transport.requests("runtime.resource.controller.acquire").len(), 2);
}

#[gpui_kit::test]
fn a_reconnect_mid_control_drops_it_and_attaches_with_the_new_sequence(cx: &mut TestAppContext) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.show(cx);
    let terminal = harness.terminal(0, cx);
    let held = harness.transport.hold("runtime.resource.controller.control");
    terminal.update(cx, |terminal, cx| terminal.input("ls\r", cx));
    settle(cx);
    terminal.update(cx, |terminal, cx| terminal.input("queued", cx));
    settle(cx);
    assert_eq!(harness.controls(), [(1, json!({"kind": "input", "input": "ls\r"}))]);

    harness.feed(ConnectionEvent::Disconnected { reason: "gone".into() }, cx);
    harness.transport.reply(
        "runtime.resource.controller.acquire",
        Ok(acquire_result(&json!("c"), 41, 9, "$ ", 80, 24)),
    );
    harness.connect(cx);
    held.try_send(Ok(json!({}))).ok();
    settle(cx);

    let acquires = harness.transport.requests("runtime.resource.controller.acquire");
    assert_eq!(acquires.len(), 2);
    assert_ne!(acquires[0]["controllerId"], acquires[1]["controllerId"], "a new controller");
    let interest = harness.transport.requests("subscription.pty_interest.set");
    assert_eq!(interest.last().expect("interest")["subscriptionId"], "sub-2");
    assert_eq!(harness.last_interest(), json!([reference("r1")]));
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
    terminal.update(cx, |terminal, cx| terminal.input("pwd\r", cx));
    settle(cx);
    // Neither the control in flight nor the queued input went again, and
    // the new controller counts from its own nextSequence.
    assert_eq!(
        harness.controls(),
        [
            (1, json!({"kind": "input", "input": "ls\r"})),
            (41, json!({"kind": "input", "input": "pwd\r"})),
        ]
    );
    let controls = harness.transport.requests("runtime.resource.controller.control");
    assert_eq!(controls[1]["controllerId"], acquires[1]["controllerId"]);
}

#[gpui_kit::test]
fn changes_of_other_resources_read_nothing_and_a_burst_of_ours_reads_twice(
    cx: &mut TestAppContext,
) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.show(cx);
    let gets = |harness: &Harness| {
        let queries = harness.transport.requests("runtime.resource.query");
        queries.into_iter().filter(|input| input["kind"] == "get").count()
    };
    // Every Session view hears every change: another task's, the agent's run.
    harness.changed(&[(OTHER, "r1"), (SESSION, "agent-run")], cx);
    assert_eq!(gets(&harness), 0);

    let first = harness.transport.hold("runtime.resource.query");
    harness.changed(&[(SESSION, "r1")], cx);
    harness.changed(&[(SESSION, "r1")], cx);
    harness.changed(&[(SESSION, "r1")], cx);
    assert_eq!(gets(&harness), 1, "one read in flight");
    let running = terminal_resource(SESSION, "r1", "running");
    harness.transport.reply("runtime.resource.query", get_result(SESSION, Some(running.clone())));
    first.try_send(get_result(SESSION, Some(running))).expect("get");
    settle(cx);
    assert_eq!(gets(&harness), 2, "and one more for the changes meanwhile");
}

#[gpui_kit::test]
fn an_exit_seen_through_a_domain_change_keeps_the_picture(cx: &mut TestAppContext) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.transport.reply(
        "runtime.resource.controller.acquire",
        Ok(acquire_result(&json!("c"), 1, 3, "hello\r\n$ exit", 80, 24)),
    );
    harness.show(cx);
    let terminal = harness.terminal(0, cx);
    harness.transport.reply(
        "runtime.resource.query",
        get_result(SESSION, Some(terminal_resource(SESSION, "r1", "completed"))),
    );
    harness.changed(&[(SESSION, "r1")], cx);
    assert_eq!(
        harness.phase(&terminal, cx),
        TerminalPhase::Exited { exit_code: Some(0), failure_message: None }
    );
    assert!(harness.text(&terminal, cx).starts_with("hello\n$ exit"));
    assert_eq!(harness.last_interest(), json!([]));
    terminal.update(cx, |terminal, cx| terminal.input("ls\r", cx));
    settle(cx);
    assert!(harness.controls().is_empty(), "nothing goes to an ended shell");
    assert_eq!(harness.count(cx), 1, "it stays until closed");
}

#[gpui_kit::test]
fn a_close_is_confirmed_by_an_exit_before_the_stop_answers_or_by_not_found(
    cx: &mut TestAppContext,
) {
    let harness = Harness::new(
        vec![
            terminal_resource(SESSION, "r1", "running"),
            terminal_resource(SESSION, "r2", "running"),
        ],
        cx,
    );
    harness.show(cx);
    let first = harness.terminal(0, cx);
    let stop = harness.transport.hold("runtime.resource.stop");
    harness.terminals.update(cx, |terminals, cx| terminals.close(&first, cx));
    settle(cx);
    let state = first.read_with(cx, |terminal, _| terminal.close_state().clone());
    assert_eq!(state, CloseState::Closing);
    // As recorded: the domain change comes before the stop's answer.
    harness.transport.reply(
        "runtime.resource.query",
        get_result(SESSION, Some(terminal_resource(SESSION, "r1", "cancelled"))),
    );
    harness.changed(&[(SESSION, "r1")], cx);
    assert_eq!(harness.count(cx), 1);
    stop.try_send(Ok(json!({}))).ok();
    settle(cx);
    assert_eq!(harness.count(cx), 1);

    // The second stop fails as not found: the shell is gone, which the
    // read that follows confirms.
    let second = harness.terminal(0, cx);
    harness.transport.reply(
        "runtime.resource.stop",
        operation_error(
            HostOperationErrorCode::NotFound,
            "Runtime Resource was not found in this Session",
        ),
    );
    harness.transport.reply("runtime.resource.query", get_result(SESSION, None));
    harness.terminals.update(cx, |terminals, cx| terminals.close(&second, cx));
    settle(cx);
    assert_eq!(harness.count(cx), 0);
    assert_eq!(harness.terminals.read_with(cx, |terminals, _| terminals.live_count()), 0);
}

#[gpui_kit::test]
fn a_failed_stop_can_be_closed_again(cx: &mut TestAppContext) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.show(cx);
    let terminal = harness.terminal(0, cx);
    harness.transport.reply(
        "runtime.resource.stop",
        operation_error(HostOperationErrorCode::SessionArchived, "Session is archived"),
    );
    harness.terminals.update(cx, |terminals, cx| terminals.close(&terminal, cx));
    settle(cx);
    let state = terminal.read_with(cx, |terminal, _| terminal.close_state().clone());
    assert!(matches!(state, CloseState::Failed(_)), "{state:?}");
    harness.terminals.update(cx, |terminals, cx| terminals.close(&terminal, cx));
    settle(cx);
    assert_eq!(harness.transport.requests("runtime.resource.stop").len(), 2);
    assert_eq!(harness.count(cx), 0);
}

#[gpui_kit::test]
fn a_ninth_live_terminal_is_refused_here(cx: &mut TestAppContext) {
    let live = |session: &str, names: std::ops::Range<u32>| -> Vec<Value> {
        names.map(|n| terminal_resource(session, &format!("{session}-{n}"), "running")).collect()
    };
    let harness = Harness::new(live(SESSION, 0..5), cx);
    harness.transport.set_inventory(OTHER, live(OTHER, 0..3));
    harness.select(OTHER, cx);
    // Five in the first task and three here: eight across tasks.
    assert_eq!(harness.terminals.read_with(cx, |terminals, _| terminals.live_count()), 8);
    harness.terminals.update(cx, |terminals, cx| terminals.start(cx));
    settle(cx);
    assert!(harness.transport.requests("runtime.resource.start").is_empty());
    assert_eq!(harness.start_state(cx), StartState::LimitReached);

    // One of them ends: there is room again.
    let ended = harness.terminal(0, cx);
    harness.terminals.update(cx, |terminals, cx| terminals.close(&ended, cx));
    settle(cx);
    assert_eq!(harness.start_state(cx), StartState::Idle);
    harness.transport.reply(
        "runtime.resource.start",
        Ok(json!({"resource": terminal_resource(OTHER, "new", "running")["result"]})),
    );
    harness.terminals.update(cx, |terminals, cx| terminals.start(cx));
    settle(cx);
    let started = harness.transport.requests("runtime.resource.start");
    assert_eq!(started.len(), 1);
    assert_eq!(started[0]["sessionId"], OTHER);
    assert!(started[0].get("command").is_none(), "a login shell, not a command");
    let launch = started[0]["launchId"].as_str().expect("launch id");
    assert!(launch.starts_with("desktop-terminal-") && launch.len() > 20, "{launch}");
    assert_eq!(harness.count(cx), 3);
}

#[gpui_kit::test]
fn another_tasks_terminal_ending_frees_its_place_under_the_limit(cx: &mut TestAppContext) {
    let live = |session: &str, names: std::ops::Range<u32>| -> Vec<Value> {
        names.map(|n| terminal_resource(session, &format!("{session}-{n}"), "running")).collect()
    };
    let harness = Harness::new(live(SESSION, 0..5), cx);
    harness.transport.set_inventory(OTHER, live(OTHER, 0..3));
    harness.select(OTHER, cx);
    harness.terminals.update(cx, |terminals, cx| terminals.start(cx));
    settle(cx);
    assert_eq!(harness.start_state(cx), StartState::LimitReached);
    let gets = |harness: &Harness| -> Vec<Value> {
        let queries = harness.transport.requests("runtime.resource.query");
        queries.into_iter().filter(|input| input["kind"] == "get").collect()
    };

    // Changes this window counts nothing for read nothing.
    harness.changed_in(OTHER, &[(SESSION, "unknown"), ("s3", "s3-0")], cx);
    assert!(gets(&harness).is_empty());
    // One of the first task's, still running: it still counts.
    harness.transport.reply(
        "runtime.resource.query",
        get_result(SESSION, Some(terminal_resource(SESSION, "s1-1", "running"))),
    );
    harness.changed_in(OTHER, &[(SESSION, "s1-1")], cx);
    assert_eq!(gets(&harness).len(), 1);
    assert_eq!(harness.terminals.read_with(cx, |terminals, _| terminals.live_count()), 8);
    // Another of them ended: its place is free.
    harness.transport.reply(
        "runtime.resource.query",
        get_result(SESSION, Some(terminal_resource(SESSION, "s1-0", "completed"))),
    );
    harness.changed_in(OTHER, &[(SESSION, "s1-0")], cx);
    let read = gets(&harness);
    assert_eq!(read.len(), 2);
    assert_eq!(
        (read[1]["sessionId"].clone(), read[1]["ref"].clone()),
        (json!(SESSION), json!(reference("s1-0")))
    );
    assert_eq!(harness.terminals.read_with(cx, |terminals, _| terminals.live_count()), 7);
    assert_eq!(harness.start_state(cx), StartState::Idle);
}

#[gpui_kit::test]
fn the_agents_interactive_runs_count_toward_the_limit(cx: &mut TestAppContext) {
    let mut inventory: Vec<Value> =
        (0..7).map(|n| terminal_resource(SESSION, &format!("r{n}"), "running")).collect();
    inventory.push(resource(SESSION, "agent-pty", "running", "turn-1", "pty"));
    inventory.push(resource(SESSION, "agent-pipes", "running", "turn-1", "pipes"));
    let mut borrowed = resource(SESSION, "branch-pty", "running", "turn-1", "pty");
    borrowed["ownership"] =
        json!({"kind": "source_owned", "sourceSessionId": OTHER, "ownerSessionId": OTHER});
    inventory.push(borrowed);
    let harness = Harness::new(inventory, cx);
    assert_eq!(harness.count(cx), 7, "the agent's runs are no terminals");
    assert_eq!(harness.terminals.read_with(cx, |terminals, _| terminals.live_count()), 8);
    harness.terminals.update(cx, |terminals, cx| terminals.start(cx));
    settle(cx);
    assert_eq!(harness.start_state(cx), StartState::LimitReached);

    // The run ends.
    harness.transport.reply(
        "runtime.resource.query",
        get_result(SESSION, Some(resource(SESSION, "agent-pty", "completed", "turn-1", "pty"))),
    );
    harness.changed(&[(SESSION, "agent-pty")], cx);
    assert_eq!(harness.terminals.read_with(cx, |terminals, _| terminals.live_count()), 7);
    assert_eq!(harness.start_state(cx), StartState::Idle);
}

#[gpui_kit::test]
fn a_start_before_the_list_answers_waits_for_it_and_counts_what_it_lists(cx: &mut TestAppContext) {
    let live = |session: &str, names: std::ops::Range<u32>| -> Vec<Value> {
        names.map(|n| terminal_resource(session, &format!("{session}-{n}"), "running")).collect()
    };
    let harness = Harness::new(live(SESSION, 0..1), cx);
    let starts = |harness: &Harness| harness.transport.requests("runtime.resource.start").len();
    // [+] Terminal while the task's list is read again: the start waits
    // for it, then goes.
    let list = harness.transport.hold("runtime.resource.query");
    harness.terminals.update(cx, |terminals, cx| terminals.reload(cx));
    settle(cx);
    harness.terminals.update(cx, |terminals, cx| terminals.start(cx));
    settle(cx);
    assert_eq!(starts(&harness), 0);
    assert_eq!(harness.start_state(cx), StartState::Starting);
    harness.transport.reply(
        "runtime.resource.start",
        Ok(json!({"resource": terminal_resource(SESSION, "new", "running")["result"]})),
    );
    list.try_send(Ok(page(SESSION, live(SESSION, 0..1)))).expect("list");
    settle(cx);
    assert_eq!(starts(&harness), 1);
    assert_eq!(harness.count(cx), 2);

    // A fresh look at a task with six more, before its list answers: that
    // makes eight, so the start that waited is refused.
    harness.transport.set_inventory(OTHER, live(OTHER, 0..6));
    let list = harness.transport.hold("runtime.resource.query");
    harness.select(OTHER, cx);
    harness.terminals.update(cx, |terminals, cx| terminals.start(cx));
    settle(cx);
    assert_eq!(harness.start_state(cx), StartState::Starting);
    list.try_send(Ok(page(OTHER, live(OTHER, 0..6)))).expect("list");
    settle(cx);
    assert_eq!(harness.start_state(cx), StartState::LimitReached);
    assert_eq!(starts(&harness), 1, "no ninth");
    assert_eq!(harness.terminals.read_with(cx, |terminals, _| terminals.live_count()), 8);
}

#[gpui_kit::test]
fn a_start_waiting_on_a_list_that_fails_is_dropped(cx: &mut TestAppContext) {
    let harness = Harness::new(Vec::new(), cx);
    let list = harness.transport.hold("runtime.resource.query");
    harness.terminals.update(cx, |terminals, cx| terminals.reload(cx));
    settle(cx);
    harness.terminals.update(cx, |terminals, cx| terminals.start(cx));
    settle(cx);
    list.try_send(Err(HostRequestError::Transport("refused".into()))).expect("list");
    settle(cx);
    assert_eq!(harness.start_state(cx), StartState::Idle);
    assert!(harness.transport.requests("runtime.resource.start").is_empty());
    let inventory = harness.terminals.read_with(cx, |terminals, _| terminals.inventory().clone());
    assert!(matches!(inventory, Inventory::Failed(_)), "{inventory:?}");
}

#[gpui_kit::test]
fn an_internal_failure_from_start_means_a_restarting_host_not_the_limit(cx: &mut TestAppContext) {
    let harness = Harness::new(Vec::new(), cx);
    harness.transport.reply(
        "runtime.resource.start",
        operation_error(
            HostOperationErrorCode::InternalFailure,
            "Runtime Resource operation failed",
        ),
    );
    harness.terminals.update(cx, |terminals, cx| terminals.start(cx));
    settle(cx);
    assert_eq!(harness.start_state(cx), StartState::HostRestarting);
    // The Host comes back as a new process.
    harness.feed(ConnectionEvent::Disconnected { reason: "drained".into() }, cx);
    harness.feed(
        ConnectionEvent::HostEpochChanged { previous: EPOCH.into(), current: "epoch-2".into() },
        cx,
    );
    harness.connect(cx);
    assert_eq!(harness.start_state(cx), StartState::Idle);
}

#[gpui_kit::test]
fn the_inventory_keeps_only_live_client_terminals(cx: &mut TestAppContext) {
    let mut source_owned = terminal_resource(SESSION, "branch", "running");
    source_owned["ownership"] =
        json!({"kind": "source_owned", "sourceSessionId": "a", "ownerSessionId": "b"});
    let mut agent_run = resource(SESSION, "agent", "running", "turn-1", "pty");
    agent_run["sourceToolCallId"] = json!("call-1");
    let harness = Harness::new(
        vec![
            terminal_resource(SESSION, "r1", "running"),
            terminal_resource(SESSION, "r2", "starting"),
            terminal_resource(SESSION, "orphan", "orphaned"),
            terminal_resource(SESSION, "done", "completed"),
            agent_run,
            resource(SESSION, "bang", "running", "desktop-command-1", "pipes"),
            source_owned,
        ],
        cx,
    );
    let refs: Vec<String> = harness.terminals.read_with(cx, |terminals, cx| {
        let terminals = terminals.terminals().iter();
        terminals.map(|terminal| terminal.read(cx).resource_ref().to_string()).collect()
    });
    assert_eq!(refs, [reference("r1"), reference("r2")]);
    let inventory = harness.terminals.read_with(cx, |terminals, _| terminals.inventory().clone());
    assert_eq!(inventory, Inventory::Loaded);
}

#[gpui_kit::test]
fn switching_tasks_releases_and_returning_attaches_again(cx: &mut TestAppContext) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.show(cx);
    let controller =
        harness.transport.requests("runtime.resource.controller.acquire")[0]["controllerId"]
            .clone();
    harness.select(OTHER, cx);
    let released = harness.transport.requests("runtime.resource.controller.release");
    assert_eq!(
        released,
        [json!({"sessionId": SESSION, "ref": reference("r1"), "controllerId": controller})]
    );
    assert!(harness.transport.requests("runtime.resource.stop").is_empty(), "the shell runs on");
    assert_eq!(harness.count(cx), 0);

    harness.select(SESSION, cx);
    assert_eq!(harness.count(cx), 1);
    let terminal = harness.terminal(0, cx);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
    assert_eq!(harness.transport.requests("runtime.resource.controller.acquire").len(), 2);
    let operations = harness.transport.terminal_operations();
    let tail = &operations[operations.len() - 3..];
    assert_eq!(tail, ["query list_start", "subscription.pty_interest.set", "controller.acquire"]);
}

#[gpui_kit::test]
fn with_only_its_tab_showing_a_terminal_streams_its_output_without_a_controller(
    cx: &mut TestAppContext,
) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    let shown = |shown: TerminalsShown, cx: &mut TestAppContext| {
        harness.terminals.update(cx, |terminals, cx| terminals.set_shown(shown, cx));
        settle(cx);
    };
    let acquires =
        |harness: &Harness| harness.transport.requests("runtime.resource.controller.acquire").len();
    let releases =
        |harness: &Harness| harness.transport.requests("runtime.resource.controller.release").len();
    shown(TerminalsShown::Tabs, cx);
    let terminal = harness.terminal(0, cx);
    assert_eq!(harness.last_interest(), json!([reference("r1")]));
    assert_eq!(acquires(&harness), 0, "no controller for a tab");
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Detached);
    // The program's title and its bell reach the tab.
    harness.output("r1", 7, "\x1b]2;build\x07\x07", cx);
    let (title, bell) = terminal
        .read_with(cx, |terminal, _| (terminal.title().map(ToString::to_string), terminal.bell()));
    assert_eq!((title.as_deref(), bell), (Some("build"), true));
    // Nothing typed goes anywhere.
    terminal.update(cx, |terminal, cx| terminal.input("ls\r", cx));
    settle(cx);
    assert!(harness.controls().is_empty());

    // The face shows: the controller, and a snapshot for the picture.
    harness.transport.reply(
        "runtime.resource.controller.acquire",
        Ok(acquire_result(&json!("c"), 1, 7, "$ make", 80, 24)),
    );
    shown(TerminalsShown::Face, cx);
    assert_eq!(acquires(&harness), 1);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
    assert!(harness.text(&terminal, cx).starts_with("$ make"));

    // Another face takes the panel: the controller goes, the output stays.
    shown(TerminalsShown::Tabs, cx);
    assert_eq!(releases(&harness), 1);
    assert_eq!(harness.last_interest(), json!([reference("r1")]));
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Detached);
    terminal.update(cx, |terminal, cx| terminal.clear_bell(cx));
    harness.output("r1", 8, "\x07", cx);
    assert!(terminal.read_with(cx, |terminal, _| terminal.bell()));
    // Back on the face: the controller again, with its snapshot.
    shown(TerminalsShown::Face, cx);
    assert_eq!(acquires(&harness), 2);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
    // The panel hidden: neither.
    shown(TerminalsShown::Hidden, cx);
    assert_eq!(releases(&harness), 2);
    assert_eq!(harness.last_interest(), json!([]));
}

#[gpui_kit::test]
fn the_grid_is_clamped_and_resized_once_per_change(cx: &mut TestAppContext) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.show(cx);
    let terminal = harness.terminal(0, cx);
    terminal.update(cx, |terminal, cx| terminal.set_grid(500, 0, cx));
    settle(cx);
    let grid = terminal.read_with(cx, |terminal, _| terminal.grid()).expect("grid");
    assert_eq!((grid.cols, grid.rows), (240, 1));
    terminal.update(cx, |terminal, cx| terminal.set_grid(300, 0, cx));
    terminal.update(cx, |terminal, cx| terminal.set_grid(100, 30, cx));
    terminal.update(cx, |terminal, cx| terminal.set_grid(100, 30, cx));
    settle(cx);
    assert_eq!(
        harness.controls(),
        [
            (1, json!({"kind": "resize", "cols": 240, "rows": 1})),
            (2, json!({"kind": "resize", "cols": 100, "rows": 30})),
        ]
    );
    let size = terminal.read_with(cx, |terminal, _| terminal.content().size);
    assert_eq!((size.cols, size.rows), (100, 30));
}

#[gpui_kit::test]
fn only_cursor_position_reports_answer_the_program(cx: &mut TestAppContext) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    harness.show(cx);
    // Device attributes, status, a colour query, then a cursor report.
    harness.output("r1", 1, "\x1b[c\x1b[5n\x1b]11;?\x07ab\x1b[6n", cx);
    assert_eq!(harness.controls(), [(1, json!({"kind": "input", "input": "\x1b[1;3R"}))]);
}

#[gpui_kit::test]
fn the_grid_search_finds_a_word_in_the_scrollback(cx: &mut TestAppContext) {
    let harness = Harness::new(vec![terminal_resource(SESSION, "r1", "running")], cx);
    let lines: Vec<String> =
        (0..40).map(|n| if n == 2 { "a needle".into() } else { format!("line {n}") }).collect();
    harness.transport.reply(
        "runtime.resource.controller.acquire",
        Ok(acquire_result(&json!("c"), 1, 1, &lines.join("\r\n"), 80, 24)),
    );
    harness.show(cx);
    let terminal = harness.terminal(0, cx);
    let query = search::SearchQuery::new("needle", search::SearchOptions::new().whole_word(true));
    let found = terminal.update(cx, |terminal, cx| terminal.find(query, cx));
    let found = cx.foreground_executor().block_test(found);
    assert_eq!(found.len(), 1);
    // 40 lines on 24 rows: line 2 is 14 rows up in the scrollback.
    assert_eq!(found[0].start.line.0, -14);
    assert_eq!(found[0].start.column.0, 2);
}

#[gpui_kit::test]
fn a_terminal_started_while_the_list_is_read_outlives_the_older_list(cx: &mut TestAppContext) {
    let harness = Harness::new(Vec::new(), cx);
    harness.show(cx);
    let start = harness.transport.hold("runtime.resource.start");
    harness.terminals.update(cx, |terminals, cx| terminals.start(cx));
    settle(cx);
    let list = harness.transport.hold("runtime.resource.query");
    harness.terminals.update(cx, |terminals, cx| terminals.reload(cx));
    settle(cx);
    let started = json!({"resource": terminal_resource(SESSION, "new", "running")["result"]});
    start.try_send(Ok(started)).expect("start");
    settle(cx);
    list.try_send(Ok(page(SESSION, Vec::new()))).expect("list");
    settle(cx);
    assert_eq!(harness.count(cx), 1);
    let terminal = harness.terminal(0, cx);
    assert_eq!(harness.phase(&terminal, cx), TerminalPhase::Live);
    assert_eq!(harness.terminals.read_with(cx, |terminals, _| terminals.live_count()), 1);
}
