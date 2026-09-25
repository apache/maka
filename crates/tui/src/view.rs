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
    app::{Action, App, ConnectionState, Focus, Hit, Notice},
    navigation::Route,
    pages::sessions::Detail,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Margin, Rect},
    style::{Modifier, Style},
    text::Line,
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

pub(crate) mod activity;
pub(crate) mod form;
pub(crate) mod queue;
mod session;
pub(crate) mod tone;

pub fn safe(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

pub(crate) fn clear_overlay(frame: &mut Frame<'_>, area: Rect) {
    let area = area.intersection(frame.area());
    if !area.is_empty() && area.x > frame.area().x {
        // Clear cannot erase the leading half of a wide glyph outside its rect.
        // Leaving that half makes the terminal consume the overlay's left edge.
        for y in area.y..area.bottom() {
            let cell = &mut frame.buffer_mut()[(area.x - 1, y)];
            if unicode_width::UnicodeWidthStr::width(cell.symbol()) > 1 {
                cell.set_symbol(" ");
            }
        }
    }
    frame.render_widget(Clear, area);
}

pub fn draw(frame: &mut Frame<'_>, app: &mut App) {
    let area = frame.area();
    app.begin_frame(area);
    let animated =
        app.chrome.motion && app.chrome.window_focused && !app.closing && app.overlay().is_none();
    app.chrome
        .animation
        .begin(std::time::Instant::now(), animated);
    let base = app.theme.colors().base();
    frame.render_widget(Block::default().style(base), area);
    if area.width < 30 || area.height < 10 {
        app.chrome.stop_animation();
        app.invalidate_editor_geometry();
        // Nothing drawn now stays clickable from the last full frame.
        app.sidebar.surface.invalidate();
        app.settings.surface.invalidate();
        app.home.surface.invalidate();
        app.apps.surface.invalidate();
        if let Some(surface) = app.apps_surface() {
            surface.invalidate();
        }
        frame.render_widget(
            Paragraph::new(app.i18n.text("terminal-small")).wrap(Wrap { trim: false }),
            area,
        );
        return;
    }
    let rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);
    let session = matches!(app.navigation.current(), Route::Session(_));
    let settings = app.navigation.current() == Route::Settings;
    let actions = app.page_actions();
    let header = Layout::horizontal([
        Constraint::Length(3),
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(if settings {
            0
        } else if session {
            actions
                .iter()
                .filter(|action| !composer_action(action))
                .count() as u16
                * 3
        } else {
            actions.len() as u16 * 3
        }),
        Constraint::Length(3),
    ])
    .split(rows[0]);
    icon_button(frame, app, header[0], Action::ToggleSidebar, false);
    icon_button(frame, app, header[1], Action::Back, false);
    let connection = match app.connection {
        ConnectionState::Disconnected => "connection-disconnected",
        ConnectionState::Connecting => "connection-connecting",
        ConnectionState::Connected { .. } => "connection-connected",
        ConnectionState::Failed(_) | ConnectionState::WrongEpoch => "connection-failed",
    };
    let title = match (&app.navigation.current(), &app.sessions.detail) {
        (Route::Session(id), Detail::Ready(item)) if *id == item.id => safe(&item.name),
        (Route::App(key), _) => app
            .apps
            .instance(key)
            .and_then(|instance| instance.title(app.i18n.locale().id()))
            .map(|title| safe(&title))
            .unwrap_or_else(|| app.i18n.text(Route::Extensions.title())),
        _ => app.i18n.text(app.navigation.current().title()),
    };
    // Center against the whole viewport, reserving equal space for both edges.
    // More contextual actions must not shift the title's visual center.
    let title_area = if session {
        let side = (header[3].width + header[4].width).max(header[0].width + header[1].width);
        Rect::new(
            area.x + side,
            header[2].y,
            area.width.saturating_sub(side * 2),
            1,
        )
        .intersection(header[2])
    } else {
        header[2]
    };
    let title = if matches!(app.connection, ConnectionState::Connected { .. }) {
        title
    } else {
        format!("{title} · {}", app.i18n.text(connection))
    };
    let title = if let Route::Session(id) = app.navigation.current()
        && title_area.width >= 16
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
        let color = if activity == activity::Activity::Waiting {
            app.theme.colors().warning
        } else {
            tone::accent(app.theme.colors())
        };
        Line::from(vec![
            ratatui::text::Span::styled(face, Style::default().fg(color)),
            " ".into(),
            session::fit(&title, usize::from(title_area.width - 8)).into(),
            "    ".into(),
        ])
    } else {
        Line::raw(title)
    };
    frame.render_widget(
        Paragraph::new(title)
            .style(Style::default().add_modifier(Modifier::BOLD))
            .alignment(if session {
                ratatui::layout::Alignment::Center
            } else {
                ratatui::layout::Alignment::Left
            }),
        title_area,
    );
    {
        let mut slot = 0;
        for (index, action) in actions.iter().enumerate() {
            if settings {
                break;
            }
            if composer_action(action) {
                continue;
            }
            let rect = Rect::new(header[3].x + slot * 3, header[3].y, 3, 1).intersection(header[3]);
            icon_button(
                frame,
                app,
                rect,
                action.clone(),
                app.focus == Focus::Page && app.selected_control == index,
            );
            slot += 1;
        }
    }
    icon_button(frame, app, header[4], Action::Palette, false);

    let nav_width = if app.fullscreen() {
        app.chrome.stop_animation();
        0
    } else {
        app.chrome
            .sidebar_width(area.width, std::time::Instant::now())
    };
    let columns =
        Layout::horizontal([Constraint::Length(nav_width), Constraint::Min(1)]).split(rows[1]);
    if nav_width > 0 {
        let nav = Block::default()
            .borders(Borders::RIGHT)
            .border_style(Style::default().fg(app.theme.colors().border));
        let inner = nav.inner(columns[0]).inner(Margin::new(1, 1));
        frame.render_widget(nav, columns[0]);
        crate::pages::sidebar::draw(frame, app, inner);
    } else {
        app.sidebar.surface.invalidate();
    }

    let page = columns[1].inner(Margin::new(1, 0));

    match app.navigation.current() {
        Route::Extensions => crate::apps::page::draw_directory(frame, app, page),
        Route::App(key) => crate::apps::page::draw(frame, app, page, &key),
        Route::Connections => crate::pages::connections::draw(frame, app, page),
        Route::Projects => crate::pages::projects::draw(frame, app, page),
        Route::Workspace => crate::pages::home::draw(frame, app, page, nav_width > 0),
        Route::Inbox => crate::pages::sessions::draw_catalog(frame, app, page),
        Route::Session(id) => session::draw(frame, app, page, &id),
        Route::Settings => crate::pages::settings::draw(frame, app, page),
    }
    crate::files::resolve_hits(app);
    let focused = match app.focus {
        Focus::Page => app.page_actions().get(app.selected_control).cloned(),
        _ => None,
    };
    let hint = if app.shutdown.stopping {
        app.i18n.text("shutdown-working")
    } else if app.closing {
        app.i18n.text("state-closing")
    } else if app.overlay().is_some() {
        String::new()
    } else if app.state_error.is_some() {
        if matches!(app.navigation.current(), Route::Session(_)) {
            String::new() // Already shown beside the composer, with its details affordance.
        } else {
            app.i18n.text("state-save-failed")
        }
    } else if let Some(Notice::Clipboard { key, .. } | Notice::Local(key)) = &app.notice {
        app.i18n.text(key)
    } else if let Some(Notice::Diagnostic(_)) = &app.notice {
        app.i18n.text("feedback-host-failed")
    } else if app
        .chat
        .reader()
        .is_some_and(|reader| reader.text_selection.active())
        && !app.chrome.details
    {
        app.i18n.text("chat-selection-help")
    } else if let Some(action) = app.hover.as_ref() {
        action_label(app, action)
    } else if let Some(hint) = app
        .sidebar
        .surface
        .hint(app.focus == Focus::Navigation)
        .or_else(|| match app.navigation.current() {
            Route::Settings => app.settings.surface.hint(app.focus == Focus::Page),
            Route::Workspace => app.home.surface.hint(app.focus == Focus::Page),
            Route::Extensions => app.apps.surface.hint(app.focus == Focus::Page),
            Route::Session(_) => app
                .apps
                .inspector
                .hint(app.focus == Focus::Inspector)
                .or_else(|| app.apps.status.hint(false)),
            Route::App(key) => app
                .apps
                .instance(&key)
                .and_then(|instance| instance.surface.hint(app.focus == Focus::Page)),
            _ => None,
        })
    {
        hint.to_owned()
    } else if let Some(action) = focused.as_ref() {
        action_label(app, action)
    } else if app.chat.view.search.is_some()
        && !app.chrome.details
        && matches!(app.navigation.current(), Route::Session(_))
    {
        app.i18n.text(
            app.chat
                .view
                .search
                .as_ref()
                .and_then(|search| search.editor.error)
                .unwrap_or(
                    if app
                        .chat
                        .view
                        .search
                        .as_ref()
                        .is_some_and(|search| search.history.is_some())
                    {
                        "chat-search-history-help"
                    } else {
                        "chat-search-help"
                    },
                ),
        )
    } else if app.focus == Focus::Composer {
        String::new()
    } else if app.focus == Focus::Transcript {
        app.i18n.text("chat-browse-help")
    } else if app.focus == Focus::Queue {
        app.i18n.text("queue-help")
    } else if app.focus == Focus::List && app.navigation.current() == Route::Connections {
        String::new()
    } else if app.focus == Focus::List && app.navigation.current() == Route::Projects {
        if app.projects.selected.is_some() {
            app.i18n.text("project-create-session")
        } else {
            String::new()
        }
    } else if app.focus == Focus::List {
        if app.catalog().items.is_empty() {
            String::new()
        } else {
            app.i18n.text("sessions-help")
        }
    } else {
        // No standing tutorial: shortcuts live in Help and the command palette.
        String::new()
    };
    frame.render_widget(
        Paragraph::new(hint).centered().style(Style::default().fg(
            if matches!(&app.notice, Some(Notice::Diagnostic(_))) {
                app.theme.colors().warning
            } else {
                app.theme.colors().subtle
            },
        )),
        Rect::new(page.x, rows[2].y, page.width, 1),
    );
    if matches!(&app.notice, Some(Notice::Diagnostic(_))) {
        app.hits.push(Hit {
            area: Rect::new(page.x, rows[2].y, page.width, 1),
            action: Action::Host,
        });
    }
    if let Some(overlay) = app.overlay() {
        crate::overlay::draw(frame, app, overlay, area, base);
    } else {
        app.layer.close();
        if app.tooltip_visible() {
            draw_tooltip(frame, app, area, base);
        }
    }
}

