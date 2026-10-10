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

//! UI integration tests of the window chrome around the conversation: the
//! sidebar column, the main pane's header, and the connection state, in the
//! production window content against a scripted Host transport.

use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::component::{ActiveTheme as _, Root};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    App, AppContext as _, ElementId, Entity, InputEvent as _, KeyUpEvent, Keystroke,
    TestAppContext, Window, WindowHandle, point, px, size,
};
use host_client::{ConnectionEvent, HostEvent};
use host_protocol::{HostAccepted, HostFrame};
use serde_json::{Value, json};
use shared::domain_element_id;
use shared::theme::ActiveMakaPalette as _;
use workspace::{HostRequestError, HostSession, HostTransport, UnavailableProjectCatalog};

use crate::Workbench;

const EPOCH: &str = "e1";

/// Lists a fixed set of sessions and opens an empty subscription for any of
/// them. Records every request.
#[derive(Default)]
pub(crate) struct ScriptedHost {
    sessions: Vec<Value>,
    /// The scheduled-task catalog, on one page.
    scheduled: Mutex<Vec<Value>>,
    requests: Mutex<Vec<(String, Value)>>,
}

impl ScriptedHost {
    fn requests(&self, operation: &str) -> Vec<Value> {
        let requests = self.requests.lock().expect("requests");
        requests.iter().filter(|(op, _)| op == operation).map(|(_, input)| input.clone()).collect()
    }
}

impl HostTransport for ScriptedHost {
    fn request(
        &self,
        operation: &'static str,
        input: Value,
        _: Duration,
    ) -> Boxed<Result<Value, HostRequestError>> {
        self.requests.lock().expect("requests").push((operation.to_owned(), input.clone()));
        let result = match operation {
            "session.catalog.query" => Ok(json!({
                "kind": "page",
                "revision": format!("sha256:{}", "0".repeat(64)),
                "sessions": self.sessions,
                "nextCursor": null
            })),
            "subscription.open" => {
                let id = input["sessionId"].as_str().expect("sessionId");
                Ok(empty_open_result(id))
            }
            "subscription.ready" | "subscription.close" => {
                Ok(json!({"subscriptionId": input["subscriptionId"]}))
            }
            "scheduled-task.query" => {
                let tasks = self.scheduled.lock().expect("scheduled").clone();
                Ok(match input["kind"].as_str() {
                    Some("get") => {
                        let task = tasks.into_iter().find(|task| task["id"] == input["taskId"]);
                        json!({"kind": "task", "task": task})
                    }
                    _ => json!({"kind": "page", "revision": 1, "tasks": tasks, "nextCursor": null}),
                })
            }
            other => Err(HostRequestError::Transport(format!("unexpected {other}").into())),
        };
        Box::pin(async move { result })
    }
}

pub(crate) fn session(id: &str, name: &str) -> Value {
    json!({
        "id": id, "revision": 1,
        "workspace": {"target": {"kind": "host_path", "path": "/work/demo"}, "hostCwd": "/work/demo"},
        "createdAt": 1, "activityAt": 2, "name": name, "isFlagged": false, "isArchived": false,
        "labels": [], "labelsTruncated": false, "hasUnread": false, "status": "active",
        "backend": "ai-sdk", "llmConnectionId": null, "llmConnectionSlug": "env",
        "connectionLocked": false, "model": "m", "permissionMode": "ask",
        "collaborationMode": "agent", "orchestrationMode": "default"
    })
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

/// A session with no turn yet.
fn empty_open_result(session_id: &str) -> Value {
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

fn accepted() -> HostAccepted {
    serde_json::from_value(json!({
        "kind": "accepted", "rootId": "r", "hostEpoch": EPOCH, "connectionId": "c",
        "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
        "compositionRevision": "3", "state": "ready"
    }))
    .expect("accepted")
}

pub(crate) struct Harness {
    pub(crate) transport: Arc<ScriptedHost>,
    pub(crate) host: Entity<HostSession>,
    pub(crate) workbench: Entity<Workbench>,
    pub(crate) window: WindowHandle<Root>,
}

impl Harness {
    pub(crate) fn open(sessions: Vec<Value>, cx: &mut TestAppContext) -> Self {
        Self::open_sized(sessions, size(px(1200.), px(800.)), cx)
    }

    /// The window at `window_size`.
    pub(crate) fn open_sized(
        sessions: Vec<Value>,
        window_size: gpui_kit::Size<gpui_kit::Pixels>,
        cx: &mut TestAppContext,
    ) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            // Overlays slide in on the wall clock; with motion reduced they
            // settle on their first frame, so clicks land where they show.
            cx.set_reduce_motion(true);
        });
        let transport = Arc::new(ScriptedHost { sessions, ..ScriptedHost::default() });
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone())
        });
        let mut workbench = None;
        let window = cx.open_window(window_size, |window, cx| {
            let view = cx.new(|cx| {
                Workbench::new(host.clone(), Rc::new(UnavailableProjectCatalog), window, cx)
            });
            workbench = Some(view.clone());
            Root::new(view, window, cx)
        });
        let harness = Self { transport, host, workbench: workbench.expect("workbench"), window };
        harness.feed(ConnectionEvent::Connected { accepted: accepted() }, cx);
        harness
    }

    fn feed(&self, event: ConnectionEvent, cx: &mut TestAppContext) {
        self.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Connection(event), cx));
        settle(cx);
    }

    /// The Host reports a running root turn in `session_id`.
    fn start_turn(&self, session_id: &str, cx: &mut TestAppContext) {
        let root = json!({"sessionId": session_id, "turnId": "t1", "runId": "r1",
                          "status": "running"});
        let value = json!({
            "kind": "subscription.session_projection", "hostEpoch": EPOCH,
            "subscriptionId": format!("sub-{session_id}"), "sequence": 1,
            "snapshot": snapshot(session_id, 2, root)
        });
        let HostFrame::Push(frame) = HostFrame::decode(value).expect("frame") else {
            panic!("not a push frame");
        };
        self.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Push(frame), cx));
        settle(cx);
    }

    pub(crate) fn draft_id(&self, cx: &mut TestAppContext) -> ElementId {
        let draft = self
            .workbench
            .read_with(cx, |workbench, cx| workbench.composer().read(cx).draft().entity_id());
        ("input", draft).into()
    }

    fn draft(&self, cx: &mut TestAppContext) -> String {
        self.workbench.read_with(cx, |workbench, cx| {
            workbench.composer().read(cx).draft().read(cx).value().to_string()
        })
    }

    pub(crate) fn with_window<R>(
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
        settle(cx);
        result
    }
}

pub(crate) fn settle(cx: &mut TestAppContext) {
    cx.run_until_parked();
    cx.executor().advance_clock(conversation::COMMIT_INTERVAL * 2);
    cx.run_until_parked();
}

