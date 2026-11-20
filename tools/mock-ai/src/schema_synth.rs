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

use crate::plan::HttpErrorSpec;
use crate::protocol::Protocol;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// Controls how `synthesize_tool_arguments` constructs JSON arguments from a tool's JSON Schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SynthMode {
    /// Generate schema-conforming JSON satisfying required fields, enums, types, and bounds.
    #[default]
    Valid,
    /// Intentionally omit one required property (tests Maka's schema validation & error recovery).
    MissingRequired,
    /// Intentionally place a wrong JSON type in one property.
    WrongType,
    /// Emit a deliberately truncated/invalid raw JSON string (tests partial/malformed JSON handling).
    MalformedJson,
    /// Fill the first string property (or a synthetic field) with `usize` bytes of realistic code/text.
    HugePayload(usize),
}

/// Wire-level SSE framing poison options for fuzzing streaming decoders.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WirePoisonConfig {
    /// Split HTTP chunked frames right inside multi-byte UTF-8 sequences (CJK/emoji).
    pub split_utf8_boundaries: bool,
    /// Replace `\n` line endings with `\r\n` across SSE frames.
    pub crlf_line_endings: bool,
    /// Interleave SSE comment lines (`: keep-alive\n\n`) before frames.
    pub inject_sse_comments: bool,
}

impl WirePoisonConfig {
    pub fn is_active(&self) -> bool {
        self.split_utf8_boundaries || self.crlf_line_endings || self.inject_sse_comments
    }
}

/// Synthesize deterministic tool arguments from an arbitrary JSON Schema definition.
///
/// For `SynthMode::MalformedJson`, returns a `Value::String` containing intentionally broken JSON
/// (which `ToolCallSpec::arguments_string()` transmits verbatim on the wire).
const MAX_SYNTH_NODES: usize = 512;
const MAX_SYNTH_BYTES: usize = 256 * 1024;

struct SynthBudget {
    nodes: usize,
    bytes: usize,
    exceeded: bool,
}

impl SynthBudget {
    fn new() -> Self {
        Self {
            nodes: MAX_SYNTH_NODES,
            bytes: MAX_SYNTH_BYTES,
            exceeded: false,
        }
    }

    fn charge_node(&mut self) -> bool {
        if self.nodes == 0 {
            self.exceeded = true;
            return false;
        }
        self.nodes -= 1;
        true
    }

    fn charge_bytes(&mut self, n: usize) -> bool {
        if n > self.bytes {
            self.bytes = 0;
            self.exceeded = true;
            return false;
        }
        self.bytes -= n;
        true
    }

    fn charge_value(&mut self, val: &Value) -> bool {
        let (nodes, bytes) = value_cost(val);
        let extra_nodes = nodes.saturating_sub(1);
        if extra_nodes > self.nodes || bytes > self.bytes {
            self.nodes = self.nodes.saturating_sub(extra_nodes);
            self.bytes = 0;
            self.exceeded = true;
            return false;
        }
        self.nodes -= extra_nodes;
        self.bytes -= bytes;
        true
    }
}

/// Strict variant of `synthesize_tool_arguments` that returns `Err` if the schema exceeds the
/// shared node/byte budget (`MAX_SYNTH_NODES` / `MAX_SYNTH_BYTES`) while satisfying constraints.
pub fn try_synthesize_tool_arguments(
    schema: &Value,
    rng: &mut fastrand::Rng,
    mode: SynthMode,
) -> Result<Value, String> {
    let mut budget = SynthBudget::new();
    let val = synthesize_inner(schema, rng, mode, &mut budget);
    if budget.exceeded && matches!(mode, SynthMode::Valid) {
        return Err(format!(
            "schema exceeded synthesis budget (nodes={MAX_SYNTH_NODES}, bytes={MAX_SYNTH_BYTES})"
        ));
    }
    Ok(val)
}

pub fn synthesize_tool_arguments(
    schema: &Value,
    rng: &mut fastrand::Rng,
    mode: SynthMode,
) -> Value {
    let mut budget = SynthBudget::new();
    synthesize_inner(schema, rng, mode, &mut budget)
}