fn draw_tooltip(frame: &mut Frame<'_>, app: &mut App, area: Rect, base: Style) {
    let Some(action) = &app.hover else {
        return;
    };
    let Some(anchor) = app.hover_area else {
        return;
    };
    // Animation/resize can retire the region without another mouse event.
    if !app
        .hits
        .iter()
        .any(|hit| hit.area == anchor && &hit.action == action)
    {
        return;
    }
    let label = action_label(app, action);
    let width = (Line::raw(label.as_str()).width() as u16 + 2)
        .min(area.width - 2)
        .clamp(3, 62);
    let height = (Line::raw(label.as_str())
        .width()
        .div_ceil((width - 2) as usize) as u16
        + 2)
    .min(area.height);
    let y = if anchor.bottom() + height <= area.bottom() {
        anchor.bottom()
    } else {
        anchor.y.saturating_sub(height).max(area.y)
    };
    let popup = Rect::new(
        anchor.x.min(area.right() - width).max(area.x),
        y,
        width,
        height,
    );
    // Noninteractive tooltip: hidden buttons cannot receive an accidental click.
    if let Some(reader) = app.chat.reader_mut() {
        reader.text_selection.occluded = Some(popup);
    }
    app.hits
        .retain(|hit| hit.area.intersection(popup).is_empty());
    // Kernel surfaces drawn underneath lose pointer targets the tooltip covers.
    app.sidebar.surface.occlude(popup);
    app.settings.surface.occlude(popup);
    app.home.surface.occlude(popup);
    if let Some(surface) = app.apps_surface() {
        surface.occlude(popup);
    }
    clear_overlay(frame, popup);
    frame.render_widget(
        Paragraph::new(label)
            .wrap(Wrap { trim: false })
            .block(Block::bordered().border_style(Style::default().fg(app.theme.colors().accent)))
            .style(base),
        popup,
    );
}

