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

//! Resolve public Playwright key names against its independently vendored layout.

use maka_agent_facts::tools::ToolError;
use serde::Deserialize;
use std::{collections::HashMap, sync::LazyLock};

const LAYOUT: &str = include_str!("../../../../../../third-party/playwright/keyboard.json");

/// The metadata needed by Chromium's keyboard input events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct KeyDescription {
    token: String,
    pub key: String,
    pub code: String,
    /// Chromium uses the layout's key code without its left/right location.
    pub key_code: u32,
    pub text: String,
    pub location: u8,
}

impl KeyDescription {
    /// Return Chromium's modifier bit for this key, or zero for ordinary keys.
    pub(super) fn modifier_mask(&self) -> u32 {
        match self.key.as_str() {
            "Alt" => 1,
            "Control" => 2,
            "Meta" => 4,
            "Shift" => 8,
            _ => 0,
        }
    }

    /// Re-resolve a key for the current state when releasing a shortcut.
    pub(super) fn for_modifiers(&self, modifiers: u32) -> Self {
        description(&self.token, modifiers).expect("resolved keyboard token remains in the layout")
    }
}

/// The ordered keys surrounding one main key in a public keyboard shortcut.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Chord {
    /// Press these in order and release them in reverse order.
    pub modifiers: Vec<KeyDescription>,
    pub key: KeyDescription,
    /// The actual modifier mask after the prefix keys have been pressed.
    pub mask: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Definition {
    key_code: u32,
    key_code_without_location: Option<u32>,
    key: String,
    text: Option<String>,
    location: Option<u8>,
    shift_key: Option<String>,
    #[serde(rename = "shiftKeyCode")]
    _shift_key_code: Option<u32>,
}

#[derive(Clone)]
struct Entry {
    plain: KeyDescription,
    shifted: Option<KeyDescription>,
}

static KEYS: LazyLock<HashMap<String, Entry>> = LazyLock::new(|| {
    let definitions: HashMap<String, Definition> =
        serde_json::from_str(LAYOUT).expect("vendored Playwright keyboard data is valid");
    let mut keys = HashMap::new();
    for (code, definition) in definitions {
        let plain = KeyDescription {
            token: code.clone(),
            text: if definition.key.chars().count() == 1 {
                definition.key.clone()
            } else {
                definition.text.unwrap_or_default()
            },
            key: definition.key,
            code: code.clone(),
            key_code: definition
                .key_code_without_location
                .unwrap_or(definition.key_code),
            location: definition.location.unwrap_or_default(),
        };
        let shifted = definition.shift_key.map(|key| {
            // Playwright retains keyCodeWithoutLocation when its shifted
            // numpad description changes keyCode. Chromium consumes the former.
            KeyDescription {
                text: key.clone(),
                key,
                ..plain.clone()
            }
        });
        keys.insert(
            code.clone(),
            Entry {
                plain: plain.clone(),
                shifted: shifted.clone(),
            },
        );
        let aliases: &[&str] = match code.as_str() {
            "ShiftLeft" => &["Shift"],
            "ControlLeft" => &["Control"],
            "AltLeft" => &["Alt"],
            "MetaLeft" => &["Meta"],
            "Enter" => &["\n", "\r"],
            _ => &[],
        };
        for alias in aliases {
            keys.insert(
                (*alias).into(),
                Entry {
                    plain: plain.clone(),
                    shifted: None,
                },
            );
        }
        if plain.location != 0 {
            continue;
        }
        if plain.key.chars().count() == 1 {
            keys.insert(
                plain.key.clone(),
                Entry {
                    plain,
                    shifted: None,
                },
            );
        }
        if let Some(shifted) = shifted {
            keys.insert(
                shifted.key.clone(),
                Entry {
                    plain: shifted,
                    shifted: None,
                },
            );
        }
    }
    // Higher function keys follow the observed virtual-key sequence. Keep
    // this behavior extension separate from the unchanged public package data.
    for number in 13..=20 {
        let code = format!("F{number}");
        keys.insert(
            code.clone(),
            Entry {
                plain: KeyDescription {
                    token: code.clone(),
                    key: code.clone(),
                    code,
                    key_code: 111 + number,
                    text: String::new(),
                    location: 0,
                },
                shifted: None,
            },
        );
    }
    keys
});

