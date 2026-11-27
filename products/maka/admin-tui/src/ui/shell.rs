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

use crate::{
    model::{LocalRelayState, LogLevel, TabId, ToastTone},
    ui::{
        access::access_screen,
        components::{badge, health_tone},
        hosts::hosts_screen,
        logs::logs_screen,
        overlays::overlay_layer,
        overview::overview_screen,
        relay::relay_screen,
        state::{active_tab, cycle_host, logs_signal, set_tab, snapshot_signal, toast_signal},
        system::system_screen,
        theme::{CELL_H, CELL_W, Tone, is_compact, palette},
    },
};
use nsh_core::{
    element::{AccessibilityRole, AccessibilityState, AnyElement},
    prelude::*,
};

pub fn shell() -> AnyElement {
    view()
        .flex_1()
        .bg(palette::BG)
        .child(top_bar())
        .child(body_area())
        .child(footer_bar())
        .child(overlay_layer())
        .into_element()
}

fn top_bar() -> AnyElement {
    view()
        .flex_shrink_0()
        .border_b_1()
        .border_b_color(palette::BORDER)
        .child(dynamic(move || {
            let snap = snapshot_signal().with(|s| s.0.clone());
            let host_pill = match snap.selected_host() {
                Some(host) => {
                    let tone = health_tone(&host.health);
                    let pid_part = host
                        .runtime
                        .as_ref()
                        .map(|r| format!(" pid {}", r.pid))
                        .unwrap_or_default();
                    badge(format!("{}{pid_part}", host.label), tone)
                }
                None => badge("No Host", Tone::Muted),
            };
            let relay_pill = match &snap.local_relay {
                LocalRelayState::Running(rt) => {
                    let short = rt
                        .https_addr
                        .as_deref()
                        .or(rt.http_addr.as_deref())
                        .unwrap_or("up");
                    badge(format!("Relay {short}"), Tone::Accent)
                }
                LocalRelayState::Error { .. } => badge("Relay error", Tone::Danger),
                LocalRelayState::Stopped => badge("Relay off", Tone::Muted),
            };
            let right_status = if let Some(busy) = &snap.busy_label {
                text(format!("◐ {busy}"))
                    .number_of_lines(1)
                    .text_color(palette::WARNING)
            } else if snap.refreshed_at.is_empty() {
                text("Loading…").text_color(palette::FAINT)
            } else {
                text(format!("Synced {}", snap.refreshed_at))
                    .number_of_lines(1)
                    .text_color(palette::FAINT)
            };

            view()
                .h(px(CELL_H))
                .flex_row()
                .items_center()
                .justify_between()
                .px(px(CELL_W))
                .gap(px(2.0 * CELL_W))
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap(px(2.0 * CELL_W))
                        .child(
                            text("◆ MAKA ADMIN")
                                .font_weight(FontWeight::BOLD)
                                .text_color(palette::ACCENT),
                        )
                        .child(host_pill)
                        .child(relay_pill),
                )
                .child(right_status)
                .into_element()
        }))
        .into_element()
}

fn body_area() -> AnyElement {
    dynamic(move || {
        if is_compact() {
            view()
                .flex_1()
                .child(compact_tab_strip())
                .child(main_pane())
                .into_element()
        } else {
            view()
                .flex_1()
                .flex_row()
                .child(left_rail())
                .child(main_pane())
                .into_element()
        }
    })
    .into_element()
}

fn tab_badge(tab: TabId) -> (String, Tone) {
    match tab {
        TabId::Hosts => snapshot_signal().with(|s| {
            let live = s.0.hosts.iter().filter(|h| h.health.is_live()).count();
            let total = s.0.hosts.len();
            (
                format!("{live}/{total}"),
                if live > 0 { Tone::Success } else { Tone::Muted },
            )
        }),
        TabId::Relay => snapshot_signal().with(|s| match &s.0.local_relay {
            LocalRelayState::Running(_) => ("ON".to_owned(), Tone::Success),
            LocalRelayState::Error { .. } => ("ERR".to_owned(), Tone::Danger),
            LocalRelayState::Stopped => (String::new(), Tone::Muted),
        }),
        TabId::Access => snapshot_signal().with(|s| {
            let count = s.0.selected_host().map(|h| h.peers.len()).unwrap_or(0);
            if count > 0 {
                (count.to_string(), Tone::Peer)
            } else {
                (String::new(), Tone::Muted)
            }
        }),
        TabId::Logs => logs_signal().with(|l| {
            let errs =
                l.0.lines
                    .iter()
                    .filter(|line| line.level == LogLevel::Error)
                    .count();
            if errs > 0 {
                (format!("{errs}!"), Tone::Danger)
            } else {
                (String::new(), Tone::Muted)
            }
        }),
        TabId::Overview | TabId::System => (String::new(), Tone::Muted),
    }
}

