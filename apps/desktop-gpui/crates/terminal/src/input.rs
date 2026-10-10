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

//! What keys, the mouse, pastes and focus send to a terminal's PTY, written
//! from xterm's control sequence documentation ("XTerm Control Sequences":
//! PC-Style Function Keys, Mouse Tracking, Bracketed Paste Mode, FocusIn /
//! FocusOut). The PTY takes UTF-8 text, so every result is a string.
//!
//! The view binds keys to these; the setting that turns Option into Meta
//! is its too, handed in as a flag. GPUI keystrokes do not tell the keypad
//! from the main keys, so application keypad mode (DECKPAM) changes
//! nothing here.

use std::borrow::Cow;

use alacritty_terminal::term::TermMode;
use gpui_kit::{Keystroke, Modifiers};

/// The bytes `keystroke` sends, or `None` when it sends none of its own:
/// plain text (the view's text input sends what was typed, IME
/// composition included), or a ⌘ shortcut that belongs to the app.
///
/// Arrows, Home and End follow application cursor mode (`ESC O` instead
/// of `ESC [`) without modifiers; with Shift, Option or Control they send
/// xterm's modifier code (`ESC [ 1 ; m A`, m = 1 + Shift 1 + Alt 2 +
/// Control 4), as do the editing keys and F1–F12. Control with a
/// character sends its control code. With `option_as_meta`, Option with
/// a key sends Escape and the key, as Meta does; without it, Option
/// composes text as macOS does. The macOS conveniences: ⌘← and ⌘→ go to
/// the start and end of the line (Ctrl-A, Ctrl-E), ⌘⌫ deletes to its start
/// (Ctrl-U), ⌥← and ⌥→ move by word (`ESC b`, `ESC f`).
pub fn key_input(
    keystroke: &Keystroke,
    mode: TermMode,
    option_as_meta: bool,
) -> Option<Cow<'static, str>> {
    let modifiers = &keystroke.modifiers;
    let key = keystroke.key.as_str();
    let (shift, alt, control) = (modifiers.shift, modifiers.alt, modifiers.control);
    if modifiers.platform {
        let convenience = match key {
            _ if shift || alt || control => None,
            "left" => Some("\x01"),
            "right" => Some("\x05"),
            "backspace" => Some("\x15"),
            _ => None,
        };
        return convenience.map(Cow::Borrowed);
    }
    if alt && !shift && !control {
        match key {
            "left" => return Some(Cow::Borrowed("\x1bb")),
            "right" => return Some(Cow::Borrowed("\x1bf")),
            _ => {}
        }
    }
    let meta = alt && option_as_meta;
    let code = 1 + u8::from(shift) + 2 * u8::from(alt) + 4 * u8::from(control);
    let modified = code > 1;
    let cursor = |last: char| -> Cow<'static, str> {
        if modified {
            Cow::Owned(format!("\x1b[1;{code}{last}"))
        } else if mode.contains(TermMode::APP_CURSOR) {
            Cow::Owned(format!("\x1bO{last}"))
        } else {
            Cow::Owned(format!("\x1b[{last}"))
        }
    };
    let tilde = |number: u8| -> Cow<'static, str> {
        if modified {
            Cow::Owned(format!("\x1b[{number};{code}~"))
        } else {
            Cow::Owned(format!("\x1b[{number}~"))
        }
    };
    let escaped = |text: &'static str| -> Cow<'static, str> {
        if meta { Cow::Owned(format!("\x1b{text}")) } else { Cow::Borrowed(text) }
    };
    Some(match key {
        "enter" => escaped("\r"),
        "tab" if shift => Cow::Borrowed("\x1b[Z"),
        "tab" => escaped("\t"),
        "escape" => escaped("\x1b"),
        "backspace" if control => escaped("\x08"),
        "backspace" => escaped("\x7f"),
        "space" if control => escaped("\0"),
        "space" if meta => Cow::Borrowed("\x1b "),
        "up" => cursor('A'),
        "down" => cursor('B'),
        "right" => cursor('C'),
        "left" => cursor('D'),
        "home" => cursor('H'),
        "end" => cursor('F'),
        "insert" => tilde(2),
        "delete" => tilde(3),
        "pageup" => tilde(5),
        "pagedown" => tilde(6),
        "f1" | "f2" | "f3" | "f4" => {
            let last = match key {
                "f1" => 'P',
                "f2" => 'Q',
                "f3" => 'R',
                _ => 'S',
            };
            if modified {
                Cow::Owned(format!("\x1b[1;{code}{last}"))
            } else {
                Cow::Owned(format!("\x1bO{last}"))
            }
        }
        "f5" => tilde(15),
        "f6" => tilde(17),
        "f7" => tilde(18),
        "f8" => tilde(19),
        "f9" => tilde(20),
        "f10" => tilde(21),
        "f11" => tilde(23),
        "f12" => tilde(24),
        _ => {
            let mut chars = key.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else {
                return None;
            };
            if control {
                let byte = control_code(c)?;
                let text = char::from(byte).to_string();
                return Some(Cow::Owned(if meta { format!("\x1b{text}") } else { text }));
            }
            if meta {
                let c = if shift { c.to_ascii_uppercase() } else { c };
                return Some(Cow::Owned(format!("\x1b{c}")));
            }
            return None;
        }
    })
}

