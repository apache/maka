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

//! What the person does, as the Host's terminal input actions
//! (`maka.workspace.Terminal` `control`, `plugins/agent/facts/src/terminal/input`):
//! text, a paste, a named key with modifiers, or a mouse report. The Host
//! encodes them for the PTY itself, with the program's modes (application
//! cursor keys, bracketed paste, its mouse encoding), so nothing here
//! depends on the emulator's modes except whether to report the mouse at
//! all.
//!
//! The Host refuses what it has no portable encoding for: Shift with a
//! character (the shifted character is sent instead), Control with
//! anything but `@`–`_`, letters, space and `?`, and any modifier on Enter,
//! Escape, Tab and Backspace but Shift-Tab. So Option-Backspace and
//! Option-Enter go as Escape and the key, which is what Meta sends, and
//! Control-Backspace as Control-H. The macOS conveniences are kept: ⌘← and
//! ⌘→ go to the start and end of the line (Control-A, Control-E), ⌘⌫
//! deletes to its start (Control-U), ⌥← and ⌥→ move by word (Meta-B,
//! Meta-F). Plain characters, Option's composed ones included, are not
//! keys: they arrive as text through the window's text input (the IME).

use gpui_shell::ComponentDataValue;
use gpui_shell::gpui::{Keystroke, Modifiers};

/// The most text one text or paste action carries. Long text is split, so
/// each action stays well under the controller's 32 KiB a control.
const CHUNK_BYTES: usize = 8 * 1024;

/// A mouse button, as the Host names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MouseButton {
    Left,
    Middle,
    Right,
}

impl MouseButton {
    fn name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Middle => "middle",
            Self::Right => "right",
        }
    }
}

/// What the mouse did at a cell, for a program that asked for mouse reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MouseEvent {
    Press(MouseButton),
    Release(MouseButton),
    /// Moved, with a button held (a drag) or none.
    Move(Option<MouseButton>),
    /// One notch of the wheel, up when `true`.
    Scroll(bool),
}

/// One input action, in the Host's wire shape (tagged by `type`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InputAction {
    /// Typed text: never empty, never a control character.
    Text(String),
    /// Pasted text: controls other than `\n`, `\r` and `\t` removed.
    Paste(String),
    /// A named key (`enter`, `arrow_up`, `f5`, …) or one printable ASCII
    /// character, with `ctrl`, `alt` and `shift`.
    Key {
        key: String,
        modifiers: Vec<&'static str>,
    },
    /// A mouse report at the cell `x`, `y` of the screen (from 0).
    Mouse {
        event: MouseEvent,
        x: usize,
        y: usize,
        modifiers: Vec<&'static str>,
    },
}

impl InputAction {
    fn key(key: &str, modifiers: &[&'static str]) -> Self {
        Self::Key {
            key: key.to_owned(),
            modifiers: modifiers.to_vec(),
        }
    }

    /// The action as the script hands it to `control`.
    pub(crate) fn to_data(&self) -> ComponentDataValue {
        let string = |value: &str| ComponentDataValue::String(value.to_owned());
        let modifiers = |modifiers: &[&'static str]| {
            ComponentDataValue::Array(modifiers.iter().map(|name| string(name)).collect())
        };
        let fields = match self {
            Self::Text(text) => vec![("type", string("text")), ("text", string(text))],
            Self::Paste(text) => vec![("type", string("paste")), ("text", string(text))],
            Self::Key {
                key,
                modifiers: held,
            } => vec![
                ("type", string("key")),
                ("key", string(key)),
                ("modifiers", modifiers(held)),
            ],
            Self::Mouse {
                event,
                x,
                y,
                modifiers: held,
            } => {
                let mut fields = vec![
                    ("type", string("mouse")),
                    ("x", ComponentDataValue::Number(*x as f64)),
                    ("y", ComponentDataValue::Number(*y as f64)),
                    ("modifiers", modifiers(held)),
                ];
                let (name, button, direction) = match event {
                    MouseEvent::Press(button) => ("press", Some(*button), None),
                    MouseEvent::Release(button) => ("release", Some(*button), None),
                    MouseEvent::Move(button) => ("move", *button, None),
                    MouseEvent::Scroll(up) => {
                        ("scroll", None, Some(if *up { "up" } else { "down" }))
                    }
                };
                fields.push(("event", string(name)));
                if let Some(button) = button {
                    fields.push(("button", string(button.name())));
                }
                if let Some(direction) = direction {
                    fields.push(("direction", string(direction)));
                }
                fields
            }
        };
        ComponentDataValue::Object(
            fields
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value))
                .collect(),
        )
    }
}

