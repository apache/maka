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

//! A side chat against a scripted Host: the first send forks the task
//! through its latest completed Turn (empty when none), the ledger entry
//! on disk before the create goes, a revision conflict sent again; the
//! fork's copied Turns hidden; quotes sent and kept on a failure; a
//! permission prompt answered in the fork; the fork disposed of; and the
//! ledger settling what an ended run left, and nothing it does not hold.

use std::cell::RefCell;
use std::collections::HashSet;
use std::io::Write as _;
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use futures_lite::future::{Boxed, block_on};
use gpui_kit::{SharedString, Task};
use host_protocol::QuoteRef;

use super::*;
use crate::{
    ForkPhase, LEDGER_FILE, LedgerEdit, LedgerFile, LedgerStore, OWNER_LOCKS_DIRECTORY, SideChat,
    SideChatLedger, SideChatPanel,
};

const SOURCE: &str = "s1";
const FORK_SUBSCRIPTION: &str = "sub-fork";

/// A ledger kept in memory: what it saved, which owners still run.
struct MemoryStore {
    owner: String,
    saved: Arc<Mutex<Option<Vec<u8>>>>,
    alive: HashSet<String>,
    released: Arc<Mutex<Vec<String>>>,
}

impl LedgerStore for MemoryStore {
    fn owner(&self) -> SharedString {
        self.owner.clone().into()
    }

    fn load(&self) -> Boxed<std::io::Result<Option<Vec<u8>>>> {
        let saved = self.saved.lock().expect("saved").clone();
        Box::pin(async move { Ok(saved) })
    }

    fn update(&self, edit: LedgerEdit) -> Boxed<std::io::Result<()>> {
        let mut saved = self.saved.lock().expect("saved");
        let result = edit(saved.as_deref()).map(|write| *saved = Some(write.contents));
        Box::pin(async move { result })
    }

    fn is_owner_alive(&self, owner: &str) -> Boxed<bool> {
        let alive = self.alive.contains(owner);
        Box::pin(async move { alive })
    }

    fn release_owner(&self, owner: &str) -> Boxed<()> {
        self.released.lock().expect("released").push(owner.to_owned());
        Box::pin(async {})
    }

    fn sweep_owners(&self, _: Vec<String>) -> Boxed<()> {
        Box::pin(async {})
    }
}

/// The forks a saved ledger holds: `(target, phase)`.
fn saved_forks(saved: &Mutex<Option<Vec<u8>>>) -> Vec<(String, String)> {
    let Some(bytes) = saved.lock().expect("saved").clone() else { return Vec::new() };
    let document: Value = serde_json::from_slice(&bytes).expect("a ledger");
    document["forks"]
        .as_array()
        .expect("forks")
        .iter()
        .map(|fork| {
            (
                fork["targetSessionId"].as_str().expect("target").to_owned(),
                fork["phase"].as_str().expect("phase").to_owned(),
            )
        })
        .collect()
}

/// A catalog projection of `id` at `revision`.
fn projection(id: &str, revision: u64) -> Value {
    json!({
        "id": id, "revision": revision,
        "workspace": {"target": {"kind": "host_path", "path": "/work/demo"}, "hostCwd": "/work/demo"},
        "createdAt": 1, "activityAt": 2, "name": "Plan the release", "isFlagged": false,
        "isArchived": false, "labels": [], "labelsTruncated": false, "hasUnread": false,
        "status": "active", "backend": "ai-sdk", "llmConnectionId": null,
        "llmConnectionSlug": "env", "connectionLocked": false, "model": "m",
        "permissionMode": "ask", "collaborationMode": "agent", "orchestrationMode": "default"
    })
}

/// A side chat's fork of the source through `boundary`.
fn fork_projection(id: &str, boundary: Option<&str>) -> Value {
    let mut fork = projection(id, 2);
    fork["labels"] = json!(["mode:side_conversation"]);
    fork["parentSessionId"] = json!(SOURCE);
    if let Some(boundary) = boundary {
        fork["branchOfTurnId"] = json!(boundary);
    }
    fork
}

/// A contribution of Turn `turn` from `first`, ended `status`.
fn turn(turn: &str, first: u64, status: &str) -> Value {
    json!({
        "turnId": turn, "firstSequence": first,
        "latestState": {"sequence": first + 2, "message": {
            "type": "turn_state", "id": format!("{turn}-end"), "turnId": turn, "ts": first + 2,
            "status": status
        }},
        "userPromptPreview": null
    })
}

/// The rows of settled Turn `turn` from `first`: a prompt and a reply.
fn turn_rows(turn: &str, first: u64) -> Vec<(u64, Value)> {
    vec![
        (
            first,
            json!({"type": "user", "id": turn, "turnId": turn, "ts": first, "text": "Plan it"}),
        ),
        (
            first + 1,
            json!({"type": "assistant", "id": format!("{turn}-a"), "turnId": turn, "ts": first + 1,
                   "text": "Here is the plan.", "contentOrder": ["text"], "modelId": "m"}),
        ),
        (
            first + 2,
            json!({"type": "turn_state", "id": format!("{turn}-end"), "turnId": turn,
                   "ts": first + 2, "status": "completed"}),
        ),
    ]
}

/// `subscription.open` of the fork, its tail holding the copied `rows`.
fn fork_open(fork: &str, rows: &[(u64, Value)]) -> Value {
    let fragments: Vec<Value> = rows
        .iter()
        .rev()
        .map(|(sequence, row)| {
            let bytes = serde_json::to_vec(row).expect("row");
            json!({
                "sequence": sequence, "byteOffset": 0, "totalBytes": bytes.len(),
                "payloadDigest": null,
                "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
            })
        })
        .collect();
    let mut snapshot = snapshot(1, Value::Null, vec![]);
    snapshot["session"]["sessionId"] = json!(fork);
    snapshot["session"]["status"] = json!("active");
    json!({
        "hostEpoch": EPOCH, "subscriptionId": FORK_SUBSCRIPTION, "nextSequence": 30,
        "snapshot": snapshot, "activeAssistantStreams": [],
        "transcript": {"durable": {
            "kind": "page", "sessionId": fork, "direction": "older", "throughSequence": 29,
            "rawBytes": 0, "fragments": fragments, "nextCursor": null, "endsAtTurnBoundary": true
        }}
    })
}

