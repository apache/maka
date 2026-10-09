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

//! UI integration tests: the Extensions page in a headless window, driven
//! through its rows, switches, buttons, and dialogs, against a scripted
//! Host that keeps a Skill catalog the way the Host's
//! `SkillCatalogRepository` answers it (every change bumps the revision; a
//! change at a stale revision is a `revision_conflict`), in the shapes
//! packages/runtime-host/src/protocol/skill-catalog.ts decodes.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    TestAppContext, Window, WindowHandle, div, px, size,
};
use host_client::{ConnectionEvent, HostEvent};
use host_protocol::HostAccepted;
use serde_json::{Value, json};
use shared::copy::extensions as copy;
use shared::domain_element_id;
use workspace::{
    HostRequestError, HostRequester, HostSession, HostTransport, ProjectCatalogError,
    ProjectCatalogSource, ProjectEntry, ProjectSelection,
};

use crate::import::{ImportFailure, import_skill_source, skill_sources_root};
use crate::locations::{
    LocationFailure, LocationStatus, SkillLocationRef, SkillRoots, inspect_locations, open_location,
};
use crate::{ExtensionsContext, ExtensionsView};

type Reply = Result<Value, HostRequestError>;

/// The project the page reads Skills for, and where the Host resolves it.
const PROJECT: &str = "p1";
const PROJECT_PATH: &str = "/work/demo";

fn revision(n: u64) -> String {
    format!("sha256:{n:064x}")
}

fn skill(skill_ref: &str, name: &str) -> Value {
    let id = skill_ref.rsplit(':').next().expect("id");
    let mut parts = skill_ref.split(':');
    let (scope, source) = (parts.next().expect("scope"), parts.next().expect("source"));
    json!({
        "kind": "skill", "ref": skill_ref, "id": id, "name": name,
        "description": format!("What {name} does"), "declaredTools": ["Read"],
        "metadataTruncated": false, "sourceType": "workspace", "userModified": false,
        "validationStatus": "ok", "validationCodes": [], "managedUpdateStatus": null,
        "enabled": true, "pinned": false, "runtimeStatus": "enabled", "scope": scope,
        "source": source, "contextStatus": "advertised", "contextRank": 1, "shadowedBy": null,
        "needsReview": false, "manageable": true
    })
}

fn bundled(id: &str, name: &str, category: &str) -> Value {
    json!({"kind": "bundled", "id": id, "name": name, "description": format!("{name} built in"),
           "category": category, "declaredTools": [], "metadataTruncated": false,
           "installed": false})
}

fn source(id: &str, name: &str) -> Value {
    json!({"kind": "managed_source", "id": id, "name": name, "description": "",
           "category": "研究与分析", "sourceType": "local", "metadataTruncated": false,
           "installed": false})
}

/// The catalog the scripted Host keeps.
#[derive(Default)]
struct Catalog {
    revision: u64,
    installed: Vec<Value>,
    bundled: Vec<Value>,
    sources: Vec<Value>,
    /// Items per page (all on one when 0).
    page_size: usize,
    /// How many changes answer `revision_conflict` first.
    conflicts: usize,
    /// A refusal the next change gets.
    refuse: Option<&'static str>,
}

#[derive(Default)]
struct ScriptedHost {
    catalog: Mutex<Catalog>,
    requests: Mutex<Vec<(String, Value)>>,
}

