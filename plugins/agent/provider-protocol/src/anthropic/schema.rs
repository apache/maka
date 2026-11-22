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

use serde_json::{Map, Value};

// These limits remain meaningful guidance for the model even when the
// constrained decoder cannot enforce them in its accepted schema dialect.
const DESCRIPTIVE_LIMITS: &[(&str, &str)] = &[
    ("minimum", "minimum"),
    ("maximum", "maximum"),
    ("exclusiveMinimum", "exclusive minimum"),
    ("exclusiveMaximum", "exclusive maximum"),
    ("multipleOf", "multiple of"),
    ("minLength", "min length"),
    ("maxLength", "max length"),
    ("pattern", "pattern"),
    ("minItems", "min items"),
    ("maxItems", "max items"),
    ("uniqueItems", "unique items"),
    ("minProperties", "min properties"),
    ("maxProperties", "max properties"),
    ("not", "not"),
];

/// Owns and rewrites a JSON Schema document into the constrained-decoding
/// dialect. Schema values are JSON by definition; request and stream state are
/// typed separately. Moving subtrees avoids copying large nested tool schemas.
pub fn constrained_schema(schema: Value) -> Value {
    let Value::Object(mut source) = schema else {
        return schema;
    };
    if let Some(reference) = source.remove("$ref").filter(|v| !v.is_null()) {
        return Value::Object(Map::from_iter([("$ref".into(), reference)]));
    }
    let mut result = Map::new();
    let description = describe_limits(&source);
    let object = source.get("type").is_some_and(|v| v == "object")
        || source.get("properties").is_some_and(|v| !v.is_null());
    let union = source
        .remove("anyOf")
        .filter(|v| !v.is_null())
        .or_else(|| source.remove("oneOf").filter(|v| !v.is_null()));
    if let Some(union) = union {
        result.insert("anyOf".into(), definitions(union));
    }
    for (keyword, value) in source {
        let converted = match keyword.as_str() {
            "default" | "const" => Some(value),
            _ if value.is_null() => None,
            "$schema" | "$id" | "title" | "description" | "enum" | "type" => Some(value),
            "allOf" | "items" => Some(definitions(value)),
            "definitions" | "$defs" | "properties" => match value {
                Value::Object(children) => Some(Value::Object(
                    children
                        .into_iter()
                        .map(|(name, value)| (name, constrained_schema(value)))
                        .collect(),
                )),
                _ => None,
            },
            "required" if object => Some(value),
            "format" if value.as_str().is_some_and(supported_format) => Some(value),
            _ => None,
        };
        if let Some(value) = converted {
            result.insert(keyword, value);
        }
    }
    if object {
        result.insert("additionalProperties".into(), Value::Bool(false));
    }
    if let Some(suffix) = description {
        let description = match result.remove("description") {
            Some(Value::String(prefix)) => format!("{prefix}\n{suffix}"),
            _ => suffix,
        };
        result.insert("description".into(), Value::String(description));
    }
    Value::Object(result)
}

fn definitions(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(constrained_schema).collect()),
        value => constrained_schema(value),
    }
}
fn supported_format(format: &str) -> bool {
    matches!(
        format,
        "date-time"
            | "time"
            | "date"
            | "duration"
            | "email"
            | "hostname"
            | "uri"
            | "ipv4"
            | "ipv6"
            | "uuid"
    )
}
fn describe_limits(schema: &Map<String, Value>) -> Option<String> {
    let mut limits = Vec::new();
    for (keyword, label) in DESCRIPTIVE_LIMITS {
        if let Some(value) = schema
            .get(*keyword)
            .filter(|v| !v.is_null() && **v != Value::Bool(false))
        {
            let value = match value {
                Value::String(value) => value.clone(),
                value => value.to_string(),
            };
            limits.push(format!("{label}: {value}"));
        }
    }
    if let Some(Value::String(format)) = schema.get("format")
        && !supported_format(format)
    {
        limits.push(format!("format: {format}"));
    }
    (!limits.is_empty()).then(|| format!("{}.", limits.join("; ")))
}
