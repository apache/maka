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

//! The Maka desktop shell: one window that composes the feature crates.
//!
//! `main.rs` only parses arguments and opens the window; everything a test
//! needs to build the same window lives here.

mod bot_link;
pub mod commands;
mod dock_icon;
mod empty_state;
mod host_blocked;
mod palette;
mod pet_companion;
mod shortcuts;
mod sidebar_layout;
mod state_root_dialog;
mod workbench;

use gpui_kit::component::Root;
use gpui_kit::{
    Action, AnyView, App, Context, KeyBinding, Menu, MenuItem, Styled as _, Window, relative, rems,
};
use settings::FontSizeStep;
use shared::copy::{self, Locale};
use shared::theme::{BODY_LINE_HEIGHT, BODY_TEXT_REMS};
use workspace::actions::{
    AddConnection, FocusComposer, GoBack, GoForward, NewSession, OpenCommandPalette, OpenSettings,
    Reconnect, ResetZoom, SendMessage, ShowKeyboardShortcuts, StopTurn, SwitchStateRoot,
    ToggleReview, ToggleSidebar, ZoomIn, ZoomOut,
};

pub use bot_link::link_bots;
pub use dock_icon::set_dock_icon;
pub use palette::CommandPalette;
pub use pet_companion::PetWatch;
pub use sidebar_layout::SidebarForm;
pub use state_root_dialog::{
    BuildWorkbench, StartupView, StateRootPicker, StateRootSetup, open_state_root_dialog,
    show_workbench, show_workbench_on,
};
pub use workbench::{
    CHROME_HEIGHT_REMS, PassivePointer, SIDEBAR_OVERLAY_CONTEXT, SIDEBAR_RESIZE_CONTEXT, Workbench,
};

gpui_kit::actions!(
    maka_app,
    [
        /// Quit the application.
        Quit,
    ]
);

/// The context of a binding the macOS menu bar must not show. GPUI's menu
/// shows a command's first binding that fits its stock menu context
/// (Workspace > Pane > Editor); no element of this app sets `Workspace`,
/// so a binding in this context still works wherever the app has focus.
const MENU_SKIPS: &str = "!Workspace";

/// The window's `Root` around `view`, with Maka's body type (14px on 20px
/// lines, see `shared::theme`) as the default for all text inside it, the
/// overlays included.
pub fn window_root(view: impl Into<AnyView>, window: &mut Window, cx: &mut Context<Root>) -> Root {
    Root::new(view, window, cx)
        .text_size(rems(BODY_TEXT_REMS))
        .line_height(relative(BODY_LINE_HEIGHT))
}

