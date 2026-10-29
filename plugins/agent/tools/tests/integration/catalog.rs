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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn discovery_loads_complete_schemas_without_running_effects() {
    use crate::support::preflight;
    use maka_code_runtime::CellLimits;
    use maka_event_log::EventLog;
    use maka_tools::CodeExecutor;
    use maka_tools::{RunTools, ToolMode};
    for oversized in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            EventLog::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let effects = Arc::new(Fixture::default());
        let catalog = ToolCatalog::new([
            registration("direct", json!({"type":"object","description":"x".repeat(if oversized { 70_000 } else { 33_000 })}), effects.clone()),
            registration("echo", json!({"type":"object","description":"x".repeat(if oversized { 0 } else { 33_000 })}), effects.clone()),
        ]).unwrap().with_discovery();
        let invalid = preflight::call(
            "invalid",
            "tool_search",
            if oversized {
                json!({"query":" "})
            } else {
                json!({"query":"fixture","limit":null})
            },
        );
        let search = preflight::call("search", "tool_search", json!({"query":"fixture"}));
        let invocation = preflight::invocation("discovery-budget");
        preflight::accepted(&log, &invocation, &[invalid.clone(), search.clone()]).await;
        let loaded = maka_tools::availability::LoadedTools::temporary().unwrap();
        let run = RunTools::new(
            maka_agent_facts::language::Language::En,
            log.clone(),
            invocation.clone(),
            catalog.clone(),
            ToolMode::Direct,
            CodeExecutor::new(CellLimits::default()).unwrap(),
            loaded.clone(),
        );
        let request = run
            .capture(".", tokio_util::sync::CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            request
                .definitions()
                .iter()
                .map(|d| d.name.as_str())
                .collect::<Vec<_>>(),
            ["tool_search"]
        );
        let mut step = request.into_step(&invocation.invocation_id);
        assert!(
            step.invoke(&invalid, None, CancellationToken::new())
                .await
                .is_err()
        );
        let result = step
            .invoke(&search, None, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result["activated"], json!(["direct", "echo"]));
        let next = run
            .capture(".", tokio_util::sync::CancellationToken::new())
            .await
            .unwrap();
        let checkpoint = run.checkpoint().unwrap();
        let restored_loaded = maka_tools::availability::LoadedTools::temporary().unwrap();
        let restored = RunTools::new(
            maka_agent_facts::language::Language::En,
            log.clone(),
            invocation.clone(),
            catalog.clone(),
            ToolMode::Direct,
            CodeExecutor::new(CellLimits::default()).unwrap(),
            restored_loaded.clone(),
        );
        restored.restore(&checkpoint).unwrap();
        assert_eq!(
            restored
                .capture(".", tokio_util::sync::CancellationToken::new())
                .await
                .unwrap()
                .definitions(),
            next.definitions()
        );
        let mut preferences = checkpoint.clone();
        preferences.loaded.insert("withheld".into());
        restored.restore(&preferences).unwrap();
        assert_eq!(
            restored
                .capture(".", CancellationToken::new())
                .await
                .unwrap()
                .definitions(),
            next.definitions(),
            "a restored name cannot advertise an absent implementation"
        );
        let mut invalid = checkpoint.clone();
        invalid.loaded.insert(String::new());
        assert!(restored.restore(&invalid).is_err());
        assert_eq!(
            restored.checkpoint().unwrap(),
            checkpoint,
            "failed restore preserves the admitted view"
        );
        let changed = RunTools::new(
            maka_agent_facts::language::Language::En,
            log.clone(),
            invocation.clone(),
            ToolCatalog::default(),
            ToolMode::Direct,
            CodeExecutor::new(CellLimits::default()).unwrap(),
            maka_tools::availability::LoadedTools::temporary().unwrap(),
        );
        assert!(changed.restore(&checkpoint).is_err());
        drop(changed);
        let coded = RunTools::new(
            maka_agent_facts::language::Language::En,
            log.clone(),
            invocation.clone(),
            catalog.clone(),
            ToolMode::CodeMode,
            CodeExecutor::new(CellLimits::default()).unwrap(),
            loaded.clone(),
        );
        let captured_code = coded.capture(".", CancellationToken::new()).await.unwrap();
        let declarations = captured_code.definitions();
        restored_loaded.clear().unwrap();
        assert!(restored.checkpoint().unwrap().loaded.is_empty());
        assert_eq!(
            run.checkpoint().unwrap(),
            checkpoint,
            "a detached successor cannot change the prior Session preferences"
        );
        drop(restored);
        loaded.clear().unwrap();
        assert_eq!(
            captured_code.definitions(),
            declarations,
            "captured Code Mode declarations cannot reread mutable Session loading state"
        );
        assert_ne!(
            coded
                .capture(".", CancellationToken::new())
                .await
                .unwrap()
                .definitions(),
            declarations
        );
        drop(coded);
        assert_eq!(
            next.definitions()
                .iter()
                .filter(|d| d.name != "tool_search")
                .count(),
            2
        );
        assert_eq!(
            run.capture(".", tokio_util::sync::CancellationToken::new())
                .await
                .unwrap()
                .definitions()
                .len(),
            1
        );
        assert_eq!(effects.0.load(Ordering::SeqCst), 0);
        drop(run);
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    }
}

