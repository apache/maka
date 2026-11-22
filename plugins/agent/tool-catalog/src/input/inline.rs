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
use std::{borrow::Cow, collections::BTreeSet};

/// Bound on schema objects materialized by `$ref` expansion within one tool
/// schema. Untrusted MCP definitions can form a small DAG whose tree unfolding
/// doubles at every level; real tool schemas stay orders of magnitude smaller
/// and must fit within a single model context window anyway.
const MAX_INLINED_OBJECTS: usize = 65_536;

const DEFINITIONS: &[&str] = &["$defs", "definitions"];

/// Expands document-local JSON Pointer `$ref`s in a tool input schema and drops
/// definitions that nothing references anymore.
///
/// Several model endpoints do not resolve `$ref` inside tool schemas and encode
/// referenced object arguments as JSON strings instead. Normalizing once at
/// catalog admission covers every wire protocol without per-step re-expansion.
pub fn inline_refs(schema: Value) -> Value {
    if !mentions_ref(&schema) {
        return schema;
    }
    let mut budget = MAX_INLINED_OBJECTS;
    inline_resource(&schema, &mut budget, false).unwrap_or(schema)
}

fn inline_resource(root: &Value, budget: &mut usize, inlined_into_outer: bool) -> Option<Value> {
    if !root.is_object() {
        return Some(root.clone());
    }
    let mut expander = Expander {
        root,
        expanding: vec![String::new()],
        budget,
        kept_pointers: BTreeSet::new(),
        keep_all_defs: false,
    };
    let mut result = expander.schema(root, true, inlined_into_outer)?;
    while expander.keep_all_defs || !expander.kept_pointers.is_empty() {
        let mut attached = false;
        reattach_definitions(&mut result, root, "", &mut expander, &mut attached)?;
        if !attached {
            break;
        }
    }
    Some(result)
}

struct Expander<'a, 'b> {
    root: &'a Value,
    expanding: Vec<String>,
    budget: &'b mut usize,
    kept_pointers: BTreeSet<String>,
    keep_all_defs: bool,
}

impl<'a> Expander<'a, '_> {
    fn has_kept_under(&self, prefix: &str) -> bool {
        self.kept_pointers
            .iter()
            .any(|pointer| pointer_has_prefix(pointer, prefix))
    }

    fn schema(&mut self, value: &'a Value, is_resource_root: bool, inlined: bool) -> Option<Value> {
        let Value::Object(source) = value else {
            return Some(value.clone());
        };
        if !is_resource_root && embedded_id(source).is_some() {
            return inline_resource(value, self.budget, inlined);
        }
        if inlined {
            *self.budget = self.budget.checked_sub(1)?;
        }
        let mut siblings = Map::new();
        for (keyword, child) in source {
            if keyword == "$ref" || DEFINITIONS.contains(&keyword.as_str()) {
                continue;
            }
            siblings.insert(keyword.clone(), self.keyword(keyword, child, inlined)?);
        }
        let Some(reference) = source.get("$ref") else {
            return Some(Value::Object(siblings));
        };
        let Some(ref_str) = reference.as_str() else {
            siblings.insert("$ref".into(), reference.clone());
            return Some(Value::Object(siblings));
        };
        let Some(pointer) = decode_local_pointer(ref_str) else {
            self.keep_all_defs = true;
            siblings.insert("$ref".into(), reference.clone());
            return Some(Value::Object(siblings));
        };
        if self
            .expanding
            .iter()
            .any(|active| active == pointer.as_ref())
        {
            if !pointer.is_empty() {
                self.kept_pointers.insert(pointer.into_owned());
            }
            siblings.insert("$ref".into(), reference.clone());
            return Some(Value::Object(siblings));
        }
        let Some(target) = self.root.pointer(&pointer) else {
            if !pointer.is_empty() {
                self.kept_pointers.insert(pointer.into_owned());
            }
            siblings.insert("$ref".into(), reference.clone());
            return Some(Value::Object(siblings));
        };
        // Duplicating an embedded `$id` across multiple sites would register
        // conflicting subresource identities in the same document.
        if contains_embedded_id(target) && count_pointer_refs(self.root, &pointer, true) > 1 {
            self.kept_pointers.insert(pointer.into_owned());
            siblings.insert("$ref".into(), reference.clone());
            return Some(Value::Object(siblings));
        }
        self.expanding.push(pointer.into_owned());
        let resolved = self.schema(target, false, true);
        self.expanding.pop();
        Some(merge(resolved?, siblings))
    }

    fn keyword(&mut self, keyword: &str, value: &'a Value, inlined: bool) -> Option<Value> {
        match keyword {
            "items"
            | "additionalItems"
            | "additionalProperties"
            | "unevaluatedItems"
            | "unevaluatedProperties"
            | "contentSchema"
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
                    .map(|child| self.schema(child, false, inlined))
                    .collect::<Option<_>>()
                    .map(Value::Array),
                child => self.schema(child, false, inlined),
            },
            "properties" | "patternProperties" | "dependentSchemas" => match value {
                Value::Object(children) => children
                    .iter()
                    .map(|(name, child)| Some((name.clone(), self.schema(child, false, inlined)?)))
                    .collect::<Option<_>>()
                    .map(Value::Object),
                other => Some(other.clone()),
            },
            "dependencies" => match value {
                Value::Object(children) => children
                    .iter()
                    .map(|(name, child)| {
                        let expanded = match child {
                            Value::Array(_) => child.clone(),
                            subschema => self.schema(subschema, false, inlined)?,
                        };
                        Some((name.clone(), expanded))
                    })
                    .collect::<Option<_>>()
                    .map(Value::Object),
                other => Some(other.clone()),
            },
            // Literal values are instance data even when they contain a `$ref` key.
            "const" | "default" | "enum" | "examples" => Some(value.clone()),
            _ => {
                self.keep_all_defs |=
                    keyword == "$dynamicRef" || keyword == "$recursiveRef" || mentions_ref(value);
                Some(value.clone())
            }
        }
    }
}

