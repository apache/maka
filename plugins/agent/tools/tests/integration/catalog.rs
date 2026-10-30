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

use maka_agent_facts::event::Invocation;
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use maka_tools::*;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Fixture(AtomicUsize);
impl ToolExecutor for Fixture {
    fn names(&self) -> Vec<String> {
        ["echo", "direct", "withheld"].map(String::from).into()
    }
    fn invoke(&self, _: String, value: Value, _: CancellationToken) -> ToolFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(value) })
    }
}
fn registration(name: &str, schema: Value, executor: Arc<Fixture>) -> ToolRegistration {
    ToolRegistration {
        definition: ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: name.into(),
            description: "fixture".into(),
            input_schema: schema,
        },
        handler: ToolHandler::Immediate(executor),
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
    }
}

fn context() -> ToolCallContext {
    ToolCallContext {
        invocation: Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        operation_id: "step:call".into(),
        execution: None,
    }
}

#[tokio::test]
async fn frozen_catalog_prevents_unadvertised_or_invalid_effects_and_direct_only_nesting() {
    let effects = Arc::new(Fixture::default());
    let schema = json!({"type":"object","properties":{"n":{"type":"integer"}},"required":["n"],"additionalProperties":false});
    let mut direct = registration("direct", schema.clone(), effects.clone());
    direct.nesting = ToolNesting::DirectOnly;
    direct.semantics = ToolSemantics::ExclusiveStep;
    let catalog =
        ToolCatalog::new([registration("echo", schema, effects.clone()), direct]).unwrap();
    assert_eq!(catalog.names(), ["direct", "echo"]);
    assert_eq!(
        catalog.semantics("direct").unwrap(),
        ToolSemantics::ExclusiveStep
    );
    let nested = catalog.nested();
    assert_eq!(nested.names(), ["echo"]);
    for (scope, name, input) in [
        (&catalog, "withheld", json!({"n": 1})),
        (&nested, "direct", json!({"n": 1})),
        (&nested, "echo", json!({"n": "1"})),
        (&catalog, "echo", json!({"n": 1, "extra": true})),
    ] {
        assert!(
            scope
                .prepare(name.into(), input, context(), CancellationToken::new())
                .await
                .is_err()
        );
    }
    assert_eq!(effects.0.load(Ordering::SeqCst), 0);
    let effect = nested
        .prepare(
            "echo".into(),
            json!({"n": 2}),
            context(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(effects.0.load(Ordering::SeqCst), 0);
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        maka_event_log::EventLog::open(&directory.path().join("tools.sqlite"))
            .await
            .unwrap(),
    );
    let invocation = context().invocation;
    crate::support::preflight::accepted(
        &log,
        &invocation,
        &[crate::support::preflight::call(
            "call",
            "echo",
            json!({"n":2}),
        )],
    )
    .await;
    let output = maka_agent_facts::tools::ToolJournal::new(log.clone(), invocation.clone())
        .invoke_prepared_call(
            format!("{}:call", invocation.invocation_id),
            maka_agent_facts::tool_call::ToolCallIdentity::provider(
                invocation.invocation_id,
                "call".into(),
            ),
            "echo".into(),
            json!({"n":2}),
            None,
            CancellationToken::new(),
            effect,
        )
        .await
        .unwrap();
    assert_eq!(output, json!({"n": 2}));
    log.shutdown().await.unwrap();
    assert_eq!(effects.0.load(Ordering::SeqCst), 1);
    assert_eq!(catalog.names(), ["direct", "echo"]); // filtering never mutates another scope
}

#[test]
fn schemas_validate_offline_without_coercion_and_catalog_rejects_ambiguous_authority() {
    let effects = Arc::new(Fixture::default());
    for schema in [
        json!({"type": "not-a-type"}),
        json!({"$ref": "https://127.0.0.1:9/unavailable.json"}),
        json!({"$ref": "file:///unavailable/schema.json"}),
    ] {
        assert!(matches!(
            ToolCatalog::new([registration("echo", schema, effects.clone())]),
            Err(CatalogError::Schema(_))
        ));
    }
    let schema = json!({
        "$schema":"http://json-schema.org/draft-07/schema#",
        "definitions": {"input": {"type":"string","format":"email"}},
        "$ref":"#/definitions/input"
    });
    let catalog = ToolCatalog::new([registration("echo", schema, effects.clone())]).unwrap();
    catalog
        .validate("echo", &json!("formats are annotations"))
        .unwrap();
    assert!(matches!(
        catalog.validate("echo", &json!(1)),
        Err(ToolRejection::InvalidInput { .. })
    ));
    let denied = ToolCatalog::new([registration("echo", json!(false), effects.clone())]).unwrap();
    assert!(denied.validate("echo", &Value::Null).is_err());
    for names in [["echo", "echo"], ["echo", "exec"], ["echo", "missing"]] {
        assert!(matches!(
            ToolCatalog::new(names.map(|name| registration(name, json!({}), effects.clone()))),
            Err(CatalogError::Invalid(_))
        ));
    }
    assert_eq!(effects.0.load(Ordering::SeqCst), 0);
}
