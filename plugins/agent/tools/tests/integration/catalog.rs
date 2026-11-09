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

use super::support::preflight::Fixture as RootFixture;
use maka_agent_facts::cells::{CellEvent, CellId, CellVmBinding};
use maka_agent_facts::tool_call::{ToolRejection, ToolSettlement};
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use maka_code_runtime::{CellContext, CellLimits};
use maka_tools::*;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
struct Fixture(AtomicUsize);
impl ToolExecutor for Fixture {
    fn names(&self) -> Vec<String> {
        ["echo", "direct", "withheld", "ProcessInput", "ProcessStop"]
            .map(String::from)
            .into()
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

#[tokio::test]
async fn frozen_catalog_prevents_unadvertised_or_invalid_effects_and_direct_only_nesting() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootFixture::open(directory.path(), "catalog").await;
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
                .prepare(
                    name.into(),
                    input,
                    root.context(Uuid::new_v4()),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
    }
    assert_eq!(effects.0.load(Ordering::SeqCst), 0);
    let operation = Uuid::new_v4();
    let effect = nested
        .prepare(
            "echo".into(),
            json!({"n": 2}),
            root.context(operation),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(effects.0.load(Ordering::SeqCst), 0);
    let port = root.port();
    let cell = CellId::new();
    let source = CellContent::new(b"// catalog admission".to_vec());
    port.append(
        vec![CellChange {
            id: cell.started_fact_id(),
            at: port.now(),
            event: CellEvent::Started {
                cell,
                owner: port.owner(),
                source: source.reference.clone(),
            },
        }],
        vec![source],
    )
    .await
    .unwrap();
    let executor = CodeExecutor::new(CellLimits::default()).unwrap();
    let context = CellContext::new(root.cell_store(), vec![]).unwrap();
    let prepared = executor
        .prepare_module(
            "// catalog admission".into(),
            effects.clone(),
            CancellationToken::new(),
            context.clone(),
        )
        .await
        .unwrap();
    let binding = prepared.binding().clone();
    let descriptor = CellContent::json(&binding.descriptor).unwrap();
    port.append(
        vec![CellChange::new(
            CellEvent::VmBound {
                cell,
                binding: CellVmBinding {
                    runtime: binding.runtime.clone(),
                    version: binding.version,
                    descriptor: descriptor.reference.clone(),
                },
            },
            port.now(),
        )],
        vec![descriptor],
    )
    .await
    .unwrap();
    let sequence = port
        .admit(
            cell,
            operation,
            "echo",
            ToolSemantics::Parallel,
            &json!({"n":2}),
        )
        .await
        .unwrap();
    let (custody, execute) = effect
        .begin(sequence, CancellationToken::new())
        .unwrap()
        .execute();
    let output = port
        .returned(
            cell,
            operation,
            execute.await.unwrap(),
            ToolSettlement::Returned,
        )
        .await
        .unwrap();
    assert_eq!(output.into_json(), json!({"n": 2}));
    drop(custody);
    port.finish_prepared(cell, prepared, context, &executor)
        .await;
    drop(port);
    root.close().await;
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

#[tokio::test]
async fn process_controls_are_resident_before_any_tool_search() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootFixture::open(directory.path(), "process-controls").await;
    let effects = Arc::new(Fixture::default());
    let catalog = ToolCatalog::new(["ProcessInput", "ProcessStop", "withheld"].map(|name| {
        registration(
            name,
            json!({"type":"object","properties":{"n":{"type":"integer"}},"required":["n"]}),
            effects.clone(),
        )
    }))
    .unwrap()
    .with_discovery();
    let available = availability::Availability::new(
        catalog,
        availability::LoadedTools::new(
            root.store
                .reader(root.session.clone(), tokio::runtime::Handle::current()),
        ),
    )
    .snapshot()
    .await
    .unwrap();
    assert_eq!(available.names(), ["ProcessInput", "ProcessStop"]);
    for (name, n) in [("ProcessInput", 1), ("ProcessStop", 2)] {
        available
            .prepare(
                name.into(),
                json!({"n":n}),
                root.context(Uuid::new_v4()),
                CancellationToken::new(),
            )
            .await
            .unwrap();
    }
    assert!(matches!(
        available
            .prepare(
                "withheld".into(),
                json!({"n":3}),
                root.context(Uuid::new_v4()),
                CancellationToken::new()
            )
            .await,
        Err(ToolRejection::Unavailable)
    ));
    assert_eq!(effects.0.load(Ordering::SeqCst), 0);
    root.close().await;
}
