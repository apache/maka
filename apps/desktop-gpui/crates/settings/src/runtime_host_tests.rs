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

//! Workspace's Runtime Host block, the header's Host picker, and the remote
//! project directory browser, in a headless window: against a scratch
//! profile store with scripted pairing (the network half is
//! `workspace::hosts_tests`, against the scripted WebSocket Host), and a
//! scripted Host transport for the projects.
#![allow(clippy::disallowed_methods)]

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_lite::future::{Boxed, block_on};
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Context, ElementId, Entity, IntoElement, ParentElement as _, Render,
    Styled as _, TestAppContext, Window, WindowHandle, div, px, size,
};
use host_client::{ConnectionEvent, HostEvent, RemoteHostProfile, RemoteProfileStore};
use host_protocol::{AccessCredential, RemoteTransport};
use serde_json::{Value, json};
use shared::copy::remote_hosts as copy;
use shared::domain_element_id;
use workspace::{
    ConnectionCatalog, HostDirectory, HostPairing, HostProjectCatalog, HostRefusal, HostSession,
    ProjectSelection, RemoteHost, WindowHost,
};

use crate::manual_host_form::ManualField;
use crate::tests::{ScriptedHost, accepted, catalog_page, policy};
use crate::{AboutFacts, SettingsContext, SettingsSection, SettingsView, SwitchHost};

const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";

/// Answers probes and pairings from queues; an empty queue succeeds.
#[derive(Default)]
struct ScriptedPairing {
    probes: Mutex<VecDeque<Result<(), HostRefusal>>>,
    pairs: Mutex<VecDeque<Result<(), HostRefusal>>>,
    paired: Mutex<Vec<String>>,
}

impl HostPairing for ScriptedPairing {
    fn probe(&self, _: RemoteHostProfile, _: AccessCredential) -> Boxed<Result<(), HostRefusal>> {
        let answer = self.probes.lock().expect("probes").pop_front().unwrap_or(Ok(()));
        Box::pin(async move { answer })
    }

    fn pair(
        &self,
        profile: RemoteHostProfile,
        _: AccessCredential,
    ) -> Boxed<Result<(), HostRefusal>> {
        self.paired.lock().expect("paired").push(profile.id().to_owned());
        let answer = self.pairs.lock().expect("pairs").pop_front().unwrap_or(Ok(()));
        Box::pin(async move { answer })
    }
}

struct Shell(Entity<SettingsView>);

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.0.clone())
    }
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn tls_profile(id: &str, name: &str) -> RemoteHostProfile {
    let transport = RemoteTransport::tls("wss://build.example.com/runtime-host").expect("tls");
    RemoteHostProfile::new(id, name, ROOT_ID, transport).expect("profile")
}

fn credential() -> AccessCredential {
    AccessCredential::new("mrha_scripted").expect("credential")
}

struct Harness {
    directory: Entity<HostDirectory>,
    pairing: Arc<ScriptedPairing>,
    view: Entity<SettingsView>,
    window: WindowHandle<Root>,
    switched: Rc<RefCell<Vec<String>>>,
    _scratch: Scratch,
}