/// The control code Control and `c` type: `@`–`_` and letters to 0–31,
/// with the digit row's traditional aliases (2 → NUL … 8 → DEL).
fn control_code(c: char) -> Option<u8> {
    let c = c.to_ascii_lowercase();
    Some(match c {
        'a'..='z' => c as u8 - b'a' + 1,
        '@' | '2' | ' ' => 0,
        '[' | '3' => 27,
        '\\' | '4' => 28,
        ']' | '5' => 29,
        '^' | '6' => 30,
        '_' | '-' | '7' => 31,
        '?' | '8' => 127,
        _ => return None,
    })
}

/// What a paste sends: in bracketed paste mode the text between
/// `ESC [200~` and `ESC [201~`, with every Escape removed so the text cannot
/// end the bracket early; otherwise the text with each line break as a
/// carriage return, as Enter types it.
pub fn paste_input(text: &str, mode: TermMode) -> String {
    if mode.contains(TermMode::BRACKETED_PASTE) {
        format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', ""))
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r")
    }
}

/// What gaining or losing focus sends when the program asked to hear it
/// (focus event mode, `CSI ? 1004 h`).
pub fn focus_input(focused: bool, mode: TermMode) -> Option<&'static str> {
    mode.contains(TermMode::FOCUS_IN_OUT).then_some(if focused { "\x1b[I" } else { "\x1b[O" })
}

/// A mouse button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

/// What the mouse did, for [`mouse_input`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseAction {
    Press(MouseButton),
    Release(MouseButton),
    /// Moved, with `button` held (a drag) or none.
    Move(Option<MouseButton>),
    /// One notch of the wheel.
    WheelUp,
    WheelDown,
}

/// What a mouse action at the cell `column`, `row` of the screen (from 0,
/// top left) sends when the program asked for mouse reports, in the
/// encoding it chose: SGR (`CSI < b ; x ; y M`), UTF-8, or the original
/// bytes. `None` when it asked for none of this kind: clicks need any
/// mouse mode, drags button-event or any-event tracking, bare moves
/// any-event tracking. The original encoding sends coordinates as single
/// bytes; past column or row 95 they are no longer ASCII, which this UTF-8
/// channel cannot carry, so such reports are not sent.
pub fn mouse_input(
    action: MouseAction,
    column: usize,
    row: usize,
    modifiers: &Modifiers,
    mode: TermMode,
) -> Option<String> {
    let button_code = |button: MouseButton| match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
    };
    let (code, release) = match action {
        MouseAction::Press(button) if mode.intersects(TermMode::MOUSE_MODE) => {
            (button_code(button), false)
        }
        MouseAction::Release(button) if mode.intersects(TermMode::MOUSE_MODE) => {
            (button_code(button), true)
        }
        MouseAction::Move(Some(button))
            if mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION) =>
        {
            (button_code(button) + 32, false)
        }
        MouseAction::Move(None) if mode.contains(TermMode::MOUSE_MOTION) => (3 + 32, false),
        MouseAction::WheelUp if mode.intersects(TermMode::MOUSE_MODE) => (64, false),
        MouseAction::WheelDown if mode.intersects(TermMode::MOUSE_MODE) => (65, false),
        _ => return None,
    };
    let code = code
        + if modifiers.shift { 4 } else { 0 }
        + if modifiers.alt { 8 } else { 0 }
        + if modifiers.control { 16 } else { 0 };
    let (x, y) = (column + 1, row + 1);
    if mode.contains(TermMode::SGR_MOUSE) {
        let last = if release { 'm' } else { 'M' };
        return Some(format!("\x1b[<{code};{x};{y}{last}"));
    }
    // Without SGR a release does not say which button.
    let code = if release { 3 + (code & !3) } else { code };
    let limit = if mode.contains(TermMode::UTF8_MOUSE) { 2015 } else { 95 };
    if x > limit || y > limit {
        return None;
    }
    let encode = |value: usize| char::from_u32(32 + value as u32);
    Some(format!("\x1b[M{}{}{}", encode(code)?, encode(x)?, encode(y)?))
}