fn reattach_definitions<'a>(
    result: &mut Value,
    source: &'a Value,
    ptr: &str,
    expander: &mut Expander<'a, '_>,
    attached: &mut bool,
) -> Option<()> {
    let Value::Object(source_map) = source else {
        return Some(());
    };
    if !ptr.is_empty() && embedded_id(source_map).is_some() {
        return Some(());
    }
    if !expander.keep_all_defs && !expander.has_kept_under(ptr) {
        return Some(());
    }
    if let Value::Bool(boolean) = *result
        && DEFINITIONS.iter().any(|kw| source_map.contains_key(*kw))
    {
        *result = Value::Object(Map::from_iter([(
            "allOf".into(),
            Value::Array(vec![Value::Bool(boolean)]),
        )]));
    }
    let Value::Object(result_map) = result else {
        return Some(());
    };
    for def_kw in DEFINITIONS {
        let Some(Value::Object(source_defs)) = source_map.get(*def_kw) else {
            continue;
        };
        for (name, def_schema) in source_defs {
            let def_ptr = format!("{ptr}/{def_kw}/{}", escape_pointer_token(name));
            if !expander.keep_all_defs && !expander.has_kept_under(&def_ptr) {
                continue;
            }
            let already_present = result_map
                .get(*def_kw)
                .and_then(Value::as_object)
                .is_some_and(|defs| defs.contains_key(name));
            if !already_present {
                expander.expanding.push(def_ptr.clone());
                let expanded_def = expander.schema(def_schema, false, true)?;
                expander.expanding.pop();
                result_map
                    .entry((*def_kw).to_owned())
                    .or_insert_with(|| Value::Object(Map::new()))
                    .as_object_mut()
                    .expect("definitions map")
                    .insert(name.clone(), expanded_def);
                *attached = true;
            }
            if let Some(result_def) = result_map
                .get_mut(*def_kw)
                .and_then(Value::as_object_mut)
                .and_then(|defs| defs.get_mut(name))
            {
                reattach_definitions(result_def, def_schema, &def_ptr, expander, attached)?;
            }
        }
    }
    for (keyword, source_child) in source_map {
        if keyword == "$ref" || DEFINITIONS.contains(&keyword.as_str()) {
            continue;
        }
        match keyword.as_str() {
            "properties" | "patternProperties" | "dependentSchemas" => {
                if let (Value::Object(source_children), Some(Value::Object(result_children))) =
                    (source_child, result_map.get_mut(keyword))
                {
                    for (name, grandchild) in source_children {
                        let child_ptr = format!("{ptr}/{keyword}/{}", escape_pointer_token(name));
                        if (expander.keep_all_defs || expander.has_kept_under(&child_ptr))
                            && let Some(result_grandchild) = result_children.get_mut(name)
                        {
                            reattach_definitions(
                                result_grandchild,
                                grandchild,
                                &child_ptr,
                                expander,
                                attached,
                            )?;
                        }
                    }
                }
            }
            "dependencies" => {
                if let (Value::Object(source_children), Some(Value::Object(result_children))) =
                    (source_child, result_map.get_mut(keyword))
                {
                    for (name, grandchild) in source_children {
                        if grandchild.is_array() {
                            continue;
                        }
                        let child_ptr = format!("{ptr}/{keyword}/{}", escape_pointer_token(name));
                        if (expander.keep_all_defs || expander.has_kept_under(&child_ptr))
                            && let Some(result_grandchild) = result_children.get_mut(name)
                        {
                            reattach_definitions(
                                result_grandchild,
                                grandchild,
                                &child_ptr,
                                expander,
                                attached,
                            )?;
                        }
                    }
                }
            }
            "items"
            | "additionalItems"
            | "additionalProperties"
            | "unevaluatedItems"
            | "unevaluatedProperties"
            | "contentSchema"
            | "propertyNames"
            | "contains"
            | "not"
            | "if"
            | "then"
            | "else"
            | "allOf"
            | "anyOf"
            | "oneOf"
            | "prefixItems" => match source_child {
                Value::Array(source_items) => {
                    if let Some(Value::Array(result_items)) = result_map.get_mut(keyword) {
                        for (index, item) in source_items.iter().enumerate() {
                            let child_ptr = format!("{ptr}/{keyword}/{index}");
                            if (expander.keep_all_defs || expander.has_kept_under(&child_ptr))
                                && let Some(result_item) = result_items.get_mut(index)
                            {
                                reattach_definitions(
                                    result_item,
                                    item,
                                    &child_ptr,
                                    expander,
                                    attached,
                                )?;
                            }
                        }
                    }
                }
                _ => {
                    let child_ptr = format!("{ptr}/{keyword}");
                    if (expander.keep_all_defs || expander.has_kept_under(&child_ptr))
                        && let Some(result_child) = result_map.get_mut(keyword)
                    {
                        reattach_definitions(
                            result_child,
                            source_child,
                            &child_ptr,
                            expander,
                            attached,
                        )?;
                    }
                }
            },
            _ => {}
        }
    }
    Some(())
}

