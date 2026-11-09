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

use super::request::parse_ref;
use crate::shell::ControlInput;
use maka_agent_facts::tools::ToolError;
use maka_plugin_core::terminal::TerminalSize;
use maka_plugin_core::terminal::input::InputAction;
use maka_plugin_core::terminal::input::encoded_actions_byte_len;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};

pub const NAME: &str = "WriteStdin";

pub fn schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["ref"],
    "properties":{
      "ref":{"type":"string"},
      "input":{"type":"string","description":"Raw terminal input, exclusive with actions."},
      "actions":{"type":["array","null"],"items":{
        "type":"object","additionalProperties":false,"required":["type"],
        "properties":{
          "type":{"enum":["text","key","mouse"]},
          "text":{"type":["string","number","null"]},
          "key":{"type":["string","number","null"]},
          "event":{"type":["string","number","null"]},
          "x":{"type":["number","string","null"]},
          "y":{"type":["number","string","null"]},
          "button":{"type":["string","number","null"]},
          "direction":{"type":["string","number","null"]},
          "modifiers":{"type":["array","null"],"items":{"enum":["ctrl","alt","shift"]}}
        }
      }},
      "size":{"type":["object","null"],"additionalProperties":false,
        "properties":{"cols":{"type":["number","null"]},"rows":{"type":["number","null"]}}}
    }})
}

