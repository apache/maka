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

use std::collections::BTreeMap;

use arrow::array::{Array, Float64Array, Float64Builder, StringArray, StringBuilder};
use arrow::compute::kernels::aggregate::{max, min, sum};
use maka_plugin_runtime::{export_plugin, response, Response};
use serde_json::{json, Value};

static MANIFEST: &[u8] = br#"{
  "abiVersion":1,
  "packageId":"arrow-data-analysis",
  "contributions":[{
    "id":"arrow-analysis",
    "kind":"tool",
    "tool":{
      "name":"arrow_analyze",
      "displayName":"Arrow Analyze",
      "description":"Analyze numeric JSON columns with Rust Apache Arrow Compute.",
      "parameters":{
        "type":"object",
        "required":["operation","columns"],
        "properties":{
          "operation":{"type":"string","enum":["summary","group_sum"]},
          "column":{"type":"string","description":"Numeric column to analyze."},
          "by":{"type":"string","description":"String column used to group rows."},
          "columns":{"type":"object","description":"Columnar JSON data. Numbers and null are accepted for numeric columns."}
        },
        "additionalProperties":false
      }
    }
  }]
}"#;

fn invoke(input: &[u8]) -> Response {
    let output = match serde_json::from_slice::<Value>(input) {
        Ok(envelope) => {
            let request = if envelope.get("kind").and_then(Value::as_str) == Some("tool") {
                envelope.get("input").unwrap_or(&envelope)
            } else {
                &envelope
            };
            analyze(request)
        }
        Err(error) => error_result(format!("invalid JSON input: {error}")),
    };
    let encoded = serde_json::to_vec(&output).unwrap_or_else(|_| {
        br#"{"ok":false,"error":"failed to encode Arrow result"}"#.to_vec()
    });
    response(&encoded)
}

fn analyze(request: &Value) -> Value {
    let operation = match request.get("operation").and_then(Value::as_str) {
        Some(value @ ("summary" | "group_sum")) => value,
        _ => return error_result("operation must be summary or group_sum".to_owned()),
    };
    let columns = match request.get("columns") {
        Some(Value::Object(value)) => value,
        _ => return error_result("columns must be an object of arrays".to_owned()),
    };
    let column_name = match request.get("column").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value,
        _ => return error_result("column is required".to_owned()),
    };
    let values = match columns.get(column_name) {
        Some(Value::Array(value)) => value,
        _ => return error_result(format!("numeric column {column_name:?} is missing")),
    };
    let numeric = match make_numeric_array(values) {
        Ok(value) => value,
        Err(error) => return error_result(error),
    };

    if operation == "summary" {
        return summary_result(column_name, &numeric);
    }

    let by_name = match request.get("by").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value,
        _ => return error_result("by is required for group_sum".to_owned()),
    };
    let groups = match columns.get(by_name) {
        Some(Value::Array(value)) => value,
        _ => return error_result(format!("group column {by_name:?} is missing")),
    };
    if groups.len() != values.len() {
        return error_result("all columns must have the same row count".to_owned());
    }
    group_sum_result(column_name, by_name, groups, &numeric)
}

fn make_numeric_array(values: &[Value]) -> Result<Float64Array, String> {
    let mut builder = Float64Builder::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        match value {
            Value::Null => builder.append_null(),
            Value::Number(number) => builder.append_value(
                number
                    .as_f64()
                    .ok_or_else(|| format!("numeric value at row {index} is not finite"))?,
            ),
            _ => return Err(format!("numeric column contains a non-number at row {index}")),
        }
    }
    Ok(builder.finish())
}

fn summary_result(column: &str, values: &Float64Array) -> Value {
    json!({
        "ok": true,
        "operation": "summary",
        "column": column,
        "rows": values.len(),
        "valid": values.len() - values.null_count(),
        "nulls": values.null_count(),
        "sum": sum(values),
        "mean": average(values),
        "min": min(values),
        "max": max(values)
    })
}

fn group_sum_result(
    column: &str,
    by: &str,
    groups: &[Value],
    values: &Float64Array,
) -> Value {
    let mut grouped = BTreeMap::<String, Vec<usize>>::new();
    let group_array = match make_string_array(groups) {
        Ok(value) => value,
        Err(error) => return error_result(error),
    };
    for index in 0..group_array.len() {
        if group_array.is_null(index) {
            return error_result(format!("group column {by:?} contains null at row {index}"));
        }
        grouped
            .entry(group_array.value(index).to_owned())
            .or_default()
            .push(index);
    }

    let mut result = BTreeMap::new();
    for (group, indices) in grouped {
        let mut builder = Float64Builder::with_capacity(indices.len());
        for index in indices {
            if values.is_null(index) {
                builder.append_null();
            } else {
                builder.append_value(values.value(index));
            }
        }
        let group_values = builder.finish();
        result.insert(
            group,
            json!({
                "sum": sum(&group_values),
                "mean": average(&group_values),
                "rows": group_values.len(),
                "valid": group_values.len() - group_values.null_count(),
                "nulls": group_values.null_count()
            }),
        );
    }
    json!({
        "ok": true,
        "operation": "group_sum",
        "column": column,
        "by": by,
        "groups": result
    })
}

fn make_string_array(values: &[Value]) -> Result<StringArray, String> {
    let mut builder = StringBuilder::new();
    for (index, value) in values.iter().enumerate() {
        match value {
            Value::String(value) => builder.append_value(value),
            Value::Null => builder.append_null(),
            _ => return Err(format!("group column contains a non-string at row {index}")),
        }
    }
    Ok(builder.finish())
}

fn error_result(error: String) -> Value {
    json!({"ok": false, "error": error})
}

fn average(values: &Float64Array) -> Option<f64> {
    let valid = values.len() - values.null_count();
    (valid > 0).then(|| sum(values).unwrap_or_default() / valid as f64)
}

export_plugin!(MANIFEST, invoke);
