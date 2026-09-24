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

use super::{
    Chat,
    rows::{Ending, Entry, Row},
    tools::{self, Kind},
};
use crate::{
    md::view::{self as md, Metrics, Scope},
    theme::{Theme, theme},
    ui::{self, icon, icon_button, motion, select::Key},
};
use chrono::{Local, TimeZone};
use gpui_kit::{
    AnyElement, App, Context, Div, Entity, FontWeight, InteractiveElement, IntoElement,
    MouseButton, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled,
    StyledText, Window, component::input, div, list, prelude::FluentBuilder, px,
};
use std::time::{Duration, Instant};

/// The reading column, shared by the transcript and the composer.
pub(super) const COLUMN: f32 = 720.;

impl Chat {
    fn scope<'a>(
        &'a self,
        row: &'a SharedString,
        metrics: Metrics,
        color: gpui_kit::Hsla,
    ) -> Scope<'a> {
        Scope {
            row,
            metrics,
            color,
            selection: &self.selection,
            copied: &self.copied,
            now: self.now,
        }
    }

    fn render_row(&self, ix: usize, this: &Entity<Chat>, cx: &App) -> AnyElement {
        let Some(row) = self.fold.get(ix) else {
            return div().into_any_element();
        };
        let theme = theme(cx);
        let entries = &self.transcript.entries;
        let key: SharedString = self.keys[ix].clone().into();
        let (content, turn): (AnyElement, Option<&str>) = match row {
            Row::Prompt(entry) => (self.prompt(*entry, &key, theme, cx), None),
            Row::Text(entry) => (self.reply(*entry, theme, cx), Some(entries[*entry].turn())),
            Row::Work { items, live } => (
                self.work(ix, &key, items, *live, this, theme, cx),
                Some(entries[items[0]].turn()),
            ),
            Row::Summary { turn, open } => (self.summary(turn, *open, this, theme), Some(turn)),
            Row::Notice { turn, text } => (
                div()
                    .flex()
                    .gap(px(8.))
                    .items_start()
                    .text_size(px(13.))
                    .line_height(px(18.))
                    .text_color(theme.danger)
                    .child(
                        icon("icons/triangle-alert.svg", theme.danger)
                            .size(px(13.))
                            .mt(px(2.)),
                    )
                    .child(text.clone())
                    .into_any_element(),
                Some(turn),
            ),
            Row::Footer { turn } => (self.footer(turn, this, theme, cx), Some(turn)),
            Row::Working => (self.working(theme), None),
        };
        let top = match row {
            _ if ix == 0 => 22.,
            Row::Prompt(_) => 48.,
            Row::Footer { .. } => 0.,
            _ => 8.,
        };
        let shell = div()
            .id(key)
            .w_full()
            .flex()
            .justify_center()
            .px(px(20.))
            .pt(px(top))
            .pb(px(8.))
            .child(div().w_full().max_w(px(COLUMN)).min_w_0().child(content));
        match turn {
            Some(turn) => {
                let turn = turn.to_owned();
                let chat = this.downgrade();
                shell
                    .on_hover(move |hovered, _, cx| {
                        let _ = chat.update(cx, |chat, cx| {
                            let next = hovered.then(|| turn.clone());
                            if (*hovered || chat.hovered_turn.as_deref() == Some(turn.as_str()))
                                && chat.hovered_turn != next
                            {
                                chat.hovered_turn = next;
                                cx.notify();
                            }
                        });
                    })
                    .into_any_element()
            }
            None => shell.into_any_element(),
        }
    }

    fn prompt(&self, entry: usize, key: &SharedString, theme: &Theme, cx: &App) -> AnyElement {
        let body = self
            .bodies
            .get(&format!("prompt:{}", self.transcript.entries[entry].id()));
        div()
            .flex()
            .justify_end()
            .child(
                div()
                    .max_w(px(540.))
                    .min_w_0()
                    .rounded(px(12.))
                    .bg(theme.text.opacity(0.055))
                    .px(px(11.))
                    .py(px(7.))
                    .when_some(body, |this, body| {
                        this.child(md::render(
                            body,
                            &self.scope(key, md::PROMPT, theme.text),
                            cx,
                        ))
                    }),
            )
            .into_any_element()
    }

    fn reply(&self, entry: usize, theme: &Theme, cx: &App) -> AnyElement {
        let id = self.transcript.entries[entry].id();
        let key: SharedString = format!("text:{id}").into();
        match self.bodies.get(key.as_ref()) {
            Some(body) => div()
                .py(px(4.))
                .child(md::render(
                    body,
                    &self.scope(&key, md::BODY, theme.text),
                    cx,
                ))
                .into_any_element(),
            None => div().into_any_element(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn work(
        &self,
        row: usize,
        key: &SharedString,
        items: &[usize],
        live: bool,
        this: &Entity<Chat>,
        theme: &Theme,
        cx: &App,
    ) -> AnyElement {
        let entries = &self.transcript.entries;
        let open = self.toggled.get(key.as_ref()).copied().unwrap_or(live);
        let calls: Vec<&Entry> = items.iter().map(|ix| &entries[*ix]).collect();
        let title = if live {
            calls
                .last()
                .map(|entry| live_title(entry))
                .unwrap_or_default()
        } else {
            tools::summary(&calls, false)
        };
        let chat = this.downgrade();
        let toggle_key = key.to_string();
        let group = SharedString::from(format!("{key}:header"));
        let header = ui::pressable(
            div()
                .id(group.clone())
                .group(group.clone())
                .h(px(26.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(6.))
                .text_size(px(12.5))
                .line_height(px(16.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.muted)
                .hover(|style| style.text_color(theme.text))
                .focus_visible(|style| style.text_color(theme.text))
                .child(div().min_w_0().truncate().child(title))
                .child(
                    icon(
                        if open {
                            "icons/chevron-down.svg"
                        } else {
                            "icons/chevron-right.svg"
                        },
                        theme.muted,
                    )
                    .size(px(10.))
                    .group_hover(group, |style| style.text_color(theme.text)),
                ),
            move |_, cx| {
                let key = toggle_key.clone();
                let _ = chat.update(cx, |chat, cx| chat.toggle(key, !open, row, cx));
            },
        );
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(header)
            .when(open, |this_div| {
                this_div.child(
                    div()
                        .ml(px(6.))
                        .pl(px(12.))
                        .pb(px(2.))
                        .border_l_1()
                        .border_color(theme.border)
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .children(items.iter().enumerate().map(|(position, item)| {
                            let last = position + 1 == items.len();
                            self.item(row, *item, live && last, this, theme, cx)
                        })),
                )
            })
            .into_any_element()
    }

    fn item(
        &self,
        row: usize,
        entry_ix: usize,
        live: bool,
        this: &Entity<Chat>,
        theme: &Theme,
        cx: &App,
    ) -> AnyElement {
        let entry = &self.transcript.entries[entry_ix];
        let kind = Kind::of(entry);
        let item_key = format!("item:{}:{}", entry.id(), kind.verb());
        let running = live
            && match entry {
                Entry::Tool { result, .. } => result.is_none(),
                Entry::Thought { streaming, .. } => *streaming,
                _ => false,
            };
        let failed = matches!(entry, Entry::Tool { result: Some(result), .. } if result.failed);
        let detail = match entry {
            Entry::Tool { result, .. } => tools::input(entry).is_some() || result.is_some(),
            _ => true,
        };
        let default_open = running && matches!(entry, Entry::Thought { .. });
        let open = detail && self.toggled.get(&item_key).copied().unwrap_or(default_open);
        let target = match entry {
            Entry::Thought { .. } if running => "思考中".to_owned(),
            Entry::Thought { .. } => String::new(),
            _ => tools::target(entry),
        };
        let pulse = self
            .elapsed
            .map(|elapsed| motion::cycle(elapsed, Duration::from_millis(1600)))
            .map_or(1., |phase| {
                0.65 + 0.35 * (phase * std::f32::consts::TAU).cos()
            });
        let mark = if failed {
            icon("icons/close.svg", theme.danger)
                .size(px(10.))
                .into_any_element()
        } else if running {
            div()
                .size(px(5.))
                .rounded_full()
                .bg(theme.accent.opacity(pulse))
                .into_any_element()
        } else if detail {
            icon(
                if open {
                    "icons/chevron-down.svg"
                } else {
                    "icons/chevron-right.svg"
                },
                theme.muted,
            )
            .size(px(10.))
            .into_any_element()
        } else {
            div().into_any_element()
        };
        let header = div()
            .id(SharedString::from(format!("{item_key}:header")))
            .h(px(28.))
            .px(px(8.))
            .flex()
            .items_center()
            .gap(px(8.))
            .text_size(px(12.5))
            .line_height(px(16.))
            .text_color(theme.muted)
            .child(icon(kind.icon(), theme.muted).size(px(12.)))
            .child(
                div()
                    .flex_none()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(kind.verb()),
            )
            .child(div().flex_1().min_w_0().truncate().child(target))
            .child(mark);
        let header = if detail {
            let chat = this.downgrade();
            let key = item_key.clone();
            ui::pressable(
                header
                    .hover(|style| style.bg(theme.hover))
                    .focus_visible(|style| style.bg(theme.hover)),
                move |_, cx| {
                    let key = key.clone();
                    let _ = chat.update(cx, |chat, cx| chat.toggle(key, !open, row, cx));
                },
            )
        } else {
            header
        };
        div()
            .flex()
            .flex_col()
            .rounded(px(9.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.text.opacity(0.025))
            .overflow_hidden()
            .child(header)
            .when(open, |card| {
                card.child(self.item_detail(entry, &item_key, theme, cx))
            })
            .into_any_element()
    }

    fn item_detail(&self, entry: &Entry, item_key: &str, theme: &Theme, cx: &App) -> AnyElement {
        let body = div()
            .id(SharedString::from(format!("{item_key}:detail")))
            .max_h(px(400.))
            .overflow_y_scroll()
            .border_t_1()
            .border_color(theme.border)
            .px(px(12.))
            .py(px(8.))
            .flex()
            .flex_col()
            .gap(px(8.));
        let row: SharedString = item_key.to_owned().into();
        match entry {
            Entry::Thought { id, .. } => match self.bodies.get(&format!("thought:{id}")) {
                Some(markdown) => body
                    .child(md::render(
                        markdown,
                        &self.scope(&row, md::COMPACT, theme.muted),
                        cx,
                    ))
                    .into_any_element(),
                None => body.into_any_element(),
            },
            Entry::Tool { result, .. } => {
                let mut sections = Vec::new();
                if let Some(input) = tools::input(entry) {
                    let label = if Kind::of(entry) == Kind::Run {
                        "命令"
                    } else {
                        "参数"
                    };
                    sections.push((label, input));
                }
                if let Some(result) = result
                    && !result.output.is_empty()
                {
                    sections.push(("输出", result.output.clone()));
                }
                body.children(
                    sections
                        .into_iter()
                        .enumerate()
                        .map(|(ordinal, (label, text))| {
                            let content: SharedString = text.into();
                            let styled = StyledText::new(content.clone());
                            let layout = styled.layout().clone();
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .line_height(px(16.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.muted)
                                        .child(label),
                                )
                                .child(
                                    div()
                                        .font_family(theme.mono_font.clone())
                                        .text_size(px(12.5))
                                        .line_height(px(17.))
                                        .text_color(theme.text)
                                        .child(self.selection.text(
                                            Key {
                                                row: row.clone(),
                                                ordinal: ordinal as u32,
                                            },
                                            content,
                                            true,
                                            layout,
                                            styled,
                                        )),
                                )
                        }),
                )
                .into_any_element()
            }
            _ => body.into_any_element(),
        }
    }

    fn summary(&self, turn: &str, open: bool, this: &Entity<Chat>, theme: &Theme) -> AnyElement {
        let state = self.transcript.turns.get(turn);
        let seconds = state
            .and_then(|state| Some((state.ended.as_ref()?.0).saturating_sub(state.started?)))
            .map(|ms| (ms / 1000).max(1));
        let label = match (state.and_then(|state| state.ended.as_ref()), seconds) {
            (Some((_, Ending::Cancelled)), Some(seconds)) => {
                format!("已停止，用时 {}", prose(seconds))
            }
            (_, Some(seconds)) => format!("工作了 {}", prose(seconds)),
            _ => "工作过程".to_owned(),
        };
        let chat = this.downgrade();
        let turn = turn.to_owned();
        let line = || div().flex_1().h(px(1.)).bg(theme.border);
        let group = SharedString::from(format!("summary:{turn}:toggle"));
        ui::pressable(
            div()
                .id(group.clone())
                .group(group.clone())
                .h(px(24.))
                .flex()
                .items_center()
                .gap(px(10.))
                .text_color(theme.muted)
                .hover(|style| style.text_color(theme.text))
                .focus_visible(|style| style.text_color(theme.text))
                .child(line())
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(5.))
                        .px(px(2.))
                        .text_size(px(13.5))
                        .line_height(px(18.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(label)
                        .child(
                            icon(
                                if open {
                                    "icons/chevron-down.svg"
                                } else {
                                    "icons/chevron-right.svg"
                                },
                                theme.muted,
                            )
                            .size(px(11.5))
                            .group_hover(group, |style| style.text_color(theme.text)),
                        ),
                )
                .child(line()),
            move |_, cx| {
                let turn = turn.clone();
                let _ = chat.update(cx, |chat, cx| chat.toggle_turn(turn, cx));
            },
        )
        .into_any_element()
    }

    fn footer(&self, turn: &str, this: &Entity<Chat>, theme: &Theme, cx: &App) -> AnyElement {
        let entries = &self.transcript.entries;
        let visible = self.hovered_turn.as_deref() == Some(turn);
        // The answer is the trailing text of the turn; work before it is not copied.
        let mut answer: Vec<&str> = Vec::new();
        for entry in entries.iter().filter(|entry| entry.turn() == turn) {
            match entry {
                Entry::Text { text, .. } if !text.trim().is_empty() => answer.push(text),
                Entry::Prompt { .. } => {}
                _ => answer.clear(),
            }
        }
        let text = answer.join("\n\n");
        let copy_key: SharedString = format!("footer:{turn}").into();
        let copied = self.copied.read(cx).is(&copy_key);
        let source = self.copied.clone();
        let time = self
            .transcript
            .turns
            .get(turn)
            .and_then(|state| state.ended.as_ref().map(|(at, _)| *at).or(state.started))
            .map(clock);
        let _ = this;
        div()
            .ml(px(-7.))
            .h(px(27.))
            .flex()
            .items_center()
            .gap(px(1.))
            .when(!visible, |this| this.invisible())
            .child(
                icon_button(
                    SharedString::from(format!("{copy_key}:copy")),
                    if copied {
                        "icons/check.svg"
                    } else {
                        "icons/copy.svg"
                    },
                    false,
                    move |_, cx| {
                        let text = text.clone();
                        let key = copy_key.clone();
                        source.update(cx, |copied, cx| copied.copy(key, text, cx));
                    },
                    cx,
                )
                .tooltip(ui::tooltip(if copied {
                    "已复制"
                } else {
                    "复制回答"
                })),
            )
            .when_some(time, |this, time| {
                this.child(
                    div()
                        .px(px(4.))
                        .text_size(px(12.5))
                        .line_height(px(14.))
                        .text_color(theme.muted)
                        .child(time),
                )
            })
            .into_any_element()
    }

    fn working(&self, theme: &Theme) -> AnyElement {
        let phase = self
            .elapsed
            .map(|elapsed| motion::cycle(elapsed, Duration::from_millis(1400)));
        let started = self
            .running()
            .and_then(|turn| self.transcript.turns.get(&turn.turn_id))
            .and_then(|turn| turn.started);
        let label = match started {
            Some(started) => {
                let now = chrono::Utc::now().timestamp_millis().max(0) as u64;
                format!("正在工作 {}", compact(now.saturating_sub(started) / 1000))
            }
            None => "正在工作".to_owned(),
        };
        div()
            .h(px(22.))
            .flex()
            .items_center()
            .gap(px(8.))
            .child(div().flex().gap(px(3.5)).children((0..3).map(|dot| {
                let opacity = match phase {
                    Some(phase) => {
                        let wave = ((phase - dot as f32 * 0.18) * std::f32::consts::TAU).sin();
                        0.25 + 0.75 * (wave + 1.) / 2.
                    }
                    None => 0.6,
                };
                div()
                    .size(px(4.5))
                    .rounded_full()
                    .bg(theme.muted.opacity(opacity))
            })))
            .child(
                div()
                    .text_size(px(13.5))
                    .line_height(px(18.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.muted)
                    .child(label),
            )
            .into_any_element()
    }

    fn jump_button(&self, this: &Entity<Chat>, theme: &Theme) -> Div {
        let chat = this.downgrade();
        div()
            .absolute()
            .bottom(px(8.))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(
                ui::pressable(
                    div()
                        .id("jump-to-latest")
                        .size(px(32.))
                        .rounded_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.raised)
                        .shadow_sm()
                        .text_color(theme.text)
                        .hover(|style| style.bg(theme.overlay))
                        .focus_visible(|style| style.border_color(theme.accent))
                        .child(icon("icons/arrow-down.svg", theme.text).size(px(16.))),
                    move |_, cx| {
                        let _ = chat.update(cx, |chat, cx| chat.jump_to_latest(cx));
                    },
                )
                .tooltip(ui::tooltip("回到最新")),
            )
    }
}

fn live_title(entry: &Entry) -> String {
    match entry {
        Entry::Thought { .. } => "思考中".to_owned(),
        _ => {
            let target = tools::target(entry);
            let verb = Kind::of(entry).verb();
            if target.is_empty() {
                format!("正在{verb}")
            } else {
                format!("正在{verb} {target}")
            }
        }
    }
}

/// "1 分 5 秒"; seconds are dropped once it reaches hours.
fn prose(seconds: u64) -> String {
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    match (hours, minutes, seconds) {
        (0, 0, s) => format!("{s} 秒"),
        (0, m, 0) => format!("{m} 分钟"),
        (0, m, s) => format!("{m} 分 {s} 秒"),
        (h, 0, _) => format!("{h} 小时"),
        (h, m, _) => format!("{h} 小时 {m} 分"),
    }
}

/// "9s", "1m 5s", "1h 2m".
pub fn compact(seconds: u64) -> String {
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    match (hours, minutes, seconds) {
        (0, 0, s) => format!("{s}s"),
        (0, m, 0) => format!("{m}m"),
        (0, m, s) => format!("{m}m {s}s"),
        (h, 0, _) => format!("{h}h"),
        (h, m, _) => format!("{h}h {m}m"),
    }
}

/// "14:05" today, otherwise with the date.
fn clock(ms: u64) -> String {
    let Some(at) = Local.timestamp_millis_opt(ms as i64).single() else {
        return String::new();
    };
    let today = Local::now().date_naive();
    let date = at.date_naive();
    if date == today {
        at.format("%H:%M").to_string()
    } else if today.pred_opt() == Some(date) {
        at.format("昨天 %H:%M").to_string()
    } else if at.format("%Y").to_string() == today.format("%Y").to_string() {
        at.format("%-m月%-d日 %H:%M").to_string()
    } else {
        at.format("%Y年%-m月%-d日 %H:%M").to_string()
    }
}

impl Render for Chat {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let fading = self.bodies.values().any(|body| body.fading(now));
        let moving = matches!(self.delivery, Some(super::Delivery::Sending))
            || self
                .fold
                .iter()
                .any(|row| matches!(row, Row::Working | Row::Work { live: true, .. }));
        self.elapsed = if fading || moving {
            motion::now(window, cx)
        } else {
            None
        };
        self.now = self.elapsed.map(|_| now);
        self.place(window);
        if let Some(at_end) = self.list.is_scrolled_to_end() {
            let scrollable = self.list.max_offset_for_scrollbar().y > px(0.5);
            self.jump = scrollable
                && !at_end
                && !self.list.is_following_tail()
                && !self.anchor.as_ref().is_some_and(|anchor| anchor.pinning);
        }

        let this = cx.entity();
        let scrollbar = self
            .scrollbar
            .render(&self.list, this.entity_id(), window, cx);
        let permission = self.render_permission(window, cx);
        let composer = self.render_composer(cx).into_any_element();
        let theme = theme(cx);
        let rows = {
            let this = this.downgrade();
            list(self.list.clone(), move |ix, _, cx| {
                this.upgrade()
                    .map(|chat| chat.read(cx).render_row(ix, &chat, cx))
                    .unwrap_or_else(|| div().into_any_element())
            })
            .size_full()
            .pb(px(22.) + self.end_space)
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .key_context("Chat")
            .on_action(cx.listener(|this, _: &super::Interrupt, _, cx| {
                if !this.interrupt(cx) {
                    cx.propagate();
                }
            }))
            // The composer's own Esc, once it has nothing left to dismiss.
            .on_action(cx.listener(|this, _: &input::Escape, _, cx| {
                if !this.interrupt(cx) {
                    cx.propagate();
                }
            }))
            .bg(theme.base)
            .text_color(theme.text)
            .child(
                div()
                    .id("transcript")
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .key_context("Transcript")
                    .track_focus(&self.focus)
                    .on_action(cx.listener(Self::copy_selection))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, event: &gpui_kit::MouseDownEvent, window, cx| {
                            window.focus(&this.focus, cx);
                            if this.selection.mouse_down(event.position, event.click_count) {
                                cx.notify();
                            }
                        }),
                    )
                    .on_mouse_move(
                        cx.listener(|this, event: &gpui_kit::MouseMoveEvent, _, cx| {
                            if event.pressed_button == Some(MouseButton::Left)
                                && this.selection.mouse_move(event.position)
                            {
                                cx.notify();
                            }
                        }),
                    )
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, _, _, _| this.selection.mouse_up()),
                    )
                    .on_mouse_up_out(
                        MouseButton::Left,
                        cx.listener(|this, _, _, _| this.selection.mouse_up()),
                    )
                    .child(self.selection.frame_start())
                    .child(rows)
                    .child(scrollbar)
                    .when(self.jump, |this_div| {
                        this_div.child(self.jump_button(&this, theme))
                    }),
            )
            .when_some(self.error.clone(), |this_div, error| {
                this_div.child(
                    div()
                        .w_full()
                        .flex()
                        .justify_center()
                        .px(px(20.))
                        .pb(px(8.))
                        .child(
                            div()
                                .w_full()
                                .max_w(px(COLUMN))
                                .text_size(px(12.5))
                                .text_color(theme.danger)
                                .child(error),
                        ),
                )
            })
            .children(permission)
            .child(composer)
    }
}

#[cfg(test)]
mod tests {
    use super::{compact, prose};

    #[test]
    fn durations_read_naturally() {
        assert_eq!(prose(1), "1 秒");
        assert_eq!(prose(65), "1 分 5 秒");
        assert_eq!(prose(120), "2 分钟");
        assert_eq!(prose(7380), "2 小时 3 分");
        assert_eq!(compact(9), "9s");
        assert_eq!(compact(65), "1m 5s");
        assert_eq!(compact(3720), "1h 2m");
    }
}
