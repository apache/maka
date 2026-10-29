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

use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult, CellStore, ToolMetadata};
use maka_js_runtime::CodeExecutor;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

struct Echo;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_modules_match_globals_timers_explicit_output_and_import_boundaries() {
    let engine = CodeExecutor::new(CellLimits::default()).unwrap();
    let tools = Arc::new(Echo);
    let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = engine
        .execute_module(
            r#"
        export const moduleValue = 42;
        text([typeof console, typeof Deno, typeof __bootstrap, typeof Atomics,
              typeof SharedArrayBuffer, typeof WebAssembly, typeof process, typeof fetch,
              typeof tools.missing, this === undefined]);
        for (let i = 0; i < 1000; i++) clearTimeout(setTimeout(() => text('cancelled'), 60000));
        await new Promise(resolve => setTimeout(resolve, 0));
        text(await tools.echo({value:moduleValue}));
        setTimeout(() => text('late'), 60000);
        exit();
        text('unreachable');
    "#
            .into(),
            tools.clone(),
            CancellationToken::new(),
            context.clone(),
        )
        .await
        .unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    let output = serde_json::to_value(context.take_output()).unwrap();
    assert_eq!(
        output,
        json!([
            {"kind":"text","text":"[\"undefined\",\"undefined\",\"undefined\",\"undefined\",\"undefined\",\"undefined\",\"undefined\",\"undefined\",\"undefined\",true]"},
            {"kind":"text","text":"{\"value\":42}"}
        ])
    );
    for source in [
        "return 42;",
        "import x from 'node:fs';",
        "await import('node:fs');",
    ] {
        let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
        let result = engine
            .execute_module(
                source.into(),
                tools.clone(),
                CancellationToken::new(),
                context,
            )
            .await
            .unwrap();
        assert!(
            matches!(result, CellResult::Failure { .. }),
            "{source}: {result:?}"
        );
    }
}
impl ToolExecutor for Echo {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn invoke(&self, _: String, value: Value, _: CancellationToken) -> ToolFuture {
        Box::pin(async move { Ok(value) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn output_survives_errors_and_json_store_does_not_retain_heap() {
    let engine = CodeExecutor::new(CellLimits::default()).unwrap();
    let store = CellStore::temporary().unwrap();
    let context = CellContext::new(
        store.clone(),
        vec![ToolMetadata {
            name: "echo".into(),
            description: "fixture".into(),
        }],
    )
    .unwrap();
    let tools = Arc::new(Echo);
    let result = engine.execute_with_context(
        "globalThis.secret = 9; store('data', {n:42}); text(ALL_TOOLS[0].name); await Promise.resolve(); throw new Error('after output');".into(),
        tools.clone(), CancellationToken::new(), context.clone()).await.unwrap();
    assert!(matches!(result, CellResult::Failure { .. }));
    assert!(matches!(&context.take_output()[0], CellOutput::Text { text } if text == "echo"));
    context.commit().unwrap();
    let next = CellContext::new(store.clone(), vec![]).unwrap();
    let result = engine
        .execute_with_context(
            "return [load('data'), typeof secret, load('missing') === undefined];".into(),
            tools.clone(),
            CancellationToken::new(),
            next,
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap()["value"],
        json!([{"n":42},"undefined",true])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_tool_fanout_has_no_concurrency_gate() {
    struct GatedEcho {
        gate: Arc<tokio::sync::Barrier>,
        calls: AtomicUsize,
    }
    impl ToolExecutor for GatedEcho {
        fn names(&self) -> Vec<String> {
            vec!["echo".into()]
        }
        fn invoke(&self, _: String, value: Value, _: CancellationToken) -> ToolFuture {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let gate = self.gate.clone();
            Box::pin(async move {
                gate.wait().await;
                Ok(value)
            })
        }
    }
    let engine = CodeExecutor::new(CellLimits::default()).unwrap();
    let tools = Arc::new(GatedEcho {
        gate: Arc::new(tokio::sync::Barrier::new(16)),
        calls: AtomicUsize::new(0),
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        engine.execute(
            "return await Promise.all(Array.from({length:16}, (_,i) => tools.echo(i)));".into(),
            tools.clone(),
            CancellationToken::new(),
        ),
    )
    .await
    .expect("all independent tools start before any completes")
    .unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap()["value"],
        json!((0..16).collect::<Vec<_>>())
    );
    assert_eq!(tools.calls.load(Ordering::SeqCst), 16);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fatal_failure_is_observable_before_other_accepted_work_finishes_cleanup() {
    struct Faults {
        entered: Arc<Notify>,
        release: Arc<Notify>,
        later: AtomicUsize,
    }
    impl ToolExecutor for Faults {
        fn names(&self) -> Vec<String> {
            ["slow", "fail", "later"].map(String::from).into()
        }
        fn invoke(&self, name: String, _: Value, _: CancellationToken) -> ToolFuture {
            let entered = self.entered.clone();
            let release = self.release.clone();
            if name == "later" {
                self.later.fetch_add(1, Ordering::SeqCst);
            }
            Box::pin(async move {
                match name.as_str() {
                    "slow" => {
                        entered.notify_one();
                        release.notified().await;
                        Ok(Value::Null)
                    }
                    "fail" => {
                        entered.notified().await;
                        Err(ToolError::Persistence("injected".into()))
                    }
                    _ => Ok(Value::Null),
                }
            })
        }
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let tools = Arc::new(Faults { entered: Arc::new(Notify::new()), release: Arc::new(Notify::new()), later: AtomicUsize::new(0) });
        let engine = CodeExecutor::new(CellLimits::default()).unwrap();
        let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
        let worker_context = context.clone();
        let worker_tools = tools.clone();
        let mut worker = tokio::spawn(async move {
            engine.execute_with_context("const slow = tools.slow({}); try { await tools.fail({}); } catch {} try { await tools.later({}); } catch {} await slow;".into(),
                worker_tools, CancellationToken::new(), worker_context).await
        });
        context.yielded().await;
        assert!(matches!(context.failure(), Some(ToolError::Persistence(_))));
        assert!(futures_util::poll!(&mut worker).is_pending(), "admitted work remains owned during cleanup");
        tools.release.notify_one();
        assert!(matches!(worker.await.unwrap(), Err(maka_code_runtime::CellAbort::Tool(ToolError::Persistence(_)))));
        assert_eq!(tools.later.load(Ordering::SeqCst), 0);
    }).await.expect("fatal notification must not wait for cleanup");
}
