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

use super::{InputAction, MouseButton, MouseEvent, ScrollDirection};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

impl Serialize for InputAction {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = match self {
            Self::Text(text) => json!({"type":"text","text":text}),
            Self::Paste(text) => json!({"type":"paste","text":text}),
            Self::Key {
                key,
                modifiers: keys,
            } => json!({"type":"key","key":key.name(),"modifiers":keys}),
            Self::Mouse(mouse) => {
                let (event, button, direction) = match mouse.event {
                    MouseEvent::Click(button) => ("click", Some(button), None),
                    MouseEvent::Press(button) => ("press", Some(button), None),
                    MouseEvent::Release(button) => ("release", Some(button), None),
                    MouseEvent::Move(button) => ("move", button, None),
                    MouseEvent::Scroll(direction) => ("scroll", None, Some(direction)),
                };
                let mut value = json!({"type":"mouse","event":event,"x":mouse.x,"y":mouse.y,"modifiers":mouse.modifiers});
                if let Some(button) = button {
                    value["button"] = json!(match button {
                        MouseButton::Left => "left",
                        MouseButton::Middle => "middle",
                        MouseButton::Right => "right",
                    });
                }
                if let Some(direction) = direction {
                    value["direction"] = json!(match direction {
                        ScrollDirection::Up => "up",
                        ScrollDirection::Down => "down",
                    });
                }
                value
            }
        };
        value.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for InputAction {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::parse(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}
