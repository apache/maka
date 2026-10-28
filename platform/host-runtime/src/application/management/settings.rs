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

use super::*;
use maka_plugin_core::deployment::management::{
    InstanceConfigure, InstanceSettingsPage, InstanceSettingsRead, SettingChange, SettingField,
    SettingKind, SettingValue,
};
use std::collections::BTreeSet;

impl Manager {
    pub(super) async fn read_settings(&self, input: Value) -> Result<Value> {
        let request: InstanceSettingsRead =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        if request.source.state_domain != self.source.state_domain
            || request.source.deployment != self.source.deployment
        {
            return Err("foreign managed deployment source".into());
        }
        check_path(&request.path, true)?;
        let _read = self.writes.lock().await;
        let loaded = self
            .store
            .load_application_at(&request.source)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("managed source not found")?;
        let plan = loaded.plan();
        let instance = plan
            .instances()
            .get(&request.instance)
            .ok_or("managed instance unavailable")?;
        let root_schema = match instance.entry.as_ref() {
            Some(maka_plugin_core::plan::InstanceEntry::Host(entry)) => &entry.configuration,
            Some(maka_plugin_core::plan::InstanceEntry::Ui(entry)) => &entry.configuration,
            None => return Err("open an executable child to configure it".into()),
        };
        let (schema, current) = at(root_schema, &instance.configuration, &request.path)?;
        let mut fields = fields(schema, root_schema, current)?;
        if let Some(after) = &request.after {
            let index = fields
                .iter()
                .position(|f| &f.key == after)
                .ok_or("settings cursor unavailable")?;
            fields.drain(..=index);
        }
        let (fields, next) = settings_page(fields)?;
        serde_json::to_value(InstanceSettingsPage {
            source: request.source,
            instance: request.instance,
            path: request.path,
            fields,
            next,
        })
        .map_err(|e| e.to_string())
    }

