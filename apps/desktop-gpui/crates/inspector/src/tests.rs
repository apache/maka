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

//! The Trace face and its state against a scripted Host, in a headless
//! window. The Host answers as the demo Host answered in the recorded
//! `inspector.jsonl` (a Session paged over two pages, one whose Turn
//! called tools, one that never ran); paging to the oldest page, a usage
//! summary with unreadable records and a refused read are not in the
//! recording, so the Host builds those itself in the recorded shapes
//! (hand-built).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    App, AppContext as _, ElementId, Entity, TestAppContext, Window, WindowHandle, px, size,
};
use host_client::HostEvent;
use host_protocol::{HostFrame, HostOperationErrorCode};
use serde_json::{Value, json};
use shared::copy::{Locale, inspector as copy};
use shared::domain_element_id;
use workspace::{HostRequestError, HostSession, HostTransport};

use crate::model::turn_key;
use crate::{InspectorState, InspectorView, InspectorViewEvent, REFRESH_DEBOUNCE};

type Reply = Result<Value, HostRequestError>;

const FIXTURE: &str = include_str!("../../host-protocol/fixtures/sequences/inspector.jsonl");
/// The recording's Sessions: traced over more than two pages, a Turn
/// with tool calls, and never run.
const PAGED: &str = "920d6149-08f0-43d1-9a07-1af4c4ec5ebf";
const TOOLS: &str = "d3c9b9eb-6db3-44d5-8ff2-6ab8fafbf327";
const IDLE: &str = "04a9ec7e-27ac-45fd-a80c-5e8226044f48";
/// A hand-built Session of three pages.
const PAGES: &str = "s-pages";

/// The operation a request is filed under: `execution.inspect.query`
/// by its kind.
fn key_of(operation: &str, input: &Value) -> String {
    match input["kind"].as_str() {
        Some(kind) if operation == "execution.inspect.query" => format!("{operation}:{kind}"),
        _ => operation.to_owned(),
    }
}

/// Answers every recorded read by its input, the hand-built ones it was
/// given, scripted replies first and held ones when the test sends them.
/// Records every request.
#[derive(Default)]
struct ScriptedHost {
    answers: Mutex<HashMap<String, Value>>,
    replies: Mutex<HashMap<String, VecDeque<Reply>>>,
    held: Mutex<HashMap<String, VecDeque<async_channel::Receiver<Reply>>>>,
    requests: Mutex<Vec<(String, Value)>>,
}

impl ScriptedHost {
    fn new() -> Arc<Self> {
        let host = Self::default();
        let lines: Vec<Value> =
            FIXTURE.lines().map(|line| serde_json::from_str(line).expect("line")).collect();
        let mut inputs = HashMap::new();
        for line in &lines {
            let id = line["requestId"].as_str().expect("request id").to_owned();
            if line.get("input").is_some() {
                inputs.insert(id, (line["operation"].clone(), line["input"].clone()));
            } else if let Some((operation, input)) = inputs.remove(&id) {
                let operation = operation.as_str().expect("operation").to_owned();
                host.answer(&operation, input, line["result"].clone());
            }
        }
        for (cursor, runs, next) in [
            (None, ["run-5", "run-6"], Some("c1")),
            (Some("c1"), ["run-3", "run-4"], Some("c2")),
            (Some("c2"), ["run-1", "run-2"], None),
        ] {
            let input = match cursor {
                Some(cursor) => json!({"kind": "session_trace_continue", "sessionId": PAGES,
                                       "cursor": cursor}),
                None => json!({"kind": "session_trace_start", "sessionId": PAGES}),
            };
            host.answer("execution.inspect.query", input, page(PAGES, &runs, next));
        }
        host.answer(
            "context.diagnostics.query",
            json!({"sessionId": PAGES}),
            json!({"status": "unavailable", "reason": "no_completed_request"}),
        );
        host.answer(
            "usage.query",
            json!({"kind": "summary", "query": {"range": "all", "sessionId": PAGES}}),
            summary(6, 0),
        );
        Arc::new(host)
    }

    fn answer(&self, operation: &str, input: Value, result: Value) {
        let key = format!("{operation} {input}");
        self.answers.lock().expect("answers").insert(key, result);
    }

