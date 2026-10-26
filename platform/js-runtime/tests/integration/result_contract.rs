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

use maka_code_runtime::{CellAbort, CellDiagnosticKind, CellLimits, CellResult};
use maka_js_runtime::CodeExecutor;
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn complete_source_runs_forty_ordered_effects_and_returns_complete_value() {
    struct Ordered(std::sync::Mutex<Vec<serde_json::Value>>);
    impl maka_agent_facts::tools::ToolExecutor for Ordered {
        fn names(&self) -> Vec<String> {
            vec!["echo".into()]
        }
        fn invoke(
            &self,
            _: String,
            input: serde_json::Value,
            _: CancellationToken,
        ) -> maka_agent_facts::tools::ToolFuture {
            self.0.lock().unwrap().push(input.clone());
            Box::pin(async move { Ok(input) })
        }
    }
    let literal = "保留😀z".repeat(8_000);
    let source = format!(
        "const original = {}; for(let index=0;index<40;index++) {{ const value=await tools.echo({{index,first:original.slice(0,5),last:original.slice(-5)}}); if(value.index!==index) throw Error('effect order'); }} return {{original,complete:'完整😀'.repeat(100000)}};",
        serde_json::to_string(&literal).unwrap()
    );
    assert!(source.len() > 65_536);
    let tools = Arc::new(Ordered(Default::default()));
    let result = CodeExecutor::new(CellLimits::default())
        .unwrap()
        .execute(source, tools.clone(), CancellationToken::new())
        .await;
    // execute returns only after the isolate's original admitted work has drained.
    let expected = (0..40)
        .map(|index| json!({"index":index,"first":"保留😀z","last":"保留😀z"}))
        .collect::<Vec<_>>();
    let calls = tools.0.lock().unwrap().clone();
    assert_eq!(
        calls.len(),
        40,
        "complete source must admit every ordered effect"
    );
    assert_eq!(calls, expected);
    let result = result.unwrap();
    let CellResult::Success { value, tool_calls } = result else {
        panic!("complete source must return success")
    };
    assert_eq!(
        tool_calls
            .iter()
            .map(|call| (call.index, call.name.as_str()))
            .collect::<Vec<_>>(),
        (1..=40).map(|index| (index, "echo")).collect::<Vec<_>>()
    );
    assert!(
        value["original"].as_str() == Some(literal.as_str()),
        "complete literal source changed"
    );
    let complete = "完整😀".repeat(100_000);
    assert!(serde_json::to_vec(&value).unwrap().len() > 1024 * 1024);
    assert!(
        value["complete"].as_str() == Some(complete.as_str()),
        "complete returned value changed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn complete_scratch_output_and_notifications_survive_cell_settlement() {
    use maka_code_runtime::{CellContext, CellOutput, CellStore};
    let store = CellStore::temporary().unwrap();
    let context = CellContext::new(store.clone(), vec![]).unwrap();
    let engine = CodeExecutor::new(CellLimits::default()).unwrap();
    let result = engine.execute_with_context(
        "const complete='保留😀z'.repeat(100000); store('original',complete); for(let index=0;index<70;index++) text(String(index)); text(complete); notify(complete); return complete;".into(),
        Arc::new(Echo::default()), CancellationToken::new(), context.clone()
    ).await.unwrap();
    let committed = context.commit();
    let output = context.take_output();
    let notifications = context.take_notifications();
    assert!(
        matches!(result, CellResult::Success { .. }),
        "full scratch/output must complete"
    );
    committed.unwrap();
    let complete = "保留😀z".repeat(100_000);
    assert_eq!(output.len(), 71, "all emitted entries must survive");
    for (index, output) in output[..70].iter().enumerate() {
        assert!(matches!(output,CellOutput::Text { text } if text == &index.to_string()));
    }
    assert!(
        matches!(&output[70],CellOutput::Text {text} if text == &complete),
        "complete output changed"
    );
    assert_eq!(notifications.len(), 1);
    assert!(
        notifications.front() == Some(&complete),
        "complete notification changed"
    );
    let next = CellContext::new(store, vec![]).unwrap();
    let loaded = engine
        .execute_with_context(
            "return load('original');".into(),
            Arc::new(Echo::default()),
            CancellationToken::new(),
            next,
        )
        .await
        .unwrap();
    assert!(
        matches!(loaded,CellResult::Success {value,..} if value.as_str() == Some(complete.as_str())),
        "committed scratch must survive in the next cell"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nested_tool_roundtrips_large_utf8_values_with_a_small_cell_result() {
    let limits = CellLimits::default();
    let expected_input = json!({"text":"中文😀\n".repeat(200_000),"tag":"original-large-echo"});
    assert!(serde_json::to_vec(&expected_input).unwrap().len() > 1024 * 1024);
    let engine = CodeExecutor::new(limits).unwrap();
    let result = engine.execute(
        "const text = '中文😀\\n'.repeat(200000); const result = await tools.echo({text,tag:'original-large-echo'}); if (result.text !== text || result.tag !== 'original-large-echo' || Object.keys(result).length !== 2) throw Error('original tool output changed'); return {units:result.text.length,tag:result.tag};".into(),
        Arc::new(Echo { expected_input: Some(expected_input) }),
        CancellationToken::new(),
    ).await.unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({
            "ok":true,"value":{"units":1_000_000,"tag":"original-large-echo"},
            "toolCalls":[{"index":1,"name":"echo"}]
        })
    );
}

#[derive(Default)]
struct Echo {
    expected_input: Option<serde_json::Value>,
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_budget_interrupts_loops_and_accumulates_across_tool_waits() {
    let engine = CodeExecutor::new(CellLimits {
        timeout: std::time::Duration::from_millis(150),
        ..Default::default()
    })
    .unwrap();
    for (index, source) in [
        "while (true) {}",
        "await Promise.resolve(); while (true) {}",
        "for (let i=0; i<20; i++) { const end=Date.now()+20; while(Date.now()<end) {} await tools.echo({}); }",
    ].into_iter().enumerate() {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            engine.execute(source.into(), Arc::new(Echo::default()), CancellationToken::new()),
        ).await.expect("V8 execution must be interruptible").unwrap();
        let CellResult::Failure { error, tool_calls } = result else { panic!("{result:?}") };
        assert_eq!(error.kind, CellDiagnosticKind::LimitExceeded);
        if index == 2 { assert!(!tool_calls.is_empty() && tool_calls.len() < 20); }
    }
    assert_eq!(
        serde_json::to_value(
            engine
                .execute(
                    "return 7;".into(),
                    Arc::new(Echo::default()),
                    CancellationToken::new()
                )
                .await
                .unwrap()
        )
        .unwrap(),
        json!({"ok":true,"value":7,"toolCalls":[]})
    );
}
struct Failure {
    error: maka_agent_facts::tools::ToolError,
    calls: std::sync::atomic::AtomicUsize,
}
impl maka_agent_facts::tools::ToolExecutor for Failure {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn invoke(
        &self,
        _: String,
        _: serde_json::Value,
        _: CancellationToken,
    ) -> maka_agent_facts::tools::ToolFuture {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let error = self.error.clone();
        Box::pin(async move { Err(error) })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_errors_are_catchable_but_fatal_errors_prevent_later_effects() {
    use maka_agent_facts::tools::ToolError;
    let engine = CodeExecutor::new(CellLimits::default()).unwrap();
    for error in [
        ToolError::Failed("parse_error".into()),
        ToolError::Persistence("T1 failed".into()),
        ToolError::CleanupUnconfirmed("worker did not settle".into()),
    ] {
        let fatal = !matches!(error, ToolError::Failed(_));
        let tools = Arc::new(Failure {
            error,
            calls: Default::default(),
        });
        let result = engine.execute(
            "try { await tools.echo({}); } catch {} try { await tools.echo({}); } catch {} return 7;".into(),
            tools.clone(), CancellationToken::new()
        ).await;
        assert_eq!(
            tools.calls.load(std::sync::atomic::Ordering::SeqCst),
            if fatal { 1 } else { 2 }
        );
        if fatal {
            assert!(matches!(
                result,
                Err(CellAbort::Tool(
                    ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_)
                ))
            ));
        } else {
            assert_eq!(
                serde_json::to_value(result.unwrap()).unwrap(),
                json!({"ok":true,"value":7,"toolCalls":[{"index":1,"name":"echo"},{"index":2,"name":"echo"}]})
            );
            let result = engine
                .execute(
                    "await tools.echo({});".into(),
                    tools,
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                json!({"ok":false,"error":{"kind":"tool_failure","message":"tool failed: parse_error"},"toolCalls":[{"index":1,"name":"echo"}]})
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_precedes_execution() {
    let engine = CodeExecutor::new(CellLimits::default()).unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        engine
            .execute("return 7;".into(), Arc::new(Echo::default()), cancel)
            .await,
        Err(CellAbort::Cancelled)
    ));
}
impl maka_agent_facts::tools::ToolExecutor for Echo {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn invoke(
        &self,
        _: String,
        input: serde_json::Value,
        _: CancellationToken,
    ) -> maka_agent_facts::tools::ToolFuture {
        if let Some(expected) = &self.expected_input {
            assert_eq!(
                &input, expected,
                "the tool must receive the exact original large input"
            );
        }
        Box::pin(async move { Ok(input) })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_envelopes_and_structured_diagnostics() {
    let engine = CodeExecutor::new(CellLimits::default()).unwrap();
    for source in ["", "return null;"] {
        let value = engine
            .execute(
                source.into(),
                Arc::new(Echo::default()),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(value).unwrap(),
            json!({"ok":true,"value":null,"toolCalls":[]})
        );
    }
    for (source, kind) in [
        ("return (;", "parse_error"),
        ("throw new SyntaxError('unknown tool');", "execution_error"),
        ("await tools.missing({});", "execution_error"),
        (
            "throw {kind: 'tool_failure', message: 'fake'};",
            "execution_error",
        ),
    ] {
        let value = engine
            .execute(
                source.into(),
                Arc::new(Echo::default()),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let value = serde_json::to_value(value).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["kind"], kind);
        assert_eq!(value["toolCalls"], json!([]));
        assert!(value.get("value").is_none());
    }
}
#[test]
fn rejects_invalid_execution_resources() {
    assert!(
        CodeExecutor::new(CellLimits {
            timeout: std::time::Duration::ZERO,
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        CodeExecutor::new(CellLimits {
            heap_bytes: 1,
            ..Default::default()
        })
        .is_err()
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn complete_diagnostics_keep_every_admitted_call() {
    let engine = CodeExecutor::new(CellLimits::default()).unwrap();
    let result=engine.execute("await tools.echo({}); await tools.echo({}); throw Error('汉\\n\\u0001'.repeat(100000));".into(),Arc::new(Echo::default()),CancellationToken::new()).await.unwrap();
    let CellResult::Failure { error, tool_calls } = result else {
        panic!("expected an actual JavaScript error")
    };
    assert_eq!(error.kind, CellDiagnosticKind::ExecutionError);
    assert!(
        error.message.ends_with(&"汉\n\u{1}".repeat(100000)),
        "complete diagnostic suffix changed"
    );
    assert_eq!(
        tool_calls.iter().map(|c| c.index).collect::<Vec<_>>(),
        vec![1, 2]
    );
}