/// Registers key bindings, the menu bar, and app-level action handlers.
/// Call once after `gpui_kit::init`, before opening a window.
pub fn init(cx: &mut App) {
    settings::init(cx);
    session::init(cx);
    conversation::init(cx);
    extensions::init(cx);
    automations::init(cx);
    review::init(cx);
    // Bindings first: `set_menus` copies each item's shortcut from the keymap.
    cx.bind_keys([
        KeyBinding::new("secondary-n", NewSession, None),
        KeyBinding::new("secondary-l", FocusComposer, None),
        KeyBinding::new("secondary-enter", SendMessage, None),
        KeyBinding::new("secondary-.", StopTurn, None),
        KeyBinding::new("secondary-r", Reconnect, None),
        KeyBinding::new("secondary-b", ToggleSidebar, None),
        KeyBinding::new("secondary-[", GoBack, None),
        KeyBinding::new("secondary-]", GoForward, None),
        KeyBinding::new("secondary-,", OpenSettings, None),
        // ⌘K is the palette's shortcut (Desktop's); ⇧⌘P opens it too, as in
        // editors. Hints show the later binding; the menu bar the first
        // that fits its context, which ⇧⌘P's does not (`MENU_SKIPS`).
        KeyBinding::new("secondary-shift-p", OpenCommandPalette, Some(MENU_SKIPS)),
        KeyBinding::new("secondary-k", OpenCommandPalette, None),
        KeyBinding::new("secondary-/", ShowKeyboardShortcuts, None),
        KeyBinding::new("secondary-q", Quit, None),
        // Zoom: + takes Shift on most layouts, so ⌘= and ⌘+ both zoom in,
        // with Shift or without. The menu bar shows a command's first
        // binding: ⌘+.
        KeyBinding::new("secondary-+", ZoomIn, None),
        KeyBinding::new("secondary-shift-+", ZoomIn, None),
        KeyBinding::new("secondary-=", ZoomIn, None),
        KeyBinding::new("secondary-shift-=", ZoomIn, None),
        KeyBinding::new("secondary--", ZoomOut, None),
        KeyBinding::new("secondary-0", ResetZoom, None),
        // The changes panel: Desktop's `ctrl+shift+g`, the Control key on
        // every platform, macOS included.
        KeyBinding::new("ctrl-shift-g", ToggleReview, None),
    ]);
    // The sidebar's edge, while its handle has focus (Desktop's separator
    // keys).
    let resize = Some(SIDEBAR_RESIZE_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("left", workbench::NarrowSidebarStep, resize),
        KeyBinding::new("right", workbench::WidenSidebarStep, resize),
        KeyBinding::new("shift-left", workbench::NarrowSidebarLargeStep, resize),
        KeyBinding::new("shift-right", workbench::WidenSidebarLargeStep, resize),
        KeyBinding::new("enter", workbench::ResetSidebarWidth, resize),
        // The sidebar over the plate.
        KeyBinding::new("escape", workbench::CloseSidebarOverlay, Some(SIDEBAR_OVERLAY_CONTEXT)),
    ]);
    // The changes panel's edge, while its handle has focus: Left moves the
    // edge toward the plate, widening the panel.
    let review = Some(workbench::REVIEW_RESIZE_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("left", workbench::WidenReviewStep, review),
        KeyBinding::new("right", workbench::NarrowReviewStep, review),
        KeyBinding::new("shift-left", workbench::WidenReviewLargeStep, review),
        KeyBinding::new("shift-right", workbench::NarrowReviewLargeStep, review),
        KeyBinding::new("enter", workbench::ResetReviewWidth, review),
    ]);
    cx.on_action(|_: &Quit, cx| cx.quit());
    // The UI font size is the app's, so every window zooms from here,
    // whatever has focus; at either end of the range a press does nothing.
    cx.on_action(|_: &ZoomIn, cx| settings::step_ui_font_size(FontSizeStep::Larger, cx));
    cx.on_action(|_: &ZoomOut, cx| settings::step_ui_font_size(FontSizeStep::Smaller, cx));
    cx.on_action(|_: &ResetZoom, cx| settings::step_ui_font_size(FontSizeStep::Default, cx));
    fallback(cx, Workbench::new_session);
    fallback(cx, Workbench::focus_composer);
    fallback(cx, Workbench::send_message);
    fallback(cx, Workbench::stop_turn);
    fallback(cx, Workbench::reconnect);
    fallback(cx, Workbench::toggle_sidebar);
    fallback(cx, Workbench::go_back);
    fallback(cx, Workbench::go_forward);
    fallback(cx, Workbench::open_settings);
    fallback(cx, Workbench::add_connection);
    fallback(cx, Workbench::open_project_settings);
    fallback(cx, Workbench::switch_state_root);
    fallback(cx, Workbench::switch_host_action);
    fallback(cx, Workbench::open_command_palette);
    fallback(cx, Workbench::archive_task);
    fallback(cx, Workbench::flag_task);
    fallback(cx, Workbench::show_keyboard_shortcuts);
    fallback(cx, Workbench::open_extensions);
    fallback(cx, Workbench::open_scheduled_tasks);
    fallback(cx, Workbench::toggle_review);
    fallback(cx, Workbench::toggle_review_maximized);
    cx.set_menus(menus(cx));
    // The menu bar is the platform's copy of the menus: rebuild it in the
    // new language.
    cx.observe_global::<Locale>(|cx| cx.set_menus(menus(cx))).detach();
}

