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
const MAX_SYNTH_DEPTH: usize = 16;
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
        if extra_nodes > self.nodes {
            self.nodes = 0;
            self.exceeded = true;
            return false;
        }
        self.nodes -= extra_nodes;
        self.charge_bytes(bytes)
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
    if matches!(mode, SynthMode::Valid) {
        let validator = jsonschema::validator_for(schema).map_err(|e| e.to_string())?;
        validator.validate(&val).map_err(|e| e.to_string())?;
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
        let mut partial = synthesize_value(schema, schema, None, rng, 0, budget).to_string();
        if partial.starts_with('{') && partial.len() > 6 {
            let cut = partial.floor_char_boundary(partial.len() / 2);
            partial.truncate(cut.max(2));
        } else {
            partial = "{\"broken\": \"unterminated".into();
        }
        return Value::String(partial);
    }

    let mut val = synthesize_value(schema, schema, None, rng, 0, budget);
    match mode {
        SynthMode::Valid | SynthMode::MalformedJson => val,
        SynthMode::MissingRequired => {
            if let Value::Object(ref mut map) = val {
                if let Ok(validator) = jsonschema::validator_for(schema)
                    && let Some(key) = map
                        .keys()
                        .find(|key| {
                            let mut without = map.clone();
                            without.remove(*key);
                            !validator.is_valid(&Value::Object(without))
                        })
                        .cloned()
                {
                    map.remove(&key);
                    return val;
                }
                if let Some(first_key) = map.keys().next().cloned() {
                    map.remove(&first_key);
                }
            }
            val
        }
        SynthMode::WrongType => {
            let Some(map) = val.as_object() else {
                return wrong_type(&val);
            };
            let validator = jsonschema::validator_for(schema).ok();
            let keys: Vec<_> = map.keys().cloned().collect();
            for key in &keys {
                let replacement = wrong_type(&val[key]);
                let previous = std::mem::replace(&mut val[key], replacement);
                if validator
                    .as_ref()
                    .is_none_or(|validator| !validator.is_valid(&val))
                {
                    return val;
                }
                val[key] = previous;
            }
            if let Some(first) = keys.first() {
                val[first] = wrong_type(&val[first]);
            } else {
                val["invalid_field"] = json!(12345);
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

fn wrong_type(value: &Value) -> Value {
    match value {
        Value::String(_) => json!(999_999),
        Value::Number(_) => json!("not_a_number"),
        Value::Bool(_) => json!("not_a_bool"),
        Value::Array(_) => json!({"unexpected": "object"}),
        Value::Object(_) => json!(["unexpected_array"]),
        Value::Null => json!(true),
    }
}

fn value_cost(val: &Value) -> (usize, usize) {
    match val {
        Value::String(s) => (1, escaped_string_bytes(s) + 2),
        Value::Array(a) => {
            a.iter()
                .fold((1usize, 2 + a.len().saturating_sub(1)), |(n, b), item| {
                    let (in_, ib) = value_cost(item);
                    (n.saturating_add(in_), b.saturating_add(ib))
                })
        }
        Value::Object(m) => {
            m.iter()
                .fold((1usize, 2 + m.len().saturating_sub(1)), |(n, b), (k, v)| {
                    let (vn, vb) = value_cost(v);
                    (
                        n.saturating_add(vn),
                        b.saturating_add(escaped_string_bytes(k))
                            .saturating_add(vb)
                            .saturating_add(3),
                    )
                })
        }
        Value::Number(number) => (1, number.to_string().len()),
        Value::Bool(false) => (1, 5),
        Value::Bool(true) | Value::Null => (1, 4),
    }
}

fn escaped_string_bytes(text: &str) -> usize {
    text.bytes().fold(text.len(), |bytes, byte| {
        bytes
            + match byte {
                b'"' | b'\\' | b'\x08' | b'\t' | b'\n' | b'\x0c' | b'\r' => 1,
                0..=0x1f => 5,
                _ => 0,
            }
    })
}

fn synthesize_value(
    root: &Value,
    schema: &Value,
    prop_name: Option<&str>,
    rng: &mut fastrand::Rng,
    depth: usize,
    budget: &mut SynthBudget,
) -> Value {
    if depth >= MAX_SYNTH_DEPTH || !budget.charge_node() {
        budget.exceeded = true;
        return Value::String("budget_cap".into());
    }

    let resolved = resolve_composition(root, schema, depth, budget);
    let schema = resolved.as_ref();

    if let Some(alts) = schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array)
        && !alts.is_empty()
    {
        let mut base = schema.as_object().expect("composition object").clone();
        let keyword = if base.contains_key("oneOf") {
            "oneOf"
        } else {
            "anyOf"
        };
        base.remove(keyword);
        let base = Value::Object(base);
        let candidates = (0..alts.len())
            .cycle()
            .skip(rng.usize(..alts.len()))
            .take(alts.len());
        let validation_schema = schema_with_definitions(root, schema);
        let validator = jsonschema::validator_for(&validation_schema).ok();
        let output_bytes = budget.bytes;
        let mut fallback = (Value::Null, output_bytes);
        let mut branch_exceeded = false;
        for i in candidates {
            if budget.exceeded || budget.bytes == 0 || !budget.charge_node() {
                break;
            }
            let branch = resolve_composition(root, &alts[i], depth + 1, budget);
            let combined = intersect(&base, &branch);
            if combined != Value::Bool(false) {
                let mut candidate =
                    synthesize_value(root, &combined, prop_name, rng, depth + 1, budget);
                if let Some(validator) = &validator
                    && !budget.exceeded
                    && (validator.is_valid(&candidate)
                        || vary_enum(
                            root,
                            &combined,
                            &mut candidate,
                            validator,
                            budget,
                            depth + 1,
                        ))
                {
                    return candidate;
                }
                fallback = (candidate, budget.bytes);
            }
            // Rejected output is discarded, but its search work still counts.
            branch_exceeded |= std::mem::take(&mut budget.exceeded);
            budget.bytes = output_bytes;
        }
        budget.exceeded |= branch_exceeded;
        let (fallback, fallback_bytes) = fallback;
        budget.bytes = fallback_bytes;
        return fallback;
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
    let ty = if schema == &Value::Bool(false) {
        "null"
    } else {
        resolve_schema_type(schema)
    };
    match ty {
        "object" => {
            if !budget.charge_bytes(2) {
                return Value::String("budget_cap".into());
            }
            let mut out = Map::new();
            let required: Vec<&str> = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if let Some(props) = schema.get("properties").and_then(Value::as_object) {
                for (key, prop_schema) in props {
                    let is_req = required.contains(&key.as_str());
                    if !is_req && !(rng.f64() < 0.35 && budget.nodes > 0 && budget.bytes > 0) {
                        continue;
                    }
                    if !budget
                        .charge_bytes(escaped_string_bytes(key) + 3 + usize::from(!out.is_empty()))
                    {
                        break;
                    }
                    let value =
                        synthesize_value(root, prop_schema, Some(key), rng, depth + 1, budget);
                    if budget.exceeded {
                        break;
                    }
                    out.insert(key.clone(), value);
                }
            }
            for req_key in required {
                if !out.contains_key(req_key) {
                    if budget.exceeded
                        || !budget.charge_node()
                        || !budget.charge_bytes(
                            escaped_string_bytes(req_key) + 3 + usize::from(!out.is_empty()),
                        )
                    {
                        break;
                    }
                    let val = synthesize_string(&Value::Null, Some(req_key), rng, budget);
                    if budget.exceeded {
                        break;
                    }
                    out.insert(req_key.to_string(), val);
                }
            }
            Value::Object(out)
        }
        "array" => {
            let min_items = schema.get("minItems").and_then(Value::as_u64).unwrap_or(0) as usize;
            let max_items = schema
                .get("maxItems")
                .and_then(Value::as_u64)
                .unwrap_or(min_items.saturating_add(2) as u64) as usize;
            let lo = min_items.min(64);
            let hi = max_items.clamp(lo, lo.clamp(4, 64));
            let count = if hi > lo { rng.usize(lo..=hi) } else { lo };
            if !budget.charge_bytes(2 + count.saturating_sub(1)) {
                return Value::String("budget_cap".into());
            }
            let default_item = Value::Null;
            let item_schema = schema.get("items").unwrap_or(&default_item);
            let mut items = Vec::with_capacity(count);
            for _ in 0..count {
                if budget.nodes == 0 || budget.bytes == 0 {
                    budget.exceeded = true;
                    break;
                }
                let item = synthesize_value(root, item_schema, prop_name, rng, depth + 1, budget);
                if budget.exceeded {
                    break;
                }
                items.push(item);
            }
            Value::Array(items)
        }
        "integer" | "number" | "boolean" | "null" => {
            let scalar = match ty {
                "integer" => {
                    let lo = schema.get("minimum").and_then(Value::as_i64).unwrap_or(0);
                    let hi = schema
                        .get("maximum")
                        .and_then(Value::as_i64)
                        .unwrap_or(lo.saturating_add(100));
                    json!(if hi > lo { rng.i64(lo..=hi) } else { lo })
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
                _ => Value::Null,
            };
            if budget.charge_value(&scalar) {
                scalar
            } else {
                Value::String("budget_cap".into())
            }
        }
        _ => synthesize_string(schema, prop_name, rng, budget),
    }
}

// A discriminator's sampled enum value can satisfy two oneOf branches. Try
// the other members against the entire composed schema before abandoning it.
fn vary_enum(
    root: &Value,
    schema: &Value,
    candidate: &mut Value,
    validator: &jsonschema::Validator,
    budget: &mut SynthBudget,
    depth: usize,
) -> bool {
    if let Some(values) = schema["enum"].as_array() {
        for value in values {
            if !budget.charge_node() {
                return false;
            }
            if validator.is_valid(value) && budget.charge_value(value) {
                *candidate = value.clone();
                return true;
            }
        }
    }
    let Some(properties) = schema["properties"].as_object() else {
        return false;
    };
    if !candidate.is_object() {
        return false;
    }
    for (name, property) in properties {
        if candidate.get(name).is_none() {
            continue;
        }
        let property = resolve_composition(root, property, depth, budget);
        let Some(values) = property["enum"].as_array() else {
            continue;
        };
        let original = std::mem::take(&mut candidate[name]);
        for value in values {
            if !budget.charge_value(value) {
                break;
            }
            candidate[name] = value.clone();
            if validator.is_valid(candidate) {
                return true;
            }
        }
        candidate[name] = original;
    }
    false
}

fn schema_with_definitions(root: &Value, schema: &Value) -> Value {
    let mut schema = schema.clone();
    for key in ["$defs", "definitions", "$schema"] {
        if let Some(value) = root.get(key) {
            schema[key] = value.clone();
        }
    }
    schema
}

fn resolve_composition<'a>(
    root: &'a Value,
    schema: &'a Value,
    depth: usize,
    budget: &mut SynthBudget,
) -> std::borrow::Cow<'a, Value> {
    use std::borrow::Cow;

    if schema.get("$ref").is_none() && schema.get("allOf").is_none() {
        return Cow::Borrowed(schema);
    }
    if depth >= MAX_SYNTH_DEPTH || !budget.charge_node() {
        budget.exceeded = true;
        return Cow::Owned(Value::Null);
    }
    let mut base = schema.as_object().expect("composition object").clone();
    let reference = base.remove("$ref");
    let all_of = base.remove("allOf");
    let mut merged = Value::Object(base);
    if let Some(reference) = reference {
        if let Some(target) = reference
            .as_str()
            .and_then(|s| s.strip_prefix('#'))
            .and_then(|p| root.pointer(p))
        {
            let target = resolve_composition(root, target, depth + 1, budget);
            merged = intersect(&merged, &target);
        } else {
            budget.exceeded = true;
        }
    }
    if let Some(Value::Array(branches)) = all_of {
        for branch in &branches {
            if budget.exceeded {
                break;
            }
            let branch = resolve_composition(root, branch, depth + 1, budget);
            merged = intersect(&merged, &branch);
        }
    }
    Cow::Owned(merged)
}

// Build a candidate schema. The original schema still decides whether an instance is valid.
fn intersect(left: &Value, right: &Value) -> Value {
    if left == &Value::Bool(false) || right == &Value::Bool(false) {
        return Value::Bool(false);
    }
    let Some(left_map) = left.as_object() else {
        return right.clone();
    };
    let Some(right_map) = right.as_object() else {
        return left.clone();
    };
    let mut merged = left_map.clone();
    for (key, right) in right_map {
        let value = match (key.as_str(), merged.get(key)) {
            ("properties", Some(Value::Object(left))) => {
                let mut properties = left.clone();
                if let Some(right) = right.as_object() {
                    for (name, schema) in right {
                        properties
                            .entry(name.clone())
                            .and_modify(|previous| {
                                *previous = json!({"allOf": [previous, schema]});
                            })
                            .or_insert_with(|| schema.clone());
                    }
                }
                Value::Object(properties)
            }
            ("oneOf" | "anyOf", Some(Value::Array(left))) => {
                let Some(right) = right.as_array() else {
                    return Value::Bool(false);
                };
                let pairs = left
                    .iter()
                    .flat_map(|first| right.iter().map(move |second| (first, second)));
                let mut alternatives = SynthBudget::new();
                Value::Array(
                    pairs
                        .map_while(|(first, second)| {
                            (alternatives.charge_value(first) && alternatives.charge_value(second))
                                .then(|| json!({"allOf": [first, second]}))
                        })
                        .collect(),
                )
            }
            ("const", Some(left)) if left != right => return Value::Bool(false),
            ("type", Some(left)) if left != right => {
                let names = |value: &Value| {
                    value
                        .as_array()
                        .cloned()
                        .unwrap_or_else(|| vec![value.clone()])
                };
                let left = names(left);
                let right = names(right);
                let mut common: Vec<_> = left
                    .iter()
                    .filter(|ty| right.contains(ty))
                    .cloned()
                    .collect();
                let number = json!("number");
                let integer = json!("integer");
                if ((left.contains(&number) && right.contains(&integer))
                    || (right.contains(&number) && left.contains(&integer)))
                    && !common.contains(&integer)
                {
                    common.push(integer);
                }
                if common.is_empty() {
                    return Value::Bool(false);
                }
                Value::Array(common)
            }
            ("required", Some(Value::Array(left))) => {
                let mut required = left.clone();
                if let Some(right) = right.as_array() {
                    for name in right {
                        if !required.contains(name) {
                            required.push(name.clone());
                        }
                    }
                }
                Value::Array(required)
            }
            ("enum", Some(Value::Array(left))) => Value::Array(
                left.iter()
                    .filter(|v| right.as_array().is_some_and(|r| r.contains(v)))
                    .cloned()
                    .collect(),
            ),
            ("minimum" | "minLength" | "minItems", Some(left))
                if left.as_f64() > right.as_f64() =>
            {
                left.clone()
            }
            ("maximum" | "maxLength" | "maxItems", Some(left))
                if left.as_f64() < right.as_f64() =>
            {
                left.clone()
            }
            ("items", Some(left)) => json!({"allOf": [left, right]}),
            _ => right.clone(),
        };
        merged.insert(key.clone(), value);
    }
    Value::Object(merged)
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
            if arr.iter().any(|value| value == "null") {
                return "null";
            }
        }
    }
    if schema.get("properties").is_some() || schema.get("required").is_some() {
        "object"
    } else if schema.get("items").is_some() {
        "array"
    } else {
        "string"
    }
}

