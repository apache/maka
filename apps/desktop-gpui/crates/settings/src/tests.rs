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

//! UI integration tests: the settings surface in a headless window (its
//! navigation, General with the language and the default permission mode,
//! Appearance, Models with a connection's detail and the "Add connection"
//! form, Workspace, About), driven through its buttons, checkboxes,
//! dropdowns, and keys, against a scripted Host transport whose answers
//! follow the TS decoders
//! (`packages/runtime-host/src/protocol/connection-effects.ts`,
//! `runtime-policy.ts`).

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use std::rc::Rc;

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::component::input::InputState;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Context, ElementId, Entity, IntoElement, ParentElement as _, Pixels, Render,
    ScrollDelta, Styled as _, TestAppContext, Window, WindowHandle, div, point, px, size,
};
use host_client::{ConnectionEvent, HostEvent};
use host_protocol::HostAccepted;
use serde_json::{Value, json};
use shared::copy::settings as copy;
use shared::domain_element_id;
use workspace::{
    ConnectionCatalog, HostRequestError, HostRequester, HostSession, HostTransport,
    ProjectCatalogError, ProjectCatalogSource, ProjectEntry, ProjectSelection,
};

use crate::{AboutFacts, SettingsContext, SettingsEvent, SettingsSection, SettingsView};

pub(crate) type Reply = Result<Value, HostRequestError>;

/// Answers each operation from a queue of scripted replies, in order, and
/// records every request. A reply may be held until the test releases it.
#[derive(Default)]
pub(crate) struct ScriptedHost {
    replies: Mutex<HashMap<String, VecDeque<Scripted>>>,
    /// What an operation answers once its queue is empty.
    fallbacks: Mutex<HashMap<String, Reply>>,
    requests: Mutex<Vec<(String, Value)>>,
}

enum Scripted {
    Now(Reply),
    Held(async_channel::Receiver<Reply>),
}

impl ScriptedHost {
    pub(crate) fn reply(&self, operation: &str, reply: Reply) {
        self.push(operation, Scripted::Now(reply));
    }

    /// Answers `operation` with `reply` whenever nothing else is queued
    /// for it (a catalog every read finds, say).
    pub(crate) fn always(&self, operation: &str, reply: Reply) {
        self.fallbacks.lock().expect("fallbacks").insert(operation.to_owned(), reply);
    }

    pub(crate) fn hold(&self, operation: &str) -> async_channel::Sender<Reply> {
        let (sender, receiver) = async_channel::bounded(1);
        self.push(operation, Scripted::Held(receiver));
        sender
    }

    fn push(&self, operation: &str, scripted: Scripted) {
        let mut replies = self.replies.lock().expect("replies");
        replies.entry(operation.to_owned()).or_default().push_back(scripted);
    }

    pub(crate) fn requests(&self, operation: &str) -> Vec<Value> {
        let requests = self.requests.lock().expect("requests");
        requests.iter().filter(|(op, _)| op == operation).map(|(_, input)| input.clone()).collect()
    }
}

impl HostTransport for ScriptedHost {
    fn request(&self, operation: &'static str, input: Value, _: Duration) -> Boxed<Reply> {
        self.requests.lock().expect("requests").push((operation.to_owned(), input));
        let scripted =
            self.replies.lock().expect("replies").get_mut(operation).and_then(VecDeque::pop_front);
        let scripted = scripted.or_else(|| {
            let fallbacks = self.fallbacks.lock().expect("fallbacks");
            fallbacks.get(operation).cloned().map(Scripted::Now)
        });
        match scripted {
            Some(Scripted::Now(reply)) => Box::pin(async move { reply }),
            Some(Scripted::Held(receiver)) => Box::pin(async move {
                receiver.recv().await.unwrap_or(Err(HostRequestError::NotConnected))
            }),
            None => Box::pin(async move {
                Err(HostRequestError::Transport(format!("unscripted {operation}").into()))
            }),
        }
    }
}

pub(crate) fn accepted() -> HostAccepted {
    serde_json::from_value(json!({
        "kind": "accepted", "rootId": "r", "hostEpoch": "e", "connectionId": "c",
        "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
        "compositionRevision": "3", "state": "ready"
    }))
    .expect("accepted")
}

/// One page of `connection.catalog.query` at `revision` with no connections.
pub(crate) fn catalog_page(revision: u64) -> Value {
    json!({"kind": "page", "revision": revision, "defaultTarget": null, "connectionCount": 0,
           "items": [], "nextCursor": null})
}

/// A window whose root view is the settings surface on its own (the
/// navigation beside the page), as the shell draws its two halves.
struct Shell(Entity<SettingsView>);

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.0.clone())
    }
}

/// A fresh State Root's runtime policy (the Host's defaults, as
/// `runtime_policy_query.response.json` records them) with the chat default
/// `mode` and Code Mode on.
pub(crate) fn policy_json(mode: &str) -> Value {
    let mut policy: Value = serde_json::from_str(include_str!(
        "../../host-protocol/fixtures/runtime_policy_query.response.json"
    ))
    .expect("fixture");
    let mut policy = policy["result"]["policy"].take();
    policy["chatDefaults"] = json!({"permissionMode": mode, "codeModeEnabled": true});
    policy
}

/// `runtime.policy.query` at `revision` with the chat default `mode`.
pub(crate) fn policy(revision: u64, mode: &str) -> Value {
    json!({"revision": revision, "policy": policy_json(mode)})
}

/// The Host's project list, which a test changes as the Host would after a
/// `project.catalog.mutate`.
#[derive(Clone, Default)]
struct SharedProjects(Arc<Mutex<Vec<ProjectEntry>>>);

impl ProjectCatalogSource for SharedProjects {
    fn list(&self, _: &HostRequester) -> Boxed<Result<Vec<ProjectEntry>, ProjectCatalogError>> {
        let projects = self.0.lock().expect("projects").clone();
        Box::pin(async move { Ok(projects) })
    }
}

pub(crate) struct Harness {
    pub(crate) transport: Arc<ScriptedHost>,
    pub(crate) host: Entity<HostSession>,
    pub(crate) view: Entity<SettingsView>,
    pub(crate) window: WindowHandle<Root>,
    /// What the surface asked of its shell, in order.
    pub(crate) events: Rc<RefCell<Vec<SettingsEvent>>>,
}

impl Harness {
    /// Opens settings on `section`, connected, with the catalog read once
    /// from `catalog` and the policy from [`policy`].
    pub(crate) fn open_on(
        section: SettingsSection,
        catalog: Value,
        cx: &mut TestAppContext,
    ) -> Self {
        Self::open_with_projects(section, catalog, SharedProjects::default(), cx)
    }

    /// Opens settings on `section`, connected, with `projects` as the
    /// Host's project list, and the section list focused.
    fn open_with_projects(
        section: SettingsSection,
        catalog: Value,
        projects: SharedProjects,
        cx: &mut TestAppContext,
    ) -> Self {
        let transport = Arc::new(ScriptedHost::default());
        transport.reply("runtime.policy.query", Ok(policy(3, "bypass")));
        transport.reply("connection.catalog.query", Ok(catalog));
        Self::open_with(section, transport, projects, cx)
    }

    /// Opens settings on `section` over `transport`, which answers the
    /// first policy read, with no connections.
    pub(crate) fn open_with_transport(
        section: SettingsSection,
        transport: Arc<ScriptedHost>,
        cx: &mut TestAppContext,
    ) -> Self {
        transport.reply("connection.catalog.query", Ok(catalog_page(6)));
        Self::open_with(section, transport, SharedProjects::default(), cx)
    }

    fn open_with(
        section: SettingsSection,
        transport: Arc<ScriptedHost>,
        projects: SharedProjects,
        cx: &mut TestAppContext,
    ) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            // Popovers slide in on the wall clock; with motion reduced they
            // settle on their first frame.
            cx.set_reduce_motion(true);
        });
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone())
        });
        host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
                cx,
            )
        });
        let connections = cx.new(|cx| ConnectionCatalog::new(host.clone(), cx));
        let projects = cx.new(|cx| ProjectSelection::new(host.clone(), Rc::new(projects), cx));
        cx.run_until_parked();
        let context =
            SettingsContext::new(host.clone(), connections, projects, AboutFacts::new("9.9.9"));
        let mut view = None;
        let window = cx.open_window(size(px(1512.), px(885.)), |window, cx| {
            let settings = cx.new(|cx| SettingsView::new(context, section, window, cx));
            view = Some(settings.clone());
            Root::new(cx.new(|_| Shell(settings)), window, cx)
        });
        let view = view.expect("the surface");
        let events = Rc::new(RefCell::new(Vec::new()));
        let recorded = events.clone();
        cx.update(|cx| {
            cx.subscribe(&view, move |_, event: &SettingsEvent, _| {
                recorded.borrow_mut().push(*event);
            })
            .detach();
        });
        cx.run_until_parked();
        let harness = Self { transport, host, view, window, events };
        let surface = harness.view.clone();
        harness.with_window(cx, |window, cx| {
            surface.update(cx, |view, cx| view.focus_nav(window, cx));
        });
        harness
    }

    pub(crate) fn with_window<R>(
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

    /// Clicks `id`, first scrolling the page until it shows when it is
    /// below the fold, as a person would.
    pub(crate) fn click(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) {
        let id = id.into();
        self.with_window(cx, |window, cx| {
            if window.try_find("settings-body").is_some() {
                reveal(window, &id, cx);
            }
            window.click(id, cx)
        });
    }

    /// Whether the surface asked to go back to the app.
    pub(crate) fn went_back(&self) -> bool {
        self.events.borrow().contains(&SettingsEvent::BackToApp)
    }

    fn section(&self, cx: &mut TestAppContext) -> SettingsSection {
        self.view.read_with(cx, |view, _| view.section())
    }
}

