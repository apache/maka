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

use super::{activity, feedback, fit, sandbox_key};
use crate::{
    app::{Action, App, ConnectionState, Focus},
    pages::sessions::Detail,
    ui::{Activity, Align, Context, Emphasis, Node, On, Size, Tone},
    view::{action_label, safe, shell},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::Style,
    widgets::{Paragraph, Wrap},
};
use unicode_width::UnicodeWidthStr;

pub(crate) const EDITOR: &str = "composer/body/content/editor";
#[cfg(test)]
pub(crate) const SEND: &str = "composer/body/actions/buttons/send";

pub(super) fn draw(
    frame: &mut Frame<'_>,
    app: &mut App,
    area: Rect,
    id: &str,
    editor_height: u16,
    extras: bool,
) {
    let mut content = Vec::new();
    if let Some(chip) = crate::pages::attachments::chips(app, id) {
        content.push(chip);
    }
    if app.has_directories(id) {
        content.push(crate::pages::references::chips(app, id));
    }
    if app.has_skills(id) {
        content.push(crate::pages::skills::chips(app, id));
    }
    let chip_rows = content.len() as u16;
    content.push(Node::slot("editor", editor_height).on(On::Activate(Action::Compose)));
    let attach = shell::controls::compact(
        "attach",
        "+".into(),
        Tone::Muted,
        Action::Attachment(crate::pages::attachments::Command::Open),
        app.enabled(&Action::Attachment(
            crate::pages::attachments::Command::Open,
        )),
        action_label(
            app,
            &Action::Attachment(crate::pages::attachments::Command::Open),
        ),
    );
    let leading = Node::column(
        "leading",
        vec![
            Node::slot("space", chip_rows),
            Node::row("buttons", vec![attach]).size(Size::Fixed(1)),
        ],
    )
    .size(Size::Fixed(4));
    let mut actions = Vec::new();
    if extras {
        actions.push(shell::action(app, "enqueue", Action::SendMessage));
        actions.push(shell::action(app, "steer", Action::SteerMessage));
    }
    actions.push(shell::action(app, "send", app.send_action()));
    let actions = Node::column(
        "actions",
        vec![
            Node::slot("space", chip_rows),
            Node::row("buttons", actions).size(Size::Fixed(1)),
        ],
    )
    .size(Size::Fixed(if extras { 9 } else { 3 }));
    let mut tree = Node::boundary(
        "composer",
        Node::row(
            "body",
            vec![
                leading,
                Node::column("content", content).size(Size::Fill),
                actions,
            ],
        ),
    )
    .emphasis(Emphasis::Accent)
    .activity(
        if app.session_activity(id) == crate::view::activity::Activity::Working {
            Activity::Busy
        } else {
            Activity::Idle
        },
    );
    if let Some(metadata) = metadata(app, area.width.saturating_sub(4)) {
        tree = tree.bottom(metadata);
    }
    let focused = app.overlay().is_none() && app.chat.view.search.is_none();
    if app.focus == Focus::Composer {
        app.chrome.composer.focus(EDITOR.into());
    }
    let context = Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: focused && matches!(app.focus, Focus::Composer | Focus::Page),
    };
    app.chrome
        .composer
        .render_motion(frame, area, tree, context, &mut app.chrome.animation);
    let Some(input) = app
        .chrome
        .composer
        .rect(EDITOR)
        .filter(|area| !area.is_empty())
    else {
        if let Some(editor) = app.drafts.get_mut(id) {
            editor.invalidate_geometry();
        }
        return;
    };
    if let Some(editor) = app.drafts.get_mut(id) {
        editor.draw(
            frame,
            input,
            focused && app.focus == Focus::Composer,
            app.theme.colors(),
        );
        if editor.text().is_empty() {
            frame.render_widget(
                Paragraph::new(app.i18n.text("composer-placeholder"))
                    .style(Style::default().fg(app.theme.colors().subtle)),
                input,
            );
        }
    } else {
        frame.render_widget(
            Paragraph::new(app.i18n.text("composer-draft-limit")).wrap(Wrap { trim: false }),
            input,
        );
    }
}

