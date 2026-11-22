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

use super::*;
use maka_js_runtime::plugin::RequestBridge;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct Echo {
    label: String,
    calls: Arc<AtomicUsize>,
}
impl RequestBridge for Echo {
    fn invoke(
        &self,
        input: Value,
    ) -> futures_util::future::BoxFuture<'static, Result<Value, Error>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let value = if input == "inexact" {
            json!(u64::MAX)
        } else {
            json!({"label":self.label,"input":input})
        };
        Box::pin(async move { Ok(value) })
    }
}
#[tokio::test]
async fn private_contexts_expire_before_reply_without_an_ambient_or_json_address() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let vm = Vm::scoped(Limits::default()).unwrap();
        let module = vm.load("contexts.mjs".into(), r#"
            let saved;
            export const service = {
                async read(input, context) {
                    if (typeof Deno!=='undefined' || typeof fetch!=='undefined') throw Error('ambient capability');
                    if (!Object.isFrozen(context)) throw Error('mutable context');
                    saved=context;
                    return await context.invoke(input);
                },
                async stale() { try { await saved.invoke('old'); return false; } catch(e) { return e.message.includes('expired'); } },
                async invalid(mode, context) {
                    try {
                        await context.invoke(mode==='bigint'?1n:'inexact');
                        return false;
                    } catch(e) { return e.message.includes(mode==='bigint'?'BigInt':'represented exactly'); }
                },
                mutateIntrinsics() { Object.freeze=()=>{throw Error('poisoned freeze')}; }
            };
        "#.into()).unwrap();
        let callbacks = module.capture(vec!["service".into()], vec!["read".into(),"stale".into(),"invalid".into(),"mutateIntrinsics".into()]).await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let bridge = Arc::new(Echo { label:"first".into(), calls:calls.clone() });
        let weak = Arc::downgrade(&bridge);
        assert_eq!(callbacks.call_with_context("read", vec![json!("value")], bridge).await.unwrap(), json!({"label":"first","input":"value"}));
        assert!(weak.upgrade().is_none(), "reply cannot precede ContextState release");
        assert_eq!(callbacks.call("stale", vec![]).await.unwrap(), json!(true));
        assert!(callbacks.call("read", vec![json!("forged"),json!({"invoke":"1","moduleId":1})]).await.is_err());
        for mode in ["bigint","inexact"] {
            assert_eq!(callbacks.call_with_context("invalid", vec![json!(mode)], Arc::new(Echo { label:mode.into(),calls:calls.clone() })).await.unwrap(), json!(true));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2, "invalid inputs never dispatch");
        callbacks.call("mutateIntrinsics", vec![]).await.unwrap();
        assert_eq!(callbacks.call_with_context("read", vec![Value::Null], Arc::new(Echo { label:"second".into(),calls:calls.clone() })).await.unwrap(), json!({"label":"second","input":null}));
        assert!(!vm.is_terminated());
        module.close().await.unwrap();
        vm.shutdown().await;
        let pure = Vm::pure(Limits::default()).unwrap();
        let module = pure.load("pure.mjs".into(), "export const service={read(){return 1}};".into()).unwrap();
        let callbacks = module.capture(vec!["service".into()],vec!["read".into()]).await.unwrap();
        assert!(callbacks.call_with_context("read", vec![], Arc::new(Echo {label:"forbidden".into(),calls})).await.is_err());
        module.close().await.unwrap();
        pure.shutdown().await;
    }).await.unwrap();
}

