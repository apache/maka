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

use super::support::preflight::{Fixture, Standalone, observe};
use maka_agent_facts::{
    cells::{
        CELL_NOTIFICATION_SCHEMA_VERSION, CellEvent, CellId, CellInterruption, CellNotification,
        CellNotificationBody, CellObservation, CellOutput, CellReplyState, CellStatus,
    },
    durable::FactId,
    execution::CodeLanguage,
    tool_output::{DurableToolProjection, ProjectionPart, ToolOutput},
    tools::{ToolExecutor, ToolFuture},
};
use maka_code_runtime::CellLimits;
use maka_tools::{
    CellAdmission, CellChange, CellContent, CellPersistence, CodeCells, CodeExecutor, ToolCatalog,
    ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Block {
    release: Arc<Notify>,
    entered: Notify,
    calls: AtomicUsize,
}
impl ToolExecutor for Block {
    fn names(&self) -> Vec<String> {
        vec!["block".into()]
    }
    fn invoke(&self, _: String, _: Value, cancellation: CancellationToken) -> ToolFuture {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        // The returned future owns the release source, independent of its observer.
        let release = self.release.clone().notified_owned();
        Box::pin(async move {
            tokio::select! { _ = release => {}, _ = cancellation.cancelled() => {} }
            Ok(json!({"settled":true}))
        })
    }
}
fn catalog(block: Arc<Block>) -> ToolCatalog {
    ToolCatalog::new([ToolRegistration {
        definition: ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: "block".into(),
            description: "wait".into(),
            input_schema: json!({"type":"object"}),
        },
        handler: ToolHandler::Immediate(block),
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
    }])
    .unwrap()
}
async fn start(
    cells: &CodeCells,
    port: Arc<Standalone>,
    catalog: ToolCatalog,
    source: String,
) -> CellId {
    let admission = CellAdmission::new(source, port.owner(), port.now());
    cells
        .start_cell(&admission, catalog, port, CancellationToken::new())
        .await
        .unwrap()
}
fn text_outputs(outputs: &[CellOutput]) -> Vec<&str> {
    outputs
        .iter()
        .map(|output| match output {
            CellOutput::Text { text } => text.as_str(),
            _ => panic!("expected text output"),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn yielding_cells_keep_ancestry_deliver_deltas_share_json_and_drain_on_run_end() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let directory = tempfile::tempdir().unwrap();
        let root = Fixture::open(directory.path(), "cells").await;
        let port = root.port();
        let block = Arc::new(Block::default());
        let catalog = catalog(block.clone());
        let cells = root.cells(CodeExecutor::new(CellLimits::default()).unwrap());
        let first = start(&cells, port.clone(), catalog.clone(), "text('early'); await yield_control(); await tools.block({}); text('late'); store('n',42);".into()).await;
        let early = observe(&cells, first, false, port.clone()).await;
        assert_eq!(early.state, CellReplyState::Running);
        assert_eq!(text_outputs(early.display()), ["early"]);
        block.entered.notified().await;
        let forged = CellContent::json(&CellNotification {schema_version: CELL_NOTIFICATION_SCHEMA_VERSION, body: CellNotificationBody::Text {text: "forged".into()}}).unwrap();
        assert!(port.append(vec![CellChange::new(CellEvent::NotificationQueued {cell: CellId::new(), notification: FactId::new(), content: forged.reference.clone()}, port.now())], vec![forged]).await.is_err(), "a notification requires its actual original Cell source");
        let running = port.read(first).await.unwrap().unwrap();
        assert_eq!(running.owner, port.owner());
        assert!(running.pending());
        let operation = *running.children.keys().next().unwrap();
        let source = root.events().await;
        let bound = source.iter().find(|entry| matches!(entry.event.event, CellEvent::VmBound {cell, ..} if cell == first)).unwrap().sequence;
        let prepared = source.iter().find(|entry| matches!(entry.event.event, CellEvent::ChildPrepared {cell, operation: op, ..} if cell == first && op == operation)).unwrap().sequence;
        let admitted = source.iter().find(|entry| matches!(entry.event.event, CellEvent::ChildAdmitted {cell, operation: op} if cell == first && op == operation)).unwrap().sequence;
        assert!(bound < prepared && prepared < admitted, "the actual child remains linked to its original VM and Cell before effects");
        block.release.notify_one();
        let late = observe(&cells, first, false, port.clone()).await;
        assert!(matches!(late.state, CellReplyState::Completed {..}));
        assert_eq!(text_outputs(late.display()), ["late"], "a live observer sees only its new display delta");
        let CellObservation::Completed {content, result, ..} = &late.observation else { panic!("original completion missing") };
        assert_eq!(text_outputs(content), ["early", "late"], "the canonical result remains complete independently of display deltas");
        assert_eq!(result["value"], Value::Null);
        let CellReplyState::Completed {result: original} = late.state else {unreachable!()};
        let canonical: CellObservation = port.raw(first, original.clone()).await;
        assert_eq!(serde_json::to_value(canonical).unwrap(), serde_json::to_value(late.observation).unwrap());
        let complete_source = format!("const complete_source = {}; text(load('n'));", serde_json::to_string(&"甲".repeat(24_000)).unwrap());
        let next = start(&cells, port.clone(), catalog.clone(), complete_source.clone()).await;
        let next_output = observe(&cells, next, false, port.clone()).await;
        assert_eq!(text_outputs(next_output.display()), ["42"]);
        let next_view = port.read(next).await.unwrap().unwrap();
        assert_eq!(port.content(next, next_view.source).await.unwrap(), complete_source.as_bytes());
        let stopping = start(&cells, port.clone(), catalog.clone(), "notify('stoppable'); await yield_control(); await tools.block({});".into()).await;
        block.entered.notified().await;
        assert_eq!(observe(&cells, stopping, false, port.clone()).await.state, CellReplyState::Running);
        let stopped = observe(&cells, stopping, true, port.clone()).await;
        assert!(matches!(stopped.state, CellReplyState::Interrupted {..}));
        assert!(stopped.display().is_empty(), "termination must not repeat previously observed output");
        let unfinished = start(&cells, port.clone(), catalog, "notify('pending'); await yield_control(); await tools.block({});".into()).await;
        block.entered.notified().await;
        assert_eq!(observe(&cells, unfinished, false, port.clone()).await.state, CellReplyState::Running);
        cells.shutdown().await.unwrap();
        root.settle().await;
        for id in [first, next, stopping, unfinished] {
            let view = port.read(id).await.unwrap().unwrap();
            assert!(!view.pending());
            assert!(view.physical_cleanup_confirmed());
        }
        let source = root.events().await;
        let mut notices = Vec::new();
        for entry in &source {
            if let CellEvent::NotificationQueued {cell, content, ..} = &entry.event.event {
                let notice: CellNotification = port.raw(*cell, content.clone()).await;
                let CellNotificationBody::Text {text} = notice.body else {panic!("unexpected notification source")};
                notices.push((*cell, text));
            }
        }
        assert_eq!(notices, [(stopping, "stoppable".into()), (unfinished, "pending".into())]);
        assert_eq!(block.calls.load(Ordering::SeqCst), 3);
        drop(cells); drop(port);
        root.close().await;
        let reopened = Fixture::open(directory.path(), "cells").await;
        let port = reopened.port();
        let recovered: CellObservation = port.raw(first, original).await;
        let CellObservation::Completed {content, ..} = recovered else {panic!("original source is not renderable")};
        assert_eq!(text_outputs(&content), ["early", "late"]);
        for id in [first, next, stopping, unfinished] {assert!(!port.read(id).await.unwrap().unwrap().pending());}
        assert_eq!(reopened.events().await.len(), source.len(), "reading original reports cannot publish or repeat notifications");
        drop(port);
        reopened.close().await;
    }).await.expect("Code Mode observation and shutdown must not hang");
}