#[tokio::test]
async fn discovery_state_failure_after_successful_t2_is_fatal() {
    use crate::support::preflight;
    use maka_agent_facts::event::{CommitFuture, EventSink, EventWrite, Fact};
    use maka_agent_facts::tools::ToolError;
    use maka_code_runtime::CellLimits;
    use maka_event_log::EventLog;
    use maka_tools::availability::LoadedTools;

    struct RetireAfterSettlement {
        log: Arc<EventLog>,
        loaded: LoadedTools,
        settlements: AtomicUsize,
    }
    impl EventSink for RetireAfterSettlement {
        fn commit(self: Arc<Self>, write: EventWrite) -> CommitFuture {
            self.commit_with_prefix(&[], write)
        }
        fn commit_with_prefix(
            self: Arc<Self>,
            prefix: &[EventWrite],
            write: EventWrite,
        ) -> CommitFuture {
            let prefix = prefix.to_vec();
            Box::pin(async move {
                let settled = matches!(write.event().fact, Fact::ToolSettled { .. });
                let committed = self.log.clone().commit_with_prefix(&prefix, write).await?;
                if settled {
                    self.settlements.fetch_add(1, Ordering::SeqCst);
                    // Fail the subsequent preference write only after T2 is durable.
                    self.loaded.session().retire().unwrap();
                }
                Ok(committed)
            })
        }
    }

    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let loaded = LoadedTools::temporary().unwrap();
    let sink = Arc::new(RetireAfterSettlement {
        log: log.clone(),
        loaded: loaded.clone(),
        settlements: AtomicUsize::new(0),
    });
    let search = preflight::call("search", "tool_search", json!({"query":"echo"}));
    let invocation = preflight::invocation("discovery-state-failure");
    preflight::accepted(&log, &invocation, std::slice::from_ref(&search)).await;
    let catalog = ToolCatalog::new([registration(
        "echo",
        json!({"type":"object"}),
        Arc::new(Fixture::default()),
    )])
    .unwrap()
    .with_discovery();
    let run = RunTools::new(
        maka_agent_facts::language::Language::En,
        sink.clone(),
        invocation.clone(),
        catalog,
        ToolMode::Direct,
        CodeExecutor::new(CellLimits::default()).unwrap(),
        loaded,
    );
    let checkpoint = run.checkpoint().unwrap();
    let mut step = run
        .capture(".", CancellationToken::new())
        .await
        .unwrap()
        .into_step(&invocation.invocation_id);
    assert!(matches!(
        step.invoke(&search, None, CancellationToken::new()).await,
        Err(ToolError::Persistence(_))
    ));
    assert_eq!(sink.settlements.load(Ordering::SeqCst), 1);
    let prefix = log.prefix(32, 64 * 1024).await.unwrap();
    assert!(prefix.events.iter().any(|stored| matches!(
        &stored.event.fact,
        Fact::ToolSettled { outcome: maka_agent_facts::event::ToolOutcome::Succeeded {
            model_projection: maka_agent_facts::tool_output::DurableToolProjection::Json { value }, ..
        }, .. } if *value == json!({"activated":["echo"]})
    )));
    assert!(matches!(
        run.capture(".", CancellationToken::new()).await,
        Err(ToolError::Persistence(_))
    ));
    assert!(matches!(run.checkpoint(), Err(ToolError::Persistence(_))));
    assert!(matches!(
        run.restore(&checkpoint),
        Err(ToolError::Persistence(_))
    ));
    drop(step);
    drop(run);
    drop(sink);
    preflight::close(log).await;
}