/// What the scripted Host answers for a side chat of [`SOURCE`] whose
/// Turns are `turns`: the first create meets a revision conflict when
/// `conflict`; the fork's tail holds the copied Turns. Records, at each
/// create, whether the ledger on disk already held its target as creating.
struct Script {
    turns: Vec<Value>,
    copied: Vec<(u64, Value)>,
    conflict: bool,
    /// The model the source runs, when not `m`.
    model: Option<&'static str>,
}

/// The source's projection, running `model` when given.
fn source_projection(model: Option<&str>) -> Value {
    let mut source = projection(SOURCE, 5);
    if let Some(model) = model {
        source["model"] = json!(model);
    }
    source
}

struct Recorded {
    fork: Arc<Mutex<Option<String>>>,
    written_first: Arc<Mutex<Vec<bool>>>,
}

fn script(
    transport: &ScriptedHost,
    saved: Arc<Mutex<Option<Vec<u8>>>>,
    script: Script,
) -> Recorded {
    let fork = Arc::new(Mutex::new(None::<String>));
    let written_first = Arc::new(Mutex::new(Vec::new()));
    let creates = AtomicUsize::new(0);
    let (fork_id, written) = (fork.clone(), written_first.clone());
    transport.respond_with(move |operation, input| {
        let fork = fork_id.lock().expect("fork").clone();
        Some(match operation {
            "session.turns.query" => Ok(json!({
                "sessionId": SOURCE, "throughSequence": 40,
                "contributions": script.turns.clone(), "nextPosition": null
            })),
            "session.catalog.query" if input["sessionId"] == SOURCE => {
                Ok(json!({"kind": "session", "session": source_projection(script.model)}))
            }
            "session.catalog.query"
                if fork.is_some() && fork.as_deref() == input["sessionId"].as_str() =>
            {
                let target = fork.clone().expect("fork");
                let mut session = fork_projection(&target, None);
                if let Some(model) = script.model {
                    session["model"] = json!(model);
                }
                Ok(json!({"kind": "session", "session": session}))
            }
            "session.catalog.query" => Ok(json!({"kind": "session", "session": null})),
            "session.branch.create" => {
                let target = input["targetSessionId"].as_str().expect("target").to_owned();
                let on_disk = saved_forks(&saved)
                    .iter()
                    .any(|(id, phase)| *id == target && phase == "creating");
                written.lock().expect("written").push(on_disk);
                if script.conflict && creates.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Some(Ok(json!({"kind": "source_revision_conflict",
                                          "expectedRevision": 5, "actualRevision": 6})));
                }
                *fork_id.lock().expect("fork") = Some(target.clone());
                let boundary = input["sourceTurnId"].as_str();
                let mut session = fork_projection(&target, boundary);
                if let Some(model) = script.model {
                    session["model"] = json!(model);
                }
                Ok(json!({"kind": "committed", "session": session}))
            }
            "subscription.open" => {
                Ok(fork_open(input["sessionId"].as_str().expect("id"), &script.copied))
            }
            "turn.message.submit" => Ok(json!({
                "disposition": "turn_started",
                "turnId": format!("turn-{}", input["messageId"].as_str().expect("messageId")),
                "skillInvocation": {"loaded": [], "failed": [], "receipts": []}
            })),
            "session.remove" => Ok(json!({"kind": "removed", "sessionId": input["sessionId"]})),
            _ => return None,
        })
    });
    Recorded { fork, written_first }
}

struct Bench {
    transport: Arc<ScriptedHost>,
    host: Entity<HostSession>,
    chat: Entity<SideChat>,
    panel: Entity<SideChatPanel>,
    window: WindowHandle<Root>,
    saved: Arc<Mutex<Option<Vec<u8>>>>,
}

impl Bench {
    fn open(
        transport: Arc<ScriptedHost>,
        saved: Arc<Mutex<Option<Vec<u8>>>>,
        cx: &mut TestAppContext,
    ) -> Self {
        Self::open_at(transport, saved, px(420.), cx)
    }

    /// The panel `width` wide, as the workbar gives it.
    fn open_at(
        transport: Arc<ScriptedHost>,
        saved: Arc<Mutex<Option<Vec<u8>>>>,
        width: Pixels,
        cx: &mut TestAppContext,
    ) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
        });
        let store = MemoryStore {
            owner: "me".to_owned(),
            saved: saved.clone(),
            alive: HashSet::new(),
            released: Arc::new(Mutex::new(Vec::new())),
        };
        cx.update(|cx| {
            SideChatLedger::global(cx).update(cx, |ledger, cx| ledger.restore(Rc::new(store), cx))
        });
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone())
        });
        host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted(EPOCH) }),
                cx,
            )
        });
        let chat = cx.new(|cx| SideChat::new(SOURCE.into(), host.clone(), cx));
        let mut panel = None;
        let window = cx.open_window(size(width, px(800.)), |window, cx| {
            let connections = cx.new(|cx| ConnectionCatalog::new(host.clone(), cx));
            let projects = cx.new(|cx| {
                let source = std::rc::Rc::new(workspace::UnavailableProjectCatalog);
                ProjectSelection::new(host.clone(), source, cx)
            });
            let view =
                cx.new(|cx| SideChatPanel::new(chat.clone(), connections, projects, window, cx));
            panel = Some(view.clone());
            Root::new(view, window, cx)
        });
        settle(cx);
        Self { transport, host, chat, panel: panel.expect("panel"), window, saved }
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

    /// Types `text` in the side chat's composer and presses Enter.
    fn send(&self, text: &str, cx: &mut TestAppContext) {
        let composer = self.panel.read_with(cx, |panel, _| panel.composer().clone());
        self.with_window(cx, |window, cx| {
            composer.update(cx, |composer, cx| composer.fill(text, window, cx));
        });
        self.with_window(cx, |window, cx| window.press("enter", cx));
        settle(cx);
        self.with_window(cx, |_, _| {});
    }

    fn push(&self, frame: PushFrame, cx: &mut TestAppContext) {
        self.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Push(frame), cx));
        settle(cx);
    }

    fn operations(&self) -> Vec<String> {
        self.transport.operations()
    }

    fn ledger(&self, cx: &mut TestAppContext) -> Vec<(String, ForkPhase)> {
        cx.update(|cx| {
            SideChatLedger::global(cx)
                .read(cx)
                .entries()
                .iter()
                .map(|entry| (entry.target_session_id.clone(), entry.phase))
                .collect()
        })
    }

    fn quotes(&self, cx: &mut TestAppContext) -> Vec<String> {
        self.chat.read_with(cx, |chat, _| {
            chat.quotes().iter().map(|staged| staged.quote.text.clone()).collect()
        })
    }
}