    fn reply(&self, key: &str, reply: Reply) {
        self.replies.lock().expect("replies").entry(key.to_owned()).or_default().push_back(reply);
    }

    fn hold(&self, key: &str) -> async_channel::Sender<Reply> {
        let (sender, receiver) = async_channel::bounded(1);
        self.held.lock().expect("held").entry(key.to_owned()).or_default().push_back(receiver);
        sender
    }

    /// The requests filed under `key`, in order.
    fn requests(&self, key: &str) -> Vec<Value> {
        let requests = self.requests.lock().expect("requests");
        requests.iter().filter(|(kind, _)| kind == key).map(|(_, input)| input.clone()).collect()
    }

    /// How many of each read were sent: the trace's pages (start and
    /// continue), the snapshots, the summaries.
    fn counts(&self) -> (usize, usize, usize) {
        let trace = self.requests("execution.inspect.query:session_trace_start").len()
            + self.requests("execution.inspect.query:session_trace_continue").len();
        (
            trace,
            self.requests("context.diagnostics.query").len(),
            self.requests("usage.query").len(),
        )
    }
}

impl HostTransport for ScriptedHost {
    fn request(&self, operation: &'static str, input: Value, _: Duration) -> Boxed<Reply> {
        let key = key_of(operation, &input);
        self.requests.lock().expect("requests").push((key.clone(), input.clone()));
        let held = self.held.lock().expect("held").get_mut(&key).and_then(VecDeque::pop_front);
        if let Some(held) = held {
            return Box::pin(async move {
                held.recv().await.unwrap_or(Err(HostRequestError::NotConnected))
            });
        }
        let scripted =
            self.replies.lock().expect("replies").get_mut(&key).and_then(VecDeque::pop_front);
        let reply = scripted.unwrap_or_else(|| {
            let answers = self.answers.lock().expect("answers");
            answers.get(&format!("{operation} {input}")).cloned().ok_or_else(|| {
                HostRequestError::Transport(format!("unscripted {operation} {input}").into())
            })
        });
        Box::pin(async move { reply })
    }
}

/// A hand-built trace page of `runs` (oldest first), each a Turn with one
/// unpriced model call, in the recorded page's shape.
fn page(session: &str, runs: &[&str], next: Option<&str>) -> Value {
    let turns: Vec<Value> = runs
        .iter()
        .map(|run| {
            let started = 1_790_000_000_000u64
                + run.trim_start_matches("run-").parse::<u64>().expect("n") * 60_000;
            let turn = format!("turn-{run}");
            json!({"runId": run, "turnId": turn, "startedAt": started,
                "endedAt": started + 8_600, "durationMs": 8_600, "steps": [
                {"kind": "model_call", "id": format!("call-{run}"), "turnId": turn, "runId": run,
                 "startedAt": started, "endedAt": started + 8_500, "durationMs": 8_500,
                 "callKind": "main", "providerId": "openai-compatible",
                 "modelId": "scripted-demo", "connectionSlug": "demo", "step": 0,
                 "attempts": [{"attemptId": format!("a-{run}"), "attempt": 0,
                    "status": "completed", "startedAt": started, "completedAt": started + 8_500,
                    "latencyMs": 8_500, "costBasis": "unpriced", "usageBasis": "reported",
                    "inputTokens": 120, "outputTokens": 80}],
                 "status": "completed"}]})
        })
        .collect();
    json!({"kind": "session_trace_page", "schemaVersion": 1, "sessionId": session,
           "turns": turns, "coverage": {"modelCalls": "no_known_gap",
           "turnsMissingModelCalls": [], "turnsWithFewerModelCallsThanSteps": [],
           "unreadableRecords": 0, "oversizedRuns": 0}, "nextCursor": next})
}

/// A summary of `requests` unpriced calls, `unreadable` records unread.
fn summary(requests: u64, unreadable: u64) -> Value {
    json!({"kind": "summary", "summary": {"range": {"from": 0, "to": 1}, "totalRequests": requests,
        "totalCostUsd": 0, "totalTokens": {"input": 120 * requests, "output": 80 * requests,
        "cacheMiss": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0,
        "total": 200 * requests}, "cacheHitRequests": 0, "cacheCreateRequests": 0,
        "errorRequests": 0, "totalDurationMs": 8_500 * requests},
        "provenance": {"coverage": {"attempts": requests, "pricedAttempts": 0,
        "unpricedAttempts": requests, "usageReportedAttempts": requests,
        "usagePartialAttempts": 0, "usageMissingAttempts": 0}, "legacyRecords": 0,
        "unreadableRecords": unreadable, "pendingRepairs": 0}})
}

