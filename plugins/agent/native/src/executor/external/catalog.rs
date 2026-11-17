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
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Read {
    Snapshot,
    Refresh,
    Resolve,
}

#[derive(Default)]
pub(super) struct Catalog {
    cwd: Option<String>,
    generation: u64,
    sources: BTreeMap<NativeRuntime, Source>,
    failure: Option<Error>,
}

struct Source {
    checked: Instant,
    refreshing: bool,
    value: Option<Value>,
}

impl Catalog {
    pub(super) fn is_current(&self, generation: u64) -> bool {
        generation == self.generation
    }

    pub(super) fn failure(&self) -> Result<(), Error> {
        self.failure.clone().map_or(Ok(()), Err)
    }

    pub(super) fn invalidate(&mut self) {
        for source in self.sources.values_mut() {
            source.checked = Instant::now() - Duration::from_secs(30);
        }
    }

    pub(super) fn admit(
        &self,
        resources: &Arc<maka_plugin_core::work::resources::Resources>,
    ) -> Result<maka_plugin_core::work::resources::Ticket, Error> {
        self.failure()?;
        resources.reserve().map_err(|_| Error::Retired)
    }

    pub(super) fn observe(&mut self, result: &Result<Value, Error>) {
        if let Err(error @ (Error::Unknown | Error::CleanupUnconfirmed)) = result
            && !matches!(self.failure, Some(Error::CleanupUnconfirmed))
        {
            self.failure = Some(error.clone());
        }
    }

    pub(super) fn prepare(
        &mut self,
        cwd: &str,
        runtimes: impl Iterator<Item = NativeRuntime>,
        refresh: bool,
    ) -> (u64, Vec<NativeRuntime>) {
        if self.cwd.as_deref() != Some(cwd) {
            self.cwd = Some(cwd.into());
            self.generation += 1;
            self.sources.clear();
        }
        let mut work = Vec::new();
        if refresh {
            for runtime in runtimes {
                let source = self.sources.entry(runtime).or_insert_with(|| Source {
                    checked: Instant::now() - Duration::from_secs(30),
                    refreshing: false,
                    value: None,
                });
                if !source.refreshing && source.checked.elapsed() >= Duration::from_secs(30) {
                    source.refreshing = true;
                    work.push(runtime);
                }
            }
        }
        (self.generation, work)
    }

    pub(super) fn publish(
        &mut self,
        generation: u64,
        runtime: NativeRuntime,
        result: Result<Value, Error>,
    ) {
        if generation != self.generation {
            return;
        }
        let Some(source) = self.sources.get_mut(&runtime) else {
            return;
        };
        source.refreshing = false;
        source.checked = Instant::now();
        match result {
            Ok(value) => {
                let failed = ["installation", "models"]
                    .iter()
                    .any(|field| value[field]["kind"] == "error");
                if failed {
                    tracing::warn!(runtime = runtime.as_str(), detail = %value, "Native model discovery failed; retaining the last catalog");
                }
                if !failed || source.value.is_none() {
                    source.value = Some(value);
                }
            }
            Err(error) => {
                tracing::warn!(runtime = runtime.as_str(), %error, "Native model discovery failed")
            }
        }
    }

    pub(super) fn snapshot(&self, selected: Option<NativeRuntime>) -> (Vec<Value>, bool) {
        let mut values = Vec::new();
        let mut refreshing = false;
        for (runtime, source) in &self.sources {
            if selected.is_some_and(|selected| selected != *runtime) {
                continue;
            }
            values.extend(source.value.clone());
            refreshing |= source.refreshing;
        }
        (values, refreshing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_publishes_sources_independently_and_retains_success_during_failed_refresh() {
        let mut catalog = Catalog::default();
        let runtimes = [NativeRuntime::Antigravity, NativeRuntime::Codex];
        let (generation, work) = catalog.prepare("/a", runtimes.into_iter(), true);
        assert_eq!(work.len(), 2);
        let codex = json!({"runtime":"codex","models":{"kind":"ok","models":[{"id":"gpt"}]}});
        catalog.publish(generation, NativeRuntime::Codex, Ok(codex.clone()));
        assert_eq!(catalog.snapshot(None), (vec![codex.clone()], true));
        assert!(
            catalog
                .prepare("/a", runtimes.into_iter(), true)
                .1
                .is_empty(),
            "readers must share admitted work"
        );
        catalog.publish(
            generation,
            NativeRuntime::Antigravity,
            Ok(json!({"runtime":"antigravity","models":{"kind":"ok","models":[]}})),
        );
        catalog.invalidate();
        assert!(
            catalog
                .prepare("/a", runtimes.into_iter(), false)
                .1
                .is_empty(),
            "pagination must not discover models"
        );
        let (_, work) = catalog.prepare("/a", runtimes.into_iter(), true);
        assert_eq!(work.len(), 2);
        assert_eq!(
            catalog.snapshot(Some(NativeRuntime::Codex)),
            (vec![codex.clone()], true)
        );
        catalog.publish(
            generation,
            NativeRuntime::Codex,
            Ok(json!({"runtime":"codex","models":{"kind":"error","detail":"offline"}})),
        );
        assert_eq!(
            catalog.snapshot(Some(NativeRuntime::Codex)),
            (vec![codex], false),
            "a discovery failure must not erase selectable models"
        );
        catalog.prepare("/b", runtimes.into_iter(), true);
        catalog.prepare("/a", runtimes.into_iter(), true);
        catalog.publish(
            generation,
            NativeRuntime::Antigravity,
            Ok(json!({"runtime":"antigravity"})),
        );
        assert_eq!(
            catalog.snapshot(None),
            (vec![], true),
            "a late result cannot publish into a new workspace generation"
        );
    }
}
