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

use crate::support::preflight as support;

use maka_agent_facts::event::Fact;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use maka_code_runtime::CellLimits;
use maka_event_log::EventLog;
use maka_tools::CodeExecutor;
use maka_tools::{
    RunTools, ToolCatalog, ToolDefinition, ToolHandler, ToolMode, ToolNesting, ToolRegistration,
    ToolSemantics,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

struct LargeOutput {
    value: Value,
    calls: AtomicUsize,
}

impl ToolExecutor for LargeOutput {
    fn names(&self) -> Vec<String> {
        vec!["read".into()]
    }

    fn invoke(&self, _: String, _: Value, _: CancellationToken) -> ToolFuture {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let value = self.value.clone();
        Box::pin(async move { Ok(value) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_child_value_is_consumable_and_complete_cell_emission_remains_durable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let effect = Arc::new(LargeOutput {
        value: json!({"text": "x".repeat(1024 * 1024)}),
        calls: AtomicUsize::new(0),
    });
    let catalog = ToolCatalog::new([ToolRegistration {
        definition: ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: "read".into(),
            description: "return a large child result".into(),
            input_schema: json!({"type":"object"}),
        },
        handler: ToolHandler::Immediate(effect.clone()),
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
    }])
    .unwrap();
    let cells = CodeExecutor::new(CellLimits::default()).unwrap();
    let mut children = Vec::new();
    for (id, code, expected_text) in [
        (
            "consumed",
            "const value = await tools.read({}); let sum = 0; for (let i = 0; i < value.text.length; i++) sum += value.text.charCodeAt(i); text({length: value.text.length, codePointSum: sum});",
            "{\"length\":1048576,\"codePointSum\":125829120}".to_owned(),
        ),
        (
            "complete-emission",
            "const value = await tools.read({}); text(value);",
            serde_json::to_string(&effect.value).unwrap(),
        ),
    ] {
        let invocation = support::invocation(id);
        let call = support::call("exec", "exec", json!({"code": code}));
        support::accepted(&log, &invocation, std::slice::from_ref(&call)).await;
        let run = RunTools::new(
            maka_agent_facts::language::Language::En,
            log.clone(),
            invocation.clone(),
            catalog.clone(),
            ToolMode::CodeMode,
            cells.clone(),
            maka_tools::availability::LoadedTools::temporary().unwrap(),
        );
        let result = run
            .capture(".", tokio_util::sync::CancellationToken::new())
            .await
            .unwrap()
            .into_step(&invocation.invocation_id)
            .invoke(&call, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result["result"]["ok"], true);
        assert_eq!(result["content"].as_array().unwrap().len(), 1);
        assert_eq!(result["content"][0]["kind"], "text");
        assert!(
            result["content"][0]["text"].as_str() == Some(expected_text.as_str()),
            "complete cell emission must match the independently expected JSON bytes"
        );
        // Both cases share this ledger; each retains the complete child value.
        let prefix = log.prefix(32, 2 * 1024 * 1024 + 64 * 1024).await.unwrap();
        let outcomes: Vec<_> = prefix
            .events
            .iter()
            .filter(|stored| stored.event.invocation == invocation)
            .filter(|stored| {
                matches!(
                    stored.event.fact,
                    Fact::ToolSettled {
                        outcome: ToolOutcome::Succeeded { .. },
                        ..
                    }
                )
            })
            .collect();
        assert_eq!(
            outcomes.len(),
            3,
            "child, cell and its observation have durable success"
        );
        let child = &outcomes[0].event;
        assert_eq!(
            log.resolve_tool_result(&invocation.session_id, &child.id)
                .await
                .unwrap()
                .into_json(),
            effect.value
        );
        assert!(
            log.invocation_recovery(&invocation)
                .await
                .unwrap()
                .uncertain_operations
                .is_empty()
        );
        children.push((invocation.session_id, child.id.clone()));
    }
    assert_eq!(effect.calls.load(Ordering::SeqCst), 2);
    support::close(log).await;
    let reopened = EventLog::open(&path).await.unwrap();
    for (session, event) in children {
        assert_eq!(
            reopened
                .resolve_tool_result(&session, &event)
                .await
                .unwrap()
                .into_json(),
            effect.value
        );
    }
    reopened.close().await.unwrap();
}
