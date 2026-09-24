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

use super::Command;
use crate::{
    app::Action,
    editor::Editor,
    i18n::I18n,
    ui::{Node, On, Role, Size, Tone},
    view::safe,
};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use maka_protocol::interaction::InteractionQuestion;

/// The free-text answer field, by its path in the sheet.
pub(super) const ANSWER: &str = "question/answer";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Answer {
    Unset,
    Option(usize),
    Text,
    Skip,
}
struct Draft {
    answer: Answer,
    editor: Editor,
}
pub struct Questions {
    questions: Vec<InteractionQuestion>,
    drafts: Vec<Draft>,
    current: usize,
}
impl Questions {
    pub fn new(questions: Vec<InteractionQuestion>) -> Self {
        Self {
            drafts: questions
                .iter()
                .map(|_| Draft {
                    answer: Answer::Unset,
                    editor: Editor::bounded(2048, "question-too-large"),
                })
                .collect(),
            questions,
            current: 0,
        }
    }
    pub fn invalidate_geometry(&mut self) {
        for draft in &mut self.drafts {
            draft.editor.invalidate_geometry();
        }
    }
    pub fn accepts(&self, command: Command) -> bool {
        match command {
            Command::Close | Command::FreeText | Command::Skip | Command::Submit => true,
            Command::Question(index) => index < self.questions.len(),
            Command::Option(index) => index < self.questions[self.current].options.len(),
            _ => false,
        }
    }
    fn answer(&self, index: usize) -> Option<Option<String>> {
        match self.drafts[index].answer {
            Answer::Unset => None,
            Answer::Skip => Some(None),
            Answer::Option(option) => Some(Some(
                self.questions[index].options.get(option)?.label.clone(),
            )),
            Answer::Text => {
                let text = self.drafts[index].editor.text();
                (!text.trim().is_empty()).then(|| Some(text.to_owned()))
            }
        }
    }
    pub fn answered(&self) -> usize {
        (0..self.drafts.len())
            .filter(|index| self.answer(*index).is_some())
            .count()
    }
    pub fn len(&self) -> usize {
        self.questions.len()
    }
    pub fn answers(&self) -> Option<Vec<Option<String>>> {
        (0..self.drafts.len())
            .map(|index| self.answer(index))
            .collect()
    }
    pub fn error(&self) -> Option<&'static str> {
        self.drafts[self.current].editor.error
    }
    pub fn apply(&mut self, command: Command) {
        if !self.accepts(command) {
            return;
        }
        match command {
            Command::Question(index) => {
                self.current = index;
                self.invalidate_geometry();
            }
            Command::Option(index) => self.drafts[self.current].answer = Answer::Option(index),
            Command::FreeText => self.drafts[self.current].answer = Answer::Text,
            Command::Skip => self.drafts[self.current].answer = Answer::Skip,
            _ => {}
        }
    }

    /// The free-text field's keys and pastes: writing chooses it as the answer.
    pub fn edit(&mut self, event: &Event) -> Option<bool> {
        let draft = &mut self.drafts[self.current];
        let before = draft.editor.text().to_owned();
        let dirty = match event {
            Event::Key(key)
                if key.kind != KeyEventKind::Release
                    && !matches!(
                        key.code,
                        KeyCode::Esc
                            | KeyCode::Tab
                            | KeyCode::BackTab
                            | KeyCode::Up
                            | KeyCode::Down
                    )
                    && !(key.modifiers.contains(KeyModifiers::CONTROL)
                        && matches!(key.code, KeyCode::Char('q' | 's'))) =>
            {
                draft.editor.key(*key)
            }
            Event::Paste(text) => draft.editor.insert(text),
            _ => return None,
        };
        if draft.editor.text() != before {
            draft.answer = Answer::Text;
        }
        Some(dirty)
    }

    pub fn editor(&mut self) -> &mut Editor {
        &mut self.drafts[self.current].editor
    }

    /// A press in the field writes the answer there.
    pub fn choose_text(&mut self) {
        self.drafts[self.current].answer = Answer::Text;
    }

    /// The question tabs, the current question with its choices, and the
    /// free-text answer row.
    pub(super) fn nodes(
        &self,
        i18n: &I18n,
        ascii: bool,
        (width, height): (u16, u16),
        enabled: impl Fn(Command) -> bool,
    ) -> Vec<Node<Action>> {
        let action = Action::Interaction;
        let tabs = (0..self.questions.len())
            .map(|index| {
                let mark = match self.answer(index) {
                    None => {
                        if ascii {
                            "?"
                        } else {
                            "○"
                        }
                    }
                    Some(None) => "-",
                    Some(Some(_)) => {
                        if ascii {
                            "*"
                        } else {
                            "✓"
                        }
                    }
                };
                let command = Command::Question(index);
                Node::button(
                    index.to_string(),
                    format!("{} {mark}", index + 1),
                    Role::Normal,
                )
                .on(On::Activate(action(command)))
                .enabled(enabled(command))
                .current(index == self.current)
            })
            .collect();
        let question = &self.questions[self.current];
        let draft = &self.drafts[self.current];
        let mut choices = vec![Node::text(
            "question",
            vec![(safe(&question.question), Tone::Normal)],
        )];
        for (index, option) in question.options.iter().enumerate() {
            let chosen = draft.answer == Answer::Option(index);
            let mark = match (chosen, ascii) {
                (true, false) => "●",
                (false, false) => "○",
                (true, true) => "(*)",
                (false, true) => "( )",
            };
            let mut lines = vec![Node::text(
                "label",
                vec![(format!("{mark} {}", safe(&option.label)), Tone::Accent)],
            )];
            if let Some(description) = &option.description {
                lines.push(Node::text(
                    "description",
                    vec![(format!("  {}", safe(description)), Tone::Subtle)],
                ));
            }
            let command = Command::Option(index);
            choices.push(
                Node::column(format!("option-{index}"), lines)
                    .on(On::Activate(action(command)))
                    .enabled(enabled(command))
                    .current(chosen),
            );
        }
        let skipped = draft.answer == Answer::Skip;
        choices.push(
            Node::text(
                "skip",
                vec![(
                    format!(
                        "{} {}",
                        if skipped { "[x]" } else { "[ ]" },
                        i18n.text("question-skip")
                    ),
                    Tone::Accent,
                )],
            )
            .on(On::Activate(action(Command::Skip)))
            .enabled(enabled(Command::Skip))
            .current(skipped),
        );
        let written = draft.answer == Answer::Text;
        let prefix = match (written, ascii) {
            (true, false) => "●› ",
            (false, false) => "○› ",
            (true, true) => "*> ",
            (false, true) => " > ",
        };
        let rows = draft
            .editor
            .rows(crate::ui::content_width(width).saturating_sub(3))
            .clamp(1, 3);
        // The written answer is the last choice, right under the others.
        vec![
            Node::row("tabs", tabs).gap(1),
            Node::column(
                "question",
                vec![
                    Node::scroll("choices", Node::column("rows", choices).gap(1))
                        .size(Size::Upto(height.saturating_sub(16).max(4))),
                    Node::row(
                        "answer",
                        vec![
                            Node::text("prefix", vec![(prefix.into(), Tone::Accent)])
                                .size(Size::Fixed(3)),
                            Node::slot("input", rows)
                                .on(On::Activate(action(Command::FreeText)))
                                .enabled(enabled(Command::FreeText))
                                .size(Size::Fill),
                        ],
                    ),
                ],
            ),
        ]
    }

    /// Paints the free-text answer into its row, with a prompt while empty.
    pub(super) fn draw(
        &mut self,
        frame: &mut ratatui::Frame<'_>,
        rect: Option<ratatui::layout::Rect>,
        focused: bool,
        prompt: &str,
        colors: crate::theme::Palette,
    ) {
        let editor = &mut self.drafts[self.current].editor;
        let Some(rect) = rect else {
            editor.invalidate_geometry();
            return;
        };
        editor.draw(frame, rect, focused, colors);
        if editor.text().is_empty() && !focused {
            frame.render_widget(
                ratatui::widgets::Paragraph::new(prompt)
                    .style(ratatui::style::Style::default().fg(colors.subtle)),
                rect,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        State,
        tests::{draw, fixture},
    };
    use super::*;
    use crate::app::Action;
    use crate::{Locale, LocalePreference, app::App};
    use crossterm::event::KeyEvent;
    use maka_client::{ClientError, RequestFailure};
    use maka_protocol::interaction::{self, InteractionAnswer};
    use serde_json::json;

    fn key(
        app: &mut App,
        code: KeyCode,
        modifiers: KeyModifiers,
    ) -> Option<(super::super::Ticket, Option<InteractionAnswer>)> {
        let (_, action) = app.input(Event::Key(KeyEvent::new(code, modifiers)));
        if let Some(Action::Interaction(command)) = action {
            app.interaction_request(command)
        } else {
            None
        }
    }
    fn click(app: &mut App, command: Command) {
        draw(app, 100, 30);
        if let Some(Action::Interaction(command)) = super::super::tests::press(app, command) {
            assert!(app.interaction_request(command).is_none());
        }
    }
    fn questions(app: &App) -> &Questions {
        app.interactions
            .review
            .as_ref()
            .unwrap()
            .questions
            .as_ref()
            .unwrap()
    }
    #[test]
    fn explicit_choices_custom_unicode_and_skips_share_one_guarded_submission_and_survive_later() {
        let mut app = fixture();
        let snapshot = app.chat.snapshot.as_mut().unwrap();
        let mut pending = serde_json::to_value(&snapshot.interactions.pending()[0]).unwrap();
        pending["request"] = json!({"kind":"question","toolUseId":"call","questions":[
            {"question":"Pick a destination","options":[{"label":"Alpha","description":"First choice"},{"label":"Beta"}]},
            {"question":"Explain your choice","options":[{"label":"Fast"},{"label":"Simple"}]},
            {"question":"Optional detail","options":[{"label":"Include"},{"label":"Omit"}]}
        ]});
        snapshot.interactions =
            interaction::decode_session_projection(&json!({"pending":[pending]}), "a").unwrap();
        app.open_interaction();
        let text = draw(&mut app, 100, 30);
        assert!(text.contains("Pick a destination") && text.contains("First choice"));
        let lines: Vec<_> = text.lines().collect();
        let top = lines.iter().position(|line| line.contains('╭')).unwrap();
        let bottom = lines.iter().position(|line| line.contains('╰')).unwrap();
        assert!(bottom - top < 24, "short questions retain natural height");
        assert!(
            top.abs_diff(29 - bottom) <= 1,
            "question review is centered"
        );
        assert!(!app.interaction_enabled(Command::Submit));
        key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert!(
            !app.interactions.visible,
            "default Enter must not choose an answer"
        );
        app.open_interaction();
        click(&mut app, Command::Option(1));
        assert_eq!(questions(&app).answer(0), Some(Some("Beta".into())));
        click(&mut app, Command::Question(1));
        click(&mut app, Command::FreeText);
        app.input(Event::Paste("自己的回答 e\u{301}".into()));
        key(&mut app, KeyCode::Backspace, KeyModifiers::NONE);
        key(&mut app, KeyCode::Char('z'), KeyModifiers::CONTROL);
        assert_eq!(
            questions(&app).answer(1),
            Some(Some("自己的回答 e\u{301}".into()))
        );
        let before = questions(&app).drafts[1].editor.text().to_owned();
        app.input(Event::Paste("中".repeat(683))); // More than 2,048 UTF-8 bytes.
        assert_eq!(questions(&app).drafts[1].editor.text(), before);
        assert_eq!(questions(&app).error(), Some("question-too-large"));
        assert_eq!(
            app.drafts["a"].text(),
            "keep draft",
            "modal editor is not the chat composer"
        );
        key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        let pending_snapshot = app.chat.snapshot.take(); // Releasing the page observation is not discarding a draft.
        app.sync_interaction();
        assert_eq!(
            app.interactions.review.as_ref().unwrap().state,
            State::Stale
        );
        app.chat.snapshot = pending_snapshot; // Same Root/epoch and exact pending request on return.
        app.open_interaction();
        assert_eq!(questions(&app).answer(1), Some(Some(before.clone())));
        click(&mut app, Command::Question(2));
        // Keyboard activation uses the same action as a mouse choice.
        draw(&mut app, 100, 30);
        app.layer
            .focus_path(&super::super::tests::path(&app, Command::Skip));
        if let Some((_, answer)) = key(&mut app, KeyCode::Enter, KeyModifiers::NONE) {
            panic!("choosing is not answering: {answer:?}");
        }
        assert_eq!(
            questions(&app).answers(),
            Some(vec![Some("Beta".into()), Some(before.clone()), None])
        );
        for locale in Locale::ALL {
            app.i18n.preference = LocalePreference::Explicit(locale);
            for size in [(30, 10), (80, 24), (120, 40)] {
                draw(&mut app, size.0, size.1);
            }
            assert!(app.i18n.diagnostics().is_empty());
        }
        let (ticket, answer) = key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL).unwrap();
        assert_eq!(
            answer,
            Some(InteractionAnswer::Question {
                answers: vec![Some("Beta".into()), Some(before), None]
            })
        );
        assert!(app.interaction_request(Command::Submit).is_none());
        app.interaction_completed(
            ticket.clone(),
            Err(RequestFailure::Unknown(ClientError::Timeout)),
        );
        assert!(!app.interaction_enabled(Command::Option(0)));
        let (query, answer) = app.interaction_request(Command::Check).unwrap();
        assert_eq!(query, ticket);
        assert!(answer.is_none());
        app.interaction_completed(query, Ok(ticket.snapshot));
        assert!(app.interaction_enabled(Command::Submit));
        app.chat.snapshot.as_mut().unwrap().interactions = Default::default();
        app.sync_interaction();
        assert_eq!(
            app.interactions.review.as_ref().unwrap().state,
            State::Stale
        );
        assert!(!app.interaction_enabled(Command::Submit));
        assert!(!app.interaction_enabled(Command::FreeText));
    }
}