fn description(value: &str, modifiers: u32) -> Option<KeyDescription> {
    let value = if value == "ControlOrMeta" {
        if cfg!(target_os = "macos") {
            "Meta"
        } else {
            "Control"
        }
    } else {
        value
    };
    let entry = KEYS.get(value)?;
    let mut key = if modifiers & 8 != 0 {
        entry.shifted.as_ref().unwrap_or(&entry.plain)
    } else {
        &entry.plain
    }
    .clone();
    key.token = value.into();
    if modifiers & !8 != 0 {
        key.text.clear();
    }
    Some(key)
}

/// Resolve all shortcut keys before dispatching any browser input.
pub(super) fn chord(value: &str) -> Result<Chord, ToolError> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    for character in value.chars() {
        if character == '+' && !token.is_empty() {
            tokens.push(std::mem::take(&mut token));
        } else {
            token.push(character);
        }
    }
    tokens.push(token);
    let mut mask = 0;
    let mut resolved = Vec::with_capacity(tokens.len());
    for token in tokens {
        let key = description(&token, mask)
            .ok_or_else(|| ToolError::Failed(format!("Unknown key: \"{token}\"")))?;
        mask |= key.modifier_mask();
        resolved.push(key);
    }
    let key = resolved
        .pop()
        .expect("shortcut tokenization always produces one main key");
    // `mask` belongs to the prefix. The dispatcher separately adds a main key
    // which itself is a modifier, then removes that bit before its key-up.
    let mask = resolved
        .iter()
        .fold(0, |mask, key| mask | key.modifier_mask());
    Ok(Chord {
        modifiers: resolved,
        key,
        mask,
    })
}

/// Return a layout-backed character; other Unicode uses Chromium text input.
pub(super) fn character(value: char) -> Option<KeyDescription> {
    description(&value.to_string(), 0)
}

/// Resolve a pointer action's modifier set in Playwright's physical press order.
pub(super) fn modifiers(values: &[&str]) -> Result<Vec<KeyDescription>, ToolError> {
    let mut requested = 0;
    for value in values {
        let key = description(value, 0)
            .filter(|key| key.modifier_mask() != 0)
            .ok_or_else(|| ToolError::Failed(format!("Unknown modifier {value}")))?;
        requested |= key.modifier_mask();
    }
    Ok(["Alt", "Control", "Meta", "Shift"]
        .into_iter()
        .filter_map(|value| description(value, 0))
        .filter(|key| requested & key.modifier_mask() != 0)
        .collect())
}

