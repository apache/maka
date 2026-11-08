//! What the keys with no text send, as xterm sends them.

use super::TerminalModes;

/// The bytes of a bound key.
#[derive(Debug, Clone, Copy)]
pub(super) enum KeyBytes {
    /// The same in every mode.
    Fixed(&'static str),
    /// An arrow, Home or End: `ESC [ x`, or `ESC O x` in application
    /// cursor mode.
    Cursor(char),
}

impl KeyBytes {
    pub(super) fn encode(self, modes: TerminalModes) -> String {
        match self {
            KeyBytes::Fixed(s) => s.to_owned(),
            KeyBytes::Cursor(c) if modes.application_cursor => format!("\x1bO{c}"),
            KeyBytes::Cursor(c) => format!("\x1b[{c}"),
        }
    }
}

const CTRL: [&str; 26] = [
    "\x01", "\x02", "\x03", "\x04", "\x05", "\x06", "\x07", "\x08", "\x09", "\x0a", "\x0b", "\x0c",
    "\x0d", "\x0e", "\x0f", "\x10", "\x11", "\x12", "\x13", "\x14", "\x15", "\x16", "\x17", "\x18",
    "\x19", "\x1a",
];

const CTRL_KEYS: [&str; 26] = [
    "ctrl+a", "ctrl+b", "ctrl+c", "ctrl+d", "ctrl+e", "ctrl+f", "ctrl+g", "ctrl+h", "ctrl+i",
    "ctrl+j", "ctrl+k", "ctrl+l", "ctrl+m", "ctrl+n", "ctrl+o", "ctrl+p", "ctrl+q", "ctrl+r",
    "ctrl+s", "ctrl+t", "ctrl+u", "ctrl+v", "ctrl+w", "ctrl+x", "ctrl+y", "ctrl+z",
];

/// Every bound key and what it sends. `apple`: Control is free of the
/// app's shortcuts (Command is theirs); elsewhere Ctrl+Q stays the
/// system's, and Ctrl+Shift+C / V are the clipboard's, as in terminals.
pub(super) fn bindings(apple: bool) -> Vec<(&'static str, KeyBytes)> {
    use KeyBytes::*;
    let mut out = vec![
        ("enter", Fixed("\r")),
        ("backspace", Fixed("\x7f")),
        ("tab", Fixed("\t")),
        ("shift+tab", Fixed("\x1b[Z")),
        ("escape", Fixed("\x1b")),
        ("up", Cursor('A')),
        ("down", Cursor('B')),
        ("right", Cursor('C')),
        ("left", Cursor('D')),
        ("home", Cursor('H')),
        ("end", Cursor('F')),
        ("delete", Fixed("\x1b[3~")),
        ("pageup", Fixed("\x1b[5~")),
        ("pagedown", Fixed("\x1b[6~")),
        ("alt+left", Fixed("\x1bb")),
        ("alt+right", Fixed("\x1bf")),
        ("alt+backspace", Fixed("\x1b\x7f")),
    ];
    for (keys, bytes) in CTRL_KEYS.iter().zip(CTRL) {
        if !apple && *keys == "ctrl+q" {
            continue;
        }
        out.push((keys, Fixed(bytes)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_keys_follow_the_mode() {
        let app = TerminalModes {
            application_cursor: true,
            ..Default::default()
        };
        assert_eq!(
            KeyBytes::Cursor('A').encode(TerminalModes::default()),
            "\x1b[A"
        );
        assert_eq!(KeyBytes::Cursor('A').encode(app), "\x1bOA");
    }

    #[test]
    fn every_key_parses() {
        for apple in [true, false] {
            for (keys, _) in bindings(apple) {
                nsh_core::keymap::Keystroke::parse_with(keys, apple).unwrap();
            }
        }
    }
}
