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

//! Classify browser shortcuts before any physical key event is dispatched.

use super::keyboard::{self, Chord};

/// Clipboard effects use the admitted browser's virtual clipboard exclusively.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ClipboardShortcut {
    Copy,
    Cut,
    Paste { plain_text_only: bool },
    Refuse,
}

fn protected(code: &str, modifiers: u32) -> bool {
    let has_control_or_meta = modifiers & 6 != 0;
    let has_shift = modifiers & 8 != 0;
    if matches!(code, "KeyC" | "KeyX")
        && modifiers.count_ones() == 2
        && has_shift
        && has_control_or_meta
    {
        return false;
    }
    match code {
        "KeyC" | "KeyV" | "KeyX" => has_control_or_meta,
        "Insert" => modifiers & 10 != 0,
        "Delete" => has_shift,
        _ => false,
    }
}

fn clipboard_action(code: &str, modifiers: u32) -> Option<ClipboardShortcut> {
    if modifiers.count_ones() == 1 {
        match (code, modifiers) {
            ("Insert", 2) => return Some(ClipboardShortcut::Copy),
            ("Insert", 8) => {
                return Some(ClipboardShortcut::Paste {
                    plain_text_only: false,
                });
            }
            ("Delete", 8) => return Some(ClipboardShortcut::Cut),
            _ => {}
        }
    }
    let one_control_or_meta = matches!(modifiers & 6, 2 | 4);
    let has_shift = modifiers & 8 != 0;
    if !one_control_or_meta
        || !(modifiers.count_ones() == 1 || modifiers.count_ones() == 2 && has_shift)
    {
        return None;
    }
    match code {
        "KeyC" if !has_shift => Some(ClipboardShortcut::Copy),
        "KeyX" if !has_shift => Some(ClipboardShortcut::Cut),
        "KeyV" => Some(ClipboardShortcut::Paste {
            plain_text_only: has_shift,
        }),
        _ => None,
    }
}

/// Inspect the real key order, including clipboard keys appearing in a prefix.
///
/// Smart modifiers have already been resolved for the target platform. Both
/// actual Control and Meta clipboard shortcuts retain their browser meaning.
pub(super) fn clipboard(chord: &Chord, _target_macos: bool) -> Option<ClipboardShortcut> {
    let mut modifiers = 0;
    let mut ordinary = Vec::new();
    let mut protected_prefix = false;
    for key in chord.modifiers.iter().chain(std::iter::once(&chord.key)) {
        let modifier = key.modifier_mask();
        if modifier != 0 {
            modifiers |= modifier;
        } else {
            ordinary.push(key.code.as_str());
            protected_prefix |= protected(&key.code, modifiers);
        }
    }
    if let [code] = ordinary.as_slice() {
        if let Some(action) = clipboard_action(code, modifiers) {
            return Some(action);
        }
        if protected(code, modifiers) {
            return Some(ClipboardShortcut::Refuse);
        }
    }
    protected_prefix.then_some(ClipboardShortcut::Refuse)
}

fn tokens(value: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        if character == '+' && !current.is_empty() {
            values.push(std::mem::take(&mut current));
        } else {
            current.push(character);
        }
    }
    if !current.is_empty() {
        values.push(current);
    }
    values
}