pub struct Input {
    pub reference: String,
    pub data: ControlInput,
    pub size: Option<TerminalSize>,
    pub bytes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fields {
    #[serde(rename = "ref")]
    reference: String,
    #[serde(default, deserialize_with = "present")]
    input: Option<String>,
    #[serde(default, deserialize_with = "present")]
    actions: Option<Vec<Value>>,
    #[serde(default, deserialize_with = "size")]
    size: Option<TerminalSize>,
}

impl Input {
    pub fn parse(mut value: Value) -> Result<Self, ToolError> {
        if let Some(fields) = value.as_object_mut() {
            if fields
                .get("actions")
                .is_some_and(|v| v.is_null() || v.as_array().is_some_and(Vec::is_empty))
            {
                fields.remove("actions");
            } else if let Some(actions) = fields.get_mut("actions").and_then(Value::as_array_mut) {
                for action in actions {
                    normalize_action(action);
                }
            }
            if fields.get("size").is_some_and(|v| {
                v.is_null()
                    || v.as_object().is_some_and(|size| {
                        size.iter().all(|(key, value)| {
                            matches!(key.as_str(), "cols" | "rows")
                                && (value.is_null() || value.as_f64() == Some(0.0))
                        })
                    })
            }) {
                fields.remove("size");
            }
        }
        let fields: Fields = serde_json::from_value(value).map_err(failed)?;
        if parse_ref(&fields.reference).is_none() {
            return Err(failed("Invalid background task ref"));
        }
        let (data, bytes) = match (fields.input, fields.actions) {
            (Some(_), Some(_)) => {
                return Err(failed(
                    "raw input and terminal actions are mutually exclusive",
                ));
            }
            (Some(text), None) => {
                if text.is_empty() {
                    return Err(failed("input must contain UTF-8 bytes"));
                }
                let bytes = text.len();
                (ControlInput::Raw(text), Some(bytes))
            }
            (None, Some(actions)) => {
                let actions = actions
                    .into_iter()
                    .map(InputAction::parse)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(failed)?;
                let bytes = encoded_actions_byte_len(&actions).map_err(failed)?;
                (ControlInput::Actions(actions), Some(bytes))
            }
            (None, None) if fields.size.is_some() => (ControlInput::Raw(String::new()), None),
            (None, None) => return Err(failed("input, actions, and/or size is required")),
        };
        Ok(Self {
            reference: fields.reference,
            data,
            size: fields.size,
            bytes,
        })
    }
}

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(de: D) -> Result<Option<T>, D::Error> {
    T::deserialize(de).map(Some)
}

fn size<'de, D: Deserializer<'de>>(de: D) -> Result<Option<TerminalSize>, D::Error> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Size {
        cols: f64,
        rows: f64,
    }
    let Size { cols, rows } = Size::deserialize(de)?;
    // JSON numbers have no integer/float distinction in the original model API.
    if [cols, rows]
        .into_iter()
        .any(|v| v.fract() != 0.0 || !(0.0..=f64::from(u16::MAX)).contains(&v))
    {
        return Err(serde::de::Error::custom(
            "terminal size requires bounded integers",
        ));
    }
    TerminalSize::new(cols as u16, rows as u16)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

fn normalize_action(value: &mut Value) {
    let Some(fields) = value.as_object_mut() else {
        return;
    };
    match fields.get("type").and_then(Value::as_str) {
        Some("text") => {
            if fields
                .get("key")
                .is_some_and(|v| v.is_null() || v.as_str() == Some(""))
            {
                fields.remove("key");
            }
            remove_defaults(fields, &["event", "x", "y", "button", "direction"]);
        }
        Some("key") => {
            if fields
                .get("text")
                .is_some_and(|v| v.is_null() || v.as_str() == Some(""))
            {
                fields.remove("text");
            }
            remove_defaults(fields, &["event", "x", "y", "button", "direction"]);
        }
        Some("mouse") => {
            remove_defaults(fields, &["text", "key"]);
            if fields.get("event").and_then(Value::as_str) == Some("scroll") {
                remove_defaults(fields, &["button"]);
            } else {
                remove_defaults(fields, &["direction"]);
            }
        }
        _ => {}
    }
    if fields
        .get("modifiers")
        .is_some_and(|v| v.is_null() || v.as_array().is_some_and(Vec::is_empty))
    {
        fields.remove("modifiers");
    }
}

fn remove_defaults(fields: &mut Map<String, Value>, names: &[&str]) {
    for name in names {
        if fields
            .get(*name)
            .is_some_and(|v| v.is_null() || v.as_str() == Some("") || v.as_f64() == Some(0.0))
        {
            fields.remove(*name);
        }
    }
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_defaults_do_not_weaken_input_validation_or_numeric_size_parity() {
        let reference = "maka://runtime/background-tasks/task";
        let parse = |mut value: Value| {
            value["ref"] = json!(reference);
            Input::parse(value)
        };
        let parsed = parse(json!({
            "actions":[
                {"type":"text","text":"中文😀","key":"","x":0,"event":null,"modifiers":[]},
                {"type":"key","key":"enter","text":"","direction":0,"modifiers":null}
            ],
            "size":{"cols":1e2,"rows":30.0}
        }))
        .unwrap();
        assert_eq!(parsed.size, Some(TerminalSize::new(100, 30).unwrap()));
        assert_eq!(parsed.bytes, Some(11));
        assert!(matches!(parsed.data, ControlInput::Actions(actions) if actions.len() == 2));
        assert_eq!(
            parse(json!({"input":"\r","actions":[],"size":{"cols":0,"rows":null}}))
                .unwrap()
                .bytes,
            Some(1)
        );
        for value in [
            json!({"input":null,"size":{"cols":80,"rows":24}}),
            json!({"input":"","size":{"cols":80,"rows":24}}),
            json!({"input":"raw","actions":[{"type":"key","key":"enter"}]}),
            json!({"actions":[{"type":"text","text":"ok","key":0}]}),
            json!({"actions":[{"type":"text","text":"\u{1b}"}]}),
            json!({"actions":[{"type":"key","key":"enter","extra":null}]}),
            json!({"actions":[],"size":{"cols":0,"rows":0}}),
            json!({"size":{"cols":80.5,"rows":24}}),
            json!({"size":{"cols":80,"rows":1025}}),
            json!({"size":{"cols":1024,"rows":65}}),
            json!({"size":{"cols":80,"rows":24,"extra":0}}),
        ] {
            assert!(parse(value.clone()).is_err(), "{value}");
        }
    }
}