fn synthesize_string(
    schema: &Value,
    prop_name: Option<&str>,
    rng: &mut fastrand::Rng,
    budget: &mut SynthBudget,
) -> Value {
    if let Some(default @ Value::String(_)) = schema.get("default") {
        return if budget.charge_value(default) {
            default.clone()
        } else {
            Value::String("budget_cap".into())
        };
    }
    let format = schema.get("format").and_then(Value::as_str).unwrap_or("");
    let name_lower = prop_name.unwrap_or("").to_ascii_lowercase();
    let n = rng.u32(1..9999);
    let digits = n.to_string();
    let suffix;
    let mut parts = match format {
        "uri" | "url" => ["https://example.invalid/resource/", &digits, ""],
        "email" => ["bench", &digits, "@example.invalid"],
        "date-time" => ["2026-11-20T12:00:00Z", "", ""],
        "date" => ["2026-11-20", "", ""],
        "uuid" => {
            suffix = format!("{n:012}");
            ["00000000-0000-4000-8000-", &suffix, ""]
        }
        _ => {
            if name_lower.contains("path") || name_lower.contains("file") {
                ["src/module_", &digits, ".rs"]
            } else if name_lower.contains("command") || name_lower == "cmd" {
                ["echo synthetic_check_", &digits, ""]
            } else if name_lower.contains("query") || name_lower.contains("search") {
                ["maka benchmark query ", &digits, ""]
            } else if name_lower.contains("url") || name_lower.contains("uri") {
                ["https://example.invalid/item/", &digits, ""]
            } else if name_lower.contains("id") {
                ["id_", &digits, ""]
            } else {
                suffix = format!("_{n}");
                ["synthetic_", name_lower.as_str(), &suffix]
            }
        }
    };

    let min_len = schema["minLength"].as_u64().unwrap_or(0).min(2048) as usize;
    let base_len = parts.iter().map(|part| part.len()).sum();
    let pad = min_len.saturating_sub(base_len).div_ceil(4) * 4;
    let mut remaining = schema["maxLength"].as_u64().unwrap_or(u64::MAX) as usize;
    for part in &mut parts {
        let cut = part.floor_char_boundary(remaining);
        remaining = if cut < part.len() { 0 } else { remaining - cut };
        *part = &part[..cut];
    }
    let pad = pad.min(remaining);
    let bytes = parts.iter().map(|s| escaped_string_bytes(s)).sum::<usize>() + pad + 2;
    if !budget.charge_bytes(bytes) {
        return Value::String("budget_cap".into());
    }
    let mut text = String::with_capacity(parts.iter().map(|part| part.len()).sum::<usize>() + pad);
    for part in parts {
        text.push_str(part);
    }
    for _ in 0..pad / 4 {
        text.push_str("_pad");
    }
    text.push_str(&"_pad"[..pad % 4]);
    Value::String(text)
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

/// Build an HTTP 400 using the provider's context overflow error shape.
pub fn context_overflow_error(
    protocol: Protocol,
    actual_bytes: usize,
    limit_bytes: usize,
) -> HttpErrorSpec {
    let limit_tokens = (limit_bytes / 4).max(1);
    let actual_tokens = (actual_bytes / 4).max(limit_tokens + 1024);
    let body = match protocol {
        Protocol::AnthropicMessages => json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": format!("prompt is too long: {actual_tokens} tokens > {limit_tokens} maximum")
            }
        }),
        Protocol::OpenaiChatCompletions => json!({
            "error": {
                "type": "invalid_request_error",
                "code": "context_length_exceeded",
                "param": "messages",
                "message": format!(
                    "This model's maximum context length is {limit_tokens} tokens. However, your messages resulted in {actual_tokens} tokens. Please reduce the length of the messages."
                )
            }
        }),
        Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => json!({
            "error": {
                "type": "invalid_request_error",
                "code": "context_length_exceeded",
                "message": "Your input exceeds the context window of this model. Please adjust your input and try again."
            }
        }),
    };
    HttpErrorSpec::raw(400, body)
}