/// A full key press: a Button activates on the key's release, which
/// `press` alone does not send.
pub(crate) fn press_and_release(window: &mut Window, key: &str, cx: &mut App) {
    window.press(key, cx);
    let keystroke = Keystroke::parse(key).expect("keystroke");
    window.dispatch_event(KeyUpEvent { keystroke }.to_platform_input(), cx);
    window.render_frame(cx);
}

pub(crate) fn row(id: &str) -> ElementId {
    domain_element_id("session-row", id)
}

#[gpui_kit::test]
fn the_header_names_the_selected_task_beside_the_sidebar(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha"), session("s2", "Beta")], cx);
    harness.with_window(cx, |window, cx| {
        let title = window.find("session-title");
        assert_eq!(title.label(), Some("Alpha"));
        let sidebar = window.find("sidebar-column").bounds();
        let header = window.find("main-header").bounds();
        assert!(header.left() >= sidebar.right(), "the header belongs to the main pane");
        let plate = window.find("main-pane").bounds();
        assert_eq!(plate.top() - sidebar.top(), px(8.), "the plate sits in the canvas margin");
        assert_eq!(plate.left() - sidebar.right(), px(8.), "the same margin beside the sidebar");
        assert_eq!(plate.left(), px(264.), "the plate starts at 264");
        assert_eq!(header.top(), plate.top(), "no title bar above the header");
        let chrome = window.find("sidebar-chrome").bounds();
        assert_eq!(chrome.bottom(), header.bottom(), "the strip and the header form one band");
        let toggle = window.find("sidebar-toggle").bounds();
        assert!(
            (toggle.center().y - header.center().y).abs() < px(0.5),
            "the controls share the header's centre line"
        );
        window.click(row("s2"), cx);
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("session-title").label(), Some("Beta"));
    });
    assert_eq!(harness.transport.requests("subscription.open").len(), 2);
    harness.workbench.read_with(cx, |workbench, cx| {
        let catalog = workbench.sidebar().read(cx).catalog().read(cx);
        assert_eq!(catalog.selected_id().map(|id| id.as_ref()), Some("s2"));
    });
}

#[gpui_kit::test]
fn the_header_shows_a_heading_titled_task_without_the_marker(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "## Plan the release"), session("s2", "#")], cx);
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("session-title").label(), Some("Plan the release"));
        window.click(row("s2"), cx);
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("session-title").label(), Some(shared::copy::UNTITLED_TASK.en()));
    });
    harness.workbench.read_with(cx, |workbench, cx| {
        let catalog = workbench.sidebar().read(cx).catalog().read(cx);
        let names: Vec<_> = catalog.rows().iter().map(|row| row.name.to_string()).collect();
        assert_eq!(names, ["## Plan the release", "#"], "the stored names are unchanged");
    });
}

/// With Hide chosen for a collapsed sidebar (the rail is
/// `sidebar_tests`').
#[gpui_kit::test]
fn toggle_sidebar_hides_and_shows_the_sidebar_and_the_composer_keeps_focus(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    cx.update(|cx| settings::choose_narrow_sidebar(settings::NarrowSidebar::Hide, cx));
    let draft = harness.draft_id(cx);
    let composer = harness.workbench.read_with(cx, |workbench, _| workbench.composer().clone());
    harness.with_window(cx, |window, cx| {
        composer.update(cx, |composer, cx| composer.focus(window, cx));
    });
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
        assert_eq!(window.find("sidebar-toggle").label(), Some(shared::copy::SIDEBAR_HIDE.en()));
        window.press("secondary-b", cx);
    });
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("sidebar-column").is_none(), "the key hides the sidebar");
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "focus stays put");
        assert_eq!(window.find("sidebar-toggle").label(), Some(shared::copy::SIDEBAR_SHOW.en()));
        let header = window.find("main-header").bounds();
        assert_eq!(header.left(), px(8.), "the plate takes the canvas margin on every side");
        if cfg!(target_os = "macos") {
            // The traffic lights sit at x 16 to 70 and keep their inset.
            let toggle = window.find("sidebar-toggle").bounds();
            assert!(toggle.left() - header.left() >= px(70.), "toggle at {toggle:?}");
        }
    });
    assert!(!harness.workbench.read_with(cx, |workbench, _| workbench.sidebar_visible()));

    // The header button does the same, without taking focus.
    harness.with_window(cx, |window, cx| window.click("sidebar-toggle", cx));
    harness.with_window(cx, |window, _| {
        let sidebar = window.find("sidebar-column").bounds();
        assert!(window.find("main-header").bounds().left() >= sidebar.right());
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "focus stays put");
    });

    // Hiding the sidebar while its list has focus hands focus to the composer.
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("session-list").focused(), Some(true));
        window.press("secondary-b", cx);
    });
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("sidebar-column").is_none());
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "the composer takes focus");
    });
}

#[gpui_kit::test]
fn a_task_without_turns_shows_the_empty_state_until_a_turn_starts(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    harness.with_window(cx, |window, _| {
        assert!(window.find("empty-state").visible());
        assert!(window.try_find("conversation").is_none(), "it stands in for the transcript");
        // The header names the task; the hero always asks the same question,
        // and that line is all it shows: no muted line under it (the
        // composer's project chip says where tasks run) and no suggestions.
        let title = window.find("empty-state-title");
        assert_eq!(title.label(), Some("What should we work on?"));
        assert!(window.try_find("empty-state-hint").is_none(), "no muted line");
        assert!(window.try_find("empty-state-suggestions").is_none(), "no suggestions");
        let hero = window.find("empty-state").bounds();
        let centre = title.bounds().center();
        assert!((centre.x - hero.center().x).abs() < px(1.), "centred across");
        assert!((centre.y - hero.center().y).abs() < px(1.), "and down: nothing else is there");
    });
    harness.start_turn("s1", cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("empty-state").is_none());
        assert!(window.find("conversation").visible());
    });
}

#[gpui_kit::test]
fn with_no_task_the_empty_state_shows_too(cx: &mut TestAppContext) {
    let harness = Harness::open(Vec::new(), cx);
    harness.with_window(cx, |window, _| {
        assert!(window.find("empty-state").visible());
        // Type only: no wordmark, no robot, no disc; the question, centered
        // over the column.
        assert!(window.try_find("empty-state-icon").is_none());
        assert!(window.try_find("empty-state-wordmark").is_none());
        let column = window.find("empty-state").bounds();
        let title = window.find("empty-state-title");
        assert_eq!(title.label(), Some(shared::copy::EMPTY_STATE_TITLE.en()));
        assert!((title.bounds().center().x - column.center().x).abs() < px(1.));
        // No task selected is the new task's draft.
        assert_eq!(window.find("session-title").label(), Some(shared::copy::NEW_TASK.en()));
    });
}

