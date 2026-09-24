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

//! Sessions, newest reply first, grouped by day. Every row has the same
//! height, so the list knows where any row is before it is drawn.

use crate::{
    theme::theme,
    ui::{self, icon, motion},
};
use chrono::{Datelike, Local, NaiveDate, TimeZone};
use gpui_kit::{
    AnyElement, Context, EventEmitter, FontWeight, InteractiveElement, IntoElement, ListAlignment,
    ListState, ParentElement, Render, Role, SharedString, StatefulInteractiveElement, Styled, Task,
    Transformation, Window, div, list, percentage, prelude::FluentBuilder, px,
};
use maka_protocol::session::{SessionCatalogProjection, SessionStatus};
use std::time::Duration;

pub const WIDTH: f32 = 252.;
/// Clearance for the macOS window buttons at the top left.
pub const TITLEBAR: f32 = 48.;

pub enum SidebarEvent {
    Open(String),
    Create,
}

enum Item {
    Group(&'static str),
    Session(usize),
}

pub struct Sidebar {
    sessions: Vec<SessionCatalogProjection>,
    items: Vec<Item>,
    keys: Vec<String>,
    /// The day the groups were computed for.
    today: NaiveDate,
    selected: Option<String>,
    can_create: bool,
    error: Option<SharedString>,
    list: ListState,
    /// The minute boundary a timer is set for.
    wake: Option<(u64, Task<()>)>,
}

impl EventEmitter<SidebarEvent> for Sidebar {}

impl Sidebar {
    pub fn new() -> Self {
        Self {
            sessions: Vec::new(),
            items: Vec::new(),
            keys: Vec::new(),
            today: Local::now().date_naive(),
            selected: None,
            can_create: false,
            error: None,
            list: ListState::new(0, ListAlignment::Top, px(520.)),
            wake: None,
        }
    }

    pub fn set_sessions(
        &mut self,
        mut sessions: Vec<SessionCatalogProjection>,
        cx: &mut Context<Self>,
    ) {
        sessions.retain(|session| !session.is_archived);
        sessions.sort_by_key(|session| std::cmp::Reverse(recency(session)));
        self.sessions = sessions;
        self.error = None;
        self.regroup(cx);
    }

    fn regroup(&mut self, cx: &mut Context<Self>) {
        self.today = Local::now().date_naive();
        let mut items = Vec::new();
        let mut keys = Vec::new();
        let mut current = None;
        for (ix, session) in self.sessions.iter().enumerate() {
            let group = day_group(recency(session), self.today);
            if current != Some(group) {
                items.push(Item::Group(group));
                keys.push(format!("group:{group}"));
                current = Some(group);
            }
            items.push(Item::Session(ix));
            keys.push(session.id.clone());
        }
        let old = std::mem::replace(&mut self.keys, keys);
        ui::splice(&self.list, &old, &self.keys);
        self.items = items;
        cx.notify();
    }

    pub fn set_error(&mut self, error: Option<SharedString>, cx: &mut Context<Self>) {
        self.error = error;
        cx.notify();
    }

    pub fn select(&mut self, session: Option<String>, cx: &mut Context<Self>) {
        self.selected = session;
        cx.notify();
    }

    pub fn set_can_create(&mut self, can_create: bool, cx: &mut Context<Self>) {
        self.can_create = can_create;
        cx.notify();
    }

    pub fn selected(&self) -> Option<String> {
        self.selected.clone()
    }

    /// The project folder of `id`, or else of the latest session.
    pub fn folder(&self, id: Option<&str>) -> Option<String> {
        id.and_then(|id| self.sessions.iter().find(|session| session.id == id))
            .or(self.sessions.first())
            .map(|session| session.workspace.host_cwd.clone())
            .filter(|folder| !folder.is_empty())
    }

    pub fn name(&self, id: &str) -> Option<SharedString> {
        self.sessions
            .iter()
            .find(|session| session.id == id)
            .map(|session| title(session).into())
    }