pub fn payload_too_large_error(protocol: Protocol) -> HttpErrorSpec {
    provider_error(
        protocol,
        413,
        "payload_too_large",
        None,
        "Request payload is too large",
    )
}

pub fn rate_limit_error(protocol: Protocol, retry_after_secs: Option<u64>) -> HttpErrorSpec {
    let mut spec = provider_error(
        protocol,
        429,
        "rate_limit_error",
        None,
        "Rate limit exceeded",
    );
    spec.retry_after_secs = retry_after_secs;
    spec
}

pub fn overloaded_error(protocol: Protocol) -> HttpErrorSpec {
    provider_error(
        protocol,
        503,
        "overloaded_error",
        None,
        "Service is overloaded",
    )
}

pub fn previous_response_not_found_error(protocol: Protocol, response_id: &str) -> HttpErrorSpec {
    provider_error(
        protocol,
        400,
        "invalid_request_error",
        Some("previous_response_not_found"),
        &format!("previous_response_id '{response_id}' not found"),
    )
}

fn provider_error(
    protocol: Protocol,
    status: u16,
    error_type: &str,
    code: Option<&str>,
    message: &str,
) -> HttpErrorSpec {
    let body = if protocol == Protocol::AnthropicMessages {
        json!({"type": "error", "error": {"type": error_type, "message": message}})
    } else {
        json!({"error": {"type": error_type, "message": message, "code": code}})
    };
    let mut spec = HttpErrorSpec::new(status, error_type, message);
    spec.code = code.map(str::to_owned);
    spec.raw_body = Some(body);
    spec
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_alternative_leaves_room_for_a_short_candidate() {
        let large = "x".repeat(270 * 1024);
        for keyword in ["anyOf", "oneOf"] {
            let schema = json!({keyword: [{"const": large}, {"const": "ok"}]});
            for seed in 0..16 {
                let value = try_synthesize_tool_arguments(
                    &schema,
                    &mut fastrand::Rng::with_seed(seed),
                    SynthMode::Valid,
                )
                .unwrap_or_else(|error| panic!("{keyword}, seed {seed}: {error}"));
                assert_eq!(value, json!("ok"), "{keyword}, seed {seed}");
            }
        }
    }

    #[test]
    fn repeated_defaults_and_generated_strings_share_the_byte_budget() {
        let mut rng = fastrand::Rng::with_seed(42);
        let default = "x".repeat(8 * 1024);
        let schema = |count| {
            json!({
                "type": "array", "minItems": count, "maxItems": count,
                "items": {"type": "string", "default": default}
            })
        };
        let fits = try_synthesize_tool_arguments(&schema(31), &mut rng, SynthMode::Valid).unwrap();
        assert_eq!(fits, json!(vec![default.clone(); 31]));

        let generated = json!({
            "type": "array", "minItems": 2, "maxItems": 2,
            "items": {
                "type": "array", "minItems": 64, "maxItems": 64,
                "items": {"type": "string", "minLength": 2048, "maxLength": 2048}
            }
        });
        for too_large in [schema(64), generated] {
            let error =
                try_synthesize_tool_arguments(&too_large, &mut rng, SynthMode::Valid).unwrap_err();
            assert!(
                error.contains("schema exceeded synthesis budget"),
                "{error}"
            );
        }

        let target = 300 * 1024;
        let explicit = try_synthesize_tool_arguments(
            &json!({"type": "object"}),
            &mut rng,
            SynthMode::HugePayload(target),
        )
        .unwrap();
        assert!(explicit["content"].as_str().unwrap().len() >= target);
    }

    #[test]
    fn synthesizes_intersections_and_exclusive_alternatives_through_local_refs() {
        let schema = json!({
            "$defs": {"base": {"type": "object", "required": ["mode"], "properties": {
                "mode": {"enum": ["shared", "read", "write"]}
            }}},
            "definitions": {"file": {"const": "src/file.rs"}},
            "allOf": [
                {"$ref": "#/$defs/base"},
                {"type": "object", "required": ["path"], "properties": {
                    "path": {"$ref": "#/definitions/file"}
                }},
                {"oneOf": [
                    {"properties": {"mode": {"enum": ["shared", "read"]}}},
                    {"properties": {"mode": {"enum": ["shared", "write"]}}}
                ]}
            ]
        });
        for seed in 0..16 {
            let value = try_synthesize_tool_arguments(
                &schema,
                &mut fastrand::Rng::with_seed(seed),
                SynthMode::Valid,
            )
            .unwrap();
            assert_eq!(value["path"], "src/file.rs");
            assert!(matches!(value["mode"].as_str(), Some("read" | "write")));
        }
    }

    #[test]
    fn recursive_branch_has_a_bounded_exit() {
        let schema = json!({
            "$defs": {"node": {"anyOf": [
                {"type": "object", "properties": {"child": {"$ref": "#/$defs/node"}}, "required": ["child"]},
                {"type": "null"}
            ]}},
            "$ref": "#/$defs/node"
        });
        let validator = jsonschema::validator_for(&schema).unwrap();
        for seed in 0..16 {
            let value = try_synthesize_tool_arguments(
                &schema,
                &mut fastrand::Rng::with_seed(seed),
                SynthMode::Valid,
            )
            .unwrap();
            assert!(validator.is_valid(&value), "{value}");
        }

        let cycle = json!({"$defs": {"loop": {"$ref": "#/$defs/loop"}}, "$ref": "#/$defs/loop"});
        assert!(
            try_synthesize_tool_arguments(
                &cycle,
                &mut fastrand::Rng::with_seed(0),
                SynthMode::Valid
            )
            .unwrap_err()
            .contains("synthesis budget")
        );
    }

    #[test]
    fn context_overflow_uses_the_provider_error_body() {
        for (protocol, expected) in [
            (
                Protocol::AnthropicMessages,
                json!({
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "message": "prompt is too long: 201024 tokens > 200000 maximum"
                    }
                }),
            ),
            (
                Protocol::OpenaiChatCompletions,
                json!({
                    "error": {
                        "type": "invalid_request_error",
                        "code": "context_length_exceeded",
                        "param": "messages",
                        "message": "This model's maximum context length is 200000 tokens. However, your messages resulted in 201024 tokens. Please reduce the length of the messages."
                    }
                }),
            ),
            (
                Protocol::OpenaiResponsesHttp,
                json!({
                    "error": {
                        "type": "invalid_request_error",
                        "code": "context_length_exceeded",
                        "message": "Your input exceeds the context window of this model. Please adjust your input and try again."
                    }
                }),
            ),
            (
                Protocol::OpenaiResponsesWs,
                json!({
                    "error": {
                        "type": "invalid_request_error",
                        "code": "context_length_exceeded",
                        "message": "Your input exceeds the context window of this model. Please adjust your input and try again."
                    }
                }),
            ),
        ] {
            let overflow = context_overflow_error(protocol, 800_004, 800_000);
            assert_eq!(overflow.status, 400);
            assert_eq!(overflow.raw_body.unwrap(), expected);
        }
        let overflow = context_overflow_error(Protocol::AnthropicMessages, 1_000_000, 800_000);
        assert_eq!(
            overflow.raw_body.unwrap()["error"]["message"],
            "prompt is too long: 250000 tokens > 200000 maximum"
        );
    }

    #[test]
    fn transport_size_rejection_is_distinct_from_model_context_overflow() {
        let openai = Protocol::OpenaiResponsesHttp;
        let anthropic = Protocol::AnthropicMessages;
        for protocol in [openai, anthropic] {
            let too_large = payload_too_large_error(protocol);
            assert_eq!(too_large.status, 413);
            assert_eq!(
                too_large.raw_body.unwrap()["error"]["type"],
                "payload_too_large"
            );
        }
        let limit = rate_limit_error(anthropic, Some(3));
        assert_eq!(limit.status, 429);
        assert_eq!(limit.retry_after_secs, Some(3));
        assert_eq!(limit.raw_body.unwrap()["error"]["type"], "rate_limit_error");
        let overloaded = overloaded_error(openai);
        assert_eq!(overloaded.status, 503);
        assert_eq!(
            overloaded.raw_body.unwrap()["error"]["type"],
            "overloaded_error"
        );
        let parent = previous_response_not_found_error(openai, "resp_missing");
        assert_eq!(parent.status, 400);
        assert_eq!(
            parent.raw_body.unwrap()["error"]["code"],
            "previous_response_not_found"
        );
    }
}