fn is_annotation(keyword: &str) -> bool {
    matches!(
        keyword,
        "title"
            | "description"
            | "default"
            | "examples"
            | "deprecated"
            | "readOnly"
            | "writeOnly"
            | "$comment"
    )
}

fn interacts_across_boundary(left: &Map<String, Value>, right: &Map<String, Value>) -> bool {
    let pair = |first: &[&str], second: &[&str]| {
        (first.iter().any(|key| left.contains_key(*key))
            && second.iter().any(|key| right.contains_key(*key)))
            || (first.iter().any(|key| right.contains_key(*key))
                && second.iter().any(|key| left.contains_key(*key)))
    };
    left.contains_key("unevaluatedProperties")
        || left.contains_key("unevaluatedItems")
        || right.contains_key("unevaluatedProperties")
        || right.contains_key("unevaluatedItems")
        || pair(
            &["additionalProperties"],
            &["properties", "patternProperties"],
        )
        || pair(&["items", "additionalItems"], &["prefixItems", "items"])
        || pair(&["contains"], &["minContains", "maxContains"])
        || pair(&["if"], &["then", "else"])
        || pair(&["contentMediaType"], &["contentSchema"])
}

fn merge(resolved: Value, siblings: Map<String, Value>) -> Value {
    if siblings.is_empty() {
        return resolved;
    }
    if let Value::Object(mut resolved_map) = resolved {
        let only_annotations = siblings.keys().all(|keyword| is_annotation(keyword));
        let can_flatten = only_annotations
            || (embedded_id(&resolved_map).is_none()
                && !interacts_across_boundary(&resolved_map, &siblings)
                && siblings
                    .iter()
                    .all(|(keyword, value)| match resolved_map.get(keyword) {
                        None => true,
                        Some(_) if is_annotation(keyword) => true,
                        Some(existing) => existing == value,
                    }));
        if can_flatten {
            resolved_map.extend(siblings);
            return Value::Object(resolved_map);
        }
        return combine_all_of(Value::Object(resolved_map), siblings);
    }
    combine_all_of(resolved, siblings)
}

