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

use nsh_core::{
    Command, EventKind, EventPayload, JsonValue, PayloadValue, ROOT_ID, Size,
    desktop::{DesktopCommand, MenuAction, MenuItem, MenuRole, Tray},
    element::Instance,
    platform::{Environment, Idiom, Os},
    prelude::px,
};
use nsh_engine::{Bundle, EngineConfig};
use nsh_testing::Headless;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

// Only the business Host boundary is a fixture; NSH owns the JS and lifecycle.
#[nsh_core::element::class]
struct EmptyHost;
#[nsh_core::element::class]
impl EmptyHost {
    #[getter]
    pub fn system_locale(&self) -> String {
        "en".into()
    }
    #[getter]
    pub fn restored(&self) -> JsonValue {
        JsonValue::Null
    }
    pub fn refresh(&self) {}
    pub fn read_ui(&self, _input: JsonValue) -> JsonValue {
        serde_json::json!({"source":{"stateDomain":"test","deployment":"test","revision":1},"ui":null,"instances":[]})
    }
    pub fn subscribe(
        &self,
        _endpoint: String,
        _method: String,
        _input: JsonValue,
    ) -> Instance<EmptyStream> {
        Instance::new(EmptyStream)
    }
}

#[nsh_core::element::class]
struct EmptyStream;
#[nsh_core::element::class]
impl EmptyStream {
    pub async fn next(this: Instance<Self>) -> JsonValue {
        drop(this);
        std::future::pending().await
    }
    pub fn close(&self) {}
}

fn start(os: Os, idiom: Idiom, bootstrap: bool) -> (Headless, Arc<AtomicUsize>) {
    let mut registry = crate::bindings::ui_registry();
    registry.value("host", || Instance::new(EmptyHost));
    let sets = vec![nsh_base::registry(), registry];
    let bundle = if bootstrap {
        crate::bootstrap_bundle()
    } else {
        let module = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new("tests/fixtures/desktop-residency.tsx")
                .canonicalize()
                .unwrap(),
            minify: false,
            split: false,
            ui_sets: sets
                .iter()
                .flat_map(nsh_core::element::Registry::sets)
                .map(Into::into)
                .collect(),
            asset_root_from: Some(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."),
            ),
            ..Default::default()
        })
        .unwrap();
        let mut capabilities = nsh_engine::Capabilities::all();
        capabilities.host = vec!["*".into()];
        Bundle::source(module.code).with_policy(nsh_engine::Policy {
            declared: Some(capabilities),
            ..nsh_engine::Policy::development()
        })
    };
    let config = EngineConfig {
        viewport: Size::new(px(640.0), px(480.0)),
        environment: Environment {
            os,
            idiom,
            ..Environment::default()
        },
        ui_sets: sets,
        ..EngineConfig::new(bundle)
    };
    let exits = Arc::new(AtomicUsize::new(0));
    let received = exits.clone();
    config.host.handle("terminal.exit", move |_| {
        received.fetch_add(1, Ordering::SeqCst);
    });
    let mut app = Headless::start(config).unwrap();
    assert!(app.settle());
    (app, exits)
}

fn tray(app: &Headless) -> Option<&Tray> {
    app.screen()
        .commands()
        .iter()
        .rev()
        .find_map(|(_, c)| match c {
            Command::Desktop(c) => match c.as_ref() {
                DesktopCommand::SetTray(t) => Some(t.as_ref()),
                _ => None,
            },
            _ => None,
        })
        .flatten()
}

fn actions(items: &[MenuItem]) -> Vec<&MenuAction> {
    items
        .iter()
        .flat_map(|item| match item {
            MenuItem::Action(action) => vec![action],
            MenuItem::Submenu { items, .. } => actions(items),
            MenuItem::Separator => vec![],
        })
        .collect()
}

// Drive the same NSH event that native tray/menu adapters send, not an OS tray.
fn select(app: &mut Headless, id: u32) {
    app.engine().control().dispatch_event(
        ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![("id", PayloadValue::Number(f64::from(id)))]),
    );
    assert!(app.settle());
}

