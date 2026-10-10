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

//! UI integration tests: the production sidebar in a headless window, driven
//! through clicks and keys, against a scripted Host transport.

use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Context, ElementId, Entity, Focusable as _, IntoElement, ParentElement as _,
    Render, Styled as _, TestAppContext, Window, WindowHandle, div, px, size,
};
use host_client::{ConnectionEvent, HostEvent};
use host_protocol::{ChangeNotice, HostAccepted, PushFrame};
use serde_json::{Value, json};
use shared::domain_element_id;
use workspace::{
    HostRequestError, HostRequester, HostSession, HostTransport, ProjectCatalogError,
    ProjectCatalogSource, ProjectEntry, ProjectSelection, UnavailableProjectCatalog,
};

use shared::time::DayGroup;

use crate::{GROUP_ROW_LIMIT, LoadState, SessionCatalog, SessionSidebar};

fn group(key: &str) -> gpui_kit::ElementId {
    domain_element_id("session-group", key)
}

/// Answers `session.catalog.query` from a mutable list, `session.create` by
/// adding to it, and the task commands (`session.metadata.update`,
/// `session.lifecycle.set`, `session.remove.preview`, `session.remove`) by
/// changing it the way the Host does, bumping the revision. Records every
/// request.
#[derive(Default)]
struct ScriptedHost {
    sessions: Mutex<Vec<Value>>,
    requests: Mutex<Vec<(String, Value)>>,
    fail_catalog: Mutex<bool>,
    /// How many metadata updates answer `revision_conflict` first (someone
    /// else changed the session meanwhile).
    conflicts: Mutex<usize>,
    /// The Host's projects as (id, name, path), for `project.catalog.query`
    /// in the locations view and `project.catalog.mutate` `register`.
    projects: Mutex<Vec<(String, String, String)>>,
}

impl ScriptedHost {
    fn with_sessions(sessions: &[(&str, &str, &str)]) -> Arc<Self> {
        let host = Arc::new(Self::default());
        for (id, name, path) in sessions {
            host.add(id, name, path);
        }
        host
    }

    fn add(&self, id: &str, name: &str, path: &str) {
        self.sessions.lock().expect("sessions").push(projection(id, name, path));
    }

    /// Adds a session in registered project `project`, run in `path`.
    fn add_in_project(&self, id: &str, name: &str, path: &str, project: &str) {
        let mut session = projection(id, name, path);
        session["workspace"]["target"] = json!({"kind": "project", "projectId": project});
        self.sessions.lock().expect("sessions").push(session);
    }

    /// Adds a session whose last activity is now, so it is listed under
    /// Today (or Yesterday, a moment after midnight), never under Earlier.
    fn add_recent(&self, id: &str, name: &str, status: &str) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_millis();
        let mut session = projection(id, name, "/work/recent");
        session["activityAt"] = json!(now as u64);
        session["status"] = json!(status);
        self.sessions.lock().expect("sessions").push(session);
    }

    fn requests(&self, operation: &str) -> Vec<Value> {
        let requests = self.requests.lock().expect("requests");
        requests.iter().filter(|(op, _)| op == operation).map(|(_, input)| input.clone()).collect()
    }

    /// Applies `change` to the listed session `id`, bumps its revision, and
    /// returns it.
    fn change(&self, id: &Value, change: impl FnOnce(&mut Value)) -> Value {
        let mut sessions = self.sessions.lock().expect("sessions");
        let session = sessions.iter_mut().find(|session| &session["id"] == id).expect("listed");
        change(session);
        session["revision"] = json!(session["revision"].as_u64().expect("revision") + 1);
        session.clone()
    }

    fn metadata_update(&self, input: &Value) -> Value {
        let revision = {
            let sessions = self.sessions.lock().expect("sessions");
            let session = sessions
                .iter()
                .find(|session| session["id"] == input["sessionId"])
                .expect("listed");
            session["revision"].as_u64().expect("revision")
        };
        let mut conflicts = self.conflicts.lock().expect("conflicts");
        if *conflicts > 0 || input["expectedRevision"] != json!(revision) {
            *conflicts = conflicts.saturating_sub(1);
            // Someone else's change lands first: the revision moves on.
            let moved = self.change(&input["sessionId"], |_| {});
            return json!({"kind": "revision_conflict",
                          "expectedRevision": input["expectedRevision"],
                          "actualRevision": moved["revision"]});
        }
        let patch = input["patch"].clone();
        let session = self.change(&input["sessionId"], |session| {
            if let Some(name) = patch.get("name") {
                session["name"] = name.clone();
            }
            if let Some(flagged) = patch.get("isFlagged") {
                session["isFlagged"] = flagged.clone();
            }
        });
        json!({"kind": "committed", "session": session})
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
            "session.catalog.query" if *self.fail_catalog.lock().expect("flag") => {
                Err(HostRequestError::Transport("the connection was shut down".into()))
            }
            "session.catalog.query" => Ok(json!({
                "kind": "page",
                "revision": format!("sha256:{}", "0".repeat(64)),
                "sessions": *self.sessions.lock().expect("sessions"),
                "nextCursor": null
            })),
            "session.create" => {
                let id = input["sessionId"].as_str().expect("sessionId");
                let workspace = &input["workspace"];
                let created = match workspace["path"].as_str() {
                    Some(path) => projection(id, "New chat", path),
                    None => {
                        // A project this Host lists runs in its folder; one
                        // a fixed test list names, in a stand-in folder.
                        let projects = self.projects.lock().expect("projects");
                        let path = projects
                            .iter()
                            .find(|(project, ..)| workspace["projectId"] == project.as_str())
                            .map(|(.., path)| path.clone())
                            .unwrap_or_else(|| format!("/projects/{}", workspace["projectId"]));
                        let mut created = projection(id, "New chat", &path);
                        created["workspace"]["target"] = workspace.clone();
                        created
                    }
                };
                // As the Host names and stamps a task it creates: its default
                // name, and no activity since it was created.
                let mut created = created;
                created["name"] = json!("New Chat");
                created["activityAt"] = created["createdAt"].clone();
                self.sessions.lock().expect("sessions").insert(0, created.clone());
                Ok(created)
            }
            "project.catalog.query" => {
                let projects = self.projects.lock().expect("projects");
                let items: Vec<Value> = projects
                    .iter()
                    .enumerate()
                    .flat_map(|(ix, (id, name, path))| {
                        [
                            json!({"kind": "project", "projectIndex": ix, "id": id, "name": name,
                                   "aliasCount": 0, "locationCount": 1,
                                   "preferredLocationIndex": 0, "archivedAt": null,
                                   "available": true}),
                            json!({"kind": "location", "projectIndex": ix, "itemIndex": 0,
                                   "location": {"path": path, "isWorktree": false}}),
                        ]
                    })
                    .collect();
                Ok(json!({"kind": "page", "view": "locations",
                          "revision": format!("sha256:{}", "1".repeat(64)),
                          "projectCount": projects.len(), "items": items, "nextCursor": null}))
            }
            "project.catalog.mutate" if input["kind"] == "register" => {
                let path = input["path"].as_str().expect("path").to_owned();
                let mut projects = self.projects.lock().expect("projects");
                let id = format!("proj-{}", projects.len() + 1);
                let name = workspace::folder_name(&path).to_owned();
                projects.insert(0, (id.clone(), name.clone(), path));
                Ok(json!({"kind": "project", "project": {"id": id, "aliases": [], "name": name,
                          "locationCount": 1, "archivedAt": null, "available": true}}))
            }
            "session.metadata.update" => Ok(self.metadata_update(&input)),
            "session.lifecycle.set" => {
                let archived = input["state"] == "archived";
                Ok(self.change(&input["sessionId"], |session| {
                    session["isArchived"] = json!(archived);
                }))
            }
            "session.remove.preview" => Ok(json!({"archivableSubtaskCount": 2})),
            "session.remove" => {
                self.sessions.lock().expect("sessions").retain(|s| s["id"] != input["sessionId"]);
                Ok(json!({"kind": "removed", "sessionId": input["sessionId"]}))
            }
            other => Err(HostRequestError::Transport(format!("unexpected {other}").into())),
        };
        Box::pin(async move { result })
    }
}

fn projection(id: &str, name: &str, path: &str) -> Value {
    json!({
        "id": id, "revision": 1,
        "workspace": {"target": {"kind": "host_path", "path": path}, "hostCwd": path},
        "createdAt": 1, "activityAt": 2, "name": name, "isFlagged": false, "isArchived": false,
        "labels": [], "labelsTruncated": false, "hasUnread": false, "status": "active",
        "backend": "ai-sdk", "llmConnectionId": null, "llmConnectionSlug": "env",
        "connectionLocked": false, "model": "m", "permissionMode": "ask",
        "collaborationMode": "agent", "orchestrationMode": "default"
    })
}

