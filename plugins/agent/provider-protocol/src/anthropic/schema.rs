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

/// Upper bound on schema objects an expansion may produce. Shared definitions
/// can multiply when inlined; past this bound the schema is sent unchanged.
const INLINE_LIMIT: usize = 10_000;

/// Expands document-local `$ref`s in a tool input schema. Some
/// Anthropic-compatible endpoints do not resolve references: the model sees an
/// opaque reference and encodes the argument as a JSON string instead of the
/// object the schema describes. Inlining is equivalent for endpoints that do
/// resolve them. Recursive, external and anchor references stay as written,
/// and the root definitions are kept whenever one of them remains.
pub fn inline_refs(schema: Value) -> Value {
    let Value::Object(source) = &schema else {
        return schema;
    };
    if !mentions_ref(&schema) {
        return schema;
    }
    let body = Value::Object(
        source
            .iter()
            .filter(|(keyword, _)| !DEFINITIONS.contains(&keyword.as_str()))
            .map(|(keyword, value)| (keyword.clone(), value.clone()))
            .collect(),
    );
    let mut expander = Expander {
        root: &schema,
        expanding: Vec::new(),
        budget: INLINE_LIMIT,
        kept_ref: false,
    };
    let Some(Value::Object(mut result)) = expander.schema(&body) else {
        return schema;
    };
    if expander.kept_ref {
        for keyword in DEFINITIONS {
            if let Some(definitions) = source.get(*keyword) {
                result.insert((*keyword).into(), definitions.clone());
            }
        }
    }
    Value::Object(result)
}

const DEFINITIONS: &[&str] = &["$defs", "definitions"];

struct Expander<'a> {
    root: &'a Value,
    expanding: Vec<&'a str>,
    budget: usize,
    kept_ref: bool,
}

impl<'a> Expander<'a> {
    fn schema(&mut self, value: &'a Value) -> Option<Value> {
        let Value::Object(source) = value else {
            return Some(value.clone());
        };
        self.budget = self.budget.checked_sub(1)?;
        let mut siblings = Map::new();
        for (keyword, value) in source {
            if keyword != "$ref" {
                siblings.insert(keyword.clone(), self.keyword(keyword, value)?);
            }
        }
        let Some(reference) = source.get("$ref") else {
            return Some(Value::Object(siblings));
        };
        let target = reference
            .as_str()
            .filter(|reference| !self.expanding.contains(reference))
            .and_then(|reference| Some((reference, reference.strip_prefix('#')?)))
            .filter(|(_, pointer)| pointer.is_empty() || pointer.starts_with('/'))
            .and_then(|(reference, pointer)| Some((reference, self.root.pointer(pointer)?)));
        let Some((reference, target)) = target else {
            self.kept_ref = true;
            siblings.insert("$ref".into(), reference.clone());
            return Some(Value::Object(siblings));
        };
        self.expanding.push(reference);
        let resolved = self.schema(target);
        self.expanding.pop();
        Some(Value::Object(merge(resolved?, siblings)))
    }

    fn keyword(&mut self, keyword: &str, value: &'a Value) -> Option<Value> {
        match keyword {
            "items"
            | "additionalItems"
            | "additionalProperties"
            | "unevaluatedItems"
            | "unevaluatedProperties"
            | "propertyNames"
            | "contains"
            | "not"
            | "if"
            | "then"
            | "else"
            | "allOf"
            | "anyOf"
            | "oneOf"
            | "prefixItems" => match value {
                Value::Array(values) => values
                    .iter()
                    .map(|value| self.schema(value))
                    .collect::<Option<_>>()
                    .map(Value::Array),
                value => self.schema(value),
            },
            "properties" | "patternProperties" | "dependentSchemas" | "$defs" | "definitions" => {
                match value {
                    Value::Object(children) => children
                        .iter()
                        .map(|(name, value)| Some((name.clone(), self.schema(value)?)))
                        .collect::<Option<_>>()
                        .map(Value::Object),
                    value => Some(value.clone()),
                }
            }
            // Literal values are data, even when they contain a `$ref` key.
            "const" | "default" | "enum" | "examples" => Some(value.clone()),
            _ => {
                // A reference left unexpanded here still needs its definitions.
                self.kept_ref |=
                    keyword == "$dynamicRef" || keyword == "$recursiveRef" || mentions_ref(value);
                Some(value.clone())
            }
        }
    }
}

/// Applies a reference's sibling keywords to the schema it resolved to. They
/// are merged when no keyword collides; otherwise both constrain the instance.
fn merge(resolved: Value, siblings: Map<String, Value>) -> Map<String, Value> {
    match resolved {
        Value::Object(mut resolved)
            if siblings
                .keys()
                .all(|keyword| !resolved.contains_key(keyword)) =>
        {
            resolved.extend(siblings);
            resolved
        }
        _ if siblings.is_empty() => match resolved {
            Value::Object(resolved) => resolved,
            resolved => Map::from_iter([("allOf".into(), Value::Array(vec![resolved]))]),
        },
        resolved => {
            let mut result = siblings;
            result.insert("allOf".into(), Value::Array(vec![resolved]));
            result
        }
    }
}

fn mentions_ref(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.contains_key("$ref") || map.values().any(mentions_ref),
        Value::Array(values) => values.iter().any(mentions_ref),
        _ => false,
    }
}