/// Resolve the closed pointer protocol's modifier set without a synthetic key.
pub(super) fn mouse_modifiers(
    values: &[crate::protocol::BrowserKeyboardModifier],
) -> Result<Vec<KeyDescription>, ToolError> {
    use crate::protocol::BrowserKeyboardModifier;

    let names: Vec<_> = values
        .iter()
        .map(|value| match value {
            BrowserKeyboardModifier::Alt => "Alt",
            BrowserKeyboardModifier::Control => "Control",
            BrowserKeyboardModifier::ControlOrMeta => "ControlOrMeta",
            BrowserKeyboardModifier::Meta => "Meta",
            BrowserKeyboardModifier::Shift => "Shift",
        })
        .collect();
    modifiers(&names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_preserve_plus_keys_and_suppress_control_text() {
        let control_plus = chord("Control++").expect("control plus shortcut");
        assert_eq!(control_plus.modifiers[0].code, "ControlLeft");
        assert_eq!(control_plus.modifiers[0].key_code, 17);
        assert_eq!(control_plus.modifiers[0].location, 1);
        assert_eq!(control_plus.key.key, "+");
        assert_eq!(control_plus.key.code, "Equal");
        assert_eq!(control_plus.key.text, "");
        assert_eq!(control_plus.mask, 2);
        assert_eq!(chord("+").expect("plus character").key.text, "+");
    }

    #[test]
    fn physical_codes_apply_shift_but_character_aliases_preserve_their_case() {
        let physical = chord("Shift+KeyA").expect("physical letter shortcut");
        assert_eq!(physical.key.key, "A");
        assert_eq!(physical.key.text, "A");
        assert_eq!(physical.key.code, "KeyA");
        let literal = chord("Shift+a").expect("literal letter shortcut");
        assert_eq!(literal.key.key, "a");
        assert_eq!(literal.key.text, "a");
        let controlled = chord("Control+Shift+KeyA").expect("controlled letter shortcut");
        assert_eq!(controlled.key.key, "A");
        assert!(controlled.key.text.is_empty());
        assert_eq!(controlled.mask, 10);
    }

    #[test]
    fn sided_modifiers_and_keypad_retain_location_and_cdp_virtual_key_codes() {
        let shortcut = chord("ControlRight+ShiftRight+Numpad7").expect("numpad shortcut");
        assert_eq!(shortcut.modifiers[0].location, 2);
        assert_eq!(shortcut.modifiers[0].key_code, 17);
        assert_eq!(shortcut.modifiers[1].location, 2);
        assert_eq!(shortcut.modifiers[1].key_code, 16);
        assert_eq!(shortcut.key.key, "7");
        assert_eq!(shortcut.key.code, "Numpad7");
        assert_eq!(shortcut.key.key_code, 36);
        assert_eq!(shortcut.key.location, 3);
        assert!(shortcut.key.text.is_empty());
        assert_eq!(shortcut.modifiers[1].modifier_mask(), 8);
        assert_eq!(
            chord("Shift").expect("single modifier").key.modifier_mask(),
            8
        );
    }

    #[test]
    fn named_keys_and_unicode_choose_distinct_input_paths() {
        assert_eq!(chord("F12").expect("function key").key.key_code, 123);
        assert_eq!(character('\n').expect("line feed alias").text, "\r");
        assert_eq!(character('A').expect("uppercase letter").code, "KeyA");
        assert_eq!(character('!').expect("shifted punctuation").code, "Digit1");
        assert!(character('中').is_none());
        assert!(character('😀').is_none());
        let error = chord("Control+NotAKey").expect_err("unknown shortcut key");
        assert!(
            matches!(error, ToolError::Failed(ref message) if message == "Unknown key: \"NotAKey\"")
        );
    }

    #[test]
    fn smart_modifiers_resolve_for_the_actual_adapter_platform() {
        let smart = chord("ControlOrMeta+KeyA").expect("smart select-all shortcut");
        let (key, mask) = if cfg!(target_os = "macos") {
            ("Meta", 4)
        } else {
            ("Control", 2)
        };
        assert_eq!(smart.modifiers[0].key, key);
        assert_eq!(smart.mask, mask);
        assert!(smart.key.text.is_empty());
    }

    #[test]
    fn pointer_modifiers_are_a_deduplicated_set_without_a_main_key() {
        assert!(modifiers(&[]).expect("no pointer modifiers").is_empty());
        let keys =
            modifiers(&["Shift", "Control", "Shift"]).expect("deduplicated pointer modifiers");
        assert_eq!(
            keys.iter().map(|key| key.key.as_str()).collect::<Vec<_>>(),
            ["Control", "Shift"]
        );
        assert_eq!(
            keys.iter().fold(0, |mask, key| mask | key.modifier_mask()),
            10
        );
        assert!(matches!(
            modifiers(&["KeyA"]),
            Err(ToolError::Failed(ref message)) if message == "Unknown modifier KeyA"
        ));
    }

    #[test]
    fn shortcut_releases_resolve_the_original_token_after_modifier_changes() {
        let keys = chord("Shift+KeyA+Shift").expect("shortcut with a modifier main key");
        assert_eq!(keys.modifiers[1].key, "A");
        assert_eq!(keys.modifiers[1].for_modifiers(0).key, "a");
        let literal = chord("Shift+A+Shift").expect("literal uppercase shortcut");
        assert_eq!(literal.modifiers[1].for_modifiers(0).key, "A");
    }

    #[test]
    fn higher_function_keys_preserve_their_observed_virtual_key_sequence() {
        for (value, expected) in [("F13", 124), ("F20", 131)] {
            let key = chord(value).expect("observed higher function key").key;
            assert_eq!(key.key, value);
            assert_eq!(key.code, value);
            assert_eq!(key.key_code, expected);
            assert_eq!(key.location, 0);
            assert!(key.text.is_empty());
        }
    }
}