/// The Host's modifier names for what is held, in its canonical order.
fn modifier_names(control: bool, alt: bool, shift: bool) -> Vec<&'static str> {
    [(control, "ctrl"), (alt, "alt"), (shift, "shift")]
        .into_iter()
        .filter_map(|(held, name)| held.then_some(name))
        .collect()
}

/// The modifiers of a mouse report.
pub(crate) fn mouse_modifiers(modifiers: &Modifiers) -> Vec<&'static str> {
    modifier_names(modifiers.control, modifiers.alt, modifiers.shift)
}

/// The character Control and `c` type as the Host names it: letters and
/// `@`–`_` as they are, `?` for DEL, with the digit row's traditional
/// aliases (2 → `@` … 8 → `?`) and `-` and `/` as `_`.
fn control_character(c: char) -> Option<char> {
    Some(match c.to_ascii_lowercase() {
        c @ 'a'..='z' => c,
        '@' | '2' => '@',
        '[' | '3' => '[',
        '\\' | '4' => '\\',
        ']' | '5' => ']',
        '^' | '6' => '^',
        '_' | '-' | '/' | '7' => '_',
        '?' | '8' => '?',
        _ => return None,
    })
}

/// The actions `keystroke` sends, or `None` when it sends none of its own:
/// plain text (the text input sends what was typed, IME composition
/// included), or a ⌘ shortcut that belongs to the app.
pub(crate) fn key_actions(keystroke: &Keystroke) -> Option<Vec<InputAction>> {
    let modifiers = &keystroke.modifiers;
    let key = keystroke.key.as_str();
    let (control, alt, shift) = (modifiers.control, modifiers.alt, modifiers.shift);
    let one = |key: &str, held: &[&'static str]| Some(vec![InputAction::key(key, held)]);
    // Meta: Escape, then the key on its own.
    let meta = |key: &str| {
        Some(vec![
            InputAction::key("escape", &[]),
            InputAction::key(key, &[]),
        ])
    };
    if modifiers.platform {
        if control || alt || shift {
            return None;
        }
        return match key {
            "left" => one("a", &["ctrl"]),
            "right" => one("e", &["ctrl"]),
            "backspace" => one("u", &["ctrl"]),
            _ => None,
        };
    }
    if alt && !control && !shift {
        match key {
            "left" => return one("b", &["alt"]),
            "right" => return one("f", &["alt"]),
            _ => {}
        }
    }
    let held = modifier_names(control, alt, shift);
    let named = match key {
        "up" => Some("arrow_up"),
        "down" => Some("arrow_down"),
        "left" => Some("arrow_left"),
        "right" => Some("arrow_right"),
        "home" => Some("home"),
        "end" => Some("end"),
        "insert" => Some("insert"),
        "delete" => Some("delete"),
        "pageup" => Some("page_up"),
        "pagedown" => Some("page_down"),
        "f1" => Some("f1"),
        "f2" => Some("f2"),
        "f3" => Some("f3"),
        "f4" => Some("f4"),
        "f5" => Some("f5"),
        "f6" => Some("f6"),
        "f7" => Some("f7"),
        "f8" => Some("f8"),
        "f9" => Some("f9"),
        "f10" => Some("f10"),
        "f11" => Some("f11"),
        "f12" => Some("f12"),
        _ => None,
    };
    if let Some(named) = named {
        return one(named, &held);
    }
    match key {
        // Enter, Escape and Backspace take no modifier at the Host: Option
        // sends Meta (Escape first), Shift and Control send the bare key,
        // as most terminals do, except Control-Backspace, which is ^H.
        "enter" | "escape" if alt => meta(key),
        "enter" | "escape" => one(key, &[]),
        "backspace" if alt => meta("backspace"),
        "backspace" if control => one("h", &["ctrl"]),
        "backspace" => one("backspace", &[]),
        "tab" if control || alt => None,
        "tab" if shift => one("tab", &["shift"]),
        "tab" => one("tab", &[]),
        "space" if control => one(" ", &modifier_names(true, alt, false)),
        _ => {
            let mut chars = key.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else {
                return None;
            };
            if !control {
                return None;
            }
            let c = control_character(c)?;
            one(&c.to_string(), &modifier_names(true, alt, false))
        }
    }
}

/// What typed (or IME-committed) `text` sends: its printable runs as text,
/// in pieces of at most [`CHUNK_BYTES`], line breaks as Enter, tabs as Tab,
/// Escape and Backspace as themselves, and any other control character
/// dropped.
pub(crate) fn text_actions(text: &str) -> Vec<InputAction> {
    let mut actions = Vec::new();
    let mut run = String::new();
    let flush = |run: &mut String, actions: &mut Vec<InputAction>| {
        if !run.is_empty() {
            actions.push(InputAction::Text(std::mem::take(run)));
        }
    };
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let key = match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                Some("enter")
            }
            '\n' => Some("enter"),
            '\t' => Some("tab"),
            '\u{1b}' => Some("escape"),
            '\u{7f}' | '\u{8}' => Some("backspace"),
            c if c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c) => {
                flush(&mut run, &mut actions);
                continue;
            }
            c => {
                if run.len() + c.len_utf8() > CHUNK_BYTES {
                    flush(&mut run, &mut actions);
                }
                run.push(c);
                None
            }
        };
        if let Some(key) = key {
            flush(&mut run, &mut actions);
            actions.push(InputAction::key(key, &[]));
        }
    }
    flush(&mut run, &mut actions);
    actions
}