fn host_session(host: &Arc<ScriptedHost>, cx: &mut TestAppContext) -> Entity<HostSession> {
    let transport = host.clone();
    cx.new(|_| HostSession::with_transport(PathBuf::from("/tmp/maka-inspector-tests"), transport))
}

/// Sends `frame` as the Host's push.
fn push(host: &Entity<HostSession>, frame: Value, cx: &mut TestAppContext) {
    let HostFrame::Push(frame) = HostFrame::decode(frame).expect("frame") else {
        panic!("not a push frame");
    };
    host.update(cx, |host, cx| host.handle_host_event(HostEvent::Push(frame), cx));
}

fn tool_start(session: &str) -> Value {
    json!({"kind": "subscription.session_event", "hostEpoch": "e1", "subscriptionId": "sub-1",
           "sequence": 7, "sessionId": session, "runId": "r1",
           "event": {"type": "tool_start", "turnId": "t1", "toolUseId": "call_1",
                     "toolName": "Read", "input": {}}})
}

fn usage_changed(session: &str) -> Value {
    json!({"kind": "subscription.session_domain_changed", "hostEpoch": "e1",
           "subscriptionId": "sub-1", "sequence": 8, "sessionId": session, "domain": "usage"})
}

fn delta(session: &str) -> Value {
    json!({"kind": "subscription.session_delta", "hostEpoch": "e1", "subscriptionId": "sub-1",
           "sequence": 9, "sessionId": session, "runId": "r1",
           "delta": {"kind": "text", "turnId": "t1", "messageId": "m1", "text": "hel"}})
}

/// Lets the debounce close and what it set off finish.
fn after_debounce(cx: &mut TestAppContext) {
    cx.run_until_parked();
    cx.executor().advance_clock(REFRESH_DEBOUNCE + Duration::from_millis(10));
    cx.run_until_parked();
}

// The state alone.

struct Bench {
    transport: Arc<ScriptedHost>,
    host: Entity<HostSession>,
    state: Entity<InspectorState>,
}

impl Bench {
    fn new(session: &str, cx: &mut TestAppContext) -> Self {
        let transport = ScriptedHost::new();
        let host = host_session(&transport, cx);
        let state = cx.new(|cx| InspectorState::new(host.clone(), cx));
        state.update(cx, |state, cx| {
            state.set_session(Some(session.to_owned().into()), cx);
            state.set_shown(true, cx);
        });
        cx.run_until_parked();
        Self { transport, host, state }
    }

    fn runs(&self, cx: &mut TestAppContext) -> Vec<String> {
        self.state.read_with(cx, |state, _| {
            state
                .trace()
                .map(|trace| trace.turns.iter().map(|turn| turn.run_id.clone()).collect())
                .unwrap_or_default()
        })
    }
}

#[gpui_kit::test]
fn a_usage_change_refreshes_the_summary_only_and_a_session_event_the_trace_only(
    cx: &mut TestAppContext,
) {
    let bench = Bench::new(TOOLS, cx);
    assert_eq!(bench.transport.counts(), (1, 1, 1), "showing reads all three");

    push(&bench.host, usage_changed(TOOLS), cx);
    after_debounce(cx);
    assert_eq!(bench.transport.counts(), (1, 1, 2), "the usage authority: the summary only");

    push(&bench.host, tool_start(TOOLS), cx);
    after_debounce(cx);
    assert_eq!(bench.transport.counts(), (2, 2, 2), "a session event: the trace and its context");

    // A burst is one read, after its last signal.
    for _ in 0..3 {
        push(&bench.host, tool_start(TOOLS), cx);
        cx.executor().advance_clock(REFRESH_DEBOUNCE / 2);
        cx.run_until_parked();
    }
    after_debounce(cx);
    assert_eq!(bench.transport.counts(), (3, 3, 2));

    // Streaming deltas, another Session's events and other domains are not
    // signals.
    for _ in 0..5 {
        push(&bench.host, delta(TOOLS), cx);
    }
    push(&bench.host, tool_start(IDLE), cx);
    let mut todo = usage_changed(TOOLS);
    todo["domain"] = json!("todo");
    push(&bench.host, todo, cx);
    after_debounce(cx);
    assert_eq!(bench.transport.counts(), (3, 3, 2));
}

