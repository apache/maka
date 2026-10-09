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

//! A `json` Tool result as plain text, the way Maka Desktop's Tool card
//! shows it (`formatQuietJsonValue` in packages/core/src/tool-quiet-preview.ts):
//! the payload's list or main text first, then its other fields as
//! `key: value` lines, never JSON braces or escaped `\n`.
//!
//! A `Read` result (`{content, next, offset, …}`) reads as the file's text
//! followed by its paging fields; a code cell's (`exec`) result
//! (`{ok, toolCalls, value}`) reads as indented `key: value` lines with the
//! value's text on its own lines.
//!
//! Not ported: Desktop's summary line for `{ok, path, bytes}` write results
//! (such a record reads as `key: value` lines here), and its renderer-side
//! secret redaction, which no other part of the Tool card applies either.

use serde_json::{Map, Value};

/// Fields whose list is the payload (Grep, Glob, `tool_search`, …).
const LIST_KEYS: [&str; 9] =
    ["matches", "files", "results", "items", "lines", "rows", "loaded", "tools", "paths"];
/// Fields whose text is the payload (Read's `content`, messages, …).
const BODY_KEYS: [&str; 10] = [
    "content", "text", "message", "output", "stdout", "stderr", "diff", "summary", "body", "result",
];
/// Fields that name what the payload is about, shown above it.
const HEADLINE_KEYS: [&str; 11] =
    ["path", "file", "cmd", "command", "pattern", "query", "url", "name", "title", "id", "ref"];
/// Diagnostic fields listed first among the rest, so none is lost below.
const REMAINDER_PRIORITY: [&str; 7] =
    ["error", "reason", "ok", "truncated", "status", "code", "message"];
/// How deep nested objects are spelled out as lines; deeper ones stay JSON.
const MAX_DEPTH: usize = 3;

/// `value` as text: its headline on the first line when it has one, then
/// its body. `empty` stands for a value or list with nothing in it (Desktop's
/// `(empty)`).
pub(crate) fn quiet_text(value: &Value, empty: &str) -> String {
    let record = match value {
        Value::Null => return empty.to_owned(),
        Value::String(text) if text.is_empty() => return empty.to_owned(),
        Value::String(text) => return text.clone(),
        Value::Bool(_) | Value::Number(_) => return value.to_string(),
        Value::Array(items) => return list_body(items, empty),
        Value::Object(record) => record,
    };
    for key in LIST_KEYS {
        if let Some(Value::Array(items)) = record.get(key) {
            return with_payload(record, key, list_body(items, empty), empty);
        }
    }
    for key in BODY_KEYS {
        if let Some(Value::String(text)) = record.get(key) {
            return with_payload(record, key, text.clone(), empty);
        }
    }
    let lines = key_value_lines(record, 0, empty);
    if lines.is_empty() { empty.to_owned() } else { lines }
}

/// The payload taken from `payload_key`, under the record's headline and
/// above its remaining fields.
fn with_payload(
    record: &Map<String, Value>,
    payload_key: &str,
    payload: String,
    empty: &str,
) -> String {
    let headline =
        HEADLINE_KEYS.iter().copied().filter(|key| *key != payload_key).find_map(|key| {
            let text = record.get(key)?.as_str().filter(|text| !text.is_empty())?;
            Some((key, text))
        });
    let consumed: Vec<&str> =
        std::iter::once(payload_key).chain(headline.map(|(key, _)| key)).collect();
    let rest = remainder(record, &consumed, empty);
    let mut text = String::new();
    if let Some((_, headline)) = headline {
        text.push_str(headline);
        text.push('\n');
    }
    text.push_str(&payload);
    if !rest.is_empty() {
        text.push('\n');
        text.push_str(&rest);
    }
    text
}

