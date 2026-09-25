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

use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_runtime::{
    event::{Fact, ToolOutcome},
    tools::{ToolExecutor, ToolFuture},
};
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
async fn child_output_limit_after_t2_preserves_raw_and_remains_catchable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    assert_eq!(CellLimits::default().max_value_bytes, 1024 * 1024);
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
    let cells = CodeExecutor::new(1, CellLimits::default()).unwrap();
    let mut children = Vec::new();
    for (id, code, caught) in [
        ("uncaught", "text(await tools.read({}));", false),
        (
            "caught",
            "try { await tools.read({}); } catch (_) { text('caught'); }",
            true,
        ),
    ] {
        let invocation = support::invocation(id);
        let call = support::call("exec", "exec", json!({"code": code}));
        support::accepted(&log, &invocation, std::slice::from_ref(&call)).await;
        let run = RunTools::new(
            log.clone(),
            invocation.clone(),
            catalog.clone(),
            ToolMode::CodeMode,
            cells.clone(),
        );
        let result = run
            .capture(".", tokio_util::sync::CancellationToken::new())
            .await
            .unwrap()
            .into_step(&invocation.invocation_id)
            .invoke(&call, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result["result"]["ok"], caught);
        if caught {
            assert_eq!(result["content"][0]["text"], "caught");
        } else {
            assert_eq!(result["result"]["error"]["kind"], "limit_exceeded");
            assert_eq!(
                result["result"]["error"]["message"],
                "tool output byte limit exceeded"
            );
        }
        let prefix = log.prefix(32, 64 * 1024).await.unwrap();
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
            log.invocation_recovery(&invocation, 32, 64 * 1024)
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
