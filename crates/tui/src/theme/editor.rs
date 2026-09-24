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

mod view;

use super::{Choice, Palette};
use crate::app::{Action, App};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::style::Color;
pub(crate) use view::{draw_field, sheet};

const SWATCHES: [u32; 18] = [
    0x71a8fd, 0xbe9df7, 0xec939b, 0xe7bd7f, 0x7ecfa4, 0x71ccd1, 0x205fc1, 0x804caf, 0xb33e48,
    0x8c5c13, 0x21714f, 0x147078, 0x131720, 0x202837, 0x647186, 0xa0afc3, 0xe9edf5, 0xf7f8fc,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open,
    Close,
    Save,
    Reload,
    Base(usize),
    Role(usize),
    Swatch(usize),
    /// Applies the #RRGGBB field, or says why it cannot.
    Hex,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Close => "session-cancel",
            Self::Save => "theme-save",
            Self::Reload => "theme-reload",
            _ => "theme-customize",
        }
    }
}

pub struct Editor {
    pub colors: Palette,
    pub chrome: Palette,
    pub name: crate::editor::Editor,
    pub hex: crate::editor::Editor,
    pub role: usize,
    pub base: usize,
    pub visible: bool,
    pub error: Option<&'static str>,
}
impl Editor {
    pub fn new(name: String, colors: Palette) -> Self {
        let mut editor = Self {
            colors,
            chrome: colors,
            name: Default::default(),
            hex: Default::default(),
            role: 3,
            base: 0,
            visible: false,
            error: None,
        };
        editor.name.insert(&name);
        editor.sync_hex();
        editor
    }
    fn sync_hex(&mut self) {
        self.hex = Default::default();
        if let Color::Rgb(r, g, b) = self.colors.entries()[self.role].1 {
            self.hex.insert(&format!("#{r:02X}{g:02X}{b:02X}"));
        }
        self.error = None;
    }
    pub fn valid_hex(&mut self) -> bool {
        let text = self.hex.text();
        if text.len() == 7
            && text.starts_with('#')
            && text[1..].bytes().all(|b| b.is_ascii_hexdigit())
            && let Ok(color) = u32::from_str_radix(&text[1..], 16)
        {
            self.colors.set_role(self.role, super::rgb(color));
            self.error = None;
            return true;
        }
        false
    }
    pub fn invalidate(&mut self) {
        self.visible = false;
        self.hex.invalidate_geometry();
        self.name.invalidate_geometry();
    }
}
impl App {
    pub fn theme_action(&mut self, command: Command) {
        match command {
            Command::Open => {
                self.invalidate_editor_geometry();
                self.theme.open_editor(self.i18n.text("theme-custom-name"));
            }
            Command::Close => {
                self.theme.close_editor();
                self.invalidate_editor_geometry();
            }
            Command::Save => self.theme.save_editor(),
            Command::Reload => self.theme.reload(),
            _ => {
                if self.theme.busy() {
                    return;
                }
                let Some(editor) = &mut self.theme.editor else {
                    return;
                };
                match command {
                    Command::Base(index) if index < 3 => {
                        editor.base = index;
                        editor.colors = [Choice::Maka, Choice::Dusk, Choice::Paper][index].colors();
                        editor.sync_hex();
                    }
                    Command::Role(index) if index < 24 => {
                        editor.role = index;
                        editor.sync_hex();
                    }
                    Command::Hex => {
                        if !editor.valid_hex() {
                            editor.error = Some("theme-hex-invalid");
                        }
                    }
                    Command::Swatch(index) if index < SWATCHES.len() => {
                        editor
                            .colors
                            .set_role(editor.role, super::rgb(SWATCHES[index]));
                        editor.sync_hex();
                    }
                    _ => {}
                }
            }
        }
        self.hover = None;
    }