/// The position of the first request for `operation` (on `session` when
/// given).
fn position(operations: &[String], operation: &str) -> usize {
    operations.iter().position(|op| op == operation).unwrap_or_else(|| panic!("no {operation}"))
}

#[gpui_kit::test]
fn the_first_send_forks_through_the_latest_completed_turn_then_sends(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let saved = Arc::new(Mutex::new(None));
    let mut copied = turn_rows("t1", 1);
    copied.extend(turn_rows("t2", 10));
    let recorded = script(
        &transport,
        saved.clone(),
        Script {
            turns: vec![
                turn("t1", 1, "completed"),
                turn("t2", 10, "completed"),
                turn("t3", 20, "failed"),
            ],
            copied,
            conflict: true,
            model: None,
        },
    );
    let bench = Bench::open(transport, saved, cx);
    // Before the fork the composer shows the task's model and mode.
    bench.with_window(cx, |window, _| {
        assert!(window.find("side-chat-empty").visible(), "Desktop's blank region");
        assert_eq!(window.find("composer-model").label(), Some("Model: m"));
        assert!(window.try_find("composer-project").is_none(), "no project chip");
    });
    bench.send("What does the plan leave out?", cx);

    let fork = recorded.fork.lock().expect("fork").clone().expect("a fork was made");
    let operations = bench.operations();
    assert!(
        position(&operations, "session.turns.query")
            < position(&operations, "session.branch.create")
    );
    assert!(
        position(&operations, "session.branch.create") < position(&operations, "subscription.open")
    );
    assert!(
        position(&operations, "subscription.open") < position(&operations, "turn.message.submit")
    );
    let creates = bench.transport.requests("session.branch.create");
    assert_eq!(creates.len(), 2, "the conflict was sent again");
    for create in &creates {
        assert_eq!(create["sourceSessionId"], SOURCE);
        assert_eq!(create["targetSessionId"], fork.as_str());
        assert_eq!(create["sourceTurnId"], "t2", "the latest completed turn, not the failed one");
        assert_eq!(create["intent"], "side_conversation");
    }
    assert_eq!(creates[0]["expectedSourceRevision"], 5);
    assert_eq!(creates[1]["expectedSourceRevision"], 6, "at the revision the Host named");
    assert_eq!(
        *recorded.written_first.lock().expect("written"),
        [true, true],
        "the ledger held the fork on disk before each create went"
    );
    assert_eq!(bench.ledger(cx), [(fork.clone(), ForkPhase::Live)]);
    assert_eq!(saved_forks(&bench.saved), [(fork.clone(), "live".to_owned())]);

    let submits = bench.transport.requests("turn.message.submit");
    assert_eq!(submits.len(), 1);
    assert_eq!(submits[0]["sessionId"], fork.as_str());
    assert_eq!(submits[0]["content"]["text"], "What does the plan leave out?");
    // The copied Turns are the fork's context: no rows, no history row.
    bench.with_window(cx, |window, _| {
        assert!(window.try_find(item_element_id("t1", &ItemKey::User("t1".into()))).is_none());
        assert!(window.try_find(item_element_id("t2", &ItemKey::User("t2".into()))).is_none());
        assert!(window.try_find("side-chat-empty").is_some(), "nothing of its own yet");
    });
    assert!(bench.chat.read_with(cx, |chat, _| chat.has_content()));
    bench.panel.read_with(cx, |panel, cx| {
        assert_eq!(panel.composer().read(cx).draft().read(cx).value().as_ref(), "", "sent");
    });
}

#[gpui_kit::test]
fn a_task_with_no_completed_turn_forks_empty(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let saved = Arc::new(Mutex::new(None));
    script(
        &transport,
        saved.clone(),
        Script {
            turns: vec![turn("t1", 1, "running")],
            copied: Vec::new(),
            conflict: false,
            model: None,
        },
    );
    let bench = Bench::open(transport, saved, cx);
    bench.send("Hi", cx);
    let creates = bench.transport.requests("session.branch.create");
    assert_eq!(creates.len(), 1);
    assert!(creates[0].get("sourceTurnId").is_none(), "an empty fork: {}", creates[0]);
    assert_eq!(bench.transport.requests("turn.message.submit").len(), 1);
}

#[gpui_kit::test]
fn quotes_go_with_the_send_and_stay_when_it_fails(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let saved = Arc::new(Mutex::new(None));
    script(
        &transport,
        saved.clone(),
        Script {
            turns: vec![turn("t1", 1, "completed")],
            copied: turn_rows("t1", 1),
            conflict: false,
            model: None,
        },
    );
    // The first message is refused; the second goes.
    transport.reply(
        "turn.message.submit",
        Err(HostRequestError::Operation {
            operation: "turn.message.submit",
            code: host_protocol::HostOperationErrorCode::InvalidRequest,
            message: "refused".into(),
        }),
    );
    let bench = Bench::open(transport, saved, cx);
    bench.chat.update(cx, |chat, cx| {
        chat.stage_quote(QuoteRef::new("the plan").with_source_turn_id(Some("t1".into())), cx);
        chat.stage_quote(QuoteRef::new("  the   risks  "), cx);
    });
    bench.with_window(cx, |window, _| {
        assert!(window.find("composer-quotes").visible(), "the chips above the draft");
    });
    bench.send("Why these?", cx);
    assert_eq!(bench.quotes(cx), ["the plan", "the   risks"], "a failed send keeps them");
    let submits = bench.transport.requests("turn.message.submit");
    assert_eq!(
        submits[0]["content"]["quotes"],
        json!([{"text": "the plan", "sourceTurnId": "t1"}, {"text": "the   risks"}])
    );
    // A chip's × takes one off; the next send carries the rest and clears it.
    let removed = bench.chat.read_with(cx, |chat, _| chat.quotes()[1].id);
    bench.with_window(cx, |window, cx| {
        window
            .within(shared::domain_element_id("staged-quote", &removed.to_string()))
            .click("quote-remove", cx);
    });
    assert_eq!(bench.quotes(cx), ["the plan"]);
    bench.send("Why these?", cx);
    let submits = bench.transport.requests("turn.message.submit");
    assert_eq!(submits.len(), 2);
    assert_eq!(
        submits[1]["content"]["quotes"],
        json!([{"text": "the plan", "sourceTurnId": "t1"}])
    );
    assert!(bench.quotes(cx).is_empty(), "the Host took them");
}