impl ScriptedHost {
    fn new(installed: Vec<Value>, bundled: Vec<Value>, sources: Vec<Value>) -> Arc<Self> {
        let host = Self::default();
        *host.catalog.lock().expect("catalog") =
            Catalog { revision: 1, installed, bundled, sources, ..Catalog::default() };
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

    fn query(&self, input: &Value) -> Value {
        let catalog = self.catalog.lock().expect("catalog");
        let view = input["view"].as_str().expect("view");
        let items = match view {
            "governance" => &catalog.installed,
            "bundled" => &catalog.bundled,
            _ => &catalog.sources,
        };
        if input["kind"] == "continue" && input["revision"] != json!(revision(catalog.revision)) {
            return json!({"kind": "revision_changed", "expectedRevision": input["revision"],
                          "actualRevision": revision(catalog.revision),
                          "resolvedWorkspace": resolved()});
        }
        let start = input["cursor"].as_str().map_or(0, |cursor| cursor.parse().expect("cursor"));
        let size = if catalog.page_size == 0 { items.len().max(1) } else { catalog.page_size };
        let end = (start + size).min(items.len());
        let next = (end < items.len()).then(|| end.to_string());
        json!({"kind": "page", "view": view, "revision": revision(catalog.revision),
               "items": items[start..end], "nextCursor": next,
               "resolvedWorkspace": resolved()})
    }

    fn mutate(&self, input: &Value) -> Value {
        let mut catalog = self.catalog.lock().expect("catalog");
        if catalog.conflicts > 0 || input["expectedRevision"] != json!(revision(catalog.revision)) {
            // Someone else's change lands first: the revision moves on.
            catalog.conflicts = catalog.conflicts.saturating_sub(1);
            catalog.revision += 1;
            return json!({"kind": "revision_conflict",
                          "expectedRevision": input["expectedRevision"],
                          "actualRevision": revision(catalog.revision),
                          "resolvedWorkspace": resolved()});
        }
        if let Some(reason) = catalog.refuse.take() {
            return json!({"kind": "rejected", "reason": reason, "resolvedWorkspace": resolved()});
        }
        let mutation = &input["mutation"];
        let position = |catalog: &Catalog| {
            catalog.installed.iter().position(|item| item["ref"] == mutation["ref"])
        };
        let entry = match mutation["kind"].as_str().expect("kind") {
            "install" => {
                let id = mutation["sourceId"].as_str().expect("sourceId");
                let managed = mutation["sourceType"] == "managed";
                let list = if managed { &mut catalog.sources } else { &mut catalog.bundled };
                let offered = list.iter_mut().find(|item| item["id"] == id).expect("offered");
                offered["installed"] = json!(true);
                let name = offered["name"].as_str().expect("name").to_owned();
                let mut installed = skill(&format!("workspace:legacy:{id}"), &name);
                installed["sourceType"] = json!(if managed { "managed" } else { "bundled" });
                if managed {
                    installed["managedUpdateStatus"] = json!("up_to_date");
                }
                catalog.installed.push(installed.clone());
                Some(installed)
            }
            "set_enabled" | "set_pinned" => {
                let ix = position(&catalog).expect("installed");
                let item = &mut catalog.installed[ix];
                if mutation["kind"] == "set_enabled" {
                    item["enabled"] = mutation["enabled"].clone();
                } else {
                    item["pinned"] = mutation["pinned"].clone();
                }
                Some(item.clone())
            }
            "delete" => {
                let ix = position(&catalog).expect("installed");
                catalog.installed.remove(ix);
                None
            }
            "update_managed" => {
                let ix = position(&catalog).expect("installed");
                let item = &mut catalog.installed[ix];
                if item["managedUpdateStatus"] == "local_modified" && mutation["force"] != true {
                    return json!({"kind": "rejected", "reason": "local_modified",
                                  "resolvedWorkspace": resolved()});
                }
                item["managedUpdateStatus"] = json!("up_to_date");
                item["userModified"] = json!(false);
                Some(item.clone())
            }
            other => panic!("unexpected mutation {other}"),
        };
        catalog.revision += 1;
        json!({"kind": "committed", "revision": revision(catalog.revision), "entry": entry,
               "resolvedWorkspace": resolved()})
    }

    fn preview(&self, input: &Value) -> Value {
        let catalog = self.catalog.lock().expect("catalog");
        if input["expectedRevision"] != json!(revision(catalog.revision)) {
            return json!({"kind": "revision_conflict",
                          "expectedRevision": input["expectedRevision"],
                          "actualRevision": revision(catalog.revision),
                          "resolvedWorkspace": resolved()});
        }
        json!({
            "kind": "preview", "revision": revision(catalog.revision),
            "currentSnippet": "---\nname: Brief\n---\nold\n",
            "sourceSnippet": "---\nname: Brief\n---\nnew\n",
            "currentTruncated": false, "sourceTruncated": false, "hasManagedBaseline": true,
            "summary": {"currentLineCount": 4, "sourceLineCount": 4, "changedLineCount": 1},
            "expectedCurrentSha256": revision(0xc), "expectedSourceSha256": revision(0x5),
            "resolvedWorkspace": resolved()
        })
    }
}

fn resolved() -> Value {
    json!({"target": {"kind": "project", "projectId": PROJECT}, "hostCwd": PROJECT_PATH})
}

impl HostTransport for ScriptedHost {
    fn request(&self, operation: &'static str, input: Value, _: Duration) -> Boxed<Reply> {
        self.requests.lock().expect("requests").push((operation.to_owned(), input.clone()));
        let reply = match operation {
            "skill.catalog.query" => Ok(self.query(&input)),
            "skill.catalog.mutate" => Ok(self.mutate(&input)),
            "skill.catalog.preview-update" => Ok(self.preview(&input)),
            other => Err(HostRequestError::Transport(format!("unexpected {other}").into())),
        };
        Box::pin(async move { reply })
    }
}

struct DemoProject;

impl ProjectCatalogSource for DemoProject {
    fn list(&self, _: &HostRequester) -> Boxed<Result<Vec<ProjectEntry>, ProjectCatalogError>> {
        Box::pin(async { Ok(vec![ProjectEntry::new(PROJECT, "Demo", PROJECT_PATH)]) })
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

/// The page as the shell draws it; `Root` draws the dialog layer over it.
struct Shell(Entity<ExtensionsView>);

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.0.clone())
    }
}

