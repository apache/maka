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
const READ_RETURN_TS: &str = r#"
  | { kind: "completed"; value: { content: string; offset: number; returnedLines: number; totalLines: number; partialLine?: boolean; next: { path: string } | null; metadata?: Record<string, unknown> } }
  | { kind: "image"; mimeType: string; ref: { kind: "session_file"; sessionId: string; relativePath: string }; detail?: "auto" | "low" | "high" | "original" }
  | { kind: "failed"; message: string }"#;
const SHELL_RETURN_TS: &str = r#"({ "kind": "completed"; "value": { "kind": string; "status": string; "exitCode"?: number | null; "ref"?: string; "output"?: { "stdout": string; "stderr": string; "stdoutTruncated": boolean; "stderrTruncated": boolean } } }) | ({ "kind": "failed"; "message": string })"#;

fn render_js_member(
    tool: &ToolDefinition,
    output_max_depth: usize,
    output_remaining: usize,
    output_nodes: usize,
) -> String {
    let mut output = String::new();
    for line in tool.description.lines() {
        output.push_str("// ");
        output.push_str(line);
        output.push('\n');
    }
    let name = maka_js_runtime::tool_identifier(&tool.name);
    let mut renderer = Renderer {
        root: &tool.input_schema,
        max_depth: 12,
        remaining: 32_000,
        nodes: 512,
    };
    let input = renderer.schema(&tool.input_schema, 0);
    let result = match tool.name.as_str() {
        "Read" if tool.output_schema.is_none() => READ_RETURN_TS.into(),
        "Shell" => SHELL_RETURN_TS.into(),
        _ => tool
            .output_schema
            .as_ref()
            .map(|schema| {
                Renderer {
                    root: schema,
                    max_depth: output_max_depth,
                    remaining: output_remaining,
                    nodes: output_nodes,
                }
                .schema(schema, 0)
            })
            .unwrap_or_else(|| "unknown".into()),
    };
    output.push_str(&format!("{name}(input: {input}): Promise<{result}>;\n"));
    output
}

pub(super) fn render<'a>(definitions: impl IntoIterator<Item = &'a ToolDefinition>) -> String {
    let mut output = String::from("declare const tools: {\n");
    for tool in definitions {
        output.push_str(&render_js_member(tool, 12, 32_000, 512));
    }
    output.push_str("};\n");
    output
}

pub(super) fn render_entry(tool: &ToolDefinition) -> String {
    render_js_member(tool, 4, 1_800, 56)
}

/// Python callers consume the same authoritative JSON schemas, including
/// references and constraints that Python type annotations cannot express.
pub(super) fn python<'a>(definitions: impl IntoIterator<Item = &'a ToolDefinition>) -> String {
    let mut output = String::new();
    for tool in definitions {
        output.push_str(&python_entry(tool, false));
    }
    output
}

pub(super) fn python_entry(tool: &ToolDefinition, compact_output: bool) -> String {
    let mut output = String::new();
    for line in tool.description.lines() {
        output.push_str("# ");
        output.push_str(line);
        output.push('\n');
    }
    output.push_str(&format!(
        "# await tools.{}(input)\n# Input JSON Schema: {}\n",
        maka_python_runtime::tool_identifier(&tool.name),
        tool.input_schema
    ));
    if !compact_output && let Some(schema) = &tool.output_schema {
        output.push_str(&format!("# Output JSON Schema: {schema}\n"));
    }
    output
}

struct Renderer<'a> {
    root: &'a Value,
    max_depth: usize,
    remaining: usize,
    nodes: usize,
}

impl Renderer<'_> {
    fn schema(&mut self, value: &Value, depth: usize) -> String {
        if depth > self.max_depth || self.nodes == 0 || self.remaining == 0 {
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
        let mut has_literal_or_enum = false;
        if let Some(literal) = value.get("const") {
            has_literal_or_enum = true;
            constraints.push(self.literal(literal));
        } else if let Some(values) = value.get("enum").and_then(Value::as_array) {
            has_literal_or_enum = true;
            let enum_has_null = values.iter().any(Value::is_null);
            let mut types: Vec<_> = values.iter().map(|v| self.literal(v)).collect();
            if !enum_has_null
                && value
                    .get("type")
                    .and_then(Value::as_array)
                    .is_some_and(|kinds| kinds.iter().any(|k| k.as_str() == Some("null")))
            {
                types.push("null".into());
            }
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
        if !has_literal_or_enum {
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
    fn literal_and_enum_do_not_emit_redundant_string_intersections_and_entries_omit_wrapper() {
        let tool = ToolDefinition {
            provider: None,
            freeform: None,
            name: "SessionManage".into(),
            description: "Manage a Session.".into(),
            input_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["action"],
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["archive", "restore", "remove"]
                    },
                    "tag": {
                        "type": "string",
                        "const": "exact"
                    }
                }
            }),
            output_schema: Some(json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["kind"],
                "properties": {
                    "kind": { "const": "completed", "type": "string" }
                }
            })),
        };
        let entry = render_entry(&tool);
        assert!(!entry.contains("declare const tools"), "{entry}");
        assert!(!entry.contains("& (string)"), "{entry}");
        assert!(
            entry.contains(r#""archive" | "restore" | "remove""#),
            "{entry}"
        );
        assert!(entry.contains(r#""kind": "completed""#), "{entry}");

        let read_tool = ToolDefinition {
            provider: None,
            freeform: None,
            name: "Read".into(),
            description: "Read files and Maka resources.".into(),
            input_schema: json!({"type": "object", "additionalProperties": false}),
            output_schema: None,
        };
        let read_entry = render_entry(&read_tool);
        assert!(read_entry.contains("returnedLines: number"), "{read_entry}");
        assert!(
            read_entry.contains(r#"| { kind: "image"; mimeType: string; ref:"#),
            "{read_entry}"
        );
    }
}