#[test]
fn desktop_residency_keeps_draft_and_work_across_close_reopen_and_ui_changes() {
    let (mut app, exits) = start(Os::Linux, Idiom::Desktop, false);
    app.send_host_event("session", "conversation-42".into())
        .unwrap();
    app.type_text("label:Draft", "edited 原文😀").unwrap();
    app.send_host_event("secondary", JsonValue::Null).unwrap();
    let first_click = tray(&app).unwrap().click;
    for primary in [false, true] {
        app.press_window_close("main").unwrap();
        assert!(!app.window_state("main").unwrap().unwrap().visible);
        assert!(app.window_state("other").unwrap().unwrap().visible);
        app.send_host_event("turn", JsonValue::Null).unwrap();
        let t = tray(&app).unwrap();
        let id = if primary {
            t.click
        } else {
            actions(&t.menu)[0].id
        };
        select(&mut app, id);
        assert!(app.window_state("main").unwrap().unwrap().visible);
    }
    app.wait_for("text:/edited 原文😀; turns: 2/").unwrap();
    app.wait_for("text:conversation-42").unwrap();
    app.send_host_event("page", false.into()).unwrap();
    app.send_host_event("locale", "zh-CN".into()).unwrap();
    app.send_host_event("icon", "line".into()).unwrap();
    let t = tray(&app).unwrap();
    assert_eq!(actions(&t.menu)[0].label, "打开 Maka");
    assert_eq!(
        t.icon.as_ref().unwrap().uri.as_ref(),
        "asset:/maka/tray-line.svg"
    );
    app.send_host_event("page", true.into()).unwrap();
    app.press_window_close("main").unwrap();
    select(&mut app, first_click);
    assert!(
        !app.window_state("main").unwrap().unwrap().visible,
        "retired tray handler reopened main"
    );
    let click = tray(&app).unwrap().click;
    select(&mut app, click);
    assert!(app.window_state("main").unwrap().unwrap().visible);
    app.wait_for("text:/edited 原文😀; turns: 2/").unwrap();
    let quit = actions(&tray(&app).unwrap().menu)[1].id;
    select(&mut app, quit);
    assert_eq!(exits.load(Ordering::SeqCst), 1);

    app.send_host_event("resident", false.into()).unwrap();
    assert!(tray(&app).is_none());
    let commands = app.screen().commands().len();
    app.send_host_event("locale", "en".into()).unwrap();
    select(&mut app, click);
    select(&mut app, quit);
    app.press_window_close("main").unwrap();
    assert!(
        app.window_state("main").unwrap().unwrap().visible,
        "disposed close listener hid main"
    );
    assert_eq!(
        exits.load(Ordering::SeqCst),
        1,
        "disposed Quit listener fired"
    );
    assert!(!app.screen().commands()[commands..].iter().any(|(_, c)| matches!(c, Command::Desktop(c) if matches!(c.as_ref(), DesktopCommand::SetTray(_)))));
    app.send_host_event("resident", true.into()).unwrap();
    app.press_window_close("main").unwrap();
    assert!(!app.window_state("main").unwrap().unwrap().visible);
    app.press_window_close("other").unwrap();
    assert!(app.window_state("other").unwrap().is_none());
}

#[test]
fn desktop_residency_is_owned_by_the_real_bootstrap_without_a_root_ui() {
    let (mut app, exits) = start(Os::Linux, Idiom::Desktop, true);
    app.wait_for("text:This deployment has no root UI selected.")
        .unwrap();
    app.press_window_close("main").unwrap();
    assert!(!app.window_state("main").unwrap().unwrap().visible);
    let open = actions(&tray(&app).unwrap().menu)[0].id;
    select(&mut app, open);
    assert!(app.window_state("main").unwrap().unwrap().visible);
    let quit = actions(&tray(&app).unwrap().menu)[1].id;
    select(&mut app, quit);
    assert_eq!(exits.load(Ordering::SeqCst), 1);
}

#[test]
fn desktop_residency_respects_platform_guards_and_explicit_quit_menu_contracts() {
    for (os, idiom) in [
        (Os::Linux, Idiom::Terminal),
        (Os::Android, Idiom::Phone),
        (Os::Web, Idiom::Desktop),
    ] {
        let (mut app, _) = start(os, idiom, false);
        app.type_text("label:Draft", "terminal editing").unwrap();
        app.wait_for("text:/terminal editing/").unwrap();
        assert!(
            !app.screen()
                .commands()
                .iter()
                .any(|(_, c)| matches!(c, Command::Desktop(_)))
        );
    }
    for os in [Os::Windows, Os::MacOs] {
        let (mut app, exits) = start(os, Idiom::Desktop, false);
        let menu = app
            .screen()
            .commands()
            .iter()
            .rev()
            .find_map(|(_, c)| match c {
                Command::Desktop(c) => match c.as_ref() {
                    DesktopCommand::SetMenu(Some(items)) => Some(items),
                    _ => None,
                },
                _ => None,
            })
            .unwrap();
        let items = actions(menu);
        if os == Os::MacOs {
            assert!(items.iter().any(|item| item.role == Some(MenuRole::Quit)));
        } else {
            let quit = items.iter().find(|item| item.label == "Quit Maka").unwrap();
            assert_eq!(quit.role, None);
            assert_eq!(
                quit.shortcut,
                Some(nsh_core::desktop::Shortcut::parse("mod+q", false).unwrap())
            );
            let id = quit.id;
            select(&mut app, id);
            assert_eq!(exits.load(Ordering::SeqCst), 1);
        }
    }
}
