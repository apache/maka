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

use super::{Inner, Limits, Result, Vm, failed};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};

/// Lazy execution placement. Weak references never keep an unused VM alive.
pub struct Pool {
    limits: Limits,
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    shared: Weak<Inner>,
    dedicated: BTreeMap<String, Weak<Inner>>,
}
impl Pool {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            state: Mutex::new(State::default()),
        }
    }

    pub fn shared(&self) -> Result<Vm> {
        let mut state = self.state.lock().unwrap();
        if let Some(vm) = alive(&state.shared) {
            return Ok(vm);
        }
        let vm = Vm::new(self.limits.clone())?;
        state.shared = Arc::downgrade(&vm.0);
        Ok(vm)
    }

    /// The key identifies a loaded package generation, not an Entry or request.
    pub fn dedicated(&self, generation: &str) -> Result<Vm> {
        if generation.is_empty() || generation.len() > 1024 {
            return Err(failed("invalid package generation"));
        }
        let mut state = self.state.lock().unwrap();
        if let Some(vm) = state.dedicated.get(generation).and_then(alive) {
            return Ok(vm);
        }
        state.dedicated.retain(|_, vm| vm.strong_count() != 0);
        let vm = Vm::new(self.limits.clone())?;
        state
            .dedicated
            .insert(generation.into(), Arc::downgrade(&vm.0));
        Ok(vm)
    }
}
fn alive(inner: &Weak<Inner>) -> Option<Vm> {
    inner.upgrade().map(Vm).filter(|vm| !vm.is_terminated())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    #[tokio::test]
    async fn dedicated_generations_are_lazy_weak_and_not_limited_by_inventory_count() {
        tokio::time::timeout(Duration::from_secs(15), async {
            let pool = Pool::new(Limits::default());
            assert!(pool.state.lock().unwrap().dedicated.is_empty());
            let mut generations = Vec::new();
            for index in 0..6 {
                let generation = format!("package-{index}:digest");
                let vm = pool.dedicated(&generation).unwrap();
                let module = vm.load(format!("package-{index}.mjs"), format!(
                    "globalThis.loaded = (globalThis.loaded ?? 0) + 1; export function value() {{ return [{index}, globalThis.loaded]; }}"
                )).unwrap();
                assert_eq!(module.call(vec!["value".into()], vec![]).await.unwrap(), json!([index, 1]));
                let repeated = pool.dedicated(&generation).unwrap();
                assert!(Arc::ptr_eq(&vm.0, &repeated.0));
                assert_eq!(repeated.statistics(false).await.unwrap().modules, 1);
                generations.push((generation, vm, module));
            }
            assert_eq!(pool.state.lock().unwrap().dedicated.len(), 6);
            let mut released = Vec::new();
            for (generation, vm, module) in generations {
                let weak_module = module.downgrade();
                module.close().await.unwrap();
                assert_eq!(vm.statistics(false).await.unwrap().modules, 0);
                drop(module);
                assert!(weak_module.upgrade().is_none());
                let health = vm.0.health.clone();
                let weak_vm = Arc::downgrade(&vm.0);
                drop(vm);
                assert!(weak_vm.upgrade().is_none(), "pool must not own its VMs");
                health.closed.cancelled().await;
                released.push((generation, health));
            }
            for (generation, old_health) in released {
                let replacement = pool.dedicated(&generation).unwrap();
                assert!(!Arc::ptr_eq(&replacement.0.health, &old_health));
                assert!(!replacement.is_terminated());
                let module = replacement.load("fresh.mjs".into(), "export function fresh() { return globalThis.loaded === undefined; }".into()).unwrap();
                assert_eq!(module.call(vec!["fresh".into()], vec![]).await.unwrap(), json!(true));
                module.close().await.unwrap();
                replacement.shutdown().await;
            }
        }).await.expect("module close and worker teardown acknowledge without sleeps");
    }
}
