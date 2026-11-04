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
use crate::ToolPreparer;
use serde_json::json;
use std::cell::RefCell;

struct Handler;
impl ToolPreparer for Handler {
    fn names(&self) -> Vec<String> {
        ["alpha", "middle", "omega"].map(str::to_owned).into()
    }

    fn prepare(
        &self,
        _: String,
        _: Value,
        _: ToolCallContext,
        _: CancellationToken,
    ) -> PreparationFuture {
        Box::pin(async { Err(ToolRejection::Unavailable) })
    }
}

fn catalog() -> ToolCatalog {
    ToolCatalog::new(["alpha", "middle", "omega"].map(|name| ToolRegistration {
        definition: ToolDefinition {
            provider: None,
            name: name.into(),
            description: name.into(),
            input_schema: json!({"type":"string"}),
            freeform: None,
            output_schema: None,
        },
        nesting: if name == "middle" {
            ToolNesting::DirectOnly
        } else {
            ToolNesting::Nestable
        },
        semantics: ToolSemantics::Parallel,
        handler: maka_agent_facts::tools::ToolHandler::Prepared(Arc::new(Handler)),
    }))
    .unwrap()
    .with_discovery()
    .with_always_visible(&["alpha"])
    .unwrap()
}

#[test]
fn selection_evaluates_each_capability_once_and_preserves_the_source() {
    let source = catalog();
    for rejected in [None, Some("alpha"), Some("middle"), Some("omega")] {
        let calls = RefCell::new(Vec::new());
        let selected = source.select(|name| {
            calls.borrow_mut().push(name.to_owned());
            Some(name) != rejected
        });
        assert_eq!(*calls.borrow(), source.names());
        let expected: Vec<_> = source
            .names()
            .into_iter()
            .filter(|name| Some(name.as_str()) != rejected)
            .collect();
        assert_eq!(selected.names(), expected);
        assert!(selected.discovery);
        for name in source.names() {
            assert_eq!(
                selected.validate(&name, &json!("valid")).is_ok(),
                Some(name.as_str()) != rejected
            );
            assert!(source.validate(&name, &json!("valid")).is_ok());
        }
    }
}

#[test]
fn nested_selection_keeps_only_nestable_capabilities_and_snapshot_visibility_is_isolated() {
    let source = catalog();
    let nested = source.nested();
    assert_eq!(nested.names(), ["alpha", "omega"]);
    assert!(matches!(
        nested.validate("middle", &json!("valid")),
        Err(ToolRejection::Unavailable)
    ));
    assert!(nested.discovery);
    assert!(nested.always_visible("alpha"));
    let visible = nested.clone().with_always_visible(&["omega"]).unwrap();
    assert!(visible.always_visible("omega"));
    assert!(!nested.always_visible("omega"));
    assert!(!source.always_visible("omega"));
    assert!(source.contains("middle"));
}

#[test]
fn admitted_tool_schemas_publish_inlined_local_refs() {
    let catalog = ToolCatalog::new([ToolRegistration {
        definition: ToolDefinition {
            provider: None,
            name: "alpha".into(),
            description: "alpha".into(),
            input_schema: json!({
                "type": "object",
                "properties": {"workspace": {"$ref": "#/$defs/Workspace"}},
                "required": ["workspace"],
                "$defs": {"Workspace": {"type": "object", "required": ["rootId"]}},
            }),
            freeform: None,
            output_schema: None,
        },
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
        handler: maka_agent_facts::tools::ToolHandler::Prepared(Arc::new(Handler)),
    }])
    .unwrap();

    assert_eq!(
        catalog.definitions().next().unwrap().input_schema,
        json!({
            "type": "object",
            "properties": {"workspace": {"type": "object", "required": ["rootId"]}},
            "required": ["workspace"],
        })
    );
    assert!(
        catalog
            .validate("alpha", &json!({"workspace": {"rootId": "main"}}))
            .is_ok()
    );
    assert!(
        catalog
            .validate("alpha", &json!({"workspace": "stringified"}))
            .is_err()
    );
}

fn checked(schema: Value) -> ToolCatalog {
    ToolCatalog::new([ToolRegistration {
        definition: ToolDefinition {
            provider: None,
            name: "alpha".into(),
            description: "alpha".into(),
            input_schema: schema,
            freeform: None,
            output_schema: None,
        },
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
        handler: maka_agent_facts::tools::ToolHandler::Prepared(Arc::new(Handler)),
    }])
    .unwrap()
}

fn rejection(catalog: &ToolCatalog, input: Value) -> String {
    match catalog.validate("alpha", &input) {
        Err(ToolRejection::InvalidInput { message }) => message,
        other => panic!("expected invalid input, got {other:?}"),
    }
}

#[test]
fn a_schema_rejection_names_where_the_input_is_wrong() {
    let catalog = checked(json!({
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "workspace": {
                "oneOf": [
                    {"type": "object", "properties": {"kind": {"const": "session"}}, "required": ["kind"]},
                    {"type": "object", "properties": {"kind": {"const": "directory"}}, "required": ["kind"]},
                ]
            },
        },
        "required": ["title"],
    }));
    // A structured argument sent as its JSON text says so, and the value is not repeated.
    let message = rejection(
        &catalog,
        json!({"title": "Check", "workspace": "{\"kind\":\"session\",\"sessionId\":\"secret-id\"}"}),
    );
    assert!(
        message.starts_with("arguments do not match the declared schema: /workspace: "),
        "{message}"
    );
    assert!(
        message.contains("JSON-encoded string; pass the object or array itself"),
        "{message}"
    );
    assert!(!message.contains("secret-id"), "{message}");
    // A plain wrong type names its place and gives no JSON hint.
    let message = rejection(&catalog, json!({"title": 7}));
    assert!(message.contains("/title: "), "{message}");
    assert!(!message.contains("JSON-encoded"), "{message}");
    // A string that breaks a string rule is meant to be a string, even if it holds JSON.
    let catalog_limited = checked(json!({
        "type": "object",
        "properties": {"title": {"type": "string", "maxLength": 4}},
    }));
    let message = rejection(&catalog_limited, json!({"title": "{\"a\":1}"}));
    assert!(message.contains("/title: "), "{message}");
    assert!(!message.contains("JSON-encoded"), "{message}");
    // A missing field is reported at the root.
    let message = rejection(&catalog, json!({}));
    assert!(message.contains("\"title\""), "{message}");
}

#[test]
fn a_schema_rejection_names_only_the_first_errors() {
    let catalog = checked(json!({
        "type": "object",
        "properties": {
            "a": {"type": "string"}, "b": {"type": "string"}, "c": {"type": "string"},
            "d": {"type": "string"}, "e": {"type": "string"},
        },
    }));
    let message = rejection(&catalog, json!({"a": 1, "b": 2, "c": 3, "d": 4, "e": 5}));
    assert_eq!(message.matches("; /").count(), 2, "{message}");
    assert!(message.ends_with("; and 2 more"), "{message}");
}
