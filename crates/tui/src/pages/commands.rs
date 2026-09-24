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
    i18n::I18n,
    ui::{Node, On, Sheet, Size, Tone},
};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{Frame, style::Style, widgets::Paragraph};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const SEARCH: &str = "search";
const ROWS: &str = "list/rows";

/// A command's name: a catalog key, or text a plugin already localized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Label {
    Key(&'static str),
    Text(String),
}
impl Label {
    pub fn text(&self, i18n: &I18n) -> String {
        match self {
            Self::Key(key) => i18n.text(key),
            Self::Text(text) => text.clone(),
        }
    }
}
impl From<&'static str> for Label {
    fn from(key: &'static str) -> Self {
        Self::Key(key)
    }
}

#[derive(Default)]
pub struct State {
    items: Vec<(Action, Label)>,
    query: String,
}

impl State {
    pub fn new(items: Vec<(Action, Label)>) -> Self {
        Self {
            items,
            ..Self::default()
        }
    }
    pub fn filtered(&self, i18n: &I18n) -> Vec<(Action, Label)> {
        let query = self.query.to_lowercase();
        self.items
            .iter()
            .filter(|(_, label)| {
                let text = label.text(i18n).to_lowercase();
                query.split_whitespace().all(|word| text.contains(word))
            })
            .cloned()
            .collect()
    }
    fn insert(&mut self, text: &str) {
        for ch in text.chars().filter(|ch| !ch.is_control()) {
            if self.query.len() + ch.len_utf8() > 512 {
                break;
            }
            self.query.push(ch);
        }
    }
}

/// The command palette: typing always filters, the arrows move the
/// highlight while the typing stays in the field, and Enter or a click
/// runs a command. The commands were captured when it opened, so nothing
/// moves under the pointer.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let selected = app.palette?;
    let items = app.commands();
    let height = app.frame_size.map_or(24, |(_, height)| height);
    let sheet = Sheet::new("palette", app.i18n.text("palette-title")).body(Node::row(
        SEARCH,
        vec![
            Node::text(
                "icon",
                vec![(format!("{} ", app.chrome.symbol("⌕", "/")), Tone::Muted)],
            )
            .size(Size::Fixed(2)),
            Node::slot("input", 1)
                .on(On::Activate(Action::ClosePalette))
                .size(Size::Fill),
        ],
    ));
    let sheet = if items.is_empty() {
        sheet.text("empty", &app.i18n.text("palette-empty"), Tone::Subtle)
    } else {
        let rows = items
            .iter()
            .enumerate()
            .map(|(index, (action, label))| {
                Node::text(
                    index.to_string(),
                    vec![(label.text(&app.i18n), Tone::Normal)],
                )
                .clip()
                .on(On::Activate(action.clone()))
                .enabled(app.enabled(action))
                .current(index == selected)
            })
            .collect();
        sheet.body(
            Node::scroll("list", Node::column("rows", rows))
                .size(Size::Upto(height.saturating_sub(10).clamp(3, 20))),
        )
    };
    Some(sheet.focus_node(format!("{SEARCH}/input")))
}

/// Paints the query, or its prompt, and the cursor while typing there.
pub(crate) fn draw_field(frame: &mut Frame<'_>, app: &mut App) {
    let Some(rect) = app.layer.slot(SEARCH).filter(|rect| !rect.is_empty()) else {
        return;
    };
    let colors = app.theme.colors();
    let query = &app.command_palette.query;
    let (label, color) = if query.is_empty() {
        (app.i18n.text("palette-filter"), colors.subtle)
    } else {
        (query.clone(), colors.foreground)
    };
    let offset = query
        .width()
        .saturating_sub(usize::from(rect.width.saturating_sub(1)));
    frame.render_widget(
        Paragraph::new(label)
            .style(Style::default().fg(color))
            .scroll((0, offset as u16)),
        rect,
    );
    if app.layer.focused(SEARCH) {
        frame.set_cursor_position((rect.x + query.width().saturating_sub(offset) as u16, rect.y));
    }
}

