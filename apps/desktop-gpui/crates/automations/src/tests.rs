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

//! UI integration tests: the Scheduled tasks page in a headless window,
//! driven through its rows, switches, buttons, and dialogs, against a
//! scripted Host that keeps a scheduled-task catalog the way the Host's
//! `ScheduledTaskCoordinator` answers it (every change bumps the revision;
//! a continuation at a stale revision is `revision_changed`; a
//! notification fired with no delivery service is refused and held) and a
//! Daily Review, in the shapes
//! packages/runtime-host/src/protocol/scheduled-task.ts and
//! daily-review.ts decode.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::component::select::SelectEvent;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    TestAppContext, Window, WindowHandle, div, px, size,
};
use host_client::{ConnectionEvent, HostEvent};
use host_protocol::{
    ChangeNotice, HostAccepted, HostOperationErrorCode, PushFrame, ScheduledTaskChangedReason,
};
use serde_json::{Value, json};
use shared::copy::Locale;
use shared::copy::automations as copy;
use shared::domain_element_id;
use workspace::{HostRequestError, HostSession, HostTransport};

use crate::awake::{AwakeBlocker, KeepSystemAwake};
use crate::catalog::{ScheduledTasks, ScheduledTasksEvent};
use crate::form::Recurrence;
use crate::page::{AutomationsEvent, AutomationsView, HubTab, TasksView};

type Reply = Result<Value, HostRequestError>;

/// Far in the future: a task that has not fired yet whenever the test runs.
const LATER: u64 = 4_000_000_000_000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// A task as the Host lists it, with `overrides`.
fn task(id: &str, title: &str, overrides: Value) -> Value {
    let mut task = json!({
        "id": id, "title": title, "intent": {"kind": "text", "body": ""},
        "schedule": {"kind": "once", "runAt": LATER},
        "effect": {"kind": "notify", "channel": "local"},
        "status": "active", "nextFireAt": LATER, "lastFireAt": null, "fireCount": 0,
        "maxFires": null, "expiresAt": null, "createdBy": {"kind": "user"},
        "createdAt": 1, "updatedAt": 1, "runs": [], "lastError": null
    });
    if let (Some(task), Value::Object(overrides)) = (task.as_object_mut(), overrides) {
        task.extend(overrides);
    }
    task
}

fn agent_effect() -> Value {
    json!({"kind": "session_resume", "sessionId": "session-1"})
}

/// The catalog the scripted Host keeps.
#[derive(Default)]
struct Catalog {
    revision: u64,
    tasks: Vec<Value>,
    /// Tasks per page (all on one when 0).
    page_size: usize,
    /// Continuations that find the catalog moved on first.
    moves: usize,
    next_id: u64,
}

#[derive(Default)]
struct Review {
    archives: Vec<Value>,
}

#[derive(Default)]
struct ScriptedHost {
    catalog: Mutex<Catalog>,
    review: Mutex<Review>,
    requests: Mutex<Vec<(String, Value)>>,
}

impl ScriptedHost {
    fn new(tasks: Vec<Value>) -> Arc<Self> {
        let host = Self::default();
        *host.catalog.lock().expect("catalog") =
            Catalog { revision: 1, tasks, next_id: 100, ..Catalog::default() };
        Arc::new(host)
    }

    fn requests(&self, operation: &str) -> Vec<Value> {
        let requests = self.requests.lock().expect("requests");
        requests.iter().filter(|(op, _)| op == operation).map(|(_, input)| input.clone()).collect()
    }

    fn clear(&self) {
        self.requests.lock().expect("requests").clear();
    }

    fn with_catalog<R>(&self, f: impl FnOnce(&mut Catalog) -> R) -> R {
        f(&mut self.catalog.lock().expect("catalog"))
    }

    fn query(&self, input: &Value) -> Reply {
        let mut catalog = self.catalog.lock().expect("catalog");
        if input["kind"] == "get" {
            let task = catalog.tasks.iter().find(|task| task["id"] == input["taskId"]).cloned();
            return Ok(json!({"kind": "task", "task": task}));
        }
        if let Some(expected) = input["expectedRevision"].as_u64() {
            if catalog.moves > 0 {
                // Another client's change lands between two pages.
                catalog.moves -= 1;
                catalog.revision += 1;
            }
            if expected != catalog.revision {
                return Ok(json!({"kind": "revision_changed", "expected": expected,
                                 "actual": catalog.revision}));
            }
        }
        let start = input["cursor"].as_str().map_or(0, |cursor| cursor.parse().expect("cursor"));
        let size =
            if catalog.page_size == 0 { catalog.tasks.len().max(1) } else { catalog.page_size };
        let end = (start + size).min(catalog.tasks.len());
        let next = (end < catalog.tasks.len()).then(|| end.to_string());
        Ok(json!({"kind": "page", "revision": catalog.revision,
                  "tasks": catalog.tasks[start..end], "nextCursor": next}))
    }

