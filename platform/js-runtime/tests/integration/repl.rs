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

use maka_agent_facts::tools::ToolFuture;
use maka_agent_facts::tools::{ToolError, ToolExecutor};
use maka_code_runtime::{CellAbort, CellContext, CellLimits, CellOutput, CellResult, CellStore};
use maka_js_runtime::repl::{Repl, ReplAdmission};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const WAIT_BOOTSTRAP: &str = r#"
Object.defineProperty(globalThis, 'invoke', { value: async id => {
    const result = await call('fixture', {id});
    if (!result.ok) throw Error(result.error.message);
    return result.value;
}});
Object.defineProperty(globalThis, 'write', { value: value => emit({kind:'text', text:JSON.stringify(value)}) });
"#;

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
    let repl = Repl::new(BOOTSTRAP, CellLimits::default()).unwrap();
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

struct Admission {
    sealed: CancellationToken,
    acknowledged: CancellationToken,
    failure: bool,
}
impl ReplAdmission for Admission {
    fn seal(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ToolError>> + Send + '_>>
    {
        self.sealed.cancel();
        Box::pin(async move {
            self.acknowledged.cancelled().await;
            if self.failure {
                Err(ToolError::CleanupUnconfirmed(
                    "fixture admission lost".into(),
                ))
            } else {
                Ok(())
            }
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observed_timeout_requires_admission_ack_and_retains_native_settlement() {
    let sealed = CancellationToken::new();
    let acknowledged = CancellationToken::new();
    let repl = Arc::new(
        Repl::new_observed(
            BOOTSTRAP,
            CellLimits::default(),
            Arc::new(Admission {
                sealed: sealed.clone(),
                acknowledged: acknowledged.clone(),
                failure: false,
            }),
        )
        .unwrap(),
    );
    let started = CancellationToken::new();
    let released = CancellationToken::new();
    let settled = Arc::new(AtomicUsize::new(0));
    let task = {
        let repl = repl.clone();
        let held = Held {
            started: started.clone(),
            released: released.clone(),
            settled: settled.clone(),
        };
        tokio::spawn(async move {
            repl.evaluate(
                "const previousEpoch = 1; await invoke()".into(),
                Arc::new(held),
                CancellationToken::new(),
                context(),
                Duration::from_millis(100),
            )
            .await
        })
    };
    started.cancelled().await;
    let queued = {
        let repl = repl.clone();
        tokio::spawn(async move {
            repl.evaluate(
                "write('must not execute')".into(),
                Arc::new(Fixture(3)),
                CancellationToken::new(),
                context(),
                Duration::from_secs(3),
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), sealed.cancelled())
        .await
        .unwrap();
    assert!(!task.is_finished(), "unacknowledged effects cannot detach");
    assert!(
        tokio::time::timeout(Duration::from_secs(1), queued)
            .await
            .expect("queued VM requests must be refused before native settlement")
            .unwrap()
            .is_err()
    );
    acknowledged.cancel();
    let result = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(result, CellResult::Failure { .. }));
    assert!(repl.is_closed());
    assert_eq!(settled.load(Ordering::SeqCst), 0);
    assert!(
        tokio::time::timeout(
            Duration::from_secs(1),
            repl.evaluate(
                "write('late request')".into(),
                Arc::new(Fixture(4)),
                CancellationToken::new(),
                context(),
                Duration::from_secs(3),
            ),
        )
        .await
        .expect("a retired VM must reject new requests before native settlement")
        .is_err()
    );

    let next = Repl::new(BOOTSTRAP, CellLimits::default()).unwrap();
    let output = context();
    next.evaluate(
        "write(typeof previousEpoch)".into(),
        Arc::new(Fixture(2)),
        CancellationToken::new(),
        output.clone(),
        Duration::from_secs(3),
    )
    .await
    .unwrap();
    let [CellOutput::Text { text }]: [CellOutput; 1] = output.take_output().try_into().unwrap()
    else {
        panic!("expected fresh VM output")
    };
    assert_eq!(text, "\"undefined\"");
    next.close().await.unwrap();

    let close = tokio::spawn(Arc::try_unwrap(repl).ok().unwrap().close());
    tokio::task::yield_now().await;
    assert!(
        !close.is_finished(),
        "the retained owner must join native work"
    );
    released.cancel();
    close.await.unwrap().unwrap();
    assert_eq!(settled.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_observation_fence_drains_before_reporting_failure() {
    let sealed = CancellationToken::new();
    let acknowledged = CancellationToken::new();
    acknowledged.cancel();
    let repl = Arc::new(
        Repl::new_observed(
            BOOTSTRAP,
            CellLimits::default(),
            Arc::new(Admission {
                sealed: sealed.clone(),
                acknowledged,
                failure: true,
            }),
        )
        .unwrap(),
    );
    let started = CancellationToken::new();
    let released = CancellationToken::new();
    let settled = Arc::new(AtomicUsize::new(0));
    let task = {
        let repl = repl.clone();
        let held = Held {
            started: started.clone(),
            released: released.clone(),
            settled: settled.clone(),
        };
        tokio::spawn(async move {
            repl.evaluate(
                "await invoke()".into(),
                Arc::new(held),
                CancellationToken::new(),
                context(),
                Duration::from_millis(100),
            )
            .await
        })
    };
    started.cancelled().await;
    tokio::time::timeout(Duration::from_secs(3), sealed.cancelled())
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert!(!task.is_finished());
    released.cancel();
    assert!(matches!(
        task.await.unwrap(),
        Err(CellAbort::Tool(ToolError::CleanupUnconfirmed(_)))
    ));
    assert_eq!(settled.load(Ordering::SeqCst), 1);
    Arc::try_unwrap(repl).ok().unwrap().close().await.unwrap();
}

struct FailingHeld {
    started: CancellationToken,
    released: CancellationToken,
}
impl ToolExecutor for FailingHeld {
    fn names(&self) -> Vec<String> {
        vec!["fixture".into()]
    }
    fn invoke(&self, _: String, _: Value, _: CancellationToken) -> ToolFuture {
        self.started.cancel();
        let released = self.released.clone();
        Box::pin(async move {
            released.cancelled().await;
            Err(ToolError::Persistence("fixture late T2 failure".into()))
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observed_native_late_failure_is_reported_to_the_retained_owner() {
    let acknowledged = CancellationToken::new();
    acknowledged.cancel();
    let repl = Repl::new_observed(
        BOOTSTRAP,
        CellLimits::default(),
        Arc::new(Admission {
            sealed: CancellationToken::new(),
            acknowledged,
            failure: false,
        }),
    )
    .unwrap();
    let started = CancellationToken::new();
    let released = CancellationToken::new();
    let result = repl
        .evaluate(
            "await invoke()".into(),
            Arc::new(FailingHeld {
                started: started.clone(),
                released: released.clone(),
            }),
            CancellationToken::new(),
            context(),
            Duration::from_millis(100),
        )
        .await
        .unwrap();
    assert!(started.is_cancelled());
    assert!(matches!(result, CellResult::Failure { .. }));
    released.cancel();
    assert!(matches!(
        repl.close().await,
        Err(CellAbort::Tool(ToolError::Persistence(_)))
    ));
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
    let repl = Arc::new(Repl::new(BOOTSTRAP, CellLimits::default()).unwrap());
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
        let repl = Repl::new(BOOTSTRAP, limits).unwrap();
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

struct WaitFixture {
    context: CellContext,
    suspend: bool,
    ready: CancellationToken,
    started: Arc<tokio::sync::Barrier>,
    released: Vec<CancellationToken>,
    settled: Vec<CancellationToken>,
}

impl ToolExecutor for WaitFixture {
    fn names(&self) -> Vec<String> {
        vec!["fixture".into()]
    }

    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        if input["id"] == "ready" {
            let ready = self.ready.clone();
            return Box::pin(async move {
                ready.cancelled().await;
                Ok(Value::Null)
            });
        }
        let id = input["id"].as_u64().unwrap() as usize;
        let context = self.context.clone();
        let suspend = self.suspend;
        let ready = self.ready.clone();
        let started = self.started.clone();
        let released = self.released[id].clone();
        let settled = self.settled[id].clone();
        Box::pin(async move {
            let outer = suspend.then(|| context.suspend_timeout());
            let inner = suspend.then(|| context.suspend_timeout());
            ready.cancel();
            started.wait().await;
            let result = tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(ToolError::Failed("fixture cancelled".into())),
                _ = released.cancelled() => Ok(json!(id)),
            };
            drop(inner);
            drop(outer);
            settled.cancel();
            result
        })
    }
}

fn wait_fixture(context: CellContext, suspend: bool, count: usize) -> Arc<WaitFixture> {
    Arc::new(WaitFixture {
        context,
        suspend,
        ready: CancellationToken::new(),
        started: Arc::new(tokio::sync::Barrier::new(count + 1)),
        released: (0..count).map(|_| CancellationToken::new()).collect(),
        settled: (0..count).map(|_| CancellationToken::new()).collect(),
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guarded_host_wait_can_outlive_budget_but_ordinary_wait_cannot() {
    for suspend in [false, true] {
        let repl = Arc::new(Repl::new(WAIT_BOOTSTRAP, CellLimits::default()).unwrap());
        let output = context();
        let fixture = wait_fixture(output.clone(), suspend, 1);
        let mut evaluation = {
            let repl = repl.clone();
            let fixture = fixture.clone();
            let output = output.clone();
            tokio::spawn(async move {
                repl.evaluate(
                    "write(await invoke(0))".into(),
                    fixture,
                    CancellationToken::new(),
                    output,
                    Duration::from_millis(200),
                )
                .await
            })
        };
        fixture.started.wait().await;
        let observed = tokio::time::timeout(Duration::from_millis(600), &mut evaluation).await;
        if suspend {
            assert!(
                observed.is_err(),
                "trusted wait consumed its suspended budget"
            );
            assert!(!repl.is_closed());
            fixture.released[0].cancel();
            let result = evaluation.await.unwrap().unwrap();
            assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
            assert!(
                matches!(output.take_output().as_slice(), [CellOutput::Text{text}] if text == "0")
            );
        } else {
            let result = observed
                .expect("ordinary Host wait must time out")
                .unwrap()
                .unwrap();
            assert!(
                matches!(result, CellResult::Failure { error, .. } if error.kind == maka_code_runtime::CellDiagnosticKind::LimitExceeded)
            );
            assert!(repl.is_closed());
        }
        fixture.settled[0].cancelled().await;
        Arc::try_unwrap(repl).ok().unwrap().close().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nested_and_concurrent_guards_resume_only_after_last_host_wait() {
    let repl = Arc::new(Repl::new(WAIT_BOOTSTRAP, CellLimits::default()).unwrap());
    let output = context();
    let fixture = wait_fixture(output.clone(), true, 2);
    let mut evaluation = {
        let repl = repl.clone();
        let output = output.clone();
        let fixture = fixture.clone();
        tokio::spawn(async move {
            repl.evaluate(
                "write(await Promise.all([invoke(0), invoke(1)]))".into(),
                fixture,
                CancellationToken::new(),
                output,
                Duration::from_millis(200),
            )
            .await
        })
    };
    fixture.started.wait().await;
    assert!(
        tokio::time::timeout(Duration::from_millis(400), &mut evaluation)
            .await
            .is_err()
    );
    fixture.released[0].cancel();
    fixture.settled[0].cancelled().await;
    assert!(
        tokio::time::timeout(Duration::from_millis(400), &mut evaluation)
            .await
            .is_err()
    );
    fixture.released[1].cancel();
    let result = evaluation.await.unwrap().unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    assert!(matches!(output.take_output().as_slice(), [CellOutput::Text{text}] if text == "[0,1]"));
    Arc::try_unwrap(repl).ok().unwrap().close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn suspended_timeout_still_cancels_and_waits_for_guarded_work_to_settle() {
    let repl = Arc::new(Repl::new(WAIT_BOOTSTRAP, CellLimits::default()).unwrap());
    let output = context();
    let fixture = wait_fixture(output.clone(), true, 1);
    let cancellation = CancellationToken::new();
    let evaluation = {
        let repl = repl.clone();
        let fixture = fixture.clone();
        let cancellation = cancellation.clone();
        tokio::spawn(async move {
            repl.evaluate(
                "await invoke(0)".into(),
                fixture,
                cancellation,
                output,
                Duration::from_secs(5),
            )
            .await
        })
    };
    fixture.started.wait().await;
    cancellation.cancel();
    assert!(matches!(
        evaluation.await.unwrap(),
        Err(CellAbort::Cancelled)
    ));
    assert!(fixture.settled[0].is_cancelled());
    assert!(repl.is_closed());
    Arc::try_unwrap(repl).ok().unwrap().close().await.unwrap();
}

struct RemainingBudgetFixture {
    context: CellContext,
    started: CancellationToken,
    released: CancellationToken,
    completed: Arc<AtomicUsize>,
}

impl ToolExecutor for RemainingBudgetFixture {
    fn names(&self) -> Vec<String> {
        vec!["fixture".into()]
    }

    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let context = self.context.clone();
        let started = self.started.clone();
        let released = self.released.clone();
        let completed = self.completed.clone();
        Box::pin(async move {
            if input["id"] == "guarded-error" {
                let _outer = context.suspend_timeout();
                let _inner = context.suspend_timeout();
                started.cancel();
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => {},
                    _ = released.cancelled() => {},
                }
                return Err(ToolError::Failed("expected fixture error".into()));
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(ToolError::Failed("fixture cancelled".into())),
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    completed.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                },
            }
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guard_drop_after_error_restores_only_the_remaining_budget() {
    let repl = Arc::new(Repl::new(WAIT_BOOTSTRAP, CellLimits::default()).unwrap());
    let output = context();
    let started = CancellationToken::new();
    let released = CancellationToken::new();
    let completed = Arc::new(AtomicUsize::new(0));
    let mut evaluation = {
        let repl = repl.clone();
        let output = output.clone();
        let fixture = RemainingBudgetFixture {
            context: output.clone(),
            started: started.clone(),
            released: released.clone(),
            completed: completed.clone(),
        };
        tokio::spawn(async move {
            repl.evaluate(
                "await invoke('ordinary'); try { await invoke('guarded-error') } catch {} await invoke('ordinary'); write('unexpected');".into(),
                Arc::new(fixture),
                CancellationToken::new(),
                output,
                Duration::from_millis(300),
            )
            .await
        })
    };
    started.cancelled().await;
    assert!(
        tokio::time::timeout(Duration::from_millis(600), &mut evaluation)
            .await
            .is_err()
    );
    released.cancel();
    let result = evaluation.await.unwrap().unwrap();
    assert!(
        matches!(result, CellResult::Failure { error, .. } if error.kind == maka_code_runtime::CellDiagnosticKind::LimitExceeded)
    );
    assert_eq!(
        completed.load(Ordering::SeqCst),
        1,
        "guard drop refilled the budget"
    );
    assert!(output.take_output().is_empty());
    assert!(repl.is_closed());
    Arc::try_unwrap(repl).ok().unwrap().close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unawaited_guarded_work_cannot_disable_compute_or_heap_limits() {
    for (source, heap) in [
        (
            "const pending = invoke(0); await invoke('ready'); while (true) {}",
            false,
        ),
        (
            "const pending = invoke(0); await invoke('ready'); const a = []; while (true) a.push(new Array(10000).fill('heap'))",
            true,
        ),
    ] {
        let repl = Arc::new(
            Repl::new(
                WAIT_BOOTSTRAP,
                CellLimits {
                    heap_bytes: 8 * 1024 * 1024,
                    ..CellLimits::default()
                },
            )
            .unwrap(),
        );
        let output = context();
        let fixture = wait_fixture(output.clone(), true, 1);
        let evaluation = {
            let repl = repl.clone();
            let fixture = fixture.clone();
            tokio::spawn(async move {
                repl.evaluate(
                    source.into(),
                    fixture,
                    CancellationToken::new(),
                    output,
                    if heap {
                        Duration::from_secs(5)
                    } else {
                        Duration::from_millis(200)
                    },
                )
                .await
            })
        };
        fixture.started.wait().await;
        let result = tokio::time::timeout(Duration::from_secs(5), evaluation)
            .await
            .expect("guarded pending work disabled the VM watchdog")
            .unwrap()
            .unwrap();
        assert!(
            matches!(&result, CellResult::Failure { error, .. } if error.kind == maka_code_runtime::CellDiagnosticKind::LimitExceeded),
            "{result:?}"
        );
        if heap {
            assert!(
                matches!(&result, CellResult::Failure { error, .. } if error.message.contains("heap")),
                "{result:?}"
            );
        }
        assert!(repl.is_closed());
        fixture.settled[0].cancelled().await;
        Arc::try_unwrap(repl).ok().unwrap().close().await.unwrap();
    }
}

#[test]
fn persistent_repl_does_not_starve_host_blocking_work() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let repl = Repl::new(BOOTSTRAP, CellLimits::default()).unwrap();
        let first = repl
            .evaluate(
                "globalThis.counter = await invoke();".into(),
                Arc::new(Fixture(41)),
                CancellationToken::new(),
                context(),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(matches!(first, CellResult::Success { .. }), "{first:?}");
        // Computer Use creates the next cell store on this same Host pool.
        let store = tokio::task::spawn_blocking(CellStore::temporary);
        let next = tokio::time::timeout(Duration::from_secs(5), async {
            let output = CellContext::new(store.await.unwrap().unwrap(), vec![]).unwrap();
            let result = repl
                .evaluate(
                    "write(++globalThis.counter);".into(),
                    Arc::new(Fixture(0)),
                    CancellationToken::new(),
                    output.clone(),
                    Duration::from_secs(5),
                )
                .await
                .unwrap();
            assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
            output.take_output()
        })
        .await;
        repl.close().await.unwrap();
        assert!(
            matches!(next.expect("idle REPL must leave Host blocking workers available").as_slice(),
            [CellOutput::Text { text }] if text == "42")
        );
    });
    runtime.shutdown_timeout(Duration::from_secs(5));
}