/// Presses ⌘F from the section list, then from the page's title (where
/// Enter on the list puts focus), and asserts that `field` takes focus
/// each time.
pub(crate) fn command_f_focuses(
    harness: &Harness,
    field: &Entity<InputState>,
    cx: &mut TestAppContext,
) {
    use gpui_kit::Focusable as _;
    let surface = harness.view.clone();
    let focused = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, cx| field.read(cx).focus_handle(cx).is_focused(window))
    };
    harness.with_window(cx, |window, cx| {
        surface.update(cx, |view, cx| view.focus_nav(window, cx));
        window.press("secondary-f", cx);
    });
    assert!(focused(cx), "⌘F from the section list");
    harness.with_window(cx, |window, cx| {
        surface.update(cx, |view, cx| view.focus_nav(window, cx));
        window.press("enter", cx);
    });
    assert!(!focused(cx), "the page's title has focus");
    harness.with_window(cx, |window, cx| window.press("secondary-f", cx));
    assert!(focused(cx), "⌘F from the page");
}

pub(crate) const OLLAMA: &str = "http://127.0.0.1:11434/v1";

/// A `connection` header item. `custom:<protocol>` is a `custom` connection
/// with that `defaultApiProtocol`.
pub(crate) fn header(
    index: u64,
    id: &str,
    slug: &str,
    name: &str,
    provider: &str,
    enabled: bool,
) -> Value {
    let mut header = json!({"kind": "connection", "connectionIndex": index, "connectionId": id,
           "revision": 4, "slug": slug, "name": name, "providerType": provider,
           "enabled": enabled, "enabledModelIdCount": 1, "modelCount": 2, "catalogEntryCount": 1});
    if let Some(protocol) = provider.strip_prefix("custom:") {
        header["providerType"] = json!("custom");
        header["defaultApiProtocol"] = json!(protocol);
    }
    header
}

/// Three connections: Ollama (default, enabled, two stored models, one
/// enabled), DeepSeek (enabled), and an old relay (disabled).
pub(crate) fn three_connections(revision: u64) -> Value {
    let mut ollama =
        header(0, "c-ollama", "ollama-local", "Ollama (local)", "custom:openai-chat", true);
    ollama["baseUrl"] = json!(OLLAMA);
    json!({"kind": "page", "revision": revision,
           "defaultTarget": {"connectionId": "c-ollama", "modelId": "qwen2.5:7b"},
           "connectionCount": 3, "nextCursor": null, "items": [
        ollama,
        {"kind": "enabled_model_id", "connectionIndex": 0, "itemIndex": 0, "modelId": "qwen2.5:7b"},
        {"kind": "model", "connectionIndex": 0, "itemIndex": 0, "model": {"id": "qwen2.5:7b"}},
        {"kind": "model", "connectionIndex": 0, "itemIndex": 1, "model": {"id": "phi4:latest"}},
        header(1, "c-deepseek", "env-deepseek", "DeepSeek (env)", "deepseek", true),
        {"kind": "enabled_model_id", "connectionIndex": 1, "itemIndex": 0,
         "modelId": "deepseek-v4-flash"},
        header(2, "c-old", "old-relay", "Old relay", "custom:anthropic-messages", false),
        {"kind": "enabled_model_id", "connectionIndex": 2, "itemIndex": 0, "modelId": "m"}
    ]})
}

pub(crate) fn nav(section: &str) -> ElementId {
    shared::domain_element_id("settings-nav", section)
}

pub(crate) fn row(id: &str) -> ElementId {
    shared::domain_element_id("connection-row", id)
}

/// The navigation's lines, top to bottom: group labels by their key,
/// sections by theirs.
fn nav_lines(window: &mut Window) -> Vec<String> {
    let mut lines: Vec<(Pixels, String)> = Vec::new();
    for group in crate::NavGroup::ALL {
        if let Some(label) = window.try_find(domain_element_id("settings-nav-group", group.key())) {
            lines.push((label.bounds().top(), format!("[{}]", group.key())));
        }
    }
    for section in SettingsSection::ALL {
        if let Some(row) = window.try_find(nav(section.key())) {
            lines.push((row.bounds().top(), section.key().to_owned()));
        }
    }
    lines.sort_by(|a, b| a.0.partial_cmp(&b.0).expect("ordered"));
    lines.into_iter().map(|(_, line)| line).collect()
}

#[gpui_kit::test]
fn the_navigation_lists_desktops_groups_with_the_built_sections(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    harness.with_window(cx, |window, _| {
        // Each group that has a built section, by its label, then its built
        // sections, in Desktop's order.
        let mut expected = Vec::new();
        for group in crate::NavGroup::ALL {
            let sections: Vec<_> =
                SettingsSection::listed().filter(|s| s.group() == group).collect();
            if !sections.is_empty() {
                expected.push(format!("[{}]", group.key()));
                expected.extend(sections.iter().map(|section| section.key().to_owned()));
            }
        }
        assert_eq!(nav_lines(window), expected, "a group with nothing built is left out");
        assert_eq!(expected[..4], ["[preferences]", "general", "appearance", "projects"]);
        assert_eq!(expected.last().map(String::as_str), Some("about"));
        let group = window.find(domain_element_id("settings-nav-group", "preferences"));
        assert_eq!(group.label(), Some(copy::GROUP_PREFERENCES.en()));
        assert_eq!(group.bounds().size.height, px(28.), "the sidebar's group label line");
        let row = window.find(nav("general"));
        assert_eq!(row.bounds().size.height, px(32.), "the sidebar's row geometry");
        assert_eq!(row.selected(), Some(true));
        assert_eq!(window.find(nav("about")).selected(), Some(false));
        assert_eq!(window.find(nav("projects")).label(), Some(copy::SECTION_WORKSPACE.en()));
        assert_eq!(window.find("settings-nav").role(), Some(gpui_kit::Role::List));
        assert_eq!(window.find("settings-nav").label(), Some(copy::SETTINGS_NAVIGATION.en()));
        // "Back to app" leads the column, the search under it, then the list.
        let back = window.find("settings-back").bounds();
        let search = window.find("settings-search").bounds();
        assert!(back.bottom() <= search.top() && search.bottom() <= row.bounds().top());
        assert_eq!(window.find("settings-back").label(), Some(copy::BACK_TO_APP.en()));
        // The page: its title and Desktop's line under it, in one readable
        // column.
        assert_eq!(window.find("settings-title").label(), Some(copy::SECTION_GENERAL.en()));
        assert_eq!(
            window.find("settings-description").label(),
            Some(copy::SECTION_GENERAL_HELP.en())
        );
        let column = window.find(domain_element_id("settings-section", "general")).bounds();
        assert!(column.size.width <= px(920.), "{column:?}");
        let title = window.find("settings-title").bounds();
        assert_eq!(title.size.height, px(32.), "the display rung: 22 on 32");
    });
}