fn left_rail() -> AnyElement {
    let nav_items: Vec<AnyElement> = TabId::ALL
        .iter()
        .copied()
        .map(|tab| {
            let is_active = move || active_tab() == tab;
            view()
                .h(px(CELL_H))
                .flex_row()
                .items_center()
                .px(px(CELL_W))
                .gap(px(CELL_W))
                .role(AccessibilityRole::Button)
                .label(tab.label())
                .accessibility_state(move || AccessibilityState {
                    selected: is_active(),
                    ..AccessibilityState::default()
                })
                .style_when(is_active, |s| s.bg(palette::RAISED))
                .on_press(move || set_tab(tab))
                .child(text(tab.key_digit()).w(px(CELL_W)).text_color(move || {
                    if is_active() {
                        palette::ACCENT
                    } else {
                        palette::FAINT
                    }
                }))
                .child(
                    text(tab.label())
                        .flex_1()
                        .number_of_lines(1)
                        .style_when(is_active, |s| s.font_weight(FontWeight::BOLD))
                        .text_color(move || {
                            if is_active() {
                                palette::TEXT
                            } else {
                                palette::MUTED
                            }
                        }),
                )
                .child(dynamic(move || {
                    let (b, tone) = tab_badge(tab);
                    if b.is_empty() {
                        view().into_element()
                    } else {
                        text(b).text_color(tone.color()).into_element()
                    }
                }))
                .into_element()
        })
        .collect();

    let host_footer = view()
        .border_t_1()
        .border_t_color(palette::BORDER)
        .px(px(CELL_W))
        .child(dynamic(move || {
            let snap = snapshot_signal().with(|s| s.0.clone());
            let total = snap.hosts.len();
            let current_name = snap
                .selected_host()
                .map(|h| h.label.clone())
                .unwrap_or_else(|| "None".to_owned());
            let version = snap.system.version.clone();
            view()
                .child(text("TARGET HOST").h(px(CELL_H)).text_color(palette::FAINT))
                .child(
                    view()
                        .h(px(CELL_H))
                        .role(AccessibilityRole::Button)
                        .label("Switch Target Host")
                        .on_press(|| cycle_host(1))
                        .child(
                            text(format!("▸ {current_name}"))
                                .number_of_lines(1)
                                .text_color(palette::ACCENT),
                        ),
                )
                .child(
                    text(format!("{total} roots · v{version}"))
                        .h(px(CELL_H))
                        .number_of_lines(1)
                        .text_color(palette::FAINT),
                )
                .into_element()
        }));

    view()
        .w(px(22.0 * CELL_W))
        .border_r_1()
        .border_r_color(palette::BORDER)
        .child(
            text("CONTROL PLANE")
                .h(px(CELL_H))
                .px(px(CELL_W))
                .text_color(palette::FAINT),
        )
        .child(view().flex_1().children(nav_items))
        .child(host_footer)
        .into_element()
}

fn compact_tab_strip() -> AnyElement {
    let tabs: Vec<AnyElement> = TabId::ALL
        .iter()
        .copied()
        .map(|tab| {
            let is_active = move || active_tab() == tab;
            view()
                .h(px(CELL_H))
                .px(px(CELL_W))
                .role(AccessibilityRole::Button)
                .label(tab.label())
                .style_when(is_active, |s| s.bg(palette::RAISED))
                .on_press(move || set_tab(tab))
                .child(
                    text(format!("{} {}", tab.key_digit(), tab.label()))
                        .number_of_lines(1)
                        .style_when(is_active, |s| s.font_weight(FontWeight::BOLD))
                        .text_color(move || {
                            if is_active() {
                                palette::ACCENT
                            } else {
                                palette::MUTED
                            }
                        }),
                )
                .into_element()
        })
        .collect();

    view()
        .flex_shrink_0()
        .border_b_1()
        .border_b_color(palette::BORDER)
        .child(view().h(px(CELL_H)).flex_row().children(tabs))
        .into_element()
}

fn main_pane() -> AnyElement {
    let pane_header = view()
        .flex_shrink_0()
        .border_b_1()
        .border_b_color(palette::BORDER)
        .child(dynamic(move || {
            let tab = active_tab();
            view()
                .h(px(CELL_H))
                .flex_row()
                .items_center()
                .gap(px(2.0 * CELL_W))
                .px(px(CELL_W))
                .child(
                    text(tab.label())
                        .font_weight(FontWeight::BOLD)
                        .text_color(palette::TEXT),
                )
                .child(
                    text(tab.subtitle())
                        .flex_1()
                        .number_of_lines(1)
                        .text_color(palette::FAINT),
                )
                .into_element()
        }));

    let content = dynamic(move || match active_tab() {
        TabId::Overview => overview_screen(),
        TabId::Hosts => hosts_screen(),
        TabId::Relay => relay_screen(),
        TabId::Access => access_screen(),
        TabId::Logs => logs_screen(),
        TabId::System => system_screen(),
    });

    view()
        .flex_1()
        .bg(palette::BG)
        .child(pane_header)
        .child(view().flex_1().child(content))
        .into_element()
}

fn footer_bar() -> AnyElement {
    view()
        .flex_shrink_0()
        .border_t_1()
        .border_t_color(palette::BORDER)
        .child(dynamic(move || {
            if let Some(toast) = toast_signal().with(|t| t.0.clone()) {
                let tone = match toast.tone {
                    ToastTone::Info => Tone::Primary,
                    ToastTone::Success => Tone::Success,
                    ToastTone::Warning => Tone::Warning,
                    ToastTone::Danger => Tone::Danger,
                };
                return view()
                    .h(px(CELL_H))
                    .flex_row()
                    .items_center()
                    .px(px(CELL_W))
                    .child(
                        text(format!("{} {}", tone.dot(), toast.message))
                            .flex_1()
                            .number_of_lines(1)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(tone.color()),
                    )
                    .into_element();
            }

            let tab = active_tab();
            let context_hint = match tab {
                TabId::Logs => "f Follow · r Refresh · / Filter",
                TabId::Hosts => "↑/↓ Switch Host · r Refresh",
                _ => "↑/↓ Host · r Refresh",
            };

            view()
                .h(px(CELL_H))
                .flex_row()
                .items_center()
                .justify_between()
                .px(px(CELL_W))
                .child(
                    text(format!(
                        "1-6 Tabs · {context_hint} · : Palette · ? Help · q Quit"
                    ))
                    .flex_1()
                    .number_of_lines(1)
                    .text_color(palette::MUTED),
                )
                .into_element()
        }))
        .into_element()
}