fn synthesize_inner(
    schema: &Value,
    rng: &mut fastrand::Rng,
    mode: SynthMode,
    budget: &mut SynthBudget,
) -> Value {
    if matches!(mode, SynthMode::MalformedJson) {
        let mut partial = synthesize_value(schema, None, rng, 0, budget).to_string();
        if partial.len() > 6 {
            let cut = partial.floor_char_boundary(partial.len() / 2);
            partial.truncate(cut.max(2));
        } else {
            partial = "{\"broken\": \"unterminated".into();
        }
        return Value::String(partial);
    }

    let mut val = synthesize_value(schema, None, rng, 0, budget);
    if !val.is_object() {
        let mut obj = Map::new();
        obj.insert("value".into(), val);
        val = Value::Object(obj);
    }

    match mode {
        SynthMode::Valid | SynthMode::MalformedJson => val,
        SynthMode::MissingRequired => {
            if let Value::Object(ref mut map) = val {
                if let Some(req) = schema.get("required").and_then(Value::as_array)
                    && let Some(first_req) = req.first().and_then(Value::as_str)
                {
                    map.remove(first_req);
                    return val;
                }
                if let Some(first_key) = map.keys().next().cloned() {
                    map.remove(&first_key);
                }
            }
            val
        }
        SynthMode::WrongType => {
            if let Value::Object(ref mut map) = val {
                if let Some((_, first_val)) = map.iter_mut().next() {
                    *first_val = match first_val {
                        Value::String(_) => json!(999_999),
                        Value::Number(_) => Value::String("not_a_number".into()),
                        Value::Bool(_) => Value::String("not_a_bool".into()),
                        Value::Array(_) => json!({"unexpected": "object"}),
                        Value::Object(_) => json!(["unexpected_array"]),
                        Value::Null => json!(true),
                    };
                } else {
                    map.insert("invalid_field".into(), json!(12345));
                }
            }
            val
        }
        SynthMode::HugePayload(target_bytes) => {
            let blob = generate_large_code_blob(target_bytes, rng);
            if let Value::Object(ref mut map) = val {
                if let Some((_, slot)) = map.iter_mut().find(|(_, v)| v.is_string()) {
                    *slot = Value::String(blob);
                } else {
                    map.insert("content".into(), Value::String(blob));
                }
            }
            val
        }
    }
}

fn value_cost(val: &Value) -> (usize, usize) {
    match val {
        Value::String(s) => (1, s.len() + 2),
        Value::Array(a) => a.iter().fold((1usize, 2usize), |(n, b), item| {
            let (in_, ib) = value_cost(item);
            (
                n.saturating_add(in_),
                b.saturating_add(ib).saturating_add(1),
            )
        }),
        Value::Object(m) => m.iter().fold((1usize, 2usize), |(n, b), (k, v)| {
            let (vn, vb) = value_cost(v);
            (
                n.saturating_add(vn),
                b.saturating_add(k.len())
                    .saturating_add(vb)
                    .saturating_add(4),
            )
        }),
        _ => (1, 8),
    }
}

