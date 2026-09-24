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

mod chat;
mod host;
mod md;
mod sidebar;
mod theme;
mod ui;
mod workspace;

use gpui_kit::{
    component::{Root, Theme as KitTheme, ThemeMode},
    *,
};
use maka_event_log::root::RootNamespaces;
use std::path::PathBuf;
use theme::Theme;

actions!(maka, [Quit, Hide, CloseWindow]);

fn default_root() -> Result<PathBuf, String> {
    let namespaces = RootNamespaces::for_current_account().map_err(|error| error.to_string())?;
    namespaces
        .ownership
        .parent()
        .map(|parent| parent.join("runtime-host-rust"))
        .ok_or_else(|| "missing account data directory".into())
}

fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let root = match (args.next().as_deref(), args.next()) {
        (Some("--root"), Some(root)) => PathBuf::from(root),
        (None, _) => default_root()?,
        _ => return Err("usage: maka-desktop [--root <state-root>]".into()),
    };
    let host = host::Host::new().map_err(|error| error.to_string())?;
    let app = gpui_kit::application().with_assets(ui::Assets);
    // Closing hides the app with its window, as the Dock brings it back.
    app.on_reopen(|cx| cx.activate(true));
    app.run(move |cx| {
        gpui_kit::init(cx);
        cx.set_global(host);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_action(|_: &Hide, cx| cx.hide());
        cx.on_action(|_: &CloseWindow, cx| cx.hide());
        cx.set_menus([
            Menu::new("Maka").items([
                MenuItem::action("新建会话", workspace::NewSession),
                MenuItem::separator(),
                MenuItem::os_submenu("服务", SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action("隐藏 Maka", Hide),
                MenuItem::action("退出 Maka", Quit),
            ]),
            Menu::new("窗口").items([
                MenuItem::action("最小化", workspace::Minimize),
                MenuItem::action("关闭窗口", CloseWindow),
            ]),
        ]);
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-h", Hide, None),
            KeyBinding::new("cmd-w", CloseWindow, None),
            KeyBinding::new("cmd-m", workspace::Minimize, None),
            KeyBinding::new("cmd-n", workspace::NewSession, None),
            KeyBinding::new("cmd-c", chat::CopySelection, Some("Transcript")),
            // Every Enter chord but plain Enter starts a new line.
            KeyBinding::new(
                "ctrl-enter",
                component::input::Enter {
                    secondary: false,
                    shift: true,
                },
                Some("Input"),
            ),
            KeyBinding::new(
                "alt-enter",
                component::input::Enter {
                    secondary: false,
                    shift: true,
                },
                Some("Input"),
            ),
        ]);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::centered(size(px(1280.), px(840.)), cx)),
            window_min_size: Some(size(px(860.), px(560.))),
            titlebar: Some(TitlebarOptions {
                title: Some("Maka".into()),
                appears_transparent: true,
                traffic_light_position: Some(point(px(16.), px(17.))),
            }),
            ..Default::default()
        };
        cx.open_window(options, |window, cx| {
            window.on_window_should_close(cx, |_, cx| {
                cx.hide();
                false
            });
            apply_theme(window, cx);
            window
                .observe_window_appearance(|window, cx| {
                    apply_theme(window, cx);
                    window.refresh();
                })
                .detach();
            let view = cx.new(|cx| workspace::Workspace::new(root, window, cx));
            cx.new(|cx| Root::new(view, window, cx))
        })
        .expect("failed to open window");
        cx.activate(true);
    });
    Ok(())
}

/// Our palette, and gpui-kit's text field drawn in it.
fn apply_theme(window: &mut Window, cx: &mut App) {
    let theme = Theme::for_appearance(window.appearance());
    let mode = if theme.dark {
        ThemeMode::Dark
    } else {
        ThemeMode::Light
    };
    KitTheme::change(mode, Some(window), cx);
    let kit = KitTheme::global_mut(cx);
    kit.colors.foreground = theme.text;
    kit.colors.muted_foreground = theme.muted;
    kit.colors.caret = theme.accent;
    kit.colors.selection = theme.selection;
    kit.colors.background = theme.raised;
    kit.font_family = theme.ui_font.clone();
    cx.set_global(theme);
}