#[gpui_kit::test]
fn the_section_list_switches_sections_by_click_and_keys_and_filters(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("settings-nav").focused(), Some(true), "the list has focus");
        window.click(nav("about"), cx);
    });
    assert_eq!(harness.section(cx), SettingsSection::About);
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("settings-title").label(), Some(copy::SECTION_ABOUT.en()));
        let value = |key: &str| domain_element_id("settings-value", key);
        assert_eq!(window.find(value("version")).label(), Some("9.9.9"));
        assert_eq!(window.find(value("state-root")).label(), Some("/tmp/.dev-root"));
        // The source and release-notes links sit on the 12/20 line.
        for link in ["about-source", "about-release-notes"] {
            assert_eq!(window.find(link).bounds().size.height, px(20.), "{link}");
        }
        assert_eq!(window.find("settings-nav").focused(), Some(true), "a click keeps list focus");
        window.press("up", cx);
    });
    let listed: Vec<_> = SettingsSection::listed().collect();
    assert_eq!(harness.section(cx), listed[listed.len() - 2], "the one above About");
    harness.with_window(cx, |window, cx| window.press("home", cx));
    assert_eq!(harness.section(cx), SettingsSection::General);
    harness.with_window(cx, |window, cx| window.press("down", cx));
    assert_eq!(harness.section(cx), SettingsSection::Appearance);
    harness.with_window(cx, |window, cx| window.press("end", cx));
    assert_eq!(harness.section(cx), SettingsSection::About);

    // The search narrows the list by label, and each group keeps its label
    // only while one of its sections shows.
    harness.with_window(cx, |window, cx| {
        window.click("settings-search", cx);
        window.input("conn", cx);
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(nav_lines(window), ["[capabilities]", "models"]);
    });
    // It finds a section by the settings it holds, too.
    for (query, found) in
        [("appearance", "appearance"), ("api key", "models"), ("permission", "general")]
    {
        harness.with_window(cx, |window, cx| {
            window.click("settings-search", cx);
            window.press("cmd-a", cx);
            window.input(query, cx);
        });
        harness.with_window(cx, |window, _| {
            let lines = nav_lines(window);
            let sections: Vec<_> = lines.iter().filter(|line| !line.starts_with('[')).collect();
            assert_eq!(sections, [found], "{query} finds only {found}");
        });
    }
    harness.with_window(cx, |window, cx| {
        window.click("settings-search", cx);
        window.press("cmd-a", cx);
        window.input("zzz", cx);
    });
    harness.with_window(cx, |window, _| {
        assert!(nav_lines(window).is_empty());
        assert_eq!(window.find("settings-title").label(), Some(copy::SECTION_ABOUT.en()));
    });
}

/// Tab walks "Back to app", the search, the list (one stop), and the page,
/// its title first; Enter on the list moves focus to the page's title.
#[gpui_kit::test]
fn tab_walks_back_search_list_and_page_and_enter_opens_the_page(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::Projects, catalog_page(6), cx);
    harness.with_window(cx, |window, cx| {
        window.press("shift-tab", cx);
        assert_eq!(window.find("settings-search").focused(), Some(true), "list → search");
        window.press("shift-tab", cx);
        assert_eq!(window.find("settings-back").focused(), Some(true), "search → back");
        window.press("tab", cx);
        window.press("tab", cx);
        assert_eq!(window.find("settings-nav").focused(), Some(true), "back → search → list");
        window.press("tab", cx);
        assert_eq!(window.find("settings-title").focused(), Some(true), "list → page");
        window.press("tab", cx);
        assert_eq!(
            window.find("settings-add-project").focused(),
            Some(true),
            "then the page's controls"
        );
        window.click(nav("about"), cx);
        window.press("enter", cx);
        assert_eq!(window.find("settings-title").focused(), Some(true), "Enter opens the page");
        assert_eq!(window.find("settings-title").label(), Some(copy::SECTION_ABOUT.en()));
    });
    assert!(!harness.went_back(), "Enter on the list does not leave");
    harness.with_window(cx, |window, cx| window.click("settings-back", cx));
    assert_eq!(*harness.events.borrow(), [SettingsEvent::BackToApp]);
}

#[gpui_kit::test]
fn the_connection_list_filters_by_state_and_search(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::Models, three_connections(8), cx);
    let listed = |cx: &mut TestAppContext| {
        harness.view.read_with(cx, |view, cx| {
            view.connections()
                .read(cx)
                .listed(cx)
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
    };
    assert_eq!(listed(cx), ["c-ollama", "c-deepseek", "c-old"]);
    harness.with_window(cx, |window, _| {
        let ollama = window.find(row("c-ollama"));
        assert_eq!(
            ollama.label(),
            Some(
                "Model connection: Ollama (local); provider: Custom connection; default \
                 connection"
            )
        );
        assert_eq!(
            window.find(row("c-old")).label(),
            Some("Model connection: Old relay; provider: Custom connection; Unavailable")
        );
        // Maka's control sizes: 32px buttons, a 28px segmented track.
        assert_eq!(window.find("settings-add-connection").bounds().size.height, px(32.));
        assert_eq!(window.find("connections-filter").bounds().size.height, px(28.));
    });
    harness.click(shared::domain_element_id("connections-filter", "enabled"), cx);
    assert_eq!(listed(cx), ["c-ollama", "c-deepseek"]);
    harness.click(shared::domain_element_id("connections-filter", "disabled"), cx);
    assert_eq!(listed(cx), ["c-old"]);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(row("c-ollama")).is_none());
        assert!(window.find(row("c-old")).visible());
    });
    harness.click(shared::domain_element_id("connections-filter", "all"), cx);
    harness.with_window(cx, |window, cx| {
        window.click("connections-search", cx);
        window.input("DEEP", cx);
    });
    assert_eq!(listed(cx), ["c-deepseek"], "the search ignores case and matches the provider");
    harness.with_window(cx, |window, cx| window.input("xyz", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.find("connections-note").visible(), "says nothing matches");
    });
}

pub(crate) fn select(key: &str) -> ElementId {
    domain_element_id("settings-select", key)
}

/// Scrolls the page until `id` shows near the top of the page's viewport,
/// as a person scrolls to a setting below the fold.
pub(crate) fn reveal(window: &mut Window, id: &ElementId, cx: &mut gpui_kit::App) {
    let Some(target) = window.try_find(id.clone()) else {
        return;
    };
    let body = window.find("settings-body").bounds();
    let bounds = target.bounds();
    if target.visible() && bounds.top() >= body.top() && bounds.bottom() <= body.bottom() {
        return;
    }
    let offset = bounds.top() - body.top() - px(64.);
    window.scroll("settings-body", ScrollDelta::Pixels(point(px(0.), -offset)), cx);
    window.render_frame(cx);
}

impl Harness {
    /// Opens the dropdown `key` (its cursor on the current choice), presses
    /// `keys`, and chooses the row the cursor is on.
    pub(crate) fn choose(&self, key: &str, keys: &[&str], cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| {
            reveal(window, &select(key), cx);
            window.click(select(key), cx)
        });
        self.with_window(cx, |window, cx| {
            for key in keys {
                window.press(key, cx);
            }
            window.press("enter", cx);
        });
    }

    /// What the dropdown `key` shows as chosen.
    pub(crate) fn chosen(&self, key: &str, cx: &mut TestAppContext) -> Option<String> {
        self.with_window(cx, |window, _| window.find(select(key)).value().map(str::to_owned))
    }
}

#[gpui_kit::test]
fn the_default_permission_mode_is_read_and_written_through_the_host(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    let mode = |cx: &mut TestAppContext| {
        harness.view.read_with(cx, |view, cx| {
            view.general().read(cx).default_mode(cx).map(|mode| mode.as_str().to_owned())
        })
    };
    assert_eq!(mode(cx).as_deref(), Some("bypass"));
    harness.with_window(cx, |window, _| {
        let row = window.find(domain_element_id("settings-row", "default-permission"));
        assert_eq!(row.label(), Some(copy::DEFAULT_PERMISSION.en()));
        let heading = domain_element_id("settings-group-title", "task-defaults");
        assert_eq!(window.find(heading).label(), Some(copy::TASK_DEFAULTS.en()));
    });
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Full access"));

    // A conflict reads the policy again and retries once, keeping the other
    // defaults as read.
    harness.transport.reply(
        "runtime.policy.mutate",
        Ok(json!({"kind": "revision_conflict", "expectedRevision": 3, "actualRevision": 4})),
    );
    harness.transport.reply("runtime.policy.query", Ok(policy(4, "bypass")));
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 5})));
    // Auto is the first choice, Full access the second.
    harness.choose("default-permission", &["up"], cx);
    let set = |revision: u64, mode: &str| {
        json!({"expectedRevision": revision, "operation": {"kind": "set_chat_defaults",
               "value": {"permissionMode": mode, "codeModeEnabled": true}}})
    };
    assert_eq!(harness.transport.requests("runtime.policy.mutate"), [set(3, "ask"), set(4, "ask")]);
    assert_eq!(mode(cx).as_deref(), Some("ask"));
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Auto"));
    let revision = harness.view.read_with(cx, |view, cx| {
        view.policy().read(cx).snapshot().map(|snapshot| snapshot.revision)
    });
    assert_eq!(revision, Some(5), "the committed revision is the next basis");

    // A refusal keeps the mode, puts the dropdown back, and says why. Full
    // access asks first; nothing is sent until the question is answered.
    harness
        .transport
        .reply("runtime.policy.mutate", Err(HostRequestError::Transport("closed".into())));
    harness.choose("default-permission", &["down"], cx);
    assert_eq!(harness.transport.requests("runtime.policy.mutate").len(), 2);
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    assert_eq!(harness.transport.requests("runtime.policy.mutate").len(), 3);
    assert_eq!(mode(cx).as_deref(), Some("ask"));
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Auto"));
    harness.with_window(cx, |window, _| {
        let error = window.find(domain_element_id("settings-status", "default-permission"));
        assert!(
            error.label().is_some_and(|label| label.starts_with(copy::PERMISSION_SAVE_FAILED.en())),
            "{:?}",
            error.label()
        );
    });
    // Choosing what is already the default sends nothing.
    harness.choose("default-permission", &[], cx);
    assert_eq!(harness.transport.requests("runtime.policy.mutate").len(), 3);
    // While the Host answers, the dropdown keeps the choice made.
    let answer = harness.transport.hold("runtime.policy.mutate");
    harness.choose("default-permission", &["down"], cx);
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Full access"));
    assert!(harness.view.read_with(cx, |view, cx| view.is_busy(cx)), "Back to app waits");
    answer.try_send(Ok(json!({"kind": "committed", "revision": 6}))).expect("answer");
    cx.run_until_parked();
    assert_eq!(mode(cx).as_deref(), Some("bypass"));
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Full access"));
}