#[gpui_kit::test]
fn an_untitled_task_asks_what_to_work_on(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "")], cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("session-title").label(),
            Some(shared::copy::UNTITLED_TASK.en()),
            "the header names it"
        );
        assert_eq!(
            window.find("empty-state-title").label(),
            Some(shared::copy::EMPTY_STATE_TITLE.en()),
            "the hero asks instead of repeating “Untitled task”"
        );
    });
}

#[gpui_kit::test]
fn the_sidebar_footer_carries_the_host_and_its_connection_state(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    harness.with_window(cx, |window, _| {
        let status = window.find("sidebar-footer");
        assert_eq!(status.label(), Some("Local Host, Connected, data folder .dev-root"));
        let sidebar = window.find("sidebar-column").bounds();
        assert!(sidebar.contains(&status.bounds().center()), "in the sidebar");
        let band = window.find("host-status").bounds();
        assert!(band.contains(&status.bounds().center()), "in the footer band");
        assert!(band.bottom() >= sidebar.bottom() - px(1.), "at the sidebar's foot");
        let header = window.find("main-header").bounds();
        assert!(!header.contains(&status.bounds().center()), "not in the header");
        // The badge ends as far in from the row's right side as the dot
        // starts from its left, so the row's fill sits even around them.
        let row = status.bounds();
        let dot = window.find("host-status-dot").bounds();
        let badge = window.find("host-status-badge").bounds();
        let (lead, tail) = (dot.left() - row.left(), row.right() - badge.right());
        assert!((lead - tail).abs() < px(0.5), "dot {lead:?} in, badge {tail:?} in");
        // The row's fill sits 8px below the band's top (where the hairline
        // over it is drawn) and 8px above the window's edge, as the plate
        // does.
        assert_eq!(row.size.height, px(36.), "{row:?}");
        assert_eq!(row.top() - band.top(), px(8.), "{row:?} in {band:?}");
        assert_eq!(band.bottom() - row.bottom(), px(8.), "{row:?} in {band:?}");
    });
    harness.feed(ConnectionEvent::Disconnected { reason: "closed".into() }, cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("sidebar-footer").label(),
            Some("Local Host, Reconnecting…, data folder .dev-root")
        );
        assert!(window.find("host-disconnected").visible(), "the strip says what to do");
        // The state's words keep their width; the badge gives way first and
        // goes rather than draw less than two glyphs (review round 12).
        let row = window.find("sidebar-footer").bounds();
        let word = window.find("host-status-word").bounds();
        assert!(word.right() <= row.right(), "{word:?} in {row:?}");
        assert!(word.size.width > px(60.), "Reconnecting… whole: {word:?}");
        if let Some(badge) = window.try_find("host-status-badge") {
            let badge = badge.bounds();
            assert!(word.right() <= badge.left(), "{word:?} {badge:?}");
            assert!(badge.size.width >= px(32.), "{badge:?}");
        }
    });
    harness.feed(ConnectionEvent::Connected { accepted: accepted() }, cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("sidebar-footer").label(),
            Some("Local Host, Connected, data folder .dev-root")
        );
    });
}

#[gpui_kit::test]
fn back_and_forward_walk_the_tasks_this_window_showed(cx: &mut TestAppContext) {
    let harness = Harness::open(
        vec![session("s1", "Alpha"), session("s2", "Beta"), session("s3", "Gamma")],
        cx,
    );
    let selected = |cx: &mut TestAppContext| {
        harness.workbench.read_with(cx, |workbench, cx| {
            let catalog = workbench.sidebar().read(cx).catalog().read(cx);
            catalog.selected_id().map(|id| id.to_string())
        })
    };
    harness.with_window(cx, |window, cx| {
        // The window controls sit in the sidebar's top strip, after the
        // traffic lights; the main header keeps only the title.
        let chrome = window.find("sidebar-chrome").bounds();
        let header = window.find("main-header").bounds();
        for id in ["sidebar-toggle", "go-back", "go-forward"] {
            let control = window.find(id).bounds();
            assert!(chrome.contains(&control.center()), "{id} is in the sidebar's top strip");
            assert!(!header.contains(&control.center()), "{id} is not in the main header");
            if cfg!(target_os = "macos") {
                assert!(control.left() - chrome.left() >= px(70.), "{id} clears the lights");
            }
        }
        window.click(row("s2"), cx);
    });
    let can_go = |cx: &mut TestAppContext| {
        harness
            .workbench
            .read_with(cx, |workbench, _| (workbench.can_go_back(), workbench.can_go_forward()))
    };
    // Showing the first task was not a visit: there is nothing to go back to.
    harness.with_window(cx, |window, cx| window.click(row("s3"), cx));
    assert_eq!(selected(cx).as_deref(), Some("s3"));
    assert_eq!(can_go(cx), (true, false));

    harness.with_window(cx, |window, cx| window.click("go-back", cx));
    assert_eq!(selected(cx).as_deref(), Some("s2"));
    // The key binding does the same.
    harness.with_window(cx, |window, cx| window.press("secondary-[", cx));
    assert_eq!(selected(cx).as_deref(), Some("s1"));
    assert_eq!(can_go(cx), (false, true), "back at the start");
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("session-title").label(), Some("Alpha"));
        // Disabled, Back does nothing.
        window.click("go-back", cx);
    });
    assert_eq!(selected(cx).as_deref(), Some("s1"));
    harness.with_window(cx, |window, cx| window.click("go-forward", cx));
    assert_eq!(selected(cx).as_deref(), Some("s2"));

    // A new choice forgets what lay ahead.
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    assert_eq!(can_go(cx), (true, false));
    harness.with_window(cx, |window, cx| window.press("secondary-[", cx));
    assert_eq!(selected(cx).as_deref(), Some("s2"));

    // With the sidebar hidden, the controls follow the traffic lights into
    // the main header.
    harness.with_window(cx, |window, cx| window.press("secondary-b", cx));
    harness.with_window(cx, |window, cx| {
        let header = window.find("main-header").bounds();
        for id in ["sidebar-toggle", "go-back", "go-forward"] {
            assert!(header.contains(&window.find(id).bounds().center()), "{id} in the header");
        }
        let title = window.find("session-title").bounds();
        assert!(title.left() > window.find("go-forward").bounds().right(), "then the title");
        window.click("go-forward", cx);
    });
    assert_eq!(selected(cx).as_deref(), Some("s1"));
}

fn menu_item(key: &str) -> ElementId {
    domain_element_id("menu-item", key)
}

