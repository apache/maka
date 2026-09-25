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

use crate::ToolDefinition;
use serde_json::Value;

/// A reading aid generated from the authoritative schema, not a validator.
/// Bounds apply to traversal as well as output: recursive refs and wide DAGs
/// cannot turn a small catalog into an unbounded prompt.
pub(super) fn render(definitions: &[ToolDefinition]) -> String {
    let mut output = String::from("declare const tools: {\n");
    for tool in definitions {
        for line in tool.description.lines() {
            output.push_str("// ");
            output.push_str(line);
            output.push('\n');
        }
        let name = maka_js_runtime::tool_identifier(&tool.name);
        let mut renderer = Renderer {
            root: &tool.input_schema,
            remaining: 32_000,
            nodes: 512,
        };
        let input = renderer.schema(&tool.input_schema, 0);
        let result = tool
            .output_schema
            .as_ref()
            .map(|schema| {
                Renderer {
                    root: schema,
                    remaining: 32_000,
                    nodes: 512,
                }
                .schema(schema, 0)
            })
            .unwrap_or_else(|| "unknown".into());
        output.push_str(&format!("{name}(input: {input}): Promise<{result}>;\n"));
    }
    output.push_str("};\n");
    output
}

struct Renderer<'a> {
    root: &'a Value,
    remaining: usize,
    nodes: usize,
}

impl Renderer<'_> {
    fn schema(&mut self, value: &Value, depth: usize) -> String {
        if depth > 12 || self.nodes == 0 || self.remaining == 0 {
            return "unknown".into();
        }
        self.nodes -= 1;
        // A nested resource changes the base URI. Do not resolve its fragments
        // against the outer schema or fetch arbitrary remote schemas.
        if depth > 0 && value.get("$id").is_some() {
            return "unknown".into();
        }
        let mut constraints = Vec::new();
        if let Some(pointer) = value
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|s| s.strip_prefix('#'))
            && let Some(target) = self.root.pointer(pointer)
        {
            constraints.push(self.schema(target, depth + 1));
        }
        if let Some(literal) = value.get("const") {
            constraints.push(self.literal(literal));
        } else if let Some(values) = value.get("enum").and_then(Value::as_array) {
            let types: Vec<_> = values.iter().map(|v| self.literal(v)).collect();
            constraints.push(if types.is_empty() {
                "never".into()
            } else {
                types.join(" | ")
            });
        }
        for (key, separator) in [("anyOf", " | "), ("oneOf", " | "), ("allOf", " & ")] {
            if let Some(variants) = value.get(key).and_then(Value::as_array) {
                let types: Vec<_> = variants
                    .iter()
                    .map(|v| format!("({})", self.schema(v, depth + 1)))
                    .collect();
                if !types.is_empty() {
                    constraints.push(types.join(separator));
                }
            }
        }
        match value.get("type") {
            Some(Value::String(kind)) => constraints.push(self.kind(value, kind, depth)),
            Some(Value::Array(kinds)) => constraints.push(
                kinds
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|kind| self.kind(value, kind, depth))
                    .collect::<Vec<_>>()
                    .join(" | "),
            ),
            _ if value.get("properties").is_some()
                || value.get("additionalProperties").is_some() =>
            {
                constraints.push(self.kind(value, "object", depth))
            }
            _ => {}
        }
        let result = if value == &Value::Bool(false) {
            "never".into()
        } else if constraints.is_empty() {
            "unknown".into()
        } else if constraints.len() == 1 {
            constraints.remove(0)
        } else {
            constraints
                .into_iter()
                .map(|s| format!("({s})"))
                .collect::<Vec<_>>()
                .join(" & ")
        };
        if result.len() > self.remaining {
            self.remaining = 0;
            "unknown".into()
        } else {
            self.remaining -= result.len();
            result
        }
    }

    fn literal(&mut self, value: &Value) -> String {
        // Object/array JSON is a value expression, not a TypeScript literal type.
        let result = match value {
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => value.to_string(),
            _ => "unknown".into(),
        };
        if result.len() > self.remaining {
            self.remaining = 0;
            "unknown".into()
        } else {
            self.remaining -= result.len();
            result
        }
    }

    fn kind(&mut self, schema: &Value, kind: &str, depth: usize) -> String {
        match kind {
            "string" | "boolean" | "null" => kind.into(),
            "number" | "integer" => "number".into(),
            "array" => {
                let item = self.schema(&schema["items"], depth + 1);
                if let Some(prefix) = schema.get("prefixItems").and_then(Value::as_array) {
                    let mut parts: Vec<_> =
                        prefix.iter().map(|v| self.schema(v, depth + 1)).collect();
                    if item != "never" {
                        parts.push(format!("...Array<{item}>"));
                    }
                    format!("[{}]", parts.join(", "))
                } else {
                    format!("Array<{item}>")
                }
            }
            "object" => {
                let mut properties = Vec::new();
                if let Some(fields) = schema.get("properties").and_then(Value::as_object) {
                    for (name, value) in fields {
                        let required = schema["required"]
                            .as_array()
                            .is_some_and(|values| values.iter().any(|v| v == name));
                        if let Some(description) = value.get("description").and_then(Value::as_str)
                        {
                            for line in description.lines().take(20) {
                                properties.push(format!("// {line}\n"));
                            }
                        }
                        let name = serde_json::to_string(name).unwrap();
                        properties.push(format!(
                            "{name}{}: {};\n",
                            if required { "" } else { "?" },
                            self.schema(value, depth + 1)
                        ));
                    }
                }
                let object = format!("{{\n{}}}", properties.join(""));
                match schema.get("additionalProperties") {
                    Some(Value::Bool(false)) => object,
                    None | Some(Value::Bool(true)) => format!("{object} & Record<string, unknown>"),
                    Some(value) => format!(
                        "{object} & Record<string, {}>",
                        self.schema(value, depth + 1)
                    ),
                }
            }
            _ => "unknown".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn references_and_literal_property_names_come_from_the_schema() {
        let tool = ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: "a-b".into(),
            description: "Choose".into(),
            input_schema: json!({"type":"object","properties":{"x-y":{"$ref":"#/$defs/Choice"}},
                "required":["x-y"],"additionalProperties":false,"$defs":{"Choice":{"enum":["a","b",null]}}}),
        };
        let text = render(&[tool]);
        assert!(text.contains("a_b(input:"));
        assert!(text.contains("\"x-y\": \"a\" | \"b\" | null;"));
    }

    #[test]
    fn recursive_schema_has_bounded_render_work() {
        let schema = json!({"anyOf":[{"$ref":"#"},{"$ref":"#"}]});
        let mut renderer = Renderer {
            root: &schema,
            remaining: 32_000,
            nodes: 512,
        };
        assert!(renderer.schema(&schema, 0).len() <= 32_000);
    }
}