fn composer_action(action: &Action) -> bool {
    matches!(
        action,
        Action::SendMessage
            | Action::SteerMessage
            | Action::ReconcileSubmission
            | Action::StopTurn(_)
    )
}
pub(crate) fn icon(app: &App, action: &Action) -> &'static str {
    let (unicode, ascii) = match action {
        Action::NextTab => ("›", ">"),
        Action::PreviousTab => ("‹", "<"),
        Action::CloseTab(_) => ("×", "x"),
        Action::Copy(_) => ("⧉", "C"),
        Action::CopyFile(_) => ("⧉", "C"),
        Action::OpenInteraction => ("!", "!"),
        Action::Interaction(_) => ("?", "?"),
        Action::Visit(Route::Workspace | Route::Session(_)) => ("▤", "W"),
        Action::Host => ("◉", "H"),
        Action::Visit(Route::Settings) => ("⛭", "S"),
        Action::Help | Action::CloseHelp => ("?", "?"),
        Action::Visit(Route::Projects) => ("▦", "P"),
        Action::Visit(Route::Extensions) => ("◇", "E"),
        Action::Visit(Route::App(_)) => ("◇", "E"),
        Action::Apps(message) => {
            use crate::apps::{Command, Message};
            match message {
                Message::Reload | Message::Instance(_, Command::Refresh | Command::ResumeDraft) => {
                    ("↻", "R")
                }
                Message::Instance(
                    _,
                    Command::Back | Command::CancelDiscard | Command::CancelDraft,
                ) => ("‹", "<"),
                Message::Instance(_, Command::Discard | Command::ConfirmDiscard) => ("×", "x"),
                Message::Instance(_, Command::Reconcile) => ("⌕", "?"),
                Message::Instance(_, Command::Retry) => ("↥", "^"),
                Message::Instance(_, Command::ApplyDraft) => ("✓", "+"),
                _ => ("◇", "E"),
            }
        }
        Action::Visit(Route::Connections) => ("⇄", "C"),
        Action::Connection(command) => match command {
            crate::pages::connections::Command::Select(_) => ("⇄", "C"),
            crate::pages::connections::Command::Refresh => ("↻", "R"),
            crate::pages::connections::Command::Next => ("›", ">"),
            crate::pages::connections::Command::Previous => ("‹", "<"),
        },
        Action::Project(command) => match command {
            crate::pages::projects::Command::Create(_) => ("+", "+"),
            crate::pages::projects::Command::Select(_) => ("▦", "P"),
            crate::pages::projects::Command::Refresh => ("↻", "R"),
            crate::pages::projects::Command::Next => ("›", ">"),
            crate::pages::projects::Command::Previous => ("‹", "<"),
        },
        Action::Visit(Route::Inbox) => {
            if app.inbox.error.is_some() {
                ("?", "?")
            } else if app.inbox_attention() {
                ("◆", "!")
            } else {
                ("◇", "I")
            }
        }
        Action::Back | Action::PreviousSessions => ("‹", "<"),
        Action::OlderMessages => ("↑", "^"),
        Action::NewerMessages => ("↓", "v"),
        Action::LatestMessages if app.chat.view.unseen => ("⇣", "v!"),
        Action::LatestMessages => ("⇣", "v"),
        Action::ToggleMessage(key) if app.chat.view.folded(key) => ("▸", ">"),
        Action::ToggleMessage(_) => ("▾", "v"),
        Action::SendMessage if app.stop_target().is_some() => ("↳", "+"),
        Action::SendMessage => ("➤", ">"),
        Action::SteerMessage => ("↗", "S"),
        Action::Queue(command) => match command {
            crate::pages::queue::Command::Focus | crate::pages::queue::Command::Select(_) => {
                ("≡", "Q")
            }
            crate::pages::queue::Command::Edit(_) => ("✎", "e"),
            crate::pages::queue::Command::Retract(_) | crate::pages::queue::Command::Close => {
                ("×", "x")
            }
            crate::pages::queue::Command::Promote(_) => ("↗", "s"),
            crate::pages::queue::Command::Save => ("✓", "v"),
            crate::pages::queue::Command::Reorder(_, false) => ("↑", "^"),
            crate::pages::queue::Command::Reorder(_, true) => ("↓", "v"),
        },
        Action::StopTurn(_) => ("■", "x"),
        Action::ReconcileSubmission | Action::RetrySubmission => ("⟳", "R"),
        Action::CreateSession => ("+", "+"),
        Action::Manage(crate::pages::manage::Command::Open(
            target,
            crate::pages::manage::Kind::Model,
        )) if target.is_default_model() => ("☆", "D"),
        Action::Manage(crate::pages::manage::Command::Open(
            _,
            crate::pages::manage::Kind::Register,
        )) => ("⊕", "+"),
        Action::Manage(crate::pages::manage::Command::Open(
            _,
            crate::pages::manage::Kind::Rename,
        )) => ("✎", "e"),
        Action::Manage(crate::pages::manage::Command::Open(
            _,
            crate::pages::manage::Kind::Locations,
        )) => ("ⓘ", "i"),
        Action::Manage(_) => ("⋯", "."),
        Action::Attachment(_) => ("⊕", "+"),
        Action::References => ("▱", "/"),
        Action::Skills(_) => ("✧", "*"),
        Action::Recap(_) => ("≡", "="),
        Action::Resume(_) => ("↻", "R"),
        Action::Branch(_) => ("↳", "+"),
        Action::Revision(_) => ("↶", "<"),
        Action::Onboard(_) => ("⊕", "+"),
        Action::Forward | Action::NextSessions => ("›", ">"),
        Action::Refresh | Action::RefreshSession | Action::RefreshSessions => ("↻", "R"),
        Action::Connect => ("⏻", "C"),
        Action::Palette | Action::ClosePalette => ("⌘", ":"),
        Action::ToggleSidebar => ("≡", "="),
        Action::ToggleFullscreen if app.fullscreen() => ("⊡", "-"),
        Action::ToggleFullscreen => ("⛶", "+"),
        Action::ToggleDetails => ("ⓘ", "i"),
        Action::ToggleInspector => ("◨", "]"),
        Action::ToggleTrace => ("⋯", "."),
        Action::BrowseTranscript => ("▤", "B"),
        Action::Search(command) => match command {
            crate::pages::chat::render::search::Command::Open => ("⌕", "/"),
            crate::pages::chat::render::search::Command::Close => ("×", "x"),
            crate::pages::chat::render::search::Command::Next => ("↓", "v"),
            crate::pages::chat::render::search::Command::Previous => ("↑", "^"),
            crate::pages::chat::render::search::Command::Scope => ("∞", "*"),
            crate::pages::chat::render::search::Command::Restart => ("↻", "R"),
            crate::pages::chat::render::search::Command::Pick(_) => ("›", ">"),
            crate::pages::chat::render::search::Command::PreviewToggle(_) => ("▾", "v"),
        },
        Action::ToggleTheme => ("◐", "T"),
        Action::Theme(_) => ("◒", "C"),
        Action::CycleLocale => ("文", "L"),
        Action::ToggleSymbols => ("◇", "A"),
        Action::ToggleMotion => ("≈", "M"),
        Action::Settings(_) => ("⛭", "S"),
        Action::Sidebar(_) | Action::Home(_) => ("≡", "="),
        Action::Quit | Action::Detach | Action::ConfirmQuit | Action::CancelQuit => ("×", "X"),
    };
    app.chrome.symbol(unicode, ascii)
}