    fn render_item(
        &mut self,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match self.items.get(ix) {
            Some(Item::Group(label)) => div()
                .id(SharedString::from(self.keys[ix].clone()))
                .role(Role::Heading)
                .aria_label(*label)
                .h(px(30.))
                .px(px(8.))
                .pt(px(8.))
                .text_size(px(12.5))
                .line_height(px(16.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme(cx).muted)
                .child(*label)
                .into_any_element(),
            Some(Item::Session(session)) => {
                let session = &self.sessions[*session];
                let turn = if busy(session) {
                    motion::now(window, cx)
                        .map(|elapsed| motion::cycle(elapsed, Duration::from_millis(900)))
                } else {
                    None
                };
                let now = Local::now().timestamp_millis().max(0) as u64;
                self.row(session, turn, now, cx)
            }
            None => div().into_any_element(),
        }
    }

    fn row(
        &self,
        session: &SessionCatalogProjection,
        turn: Option<f32>,
        now: u64,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = theme(cx);
        let selected = self.selected.as_deref() == Some(session.id.as_str());
        let (state, status) = match session.status {
            SessionStatus::Running => (
                Some("运行中"),
                Some(
                    icon("icons/loader-circle.svg", theme.accent)
                        .size(px(12.))
                        .with_transformation(Transformation::rotate(percentage(turn.unwrap_or(0.))))
                        .into_any_element(),
                ),
            ),
            SessionStatus::WaitingForUser | SessionStatus::Blocked => (
                Some("等待回应"),
                Some(
                    icon("icons/triangle-alert.svg", theme.warning)
                        .size(px(12.))
                        .into_any_element(),
                ),
            ),
            _ => (None, None),
        };
        let project = session
            .workspace
            .host_cwd
            .rsplit(['/', '\\'])
            .find(|part| !part.is_empty())
            .unwrap_or("")
            .to_owned();
        let id = session.id.clone();
        let entity = cx.weak_entity();
        let when = ago(now, recency(session));
        let description = match state {
            Some(state) => format!("{state} · {project} · {when}"),
            None => format!("{project} · {when}"),
        };
        div()
            .h(px(52.))
            .pb(px(1.))
            .child(ui::pressable(
                div()
                    .id(SharedString::from(format!("session:{}", session.id)))
                    .aria_selected(selected)
                    .aria_description(description)
                    .h(px(51.))
                    .px(px(8.))
                    .py(px(7.))
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .rounded(px(7.))
                    .border_1()
                    .border_color(gpui_kit::transparent_black())
                    .when(selected, |this| this.bg(theme.hover))
                    .hover(|style| style.bg(theme.hover))
                    .focus_visible(|style| style.border_color(theme.accent))
                    .child(
                        div()
                            .h(px(18.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(13.5))
                                    .line_height(px(18.))
                                    .child(title(session)),
                            )
                            .children(status),
                    )
                    .child(
                        div()
                            .h(px(15.))
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .text_size(px(12.5))
                            .line_height(px(15.))
                            .text_color(theme.muted)
                            .child(icon("icons/folder.svg", theme.muted).size(px(12.)))
                            .child(div().flex_1().min_w_0().truncate().child(project))
                            .child(div().flex_none().child(when)),
                    ),
                title(session),
                move |_, cx| {
                    let id = id.clone();
                    let _ = entity.update(cx, |sidebar, cx| {
                        sidebar.selected = Some(id.clone());
                        cx.emit(SidebarEvent::Open(id));
                        cx.notify();
                    });
                },
            ))
            .into_any_element()
    }

    /// Relative times change at minute boundaries; wake once for the next.
    fn schedule_wake(&mut self, cx: &mut Context<Self>) {
        let now = Local::now().timestamp_millis().max(0) as u64;
        let boundary = now - now % 60_000 + 60_000;
        if self.wake.as_ref().is_some_and(|(at, _)| *at == boundary) {
            return;
        }
        let wait = boundary - now + 50;
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(wait))
                .await;
            let _ = this.update(cx, |sidebar, cx| {
                if sidebar.today == Local::now().date_naive() {
                    cx.notify();
                } else {
                    sidebar.regroup(cx);
                }
            });
        });
        self.wake = Some((boundary, task));
    }
}