#[gpui_kit::test]
fn the_footer_menu_opens_from_the_keyboard_and_escape_returns_focus(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    harness.with_window(cx, |window, cx| {
        let footer = window.find("sidebar-footer");
        assert_eq!(footer.label(), Some("Local Host, Connected, data folder .dev-root"));
        window.click(row("s1"), cx);
        // The footer row follows the task list in Tab order.
        window.press("tab", cx);
        assert_eq!(window.find("sidebar-footer").focused(), Some(true));
        press_and_release(window, "enter", cx);
        let menu = window.within("menu");
        let labels: Vec<_> = ["settings", "language", "appearance", "switch-data-folder"]
            .map(|key| {
                menu.try_find(menu_item(key)).and_then(|item| item.label().map(str::to_owned))
            })
            .into();
        assert_eq!(
            labels,
            [
                Some(shared::copy::SETTINGS_ITEM.en().to_owned()),
                Some(shared::copy::settings::LANGUAGE.en().to_owned()),
                Some(shared::copy::settings::APPEARANCE.en().to_owned()),
                Some(shared::copy::SWITCH_STATE_ROOT.en().to_owned()),
            ]
        );
        // 32px rows in a 4px padded surface inside its 1px hairline, 8px
        // above the row, as wide.
        let settings = window.find(menu_item("settings")).bounds();
        assert_eq!(settings.size.height, px(32.));
        let menu = window.find("menu").bounds();
        let footer = window.find("sidebar-footer").bounds();
        assert_eq!(settings.left() - menu.left(), px(5.));
        assert_eq!(footer.top() - menu.bottom(), px(8.), "the menu opens 8px above the row");
        assert_eq!(menu.left(), footer.left());
        assert!(menu.size.width >= footer.size.width);
    });
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("menu").is_none(), "Escape closes the menu");
        assert_eq!(window.find("sidebar-footer").focused(), Some(true), "focus returns to the row");
    });

    // Down wraps from the last item to the first, Up the other way, and
    // Home and End jump; Settings… opens settings, and Back to app returns
    // to the row.
    harness.with_window(cx, |window, cx| {
        press_and_release(window, "enter", cx);
        window.press("up", cx);
        assert_eq!(window.find(menu_item("switch-data-folder")).selected(), Some(true));
        window.press("down", cx);
        assert_eq!(window.find(menu_item("settings")).selected(), Some(true));
        window.press("end", cx);
        window.press("home", cx);
        assert_eq!(window.find(menu_item("settings")).selected(), Some(true));
        window.press("enter", cx);
    });
    harness.with_window(cx, |window, cx| {
        assert!(window.find("settings-page").visible(), "Settings… opens settings");
        assert!(window.try_find("sidebar-footer").is_none(), "in the sidebar's place");
        window.click("settings-back", cx);
    });
    let draft = harness
        .workbench
        .read_with(cx, |workbench, cx| workbench.composer().read(cx).draft().entity_id());
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("settings-page").is_none());
        // The footer row was not drawn while settings showed, so its focus
        // went with it; the composer takes focus.
        assert_eq!(window.find("sidebar-footer").focused(), Some(false));
        assert_eq!(window.find(("input", draft)).focused(), Some(true));
    });
}

#[gpui_kit::test]
fn the_footer_row_toggles_its_menu_and_a_press_outside_closes_it(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    harness.with_window(cx, |window, cx| window.click("sidebar-footer", cx));
    harness.with_window(cx, |window, cx| {
        assert!(window.find("menu").visible(), "a click opens the menu");
        window.click("sidebar-footer", cx);
    });
    harness.with_window(cx, |window, cx| {
        assert!(window.try_find("menu").is_none(), "a second click closes it");
        window.click("sidebar-footer", cx);
    });
    harness.with_window(cx, |window, cx| {
        // Hovering Language opens its submenu beside the menu, its first row
        // (Follow system, then the languages) level with Language.
        window.hover(menu_item("language"), cx);
        let language = window.find(menu_item("language")).bounds();
        let system = window.find(menu_item("language:system")).bounds();
        assert_eq!(system.top(), language.top());
        assert_eq!(
            window.find(menu_item("language:system")).label(),
            Some(shared::copy::settings::LANGUAGE_SYSTEM.en())
        );
        assert!(window.find(menu_item("language:en")).bounds().top() > system.top());
        // 4px between the two surfaces, then the hairline and the padding.
        assert_eq!(system.left() - window.find("menu").bounds().right(), px(9.));
        assert_eq!(window.find(menu_item("language")).expanded(), Some(true));
        window.click(row("s1"), cx);
    });
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("menu").is_none(), "a press outside closes it");
        assert!(window.try_find("submenu").is_none());
    });
}

/// Opens the footer menu from the keyboard and chooses item `choice` of
/// submenu `submenu` (0 Language, 1 Appearance).
fn choose_in_footer_submenu(
    harness: &Harness,
    submenu: usize,
    choice: usize,
    cx: &mut TestAppContext,
) {
    harness.with_window(cx, |window, cx| {
        window.click(row("s1"), cx);
        window.press("tab", cx);
        press_and_release(window, "enter", cx);
        // Settings… comes first.
        for _ in 0..=submenu + 1 {
            window.press("down", cx);
        }
        // The submenu opens on its checked choice; Home counts from the top.
        window.press("right", cx);
        window.press("home", cx);
        for _ in 0..choice {
            window.press("down", cx);
        }
        window.press("enter", cx);
    });
}

#[gpui_kit::test]
fn appearance_and_language_apply_from_the_footer_menu(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    let current = |cx: &mut TestAppContext| cx.update(|cx| settings::AppPreferences::current(cx));
    assert_eq!(current(cx).appearance, settings::Appearance::System);

    choose_in_footer_submenu(&harness, 1, 2, cx);
    assert_eq!(current(cx).appearance, settings::Appearance::Dark);
    assert!(cx.update(|cx| settings::theme_mode(cx).is_dark()), "the theme is dark now");
    harness.with_window(cx, |window, cx| {
        assert!(window.try_find("menu").is_none(), "choosing closes the menu");
        // Opened again from the keyboard, the submenu starts on the choice
        // in effect, not on its first row.
        window.click(row("s1"), cx);
        window.press("tab", cx);
        press_and_release(window, "enter", cx);
        for _ in 0..3 {
            window.press("down", cx);
        }
        window.press("right", cx);
        assert_eq!(window.find(menu_item("appearance:dark")).selected(), Some(true));
        window.press("escape", cx);
        window.press("escape", cx);
    });

    choose_in_footer_submenu(&harness, 1, 1, cx);
    assert_eq!(current(cx).appearance, settings::Appearance::Light);
    assert!(!cx.update(|cx| settings::theme_mode(cx).is_dark()));

    // Another language applies at once: the whole window redraws in it,
    // including what entities cached in words (the task list's headings) and
    // the menu bar.
    use shared::copy::{self, Locale};
    let zh = Locale::SimplifiedChinese;
    let earlier = shared::domain_element_id("session-group", "earlier");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(earlier.clone()).label(), Some(copy::GROUP_EARLIER.en()));
    });
    // Follow system, English, 简体中文, 繁體中文.
    choose_in_footer_submenu(&harness, 0, 2, cx);
    assert_eq!(current(cx).language, settings::Language::SimplifiedChinese);
    assert_eq!(cx.update(|cx| Locale::current(cx)), zh);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("go-back").label(), Some(copy::GO_BACK.in_locale(zh)));
        assert_eq!(window.find("sidebar-toggle").label(), Some(copy::SIDEBAR_HIDE.in_locale(zh)));
        assert_eq!(window.find(earlier.clone()).label(), Some(copy::GROUP_EARLIER.in_locale(zh)));
        assert!(window.try_find("notification").is_none(), "no “translations later” notice");
    });
    let menus = cx.update(|cx| cx.get_menus()).unwrap_or_default();
    assert!(
        menus.iter().any(|menu| menu.name.as_ref() == copy::MENU_TASK.in_locale(zh)),
        "the menu bar is rebuilt in the new language"
    );

    // And back.
    choose_in_footer_submenu(&harness, 0, 1, cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("go-back").label(), Some(copy::GO_BACK.en()));
        assert_eq!(window.find(earlier.clone()).label(), Some(copy::GROUP_EARLIER.en()));
    });
}