#[gpui_kit::test]
fn nothing_refreshes_while_hidden(cx: &mut TestAppContext) {
    let bench = Bench::new(TOOLS, cx);
    // A signal whose refresh is still waiting when the face hides.
    push(&bench.host, tool_start(TOOLS), cx);
    push(&bench.host, usage_changed(TOOLS), cx);
    cx.run_until_parked();
    assert_eq!(bench.state.read_with(cx, |state, _| state.refresh_scheduled()), (true, true));
    bench.state.update(cx, |state, cx| state.set_shown(false, cx));
    assert_eq!(bench.state.read_with(cx, |state, _| state.refresh_scheduled()), (false, false));
    after_debounce(cx);
    // Signals while hidden schedule nothing.
    push(&bench.host, tool_start(TOOLS), cx);
    push(&bench.host, usage_changed(TOOLS), cx);
    after_debounce(cx);
    assert_eq!(bench.transport.counts(), (1, 1, 1), "nothing read while hidden");
    assert!(bench.state.read_with(cx, |state, _| state.trace().is_some()), "what it showed stays");

    // A read in flight when the face hides is never applied.
    bench.state.update(cx, |state, cx| state.set_shown(true, cx));
    let held = bench.transport.hold("usage.query");
    cx.run_until_parked();
    bench.state.update(cx, |state, cx| state.set_shown(false, cx));
    held.try_send(Ok(summary(99, 0))).ok();
    cx.run_until_parked();
    let requests = bench
        .state
        .read_with(cx, |state, _| state.usage().map(|usage| usage.summary.total_requests));
    assert_ne!(requests, Some(99), "the answer to a hidden face's read is dropped");
}

#[gpui_kit::test]
fn following_another_task_whose_face_is_hidden_reads_nothing(cx: &mut TestAppContext) {
    let bench = Bench::new(TOOLS, cx);
    assert_eq!(bench.transport.counts(), (1, 1, 1));
    bench.state.update(cx, |state, cx| state.follow(Some(IDLE.into()), false, cx));
    after_debounce(cx);
    assert_eq!(bench.transport.counts(), (1, 1, 1), "a hidden face reads nothing");
    assert!(bench.state.read_with(cx, |state, _| state.trace().is_none()), "TOOLS' trace went");
    bench.state.update(cx, |state, cx| state.follow(Some(IDLE.into()), true, cx));
    cx.run_until_parked();
    assert_eq!(bench.transport.counts(), (2, 2, 2), "shown, it reads once");
    assert_eq!(bench.transport.requests("usage.query")[1]["query"]["sessionId"], IDLE);
}