pub(super) fn feedback(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let item = feedback::current(app);
    let status = item
        .as_ref()
        .map_or_else(|| activity(app), |item| app.i18n.text(item.key));
    let has_details = item.as_ref().is_some_and(|item| item.detail.is_some());
    let status = if has_details {
        format!("{status}  {}", app.chrome.symbol("ⓘ", "i"))
    } else {
        status
    };
    let tone = if item.as_ref().is_some_and(|item| item.warning) {
        Tone::Warning
    } else {
        Tone::Muted
    };
    let mut notice = Node::text("notice", vec![(status, tone)])
        .align(Align::Center)
        .clip()
        .size(Size::Fill);
    if has_details {
        notice = notice
            .on(On::Activate(Action::ToggleDetails))
            .hint(action_label(app, &Action::ToggleDetails));
    }
    let mut children = vec![notice];
    let count = app.queue_rows().len();
    if count > 0 {
        let action = Action::Queue(crate::pages::queue::Command::Focus);
        children.push(
            Node::text(
                "queue",
                vec![(
                    format!(" {} {count} ", app.chrome.symbol("≡", "Q")),
                    Tone::Muted,
                )],
            )
            .on(On::Activate(action.clone()))
            .enabled(app.enabled(&action))
            .hint(action_label(app, &action)),
        );
    }
    let context = Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: false,
    };
    app.chrome
        .feedback
        .render(frame, area, Node::row("feedback", children), context);
}

fn metadata(app: &App, width: u16) -> Option<Node<Action>> {
    let Detail::Ready(item) = &app.sessions.detail else {
        return None;
    };
    let sandbox = app.i18n.text(sandbox_key(item));
    let context = app
        .chat
        .context
        .current_label(
            &item.model,
            item.llm_connection_id.as_deref(),
            app.chrome.ascii,
        )
        .filter(|_| {
            app.chat.error.is_none() && matches!(app.connection, ConnectionState::Connected { .. })
        })
        .filter(|text| usize::from(width) >= sandbox.width() + text.width() + 15);
    let available = usize::from(width)
        .saturating_sub(sandbox.width() + 8 + context.as_ref().map_or(0, |text| text.width() + 3));
    let thinking = item.thinking_level.map(|level| {
        app.i18n
            .text(crate::pages::manage::models::thinking_key(Some(level)))
    });
    let model = if available >= 6 {
        match thinking.filter(|level| available >= level.width() + 9) {
            Some(level) => format!(
                "{} · {level}",
                fit(&safe(&item.model), available - level.width() - 3)
            ),
            None => fit(&safe(&item.model), available),
        }
    } else {
        String::new()
    };
    let mut children = Vec::new();
    if !model.is_empty() {
        let mut label = Node::text("model", vec![(model, Tone::Subtle)]).clip();
        if let Some(action) = app.model_action() {
            label = label
                .enabled(app.enabled(&action))
                .hint(action_label(app, &action))
                .on(On::Activate(action));
        }
        children.push(label);
        children.push(Node::text(
            "model-separator",
            vec![(" · ".into(), Tone::Subtle)],
        ));
    }
    if let Some(context) = context {
        children.push(Node::text(
            "context",
            vec![(format!("{context} · "), Tone::Subtle)],
        ));
    }
    let mut sandbox = Node::text(
        "sandbox",
        vec![(
            sandbox,
            if item.sandbox_mode == maka_sandbox::Mode::DangerFullAccess {
                Tone::Warning
            } else {
                Tone::Subtle
            },
        )],
    )
    .clip();
    if let Some(action) = app.sandbox_action() {
        sandbox = sandbox
            .enabled(app.enabled(&action))
            .hint(action_label(app, &action))
            .on(On::Activate(action));
    }
    children.push(sandbox);
    Some(Node::row("metadata", children))
}