    /// The two text fields take their keys, pastes and pointer before the
    /// sheet; typing into the hex field applies a valid color at once.
    pub(crate) fn theme_sheet_input(&mut self, event: &Event) -> Option<(bool, Option<Action>)> {
        let busy = self.theme.busy();
        let focused = self.layer.focused_path().map(str::to_owned);
        let hex_focused = focused.as_deref() == Some(&format!("{}/input", view::HEX));
        let name_focused = focused.as_deref() == Some(&format!("{}/input", view::NAME));
        let editor = self.theme.editor.as_mut()?;
        if busy {
            return None;
        }
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if !(name_focused || hex_focused)
                    || matches!(
                        key.code,
                        KeyCode::Esc
                            | KeyCode::Tab
                            | KeyCode::BackTab
                            | KeyCode::Enter
                            | KeyCode::Up
                            | KeyCode::Down
                    )
                    || (key.modifiers.contains(KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('q'))
                    || matches!(key.code, KeyCode::Char(c) if c.is_control())
                {
                    return None;
                }
                let field = if hex_focused {
                    &mut editor.hex
                } else {
                    &mut editor.name
                };
                let changed = field.key(*key);
                if hex_focused {
                    editor.valid_hex();
                }
                Some((changed, None))
            }
            Event::Paste(text) if name_focused || hex_focused => {
                if text.chars().any(char::is_control) {
                    return Some((false, None));
                }
                let field = if hex_focused {
                    &mut editor.hex
                } else {
                    &mut editor.name
                };
                let changed = field.insert(text);
                if hex_focused {
                    editor.valid_hex();
                }
                Some((changed, None))
            }
            Event::Mouse(mouse) => {
                let point = (mouse.column, mouse.row).into();
                let (field, key) = [(&mut editor.name, view::NAME), (&mut editor.hex, view::HEX)]
                    .into_iter()
                    .find(|(field, _)| field.contains(point) || field.dragging())?;
                let changed = field.mouse(*mouse);
                self.layer.focus(key);
                Some((
                    changed || matches!(mouse.kind, crossterm::event::MouseEventKind::Down(_)),
                    None,
                ))
            }
            _ => None,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEvent, MouseButton, MouseEvent, MouseEventKind};
    use ratatui::{Terminal, backend::TestBackend};
    fn key(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(code, modifiers))
    }
    fn draw(app: &mut App, width: u16, height: u16) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, app))
            .unwrap();
        assert!(
            app.i18n.diagnostics().is_empty(),
            "{:?}",
            app.i18n.diagnostics()
        );
    }
    #[tokio::test]
    async fn swatches_hex_preview_cancel_and_save_share_real_modal_geometry() {
        for locale in [crate::Locale::En, crate::Locale::ZhCn, crate::Locale::ZhTw] {
            for (width, height) in [(80, 35), (46, 26)] {
                let dir = tempfile::tempdir().unwrap();
                let path = dir.path().join("theme.json");
                let mut app = App::new(
                    "/unused".into(),
                    crate::i18n::I18n::new(crate::LocalePreference::Explicit(locale), locale),
                );
                app.theme.path = Some(path.clone());
                app.apply(Action::Visit(crate::navigation::Route::Settings));
                let original = app.theme.colors();
                app.apply(Action::Theme(Command::Open));
                draw(&mut app, width, height);
                // The role list opens on the edited role; the selection
                // follows the focus to the last one, scrolled into view.
                app.input(key(KeyCode::End, KeyModifiers::NONE));
                draw(&mut app, width, height);
                assert_eq!(app.theme.editor.as_ref().unwrap().role, 23);
                assert!(
                    app.layer
                        .rect("columns/roles/list/rows/23")
                        .is_some_and(|rect| !rect.is_empty())
                );
                app.apply(Action::Theme(Command::Role(3)));
                draw(&mut app, width, height);
                let click = |app: &mut App, rect: ratatui::layout::Rect| {
                    for kind in [
                        MouseEventKind::Down(MouseButton::Left),
                        MouseEventKind::Up(MouseButton::Left),
                    ] {
                        app.input(Event::Mouse(MouseEvent {
                            kind,
                            column: rect.x,
                            row: rect.y,
                            modifiers: KeyModifiers::NONE,
                        }));
                    }
                };
                let swatch = app.layer.rect("columns/colors/swatches/r0/4").unwrap();
                click(&mut app, swatch);
                assert_eq!(app.theme.colors().accent, super::super::rgb(SWATCHES[4]));
                draw(&mut app, width, height);
                let hex = app.layer.slot(view::HEX).unwrap();
                click(&mut app, hex);
                app.input(key(KeyCode::Char('a'), KeyModifiers::CONTROL));
                app.input(Event::Paste("#AABBCC".into()));
                assert_eq!(app.theme.colors().accent, super::super::rgb(0xaabbcc));
                draw(&mut app, width, height);
                app.input(Event::Mouse(MouseEvent {
                    kind: MouseEventKind::Down(MouseButton::Left),
                    column: 0,
                    row: 0,
                    modifiers: KeyModifiers::NONE,
                }));
                assert!(app.theme.editor.is_none());
                assert_eq!(app.theme.colors(), original);
                assert!(!path.exists());
                assert_eq!(app.navigation.current(), crate::navigation::Route::Settings);
                app.apply(Action::Theme(Command::Open));
                draw(&mut app, 20, 8);
                app.input(key(KeyCode::Enter, KeyModifiers::NONE));
                assert!(!app.theme.busy());
                assert!(!path.exists());
                draw(&mut app, width, height);
                app.apply(Action::Theme(Command::Swatch(5)));
                draw(&mut app, width, height);
                let hex = app.layer.slot(view::HEX).unwrap();
                click(&mut app, hex);
                app.input(key(KeyCode::Char('a'), KeyModifiers::CONTROL));
                app.input(Event::Paste("invalid".into()));
                app.apply(Action::Theme(Command::Save));
                assert!(app.theme.request().is_none());
                assert_eq!(
                    app.theme.editor.as_ref().unwrap().error,
                    Some("theme-hex-invalid")
                );
                app.input(key(KeyCode::Char('a'), KeyModifiers::CONTROL));
                app.input(Event::Paste("#112233".into()));
                app.apply(Action::Theme(Command::Save));
                let request = app.theme.request().unwrap();
                let result = request.execute().await;
                app.theme.complete(request, result);
                assert!(app.theme.editor.is_none());
                assert_eq!(app.theme.choice, Choice::Custom);
                assert_eq!(
                    super::super::custom::read(&path).unwrap().colors.accent,
                    super::super::rgb(0x112233)
                );
                assert_eq!(app.theme.colors().accent, super::super::rgb(0x112233));
            }
        }
    }
}