/// A scratch directory, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir()
            .join(format!("maka-gpui-extensions-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("scratch");
        Self(std::fs::canonicalize(&path).expect("canonical"))
    }

    #[allow(clippy::disallowed_methods)] // Test setup.
    fn write(&self, relative: &str, text: &str) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(&path, text).expect("write");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Harness {
    transport: Arc<ScriptedHost>,
    host: Entity<HostSession>,
    view: Entity<ExtensionsView>,
    window: WindowHandle<Root>,
    opened: Rc<RefCell<Vec<PathBuf>>>,
}

impl Harness {
    fn open(transport: Arc<ScriptedHost>, cx: &mut TestAppContext) -> Self {
        Self::open_at(transport, PathBuf::from("/tmp/.dev-root"), PathBuf::from("/tmp/home"), cx)
    }

    /// The page for the State Root `root` and the home directory `home`,
    /// connected and shown once.
    fn open_at(
        transport: Arc<ScriptedHost>,
        root: PathBuf,
        home: PathBuf,
        cx: &mut TestAppContext,
    ) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            // Dialogs slide in on the wall clock; with motion reduced they
            // settle on their first frame.
            cx.set_reduce_motion(true);
        });
        let host = cx.new(|_| HostSession::with_transport(root, transport.clone()));
        let projects = cx.new(|cx| ProjectSelection::new(host.clone(), Rc::new(DemoProject), cx));
        let opened = Rc::new(RefCell::new(Vec::new()));
        let recorded = opened.clone();
        let context = ExtensionsContext::new(host.clone(), projects)
            .home(home)
            .opener(move |path, _| recorded.borrow_mut().push(path.to_path_buf()));
        let mut view = None;
        let window = cx.open_window(size(px(1100.), px(800.)), |window, cx| {
            let page = cx.new(|cx| ExtensionsView::new(context, window, cx));
            view = Some(page.clone());
            let shell = cx.new(|_| Shell(page));
            Root::new(shell, window, cx)
        });
        let harness = Self { transport, host, view: view.expect("view"), window, opened };
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
        let sent = self.transport.requests("skill.catalog.mutate");
        sent.iter().map(|input| input["mutation"].clone()).collect()
    }

    /// The views read, in order.
    fn reads(&self) -> Vec<String> {
        let sent = self.transport.requests("skill.catalog.query");
        sent.iter().map(|input| input["view"].as_str().expect("view").to_owned()).collect()
    }
}

fn row(skill_ref: &str) -> gpui_kit::ElementId {
    domain_element_id("skill-row", skill_ref)
}

fn discover(id: &str) -> gpui_kit::ElementId {
    domain_element_id("skill-discover", id)
}

fn install(id: &str) -> gpui_kit::ElementId {
    domain_element_id("skill-install", id)
}