/// What pasting `text` sends: the text without control characters other
/// than line breaks and tabs, in pieces of at most [`CHUNK_BYTES`].
pub(crate) fn paste_actions(text: &str) -> Vec<InputAction> {
    let clean: String = text
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
        .collect();
    let mut actions = Vec::new();
    let mut rest = clean.as_str();
    while !rest.is_empty() {
        let mut end = rest.len().min(CHUNK_BYTES);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        // Keep a CRLF together, so a piece never ends between the two.
        if end < rest.len() && rest.as_bytes()[end - 1] == b'\r' && rest.as_bytes()[end] == b'\n' {
            end += 1;
        }
        actions.push(InputAction::Paste(rest[..end].to_owned()));
        rest = &rest[end..];
    }
    actions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(keystroke: &str) -> Option<Vec<(String, Vec<&'static str>)>> {
        key_actions(&Keystroke::parse(keystroke).unwrap()).map(|actions| {
            actions
                .into_iter()
                .map(|action| match action {
                    InputAction::Key { key, modifiers } => (key, modifiers),
                    other => panic!("not a key: {other:?}"),
                })
                .collect()
        })
    }

    fn key(name: &str, modifiers: &[&'static str]) -> Option<Vec<(String, Vec<&'static str>)>> {
        Some(vec![(name.to_owned(), modifiers.to_vec())])
    }

    #[test]
    fn plain_characters_are_left_to_the_text_input() {
        assert_eq!(keys("a"), None);
        assert_eq!(keys("shift-a"), None);
        assert_eq!(keys("alt-a"), None, "Option composes text on macOS");
        assert_eq!(keys("space"), None);
        assert_eq!(keys("cmd-c"), None, "⌘ shortcuts are the app's");
        assert_eq!(keys("cmd-shift-left"), None);
    }

    #[test]
    fn control_sends_the_hosts_portable_control_keys() {
        assert_eq!(keys("ctrl-c"), key("c", &["ctrl"]));
        assert_eq!(
            keys("ctrl-shift-c"),
            key("c", &["ctrl"]),
            "Shift is dropped, as the code is the same"
        );
        assert_eq!(keys("ctrl-["), key("[", &["ctrl"]));
        assert_eq!(keys("ctrl-2"), key("@", &["ctrl"]));
        assert_eq!(keys("ctrl-6"), key("^", &["ctrl"]));
        assert_eq!(keys("ctrl--"), key("_", &["ctrl"]));
        assert_eq!(keys("ctrl-/"), key("_", &["ctrl"]));
        assert_eq!(keys("ctrl-8"), key("?", &["ctrl"]));
        assert_eq!(keys("ctrl-space"), key(" ", &["ctrl"]));
        assert_eq!(keys("ctrl-alt-x"), key("x", &["ctrl", "alt"]));
        assert_eq!(keys("ctrl-1"), None, "no portable code");
        assert_eq!(keys("ctrl-;"), None);
    }

    #[test]
    fn named_keys_carry_their_modifiers() {
        assert_eq!(keys("up"), key("arrow_up", &[]));
        assert_eq!(keys("shift-up"), key("arrow_up", &["shift"]));
        assert_eq!(keys("ctrl-alt-right"), key("arrow_right", &["ctrl", "alt"]));
        assert_eq!(keys("pageup"), key("page_up", &[]));
        assert_eq!(keys("shift-pagedown"), key("page_down", &["shift"]));
        assert_eq!(keys("home"), key("home", &[]));
        assert_eq!(keys("delete"), key("delete", &[]));
        assert_eq!(keys("f1"), key("f1", &[]));
        assert_eq!(keys("ctrl-f12"), key("f12", &["ctrl"]));
    }

    #[test]
    fn byte_keys_send_meta_or_the_bare_key() {
        assert_eq!(keys("enter"), key("enter", &[]));
        assert_eq!(keys("shift-enter"), key("enter", &[]));
        assert_eq!(keys("ctrl-enter"), key("enter", &[]));
        assert_eq!(
            keys("alt-enter"),
            Some(vec![("escape".into(), vec![]), ("enter".into(), vec![])])
        );
        assert_eq!(keys("escape"), key("escape", &[]));
        assert_eq!(keys("tab"), key("tab", &[]));
        assert_eq!(keys("shift-tab"), key("tab", &["shift"]));
        assert_eq!(keys("ctrl-tab"), None);
        assert_eq!(keys("backspace"), key("backspace", &[]));
        assert_eq!(keys("ctrl-backspace"), key("h", &["ctrl"]));
        assert_eq!(
            keys("alt-backspace"),
            Some(vec![
                ("escape".into(), vec![]),
                ("backspace".into(), vec![])
            ])
        );
    }

    #[test]
    fn the_macos_conveniences_move_by_line_and_word() {
        assert_eq!(keys("cmd-left"), key("a", &["ctrl"]));
        assert_eq!(keys("cmd-right"), key("e", &["ctrl"]));
        assert_eq!(keys("cmd-backspace"), key("u", &["ctrl"]));
        assert_eq!(keys("alt-left"), key("b", &["alt"]));
        assert_eq!(keys("alt-right"), key("f", &["alt"]));
        assert_eq!(keys("alt-shift-left"), key("arrow_left", &["alt", "shift"]));
    }

    #[test]
    fn typed_text_splits_into_text_and_keys() {
        assert_eq!(
            text_actions("echo hi\n"),
            vec![
                InputAction::Text("echo hi".into()),
                InputAction::key("enter", &[])
            ]
        );
        assert_eq!(
            text_actions("a\r\nb\tc\u{7}d\u{1b}"),
            vec![
                InputAction::Text("a".into()),
                InputAction::key("enter", &[]),
                InputAction::Text("b".into()),
                InputAction::key("tab", &[]),
                InputAction::Text("c".into()),
                InputAction::Text("d".into()),
                InputAction::key("escape", &[]),
            ]
        );
        assert_eq!(text_actions("中文"), vec![InputAction::Text("中文".into())]);
        assert!(text_actions("").is_empty());
        // A long commit goes in pieces the controller takes, on character
        // boundaries, with nothing lost.
        let long = "中".repeat(6000);
        let pieces: Vec<String> = text_actions(&long)
            .into_iter()
            .map(|action| match action {
                InputAction::Text(text) => text,
                other => panic!("not text: {other:?}"),
            })
            .collect();
        assert_eq!(pieces.len(), 3);
        assert!(pieces.iter().all(|piece| piece.len() <= CHUNK_BYTES));
        assert_eq!(pieces.concat(), long);
    }

    #[test]
    fn a_paste_loses_its_controls_and_long_ones_split_on_character_boundaries() {
        assert_eq!(
            paste_actions("a\u{1b}[31mb\r\nc\td"),
            vec![InputAction::Paste("a[31mb\r\nc\td".into())]
        );
        assert!(paste_actions("\u{1b}").is_empty());
        let long = "中".repeat(CHUNK_BYTES);
        let pieces = paste_actions(&long);
        assert!(pieces.len() > 1);
        let mut joined = String::new();
        for piece in pieces {
            let InputAction::Paste(text) = piece else {
                panic!()
            };
            assert!(text.len() <= CHUNK_BYTES);
            joined.push_str(&text);
        }
        assert_eq!(joined, long);
    }

    #[test]
    fn a_paste_never_splits_a_crlf() {
        // The piece would end between the CR and the LF: it takes the LF.
        let text = format!("{}\r\nb", "a".repeat(CHUNK_BYTES - 1));
        let pieces: Vec<String> = paste_actions(&text)
            .into_iter()
            .map(|piece| match piece {
                InputAction::Paste(text) => text,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(pieces.len(), 2);
        assert!(
            pieces[0].ends_with("\r\n"),
            "{:?}",
            &pieces[0][pieces[0].len() - 3..]
        );
        assert_eq!(pieces[1], "b");
    }

    #[test]
    fn actions_take_the_hosts_wire_shape() {
        let object = |value: ComponentDataValue| match value {
            ComponentDataValue::Object(fields) => fields
                .into_iter()
                .map(|(name, value)| (name, format!("{value:?}")))
                .collect::<Vec<_>>(),
            other => panic!("{other:?}"),
        };
        let key = object(InputAction::key("c", &["ctrl"]).to_data());
        assert_eq!(key[0], ("type".into(), "String(\"key\")".into()));
        assert_eq!(key[2].1, "Array([String(\"ctrl\")])");
        let scroll = object(
            InputAction::Mouse {
                event: MouseEvent::Scroll(true),
                x: 3,
                y: 4,
                modifiers: vec![],
            }
            .to_data(),
        );
        assert!(scroll.contains(&("event".into(), "String(\"scroll\")".into())));
        assert!(scroll.contains(&("direction".into(), "String(\"up\")".into())));
        assert!(!scroll.iter().any(|(name, _)| name == "button"));
        let press = object(
            InputAction::Mouse {
                event: MouseEvent::Press(MouseButton::Left),
                x: 0,
                y: 0,
                modifiers: vec!["shift"],
            }
            .to_data(),
        );
        assert!(press.contains(&("button".into(), "String(\"left\")".into())));
    }
}