pub(crate) fn action_label(app: &App, action: &Action) -> String {
    if matches!(
        action,
        Action::Manage(crate::pages::manage::Command::Open(
            _,
            crate::pages::manage::Kind::Model
        ))
    ) && app.model_action().as_ref() == Some(action)
        && let Detail::Ready(item) = &app.sessions.detail
    {
        return app.i18n.format(
            "session-model-thinking",
            &[
                ("name", &safe(&item.model)),
                (
                    "state",
                    &app.i18n.text(crate::pages::manage::models::thinking_key(
                        item.thinking_level,
                    )),
                ),
            ],
        );
    }
    if let Action::Manage(crate::pages::manage::Command::Directory(
        crate::pages::manage::directory::Command::RemoveReference(index),
    )) = action
        && let Some(target) = app.directory_reference_target()
        && let Some(item) = app.reference_items(target).get(*index)
    {
        return format!(
            "{} · {}",
            app.i18n.text("references-remove"),
            safe(&item.path)
        );
    }
    if let Action::CopyFile(path) = action {
        return safe(path);
    }
    if let Action::Visit(Route::Session(id)) = action {
        return app
            .tabs
            .entries
            .iter()
            .find(|tab| tab.id == *id)
            .and_then(|tab| tab.name.as_deref())
            .or_else(|| {
                app.sessions
                    .items
                    .iter()
                    .find(|item| item.id == *id)
                    .map(|item| item.name.as_str())
            })
            .map_or_else(|| app.i18n.text("route-session"), safe);
    }
    if let Action::ToggleMessage(message) = action
        && let Some(state) = app.chat.view.tool_status(message)
    {
        let action = if app.chat.view.folded(message) {
            "chat-expand"
        } else {
            "chat-collapse"
        };
        return app.i18n.format(
            "tool-toggle",
            &[
                ("state", &app.i18n.text(state)),
                ("action", &app.i18n.text(action)),
            ],
        );
    }
    let key = match action {
        Action::Attachment(command) => command.label(),
        Action::References => "references-title",
        Action::Skills(command) => command.label(),
        Action::Apps(message) => message.label(),
        Action::NextTab => "tabs-next",
        Action::PreviousTab => "tabs-previous",
        Action::CloseTab(_) => "tabs-close",
        Action::Copy(mode) => mode.label(),
        Action::CopyFile(_) => "file-copy-path",
        Action::Interaction(command) => command.label(),
        Action::OpenInteraction => "interaction-open",
        Action::OlderMessages => "chat-older",
        Action::NewerMessages => "chat-newer",
        Action::LatestMessages if app.chat.view.unseen => "chat-new-output",
        Action::LatestMessages => "chat-latest",
        Action::ToggleMessage(key) if app.chat.view.folded(key) => "chat-expand",
        Action::ToggleMessage(_) => "chat-collapse",
        Action::SendMessage if app.stop_target().is_some() => "queue-send",
        Action::SendMessage => "chat-send",
        Action::SteerMessage => "queue-steer",
        Action::Queue(crate::pages::queue::Command::Select(target)) => {
            if let Some(row) = app.queue_rows().iter().find(|row| &row.target == target) {
                return app.i18n.text(row.kind.label());
            }
            "queue-focus"
        }
        Action::Queue(command) => command.label(),
        Action::StopTurn(target) if app.chat.stop.pending(target) => "chat-stopping",
        Action::StopTurn(_) => "chat-stop",
        Action::ReconcileSubmission => "chat-reconcile",
        Action::RetrySubmission => "chat-retry-original",
        Action::CreateSession => "session-create",
        Action::Manage(command) => command.label(),
        Action::Branch(command) => command.label(),
        Action::Recap(command) => command.label(),
        Action::Resume(command) => command.label(),
        Action::Revision(command) => command.label(),
        Action::Onboard(command) => command.label(),
        Action::Project(command) => command.label(),
        Action::Connection(command) => command.label(),
        Action::Visit(Route::Inbox) if app.inbox.error.is_some() => "inbox-unavailable",
        Action::Visit(Route::Inbox) if app.inbox_attention() => "inbox-pending",
        Action::Visit(route) => route.title(),
        Action::Host => "route-host",
        Action::Help | Action::CloseHelp => "route-help",
        Action::Back => "footer-back",
        Action::Forward => "footer-forward",
        Action::Palette | Action::ClosePalette => "footer-commands",
        Action::Connect => "command-connect",
        Action::Refresh | Action::RefreshSession | Action::RefreshSessions => "command-refresh",
        Action::ToggleTheme => "button-theme",
        Action::Theme(command) => command.label(),
        Action::CycleLocale => {
            return app.i18n.format(
                "button-language",
                &[("language", &app.i18n.language_name())],
            );
        }
        Action::PreviousSessions => "sessions-previous",
        Action::NextSessions => "sessions-next",
        Action::ToggleSidebar => "command-sidebar",
        Action::ToggleFullscreen => "command-fullscreen",
        Action::ToggleDetails => "command-details",
        Action::ToggleInspector if app.chrome.inspector => "command-inspector-hide",
        Action::ToggleInspector => "command-inspector-show",
        Action::ToggleTrace if app.chat.view.trace => "command-trace-hide",
        Action::ToggleTrace => "command-trace-show",
        Action::BrowseTranscript => "chat-browse",
        Action::Search(command) => match command {
            crate::pages::chat::render::search::Command::Open => "chat-search",
            crate::pages::chat::render::search::Command::Close => "chat-search-close",
            crate::pages::chat::render::search::Command::Next => "chat-search-next",
            crate::pages::chat::render::search::Command::Previous => "chat-search-previous",
            crate::pages::chat::render::search::Command::Scope => "chat-search-scope-toggle",
            crate::pages::chat::render::search::Command::Restart => "chat-search-restart",
            crate::pages::chat::render::search::Command::Pick(_) => "chat-search-preview",
            crate::pages::chat::render::search::Command::PreviewToggle(_) => "chat-toggle-message",
        },
        Action::ToggleSymbols => "command-symbols",
        Action::ToggleMotion => "command-motion",
        Action::Settings(_) => "route-settings",
        Action::Sidebar(_) | Action::Home(_) => "route-workspace",
        Action::Quit => "footer-quit",
        Action::Detach => "command-detach",
        Action::ConfirmQuit => "shutdown-force",
        Action::CancelQuit => "shutdown-cancel",
    };
    app.i18n.text(key)
}