#[gpui_kit::test]
fn the_trace_pages_and_keeps_its_depth_on_reactivation(cx: &mut TestAppContext) {
    let bench = Bench::new(PAGES, cx);
    assert_eq!(bench.runs(cx), ["run-5", "run-6"]);
    bench.state.update(cx, |state, cx| state.load_earlier(cx));
    cx.run_until_parked();
    assert_eq!(bench.runs(cx), ["run-3", "run-4", "run-5", "run-6"]);
    assert_eq!(bench.state.read_with(cx, |state, _| (state.depth(), state.pages())), (2, 2));
    assert_eq!(
        bench.transport.requests("execution.inspect.query:session_trace_continue"),
        [json!({"kind": "session_trace_continue", "sessionId": PAGES, "cursor": "c1"})]
    );

    // Hidden and shown again: the window is read again from the newest
    // page to the depth asked for.
    bench.state.update(cx, |state, cx| state.set_shown(false, cx));
    bench.state.update(cx, |state, cx| state.set_shown(true, cx));
    cx.run_until_parked();
    assert_eq!(bench.runs(cx), ["run-3", "run-4", "run-5", "run-6"]);
    assert_eq!(bench.transport.requests("execution.inspect.query:session_trace_start").len(), 2);
    assert_eq!(bench.transport.requests("execution.inspect.query:session_trace_continue").len(), 2);
    // A session event refreshes the same depth.
    push(&bench.host, tool_start(PAGES), cx);
    after_debounce(cx);
    assert_eq!(bench.state.read_with(cx, |state, _| state.pages()), 2);

    // To the oldest page; then the earlier ones hide, the depth back to one.
    bench.state.update(cx, |state, cx| state.load_earlier(cx));
    cx.run_until_parked();
    assert_eq!(bench.runs(cx).len(), 6);
    assert!(bench.state.read_with(cx, |state, _| state.can_hide_earlier()));
    bench.state.update(cx, |state, cx| state.hide_earlier(cx));
    assert_eq!(bench.runs(cx), ["run-5", "run-6"]);
    assert_eq!(
        bench
            .state
            .read_with(cx, |state, _| (state.depth(), state.next_cursor().map(str::to_owned))),
        (1, Some("c1".to_owned()))
    );

    // Another task starts at one page.
    bench.state.update(cx, |state, cx| state.load_earlier(cx));
    cx.run_until_parked();
    bench.state.update(cx, |state, cx| state.set_session(Some(TOOLS.into()), cx));
    cx.run_until_parked();
    assert_eq!(bench.state.read_with(cx, |state, _| state.depth()), 1);
}

#[gpui_kit::test]
fn a_head_refresh_superseding_load_earlier_keeps_the_depth(cx: &mut TestAppContext) {
    let bench = Bench::new(PAGES, cx);
    let held = bench.transport.hold("execution.inspect.query:session_trace_continue");
    bench.state.update(cx, |state, cx| state.load_earlier(cx));
    cx.run_until_parked();
    assert!(bench.state.read_with(cx, |state, _| state.is_earlier_loading()));
    push(&bench.host, tool_start(PAGES), cx);
    after_debounce(cx);
    // The refresh read two pages; the held answer arrives late and is
    // dropped with the read it answered.
    held.try_send(Ok(page(PAGES, &["run-0"], None))).ok();
    cx.run_until_parked();
    assert_eq!(bench.runs(cx), ["run-3", "run-4", "run-5", "run-6"]);
    assert!(!bench.state.read_with(cx, |state, _| state.is_earlier_loading()));
}

#[gpui_kit::test]
fn a_cursor_that_does_not_move_on_fails_the_read_instead_of_paging_forever(
    cx: &mut TestAppContext,
) {
    let bench = Bench::new(PAGES, cx);
    bench.transport.reply(
        "execution.inspect.query:session_trace_continue",
        Ok(page(PAGES, &["run-3"], Some("c1"))),
    );
    bench.state.update(cx, |state, cx| state.load_earlier(cx));
    cx.run_until_parked();
    let (failed, depth, pages) = bench
        .state
        .read_with(cx, |state, _| (state.trace_failure().is_some(), state.depth(), state.pages()));
    assert!(failed);
    assert_eq!((depth, pages), (1, 1), "the depth falls back to what is loaded");
    assert_eq!(bench.runs(cx), ["run-5", "run-6"], "what was shown stays");
}

// The face.

struct Face {
    transport: Arc<ScriptedHost>,
    host: Entity<HostSession>,
    view: Entity<InspectorView>,
    window: WindowHandle<Root>,
    events: std::rc::Rc<std::cell::RefCell<Vec<InspectorViewEvent>>>,
}

impl Face {
    fn open(session: &str, cx: &mut TestAppContext) -> Self {
        Self::open_with(ScriptedHost::new(), session, cx)
    }

    fn open_with(transport: Arc<ScriptedHost>, session: &str, cx: &mut TestAppContext) -> Self {
        Self::open_sized(transport, session, 480., cx)
    }

