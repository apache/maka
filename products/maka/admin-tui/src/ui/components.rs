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
    model::HostHealth,
    ui::theme::{CELL_H, CELL_W, Tone, palette},
};
use nsh_base::button;
use nsh_core::{
    element::{AccessibilityRole, AccessibilityState, AnyElement},
    prelude::*,
};

pub fn health_tone(health: &HostHealth) -> Tone {
    match health {
        HostHealth::Running => Tone::Success,
        HostHealth::Draining | HostHealth::Incomplete => Tone::Warning,
        HostHealth::Stopped | HostHealth::NotInstalled => Tone::Muted,
        HostHealth::Error { .. } => Tone::Danger,
    }
}

pub fn remote_status_tone(status: &str) -> Tone {
    match status {
        "connected" => Tone::Success,
        "starting" => Tone::Warning,
        "error" => Tone::Danger,
        _ => Tone::Muted,
    }
}

/// Compact bordered card with header directly separated by a 1-row border.
pub fn panel_card(
    title: impl Into<SharedString>,
    right_meta: Option<AnyElement>,
    body: AnyElement,
) -> AnyElement {
    let title: SharedString = title.into();
    view()
        .border_1()
        .border_color(palette::BORDER)
        .rounded(px(4.0))
        .child(
            view().border_b_1().border_b_color(palette::BORDER).child(
                view()
                    .h(px(CELL_H))
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .px(px(CELL_W))
                    .child(
                        text(title)
                            .number_of_lines(1)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(palette::TEXT),
                    )
                    .children(right_meta),
            ),
        )
        .child(view().px(px(CELL_W)).child(body))
        .into_element()
}

pub fn badge(label: impl Into<SharedString>, tone: Tone) -> AnyElement {
    let label: SharedString = label.into();
    text(format!("{} {}", tone.dot(), label))
        .number_of_lines(1)
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(tone.color())
        .into_element()
}

pub fn kv_row(
    label: impl Into<SharedString>,
    value: impl Into<SharedString>,
    tone: Tone,
) -> AnyElement {
    let label: SharedString = label.into();
    let value: SharedString = value.into();
    view()
        .h(px(CELL_H))
        .flex_row()
        .items_center()
        .gap(px(CELL_W))
        .child(
            text(label)
                .w(px(17.0 * CELL_W))
                .number_of_lines(1)
                .text_color(palette::MUTED),
        )
        .child(
            text(value)
                .flex_1()
                .number_of_lines(1)
                .text_color(tone.color()),
        )
        .into_element()
}

pub fn kv_row_with_action(
    label: impl Into<SharedString>,
    value: impl Into<SharedString>,
    tone: Tone,
    action_label: impl Into<SharedString>,
    on_press: impl Fn() + 'static,
) -> AnyElement {
    let label: SharedString = label.into();
    let value: SharedString = value.into();
    let action_label: SharedString = action_label.into();
    view()
        .h(px(CELL_H))
        .flex_row()
        .items_center()
        .gap(px(CELL_W))
        .child(
            text(label)
                .w(px(17.0 * CELL_W))
                .number_of_lines(1)
                .text_color(palette::MUTED),
        )
        .child(
            text(value)
                .flex_1()
                .number_of_lines(1)
                .text_color(tone.color()),
        )
        .child(inline_link(action_label, Tone::Accent, on_press))
        .into_element()
}

pub fn metric_tile(
    label: impl Into<SharedString>,
    value: impl Into<SharedString>,
    detail: impl Into<SharedString>,
    tone: Tone,
) -> AnyElement {
    let label: SharedString = label.into();
    let value: SharedString = value.into();
    let detail: SharedString = detail.into();
    view()
        .flex_1()
        .border_1()
        .border_color(palette::BORDER)
        .rounded(px(4.0))
        .px(px(CELL_W))
        .child(
            text(label)
                .h(px(CELL_H))
                .number_of_lines(1)
                .text_color(palette::MUTED),
        )
        .child(
            text(value)
                .h(px(CELL_H))
                .number_of_lines(1)
                .font_weight(FontWeight::BOLD)
                .text_color(tone.color()),
        )
        .child(
            text(detail)
                .h(px(CELL_H))
                .number_of_lines(1)
                .text_color(palette::FAINT),
        )
        .into_element()
}

pub fn action_btn(
    label: impl Into<SharedString>,
    tone: Tone,
    disabled: bool,
    on_press: impl Fn() + 'static,
) -> AnyElement {
    let label: SharedString = label.into();
    button()
        .disabled(disabled)
        .accessibility_label(Some(label.clone()))
        .on_press(on_press)
        .h(px(CELL_H))
        .px(px(CELL_W))
        .bg(palette::RAISED)
        .hover(|s| s.bg(palette::BORDER))
        .active(|s| s.opacity(0.75))
        .disabled_style(|s| s.opacity(0.4))
        .child(
            text(label)
                .number_of_lines(1)
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(tone.color()),
        )
        .into_element()
}

pub fn inline_link(
    label: impl Into<SharedString>,
    tone: Tone,
    on_press: impl Fn() + 'static,
) -> AnyElement {
    let label: SharedString = label.into();
    button()
        .accessibility_label(Some(label.clone()))
        .on_press(on_press)
        .h(px(CELL_H))
        .child(
            text(format!("[{label}]"))
                .number_of_lines(1)
                .text_color(tone.color()),
        )
        .into_element()
}

pub fn filter_chip(
    label: impl Into<SharedString>,
    selected: bool,
    on_press: impl Fn() + 'static,
) -> AnyElement {
    let label: SharedString = label.into();
    view()
        .h(px(CELL_H))
        .px(px(CELL_W))
        .role(AccessibilityRole::Button)
        .label(label.clone())
        .accessibility_state(AccessibilityState {
            selected,
            ..AccessibilityState::default()
        })
        .style_when(selected, |s| s.bg(palette::RAISED))
        .on_press(on_press)
        .child(
            text(label)
                .number_of_lines(1)
                .font_weight(if selected {
                    FontWeight::BOLD
                } else {
                    FontWeight::NORMAL
                })
                .text_color(if selected {
                    palette::ACCENT
                } else {
                    palette::MUTED
                }),
        )
        .into_element()
}

pub fn notice_banner(message: impl Into<SharedString>, tone: Tone) -> AnyElement {
    let message: SharedString = message.into();
    view()
        .bg(palette::RAISED)
        .border_1()
        .border_color(tone.color())
        .px(px(CELL_W))
        .child(text(format!("{} {}", tone.dot(), message)).text_color(tone.color()))
        .into_element()
}

pub fn empty_state(title: impl Into<SharedString>, hint: impl Into<SharedString>) -> AnyElement {
    let title: SharedString = title.into();
    let hint: SharedString = hint.into();
    view()
        .px(px(CELL_W))
        .py(px(CELL_H))
        .child(
            text(title)
                .h(px(CELL_H))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(palette::MUTED),
        )
        .child(text(hint).text_color(palette::FAINT))
        .into_element()
}

pub fn section_heading(label: impl Into<SharedString>) -> AnyElement {
    let label: SharedString = label.into();
    text(label)
        .h(px(CELL_H))
        .number_of_lines(1)
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(palette::FAINT)
        .into_element()
}

pub fn format_uptime(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}h {m:02}m {s:02}s")
    } else if m > 0 {
        format!("{m}m {s:02}s")
    } else {
        format!("{s}s")
    }
}

pub fn short_hash(value: &str) -> String {
    if value.len() > 16 {
        format!("{}…{}", &value[..8], &value[value.len() - 6..])
    } else {
        value.to_owned()
    }
}