fn accepted() -> HostAccepted {
    serde_json::from_value(json!({
        "kind": "accepted", "rootId": "r", "hostEpoch": "e1", "connectionId": "c",
        "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
        "compositionRevision": "3", "state": "ready"
    }))
    .expect("accepted")
}

struct Harness {
    transport: Arc<ScriptedHost>,
    host: Entity<HostSession>,
    catalog: Entity<SessionCatalog>,
    projects: Entity<ProjectSelection>,
    sidebar: Entity<SessionSidebar>,
    window: WindowHandle<Root>,
}

/// The window's root view: the sidebar as the shell draws it; `Root` draws
/// the dialog layer over it.
struct Shell(Entity<SessionSidebar>);

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.0.clone())
    }
}

/// A project catalog with a fixed list.
struct FixedProjects(Vec<ProjectEntry>);

impl ProjectCatalogSource for FixedProjects {
    fn list(&self, _: &HostRequester) -> Boxed<Result<Vec<ProjectEntry>, ProjectCatalogError>> {
        let projects = self.0.clone();
        Box::pin(async move { Ok(projects) })
    }
}

fn open(transport: Arc<ScriptedHost>, cx: &mut TestAppContext) -> Harness {
    open_with_projects(transport, Rc::new(UnavailableProjectCatalog), cx)
}

fn open_with_projects(
    transport: Arc<ScriptedHost>,
    source: Rc<dyn ProjectCatalogSource>,
    cx: &mut TestAppContext,
) -> Harness {
    let harness = open_unconnected(transport, source, cx);
    feed(&harness.host, ConnectionEvent::Connected { accepted: accepted() }, cx);
    harness
}

/// The sidebar before its Host has answered: the first attempt runs.
fn open_unconnected(
    transport: Arc<ScriptedHost>,
    source: Rc<dyn ProjectCatalogSource>,
    cx: &mut TestAppContext,
) -> Harness {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init(cx);
        // Dialogs slide in on the wall clock; with motion reduced they
        // settle on their first frame.
        cx.set_reduce_motion(true);
    });
    let host =
        cx.new(|_| HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone()));
    let catalog = cx.new(|cx| SessionCatalog::new(host.clone(), cx));
    let projects = cx.new(|cx| ProjectSelection::new(host.clone(), source, cx));
    let mut sidebar = None;
    let window = cx.open_window(size(px(320.), px(640.)), |window, cx| {
        let view = cx.new(|cx| SessionSidebar::new(catalog.clone(), projects.clone(), window, cx));
        sidebar = Some(view.clone());
        let shell = cx.new(|_| Shell(view));
        Root::new(shell, window, cx)
    });
    let sidebar = sidebar.expect("sidebar");
    Harness { transport, host, catalog, projects, sidebar, window }
}

fn feed(host: &Entity<HostSession>, event: ConnectionEvent, cx: &mut TestAppContext) {
    host.update(cx, |host, cx| host.handle_host_event(HostEvent::Connection(event), cx));
    cx.run_until_parked();
}

fn selected(harness: &Harness, cx: &mut TestAppContext) -> Option<String> {
    harness.catalog.read_with(cx, |catalog, _| catalog.selected_id().map(|id| id.to_string()))
}

fn row(id: &str) -> gpui_kit::ElementId {
    domain_element_id("session-row", id)
}

#[gpui_kit::test]
fn the_list_shows_the_catalog_and_a_click_selects_a_session(cx: &mut TestAppContext) {
    let harness = open(
        ScriptedHost::with_sessions(&[
            ("s1", "Alpha", "/work/alpha"),
            ("s2", "Beta", "/work/beta"),
            ("s3", "Gamma", "/work/gamma"),
        ]),
        cx,
    );
    // The newest session is selected so the composer has a target.
    assert_eq!(selected(&harness, cx).as_deref(), Some("s1"));

    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        for id in ["s1", "s2", "s3"] {
            assert!(window.find(row(id)).visible(), "row {id}");
        }
        assert!(window.find(row("s1")).bounds().top() < window.find(row("s2")).bounds().top());
        window.click(row("s2"), cx);
        assert_eq!(window.find("session-list").focused(), Some(true), "the list owns focus");
    })
    .expect("window");
    cx.run_until_parked();
    assert_eq!(selected(&harness, cx).as_deref(), Some("s2"));
}

/// The entries under New task open their pages through the window's
/// Actions and show which one the plate has; choosing a task, even the
/// selected one, says so, which takes the plate back to it.
#[gpui_kit::test]
fn the_page_entries_open_their_pages_and_a_chosen_task_is_reported(cx: &mut TestAppContext) {
    use std::cell::RefCell;
    use workspace::actions::{OpenExtensions, OpenScheduledTasks};

    use crate::{SidebarEvent, SidebarPage};

    let harness = open(ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]), cx);
    let opened = Rc::new(RefCell::new(Vec::new()));
    let chosen = Rc::new(RefCell::new(Vec::new()));
    cx.update(|cx| {
        let recorded = opened.clone();
        cx.on_action(move |_: &OpenExtensions, _| recorded.borrow_mut().push("extensions"));
        let recorded = opened.clone();
        cx.on_action(move |_: &OpenScheduledTasks, _| {
            recorded.borrow_mut().push("scheduled-tasks")
        });
        let recorded = chosen.clone();
        cx.subscribe(&harness.sidebar, move |_, event: &SidebarEvent, _| {
            let SidebarEvent::TaskChosen(id) = event;
            recorded.borrow_mut().push(id.to_string());
        })
        .detach();
    });
    let entry = |page: &str| domain_element_id("sidebar-page", page);
    with_window(&harness, cx, |window, cx| {
        assert_eq!(window.find(entry("extensions")).label(), Some("Extensions"));
        assert_eq!(window.find(entry("scheduled-tasks")).label(), Some("Scheduled tasks"));
        let new_task = window.find("new-session").bounds();
        let extensions = window.find(entry("extensions")).bounds();
        let scheduled = window.find(entry("scheduled-tasks")).bounds();
        let grouping = window.find("task-grouping").bounds();
        assert!(new_task.bottom() <= extensions.top(), "under New task");
        assert!(extensions.bottom() <= scheduled.top(), "in Desktop's order");
        assert!(scheduled.bottom() <= grouping.top());
        assert_eq!(extensions.size.height, new_task.size.height, "in New task's geometry");
        window.click(entry("extensions"), cx);
        window.click(entry("scheduled-tasks"), cx);
    });
    assert_eq!(*opened.borrow(), ["extensions", "scheduled-tasks"]);
    assert_eq!(harness.sidebar.read_with(cx, |sidebar, _| sidebar.open_page()), None);
    // Active scheduled tasks: the entry still reads "Scheduled tasks", the
    // count sits at its end, and the sentence is only its accessible name.
    harness.sidebar.update(cx, |sidebar, cx| sidebar.set_active_scheduled_tasks(3, cx));
    with_window(&harness, cx, |window, _| {
        let scheduled = window.find(entry("scheduled-tasks"));
        assert_eq!(scheduled.label(), Some("Scheduled tasks, 3 active"));
        let title = window.find(domain_element_id("sidebar-page-title", "scheduled-tasks"));
        assert_eq!(title.label(), Some("Scheduled tasks"));
        let count = window.find(domain_element_id("sidebar-page-count", "scheduled-tasks"));
        assert_eq!(count.label(), Some("3"));
        let (row, count) = (scheduled.bounds(), count.bounds());
        assert!(title.bounds().right() <= count.left());
        assert!(row.right() - count.right() <= px(12.), "at the row's end: {count:?} in {row:?}");
        assert!(window.try_find(domain_element_id("sidebar-page-count", "extensions")).is_none());
    });
    harness.sidebar.update(cx, |sidebar, cx| {
        let catalog = sidebar.catalog().clone();
        catalog.update(cx, |catalog, cx| catalog.select(Some("s1"), cx));
        sidebar.set_open_page(Some(SidebarPage::Extensions), cx);
    });
    with_window(&harness, cx, |window, cx| {
        // One selected row: the page's entry; the selected task rests.
        assert_eq!(window.find(row("s1")).selected(), Some(false));
        // The selected task is chosen again, from the list.
        window.click(row("s1"), cx);
    });
    assert_eq!(*chosen.borrow(), ["s1"]);
    // The task shows again: its row takes the fill back.
    harness.sidebar.update(cx, |sidebar, cx| sidebar.set_open_page(None, cx));
    with_window(&harness, cx, |window, _| {
        assert_eq!(window.find(row("s1")).selected(), Some(true));
    });
}