    fn mutate(&self, input: &Value) -> Reply {
        let mut catalog = self.catalog.lock().expect("catalog");
        let kind = input["kind"].as_str().expect("kind");
        if kind == "create" {
            catalog.next_id += 1;
            let id = format!("task-{}", catalog.next_id);
            let draft = &input["input"];
            let mut created = task(&id, draft["title"].as_str().expect("title"), json!({}));
            created["intent"]["body"] = draft["intentBody"].clone();
            created["schedule"] = draft["schedule"].clone();
            created["effect"] = draft["effect"].clone();
            catalog.tasks.push(created.clone());
            catalog.revision += 1;
            return Ok(json!({"kind": "task", "task": created}));
        }
        let Some(ix) = catalog.tasks.iter().position(|task| task["id"] == input["taskId"]) else {
            return Err(operation_error(
                HostOperationErrorCode::NotFound,
                "No such scheduled task",
            ));
        };
        let task = &mut catalog.tasks[ix];
        match kind {
            "update" => {
                if let Value::Object(patch) = &input["patch"] {
                    for (key, value) in patch {
                        match key.as_str() {
                            "intentBody" => task["intent"]["body"] = value.clone(),
                            key => task[key] = value.clone(),
                        }
                    }
                }
            }
            "pause" => task["status"] = json!("paused"),
            "resume" => task["status"] = json!("active"),
            "snooze" => {
                let next = task["nextFireAt"].as_u64().expect("next")
                    + input["delayMs"].as_u64().expect("delay");
                task["nextFireAt"] = json!(next);
            }
            "clear_history" => {
                task["runs"] = json!([]);
                task["lastError"] = Value::Null;
            }
            "trigger_now" => {
                if task["effect"]["kind"] == "notify" {
                    return Err(operation_error(
                        HostOperationErrorCode::OperationConflict,
                        "ScheduledTask native delivery is waiting for a Desktop provider",
                    ));
                }
                let run = json!({"id": "run-now", "at": now_ms(), "outcome": "ok",
                                 "message": "已在原任务中继续执行。", "sessionId": "session-1"});
                task["runs"] = json!([run]);
            }
            "delete" => {
                let id = input["taskId"].clone();
                catalog.tasks.remove(ix);
                catalog.revision += 1;
                return Ok(json!({"kind": "deleted", "taskId": id}));
            }
            other => panic!("unexpected mutation {other}"),
        }
        let task = task.clone();
        catalog.revision += 1;
        Ok(json!({"kind": "task", "task": task}))
    }

    fn review_query(&self, input: &Value) -> Reply {
        let review = self.review.lock().expect("review");
        match input["kind"].as_str().expect("kind") {
            "summary" => Ok(json!({"kind": "summary", "summary": summary()})),
            "archives" => {
                let summaries: Vec<Value> = review
                    .archives
                    .iter()
                    .map(|archive| {
                        let mut summary = archive.clone();
                        summary.as_object_mut().expect("object").remove("sections");
                        summary
                    })
                    .collect();
                Ok(json!({"kind": "archives", "archives": summaries,
                          "beforeArchiveId": input["beforeArchiveId"],
                          "nextBeforeArchiveId": null}))
            }
            "archive" => {
                let archive = review
                    .archives
                    .iter()
                    .find(|archive| archive["id"] == input["archiveId"])
                    .cloned();
                Ok(json!({"kind": "archive", "archive": archive}))
            }
            other => panic!("unexpected review query {other}"),
        }
    }

    fn review_mutate(&self, input: &Value) -> Reply {
        assert_eq!(input["kind"], "run");
        let archive = archive();
        self.review.lock().expect("review").archives = vec![archive.clone()];
        Ok(json!({"kind": "archive", "archive": archive}))
    }
}

fn operation_error(code: HostOperationErrorCode, message: &str) -> HostRequestError {
    HostRequestError::Operation {
        operation: "scheduled-task.mutate",
        code,
        message: message.into(),
    }
}

/// Today's activity: two tasks, one of them without a name.
fn summary() -> Value {
    let (from, to) = today();
    json!({
        "day": {"fromMs": from, "toMs": to},
        "totals": {"sessionCount": 2, "requestCount": 5, "totalTokens": 12_345,
                   "costUsd": 0.25, "errorCount": 0},
        "sessions": [
            {"id": "s1", "name": "Refactor the parser", "lastMessageAt": now_ms(),
             "lastMessagePreview": "Done."},
            {"id": "s2", "name": "", "lastMessageAt": now_ms()}
        ],
        "topTools": [], "topModels": []
    })
}

/// Today's local bounds.
fn today() -> (u64, u64) {
    use chrono::{Duration as Days, Local, TimeZone as _};
    let midnight = Local::now().date_naive().and_hms_opt(0, 0, 0).expect("midnight");
    let from = Local.from_local_datetime(&midnight).earliest().expect("from");
    let to = Local.from_local_datetime(&(midnight + Days::days(1))).earliest().expect("to");
    (from.timestamp_millis() as u64, to.timestamp_millis() as u64)
}

fn archive() -> Value {
    let (from, to) = today();
    json!({
        "id": "2026-09-28-1d", "day": {"fromMs": from, "toMs": to}, "range": 1, "status": "ok",
        "generatedAt": now_ms(), "trigger": "manual", "modelKey": "openai::gpt-5",
        "sections": {"summary": "Two tasks moved.", "gaps": "Nothing missed."},
        "totals": {"sessionCount": 2, "requestCount": 5, "totalTokens": 12_345, "costUsd": 0.25,
                   "errorCount": 0}
    })
}

impl HostTransport for ScriptedHost {
    fn request(&self, operation: &'static str, input: Value, _: Duration) -> Boxed<Reply> {
        self.requests.lock().expect("requests").push((operation.to_owned(), input.clone()));
        let reply = match operation {
            "scheduled-task.query" => self.query(&input),
            "scheduled-task.mutate" => self.mutate(&input),
            "daily-review.query" => self.review_query(&input),
            "daily-review.mutate" => self.review_mutate(&input),
            other => Err(HostRequestError::Transport(format!("unexpected {other}").into())),
        };
        Box::pin(async move { reply })
    }
}

