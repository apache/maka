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

//! The window: sidebar, header and the open session. The root holds only
//! the connection; the sidebar and the chat are their own views, drawn from
//! cache unless they changed, so a streaming reply redraws the chat alone.

use crate::{
    chat::Chat,
    host::{self, Host},
    sidebar::{self, Sidebar, SidebarEvent},
    theme::theme,
    ui::{self, Copied},
};
use gpui_kit::{
    AnyElement, AppContext, AsyncApp, Context, Div, Entity, FontWeight, InteractiveElement,
    IntoElement, MouseButton, ParentElement, Render, Role, SharedString, Stateful,
    StatefulInteractiveElement, StyleRefinement, Styled, Task, WeakEntity, Window, div, px,
};
use maka_client::{Client, Notification};
use maka_protocol::session::{SessionCatalogQueryInput, SessionCatalogQueryResult};
use serde_json::json;
use std::{cell::Cell, path::PathBuf, rc::Rc, time::Duration};
use tokio::sync::mpsc;

/// Provider chunks queue this long and land as one update: one parse and
/// one redraw per update, whatever the chunk rate.
const STREAM_FRAME: Duration = Duration::from_millis(120);

gpui_kit::actions!(workspace, [NewSession, Minimize]);

enum Connection {
    Connecting,
    Ready(Client),
    Failed(SharedString),
}

pub struct Workspace {
    root: PathBuf,
    connection: Connection,
    sidebar: Entity<Sidebar>,
    chat: Option<Entity<Chat>>,
    copied: Entity<Copied>,
    _tasks: Vec<Task<()>>,
}

impl Workspace {
    pub fn new(root: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let sidebar = cx.new(|_| Sidebar::new());
        cx.subscribe_in(&sidebar, window, |this, _, event, window, cx| match event {
            SidebarEvent::Open(id) => this.open(id.clone(), window, cx),
            SidebarEvent::Create => this.create_session(window, cx),
        })
        .detach();
        let mut this = Self {
            root,
            connection: Connection::Connecting,
            sidebar,
            chat: None,
            copied: cx.new(|_| Copied::default()),
            _tasks: Vec::new(),
        };
        this.connect(window, cx);
        this
    }