fn palette_entry(key: &str) -> ElementId {
    domain_element_id("palette-entry", key)
}

#[gpui_kit::test]
fn the_command_palette_filters_runs_a_command_and_returns_focus(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha"), session("s2", "Beta release")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(row("s1"), cx);
        window.click(draft.clone(), cx);
    });
    // ⌘K opens it over the window with the query field focused; the
    // commands that can run come first (the list is virtual: only what is
    // in view is drawn).
    harness.with_window(cx, |window, cx| window.press("cmd-k", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.find("command-palette").visible(), "⌘K opens the palette");
        for key in ["command:new-task", "command:toggle-sidebar"] {
            assert!(window.try_find(palette_entry(key)).is_some(), "{key} is listed");
        }
        assert!(window.try_find(palette_entry("command:stop-turn")).is_none(), "nothing runs");
        assert!(window.try_find(palette_entry("command:go-back")).is_none(), "no history");
    });
    // Choices and tasks are listed too, found by a search.
    harness.with_window(cx, |window, cx| window.input("dark", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(palette_entry("appearance:dark")).is_some());
    });
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    // Typing filters fuzzily: "hsb" is Hide sidebar and nothing else.
    harness.with_window(cx, |window, cx| window.input("hsb", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(palette_entry("command:toggle-sidebar")).is_some());
        assert!(window.try_find(palette_entry("command:new-task")).is_none(), "filtered out");
        assert!(window.try_find(palette_entry("task:s1")).is_none());
    });
    // Enter runs the best match once the palette has closed; focus is back
    // in the draft.
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    assert!(!harness.workbench.read_with(cx, |workbench, _| workbench.sidebar_visible()));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("command-palette").is_none(), "Enter closes the palette");
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "focus returns");
    });
}

#[gpui_kit::test]
fn escape_clears_the_query_then_closes_the_palette(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(row("s1"), cx);
        window.click(draft.clone(), cx);
        // ⇧⌘P opens it too, as in editors.
        window.press("cmd-shift-p", cx);
    });
    let highlight = cx.update(|cx| (cx.theme().accent, cx.maka()));
    assert_eq!(highlight.0, highlight.1.active_row, "the open palette highlights as selected");
    harness.with_window(cx, |window, cx| window.input("zzqq", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(palette_entry("command:new-task")).is_none(), "no match");
    });
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.find("command-palette").visible(), "the first Escape clears the query");
        assert!(window.try_find(palette_entry("command:new-task")).is_some());
    });
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("command-palette").is_none(), "the second closes it");
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "focus returns");
    });
    let highlight = cx.update(|cx| (cx.theme().accent, cx.maka()));
    assert_eq!(highlight.0, highlight.1.hover, "closed, ghost buttons hover with the wash again");
}

#[gpui_kit::test]
fn the_palette_opens_a_task_by_title(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha"), session("s2", "Beta release")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    harness.with_window(cx, |window, cx| window.press("cmd-k", cx));
    harness.with_window(cx, |window, cx| {
        assert!(window.find("command-palette").visible(), "⌘K opens it");
        window.input("beta", cx);
    });
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    let selected = harness.workbench.read_with(cx, |workbench, cx| {
        workbench.sidebar().read(cx).catalog().read(cx).selected_id().cloned()
    });
    assert_eq!(selected.as_deref(), Some("s2"));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("command-palette").is_none());
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "ready to write");
    });
}

#[gpui_kit::test]
fn the_shortcuts_sheet_lists_the_palettes_commands_with_their_keys(cx: &mut TestAppContext) {
    use crate::commands::{COMMANDS, palette_commands};
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(row("s1"), cx);
        window.click(draft.clone(), cx);
        window.press("cmd-/", cx);
    });
    // Every command of the table with a binding has a row, and nothing else
    // does; the palette's commands with a binding are all there.
    let (sheet, bound) = harness.with_window(cx, |window, _| {
        assert!(window.find("keyboard-shortcuts").visible(), "⌘/ opens the sheet");
        let sheet: Vec<&str> = COMMANDS
            .iter()
            .filter(|command| window.try_find(domain_element_id("shortcut", command.id)).is_some())
            .map(|command| command.id)
            .collect();
        let bound: Vec<&str> = COMMANDS
            .iter()
            .filter(|command| !crate::shortcuts::bindings(command, window).is_empty())
            .map(|command| command.id)
            .collect();
        (sheet, bound)
    });
    assert_eq!(sheet, bound);
    for expected in ["new-task", "command-palette", "keyboard-shortcuts", "next-task", "page-up"] {
        assert!(sheet.contains(&expected), "{expected} is in the sheet");
    }
    let palette: Vec<String> = harness.workbench.read_with(cx, |workbench, cx| {
        workbench.palette_entries(cx).iter().map(|entry| entry.key.to_string()).collect()
    });
    for command in palette_commands() {
        let listed = palette.contains(&format!("command:{}", command.id));
        if listed && bound.contains(&command.id) {
            assert!(sheet.contains(&command.id), "{} is in the palette and the sheet", command.id);
        }
    }
    harness.with_window(cx, |window, _| {
        let new_task = window.find(domain_element_id("shortcut", "new-task"));
        let label = new_task.label().expect("label");
        assert!(label.starts_with(shared::copy::NEW_TASK.en()), "{label}");
        assert!(label.ends_with("⌘N"), "{label}");
        let palette = window.find(domain_element_id("shortcut", "command-palette"));
        assert!(palette.label().expect("label").contains("⌘K, ⇧⌘P"), "both bindings, ⌘K first");
    });
    // Escape closes it and focus returns.
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("keyboard-shortcuts").is_none());
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
    });
}