/// Frames of the fork's subscription.
struct ForkFrames {
    fork: String,
    sequence: u64,
    revision: u64,
}

impl ForkFrames {
    fn next(&mut self, kind: &str, fields: Value) -> PushFrame {
        let mut value = json!({"kind": kind, "hostEpoch": EPOCH,
                               "subscriptionId": FORK_SUBSCRIPTION, "sequence": self.sequence});
        for (key, field) in fields.as_object().expect("object") {
            value[key] = field.clone();
        }
        self.sequence += 1;
        frame(value)
    }

    fn projection(&mut self, root: Value, pending: Vec<Value>) -> PushFrame {
        self.revision += 1;
        let mut snapshot = snapshot(self.revision, root, pending);
        snapshot["session"]["sessionId"] = json!(self.fork);
        self.next("subscription.session_projection", json!({"snapshot": snapshot}))
    }
}

#[gpui_kit::test]
fn a_permission_prompt_in_the_side_chat_is_answered_on_the_fork(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let saved = Arc::new(Mutex::new(None));
    let recorded = script(
        &transport,
        saved.clone(),
        Script {
            turns: vec![turn("t1", 1, "completed")],
            copied: turn_rows("t1", 1),
            conflict: false,
            model: None,
        },
    );
    let bench = Bench::open(transport, saved, cx);
    bench.send("List the files", cx);
    let fork = recorded.fork.lock().expect("fork").clone().expect("fork");
    let submit = bench.transport.requests("turn.message.submit").remove(0);
    let message = submit["messageId"].as_str().expect("message").to_owned();
    let own = format!("turn-{message}");
    let root = json!({"sessionId": fork, "turnId": own, "runId": "run-f", "status": "running"});
    let prompt =
        json!({"type": "user", "id": message, "turnId": own, "ts": 40, "text": "List the files"});
    let page = json!({
        "kind": "page", "sessionId": fork, "direction": "newer", "throughSequence": 40,
        "rawBytes": 0, "nextCursor": null, "endsAtTurnBoundary": true,
        "fragments": [{
            "sequence": 40, "byteOffset": 0,
            "totalBytes": serde_json::to_vec(&prompt).expect("row").len(), "payloadDigest": null,
            "data": base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&prompt).expect("row"))
        }]
    });
    bench.transport.reply("session.transcript.page", Ok(page));
    let mut frames = ForkFrames { fork: fork.clone(), sequence: 30, revision: 1 };
    bench.push(frames.projection(root.clone(), vec![]), cx);
    bench.push(
        frames.next(
            "subscription.transcript_advanced",
            json!({"sessionId": fork, "throughSequence": 40}),
        ),
        cx,
    );
    let mut pending = interaction(permission_request(), "pending", Value::Null);
    pending["sessionId"] = json!(fork);
    pending["turnId"] = json!(own);
    pending["runId"] = json!("run-f");
    let mut waiting = root.clone();
    waiting["status"] = json!("waiting_for_user");
    bench.push(frames.projection(waiting, vec![pending]), cx);
    let prompt_row = item_element_id(&own, &ItemKey::Interaction("i1".into()));
    bench.with_window(cx, |window, _| {
        assert!(window.find(item_element_id(&own, &ItemKey::User(message.clone()))).visible());
        assert_eq!(
            window.within(prompt_row.clone()).find("prompt-title").label(),
            Some("Allow Bash?")
        );
    });
    bench.transport.hold("interaction.answer");
    bench.with_window(cx, |window, cx| window.within(prompt_row.clone()).click("allow", cx));
    assert_eq!(
        bench.transport.requests("interaction.answer"),
        [json!({"sessionId": fork, "interactionId": "i1",
                "answer": {"kind": "permission", "decision": "allow", "rememberForTurn": false}})]
    );
}

#[gpui_kit::test]
fn disposing_of_a_side_chat_removes_its_fork_and_settles_the_ledger(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let saved = Arc::new(Mutex::new(None));
    let recorded = script(
        &transport,
        saved.clone(),
        Script {
            turns: vec![turn("t1", 1, "completed")],
            copied: turn_rows("t1", 1),
            conflict: false,
            model: None,
        },
    );
    let bench = Bench::open(transport, saved, cx);
    bench.send("Hi", cx);
    let fork = recorded.fork.lock().expect("fork").clone().expect("fork");
    let disposed = bench.chat.update(cx, |chat, cx| chat.dispose(cx));
    let removed = Rc::new(std::cell::Cell::new(None));
    let answer = removed.clone();
    cx.update(|cx| cx.spawn(async move |_| answer.set(Some(disposed.await))).detach());
    settle(cx);
    assert_eq!(removed.get(), Some(true), "the fork is gone");
    let removes = bench.transport.requests("session.remove");
    assert_eq!(removes, [json!({"sessionId": fork, "expectedRevision": 2})]);
    assert!(bench.ledger(cx).is_empty(), "settled");
    assert!(saved_forks(&bench.saved).is_empty());
    assert!(bench.transport.requests("subscription.close").len() == 1, "its conversation closed");
}