#[tokio::test]
async fn a_throwing_cell_settles_as_an_error_result() {
    let directory = tempfile::tempdir().unwrap();
    let root = Fixture::open(directory.path(), "throwing").await;
    let port = root.port();
    let cells = root.cells(CodeExecutor::new(CellLimits::default()).unwrap());
    let cell = start(
        &cells,
        port.clone(),
        ToolCatalog::default(),
        "throw new Error('boom');".into(),
    )
    .await;
    let observed = observe(&cells, cell, false, port.clone()).await;
    let CellReplyState::Interrupted { report } = &observed.state else {
        panic!("throwing Cell did not record an error")
    };
    let canonical: CellInterruption = port.raw(cell, report.clone()).await;
    assert!(canonical.diagnostic.contains("boom"));
    assert_eq!(
        serde_json::from_str::<Value>(&canonical.diagnostic).unwrap()["ok"],
        false
    );
    let normalized = CodeCells::project_observation(cell, observed, 1000)
        .into_durable("throw-observation", SystemTime::now(), &root.execution)
        .unwrap();
    assert!(
        normalized.is_error,
        "both the canonical Cell and its model-visible observation report failure"
    );
    let ToolOutput::Cell(reply) = normalized.output else {
        panic!("Cell observation lost its typed evidence")
    };
    assert_eq!(
        reply.observation["report"]["diagnostic"],
        canonical.diagnostic
    );
    cells.shutdown().await.unwrap();
    assert!(!port.read(cell).await.unwrap().unwrap().pending());
    drop(cells);
    drop(port);
    root.close().await;
}