fn alias(value: &str) -> String {
    // Literal characters and physical codes retain their case and Shift
    // behavior. Legacy names are considered only after a direct layout miss.
    if keyboard::chord(value).is_ok() {
        return value.into();
    }
    let compact = value.to_lowercase().replace('_', "");
    let name = match compact.as_str() {
        "alt" | "option" => "Alt",
        "control" => "Control",
        "controlormeta" | "ctrl" => "ControlOrMeta",
        "cmd" | "command" | "meta" | "win" | "super" => "Meta",
        "shift" => "Shift",
        "capslock" | "shiftlock" => "CapsLock",
        "esc" | "escape" => "Escape",
        "enter" | "return" | "linefeed" => "Enter",
        "backspace" => "Backspace",
        "delete" | "del" => "Delete",
        "tab" => "Tab",
        "space" => "Space",
        "left" | "arrowleft" => "ArrowLeft",
        "right" | "arrowright" => "ArrowRight",
        "up" | "arrowup" => "ArrowUp",
        "down" | "arrowdown" => "ArrowDown",
        "home" | "begin" => "Home",
        "end" => "End",
        "insert" => "Insert",
        "pageup" | "prior" => "PageUp",
        "pagedown" | "next" => "PageDown",
        "menu" => "ContextMenu",
        "exclam" => "!",
        "quotedbl" => "\"",
        "numbersign" => "#",
        "dollar" => "$",
        "percent" => "%",
        "ampersand" => "&",
        "apostrophe" => "'",
        "parenleft" => "(",
        "parenright" => ")",
        "asterisk" => "*",
        "plus" => "+",
        "comma" => ",",
        "minus" => "-",
        "period" => ".",
        "slash" => "/",
        "colon" => ":",
        "semicolon" => ";",
        "less" => "<",
        "equal" => "=",
        "greater" => ">",
        "question" => "?",
        "at" => "@",
        "bracketleft" => "[",
        "backslash" => "\\",
        "bracketright" => "]",
        "asciicircum" => "^",
        "underscore" => "_",
        "grave" => "`",
        "braceleft" => "{",
        "bar" => "|",
        "braceright" => "}",
        "asciitilde" => "~",
        "kpenter" => "NumpadEnter",
        "kpmultiply" => "NumpadMultiply",
        "kpadd" => "NumpadAdd",
        "kpsubtract" => "NumpadSubtract",
        "kpdecimal" => "NumpadDecimal",
        "kpdivide" => "NumpadDivide",
        _ => {
            if let Some(number) = compact.strip_prefix("kp")
                && number.len() == 1
                && number.as_bytes()[0].is_ascii_digit()
            {
                return format!("Numpad{number}");
            }
            return value.into();
        }
    };
    name.into()
}

/// Normalize observed key aliases while preserving a literal plus key.
pub(super) fn normalize(value: &str) -> String {
    let values = tokens(value);
    let combined = values
        .iter()
        .map(|value| value.to_lowercase())
        .collect::<Vec<_>>()
        .join("+");
    match combined.as_str() {
        "ctrl+a" => "ControlOrMeta+a".into(),
        "ctrl+c" => "ControlOrMeta+c".into(),
        "ctrl+l" => "ControlOrMeta+l".into(),
        "ctrl+n" => "ControlOrMeta+n".into(),
        "ctrl+v" => "ControlOrMeta+v".into(),
        "ctrl+x" => "ControlOrMeta+x".into(),
        "ctrl+z" => "ControlOrMeta+z".into(),
        "ctrl+shift+v" => "ControlOrMeta+Shift+v".into(),
        "ctrl+y" => "ControlOrMeta+Shift+z".into(),
        _ => values
            .iter()
            .map(|value| alias(value))
            .collect::<Vec<_>>()
            .join("+"),
    }
}

