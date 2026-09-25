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

use super::{action_label, activity, icon, safe, session};
use crate::{
    app::{Action, App, ConnectionState, Focus, Notice},
    navigation::Route,
    pages::sessions::Detail,
    ui::{Align, Context, Node, On, Size, Tone},
};
use ratatui::{Frame, layout::Rect};

pub(crate) mod controls;
mod input;
pub(crate) use session::composer::EDITOR;
#[cfg(test)]
pub(crate) use session::composer::SEND;

pub(crate) fn action(
    app: &App,
    key: impl Into<std::borrow::Cow<'static, str>>,
    action: Action,
) -> Node<Action> {
    let tone = if matches!(
        action,
        Action::SendMessage | Action::SteerMessage | Action::StopTurn(_)
    ) {
        Tone::Accent
    } else {
        Tone::Muted
    };
    controls::compact(
        key,
        icon(app, &action).into(),
        tone,
        action.clone(),
        app.enabled(&action),
        action_label(app, &action),
    )
}

pub(super) fn header(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let session = matches!(app.navigation.current(), Route::Session(_));
    let actions = app.header_actions();
    let right_width = (actions.len() as u16 + 1) * 3;
    let side = right_width.max(6);
    let title_width = area
        .width
        .saturating_sub(if session { side * 2 } else { 6 + right_width });
    let mut title = match (&app.navigation.current(), &app.sessions.detail) {
        (Route::Session(id), Detail::Ready(item)) if *id == item.id => safe(&item.name),
        (Route::App(key), _) => app
            .apps
            .instance(key)
            .and_then(|instance| instance.title(app.i18n.locale().id()))
            .map(|title| safe(&title))
            .unwrap_or_else(|| app.i18n.text(Route::Extensions.title())),
        _ => app.i18n.text(app.navigation.current().title()),
    };
    if !matches!(app.connection, ConnectionState::Connected { .. }) {
        let connection = match app.connection {
            ConnectionState::Disconnected => "connection-disconnected",
            ConnectionState::Connecting => "connection-connecting",
            ConnectionState::Connected { .. } => "connection-connected",
            ConnectionState::Failed(_) | ConnectionState::WrongEpoch => "connection-failed",
        };
        title = format!("{title} · {}", app.i18n.text(connection));
    }
    let spans = if let Route::Session(id) = app.navigation.current()
        && title_width >= 16
    {
        let activity = app.session_activity(&id);
        let face = match activity {
            activity::Activity::Working => app
                .chrome
                .animation
                .frame(crate::motion::Loop::Spring, app.chrome.ascii),
            activity::Activity::Waiting => "-_-",
            activity::Activity::Idle => app
                .chrome
                .animation
                .frame(crate::motion::Loop::Familiar, app.chrome.ascii),
            activity::Activity::Unknown => "o_o",
        };
        vec![
            (
                face.to_owned(),
                if activity == activity::Activity::Waiting {
                    Tone::Warning
                } else {
                    Tone::Accent
                },
            ),
            (
                format!(
                    " {}    ",
                    session::fit(&title, usize::from(title_width - 8))
                ),
                Tone::Strong,
            ),
        ]
    } else {
        vec![(title, Tone::Strong)]
    };
    let left = Node::row(
        "left",
        vec![
            action(app, "sidebar", Action::ToggleSidebar),
            action(app, "back", Action::Back),
        ],
    )
    .size(Size::Fixed(if session { side } else { 6 }));
    let mut right = Vec::new();
    if session && side > right_width {
        right.push(Node::text("space", vec![]).size(Size::Fixed(side - right_width)));
    }
    right.extend(
        actions
            .into_iter()
            .map(|value| action(app, format!("{value:?}"), value)),
    );
    right.push(action(app, "palette", Action::Palette));
    let tree = Node::row(
        "header",
        vec![
            left,
            Node::text("title", spans)
                .clip()
                .align(if session { Align::Center } else { Align::Start })
                .size(Size::Fill),
            Node::row("right", right).size(Size::Fixed(if session { side } else { right_width })),
        ],
    );
    let context = Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: app.focus == Focus::Header && app.overlay().is_none(),
    };
    app.chrome.header.render(frame, area, tree, context);
}

pub(super) fn footer(frame: &mut Frame<'_>, app: &mut App, area: Rect, hint: String) {
    let diagnostic = matches!(&app.notice, Some(Notice::Diagnostic(_)));
    let mut tree = Node::text(
        "footer",
        vec![(
            hint,
            if diagnostic {
                Tone::Warning
            } else {
                Tone::Subtle
            },
        )],
    )
    .align(Align::Center)
    .clip();
    if diagnostic {
        tree = tree.on(On::Activate(Action::Host));
    }
    let context = Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: false,
    };
    app.chrome.footer.render(frame, area, tree, context);
}
