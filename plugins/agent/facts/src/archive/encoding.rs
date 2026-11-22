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

use crate::{
    artifact::content_digest,
    attachment::StorageRef,
    event::ToolOutcome,
    tool_output::{DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE, DurableToolProjection, ProjectionPart},
};
use serde_json::Value;
use std::{borrow::Cow, cmp::Ordering};

mod source;
pub use source::{projection_identity_source, projection_source};

const MEDIA_PREFIX: &str = "[Artifact ";
const MEDIA_MIME_PREFIX: &str = " (";
const MEDIA_SUFFIX: &str = ") is stored in this Session.]";

/// Failed execution is text evidence, not a successful effect's projection sentinel.
/// Callers retain the original outcome category when replacing provider content.
pub fn outcome_projection(outcome: &ToolOutcome) -> Cow<'_, DurableToolProjection> {
    match outcome {
        ToolOutcome::Succeeded {
            model_projection, ..
        } => Cow::Borrowed(model_projection),
        ToolOutcome::Failed { message } | ToolOutcome::Unknown { message, .. } => {
            Cow::Owned(DurableToolProjection::Text {
                text: message.clone(),
            })
        }
    }
}

/// Frozen TS archive encoding, over projection only; never hydrate raw or media.
pub fn encode_projection(projection: &DurableToolProjection) -> Result<Vec<u8>, &'static str> {
    let mut result = String::new();
    match projection {
        DurableToolProjection::Text { text } => string(&mut result, text)?,
        DurableToolProjection::Failure => {
            string(&mut result, DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE)?
        }
        DurableToolProjection::Json { value } => value_json(&mut result, value, false)?,
        DurableToolProjection::Content { parts } => {
            if parts.is_empty() {
                return Err("invalid archive content");
            }
            result.push('[');
            for (index, part) in parts.iter().enumerate() {
                if index > 0 {
                    result.push(',');
                }
                result.push_str("{\"type\":\"text\",\"text\":");
                match part {
                    ProjectionPart::Text { text } => string(&mut result, text)?,
                    media => {
                        let (reference, mime) = media.media().expect("media projection");
                        let StorageRef::SessionFile { relative_path, .. } = reference else {
                            return Err("archive media must be Session-owned");
                        };
                        let mut quoted = String::new();
                        string(&mut quoted, relative_path)?;
                        string(
                            &mut result,
                            &format!(
                                "{MEDIA_PREFIX}{quoted}{MEDIA_MIME_PREFIX}{mime}{MEDIA_SUFFIX}"
                            ),
                        )?;
                    }
                }
                result.push('}');
            }
            result.push(']');
        }
    }
    Ok(result.into_bytes())
}

/// Key-sorted strict JSON identity of the native durable projection shape.
/// Rust has no TS projection version envelope; body encoding is a separate hash.
pub fn projection_digest(projection: &DurableToolProjection) -> Result<String, &'static str> {
    let mut json = String::new();
    match projection {
        DurableToolProjection::Text { text } => {
            json.push_str("{\"kind\":\"text\",\"text\":");
            string(&mut json, text)?;
            json.push('}');
        }
        DurableToolProjection::Json { value } => {
            json.push_str("{\"kind\":\"json\",\"value\":");
            value_json(&mut json, value, true)?;
            json.push('}');
        }
        DurableToolProjection::Failure => json.push_str("{\"kind\":\"failure\"}"),
        DurableToolProjection::Content { parts } => {
            if parts.is_empty() {
                return Err("invalid archive content");
            }
            json.push_str("{\"kind\":\"content\",\"parts\":[");
            for (index, part) in parts.iter().enumerate() {
                if index > 0 {
                    json.push(',');
                }
                // A typed part contains only flat strings/references, never nested raw JSON.
                let value = serde_json::to_value(part).map_err(|_| "invalid projection part")?;
                value_json(&mut json, &value, true)?;
            }
            json.push_str("]}");
        }
    }
    Ok(content_digest(json.as_bytes()))
}

fn string(output: &mut String, value: &str) -> Result<(), &'static str> {
    use maka_provider_protocol::json_stream::pull::{JsonEscape, Transform};
    let mut encoded = Vec::new();
    encoded.push(b'"');
    let mut escape = JsonEscape::new();
    let mut input = value.as_bytes();
    let mut buffer = [0; 1024];
    loop {
        let progress = escape
            .transform(input, true, &mut buffer)
            .map_err(|_| "invalid string")?;
        encoded.extend_from_slice(&buffer[..progress.written]);
        input = &input[progress.consumed..];
        if progress.finished {
            break;
        }
    }
    encoded.push(b'"');
    output.push_str(std::str::from_utf8(&encoded).map_err(|_| "invalid string")?);
    Ok(())
}
fn number(value: &serde_json::Number) -> Result<String, &'static str> {
    Ok(ryu_js::Buffer::new()
        .format(value.as_f64().ok_or("invalid number")?)
        .to_owned())
}
fn key_order(a: &str, b: &str, stable: bool) -> Ordering {
    key_prefix_order(a, b, stable).unwrap_or_else(|| key_units(a).cmp(key_units(b)))
}
fn key_prefix_order(a: &str, b: &str, stable: bool) -> Option<Ordering> {
    match (index(a), index(b)) {
        (Some(a), Some(b)) => Some(a.cmp(&b)),
        (Some(_), None) => Some(Ordering::Less),
        (None, Some(_)) => Some(Ordering::Greater),
        (None, None) if stable => None,
        (None, None) => Some(Ordering::Equal),
    }
}
fn key_units(key: &str) -> std::str::EncodeUtf16<'_> {
    key.encode_utf16()
}
fn index(key: &str) -> Option<u32> {
    if key.len() > 10 {
        return None;
    }
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}
fn value_json(output: &mut String, value: &Value, stable: bool) -> Result<(), &'static str> {
    enum Step<'a> {
        Value(&'a Value),
        Key(&'a str),
        Literal(&'static str),
    }
    let mut pending = vec![Step::Value(value)];
    while let Some(step) = pending.pop() {
        let value = match step {
            Step::Literal(text) => {
                output.push_str(text);
                continue;
            }
            Step::Key(key) => {
                string(output, key)?;
                continue;
            }
            Step::Value(value) => value,
        };
        match value {
            Value::Null => output.push_str("null"),
            Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Value::Number(value) => output.push_str(&number(value)?),
            Value::String(value) => string(output, value)?,
            Value::Array(values) => {
                output.push('[');
                pending.push(Step::Literal("]"));
                for (index, value) in values.iter().enumerate().rev() {
                    pending.push(Step::Value(value));
                    if index > 0 {
                        pending.push(Step::Literal(","));
                    }
                }
            }
            Value::Object(values) => {
                let mut keys: Vec<_> = values.keys().collect();
                keys.sort_by(|a, b| key_order(a, b, stable));
                output.push('{');
                pending.push(Step::Literal("}"));
                for (index, key) in keys.into_iter().enumerate().rev() {
                    pending.push(Step::Value(&values[key]));
                    pending.push(Step::Literal(":"));
                    pending.push(Step::Key(key));
                    if index > 0 {
                        pending.push(Step::Literal(","));
                    }
                }
            }
        }
    }
    Ok(())
}
