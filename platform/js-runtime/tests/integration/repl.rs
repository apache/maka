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

use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use maka_code_runtime::{CellAbort, CellContext, CellLimits, CellOutput, CellResult, CellStore};
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const BOOTSTRAP: &str = r#"
Object.defineProperty(globalThis, 'invoke', { value: async () => {
    const result = await call('fixture', {});
    if (!result.ok) throw Error(result.error.message);
    return result.value;
}});
Object.defineProperty(globalThis, 'write', { value: value => emit({kind:'text', text:JSON.stringify(value)}) });
"#;

struct Fixture(usize);
impl ToolExecutor for Fixture {
    fn names(&self) -> Vec<String> {
        vec!["fixture".into()]
    }
    fn invoke(&self, _: String, _: Value, _: CancellationToken) -> ToolFuture {
        let value = self.0;
        Box::pin(async move { Ok(json!(value)) })
    }
}
fn context() -> CellContext {
    CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repl_keeps_bindings_but_uses_current_call_and_preserves_output_on_exception() {
    let repl = Repl::new(BOOTSTRAP, CellLimits::default());
    for (source, authority, expected, success) in [
        (
            "const target = {value: await invoke()}; write(target.value)",
            1,
            "1",
            true,
        ),
        (
            "write([target.value, await invoke()]); throw Error('expected')",
            2,
            "[1,2]",
            false,
        ),
        (
            "const target = {value: 3}; write([target.value, typeof Deno, typeof tools, typeof fetch])",
            4,
            "[3,\"undefined\",\"undefined\",\"undefined\"]",
            true,
        ),
    ] {
        let output = context();
        let result = repl
            .evaluate(
                source.into(),
                Arc::new(Fixture(authority)),
                CancellationToken::new(),
                output.clone(),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(
            matches!(result, CellResult::Success { .. }),
            success,
            "{result:?}"
        );
        let output: [CellOutput; 1] = output.take_output().try_into().unwrap();
        let [CellOutput::Text { text }] = output else {
            panic!("expected text")
        };
        assert_eq!(text, expected);
    }
    repl.close().await.unwrap();
}

struct Held {
    started: CancellationToken,
    released: CancellationToken,
    settled: Arc<AtomicUsize>,
}
impl ToolExecutor for Held {
    fn names(&self) -> Vec<String> {
        vec!["fixture".into()]
    }
    fn invoke(&self, _: String, _: Value, _: CancellationToken) -> ToolFuture {
        self.started.cancel();
        let released = self.released.clone();
        let settled = self.settled.clone();
        Box::pin(async move {
            released.cancelled().await;
            settled.fetch_add(1, Ordering::SeqCst);
            Ok(Value::Null)
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_waits_for_native_settlement_and_requires_reset() {
    let repl = Arc::new(Repl::new(BOOTSTRAP, CellLimits::default()));
    let stop = CancellationToken::new();
    let started = CancellationToken::new();
    let released = CancellationToken::new();
    let settled = Arc::new(AtomicUsize::new(0));
    let task = {
        let repl = repl.clone();
        let stop = stop.clone();
        let held = Held {
            started: started.clone(),
            released: released.clone(),
            settled: settled.clone(),
        };
        tokio::spawn(async move {
            repl.evaluate(
                "await invoke()".into(),
                Arc::new(held),
                stop,
                context(),
                Duration::from_secs(5),
            )
            .await
        })
    };
    started.cancelled().await;
    stop.cancel();
    assert!(!task.is_finished());
    released.cancel();
    assert!(matches!(task.await.unwrap(), Err(CellAbort::Cancelled)));
    assert!(repl.is_closed());
    assert_eq!(settled.load(Ordering::SeqCst), 1);
    assert!(
        repl.evaluate(
            "write('late')".into(),
            Arc::new(Fixture(2)),
            CancellationToken::new(),
            context(),
            Duration::from_secs(5)
        )
        .await
        .is_err()
    );
    Arc::try_unwrap(repl).ok().unwrap().close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loops_and_unresolved_await_are_bounded_and_do_not_reuse_the_heap() {
    for (source, heap) in [
        ("while (true) {}", false),
        ("await new Promise(() => {})", false),
        (
            "const a = []; while (true) a.push(new Array(10000).fill('heap'))",
            true,
        ),
    ] {
        let limits = CellLimits {
            heap_bytes: 8 * 1024 * 1024,
            ..CellLimits::default()
        };
        let repl = Repl::new(BOOTSTRAP, limits);
        let result = repl
            .evaluate(
                source.into(),
                Arc::new(Fixture(0)),
                CancellationToken::new(),
                context(),
                if heap {
                    Duration::from_secs(5)
                } else {
                    Duration::from_millis(100)
                },
            )
            .await
            .unwrap();
        assert!(matches!(result, CellResult::Failure { .. }), "{result:?}");
        if heap {
            assert!(
                matches!(&result,CellResult::Failure {error,..} if error.kind==maka_code_runtime::CellDiagnosticKind::LimitExceeded && error.message.contains("heap")),
                "heap guard must fire before the wall timeout: {result:?}"
            );
        }
        let next = repl
            .evaluate(
                "write(1)".into(),
                Arc::new(Fixture(0)),
                CancellationToken::new(),
                context(),
                Duration::from_secs(1),
            )
            .await;
        assert!(
            next.is_err(),
            "source={source:?}; first={result:?}; next={next:?}"
        );
        repl.close().await.unwrap();
    }
}
