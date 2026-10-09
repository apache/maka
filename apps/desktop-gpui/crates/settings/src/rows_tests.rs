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

//! The row kit in a headless window: each kind of row as a page would use
//! it, driven by clicks and keys.

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, TestAppContext, Window, WindowHandle, div, px, size,
};
use shared::copy::settings as copy;
use shared::domain_element_id;

use crate::rows::{
    ActionRow, EmptyRow, SettingsGroup, SettingsRow, StatusLine, TextSetting, TextSettingEvent,
    destructive_button, settings_button,
};

/// A page with one row of each kind; it records what they report.
struct Sample {
    enabled: bool,
    name: Entity<TextSetting>,
    log: Rc<RefCell<Vec<String>>>,
    _subscription: gpui_kit::Subscription,
}

impl Sample {
    fn new(log: Rc<RefCell<Vec<String>>>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = cx.new(|cx| TextSetting::new(copy::NAME, "Ada", window, cx));
        let recorded = log.clone();
        let subscription = cx.subscribe(&name, move |_, _, event: &TextSettingEvent, _| {
            let TextSettingEvent::Committed(value) = event;
            recorded.borrow_mut().push(format!("committed {value}"));
        });
        Self { enabled: false, name, log, _subscription: subscription }
    }
}

impl Render for Sample {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let log = self.log.clone();
        let cleared = self.log.clone();
        let this = cx.entity().downgrade();
        div().size_full().child(
            SettingsGroup::new("sample")
                .title("Sample")
                .description("Every kind of row.")
                .child(
                    SettingsRow::toggle("incognito", "Incognito", self.enabled, false, {
                        move |checked, _, cx| {
                            log.borrow_mut().push(format!("toggle {checked}"));
                            let checked = *checked;
                            this.update(cx, |this, cx| {
                                this.enabled = checked;
                                cx.notify();
                            })
                            .ok();
                        }
                    })
                    .detail("Pause memory."),
                )
                .child(SettingsRow::text("name", "Name", &self.name))
                .child(SettingsRow::value("version", "Version", "1.2.3", cx))
                .child(
                    SettingsRow::path("root", "Data folder", "/Users/me/very/long/path")
                        .detail("Where it lives.")
                        .status(StatusLine::error("root", "Couldn’t read it.")),
                )
                .child(SettingsRow::loading("model", "Default model", 8., cx))
                .child(EmptyRow::new("presets", "No presets yet"))
                .child(
                    ActionRow::new("sample").child(settings_button("open", "Open", cx)).child(
                        destructive_button("clear", "Clear history", cx).on_click(
                            move |_, _, _| cleared.borrow_mut().push("cleared".to_owned()),
                        ),
                    ),
                ),
        )
    }
}

fn open(cx: &mut TestAppContext) -> (WindowHandle<Root>, Entity<Sample>, Rc<RefCell<Vec<String>>>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init(cx);
    });
    let log = Rc::new(RefCell::new(Vec::new()));
    let mut sample = None;
    let recorded = log.clone();
    let window = cx.open_window(size(px(900.), px(700.)), |window, cx| {
        let view = cx.new(|cx| Sample::new(recorded, window, cx));
        sample = Some(view.clone());
        Root::new(view, window, cx)
    });
    // Focus events (a field's blur) reach listeners in an active window.
    cx.update_window(window.into(), |_, window, _| window.activate_window()).expect("window");
    cx.run_until_parked();
    (window, sample.expect("sample"), log)
}

fn in_window<R>(
    window: WindowHandle<Root>,
    cx: &mut TestAppContext,
    f: impl FnOnce(&mut Window, &mut gpui_kit::App) -> R,
) -> R {
    let result = cx
        .update_window(window.into(), |_, window, cx| {
            window.render_frame(cx);
            f(window, cx)
        })
        .expect("window");
    cx.run_until_parked();
    result
}

