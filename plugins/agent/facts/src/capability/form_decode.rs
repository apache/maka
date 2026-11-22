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

use super::{form::*, form_validation as validation};
use serde_json::Value;
use std::collections::HashSet;
type Result<T> = std::result::Result<T, &'static str>;
pub(super) fn invalid() -> &'static str {
    "Invalid Client Capability form"
}
pub(super) fn ensure(valid: bool) -> Result<()> {
    if valid { Ok(()) } else { Err(invalid()) }
}
pub(super) fn record<'a>(value: &'a Value, _: &str) -> Result<&'a serde_json::Map<String, Value>> {
    value.as_object().ok_or_else(invalid)
}
pub(super) fn shaped(
    r: &serde_json::Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> Result<()> {
    ensure(
        required.iter().all(|k| r.contains_key(*k))
            && r.keys()
                .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str())),
    )
}
fn exact(r: &serde_json::Map<String, Value>, required: &[&str]) -> Result<()> {
    shaped(r, required, &[])
}
fn count(value: &Value, _: &str) -> Result<u64> {
    let n = value
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0 && v.fract() == 0.0 && *v <= 9_007_199_254_740_991.0)
        .ok_or_else(invalid)?;
    Ok(n as u64)
}
pub(super) fn text(value: &Value, empty: bool) -> Result<String> {
    value
        .as_str()
        .filter(|s| empty || !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(invalid)
}
fn optional_text(value: &Value, key: &str) -> Result<Option<String>> {
    value.get(key).map(|v| text(v, true)).transpose()
}
pub(super) fn number(value: &Value) -> Result<f64> {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|v| if v == 0.0 { 0.0 } else { v })
        .ok_or_else(invalid)
}
fn optional_number(value: &Value, key: &str) -> Result<Option<f64>> {
    value.get(key).map(number).transpose()
}
fn optional_count(value: &Value, key: &str, max: usize) -> Result<Option<usize>> {
    value
        .get(key)
        .map(|v| {
            let n = count(v, key)?;
            ensure(n <= max as u64)?;
            usize::try_from(n).map_err(|_| invalid())
        })
        .transpose()
}
fn boolean(value: &Value) -> Result<bool> {
    value.as_bool().ok_or_else(invalid)
}
fn array(value: &Value) -> Result<&Vec<Value>> {
    value.as_array().ok_or_else(invalid)
}
pub(super) fn strings(value: &Value) -> Result<Vec<String>> {
    let values = array(value)?
        .iter()
        .map(|v| text(v, true))
        .collect::<Result<Vec<_>>>()?;
    ensure(values.iter().collect::<HashSet<_>>().len() == values.len())?;
    Ok(values)
}
fn options(value: &Value) -> Result<Vec<FormOption>> {
    let options = array(value)?
        .iter()
        .map(|v| {
            exact(record(v, "form option")?, &["value", "label"])?;
            Ok(FormOption {
                value: text(&v["value"], true)?,
                label: text(&v["label"], false)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    ensure(
        !options.is_empty()
            && options
                .iter()
                .map(|o| &o.value)
                .collect::<HashSet<_>>()
                .len()
                == options.len()
            && options
                .iter()
                .map(|o| &o.label)
                .collect::<HashSet<_>>()
                .len()
                == options.len(),
    )?;
    Ok(options)
}
pub(super) fn field(value: &Value) -> Result<FormField> {
    let r = record(value, "form field")?;
    let required = ["kind", "name", "label", "required"];
    let spec = match value["kind"].as_str() {
        Some("string") => {
            shaped(
                r,
                &required,
                &["description", "default", "minLength", "maxLength", "format"],
            )?;
            let min_length = optional_count(value, "minLength", usize::MAX)?;
            let max_length = optional_count(value, "maxLength", usize::MAX)?;
            ensure(!matches!((min_length,max_length), (Some(a),Some(b)) if a>b))?;
            let format = value
                .get("format")
                .map(|v| match v.as_str() {
                    Some("email") => Ok(FormFormat::Email),
                    Some("uri") => Ok(FormFormat::Uri),
                    Some("date") => Ok(FormFormat::Date),
                    Some("date-time") => Ok(FormFormat::DateTime),
                    _ => Err(invalid()),
                })
                .transpose()?;
            FormFieldSpec::String {
                default: optional_text(value, "default")?,
                min_length,
                max_length,
                format,
            }
        }
        Some(kind @ ("number" | "integer")) => {
            shaped(
                r,
                &required,
                &["description", "default", "minimum", "maximum"],
            )?;
            let minimum = optional_number(value, "minimum")?;
            let maximum = optional_number(value, "maximum")?;
            ensure(!matches!((minimum,maximum), (Some(a),Some(b)) if a>b))?;
            let default = optional_number(value, "default")?;
            if kind == "number" {
                FormFieldSpec::Number {
                    default,
                    minimum,
                    maximum,
                }
            } else {
                FormFieldSpec::Integer {
                    default,
                    minimum,
                    maximum,
                }
            }
        }
        Some("boolean") => {
            shaped(r, &required, &["description", "default"])?;
            FormFieldSpec::Boolean {
                default: value.get("default").map(boolean).transpose()?,
            }
        }
        Some(kind @ ("single_select" | "multi_select")) => {
            let required = ["kind", "name", "label", "required", "options"];
            let optional: &[&str] = if kind == "single_select" {
                &["description", "default"]
            } else {
                &["description", "default", "minItems", "maxItems"]
            };
            shaped(r, &required, optional)?;
            let options = options(&value["options"])?;
            if kind == "single_select" {
                FormFieldSpec::SingleSelect {
                    options,
                    default: optional_text(value, "default")?,
                }
            } else {
                let min_items = optional_count(value, "minItems", options.len())?;
                let max_items = optional_count(value, "maxItems", options.len())?;
                ensure(!matches!((min_items,max_items), (Some(a),Some(b)) if a>b))?;
                FormFieldSpec::MultiSelect {
                    options,
                    default: value.get("default").map(strings).transpose()?,
                    min_items,
                    max_items,
                }
            }
        }
        _ => return Err(invalid()),
    };
    let field = FormField {
        name: text(&value["name"], false)?,
        label: text(&value["label"], false)?,
        required: boolean(&value["required"])?,
        description: optional_text(value, "description")?,
        spec,
    };
    if let Some(default) = validation::default_value(&field.spec) {
        ensure(validation::valid(&field.spec, &default))?;
    }
    Ok(field)
}
pub fn decode_input(value: &Value) -> Result<FormInput> {
    exact(
        record(value, "form request")?,
        &["message", "requester", "fields"],
    )?;
    let requester = &value["requester"];
    shaped(record(requester, "form requester")?, &["name"], &["source"])?;
    let fields = array(&value["fields"])?
        .iter()
        .map(field)
        .collect::<Result<Vec<_>>>()?;
    ensure(fields.iter().map(|f| &f.name).collect::<HashSet<_>>().len() == fields.len())?;
    let input = FormInput {
        message: text(&value["message"], false)?,
        requester: FormRequester {
            name: text(&requester["name"], false)?,
            source: optional_text(requester, "source")?,
        },
        fields,
    };
    validation::admit(&input)?;
    Ok(input)
}

pub use super::form_result_decode::decode_form_result;
