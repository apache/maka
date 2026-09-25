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

use std::sync::Arc;
use std::time::Duration;

use maka_js_runtime::{CellDiagnostic, CellDiagnosticKind, CellLimits, CellResult, CodeExecutor};
use maka_runtime::tools::{ToolExecutor, ToolFuture};
use serde_json::{Value, json};
use tokio::sync::{Barrier, Notify};
use tokio_util::sync::CancellationToken;

struct Tools<F>(F);
impl<F> ToolExecutor for Tools<F>
where
    F: Fn(String, Value, CancellationToken) -> ToolFuture + Send + Sync + 'static,
{
    fn names(&self) -> Vec<String> {
        vec!["echo".into(), "wait".into()]
    }
    fn invoke(&self, name: String, input: Value, cancel: CancellationToken) -> ToolFuture {
        (self.0)(name, input, cancel)
    }
}

fn echo() -> Arc<dyn ToolExecutor> {
    Arc::new(Tools(|_name, value, _cancel| -> ToolFuture {
        Box::pin(async { Ok(value) })
    }))
}

fn executor() -> CodeExecutor {
    CodeExecutor::new(
        2,
        CellLimits {
            timeout: Duration::from_secs(5),
            ..Default::default()
        },
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_cells_await_parallel_rust_tools_without_leaking_globals() {
    let barrier = Arc::new(Barrier::new(2));
    let tools = Arc::new(Tools(move |_name, value, _cancel| -> ToolFuture {
        let barrier = barrier.clone();
        Box::pin(async move {
            barrier.wait().await;
            Ok(value)
        })
    }));
    let engine = executor();
    let output = engine.execute(
        "globalThis.secret = 42; return await Promise.all([tools.echo({id:1}), tools.echo({id:2})]);".into(),
        tools, CancellationToken::new(),
    ).await.unwrap();
    assert_eq!(output.success_value(), json!([{"id":1},{"id":2}]));
    assert_eq!(
        output
            .calls()
            .iter()
            .map(|call| call.index)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    let output = engine.execute(
        "return [globalThis.secret ?? null, typeof process, typeof Deno, typeof fetch, Object.keys(tools)];".into(),
        echo(), CancellationToken::new(),
    ).await.unwrap();
    assert_eq!(
        output.success_value(),
        json!([
            null,
            "undefined",
            "undefined",
            "undefined",
            ["echo", "wait"]
        ])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_waits_do_not_spend_execution_budget_even_for_unawaited_effects() {
    for source in [
        "tools.wait({}); return 9;",
        "await tools.wait({}); return 9;",
    ] {
        let started = Arc::new(Notify::new());
        let released = Arc::new(Notify::new());
        let tools = {
            let started = started.clone();
            let released = released.clone();
            Arc::new(Tools(move |_name, _value, _cancel| -> ToolFuture {
                let started = started.clone();
                let released = released.clone();
                Box::pin(async move {
                    started.notify_one();
                    released.notified().await;
                    Ok(json!("settled"))
                })
            }))
        };
        let mut task = tokio::spawn(async move {
            CodeExecutor::new(
                1,
                CellLimits {
                    timeout: Duration::from_millis(200),
                    ..Default::default()
                },
            )
            .unwrap()
            .execute(source.into(), tools, CancellationToken::new())
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), started.notified())
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(500), &mut task)
                .await
                .is_err()
        );
        released.notify_one();
        assert_eq!(task.await.unwrap().unwrap().success_value(), json!(9));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn javascript_failure_cancels_and_drains_dispatched_tools() {
    // Both exceptions and successful module completion cancel unawaited work,
    // but neither may release the cell before the admitted effect drains.
    for fail in [false, true] {
        let dispatched = Arc::new(Notify::new());
        let cancelled = Arc::new(Notify::new());
        let released = Arc::new(Notify::new());
        let tools = {
            let dispatched = dispatched.clone();
            let cancelled = cancelled.clone();
            let released = released.clone();
            Arc::new(Tools(
                move |name, _value, cancel: CancellationToken| -> ToolFuture {
                    let dispatched = dispatched.clone();
                    let cancelled = cancelled.clone();
                    let released = released.clone();
                    Box::pin(async move {
                        if name == "echo" {
                            dispatched.notified().await;
                            return Ok(Value::Null);
                        }
                        dispatched.notify_one();
                        cancel.cancelled().await;
                        cancelled.notify_one();
                        released.notified().await;
                        Ok(Value::Null)
                    })
                },
            ))
        };
        // Admission precedes dispatch. Wait for the tool to enter before failing JS,
        // otherwise cancellation may correctly prevent dispatch altogether.
        let mut task = tokio::spawn(async move {
            let context = maka_js_runtime::CellContext::new(
                maka_js_runtime::CellStore::default(),
                4096,
                vec![],
            );
            executor()
                .execute_module(
                    format!(
                        "tools.wait({{}}); await tools.echo({{}}); {}",
                        if fail {
                            "throw new Error('cell-failure');"
                        } else {
                            "text('finished');"
                        }
                    ),
                    tools,
                    CancellationToken::new(),
                    context,
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), cancelled.notified())
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut task)
                .await
                .is_err()
        );
        released.notify_one();
        let result = task.await.unwrap().unwrap();
        if fail {
            assert!(
                matches!(result, CellResult::Failure { error: CellDiagnostic { kind: CellDiagnosticKind::ExecutionError, message }, tool_calls } if message.contains("cell-failure") && tool_calls.len() == 2)
            );
        } else {
            assert!(
                matches!(result, CellResult::Success { tool_calls, .. } if tool_calls.len() == 2)
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_caller_cancels_tools_but_holds_capacity_until_cleanup() {
    let engine = CodeExecutor::new(1, CellLimits::default()).unwrap();
    let started = Arc::new(Notify::new());
    let cancelled = Arc::new(Notify::new());
    let released = Arc::new(Notify::new());
    let tools = {
        let started = started.clone();
        let cancelled = cancelled.clone();
        let released = released.clone();
        Arc::new(Tools(
            move |_name, _value, cancel: CancellationToken| -> ToolFuture {
                let started = started.clone();
                let cancelled = cancelled.clone();
                let released = released.clone();
                Box::pin(async move {
                    started.notify_one();
                    cancel.cancelled().await;
                    cancelled.notify_one();
                    released.notified().await;
                    Ok(Value::Null)
                })
            },
        ))
    };
    let task = {
        let engine = engine.clone();
        tokio::spawn(async move {
            engine
                .execute(
                    "return await tools.wait({});".into(),
                    tools,
                    CancellationToken::new(),
                )
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    task.abort();
    tokio::time::timeout(Duration::from_secs(5), cancelled.notified())
        .await
        .unwrap();
    let mut next = tokio::spawn(async move {
        engine
            .execute("return 2;".into(), echo(), CancellationToken::new())
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut next)
            .await
            .is_err()
    );
    released.notify_one();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), next)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .success_value(),
        json!(2)
    );
}

trait SuccessResult {
    fn success_value(&self) -> Value;
    fn calls(&self) -> &[maka_js_runtime::ToolCall];
}
impl SuccessResult for CellResult {
    fn success_value(&self) -> Value {
        match self {
            CellResult::Success { value, .. } => value.clone(),
            _ => panic!("{self:?}"),
        }
    }
    fn calls(&self) -> &[maka_js_runtime::ToolCall] {
        match self {
            CellResult::Success { tool_calls, .. } => tool_calls,
            _ => panic!("{self:?}"),
        }
    }
}
