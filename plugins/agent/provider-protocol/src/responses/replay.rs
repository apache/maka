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

//! Accepted wire item metadata with payloads supplied separately during replay.

use super::{Error, Result};
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Serialize)]
pub struct Replay {
    version: u8,
    fields: Map<String, Value>,
    #[serde(rename = "textField", skip_serializing_if = "Option::is_none")]
    text_field: Option<TextField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parts: Option<Vec<TextPart>>,
    #[serde(skip_serializing_if = "is_false")]
    encrypted: bool,
    #[serde(skip_serializing_if = "is_false")]
    action: bool,
}
fn is_false(value: &bool) -> bool {
    !value
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum TextField {
    Content,
    Summary,
}
impl TextField {
    fn as_str(self) -> &'static str {
        match self {
            Self::Content => "content",
            Self::Summary => "summary",
        }
    }
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum TextKey {
    Text,
    Refusal,
}
impl TextKey {
    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Refusal => "refusal",
        }
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
struct TextPart {
    bytes: usize,
    key: TextKey,
    fields: Map<String, Value>,
}
#[derive(Deserialize)]
struct StoredReplay {
    version: u8,
    fields: Map<String, Value>,
    #[serde(rename = "textField")]
    text_field: Option<TextField>,
    parts: Option<Vec<TextPart>>,
    #[serde(default)]
    encrypted: bool,
    #[serde(default)]
    action: bool,
}
impl<'de> Deserialize<'de> for Replay {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let stored = StoredReplay::deserialize(deserializer)?;
        let kind = stored.fields.get("type").and_then(Value::as_str);
        if stored.version != 1
            || !matches!(
                kind,
                Some(
                    "message"
                        | "reasoning"
                        | "function_call"
                        | "custom_tool_call"
                        | "web_search_call"
                )
            )
            || stored.text_field.is_some() != stored.parts.is_some()
            || stored.encrypted && kind != Some("reasoning")
            || stored.action && kind != Some("web_search_call")
            || matches!(stored.text_field, Some(TextField::Content)) && kind != Some("message")
            || matches!(stored.text_field, Some(TextField::Summary)) && kind != Some("reasoning")
        {
            return Err(D::Error::custom("invalid accepted Responses item metadata"));
        }
        Ok(Self {
            version: 1,
            fields: stored.fields,
            text_field: stored.text_field,
            parts: stored.parts,
            encrypted: stored.encrypted,
            action: stored.action,
        })
    }
}