/// `--open-settings general:full-access` reaches the page before the
/// policy is read: it waits for it, then asks the Full access question.
#[gpui_kit::test]
fn the_full_access_target_waits_for_the_policy_then_asks(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let answer = transport.hold("runtime.policy.query");
    let harness = Harness::open_with_transport(SettingsSection::General, transport, cx);
    let view = harness.view.clone();
    let asking = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, cx| {
            gpui_kit::component::WindowExt::has_active_dialog(window, cx)
        })
    };
    let opened = harness.with_window(cx, |window, cx| {
        view.update(cx, |view, cx| view.open_target("full-access", window, cx))
    });
    assert!(opened, "the target is taken, to open once the policy is read");
    assert!(!asking(cx), "nothing read yet");
    answer.try_send(Ok(policy(3, "ask"))).expect("answer");
    cx.run_until_parked();
    assert!(asking(cx), "the Full access question");
    // Desktop's AlertDialog: 16 between the text and the answers.
    harness.with_window(cx, |window, _| {
        let text = window.find("confirmation-text").bounds();
        let ok = window.find("ok").bounds();
        assert_eq!(ok.top() - text.bottom(), px(16.));
    });
}

/// `--open-settings general:end` reaches the page before its rows: it
/// waits for the policy, then scrolls to the end of the whole page.
#[gpui_kit::test]
fn the_end_target_waits_for_the_policy_then_scrolls_to_the_real_end(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let answer = transport.hold("runtime.policy.query");
    let harness = Harness::open_with_transport(SettingsSection::General, transport, cx);
    let view = harness.view.clone();
    let opened = harness.with_window(cx, |window, cx| {
        view.update(cx, |view, cx| view.open_target("end", window, cx))
    });
    assert!(opened);
    // A frame draws the page as it is before the policy comes.
    harness.with_window(cx, |_, _| {});
    answer.try_send(Ok(policy(3, "ask"))).expect("answer");
    cx.run_until_parked();
    harness.with_window(cx, |window, _| {
        let body = window.find("settings-body").bounds();
        let network = window.find(domain_element_id("settings-group", "network")).bounds();
        assert!(network.top() > body.top(), "{network:?} in {body:?}");
        assert!(network.bottom() <= body.bottom(), "the last group shows: {network:?} in {body:?}");
    });
}

/// Before the policy is read the row holds a placeholder; a failed read
/// says so with Retry; offline it says what is needed.
#[gpui_kit::test]
fn the_default_permission_row_says_why_it_cannot_change(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    let status = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, _| {
            window
                .try_find(domain_element_id("settings-status", "default-permission"))
                .and_then(|status| status.label().map(str::to_owned))
        })
    };
    let answer = harness.transport.hold("runtime.policy.query");
    // A new connection reads the policy again; the snapshot stays meanwhile.
    harness.host.update(cx, |host, cx| {
        host.handle_host_event(
            HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
            cx,
        )
    });
    cx.run_until_parked();
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Full access"));
    answer.try_send(Ok(policy(6, "ask"))).expect("answer");
    cx.run_until_parked();
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Auto"));
    assert_eq!(status(cx), None);

    // A surface opened while the read is failing says so at the top of the
    // page, shows none of the Host's rows, and Retry reads again.
    let failing = Harness::open_failing_policy(cx);
    let failed = failing.with_window(cx, |window, _| {
        assert!(window.try_find(select("default-permission")).is_none());
        assert!(window.try_find(row_id("incognito")).is_none());
        assert!(window.find(row_id("notifications")).visible(), "the client's own rows stay");
        window.find(domain_element_id("settings-status", "general")).label().map(str::to_owned)
    });
    assert!(
        failed.as_deref().is_some_and(|label| label.starts_with(copy::GENERAL_LOAD_FAILED.en())),
        "{failed:?}"
    );
    failing.transport.reply("runtime.policy.query", Ok(policy(3, "bypass")));
    failing.click("general-retry", cx);
    assert_eq!(failing.chosen("default-permission", cx).as_deref(), Some("Full access"));
}

impl Harness {
    /// Opens General while the Host cannot read its policy.
    fn open_failing_policy(cx: &mut TestAppContext) -> Self {
        let transport = Arc::new(ScriptedHost::default());
        transport.reply("connection.catalog.query", Ok(catalog_page(6)));
        transport.reply("runtime.policy.query", Err(HostRequestError::Transport("closed".into())));
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone())
        });
        host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
                cx,
            )
        });
        let connections = cx.new(|cx| ConnectionCatalog::new(host.clone(), cx));
        let projects = cx
            .new(|cx| ProjectSelection::new(host.clone(), Rc::new(SharedProjects::default()), cx));
        cx.run_until_parked();
        let context =
            SettingsContext::new(host.clone(), connections, projects, AboutFacts::new("9.9.9"));
        let mut view = None;
        let window = cx.open_window(size(px(1512.), px(885.)), |window, cx| {
            let settings =
                cx.new(|cx| SettingsView::new(context, SettingsSection::General, window, cx));
            view = Some(settings.clone());
            Root::new(cx.new(|_| Shell(settings)), window, cx)
        });
        cx.run_until_parked();
        let view = view.expect("the surface");
        Self { transport, host, view, window, events: Rc::default() }
    }
}

#[gpui_kit::test]
fn the_interface_language_follows_the_choice_and_the_system(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    // A fresh install follows the system, as Desktop's does.
    let tw = shared::copy::Locale::TraditionalChinese;
    cx.update(|cx| {
        crate::AppPreferences::global(cx).update(cx, |preferences, cx| {
            preferences.set_system_languages(vec!["zh-Hant-TW".into()], cx)
        })
    });
    assert_eq!(cx.update(|cx| shared::copy::Locale::current(cx)), tw);
    assert_eq!(
        harness.chosen("language", cx).as_deref(),
        Some(copy::LANGUAGE_SYSTEM.in_locale(tw))
    );
    cx.update(|cx| crate::choose_language(crate::Language::English, cx));
    let heading = domain_element_id("settings-group-title", "identity");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(heading.clone()).label(), Some(copy::IDENTITY.en()));
    });
    assert_eq!(harness.chosen("language", cx).as_deref(), Some("English"));
    // Follow system, English, 简体中文, 繁體中文.
    harness.choose("language", &["down"], cx);
    assert_eq!(
        cx.update(|cx| crate::AppPreferences::current(cx)).language,
        crate::Language::SimplifiedChinese
    );
    // The surface redraws in the new language at once.
    let zh = shared::copy::Locale::SimplifiedChinese;
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("settings-title").label(),
            Some(copy::SECTION_GENERAL.in_locale(zh))
        );
        assert_eq!(window.find(nav("about")).label(), Some(copy::SECTION_ABOUT.in_locale(zh)));
        assert_eq!(window.find(heading.clone()).label(), Some(copy::IDENTITY.in_locale(zh)));
    });
    // Follow system speaks the system's language, and says so in it.
    harness.choose("language", &["up", "up"], cx);
    assert_eq!(
        cx.update(|cx| crate::AppPreferences::current(cx)).language,
        crate::Language::System
    );
    let tw = shared::copy::Locale::TraditionalChinese;
    assert_eq!(cx.update(|cx| shared::copy::Locale::current(cx)), tw);
    assert_eq!(
        harness.chosen("language", cx).as_deref(),
        Some(copy::LANGUAGE_SYSTEM.in_locale(tw))
    );
    // A choice made elsewhere (the footer menu) shows here too.
    cx.update(|cx| crate::choose_language(crate::Language::English, cx));
    assert_eq!(harness.chosen("language", cx).as_deref(), Some("English"));
}

