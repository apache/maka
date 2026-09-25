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

use crate::CellDiagnostic;
use maka_runtime::tool_output::ImageOutput;
use maka_runtime::tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

/// Only JSON crosses cell boundaries; neither V8 handles nor authority are stored.
#[derive(Clone, Default)]
pub struct CellStore(Arc<Mutex<BTreeMap<String, Value>>>);

/// Synchronous notification admission shared by all cells of a Run. Closing
/// and enqueueing use the same lock; publication remains the Host's job.
#[derive(Clone, Default)]
pub struct NotificationGate(Arc<Mutex<bool>>);

impl NotificationGate {
    pub fn close(&self) {
        *self.0.lock().unwrap() = true;
    }

    pub fn close_if_empty<'a>(&self, mut contexts: impl Iterator<Item = &'a CellContext>) -> bool {
        let mut closed = self.0.lock().unwrap();
        if contexts.any(CellContext::has_notifications) {
            return false;
        }
        *closed = true;
        true
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CellOutput {
    Text {
        text: String,
    },
    Image {
        image: ImageOutput,
    },
    Media {
        content: maka_runtime::capability::ContentBlock,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<maka_runtime::tool_output::ImageDetail>,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct ToolMetadata {
    pub name: String,
    pub description: String,
}

/// A cell's bounded scratch data and emitted output, separate from its V8 heap.
/// Host observers own delivery; the VM only appends and requests an observation.
#[derive(Clone)]
pub struct CellContext(Arc<Inner>);

struct Inner {
    store: CellStore,
    state: Mutex<State>,
    changed: Notify,
    notification_ready: Notify,
    max_bytes: usize,
    metadata: Vec<ToolMetadata>,
    notification_gate: NotificationGate,
}

struct State {
    values: BTreeMap<String, Value>,
    writes: BTreeMap<String, Value>,
    output: Vec<CellOutput>,
    notifications: VecDeque<String>,
    output_bytes: usize,
    output_count: usize,
    yielded: bool,
    failure: Option<ToolError>,
}

impl CellContext {
    pub fn new(store: CellStore, max_bytes: usize, metadata: Vec<ToolMetadata>) -> Self {
        Self::with_notification_gate(store, max_bytes, metadata, NotificationGate::default())
    }

    pub fn with_notification_gate(
        store: CellStore,
        max_bytes: usize,
        metadata: Vec<ToolMetadata>,
        notification_gate: NotificationGate,
    ) -> Self {
        let values = store.0.lock().unwrap().clone();
        Self(Arc::new(Inner {
            store,
            state: Mutex::new(State {
                values,
                writes: BTreeMap::new(),
                output: Vec::new(),
                notifications: VecDeque::new(),
                output_bytes: 0,
                output_count: 0,
                yielded: false,
                failure: None,
            }),
            changed: Notify::new(),
            notification_ready: Notify::new(),
            max_bytes,
            metadata,
            notification_gate,
        }))
    }

    pub(crate) fn metadata(&self) -> &[ToolMetadata] {
        &self.0.metadata
    }

    /// Host failures are visible before drain, but never erased by JS catch.
    pub fn failure(&self) -> Option<ToolError> {
        self.0.state.lock().unwrap().failure.clone()
    }

    pub fn fail(&self, error: ToolError) {
        self.0.state.lock().unwrap().failure.get_or_insert(error);
        self.yield_output();
    }

    pub(crate) fn load(&self, key: &str) -> Option<Value> {
        self.0.state.lock().unwrap().values.get(key).cloned()
    }

    pub(crate) fn store(&self, key: String, value: Value) -> Result<(), CellDiagnostic> {
        let mut state = self.0.state.lock().unwrap();
        let previous = state.values.insert(key.clone(), value.clone());
        if serde_json::to_vec(&state.values).unwrap().len() > self.0.max_bytes {
            match previous {
                Some(previous) => {
                    state.values.insert(key, previous);
                }
                None => {
                    state.values.remove(&key);
                }
            }
            return Err(CellDiagnostic::limit("cell store byte limit exceeded"));
        }
        state.writes.insert(key, value);
        Ok(())
    }

    /// Called only after the cell's effects and canonical completion settle.
    pub fn commit(&self) -> Result<(), CellDiagnostic> {
        let state = self.0.state.lock().unwrap();
        let mut store = self.0.store.0.lock().unwrap();
        let mut next = store.clone();
        next.extend(state.writes.clone());
        if serde_json::to_vec(&next).unwrap().len() > self.0.max_bytes {
            return Err(CellDiagnostic::limit(
                "shared cell store byte limit exceeded",
            ));
        }
        *store = next;
        Ok(())
    }

    pub(crate) fn emit(&self, output: CellOutput) -> Result<(), CellDiagnostic> {
        if let CellOutput::Media { content, .. } = &output
            && !matches!(
                content,
                maka_runtime::capability::ContentBlock::Image { .. }
                    | maka_runtime::capability::ContentBlock::Audio { .. }
            )
        {
            return Err(CellDiagnostic::new(
                crate::CellDiagnosticKind::ExecutionError,
                "expected image or audio content",
            ));
        }
        let bytes = serde_json::to_vec(&output).unwrap().len();
        let mut state = self.0.state.lock().unwrap();
        // A lifetime bound, not a per-observation bound: slow observers cannot
        // cause unbounded memory, and fast observers cannot defeat the budget.
        if state.output_count >= 63 || bytes > self.0.max_bytes.saturating_sub(state.output_bytes) {
            return Err(CellDiagnostic::limit("cell output limit exceeded"));
        }
        state.output_bytes += bytes;
        state.output_count += 1;
        state.output.push(output);
        Ok(())
    }

    pub(crate) fn yield_output(&self) {
        self.0.state.lock().unwrap().yielded = true;
        self.0.changed.notify_one();
    }

    pub async fn yielded(&self) {
        loop {
            let changed = self.0.changed.notified();
            if self.0.state.lock().unwrap().yielded {
                return;
            }
            changed.await;
        }
    }

    pub fn take_output(&self) -> Vec<CellOutput> {
        let mut state = self.0.state.lock().unwrap();
        state.yielded = false;
        std::mem::take(&mut state.output)
    }

    pub(crate) fn notify(&self, text: String) -> Result<(), CellDiagnostic> {
        let closed = self.0.notification_gate.0.lock().unwrap();
        if *closed {
            return Err(CellDiagnostic::new(
                crate::CellDiagnosticKind::ExecutionError,
                "notification Run is closed",
            ));
        }
        if text.trim().is_empty() || text.len() > 128 * 1024 {
            return Err(CellDiagnostic::new(
                crate::CellDiagnosticKind::ExecutionError,
                "notify expects non-empty text of at most 128 KiB",
            ));
        }
        let mut state = self.0.state.lock().unwrap();
        if state.output_count >= 63
            || text.len() > self.0.max_bytes.saturating_sub(state.output_bytes)
        {
            return Err(CellDiagnostic::limit("cell output limit exceeded"));
        }
        state.output_count += 1;
        state.output_bytes += text.len();
        state.notifications.push_back(text);
        self.0.notification_ready.notify_one();
        Ok(())
    }

    pub async fn notified(&self) {
        loop {
            let ready = self.0.notification_ready.notified();
            if !self.0.state.lock().unwrap().notifications.is_empty() {
                return;
            }
            ready.await;
        }
    }

    pub fn take_notifications(&self) -> VecDeque<String> {
        std::mem::take(&mut self.0.state.lock().unwrap().notifications)
    }

    pub fn has_notifications(&self) -> bool {
        !self.0.state.lock().unwrap().notifications.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notification_acceptance_and_empty_queue_closure_are_atomic() {
        let gate = NotificationGate::default();
        let context =
            CellContext::with_notification_gate(CellStore::default(), 4096, vec![], gate.clone());
        context.notify("accepted".into()).unwrap();
        assert!(!gate.close_if_empty(std::iter::once(&context)));
        assert_eq!(context.take_notifications(), ["accepted".to_string()]);
        let empty_checked = std::sync::Barrier::new(2);
        let close = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let closing = scope.spawn(|| {
                gate.close_if_empty(std::iter::once(&context).chain(std::iter::from_fn(|| {
                    empty_checked.wait();
                    close.wait();
                    None
                })))
            });
            empty_checked.wait();
            let late = scope.spawn(|| context.notify("after the empty check".into()));
            close.wait();
            assert!(closing.join().unwrap());
            assert!(late.join().unwrap().is_err());
        });
        assert!(context.take_notifications().is_empty());
    }
}
