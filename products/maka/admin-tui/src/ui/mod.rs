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

mod access;
mod components;
mod hosts;
mod logs;
mod overlays;
mod overview;
mod relay;
mod shell;
pub mod state;
mod system;
pub mod theme;

use crate::model::{AdminCommand, TabId};
use nsh_core::{element::desktop::quit, keymap::When, prelude::*};
use overlays::{execute_palette_selection, move_palette_selection};
use state::{
    Overlay, active_tab, close_overlay, cycle_host, logs_signal, open_command_palette,
    open_overlay, send_command, set_tab, ui_signal, wire_host_events,
};

#[component]
pub fn AdminApp() -> impl IntoElement {
    wire_host_events();
    bind_shortcuts();
    shell::shell()
}

fn bind_shortcuts() {
    let always = KeyOptions {
        when: When::Always,
        ..KeyOptions::default()
    };

    // Escape closes any open modal/palette even while an Input has focus.
    on_key_with("escape", always, |_| {
        if ui_signal().with(|u| u.overlay.is_open()) {
            close_overlay();
        }
    });

    // Command palette: Ctrl+P / Ctrl+K always work; ':' works outside text inputs.
    on_key_with("ctrl+p", always, |_| open_command_palette());
    on_key_with("ctrl+k", always, |_| open_command_palette());
    on_key("shift+;", |_| {
        if !ui_signal().with(|u| u.overlay.is_open()) {
            open_command_palette();
        }
    });

    // Help overlay: '?'
    on_key("shift+/", |_| {
        let is_help = ui_signal().with(|u| matches!(u.overlay, Overlay::Help));
        if is_help {
            close_overlay();
        } else if !ui_signal().with(|u| u.overlay.is_open()) {
            open_overlay(Overlay::Help);
        }
    });

    // Quit: 'q' outside inputs
    on_key("q", |_| {
        if ui_signal().with(|u| u.overlay.is_open()) {
            close_overlay();
        } else {
            quit();
        }
    });

    // Refresh: 'r' or Ctrl+R
    on_key("r", |_| {
        if !ui_signal().with(|u| u.overlay.is_open()) {
            send_command(AdminCommand::Refresh);
        }
    });
    on_key_with("ctrl+r", always, |_| {
        send_command(AdminCommand::Refresh);
    });

    // Direct tab switching: 1..6
    for tab in TabId::ALL {
        on_key(tab.key_digit(), move |_| {
            if !ui_signal().with(|u| u.overlay.is_open()) {
                set_tab(tab);
            }
        });
    }

    // Cycle tabs with [ and ]
    on_key("[", |_| {
        if !ui_signal().with(|u| u.overlay.is_open()) {
            set_tab(active_tab().prev());
        }
    });
    on_key("]", |_| {
        if !ui_signal().with(|u| u.overlay.is_open()) {
            set_tab(active_tab().next());
        }
    });

    // Host / Palette navigation: Up/Down and j/k
    let nav_down = || {
        if ui_signal().with(|u| matches!(u.overlay, Overlay::CommandPalette { .. })) {
            move_palette_selection(1);
        } else if !ui_signal().with(|u| u.overlay.is_open()) {
            cycle_host(1);
        }
    };
    let nav_up = || {
        if ui_signal().with(|u| matches!(u.overlay, Overlay::CommandPalette { .. })) {
            move_palette_selection(-1);
        } else if !ui_signal().with(|u| u.overlay.is_open()) {
            cycle_host(-1);
        }
    };

    on_key_with("down", always, move |_| {
        if ui_signal().with(|u| matches!(u.overlay, Overlay::CommandPalette { .. })) {
            move_palette_selection(1);
        } else if !ui_signal().with(|u| u.overlay.is_open()) {
            cycle_host(1);
        }
    });
    on_key_with("up", always, move |_| {
        if ui_signal().with(|u| matches!(u.overlay, Overlay::CommandPalette { .. })) {
            move_palette_selection(-1);
        } else if !ui_signal().with(|u| u.overlay.is_open()) {
            cycle_host(-1);
        }
    });
    on_key("j", move |_| nav_down());
    on_key("k", move |_| nav_up());

    // Enter inside command palette executes highlighted item even if input unfocused.
    on_key("enter", |_| {
        if ui_signal().with(|u| matches!(u.overlay, Overlay::CommandPalette { .. })) {
            execute_palette_selection();
        }
    });

    // Logs follow toggle ('f')
    on_key("f", |_| {
        if !ui_signal().with(|u| u.overlay.is_open()) && active_tab() == TabId::Logs {
            let next = !logs_signal().with(|l| l.0.follow);
            send_command(AdminCommand::SetLogFollow { follow: next });
        }
    });
}