fn accepted() -> HostAccepted {
    serde_json::from_value(json!({
        "kind": "accepted", "rootId": "r", "hostEpoch": "e1", "connectionId": "c",
        "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
        "compositionRevision": "3", "state": "ready"
    }))
    .expect("accepted")
}

/// The page as the shell draws it; `Root` draws the dialog and notification
/// layers over it.
struct Shell(Entity<AutomationsView>);

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.0.clone())
    }
}

struct Harness {
    transport: Arc<ScriptedHost>,
    host: Entity<HostSession>,
    catalog: Entity<ScheduledTasks>,
    view: Entity<AutomationsView>,
    window: WindowHandle<Root>,
    events: Rc<RefCell<Vec<AutomationsEvent>>>,
    fired: Rc<RefCell<Vec<String>>>,
    holds: Rc<Cell<usize>>,
}

/// A hold that counts how many are alive.
struct CountedHold(Rc<Cell<usize>>);

impl Drop for CountedHold {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

impl Harness {
    fn open(transport: Arc<ScriptedHost>, cx: &mut TestAppContext) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            // Dialogs slide in on the wall clock; with motion reduced they
            // settle on their first frame.
            cx.set_reduce_motion(true);
        });
        let holds = Rc::new(Cell::new(0));
        let counted = holds.clone();
        let blocker: AwakeBlocker = Rc::new(move || {
            counted.set(counted.get() + 1);
            Some(Box::new(CountedHold(counted.clone())))
        });
        cx.update(|cx| {
            let awake = cx.new(|cx| KeepSystemAwake::new(None, Some(blocker), cx));
            KeepSystemAwake::install(awake, cx);
        });
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone())
        });
        let catalog = cx.new(|cx| ScheduledTasks::new(host.clone(), cx));
        let fired = Rc::new(RefCell::new(Vec::new()));
        let recorded = fired.clone();
        cx.update(|cx| {
            cx.subscribe(&catalog, move |_, event: &ScheduledTasksEvent, _| {
                let ScheduledTasksEvent::Fired { title, .. } = event;
                recorded.borrow_mut().push(title.to_string());
            })
            .detach();
        });
        let mut view = None;
        let page_catalog = catalog.clone();
        let window = cx.open_window(size(px(1100.), px(900.)), |window, cx| {
            let page = cx.new(|cx| AutomationsView::new(page_catalog, window, cx));
            view = Some(page.clone());
            let shell = cx.new(|_| Shell(page));
            Root::new(shell, window, cx)
        });
        let view = view.expect("view");
        let events = Rc::new(RefCell::new(Vec::new()));
        let recorded = events.clone();
        cx.update(|cx| {
            cx.subscribe(&view, move |_, event: &AutomationsEvent, _| {
                recorded.borrow_mut().push(event.clone());
            })
            .detach();
        });
        let harness = Self { transport, host, catalog, view, window, events, fired, holds };
        harness.connect(cx);
        harness.view.update(cx, |view, cx| view.activate(cx));
        cx.run_until_parked();
        harness
    }

    fn connect(&self, cx: &mut TestAppContext) {
        self.host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
                cx,
            )
        });
        cx.run_until_parked();
    }

    fn push_changed(
        &self,
        reason: ScheduledTaskChangedReason,
        task_id: &str,
        cx: &mut TestAppContext,
    ) {
        let revision = self.transport.with_catalog(|catalog| catalog.revision);
        let notice =
            ChangeNotice::ScheduledTaskChanged { revision, reason, task_id: task_id.to_owned() };
        self.host.update(cx, |host, cx| {
            host.handle_host_event(HostEvent::Push(PushFrame::Change(notice)), cx)
        });
        cx.run_until_parked();
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Window, &mut gpui_kit::App) -> R,
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

    /// The mutations sent, in order.
    fn mutations(&self) -> Vec<Value> {
        self.transport.requests("scheduled-task.mutate")
    }

    /// The list reads sent, in order: `None` for a first page, else the
    /// cursor.
    fn reads(&self) -> Vec<Option<String>> {
        self.transport
            .requests("scheduled-task.query")
            .into_iter()
            .filter(|input| input["kind"] == "list")
            .map(|input| input["cursor"].as_str().map(str::to_owned))
            .collect()
    }
}

fn row(id: &str) -> gpui_kit::ElementId {
    domain_element_id("scheduled-task-row", id)
}

fn description(id: &str) -> gpui_kit::ElementId {
    domain_element_id("scheduled-task-description", id)
}

/// A reminder, an Agent task with a failed last run, and a paused one.
fn standard() -> Arc<ScriptedHost> {
    ScriptedHost::new(vec![
        task("t1", "Stand-up", json!({"createdAt": 3})),
        task(
            "t2",
            "Weekly review",
            json!({
                "createdAt": 2, "effect": agent_effect(),
                "schedule": {"kind": "cron", "expression": "0 20 * * 0", "startAt": 1},
                "runs": [{"id": "r1", "at": 1_000_000, "outcome": "failed",
                          "message": "The model was unavailable."}]
            }),
        ),
        task("t3", "Water the plants", json!({"createdAt": 1, "status": "paused"})),
    ])
}