    /// The face `width` pixels wide: the workbar's default is 480, its
    /// narrowest 340.
    fn open_sized(
        transport: Arc<ScriptedHost>,
        session: &str,
        width: f32,
        cx: &mut TestAppContext,
    ) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            cx.set_reduce_motion(true);
        });
        let host = host_session(&transport, cx);
        let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let recorded = events.clone();
        let mut view = None;
        let window = cx.open_window(size(px(width), px(1600.)), |window, cx| {
            let face = cx.new(|cx| InspectorView::new(host.clone(), window, cx));
            cx.subscribe(&face, move |_, _, event: &InspectorViewEvent, _| {
                recorded.borrow_mut().push(event.clone());
            })
            .detach();
            view = Some(face.clone());
            Root::new(face, window, cx)
        });
        let face = Self { transport, host, view: view.expect("view"), window, events };
        let session = session.to_owned();
        face.view.update(cx, |view, cx| {
            view.set_session(Some(session.into()), cx);
            view.set_shown(true, cx);
        });
        face.frame(cx);
        face
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Window, &mut App) -> R,
    ) -> R {
        let result = cx
            .update_window(self.window.into(), |_, window, cx| {
                window.render_frame(cx);
                f(window, cx)
            })
            .expect("window");
        cx.run_until_parked();
        cx.update_window(self.window.into(), |_, window, cx| window.render_frame(cx))
            .expect("window");
        cx.run_until_parked();
        result
    }

    fn frame(&self, cx: &mut TestAppContext) {
        self.with_window(cx, |_, _| {});
    }

    fn click(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) {
        let id = id.into();
        self.with_window(cx, |window, cx| window.click(id, cx));
    }

    fn exists(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> bool {
        let id = id.into();
        self.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    fn label(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|element| element.label().map(str::to_owned))
        })
    }

    fn readout(&self, key: &str, cx: &mut TestAppContext) -> Option<String> {
        self.label(domain_element_id("inspector-readout", key), cx)
    }

    fn fact(&self, key: &str, cx: &mut TestAppContext) -> Option<String> {
        self.label(domain_element_id("inspector-fact", key), cx)
    }
}

fn status(key: &str) -> ElementId {
    domain_element_id("settings-status", key)
}

/// The recorded Session whose Turn read files and ran a command: the
/// overview shows what Desktop's model derives from the same answers, the
/// newest Turn opens to its steps, and the unpriced demo model reads in
/// Desktop's words.
#[gpui_kit::test]
fn the_recorded_answers_draw_the_overview_and_the_timeline(cx: &mut TestAppContext) {
    let face = Face::open(TOOLS, cx);
    // 601 input (1 reported as a miss), 401 output: the uncached input is
    // the prompt's residual, 601 of 1002.
    assert_eq!(face.readout("tokens", cx).as_deref(), Some("Uncached input: 60.0%"));
    assert_eq!(face.fact("tokens/cache-miss", cx).as_deref(), Some("Uncached input: 601 · 60.0%"));
    assert_eq!(
        face.fact("tokens/output", cx).as_deref(),
        Some("Output (incl. reasoning): 401 · 40.0%")
    );
    assert!(!face.exists(domain_element_id("inspector-fact", "tokens/cache-read"), cx));
    // Six model calls in 391 ms, four tool runs in 210 ms.
    assert_eq!(face.readout("time", cx).as_deref(), Some("Recorded time: 601ms"));
    assert_eq!(face.fact("time/model", cx).as_deref(), Some("LLM calls × 6: 391ms · 65.1%"));
    assert_eq!(face.fact("time/tool", cx).as_deref(), Some("Tool runs × 4: 210ms · 34.9%"));
    // Nothing priced: the cost is unknown, never $0.00; the cache read none.
    assert_eq!(face.readout("cost", cx).as_deref(), Some("cost unknown"));
    assert_eq!(face.readout("cache-hit", cx).as_deref(), Some("0.0%"));
    // The demo model reports no window: no bar, but the composition.
    assert!(!face.exists("inspector-context", cx));
    assert_eq!(face.fact("composition/system", cx).as_deref(), Some("System instructions: ≈8,254"));
    assert!(face.exists(domain_element_id("inspector-tool", "Bash"), cx));

    let (key, steps) = face.view.read_with(cx, |view, _| {
        let turn = &view.panel().turns[0];
        (turn.key(), turn.steps.iter().map(|step| step.id.clone()).collect::<Vec<_>>())
    });
    assert_eq!(steps.len(), 9);
    assert!(face.exists(domain_element_id("inspector-steps", &key), cx), "the newest Turn opens");
    let toggle = face.label(domain_element_id("inspector-turn-toggle", &key), cx).expect("toggle");
    assert!(
        toggle.starts_with("Turn · ") && toggle.ends_with("cost unknown, Hide steps"),
        "{toggle}"
    );
    let first = format!("{key}/{}", steps[0]);
    assert_eq!(
        face.label(domain_element_id("inspector-pricing-key", &first), cx).as_deref(),
        Some("Unpriced pricing key: openai-compatible:scripted-demo")
    );
    // The failed Read names itself so in its row, not by colour alone.
    let failed = face.view.read_with(cx, |view, _| {
        view.panel().turns[0].steps.iter().filter(|step| step.failed).count()
    });
    assert_eq!(failed, 1);

    // Folded, its steps go; Copy pricing key put the key on the clipboard.
    face.click(domain_element_id("inspector-copy-pricing-key", &first), cx);
    let copied = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
    assert_eq!(copied.as_deref(), Some("openai-compatible:scripted-demo"));
    face.click(domain_element_id("inspector-turn-toggle", &key), cx);
    assert!(!face.exists(domain_element_id("inspector-steps", &key), cx));
}