/// The palette lists the settings sections that exist and opens settings on
/// the one chosen; while settings show it leaves out what waits for them.
#[gpui_kit::test]
fn the_palette_opens_settings_on_a_section(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(row("s1"), cx);
        window.click(draft.clone(), cx);
        window.press("cmd-k", cx);
    });
    harness.with_window(cx, |window, cx| window.input("workspace", cx));
    harness.with_window(cx, |window, cx| {
        assert!(window.try_find(palette_entry("settings:usage")).is_none(), "not built yet");
        window.click(palette_entry("settings:projects"), cx);
    });
    harness.with_window(cx, |window, cx| {
        assert_eq!(
            window.find("settings-title").label(),
            Some(shared::copy::settings::SECTION_WORKSPACE.en())
        );
        window.press("cmd-k", cx);
    });
    harness.with_window(cx, |window, _| {
        assert!(window.find("command-palette").visible());
        assert!(window.try_find(palette_entry("command:toggle-sidebar")).is_none());
        assert!(window.try_find(palette_entry("command:new-task")).is_some());
    });
}

pub(crate) fn page_entry(page: &str) -> ElementId {
    domain_element_id("sidebar-page", page)
}

/// The sidebar's entries put their page on the plate, under a header row
/// of window chrome only: the page heads its own column with its title and
/// controls, as a settings page does. Choosing a task, even the one
/// selected, brings the task back as it was.
#[gpui_kit::test]
fn a_page_takes_the_plate_and_choosing_a_task_brings_the_task_back(cx: &mut TestAppContext) {
    use session::SidebarPage;
    let harness = Harness::open(vec![session("s1", "Alpha"), session("s2", "Beta")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(row("s1"), cx);
        window.click(draft.clone(), cx);
        window.input("keep me", cx);
        window.click(page_entry("extensions"), cx);
    });
    let page = |cx: &mut TestAppContext| harness.workbench.read_with(cx, |w, _| w.page());
    assert_eq!(page(cx), Some(SidebarPage::Extensions));
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("page-title").label(), Some("Extensions"));
        assert!(window.try_find("session-title").is_none(), "no task title over a page");
        let header = window.find("main-header").bounds();
        let title = window.find("page-title").bounds();
        let actions = window.find("extensions-actions").bounds();
        assert!(title.top() >= header.bottom(), "the title heads the page's column");
        // The controls on the title's row, at the column's end.
        assert!(actions.top() < title.bottom() && title.top() < actions.bottom());
        assert!(actions.left() > title.right());
        assert!(window.find("extensions-page").visible());
        assert!(window.try_find(draft.clone()).is_none(), "no composer on a page");
        assert!(window.find("sidebar-column").visible(), "the sidebar stays");
    });
    assert_eq!(
        harness.workbench.read_with(cx, |w, cx| w.sidebar().read(cx).open_page()),
        Some(SidebarPage::Extensions),
        "its entry is the selected one"
    );
    // The other entry swaps the page; the task row brings the task back,
    // even the task already selected, with its draft.
    harness.with_window(cx, |window, cx| window.click(page_entry("scheduled-tasks"), cx));
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("page-title").label(), Some("Scheduled tasks"));
        assert!(window.find("scheduled-tasks-page").visible());
        window.click(row("s1"), cx);
    });
    assert_eq!(page(cx), None);
    assert_eq!(harness.draft(cx), "keep me");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("session-title").label(), Some("Alpha"));
    });
    // A selection that changes by itself does not leave a page.
    harness.with_window(cx, |window, cx| window.press("cmd-k", cx));
    harness.with_window(cx, |window, cx| window.input("open extensions", cx));
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    assert_eq!(page(cx), Some(SidebarPage::Extensions), "the palette opens it too");
    harness.workbench.update(cx, |workbench, cx| {
        let catalog = workbench.sidebar().read(cx).catalog().clone();
        catalog.update(cx, |catalog, cx| catalog.select(Some("s2"), cx));
    });
    cx.run_until_parked();
    assert_eq!(page(cx), Some(SidebarPage::Extensions));
    // Focus composer (⌘L) returns to the task view too.
    harness.with_window(cx, |window, cx| window.press("cmd-l", cx));
    assert_eq!(page(cx), None);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
        assert_eq!(window.find("session-title").label(), Some("Beta"));
    });
}

/// Back and Forward walk the pages the window showed with its tasks.
#[gpui_kit::test]
fn back_and_forward_walk_pages_and_tasks_alike(cx: &mut TestAppContext) {
    use session::SidebarPage;
    let harness = Harness::open(vec![session("s1", "Alpha"), session("s2", "Beta")], cx);
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    harness.with_window(cx, |window, cx| window.click(page_entry("extensions"), cx));
    harness.with_window(cx, |window, cx| window.click(row("s2"), cx));
    let place = |cx: &mut TestAppContext| {
        harness.workbench.read_with(cx, |workbench, cx| {
            let catalog = workbench.sidebar().read(cx).catalog().read(cx);
            (workbench.page(), catalog.selected_id().map(|id| id.to_string()))
        })
    };
    assert_eq!(place(cx), (None, Some("s2".into())));
    harness.with_window(cx, |window, cx| window.press("secondary-[", cx));
    assert_eq!(place(cx).0, Some(SidebarPage::Extensions), "back to the page");
    harness.with_window(cx, |window, cx| window.click("go-back", cx));
    assert_eq!(place(cx), (None, Some("s1".into())), "then to the task before it");
    harness.with_window(cx, |window, cx| window.press("secondary-]", cx));
    assert_eq!(place(cx).0, Some(SidebarPage::Extensions));
    harness.with_window(cx, |window, cx| window.click("go-forward", cx));
    assert_eq!(place(cx), (None, Some("s2".into())));
    assert!(!harness.workbench.read_with(cx, |workbench, _| workbench.can_go_forward()));
    // From a page, the history controls stay where they are.
    harness.with_window(cx, |window, cx| window.click(page_entry("scheduled-tasks"), cx));
    harness.with_window(cx, |window, _| {
        assert!(
            window
                .find("sidebar-chrome")
                .bounds()
                .contains(&window.find("go-back").bounds().center())
        );
    });
    harness.with_window(cx, |window, cx| window.click("go-back", cx));
    assert_eq!(place(cx), (None, Some("s2".into())));
}