    fn connect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.connection = Connection::Connecting;
        let connecting = cx.global::<Host>().spawn(host::connect(self.root.clone()));
        self._tasks = vec![cx.spawn_in(window, async move |this, cx| {
            let result = connecting.await.and_then(|result| result);
            let Ok(notifications) = this.update_in(cx, |this, window, cx| match result {
                Ok((client, notifications)) => {
                    this.connection = Connection::Ready(client);
                    this.sidebar
                        .update(cx, |sidebar, cx| sidebar.set_can_create(true, cx));
                    this.load_sessions(cx);
                    // After a reconnect, the session that was open comes back.
                    if let Some(selected) = this.sidebar.read(cx).selected() {
                        this.open(selected, window, cx);
                    }
                    cx.notify();
                    Some(notifications)
                }
                Err(error) => {
                    this.connection = Connection::Failed(error.into());
                    cx.notify();
                    None
                }
            }) else {
                return;
            };
            if let Some(notifications) = notifications {
                Self::pump(this, notifications, cx).await;
            }
        })];
    }

    async fn pump(
        this: WeakEntity<Self>,
        mut notifications: mpsc::Receiver<Notification>,
        cx: &mut AsyncApp,
    ) {
        while let Some(first) = notifications.recv().await {
            // Sleep the whole frame before draining, rather than waking per
            // chunk: racing the channel would redraw at the chunk rate.
            cx.background_executor().timer(STREAM_FRAME).await;
            let mut batch = vec![first];
            while let Ok(next) = notifications.try_recv() {
                batch.push(next);
            }
            if this.update(cx, |this, cx| this.apply(batch, cx)).is_err() {
                return;
            }
        }
        let _ = this.update(cx, |this, cx| {
            this.connection = Connection::Failed("与 Host 的连接已断开".into());
            this.sidebar
                .update(cx, |sidebar, cx| sidebar.set_can_create(false, cx));
            // A chat without a connection looks live but cannot send; the
            // main area shows the failure and a reconnect instead.
            if let Some(chat) = this.chat.take() {
                chat.update(cx, |chat, cx| chat.close(cx));
            }
            cx.notify();
        });
    }

    fn apply(&mut self, batch: Vec<Notification>, cx: &mut Context<Self>) {
        let mut catalog_changed = false;
        let mut frames = Vec::new();
        for notification in batch {
            match notification {
                Notification::Catalog(change) => {
                    catalog_changed |= change.kind == "session.catalog.changed";
                }
                Notification::Observation(frame) => frames.push(*frame),
            }
        }
        if let Some(chat) = &self.chat
            && !frames.is_empty()
        {
            chat.update(cx, |chat, cx| chat.accept(frames, cx));
        }
        if catalog_changed {
            self.load_sessions(cx);
        }
    }

    fn client(&self) -> Option<Client> {
        match &self.connection {
            Connection::Ready(client) => Some(client.clone()),
            _ => None,
        }
    }

    fn load_sessions(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client() else {
            return;
        };
        let loading = cx.global::<Host>().spawn(async move {
            client
                .session_catalog(SessionCatalogQueryInput::ListStart)
                .await
        });
        let sidebar = self.sidebar.clone();
        cx.spawn(async move |this, cx| {
            let result = loading.await;
            sidebar.update(cx, |sidebar, cx| match result {
                Ok(Ok(SessionCatalogQueryResult::Page { sessions, .. })) => {
                    sidebar.set_sessions(sessions, cx)
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => sidebar.set_error(Some(error.to_string().into()), cx),
                Err(error) => sidebar.set_error(Some(error.into()), cx),
            });
            // The header shows the session's name.
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }

    fn create_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client() else {
            return;
        };
        // A new session continues in the project at hand; the launch
        // directory is `/` when the app starts from Finder.
        let open = self.chat.as_ref().map(|chat| chat.read(cx).session());
        let Some(workspace) = self
            .sidebar
            .read(cx)
            .folder(open)
            .map(PathBuf::from)
            .or_else(std::env::home_dir)
        else {
            return;
        };
        let creating = cx.global::<Host>().spawn(async move {
            let input = maka_protocol::session::decode_session_create_input(&json!({
                "sessionId": uuid::Uuid::new_v4().to_string(),
                "name": "新会话",
                "workspace": {"kind": "host_path", "path": workspace},
                "modelTarget": {"kind": "default"}
            }))
            .map_err(|error| error.to_string())?;
            client
                .create_session(input)
                .await
                .map_err(|error| error.to_string())
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = creating.await.and_then(|result| result);
            let _ = this.update_in(cx, |this, window, cx| match result {
                Ok(session) => {
                    let id = session.id.clone();
                    this.sidebar
                        .update(cx, |sidebar, cx| sidebar.insert(session, cx));
                    this.open(id, window, cx);
                }
                Err(error) => this
                    .sidebar
                    .update(cx, |sidebar, cx| sidebar.set_error(Some(error.into()), cx)),
            });
        })
        .detach();
    }

    fn open(&mut self, session: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client() else {
            return;
        };
        self.sidebar
            .update(cx, |sidebar, cx| sidebar.select(Some(session.clone()), cx));
        if self
            .chat
            .as_ref()
            .is_some_and(|chat| chat.read(cx).session() == session)
        {
            return;
        }
        if let Some(chat) = self.chat.take() {
            chat.update(cx, |chat, cx| chat.close(cx));
        }
        let copied = self.copied.clone();
        let chat = cx.new(|cx| Chat::new(client, session, copied, window, cx));
        chat.update(cx, |chat, cx| chat.focus_composer(window, cx));
        self.chat = Some(chat);
        cx.notify();
    }

    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let title = self
            .chat
            .as_ref()
            .and_then(|chat| self.sidebar.read(cx).name(chat.read(cx).session()))
            .unwrap_or_default();
        drag_region()
            .h(px(sidebar::TITLEBAR))
            .flex_none()
            .px(px(14.))
            .flex()
            .items_center()
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(title),
            )
    }

    fn render_main(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        if let Some(chat) = &self.chat {
            return embed(chat, window);
        }
        let theme = theme(cx);
        let message: SharedString = match &self.connection {
            Connection::Connecting => "正在连接 Host…".into(),
            Connection::Failed(error) => format!("无法连接 Host：{error}").into(),
            Connection::Ready(_) => "选择或新建一个会话".into(),
        };
        let reconnect = matches!(self.connection, Connection::Failed(_)).then(|| {
            let this = cx.weak_entity();
            ui::button(
                "reconnect",
                "重新连接",
                ui::Tone::Outline,
                false,
                move |window, cx| {
                    let _ = this.update(cx, |this, cx| {
                        this.connect(window, cx);
                        cx.notify();
                    });
                },
                cx,
            )
        });
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.))
            .text_size(px(13.))
            .text_color(theme.muted)
            .child(message)
            .children(reconnect)
            .into_any_element()
    }
}

/// Draws `view` from cache unless it changed. While assistive technology is
/// listening it is drawn fresh: GPUI drops a cached view's accessibility
/// nodes when it reuses the view's last frame.
fn embed<V: Render>(view: &Entity<V>, window: &Window) -> AnyElement {
    if window.is_a11y_active() {
        div().size_full().child(view.clone()).into_any_element()
    } else {
        view.clone()
            .cached(StyleRefinement::default().size_full())
            .into_any_element()
    }
}

/// Drags the window from the first move after a press, so clicks and
/// double-clicks on it still reach the window.
pub fn drag_region() -> Stateful<Div> {
    let armed = Rc::new(Cell::new(false));
    let on_move = armed.clone();
    div()
        .id("drag-region")
        .on_mouse_down(MouseButton::Left, move |event, window, _| {
            if event.click_count >= 2 {
                window.titlebar_double_click();
            } else {
                armed.set(true);
            }
        })
        .on_mouse_move(move |event, window, _| {
            if on_move.replace(false) && event.pressed_button == Some(MouseButton::Left) {
                window.start_window_move();
            }
        })
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        div()
            .size_full()
            .flex()
            .on_action(
                cx.listener(|this, _: &NewSession, window, cx| this.create_session(window, cx)),
            )
            .on_action(|_: &Minimize, window, _| window.minimize_window())
            .bg(theme.base)
            .text_color(theme.text)
            .font_family(theme.ui_font.clone())
            .child(
                div()
                    .id("sidebar")
                    .role(Role::Navigation)
                    .aria_label("会话")
                    .w(px(sidebar::WIDTH))
                    .h_full()
                    .flex_none()
                    .child(embed(&self.sidebar, window)),
            )
            .child(
                div()
                    .id("main")
                    .role(Role::Main)
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .border_l_1()
                    .border_color(theme.border)
                    .child(self.render_header(cx))
                    .child(div().flex_1().min_h_0().child(self.render_main(window, cx))),
            )
    }
}
