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

use maka_js_runtime::plugin::{Error, Limits, Module, RequestBridge, Vm};
use serde_json::{Value, json};
use std::time::Duration;

mod captured;
mod inventory;
mod request;

struct Relay(Module);
impl RequestBridge for Relay {
    fn invoke(
        &self,
        input: Value,
    ) -> futures_util::future::BoxFuture<'static, Result<Value, Error>> {
        let target = self.0.clone();
        Box::pin(async move {
            target
                .call(
                    vec![input["method"].as_str().unwrap().into()],
                    vec![input["value"].clone()],
                )
                .await
        })
    }
}

#[tokio::test]
async fn cross_vm_host_calls_preserve_values_and_retirement_does_not_retarget_or_deadlock() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let shared = Vm::scoped(Limits::default()).unwrap();
        let dedicated = Vm::pure(Limits::default()).unwrap();
        let service = dedicated.load("service.mjs".into(), r#"
            let release;
            let calls = 0;
            export function echo(value) { calls++; return value; }
            export function count() { return calls; }
            export function wait(value) { return new Promise(resolve => { release = () => resolve(value); }); }
            export function finish() { release(); }
        "#.into()).unwrap();
        let caller = shared.load("caller.mjs".into(), r#"
            export function invoke(method, value, context) {
                globalThis.staleBridge = () => context.invoke({method:"echo", value});
                return context.invoke({method, value});
            }
        "#.into()).unwrap();
        let callbacks = caller.capture(vec![], vec!["invoke".into()]).await.unwrap();
        let relay = std::sync::Arc::new(Relay(service.clone()));
        let payload = json!({"nested":[1, null, {"text":"跨 VM",
            "timestamp":1_790_320_333_732_i64,
            "safe":[9_007_199_254_740_991_i64,-9_007_199_254_740_991_i64],
            "fraction":1.25,"outsideSafeRange":9_007_199_254_740_992.0,
            "largeExact":1_000_000_000_000_000_128_u64,
            "negativeExact":-1_000_000_000_000_000_128_i64
        }]});
        // JSON.stringify preserves the numeric value, not Rust's integer/float enum variant.
        let mut expected = payload.clone();
        expected["nested"][2]["outsideSafeRange"] = json!(9_007_199_254_740_992_u64);
        expected["nested"][2]["largeExact"] = json!(1_000_000_000_000_000_128_u64 as f64);
        expected["nested"][2]["negativeExact"] = json!(-1_000_000_000_000_000_128_i64 as f64);
        assert_eq!(service.call(vec!["echo".into()], vec![payload.clone()]).await.unwrap(), expected);
        assert_eq!(callbacks.call_with_context("invoke", vec![json!("echo"), payload.clone()], relay.clone()).await.unwrap(), expected);
        assert_eq!(call(&service, "count").await, json!(2));
        let running = tokio::spawn({
            let callbacks = callbacks.clone();
            let relay = relay.clone();
            let payload = payload.clone();
            async move { callbacks.call_with_context("invoke", vec![json!("wait"), payload], relay).await.unwrap() }
        });
        while dedicated.statistics(false).await.unwrap().pending_calls != 1 { tokio::task::yield_now().await; }
        let closing = tokio::spawn({ let caller = caller.clone(); async move { caller.close().await.unwrap() } });
        while caller.ready().await.is_ok() { tokio::task::yield_now().await; }
        assert!(!closing.is_finished());
        service.call(vec!["finish".into()], vec![]).await.unwrap();
        assert_eq!(running.await.unwrap(), expected);
        closing.await.unwrap();
        let inspector = shared.load("inspector.mjs".into(), r#"
            export async function inspect() {
                try { await globalThis.staleBridge(); return false; }
                catch (error) { return error.message.includes("expired"); }
                finally { delete globalThis.staleBridge; }
            }
        "#.into()).unwrap();
        assert_eq!(call(&inspector, "inspect").await, json!(true));
        inspector.close().await.unwrap();
        service.close().await.unwrap();
        assert_eq!(shared.statistics(true).await.unwrap().modules, 0);
        assert_eq!(dedicated.statistics(true).await.unwrap().modules, 0);
        shared.shutdown().await;
        dedicated.shutdown().await;
    }).await.expect("cross-VM drains make bounded progress");
}

async fn call(module: &Module, name: &str) -> Value {
    module.call(vec![name.into()], vec![]).await.unwrap()
}