#[gpui_kit::test]
fn tab_reaches_the_list_and_arrows_move_the_selection(cx: &mut TestAppContext) {
    let harness = open(
        ScriptedHost::with_sessions(&[
            ("s1", "Alpha", "/work/a"),
            ("s2", "Beta", "/work/b"),
            ("s3", "Gamma", "/work/c"),
        ]),
        cx,
    );
    let press = |key: &str, cx: &mut TestAppContext| {
        cx.update_window(harness.window.into(), |_, window, cx| window.press(key, cx))
            .expect("window");
        cx.run_until_parked();
    };
    let focused = |id: ElementId, cx: &mut TestAppContext| {
        cx.update_window(harness.window.into(), |_, window, cx| {
            window.render_frame(cx);
            window.find(id).focused()
        })
        .expect("window")
    };
    let by_time = || domain_element_id("task-grouping", "time");
    let by_project = || domain_element_id("task-grouping", "project");
    cx.update_window(harness.window.into(), |_, window, cx| {
        let list = harness.sidebar.read(cx).focus_handle(cx);
        list.focus(window, cx);
    })
    .expect("window");
    assert_eq!(focused("session-list".into(), cx), Some(true));
    // Shift-Tab goes back through the grouping switch and the pages'
    // entries to New task, Tab returns.
    press("shift-tab", cx);
    assert_eq!(focused(by_project(), cx), Some(true));
    press("shift-tab", cx);
    assert_eq!(focused(by_time(), cx), Some(true));
    for page in ["scheduled-tasks", "extensions"] {
        press("shift-tab", cx);
        assert_eq!(focused(domain_element_id("sidebar-page", page), cx), Some(true), "{page}");
    }
    press("shift-tab", cx);
    assert_eq!(focused("new-session".into(), cx), Some(true));
    for _ in 0..5 {
        press("tab", cx);
    }
    assert_eq!(focused("session-list".into(), cx), Some(true));

    // A click keeps focus on the same Tab stop, so one Shift-Tab leaves it.
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        window.click(row("s1"), cx);
    })
    .expect("window");
    press("shift-tab", cx);
    assert_eq!(focused(by_project(), cx), Some(true), "one Shift-Tab from a clicked row");
    press("tab", cx);

    press("down", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s2"));
    press("down", cx);
    press("down", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s3"), "stops at the end");
    press("up", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s2"));
    press("home", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s1"));
    press("end", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s3"));
}

#[gpui_kit::test]
fn the_last_task_scrolls_clear_of_the_footer(cx: &mut TestAppContext) {
    let names: Vec<(String, String)> =
        (0..30).map(|ix| (format!("s{ix:02}"), format!("Task {ix}"))).collect();
    let sessions: Vec<(&str, &str, &str)> =
        names.iter().map(|(id, name)| (id.as_str(), name.as_str(), "/work/a")).collect();
    let harness = open(ScriptedHost::with_sessions(&sessions), cx);
    // Every task, not the first eight and "Show more".
    harness.sidebar.update(cx, |sidebar, cx| sidebar.show_more(DayGroup::Earlier, cx));
    cx.update_window(harness.window.into(), |_, window, cx| {
        let list = harness.sidebar.read(cx).focus_handle(cx);
        list.focus(window, cx);
        window.render_frame(cx);
        assert!(harness.sidebar.read(cx).list_overflows(), "30 rows overflow 640 px");
        window.press("end", cx);
        window.render_frame(cx);
        let list = window.find("session-list").bounds();
        let last = window.find(row("s29")).bounds();
        // One row (2 rem) plus 8 px stays below the last row.
        let gap = list.bottom() - last.bottom();
        assert!((gap - px(40.)).abs() < px(1.), "gap {gap:?}");
        window.press("home", cx);
        window.render_frame(cx);
        assert!(window.find(row("s00")).bounds().top() >= list.top(), "Home still reaches the top");

        // Folded, the list fits: no hairline over the footer.
        window.press("left", cx);
        window.press("left", cx);
        window.render_frame(cx);
        assert_eq!(window.find(group("earlier")).expanded(), Some(false));
        assert!(!harness.sidebar.read(cx).list_overflows());
    })
    .expect("window");
    assert_eq!(selected(&harness, cx).as_deref(), Some("s00"));
}

#[gpui_kit::test]
fn a_catalog_change_notice_reloads_the_list(cx: &mut TestAppContext) {
    let harness = open(ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]), cx);
    harness.transport.add("s2", "Beta", "/work/b");
    harness.host.update(cx, |host, cx| {
        host.handle_host_event(
            HostEvent::Push(PushFrame::Change(ChangeNotice::SessionCatalogChanged {
                revision: 2,
                session_id: "s2".into(),
                attention: None,
            })),
            cx,
        )
    });
    cx.run_until_parked();
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.find(row("s2")).visible());
    })
    .expect("window");
    assert_eq!(harness.transport.requests("session.catalog.query").len(), 2);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s1"), "the selection is kept");
}

#[gpui_kit::test]
fn a_failed_load_shows_the_error_and_keeps_earlier_rows(cx: &mut TestAppContext) {
    let harness = open(ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]), cx);
    *harness.transport.fail_catalog.lock().expect("flag") = true;
    harness.catalog.update(cx, |catalog, cx| catalog.reload(cx));
    cx.run_until_parked();
    harness.catalog.read_with(cx, |catalog, _| {
        assert!(matches!(catalog.load_state(), LoadState::Failed(_)));
        assert_eq!(catalog.rows().len(), 1);
    });
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.find("session-load-error").visible());
        assert!(window.find(row("s1")).visible(), "last content stays visible");
    })
    .expect("window");
    *harness.transport.fail_catalog.lock().expect("flag") = false;
    cx.update_window(harness.window.into(), |_, window, cx| window.click("reload-sessions", cx))
        .expect("window");
    cx.run_until_parked();
    harness.catalog.read_with(cx, |catalog, _| {
        assert_eq!(catalog.load_state(), &LoadState::Loaded);
    });
}

#[gpui_kit::test]
fn the_list_says_it_is_offline_once_the_first_attempt_fails(cx: &mut TestAppContext) {
    let transport = ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]);
    let harness = open_unconnected(transport, Rc::new(UnavailableProjectCatalog), cx);
    let offline = domain_element_id("settings-empty", "session-offline");
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(
            window.try_find(("session-skeleton", 0usize)).is_some(),
            "placeholders while it tries"
        );
        assert!(window.try_find(offline.clone()).is_none());
    })
    .expect("window");
    feed(&harness.host, ConnectionEvent::Disconnected { reason: "refused".into() }, cx);
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find(("session-skeleton", 0usize)).is_none(), "no placeholders after");
        assert_eq!(window.find(offline.clone()).label(), Some("Not connected to the Runtime Host"));
        assert_empty_line_recipe(window, offline.clone());
    })
    .expect("window");
    // Once it connects, the list loads.
    feed(&harness.host, ConnectionEvent::Connected { accepted: accepted() }, cx);
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find(offline).is_none());
        assert!(window.find(row("s1")).visible());
    })
    .expect("window");
}

/// The empty list and the offline one use the one inline empty row: 16 in
/// from the column, 8 under the list's top, 32 tall.
fn assert_empty_line_recipe(window: &mut gpui_kit::Window, id: ElementId) {
    let list = window.find("session-list").bounds();
    let line = window.find(id).bounds();
    assert_eq!(line.left() - list.left(), px(16.), "{line:?} in {list:?}");
    assert_eq!(line.top() - list.top(), px(8.), "{line:?} in {list:?}");
    assert_eq!(line.size.height, px(32.));
}

#[gpui_kit::test]
fn an_empty_list_says_so_in_the_offline_lines_recipe(cx: &mut TestAppContext) {
    let harness = open(ScriptedHost::with_sessions(&[]), cx);
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        let empty = domain_element_id("settings-empty", "session-empty");
        assert_eq!(window.find(empty.clone()).label(), Some("No tasks yet"));
        assert_empty_line_recipe(window, empty);
    })
    .expect("window");
}