fn icon_button(frame: &mut Frame<'_>, app: &mut App, area: Rect, action: Action, focused: bool) {
    let title = icon(app, &action);
    button(frame, app, area, title, action, focused);
}

pub(crate) fn button(
    frame: &mut Frame<'_>,
    app: &mut App,
    rect: Rect,
    title: &str,
    action: Action,
    focused: bool,
) {
    control(
        frame,
        app,
        rect,
        Paragraph::new(title).centered(),
        action,
        focused,
    );
}

/// List entries and field-like selectors share interaction styling, not the
/// centering of standalone actions. Keep their leading scan edge stable.
pub(crate) fn list_item(
    frame: &mut Frame<'_>,
    app: &mut App,
    rect: Rect,
    title: &str,
    action: Action,
    focused: bool,
) {
    control(frame, app, rect, Paragraph::new(title), action, focused);
}

fn control(
    frame: &mut Frame<'_>,
    app: &mut App,
    rect: Rect,
    label: Paragraph<'_>,
    action: Action,
    focused: bool,
) {
    if rect.is_empty() {
        return;
    }
    let enabled = app.enabled(&action);
    let destructive = action == Action::ConfirmQuit
        || (matches!(action, Action::Manage(crate::pages::manage::Command::Save))
            && app.management.destructive());
    let caution = matches!(action, Action::Manage(crate::pages::manage::Command::Save))
        && app.sandbox_disabling();
    let style = if !enabled {
        Style::default()
            .fg(app.theme.colors().subtle)
            .add_modifier(Modifier::DIM)
    } else if focused || app.hover.as_ref() == Some(&action) {
        tone::selection(app.theme.colors()).fg(if destructive {
            app.theme.colors().error
        } else if caution {
            app.theme.colors().warning
        } else {
            tone::accent(app.theme.colors())
        })
    } else if destructive {
        Style::default().fg(app.theme.colors().error)
    } else if caution {
        Style::default().fg(app.theme.colors().warning)
    } else if matches!(
        action,
        Action::SendMessage | Action::SteerMessage | Action::StopTurn(_)
    ) {
        Style::default().fg(tone::accent(app.theme.colors()))
    } else {
        Style::default().fg(app.theme.colors().muted)
    };
    frame.render_widget(label.style(style), rect);
    if enabled {
        app.hits.push(Hit { area: rect, action });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use ratatui::{Terminal, backend::TestBackend};

    fn render(app: &mut App, width: u16, height: u16) -> Terminal<TestBackend> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw(frame, app)).unwrap();
        terminal
    }
    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }
    fn click(x: u16, y: u16) -> Event {
        Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        })
    }

    #[test]
    fn modal_consumes_enter_and_outside_click_without_page_activation() {
        let mut app = App::new(
            "/unconfigured".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::En),
                crate::Locale::En,
            ),
        );
        app.apply(Action::Visit(Route::Settings));
        app.hover = Some(Action::Host);
        app.apply(Action::Palette);
        assert_eq!(
            app.hover, None,
            "covered page hover must not highlight a modal item"
        );
        render(&mut app, 120, 40);
        assert_eq!(app.input(click(1, 5)).1, None);
        assert_eq!(app.navigation.current(), Route::Settings);
        assert!(app.palette.is_none());
        app.apply(Action::Palette);
        render(&mut app, 120, 40);
        app.input(key(KeyCode::Enter));
        assert_eq!(app.navigation.current(), Route::Workspace);
        assert!((app.theme.choice != crate::theme::Choice::Terminal));
        assert_eq!(app.palette, None);
    }

    /// Cell position of the first occurrence of `text` on screen.
    fn locate(terminal: &Terminal<TestBackend>, text: &str) -> (u16, u16) {
        use unicode_width::UnicodeWidthStr;
        let buffer = terminal.backend().buffer();
        for y in 0..buffer.area.height {
            let (mut row, mut starts, mut x) = (String::new(), vec![], 0);
            while x < buffer.area.width {
                let symbol = buffer[(x, y)].symbol();
                starts.push((row.len(), x));
                row.push_str(symbol);
                x += (symbol.width() as u16).max(1);
            }
            if let Some(byte) = row.find(text) {
                let (_, x) = starts.iter().rev().find(|(at, _)| *at <= byte).unwrap();
                return (*x, y);
            }
        }
        panic!("{text:?} is not on screen");
    }

    #[test]
    fn resized_screen_invalidates_old_mouse_regions() {
        let mut app = App::new(
            "/unconfigured".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::En),
                crate::Locale::En,
            ),
        );
        app.apply(Action::Visit(Route::Settings));
        let terminal = render(&mut app, 120, 40);
        let (x, y) = locate(&terminal, "Maka dark");
        app.input(Event::Resize(80, 24));
        app.input(click(x, y));
        assert!(
            !app.settings.surface.captures(),
            "a click against the previous frame's geometry is ignored"
        );
        let terminal = render(&mut app, 80, 24);
        let (x, y) = locate(&terminal, "Maka dark");
        app.input(click(x, y));
        assert!(app.settings.surface.captures());
        let terminal = render(&mut app, 80, 24);
        let (x, y) = locate(&terminal, "○ Dusk");
        app.input(click(x, y));
        assert_eq!(app.theme.choice, crate::theme::Choice::Dusk);
        assert!(!app.settings.surface.captures());
    }

    #[test]
    fn keyboard_and_mouse_share_primary_action() {
        let app = || {
            App::new(
                "/unconfigured".into(),
                crate::i18n::I18n::new(
                    crate::LocalePreference::Explicit(crate::Locale::En),
                    crate::Locale::En,
                ),
            )
        };
        let mut keyboard = app();
        keyboard.focus = Focus::Page;
        render(&mut keyboard, 120, 40);
        let by_key = keyboard.input(key(KeyCode::Enter)).1;
        let mut mouse = app();
        let terminal = render(&mut mouse, 120, 40);
        let (x, y) = locate(&terminal, "Connect");
        let by_mouse = mouse.input(click(x, y)).1;
        assert_eq!(by_key, Some(Action::Connect), "home's primary action");
        assert_eq!(by_key, by_mouse);
        assert_eq!(keyboard.navigation.current(), mouse.navigation.current());
        assert_eq!(keyboard.focus, mouse.focus);
    }

    #[test]
    fn drafts_survive_routes_locale_and_reconnect_without_modal_input_leaks() {
        let mut app = App::new(
            "/unconfigured".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::En),
                crate::Locale::En,
            ),
        );
        app.apply(Action::Visit(Route::Session("a".into())));
        render(&mut app, 120, 40);
        app.input(Event::Paste("独立草稿 👩🏽‍💻".into()));
        let normal_area = (0..40)
            .map(|y| {
                (0..120)
                    .filter(|x| app.drafts["a"].contains(ratatui::layout::Position::new(*x, y)))
                    .count()
            })
            .sum::<usize>();
        app.apply(Action::ToggleFullscreen);
        render(&mut app, 120, 40);
        let focused_area = (0..40)
            .map(|y| {
                (0..120)
                    .filter(|x| app.drafts["a"].contains(ratatui::layout::Position::new(*x, y)))
                    .count()
            })
            .sum::<usize>();
        assert!(
            focused_area > normal_area,
            "focus mode must return space to content"
        );
        for _ in 0..6 {
            app.input(key(KeyCode::Tab));
            assert_ne!(app.focus, Focus::Navigation);
        }
        app.focus = Focus::Composer;
        app.apply(Action::ToggleFullscreen);
        render(&mut app, 120, 40);
        let point = (0..40)
            .find_map(|y| {
                (0..120).find_map(|x| {
                    app.drafts["a"]
                        .contains(ratatui::layout::Position::new(x, y))
                        .then_some((x, y))
                })
            })
            .unwrap();
        app.apply(Action::Palette);
        render(&mut app, 120, 40);
        app.input(Event::Paste("must not leak".into()));
        app.input(click(point.0, point.1));
        assert!(app.palette.is_none());
        assert_eq!(app.focus, Focus::Composer);
        assert_eq!(app.drafts["a"].text(), "独立草稿 👩🏽‍💻");
        app.apply(Action::CycleLocale);
        app.apply(Action::Visit(Route::Session("b".into())));
        app.input(Event::Paste("another draft".into()));
        app.apply(Action::Back);
        render(&mut app, 80, 24);
        assert_eq!(app.navigation.current(), Route::Session("a".into()));
        app.apply(Action::Connect);
        assert_eq!(app.drafts["a"].text(), "独立草稿 👩🏽‍💻");
        assert_eq!(app.drafts["b"].text(), "another draft");
        for index in 0..32 {
            app.apply(Action::Visit(Route::Session(index.to_string())));
        }
        assert_eq!(app.drafts.len(), 32);
        assert_eq!(app.drafts["a"].text(), "独立草稿 👩🏽‍💻");
        assert!(!app.drafts.contains_key("31")); // Capacity never silently evicts a draft.
    }

    #[test]
    fn tooltip_explains_icons_without_clicking_through_covered_controls() {
        let mut app = App::new(
            "/unconfigured".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::En),
                crate::Locale::En,
            ),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        let mut terminal = render(&mut app, 120, 40);
        let anchor = app
            .hits
            .iter()
            .find(|hit| hit.action == Action::ToggleSidebar)
            .unwrap()
            .area;
        let covered = locate(&terminal, "New session");
        app.hover = Some(Action::ToggleSidebar);
        app.hover_area = Some(anchor);
        terminal
            .draw(|frame| {
                draw(frame, &mut app);
                draw_tooltip(frame, &mut app, frame.area(), Style::default());
            })
            .unwrap();
        // The sidebar row under the tooltip is not clickable through it.
        assert_eq!(app.input(click(covered.0, covered.1)), (true, None));
        assert!(!app.creating);
        assert_eq!(app.focus, Focus::Navigation);
        let screen = terminal
            .backend()
            .buffer()
            .content
            .chunks(120)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(screen.contains("Expand / collapse navigation · Ctrl+B"));
    }

    #[test]
    fn every_route_and_modal_render_within_tiny_and_normal_viewports() {
        for locale in crate::Locale::ALL {
            for (width, height) in [
                (0, 0),
                (1, 1),
                (29, 9),
                (30, 10),
                (80, 24),
                (120, 40),
                (160, 50),
            ] {
                for route in Route::ALL
                    .into_iter()
                    .chain([Route::Session("session-test".into())])
                {
                    let mut app = App::new(
                        "/unconfigured/中文".into(),
                        crate::i18n::I18n::new(
                            crate::LocalePreference::Explicit(crate::Locale::En),
                            crate::Locale::En,
                        ),
                    );
                    app.i18n.preference = crate::LocalePreference::Explicit(locale);
                    app.apply(Action::Visit(route));
                    let terminal = render(&mut app, width, height);
                    let area = terminal.backend().buffer().area;
                    assert!(
                        app.hits
                            .iter()
                            .all(|hit| hit.area.intersection(area) == hit.area)
                    );
                    app.apply(Action::Palette);
                    render(&mut app, width, height);
                    assert!(app.i18n.diagnostics().is_empty());
                }
            }
        }
    }

    #[test]
    fn live_language_switch_preserves_connection_history_and_keyboard_focus() {
        let mut app = App::new(
            "/unconfigured".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::ZhCn),
                crate::Locale::En,
            ),
        );
        app.apply(Action::Visit(Route::Extensions));
        app.apply(Action::Visit(Route::Settings));
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.status = Some(serde_json::json!({"state": "ready", "hostEpoch": "epoch"}));
        render(&mut app, 80, 24);
        // Category selection follows the keyboard; Right enters its rows.
        for code in [KeyCode::Down, KeyCode::Right, KeyCode::Enter] {
            app.input(key(code));
            render(&mut app, 80, 24);
        }
        assert!(
            app.settings.surface.captures(),
            "Enter opens the language chooser"
        );
        app.input(key(KeyCode::Down));
        app.input(key(KeyCode::Enter));
        assert!(
            app.hits.is_empty(),
            "language changes invalidate previous text geometry"
        );
        assert_eq!(app.i18n.locale(), crate::Locale::ZhTw);
        assert_eq!(app.focus, Focus::Page);
        assert!(matches!(app.connection, ConnectionState::Connected { .. }));
        assert_eq!(app.status.as_ref().unwrap()["hostEpoch"], "epoch");
        let terminal = render(&mut app, 80, 24);
        assert_eq!(
            app.settings.surface.hint(true),
            Some("選擇語言 · Enter"),
            "keyboard focus stays on the relabeled row"
        );
        let (x, y) = locate(&terminal, "繁體中文");
        app.input(click(x, y));
        let terminal = render(&mut app, 80, 24);
        let (x, y) = locate(&terminal, "○ English");
        app.input(click(x, y));
        assert_eq!(app.i18n.locale(), crate::Locale::En);
        render(&mut app, 80, 24);
        for _ in 0..8 {
            if app.focus == Focus::Navigation {
                break;
            }
            app.input(key(KeyCode::BackTab));
        }
        assert_eq!(
            app.focus,
            Focus::Navigation,
            "Tab past the first control leaves the page"
        );
        app.apply(Action::Back);
        assert_eq!(app.navigation.current(), Route::Extensions);
    }

    #[test]
    fn buttons_center_cell_width_without_centering_lists_or_shrinking_hit_targets() {
        use unicode_width::UnicodeWidthStr;
        for title in ["关闭", "關閉", "Close", "⛭", "e\u{301}", "🦀"] {
            for padding in [2, 3] {
                let mut app = App::new(
                    "/unused".into(),
                    crate::i18n::I18n::new(crate::LocalePreference::Auto, crate::Locale::En),
                );
                let width = title.width() as u16 + padding;
                let rect = Rect::new(2, 0, width, 1);
                let row = Rect::new(2, 1, width, 1);
                let disabled = Rect::new(2, 2, width, 1);
                let mut terminal = Terminal::new(TestBackend::new(20, 3)).unwrap();
                terminal
                    .draw(|frame| {
                        button(frame, &mut app, rect, title, Action::ToggleSymbols, true);
                        list_item(frame, &mut app, row, title, Action::ToggleMotion, true);
                        button(frame, &mut app, disabled, title, Action::SendMessage, true);
                        button(frame, &mut app, Rect::default(), title, Action::Quit, true);
                    })
                    .unwrap();
                let buffer = terminal.backend().buffer();
                let first = unicode_segmentation::UnicodeSegmentation::graphemes(title, true)
                    .next()
                    .unwrap();
                let centered_x = (rect.x..rect.right())
                    .find(|x| buffer[(*x, rect.y)].symbol() == first)
                    .expect("complete label start");
                let left = centered_x - rect.x;
                let right = rect.right() - centered_x - title.width() as u16;
                assert!(
                    left >= 1 && right >= 1 && left.abs_diff(right) <= 1,
                    "{title}: {left}/{right}"
                );
                assert_eq!(buffer[(centered_x, rect.y)].symbol(), first, "{title}");
                assert_eq!(buffer[(row.x, row.y)].symbol(), first);
                assert_eq!(buffer[(centered_x, disabled.y)].symbol(), first);
                for x in rect.x..centered_x {
                    assert_eq!(buffer[(x, rect.y)].symbol(), " ");
                }
                for x in centered_x + title.width() as u16..rect.right() {
                    assert_eq!(buffer[(x, rect.y)].symbol(), " ");
                }
                assert_eq!(
                    buffer[(rect.x, rect.y)].bg,
                    buffer[(rect.right() - 1, rect.y)].bg
                );
                assert_eq!(
                    app.hits.len(),
                    2,
                    "disabled/empty buttons have no hit targets"
                );
                assert_eq!(app.hits[0].area, rect, "padding remains clickable");
                assert_eq!(app.hits[1].area, row);
            }
        }
    }

    #[test]
    fn text_from_host_or_path_cannot_inject_terminal_controls() {
        assert_eq!(safe("中文\x1b]52;bad\x07\n"), "中文 ]52;bad  ");
    }
}