/// The palette's page commands, in each locale.
#[gpui_kit::test]
fn the_palette_lists_the_page_commands(cx: &mut TestAppContext) {
    use shared::copy::Locale;
    use shared::copy::extensions as pages;
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    for locale in Locale::ALL {
        cx.update(|cx| locale.apply(cx));
        let entries =
            harness.workbench.read_with(cx, |workbench, cx| workbench.palette_entries(cx));
        for (key, text) in [
            ("command:open-extensions", pages::OPEN_EXTENSIONS),
            ("command:open-scheduled-tasks", pages::OPEN_SCHEDULED_TASKS),
        ] {
            let entry = entries.iter().find(|entry| entry.key == key).expect("listed");
            assert_eq!(entry.label.as_ref(), text.in_locale(locale), "{key} in {locale:?}");
        }
    }
}

/// A scheduled task as the Host lists it.
fn scheduled_task(id: &str, title: &str, status: &str) -> Value {
    json!({
        "id": id, "title": title, "intent": {"kind": "text", "body": ""},
        "schedule": {"kind": "once", "runAt": 4_000_000_000_000_u64},
        "effect": {"kind": "session_resume", "sessionId": "s1"},
        "status": status, "nextFireAt": 4_000_000_000_000_u64, "lastFireAt": null,
        "fireCount": 0, "maxFires": null, "expiresAt": null, "createdBy": {"kind": "agent",
        "sessionId": "s1"}, "createdAt": 1, "updatedAt": 1, "runs": [], "lastError": null
    })
}

#[gpui_kit::test]
fn the_scheduled_tasks_entry_counts_the_active_ones_and_a_fire_says_where_to_look(
    cx: &mut TestAppContext,
) {
    use host_protocol::{ChangeNotice, PushFrame, ScheduledTaskChangedReason};
    use session::SidebarPage;
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(page_entry("scheduled-tasks")).label(), Some("Scheduled tasks"));
    });
    *harness.transport.scheduled.lock().expect("scheduled") = vec![
        scheduled_task("t1", "Weekly review", "active"),
        scheduled_task("t2", "Water the plants", "paused"),
    ];
    let changed = |reason| {
        PushFrame::Change(ChangeNotice::ScheduledTaskChanged {
            revision: 2,
            reason,
            task_id: "t1".into(),
        })
    };
    let frame = changed(ScheduledTaskChangedReason::Created);
    harness.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Push(frame), cx));
    settle(cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find(page_entry("scheduled-tasks")).label(),
            Some("Scheduled tasks, 1 active"),
            "Desktop's pendingTasks label"
        );
    });
    // A fire is announced wherever the window is, with the way to the page.
    let frame = changed(ScheduledTaskChangedReason::Fired);
    harness.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Push(frame), cx));
    settle(cx);
    harness.with_window(cx, |window, cx| window.click("scheduled-task-fired-view", cx));
    assert_eq!(
        harness.workbench.read_with(cx, |workbench, _| workbench.page()),
        Some(SidebarPage::ScheduledTasks)
    );
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("page-meta").label(), Some("1 active"));
        assert!(window.find(domain_element_id("scheduled-task-row", "t1")).visible());
    });
}

#[gpui_kit::test]
fn a_passive_window_takes_no_pointer_over_its_content(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_global(crate::PassivePointer));
    let harness = Harness::open(vec![session("s1", "Alpha"), session("s2", "Beta")], cx);
    harness.with_window(cx, |window, cx| {
        let shield = window.find("passive-pointer").bounds();
        for region in ["sidebar-column", "main-pane"] {
            let bounds = window.find(region).bounds();
            assert!(shield.contains(&bounds.origin), "{region}");
            assert!(shield.contains(&(bounds.bottom_right() - point(px(1.), px(1.)))), "{region}");
        }
        // A click lands on the layer, not on the row under it.
        window.click(row("s2"), cx);
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("session-title").label(), Some("Alpha"));
    });
}

#[gpui_kit::test]
fn the_footer_menu_opens_with_a_submenu_shown_for_captures(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    let workbench = harness.workbench.clone();
    harness.with_window(cx, |window, cx| {
        workbench.update(cx, |workbench, cx| workbench.open_footer_menu(window, cx));
    });
    let menu = harness.workbench.read_with(cx, |workbench, _| workbench.footer_menu().cloned());
    let menu = menu.expect("the menu opened");
    let shown = menu.update(cx, |menu, cx| {
        (menu.open_submenu_of("language", cx), menu.open_submenu_of("nothing", cx))
    });
    assert_eq!(shown, (true, false));
    harness.with_window(cx, |window, _| {
        assert!(window.find("submenu").visible(), "the Language submenu shows");
        // As the pointer resting on Language leaves it: one row current,
        // none of the submenu's until the keyboard moves in.
        assert_eq!(window.find(menu_item("language")).selected(), Some(true));
        assert_eq!(window.find(menu_item("language:system")).selected(), Some(false));
    });
    // Right moves in: the first row is the current one, and Language gives
    // up its fill.
    harness.with_window(cx, |window, cx| window.press("right", cx));
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(menu_item("language:system")).selected(), Some(true));
        assert_eq!(window.find(menu_item("language")).selected(), Some(false));
        assert_eq!(window.find(menu_item("language")).expanded(), Some(true));
    });
}

/// The UI font size the app draws at, as applied and as saved.
fn ui_font_size(cx: &mut TestAppContext) -> u8 {
    let size = cx.update(|cx| shared::theme::ui_font_size(cx));
    assert_eq!(cx.update(|cx| settings::AppPreferences::current(cx)).ui_font_size, size);
    size
}

#[gpui_kit::test]
fn zoom_keys_step_the_ui_font_size_and_leave_a_field_alone(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(row("s1"), cx);
        window.click(draft.clone(), cx);
        window.input("hello", cx);
    });
    // ⌘+ with Shift or without, ⌘= too, then ⌘− and ⌘0, from the draft.
    for (key, size) in [
        ("secondary-=", 15),
        ("secondary-+", 16),
        ("secondary-shift-=", 17),
        ("secondary-shift-+", 18),
        ("secondary--", 17),
        ("secondary-0", 14),
    ] {
        harness.with_window(cx, |window, cx| window.press(key, cx));
        assert_eq!(ui_font_size(cx), size, "{key}");
    }
    assert_eq!(harness.draft(cx), "hello", "the field's text is not edited");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "and it keeps focus");
    });
    // At either end of Desktop's range a press does nothing.
    for _ in 0..4 {
        harness.with_window(cx, |window, cx| window.press("secondary--", cx));
    }
    assert_eq!(ui_font_size(cx), 11);
    harness.with_window(cx, |window, cx| window.press("secondary--", cx));
    assert_eq!(ui_font_size(cx), 11, "not below 11");
    for _ in 11..23 {
        harness.with_window(cx, |window, cx| window.press("secondary-=", cx));
    }
    assert_eq!(ui_font_size(cx), 22, "not above 22");
    harness.with_window(cx, |window, cx| window.press("secondary-0", cx));
    assert_eq!(ui_font_size(cx), 14);
}