#[tokio::test]
async fn collected_cell_recovery_uses_the_original_run_language_and_keeps_user_output() {
    for language in ["en", "zh-CN", "zh-TW"] {
        let directory = tempfile::tempdir().unwrap();
        let root = Fixture::open(directory.path(), language).await;
        let port = root.port();
        let block = Arc::new(Block::default());
        block.release.notify_one();
        let cells = root.cells(CodeExecutor::new(CellLimits::default()).unwrap());
        let cell = start(
            &cells,
            port.clone(),
            catalog(block.clone()),
            "await tools.block({}); text('original 用户資料');".into(),
        )
        .await;
        let finished = observe(&cells, cell, false, port.clone()).await;
        assert!(matches!(finished.state, CellReplyState::Completed { .. }));
        assert_eq!(text_outputs(finished.display()), ["original 用户資料"]);
        let original = serde_json::to_value(&finished.observation).unwrap();
        cells.shutdown().await.unwrap();
        drop(cells);
        let source_count = root.events().await.len();
        // Heap collection and a different current interpreter do not invalidate a recorded report.
        let cold = root.cells(
            CodeExecutor::new(CellLimits::default())
                .unwrap()
                .with_language(CodeLanguage::Python),
        );
        let recovered = observe(&cold, cell, false, port.clone()).await;
        assert_eq!(recovered.state, finished.state);
        assert_eq!(
            serde_json::to_value(&recovered.observation).unwrap(),
            original
        );
        assert_eq!(text_outputs(recovered.display()), ["original 用户資料"]);
        let missing = cold
            .observe_cell(
                CellId::new(),
                Duration::ZERO,
                false,
                port.clone(),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await;
        assert!(
            matches!(missing, Err(maka_agent_facts::tools::ToolError::Failed(message)) if message.contains("not recorded"))
        );
        assert_eq!(root.events().await.len(), source_count);
        assert_eq!(
            block.calls.load(Ordering::SeqCst),
            1,
            "neither cold observation nor absence replays the original child"
        );
        cold.shutdown().await.unwrap();
        drop(cold);
        drop(port);
        root.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cells_accept_concurrent_work_and_honor_the_requested_output_budget() {
    let directory = tempfile::tempdir().unwrap();
    let root = Fixture::open(directory.path(), "many-cells").await;
    let port = root.port();
    let block = Arc::new(Block::default());
    let catalog = catalog(block.clone());
    let cells = root.cells(CodeExecutor::new(CellLimits::default()).unwrap());
    let expected = "x".repeat(140 * 1024);
    let mut originals = Vec::new();
    for index in 0..5 {
        let cell = start(
            &cells,
            port.clone(),
            catalog.clone(),
            "text('x'.repeat(140 * 1024)); await yield_control(); await tools.block({});".into(),
        )
        .await;
        block.entered.notified().await;
        let observed = observe(&cells, cell, false, port.clone()).await;
        assert_eq!(observed.state, CellReplyState::Running);
        assert_eq!(text_outputs(observed.display()), [expected.as_str()]);
        let normalized = CodeCells::project_observation(cell, observed, 50_000)
            .into_durable(
                &format!("observe-{index}"),
                SystemTime::now(),
                &root.execution,
            )
            .unwrap();
        let DurableToolProjection::Content { parts } = normalized.projection else {
            panic!("model-facing Cell output lost its requested budget projection")
        };
        assert!(matches!(parts.last(), Some(ProjectionPart::Text {text}) if text == &expected));
        let ToolOutput::Cell(reply) = normalized.output else {
            panic!("full raw observation missing")
        };
        assert_eq!(reply.observation["content"][0]["text"], expected);
        originals.push(cell);
    }
    assert_eq!(
        block.calls.load(Ordering::SeqCst),
        5,
        "five distinct actual child effects coexist"
    );
    cells.shutdown().await.unwrap();
    root.settle().await;
    let source = root.events().await;
    let mut complete = 0;
    for cell in originals {
        let view = port.read(cell).await.unwrap().unwrap();
        assert!(!view.pending());
        assert!(view.physical_cleanup_confirmed());
        let CellStatus::Interrupted { report } = view.status else {
            panic!("unfinished Cell has no original interruption evidence")
        };
        let report: CellInterruption = port.raw(cell, report).await;
        assert_eq!(
            text_outputs(&report.prior_output.unwrap().content),
            [expected.as_str()]
        );
        complete += source.iter().filter(|entry| matches!(entry.event.event, CellEvent::Interrupted {cell: id, ..} if id == cell)).count();
    }
    assert_eq!(
        complete, 5,
        "each original source retains the complete previously observed output"
    );
    drop(cells);
    drop(port);
    root.close().await;
}