#[gpui_kit::test]
fn appearance_offers_desktops_three_themes(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::Appearance, catalog_page(6), cx);
    let card = |key: &str| domain_element_id("settings-theme", key);
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("settings-title").label(), Some(copy::SECTION_APPEARANCE.en()));
        let heading = domain_element_id("settings-group-title", "theme");
        assert_eq!(window.find(heading).label(), Some(copy::THEME.en()));
        // Light, Dark, Follow system, side by side.
        let light = window.find(card("light")).bounds();
        let dark = window.find(card("dark")).bounds();
        let system = window.find(card("system")).bounds();
        assert!(light.right() <= dark.left() && dark.right() <= system.left());
        assert_eq!(window.find(card("system")).label(), Some(copy::APPEARANCE_SYSTEM.en()));
        window.click(card("dark"), cx);
    });
    assert!(cx.update(|cx| crate::theme_mode(cx).is_dark()), "applied at once");
    assert_eq!(
        cx.update(|cx| crate::AppPreferences::current(cx)).appearance,
        crate::Appearance::Dark
    );
    harness.with_window(cx, |window, cx| {
        window.click(nav("appearance"), cx);
        window.press("enter", cx);
        window.press("tab", cx);
        assert_eq!(window.find(card("light")).focused(), Some(true), "the cards are Tab stops");
        // A button acts on the key's release.
        window.press("space", cx);
        let keystroke = gpui_kit::Keystroke::parse("space").expect("keystroke");
        window
            .dispatch_event(gpui_kit::PlatformInput::KeyUp(gpui_kit::KeyUpEvent { keystroke }), cx);
    });
    assert!(!cx.update(|cx| crate::theme_mode(cx).is_dark()));
}

/// The answer to a `project.catalog.mutate` for `project`.
fn project_result(project: &ProjectEntry) -> Value {
    json!({"kind": "project", "project": {
        "id": project.id, "aliases": [], "name": project.name, "locationCount": 1,
        "archivedAt": if project.archived { json!(5) } else { json!(null) },
        "available": project.available
    }})
}

/// Maka at /p/maka, and Gone, archived, whose folder is missing.
fn two_projects() -> SharedProjects {
    let projects = SharedProjects::default();
    *projects.0.lock().expect("projects") = vec![
        ProjectEntry::new("p1", "Maka", "/p/maka"),
        ProjectEntry::new("p2", "Gone", "/p/gone").with_archived(true).with_available(false),
    ];
    projects
}

#[gpui_kit::test]
fn projects_list_every_project_and_rename_in_place(cx: &mut TestAppContext) {
    let projects = two_projects();
    let harness = Harness::open_with_projects(
        SettingsSection::Projects,
        catalog_page(6),
        projects.clone(),
        cx,
    );
    let row = |id: &str| domain_element_id("project-row", id);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("settings-title").label(), Some(copy::SECTION_WORKSPACE.en()));
        let group = window.within(domain_element_id("settings-group", "projects"));
        assert!(group.find("settings-add-project").visible(), "the group's action");
        assert_eq!(window.find(row("p1")).label(), Some("Maka, /p/maka"));
        assert_eq!(window.find(row("p2")).label(), Some("Gone, /p/gone, Archived, Folder missing"));
        // Relink is offered only where the folder is missing.
        assert!(window.try_find(domain_element_id("project-relink", "p1")).is_none());
        assert!(window.find(domain_element_id("project-relink", "p2")).visible());
    });

    // Escape leaves the field and stays in settings.
    harness.click(domain_element_id("project-rename", "p1"), cx);
    harness.with_window(cx, |window, cx| {
        assert!(window.find(domain_element_id("project-rename-field", "p1")).visible());
        window.input("Nope", cx);
        window.press("escape", cx);
    });
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(domain_element_id("project-rename-field", "p1")).is_none());
    });
    assert!(!harness.went_back(), "Escape closed only the field");
    assert!(harness.transport.requests("project.catalog.mutate").is_empty());

    // Enter commits; the list shows the Host's answer.
    let renamed = ProjectEntry::new("p1", "Maka app", "/p/maka");
    harness.transport.reply("project.catalog.mutate", Ok(project_result(&renamed)));
    harness.click(domain_element_id("project-rename", "p1"), cx);
    projects.0.lock().expect("projects")[0] = renamed;
    harness.with_window(cx, |window, cx| {
        window.input("Maka app", cx);
        window.press("enter", cx);
    });
    assert_eq!(
        harness.transport.requests("project.catalog.mutate"),
        [json!({"kind": "rename", "projectId": "p1", "name": "Maka app"})]
    );
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(row("p1")).label(), Some("Maka app, /p/maka"));
    });
    assert!(!harness.went_back(), "Enter in the field stays in settings");
}

#[gpui_kit::test]
fn projects_archive_restore_and_relink_through_the_host(cx: &mut TestAppContext) {
    let projects = two_projects();
    let harness = Harness::open_with_projects(
        SettingsSection::Projects,
        catalog_page(6),
        projects.clone(),
        cx,
    );
    let archived = ProjectEntry::new("p1", "Maka", "/p/maka").with_archived(true);
    harness.transport.reply("project.catalog.mutate", Ok(project_result(&archived)));
    harness.click(domain_element_id("project-archive", "p1"), cx);
    let restored = ProjectEntry::new("p2", "Gone", "/p/gone").with_available(false);
    harness.transport.reply("project.catalog.mutate", Ok(project_result(&restored)));
    harness.click(domain_element_id("project-archive", "p2"), cx);
    let relinked = ProjectEntry::new("p2", "Gone", "/p/found");
    harness.transport.reply("project.catalog.mutate", Ok(project_result(&relinked)));
    harness.click(domain_element_id("project-relink", "p2"), cx);
    assert!(cx.did_prompt_for_paths(), "Relink… asks for the folder");
    cx.simulate_path_prompt_response(|options| {
        assert!(options.directories && !options.files);
        Some(vec![PathBuf::from("/p/found")])
    });
    cx.run_until_parked();
    assert_eq!(
        harness.transport.requests("project.catalog.mutate"),
        [
            json!({"kind": "archive", "projectId": "p1"}),
            json!({"kind": "restore", "projectId": "p2"}),
            json!({"kind": "relink", "projectId": "p2", "path": "/p/found"}),
        ]
    );
}

fn row_id(key: &str) -> ElementId {
    domain_element_id("settings-row", key)
}

fn toggle(key: &str) -> ElementId {
    domain_element_id("settings-toggle", key)
}

fn status(key: &str) -> ElementId {
    domain_element_id("settings-status", key)
}

/// A Host error with `code`, as the transport reports it.
fn host_error(code: &str) -> HostRequestError {
    HostRequestError::Operation {
        operation: "runtime.policy.mutate",
        code: host_protocol::HostOperationErrorCode::from_wire(code),
        message: "refused".into(),
    }
}

impl Harness {
    /// Whether the switch `key` shows on.
    fn checked(&self, key: &str, cx: &mut TestAppContext) -> Option<bool> {
        self.with_window(cx, |window, _| window.find(toggle(key)).checked())
    }

    /// The status line under the row `key`.
    fn status(&self, key: &str, cx: &mut TestAppContext) -> Option<String> {
        self.with_window(cx, |window, _| {
            window.try_find(status(key)).and_then(|line| line.label().map(str::to_owned))
        })
    }

    /// Types `text` into `field` (selecting what is there) and presses Enter.
    fn type_into(
        &self,
        field: &Entity<crate::rows::TextSetting>,
        text: &str,
        cx: &mut TestAppContext,
    ) {
        let id: ElementId = ("settings-text", field.entity_id()).into();
        self.with_window(cx, |window, cx| {
            reveal(window, &id, cx);
            window.click(id, cx);
            window.press("cmd-a", cx);
            window.input(text, cx);
            window.press("enter", cx);
        });
    }

    fn network(&self, cx: &mut TestAppContext) -> Entity<crate::NetworkSection> {
        self.view.read_with(cx, |view, cx| view.general().read(cx).network().clone())
    }
}

/// The policy at `revision` with its sections changed by `edit`.
fn policy_with(revision: u64, edit: impl FnOnce(&mut Value)) -> Value {
    let mut value = policy(revision, "bypass");
    edit(&mut value["policy"]);
    value
}