/// Two installed Skills; two built-in ones, one of them installed already
/// by id; one local source.
fn standard() -> Arc<ScriptedHost> {
    ScriptedHost::new(
        vec![skill("workspace:legacy:review", "Review"), skill("user:maka:brief", "Brief")],
        vec![
            bundled("computer-use", "Computer use", "效率工具"),
            bundled("review", "Review", "效率工具"),
        ],
        vec![source("research", "Research")],
    )
}

fn labeled(title: shared::copy::Text, reason: shared::copy::Text) -> String {
    format!("{}: {}", title.en(), reason.en())
}

#[gpui_kit::test]
fn the_page_lists_installed_skills_and_what_can_be_installed(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.with_window(cx, |window, _| {
        // Its own header heads the column; Skills is the only tab, so there
        // is no tab strip.
        assert_eq!(window.find("page-title").label(), Some("Extensions"));
        assert!(
            window
                .find("page-header")
                .bounds()
                .contains(&window.find("extensions-actions").bounds().center())
        );
        assert!(window.try_find("extensions-tabs").is_none());
    });
    assert_eq!(harness.reads(), ["governance", "bundled", "managed_sources"]);
    assert_eq!(
        harness.transport.requests("skill.catalog.query")[0],
        json!({"kind": "start", "view": "governance",
               "context": {"workspace": {"kind": "project", "projectId": PROJECT}}})
    );
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(row("workspace:legacy:review")).label(), Some("Review"));
        assert!(window.find(row("user:maka:brief")).visible());
        // Discover leaves out what is installed (by id, so the built-in
        // Review is the installed one) and groups by category only when
        // there is more than one.
        assert!(window.find(discover("computer-use")).visible());
        assert!(window.find(discover("research")).visible());
        assert!(window.try_find(discover("review")).is_none(), "installed already");
        assert!(window.find(domain_element_id("skills-category", "Productivity")).visible());
        assert!(window.find(domain_element_id("skills-category", "Research & analysis")).visible());
    });
    // The search narrows both lists.
    let search = harness.view.read_with(cx, |view, _| view.search().clone());
    harness.with_window(cx, |window, cx| {
        search.update(cx, |search, cx| search.set_value("rev", window, cx));
        harness.view.update(cx, |_, cx| cx.notify());
    });
    harness.with_window(cx, |window, _| {
        assert!(window.find(row("workspace:legacy:review")).visible());
        assert!(window.try_find(row("user:maka:brief")).is_none());
        assert!(window.try_find(discover("computer-use")).is_none());
        assert_eq!(window.find("skills-search-summary").label(), Some("1 match"));
    });
}

#[gpui_kit::test]
fn a_listing_is_read_page_by_page_at_one_revision(cx: &mut TestAppContext) {
    let transport = standard();
    transport.with_catalog(|catalog| {
        catalog.page_size = 1;
        catalog.installed.push(skill("project:maka:third", "Third"));
    });
    let harness = Harness::open(transport, cx);
    let governance: Vec<Value> = harness
        .transport
        .requests("skill.catalog.query")
        .into_iter()
        .filter(|input| input["view"] == "governance")
        .collect();
    assert_eq!(governance.len(), 3, "three pages of one");
    assert_eq!(governance[1]["kind"], "continue");
    assert_eq!(governance[1]["cursor"], "1");
    assert_eq!(governance[2]["revision"], json!(revision(1)), "at the first page's revision");
    harness.with_window(cx, |window, _| {
        assert!(window.find(row("project:maka:third")).visible());
    });
}

#[gpui_kit::test]
fn the_detail_shows_the_whole_description(cx: &mut TestAppContext) {
    let mut long = skill("workspace:legacy:review", "Review");
    long["description"] = json!("Reads the change and says what it breaks. ".repeat(30));
    let harness = Harness::open(ScriptedHost::new(vec![long], vec![], vec![]), cx);
    harness.with_window(cx, |window, cx| window.click(row("workspace:legacy:review"), cx));
    harness.with_window(cx, |window, _| {
        // The title's line (24px) and every line of the description under
        // it, not two lines cut short.
        let title = window.find("skill-detail-title").bounds();
        assert!(title.size.height > gpui_kit::px(24. + 20. * 3.), "{title:?}");
    });
}