#[gpui_kit::test]
fn a_task_that_never_ran_says_so(cx: &mut TestAppContext) {
    let face = Face::open(IDLE, cx);
    assert_eq!(
        face.label("inspector-empty", cx).as_deref(),
        Some("Nothing to trace in this task yet. No activity recorded for this task yet.")
    );
    for absent in ["inspector-timeline", "inspector-context", "inspector-cost", "inspector-tokens"]
    {
        assert!(!face.exists(absent, cx), "{absent}");
    }
}

#[gpui_kit::test]
fn unavailable_usage_and_unpriced_calls_read_in_desktops_words(cx: &mut TestAppContext) {
    let transport = ScriptedHost::new();
    transport.reply("usage.query", Ok(summary(6, 2)));
    let face = Face::open_with(transport, PAGES, cx);
    assert_eq!(
        face.label("inspector-usage-unavailable", cx).as_deref(),
        Some("Full-session usage is temporarily unavailable.")
    );
    assert_eq!(face.readout("cost", cx).as_deref(), Some("cost unknown"));
    let key = turn_key("run-6", "turn-run-6");
    let toggle = face.label(domain_element_id("inspector-turn-toggle", &key), cx).expect("toggle");
    assert!(toggle.contains("8.6s · cost unknown"), "{toggle}");
    // A failed summary read shows no old summary, and says so.
    face.transport.reply(
        "usage.query",
        Err(HostRequestError::Operation {
            operation: "usage.query",
            code: HostOperationErrorCode::InternalFailure,
            message: "boom".into(),
        }),
    );
    push(&face.host, usage_changed(PAGES), cx);
    after_debounce(cx);
    face.frame(cx);
    assert!(face.exists("inspector-usage-unavailable", cx));
    assert!(!face.exists("inspector-cost", cx));

    cx.update(|cx| Locale::SimplifiedChinese.apply(cx));
    face.frame(cx);
    let toggle = face.label(domain_element_id("inspector-turn-toggle", &key), cx).expect("toggle");
    assert!(toggle.contains("8.6s · 费用未知"), "{toggle}");
    let first = format!("{key}/call-run-6");
    assert_eq!(
        face.label(domain_element_id("inspector-pricing-key", &first), cx).as_deref(),
        Some("未计价的定价键：openai-compatible:scripted-demo")
    );
    assert_eq!(
        face.label("inspector-usage-unavailable", cx).as_deref(),
        Some(copy::SUMMARY_UNAVAILABLE.in_locale(Locale::SimplifiedChinese))
    );
}