impl Harness {
    /// Settings on `section` for a window on `host`, with the saved remote
    /// Hosts `saved` (profile, enabled).
    fn open(
        section: SettingsSection,
        host: WindowHost,
        saved: &[(RemoteHostProfile, bool)],
        transport: Arc<ScriptedHost>,
        cx: &mut TestAppContext,
    ) -> Self {
        cx.executor().allow_parking();
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            cx.set_reduce_motion(true);
        });
        let dir =
            std::env::temp_dir().join(format!("settings-hosts-{}", uuid::Uuid::new_v4().simple()));
        let store = RemoteProfileStore::new(dir.join("config"));
        for (profile, enabled) in saved {
            block_on(store.create(profile, &credential())).expect("saved");
            if *enabled {
                block_on(store.set_enabled(profile.id(), true)).expect("enabled");
            }
        }
        let pairing = Arc::new(ScriptedPairing::default());
        let directory = cx.new(|cx| HostDirectory::new(store, pairing.clone(), cx));
        cx.update(|cx| HostDirectory::install(directory.clone(), cx));
        settle(&directory, cx);
        transport.reply("runtime.policy.query", Ok(policy(3, "bypass")));
        transport.always("connection.catalog.query", Ok(catalog_page(6)));
        let session = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone())
                .for_host(host)
        });
        session.update(cx, |session, cx| {
            session.handle_host_event(
                HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
                cx,
            )
        });
        let connections = cx.new(|cx| ConnectionCatalog::new(session.clone(), cx));
        let projects =
            cx.new(|cx| ProjectSelection::new(session.clone(), Rc::new(HostProjectCatalog), cx));
        cx.run_until_parked();
        let context =
            SettingsContext::new(session.clone(), connections, projects, AboutFacts::new("9.9.9"));
        let mut view = None;
        let window = cx.open_window(size(px(1512.), px(885.)), |window, cx| {
            let settings = cx.new(|cx| SettingsView::new(context, section, window, cx));
            view = Some(settings.clone());
            Root::new(cx.new(|_| Shell(settings)), window, cx)
        });
        let view = view.expect("the surface");
        let switched = Rc::new(RefCell::new(Vec::new()));
        let recorded = switched.clone();
        cx.update(|cx| {
            cx.subscribe(&view, move |_, event: &SwitchHost, _| {
                recorded.borrow_mut().push(event.profile_id.to_string());
            })
            .detach();
        });
        cx.run_until_parked();
        Self { directory, pairing, view, window, switched, _scratch: Scratch(dir) }
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

    fn click(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) {
        let id = id.into();
        self.with_window(cx, |window, cx| {
            crate::tests::reveal(window, &id, cx);
            window.click(id, cx)
        });
    }

    fn section(&self, cx: &mut TestAppContext) -> Entity<crate::RuntimeHostSection> {
        self.view.read_with(cx, |view, _| view.hosts().cloned()).expect("the Runtime Host block")
    }

    /// Opens a place of the block (`RuntimeHostSection::reveal`).
    fn reveal(&self, target: &str, cx: &mut TestAppContext) {
        let view = self.view.clone();
        let target = target.to_owned();
        self.with_window(cx, move |window, cx| {
            view.update(cx, |view, cx| assert!(view.open_target(&target, window, cx), "{target}"))
        });
    }

    fn type_into(&self, field: &str, text: &str, cx: &mut TestAppContext) {
        let id = domain_element_id("host-field", field);
        self.with_window(cx, |window, cx| {
            crate::tests::reveal(window, &id, cx);
            window.click(id, cx);
            window.input(text, cx);
        });
    }

    fn label(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|element| element.label().map(str::to_owned))
        })
    }

    fn exists(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> bool {
        let id = id.into();
        self.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    fn settle(&self, cx: &mut TestAppContext) {
        settle(&self.directory, cx);
    }
}

/// Runs the directory's background work (its files are written on the
/// blocking pool) until it is idle, then lets the reload after it answer.
fn settle(directory: &Entity<HostDirectory>, cx: &mut TestAppContext) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        let idle = directory.read_with(cx, |directory, _| {
            !directory.is_busy() && (directory.list().is_some() || directory.load_error().is_some())
        });
        if idle || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    for _ in 0..20 {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
    cx.run_until_parked();
}

fn remote_host(id: &str, name: &str) -> WindowHost {
    WindowHost::Remote(RemoteHost::new(tls_profile(id, name), credential()))
}

#[gpui_kit::test]
fn the_workspace_page_leads_with_the_runtime_host_block(cx: &mut TestAppContext) {
    let saved = [(tls_profile("build", "Build box"), true), (tls_profile("old", "Old box"), false)];
    let harness = Harness::open(
        SettingsSection::Projects,
        WindowHost::Local,
        &saved,
        Arc::new(ScriptedHost::default()),
        cx,
    );
    harness.with_window(cx, |window, _| {
        let runtime = window.find(domain_element_id("settings-group", "runtime-host")).bounds();
        let other = window.find(domain_element_id("settings-group", "other-hosts")).bounds();
        let projects = window.find(domain_element_id("settings-group", "projects")).bounds();
        assert!(runtime.bottom() <= other.top() && other.bottom() <= projects.top());
        // The projects follow the Host groups under a heading of their own.
        assert_eq!(
            window.find(domain_element_id("settings-group-title", "projects")).label(),
            Some(shared::copy::settings::SECTION_PROJECTS.en())
        );
        assert_eq!(
            window.find(domain_element_id("settings-row", "default-host")).label(),
            Some(copy::DEFAULT_HOST.en())
        );
        assert_eq!(
            window.find(crate::tests::select("default-host")).value(),
            Some(shared::copy::HOST_LOCAL.en())
        );
        // Each remote Host, with where it points; neither is the default.
        let build = window.find(domain_element_id("host-row", "build"));
        assert_eq!(build.label(), Some("Build box"));
        assert!(window.try_find(domain_element_id("host-row", "old")).is_some());
    });
    // The enabled one is offered in the header, the disabled one is not.
    let offered = harness
        .view
        .read_with(cx, |view, cx| view.host_picker().map(|picker| picker.read(cx).offered()));
    assert_eq!(offered, Some(2));
    assert!(harness.exists("settings-host-picker", cx), "Workspace is the Host's too");
}

#[gpui_kit::test]
fn the_host_picker_leaves_the_title_its_width_on_every_host_page(cx: &mut TestAppContext) {
    let saved = [(tls_profile("build", "Build box"), true)];
    let harness = Harness::open(
        SettingsSection::Projects,
        WindowHost::Local,
        &saved,
        Arc::new(ScriptedHost::default()),
        cx,
    );
    for section in SettingsSection::listed().filter(|s| crate::section_shows_host_picker(*s)) {
        harness.view.update(cx, |view, cx| view.select(section, cx));
        harness.with_window(cx, |window, _| {
            let column = window.find(domain_element_id("settings-section", section.key())).bounds();
            let title = window.find("settings-title").bounds();
            let description = window.find("settings-description").bounds();
            let picker = window.find("settings-host-picker").bounds();
            // The picker keeps its own width at the header's end, top
            // aligned; the title block takes the rest and wraps in it.
            assert!(
                title.right() <= picker.left(),
                "{section:?}: title {title:?}, picker {picker:?}"
            );
            assert!(
                title.size.width > column.size.width / 2.,
                "{section:?}: the title is squeezed to {:?}",
                title.size.width
            );
            assert!(description.size.width > column.size.width / 2., "{section:?}");
            assert!(picker.size.width < column.size.width / 3., "{section:?}");
            assert!((picker.top() - title.top()).abs() < px(8.), "{section:?}");
            assert!(column.right() - picker.right() < px(40.), "{section:?}: picker at the end");
        });
    }
}

#[gpui_kit::test]
fn a_host_added_by_hand_is_verified_then_listed_enabled(cx: &mut TestAppContext) {
    let harness = Harness::open(
        SettingsSection::Projects,
        WindowHost::Local,
        &[],
        Arc::new(ScriptedHost::default()),
        cx,
    );
    assert_eq!(
        harness.label(domain_element_id("settings-row", "hosts-empty"), cx).as_deref(),
        Some(copy::EMPTY.en())
    );
    // Every connection code is a Direct peer, which this client refuses:
    // Use connection code is offered but cannot be chosen.
    harness.click("hosts-add-computer", cx);
    harness.click(domain_element_id("menu-item", "hosts-add:code"), cx);
    harness.with_window(cx, |window, cx| {
        assert!(window.find(domain_element_id("menu-item", "hosts-add:code")).visible());
        assert!(!gpui_kit::component::WindowExt::has_active_dialog(window, cx));
        window.press("escape", cx);
    });
    harness.reveal("manual", cx);
    harness.type_into("name", "Studio", cx);
    harness.type_into("url", "wss://studio.example.com/runtime-host", cx);
    harness.type_into("root-id", ROOT_ID, cx);
    let complete = |harness: &Harness, cx: &mut TestAppContext| {
        let form = harness.section(cx).read_with(cx, |section, _| section.form().cloned());
        form.expect("form").read_with(cx, |form, cx| form.is_complete(cx))
    };
    assert!(!complete(&harness, cx), "no credential yet: Save and enable stays off");
    harness.type_into("credential", "mrha_studio", cx);
    assert!(complete(&harness, cx));
    harness.click("host-save-and-enable", cx);
    harness.settle(cx);

    let added = harness.directory.read_with(cx, |directory, _| {
        let list = directory.list().expect("list");
        let entry = list.remotes.first().expect("added").clone();
        assert!(list.is_enabled(entry.profile.id()));
        entry.profile
    });
    assert_eq!(added.name(), "Studio");
    assert_eq!(added.transport().kind(), host_protocol::RemoteTransportKind::Tls);
    assert_eq!(*harness.pairing.paired.lock().expect("paired"), [added.id().to_owned()]);
    let section = harness.section(cx);
    assert!(section.read_with(cx, |section, _| section.form().is_none()), "the form closed");
    assert_eq!(
        harness.label(domain_element_id("settings-status", "hosts-outcome"), cx).as_deref(),
        Some("Studio is added and enabled.")
    );
    assert!(harness.exists(domain_element_id("host-row", added.id()), cx));
}

#[gpui_kit::test]
fn a_host_that_is_not_there_says_why_and_keeps_the_form(cx: &mut TestAppContext) {
    let harness = Harness::open(
        SettingsSection::Projects,
        WindowHost::Local,
        &[],
        Arc::new(ScriptedHost::default()),
        cx,
    );
    harness
        .pairing
        .probes
        .lock()
        .expect("probes")
        .push_back(Err(HostRefusal::Unreachable("box.example.com:443".into())));
    harness.reveal("manual-ssh", cx);
    harness.type_into("name", "Box", cx);
    harness.type_into("destination", "me@box.example.com", cx);
    harness.type_into("remote-port", "8765", cx);
    harness.type_into("root-id", ROOT_ID, cx);
    harness.type_into("credential", "mrha_box", cx);
    // A port that is not one keeps Save and enable off.
    harness.type_into("ssh-port", "70000", cx);
    let form =
        harness.section(cx).read_with(cx, |section, _| section.form().cloned()).expect("form");
    assert!(!form.read_with(cx, |form, cx| form.is_complete(cx)));
    harness.with_window(cx, |window, cx| {
        form.update(cx, |form, cx| {
            form.input(ManualField::SshPort).update(cx, |input, cx| input.set_value("", window, cx))
        })
    });
    harness.click("host-save-and-enable", cx);
    harness.settle(cx);
    assert_eq!(
        harness.label(domain_element_id("settings-status", "host-form-status"), cx).as_deref(),
        Some("Could not reach a Host at box.example.com:443.")
    );
    let saved = harness
        .directory
        .read_with(cx, |directory, _| directory.list().expect("list").remotes.len());
    assert_eq!(saved, 0, "nothing is saved");
    assert!(harness.section(cx).read_with(cx, |section, _| section.form().is_some()));
}

#[gpui_kit::test]
fn the_manual_form_is_one_plate_under_the_pairing_notice_and_cancel_closes_it(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(
        SettingsSection::Projects,
        WindowHost::Local,
        &[],
        Arc::new(ScriptedHost::default()),
        cx,
    );
    // A pairing whose outcome is unknown is kept to retry.
    harness.pairing.pairs.lock().expect("pairs").push_back(Err(HostRefusal::OutcomeUnknown));
    harness.directory.update(cx, |directory, cx| {
        directory.add_manual(tls_profile("pending", "Pending box"), credential(), cx)
    });
    harness.settle(cx);
    harness.reveal("manual", cx);
    harness.with_window(cx, |window, _| {
        let form = window.find("manual-host-form").bounds();
        let title = window.find("manual-host-form-title");
        assert_eq!(title.label(), Some(copy::ADD_REMOTE_HOST.en()));
        assert_eq!(title.role(), Some(gpui_kit::Role::Heading));
        // The title at the top of the plate, inside its 16px padding.
        assert!(title.bounds().top() - form.top() >= px(16.));
        assert!(title.bounds().top() - form.top() <= px(18.));
        // Cancel, then Save and enable, at the plate's bottom right.
        let cancel = window.find("host-form-cancel").bounds();
        let save = window.find("host-save-and-enable").bounds();
        assert!(cancel.right() < save.left());
        assert!(form.right() - save.right() <= px(18.));
        // The fields and the transport end where the buttons do: one edge.
        for key in ["name", "credential"] {
            let field = window.find(domain_element_id("host-field", key)).bounds();
            assert_eq!(field.right(), save.right(), "{key}: {field:?}, save {save:?}");
        }
        let transport = window.find(domain_element_id("host-choice", "transport")).bounds();
        assert_eq!(transport.right(), save.right());
        assert!(form.bottom() - save.bottom() <= px(18.));
        // The unfinished pairing comes first, over the form, as Desktop
        // renders it before `showAdd`; the list under the form.
        let notice = window.find(domain_element_id("settings-row", "pairing-recovery")).bounds();
        let row = window.find(domain_element_id("host-row", "pending")).bounds();
        assert!(notice.bottom() <= form.top(), "{form:?} {notice:?}");
        assert!(form.bottom() <= row.top());
        // The notice is a row with its Retry at the end, as Desktop's.
        let retry = window.find("hosts-retry-pairing").bounds();
        assert!(notice.left() < retry.left(), "{retry:?} {notice:?}");
        assert!((retry.right() - notice.right()).abs() < px(1.), "{retry:?} {notice:?}");
    });
    harness.click("host-form-cancel", cx);
    assert!(harness.section(cx).read_with(cx, |section, _| section.form().is_none()));
}

#[gpui_kit::test]
fn choosing_the_default_host_or_the_header_picker_switches_the_window(cx: &mut TestAppContext) {
    let saved = [(tls_profile("build", "Build box"), true)];
    let harness = Harness::open(
        SettingsSection::Models,
        WindowHost::Local,
        &saved,
        Arc::new(ScriptedHost::default()),
        cx,
    );
    assert!(harness.exists("settings-host-picker", cx), "two Hosts are offered");
    let section = harness.section(cx);
    section.update(cx, |section, cx| section.choose_default("build".into(), cx));
    harness.settle(cx);
    assert_eq!(*harness.switched.borrow(), ["build"]);
    let default = harness.directory.read_with(cx, |directory, _| {
        directory.list().expect("list").default_profile_id().to_owned()
    });
    assert_eq!(default, "build");

    // Appearance is the client's own: no Host picker there.
    harness.view.update(cx, |view, cx| view.select(SettingsSection::Appearance, cx));
    assert!(!harness.exists("settings-host-picker", cx));
}

#[gpui_kit::test]
fn a_window_on_a_remote_host_adds_projects_from_the_hosts_folders(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let page = json!({
        "kind": "page", "view": "summary", "revision": format!("sha256:{}", "0".repeat(64)),
        "projectCount": 1, "nextCursor": null,
        "items": [{"kind": "project", "projectIndex": 0, "id": "p1", "name": "Moved",
                   "aliasCount": 0, "locationCount": 1, "preferredLocationIndex": null,
                   "archivedAt": null, "available": false}]
    });
    transport.always("project.catalog.query", Ok(page));
    let host = remote_host("build", "Build box");
    let harness = Harness::open(
        SettingsSection::Projects,
        host,
        &[(tls_profile("build", "Build box"), true)],
        transport.clone(),
        cx,
    );
    // The catalog was read without folders; a project whose folder is gone
    // cannot be relinked from here.
    let first = transport.requests("project.catalog.query");
    assert_eq!(first.first(), Some(&json!({"kind": "list_start", "view": "summary"})));
    assert!(harness.exists(domain_element_id("project-row", "p1"), cx));
    assert!(!harness.exists(domain_element_id("project-relink", "p1"), cx));
    harness.with_window(cx, |window, _| {
        // A project row and a Host row share both edges; Rename and
        // Archive are 8 apart.
        let project = window.find(domain_element_id("project-row", "p1")).bounds();
        let host = window.find(domain_element_id("host-row", "build")).bounds();
        assert_eq!((project.left(), project.right()), (host.left(), host.right()));
        let rename = window.find(domain_element_id("project-rename", "p1")).bounds();
        let archive = window.find(domain_element_id("project-archive", "p1")).bounds();
        assert_eq!(archive.left() - rename.right(), px(8.));
        assert_eq!(archive.right(), project.right());
    });
    // The window's Host is marked as this window's, and cannot be disabled.
    assert!(
        harness
            .label(domain_element_id("host-row", "build"), cx)
            .is_some_and(|label| label.contains(copy::THIS_WINDOW_BADGE.en()))
    );
    harness.click(domain_element_id("host-enabled", "build"), cx);
    harness.settle(cx);
    let enabled = harness
        .directory
        .read_with(cx, |directory, _| directory.list().expect("list").is_enabled("build"));
    assert!(enabled, "the window's own Host cannot be disabled");

    // Add project… browses the Host's folders instead of this machine's.
    transport.reply(
        "project.catalog.query",
        Ok(json!({"kind": "directory_roots", "roots": [{"id": "home", "label": "Home"}]})),
    );
    let listing = |segments: Value, entries: &[&str]| {
        json!({"kind": "directory_page", "rootId": "home", "segments": segments,
               "entries": entries.iter().map(|name| json!({"name": name})).collect::<Vec<_>>(),
               "nextCursor": null})
    };
    transport.reply("project.catalog.query", Ok(listing(json!([]), &["work", ".cache"])));
    harness.click("settings-add-project", cx);
    assert!(!cx.did_prompt_for_paths(), "no folder dialog on this machine");
    assert!(harness.exists(domain_element_id("remote-directory-entry", "work"), cx));
    assert!(
        !harness.exists(domain_element_id("remote-directory-entry", ".cache"), cx),
        "hidden folders stay hidden until asked for"
    );
    transport.reply("project.catalog.query", Ok(listing(json!(["work"]), &["api"])));
    harness.click(domain_element_id("remote-directory-entry", "work"), cx);
    assert!(harness.exists(domain_element_id("remote-directory-entry", "api"), cx));
    assert!(harness.exists(domain_element_id("remote-directory-crumb", "0"), cx));

    transport.reply(
        "project.catalog.mutate",
        Ok(json!({"kind": "project", "project": {
            "id": "p2", "name": "work", "aliases": [], "locationCount": 1,
            "archivedAt": null, "available": true
        }})),
    );
    harness.click("remote-directory-select", cx);
    assert_eq!(
        transport.requests("project.catalog.mutate"),
        [json!({"kind": "register_directory", "rootId": "home", "segments": ["work"]})]
    );
    assert!(!harness.exists("remote-directory", cx), "the browser closed once registered");
}

#[gpui_kit::test]
fn a_host_row_has_its_menu_as_a_28px_button_after_the_switch(cx: &mut TestAppContext) {
    let saved = [(tls_profile("build", "Build box"), true)];
    let harness = Harness::open(
        SettingsSection::Projects,
        WindowHost::Local,
        &saved,
        Arc::new(ScriptedHost::default()),
        cx,
    );
    harness.with_window(cx, |window, _| {
        let switch = window.find(domain_element_id("host-enabled", "build")).bounds();
        let more = window.find(domain_element_id("host-more", "build")).bounds();
        assert_eq!(more.size, size(px(28.), px(28.)), "the row's overflow button");
        assert!(switch.right() <= more.left(), "switch {switch:?}, menu {more:?}");
        // One edge each side: the rows start on the headings' edge, and the
        // row's menu, the default Host's select and the window's Host picker
        // (labelled as this window's) end on the column's.
        let heading = window.find(domain_element_id("settings-group-title", "runtime-host"));
        let row = window.find(domain_element_id("host-row", "build")).bounds();
        assert_eq!(row.left(), heading.bounds().left());
        let select = window.find(domain_element_id("settings-select", "default-host")).bounds();
        let picker = window.find("settings-host-picker").bounds();
        assert_eq!(select.right(), more.right(), "select {select:?}, menu {more:?}");
        assert_eq!(picker.right(), more.right(), "picker {picker:?}, menu {more:?}");
        // A settings row's select at Desktop's control width; the header's
        // picker at its own 220.
        assert_eq!(select.size.width, px(260.), "{select:?}");
        assert_eq!(picker.size.width, px(220.), "{picker:?}");
        let label = window.find("settings-host-picker-label").bounds();
        assert!(label.right() <= picker.left());
    });
    // Its menu is Maka's: 32px rows, under the button.
    harness.click(domain_element_id("host-more", "build"), cx);
    harness.with_window(cx, |window, _| {
        let more = window.find(domain_element_id("host-more", "build")).bounds();
        let remove = window.find(domain_element_id("menu-item", "host:remove")).bounds();
        assert_eq!(remove.size.height, px(32.));
        assert!(remove.top() > more.bottom());
    });
    harness.click(domain_element_id("menu-item", "host:default"), cx);
    harness.settle(cx);
    let default = harness.directory.read_with(cx, |directory, _| {
        directory.list().expect("list").default_profile_id().to_owned()
    });
    assert_eq!(default, "build", "Set as default ran");
}