pub fn capture(item: &Value) -> Option<Replay> {
    let object = item.as_object()?;
    let kind = item["type"].as_str()?;
    let field = match kind {
        "message" => Some(TextField::Content),
        "reasoning" => Some(TextField::Summary),
        "function_call" | "custom_tool_call" | "web_search_call" => None,
        _ => return None,
    };
    let fields = object
        .iter()
        .filter(|(key, _)| {
            field.is_none_or(|field| key.as_str() != field.as_str())
                && !matches!(
                    (kind, key.as_str()),
                    ("reasoning", "encrypted_content")
                        | ("function_call", "arguments")
                        | ("custom_tool_call", "input")
                        | ("web_search_call", "action")
                )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let mut text_field = None;
    let mut parts = None;
    if let Some(field) = field
        && let Some(values) = object.get(field.as_str())
    {
        let mut captured = Vec::new();
        for value in values.as_array()? {
            let object = value.as_object()?;
            let key = if value["type"] == "refusal" && object.contains_key("refusal") {
                TextKey::Refusal
            } else {
                TextKey::Text
            };
            let text = value[key.as_str()].as_str()?;
            let fields = object
                .iter()
                .filter(|(name, _)| name.as_str() != key.as_str())
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            captured.push(TextPart {
                bytes: text.len(),
                key,
                fields,
            });
        }
        text_field = Some(field);
        parts = Some(captured);
    }
    Some(Replay {
        version: 1,
        fields,
        text_field,
        parts,
        encrypted: kind == "reasoning" && object.contains_key("encrypted_content"),
        action: kind == "web_search_call" && object.contains_key("action"),
    })
}
impl Replay {
    pub fn from_value(value: Value) -> Result<Self> {
        serde_json::from_value(value).map_err(|error| {
            Error::Invalid(format!("invalid accepted Responses item metadata: {error}"))
        })
    }
    pub fn text(&self, text: &str, kind: &str, encrypted_content: Option<&str>) -> Result<Value> {
        if self.fields.get("type").and_then(Value::as_str) != Some(kind) {
            return Err(Error::Invalid(
                "accepted Responses item kind changed".into(),
            ));
        }
        let mut item = Value::Object(self.fields.clone());
        if let Some(field) = self.text_field {
            let mut offset = 0usize;
            let parts = self
                .parts
                .as_deref()
                .expect("text replay includes its boundaries");
            let mut content = Vec::with_capacity(parts.len());
            for part in parts {
                let end = offset.checked_add(part.bytes).ok_or_else(|| {
                    Error::Invalid("accepted Responses text length overflow".into())
                })?;
                let value = text.get(offset..end).ok_or_else(|| {
                    Error::Invalid(
                        "accepted Responses text no longer matches its boundaries".into(),
                    )
                })?;
                let mut fields = part.fields.clone();
                fields.insert(part.key.as_str().into(), Value::String(value.into()));
                content.push(Value::Object(fields));
                offset = end;
            }
            if offset != text.len() {
                return Err(Error::Invalid(
                    "accepted Responses text no longer matches its boundaries".into(),
                ));
            }
            item[field.as_str()] = Value::Array(content);
        } else if !text.is_empty() {
            return Err(Error::Invalid(
                "accepted Responses item omitted its text".into(),
            ));
        }
        if self.encrypted {
            item["encrypted_content"] = json!(encrypted_content);
        }
        Ok(item)
    }
    pub fn call(&self, kind: &str, call_id: &str, name: &str, payload: &str) -> Result<Value> {
        if self.fields.get("type").and_then(Value::as_str) != Some(kind) {
            return Err(Error::Invalid(
                "accepted Responses call kind changed".into(),
            ));
        }
        let mut item = Value::Object(self.fields.clone());
        item["call_id"] = json!(call_id);
        item["name"] = json!(name);
        item[if kind == "custom_tool_call" {
            "input"
        } else {
            "arguments"
        }] = json!(payload);
        Ok(item)
    }
    pub fn provider(&self, action: &Value) -> Result<Value> {
        if self.fields.get("type").and_then(Value::as_str) != Some("web_search_call") {
            return Err(Error::Invalid(
                "invalid accepted Responses provider item".into(),
            ));
        }
        let mut item = Value::Object(self.fields.clone());
        if self.action {
            item["action"] = action.clone();
        }
        Ok(item)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_text_metadata_preserves_parts_without_copying_payload() {
        let original = json!({"type":"message","id":"msg","role":"assistant","status":"completed","phase":"commentary",
            "content":[{"type":"output_text","text":"First 😀","annotations":[{"type":"url_citation","url":"https://example.test/","start_index":0,"end_index":5}]},
                {"type":"output_text","text":"第二部分","annotations":[],"logprobs":null}]});
        let template = capture(&original).unwrap();
        let serialized = serde_json::to_string(&template).unwrap();
        assert!(!serialized.contains("First"));
        assert!(!serialized.contains("第二部分"));
        let parsed: Replay = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            parsed.text("First 😀第二部分", "message", None).unwrap(),
            original
        );
        assert!(parsed.text("changed", "message", None).is_err());
        let mut invalid: Value = serde_json::from_str(&serialized).unwrap();
        invalid["version"] = json!(2);
        assert!(serde_json::from_value::<Replay>(invalid).is_err());
    }

    #[test]
    fn reasoning_and_calls_restore_exact_accepted_fields() {
        let reasoning = json!({"type":"reasoning","id":"reason","encrypted_content":"opaque",
            "summary":[{"type":"summary_text","text":"Check 😀"},{"type":"summary_text","text":""}]});
        let template = capture(&reasoning).unwrap();
        let serialized = serde_json::to_string(&template).unwrap();
        assert!(!serialized.contains("opaque"));
        assert!(!serialized.contains("Check"));
        assert_eq!(
            template
                .text("Check 😀", "reasoning", Some("opaque"))
                .unwrap(),
            reasoning
        );
        let original = json!({"type":"function_call","id":"fc","call_id":"call","name":"read","arguments":" {\"n\":\n","status":"completed"});
        let replay = capture(&original).unwrap();
        assert_eq!(
            replay
                .call("function_call", "call", "read", " {\"n\":\n")
                .unwrap(),
            original
        );
    }
}
