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

use super::support::preflight::{Fixture, observe};
use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{
        CellEvent, CellObservation, CellOutput, CellReplyState, CellReturnedResult, CellStatus,
    },
    tools::{ToolExecutor, ToolFuture},
};
use maka_code_runtime::CellLimits;
use maka_tools::{
    CellAdmission, CellPersistence, CodeExecutor, ToolCatalog, ToolDefinition, ToolHandler,
    ToolNesting, ToolRegistration, ToolSemantics,
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
    let root = Fixture::open(directory.path(), "large-output").await;
    let port = root.port();
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
    let cells = root.cells(CodeExecutor::new(CellLimits::default()).unwrap());
    let mut originals = Vec::new();
    for (name, code, expected_text) in [
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
        let admission = CellAdmission::new(code.into(), port.owner(), port.now());
        let cell = cells
            .start_cell(
                &admission,
                catalog.clone(),
                port.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let observed = observe(&cells, cell, false, port.clone()).await;
        let CellReplyState::Completed { result: completion } = observed.state else {
            panic!("{name} did not complete")
        };
        let CellObservation::Completed {
            content, result, ..
        } = observed.observation
        else {
            panic!("{name} has no completion observation")
        };
        assert_eq!(result["ok"], true);
        assert_eq!(
            content,
            [CellOutput::Text {
                text: expected_text.clone()
            }],
            "complete Cell emission must match independently expected JSON bytes"
        );
        let events = root.events().await;
        let outcomes = events
            .iter()
            .filter(|entry| {
                entry.event.event.cell() == cell
                    && matches!(
                        &entry.event.event,
                        CellEvent::LocalChildReturned { .. }
                            | CellEvent::Completed { .. }
                            | CellEvent::ResultAccepted { .. }
                    )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes.len(),
            3,
            "child return, Cell completion and atomic result acceptance have original canonical sources"
        );
        assert!(
            outcomes
                .windows(2)
                .all(|pair| pair[0].sequence < pair[1].sequence)
        );
        let CellEvent::LocalChildReturned { result: child, .. } = &outcomes[0].event.event else {
            panic!("original child return missing")
        };
        let returned: ToolReturn<CellReturnedResult> = port.raw(cell, child.clone()).await;
        assert!(!returned.body.is_error);
        assert_eq!(returned.body.output.into_json(), effect.value);
        let view = port.read(cell).await.unwrap().unwrap();
        assert!(matches!(
            view.status,
            CellStatus::Completed { accepted: true, .. }
        ));
        assert!(!view.pending());
        assert!(view.physical_cleanup_confirmed());
        originals.push((cell, child.clone(), completion, expected_text));
    }
    assert_eq!(effect.calls.load(Ordering::SeqCst), 2);
    cells.shutdown().await.unwrap();
    drop(cells);
    drop(port);
    root.close().await;
    let reopened = Fixture::open(directory.path(), "large-output").await;
    let port = reopened.port();
    for (cell, child, completion, expected) in originals {
        let returned: ToolReturn<CellReturnedResult> = port.raw(cell, child).await;
        assert_eq!(returned.body.output.into_json(), effect.value);
        let completed: CellObservation = port.raw(cell, completion).await;
        let CellObservation::Completed { content, .. } = completed else {
            panic!("reopened original report is not complete")
        };
        assert_eq!(content, [CellOutput::Text { text: expected }]);
        assert!(!port.read(cell).await.unwrap().unwrap().pending());
    }
    assert_eq!(
        effect.calls.load(Ordering::SeqCst),
        2,
        "reopening only reads original evidence"
    );
    drop(port);
    reopened.close().await;
}