fn synthesize_value(
    schema: &Value,
    prop_name: Option<&str>,
    rng: &mut fastrand::Rng,
    depth: usize,
    budget: &mut SynthBudget,
) -> Value {
    if depth >= 8 || !budget.charge_node() {
        budget.exceeded = true;
        return Value::String("budget_cap".into());
    }

    if let Some(c) = schema.get("const") {
        if !budget.charge_value(c) {
            return Value::String("budget_cap".into());
        }
        return c.clone();
    }
    if let Some(arr) = schema.get("enum").and_then(Value::as_array)
        && !arr.is_empty()
    {
        let chosen = &arr[rng.usize(0..arr.len())];
        if !budget.charge_value(chosen) {
            return Value::String("budget_cap".into());
        }
        return chosen.clone();
    }
    if let Some(alts) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
        let non_null: Vec<&Value> = alts
            .iter()
            .filter(|v| v.get("type").and_then(Value::as_str) != Some("null"))
            .collect();
        let pool = if non_null.is_empty() {
            alts.iter().collect::<Vec<_>>()
        } else {
            non_null
        };
        if !pool.is_empty() {
            let chosen = pool[rng.usize(0..pool.len())];
            return synthesize_value(chosen, prop_name, rng, depth + 1, budget);
        }
    }
    if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
        let mut merged = Map::new();
        for sub in all_of {
            if budget.nodes == 0 || budget.bytes == 0 {
                budget.exceeded = true;
                break;
            }
            if let Value::Object(m) = synthesize_value(sub, prop_name, rng, depth + 1, budget) {
                for (k, v) in m {
                    merged.insert(k, v);
                }
            }
        }
        if !merged.is_empty() {
            return Value::Object(merged);
        }
    }

    let ty = resolve_schema_type(schema);
    match ty {
        "object" => {
            let mut out = Map::new();
            let required: Vec<&str> = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if let Some(props) = schema.get("properties").and_then(Value::as_object) {
                for (key, prop_schema) in props {
                    let is_req = required.contains(&key.as_str());
                    if is_req {
                        if budget.nodes == 0 || budget.bytes == 0 {
                            budget.exceeded = true;
                            break;
                        }
                        let _ = budget.charge_bytes(key.len() + 4);
                        out.insert(
                            key.clone(),
                            synthesize_value(prop_schema, Some(key), rng, depth + 1, budget),
                        );
                    } else if rng.f64() < 0.35 && budget.nodes > 0 && budget.bytes > 0 {
                        let _ = budget.charge_bytes(key.len() + 4);
                        out.insert(
                            key.clone(),
                            synthesize_value(prop_schema, Some(key), rng, depth + 1, budget),
                        );
                    }
                }
            }
            for req_key in required {
                if !out.contains_key(req_key) {
                    if !budget.charge_node() {
                        break;
                    }
                    let val = synthesize_string(&json!({}), Some(req_key), rng);
                    let _ = budget.charge_bytes(req_key.len() + val.to_string().len() + 4);
                    out.insert(req_key.to_string(), val);
                }
            }
            Value::Object(out)
        }
        "array" => {
            let min_items = schema.get("minItems").and_then(Value::as_u64).unwrap_or(1) as usize;
            let max_items = schema
                .get("maxItems")
                .and_then(Value::as_u64)
                .unwrap_or((min_items + 2) as u64) as usize;
            let lo = min_items.min(64);
            let hi = max_items.clamp(lo, lo.clamp(4, 64));
            let count = if hi > lo { rng.usize(lo..=hi) } else { lo };
            let item_schema = schema
                .get("items")
                .cloned()
                .unwrap_or_else(|| json!({"type": "string"}));
            let mut items = Vec::with_capacity(count);
            for _ in 0..count {
                if budget.nodes == 0 || budget.bytes == 0 {
                    budget.exceeded = true;
                    break;
                }
                items.push(synthesize_value(
                    &item_schema,
                    prop_name,
                    rng,
                    depth + 1,
                    budget,
                ));
            }
            Value::Array(items)
        }
        "integer" => {
            let lo = schema.get("minimum").and_then(Value::as_i64).unwrap_or(0);
            let hi = schema
                .get("maximum")
                .and_then(Value::as_i64)
                .unwrap_or(lo.saturating_add(100));
            let hi = hi.max(lo);
            let v = if hi > lo { rng.i64(lo..=hi) } else { lo };
            json!(v)
        }
        "number" => {
            let lo = schema.get("minimum").and_then(Value::as_f64).unwrap_or(0.0);
            let hi = schema
                .get("maximum")
                .and_then(Value::as_f64)
                .unwrap_or(lo + 100.0)
                .max(lo);
            let v = lo + (hi - lo) * rng.f64();
            json!((v * 100.0).round() / 100.0)
        }
        "boolean" => Value::Bool(rng.bool()),
        "null" => Value::Null,
        _ => synthesize_string(schema, prop_name, rng),
    }
}

fn resolve_schema_type(schema: &Value) -> &str {
    if let Some(t) = schema.get("type") {
        if let Some(s) = t.as_str() {
            return s;
        }
        if let Some(arr) = t.as_array() {
            for item in arr {
                if let Some(s) = item.as_str()
                    && s != "null"
                {
                    return s;
                }
            }
        }
    }
    if schema.get("properties").is_some() {
        "object"
    } else if schema.get("items").is_some() {
        "array"
    } else {
        "string"
    }
}