struct Held {
    label: String,
    started: Arc<tokio::sync::Semaphore>,
    release: Arc<tokio::sync::Semaphore>,
}
impl RequestBridge for Held {
    fn invoke(&self, _: Value) -> futures_util::future::BoxFuture<'static, Result<Value, Error>> {
        let value = self.label.clone();
        let release = self.release.clone();
        self.started.add_permits(1);
        Box::pin(async move {
            release.acquire_owned().await.unwrap().forget();
            Ok(json!(value))
        })
    }
}
struct Panicking(bool);
impl RequestBridge for Panicking {
    fn invoke(&self, _: Value) -> futures_util::future::BoxFuture<'static, Result<Value, Error>> {
        assert!(!self.0, "bridge preparation panic");
        Box::pin(async { panic!("observer polling panic") })
    }
}
#[tokio::test]
async fn shared_worker_bounds_private_ops_and_releases_contexts_on_actual_completion_or_termination()
 {
    tokio::time::timeout(Duration::from_secs(15), async {
        let vm = Vm::scoped(Limits::default()).unwrap();
        let module = vm.load("held-contexts.mjs".into(), r#"
            export const service={
                async many(count, input, context) { return await Promise.all(Array.from({length:count},()=>context.invoke(input))); },
                async one(input, context) { try { return await context.invoke(input); } catch(e) { return e.message; } }
            };
        "#.into()).unwrap();
        let callbacks = module.capture(vec!["service".into()],vec!["many".into(),"one".into()]).await.unwrap();
        let started = Arc::new(tokio::sync::Semaphore::new(0));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        for (count, input, expected_error) in [
            (32, json!("x".repeat(1024*1024-1024)), "input budget"),
        ] {
            let held = Arc::new(Held { label:"first".into(),started:started.clone(),release:release.clone() });
            let weak = Arc::downgrade(&held);
            let first = tokio::spawn({
                let callbacks=callbacks.clone(); let input=input.clone();
                async move { callbacks.call_with_context("many",vec![json!(count),input],held).await }
            });
            started.acquire_many(count).await.unwrap().forget();
            let other = Arc::new(Held { label:"second".into(),started:started.clone(),release:release.clone() });
            assert!(callbacks.call_with_context("one",vec![input],other).await.unwrap().as_str().unwrap().contains(expected_error));
            assert!(weak.upgrade().is_some(), "actual JS request owns the bridge while pending");
            release.add_permits(count as usize);
            assert_eq!(first.await.unwrap().unwrap(),json!(vec!["first";count as usize]));
            assert!(weak.upgrade().is_none());
        }
        let held = Arc::new(Held {label:"survives-panic".into(),started:started.clone(),release:release.clone()});
        let healthy = tokio::spawn({ let callbacks=callbacks.clone(); async move { callbacks.call_with_context("one",vec![Value::Null],held).await } });
        started.acquire().await.unwrap().forget();
        for (preparation, expected) in [(true,"preparation panicked"),(false,"observer panicked")] {
            assert!(callbacks.call_with_context("one",vec![Value::Null],Arc::new(Panicking(preparation))).await.unwrap().as_str().unwrap().contains(expected));
            assert!(!vm.is_terminated());
            assert!(!healthy.is_finished(),"another accepted callback survives the op panic");
        }
        release.add_permits(1);
        assert_eq!(healthy.await.unwrap().unwrap(),json!("survives-panic"));
        let held = Arc::new(Held {label:"abandoned".into(),started:started.clone(),release:release.clone()});
        let weak = Arc::downgrade(&held);
        let mut observer = Box::pin(callbacks.call_with_context("one",vec![Value::Null],held));
        assert!(futures_util::poll!(observer.as_mut()).is_pending());
        started.acquire().await.unwrap().forget();
        drop(observer);
        assert!(weak.upgrade().is_some(),"dropping the observer cannot expire the actual pending callback");
        release.add_permits(1);
        while weak.upgrade().is_some() { tokio::task::yield_now().await; }
        let held = Arc::new(Held {label:"terminal".into(),started:started.clone(),release:release.clone()});
        let weak = Arc::downgrade(&held);
        let pending = tokio::spawn({ let callbacks=callbacks.clone(); async move { callbacks.call_with_context("one",vec![Value::Null],held).await } });
        started.acquire().await.unwrap().forget();
        vm.terminate("test request termination");
        let failure = vm.failed().await.to_string();
        assert_eq!(
            failure,
            "plugin VM: test request termination (phase: script poll)"
        );
        vm.terminate("later termination must not replace the first reason");
        let Err(load_error) = vm.load(
            "after-termination.mjs".into(),
            "export const value = 1;".into(),
        ) else {
            panic!("a terminated VM must refuse new modules");
        };
        assert_eq!(load_error.to_string(), failure);
        assert!(pending.await.unwrap().is_err());
        assert!(weak.upgrade().is_none(), "terminal reply follows all context releases");
        module.close().await.unwrap();
        vm.shutdown().await;
    }).await.unwrap();
}