impl Render for Sidebar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.schedule_wake(cx);
        let theme = theme(cx);
        let entity = cx.weak_entity();
        let can_create = self.can_create;
        let new_row = ui::pressable(
            div()
                .id("new-session")
                .h(px(32.))
                .px(px(4.))
                .flex()
                .items_center()
                .gap(px(10.))
                .rounded(px(7.))
                .border_1()
                .border_color(gpui_kit::transparent_black())
                .text_size(px(13.))
                .text_color(theme.muted)
                .when(can_create, |this| this.hover(|style| style.bg(theme.hover)))
                .when(!can_create, |this| this.opacity(0.5))
                .focus_visible(|style| style.border_color(theme.accent))
                .child(
                    div()
                        .size(px(20.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon("icons/square-pen.svg", theme.muted)),
                )
                .child("新建会话"),
            "新建会话",
            move |_, cx| {
                if can_create {
                    let _ = entity.update(cx, |_, cx| cx.emit(SidebarEvent::Create));
                }
            },
        );
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme.sidebar)
            .text_color(theme.text)
            .child(crate::workspace::drag_region().h(px(TITLEBAR)).flex_none())
            .child(div().px(px(10.)).child(new_row))
            .when_some(self.error.clone(), |this, error| {
                this.child(
                    div()
                        .px(px(14.))
                        .py(px(6.))
                        .text_size(px(12.5))
                        .text_color(theme.danger)
                        .child(error),
                )
            })
            .child(
                div().flex_1().min_h_0().px(px(10.)).pt(px(4.)).child(
                    list(self.list.clone(), {
                        let entity = cx.weak_entity();
                        move |ix, window, cx| {
                            entity
                                .update(cx, |sidebar, cx| sidebar.render_item(ix, window, cx))
                                .unwrap_or_else(|_| div().into_any_element())
                        }
                    })
                    .size_full(),
                ),
            )
    }
}

fn title(session: &SessionCatalogProjection) -> String {
    if session.name.trim().is_empty() {
        "新会话".into()
    } else {
        session
            .name
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn busy(session: &SessionCatalogProjection) -> bool {
    session.status == SessionStatus::Running
}

/// When the last reply landed; renames do not move a session.
fn recency(session: &SessionCatalogProjection) -> u64 {
    session.last_message_at.unwrap_or(session.created_at)
}

fn day_group(ms: u64, today: chrono::NaiveDate) -> &'static str {
    let Some(at) = Local.timestamp_millis_opt(ms as i64).single() else {
        return "更早";
    };
    let date = at.date_naive();
    if date >= today {
        "今天"
    } else if today.pred_opt() == Some(date) {
        "昨天"
    } else if date.iso_week() == today.iso_week() && date.year() == today.year() {
        "本周"
    } else if date.month() == today.month() && date.year() == today.year() {
        "本月"
    } else {
        "更早"
    }
}

fn ago(now: u64, then: u64) -> String {
    let seconds = now.saturating_sub(then) / 1000;
    match seconds {
        0..60 => "刚刚".into(),
        60..3600 => format!("{} 分钟", seconds / 60),
        3600..86400 => format!("{} 小时", seconds / 3600),
        _ => format!("{} 天", seconds / 86400),
    }
}

#[cfg(test)]
mod tests {
    use super::ago;

    #[test]
    fn relative_times_round_down() {
        assert_eq!(ago(59_000, 0), "刚刚");
        assert_eq!(ago(61_000, 0), "1 分钟");
        assert_eq!(ago(7_200_000, 0), "2 小时");
        assert_eq!(ago(90_000_000, 0), "1 天");
    }
}
