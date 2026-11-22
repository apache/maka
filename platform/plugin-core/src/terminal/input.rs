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

mod key;
mod mouse;
mod wire;

pub use key::{Key, Modifier, Modifiers};
pub use mouse::{MouseAction, MouseButton, MouseEvent, ScrollDirection};

use super::{TerminalInputModes, TerminalSize};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("terminal input rejected: {0}")]
pub struct InputError(pub &'static str);

#[derive(Clone, Debug, Eq, PartialEq, JsonSchema)]
#[schemars(with = "RawAction", rename = "TerminalInputAction")]
pub enum InputAction {
    Text(String),
    Paste(String),
    Key { key: Key, modifiers: Modifiers },
    Mouse(MouseAction),
}

impl InputAction {
    /// Strict client/tool boundary. Provider-default normalization, when needed,
    /// belongs to the provider adapter, never to this decoder.
    pub fn parse(value: Value) -> Result<Self, InputError> {
        let raw: RawAction = serde_json::from_value(value)
            .map_err(|_| InputError("invalid action fields or values"))?;
        let action = match raw {
            RawAction::Text { text } => {
                if text.is_empty()
                    || text
                        .chars()
                        .any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
                {
                    return Err(InputError(
                        "text must be nonempty and contain no terminal controls",
                    ));
                }
                Self::Text(text)
            }
            RawAction::Paste { text } => {
                validate_paste(&text)?;
                Self::Paste(text)
            }
            RawAction::Key { key, modifiers } => {
                let key = Key::parse(&key)?;
                // Reject unsupported combinations independently of live mode.
                key.encode(modifiers, false)?;
                Self::Key { key, modifiers }
            }
            RawAction::Mouse {
                event,
                x,
                y,
                button,
                direction,
                modifiers,
            } => Self::Mouse(MouseAction::new(event, x, y, button, direction, modifiers)?),
        };
        Ok(action)
    }
}

/// Encodes the entire batch before the caller can perform any native effect.
/// The caller supplies modes and size from one serialized screen cut.
pub fn encode_actions(
    actions: &[InputAction],
    modes: TerminalInputModes,
    size: TerminalSize,
) -> Result<String, InputError> {
    encode_actions_with_paste(actions, modes, size, false)
}

/// Paste framing is read from the same native parser cut as keyboard modes.
pub fn encode_actions_with_paste(
    actions: &[InputAction],
    modes: TerminalInputModes,
    size: TerminalSize,
    bracketed_paste: bool,
) -> Result<String, InputError> {
    if actions.is_empty() {
        return Err(InputError("expected at least one input action"));
    }
    let mut output = String::new();
    for action in actions {
        let encoded = match action {
            InputAction::Text(text) => {
                if text.is_empty()
                    || text
                        .chars()
                        .any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
                {
                    return Err(InputError(
                        "text must be nonempty and contain no terminal controls",
                    ));
                }
                output.push_str(text);
                continue;
            }
            InputAction::Paste(text) => {
                validate_paste(text)?;
                let text = text.replace("\r\n", "\n").replace('\r', "\n");
                if bracketed_paste {
                    format!("\x1b[200~{text}\x1b[201~")
                } else {
                    text.replace('\n', "\r")
                }
            }
            InputAction::Key { key, modifiers } => {
                key.encode(*modifiers, modes.application_cursor_keys_mode)?
            }
            InputAction::Mouse(mouse) => mouse.encode(modes, size)?,
        };
        output.push_str(&encoded);
    }
    Ok(output)
}

/// Canonical requested byte count, independent of live modes or terminal size.
/// Admission still encodes again against the actual worker cut before effects.
pub fn encoded_actions_byte_len(actions: &[InputAction]) -> Result<usize, InputError> {
    if actions.is_empty() {
        return Err(InputError("expected at least one input action"));
    }
    let mut length = 0usize;
    for action in actions {
        let bytes = match action {
            InputAction::Text(text) => {
                if text.is_empty()
                    || text
                        .chars()
                        .any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
                {
                    return Err(InputError(
                        "text must be nonempty and contain no terminal controls",
                    ));
                }
                text.len()
            }
            InputAction::Paste(text) => {
                validate_paste(text)?;
                text.len()
                    .checked_add(12)
                    .ok_or(InputError("input length overflow"))?
            }
            InputAction::Key { key, modifiers } => key.encode(*modifiers, false)?.len(),
            InputAction::Mouse(mouse) => mouse.encode_sgr().len(),
        };
        length = length
            .checked_add(bytes)
            .ok_or(InputError("input length overflow"))?;
    }
    Ok(length)
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum RawAction {
    Text {
        #[schemars(length(min = 1), regex(pattern = "^[^\\x00-\\x1f\\x7f-\\x9f]+$"))]
        text: String,
    },
    Paste {
        #[schemars(
            length(min = 1),
            regex(pattern = "^[^\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]+$")
        )]
        text: String,
    },
    Key {
        #[schemars(regex(
            pattern = "^(?:[ -~]|enter|escape|tab|backspace|arrow_(?:up|down|left|right)|home|end|insert|delete|page_(?:up|down)|f(?:[1-9]|1[0-2]))$"
        ))]
        key: String,
        #[serde(default)]
        modifiers: Modifiers,
    },
    Mouse {
        event: mouse::RawEvent,
        #[serde(deserialize_with = "coordinate")]
        #[schemars(range(max = 9007199254740991u64))]
        x: u64,
        #[serde(deserialize_with = "coordinate")]
        #[schemars(range(max = 9007199254740991u64))]
        y: u64,
        #[serde(default, deserialize_with = "present")]
        #[schemars(with = "MouseButton")]
        button: Option<MouseButton>,
        #[serde(default, deserialize_with = "present")]
        #[schemars(with = "ScrollDirection")]
        direction: Option<ScrollDirection>,
        #[serde(default)]
        modifiers: Modifiers,
    },
}

// Missing is allowed; explicit null is not part of the strict wire contract.
fn present<'de, D, T>(de: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(de).map(Some)
}

fn coordinate<'de, D: serde::Deserializer<'de>>(de: D) -> Result<u64, D::Error> {
    let value = f64::deserialize(de)?;
    if !(0.0..=9_007_199_254_740_991.0).contains(&value) || value.fract() != 0.0 {
        return Err(serde::de::Error::custom(
            "expected a non-negative safe integer",
        ));
    }
    Ok(value as u64)
}

fn validate_paste(text: &str) -> Result<(), InputError> {
    if text.is_empty()
        || text
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(InputError(
            "paste must be nonempty and contain no terminal controls except whitespace",
        ));
    }
    Ok(())
}

/// Pointer events from an attached human terminal may race native mode/size changes.
/// Only those explicit unsupported pointer events are ignored; other input stays strict.
pub fn encode_controller_actions(
    actions: &[InputAction],
    modes: TerminalInputModes,
    size: TerminalSize,
    bracketed_paste: bool,
) -> Result<String, InputError> {
    encoded_actions_byte_len(actions)?;
    let applicable: Vec<_> = actions
        .iter()
        .filter(
            |action| !matches!(action, InputAction::Mouse(mouse) if !mouse.applicable(modes, size)),
        )
        .cloned()
        .collect();
    if applicable.is_empty() {
        return Ok(String::new());
    }
    encode_actions_with_paste(&applicable, modes, size, bracketed_paste)
}