#[gpui_kit::test]
fn new_task_opens_the_draft_without_asking_the_host(cx: &mut TestAppContext) {
    let harness = open(ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]), cx);
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find("project-folder").is_none(), "no folder row");
    })
    .expect("window");
    assert_eq!(selected(&harness, cx).as_deref(), Some("s1"));
    let asked = harness.transport.requests.lock().expect("requests").len();
    let click_new_task = |cx: &mut TestAppContext| {
        cx.update_window(harness.window.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("new-session", cx);
        })
        .expect("window");
        cx.run_until_parked();
    };
    click_new_task(cx);
    assert_eq!(selected(&harness, cx), None, "no task is selected");
    assert!(harness.catalog.read_with(cx, |catalog, _| catalog.is_draft()));
    assert_eq!(harness.transport.requests.lock().expect("requests").len(), asked, "no request");
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find(row("s1")).selected(), Some(false));
    })
    .expect("window");

    // A load keeps the draft open, and offline New task opens it too.
    harness.catalog.update(cx, |catalog, cx| catalog.reload(cx));
    cx.run_until_parked();
    assert_eq!(selected(&harness, cx), None, "a load leaves the draft open");
    harness.catalog.update(cx, |catalog, cx| catalog.select(Some("s1"), cx));
    feed(&harness.host, ConnectionEvent::Disconnected { reason: "closed".into() }, cx);
    let asked = harness.transport.requests.lock().expect("requests").len();
    click_new_task(cx);
    assert!(harness.catalog.read_with(cx, |catalog, _| catalog.is_draft()), "offline too");
    assert_eq!(harness.transport.requests.lock().expect("requests").len(), asked);
}

#[gpui_kit::test]
fn tasks_are_grouped_by_day_and_a_heading_click_folds_its_group(cx: &mut TestAppContext) {
    let transport = ScriptedHost::with_sessions(&[]);
    transport.add_recent("r1", "Recent", "active");
    transport.add("s1", "Old one", "/work/a");
    transport.add("s2", "Old two", "/work/b");
    let harness = open(transport, cx);
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        let earlier = window.find(group("earlier"));
        assert_eq!(earlier.expanded(), Some(true));
        let recent = window.find(row("r1")).bounds().top();
        assert!(recent < earlier.bounds().top(), "newer groups come first");
        assert!(earlier.bounds().top() < window.find(row("s1")).bounds().top());
        assert_eq!(window.find(row("r1")).selected(), Some(true), "the newest is selected");
        assert_eq!(window.find(row("s1")).selected(), Some(false));

        window.click(group("earlier"), cx);
        window.render_frame(cx);
        assert_eq!(window.find(group("earlier")).expanded(), Some(false));
        assert!(window.try_find(row("s1")).is_none(), "a folded group hides its tasks");
        assert!(window.find(row("r1")).visible(), "other groups stay open");
        assert_eq!(window.find("session-list").focused(), Some(true), "the list owns focus");

        window.click(group("earlier"), cx);
        window.render_frame(cx);
        assert!(window.find(row("s2")).visible());
    })
    .expect("window");
}

#[gpui_kit::test]
fn arrows_walk_tasks_and_headings_and_left_and_right_fold(cx: &mut TestAppContext) {
    let transport = ScriptedHost::with_sessions(&[]);
    transport.add_recent("r1", "Recent", "active");
    transport.add("s1", "Old one", "/work/a");
    transport.add("s2", "Old two", "/work/b");
    let harness = open(transport, cx);
    let press = |key: &str, cx: &mut TestAppContext| {
        cx.update_window(harness.window.into(), |_, window, cx| window.press(key, cx))
            .expect("window");
        cx.run_until_parked();
    };
    let earlier_expanded = |cx: &mut TestAppContext| {
        cx.update_window(harness.window.into(), |_, window, cx| {
            window.render_frame(cx);
            window.find(group("earlier")).expanded()
        })
        .expect("window")
    };
    cx.update_window(harness.window.into(), |_, window, cx| {
        harness.sidebar.read(cx).focus_handle(cx).focus(window, cx);
    })
    .expect("window");
    assert_eq!(selected(&harness, cx).as_deref(), Some("r1"));

    // Down from the last task of a group lands on the next heading; the
    // selection stays where it was.
    press("down", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("r1"));
    press("left", cx);
    assert_eq!(earlier_expanded(cx), Some(false), "Left folds the heading");
    press("left", cx);
    assert_eq!(earlier_expanded(cx), Some(false), "a folded heading stays folded");
    press("right", cx);
    assert_eq!(earlier_expanded(cx), Some(true), "Right unfolds it");
    press("right", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s1"), "then enters the group");
    press("down", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s2"));

    // Left on a task goes to its heading, Enter folds it, and End then
    // selects the last task still shown.
    press("left", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s2"));
    press("enter", cx);
    assert_eq!(earlier_expanded(cx), Some(false), "Enter toggles a heading");
    press("end", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("r1"));
    press("space", cx);
    press("up", cx);
    press("up", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("r1"), "Up stops at the first heading");
    press("home", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("r1"));
}

#[gpui_kit::test]
fn every_row_ends_in_the_same_fixed_lane(cx: &mut TestAppContext) {
    let transport = ScriptedHost::with_sessions(&[("s1", "Idle", "/work/a")]);
    transport.add_recent("r1", "Busy", "running");
    let harness = open(transport, cx);
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        let idle = window.find(domain_element_id("session-lane", "s1")).bounds();
        let running = window.find(domain_element_id("session-lane", "r1")).bounds();
        assert_eq!(idle.size.width, px(40.), "a 40px lane");
        assert_eq!(running.size.width, idle.size.width);
        assert_eq!(running.right(), idle.right(), "ages and the running mark share one edge");
        let running_mark = window.find(domain_element_id("session-running", "r1")).bounds();
        assert!(running.contains(&running_mark.center()), "the mark takes the age's place");
    })
    .expect("window");
}

#[gpui_kit::test]
fn a_running_task_shows_a_spinner_instead_of_its_age(cx: &mut TestAppContext) {
    let transport = ScriptedHost::with_sessions(&[("s1", "Idle", "/work/a")]);
    transport.add_recent("r1", "Busy", "running");
    let harness = open(transport, cx);
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.find(domain_element_id("session-running", "r1")).visible());
        assert_eq!(window.find(row("r1")).label(), Some("Busy, Running"));
        assert!(window.try_find(domain_element_id("session-running", "s1")).is_none());
        assert_eq!(window.find(row("s1")).label(), None, "no status words while idle");
    })
    .expect("window");
}

#[gpui_kit::test]
fn a_row_shows_a_heading_titled_task_without_the_marker(cx: &mut TestAppContext) {
    let transport = ScriptedHost::with_sessions(&[]);
    transport.add_recent("r1", "## Busy", "running");
    let harness = open(transport, cx);
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find(row("r1")).label(), Some("Busy, Running"));
    })
    .expect("window");
}

#[gpui_kit::test]
fn a_preferred_task_is_selected_once_a_load_lists_it(cx: &mut TestAppContext) {
    let harness = open(
        ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a"), ("s2", "Beta", "/work/b")]),
        cx,
    );
    harness.catalog.update(cx, |catalog, cx| catalog.select_when_listed("s3", cx));
    assert_eq!(selected(&harness, cx).as_deref(), Some("s1"), "not listed yet");
    harness.transport.add("s3", "Gamma", "/work/c");
    harness.catalog.update(cx, |catalog, cx| catalog.reload(cx));
    cx.run_until_parked();
    assert_eq!(selected(&harness, cx).as_deref(), Some("s3"));
    harness.catalog.update(cx, |catalog, cx| catalog.select_when_listed("s2", cx));
    assert_eq!(selected(&harness, cx).as_deref(), Some("s2"), "a listed one at once");
}

fn show_more(group: &str) -> gpui_kit::ElementId {
    domain_element_id("session-show-more", group)
}

/// Twelve tasks from long ago, all under Earlier.
fn twelve_earlier() -> Arc<ScriptedHost> {
    let names: Vec<(String, String)> =
        (0..12).map(|ix| (format!("s{ix:02}"), format!("Task {ix}"))).collect();
    let sessions: Vec<(&str, &str, &str)> =
        names.iter().map(|(id, name)| (id.as_str(), name.as_str(), "/work/a")).collect();
    ScriptedHost::with_sessions(&sessions)
}

