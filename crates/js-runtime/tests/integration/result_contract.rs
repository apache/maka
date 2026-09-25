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

use maka_js_runtime::{
    CellAbort, CellDiagnostic, CellDiagnosticKind, CellLimits, CellResult, CodeExecutor,
};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enforces_tool_call_and_serialized_value_limits() {
    let engine = CodeExecutor::new(
        1,
        CellLimits {
            max_tool_calls: 1,
            max_value_bytes: 160,
            ..Default::default()
        },
    )
    .unwrap();
    let result = engine
        .execute(
            "await tools.echo({}); return await tools.echo({});".into(),
            Arc::new(Echo),
            CancellationToken::new(),
        )
        .await;
    assert!(serde_json::to_vec(result.as_ref().unwrap()).unwrap().len() <= 160);
    assert!(
        matches!(result, Ok(CellResult::Failure { error: CellDiagnostic { kind: CellDiagnosticKind::LimitExceeded, message }, tool_calls }) if message.contains("admission limit") && tool_calls.len() == 1)
    );
    let result = engine
        .execute(
            "return 'x'.repeat(300);".into(),
            Arc::new(Echo),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        result,
        Ok(CellResult::Failure {
            error: CellDiagnostic {
                kind: CellDiagnosticKind::LimitExceeded,
                ..
            },
            ..
        })
    ));
    let result = engine
        .execute(
            "return await tools.echo({text:'x'.repeat(300)});".into(),
            Arc::new(Echo),
            CancellationToken::new(),
        )
        .await;
    assert!(serde_json::to_vec(result.as_ref().unwrap()).unwrap().len() <= 160);
    assert!(
        matches!(result, Ok(CellResult::Failure { error: CellDiagnostic { kind: CellDiagnosticKind::LimitExceeded, message }, tool_calls }) if message.contains("input byte limit") && tool_calls.is_empty())
    );
}

struct Echo;
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_budget_interrupts_loops_and_accumulates_across_tool_waits() {
    let engine = CodeExecutor::new(
        1,
        CellLimits {
            timeout: std::time::Duration::from_millis(150),
            ..Default::default()
        },
    )
    .unwrap();
    for (index, source) in [
        "while (true) {}",
        "await Promise.resolve(); while (true) {}",
        "for (let i=0; i<20; i++) { const end=Date.now()+20; while(Date.now()<end) {} await tools.echo({}); }",
    ].into_iter().enumerate() {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            engine.execute(source.into(), Arc::new(Echo), CancellationToken::new()),
        ).await.expect("V8 execution must be interruptible").unwrap();
        let CellResult::Failure { error, tool_calls } = result else { panic!("{result:?}") };
        assert_eq!(error.kind, CellDiagnosticKind::LimitExceeded);
        if index == 2 { assert!(!tool_calls.is_empty() && tool_calls.len() < 20); }
    }
    assert_eq!(
        serde_json::to_value(
            engine
                .execute("return 7;".into(), Arc::new(Echo), CancellationToken::new())
                .await
                .unwrap()
        )
        .unwrap(),
        json!({"ok":true,"value":7,"toolCalls":[]})
    );
}
struct Failure {
    error: maka_runtime::tools::ToolError,
    calls: std::sync::atomic::AtomicUsize,
}
impl maka_runtime::tools::ToolExecutor for Failure {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn invoke(
        &self,
        _: String,
        _: serde_json::Value,
        _: CancellationToken,
    ) -> maka_runtime::tools::ToolFuture {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let error = self.error.clone();
        Box::pin(async move { Err(error) })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_errors_are_catchable_but_fatal_errors_prevent_later_effects() {
    use maka_runtime::tools::ToolError;
    let engine = CodeExecutor::new(1, CellLimits::default()).unwrap();
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
async fn cancellation_precedes_source_limit() {
    let engine = CodeExecutor::new(
        1,
        CellLimits {
            max_source_bytes: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        engine
            .execute("return 7;".into(), Arc::new(Echo), cancel)
            .await,
        Err(CellAbort::Cancelled)
    ));
}
impl maka_runtime::tools::ToolExecutor for Echo {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn invoke(
        &self,
        _: String,
        input: serde_json::Value,
        _: CancellationToken,
    ) -> maka_runtime::tools::ToolFuture {
        Box::pin(async move { Ok(input) })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_envelopes_and_structured_diagnostics() {
    let engine = CodeExecutor::new(1, CellLimits::default()).unwrap();
    for source in ["", "return null;"] {
        let value = engine
            .execute(source.into(), Arc::new(Echo), CancellationToken::new())
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
            .execute(source.into(), Arc::new(Echo), CancellationToken::new())
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
fn rejects_budget_too_small_for_a_diagnostic() {
    assert!(matches!(
        CodeExecutor::new(
            1,
            CellLimits {
                max_value_bytes: 32,
                ..Default::default()
            }
        ),
        Err(CellAbort::Internal(_))
    ));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_and_large_error_fit_the_whole_envelope() {
    let engine = CodeExecutor::new(
        1,
        CellLimits {
            max_value_bytes: 120,
            ..Default::default()
        },
    )
    .unwrap();
    for source in [
        "await tools.echo({}); throw Error('x'.repeat(1000));",
        "await tools.echo({}); throw Error('汉\\n\\u0001'.repeat(100000));",
        "await tools.echo({}); return 'x'.repeat(90);",
        "await tools.echo({}); await tools.echo({});",
    ] {
        let value = engine
            .execute(source.into(), Arc::new(Echo), CancellationToken::new())
            .await
            .unwrap();
        let encoded = serde_json::to_vec(&value).unwrap();
        assert!(encoded.len() <= 120);
        let CellResult::Failure { tool_calls, .. } = value else {
            panic!("expected failure")
        };
        assert_eq!(tool_calls.len(), 1);
    }
}