#[gpui_kit::test]
fn a_leftover_entry_is_settled_and_forks_the_ledger_does_not_hold_stay(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init(cx);
    });
    let leftover = |target: &str, owner: &str, root: &str, phase: &str| {
        json!({"rootId": root, "owner": owner, "targetSessionId": target,
               "sourceSessionId": SOURCE, "sourceTurnId": "t1", "phase": phase})
    };
    let document = json!({"version": 1, "forks": [
        leftover("f-creating", "ended", "r", "creating"),
        leftover("f-live", "ended", "r", "live"),
        leftover("f-elsewhere", "ended", "other-root", "live"),
        leftover("f-running-client", "running", "r", "live"),
    ]});
    let saved = Arc::new(Mutex::new(Some(serde_json::to_vec(&document).expect("json"))));
    let released = Arc::new(Mutex::new(Vec::new()));
    let store = MemoryStore {
        owner: "me".to_owned(),
        saved: saved.clone(),
        alive: HashSet::from(["running".to_owned()]),
        released: released.clone(),
    };
    let transport = Arc::new(ScriptedHost::default());
    // f-live runs a Turn; f-creating was made by the create sent again;
    // f-foreign is another client's fork, which the ledger does not hold.
    let mut running = fork_projection("f-live", Some("t1"));
    running["liveRunState"] = json!({"schemaVersion": 1, "runningTurnIds": ["tf"]});
    let removed = Arc::new(Mutex::new(HashSet::<String>::new()));
    let gone = removed.clone();
    transport.respond_with(move |operation, input| {
        let id = input["sessionId"].as_str().unwrap_or_default().to_owned();
        Some(match operation {
            "session.catalog.query" if id == SOURCE => {
                Ok(json!({"kind": "session", "session": projection(SOURCE, 5)}))
            }
            "session.catalog.query" if gone.lock().expect("gone").contains(&id) => {
                Ok(json!({"kind": "session", "session": null}))
            }
            "session.catalog.query" if id == "f-live" => {
                Ok(json!({"kind": "session", "session": running.clone()}))
            }
            "session.catalog.query" if id == "f-creating" => {
                Ok(json!({"kind": "session", "session": fork_projection("f-creating", Some("t1"))}))
            }
            "session.branch.create" => {
                let target = input["targetSessionId"].as_str().expect("target");
                Ok(json!({"kind": "committed", "session": fork_projection(target, Some("t1"))}))
            }
            "turn.query" => Ok(json!({"sessionId": id, "turnId": "tf", "runId": "run-tf",
                                      "status": "running"})),
            "turn.stop" => Ok(json!({"sessionId": id, "turnId": "tf", "runId": "run-tf",
                                     "status": "cancelled", "terminalEventId": "end"})),
            "session.remove" => {
                gone.lock().expect("gone").insert(id.clone());
                Ok(json!({"kind": "removed", "sessionId": id}))
            }
            _ => return None,
        })
    });
    let host =
        cx.new(|_| HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone()));
    let ledger = cx.update(|cx| SideChatLedger::global(cx));
    ledger.update(cx, |ledger, cx| ledger.restore(Rc::new(store), cx));
    settle(cx);
    // Nothing is settled before a window connects to the root.
    assert!(transport.operations().is_empty());
    let requester = host.read_with(cx, |host, _| host.requester());
    ledger.update(cx, |ledger, cx| ledger.connected("r", requester, cx));
    settle(cx);

    let creates = transport.requests("session.branch.create");
    assert_eq!(creates.len(), 1, "only the entry still creating replays its create");
    assert_eq!(creates[0]["targetSessionId"], "f-creating");
    assert_eq!(creates[0]["sourceTurnId"], "t1");
    assert_eq!(creates[0]["expectedSourceRevision"], 5);
    let stops = transport.requests("turn.stop");
    assert_eq!(stops, [json!({"sessionId": "f-live", "turnId": "tf", "runId": "run-tf"})]);
    let removes: HashSet<String> = transport
        .requests("session.remove")
        .iter()
        .map(|input| input["sessionId"].as_str().expect("id").to_owned())
        .collect();
    assert_eq!(removes, HashSet::from(["f-creating".to_owned(), "f-live".to_owned()]));
    let named: Vec<Value> = transport.requests("session.catalog.query");
    assert!(
        !named.iter().any(|input| {
            ["f-elsewhere", "f-running-client", "f-foreign"]
                .contains(&input["sessionId"].as_str().unwrap_or_default())
        }),
        "another root's entry, a running client's, and a fork it does not hold are left alone"
    );
    let left: Vec<String> = ledger.read_with(cx, |ledger, _| {
        ledger.entries().iter().map(|entry| entry.target_session_id.clone()).collect()
    });
    assert_eq!(left, ["f-elsewhere", "f-running-client"]);
    assert_eq!(
        saved_forks(&saved).into_iter().map(|(id, _)| id).collect::<Vec<_>>(),
        ["f-elsewhere", "f-running-client"]
    );
    // The ended client still has an entry for another root: its lock stays.
    assert!(released.lock().expect("released").is_empty());
}

#[gpui_kit::test]
fn a_user_row_shows_the_quotes_it_carries_and_opens_one_whole(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let user = json!({
        "type": "user", "id": "t1", "turnId": "t1", "ts": 1, "text": "Why?",
        "quotes": [
            {"text": "### The plan\nship   on Friday", "label": "Plan", "comment": "still right?"},
            {"text": "the risks", "sourceTurnId": "t0"}
        ]
    });
    let mut open = open_result_for(SESSION, SUBSCRIPTION);
    let bytes = serde_json::to_vec(&user).expect("row");
    open["transcript"]["durable"]["fragments"] = json!([{
        "sequence": 1, "byteOffset": 0, "totalBytes": bytes.len(), "payloadDigest": null,
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
    }]);
    transport.reply("subscription.open", Ok(open));
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    let RowBody::User { quotes, .. } = &harness.rows(cx)[0] else { panic!("a user row") };
    assert_eq!(quotes.len(), 2);
    assert_eq!(quotes[0].text, "The plan ship on Friday", "folded, its heading mark gone");
    assert_eq!(quotes[0].label.as_deref(), Some("Plan"));
    let first = shared::domain_element_id("sent-quote", &quotes[0].key);
    let key = quotes[0].key.clone();
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find(first.clone()).label(),
            Some("Quote, Plan: The plan ship on Friday, still right?")
        );
    });
    harness.with_window(cx, |window, cx| window.click(first.clone(), cx));
    let RowBody::User { quotes, .. } = &harness.rows(cx)[0] else { panic!("a user row") };
    assert!(quotes[0].expanded && quotes[0].key == key, "opened whole");
    assert!(!quotes[1].expanded);
}