#[gpui_kit::test]
fn a_long_group_lists_eight_tasks_then_show_more_reveals_the_rest(cx: &mut TestAppContext) {
    assert_eq!(GROUP_ROW_LIMIT, 8);
    let harness = open(twelve_earlier(), cx);
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        for ix in 0..8 {
            assert!(window.find(row(&format!("s{ix:02}"))).visible(), "row {ix}");
        }
        assert!(window.try_find(row("s08")).is_none(), "the ninth task waits");
        let more = window.find(show_more("earlier"));
        assert_eq!(more.label(), Some("Show 4 more tasks in Earlier"));
        assert!(more.bounds().top() >= window.find(row("s07")).bounds().bottom() - px(1.));
        window.click(show_more("earlier"), cx);
    })
    .expect("window");
    cx.run_until_parked();
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.find(row("s11")).visible(), "the rest is listed");
        assert!(window.try_find(show_more("earlier")).is_none());
        assert_eq!(window.find("session-list").focused(), Some(true), "the list keeps focus");
    })
    .expect("window");
    assert_eq!(selected(&harness, cx).as_deref(), Some("s00"), "a click selects nothing");
    assert!(harness.sidebar.read_with(cx, |sidebar, _| sidebar.is_expanded(DayGroup::Earlier)));

    // Folding and unfolding the group keeps it expanded.
    harness.sidebar.update(cx, |sidebar, cx| {
        sidebar.toggle_group(DayGroup::Earlier, cx);
        sidebar.toggle_group(DayGroup::Earlier, cx);
    });
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.find(row("s11")).visible());
    })
    .expect("window");
}

#[gpui_kit::test]
fn show_more_is_reached_with_arrows_and_enter_selects_the_first_revealed(cx: &mut TestAppContext) {
    let harness = open(twelve_earlier(), cx);
    let press = |key: &str, cx: &mut TestAppContext| {
        cx.update_window(harness.window.into(), |_, window, cx| window.press(key, cx))
            .expect("window");
        cx.run_until_parked();
    };
    cx.update_window(harness.window.into(), |_, window, cx| {
        let list = harness.sidebar.read(cx).focus_handle(cx);
        list.focus(window, cx);
    })
    .expect("window");
    press("end", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s07"), "End reaches the last listed");
    press("down", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s07"), "Show more takes the cursor");
    press("enter", cx);
    assert_eq!(selected(&harness, cx).as_deref(), Some("s08"), "the first revealed task");
    assert!(harness.sidebar.read_with(cx, |sidebar, _| sidebar.is_expanded(DayGroup::Earlier)));
}

#[gpui_kit::test]
fn a_selected_task_beyond_the_limit_is_listed(cx: &mut TestAppContext) {
    let harness = open(twelve_earlier(), cx);
    // As Back or --session would select it.
    harness.catalog.update(cx, |catalog, cx| catalog.select(Some("s10"), cx));
    cx.run_until_parked();
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.find(row("s10")).visible(), "the selection is on screen");
        assert!(window.try_find(show_more("earlier")).is_none());
    })
    .expect("window");
    assert!(
        !harness.sidebar.read_with(cx, |sidebar, _| sidebar.is_expanded(DayGroup::Earlier)),
        "without counting as Show more"
    );
}

fn menu_item(key: &str) -> ElementId {
    domain_element_id("menu-item", key)
}

/// The labels of the open task menu's items, in order.
fn menu_labels(window: &mut Window) -> Vec<String> {
    let menu = window.within("menu");
    ["rename", "flag", "copy-id", "archive", "delete"]
        .into_iter()
        .filter_map(|key| menu.try_find(menu_item(key)))
        .filter_map(|item| item.label().map(str::to_owned))
        .collect()
}

fn list_focused(harness: &Harness, cx: &mut TestAppContext) {
    cx.update_window(harness.window.into(), |_, window, cx| {
        harness.sidebar.read(cx).focus_handle(cx).focus(window, cx);
        window.render_frame(cx);
    })
    .expect("window");
    cx.run_until_parked();
}

fn with_window<R>(
    harness: &Harness,
    cx: &mut TestAppContext,
    f: impl FnOnce(&mut Window, &mut gpui_kit::App) -> R,
) -> R {
    let result = cx
        .update_window(harness.window.into(), |_, window, cx| {
            window.render_frame(cx);
            f(window, cx)
        })
        .expect("window");
    cx.run_until_parked();
    result
}

fn row_name(harness: &Harness, id: &str, cx: &mut TestAppContext) -> String {
    harness.catalog.read_with(cx, |catalog, _| catalog.row(id).expect("row").name.to_string())
}

#[gpui_kit::test]
fn right_click_opens_the_menu_and_a_rename_commits_with_enter(cx: &mut TestAppContext) {
    let harness = open(
        ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a"), ("s2", "Beta", "/work/b")]),
        cx,
    );
    with_window(&harness, cx, |window, cx| window.right_click(row("s2"), cx));
    with_window(&harness, cx, |window, _| {
        assert_eq!(
            menu_labels(window),
            ["Rename", "Flag", "Copy task ID", "Archive"],
            "no Delete before the task is archived"
        );
        // The menu's geometry: 32px rows, and the rename key as a hint.
        assert_eq!(window.find(menu_item("rename")).bounds().size.height, px(32.));
    });
    assert_eq!(selected(&harness, cx).as_deref(), Some("s1"), "a right-click selects nothing");
    with_window(&harness, cx, |window, cx| window.within("menu").click(menu_item("rename"), cx));
    with_window(&harness, cx, |window, cx| {
        assert!(window.try_find("menu").is_none(), "the menu closed");
        let field = domain_element_id("session-rename", "s2");
        assert!(window.find(field).visible(), "the title became a field");
        // The field holds the title, selected, so typing replaces it.
        window.input("Beta plan", cx);
        window.press("enter", cx);
    });
    let updates = harness.transport.requests("session.metadata.update");
    assert_eq!(
        updates,
        [json!({"sessionId": "s2", "expectedRevision": 1, "patch": {"name": "Beta plan"}})]
    );
    assert_eq!(row_name(&harness, "s2", cx), "Beta plan");
    with_window(&harness, cx, |window, _| {
        assert!(window.try_find(domain_element_id("session-rename", "s2")).is_none());
        assert_eq!(window.find("session-list").focused(), Some(true), "focus returns to the list");
    });
}

#[gpui_kit::test]
fn f2_renames_in_place_and_escape_cancels(cx: &mut TestAppContext) {
    let harness = open(ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]), cx);
    list_focused(&harness, cx);
    with_window(&harness, cx, |window, cx| window.press("f2", cx));
    with_window(&harness, cx, |window, cx| {
        assert!(window.find(domain_element_id("session-rename", "s1")).visible());
        // Space and arrows edit the name instead of moving the list.
        window.input("Other name", cx);
        window.press("escape", cx);
    });
    assert!(harness.transport.requests("session.metadata.update").is_empty());
    assert_eq!(row_name(&harness, "s1", cx), "Alpha");
    with_window(&harness, cx, |window, _| {
        assert!(window.try_find(domain_element_id("session-rename", "s1")).is_none());
        assert_eq!(window.find("session-list").focused(), Some(true));
    });
    // Enter on an unchanged name sends nothing either.
    with_window(&harness, cx, |window, cx| window.press("f2", cx));
    with_window(&harness, cx, |window, cx| window.press("enter", cx));
    assert!(harness.transport.requests("session.metadata.update").is_empty());
}

#[gpui_kit::test]
fn a_revision_conflict_is_retried_once_at_the_hosts_revision(cx: &mut TestAppContext) {
    let transport = ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]);
    *transport.conflicts.lock().expect("conflicts") = 1;
    let harness = open(transport, cx);
    harness.catalog.update(cx, |catalog, cx| catalog.rename("s1", "Renamed", cx));
    cx.run_until_parked();
    let revisions: Vec<Value> = harness
        .transport
        .requests("session.metadata.update")
        .iter()
        .map(|input| input["expectedRevision"].clone())
        .collect();
    assert_eq!(revisions, [json!(1), json!(2)]);
    assert_eq!(row_name(&harness, "s1", cx), "Renamed");
    harness.catalog.read_with(cx, |catalog, _| assert_eq!(catalog.command_error(), None));

    // Two conflicts in a row: the old name comes back and the list says why.
    *harness.transport.conflicts.lock().expect("conflicts") = 2;
    harness.catalog.update(cx, |catalog, cx| catalog.rename("s1", "Again", cx));
    assert_eq!(row_name(&harness, "s1", cx), "Again", "shown at once");
    cx.run_until_parked();
    assert_eq!(row_name(&harness, "s1", cx), "Renamed");
    with_window(&harness, cx, |window, _| {
        assert_eq!(
            window.find("session-command-error").label(),
            Some("Couldn’t rename the task. It changed in the meantime; try again.")
        );
    });
}

