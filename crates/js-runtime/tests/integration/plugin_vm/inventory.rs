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

#[tokio::test]
async fn shared_vm_keeps_eighty_modules_then_reclaims_and_reloads_them() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let pool = Pool::new(Limits::default());
        let vm = pool.shared().unwrap();
        let mut previous_keys = std::collections::BTreeSet::new();
        for generation in 0..2 {
            let modules = (0..80).map(|index| {
                vm.load(format!("entry-{index}.mjs"), format!(
                    "const identity = [{generation}, {index}]; export function value() {{ return identity; }}"
                )).unwrap()
            }).collect::<Vec<_>>();
            for (index, module) in modules.iter().enumerate() {
                assert_eq!(call(module, "value").await, json!([generation, index]));
                assert!(previous_keys.insert(module.host_key()), "module identities are never recycled");
            }
            let snapshot = pool.shared().unwrap().statistics(false).await.unwrap();
            assert_eq!(snapshot.modules, 80);
            assert_eq!(snapshot.pending_calls, 0);
            for module in modules {
                let weak = module.downgrade();
                module.close().await.unwrap();
                assert!(module.call(vec!["value".into()], vec![]).await.is_err());
                drop(module);
                assert!(weak.upgrade().is_none());
            }
            assert_eq!(vm.statistics(true).await.unwrap().modules, 0);
        }
        vm.shutdown().await;
    }).await.expect("eighty small modules drain and reload without sleeps");
}

struct NoHostCalls;
impl Bridge for NoHostCalls {
    fn call(
        &self,
        method: String,
        _: Value,
    ) -> futures_util::future::BoxFuture<'static, Result<Value, Error>> {
        panic!("business lifetime fixture unexpectedly called Host method {method}")
    }
}

#[tokio::test]
async fn shared_sdk_business_tasks_do_not_reserve_ordinary_call_slots() {
    use maka_js_runtime::plugin::Lifecycle;
    use std::sync::Arc;
    const SOURCE: &str = r#"
let activations = 0, started = 0;
export default async function activate(ctx) {
  activations++;
  ctx.run(async () => { started++; await ctx.signal.wait(); });
  await ctx.remote.method('stats', () => ({ activations, started }));
}
"#;
    tokio::time::timeout(Duration::from_secs(30), async {
        let limits = Limits::default();
        assert_eq!(limits.heap_bytes, 128 * 1024 * 1024);
        let vm = Vm::new(limits).unwrap();
        let plain = vm
            .load(
                "not-sdk.mjs".into(),
                "export function effective() { throw new Error('must not run'); }".into(),
            )
            .unwrap();
        assert!(
            plain
                .start_tasks()
                .await
                .unwrap_err()
                .to_string()
                .contains("SDK plugin")
        );
        plain.close().await.unwrap();
        let mut modules = Vec::new();
        for index in 0..130 {
            let module = vm
                .load_plugin(
                    format!("business-{index}.mjs"),
                    SOURCE.into(),
                    Arc::new(NoHostCalls),
                )
                .unwrap();
            assert!(
                module
                    .start_tasks()
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("Invalid effective transition")
            );
            let registrations = module
                .call(vec!["activate".into()], vec![json!({}), Value::Null])
                .await
                .unwrap();
            let stats = registrations[0]["callback"].clone();
            let running = module.clone();
            let tasks = tokio::spawn(async move { running.start_tasks().await });
            loop {
                let value = module
                    .call(
                        vec!["invoke".into()],
                        vec![stats.clone(), Value::Null, json!({})],
                    )
                    .await
                    .unwrap();
                assert_eq!(value["value"]["activations"], 1);
                if value["value"]["started"] == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
            modules.push((module, stats, tasks));
        }
        let current = vm.statistics(false).await.unwrap();
        assert_eq!(current.modules, 130);
        assert_eq!(current.pending_calls, 130);
        for (module, stats, tasks) in &modules {
            assert!(
                !tasks.is_finished(),
                "each business lifetime remains pending"
            );
            let value = module
                .call(
                    vec!["invoke".into()],
                    vec![stats.clone(), Value::Null, json!({})],
                )
                .await
                .unwrap();
            assert_eq!(value["value"], json!({"activations":1,"started":1}));
        }
        assert!(
            modules[0]
                .0
                .start_tasks()
                .await
                .unwrap_err()
                .to_string()
                .contains("Invalid effective transition")
        );
        assert!(
            !modules[0].2.is_finished(),
            "duplicate start cannot replace the original lifetime"
        );
        for (module, _, tasks) in modules {
            module.lifecycle(Lifecycle::Retire).await.unwrap();
            tasks.await.unwrap().unwrap();
            module.lifecycle(Lifecycle::Dispose).await.unwrap();
            module.close().await.unwrap();
        }
        let settled = vm.statistics(true).await.unwrap();
        assert_eq!(settled.modules, 0);
        assert_eq!(settled.pending_calls, 0);
        assert!(!vm.is_terminated());
        vm.shutdown().await;
    })
    .await
    .expect("SDK business jobs share the unchanged 128 MiB VM and retire through reserved control");
}
