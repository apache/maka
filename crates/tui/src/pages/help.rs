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
    app::{Action, App},
    ui::{self, Node, On, Role, Sheet, Size, Tone},
};

/// Help is a temporary sheet over the current place, never a navigation entry.
pub fn sheet(app: &App) -> Sheet<Action> {
    let narrow = ui::content_width(app.frame_size.map_or(80, |size| size.0)) < 44;
    let rows = app
        .i18n
        .text("help")
        .lines()
        .enumerate()
        .map(|(index, line)| match line.split_once("  ") {
            Some((keys, description)) => {
                let keys = Node::text("keys", vec![(keys.to_owned(), Tone::Muted)]);
                let description = Node::text(
                    "description",
                    vec![(description.trim_start().to_owned(), Tone::Normal)],
                );
                if narrow {
                    Node::column(index.to_string(), vec![keys, description])
                } else {
                    Node::row(
                        index.to_string(),
                        vec![keys.size(Size::Fixed(18)), description.size(Size::Fill)],
                    )
                    .gap(2)
                }
            }
            None => Node::text(index.to_string(), vec![(line.to_owned(), Tone::Subtle)]),
        })
        .collect();
    Sheet::new("help", app.i18n.text("route-help"))
        .body(
            Node::scroll("shortcuts", Node::column("rows", rows))
                .size(Size::Upto(18))
                .on(On::Scroll),
        )
        .button(
            "close",
            app.i18n.text("help-close"),
            Role::Primary,
            Action::CloseHelp,
            true,
        )
        .focus_node("shortcuts")
        .back(Action::CloseHelp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Locale, LocalePreference, app::Focus, navigation::Route};
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn help_preserves_the_conversation_and_question_marks_remain_text_in_the_composer() {
        for locale in [Locale::En, Locale::ZhCn, Locale::ZhTw] {
            let mut app = App::new(
                "/unconfigured".into(),
                crate::i18n::I18n::new(LocalePreference::Explicit(locale), Locale::En),
            );
            app.apply(Action::Visit(Route::Session("draft".into())));
            app.focus = Focus::Composer;
            app.drafts.get_mut("draft").unwrap().insert("Keep this");
            let key = |code| Event::Key(KeyEvent::new(code, KeyModifiers::NONE));
            app.input(key(KeyCode::Char('?')));
            assert!(!app.help);
            assert_eq!(app.drafts["draft"].text(), "Keep this?");
            app.input(key(KeyCode::F(1)));
            assert!(app.help);
            assert_eq!(app.navigation.current(), Route::Session("draft".into()));
            for (width, height) in [(40, 16), (100, 32)] {
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal
                    .draw(|frame| crate::view::draw(frame, &mut app))
                    .unwrap();
                assert!(app.layer.rect("footer/close").is_some());
                assert!(app.i18n.diagnostics().is_empty());
            }
            app.input(key(KeyCode::Esc));
            assert!(!app.help);
            assert_eq!(app.focus, Focus::Composer);
            assert_eq!(app.drafts["draft"].text(), "Keep this?");
        }
    }
}