impl App {
    /// Typing, the highlight and Enter, taken before the sheet: the list
    /// keeps its pointer and wheel, and a click there runs its command.
    pub(crate) fn palette_sheet_input(&mut self, event: &Event) -> Option<(bool, Option<Action>)> {
        let selected = self.palette?;
        let items = self.commands();
        let last = items.len().saturating_sub(1);
        let page = usize::from(
            self.frame_size
                .map_or(24, |(_, height)| height)
                .saturating_sub(10)
                .clamp(3, 20),
        );
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                let control = key.modifiers.contains(KeyModifiers::CONTROL);
                let highlight = match key.code {
                    KeyCode::Up => Some(selected.saturating_sub(1)),
                    KeyCode::Down => Some((selected + 1).min(last)),
                    KeyCode::Home => Some(0),
                    KeyCode::End => Some(last),
                    KeyCode::PageUp => Some(selected.saturating_sub(page)),
                    KeyCode::PageDown => Some((selected + page).min(last)),
                    _ => None,
                };
                if let Some(index) = highlight {
                    self.palette = Some(index);
                    self.layer.reveal(&format!("{ROWS}/{index}"));
                    self.layer.focus(SEARCH);
                    return Some((true, None));
                }
                match key.code {
                    KeyCode::Enter => {
                        // With nothing to run, Enter does nothing at all.
                        let Some((action, _)) = items.get(selected).cloned() else {
                            return Some((false, None));
                        };
                        if !self.enabled(&action) {
                            return Some((false, None));
                        }
                        self.palette = None;
                        return Some((true, self.apply(action)));
                    }
                    KeyCode::Backspace => {
                        let query = &mut self.command_palette.query;
                        let (index, _) = query.grapheme_indices(true).next_back()?;
                        query.truncate(index);
                    }
                    KeyCode::Char('u') if control => self.command_palette.query.clear(),
                    KeyCode::Char(ch)
                        if !key
                            .modifiers
                            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                    {
                        self.command_palette.insert(&ch.to_string());
                    }
                    _ => return None,
                }
            }
            Event::Paste(text) => self.command_palette.insert(text),
            _ => return None,
        }
        // A new query lists from its first match, typed into the field; the
        // old rows retire before another click can reach them.
        self.palette = Some(0);
        self.layer.reveal(&format!("{ROWS}/0"));
        self.layer.focus(SEARCH);
        self.layer.retire();
        Some((true, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        i18n::{Locale, LocalePreference},
        navigation::Route,
    };
    use crossterm::event::{KeyEvent, MouseButton, MouseEvent, MouseEventKind};
    use ratatui::{Terminal, backend::TestBackend};
    fn frame(app: &mut App, width: u16, height: u16) {
        Terminal::new(TestBackend::new(width, height))
            .unwrap()
            .draw(|f| crate::view::draw(f, app))
            .unwrap();
    }
    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }
    fn mouse(kind: MouseEventKind, x: u16, y: u16) -> Event {
        Event::Mouse(MouseEvent {
            kind,
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        })
    }
    #[test]
    fn search_and_drag_preserve_captured_commands_drafts_and_published_geometry() {
        for locale in [Locale::En, Locale::ZhCn, Locale::ZhTw] {
            let mut app = App::new(
                "/unused".into(),
                I18n::new(LocalePreference::Explicit(locale), locale),
            );
            app.apply(Action::Visit(Route::Session("draft".into())));
            app.drafts
                .get_mut("draft")
                .unwrap()
                .insert("preserved draft");
            app.apply(Action::Palette);
            frame(&mut app, 52, 18);
            let row = |app: &App, index: usize| app.layer.rect(&format!("{ROWS}/{index}"));
            let shown =
                |app: &App, index: usize| row(app, index).is_some_and(|rect| !rect.is_empty());
            let first = row(&app, 0).unwrap();
            let selected = app.palette;
            app.input(mouse(MouseEventKind::Moved, first.x, first.y));
            assert_eq!(
                app.palette, selected,
                "hover highlights without changing the keyboard choice"
            );
            let count = app.commands().len();
            assert!(!shown(&app, count - 1), "the list scrolls");
            app.input(mouse(MouseEventKind::ScrollDown, first.x, first.y));
            frame(&mut app, 52, 18);
            assert!(
                !shown(&app, 0),
                "wheel scrolls immediately, not after selection reaches the bottom"
            );
            let quit = app
                .commands()
                .iter()
                .position(|(action, _)| *action == Action::Quit)
                .unwrap();
            for _ in 0..count {
                if shown(&app, quit) {
                    break;
                }
                app.input(mouse(MouseEventKind::ScrollDown, first.x, first.y));
                frame(&mut app, 52, 18);
            }
            let target = row(&app, quit).expect("quit is reachable by scrolling");
            assert_eq!(
                app.input(mouse(
                    MouseEventKind::Down(MouseButton::Left),
                    target.x,
                    target.y
                ))
                .1,
                Some(Action::Quit)
            );
            assert!(app.palette.is_none(), "a launcher closes as it launches");
            assert_eq!(app.drafts["draft"].text(), "preserved draft");
            app.apply(Action::Palette);
            frame(&mut app, 52, 18);
            // The scrollbar, just right of the rows, dragged to the end.
            let first = row(&app, 0).unwrap();
            for (kind, y) in [
                (MouseEventKind::Down(MouseButton::Left), first.y),
                (MouseEventKind::Drag(MouseButton::Left), first.y + 30),
                (MouseEventKind::Up(MouseButton::Left), first.y + 30),
            ] {
                app.input(mouse(kind, first.right(), y));
            }
            frame(&mut app, 52, 18);
            assert!(shown(&app, count - 1));
            app.input(Event::Resize(80, 28));
            frame(&mut app, 80, 28);
            let search = app.layer.slot(SEARCH).unwrap();
            app.input(key(KeyCode::Home));
            assert_eq!(app.palette, Some(0));
            app.input(key(KeyCode::End));
            assert_eq!(app.palette, Some(count - 1));
            let stale = (0..count)
                .filter_map(|index| row(&app, index))
                .find(|rect| !rect.is_empty())
                .unwrap();
            app.input(Event::Paste("not-a-command 👨‍👩‍👧‍👦".into()));
            app.input(key(KeyCode::Backspace));
            assert_eq!(app.command_palette.query, "not-a-command ");
            frame(&mut app, 80, 28);
            assert!(app.commands().is_empty());
            assert!(app.input(key(KeyCode::Enter)).1.is_none());
            assert!(app.palette.is_some());
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Char('u'),
                KeyModifiers::CONTROL,
            )));
            let query = app.i18n.text("command-settings").to_lowercase();
            app.input(Event::Paste(query));
            assert_eq!(
                app.commands(),
                vec![(Action::Visit(Route::Settings), "command-settings".into())]
            );
            // Old geometry cannot activate a different row after filtering.
            app.input(mouse(
                MouseEventKind::Down(MouseButton::Left),
                stale.x,
                stale.y,
            ));
            assert_eq!(app.navigation.current(), Route::Session("draft".into()));
            frame(&mut app, 80, 28);
            assert_eq!(
                app.layer.slot(SEARCH).unwrap().y,
                search.y,
                "the field stays put as the results shrink"
            );
            let stable = app.commands();
            app.connection = crate::app::ConnectionState::Failed("offline".into());
            assert_eq!(app.commands(), stable);
            let settings = row(&app, 0).unwrap();
            app.input(mouse(
                MouseEventKind::Down(MouseButton::Left),
                settings.x + 2,
                settings.y,
            ));
            assert!(app.palette.is_none());
            assert_eq!(app.navigation.current(), Route::Settings);
            assert_eq!(app.drafts["draft"].text(), "preserved draft");
            app.apply(Action::Palette);
            assert!(app.command_palette.query.is_empty());
            frame(&mut app, 52, 18);
            app.input(Event::Paste(app.i18n.text("command-quit")));
            frame(&mut app, 52, 18);
            assert_eq!(app.commands(), vec![(Action::Quit, "command-quit".into())]);
            assert_eq!(app.input(key(KeyCode::Enter)).1, Some(Action::Quit));
            app.apply(Action::Palette);
            frame(&mut app, 52, 18);
            app.input(Event::Paste("🦀".repeat(200)));
            assert!(app.command_palette.query.len() <= 512);
            frame(&mut app, 20, 6);
            assert!(app.input(key(KeyCode::Enter)).1.is_none());
            app.input(key(KeyCode::Esc));
            assert!(app.palette.is_none());
        }
    }
}