/// What turning the wheel by `lines` (up when positive) sends on the
/// alternate screen when the program asked for alternate scroll and no
/// mouse reports: the arrow keys, one per line, in application cursor mode
/// when that is on. `None` elsewhere: the view scrolls its scrollback.
pub fn alternate_scroll_input(lines: i32, mode: TermMode) -> Option<String> {
    let alternate = mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL)
        && !mode.intersects(TermMode::MOUSE_MODE);
    if !alternate || lines == 0 {
        return None;
    }
    let prefix = if mode.contains(TermMode::APP_CURSOR) { "\x1bO" } else { "\x1b[" };
    let last = if lines > 0 { 'A' } else { 'B' };
    Some(format!("{prefix}{last}").repeat(lines.unsigned_abs() as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(source: &str, mode: TermMode, meta: bool) -> Option<String> {
        let keystroke = Keystroke::parse(source).expect("keystroke");
        key_input(&keystroke, mode, meta).map(Cow::into_owned)
    }

    fn plain(source: &str) -> Option<String> {
        key(source, TermMode::empty(), false)
    }

    #[test]
    fn arrows_follow_application_cursor_mode() {
        assert_eq!(plain("up").as_deref(), Some("\x1b[A"));
        assert_eq!(plain("left").as_deref(), Some("\x1b[D"));
        assert_eq!(plain("home").as_deref(), Some("\x1b[H"));
        assert_eq!(key("down", TermMode::APP_CURSOR, false).as_deref(), Some("\x1bOB"));
        assert_eq!(key("end", TermMode::APP_CURSOR, false).as_deref(), Some("\x1bOF"));
        // Modifiers win over application cursor mode.
        assert_eq!(key("shift-up", TermMode::APP_CURSOR, false).as_deref(), Some("\x1b[1;2A"));
    }

    #[test]
    fn modifiers_send_xterm_codes() {
        assert_eq!(plain("ctrl-right").as_deref(), Some("\x1b[1;5C"));
        assert_eq!(plain("ctrl-shift-left").as_deref(), Some("\x1b[1;6D"));
        assert_eq!(plain("alt-up").as_deref(), Some("\x1b[1;3A"));
        assert_eq!(plain("shift-delete").as_deref(), Some("\x1b[3;2~"));
        assert_eq!(plain("pageup").as_deref(), Some("\x1b[5~"));
        assert_eq!(plain("f1").as_deref(), Some("\x1bOP"));
        assert_eq!(plain("ctrl-f2").as_deref(), Some("\x1b[1;5Q"));
        assert_eq!(plain("f12").as_deref(), Some("\x1b[24~"));
        assert_eq!(plain("shift-tab").as_deref(), Some("\x1b[Z"));
    }

    #[test]
    fn control_and_editing_keys() {
        assert_eq!(plain("ctrl-c").as_deref(), Some("\x03"));
        assert_eq!(plain("ctrl-shift-a").as_deref(), Some("\x01"));
        assert_eq!(plain("ctrl-[").as_deref(), Some("\x1b"));
        assert_eq!(plain("ctrl-space").as_deref(), Some("\0"));
        assert_eq!(plain("enter").as_deref(), Some("\r"));
        assert_eq!(plain("backspace").as_deref(), Some("\x7f"));
        assert_eq!(plain("ctrl-backspace").as_deref(), Some("\x08"));
        assert_eq!(plain("escape").as_deref(), Some("\x1b"));
        // Plain characters are the text input's.
        assert_eq!(plain("a"), None);
        assert_eq!(plain("shift-a"), None);
        assert_eq!(plain("space"), None);
    }

    #[test]
    fn option_is_meta_only_when_asked() {
        assert_eq!(key("alt-b", TermMode::empty(), true).as_deref(), Some("\x1bb"));
        assert_eq!(key("alt-shift-b", TermMode::empty(), true).as_deref(), Some("\x1bB"));
        assert_eq!(key("alt-backspace", TermMode::empty(), true).as_deref(), Some("\x1b\x7f"));
        assert_eq!(key("alt-enter", TermMode::empty(), true).as_deref(), Some("\x1b\r"));
        assert_eq!(key("ctrl-alt-c", TermMode::empty(), true).as_deref(), Some("\x1b\x03"));
        // Without it, Option composes text (the text input sends "∫").
        assert_eq!(key("alt-b", TermMode::empty(), false), None);
        assert_eq!(key("alt-enter", TermMode::empty(), false).as_deref(), Some("\r"));
    }

    #[test]
    fn macos_conveniences() {
        assert_eq!(plain("cmd-left").as_deref(), Some("\x01"));
        assert_eq!(plain("cmd-right").as_deref(), Some("\x05"));
        assert_eq!(plain("cmd-backspace").as_deref(), Some("\x15"));
        assert_eq!(plain("alt-left").as_deref(), Some("\x1bb"));
        assert_eq!(plain("alt-right").as_deref(), Some("\x1bf"));
        // Other ⌘ keys are the app's (copy, paste, find).
        assert_eq!(plain("cmd-c"), None);
        assert_eq!(plain("cmd-shift-left"), None);
    }

    #[test]
    fn a_bracketed_paste_is_wrapped_and_cannot_close_itself() {
        let bracketed = TermMode::BRACKETED_PASTE;
        assert_eq!(paste_input("ls\x1b[201~rm\n", bracketed), "\x1b[200~ls[201~rm\n\x1b[201~");
        assert_eq!(paste_input("a\r\nb\nc", TermMode::empty()), "a\rb\rc");
    }

    #[test]
    fn focus_is_reported_only_when_asked() {
        assert_eq!(focus_input(true, TermMode::empty()), None);
        assert_eq!(focus_input(true, TermMode::FOCUS_IN_OUT), Some("\x1b[I"));
        assert_eq!(focus_input(false, TermMode::FOCUS_IN_OUT), Some("\x1b[O"));
    }

    #[test]
    fn mouse_reports_follow_the_mode_and_encoding() {
        let none = Modifiers::default();
        let click = TermMode::MOUSE_REPORT_CLICK;
        let left = MouseAction::Press(MouseButton::Left);
        assert_eq!(mouse_input(left, 0, 0, &none, TermMode::empty()), None);
        assert_eq!(mouse_input(left, 0, 0, &none, click).as_deref(), Some("\x1b[M !!"));
        assert_eq!(
            mouse_input(MouseAction::Release(MouseButton::Right), 1, 2, &none, click).as_deref(),
            Some("\x1b[M#\"#")
        );
        let sgr = click | TermMode::SGR_MOUSE;
        assert_eq!(
            mouse_input(MouseAction::Release(MouseButton::Right), 9, 4, &none, sgr).as_deref(),
            Some("\x1b[<2;10;5m")
        );
        let control = Modifiers { control: true, ..Modifiers::default() };
        assert_eq!(
            mouse_input(MouseAction::WheelUp, 0, 0, &control, sgr).as_deref(),
            Some("\x1b[<80;1;1M")
        );
        // Drags need button-event tracking, bare moves any-event tracking.
        let drag = MouseAction::Move(Some(MouseButton::Left));
        assert_eq!(mouse_input(drag, 0, 0, &none, sgr), None);
        assert_eq!(
            mouse_input(drag, 0, 0, &none, sgr | TermMode::MOUSE_DRAG).as_deref(),
            Some("\x1b[<32;1;1M")
        );
        assert_eq!(
            mouse_input(MouseAction::Move(None), 0, 0, &none, sgr | TermMode::MOUSE_DRAG),
            None
        );
        // The original encoding stops where its bytes stop being ASCII;
        // UTF-8 goes on.
        assert_eq!(mouse_input(left, 95, 0, &none, click), None);
        assert_eq!(
            mouse_input(left, 95, 0, &none, click | TermMode::UTF8_MOUSE).as_deref(),
            Some("\x1b[M \u{80}!")
        );
    }

    #[test]
    fn the_wheel_on_the_alternate_screen_sends_arrows() {
        let alternate = TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL;
        assert_eq!(alternate_scroll_input(2, alternate).as_deref(), Some("\x1b[A\x1b[A"));
        assert_eq!(
            alternate_scroll_input(-1, alternate | TermMode::APP_CURSOR).as_deref(),
            Some("\x1bOB")
        );
        assert_eq!(alternate_scroll_input(1, TermMode::ALT_SCREEN), None);
        assert_eq!(
            alternate_scroll_input(
                1,
                alternate | TermMode::SGR_MOUSE | TermMode::MOUSE_REPORT_CLICK
            ),
            None
        );
    }
}