/// Raises a permission prompt in the fork's own Turn, after a long user
/// message and a Tool call, with the task's model named long.
fn prompt_in_the_fork(bench: &Bench, fork: &str, cx: &mut TestAppContext) -> (String, String) {
    let submit = bench.transport.requests("turn.message.submit").remove(0);
    let message = submit["messageId"].as_str().expect("message").to_owned();
    let own = format!("turn-{message}");
    let root = json!({"sessionId": fork, "turnId": own, "runId": "run-f", "status": "running"});
    let prompt = json!({"type": "user", "id": message, "turnId": own, "ts": 40,
                        "text": "Look at every file under crates and tell me which ones changed"});
    let bytes = serde_json::to_vec(&prompt).expect("row");
    let page = json!({
        "kind": "page", "sessionId": fork, "direction": "newer", "throughSequence": 40,
        "rawBytes": 0, "nextCursor": null, "endsAtTurnBoundary": true,
        "fragments": [{"sequence": 40, "byteOffset": 0, "totalBytes": bytes.len(),
                       "payloadDigest": null,
                       "data": base64::engine::general_purpose::STANDARD.encode(&bytes)}]
    });
    bench.transport.reply("session.transcript.page", Ok(page));
    let mut frames = ForkFrames { fork: fork.to_owned(), sequence: 30, revision: 1 };
    bench.push(frames.projection(root.clone(), vec![]), cx);
    bench.push(
        frames.next(
            "subscription.transcript_advanced",
            json!({"sessionId": fork, "throughSequence": 40}),
        ),
        cx,
    );
    bench.push(
        frames.next("subscription.session_event", json!({"sessionId": fork, "runId": "run-f", "event": {
            "type": "tool_start", "id": "e1", "turnId": own, "ts": 41, "toolUseId": "c1",
            "toolName": "Bash", "activityKind": "command",
            "argsPreview": {"command": "git status --porcelain && git diff --stat"}, "stepId": "s1"
        }})),
        cx,
    );
    let mut pending = interaction(permission_request(), "pending", Value::Null);
    pending["sessionId"] = json!(fork);
    pending["turnId"] = json!(own);
    pending["runId"] = json!("run-f");
    let mut waiting = root;
    waiting["status"] = json!("waiting_for_user");
    bench.push(frames.projection(waiting, vec![pending]), cx);
    (message, own)
}

#[gpui_kit::test]
fn the_side_chat_fits_the_workbars_narrowest_width(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let saved = Arc::new(Mutex::new(None));
    let recorded = script(
        &transport,
        saved.clone(),
        Script {
            turns: vec![turn("t1", 1, "completed")],
            copied: turn_rows("t1", 1),
            conflict: false,
            model: Some("claude-sonnet-4-5-20250929-thinking-extended"),
        },
    );
    // The workbar's narrowest: 340 pt.
    let bench = Bench::open_at(transport, saved, px(340.), cx);
    bench.chat.update(cx, |chat, cx| {
        chat.stage_quote(
            QuoteRef::new("a long excerpt of the plan that runs well past the width"),
            cx,
        );
    });
    bench.send("Which files changed?", cx);
    let fork = recorded.fork.lock().expect("fork").clone().expect("fork");
    let (_, own) = prompt_in_the_fork(&bench, &fork, cx);
    let prompt_row = item_element_id(&own, &ItemKey::Interaction("i1".into()));
    bench.with_window(cx, |window, _| {
        let width = window.viewport_size().width;
        let inside = |what: &str, bounds: gpui_kit::Bounds<Pixels>| {
            assert!(
                bounds.left() >= px(0.) && bounds.right() <= width,
                "{what} spills out of the {width:?} panel: {bounds:?}"
            );
        };
        assert_eq!(
            window.find("composer-model").label(),
            Some("Model: claude-sonnet-4-5-20250929-thinking-extended"),
            "the fork's model, whole in its name"
        );
        for id in ["stop-turn", "composer-attach", "composer-model", "composer-permission-mode"] {
            inside(id, window.find(id).bounds());
        }
        let prompt = window.within(prompt_row.clone());
        for id in ["allow", "deny", "prompt-waiting", "prompt-title"] {
            inside(id, prompt.find(id).bounds());
        }
    });
}

/// A fresh directory under the system's temporary one.
fn scratch_dir() -> PathBuf {
    std::env::temp_dir().join(format!("maka-side-chats-{}", uuid::Uuid::new_v4().simple()))
}

/// Writes `contents` to the file at `path`.
fn write_file(path: &Path, contents: &[u8]) {
    std::fs::create_dir_all(path.parent().expect("a directory")).expect("the directory");
    let mut file = std::fs::File::create(path).expect("the file");
    file.write_all(contents).expect("written");
}

/// The bytes of the file at `path`.
#[allow(clippy::disallowed_methods)] // A test.
fn read_file(path: &Path) -> Vec<u8> {
    std::fs::read(path).expect("the file")
}

/// The forks the ledger file at `path` holds.
fn file_forks(path: &Path) -> Vec<Value> {
    let document: Value = serde_json::from_slice(&read_file(path)).expect("a ledger");
    document["forks"].as_array().expect("forks").clone()
}

/// The targets of the forks the ledger file at `path` holds, sorted.
fn file_targets(path: &Path) -> Vec<String> {
    let mut targets: Vec<String> = file_forks(path)
        .iter()
        .map(|fork| fork["targetSessionId"].as_str().expect("a target").to_owned())
        .collect();
    targets.sort();
    targets
}

/// An entry of run `owner`'s for a fork of [`SOURCE`] on the root `r`.
fn ledger_entry(target: &str, owner: &str, phase: &str) -> Value {
    json!({"rootId": "r", "owner": owner, "targetSessionId": target,
           "sourceSessionId": SOURCE, "phase": phase})
}