#[gpui_kit::test]
fn archiving_moves_a_task_to_the_archived_group(cx: &mut TestAppContext) {
    let harness = open(
        ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a"), ("s2", "Beta", "/work/b")]),
        cx,
    );
    // Shift-F10 opens the selected task's menu from the keyboard.
    list_focused(&harness, cx);
    with_window(&harness, cx, |window, cx| window.press("shift-f10", cx));
    assert_eq!(harness.sidebar.read_with(cx, |s, _| s.menu_task().cloned()).as_deref(), Some("s1"));
    with_window(&harness, cx, |window, cx| window.within("menu").click(menu_item("archive"), cx));
    assert_eq!(
        harness.transport.requests("session.lifecycle.set"),
        [json!({"sessionId": "s1", "state": "archived"})]
    );
    assert_eq!(selected(&harness, cx).as_deref(), Some("s2"), "the neighbour is selected");
    with_window(&harness, cx, |window, cx| {
        assert!(window.try_find(row("s1")).is_none(), "it left the main list");
        let archived = window.find(group("archived"));
        assert_eq!(archived.expanded(), Some(false), "the Archived group starts folded");
        assert_eq!(archived.label(), Some("Archived, 1"));
        window.click(group("archived"), cx);
    });
    with_window(&harness, cx, |window, cx| {
        assert!(window.find(row("s1")).visible(), "unfolded, it lists the task");
        assert!(
            window.find(row("s1")).bounds().top() > window.find(group("archived")).bounds().top()
        );
        window.right_click(row("s1"), cx);
    });
    with_window(&harness, cx, |window, cx| {
        let labels = menu_labels(window);
        assert_eq!(labels[3], "Unarchive");
        assert_eq!(labels.get(4).map(String::as_str), Some("Delete…"));
        window.within("menu").click(menu_item("archive"), cx);
    });
    with_window(&harness, cx, |window, _| {
        assert!(window.try_find(group("archived")).is_none(), "no archived task left");
        assert!(window.find(row("s1")).visible());
    });
}

#[gpui_kit::test]
fn flagging_marks_the_row_and_copy_puts_the_id_on_the_clipboard(cx: &mut TestAppContext) {
    let harness = open(ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]), cx);
    with_window(&harness, cx, |window, cx| window.right_click(row("s1"), cx));
    with_window(&harness, cx, |window, cx| window.within("menu").click(menu_item("flag"), cx));
    assert_eq!(
        harness.transport.requests("session.metadata.update"),
        [json!({"sessionId": "s1", "expectedRevision": 1, "patch": {"isFlagged": true}})]
    );
    with_window(&harness, cx, |window, cx| {
        assert!(window.find(domain_element_id("session-flag", "s1")).visible());
        assert_eq!(window.find(row("s1")).label(), Some("Alpha, Flagged"));
        window.right_click(row("s1"), cx);
    });
    with_window(&harness, cx, |window, cx| {
        assert_eq!(menu_labels(window)[1], "Unflag");
        window.within("menu").click(menu_item("copy-id"), cx);
    });
    let copied = cx.read_from_clipboard().and_then(|item| item.text());
    assert_eq!(copied.as_deref(), Some("s1"));
}

#[gpui_kit::test]
fn the_row_button_shows_on_hover_and_opens_the_same_menu(cx: &mut TestAppContext) {
    let harness = open(ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]), cx);
    let actions = domain_element_id("session-actions", "s1");
    with_window(&harness, cx, |window, _| {
        assert!(window.try_find(actions.clone()).is_none(), "hidden at rest");
    });
    with_window(&harness, cx, |window, cx| window.hover(row("s1"), cx));
    with_window(&harness, cx, |window, cx| {
        assert_eq!(window.find(actions.clone()).label(), Some("Actions for Alpha"));
        window.click(actions.clone(), cx);
    });
    with_window(&harness, cx, |window, cx| {
        let menu = window.find("menu").bounds();
        let row = window.find(row("s1")).bounds();
        assert_eq!(menu.top() - row.bottom(), px(8.), "it hangs 8px under the row");
        assert_eq!(menu.right(), row.right(), "right edges aligned");
        assert_eq!(menu_labels(window)[0], "Rename");
        window.press("escape", cx);
    });
    with_window(&harness, cx, |window, _| {
        assert!(window.try_find("menu").is_none());
        assert_eq!(window.find("session-list").focused(), Some(true), "focus returns to the list");
    });
    // A second click on the button closes the menu it opened.
    with_window(&harness, cx, |window, cx| window.hover(row("s1"), cx));
    with_window(&harness, cx, |window, cx| window.click(actions.clone(), cx));
    with_window(&harness, cx, |window, cx| {
        assert!(window.find("menu").visible());
        window.click(actions.clone(), cx);
    });
    with_window(&harness, cx, |window, _| {
        assert!(window.try_find("menu").is_none(), "a second click closes it");
    });
}

#[gpui_kit::test]
fn the_task_menu_works_from_the_keyboard(cx: &mut TestAppContext) {
    let harness = open(ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]), cx);
    list_focused(&harness, cx);
    with_window(&harness, cx, |window, cx| window.press("shift-f10", cx));
    with_window(&harness, cx, |window, cx| {
        // Nothing is highlighted until an arrow moves; Up wraps to the end,
        // Home goes back to the start, and the separator is skipped.
        assert_eq!(window.find(menu_item("rename")).selected(), Some(false));
        window.press("up", cx);
        assert_eq!(window.find(menu_item("archive")).selected(), Some(true));
        window.press("up", cx);
        assert_eq!(window.find(menu_item("copy-id")).selected(), Some(true));
        window.press("home", cx);
        assert_eq!(window.find(menu_item("rename")).selected(), Some(true));
        window.press("enter", cx);
    });
    with_window(&harness, cx, |window, cx| {
        assert!(window.try_find("menu").is_none());
        let field = domain_element_id("session-rename", "s1");
        assert!(window.find(field).visible(), "Rename turned the title into a field");
        window.press("escape", cx);
    });
    // Tab closes the menu too, and focus goes back to the list.
    with_window(&harness, cx, |window, cx| window.press("shift-f10", cx));
    with_window(&harness, cx, |window, cx| window.press("tab", cx));
    with_window(&harness, cx, |window, _| {
        assert!(window.try_find("menu").is_none());
        assert_eq!(window.find("session-list").focused(), Some(true));
    });
}

#[gpui_kit::test]
fn deleting_an_archived_task_asks_first(cx: &mut TestAppContext) {
    let transport = ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]);
    transport.add("s2", "Old", "/work/b");
    transport.sessions.lock().expect("sessions")[1]["isArchived"] = json!(true);
    let harness = open(transport, cx);
    harness.sidebar.update(cx, |sidebar, cx| sidebar.toggle_group(crate::TaskGroup::Archived, cx));
    with_window(&harness, cx, |window, cx| window.right_click(row("s2"), cx));
    with_window(&harness, cx, |window, cx| window.within("menu").click(menu_item("delete"), cx));
    assert_eq!(harness.transport.requests("session.remove.preview"), [json!({"sessionId": "s2"})]);
    assert!(harness.transport.requests("session.remove").is_empty(), "nothing yet");
    with_window(&harness, cx, |window, cx| {
        assert!(window.find("cancel").visible(), "the confirmation shows");
        window.click("cancel", cx);
    });
    assert!(harness.transport.requests("session.remove").is_empty(), "Cancel deletes nothing");
    with_window(&harness, cx, |window, cx| window.right_click(row("s2"), cx));
    with_window(&harness, cx, |window, cx| window.within("menu").click(menu_item("delete"), cx));
    with_window(&harness, cx, |window, cx| window.click("ok", cx));
    assert_eq!(
        harness.transport.requests("session.remove"),
        [json!({"sessionId": "s2", "expectedRevision": 1})]
    );
    with_window(&harness, cx, |window, _| {
        assert!(window.try_find(row("s2")).is_none(), "the task is gone");
    });
}