#[gpui_kit::test]
fn the_detail_switches_enable_and_pin_and_the_list_is_read_again(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.with_window(cx, |window, cx| window.click(row("workspace:legacy:review"), cx));
    harness.with_window(cx, |window, cx| {
        assert!(window.find("skill-detail").visible(), "the detail opens");
        assert_eq!(window.find("skill-detail-title").label(), Some("Review"));
        assert!(window.find("skill-detail-path").visible(), "the folder, for a local Host");
        // Desktop's MetadataList: the value 16 after a 120 label column.
        let fact = window.find("skill-detail-path").bounds();
        let switch = window.find("skill-detail-enabled").bounds();
        assert_eq!(switch.left() - fact.left(), gpui_kit::px(136.));
        harness.transport.clear();
        window.click("skill-detail-enabled", cx);
    });
    assert_eq!(
        harness.mutations(),
        [json!({"kind": "set_enabled", "ref": "workspace:legacy:review", "enabled": false})]
    );
    let mutate = &harness.transport.requests("skill.catalog.mutate")[0];
    assert_eq!(mutate["expectedRevision"], json!(revision(1)), "at the revision just read");
    assert_eq!(harness.reads(), ["governance", "governance"], "a fresh read, then the refresh");
    harness.with_window(cx, |window, cx| {
        assert_eq!(
            window.find(row("workspace:legacy:review")).label(),
            Some("Review, Disabled"),
            "the row says it is off"
        );
        window.click("skill-detail-pinned", cx);
    });
    assert_eq!(
        harness.mutations().last(),
        Some(&json!({"kind": "set_pinned", "ref": "workspace:legacy:review", "pinned": true}))
    );
    let pinned = harness.transport.with_catalog(|catalog| catalog.installed[0]["pinned"].clone());
    assert_eq!(pinned, json!(true));
    // Escape closes the detail.
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    harness.with_window(cx, |window, _| assert!(window.try_find("skill-detail").is_none()));
    assert_eq!(harness.view.read_with(cx, |view, _| view.detail().cloned()), None);
}

#[gpui_kit::test]
fn a_change_at_a_stale_revision_is_rebuilt_and_a_refusal_says_why(cx: &mut TestAppContext) {
    let transport = standard();
    transport.with_catalog(|catalog| catalog.conflicts = 1);
    let harness = Harness::open(transport, cx);
    harness.with_window(cx, |window, cx| window.click(row("user:maka:brief"), cx));
    harness.with_window(cx, |window, cx| window.click("skill-detail-pinned", cx));
    let sent = harness.transport.requests("skill.catalog.mutate");
    assert_eq!(sent.len(), 2, "sent again after the conflict");
    assert_eq!(sent[1]["expectedRevision"], json!(revision(2)), "at the fresh read's revision");
    harness.transport.with_catalog(|catalog| catalog.refuse = Some("state_error"));
    harness.with_window(cx, |window, cx| window.click("skill-detail-enabled", cx));
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("skill-detail-feedback").label(),
            Some(labeled(copy::TOGGLE_FAILED, copy::STATE_ERROR).as_str())
        );
    });
}

#[gpui_kit::test]
fn install_from_discover_moves_the_skill_to_installed(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.transport.clear();
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find(install("computer-use")).label(), Some("Install Computer use"));
        // Desktop's size sm.
        assert_eq!(window.find(install("computer-use")).bounds().size.height, px(28.));
        window.click(install("computer-use"), cx);
    });
    assert_eq!(
        harness.mutations(),
        [json!({"kind": "install", "sourceType": "bundled", "sourceId": "computer-use"})]
    );
    // Built on the built-in view's revision, then the installed and the
    // built-in Skills are read again.
    assert_eq!(harness.reads(), ["bundled", "governance", "bundled"]);
    harness.with_window(cx, |window, cx| {
        assert!(window.find(row("workspace:legacy:computer-use")).visible());
        assert!(window.try_find(discover("computer-use")).is_none());
        window.click(install("research"), cx);
    });
    assert_eq!(
        harness.mutations().last(),
        Some(&json!({"kind": "install", "sourceType": "managed", "sourceId": "research"}))
    );
    assert_eq!(harness.reads()[3..], ["managed_sources", "governance", "managed_sources"]);
}