/// Runs the app, and the threads the ledger file's work runs on, until
/// `done`.
#[allow(clippy::disallowed_methods)] // A test waits for the blocking pool.
fn wait_until(cx: &mut TestAppContext, mut done: impl FnMut(&mut TestAppContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// What `task` answers, once it does.
fn wait_for<T: 'static>(task: Task<T>, cx: &mut TestAppContext) -> T {
    let answer = Rc::new(RefCell::new(None));
    let slot = answer.clone();
    cx.update(|cx| cx.spawn(async move |_| *slot.borrow_mut() = Some(task.await)).detach());
    wait_until(cx, |_| answer.borrow().is_some());
    answer.borrow_mut().take().expect("answered")
}

/// A ledger on the file at `path`, as a run of the app opens it.
fn open_ledger(path: &Path, cx: &mut TestAppContext) -> Entity<SideChatLedger> {
    let owners = path.with_file_name(OWNER_LOCKS_DIRECTORY);
    let file = block_on(LedgerFile::open(path.to_owned(), owners)).expect("a ledger");
    let ledger = cx.new(|_| SideChatLedger::in_memory());
    ledger.update(cx, |ledger, cx| ledger.restore(Rc::new(file), cx));
    ledger
}

/// Writes down the fork `target` in `ledger`, as a side chat does before
/// its create; answers once it is saved.
fn begin(ledger: &Entity<SideChatLedger>, target: &str, cx: &mut TestAppContext) {
    let written = ledger
        .update(cx, |ledger, cx| ledger.begin("r".into(), target.into(), SOURCE.into(), None, cx));
    wait_for(written, cx).expect("saved");
}

#[gpui_kit::test]
fn two_runs_on_one_ledger_file_keep_each_others_forks(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init(cx);
    });
    let directory = scratch_dir();
    let path = directory.join(LEDGER_FILE);
    // What an ended run left.
    let left = json!({"version": 1, "forks": [ledger_entry("f-ended", "0ended", "live")]});
    write_file(&path, &serde_json::to_vec(&left).expect("json"));
    let first = open_ledger(&path, cx);
    let second = open_ledger(&path, cx);
    begin(&first, "f-x", cx);
    begin(&second, "f-y", cx);
    begin(&first, "f-z", cx);
    assert_eq!(file_targets(&path), ["f-ended", "f-x", "f-y", "f-z"], "each run's forks kept");

    // The first settles the ended run's fork: it leaves the file, the
    // second's stay.
    let transport = Arc::new(ScriptedHost::default());
    let removed = Arc::new(Mutex::new(false));
    let gone = removed.clone();
    transport.respond_with(move |operation, input| {
        Some(match operation {
            "session.catalog.query" if !*gone.lock().expect("gone") => {
                Ok(json!({"kind": "session", "session": fork_projection("f-ended", None)}))
            }
            "session.catalog.query" => Ok(json!({"kind": "session", "session": null})),
            "session.remove" => {
                *gone.lock().expect("gone") = true;
                Ok(json!({"kind": "removed", "sessionId": input["sessionId"]}))
            }
            _ => return None,
        })
    });
    let host =
        cx.new(|_| HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone()));
    let requester = host.read_with(cx, |host, _| host.requester());
    first.update(cx, |ledger, cx| ledger.connected("r", requester, cx));
    wait_until(cx, |cx| !first.read_with(cx, |ledger, _| ledger.holds("f-ended")));
    // A save after the settlement's: once it is on disk, so is that one.
    let saved = first.update(cx, |ledger, cx| ledger.forget("f-unknown", cx));
    wait_for(saved, cx).expect("saved");
    assert!(*removed.lock().expect("removed"));
    assert_eq!(file_targets(&path), ["f-x", "f-y", "f-z"]);

    // The second, which read the ended run's fork too, does not write it
    // back.
    begin(&second, "f-w", cx);
    assert_eq!(file_targets(&path), ["f-w", "f-x", "f-y", "f-z"]);
    std::fs::remove_dir_all(&directory).ok();
}

#[gpui_kit::test]
fn a_ledger_this_client_cannot_read_is_never_overwritten(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init(cx);
    });
    // A document that does not parse is set aside as it was.
    let directory = scratch_dir();
    let path = directory.join(LEDGER_FILE);
    let torn = br#"{"version": 1, "forks": [{"rootId": "r", "#;
    write_file(&path, torn);
    let ledger = open_ledger(&path, cx);
    begin(&ledger, "f-x", cx);
    assert_eq!(file_targets(&path), ["f-x"]);
    #[allow(clippy::disallowed_methods)] // A test.
    let aside: Vec<PathBuf> = std::fs::read_dir(&directory)
        .expect("the directory")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name().is_some_and(|name| {
                name.to_string_lossy().starts_with(&format!("{LEDGER_FILE}.unreadable-"))
            })
        })
        .collect();
    assert_eq!(aside.len(), 1, "kept aside: {aside:?}");
    assert_eq!(read_file(&aside[0]), torn);
    std::fs::remove_dir_all(&directory).ok();

    // A newer client's entries, with a phase and a field this one does not
    // know, stay as they are; it settles only those it reads.
    let directory = scratch_dir();
    let path = directory.join(LEDGER_FILE);
    let mut newer = ledger_entry("f-newer", "0ended", "archived");
    newer["pinned"] = json!(true);
    let mut known = ledger_entry("f-known", "0ended", "live");
    known["pinned"] = json!(true);
    let document = json!({"version": 1, "forks": [newer.clone(), known.clone()]});
    write_file(&path, &serde_json::to_vec(&document).expect("json"));
    let ledger = open_ledger(&path, cx);
    begin(&ledger, "f-x", cx);
    ledger.read_with(cx, |ledger, _| {
        assert!(!ledger.holds("f-newer") && ledger.holds("f-known"));
    });
    let forks = file_forks(&path);
    assert_eq!(forks.len(), 3);
    assert!(forks.contains(&newer) && forks.contains(&known), "as they were: {forks:?}");
    std::fs::remove_dir_all(&directory).ok();

    // A ledger the read fails on is not written this run; side chats keep
    // theirs in memory.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let directory = scratch_dir();
        let path = directory.join(LEDGER_FILE);
        let contents = serde_json::to_vec(&json!({"version": 1, "forks": [known]})).expect("json");
        write_file(&path, &contents);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).expect("locked");
        // Unless the tests run as a user every file opens for.
        if std::fs::File::open(&path).is_err() {
            let ledger = open_ledger(&path, cx);
            begin(&ledger, "f-x", cx);
            assert!(ledger.read_with(cx, |ledger, _| ledger.holds("f-x")), "kept in memory");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("open");
            assert_eq!(read_file(&path), contents, "not written");
        }
        std::fs::remove_dir_all(&directory).ok();
    }
}

/// The Host's `operation_conflict` for `session.branch.create`.
fn create_conflict() -> Result<Value, HostRequestError> {
    Err(HostRequestError::Operation {
        operation: "session.branch.create",
        code: host_protocol::HostOperationErrorCode::OperationConflict,
        message: "Target Session identity belongs to a different request".into(),
    })
}

#[gpui_kit::test]
fn a_create_refused_as_a_conflict_is_settled_and_the_next_send_names_a_new_fork(
    cx: &mut TestAppContext,
) {
    let transport = Arc::new(ScriptedHost::default());
    let saved = Arc::new(Mutex::new(None));
    let recorded = script(
        &transport,
        saved.clone(),
        Script {
            turns: vec![turn("t1", 1, "completed")],
            copied: turn_rows("t1", 1),
            conflict: false,
            model: None,
        },
    );
    transport.reply("session.branch.create", create_conflict());
    let bench = Bench::open(transport, saved, cx);
    bench.send("Hi", cx);
    assert!(bench.transport.requests("turn.message.submit").is_empty());
    assert!(bench.ledger(cx).is_empty(), "the Host made nothing");
    assert!(saved_forks(&bench.saved).is_empty());

    bench.send("Hi", cx);
    let fork = recorded.fork.lock().expect("fork").clone().expect("a fork was made");
    let creates = bench.transport.requests("session.branch.create");
    assert_eq!(creates.len(), 2);
    assert_ne!(creates[0]["targetSessionId"], creates[1]["targetSessionId"], "a new target");
    assert_eq!(creates[1]["targetSessionId"], fork.as_str());
    assert_eq!(bench.transport.requests("turn.message.submit").len(), 1);
    assert!(
        bench.transport.requests("session.remove").is_empty(),
        "a Session at the refused target is not this side chat's"
    );
    assert_eq!(bench.ledger(cx), [(fork, ForkPhase::Live)]);
}

