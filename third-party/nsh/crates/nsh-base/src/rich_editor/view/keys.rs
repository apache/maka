//! The keys a `RichEditor` listens to while it has the focus, and what the
//! view does with those no plugin handles: moving the caret.
//!
//! Plugins' keymaps can bind any key, so the view binds every keystroke a
//! keymap could use (named keys with any modifiers, characters with
//! Control or Command), in `nsh/keymap`'s syntax, and hands each to the
//! plugins as a [`KeyEvent`] named as the web's `KeyboardEvent.key`.
//! Characters typed without those modifiers are text, which the native
//! input takes; `mod+v` is left to it too (the paste comes as an event).

use nsh_core::{element::Os, keymap::Keystroke, prelude::os};

use crate::rich_editor::state::KeyEvent;

/// A keystroke to bind and the event it is.
#[derive(Debug, Clone)]
pub(crate) struct KeySpec {
    /// In `nsh/keymap`'s syntax (`"ctrl+shift+left"`).
    pub(crate) keystroke: String,
    pub(crate) event: KeyEvent,
    /// Held, it repeats (moves and deletions).
    pub(crate) repeat: bool,
}

/// Named keys: `nsh/keymap`'s name, the web's, whether held ones repeat.
const NAMED: &[(&str, &str, bool)] = &[
    ("enter", "Enter", true),
    ("backspace", "Backspace", true),
    ("delete", "Delete", true),
    ("tab", "Tab", false),
    ("escape", "Escape", false),
    ("left", "ArrowLeft", true),
    ("right", "ArrowRight", true),
    ("up", "ArrowUp", true),
    ("down", "ArrowDown", true),
    ("home", "Home", false),
    ("end", "End", false),
    ("pageup", "PageUp", true),
    ("pagedown", "PageDown", true),
];

/// Characters bound with Control or Command.
const CHARS: &str = "abcdefghijklmnopqrstuvwxyz0123456789[]`-=\\;',./";

/// Modifiers of a keystroke.
#[derive(Debug, Clone, Copy, Default)]
struct Mods {
    shift: bool,
    alt: bool,
    ctrl: bool,
    cmd: bool,
}

/// Every keystroke the view binds on this platform.
pub(crate) fn key_table() -> Vec<KeySpec> {
    let apple = matches!(os(), Os::MacOs | Os::Ios);
    let os = os();
    let mut out = Vec::with_capacity(1024);
    let combos: Vec<Mods> = (0..if apple { 16 } else { 8 })
        .map(|bits: u32| Mods {
            shift: bits & 1 != 0,
            alt: bits & 2 != 0,
            ctrl: bits & 4 != 0,
            cmd: bits & 8 != 0,
        })
        .collect();
    let mut push = |keystroke: String, event: KeyEvent, repeat: bool| {
        // Keys the platform keeps (Command+Q, ...) cannot be bound.
        match Keystroke::parse_with(&keystroke, apple) {
            Ok(parsed) if parsed.reserved(os).is_none() => out.push(KeySpec {
                keystroke,
                event,
                repeat,
            }),
            _ => {}
        }
    };
    for (name, key, repeat) in NAMED {
        for m in &combos {
            push(keystroke(*m, name), event(key, *m, apple), *repeat);
        }
    }
    for c in CHARS.chars() {
        for m in combos.iter().filter(|m| m.ctrl || m.cmd) {
            let s = c.to_string();
            // Pastes are the native input's (an event with the text).
            if c == 'v' && !m.shift && !m.alt && (if apple { m.cmd && !m.ctrl } else { m.ctrl }) {
                continue;
            }
            let key = if m.shift && c.is_ascii_alphabetic() {
                c.to_ascii_uppercase().to_string()
            } else {
                s.clone()
            };
            push(keystroke(*m, &s), event(&key, *m, apple), false);
        }
    }
    out
}

fn keystroke(m: Mods, key: &str) -> String {
    let mut parts = Vec::new();
    if m.cmd {
        parts.push("cmd");
    }
    if m.ctrl {
        parts.push("ctrl");
    }
    if m.alt {
        parts.push("alt");
    }
    if m.shift {
        parts.push("shift");
    }
    parts.push(key);
    parts.join("+")
}

fn event(key: &str, m: Mods, apple: bool) -> KeyEvent {
    KeyEvent {
        mod_key: if apple { m.cmd } else { m.ctrl },
        ctrl: m.ctrl,
        alt: m.alt,
        shift: m.shift,
        meta: m.cmd,
        ..KeyEvent::new(key)
    }
}

/// How the caret moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unit {
    /// A grapheme.
    Char,
    /// A word.
    Word,
    /// To the line's start or end.
    LineEdge,
    /// A line up or down.
    Line,
    /// A page up or down.
    Page,
    /// To the document's start or end.
    Doc,
}

/// A caret movement: by `unit` toward `dir` (negative backward),
/// extending the selection with `extend`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Move {
    pub(crate) unit: Unit,
    pub(crate) dir: i32,
    pub(crate) extend: bool,
}

/// The movement a key makes when no plugin took it.
pub(crate) fn movement(e: &KeyEvent) -> Option<Move> {
    let apple = matches!(os(), Os::MacOs | Os::Ios);
    let extend = e.shift;
    let (unit, dir) = match e.key.as_str() {
        "ArrowLeft" | "ArrowRight" => {
            let dir = if e.key == "ArrowLeft" { -1 } else { 1 };
            let unit = if apple && e.meta {
                Unit::LineEdge
            } else if (apple && e.alt) || (!apple && e.ctrl) {
                Unit::Word
            } else {
                Unit::Char
            };
            (unit, dir)
        }
        "ArrowUp" | "ArrowDown" => {
            let dir = if e.key == "ArrowUp" { -1 } else { 1 };
            (
                if apple && e.meta {
                    Unit::Doc
                } else {
                    Unit::Line
                },
                dir,
            )
        }
        "Home" | "End" => {
            let dir = if e.key == "Home" { -1 } else { 1 };
            (
                if e.ctrl || e.meta {
                    Unit::Doc
                } else {
                    Unit::LineEdge
                },
                dir,
            )
        }
        "PageUp" => (Unit::Page, -1),
        "PageDown" => (Unit::Page, 1),
        _ => return None,
    };
    Some(Move { unit, dir, extend })
}