/// Chromium editing commands observed for the main key of an admitted chord.
pub(super) fn edit_commands(chord: &Chord, target_macos: bool) -> Vec<&'static str> {
    let modifiers = chord.mask | chord.key.modifier_mask();
    let select_all_modifier = if target_macos { 4 } else { 2 };
    if chord.key.code == "KeyA" && modifiers == select_all_modifier {
        return vec!["selectAll"];
    }
    if !target_macos {
        return Vec::new();
    }
    match (chord.key.code.as_str(), modifiers) {
        ("Backspace", 0) => vec!["deleteBackward"],
        ("Delete", 0) => vec!["deleteForward"],
        ("KeyZ", 4) => vec!["undo"],
        ("KeyZ", 12) => vec!["redo"],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(value: &str) -> Chord {
        keyboard::chord(value).expect("known shortcut")
    }

    #[test]
    fn clipboard_actions_preserve_plain_text_and_legacy_insert_shortcuts() {
        for modifier in ["Control", "Meta"] {
            assert_eq!(
                clipboard(&keys(&format!("{modifier}+c")), false),
                Some(ClipboardShortcut::Copy)
            );
            assert_eq!(
                clipboard(&keys(&format!("{modifier}+x")), true),
                Some(ClipboardShortcut::Cut)
            );
            assert_eq!(
                clipboard(&keys(&format!("{modifier}+v")), false),
                Some(ClipboardShortcut::Paste {
                    plain_text_only: false
                })
            );
            assert_eq!(
                clipboard(&keys(&format!("{modifier}+Shift+v")), true),
                Some(ClipboardShortcut::Paste {
                    plain_text_only: true
                })
            );
        }
        assert_eq!(
            clipboard(&keys("Control+Insert"), false),
            Some(ClipboardShortcut::Copy)
        );
        assert_eq!(
            clipboard(&keys("Shift+Insert"), true),
            Some(ClipboardShortcut::Paste {
                plain_text_only: false
            })
        );
        assert_eq!(
            clipboard(&keys("Shift+Delete"), true),
            Some(ClipboardShortcut::Cut)
        );
    }

    #[test]
    fn complex_clipboard_sequences_refuse_without_blocking_shift_c_or_x() {
        for value in [
            "Control+Alt+c",
            "Meta+Control+v",
            "Control+c+a",
            "Control+c+F1",
            "Meta+x+ArrowRight",
            "Control+c+Shift",
            "Control+Shift+Insert",
        ] {
            assert_eq!(
                clipboard(&keys(value), false),
                Some(ClipboardShortcut::Refuse),
                "shortcut {value}"
            );
        }
        for value in [
            "Control+Shift+c",
            "Meta+Shift+x",
            "c+Control+a",
            "Alt+v",
            "Control+a",
        ] {
            assert_eq!(clipboard(&keys(value), false), None, "shortcut {value}");
        }
    }

    #[test]
    fn normalizing_legacy_names_preserves_literals_and_plus_token_boundaries() {
        assert_eq!(normalize("CTRL+Y"), "ControlOrMeta+Shift+z");
        assert_eq!(normalize("option+return"), "Alt+Enter");
        assert_eq!(normalize("cmd+Page_Up"), "Meta+PageUp");
        assert_eq!(normalize("Control++"), "Control++");
        assert_eq!(normalize("Control+"), "Control");
        assert_eq!(normalize("++"), "+");
        assert_eq!(normalize("plus"), "+");
        assert_eq!(normalize("Shift+Backslash"), "Shift+Backslash");
        assert_eq!(normalize("Shift+backslash"), "Shift+\\");
        assert_eq!(normalize("A"), "A");
        assert_eq!(normalize("kp_7"), "Numpad7");
    }

    #[test]
    fn editing_commands_follow_the_target_platform_and_exact_modifier_set() {
        assert_eq!(edit_commands(&keys("Control+a"), false), ["selectAll"]);
        assert!(edit_commands(&keys("Control+a"), true).is_empty());
        assert_eq!(edit_commands(&keys("Meta+a"), true), ["selectAll"]);
        assert_eq!(edit_commands(&keys("Backspace"), true), ["deleteBackward"]);
        assert_eq!(edit_commands(&keys("Delete"), true), ["deleteForward"]);
        assert!(edit_commands(&keys("Shift+Backspace"), true).is_empty());
        assert_eq!(edit_commands(&keys("Meta+z"), true), ["undo"]);
        assert_eq!(edit_commands(&keys("Meta+Shift+z"), true), ["redo"]);
        assert!(edit_commands(&keys("Meta+Shift+Alt+z"), true).is_empty());
    }
}