#[gpui_kit::test]
fn the_page_heads_its_column_and_its_bar_holds_the_tabs_and_the_views(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.with_window(cx, |window, _| {
        // The page's header: its title, the active count beside it on the
        // title's centre line, and its controls at the column's end.
        let header = window.find("page-header").bounds();
        let title = window.find("page-title");
        assert_eq!(title.label(), Some("Scheduled tasks"));
        assert_eq!(title.role(), Some(gpui_kit::Role::Heading));
        let meta = window.find("page-meta").bounds();
        assert!(meta.left() > title.bounds().right());
        let centre =
            |bounds: gpui_kit::Bounds<gpui_kit::Pixels>| bounds.top() + bounds.size.height / 2.;
        assert!((centre(meta) - centre(title.bounds())).abs() < gpui_kit::px(1.), "{meta:?}");
        let actions = window.find("scheduled-tasks-actions").bounds();
        assert!(header.right() - actions.right() < gpui_kit::px(1.), "at the column's end");
        // The bar, 16 + 12 under the header: the tabs (labels only, the
        // selected one said so) at the start, the views at the row's end.
        let tabs = window.within("automations-tabs");
        let first = tabs.find(domain_element_id("automations-tab", "scheduled-tasks"));
        assert_eq!(first.bounds().top() - header.bottom(), gpui_kit::px(28.));
        assert_eq!(first.role(), Some(gpui_kit::Role::Tab));
        assert_eq!(first.selected(), Some(true));
        let other = tabs.find(domain_element_id("automations-tab", "daily-review"));
        assert_eq!(other.selected(), Some(false));
        assert_eq!(first.bounds().left(), header.left(), "on the column's edge");
        let views = window.find("scheduled-task-views").bounds();
        assert!(views.top() < first.bounds().bottom() && first.bounds().top() < views.bottom());
        let toolbar = window.find("scheduled-tasks-toolbar").bounds();
        assert!((header.right() - toolbar.right()).abs() < gpui_kit::px(1.), "{toolbar:?}");
    });
}

#[gpui_kit::test]
fn the_page_lists_every_task_read_page_by_page(cx: &mut TestAppContext) {
    let transport = standard();
    transport.with_catalog(|catalog| catalog.page_size = 2);
    let harness = Harness::open(transport, cx);
    assert_eq!(harness.reads(), [None, Some("2".to_owned())], "two pages of two");
    let continuation = &harness.transport.requests("scheduled-task.query")[1];
    assert_eq!(continuation["expectedRevision"], json!(1), "at the first page's revision");
    harness.with_window(cx, |window, _| {
        // Newest created first; each row says its state in words.
        assert!(window.find(row("t1")).bounds().top() < window.find(row("t2")).bounds().top());
        let agent = window.find(description("t2")).label().expect("label").to_owned();
        assert!(agent.starts_with("Agent scheduled task · Failed · Cron 0 20 * * 0"), "{agent}");
        // A paused task will not run: its state takes the end lane, once.
        let paused = window.find(description("t3")).label().expect("label").to_owned();
        assert!(paused.starts_with("One-time task · Next run:"), "{paused}");
        let lane = window.find(domain_element_id("scheduled-task-lane", "t3"));
        assert_eq!(lane.label(), Some("Paused"));
        // Fewer than eight tasks: no search, sort, or filter.
        assert!(window.try_find("scheduled-tasks-toolbar").is_some());
    });
    assert_eq!(
        harness.view.read_with(cx, |view, cx| view.header_meta(cx)),
        Some("2 active".into())
    );
    assert_eq!(harness.catalog.read_with(cx, |catalog, _| catalog.active_count()), 2);
}

#[gpui_kit::test]
fn a_catalog_that_changes_between_pages_is_read_again_from_the_start(cx: &mut TestAppContext) {
    let transport = standard();
    transport.with_catalog(|catalog| {
        catalog.page_size = 2;
        catalog.moves = 1;
    });
    let harness = Harness::open(transport, cx);
    // The continuation finds revision 2, so the listing starts over there.
    assert_eq!(harness.reads(), [None, Some("2".to_owned()), None, Some("2".to_owned())]);
    let queries = harness.transport.requests("scheduled-task.query");
    assert_eq!(queries[3]["expectedRevision"], json!(2));
    harness.with_window(cx, |window, _| assert!(window.find(row("t3")).visible()));
}

#[gpui_kit::test]
fn a_changed_frame_reads_the_catalog_again_and_a_fire_is_announced(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.transport.clear();
    harness.transport.with_catalog(|catalog| {
        catalog.tasks[0]["title"] = json!("Stand-up notes");
        catalog.revision += 1;
    });
    harness.push_changed(ScheduledTaskChangedReason::Updated, "t1", cx);
    assert_eq!(harness.reads(), [None], "the catalog, read again");
    harness.with_window(cx, |window, _| {
        assert!(window.find(row("t1")).label().expect("label").starts_with("Stand-up notes"));
    });
    // A fired Agent task is looked up and announced; a local reminder is
    // Desktop's own native effect's to announce.
    harness.transport.clear();
    harness.push_changed(ScheduledTaskChangedReason::Fired, "t2", cx);
    harness.push_changed(ScheduledTaskChangedReason::Fired, "t1", cx);
    let gets: Vec<Value> = harness
        .transport
        .requests("scheduled-task.query")
        .into_iter()
        .filter(|input| input["kind"] == "get")
        .collect();
    assert_eq!(
        gets,
        [json!({"kind": "get", "taskId": "t2"}), json!({"kind": "get", "taskId": "t1"})]
    );
    assert_eq!(*harness.fired.borrow(), ["Weekly review"]);
}