/// The fields not yet shown, diagnostics first.
fn remainder(record: &Map<String, Value>, consumed: &[&str], empty: &str) -> String {
    let mut rest = Map::new();
    for key in REMAINDER_PRIORITY {
        if let Some(value) = record.get(key).filter(|_| !consumed.contains(&key)) {
            rest.insert(key.to_owned(), value.clone());
        }
    }
    for (key, value) in record {
        if !consumed.contains(&key.as_str()) && !rest.contains_key(key) {
            rest.insert(key.clone(), value.clone());
        }
    }
    key_value_lines(&rest, 0, empty)
}

/// A list, one entry per line; an object entry as its `key: value` lines.
fn list_body(items: &[Value], empty: &str) -> String {
    if items.is_empty() {
        return empty.to_owned();
    }
    items
        .iter()
        .map(|item| match item {
            Value::String(text) => text.clone(),
            Value::Object(record) => key_value_lines(record, 0, empty),
            other => other.to_string(),
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `key: value` lines (`formatAsKeyValueLines`), two spaces deeper per
/// level: a text with line breaks, a list, or an object starts on the line
/// after its key.
fn key_value_lines(record: &Map<String, Value>, depth: usize, empty: &str) -> String {
    if depth > MAX_DEPTH {
        return Value::Object(record.clone()).to_string();
    }
    let indent = "  ".repeat(depth);
    let mut lines = Vec::new();
    for (key, value) in record {
        match value {
            Value::String(text) if text.contains('\n') => {
                lines.push(format!("{indent}{key}:"));
                lines.extend(text.split('\n').map(|line| format!("{indent}  {line}")));
            }
            Value::String(text) => lines.push(format!("{indent}{key}: {text}")),
            Value::Array(items) if items.is_empty() => {
                lines.push(format!("{indent}{key}: {empty}"))
            }
            Value::Array(items)
                if items.iter().all(|item| !item.is_array() && !item.is_object()) =>
            {
                lines.push(format!("{indent}{key}:"));
                lines.extend(items.iter().map(|item| match item {
                    Value::String(text) => format!("{indent}  - {text}"),
                    other => format!("{indent}  - {other}"),
                }));
            }
            Value::Array(items) => {
                lines.push(format!("{indent}{key}:"));
                let body = list_body(items, empty);
                lines.extend(body.split('\n').map(|line| format!("{indent}  {line}")));
            }
            Value::Object(nested) => {
                lines.push(format!("{indent}{key}:"));
                let nested = key_value_lines(nested, depth + 1, empty);
                if !nested.is_empty() {
                    lines.push(nested);
                }
            }
            other => lines.push(format!("{indent}{key}: {other}")),
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_read_result_shows_the_text_then_its_paging() {
        let value = json!({
            "content": "line one\nline two\n", "next": {"path": "maka://read/abc"},
            "offset": 0, "returnedLines": 2, "totalLines": 9
        });
        assert_eq!(
            quiet_text(&value, "(empty)"),
            "line one\nline two\n\nnext:\n  path: maka://read/abc\noffset: 0\nreturnedLines: 2\ntotalLines: 9"
        );
    }

    #[test]
    fn a_code_cell_result_reads_as_lines() {
        let value = json!({
            "ok": true, "toolCalls": [{"index": 1, "name": "Read"}],
            "value": {"content": "a\nb", "next": null}
        });
        assert_eq!(
            quiet_text(&value, "(empty)"),
            "ok: true\ntoolCalls:\n  index: 1\n  name: Read\nvalue:\n  content:\n    a\n    b\n  next: null"
        );
    }

    #[test]
    fn a_list_payload_comes_first_with_its_headline() {
        let value = json!({"truncated": false, "files": ["a.md", "b.md"], "pattern": "*.md"});
        assert_eq!(quiet_text(&value, "(empty)"), "*.md\na.md\nb.md\ntruncated: false");
    }

    #[test]
    fn nothing_reads_as_empty() {
        for value in [json!(null), json!(""), json!([]), json!({}), json!({"files": []})] {
            assert_eq!(quiet_text(&value, "(empty)"), "(empty)", "{value}");
        }
        assert_eq!(quiet_text(&json!({"tags": []}), "(empty)"), "tags: (empty)");
        assert_eq!(quiet_text(&json!(3), "(empty)"), "3");
    }
}