#[gpui_kit::test]
fn an_update_is_reviewed_and_local_changes_are_overwritten_with_the_previews_hashes(
    cx: &mut TestAppContext,
) {
    let mut managed = skill("workspace:legacy:brief", "Brief");
    managed["sourceType"] = json!("managed");
    managed["managedUpdateStatus"] = json!("local_modified");
    managed["userModified"] = json!(true);
    let harness = Harness::open(ScriptedHost::new(vec![managed], vec![], vec![]), cx);
    harness.with_window(cx, |window, cx| {
        assert_eq!(
            window.find(row("workspace:legacy:brief")).label(),
            Some("Brief, Locally modified")
        );
        window.click(row("workspace:legacy:brief"), cx);
    });
    harness.with_window(cx, |window, cx| {
        assert_eq!(
            window.find("skill-detail-banner").label(),
            Some(copy::STATUS_LOCAL_MODIFIED.en())
        );
        window.click("skill-review-update", cx);
    });
    let preview = &harness.transport.requests("skill.catalog.preview-update")[0];
    assert_eq!(preview["ref"], "workspace:legacy:brief");
    assert_eq!(preview["expectedRevision"], json!(revision(1)));
    harness.with_window(cx, |window, cx| {
        assert!(window.find("skill-review").visible());
        assert!(window.find("skill-review-warning").visible(), "local changes will go");
        let summary = window.find("skill-review-summary").label().expect("summary").to_owned();
        assert!(summary.contains("4 → 4 lines") && summary.contains("1 line differs"), "{summary}");
        window.click("skill-review-apply", cx);
    });
    assert_eq!(
        harness.mutations(),
        [json!({"kind": "update_managed", "ref": "workspace:legacy:brief", "force": true,
                "expectedCurrentSha256": revision(0xc), "expectedSourceSha256": revision(0x5)})]
    );
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("skill-review").is_none(), "back to the detail");
        assert!(window.try_find("skill-detail-banner").is_none(), "nothing to review now");
        assert_eq!(window.find(row("workspace:legacy:brief")).label(), Some("Brief"));
    });
}

#[gpui_kit::test]
fn delete_asks_first_and_the_detail_closes_with_the_skill(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.with_window(cx, |window, cx| window.click(row("user:maka:brief"), cx));
    harness.with_window(cx, |window, cx| window.click("skill-detail-delete", cx));
    harness.with_window(cx, |window, cx| {
        assert!(window.find("cancel").visible(), "the confirmation shows");
        window.click("cancel", cx);
    });
    assert!(harness.mutations().is_empty(), "Cancel deletes nothing");
    harness.with_window(cx, |window, cx| {
        assert!(window.find("skill-detail").visible(), "the detail is still there");
        window.click("skill-detail-delete", cx);
    });
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    assert_eq!(harness.mutations(), [json!({"kind": "delete", "ref": "user:maka:brief"})]);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(row("user:maka:brief")).is_none(), "gone from the list");
        assert!(window.try_find("skill-detail").is_none(), "and its detail closed");
    });
}

#[gpui_kit::test]
fn the_keyboard_walks_the_installed_skills_and_opens_one(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.with_window(cx, |window, cx| {
        let focus = gpui_kit::Focusable::focus_handle(harness.view.read(cx), cx);
        window.focus(&focus, cx);
        window.press("down", cx);
        window.press("down", cx);
        window.press("enter", cx);
    });
    assert_eq!(
        harness.view.read_with(cx, |view, _| view.detail().cloned()).as_deref(),
        Some("user:maka:brief")
    );
}

#[gpui_kit::test]
fn a_new_connection_reads_the_catalog_again(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.transport.clear();
    harness.connect(cx);
    assert_eq!(harness.reads(), ["governance", "bundled", "managed_sources"]);
}

#[gpui_kit::test]
fn open_skill_md_opens_the_file_under_its_scope(cx: &mut TestAppContext) {
    let root = Scratch::new("open-root");
    let file = root.write("skills/review/SKILL.md", "---\nname: Review\ndescription: d\n---\n");
    let home = Scratch::new("open-home");
    let harness = Harness::open_at(standard(), root.0.clone(), home.0.clone(), cx);
    harness.with_window(cx, |window, cx| window.click(row("workspace:legacy:review"), cx));
    harness.with_window(cx, |window, cx| window.click("skill-detail-open", cx));
    assert_eq!(*harness.opened.borrow(), [file]);
    // One whose file is not there says so.
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    harness.with_window(cx, |window, cx| window.click(row("user:maka:brief"), cx));
    harness.with_window(cx, |window, cx| window.click("skill-detail-open", cx));
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("skill-detail-feedback").label(),
            Some(labeled(copy::OPEN_FAILED, copy::OPEN_MISSING).as_str())
        );
    });
}