#[gpui_kit::test]
fn each_change_goes_out_as_the_host_decodes_it_and_the_list_is_read_again(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.with_window(cx, |window, cx| window.click(row("t1"), cx));
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("scheduled-task-detail-title").label(), Some("Stand-up"));
        harness.transport.clear();
        window.click("scheduled-task-enabled", cx);
    });
    assert_eq!(harness.mutations(), [json!({"kind": "pause", "taskId": "t1"})]);
    assert_eq!(harness.reads(), [None], "read again after the change");
    harness.with_window(cx, |window, cx| {
        let lane = window.find(domain_element_id("scheduled-task-lane", "t1"));
        assert_eq!(lane.label(), Some("Paused"));
        window.click("scheduled-task-enabled", cx);
    });
    assert_eq!(harness.mutations().last(), Some(&json!({"kind": "resume", "taskId": "t1"})));
    harness.with_window(cx, |window, cx| {
        // Desktop's size sm.
        for id in ["scheduled-task-snooze", "scheduled-task-trigger"] {
            assert_eq!(window.find(id).bounds().size.height, px(28.), "{id}");
        }
        window.click("scheduled-task-snooze", cx)
    });
    assert_eq!(
        harness.mutations().last(),
        Some(&json!({"kind": "snooze", "taskId": "t1", "delayMs": 600_000}))
    );
    let next = harness.transport.with_catalog(|catalog| catalog.tasks[0]["nextFireAt"].clone());
    assert_eq!(next, json!(LATER + 600_000));
    // Escape closes the detail; the Agent task's Trigger now runs it.
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    harness.with_window(cx, |window, cx| window.click(row("t2"), cx));
    harness.with_window(cx, |window, cx| {
        // An Agent's task is neither edited nor duplicated here, as in Desktop.
        assert!(window.try_find("scheduled-task-edit").is_none());
        assert!(window.try_find("scheduled-task-duplicate").is_none());
        window.click("scheduled-task-trigger", cx);
    });
    assert_eq!(harness.mutations().last(), Some(&json!({"kind": "trigger_now", "taskId": "t2"})));
    // Clear history asks first.
    harness.with_window(cx, |window, cx| window.click("scheduled-task-clear-runs", cx));
    let before = harness.mutations().len();
    harness.with_window(cx, |window, cx| {
        assert!(window.try_find("scheduled-task-detail").is_some(), "the detail stays under it");
        window.press("enter", cx);
    });
    assert_eq!(harness.mutations().len(), before + 1);
    assert_eq!(harness.mutations().last(), Some(&json!({"kind": "clear_history", "taskId": "t2"})));
    // Delete asks first, and the detail closes once the task is gone.
    harness.with_window(cx, |window, cx| window.click("scheduled-task-delete", cx));
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    assert_eq!(harness.mutations().last(), Some(&json!({"kind": "delete", "taskId": "t2"})));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("scheduled-task-detail").is_none());
        assert!(window.try_find(row("t2")).is_none());
    });
    assert_eq!(harness.view.read_with(cx, |view, _| view.detail().cloned()), None);
}

