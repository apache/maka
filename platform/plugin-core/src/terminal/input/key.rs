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

use super::InputError;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize)]
#[serde(try_from = "Vec<Modifier>")]
pub struct Modifiers(u8);

impl TryFrom<Vec<Modifier>> for Modifiers {
    type Error = InputError;
    fn try_from(values: Vec<Modifier>) -> Result<Self, Self::Error> {
        let mut result = Self::default();
        for value in values {
            let bit = match value {
                Modifier::Shift => 1,
                Modifier::Alt => 2,
                Modifier::Ctrl => 4,
            };
            if result.0 & bit != 0 {
                return Err(InputError("modifiers must be unique"));
            }
            result.0 |= bit;
        }
        Ok(result)
    }
}

impl Modifiers {
    pub(super) fn bits(self) -> u8 {
        self.0
    }
}

impl Serialize for Modifiers {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        [
            (4, Modifier::Ctrl),
            (2, Modifier::Alt),
            (1, Modifier::Shift),
        ]
        .into_iter()
        .filter_map(|(bit, modifier)| (self.0 & bit != 0).then_some(modifier))
        .collect::<Vec<_>>()
        .serialize(serializer)
    }
}
impl JsonSchema for Modifiers {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "TerminalModifiers".into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = Vec::<Modifier>::json_schema(generator);
        schema.insert("uniqueItems".into(), true.into());
        schema.insert("maxItems".into(), 3.into());
        schema
    }
}

/// Named keys are classified by their terminal encoding, not kept as arbitrary strings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Key(Encoding);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Encoding {
    Character(u8),
    Byte(u8),
    Cursor(char),
    Tilde(u8),
    Function(char),
}

impl Key {
    pub fn parse(name: &str) -> Result<Self, InputError> {
        let encoding = match name {
            "enter" => Encoding::Byte(b'\r'),
            "escape" => Encoding::Byte(27),
            "tab" => Encoding::Byte(b'\t'),
            "backspace" => Encoding::Byte(127),
            "arrow_up" => Encoding::Cursor('A'),
            "arrow_down" => Encoding::Cursor('B'),
            "arrow_right" => Encoding::Cursor('C'),
            "arrow_left" => Encoding::Cursor('D'),
            "home" => Encoding::Cursor('H'),
            "end" => Encoding::Cursor('F'),
            "insert" => Encoding::Tilde(2),
            "delete" => Encoding::Tilde(3),
            "page_up" => Encoding::Tilde(5),
            "page_down" => Encoding::Tilde(6),
            "f1" => Encoding::Function('P'),
            "f2" => Encoding::Function('Q'),
            "f3" => Encoding::Function('R'),
            "f4" => Encoding::Function('S'),
            "f5" => Encoding::Tilde(15),
            "f6" => Encoding::Tilde(17),
            "f7" => Encoding::Tilde(18),
            "f8" => Encoding::Tilde(19),
            "f9" => Encoding::Tilde(20),
            "f10" => Encoding::Tilde(21),
            "f11" => Encoding::Tilde(23),
            "f12" => Encoding::Tilde(24),
            _ if name.len() == 1 && (32..=126).contains(&name.as_bytes()[0]) => {
                Encoding::Character(name.as_bytes()[0])
            }
            _ => {
                return Err(InputError(
                    "unsupported key; expected a named key or printable ASCII",
                ));
            }
        };
        Ok(Self(encoding))
    }

    pub(super) fn name(self) -> String {
        if let Encoding::Character(byte) = self.0 {
            return char::from(byte).to_string();
        }
        // Every non-character encoding has exactly one canonical named key.
        [
            "enter",
            "escape",
            "tab",
            "backspace",
            "arrow_up",
            "arrow_down",
            "arrow_right",
            "arrow_left",
            "home",
            "end",
            "insert",
            "delete",
            "page_up",
            "page_down",
            "f1",
            "f2",
            "f3",
            "f4",
            "f5",
            "f6",
            "f7",
            "f8",
            "f9",
            "f10",
            "f11",
            "f12",
        ]
        .into_iter()
        .find(|name| Self::parse(name) == Ok(self))
        .expect("closed key encoding has a name")
        .to_owned()
    }

    pub(super) fn encode(
        self,
        modifiers: Modifiers,
        application: bool,
    ) -> Result<String, InputError> {
        let bits = modifiers.bits();
        let parameter = 1 + bits;
        Ok(match self.0 {
            Encoding::Character(mut byte) => {
                if bits & 1 != 0 {
                    return Err(InputError("send the shifted character directly"));
                }
                if bits & 4 != 0 {
                    byte = match byte {
                        b' ' | b'@' => 0,
                        b'A'..=b'Z' | b'a'..=b'z' | b'['..=b'_' => byte & 31,
                        b'?' => 127,
                        _ => return Err(InputError("character has no portable Ctrl encoding")),
                    };
                }
                let prefix = if bits & 2 != 0 { "\x1b" } else { "" };
                format!("{prefix}{}", char::from(byte))
            }
            Encoding::Byte(byte) if bits == 0 => char::from(byte).to_string(),
            Encoding::Byte(b'\t') if bits == 1 => "\x1b[Z".into(),
            Encoding::Byte(_) => return Err(InputError("key does not support these modifiers")),
            Encoding::Cursor(final_char) if bits == 0 => {
                format!("\x1b{}{final_char}", if application { 'O' } else { '[' })
            }
            Encoding::Function(final_char) if bits == 0 => format!("\x1bO{final_char}"),
            Encoding::Cursor(final_char) | Encoding::Function(final_char) => {
                format!("\x1b[1;{parameter}{final_char}")
            }
            Encoding::Tilde(number) if bits == 0 => format!("\x1b[{number}~"),
            Encoding::Tilde(number) => format!("\x1b[{number};{parameter}~"),
        })
    }
}