fn combine_all_of(resolved: Value, mut siblings: Map<String, Value>) -> Value {
    match siblings.get_mut("allOf") {
        Some(Value::Array(items)) => {
            items.push(resolved);
            Value::Object(siblings)
        }
        Some(_) => Value::Object(Map::from_iter([(
            "allOf".into(),
            Value::Array(vec![Value::Object(siblings), resolved]),
        )])),
        None => {
            siblings.insert("allOf".into(), Value::Array(vec![resolved]));
            Value::Object(siblings)
        }
    }
}

fn embedded_id(schema: &Map<String, Value>) -> Option<&str> {
    schema
        .get("$id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && !id.starts_with('#'))
}

fn decode_local_pointer(reference: &str) -> Option<Cow<'_, str>> {
    let pointer = reference.strip_prefix('#')?;
    if !pointer.is_empty() && !pointer.starts_with('/') {
        return None;
    }
    if !pointer.contains('%') {
        return Some(Cow::Borrowed(pointer));
    }
    let bytes = pointer.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = char::from(*bytes.get(index + 1)?).to_digit(16)?;
            let low = char::from(*bytes.get(index + 2)?).to_digit(16)?;
            decoded.push(((high << 4) | low) as u8);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok().map(Cow::Owned)
}

fn escape_pointer_token(token: &str) -> Cow<'_, str> {
    if !token.contains(['~', '/']) {
        return Cow::Borrowed(token);
    }
    Cow::Owned(token.replace('~', "~0").replace('/', "~1"))
}

fn pointer_has_prefix(pointer: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    pointer
        .strip_prefix(prefix)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn contains_embedded_id(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            embedded_id(map).is_some()
                || map
                    .iter()
                    .filter(|(keyword, _)| {
                        !matches!(keyword.as_str(), "const" | "default" | "enum" | "examples")
                    })
                    .any(|(keyword, child)| {
                        if matches!(
                            keyword.as_str(),
                            "properties"
                                | "patternProperties"
                                | "dependentSchemas"
                                | "$defs"
                                | "definitions"
                        ) {
                            child
                                .as_object()
                                .is_some_and(|children| children.values().any(contains_embedded_id))
                        } else {
                            contains_embedded_id(child)
                        }
                    })
        }
        Value::Array(items) => items.iter().any(contains_embedded_id),
        _ => false,
    }
}

fn count_pointer_refs(value: &Value, target_pointer: &str, is_root: bool) -> usize {
    match value {
        Value::Object(map) => {
            if !is_root && embedded_id(map).is_some() {
                return 0;
            }
            let own = usize::from(
                map.get("$ref")
                    .and_then(Value::as_str)
                    .and_then(decode_local_pointer)
                    .is_some_and(|pointer| pointer == target_pointer),
            );
            own + map
                .iter()
                .filter(|(keyword, _)| {
                    !matches!(keyword.as_str(), "const" | "default" | "enum" | "examples")
                })
                .map(|(keyword, child)| {
                    if matches!(
                        keyword.as_str(),
                        "properties"
                            | "patternProperties"
                            | "dependentSchemas"
                            | "$defs"
                            | "definitions"
                    ) {
                        child.as_object().map_or(0, |children| {
                            children
                                .values()
                                .map(|grandchild| {
                                    count_pointer_refs(grandchild, target_pointer, false)
                                })
                                .sum()
                        })
                    } else {
                        count_pointer_refs(child, target_pointer, false)
                    }
                })
                .sum::<usize>()
        }
        Value::Array(items) => items
            .iter()
            .map(|item| count_pointer_refs(item, target_pointer, false))
            .sum(),
        _ => 0,
    }
}