#[gpui_kit::test]
fn the_privacy_and_task_default_switches_save_at_once_and_a_refusal_puts_them_back(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    harness.with_window(cx, |window, _| {
        let heading = domain_element_id("settings-group-title", "privacy");
        assert_eq!(window.find(heading).label(), Some(copy::PRIVACY.en()));
        assert_eq!(window.find(row_id("incognito")).label(), Some(copy::INCOGNITO.en()));
    });
    assert_eq!(harness.checked("incognito", cx), Some(false));
    assert_eq!(harness.checked("workspace-instructions", cx), Some(true));
    assert_eq!(harness.checked("code-mode", cx), Some(true));

    // The new value shows while the Host answers.
    let answer = harness.transport.hold("runtime.policy.mutate");
    harness.click(toggle("incognito"), cx);
    assert_eq!(harness.checked("incognito", cx), Some(true), "at once");
    assert!(harness.view.read_with(cx, |view, cx| view.is_busy(cx)));
    answer.try_send(Ok(json!({"kind": "committed", "revision": 4}))).expect("answer");
    cx.run_until_parked();
    assert_eq!(harness.checked("incognito", cx), Some(true));

    // A refusal puts the switch back and says why, in a sentence.
    harness.transport.reply("runtime.policy.mutate", Err(host_error("persistence_failed")));
    harness.click(toggle("workspace-instructions"), cx);
    assert_eq!(harness.checked("workspace-instructions", cx), Some(true), "put back");
    assert_eq!(
        harness.status("workspace-instructions", cx).as_deref(),
        Some(
            shared::copy::failure(
                shared::copy::Locale::English,
                copy::WORKSPACE_INSTRUCTIONS_FAILED.en(),
                copy::HOST_ERROR_PERSISTENCE.en(),
            )
            .as_str()
        )
    );

    // Code Mode off leaves the permission mode as read and drops the flag,
    // as the Host stores it.
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 5})));
    harness.click(toggle("code-mode"), cx);
    assert_eq!(harness.checked("code-mode", cx), Some(false));
    let writes = harness.transport.requests("runtime.policy.mutate");
    assert_eq!(
        writes,
        [
            json!({"expectedRevision": 3, "operation": {"kind": "set_privacy",
                   "value": {"incognitoActive": true}}}),
            json!({"expectedRevision": 4, "operation": {"kind": "set_workspace_instructions",
                   "value": {"enabled": false}}}),
            json!({"expectedRevision": 4, "operation": {"kind": "set_chat_defaults",
                   "value": {"permissionMode": "bypass"}}}),
        ]
    );
}

#[gpui_kit::test]
fn the_notification_switch_is_the_clients_own_and_on_by_default(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    assert_eq!(harness.checked("notifications", cx), Some(true));
    harness.click(toggle("notifications"), cx);
    assert_eq!(harness.checked("notifications", cx), Some(false));
    assert!(!cx.update(|cx| crate::AppPreferences::current(cx)).run_notifications);
    assert!(harness.transport.requests("runtime.policy.mutate").is_empty(), "not the Host's");
}

#[gpui_kit::test]
fn the_display_name_opens_saves_and_keeps_its_editor_on_a_refusal(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    harness.with_window(cx, |window, _| {
        let name = window.find(row_id("display-name"));
        assert_eq!(name.label(), Some(copy::DISPLAY_NAME.en()));
        assert_eq!(window.find("display-name-edit").label(), Some(copy::DISPLAY_NAME_SET.en()));
    });
    harness.click("display-name-edit", cx);
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("display-name-field").focused(), Some(true), "focus moves in");
        // Nothing to save yet: Save does nothing.
        window.click("display-name-save", cx);
    });
    let general = harness.view.read_with(cx, |view, _| view.general().clone());
    assert!(general.read_with(cx, |page, _| page.is_editing_display_name()));
    harness.with_window(cx, |window, cx| {
        window.click("display-name-field", cx);
        window.input("  Ada Lovelace  ", cx);
    });
    // A refusal keeps the editor and the draft.
    harness.transport.reply("runtime.policy.mutate", Err(host_error("invalid_request")));
    harness.click("display-name-save", cx);
    assert!(general.read_with(cx, |page, _| page.is_editing_display_name()));
    assert!(
        harness
            .status("display-name", cx)
            .is_some_and(|line| { line.starts_with(copy::PERSONALIZATION_SAVE_FAILED.en()) })
    );
    // Enter saves, trimmed, with the tone as read; the row shows the name.
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 4})));
    harness.with_window(cx, |window, cx| {
        window.click("display-name-field", cx);
        window.press("enter", cx);
    });
    assert!(!general.read_with(cx, |page, _| page.is_editing_display_name()));
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("display-name-edit").label(), Some(copy::DISPLAY_NAME_CHANGE.en()));
    });
    let writes = harness.transport.requests("runtime.policy.mutate");
    assert_eq!(
        writes.last(),
        Some(&json!({"expectedRevision": 3, "operation": {"kind": "set_personalization",
                     "value": {"displayName": "Ada Lovelace", "assistantTone": ""}}}))
    );
    // Escape closes the editor without saving.
    harness.click("display-name-edit", cx);
    harness.with_window(cx, |window, cx| {
        window.input(" the Second", cx);
        window.press("escape", cx);
    });
    assert!(!general.read_with(cx, |page, _| page.is_editing_display_name()));
    assert!(!harness.went_back(), "Escape closed only the editor");
    assert_eq!(harness.transport.requests("runtime.policy.mutate").len(), 2);
}

#[gpui_kit::test]
fn the_tone_saves_once_the_typing_stops(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 4})));
    harness.with_window(cx, |window, cx| {
        reveal(window, &"assistant-tone-field".into(), cx);
        window.click("assistant-tone-field", cx);
        window.input("Terse.", cx);
    });
    assert!(harness.transport.requests("runtime.policy.mutate").is_empty(), "not yet");
    cx.executor().advance_clock(crate::general_page::TONE_SAVE_DELAY);
    cx.run_until_parked();
    assert_eq!(
        harness.transport.requests("runtime.policy.mutate"),
        [json!({"expectedRevision": 3, "operation": {"kind": "set_personalization",
                "value": {"displayName": "", "assistantTone": "Terse."}}})]
    );
}

#[gpui_kit::test]
fn the_default_model_is_the_catalogs_and_a_refusal_puts_it_back(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, three_connections(8), cx);
    // Not set, then Ollama's model and DeepSeek's (the disabled relay is not
    // offered).
    assert_eq!(harness.chosen("default-model", cx).as_deref(), Some("qwen2.5:7b"));
    harness.transport.reply("connection.catalog.query", Ok(three_connections(8)));
    harness.transport.reply(
        "connection.catalog.set-default-target",
        Ok(json!({"kind": "committed", "catalogRevision": 9})),
    );
    harness.transport.reply("connection.catalog.query", Ok(three_connections(9)));
    harness.choose("default-model", &["down"], cx);
    assert_eq!(
        harness.transport.requests("connection.catalog.set-default-target"),
        [json!({"expectedCatalogRevision": 8,
                "target": {"connectionId": "c-deepseek", "modelId": "deepseek-v4-flash"}})]
    );
    // The Host refuses clearing it: the dropdown shows the catalog's default.
    harness.transport.reply("connection.catalog.query", Ok(three_connections(9)));
    harness.transport.reply(
        "connection.catalog.set-default-target",
        Err(HostRequestError::Operation {
            operation: "connection.catalog.set-default-target",
            code: host_protocol::HostOperationErrorCode::HostDraining,
            message: "draining".into(),
        }),
    );
    harness.transport.reply("connection.catalog.query", Ok(three_connections(9)));
    harness.choose("default-model", &["up"], cx);
    assert_eq!(harness.transport.requests("connection.catalog.set-default-target").len(), 2);
    assert_eq!(
        harness.transport.requests("connection.catalog.set-default-target")[1],
        json!({"expectedCatalogRevision": 9, "target": null})
    );
    assert_eq!(harness.chosen("default-model", cx).as_deref(), Some("qwen2.5:7b"));
    assert_eq!(
        harness.status("default-model", cx),
        Some(shared::copy::failure(
            shared::copy::Locale::English,
            copy::DEFAULT_MODEL_FAILED.en(),
            copy::HOST_ERROR_DRAINING.en()
        ))
    );
}

#[gpui_kit::test]
fn the_shell_saves_with_its_button_and_says_when_the_host_cannot_run_it(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    let save_label = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, _| {
            window.try_find("shell-save").and_then(|save| save.label().map(str::to_owned))
        })
    };
    // Nothing to save: no button.
    assert_eq!(save_label(cx), None);
    // Automatic, Git Bash: choosing Git Bash fills in where it usually is.
    harness.choose("shell", &["down"], cx);
    let executable = "C:\\Program Files\\Git\\bin\\bash.exe";
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("shell-executable-field").value(), Some(executable));
    });
    assert_eq!(save_label(cx).as_deref(), Some(copy::SAVE_SHELL.en()));
    assert!(harness.transport.requests("runtime.policy.mutate").is_empty(), "Save sends it");
    // The Host cannot run it as GNU Bash: Desktop's sentence, and the
    // choice stays to be fixed.
    harness.transport.reply("runtime.policy.mutate", Err(host_error("invalid_request")));
    harness.click("shell-save", cx);
    assert_eq!(harness.status("shell", cx).as_deref(), Some(copy::SHELL_EXECUTABLE_REJECTED.en()));
    assert_eq!(harness.chosen("shell", cx).as_deref(), Some(copy::SHELL_GIT_BASH.en()));
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 4})));
    harness.click("shell-save", cx);
    assert_eq!(
        harness.transport.requests("runtime.policy.mutate").last(),
        Some(&json!({"expectedRevision": 3, "operation": {"kind": "set_shell",
                     "value": {"preference": "git_bash", "executable": executable}}}))
    );
    assert_eq!(save_label(cx), None, "saved: the button goes");
    assert_eq!(harness.status("shell", cx), None);
}

