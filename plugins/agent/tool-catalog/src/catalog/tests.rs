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
        if rejected.is_none() {
            assert!(Arc::ptr_eq(&source.entries, &selected.entries));
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
