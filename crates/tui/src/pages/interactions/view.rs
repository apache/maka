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

use super::{Command, State, form::VALUE, question::ANSWER, summary};
use crate::{
    app::{Action, App},
    ui::{Node, On, Role, Sheet, Size, Tone},
};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseEventKind};
use maka_protocol::interaction::InteractionOutcome;
use ratatui::Frame;

fn action(command: Command) -> Action {
    Action::Interaction(command)
}

/// Reviewing a pinned Host request: what it asks (permissions, a client
/// capability, questions or a form), what has happened to it, and the
/// decisions it allows. Initial focus only dismisses the sheet; nothing is
/// decided by Enter alone. A settled request no longer asks to return later.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    if !app.interactions.visible {
        return None;
    }
    let review = app.interactions.review.as_ref()?;
    let enabled = |command: Command| app.interaction_enabled(command);
    let (width, height) = app.frame_size.unwrap_or((80, 24));
    let ready = review.state == State::Ready;
    let questions = review.questions.as_ref().filter(|_| ready);
    let form = review.form.as_ref().filter(|_| ready);
    let mode = if questions.is_some() {
        "questions"
    } else if form.is_some() {
        "form"
    } else if review.details {
        "details"
    } else {
        "summary"
    };
    let mut sheet = Sheet::new(
        format!(
            "interaction:{}:{:?}:{mode}",
            review.ticket.snapshot.interaction_id(),
            review.state
        ),
        app.i18n.text("interaction-title"),
    );
    let status = if let Some(questions) = questions {
        for node in questions.nodes(&app.i18n, app.chrome.ascii, (width, height), enabled) {
            sheet = sheet.body(node);
        }
        questions
            .error()
            .map(|key| app.i18n.text(key))
            .unwrap_or_else(|| {
                app.i18n.format(
                    "question-progress",
                    &[
                        ("value", &questions.answered().to_string()),
                        ("count", &questions.len().to_string()),
                    ],
                )
            })
    } else if let Some(form) = form {
        for node in form.nodes(&app.i18n, app.chrome.ascii, (width, height), enabled) {
            sheet = sheet.body(node);
        }
        form.status(&app.i18n)
    } else {
        // The Host's words, one node per line; the kernel neutralizes them.
        let lines = summary::text(review, &app.i18n)
            .lines()
            .enumerate()
            .map(|(index, line)| {
                Node::text(index.to_string(), vec![(line.to_owned(), Tone::Normal)])
            })
            .collect();
        sheet = sheet.body(
            Node::scroll("summary", Node::column("lines", lines))
                .on(On::Scroll)
                .size(Size::Upto(height.saturating_sub(14).max(3))),
        );
        app.i18n.text(state(review))
    };
    let status = Node::text(
        "status",
        vec![(
            status,
            if review.state == State::Resolved {
                Tone::Subtle
            } else {
                Tone::Warning
            },
        )],
    );
    let commands = review.commands();
    // A permission's decisions, from refusing to the widest grant.
    let decisions: Vec<_> = [
        ("deny", Command::Deny, Role::Normal),
        ("once", Command::Once, Role::Normal),
        ("turn", Command::Turn, Role::Normal),
        ("session", Command::Session, Role::Caution),
    ]
    .into_iter()
    .filter(|(_, command, _)| commands.contains(command))
    .map(|(key, command, role)| {
        Node::button(key, app.i18n.text(command.label()), role)
            .size(Size::Fixed(1))
            .on(On::Activate(action(command)))
            .enabled(enabled(command))
    })
    .collect();
    if form.is_some() {
        // The other answers a form allows sit under what it would send.
        let respond = |key: &'static str, command: Command| {
            Node::button(key, app.i18n.text(command.label()), Role::Normal)
                .on(On::Activate(action(command)))
                .enabled(enabled(command))
        };
        sheet = sheet.body(Node::column(
            "outcome",
            vec![
                status,
                Node::row(
                    "responses",
                    vec![
                        respond("decline", Command::FormDecline),
                        respond("cancel", Command::FormCancel),
                    ],
                )
                .gap(2),
            ],
        ));
    } else {
        sheet = sheet.body(status);
    }
    if !decisions.is_empty() {
        sheet = sheet.body(Node::column("decisions", decisions));
    }
    if commands.contains(&Command::Details) {
        sheet = sheet.aside(
            "details",
            app.i18n.text(if review.details {
                "interaction-hide-details"
            } else {
                Command::Details.label()
            }),
            action(Command::Details),
            enabled(Command::Details),
        );
    }
    sheet = sheet.button(
        "close",
        app.i18n.text(if review.state == State::Resolved {
            "interaction-done"
        } else {
            Command::Close.label()
        }),
        Role::Normal,
        action(Command::Close),
        true,
    );
    let primary = if commands.contains(&Command::Check) {
        Some(Command::Check)
    } else if questions.is_some() {
        Some(Command::Submit)
    } else if form.is_some() {
        Some(Command::FormSubmit)
    } else {
        None
    };
    if let Some(command) = primary {
        sheet = sheet.button(
            "primary",
            app.i18n.text(command.label()),
            Role::Primary,
            action(command),
            enabled(command),
        );
    }
    Some(sheet.focus("close"))
}

