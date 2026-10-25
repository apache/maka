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

//! Declarative command scopes. Native editing gets first refusal; the nearest
//! matching scope owns an unconsumed chord, including when disabled.
//! 声明式快捷键作用域；原生编辑优先，最近的声明独占尚未消费的按键。
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Shortcut {
    #[schemars(regex(
        pattern = "^([a-z0-9]|escape|enter|tab|delete|space|up|down|left|right|home|end|pageup|pagedown|f([1-9]|1[0-2]))$"
    ))]
    pub key: String,
    #[schemars(length(max = 4))]
    pub modifiers: Vec<Modifier>,
    #[schemars(length(min = 1))]
    pub input: String,
    pub enabled: bool,
}
/// Route navigation yielded by a native editor to a declared child component.
/// Ordinary unhandled button keys do not activate this binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FocusShortcut {
    pub key: String,
    pub modifiers: Vec<Modifier>,
    pub child: String,
    pub enabled: bool,
}
impl FocusShortcut {
    pub fn matches(&self, key: &str, modifiers: Modifiers) -> bool {
        self.key == key && physical(&self.modifiers, false) == modifiers
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Modifier {
    Control,
    Primary,
    Alt,
    Shift,
    Super,
}
/// Physical modifiers after the presenter resolves Primary.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Modifiers {
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
    pub super_key: bool,
}
impl Shortcut {
    pub fn physical(&self, primary_is_super: bool) -> Modifiers {
        physical(&self.modifiers, primary_is_super)
    }
    pub fn matches(&self, key: &str, modifiers: Modifiers, primary_is_super: bool) -> bool {
        self.key == key && self.physical(primary_is_super) == modifiers
    }
}
fn physical(modifiers: &[Modifier], primary_is_super: bool) -> Modifiers {
    let mut result = Modifiers::default();
    for modifier in modifiers {
        match modifier {
            Modifier::Control => result.control = true,
            Modifier::Primary if primary_is_super => result.super_key = true,
            Modifier::Primary => result.control = true,
            Modifier::Alt => result.alt = true,
            Modifier::Shift => result.shift = true,
            Modifier::Super => result.super_key = true,
        }
    }
    result
}
pub fn validate(shortcuts: &[Shortcut], primary_is_super: bool) -> Result<(), String> {
    validate_chords(
        shortcuts
            .iter()
            .map(|s| (s.key.as_str(), s.modifiers.as_slice(), s.input.as_str())),
        primary_is_super,
    )
}
pub fn validate_focus(shortcuts: &[Shortcut], focus: &[FocusShortcut]) -> Result<(), String> {
    validate_chords(
        shortcuts
            .iter()
            .map(|s| (s.key.as_str(), s.modifiers.as_slice(), s.input.as_str()))
            .chain(
                focus
                    .iter()
                    .map(|s| (s.key.as_str(), s.modifiers.as_slice(), s.child.as_str())),
            ),
        false,
    )
}
fn validate_chords<'a>(
    bindings: impl IntoIterator<Item = (&'a str, &'a [Modifier], &'a str)>,
    primary_is_super: bool,
) -> Result<(), String> {
    let mut chords = BTreeSet::new();
    for (key, modifiers, target) in bindings {
        let printable = key == "space"
            || key.len() == 1
                && key
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        let named = matches!(
            key,
            "escape"
                | "enter"
                | "tab"
                | "delete"
                | "space"
                | "up"
                | "down"
                | "left"
                | "right"
                | "home"
                | "end"
                | "pageup"
                | "pagedown"
        ) || key
            .strip_prefix('f')
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| (1..=12).contains(&n) && key == format!("f{n}"));
        let physical = physical(modifiers, primary_is_super);
        let unique_modifiers = modifiers
            .iter()
            .enumerate()
            .all(|(i, m)| !modifiers[..i].contains(m));
        if (!printable && !named)
            || target.is_empty()
            || modifiers.len() > 4
            || !unique_modifiers
            || (printable && !physical.control && !physical.alt && !physical.super_key)
            || !chords.insert((key, physical))
        {
            return Err("invalid or duplicate shortcut chord".into());
        }
    }
    Ok(())
}
/// Merge command inputs with ordinary buttons, never with a typed native input.
/// The input table is derived from the finite scene declaration.
pub fn inputs(
    shortcuts: &[Shortcut],
    inputs: &mut BTreeMap<String, serde_json::Value>,
) -> Result<(), String> {
    for shortcut in shortcuts.iter().filter(|shortcut| shortcut.enabled) {
        if let Some(schema) = inputs.get(&shortcut.input)
            && schema != &serde_json::Value::Bool(true)
        {
            return Err("shortcut collides with typed native input".into());
        }
        inputs.insert(shortcut.input.clone(), serde_json::Value::Bool(true));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn shortcut(key: &str, modifiers: Vec<Modifier>) -> Shortcut {
        Shortcut {
            key: key.into(),
            modifiers,
            input: "command".into(),
            enabled: true,
        }
    }
    #[test]
    fn physical_chords_are_unambiguous_and_leave_typing_native() {
        assert!(validate(&[shortcut("b", vec![])], false).is_err());
        assert!(validate(&[shortcut("b", vec![Modifier::Shift])], false).is_err());
        let primary = shortcut("b", vec![Modifier::Primary]);
        let control = shortcut("b", vec![Modifier::Control]);
        assert!(validate(&[primary.clone(), control.clone()], false).is_err());
        assert!(validate(&[primary, control], true).is_ok());
        assert!(validate(&[shortcut("escape", vec![])], false).is_ok());
        assert!(validate(&[shortcut("space", vec![])], false).is_err());
        assert!(validate(&[shortcut("f01", vec![])], false).is_err());
        assert!(
            validate(
                &[shortcut("b", vec![Modifier::Control, Modifier::Control])],
                false
            )
            .is_err()
        );
    }
}