#[gpui_kit::test]
fn a_reminder_waiting_for_maka_desktop_says_so(cx: &mut TestAppContext) {
    let transport = standard();
    // A reminder whose time has passed: the Host holds its fire.
    transport.with_catalog(|catalog| catalog.tasks[2]["nextFireAt"] = json!(1_000));
    transport.with_catalog(|catalog| catalog.tasks[2]["status"] = json!("active"));
    let harness = Harness::open(transport, cx);
    harness.with_window(cx, |window, cx| {
        // The fire is past its time: the end lane says what it waits for,
        // not Overdue forever, and the line does not say it again.
        let waiting = window.find(description("t3")).label().expect("label").to_owned();
        assert!(!waiting.contains("Maka Desktop"), "{waiting}");
        let lane = window.find(domain_element_id("scheduled-task-lane", "t3"));
        assert_eq!(lane.label(), Some(copy::LANE_NEEDS_DESKTOP.en()));
        // Every row's lane is the same fixed width, at the same edge.
        let other = window.find(domain_element_id("scheduled-task-lane", "t1")).bounds();
        assert_eq!(lane.bounds().size.width, gpui_kit::px(128.));
        assert_eq!(other.size.width, lane.bounds().size.width);
        assert_eq!(other.right(), lane.bounds().right());
        window.click(domain_element_id("scheduled-task-view", "runs"), cx);
    });
    harness.with_window(cx, |window, _| {
        let run = window.find(domain_element_id("scheduled-task-waiting", "t3"));
        assert!(run.label().expect("label").contains(copy::WAITING_FOR_DESKTOP.en()));
        // The range keeps its own width on the views' line, at the column's
        // end.
        let header = window.find("page-header").bounds();
        let views = window.find("scheduled-task-views").bounds();
        let range = window.find("scheduled-tasks-range").bounds();
        assert!(range.top() < views.bottom() && views.top() < range.bottom(), "{range:?}");
        assert!(range.size.width < header.size.width / 4., "{range:?}");
        assert!((header.right() - range.right()).abs() < gpui_kit::px(1.), "{range:?}");
        // Desktop's small toolbar: the switch and the range both 28 tall,
        // centred on one line, 12 apart, the range 148 wide.
        assert_eq!(views.size.height, gpui_kit::px(28.));
        assert_eq!(range.size.height, gpui_kit::px(28.));
        assert_eq!(range.center().y, views.center().y);
        assert_eq!(range.left() - views.right(), gpui_kit::px(12.));
        assert_eq!(range.size.width, gpui_kit::px(148.));
    });
    // Its detail says it once, in the notice: no run is made up for it.
    harness.view.update(cx, |view, cx| view.set_view(TasksView::Tasks, cx));
    harness.with_window(cx, |window, cx| window.click(row("t3"), cx));
    harness.with_window(cx, |window, cx| {
        assert!(window.find("scheduled-task-detail-waiting").visible());
        assert!(window.try_find("scheduled-task-detail-runs").is_none());
        assert!(window.find("scheduled-task-no-runs").visible());
        window.press("escape", cx);
    });
    // Trigger now on a reminder: the Host holds the fire; the detail says
    // why, and the row and the runs say it waits.
    harness.with_window(cx, |window, cx| window.click(row("t1"), cx));
    harness.with_window(cx, |window, cx| window.click("scheduled-task-trigger", cx));
    harness.with_window(cx, |window, _| {
        let feedback = window.find("scheduled-task-detail-feedback");
        assert_eq!(
            feedback.label(),
            Some(format!("{}: {}", copy::TRIGGER_FAILED.en(), copy::NEEDS_DESKTOP.en()).as_str())
        );
        let notice = window.find("scheduled-task-detail-waiting");
        assert!(notice.visible());
        assert_eq!(
            notice.label(),
            Some(
                format!("{}. {}", copy::WAITING_NOTICE_TITLE.en(), copy::NEEDS_DESKTOP_FIRES.en())
                    .as_str()
            )
        );
    });
    // The notice wraps inside the detail rather than run past its edge, in
    // Chinese too, where a line has no spaces to break at.
    for locale in [Locale::English, Locale::SimplifiedChinese] {
        cx.update(|cx| locale.apply(cx));
        harness.with_window(cx, |window, _| {
            let notice = window.find("scheduled-task-detail-waiting").bounds();
            let header = window.find("dialog-header").bounds();
            assert!(notice.right() <= header.right(), "{locale:?}: {notice:?} past {header:?}");
            // The window's one banner, with no ring: 16 in, the glyph, 8,
            // then the title.
            let title = window.find("scheduled-task-detail-waiting-title").bounds();
            assert_eq!(title.left() - notice.left(), px(40.), "{locale:?}");
            // A phrase on one line, as the disconnected banner's title; the
            // sentence goes under it.
            assert_eq!(title.size.height, px(20.), "{locale:?}");
        });
    }
    cx.update(|cx| Locale::English.apply(cx));
    harness.with_window(cx, |window, _| {
        // The facts are Desktop's `MetadataList` rows: a 20px line each,
        // 8 apart.
        let recurrence = window.find("scheduled-task-recurrence").bounds();
        let next = window.find("scheduled-task-next-run").bounds();
        assert_eq!(recurrence.size.height, px(20.));
        assert_eq!(next.top() - recurrence.bottom(), px(8.));
        assert!(window.find(description("t1")).label().expect("label").starts_with("Waiting"));
    });
    assert!(harness.catalog.read_with(cx, |catalog, _| catalog.is_held("t1")));
    // Pausing drops the held fire.
    harness.with_window(cx, |window, cx| window.click("scheduled-task-enabled", cx));
    assert!(!harness.catalog.read_with(cx, |catalog, _| catalog.is_held("t1")));
}

#[gpui_kit::test]
fn the_form_validates_and_creates_a_task(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.with_window(cx, |window, cx| window.click("scheduled-task-create", cx));
    let form = harness.view.read_with(cx, |view, _| view.form().cloned()).expect("the form");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("scheduled-task-form-title").label(), Some("New scheduled task"));
        // Empty, but the title's message waits for typing.
        assert!(
            window
                .try_find(domain_element_id("settings-status", "scheduled-task-error-title"))
                .is_none()
        );
        // The header: Use template, then close, on the title's line, the
        // close at the fields' right edge.
        let title = window.find("scheduled-task-form-title").bounds();
        let template = window.find("scheduled-task-template").bounds();
        let close = window.find(shared::dialog::DIALOG_CLOSE_ID).bounds();
        let field = window.find(domain_element_id("scheduled-task-field", "title")).bounds();
        let line = title.top() + gpui_kit::px(12.);
        for control in [template, close] {
            let centre = control.top() + control.size.height / 2.;
            assert!((centre - line).abs() < gpui_kit::px(1.), "{control:?} off {title:?}");
        }
        assert!(title.right() <= template.left() && template.right() <= close.left());
        assert!((close.right() - field.right()).abs() < gpui_kit::px(1.), "{close:?} {field:?}");
        // The dialog's controls at the control size: fields 32px, the
        // preset chips 28px.
        let input = window.find("scheduled-task-title-input").bounds();
        assert_eq!(input.size.height, gpui_kit::px(32.));
        let preset = window.find(domain_element_id("scheduled-task-preset", "one-hour")).bounds();
        assert_eq!(preset.size.height, gpui_kit::px(28.));
    });
    // Create is disabled with no title: a click sends nothing.
    harness.transport.clear();
    harness.with_window(cx, |window, cx| window.click("scheduled-task-submit", cx));
    assert!(harness.mutations().is_empty());
    let title = form.read_with(cx, |form, _| form.title_input().clone());
    harness.with_window(cx, |window, cx| {
        title.update(cx, |title, cx| title.focus(window, cx));
        window.input("Stand-up", cx);
    });
    // A cron rule that does not compile.
    let recurrence = form.read_with(cx, |form, _| form.recurrence_select().clone());
    let cron = form.read_with(cx, |form, _| form.cron_input().clone());
    harness.with_window(cx, |window, cx| {
        // As a pick from the dropdown confirms it.
        recurrence.update(cx, |select, cx| {
            select.set_selected_value(&Recurrence::Cron, window, cx);
            cx.emit(SelectEvent::Confirm(Some(Recurrence::Cron)));
        });
    });
    harness.with_window(cx, |window, cx| {
        cron.update(cx, |cron, cx| cron.set_value("", window, cx));
        cron.update(cx, |cron, cx| cron.focus(window, cx));
        window.input("0 9 * *", cx);
    });
    harness.with_window(cx, |window, _| {
        let error = window.find(domain_element_id("settings-status", "scheduled-task-error-cron"));
        assert_eq!(error.label(), Some(copy::INVALID_CRON.en()));
    });
    harness.with_window(cx, |window, cx| window.input(" 1-5", cx));
    harness.transport.clear();
    harness.with_window(cx, |window, cx| window.click("scheduled-task-submit", cx));
    let sent = harness.mutations();
    assert_eq!(sent.len(), 1);
    let input = &sent[0]["input"];
    assert_eq!(sent[0]["kind"], "create");
    assert_eq!(input["title"], "Stand-up");
    assert_eq!(input["effect"], json!({"kind": "notify", "channel": "local"}));
    assert_eq!(input["schedule"]["kind"], "cron");
    assert_eq!(input["schedule"]["expression"], "0 9 * * 1-5");
    assert!(input["schedule"]["startAt"].as_u64().expect("startAt") > now_ms());
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("scheduled-task-form").is_none(), "the dialog closed");
        assert!(window.find(row("task-101")).visible());
    });
    assert!(harness.view.read_with(cx, |view, _| view.form().is_none()));
}

