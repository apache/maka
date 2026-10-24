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

//! Lossless accepted-item metadata without another copy of canonical text.
//!
//! A template retains item fields and content-part boundaries; text and tool
//! payloads are supplied by the canonical ModelPart when replayed.
use crate::{Error, Result};
use serde_json::{Map, Value, json};

pub(crate) fn capture(item: &Value) -> Option<Value> {
    let object = item.as_object()?;
    let kind = item["type"].as_str()?;
    let field = match kind {
        "message" => Some("content"),
        "reasoning" => Some("summary"),
        "function_call" | "custom_tool_call" | "web_search_call" => None,
        _ => return None,
    };
    let mut fields = Map::new();
    for (key, value) in object {
        if Some(key.as_str()) != field
            && !matches!(
                (kind, key.as_str()),
                ("reasoning", "encrypted_content")
                    | ("function_call", "arguments")
                    | ("custom_tool_call", "input")
                    | ("web_search_call", "action")
            )
        {
            fields.insert(key.clone(), value.clone());
        }
    }
    let mut template = json!({"version":1,"fields":fields});
    if let Some(field) = field {
        let mut parts = Vec::new();
        if let Some(values) = object.get(field) {
            for value in values.as_array()? {
                let object = value.as_object()?;
                let text_key = if value["type"] == "refusal" && object.contains_key("refusal") {
                    "refusal"
                } else {
                    "text"
                };
                let text = value[text_key].as_str()?;
                let fields: Map<_, _> = object
                    .iter()
                    .filter(|(key, _)| key.as_str() != text_key)
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
                parts.push(json!({"bytes":text.len(),"key":text_key,"fields":fields}));
            }
            template["textField"] = json!(field);
            template["parts"] = json!(parts);
        }
    }
    if kind == "reasoning" && object.contains_key("encrypted_content") {
        template["encrypted"] = json!(true);
    }
    if kind == "web_search_call" && object.contains_key("action") {
        template["action"] = json!(true);
    }
    Some(template)
}

fn template(options: &Option<Value>) -> Result<Option<&Value>> {
    let Some(template) = options
        .as_ref()
        .and_then(|options| options["openai"].get("responsesReplay"))
    else {
        return Ok(None);
    };
    if template["version"] != 1 || !template["fields"].is_object() {
        return Err(Error::Invalid(
            "invalid accepted Responses item metadata".into(),
        ));
    }
    Ok(Some(template))
}
pub(crate) fn text(options: &Option<Value>, text: &str, kind: &str) -> Result<Option<Value>> {
    let Some(template) = template(options)? else {
        return Ok(None);
    };
    if template["fields"]["type"] != kind {
        return Err(Error::Invalid(
            "accepted Responses item kind changed".into(),
        ));
    }
    let mut item = template["fields"].clone();
    if let Some(field) = template["textField"].as_str() {
        let expected = if kind == "message" {
            "content"
        } else {
            "summary"
        };
        if field != expected {
            return Err(Error::Invalid(
                "invalid accepted Responses text field".into(),
            ));
        }
        let parts = template["parts"]
            .as_array()
            .ok_or_else(|| Error::Invalid("invalid accepted Responses text parts".into()))?;
        let mut offset: usize = 0;
        let mut content = Vec::with_capacity(parts.len());
        for part in parts {
            let length = part["bytes"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| Error::Invalid("invalid accepted Responses text length".into()))?;
            let end = offset
                .checked_add(length)
                .ok_or_else(|| Error::Invalid("accepted Responses text length overflow".into()))?;
            let value = text.get(offset..end).ok_or_else(|| {
                Error::Invalid("accepted Responses text no longer matches its boundaries".into())
            })?;
            let key = part["key"]
                .as_str()
                .filter(|key| matches!(*key, "text" | "refusal"))
                .ok_or_else(|| Error::Invalid("invalid accepted Responses content key".into()))?;
            let mut fields = part["fields"].as_object().cloned().ok_or_else(|| {
                Error::Invalid("invalid accepted Responses content metadata".into())
            })?;
            fields.insert(key.into(), Value::String(value.into()));
            content.push(Value::Object(fields));
            offset = end;
        }
        if offset != text.len() {
            return Err(Error::Invalid(
                "accepted Responses text no longer matches its boundaries".into(),
            ));
        }
        item[field] = Value::Array(content);
    } else if !text.is_empty() {
        return Err(Error::Invalid(
            "accepted Responses item omitted its canonical text".into(),
        ));
    }
    if template["encrypted"] == true {
        item["encrypted_content"] =
            options.as_ref().unwrap()["openai"]["reasoningEncryptedContent"].clone();
    }
    Ok(Some(item))
}
pub(crate) fn call(
    options: &Option<Value>,
    kind: &str,
    call_id: &str,
    name: &str,
    payload: &str,
) -> Result<Option<Value>> {
    let Some(template) = template(options)? else {
        return Ok(None);
    };
    if template["fields"]["type"] != kind {
        return Err(Error::Invalid(
            "accepted Responses call kind changed".into(),
        ));
    }
    let mut item = template["fields"].clone();
    item["call_id"] = json!(call_id);
    item["name"] = json!(name);
    item[if kind == "custom_tool_call" {
        "input"
    } else {
        "arguments"
    }] = Value::String(payload.to_owned());
    Ok(Some(item))
}
pub(crate) fn provider(
    options: &Option<Value>,
    output: &maka_agent_facts::model::prompt::ToolOutput,
) -> Result<Option<Value>> {
    let Some(template) = template(options)? else {
        return Ok(None);
    };
    if template["fields"]["type"] != "web_search_call" {
        return Err(Error::Invalid(
            "invalid accepted Responses provider item".into(),
        ));
    }
    let mut item = template["fields"].clone();
    let value = match output {
        maka_agent_facts::model::prompt::ToolOutput::Json(value)
        | maka_agent_facts::model::prompt::ToolOutput::ErrorJson(value) => value,
        _ => {
            return Err(Error::Invalid(
                "accepted Responses provider result is not JSON".into(),
            ));
        }
    };
    if template["action"] == true {
        item["action"] = value["action"].clone();
    }
    Ok(Some(item))
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
        let serialized = template.to_string();
        assert!(!serialized.contains("First"));
        assert!(!serialized.contains("第二部分"));
        let options = Some(json!({"openai":{"itemId":"msg","responsesReplay":template}}));
        assert_eq!(
            text(&options, "First 😀第二部分", "message").unwrap(),
            Some(original)
        );
        assert!(text(&options, "changed", "message").is_err());
    }

    #[test]
    fn reasoning_and_calls_restore_exact_accepted_fields() {
        let reasoning = json!({"type":"reasoning","id":"reason","encrypted_content":"opaque",
            "summary":[{"type":"summary_text","text":"Check 😀"},{"type":"summary_text","text":""}]});
        let template = capture(&reasoning).unwrap();
        assert!(!template.to_string().contains("opaque"));
        assert!(!template.to_string().contains("Check"));
        let options = Some(
            json!({"openai":{"itemId":"reason","reasoningEncryptedContent":"opaque","responsesReplay":template}}),
        );
        assert_eq!(
            text(&options, "Check 😀", "reasoning").unwrap(),
            Some(reasoning)
        );
        let original = json!({"type":"function_call","id":"fc","call_id":"call","name":"read","arguments":" {\"n\":\n","status":"completed"});
        let options = Some(json!({"openai":{"responsesReplay":capture(&original).unwrap()}}));
        assert_eq!(
            call(&options, "function_call", "call", "read", " {\"n\":\n").unwrap(),
            Some(original)
        );
    }
}