#[gpui_kit::test]
fn a_local_skill_is_imported_into_the_source_library(cx: &mut TestAppContext) {
    let home = Scratch::new("import-home");
    let files = Scratch::new("import-files");
    let good = files.write(
        "Research Brief/SKILL.md",
        "---\nname: Research brief\ndescription: Prepare a research brief\n---\nSteps\n",
    );
    let harness = Harness::open_at(standard(), PathBuf::from("/tmp/.dev-root"), home.0.clone(), cx);
    harness.transport.clear();
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.import_local(window, cx));
    });
    assert!(cx.did_prompt_for_paths(), "a file dialog asks");
    cx.simulate_path_prompt_response(|options| {
        assert!(options.files && !options.directories && !options.multiple);
        Some(vec![good.clone()])
    });
    cx.run_until_parked();
    let written = skill_sources_root(&home.0).join("research-brief").join("SKILL.md");
    assert!(written.is_file(), "written to ~/.maka/skill-sources/<id>/SKILL.md");
    assert_eq!(harness.reads(), ["managed_sources"], "the sources are read again");
    harness.with_window(cx, |window, _| {
        let expected = format!("{}: Research brief", copy::IMPORTED.en());
        assert_eq!(window.find("extensions-feedback").label(), Some(expected.as_str()));
    });
    // The same one again: the library has it.
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.import_file(good.clone(), window, cx));
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("extensions-feedback").label(),
            Some(labeled(copy::IMPORT_FAILED, copy::SOURCE_ALREADY_EXISTS).as_str())
        );
    });
    // A file that is not a Skill.
    let bad = files.write("notes.md", "# Just notes\n");
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.import_file(bad, window, cx));
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("extensions-feedback").label(),
            Some(labeled(copy::IMPORT_FAILED, copy::SOURCE_INVALID).as_str())
        );
    });
}

#[test]
fn import_refuses_what_desktop_refuses() {
    let home = Scratch::new("import-refusals");
    let root = skill_sources_root(&home.0);
    let files = Scratch::new("import-refusal-files");
    let invalid = files.write("a/SKILL.md", "---\nname: A\n---\n");
    assert_eq!(import_skill_source(&root, &invalid), Err(ImportFailure::InvalidSkill));
    assert!(!root.join("a").exists(), "nothing written");
    let unnamed = files.write("研究/SKILL.md", "---\nname: A\ndescription: B\n---\n");
    assert_eq!(import_skill_source(&root, &unnamed), Err(ImportFailure::InvalidSkill));
    assert_eq!(
        import_skill_source(&root, &files.0.join("missing.md")),
        Err(ImportFailure::InvalidSkill)
    );
    let valid = files.write("b.md", "---\nname: B\ndescription: C\n---\n");
    #[cfg(unix)]
    {
        let link = files.0.join("link.md");
        std::os::unix::fs::symlink(&valid, &link).expect("symlink");
        assert_eq!(import_skill_source(&root, &link), Err(ImportFailure::BlockedPath));
    }
    let imported = import_skill_source(&root, &valid).expect("imported");
    assert_eq!((imported.id.as_str(), imported.name.as_str()), ("b", "B"));
    assert_eq!(imported.path, root.join("b").join("SKILL.md"));
    assert_eq!(import_skill_source(&root, &valid), Err(ImportFailure::AlreadyExists));
}