#[gpui_kit::test]
fn zoom_keys_work_in_settings_and_the_appearance_stepper_shows_the_size(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    harness.with_window(cx, |window, cx| window.press("secondary-,", cx));
    harness.with_window(cx, |window, cx| {
        window.click(domain_element_id("settings-nav", "appearance"), cx)
    });
    let field = harness.workbench.read_with(cx, |workbench, cx| {
        let settings = workbench.settings_view().expect("settings show");
        settings.read(cx).appearance().read(cx).font_size().clone()
    });
    let shown = |cx: &mut TestAppContext| field.read_with(cx, |field, _| field.value().to_string());
    // From the section list.
    harness.with_window(cx, |window, cx| window.press("secondary-=", cx));
    assert_eq!((ui_font_size(cx), shown(cx)), (15, "15".into()));
    // From the stepper's own field, which shows the new size while it
    // keeps focus.
    harness.with_window(cx, |window, cx| {
        field.update(cx, |field, cx| field.focus(window, cx));
        window.press("secondary--", cx);
        window.press("secondary--", cx);
    });
    assert_eq!((ui_font_size(cx), shown(cx)), (13, "13".into()));
    harness.with_window(cx, |window, cx| window.press("secondary-0", cx));
    assert_eq!((ui_font_size(cx), shown(cx)), (14, "14".into()));
}

#[gpui_kit::test]
fn the_view_menu_zooms_with_its_keys_shown(cx: &mut TestAppContext) {
    use gpui_kit::{Action as _, OwnedMenuItem};
    use workspace::actions::{ResetZoom, ZoomIn, ZoomOut};
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    let menus = cx.update(|cx| cx.get_menus()).unwrap_or_default();
    let view = menus
        .iter()
        .find(|menu| menu.name.as_ref() == shared::copy::MENU_VIEW.en())
        .expect("the View menu");
    // After the existing items, behind a separator, in Desktop's order.
    let last: Vec<Option<(String, Box<dyn gpui_kit::Action>)>> = view.items[view.items.len() - 4..]
        .iter()
        .map(|item| match item {
            OwnedMenuItem::Action { name, action, .. } => {
                Some((name.clone(), action.boxed_clone()))
            }
            _ => None,
        })
        .collect();
    assert!(last[0].is_none(), "a separator first");
    let expected: [(&str, &dyn gpui_kit::Action, &str); 3] = [
        (shared::copy::MENU_ACTUAL_SIZE.en(), &ResetZoom, "0"),
        (shared::copy::MENU_ZOOM_IN.en(), &ZoomIn, "+"),
        (shared::copy::MENU_ZOOM_OUT.en(), &ZoomOut, "-"),
    ];
    for (item, (name, action, key)) in last[1..].iter().zip(expected) {
        let (shown, dispatched) = item.as_ref().expect("an item");
        assert_eq!(shown, name);
        assert!(dispatched.partial_eq(action), "{name}");
        // The menu bar shows a command's first binding.
        let binding = cx.update(|cx| {
            let keymap = cx.key_bindings();
            let keymap = keymap.borrow();
            let binding = keymap.bindings_for_action(action).next().cloned();
            binding.expect("a binding")
        });
        let keystroke = binding.keystrokes().first().expect("a keystroke");
        assert_eq!(keystroke.key(), key, "{name}");
        assert!(keystroke.modifiers().secondary() && !keystroke.modifiers().shift, "{name}");
    }
    // Choosing an item does what its key does, with nothing focused.
    harness.with_window(cx, |window, cx| {
        window.blur(cx);
        window.dispatch_action(ZoomIn.boxed_clone(), cx);
    });
    assert_eq!(ui_font_size(cx), 15);
    harness.with_window(cx, |window, cx| window.dispatch_action(ResetZoom.boxed_clone(), cx));
    assert_eq!(ui_font_size(cx), 14);
    // In every language: 放大, 縮小.
    cx.update(|cx| settings::choose_language(settings::Language::TraditionalChinese, cx));
    let menus = cx.update(|cx| cx.get_menus()).unwrap_or_default();
    let names: Vec<String> = menus
        .iter()
        .flat_map(|menu| menu.items.iter())
        .filter_map(|item| match item {
            OwnedMenuItem::Action { name, .. } => Some(name.clone()),
            _ => None,
        })
        .collect();
    let zh = shared::copy::Locale::TraditionalChinese;
    for text in
        [shared::copy::MENU_ACTUAL_SIZE, shared::copy::MENU_ZOOM_IN, shared::copy::MENU_ZOOM_OUT]
    {
        assert!(names.iter().any(|name| name == text.in_locale(zh)), "{}", text.in_locale(zh));
    }
}

/// ⌘F is each surface's own: a page's search, the settings' section
/// search, and in the task view Find in conversation, which an empty task
/// has nothing for (`find_tests` has the rest).
#[gpui_kit::test]
fn command_f_finds_on_pages_and_in_settings(cx: &mut TestAppContext) {
    use gpui_kit::{Action as _, Focusable as _};
    use workspace::actions::{FocusSearch, OpenExtensions};
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(row("s1"), cx);
        window.click(draft.clone(), cx);
        window.input("hello", cx);
    });
    // The task view's ⌘F is Find in conversation; an empty task has
    // nothing to find, and its draft keeps focus.
    harness.with_window(cx, |window, cx| {
        assert!(window.highest_precedence_binding_for_action(&FocusSearch).is_none());
        window.press("secondary-f", cx);
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "the draft keeps focus");
    });
    assert_eq!(harness.draft(cx), "hello");
    // The Extensions page: its search.
    harness.with_window(cx, |window, cx| window.dispatch_action(OpenExtensions.boxed_clone(), cx));
    let search = harness.workbench.read_with(cx, |workbench, cx| {
        workbench.extensions_view().expect("the page").read(cx).search().clone()
    });
    harness.with_window(cx, |window, cx| window.press("secondary-f", cx));
    harness.with_window(cx, |window, cx| {
        assert!(search.read(cx).focus_handle(cx).is_focused(window), "the page's search");
    });
    // Settings: the section search.
    harness.with_window(cx, |window, cx| window.press("secondary-,", cx));
    harness.with_window(cx, |window, cx| window.press("secondary-f", cx));
    harness.with_window(cx, |window, cx| {
        let settings = harness.workbench.read(cx).settings_view().expect("settings show");
        let search = settings.read(cx).section_search().clone();
        assert!(search.read(cx).focus_handle(cx).is_focused(window), "the section search");
    });
}