/// The network proxy on, as the Host has it, with authentication off.
fn proxy_on(revision: u64) -> Value {
    policy_with(revision, |policy| policy["networkProxy"]["enabled"] = json!(true))
}

/// The proxy password's status, configured or not.
fn password_status(configured: bool) -> Value {
    if configured {
        json!({"kind": "status", "status": {
            "locator": {"scope": "network_proxy", "kind": "password"}, "configured": true,
            "credentialId": "p1", "revision": 2, "updatedAt": 1}})
    } else {
        json!({"kind": "status", "status": {
            "locator": {"scope": "network_proxy", "kind": "password"}, "configured": false,
            "credentialId": null, "revision": null, "updatedAt": null}})
    }
}

/// `runtime.policy.network-proxy.update` committed at `revision`.
fn proxy_committed(revision: u64, configured: bool) -> Value {
    json!({"kind": "committed", "revision": revision,
           "credentialStatus": password_status(configured)["status"]})
}

#[gpui_kit::test]
fn the_proxy_saves_with_its_password_which_never_comes_back(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    // Off: only the switch. Turning it on deletes the (absent) password, as
    // the Host requires while authentication is off.
    harness.with_window(cx, |window, _| {
        assert!(window.find(row_id("proxy")).label() == Some(copy::PROXY.en()));
        assert!(window.try_find(domain_element_id("settings-field", "proxy-server")).is_none());
    });
    harness.transport.reply("runtime.policy.network-proxy.update", Ok(proxy_committed(4, false)));
    harness.click(toggle("proxy"), cx);
    let updates = || harness.transport.requests("runtime.policy.network-proxy.update");
    let mut proxy = policy_json("bypass")["networkProxy"].clone();
    proxy["enabled"] = json!(true);
    assert_eq!(
        updates(),
        [json!({"expectedPolicyRevision": 3, "expectedCredential": null,
                "networkProxy": proxy, "credential": {"kind": "delete"}})]
    );
    let network = harness.network(cx);
    let field = |key: &str, cx: &mut TestAppContext| {
        network.read_with(cx, |network, _| network.field(key).clone())
    };

    // A port that is not one is refused before anything is sent.
    let port = field("port", cx);
    harness.type_into(&port, "99999", cx);
    assert_eq!(updates().len(), 1);
    assert_eq!(harness.status("proxy-port", cx).as_deref(), Some(copy::PROXY_PORT_INVALID.en()));
    assert_eq!(port.read_with(cx, |port, cx| port.input().read(cx).value()), "7890", "put back");

    // Authentication on, a username, then the password: it goes to the Host
    // and the field is empty again, saying one is saved.
    harness.transport.reply("runtime.policy.network-proxy.update", Ok(proxy_committed(5, false)));
    harness.click(toggle("proxy-auth"), cx);
    harness.transport.reply("runtime.policy.network-proxy.update", Ok(proxy_committed(6, false)));
    harness.type_into(&field("username", cx), "proxy-user", cx);
    harness.transport.reply("runtime.policy.network-proxy.update", Ok(proxy_committed(7, true)));
    let password = field("password", cx);
    harness.type_into(&password, "write-only-secret", cx);
    let sent = updates();
    assert_eq!(sent[1]["credential"], json!({"kind": "keep"}));
    assert_eq!(sent[2]["networkProxy"]["username"], json!("proxy-user"));
    assert_eq!(sent[3]["credential"], json!({"kind": "replace", "secret": "write-only-secret"}));
    assert_eq!(sent[3]["expectedPolicyRevision"], json!(6));
    let value = password.read_with(cx, |password, cx| password.input().read(cx).value());
    assert_eq!(value, "", "the secret leaves the field");
    let policy = harness.view.read_with(cx, |view, _| view.policy().clone());
    let state = policy.read_with(cx, |policy, _| format!("{policy:?} {:?}", policy.snapshot()));
    assert!(!state.contains("write-only-secret"), "the policy keeps no secret");
    assert!(policy.read_with(cx, |policy, _| policy.proxy_password_saved()));

    // A stale basis reads the policy and the password again and sends once
    // more against what it read.
    harness.transport.reply(
        "runtime.policy.network-proxy.update",
        Ok(json!({"kind": "credential_stale", "expected": null, "actual": null})),
    );
    harness.transport.reply("runtime.policy.query", Ok(proxy_on(9)));
    harness.transport.reply("credential.vault.query", Ok(password_status(true)));
    harness.transport.reply("runtime.policy.network-proxy.update", Ok(proxy_committed(10, true)));
    harness.type_into(&field("bypass", cx), "a.cn, b.com", cx);
    let sent = updates();
    let retry = sent.last().expect("retry");
    assert_eq!(retry["expectedPolicyRevision"], json!(9));
    assert_eq!(
        retry["expectedCredential"],
        json!({"locator": {"scope": "network_proxy", "kind": "password"},
               "credentialId": "p1", "revision": 2})
    );
    assert_eq!(retry["networkProxy"]["bypassList"], json!(["a.cn", "b.com"]));

    // A refusal puts the field back and says why under its block.
    harness.transport.reply(
        "runtime.policy.network-proxy.update",
        Ok(json!({"kind": "proxy_target_mismatch",
                  "expected": {"protocol": "http", "host": "a", "port": 1, "username": ""},
                  "actual": {"protocol": "http", "host": "b", "port": 1, "username": ""}})),
    );
    let server = field("server", cx);
    harness.type_into(&server, "proxy.lan", cx);
    assert_eq!(server.read_with(cx, |server, cx| server.input().read(cx).value()), "127.0.0.1");
    assert!(harness.status("proxy-server", cx).is_some_and(|line| {
        line.starts_with(copy::PROXY_SAVE_FAILED.en()) && line.contains("proxy changed")
    }));
}

#[gpui_kit::test]
fn a_proxy_test_probes_the_saved_proxy_and_says_what_it_found(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("runtime.policy.query", Ok(proxy_on(3)));
    let harness = Harness::open_with_transport(SettingsSection::General, transport, cx);
    harness.transport.reply(
        "network-proxy.test",
        Ok(json!({"ok": true, "latencyMs": 42, "status": 200, "ip": "203.0.113.4"})),
    );
    harness.click("proxy-test", cx);
    let tested = harness.transport.requests("network-proxy.test");
    assert_eq!(tested.len(), 1);
    assert_eq!(tested[0]["networkProxy"]["enabled"], json!(true));
    assert_eq!(
        harness.status("proxy-test", cx).as_deref(),
        Some("The proxy is reachable · http://127.0.0.1:7890 · 203.0.113.4 · 42 ms")
    );
    harness.transport.reply(
        "network-proxy.test",
        Ok(json!({"ok": false, "latencyMs": 0, "error": "proxy test timeout"})),
    );
    harness.click("proxy-test", cx);
    assert!(harness.status("proxy-test", cx).is_some_and(|line| {
        line.starts_with(copy::PROXY_TEST_FAILED.en()) && line.contains("timed out")
    }));
}

#[gpui_kit::test]
fn every_refusal_code_of_the_settings_operations_has_a_sentence(cx: &mut TestAppContext) {
    let _ = cx;
    let en = shared::copy::Locale::English;
    for code in [
        "host_not_ready",
        "host_draining",
        "operation_unavailable",
        "invalid_request",
        "internal_failure",
        "persistence_failed",
        "commit_outcome_unknown",
        "unauthorized",
    ] {
        let reason = crate::policy::host_error_reason(&host_error(code), en);
        assert_ne!(reason, "refused", "{code} reads as the Host's words");
        assert!(!reason.is_empty());
    }
    assert_eq!(
        crate::policy::host_error_reason(&HostRequestError::NotConnected, en),
        copy::HOST_ERROR_NOT_CONNECTED.en()
    );
}