fn mentions_ref(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.contains_key("$ref") || map.values().any(mentions_ref),
        Value::Array(values) => values.iter().any(mentions_ref),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::Projection;
    use serde_json::json;

    #[test]
    fn local_refs_inline_cleanly_while_annotations_and_literals_preserve_semantics() {
        let directory = json!({
            "type": "object",
            "description": "Default directory description.",
            "properties": {"rootId": {"type": "string"}},
            "required": ["rootId"],
            "additionalProperties": false,
        });
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "workspace": {"$ref": "#/$defs/Workspace"},
                "backup": {"$ref": "#/$defs/Directory%20Selection", "description": "Optional copy."},
                "literal": {"const": {"$ref": "#/$defs/Workspace"}},
                "$ref": {"type": "string"},
            },
            "dependencies": {
                "backup": {"properties": {"mirror": {"$ref": "#/$defs/Directory%20Selection"}}},
                "workspace": ["$ref"],
            },
            "$defs": {
                "Workspace": {"oneOf": [{
                    "type": "object",
                    "properties": {
                        "kind": {"const": "directory"},
                        "selection": {"$ref": "#/$defs/Directory%20Selection"},
                    },
                    "required": ["kind", "selection"],
                    "additionalProperties": false,
                }]},
                "Directory Selection": directory,
            },
        });
        let before = jsonschema::validator_for(&schema).unwrap();
        let inlined = inline_refs(schema);
        let after = jsonschema::validator_for(&inlined).unwrap();

        assert!(inlined.get("$defs").is_none());
        assert_eq!(
            inlined["properties"]["workspace"]["oneOf"][0]["properties"]["selection"],
            directory
        );
        let mut expected_backup = directory.clone();
        expected_backup["description"] = json!("Optional copy.");
        assert_eq!(inlined["properties"]["backup"], expected_backup);
        assert_eq!(
            inlined["dependencies"]["backup"]["properties"]["mirror"],
            directory
        );
        assert_eq!(inlined["dependencies"]["workspace"], json!(["$ref"]));
        assert_eq!(
            inlined["properties"]["literal"],
            json!({"const": {"$ref": "#/$defs/Workspace"}})
        );
        assert_eq!(inlined["properties"]["$ref"], json!({"type": "string"}));

        for sample in [
            json!({
                "workspace": {"kind": "directory", "selection": {"rootId": "main"}},
                "$ref": "ok",
            }),
            json!({
                "backup": {"rootId": "backup"},
                "mirror": {"rootId": "mirror"},
            }),
            json!({"backup": {"rootId": "backup"}, "mirror": {"rootId": 7}}),
            json!({"workspace": {"kind": "directory", "selection": {"rootId": "main"}}}),
            json!({"literal": {"$ref": "#/$defs/Workspace"}}),
            json!({"literal": {"rootId": "main"}}),
        ] {
            assert_eq!(
                after.is_valid(&sample),
                before.is_valid(&sample),
                "{sample}"
            );
        }
    }

    #[test]
    fn colliding_siblings_preserve_existing_all_of_and_unevaluated_isolation() {
        let colliding = json!({
            "type": "object",
            "properties": {
                "name": {
                    "$ref": "#/$defs/Name",
                    "maxLength": 8,
                    "allOf": [{"minLength": 3, "pattern": "^[a-z]+$"}],
                },
                "closed": {
                    "$ref": "#/$defs/EmptyClosed",
                    "properties": {"extra": {"type": "number"}},
                },
                "neighbourClosed": {
                    "$ref": "#/$defs/OpenItem",
                    "additionalProperties": false,
                },
                "annotated": {
                    "$ref": "#/$defs/Defaulted",
                    "description": "Field override.",
                    "default": "override",
                },
            },
            "$defs": {
                "Name": {"type": "string", "maxLength": 64},
                "EmptyClosed": {"type": "object", "unevaluatedProperties": false},
                "OpenItem": {"type": "object", "properties": {"id": {"type": "string"}}},
                "Defaulted": {
                    "description": "Type default.",
                    "default": "base",
                    "oneOf": [{"type": "string"}],
                },
            },
        });
        let before = jsonschema::validator_for(&colliding).unwrap();
        let inlined = inline_refs(colliding);
        let after = jsonschema::validator_for(&inlined).unwrap();
        assert!(inlined.get("$defs").is_none());
        assert_eq!(
            inlined["properties"]["annotated"],
            json!({
                "description": "Field override.",
                "default": "override",
                "oneOf": [{"type": "string"}],
            })
        );

        for sample in [
            json!({"name": "alpha"}),
            json!({"name": "ab"}),
            json!({"name": "UPPER"}),
            json!({"name": "alphabetical"}),
            json!({"closed": {}}),
            json!({"closed": {"extra": 1}}),
            json!({"neighbourClosed": {}}),
            json!({"neighbourClosed": {"id": "rejected-by-outer-additional-properties"}}),
            json!({"annotated": "ok"}),
            json!({"annotated": 9}),
        ] {
            assert_eq!(
                after.is_valid(&sample),
                before.is_valid(&sample),
                "{sample}"
            );
        }
    }

    #[test]
    fn projected_envelopes_and_embedded_resources_keep_exact_validation_scopes() {
        let (_, enveloped_union) = Projection::project(json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "oneOf": [
                {"type": "object", "properties": {"kind": {"const": "roots"}}, "required": ["kind"]},
                {
                    "type": "object",
                    "properties": {
                        "kind": {"const": "children"},
                        "selection": {"$ref": "#/$defs/Directory"},
                    },
                    "required": ["kind", "selection"],
                },
            ],
            "$defs": {"Directory": {"type": "object", "required": ["rootId"]}},
        }));
        let inlined_union = inline_refs(enveloped_union.clone());
        assert!(
            inlined_union["properties"]["request"]
                .get("$defs")
                .is_none()
        );
        let before_union = jsonschema::validator_for(&enveloped_union).unwrap();
        let after_union = jsonschema::validator_for(&inlined_union).unwrap();
        for sample in [
            json!({"request": {"kind": "roots"}}),
            json!({"request": {"kind": "children", "selection": {"rootId": "r"}}}),
            json!({"request": {"kind": "children", "selection": {}}}),
        ] {
            assert_eq!(
                after_union.is_valid(&sample),
                before_union.is_valid(&sample)
            );
        }

        let (_, enveloped_scoped) = Projection::project(json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$ref": "#/$defs/Scoped",
            "maxProperties": 2,
            "$defs": {"Scoped": {
                "$id": "https://example.com/scoped",
                "type": "object",
                "properties": {
                    "value": {"$ref": "#/$defs/Value"},
                    "extra": {"type": "string"},
                    "next": {"anyOf": [{"type": "null"}, {"$ref": "#"}]},
                },
                "required": ["value"],
                "additionalProperties": false,
                "$defs": {"Value": {"type": "string", "minLength": 1}},
            }},
        }));
        let before_scoped = jsonschema::validator_for(&enveloped_scoped).unwrap();
        let inlined_scoped = inline_refs(enveloped_scoped);
        let after_scoped = jsonschema::validator_for(&inlined_scoped).unwrap();
        assert!(
            inlined_scoped["properties"]["request"]
                .get("$defs")
                .is_none()
        );
        assert_eq!(
            inlined_scoped["properties"]["request"]["allOf"][0]["properties"]["value"],
            json!({"type": "string", "minLength": 1})
        );
        for sample in [
            json!({"request": {"value": "outer", "next": {"value": "inner", "extra": "allowed-inside-subresource", "next": null}}}),
            json!({"request": {"value": "outer", "extra": "outer-exceeds-max-properties", "next": null}}),
            json!({"request": {"value": "", "next": null}}),
            json!({"request": {"value": "outer", "next": {}}}),
        ] {
            assert_eq!(
                after_scoped.is_valid(&sample),
                before_scoped.is_valid(&sample)
            );
        }

        // Multiple references to an embedded `$id` resource keep one canonical `$id`.
        let shared_scoped = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "left": {"$ref": "#/$defs/Scoped"},
                "right": {"$ref": "#/$defs/Scoped"},
            },
            "$defs": {"Scoped": {
                "$id": "https://example.com/shared-scoped",
                "type": "object",
                "properties": {"v": {"$ref": "#/$defs/Inner"}},
                "required": ["v"],
                "$defs": {"Inner": {"type": "integer"}},
            }},
        });
        let before_shared = jsonschema::validator_for(&shared_scoped).unwrap();
        let inlined_shared = inline_refs(shared_scoped);
        let after_shared = jsonschema::validator_for(&inlined_shared).unwrap();
        assert_eq!(
            inlined_shared["$defs"]["Scoped"]["properties"]["v"],
            json!({"type": "integer"})
        );
        assert!(inlined_shared["$defs"]["Scoped"].get("$defs").is_none());
        for sample in [
            json!({"left": {"v": 1}, "right": {"v": 2}}),
            json!({"left": {"v": "bad"}}),
        ] {
            assert_eq!(
                after_shared.is_valid(&sample),
                before_shared.is_valid(&sample)
            );
        }
    }

    #[test]
    fn recursive_and_non_pointer_references_keep_only_needed_definitions_and_bound_dag_blowup() {
        let recursive = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "selfLink": {"anyOf": [{"type": "null"}, {"$ref": "#"}]},
                "tree": {"$ref": "#/$defs/Node"},
            },
            "$defs": {
                "Node": {
                    "type": "object",
                    "properties": {
                        "label": {"$ref": "#/$defs/Leaf"},
                        "children": {"type": "array", "items": {"$ref": "#/$defs/Node"}},
                    },
                    "required": ["label"],
                },
                "Leaf": {"type": "string", "minLength": 1},
            },
        });
        let before = jsonschema::validator_for(&recursive).unwrap();
        let inlined = inline_refs(recursive);
        let after = jsonschema::validator_for(&inlined).unwrap();

        assert!(
            inlined["properties"]["selfLink"]["anyOf"][1]
                .get("$defs")
                .is_none()
        );
        assert_eq!(
            inlined["properties"]["tree"]["properties"]["label"],
            json!({"type": "string", "minLength": 1})
        );
        assert_eq!(
            inlined["$defs"]["Node"]["properties"]["label"],
            json!({"type": "string", "minLength": 1})
        );
        assert!(inlined["$defs"].get("Leaf").is_none());
        for sample in [
            json!({"selfLink": {"selfLink": null}, "tree": {"label": "root", "children": [{"label": "child"}]}}),
            json!({"tree": {"label": "root", "children": [{"label": ""}]}}),
        ] {
            assert_eq!(after.is_valid(&sample), before.is_valid(&sample));
        }

        let anchored = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "target": {"$ref": "#named"},
                "plain": {"$ref": "#/$defs/Plain"},
            },
            "$defs": {
                "Anchored": {"$anchor": "named", "type": "integer"},
                "Plain": {"type": "boolean"},
            },
        });
        let before_anchored = jsonschema::validator_for(&anchored).unwrap();
        let inlined_anchored = inline_refs(anchored);
        let after_anchored = jsonschema::validator_for(&inlined_anchored).unwrap();
        assert_eq!(
            inlined_anchored["properties"]["plain"],
            json!({"type": "boolean"})
        );
        assert!(inlined_anchored["$defs"].get("Anchored").is_some());
        for sample in [
            json!({"target": 3, "plain": true}),
            json!({"target": "nope", "plain": true}),
        ] {
            assert_eq!(
                after_anchored.is_valid(&sample),
                before_anchored.is_valid(&sample)
            );
        }

        let mut defs = Map::new();
        defs.insert("L0".into(), json!({"type": "string"}));
        for level in 1..20 {
            let below = format!("#/$defs/L{}", level - 1);
            defs.insert(
                format!("L{level}"),
                json!({"type": "array", "prefixItems": [{"$ref": below}, {"$ref": below}]}),
            );
        }
        let exploding =
            json!({"type": "object", "properties": {"x": {"$ref": "#/$defs/L19"}}, "$defs": defs});
        assert_eq!(inline_refs(exploding.clone()), exploding);
    }
}