fn synthesize_string(schema: &Value, prop_name: Option<&str>, rng: &mut fastrand::Rng) -> Value {
    if let Some(default) = schema.get("default").and_then(Value::as_str) {
        return Value::String(default.to_string());
    }
    let format = schema.get("format").and_then(Value::as_str).unwrap_or("");
    let name_lower = prop_name.unwrap_or("").to_ascii_lowercase();
    let n = rng.u32(1..9999);

    let mut s = match format {
        "uri" | "url" => format!("https://example.invalid/resource/{n}"),
        "email" => format!("bench{n}@example.invalid"),
        "date-time" => "2026-11-20T12:00:00Z".into(),
        "date" => "2026-11-20".into(),
        "uuid" => format!("00000000-0000-4000-8000-{n:012}"),
        _ => {
            if name_lower.contains("path") || name_lower.contains("file") {
                format!("src/module_{n}.rs")
            } else if name_lower.contains("command") || name_lower == "cmd" {
                format!("echo synthetic_check_{n}")
            } else if name_lower.contains("query") || name_lower.contains("search") {
                format!("maka benchmark query {n}")
            } else if name_lower.contains("url") || name_lower.contains("uri") {
                format!("https://example.invalid/item/{n}")
            } else if name_lower.contains("id") {
                format!("id_{n}")
            } else {
                format!("synthetic_{name_lower}_{n}")
            }
        }
    };

    if let Some(min_len) = schema.get("minLength").and_then(Value::as_u64) {
        let min_len = (min_len as usize).min(2048);
        while s.len() < min_len {
            s.push_str("_pad");
        }
    }
    if let Some(max_len) = schema.get("maxLength").and_then(Value::as_u64) {
        let max_len = max_len as usize;
        if s.len() > max_len {
            let cut = s.floor_char_boundary(max_len);
            s.truncate(cut);
        }
    }
    Value::String(s)
}

fn generate_large_code_blob(target_bytes: usize, rng: &mut fastrand::Rng) -> String {
    let target = target_bytes.clamp(1024, 4 * 1024 * 1024);
    let mut out = String::with_capacity(target + 128);
    let mut line = 0usize;
    while out.len() < target {
        let v = rng.u32(1000..9999);
        out.push_str(&format!(
            "pub fn synthetic_block_{line}(input: u64) -> u64 {{ input.wrapping_add({v}) }} // 中文边界🚀\n"
        ));
        line += 1;
    }
    out
}

/// Apply wire-level SSE framing poison (CRLF, comments, and mid-UTF-8 byte splits).
pub fn poison_sse_frame(frame: String, cfg: &WirePoisonConfig, frame_index: usize) -> Vec<Bytes> {
    if !cfg.is_active() {
        return vec![Bytes::from(frame)];
    }

    let mut payload = String::with_capacity(frame.len() + 32);
    if cfg.inject_sse_comments && frame_index.is_multiple_of(2) {
        payload.push_str(": keep-alive\n\n");
    }
    payload.push_str(&frame);

    if cfg.crlf_line_endings {
        payload = payload.replace("\r\n", "\n").replace('\n', "\r\n");
    }

    let raw = Bytes::from(payload.into_bytes());
    if !cfg.split_utf8_boundaries {
        return vec![raw];
    }

    // Single-pass O(N) zero-copy splitter: only inspects up to `STEP` bytes ahead so large ASCII
    // payloads never degrade to quadratic scanning, while still bisecting multi-byte UTF-8 sequences.
    const STEP: usize = 37;
    let mut chunks = Vec::with_capacity(raw.len() / STEP + 2);
    let mut cursor = 0usize;
    while cursor < raw.len() {
        let end = (cursor + STEP).min(raw.len());
        let window = &raw[cursor..end];
        let advance = if let Some(pos) = window.iter().position(|&b| b >= 0xC0) {
            if pos == 0 && raw.len() - cursor > 1 {
                1
            } else if cursor + pos + 1 < raw.len() {
                pos + 1
            } else {
                raw.len() - cursor
            }
        } else {
            window.len()
        };
        chunks.push(raw.slice(cursor..cursor + advance));
        cursor += advance;
    }
    chunks
}

/// Build an HTTP 400 `context_length_exceeded` response recognized by Maka's `error/overflow.rs`.
pub fn context_overflow_error(
    protocol: Protocol,
    actual_bytes: usize,
    limit_bytes: usize,
) -> HttpErrorSpec {
    let actual_tokens = (actual_bytes / 4).max(1);
    let max_tokens = (limit_bytes / 4).max(1);
    let body = match protocol {
        Protocol::AnthropicMessages => json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": format!("prompt is too long: {actual_tokens} tokens > {max_tokens} maximum")
            }
        }),
        Protocol::OpenaiChatCompletions
        | Protocol::OpenaiResponsesHttp
        | Protocol::OpenaiResponsesWs => json!({
            "error": {
                "type": "invalid_request_error",
                "code": "context_length_exceeded",
                "message": format!(
                    "This model's maximum context length is {max_tokens} tokens. However, your messages resulted in {actual_tokens} tokens."
                )
            }
        }),
    };
    HttpErrorSpec::raw(400, body)
}