#[gpui_kit::test]
fn palettes_and_the_font_size_apply_at_once_and_are_remembered(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::Appearance, catalog_page(6), cx);
    let card = |id: &str| domain_element_id("settings-palette", id);
    harness.with_window(cx, |window, _| {
        let heading = domain_element_id("settings-group-title", "palette");
        assert_eq!(window.find(heading).label(), Some(copy::PALETTE.en()));
        assert_eq!(window.find(card("default")).checked(), Some(true));
        assert_eq!(window.find(card("tokyo-night")).label(), Some(copy::PALETTE_TOKYO_NIGHT.en()));
        // Desktop's two groups, four cards a line.
        let first = window.find(card("default")).bounds();
        let fifth = window.find(card("nord")).bounds();
        assert!(fifth.top() > first.top(), "the fifth wraps");
        let coral = window.find(card("coral")).bounds();
        assert!(coral.top() > fifth.top(), "product colours after the editor themes");
    });
    harness.click(card("nord"), cx);
    assert_eq!(
        cx.update(|cx| shared::theme::theme_palette(cx)),
        shared::palette::ThemePalette::Nord
    );
    assert_eq!(
        cx.update(|cx| crate::AppPreferences::current(cx)).palette,
        shared::palette::ThemePalette::Nord
    );
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(card("nord")).checked(), Some(true));
    });

    // The size steps by one pixel within Desktop's range, 11 to 22: Up and
    // Down in the field, and its − and + buttons.
    use gpui_kit::Focusable as _;
    let size =
        harness.view.read_with(cx, |view, cx| view.appearance().read(cx).font_size().clone());
    let shown = |cx: &mut TestAppContext| size.read_with(cx, |input, _| input.value().to_string());
    let applied = |cx: &mut TestAppContext| {
        let size = cx.update(|cx| shared::theme::ui_font_size(cx));
        assert_eq!(cx.update(|cx| crate::AppPreferences::current(cx)).ui_font_size, size);
        size
    };
    harness.with_window(cx, |window, cx| {
        reveal(window, &"settings-ui-font-size".into(), cx);
        size.update(cx, |input, cx| {
            input.focus(window, cx);
        });
        window.press("up", cx);
    });
    assert_eq!((applied(cx), shown(cx)), (15, "15".into()));
    harness.with_window(cx, |window, cx| {
        for _ in 0..5 {
            window.press("down", cx);
        }
    });
    assert_eq!((applied(cx), shown(cx)), (11, "11".into()), "not below Desktop's smallest");
    // At either end that end's button is disabled: a click does nothing,
    // not even give the field focus as an enabled button's does.
    let focus_nav = |cx: &mut TestAppContext| {
        let surface = harness.view.clone();
        harness.with_window(cx, |window, cx| {
            surface.update(cx, |view, cx| view.focus_nav(window, cx));
        });
    };
    let field_focused = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, cx| size.read(cx).focus_handle(cx).is_focused(window))
    };
    focus_nav(cx);
    harness.click("settings-ui-font-size-smaller", cx);
    assert_eq!((applied(cx), shown(cx)), (11, "11".into()));
    assert!(!field_focused(cx), "− is disabled at 11");
    harness.click("settings-ui-font-size-larger", cx);
    assert_eq!((applied(cx), shown(cx)), (12, "12".into()));
    assert!(field_focused(cx), "+ steps from the field");
    harness.click("settings-ui-font-size-smaller", cx);
    assert_eq!(applied(cx), 11);
    for _ in 11..22 {
        harness.click("settings-ui-font-size-larger", cx);
    }
    assert_eq!((applied(cx), shown(cx)), (22, "22".into()));
    harness.with_window(cx, |window, cx| window.press("up", cx));
    assert_eq!((applied(cx), shown(cx)), (22, "22".into()), "not above Desktop's largest");
    focus_nav(cx);
    harness.click("settings-ui-font-size-larger", cx);
    assert_eq!(applied(cx), 22);
    assert!(!field_focused(cx), "+ is disabled at 22");
    harness.click("settings-ui-font-size-smaller", cx);
    assert_eq!((applied(cx), shown(cx)), (21, "21".into()));
    assert!(field_focused(cx), "− steps from the field");
}

#[gpui_kit::test]
fn command_f_focuses_the_section_search_from_anywhere_in_settings(cx: &mut TestAppContext) {
    use gpui_kit::Focusable as _;
    // Appearance has no search of its own.
    let harness = Harness::open_on(SettingsSection::Appearance, catalog_page(6), cx);
    let search = harness.view.read_with(cx, |view, _| view.section_search().clone());
    command_f_focuses(&harness, &search, cx);
    harness.with_window(cx, |window, cx| window.input("app", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(nav("general")).is_none(), "the search filters the sections");
    });
    // From a field on the page: the kit's own ⌘F (find in the field)
    // passes it on; the search takes focus with its text selected.
    let field =
        harness.view.read_with(cx, |view, cx| view.appearance().read(cx).font_size().clone());
    harness.with_window(cx, |window, cx| {
        field.update(cx, |field, cx| field.focus(window, cx));
        window.press("secondary-f", cx);
    });
    harness.with_window(cx, |window, cx| {
        assert!(search.read(cx).focus_handle(cx).is_focused(window));
        assert!(!field.read(cx).focus_handle(cx).is_focused(window));
        assert_eq!(search.read(cx).selected_range(), 0..3, "“app” is selected");
    });
    // Typing replaces it.
    harness.with_window(cx, |window, cx| window.input("gen", cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(nav("general")).is_some());
    });
}

#[gpui_kit::test]
fn settings_remember_the_section_shown_last(cx: &mut TestAppContext) {
    let harness = Harness::open_on(SettingsSection::General, catalog_page(6), cx);
    assert_eq!(cx.update(|cx| crate::remembered_settings_section(cx)), SettingsSection::General);
    harness.with_window(cx, |window, cx| window.click(nav("appearance"), cx));
    assert_eq!(cx.update(|cx| crate::remembered_settings_section(cx)), SettingsSection::Appearance);
}

/// Nothing: a window for a notifier to watch from.
struct Blank;

impl Render for Blank {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full()
    }
}

/// A `session.catalog.changed` for `session` with an attention.
fn attention(session: &str, kind: &str, event: &str, body: Option<&str>) -> HostEvent {
    let mut attention = json!({"kind": kind, "eventId": event});
    if let Some(body) = body {
        attention["body"] = json!(body);
    }
    let frame = host_protocol::HostFrame::decode(json!({
        "kind": "session.catalog.changed", "revision": 7, "sessionId": session,
        "attention": attention
    }))
    .expect("frame");
    let host_protocol::HostFrame::Push(frame) = frame else {
        panic!("a push frame");
    };
    HostEvent::Push(frame)
}

#[gpui_kit::test]
fn a_run_that_ends_in_the_background_notifies_once(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init(cx);
        // As the app does at startup: the platform posts nothing before.
        cx.set_app_identity("com.longbridge.maka-gpui", "Maka");
    });
    let transport = Arc::new(ScriptedHost::default());
    let host =
        cx.new(|_| HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), transport.clone()));
    host.update(cx, |host, cx| {
        host.handle_host_event(
            HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
            cx,
        )
    });
    let names: crate::TaskNames =
        Rc::new(|id, _| (id == "s1").then(|| gpui_kit::SharedString::from("Fix the build")));
    let mut notifier = None;
    let window = cx.open_window(size(px(800.), px(600.)), |window, cx| {
        notifier = Some(cx.new(|cx| crate::RunNotifier::new(host.clone(), names, window, cx)));
        Root::new(cx.new(|_| Blank), window, cx)
    });
    let _notifier = notifier.expect("notifier");
    let send = |event: HostEvent, cx: &mut TestAppContext| {
        host.update(cx, |host, cx| host.handle_host_event(event, cx));
        cx.run_until_parked();
    };
    let shown = |cx: &mut TestAppContext| -> Vec<(String, String)> {
        cx.shown_system_notifications()
            .into_iter()
            .map(|shown| (shown.title.to_string(), shown.body.to_string()))
            .collect()
    };

    // The window in front shows the answer itself.
    cx.update_window(window.into(), |_, window, _| window.activate_window()).expect("window");
    cx.run_until_parked();
    send(attention("s1", "completed", "e1", None), cx);
    assert!(shown(cx).is_empty());

    gpui_kit::VisualTestContext::from_window(window.into(), cx).deactivate_window();
    send(attention("s1", "errored", "e2", Some("auth failed")), cx);
    // The same event again (another connection delivered it) posts nothing.
    send(attention("s1", "errored", "e2", Some("auth failed")), cx);
    send(attention("s2", "waiting", "e3", None), cx);
    assert_eq!(
        shown(cx),
        [
            ("Fix the build".to_owned(), "auth failed".to_owned()),
            (copy::RUN_WAITING_TITLE.en().to_owned(), copy::RUN_WAITING_BODY.en().to_owned()),
        ]
    );
    // Off, nothing is posted; a catalog change without an attention never is.
    cx.update(|cx| {
        crate::AppPreferences::global(cx)
            .update(cx, |preferences, cx| preferences.set_run_notifications(false, cx))
    });
    send(attention("s1", "completed", "e4", None), cx);
    assert_eq!(shown(cx).len(), 2);
    // A click brings the window forward.
    let tag = cx.shown_system_notifications()[0].tag.clone();
    cx.simulate_system_notification_response(gpui_kit::SystemNotificationResponse {
        tag,
        action_id: None,
    });
    cx.run_until_parked();
    assert!(
        cx.update_window(window.into(), |_, window, _| window.is_window_active()).expect("window")
    );
}
