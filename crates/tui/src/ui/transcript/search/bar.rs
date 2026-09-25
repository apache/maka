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

use super::{Command, Search};
use crate::ui::{Align, Context, Node, On, Size, Tone};
use ratatui::{Frame, layout::Rect};
use unicode_width::UnicodeWidthStr;

impl Search {
    /// The reader owns its query; callers can add a scope control and supply
    /// their own count without copying that query or its editor state.
    pub fn draw_bar(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        context: Context,
        count: &str,
        scope: Option<(&str, &str)>,
        hints: [&str; 3],
    ) {
        if area.is_empty() {
            self.invalidate_geometry();
            return;
        }
        let symbol = match (scope.is_some() && self.history, context.ascii) {
            (true, false) => "∞",
            (true, true) => "*",
            (false, false) => "⌕",
            (false, true) => "/",
        };
        let label = scope.map_or("", |(label, _)| label);
        let label = if area.width >= 60 { label } else { "" };
        let prefix = if label.is_empty() {
            format!("{symbol} ")
        } else {
            format!("{symbol} {label} ")
        };
        let prefix_width = (prefix.width() as u16).min(area.width / 2);
        let mut prefix = Node::text("scope", vec![(prefix, Tone::Subtle)])
            .clip()
            .size(Size::Fixed(prefix_width));
        if let Some((_, hint)) = scope {
            prefix = prefix.on(On::Activate(Command::Scope)).hint(hint);
        }
        let mut children = vec![
            prefix,
            Node::slot("input", 1)
                .size(Size::Fill)
                .on(On::Activate(Command::Next)),
            Node::text("gap", vec![]).size(Size::Fixed(1)),
            Node::text("count", vec![(count.into(), Tone::Subtle)])
                .clip()
                .size(Size::Fixed((count.width() as u16).min(area.width / 3))),
        ];
        for ((key, unicode, ascii, command), hint) in [
            ("previous", "↑", "^", Command::Previous),
            ("next", "↓", "v", Command::Next),
            ("close", "×", "x", Command::Close),
        ]
        .into_iter()
        .zip(hints)
        {
            let mut button = Node::text(
                key,
                vec![(
                    if context.ascii { ascii } else { unicode }.into(),
                    Tone::Muted,
                )],
            )
            .clip()
            .align(Align::Center)
            .size(Size::Fixed(3))
            .on(On::Activate(command));
            if !hint.is_empty() {
                button = button.hint(hint);
            }
            children.push(button);
        }
        // Find keeps keyboard entry in its editor. Pointer controls use this
        // same tree, while Enter/F3/Tab/Esc remain the reader's local policy.
        self.bar.render(
            frame,
            Rect::new(area.x, area.y, area.width, 1),
            Node::row("find", children),
            Context {
                focused: false,
                ..context
            },
        );
        if let Some(input) = self.bar.rect("find/input") {
            self.editor
                .draw(frame, input, context.focused, context.colors);
        } else {
            self.editor.invalidate_geometry();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::transcript::{Transcript, tests::locale};
    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn find_buttons_use_committed_geometry_and_history_is_opt_in() {
        let mut reader = Transcript::default();
        reader.sync(
            &BTreeMap::from([(
                1,
                json!({"type":"assistant","id":"m","turnId":"t","text":"中文 first 中文 second"}),
            )]),
            &[],
            0,
            &locale(),
            false,
        );
        reader.search_command(Command::Open);
        reader.search_input(&Event::Paste("中文".into()));
        let click = |area: Rect| {
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: area.x,
                row: area.y,
                modifiers: KeyModifiers::NONE,
            })
        };
        for (width, ascii) in [(30, false), (80, true)] {
            let mut terminal = Terminal::new(TestBackend::new(width, 4)).unwrap();
            terminal
                .draw(|frame| {
                    let search = reader.search.as_mut().unwrap();
                    let count = search.count();
                    search.draw_bar(
                        frame,
                        Rect::new(0, 0, width, 1),
                        Context {
                            colors: Default::default(),
                            ascii,
                            focused: true,
                        },
                        &count,
                        None,
                        [""; 3],
                    );
                })
                .unwrap();
            let search = reader.search.as_ref().unwrap();
            assert!(search.bar.rect("find/scope").is_none());
            let next = search.bar.rect("find/next").unwrap();
            let before = search.count();
            assert_eq!(reader.search_input(&click(next)), Some(true));
            assert_ne!(reader.search.as_ref().unwrap().count(), before);
            let before = reader.search.as_ref().unwrap().count();
            reader.search.as_mut().unwrap().bar.occlude(next);
            reader.search_input(&click(next));
            assert_eq!(reader.search.as_ref().unwrap().count(), before);
            assert_eq!(reader.search.as_ref().unwrap().editor.text(), "中文");
        }
        reader.search_input(&Event::Key(KeyEvent::new(
            KeyCode::Char('f'),
            KeyModifiers::ALT,
        )));
        assert!(
            !reader.search.as_ref().unwrap().history,
            "a local reader cannot start Host history search"
        );
        assert_eq!(
            reader.search_input(&Event::Key(KeyEvent::new(
                KeyCode::Char('q'),
                KeyModifiers::CONTROL
            ))),
            None
        );
        let close = reader
            .search
            .as_ref()
            .unwrap()
            .bar
            .rect("find/close")
            .unwrap();
        reader.search.as_mut().unwrap().invalidate_geometry();
        reader.search_input(&click(close));
        assert!(
            reader.search.is_some(),
            "retired controls cannot close a replacement reader"
        );
    }
}