fn state(review: &super::Review) -> &'static str {
    match review.state {
        State::Ready => "interaction-ready",
        State::Sending => "interaction-sending",
        State::Unknown => "interaction-unknown",
        State::Checking => "interaction-checking",
        State::Stale => "interaction-stale",
        State::Resolved => match review
            .outcome
            .as_ref()
            .and_then(|outcome| outcome.outcome())
        {
            Some(InteractionOutcome::Closure { .. }) => "interaction-closed",
            _ => "interaction-resolved",
        },
    }
}

/// Paints the free-text answer or the written form value over the sheet.
pub(crate) fn draw_field(frame: &mut Frame<'_>, app: &mut App) {
    let focused = app.layer.focused_path().map(str::to_owned);
    let answer = app.layer.slot(ANSWER).filter(|rect| !rect.is_empty());
    let value = app.layer.slot(VALUE).filter(|rect| !rect.is_empty());
    let colors = app.theme.colors();
    let (custom, input) = (
        app.i18n.text("question-custom"),
        app.i18n.text("form-input"),
    );
    let Some(review) = app.interactions.review.as_mut() else {
        return;
    };
    let ready = review.state == State::Ready;
    if let Some(questions) = &mut review.questions {
        let here = focused.as_deref() == Some(&format!("{ANSWER}/input"));
        questions.draw(frame, answer.filter(|_| ready), here, &custom, colors);
    }
    if let Some(form) = &mut review.form {
        let here = focused.as_deref() == Some(&format!("{VALUE}/input"));
        form.draw(frame, value.filter(|_| ready), here, &input, colors);
    }
}

impl App {
    /// The answer and value fields' keys, pastes and pointer, and Ctrl+Enter to
    /// submit, taken before the sheet while it is on screen.
    pub(crate) fn interaction_sheet_input(
        &mut self,
        event: &Event,
    ) -> Option<(bool, Option<Action>)> {
        if !self.interactions.rendered {
            return None;
        }
        let focused = self.layer.focused_path().map(str::to_owned);
        let review = self.interactions.review.as_mut()?;
        if review.state != State::Ready {
            return None;
        }
        if let Event::Key(key) = event
            && key.kind == KeyEventKind::Press
            && key.modifiers == KeyModifiers::CONTROL
            && key.code == KeyCode::Enter
        {
            let command = if review.questions.is_some() {
                Command::Submit
            } else if review.form.is_some() {
                Command::FormSubmit
            } else {
                return None;
            };
            return Some((true, self.apply(action(command))));
        }
        let in_answer = focused.as_deref() == Some(&format!("{ANSWER}/input"));
        let in_value = focused.as_deref() == Some(&format!("{VALUE}/input"));
        let press =
            matches!(event, Event::Mouse(mouse) if matches!(mouse.kind, MouseEventKind::Down(_)));
        if let Some(questions) = &mut review.questions {
            if let Event::Mouse(mouse) = event {
                if !questions.editor().takes(mouse) {
                    return None;
                }
                let changed = questions.editor().mouse(*mouse);
                if press {
                    questions.choose_text();
                    self.layer.focus(ANSWER);
                }
                return Some((changed || press, None));
            }
            return in_answer
                .then(|| questions.edit(event))
                .flatten()
                .map(|dirty| (dirty, None));
        }
        let form = review.form.as_mut()?;
        if let Event::Mouse(mouse) = event {
            let editor = form.editor().filter(|editor| editor.takes(mouse))?;
            let changed = editor.mouse(*mouse);
            if press {
                form.choose_text();
                self.layer.focus(VALUE);
            }
            return Some((changed || press, None));
        }
        in_value
            .then(|| form.edit(event))
            .flatten()
            .map(|dirty| (dirty, None))
    }
}