#[gpui_kit::test]
fn an_edit_from_the_detail_saves_and_gives_the_detail_back(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.with_window(cx, |window, cx| window.click(row("t1"), cx));
    harness.with_window(cx, |window, cx| window.click("scheduled-task-edit", cx));
    let form = harness.view.read_with(cx, |view, _| view.form().cloned()).expect("the form");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("scheduled-task-form-title").label(), Some("Edit scheduled task"));
        assert!(window.try_find("scheduled-task-detail").is_none(), "the form took its place");
        assert!(window.try_find("scheduled-task-template").is_none(), "no templates for an edit");
    });
    let note = form.read_with(cx, |form, _| form.note_input().clone());
    harness.with_window(cx, |window, cx| {
        note.update(cx, |note, cx| note.focus(window, cx));
        window.input("Bring notes", cx);
    });
    harness.transport.clear();
    harness.with_window(cx, |window, cx| window.click("scheduled-task-submit", cx));
    // The time and the repeat rule are as they were: the schedule stays.
    assert_eq!(
        harness.mutations(),
        [json!({"kind": "update", "taskId": "t1", "patch": {
            "title": "Stand-up", "intentBody": "Bring notes",
            "effect": {"kind": "notify", "channel": "local"}}})]
    );
    harness.with_window(cx, |_, _| {});
    harness.with_window(cx, |window, _| {
        assert!(window.find("scheduled-task-detail").visible(), "the detail is back");
    });
}

#[gpui_kit::test]
fn the_list_controls_show_from_eight_tasks_and_narrow_the_list(cx: &mut TestAppContext) {
    let tasks = (0..8)
        .map(|ix| {
            let status = if ix == 7 { "completed" } else { "active" };
            task(
                &format!("t{ix}"),
                &format!("Task {ix}"),
                json!({"createdAt": ix, "status": status}),
            )
        })
        .collect();
    let harness = Harness::open(ScriptedHost::new(tasks), cx);
    let search = harness.view.read_with(cx, |view, _| view.search().clone());
    harness.with_window(cx, |window, cx| {
        search.update(cx, |search, cx| search.focus(window, cx));
        window.input("task 7", cx);
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("scheduled-tasks-search-summary").label(), Some("1 matching task"));
        assert!(window.find(row("t7")).visible());
        assert!(window.try_find(row("t1")).is_none());
    });
    harness.with_window(cx, |window, cx| window.input("x", cx));
    harness.with_window(cx, |window, cx| {
        assert!(window.find("scheduled-tasks-no-match").visible());
        window.click("scheduled-tasks-reset", cx);
    });
    harness.with_window(cx, |window, _| assert!(window.find(row("t1")).visible()));
    // The keyboard walks the rows from the list's one Tab stop.
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.focus(window, cx));
        window.press("down", cx);
        window.press("down", cx);
        window.press("enter", cx);
    });
    assert_eq!(harness.view.read_with(cx, |view, _| view.detail().cloned()), Some("t6".into()));
}

#[gpui_kit::test]
fn keep_system_awake_holds_while_it_is_on(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    assert_eq!(harness.holds.get(), 0);
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.toggle_keep_awake(window, cx));
    });
    assert_eq!(harness.holds.get(), 1);
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.toggle_keep_awake(window, cx));
    });
    assert_eq!(harness.holds.get(), 0, "let go");
}