#[gpui_kit::test]
fn by_project_groups_tasks_under_their_projects_name(cx: &mut TestAppContext) {
    let projects = vec![
        ProjectEntry::new("p1", "Maka", "/p/maka"),
        ProjectEntry::new("p2", "Idle", "/p/idle"),
    ];
    let transport = ScriptedHost::with_sessions(&[]);
    transport.add_recent("r1", "Recent", "active");
    transport.add_in_project("s1", "In Maka", "/p/maka", "p1");
    transport.add("s2", "Elsewhere", "/work/other");
    transport.add_in_project("s3", "Also Maka", "/p/maka-worktree", "p1");
    let harness = open_with_projects(transport, Rc::new(FixedProjects(projects)), cx);
    let project = |id: &str| group(&format!("project:{id}"));
    with_window(&harness, cx, |window, cx| {
        assert!(window.find(group("today")).visible(), "by time first");
        window.click(domain_element_id("task-grouping", "project"), cx);
    });
    assert_eq!(harness.sidebar.read_with(cx, |s, _| s.grouping()), crate::TaskGrouping::ByProject);
    with_window(&harness, cx, |window, cx| {
        assert!(window.try_find(group("today")).is_none(), "no day groups by project");
        // The projects in the catalog's order, then the tasks in no project.
        let maka = window.find(project("p1"));
        let idle = window.find(project("p2"));
        let none = window.find(group("no-project"));
        assert!(maka.bounds().top() < idle.bounds().top());
        assert!(idle.bounds().top() < none.bounds().top());
        assert!(maka.bounds().top() < window.find(row("s1")).bounds().top());
        assert!(
            window.find(row("s3")).bounds().top() < idle.bounds().top(),
            "both Maka tasks together, whatever their folder"
        );
        assert!(none.bounds().top() < window.find(row("r1")).bounds().top());
        assert!(none.bounds().top() < window.find(row("s2")).bounds().top());
        // The heading is the project's name; a project with no task is
        // listed, with nothing to fold.
        assert_eq!(maka.label(), Some("Maka"));
        assert_eq!(none.label(), Some("No project"));
        assert_eq!(maka.expanded(), Some(true));
        assert_eq!(idle.expanded(), None);
        window.click(project("p2"), cx);
        window.click(project("p1"), cx);
    });
    assert!(
        !harness
            .sidebar
            .read_with(cx, |s, _| s.is_collapsed(crate::TaskGroup::Project("p2".into())))
    );
    with_window(&harness, cx, |window, cx| {
        assert!(window.try_find(row("s1")).is_none(), "a folded project hides its tasks");
        assert!(window.find(row("s2")).visible());
        window.click(domain_element_id("task-grouping", "time"), cx);
    });
    with_window(&harness, cx, |window, _| {
        assert!(window.find(group("earlier")).visible(), "back to days");
        assert!(window.find(row("s1")).visible());
    });
    // Choosing By project again finds Maka's group still folded.
    harness.sidebar.update(cx, |s, cx| s.set_grouping(crate::TaskGrouping::ByProject, cx));
    assert!(
        harness
            .sidebar
            .read_with(cx, |s, _| { s.is_collapsed(crate::TaskGroup::Project("p1".into())) })
    );
}

/// Grouped by project, a project's heading and the tasks in no project's
/// start with an open folder in the icon column, as Desktop's do; other
/// headings have none.
#[gpui_kit::test]
fn project_headings_start_with_an_open_folder(cx: &mut TestAppContext) {
    let projects = vec![ProjectEntry::new("p1", "Maka", "/p/maka")];
    let transport = ScriptedHost::with_sessions(&[]);
    transport.add_in_project("s1", "In Maka", "/p/maka", "p1");
    transport.add("s2", "Elsewhere", "/work/other");
    let harness = open_with_projects(transport, Rc::new(FixedProjects(projects)), cx);
    harness.sidebar.update(cx, |s, cx| s.set_grouping(crate::TaskGrouping::ByProject, cx));
    let folder = |key: &str| domain_element_id("session-group-folder", key);
    with_window(&harness, cx, |window, _| {
        for key in ["project:p1", "no-project"] {
            let heading = window.find(group(key)).bounds();
            let icon = window.find(folder(key)).bounds();
            assert!(heading.contains(&icon.center()), "on {key}'s heading");
            assert_eq!(icon.left() - heading.left(), px(8.), "in the icon column");
            assert_eq!(icon.size.height, px(16.));
        }
        assert!(window.try_find(folder("archived")).is_none(), "not on Archived");
    });
}

/// Grouped by project, each project's heading ends in a "+" that starts a
/// task in that project: it chooses the project and opens the new task's
/// draft, asking the Host nothing and folding nothing. The tasks in no
/// project have none.
#[gpui_kit::test]
fn a_project_headings_plus_opens_a_draft_in_that_project(cx: &mut TestAppContext) {
    let projects = vec![
        ProjectEntry::new("p1", "Maka", "/p/maka"),
        ProjectEntry::new("p2", "Idle", "/p/idle"),
        ProjectEntry::new("p3", "Moved", "/p/moved").with_available(false),
    ];
    let transport = ScriptedHost::with_sessions(&[]);
    transport.add_in_project("s1", "In Maka", "/p/maka", "p1");
    transport.add_in_project("s3", "Moved task", "/p/moved", "p3");
    transport.add("s2", "Elsewhere", "/work/other");
    let harness = open_with_projects(transport, Rc::new(FixedProjects(projects)), cx);
    harness.sidebar.update(cx, |s, cx| s.set_grouping(crate::TaskGrouping::ByProject, cx));
    let heading = |id: &str| group(&format!("project:{id}"));
    let plus = |id: &str| domain_element_id("session-group-new-task", id);
    let asked = harness.transport.requests.lock().expect("requests").len();
    with_window(&harness, cx, |window, _| {
        for (id, name) in [("p1", "Maka"), ("p2", "Idle")] {
            let button = window.find(plus(id));
            assert_eq!(button.label(), Some(format!("New task in {name}").as_str()));
            let line = window.find(heading(id)).bounds();
            assert!(line.contains(&button.bounds().center()), "on {name}'s heading");
            assert!(button.bounds().right() > line.right() - px(16.), "at its end");
            // Its glyph's ink ends on the column's trailing edge, where
            // the tasks' ages end: the 14 px glyph in the middle of its
            // 20 px button draws 2.75 of 16 short of its square's edge.
            let ink = button.bounds().center().x + px(7.) - px(14. * shared::icons::ink::PLUS);
            let age = window.find(domain_element_id("session-lane", "s1")).bounds().right();
            assert!((ink - age).abs() < px(0.5), "{ink:?} on {age:?}");
            // The heading keeps its height and its words.
            assert_eq!(line.size.height, px(28.));
        }
        assert_eq!(window.find(heading("p1")).label(), Some("Maka"));
        // A project whose folder is gone has one too, which takes nothing
        // (below).
        assert!(window.find(plus("p3")).visible());
        // The tasks in no project have no "+".
        let none = window.find(group("no-project")).bounds();
        for id in ["p1", "p2", "p3"] {
            assert!(!none.contains(&window.find(plus(id)).bounds().center()));
        }
    });
    with_window(&harness, cx, |window, cx| window.click(plus("p2"), cx));
    assert!(harness.catalog.read_with(cx, |catalog, _| catalog.is_draft()), "the draft opens");
    let chosen = |cx: &mut TestAppContext| {
        harness.projects.read_with(cx, |projects, _| {
            projects.selected_project().map(|project| project.id.to_string())
        })
    };
    assert_eq!(chosen(cx).as_deref(), Some("p2"), "in that project");
    assert_eq!(harness.transport.requests.lock().expect("requests").len(), asked, "no request");
    assert!(
        !harness
            .sidebar
            .read_with(cx, |s, _| s.is_collapsed(crate::TaskGroup::Project("p1".into()))),
        "nothing folds"
    );
    harness.catalog.update(cx, |catalog, cx| catalog.select(Some("s1"), cx));
    with_window(&harness, cx, |window, cx| window.click(plus("p3"), cx));
    assert_eq!(chosen(cx).as_deref(), Some("p2"), "the missing one is not chosen");
    assert_eq!(selected(&harness, cx).as_deref(), Some("s1"), "and no draft opens");

    // From the keyboard: Tab from the list reaches the first "+", and
    // Enter starts a task there without folding Maka's group.
    harness.catalog.update(cx, |catalog, cx| catalog.select(Some("s1"), cx));
    cx.update_window(harness.window.into(), |_, window, cx| {
        let list = harness.sidebar.read(cx).focus_handle(cx);
        list.focus(window, cx);
        window.press("tab", cx);
    })
    .expect("window");
    cx.run_until_parked();
    with_window(&harness, cx, |window, cx| {
        assert_eq!(window.find(plus("p1")).focused(), Some(true));
        // A Button acts on the key's release.
        window.press("enter", cx);
        let keystroke = gpui_kit::Keystroke::parse("enter").expect("keystroke");
        let release = gpui_kit::KeyUpEvent { keystroke };
        window.dispatch_event(gpui_kit::InputEvent::to_platform_input(release), cx);
    });
    assert!(harness.catalog.read_with(cx, |catalog, _| catalog.is_draft()));
    assert_eq!(chosen(cx).as_deref(), Some("p1"));
    assert!(
        !harness
            .sidebar
            .read_with(cx, |s, _| s.is_collapsed(crate::TaskGroup::Project("p1".into()))),
        "Enter on the + does not fold the group"
    );
}