/// Handles `A` at app level for when no element has focus: then a menu item
/// dispatches to the window's root, which is not on the path to the
/// Workbench's own handlers. When something has focus the Workbench handles
/// the Action first and this never runs.
fn fallback<A: Action + Clone>(
    cx: &mut App,
    handler: fn(&mut Workbench, &A, &mut Window, &mut Context<Workbench>),
) {
    cx.on_action(move |action: &A, cx| {
        let action = action.clone();
        // App-level handlers run while the window is borrowed for dispatch;
        // reach it once that dispatch has returned.
        cx.defer(move |cx| {
            workbench::with_active_workbench(cx, move |workbench, window, cx| {
                handler(workbench, &action, window, cx);
            });
        });
    });
}

fn menus(cx: &App) -> Vec<Menu> {
    vec![
        Menu::new(copy::APP_NAME.get(cx)).items([
            MenuItem::action(copy::MENU_SETTINGS.get(cx), OpenSettings),
            MenuItem::separator(),
            MenuItem::action(copy::MENU_QUIT.get(cx), Quit),
        ]),
        Menu::new(copy::MENU_TASK.get(cx)).items([
            MenuItem::action(copy::MENU_NEW_TASK.get(cx), NewSession),
            MenuItem::separator(),
            MenuItem::action(copy::MENU_FOCUS_COMPOSER.get(cx), FocusComposer),
            MenuItem::action(copy::MENU_SEND.get(cx), SendMessage),
            MenuItem::action(copy::MENU_STOP.get(cx), StopTurn),
        ]),
        Menu::new(copy::MENU_VIEW.get(cx)).items([
            MenuItem::action(copy::MENU_COMMAND_PALETTE.get(cx), OpenCommandPalette),
            MenuItem::action(copy::MENU_KEYBOARD_SHORTCUTS.get(cx), ShowKeyboardShortcuts),
            MenuItem::action(copy::MENU_TOGGLE_SIDEBAR.get(cx), ToggleSidebar),
            MenuItem::separator(),
            MenuItem::action(copy::MENU_GO_BACK.get(cx), GoBack),
            MenuItem::action(copy::MENU_GO_FORWARD.get(cx), GoForward),
            // Desktop's View menu (Electron's resetZoom, zoomIn, zoomOut).
            MenuItem::separator(),
            MenuItem::action(copy::MENU_ACTUAL_SIZE.get(cx), ResetZoom),
            MenuItem::action(copy::MENU_ZOOM_IN.get(cx), ZoomIn),
            MenuItem::action(copy::MENU_ZOOM_OUT.get(cx), ZoomOut),
        ]),
        Menu::new(copy::MENU_HOST.get(cx)).items([
            MenuItem::action(copy::MENU_RECONNECT.get(cx), Reconnect),
            MenuItem::separator(),
            MenuItem::action(copy::MENU_ADD_CONNECTION.get(cx), AddConnection),
            MenuItem::separator(),
            MenuItem::action(copy::MENU_SWITCH_STATE_ROOT.get(cx), SwitchStateRoot),
        ]),
    ]
}

#[cfg(test)]
mod chrome_tests;
#[cfg(test)]
mod draft_tests;
#[cfg(test)]
mod font_size_tests;
#[cfg(test)]
mod host_blocked_tests;
#[cfg(test)]
mod host_switch_tests;
#[cfg(test)]
mod pet_tests;
#[cfg(test)]
mod review_tests;
#[cfg(test)]
mod sidebar_tests;
#[cfg(test)]
mod state_root_tests;
#[cfg(test)]
mod strip_tests;
#[cfg(test)]
mod tests;