#[gpui_kit::test]
fn the_daily_review_reads_the_day_generates_a_report_and_exports_it(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.view.update(cx, |view, cx| view.set_tab(HubTab::DailyReview, cx));
    cx.run_until_parked();
    let queries = harness.transport.requests("daily-review.query");
    assert_eq!(queries[0], json!({"kind": "summary", "daySpan": 1, "offsetDays": 0}));
    assert_eq!(queries[1], json!({"kind": "archives", "beforeArchiveId": null, "limit": 32}));
    harness.with_window(cx, |window, cx| {
        assert_eq!(
            window.find(domain_element_id("daily-review-metric", "tokens")).label(),
            Some("Tokens: 12,345")
        );
        assert!(window.find(domain_element_id("daily-review-session", "s1")).visible());
        window.click(domain_element_id("daily-review-session", "s1"), cx);
    });
    assert_eq!(harness.events.borrow().last(), Some(&AutomationsEvent::OpenTask("s1".into())));
    // The page meta is Desktop's archive.sessionCount, not the toast's
    // tasks-and-requests line.
    let meta = harness.view.read_with(cx, |view, cx| view.header_meta(cx)).expect("meta");
    assert!(meta.ends_with(" task") || meta.ends_with(" tasks"), "{meta}");
    assert!(!meta.contains("request"), "{meta}");
    // Earlier: yesterday.
    harness.with_window(cx, |window, cx| window.click("daily-review-earlier", cx));
    let summary = harness.transport.requests("daily-review.query").last().cloned();
    assert_eq!(summary, Some(json!({"kind": "summary", "daySpan": 1, "offsetDays": -1})));
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("daily-review-scope").label(), Some("Yesterday"));
        // The label is centred on the toolbar's 28, as the steppers are.
        let scope = window.find("daily-review-scope").bounds();
        let earlier = window.find("daily-review-earlier").bounds();
        assert_eq!(scope.size.height, px(28.));
        assert_eq!(scope.center().y, earlier.center().y);
        window.click("daily-review-later", cx);
    });
    // Generate analysis: a run, then the report it made.
    harness.with_window(cx, |window, cx| {
        let review = harness.view.read(cx).review().clone();
        review.update(cx, |review, cx| review.generate(window, cx));
    });
    assert_eq!(
        harness.transport.requests("daily-review.mutate"),
        [json!({"kind": "run", "range": 1, "offsetDays": 0, "modelKeyOverride": "",
                "replaceExisting": false})]
    );
    harness.with_window(cx, |window, cx| {
        assert!(window.find("daily-review-report").visible());
        assert!(window.find(domain_element_id("daily-review-section", "Task summary")).visible());
        window.click("daily-review-copy", cx);
    });
    let copied = cx.read_from_clipboard().and_then(|item| item.text()).expect("copied");
    // The confirmation's toast covers the plate's top right; the next
    // export goes through the view.
    let review = harness.view.read_with(cx, |view, _| view.review().clone());
    harness.with_window(cx, |window, cx| {
        review.update(cx, |review, cx| review.append_report(window, cx));
    });
    let Some(AutomationsEvent::AppendToComposer(markdown)) =
        harness.events.borrow().last().cloned()
    else {
        panic!("the report went to the composer");
    };
    assert!(markdown.starts_with("# "), "{markdown}");
    assert!(markdown.contains("## Task summary\nTwo tasks moved."));
    assert!(markdown.contains("## Missed items\nNothing missed."));
    assert_eq!(copied, markdown, "the same Markdown on the clipboard");
    // Back to activity.
    harness.with_window(cx, |window, cx| {
        review.update(cx, |review, cx| review.close_report(cx));
        let _ = window;
    });
    harness.with_window(cx, |window, _| {
        assert!(window.find("daily-review-metrics").visible());
    });
}

#[gpui_kit::test]
fn the_page_menu_is_makas_menu_and_refreshes(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.transport.clear();
    harness.with_window(cx, |window, cx| window.click("scheduled-tasks-menu", cx));
    harness.with_window(cx, |window, cx| {
        let refresh = window.find(domain_element_id("menu-item", "refresh")).bounds();
        assert_eq!(refresh.size.height, gpui_kit::px(32.), "a menu row is 32px");
        window.click(domain_element_id("menu-item", "refresh"), cx);
    });
    harness.with_window(cx, |window, _| assert!(window.try_find("menu").is_none()));
    assert_eq!(harness.reads(), [None], "Refresh reads the list again");
}

#[gpui_kit::test]
fn command_f_focuses_the_tasks_search_while_it_shows(cx: &mut TestAppContext) {
    use gpui_kit::Focusable as _;
    let tasks = |count: usize| -> Vec<Value> {
        (0..count)
            .map(|ix| task(&format!("t{ix}"), &format!("Task {ix}"), json!({"createdAt": ix})))
            .collect()
    };
    let press = |harness: &Harness, cx: &mut TestAppContext| {
        let search = harness.view.read_with(cx, |view, _| view.search().clone());
        harness.with_window(cx, |window, cx| {
            harness.view.update(cx, |view, cx| view.focus(window, cx));
            window.press("secondary-f", cx);
        });
        harness.with_window(cx, |window, cx| search.read(cx).focus_handle(cx).is_focused(window))
    };
    // Below eight tasks there is no search: nothing takes focus.
    let harness = Harness::open(ScriptedHost::new(tasks(2)), cx);
    assert!(!press(&harness, cx), "no search to focus");
    let harness = Harness::open(ScriptedHost::new(tasks(8)), cx);
    assert!(press(&harness, cx), "⌘F from the list");
    // Run history has no search.
    harness.view.update(cx, |view, cx| view.set_view(TasksView::Runs, cx));
    assert!(!press(&harness, cx), "not on Run history");
}