/// Catalog races against a Host whose answers the test releases one by one.
mod held {
    use std::collections::{HashMap, VecDeque};

    use host_protocol::SessionCatalogItem;

    use super::*;

    type Reply = Result<Value, HostRequestError>;

    /// One held answer and the request waiting for it.
    #[derive(Default)]
    struct Slot {
        reply: Option<Reply>,
        waker: Option<std::task::Waker>,
    }

    /// Releases one held answer.
    struct Release(Arc<Mutex<Slot>>);

    impl Release {
        fn send(&self, reply: Reply) {
            let mut slot = self.0.lock().expect("slot");
            slot.reply = Some(reply);
            if let Some(waker) = slot.waker.take() {
                waker.wake();
            }
        }
    }

    /// Answers each operation from a queue of held replies, in order.
    #[derive(Default)]
    struct HeldHost {
        replies: Mutex<HashMap<String, VecDeque<Arc<Mutex<Slot>>>>>,
    }

    impl HeldHost {
        /// The next `operation` request waits until the release is sent.
        fn hold(&self, operation: &str) -> Release {
            let slot = Arc::new(Mutex::new(Slot::default()));
            let mut replies = self.replies.lock().expect("replies");
            replies.entry(operation.to_owned()).or_default().push_back(slot.clone());
            Release(slot)
        }
    }

    impl HostTransport for HeldHost {
        fn request(&self, operation: &'static str, _: Value, _: Duration) -> Boxed<Reply> {
            let held = self
                .replies
                .lock()
                .expect("replies")
                .get_mut(operation)
                .and_then(VecDeque::pop_front);
            let Some(slot) = held else {
                return Box::pin(async move {
                    Err(HostRequestError::Transport(format!("unscripted {operation}").into()))
                });
            };
            Box::pin(futures_lite::future::poll_fn(move |cx| {
                let mut slot = slot.lock().expect("slot");
                match slot.reply.take() {
                    Some(reply) => std::task::Poll::Ready(reply),
                    None => {
                        slot.waker = Some(cx.waker().clone());
                        std::task::Poll::Pending
                    }
                }
            }))
        }
    }

    fn page(sessions: &[Value]) -> Reply {
        Ok(json!({
            "kind": "page", "revision": format!("sha256:{}", "0".repeat(64)),
            "sessions": sessions, "nextCursor": null
        }))
    }

    fn catalog_changed(host: &Entity<HostSession>, session_id: &str, cx: &mut TestAppContext) {
        let notice = ChangeNotice::SessionCatalogChanged {
            revision: 2,
            session_id: session_id.into(),
            attention: None,
        };
        host.update(cx, |host, cx| {
            host.handle_host_event(HostEvent::Push(PushFrame::Change(notice)), cx)
        });
        cx.run_until_parked();
    }

    /// Adversarial review 2026-09-26: adopting a created session lists and
    /// selects it without superseding a catalog load already in flight. A
    /// load that read the catalog before the create committed but answers
    /// after it (the Host serves requests concurrently) replaces the rows
    /// with a list that lacks the new session; `finish_reload` then finds the
    /// selection gone and selects the newest other task. The reload the
    /// create's own change notice queued lists the new session again, but
    /// the selection stays on the other task: the task the person just made
    /// is no longer the one the conversation shows. Such a load now keeps
    /// the created row.
    #[gpui_kit::test]
    fn a_load_that_started_before_a_create_does_not_take_the_new_session_away(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
        });
        let transport = Arc::new(HeldHost::default());
        let first = transport.hold("session.catalog.query");
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone())
        });
        let catalog = cx.new(|cx| SessionCatalog::new(host.clone(), cx));
        feed(&host, ConnectionEvent::Connected { accepted: accepted() }, cx);
        first.send(page(&[projection("s1", "Alpha", "/work/a")]));
        cx.run_until_parked();
        let selected = |cx: &mut TestAppContext| {
            catalog.read_with(cx, |catalog, _| catalog.selected_id().map(|id| id.to_string()))
        };
        assert_eq!(selected(cx).as_deref(), Some("s1"));

        // Another client's change starts a load; the Host reads the catalog
        // for it before the create below commits.
        let stale = transport.hold("session.catalog.query");
        catalog_changed(&host, "s1", cx);
        // The draft's first message created this session (the conversation
        // state sends `session.create`), and the window hands it over.
        catalog.update(cx, |catalog, cx| catalog.open_draft(cx));
        let created: SessionCatalogItem =
            serde_json::from_value(projection("s-new", "New chat", "/work/new")).expect("item");
        catalog.update(cx, |catalog, cx| catalog.adopt(&created, cx));
        cx.run_until_parked();
        assert_eq!(selected(cx).as_deref(), Some("s-new"), "the new task is selected");
        assert!(!catalog.read_with(cx, |catalog, _| catalog.is_draft()));

        // The create's change notice arrives while that load is in flight,
        // and the load answers after the create.
        let fresh = transport.hold("session.catalog.query");
        catalog_changed(&host, "s-new", cx);
        stale.send(page(&[projection("s1", "Alpha", "/work/a")]));
        cx.run_until_parked();
        assert!(
            catalog.read_with(cx, |catalog, _| catalog.row("s-new").is_some()),
            "the stale load keeps the new row"
        );
        assert_eq!(selected(cx).as_deref(), Some("s-new"));
        fresh.send(page(&[
            projection("s-new", "New chat", "/work/new"),
            projection("s1", "Alpha", "/work/a"),
        ]));
        cx.run_until_parked();
        catalog.read_with(cx, |catalog, _| assert_eq!(catalog.rows().len(), 2));
        assert_eq!(selected(cx).as_deref(), Some("s-new"), "the new task stays selected");

        // A load that started after the create is authoritative: once
        // another client removes the task, it goes.
        let later = transport.hold("session.catalog.query");
        catalog_changed(&host, "s-new", cx);
        later.send(page(&[projection("s1", "Alpha", "/work/a")]));
        cx.run_until_parked();
        assert!(catalog.read_with(cx, |catalog, _| catalog.row("s-new").is_none()));
        assert_eq!(selected(cx).as_deref(), Some("s1"));
    }
}

/// New task, the pages, and search: entering one with the pointer hops its
/// icon once, for 180ms (`shared::hop`); with motion reduced nothing hops.
#[gpui_kit::test]
fn the_sidebar_icons_hop_once_as_the_pointer_enters_their_rows(cx: &mut TestAppContext) {
    let harness = open(ScriptedHost::with_sessions(&[("s1", "Alpha", "/work/a")]), cx);
    let hopping = |key: &'static str, cx: &mut TestAppContext| {
        harness.sidebar.read_with(cx, |sidebar, cx| sidebar.icon_hopping(key, cx))
    };
    let hover = |id: gpui_kit::ElementId, cx: &mut TestAppContext| {
        cx.update_window(harness.window.into(), |_, window, cx| {
            window.render_frame(cx);
            window.hover(id, cx);
        })
        .expect("window");
        cx.run_until_parked();
    };
    hover("new-session".into(), cx);
    assert!(!hopping("new-task", cx), "not with motion reduced");
    hover(row("s1"), cx);

    cx.update(|cx| cx.set_reduce_motion(false));
    for (id, key) in [
        (gpui_kit::ElementId::from("new-session"), "new-task"),
        (domain_element_id("sidebar-page", "extensions"), "extensions"),
        (domain_element_id("sidebar-page", "scheduled-tasks"), "scheduled-tasks"),
        ("search-button".into(), "search"),
    ] {
        hover(id, cx);
        assert!(hopping(key, cx), "{key} hops");
        cx.executor().advance_clock(shared::hop::HOP_DURATION);
        assert!(!hopping(key, cx), "{key} settles");
    }
    // Once per entry: staying on the row does not hop it again; leaving
    // and coming back does.
    hover("search-button".into(), cx);
    assert!(!hopping("search", cx));
    hover(row("s1"), cx);
    hover("search-button".into(), cx);
    assert!(hopping("search", cx), "a new entry");
}