#[gpui_kit::test]
fn rows_show_their_parts_under_the_groups_heading(cx: &mut TestAppContext) {
    let (window, _, _) = open(cx);
    in_window(window, cx, |window, _| {
        let heading = window.find(domain_element_id("settings-group-title", "sample"));
        assert_eq!(heading.label(), Some("Sample"));
        assert_eq!(heading.role(), Some(gpui_kit::Role::Heading));
        let row = window.find(domain_element_id("settings-row", "incognito"));
        assert_eq!(row.label(), Some("Incognito"));
        assert!(heading.bounds().bottom() < row.bounds().top());
        let value = window.find(domain_element_id("settings-value", "version"));
        assert_eq!(value.label(), Some("1.2.3"));
        // A path sits on its own line under the detail, the width of the row.
        let path = window.find(domain_element_id("settings-value", "root")).bounds();
        let root = window.find(domain_element_id("settings-row", "root")).bounds();
        assert!(path.size.width > root.size.width * 0.5, "{path:?} in {root:?}");
        let status = window.find(domain_element_id("settings-status", "root"));
        assert_eq!(status.label(), Some("Couldn’t read it."));
        assert!(status.bounds().top() >= path.bottom(), "the status line comes last");
        let loading = window.find(domain_element_id("settings-loading", "model"));
        assert_eq!(loading.label(), Some(copy::SETTINGS_LOADING.en()));
        // A group with nothing in it says so in one 32px row.
        let empty = window.find(domain_element_id("settings-empty", "presets"));
        assert_eq!(empty.label(), Some("No presets yet"));
        assert_eq!(empty.bounds().size.height, px(32.));
        // Desktop's row actions: 32px, 8px apart.
        let open = window.find("open").bounds();
        let clear = window.find("clear").bounds();
        assert_eq!(open.size.height, px(32.));
        assert_eq!(clear.size.height, px(32.));
        assert_eq!(clear.left() - open.right(), px(8.));
        // A path is compact code: one 20px line, under the title's rung.
        assert_eq!(path.size.height, px(20.));
    });
}

#[gpui_kit::test]
fn a_toggle_row_asks_its_owner_and_an_action_runs(cx: &mut TestAppContext) {
    let (window, sample, log) = open(cx);
    let toggle = domain_element_id("settings-toggle", "incognito");
    in_window(window, cx, |window, cx| {
        assert_eq!(window.find(toggle.clone()).checked(), Some(false));
        assert_eq!(window.find(toggle.clone()).label(), Some("Incognito"));
        window.click(toggle.clone(), cx);
    });
    assert!(sample.read_with(cx, |sample, _| sample.enabled));
    in_window(window, cx, |window, cx| {
        assert_eq!(window.find(toggle.clone()).checked(), Some(true));
        window.click("clear", cx);
    });
    assert_eq!(*log.borrow(), ["toggle true", "cleared"]);
}

#[gpui_kit::test]
fn a_text_row_commits_on_enter_and_blur_and_escape_puts_it_back(cx: &mut TestAppContext) {
    let (window, sample, log) = open(cx);
    let name = sample.read_with(cx, |sample, _| sample.name.clone());
    let input_id = ("settings-text", name.entity_id());
    let value = |cx: &mut TestAppContext| -> SharedString {
        name.read_with(cx, |name, cx| name.input().read(cx).value())
    };
    in_window(window, cx, |window, cx| {
        window.click(input_id, cx);
        window.press("cmd-a", cx);
        window.input("Grace", cx);
        window.press("enter", cx);
    });
    assert_eq!(*log.borrow(), ["committed Grace"]);
    assert_eq!(name.read_with(cx, |name, _| name.committed().clone()), "Grace");
    // Escape puts the committed text back and stays in the field.
    in_window(window, cx, |window, cx| {
        window.input(" Hopper", cx);
        window.press("escape", cx);
    });
    assert_eq!(value(cx), "Grace");
    in_window(window, cx, |window, _| {
        assert_eq!(window.find(input_id).focused(), Some(true));
    });
    assert_eq!(log.borrow().len(), 1, "a revert commits nothing");
    // Leaving the field commits what it holds; an unchanged text commits
    // nothing.
    in_window(window, cx, |window, cx| {
        window.input(" H", cx);
        window.press("tab", cx);
    });
    // The field hears it lost focus when the next frame is drawn.
    in_window(window, cx, |_, _| {});
    assert_eq!(*log.borrow(), ["committed Grace", "committed Grace H"]);
    in_window(window, cx, |window, cx| {
        window.click(input_id, cx);
        window.press("enter", cx);
    });
    assert_eq!(log.borrow().len(), 2);
    // The owner's value replaces the field's text unless it is being edited.
    in_window(window, cx, |window, cx| {
        name.update(cx, |name, cx| name.set_committed("From the Host", window, cx));
    });
    assert_eq!(value(cx), "Grace H", "being edited: the text stays");
    in_window(window, cx, |window, cx| window.press("tab", cx));
    in_window(window, cx, |window, cx| {
        name.update(cx, |name, cx| name.set_committed("From the Host", window, cx));
    });
    assert_eq!(value(cx), "From the Host");
}