#[gpui_kit::test]
fn a_leftover_whose_create_conflicts_is_settled_without_a_removal(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init(cx);
    });
    let document = json!({"version": 1, "forks": [ledger_entry("f-taken", "ended", "creating")]});
    let saved = Arc::new(Mutex::new(Some(serde_json::to_vec(&document).expect("json"))));
    let store = MemoryStore {
        owner: "me".to_owned(),
        saved: saved.clone(),
        alive: HashSet::new(),
        released: Arc::new(Mutex::new(Vec::new())),
    };
    let transport = Arc::new(ScriptedHost::default());
    transport.respond_with(move |operation, input| match operation {
        "session.catalog.query" if input["sessionId"] == SOURCE => {
            Some(Ok(json!({"kind": "session", "session": projection(SOURCE, 5)})))
        }
        "session.branch.create" => Some(create_conflict()),
        _ => None,
    });
    let host =
        cx.new(|_| HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone()));
    let ledger = cx.update(|cx| SideChatLedger::global(cx));
    ledger.update(cx, |ledger, cx| ledger.restore(Rc::new(store), cx));
    settle(cx);
    let requester = host.read_with(cx, |host, _| host.requester());
    ledger.update(cx, |ledger, cx| ledger.connected("r", requester, cx));
    settle(cx);
    assert_eq!(transport.requests("session.branch.create").len(), 1, "sent again");
    assert!(ledger.read_with(cx, |ledger, _| ledger.entries().is_empty()), "settled");
    assert!(saved_forks(&saved).is_empty());
    assert_eq!(transport.operations(), ["session.catalog.query", "session.branch.create"]);
}

#[gpui_kit::test]
fn a_fork_whose_removal_gave_up_is_tried_again_without_a_reconnection(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let saved = Arc::new(Mutex::new(None));
    let recorded = script(
        &transport,
        saved.clone(),
        Script {
            turns: vec![turn("t1", 1, "completed")],
            copied: turn_rows("t1", 1),
            conflict: false,
            model: None,
        },
    );
    let bench = Bench::open(transport, saved, cx);
    let requester = bench.host.read_with(cx, |host, _| host.requester());
    let ledger = cx.update(|cx| SideChatLedger::global(cx));
    ledger.update(cx, |ledger, cx| ledger.connected("r", requester, cx));
    bench.send("Hi", cx);
    let fork = recorded.fork.lock().expect("fork").clone().expect("fork");
    // A run of the fork that has not ended after its stop: every removal of
    // the disposal is refused.
    for _ in 0..4 {
        bench.transport.reply(
            "session.remove",
            Err(HostRequestError::Operation {
                operation: "session.remove",
                code: host_protocol::HostOperationErrorCode::SessionBusy,
                message: "the Session has an active Turn".into(),
            }),
        );
    }
    let disposed = bench.chat.update(cx, |chat, cx| chat.dispose(cx));
    let removed = Rc::new(std::cell::Cell::new(None));
    let answer = removed.clone();
    cx.update(|cx| cx.spawn(async move |_| answer.set(Some(disposed.await))).detach());
    for _ in 0..8 {
        cx.executor().advance_clock(Duration::from_secs(1));
        cx.run_until_parked();
    }
    assert_eq!(removed.get(), Some(false), "gave up for now");
    assert_eq!(bench.transport.requests("session.remove").len(), 4);
    assert_eq!(bench.ledger(cx), [(fork.clone(), ForkPhase::Cleanup)]);

    // A minute on, the window still connected, it is tried again.
    cx.executor().advance_clock(Duration::from_secs(60));
    cx.run_until_parked();
    assert_eq!(bench.transport.requests("session.remove").len(), 5);
    assert!(bench.ledger(cx).is_empty(), "settled");
    assert!(saved_forks(&bench.saved).is_empty());
    // Nothing is left to try again.
    cx.executor().advance_clock(Duration::from_secs(120));
    cx.run_until_parked();
    assert_eq!(bench.transport.requests("session.remove").len(), 5);
}

#[gpui_kit::test]
fn a_mode_the_new_fork_did_not_take_is_set_before_the_next_send(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let saved = Arc::new(Mutex::new(None));
    let recorded = script(
        &transport,
        saved.clone(),
        Script {
            turns: vec![turn("t1", 1, "completed")],
            copied: turn_rows("t1", 1),
            conflict: false,
            model: None,
        },
    );
    transport.reply(
        "session.configuration.update",
        Err(HostRequestError::Transport("the connection dropped".into())),
    );
    transport.reply(
        "session.configuration.update",
        Ok(json!({"kind": "committed", "session": fork_projection("f", None)})),
    );
    let bench = Bench::open(transport, saved, cx);
    let explore = host_protocol::PermissionMode::Explore;
    bench.chat.update(cx, |chat, cx| assert!(chat.stage_permission_mode(explore.clone(), cx)));
    bench.send("Look around", cx);
    let fork = recorded.fork.lock().expect("fork").clone().expect("a fork was made");
    assert!(bench.transport.requests("turn.message.submit").is_empty(), "fails closed");
    let shown = bench.chat.read_with(cx, |chat, cx| chat.permission_mode(cx));
    assert_eq!(shown, Some(explore.clone()), "the pick still stands");

    bench.send("Look around", cx);
    let updates = bench.transport.requests("session.configuration.update");
    assert_eq!(updates.len(), 2, "set before this send");
    assert_eq!(updates[1]["sessionId"], fork.as_str());
    assert_eq!(updates[1]["patch"]["permissionMode"], "explore");
    let submits = bench.transport.requests("turn.message.submit");
    assert_eq!(submits.len(), 1);
    assert_eq!(submits[0]["sessionId"], fork.as_str());
    assert_eq!(bench.transport.requests("session.branch.create").len(), 1, "the same fork");
}
