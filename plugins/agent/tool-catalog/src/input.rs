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

use maka_agent_facts::tool_call::ToolRejection;
use schemars::{
    Schema,
    transform::{Transform, transform_subschemas},
};
use serde::Deserialize;
use serde_json::{Value, json};

/// Preserve a typed request inside an object-rooted model tool input.
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolRequest<T> {
    pub request: T,
}

#[derive(Clone, Copy)]
pub enum Projection {
    Direct,
    RequestEnvelope,
}

impl Projection {
    pub fn project(schema: Value) -> (Self, Value) {
        if schema["type"] == "object"
            && ["oneOf", "anyOf", "allOf", "$ref"]
                .iter()
                .all(|key| schema.get(*key).is_none())
        {
            return (Self::Direct, schema);
        }
        let mut schema = Schema::try_from(schema).expect("admitted service input schema");
        RebaseRootReferences.transform(&mut schema);
        let mut envelope = json!({
            "type": "object",
            "properties": {"request": schema},
            "required": ["request"],
            "additionalProperties": false,
        });
        if let Some(dialect) = envelope["properties"]["request"].get("$schema").cloned() {
            envelope["$schema"] = dialect;
        }
        (Self::RequestEnvelope, envelope)
    }

    pub fn decode(self, input: Value) -> Result<Value, ToolRejection> {
        match self {
            Self::Direct => Ok(input),
            Self::RequestEnvelope => serde_json::from_value::<ToolRequest<Value>>(input)
                .map(|input| input.request)
                .map_err(|error| ToolRejection::InvalidInput {
                    message: error.to_string(),
                }),
        }
    }
}

struct RebaseRootReferences;

impl Transform for RebaseRootReferences {
    fn transform(&mut self, schema: &mut Schema) {
        // An embedded resource keeps its own document root after relocation.
        if schema.get("$id").is_some() {
            return;
        }
        for key in ["$ref", "$dynamicRef"] {
            if let Some(Value::String(reference)) = schema.get_mut(key)
                && let Some(pointer) = reference.strip_prefix('#')
                && (pointer.is_empty() || pointer.starts_with('/'))
            {
                *reference = format!("#/properties/request{pointer}");
            }
        }
        transform_subschemas(self, schema);
        for key in ["unevaluatedItems", "unevaluatedProperties", "contentSchema"] {
            if let Some(value) = schema.get_mut(key)
                && let Ok(schema) = <&mut Schema>::try_from(value)
            {
                self.transform(schema);
            }
        }
        if let Some(Value::Object(schemas)) = schema.get_mut("dependentSchemas") {
            for value in schemas.values_mut() {
                if let Ok(schema) = <&mut Schema>::try_from(value) {
                    self.transform(schema);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_objects_and_wrapped_inputs_keep_their_original_values() {
        let original = json!({
            "type": "object",
            "properties": {"count": {"type": "integer"}},
            "required": ["count"],
            "additionalProperties": false,
        });
        let (projection, schema) = Projection::project(original.clone());
        assert_eq!(schema, original);
        assert_eq!(
            projection.decode(json!({"count": 3})).unwrap(),
            json!({"count": 3})
        );
        let (projection, schema) = Projection::project(json!({"type": "null"}));
        let validator = jsonschema::validator_for(&schema).unwrap();
        assert!(validator.is_valid(&json!({"request": null})));
        assert!(!validator.is_valid(&json!({"request": {}})));
        assert!(!validator.is_valid(&json!({})));
        assert!(!validator.is_valid(&json!({"request": null, "extra": true})));
        assert_eq!(
            projection.decode(json!({"request": null})).unwrap(),
            Value::Null
        );
        assert!(matches!(
            projection.decode(json!({})),
            Err(ToolRejection::InvalidInput { .. })
        ));

        let (projection, schema) = Projection::project(json!({}));
        let validator = jsonschema::validator_for(&schema).unwrap();
        assert!(validator.is_valid(&json!({"request": 7})));
        assert_eq!(projection.decode(json!({"request": 7})).unwrap(), json!(7));
    }

    #[test]
    fn recursive_document_refs_move_while_literal_refs_stay_unchanged() {
        let (projection, schema) = Projection::project(json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$ref": "#/$defs/Node",
            "properties": {"value": {"type": "integer"}},
            "$defs": {"Node": {
                "type": "object",
                "properties": {
                    "value": {"$ref": "#/properties/value"},
                    "next": {"anyOf": [{"type": "null"}, {"$dynamicRef": "#"}]},
                    "marker": {
                        "const": {"$ref": "#/$defs/Node"},
                        "default": {"$ref": "#"},
                    },
                },
                "required": ["value"],
                "additionalProperties": false,
            }},
        }));
        let validator = jsonschema::validator_for(&schema).unwrap();
        let input = json!({"request": {
            "value": 1,
            "next": {"value": 2, "next": null},
            "marker": {"$ref": "#/$defs/Node"},
        }});
        assert!(validator.is_valid(&input));
        assert_eq!(
            projection.decode(input).unwrap(),
            json!({
                "value": 1,
                "next": {"value": 2, "next": null},
                "marker": {"$ref": "#/$defs/Node"},
            })
        );
        assert!(!validator.is_valid(&json!({"request": {"value": "one"}})));
        assert!(!validator.is_valid(&json!({"request": {"value": 1, "next": {}}})));
        assert!(!validator.is_valid(&json!({"request": {
            "value": 1, "marker": {"$ref": "#/properties/request/$defs/Node"},
        }})));
        assert_eq!(
            schema["properties"]["request"]["$defs"]["Node"]["properties"]["marker"]["default"],
            json!({"$ref": "#"}),
        );
    }

    #[test]
    fn embedded_resources_keep_their_own_document_refs() {
        for root_id in [None, Some("https://example.com/root")] {
            let mut original = json!({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "$ref": "#/$defs/Scoped",
                "$defs": {"Scoped": {
                    "$id": "https://example.com/scoped",
                    "type": "object",
                    "properties": {
                        "value": {"$ref": "#/$defs/Value"},
                        "next": {"anyOf": [{"type": "null"}, {"$ref": "#"}]},
                    },
                    "required": ["value"],
                    "additionalProperties": false,
                    "$defs": {"Value": {"type": "string", "minLength": 1}},
                }},
            });
            if let Some(root_id) = root_id {
                original["$id"] = json!(root_id);
            }
            let (projection, schema) = Projection::project(original);
            let validator = jsonschema::validator_for(&schema).unwrap();
            let input = json!({"request": {"value": "outer", "next": {"value": "inner"}}});
            assert!(validator.is_valid(&input));
            assert_eq!(
                projection.decode(input).unwrap(),
                json!({
                    "value": "outer", "next": {"value": "inner"},
                })
            );
            assert!(!validator.is_valid(&json!({"request": {"value": 1}})));
            assert!(!validator.is_valid(&json!({"request": {"value": "outer", "next": {}}})));
        }
    }
}