#[test]
fn locations_are_inspected_and_a_missing_one_is_created_on_open() {
    let root = Scratch::new("locations-root");
    let home = Scratch::new("locations-home");
    std::fs::create_dir_all(home.0.join(".maka/skills")).expect("dir");
    let roots = SkillRoots::new(None, root.0.clone(), home.0.clone());
    let status = |roots: &SkillRoots, location| {
        inspect_locations(roots)
            .into_iter()
            .find(|shown| shown.location == location)
            .map(|shown| shown.status)
    };
    assert_eq!(status(&roots, SkillLocationRef::UserMaka), Some(LocationStatus::Available));
    assert_eq!(status(&roots, SkillLocationRef::WorkspaceLegacy), Some(LocationStatus::Missing));
    assert_eq!(status(&roots, SkillLocationRef::ProjectMaka), None, "no project");
    let created = open_location(&roots, SkillLocationRef::WorkspaceLegacy, true).expect("created");
    assert_eq!(created, root.0.join("skills"));
    assert!(created.is_dir());
    assert_eq!(
        open_location(&roots, SkillLocationRef::UserAgents, false),
        Err(LocationFailure::Missing)
    );
    #[cfg(unix)]
    {
        // A link out of the home directory is not followed there.
        std::os::unix::fs::symlink(std::env::temp_dir(), home.0.join(".agents")).expect("link");
        assert_eq!(status(&roots, SkillLocationRef::UserAgents), Some(LocationStatus::BlockedPath));
    }
}

/// Enter on an Install button installs: the list's keys are the list's
/// alone.
#[gpui_kit::test]
fn enter_on_an_install_button_installs(cx: &mut TestAppContext) {
    let harness = Harness::open(standard(), cx);
    harness.transport.clear();
    harness.with_window(cx, |window, cx| {
        let focus = gpui_kit::Focusable::focus_handle(harness.view.read(cx), cx);
        window.focus(&focus, cx);
        // Past the page header's search, refresh and Add.
        for _ in 0..4 {
            window.press("tab", cx);
        }
    });
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find(install("computer-use")).focused(), Some(true));
        window.press("enter", cx);
        let keystroke = gpui_kit::Keystroke::parse("enter").expect("key");
        window
            .dispatch_event(gpui_kit::PlatformInput::KeyUp(gpui_kit::KeyUpEvent { keystroke }), cx);
    });
    assert_eq!(harness.mutations().len(), 1, "installed from the keyboard");
}

#[gpui_kit::test]
fn the_add_menu_is_makas_menu(cx: &mut TestAppContext) {
    let harness = Harness::open(Arc::new(ScriptedHost::default()), cx);
    harness.with_window(cx, |window, cx| window.click("skills-add", cx));
    harness.with_window(cx, |window, cx| {
        let import = window.find(domain_element_id("menu-item", "import-local-skill")).bounds();
        assert_eq!(import.size.height, px(32.), "a menu row is 32px");
        let add = window.find("skills-add").bounds();
        assert!(import.top() > add.bottom(), "the menu hangs under Add");
        window.press("escape", cx);
    });
    harness.with_window(cx, |window, _| assert!(window.try_find("menu").is_none()));
    // The Skill locations submenu is Desktop's 420 wide, whatever the
    // paths: each path stays on one line under its label.
    harness.with_window(cx, |window, cx| window.click("skills-add", cx));
    harness.with_window(cx, |window, cx| {
        window.click(domain_element_id("menu-item", "skill-locations"), cx)
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("submenu").bounds().size.width, px(420.));
        let first = window.find(domain_element_id("menu-item", "skill-location:project:maka"));
        let height = first.bounds().size.height;
        assert!(height < px(60.), "the label and one line of path: {height:?}");
    });
}

#[gpui_kit::test]
fn command_f_focuses_the_skill_search_with_its_text_selected(cx: &mut TestAppContext) {
    use gpui_kit::Focusable as _;
    let harness = Harness::open(standard(), cx);
    let search = harness.view.read_with(cx, |view, _| view.search().clone());
    let focused = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, cx| search.read(cx).focus_handle(cx).is_focused(window))
    };
    // From the installed Skills, the page's focus.
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.focus(window, cx));
        window.press("secondary-f", cx);
    });
    assert!(focused(cx), "⌘F from the list");
    harness.with_window(cx, |window, cx| window.input("rev", cx));
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.focus(window, cx));
        window.press("secondary-f", cx);
    });
    assert!(focused(cx), "again");
    assert_eq!(search.read_with(cx, |search, _| search.selected_range()), 0..3, "“rev” selected");
    // In the field itself, the kit's ⌘F passes it on: still the search,
    // still all of it.
    harness.with_window(cx, |window, cx| window.press("secondary-f", cx));
    assert!(focused(cx));
    assert_eq!(search.read_with(cx, |search, _| search.selected_range()), 0..3);
}
