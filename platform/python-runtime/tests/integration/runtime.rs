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

use maka_agent_facts::tools::{ToolError, ToolExecutor, ToolFuture};
use maka_code_runtime::{
    CellAbort, CellContext, CellDiagnosticKind, CellLimits, CellOutput, CellResult, CellStore,
    ToolMetadata,
};
use maka_python_runtime::CodeExecutor;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
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
    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        (self.0)(name, input, cancellation)
    }
}
fn echo() -> Arc<dyn ToolExecutor> {
    Arc::new(Tools(|_, input, _| -> ToolFuture {
        Box::pin(async move { Ok(input) })
    }))
}
fn executor(limits: CellLimits) -> CodeExecutor {
    CodeExecutor::with_worker(limits, env!("CARGO_BIN_EXE_maka-python-worker").into()).unwrap()
}
fn context() -> CellContext {
    CellContext::new(
        CellStore::temporary().unwrap(),
        vec![ToolMetadata {
            name: "echo".into(),
            description: "echo JSON".into(),
        }],
    )
    .unwrap()
}
fn success(result: CellResult) -> usize {
    match result {
        CellResult::Success { value, tool_calls } => {
            assert_eq!(value, Value::Null);
            tool_calls.len()
        }
        other => panic!("{other:?}"),
    }
}
async fn run(source: &str, context: CellContext) -> Result<CellResult, CellAbort> {
    executor(CellLimits::default())
        .execute_module(source.into(), echo(), CancellationToken::new(), context)
        .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn python_fanout_and_partial_failure_use_real_host_tools() {
    let barrier = Arc::new(Barrier::new(2));
    let tools = Arc::new(Tools(move |_, input: Value, _| -> ToolFuture {
        let barrier = barrier.clone();
        Box::pin(async move {
            barrier.wait().await;
            if input["id"] == 2 {
                Err(ToolError::Failed("failed-two".into()))
            } else {
                Ok(input)
            }
        })
    }));
    let context = context();
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        executor(CellLimits::default()).execute_module(
            r#"
import asyncio
async def settled(n):
    try:
        return {"ok": True, "value": await tools.echo(id=n)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
text(await asyncio.gather(settled(1), settled(2)))
"#
            .into(),
            tools,
            CancellationToken::new(),
            context.clone(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(success(result), 2);
    let outputs = context.take_output();
    let CellOutput::Text { text } = &outputs[0] else {
        panic!("{outputs:?}")
    };
    let output: Value = serde_json::from_str(text).unwrap();
    assert_eq!(output[0], json!({"ok":true,"value":{"id":1}}));
    assert_eq!(output[1]["ok"], false);
    assert!(output[1]["error"].as_str().unwrap().contains("failed-two"));
}

#[tokio::test]
async fn output_store_metadata_and_fresh_globals_obey_cell_contract() {
    let store = CellStore::temporary().unwrap();
    let first = CellContext::new(
        store.clone(),
        vec![ToolMetadata {
            name: "echo".into(),
            description: "echo JSON".into(),
        }],
    )
    .unwrap();
    success(run(r#"
secret = "private"
print(secret)
store("receipt", {"text": "你好", "values": [1, True, None]})
text(ALL_TOOLS[0].name)
image({"type":"image", "data":"R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=", "mimeType":"image/gif"}, detail="original")
notify("ready")
await yield_control()
secret
"#,first.clone()).await.unwrap());
    let outputs = first.take_output();
    assert_eq!(outputs.len(), 2);
    assert!(matches!(&outputs[0],CellOutput::Text{text} if text=="echo"));
    assert!(matches!(
        &outputs[1],
        CellOutput::Media {
            detail: Some(maka_agent_facts::tool_output::ImageDetail::Original),
            ..
        }
    ));
    assert_eq!(
        first.take_notifications().into_iter().collect::<Vec<_>>(),
        ["ready"]
    );
    first.commit().unwrap();
    let second = CellContext::new(store, vec![]).unwrap();
    success(
        run(
            "text(load('receipt'))\ntry:\n    text(secret)\nexcept NameError:\n    text('fresh')",
            second.clone(),
        )
        .await
        .unwrap(),
    );
    let outputs = second.take_output();
    assert!(matches!(&outputs[1],CellOutput::Text{text} if text=="fresh"));
    let CellOutput::Text { text } = &outputs[0] else {
        panic!()
    };
    assert_eq!(
        serde_json::from_str::<Value>(text).unwrap(),
        json!({"text":"你好","values":[1,true,null]})
    );
}

#[tokio::test]
async fn json_boundary_rejects_lossy_types_and_cycles_before_effects() {
    for value in ["{1: 'bad'}", "float('nan')", "b'bytes'", "2**100", "{1,2}"] {
        let context = context();
        success(
            run(
                &format!(
                    "try:\n    await tools.echo({value})\nexcept Exception:\n    text('rejected')"
                ),
                context.clone(),
            )
            .await
            .unwrap(),
        );
        assert!(matches!(&context.take_output()[0],CellOutput::Text{text} if text=="rejected"));
    }
    let result = run("a=[]\na.append(a)\nawait tools.echo(a)", context())
        .await
        .unwrap();
    assert!(matches!(result,CellResult::Failure{tool_calls,..} if tool_calls.is_empty()));
    let context = context();
    assert_eq!(
        success(
            run(
                "text(await tools.echo({'n':18446744073709551615}))",
                context.clone()
            )
            .await
            .unwrap()
        ),
        1
    );
    assert!(
        matches!(&context.take_output()[0],CellOutput::Text{text} if text.contains("18446744073709551615"))
    );
}

#[tokio::test]
async fn cpu_memory_parse_and_os_errors_stay_inside_worker() {
    for (source, limits, kind) in [
        (
            "while True: pass",
            CellLimits {
                timeout: Duration::from_millis(150),
                ..Default::default()
            },
            CellDiagnosticKind::LimitExceeded,
        ),
        (
            "items=['x'*32000 for i in range(10000)]",
            CellLimits {
                heap_bytes: 8 * 1024 * 1024,
                ..Default::default()
            },
            CellDiagnosticKind::LimitExceeded,
        ),
        ("def", CellLimits::default(), CellDiagnosticKind::ParseError),
        (
            "open('/etc/passwd').read()",
            CellLimits::default(),
            CellDiagnosticKind::ExecutionError,
        ),
    ] {
        let result = executor(limits)
            .execute_module(source.into(), echo(), CancellationToken::new(), context())
            .await
            .unwrap();
        assert!(
            matches!(result,CellResult::Failure{error,..} if error.kind==kind),
            "{source}"
        );
    }
    success(run("text('Host still works')", context()).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_waits_and_python_sleep_do_not_spend_execution_budget() {
    let tools = Arc::new(Tools(|_, input, _| -> ToolFuture {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            Ok(input)
        })
    }));
    let result = executor(CellLimits {
        timeout: Duration::from_millis(200),
        ..Default::default()
    })
    .execute_module(
        "import asyncio\nawait tools.wait({})\nawait asyncio.sleep(0.4)\ntext('done')".into(),
        tools,
        CancellationToken::new(),
        context(),
    )
    .await
    .unwrap();
    assert_eq!(success(result), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completion_and_failure_cancel_unawaited_tools_and_wait_for_cleanup() {
    for tail in [
        "text('done')",
        "raise ValueError('bad')",
        "exit()\nawait tools.echo({})",
    ] {
        let entered = Arc::new(Notify::new());
        let cancelled = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let tools = {
            let entered = entered.clone();
            let cancelled = cancelled.clone();
            let release = release.clone();
            Arc::new(Tools(
                move |name: String, _, cancel: CancellationToken| -> ToolFuture {
                    let entered = entered.clone();
                    let cancelled = cancelled.clone();
                    let release = release.clone();
                    Box::pin(async move {
                        if name == "echo" {
                            entered.notified().await;
                            return Ok(Value::Null);
                        }
                        entered.notify_one();
                        cancel.cancelled().await;
                        cancelled.notify_one();
                        release.notified().await;
                        Ok(Value::Null)
                    })
                },
            ))
        };
        let source = format!("tools.wait({{}})\nawait tools.echo({{}})\n{tail}");
        let mut task = tokio::spawn(async move {
            executor(CellLimits::default())
                .execute_module(source, tools, CancellationToken::new(), context())
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), cancelled.notified())
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut task)
                .await
                .is_err()
        );
        release.notify_one();
        let result = task.await.unwrap().unwrap();
        match result {
            CellResult::Success { tool_calls, .. } | CellResult::Failure { tool_calls, .. } => {
                assert_eq!(tool_calls.len(), 2)
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_and_dropped_observer_drain_the_owned_effect() {
    for drop_observer in [false, true] {
        let started = Arc::new(Notify::new());
        let cleaned = Arc::new(AtomicBool::new(false));
        let tools = {
            let started = started.clone();
            let cleaned = cleaned.clone();
            Arc::new(Tools(
                move |_, _, cancel: CancellationToken| -> ToolFuture {
                    let started = started.clone();
                    let cleaned = cleaned.clone();
                    Box::pin(async move {
                        started.notify_one();
                        cancel.cancelled().await;
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        cleaned.store(true, Ordering::SeqCst);
                        Ok(Value::Null)
                    })
                },
            ))
        };
        let cancellation = CancellationToken::new();
        let token = cancellation.clone();
        let task = tokio::spawn(async move {
            executor(CellLimits::default())
                .execute_module("await tools.wait({})".into(), tools, token, context())
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), started.notified())
            .await
            .unwrap();
        if drop_observer {
            task.abort();
        } else {
            cancellation.cancel();
            assert!(matches!(task.await.unwrap(), Err(CellAbort::Cancelled)));
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while !cleaned.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    let cancellation = CancellationToken::new();
    let token = cancellation.clone();
    let task = tokio::spawn(async move {
        executor(CellLimits::default())
            .execute_module("while True: pass".into(), echo(), token, context())
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    cancellation.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap(),
        Err(CellAbort::Cancelled)
    ));
}

#[tokio::test]
async fn caught_fatal_tool_error_cannot_publish_success() {
    let tools = Arc::new(Tools(|_, _, _| -> ToolFuture {
        Box::pin(async { Err(ToolError::Persistence("journal unavailable".into())) })
    }));
    let context = context();
    let result=executor(CellLimits::default()).execute_module("try:\n    await tools.echo({})\nexcept Exception:\n    text('caught')\nawait tools.echo({})".into(),tools,CancellationToken::new(),context).await;
    assert!(matches!(
        result,
        Err(CellAbort::Tool(ToolError::Persistence(_)))
    ));
}

#[tokio::test]
async fn json_depth_is_independent_of_request_and_reply_framing() {
    for depth in [123, 124, 125, 126, 127, 128] {
        for host_value in [false, true] {
            let tools = Arc::new(Tools(move |_, input, _| -> ToolFuture {
                Box::pin(async move {
                    Ok(if host_value {
                        (0..depth).fold(json!("leaf"), |value, _| json!([value]))
                    } else {
                        input
                    })
                })
            }));
            let context = context();
            let source = format!(
                "v='leaf'\nfor _ in range({depth}):\n    v=[v]\ntry:\n    v=await tools.echo({})\n    for _ in range({depth}):\n        v=v[0]\n    text(v)\nexcept Exception:\n    text('rejected')",
                if host_value { "None" } else { "v" }
            );
            success(
                executor(CellLimits::default())
                    .execute_module(source, tools, CancellationToken::new(), context.clone())
                    .await
                    .unwrap(),
            );
            let expected = if depth < 128 { "leaf" } else { "rejected" };
            assert!(
                matches!(&context.take_output()[0], CellOutput::Text { text } if text == expected),
                "depth {depth}, host value {host_value}"
            );
        }
    }
}

#[tokio::test]
async fn parent_cell_can_await_child_without_a_worker_pool_deadlock() {
    let child = executor(CellLimits::default());
    let tools = Arc::new(Tools(move |_, _, cancel| -> ToolFuture {
        let child = child.clone();
        Box::pin(async move {
            success(
                child
                    .execute_module("text('child')".into(), echo(), cancel, context())
                    .await
                    .unwrap(),
            );
            Ok(json!("child settled"))
        })
    }));
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        executor(CellLimits::default()).execute_module(
            "text(await tools.echo({}))".into(),
            tools,
            CancellationToken::new(),
            context(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(success(result), 1);
}

#[tokio::test]
async fn execution_budget_accumulates_across_host_resumes() {
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        executor(CellLimits {
            timeout: Duration::from_millis(150),
            ..Default::default()
        })
        .execute_module(
            "while True:\n    await tools.echo({})".into(),
            echo(),
            CancellationToken::new(),
            context(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        matches!(result,CellResult::Failure{error,tool_calls} if error.kind==CellDiagnosticKind::LimitExceeded && tool_calls.len()>1)
    );
}

#[tokio::test]
async fn loading_deep_host_or_javascript_store_values_is_catchable() {
    let context = context();
    context
        .store(
            "deep".into(),
            (0..132).fold(json!(0), |value, _| json!([value])),
        )
        .unwrap();
    success(
        run(
            "try:\n    load('deep')\nexcept Exception:\n    text('rejected')",
            context.clone(),
        )
        .await
        .unwrap(),
    );
    assert!(matches!(&context.take_output()[0],CellOutput::Text{text} if text=="rejected"));
}