    pub(super) async fn configure(&self, input: Value) -> Result<Value> {
        let request: InstanceConfigure =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        let _write = self.writes.lock().await;
        let metadata = self.metadata().await?;
        if request.expected_revision != metadata.source.reference.revision {
            return conflict(metadata.source.reference.revision);
        }
        let loaded = self
            .store
            .load_application_at(&metadata.source.reference)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("managed source not found")?;
        let (mut source, packages, plan, _) = loaded.into_parts();
        let Some(instance) = plan
            .instances()
            .get(&request.instance)
            .filter(|i| i.entry.is_some())
        else {
            return rejected(ManagementRejection::InstanceUnavailable);
        };
        let mut configuration = instance.configuration.clone();
        let changes = match apply(&mut configuration, &request.changes) {
            Ok(changes) => changes,
            Err(error) => return rejected_diagnostic(ManagementRejection::InvalidSource, error),
        };
        let [root, path @ ..] = instance.path.as_slice() else {
            return Err("invalid managed path".into());
        };
        let node = source
            .input
            .instances
            .get_mut(root)
            .ok_or("managed root disappeared")?;
        if path.is_empty() {
            for key in changes {
                node.configuration.parameters.remove(&key);
                match configuration.get(&key) {
                    Some(value) => {
                        node.configuration.values.insert(key, value.clone());
                    }
                    None => {
                        node.configuration.values.remove(&key);
                    }
                }
            }
        } else {
            // Existing composition overrides replace top-level fields. Editing a nested
            // leaf freezes only that containing field, not any unrelated binding or value.
            if changes.iter().any(|key| configuration.get(key).is_none()) {
                return rejected_diagnostic(
                    ManagementRejection::InvalidSource,
                    "an inherited field cannot be removed from this instance".into(),
                );
            }
            let index = node.overrides.iter().position(|patch| patch.path == path);
            let patch = if let Some(index) = index {
                &mut node.overrides[index]
            } else {
                node.overrides
                    .push(maka_plugin_core::composition::Override {
                        path: path.to_vec(),
                        ..Default::default()
                    });
                node.overrides.last_mut().unwrap()
            };
            for key in changes {
                patch
                    .configuration
                    .insert(key.clone(), configuration[&key].clone());
            }
        }
        self.commit(
            request.expected_revision,
            source.input,
            source.remote_exports,
            packages,
            |source| source,
        )
        .await
    }
}
// Local $refs can repeat a large enum across many fields. Bound the encoded
// projection as well as its row count, leaving room for source/path metadata.
pub(super) fn settings_page(
    mut fields: Vec<SettingField>,
) -> Result<(Vec<SettingField>, Option<String>)> {
    let mut bytes = 0;
    let mut count = 0;
    for field in fields.iter().take(8) {
        let size = serde_json::to_vec(field).map_err(|e| e.to_string())?.len();
        if count > 0 && size > (448usize * 1024).saturating_sub(bytes) {
            break;
        }
        bytes = bytes
            .checked_add(size)
            .ok_or("settings page length overflow")?;
        count += 1;
    }
    let more = fields.len() > count;
    fields.truncate(count);
    let next = more.then(|| fields.last().unwrap().key.clone());
    Ok((fields, next))
}
pub(super) fn check_path(path: &[String], root: bool) -> Result<()> {
    if !root && path.is_empty() {
        return Err("invalid settings path".into());
    }
    Ok(())
}
fn scalar(value: &Value) -> Option<SettingValue> {
    Some(match value {
        Value::String(text) => SettingValue::Text { text: text.clone() },
        Value::Number(number) => SettingValue::Number {
            text: number.to_string(),
        },
        Value::Bool(value) => SettingValue::Boolean { value: *value },
        Value::Null => SettingValue::Null,
        _ => return None,
    })
}
fn json(value: &SettingValue) -> Result<Value> {
    Ok(match value {
        SettingValue::Text { text } => Value::String(text.clone()),
        SettingValue::Number { text } => {
            let value: Value =
                serde_json::from_str(text).map_err(|e| format!("invalid number: {e}"))?;
            if !value.is_number() {
                return Err("number required".into());
            }
            value
        }
        SettingValue::Boolean { value } => Value::Bool(*value),
        SettingValue::Null => Value::Null,
    })
}
pub(super) fn apply(
    configuration: &mut Value,
    changes: &[SettingChange],
) -> Result<BTreeSet<String>> {
    if changes.is_empty() {
        return Err("settings changes must not be empty".into());
    }
    let mut touched = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for change in changes {
        check_path(&change.path, false)?;
        if !paths.insert(change.path.clone()) {
            return Err("duplicate setting change".into());
        }
        touched.insert(change.path[0].clone());
        let (key, parents) = change.path.split_last().unwrap();
        let mut current = &mut *configuration;
        for part in parents {
            current = match current {
                Value::Object(map) => {
                    if change.value.is_some() {
                        map.entry(part)
                            .or_insert_with(|| Value::Object(Default::default()))
                    } else {
                        map.get_mut(part).ok_or("settings parent unavailable")?
                    }
                }
                Value::Array(items) => items
                    .get_mut(index(part)?)
                    .ok_or("settings item unavailable")?,
                _ => return Err("settings parent is not a group".into()),
            };
        }
        let value = change.value.as_ref().map(json).transpose()?;
        match current {
            Value::Object(map) => {
                if let Some(value) = value {
                    map.insert(key.clone(), value);
                } else {
                    map.remove(key);
                }
            }
            Value::Array(items) => {
                let index = index(key)?;
                if index >= items.len() {
                    return Err("settings item unavailable".into());
                }
                if let Some(value) = value {
                    items[index] = value;
                } else {
                    return Err("array membership must be changed as a group".into());
                }
            }
            _ => return Err("settings parent is not a group".into()),
        }
    }
    Ok(touched)
}
fn index(key: &str) -> Result<usize> {
    let index = key.parse::<usize>().map_err(|_| "invalid settings index")?;
    if index.to_string() != key {
        return Err("invalid settings index".into());
    }
    Ok(index)
}
// Schema is a display hint; admission validates the entire resulting source.
// Resolve only local references and the branch selected by the actual value.
pub(super) fn resolved<'a>(
    mut schema: &'a Value,
    root: &'a Value,
    value: Option<&Value>,
) -> &'a Value {
    let mut visited = BTreeSet::new();
    while visited.insert(std::ptr::from_ref(schema)) {
        if let Some(reference) = schema
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|r| r.strip_prefix('#'))
            .and_then(|r| root.pointer(r))
        {
            schema = reference;
        } else if let Some(branches) = schema
            .get("oneOf")
            .or_else(|| schema.get("anyOf"))
            .and_then(Value::as_array)
        {
            let Some(branch) = branches
                .iter()
                .find(|branch| matches_value(branch, root, value))
            else {
                break;
            };
            schema = branch;
        } else {
            break;
        }
    }
    schema
}
fn matches_value(schema: &Value, root: &Value, value: Option<&Value>) -> bool {
    let schema = if let Some(reference) = schema
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|r| r.strip_prefix('#'))
        .and_then(|r| root.pointer(r))
    {
        reference
    } else {
        schema
    };
    if let Some(value) = value {
        if let Some(constant) = schema.get("const") {
            return value == constant;
        }
        if let Some(properties) = schema.get("properties").and_then(Value::as_object)
            && properties.iter().any(|(key, field)| {
                field
                    .get("const")
                    .is_some_and(|v| value.get(key) != Some(v))
            })
        {
            return false;
        }
        match schema.get("type").and_then(Value::as_str) {
            Some("null") => value.is_null(),
            Some("object") => value.is_object(),
            Some("array") => value.is_array(),
            Some("string") => value.is_string(),
            Some("boolean") => value.is_boolean(),
            Some("number" | "integer") => value.is_number(),
            _ => true,
        }
    } else {
        schema.get("type").and_then(Value::as_str) != Some("null")
    }
}
pub(super) fn at<'a>(
    root: &'a Value,
    configuration: &'a Value,
    path: &[String],
) -> Result<(&'a Value, Option<&'a Value>)> {
    let mut schema = root;
    let mut value = Some(configuration);
    for part in path {
        schema = resolved(schema, root, value);
        if value.is_some_and(Value::is_array) {
            let i = index(part)?;
            value = value.and_then(|v| v.get(i));
            schema = schema
                .get("prefixItems")
                .and_then(|v| v.get(i))
                .or_else(|| schema.get("items"))
                .unwrap_or(&Value::Null);
        } else {
            value = value.and_then(|v| v.get(part));
            schema = schema
                .get("properties")
                .and_then(|p| p.get(part))
                .unwrap_or(&Value::Null);
        }
        if value.is_none() && schema.is_null() {
            return Err("settings path unavailable".into());
        }
    }
    Ok((resolved(schema, root, value), value))
}
pub(super) fn fields(
    schema: &Value,
    root: &Value,
    value: Option<&Value>,
) -> Result<Vec<SettingField>> {
    if let Some(items) = value.and_then(Value::as_array) {
        return Ok(items
            .iter()
            .enumerate()
            .map(|(i, value)| {
                let item = schema
                    .get("prefixItems")
                    .and_then(|v| v.get(i))
                    .or_else(|| schema.get("items"))
                    .unwrap_or(&Value::Null);
                field(i.to_string(), item, root, Some(value), true)
            })
            .collect());
    }
    if !value.is_none_or(Value::is_object) {
        return Err("settings path is not a group".into());
    }
    let properties = schema.get("properties").and_then(Value::as_object);
    let values = value.and_then(Value::as_object);
    let keys: BTreeSet<_> = properties
        .into_iter()
        .flat_map(|v| v.keys())
        .chain(values.into_iter().flat_map(|v| v.keys()))
        .collect();
    Ok(keys
        .into_iter()
        .map(|key| {
            let required = schema
                .get("required")
                .and_then(Value::as_array)
                .is_some_and(|v| v.iter().any(|v| v.as_str() == Some(key)));
            field(
                key.clone(),
                properties.and_then(|p| p.get(key)).unwrap_or(&Value::Null),
                root,
                values.and_then(|v| v.get(key)),
                required,
            )
        })
        .collect())
}
fn field(
    key: String,
    schema: &Value,
    root: &Value,
    value: Option<&Value>,
    required: bool,
) -> SettingField {
    let original = schema;
    let schema = resolved(schema, root, value.filter(|value| !value.is_null()));
    let kind = match value {
        Some(Value::Object(_)) => SettingKind::Object,
        Some(Value::Array(_)) => SettingKind::Array,
        Some(Value::String(_)) => SettingKind::Text,
        Some(Value::Number(_)) => SettingKind::Number,
        Some(Value::Bool(_)) => SettingKind::Boolean,
        _ => match schema.get("type").and_then(Value::as_str) {
            Some("object") => SettingKind::Object,
            Some("array") => SettingKind::Array,
            Some("string") => SettingKind::Text,
            Some("number" | "integer") => SettingKind::Number,
            Some("boolean") => SettingKind::Boolean,
            Some("null") => SettingKind::Null,
            _ => SettingKind::Unsupported,
        },
    };
    let mut options: Vec<SettingValue> = schema
        .get("enum")
        .and_then(Value::as_array)
        .map(|v| v.iter().filter_map(scalar).collect())
        .unwrap_or_default();
    let label = original
        .get("title")
        .or_else(|| schema.get("title"))
        .and_then(Value::as_str)
        .unwrap_or(&key)
        .to_owned();
    let description = original
        .get("description")
        .or_else(|| schema.get("description"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let nullable = value.is_some_and(Value::is_null)
        || schema.get("type").and_then(Value::as_str) == Some("null")
        || original
            .get("type")
            .and_then(Value::as_array)
            .is_some_and(|v| v.iter().any(|v| v == "null"))
        || original
            .get("anyOf")
            .and_then(Value::as_array)
            .is_some_and(|v| v.iter().any(|v| v.get("type").is_some_and(|v| v == "null")));
    let private = [original, schema].iter().any(|schema| {
        schema.get("writeOnly") == Some(&Value::Bool(true))
            || schema.get("format").and_then(Value::as_str) == Some("password")
    });
    let scalar = if private {
        options.clear();
        None
    } else {
        value.and_then(scalar)
    };
    let editable = !private
        && [original, schema]
            .iter()
            .all(|schema| schema.get("readOnly") != Some(&Value::Bool(true)))
        && !schema.as_bool().is_some_and(|v| !v)
        && !schema.as_object().is_some_and(|v| v.contains_key("const"))
        && !matches!(kind, SettingKind::Unsupported)
        && (value.is_none()
            || scalar.is_some()
            || value.is_some_and(|v| v.is_object() || v.is_array()));
    SettingField {
        key,
        label,
        description,
        kind,
        present: value.is_some(),
        required,
        nullable,
        editable,
        value: scalar,
        options,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn referenced_fields_keep_private_and_read_only_annotations() {
        let root = json!({"$defs":{"text":{"type":"string","enum":["private"]}}});
        for annotation in [json!({"writeOnly":true}), json!({"format":"password"})] {
            let mut schema = json!({"$ref":"#/$defs/text"});
            schema
                .as_object_mut()
                .unwrap()
                .extend(annotation.as_object().unwrap().clone());
            let field = field(
                "credential".into(),
                &schema,
                &root,
                Some(&json!("private")),
                true,
            );
            assert!(field.value.is_none());
            assert!(field.options.is_empty());
            assert!(!field.editable);
        }
        let field = field(
            "id".into(),
            &json!({"$ref":"#/$defs/text","readOnly":true}),
            &root,
            Some(&json!("original")),
            true,
        );
        assert!(!field.editable);
    }

    #[test]
    fn repeated_large_enums_page_by_encoded_bytes_without_losing_a_field() {
        let options: Vec<_> = (0..16)
            .map(|i| json!(format!("{i}{}", "界".repeat(4000))))
            .collect();
        let root = json!({"$defs":{"choice":{"type":"string","enum":options}}});
        let fields: Vec<_> = (0..8)
            .map(|i| {
                field(
                    i.to_string(),
                    &json!({"$ref":"#/$defs/choice"}),
                    &root,
                    None,
                    false,
                )
            })
            .collect();
        let (page, next) = settings_page(fields.clone()).unwrap();
        assert!(page.len() < 8);
        assert!(serde_json::to_vec(&page).unwrap().len() < 512 * 1024);
        assert_eq!(next, page.last().map(|field| field.key.clone()));
        let remainder = fields.into_iter().skip(page.len()).collect();
        let (second, _) = settings_page(remainder).unwrap();
        assert_eq!(second[0].key, page.len().to_string());
    }
}
