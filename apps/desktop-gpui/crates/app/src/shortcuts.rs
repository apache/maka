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

//! The keyboard shortcuts sheet: every command of the window's table that
//! has a key binding, grouped as the table groups them, each binding drawn
//! with gpui-kit's `Kbd`. It is generated from the same table as the
//! command palette and reads the bindings from the keymap, so it lists
//! what the keys really do.

use gpui_kit::component::kbd::Kbd;
use gpui_kit::component::{ActiveTheme as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    App, AsKeystroke as _, InteractiveElement as _, IntoElement, KeyContext, Keystroke,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, Window, div, px, rems,
};
use shared::copy::{self, Locale, commands as words};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::theme::floating_surface;

use crate::commands::{COMMANDS, CommandGroup, CommandSpec};

/// The sheet's width: two columns of groups.
const WIDTH_REMS: f32 = 46.;
/// The groups in each column: what runs anywhere, then what acts on the
/// focused list.
const COLUMNS: [&[CommandGroup]; 2] = [
    &[CommandGroup::Task, CommandGroup::View, CommandGroup::Settings, CommandGroup::Host],
    &[CommandGroup::TaskList, CommandGroup::Transcript],
];

/// The key bindings of `command` in force now, highest precedence first
/// (the one menus and the palette show).
pub(crate) fn bindings(command: &CommandSpec, window: &Window) -> Vec<Keystroke> {
    let context = match command.context {
        Some(context) => KeyContext::parse(context).unwrap_or_default(),
        None => KeyContext::default(),
    };
    let action = command.action();
    let mut bindings: Vec<Keystroke> = window
        .bindings_for_action_in_context(action.as_ref(), context)
        .iter()
        .filter_map(|binding| binding.keystrokes().first())
        .map(|keystroke| keystroke.as_keystroke().clone())
        .collect();
    bindings.reverse();
    bindings.dedup();
    bindings
}

/// Opens the sheet over `window`. It holds no focusable control; Escape or
/// a click outside closes it, and focus returns to what had it.
pub(crate) fn open_shortcuts(window: &mut Window, cx: &mut App) {
    window.open_dialog(cx, move |dialog, window, cx| {
        let width = (window.rem_size() * WIDTH_REMS).min(window.viewport_size().width - px(32.));
        floating_surface(dialog, cx)
            .w(width)
            .with_header(DialogHeader::new(words::KEYBOARD_SHORTCUTS.get(cx)))
            .child(ShortcutsSheet)
    });
}

/// The sheet's content, built from the table on every frame.
#[derive(IntoElement)]
struct ShortcutsSheet;

impl RenderOnce for ShortcutsSheet {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let columns = COLUMNS.map(|groups| {
            v_flex()
                .flex_1()
                .min_w_0()
                .gap_5()
                .children(groups.iter().filter_map(|group| render_group(*group, window, cx)))
        });
        // The dialog scrolls its content when the window is too short.
        div()
            .id("keyboard-shortcuts")
            .test_support()
            .child(h_flex().items_start().gap_8().children(columns))
    }
}

/// A group's heading and its commands with bindings; nothing when none has
/// one.
fn render_group(group: CommandGroup, window: &Window, cx: &App) -> Option<impl IntoElement> {
    let rows: Vec<_> = COMMANDS
        .iter()
        .filter(|command| command.group == group)
        .filter_map(|command| {
            let bindings = bindings(command, window);
            (!bindings.is_empty()).then(|| render_row(command, bindings, cx))
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    Some(
        v_flex()
            .gap_1()
            .child(
                div()
                    .text_xs()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(cx.theme().muted_foreground)
                    .child(group.heading().get(cx)),
            )
            .children(rows),
    )
}

/// One command: its name, and its bindings at the right edge.
fn render_row(command: &CommandSpec, bindings: Vec<Keystroke>, cx: &App) -> impl IntoElement {
    let locale = Locale::current(cx);
    let label = command.label.in_locale(locale);
    let keys: Vec<String> = bindings.iter().map(Kbd::format).collect();
    let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
    let spoken: SharedString = words::SHORTCUT_LABEL
        .fill(locale, &[("command", label), ("keys", &copy::list(locale, &keys))])
        .into();
    h_flex()
        .id(domain_element_id("shortcut", command.id))
        .test_support()
        .aria_label(spoken)
        .min_h(rems(2.))
        .gap_3()
        .border_b_1()
        .border_color(cx.theme().border)
        .child(div().flex_1().min_w_0().text_sm().child(label))
        .child(h_flex().flex_shrink_0().gap_1().children(bindings.into_iter().map(Kbd::new)))
}