#[tokio::test]
async fn shared_vm_multiplexes_and_drains_before_reclaiming_module() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let vm = Vm::pure(Limits::default()).unwrap();
        let waiting = vm
            .load(
                "waiting.mjs".into(),
                r#"
            export function wait() {
                return new Promise(resolve => { globalThis.releasePluginTest = resolve; });
            }
        "#
                .into(),
            )
            .unwrap();
        let control = vm
            .load(
                "control.mjs".into(),
                r#"
            export function ping() { return 42; }
            export function release() {
                globalThis.releasePluginTest("finished");
                delete globalThis.releasePluginTest;
            }
        "#
                .into(),
            )
            .unwrap();
        waiting.ready().await.unwrap();
        control.ready().await.unwrap();
        let running = tokio::spawn({
            let waiting = waiting.clone();
            async move { call(&waiting, "wait").await }
        });
        while vm.statistics(false).await.unwrap().pending_calls != 1 {
            tokio::task::yield_now().await;
        }
        let closing = tokio::spawn({
            let waiting = waiting.clone();
            async move { waiting.close().await.unwrap() }
        });
        while waiting.ready().await.is_ok() {
            tokio::task::yield_now().await;
        }
        assert!(!closing.is_finished());
        assert_eq!(call(&control, "ping").await, json!(42));
        call(&control, "release").await;
        assert_eq!(running.await.unwrap(), json!("finished"));
        closing.await.unwrap();
        assert!(waiting.call(vec!["wait".into()], vec![]).await.is_err());
        assert_eq!(vm.statistics(true).await.unwrap().modules, 1);
        control.close().await.unwrap();
        assert_eq!(vm.statistics(true).await.unwrap().modules, 0);
        vm.shutdown().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn module_errors_and_hot_updates_do_not_poison_or_retain_the_shared_vm() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let vm = Vm::pure(Limits::default()).unwrap();
        let baseline = vm.statistics(true).await.unwrap().used_heap_bytes;
        let bad = vm
            .load(
                "bad.mjs".into(),
                "throw new Error('broken package');".into(),
            )
            .unwrap();
        assert!(
            bad.ready()
                .await
                .unwrap_err()
                .to_string()
                .contains("broken package")
        );
        bad.close().await.unwrap();
        for generation in 0..24 {
            let module = vm
                .load(
                    format!("generation-{generation}.mjs"),
                    r#"
                const retained = new Array(256 * 1024).fill(1);
                export function size() { return retained.length; }
                export function fail() { return Promise.reject(new Error("call failed")); }
            "#
                    .into(),
                )
                .unwrap();
            assert_eq!(call(&module, "size").await, json!(256 * 1024));
            assert!(module.call(vec!["fail".into()], vec![]).await.is_err());
            module.close().await.unwrap();
        }
        let after = vm.statistics(true).await.unwrap();
        assert_eq!(after.modules, 0);
        assert_eq!(after.pending_calls, 0);
        assert!(
            after.used_heap_bytes < baseline + 4 * 1024 * 1024,
            "old module roots retained: baseline={baseline}, after={after:?}"
        );
        vm.shutdown().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn runaway_terminates_its_vm_and_not_an_independent_vm() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let limits = Limits {
            synchronous_slice: Duration::from_millis(200),
            ..Limits::default()
        };
        let shared = Vm::pure(limits.clone()).unwrap();
        let dedicated = Vm::pure(limits.clone()).unwrap();
        let other = Vm::pure(limits.clone()).unwrap();
        let innocent = shared
            .load(
                "innocent.mjs".into(),
                "export function ping() { return 1; }".into(),
            )
            .unwrap();
        let separate = dedicated
            .load(
                "separate.mjs".into(),
                "export function ping() { return 2; }".into(),
            )
            .unwrap();
        assert_eq!(call(&innocent, "ping").await, json!(1));
        assert_eq!(shared.statistics(false).await.unwrap().modules, 1);
        separate.ready().await.unwrap();
        let runaway = shared
            .load(
                "runaway.mjs".into(),
                "export function run() { while (true) {} }".into(),
            )
            .unwrap();
        assert!(runaway.call(vec!["run".into()], vec![]).await.is_err());
        assert!(innocent.call(vec!["ping".into()], vec![]).await.is_err());
        innocent.close().await.unwrap();
        runaway.close().await.unwrap();
        assert_eq!(call(&separate, "ping").await, json!(2));
        assert!(!other.is_terminated());
        separate.close().await.unwrap();
        shared.shutdown().await;
        dedicated.shutdown().await;
        other.shutdown().await;
        // Retaining dead handles must not revive or retarget a VM.
        let replacement = Vm::pure(limits).unwrap();
        assert!(!replacement.is_terminated());
        replacement.shutdown().await;
    })
    .await
    .unwrap();
}