#[gpui_kit::test]
fn load_earlier_pages_back_and_hide_earlier_folds_them(cx: &mut TestAppContext) {
    let face = Face::open(PAGES, cx);
    assert_eq!(face.label("inspector-load-earlier", cx).as_deref(), Some("Load earlier records"));
    face.click("inspector-load-earlier", cx);
    face.click("inspector-load-earlier", cx);
    let turns = face.view.read_with(cx, |view, _| view.panel().turns.len());
    assert_eq!(turns, 6, "newest first, every page");
    assert_eq!(
        face.label("inspector-load-earlier", cx).as_deref(),
        Some("Hide all earlier records")
    );
    face.click("inspector-load-earlier", cx);
    let turns = face.view.read_with(cx, |view, _| view.panel().turns.len());
    assert_eq!(turns, 2);
    // The newest Turn stays open; the ones loaded with the pages arrive
    // folded.
    let open = face.view.read_with(cx, |view, _| view.open_turns().clone());
    assert_eq!(open.into_iter().collect::<Vec<_>>(), [turn_key("run-6", "turn-run-6")]);
}

#[gpui_kit::test]
fn a_failed_read_says_why_and_retry_reads_again(cx: &mut TestAppContext) {
    let transport = ScriptedHost::new();
    transport.reply(
        "execution.inspect.query:session_trace_start",
        Err(HostRequestError::Operation {
            operation: "execution.inspect.query",
            code: HostOperationErrorCode::NotFound,
            message: "Session was not found".into(),
        }),
    );
    let face = Face::open_with(transport, PAGES, cx);
    assert_eq!(
        face.label(status("inspector-failure"), cx).as_deref(),
        Some("Could not read the trace. The Runtime Host refused: Session was not found.")
    );
    assert!(!face.exists("inspector-empty", cx), "a failed read is not an empty task");
    face.click("inspector-retry", cx);
    assert!(!face.exists(status("inspector-failure"), cx));
    let turns = face.view.read_with(cx, |view, _| view.panel().turns.len());
    assert_eq!(turns, 2);
}

#[gpui_kit::test]
fn escape_in_the_face_gives_the_panel_back(cx: &mut TestAppContext) {
    let face = Face::open(PAGES, cx);
    let view = face.view.clone();
    face.with_window(cx, |window, cx| view.update(cx, |view, cx| view.focus(window, cx)));
    face.with_window(cx, |window, cx| window.press("escape", cx));
    assert_eq!(face.events.borrow().as_slice(), [InspectorViewEvent::Dismiss]);
}

/// The recorded Session of many runs pages as the demo Host paged it: 16
/// Turns, then 16 more from the first page's cursor.
#[gpui_kit::test]
fn the_recorded_trace_pages_from_its_cursor(cx: &mut TestAppContext) {
    let face = Face::open(PAGED, cx);
    let turns = face.view.read_with(cx, |view, _| view.panel().turns.len());
    assert_eq!(turns, host_protocol::EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS);
    face.click("inspector-load-earlier", cx);
    let turns = face.view.read_with(cx, |view, _| view.panel().turns.len());
    assert_eq!(turns, 32);
    let continued = face.transport.requests("execution.inspect.query:session_trace_continue");
    assert_eq!(continued.len(), 1);
    assert_eq!(continued[0]["sessionId"], PAGED);
}

/// At the panel's narrowest a Turn's row keeps to the face: its fill starts
/// 8 px in from the face's edges, its text on the content's 16 px line, as
/// the section titles' do, and nothing runs past the trailing edge.
#[gpui_kit::test]
fn a_turn_row_keeps_to_the_content_edges_at_the_narrowest_panel(cx: &mut TestAppContext) {
    let face = Face::open_sized(ScriptedHost::new(), TOOLS, 340., cx);
    let key = face.view.read_with(cx, |view, _| view.panel().turns[0].key());
    let (body, toggle, readout) = face.with_window(cx, |window, _| {
        (
            window.find("inspector-body").bounds(),
            window.find(domain_element_id("inspector-turn-toggle", &key)).bounds(),
            window.find(domain_element_id("inspector-readout", "tokens")).bounds(),
        )
    });
    let rem = 16.;
    let close = |left: gpui_kit::Pixels, right: f32| (f32::from(left) - right).abs() < 0.5;
    assert!(
        close(toggle.left(), f32::from(body.left()) + rem - rem / 2.),
        "{toggle:?} in {body:?}"
    );
    assert!(
        close(toggle.right(), f32::from(body.right()) - rem + rem / 2.),
        "{toggle:?} in {body:?}"
    );
    assert!(readout.right() <= body.right() - px(rem - 0.5), "{readout:?} in {body:?}");
}
