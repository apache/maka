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
use maka_agent_facts::tool_output::ImageOutput;
use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

/// Only JSON crosses cell boundaries; idle values and pending writes live on disk.
#[derive(Clone)]
pub struct CellStore(maka_session_state::Session);

impl CellStore {
    pub fn new(session: maka_session_state::Session) -> Self {
        Self(session)
    }

    pub fn temporary() -> Result<Self, CellDiagnostic> {
        Ok(Self(
            maka_session_state::Backend::temporary()
                .map_err(state_error)?
                .session("scratch"),
        ))
    }
}

fn state_error(error: maka_session_state::Error) -> CellDiagnostic {
    CellDiagnostic::new(crate::CellDiagnosticKind::ExecutionError, error.to_string())
}

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
        content: maka_agent_facts::capability::ContentBlock,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<maka_agent_facts::tool_output::ImageDetail>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ToolMetadata {
    pub name: String,
    pub description: String,
}

/// A cell's JSON scratch data and emitted output, separate from its interpreter heap.
/// Host observers own delivery; the VM only appends and requests an observation.
#[derive(Clone)]
pub struct CellContext(Arc<Inner>);

struct Inner {
    snapshot: maka_session_state::Snapshot,
    state: Mutex<State>,
    changed: Notify,
    notification_ready: Notify,
    metadata: Vec<ToolMetadata>,
    notification_gate: NotificationGate,
}

struct State {
    output: Vec<CellOutput>,
    notifications: VecDeque<String>,
    deduplicate_images: bool,
    yielded: bool,
    failure: Option<ToolError>,
}

impl CellContext {
    pub fn new(store: CellStore, metadata: Vec<ToolMetadata>) -> Result<Self, CellDiagnostic> {
        Self::with_notification_gate(store, metadata, NotificationGate::default())
    }

    pub fn with_notification_gate(
        store: CellStore,
        metadata: Vec<ToolMetadata>,
        notification_gate: NotificationGate,
    ) -> Result<Self, CellDiagnostic> {
        let snapshot = store.0.snapshot().map_err(state_error)?;
        Ok(Self(Arc::new(Inner {
            snapshot,
            state: Mutex::new(State {
                output: Vec::new(),
                notifications: VecDeque::new(),
                deduplicate_images: false,
                yielded: false,
                failure: None,
            }),
            changed: Notify::new(),
            notification_ready: Notify::new(),
            metadata,
            notification_gate,
        })))
    }

    pub fn metadata(&self) -> &[ToolMetadata] {
        &self.0.metadata
    }

    /// Observation tools can emit a screenshot automatically and then receive
    /// the same image through explicit output. Count it once in this batch;
    /// retain no image cache across evaluations or drained batches.
    pub fn with_image_deduplication(self) -> Self {
        self.0.state.lock().unwrap().deduplicate_images = true;
        self
    }

    /// Host failures are visible before drain, but never erased by user exception handling.
    pub fn failure(&self) -> Option<ToolError> {
        self.0.state.lock().unwrap().failure.clone()
    }

    pub fn fail(&self, error: ToolError) {
        self.0.state.lock().unwrap().failure.get_or_insert(error);
        self.yield_output();
    }

    pub fn load(&self, key: &str) -> Result<Option<Value>, CellDiagnostic> {
        self.0
            .snapshot
            .load(key)
            .map_err(|error| self.state_failure(error))
    }

    pub fn store(&self, key: String, value: Value) -> Result<(), CellDiagnostic> {
        self.0
            .snapshot
            .store(&key, &value)
            .map_err(|error| self.state_failure(error))
    }

    fn state_failure(&self, error: maka_session_state::Error) -> CellDiagnostic {
        // Storage failure remains fatal even if user code catches the helper error.
        self.fail(ToolError::Persistence(error.to_string()));
        state_error(error)
    }

    /// Called only after the cell's effects and canonical completion settle.
    pub fn commit(&self) -> Result<(), CellDiagnostic> {
        self.0
            .snapshot
            .commit()
            .map_err(|error| self.state_failure(error))
    }

    pub fn emit(&self, output: CellOutput) -> Result<(), CellDiagnostic> {
        if let CellOutput::Media { content, .. } = &output
            && !matches!(
                content,
                maka_agent_facts::capability::ContentBlock::Image { .. }
                    | maka_agent_facts::capability::ContentBlock::Audio { .. }
            )
        {
            return Err(CellDiagnostic::new(
                crate::CellDiagnosticKind::ExecutionError,
                "expected image or audio content",
            ));
        }
        let mut state = self.0.state.lock().unwrap();
        if state.deduplicate_images
            && let CellOutput::Media {
                content: image @ maka_agent_facts::capability::ContentBlock::Image { .. },
                detail,
            } = &output
            && state
                .output
                .iter()
                .any(|prior| matches!(prior, CellOutput::Media { content, detail: previous } if content == image && previous == detail))
        {
            return Ok(());
        }
        state.output.push(output);
        Ok(())
    }

    pub fn yield_output(&self) {
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

    pub fn notify(&self, text: String) -> Result<(), CellDiagnostic> {
        let closed = self.0.notification_gate.0.lock().unwrap();
        if *closed {
            return Err(CellDiagnostic::new(
                crate::CellDiagnosticKind::ExecutionError,
                "notification Run is closed",
            ));
        }
        if text.trim().is_empty() {
            return Err(CellDiagnostic::new(
                crate::CellDiagnosticKind::ExecutionError,
                "notify expects non-empty text",
            ));
        }
        let mut state = self.0.state.lock().unwrap();
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
    fn retired_storage_is_a_sticky_host_failure_not_a_missing_value() {
        let backend = maka_session_state::Backend::temporary().unwrap();
        let session = backend.session("retired");
        let context = CellContext::new(CellStore::new(session.clone()), vec![]).unwrap();
        context
            .store("answer".into(), serde_json::json!(42))
            .unwrap();
        session.retire().unwrap();
        assert!(context.load("answer").is_err());
        assert!(matches!(context.failure(), Some(ToolError::Persistence(_))));
        assert!(context.commit().is_err());
    }

    #[test]
    fn observation_image_deduplication_precedes_budget_and_does_not_cross_batches() {
        let image = CellOutput::Media {
            content: maka_agent_facts::capability::ContentBlock::Image {
                data: "a".repeat(2048),
                mime_type: "image/png".into(),
            },
            detail: None,
        };
        let context = CellContext::new(CellStore::temporary().unwrap(), vec![])
            .unwrap()
            .with_image_deduplication();
        context.emit(image.clone()).unwrap();
        context.emit(image.clone()).unwrap();
        assert_eq!(context.take_output().len(), 1);
        // A drained batch does not suppress a new observation.
        context.emit(image.clone()).unwrap();
        assert_eq!(context.take_output().len(), 1);
        let next = CellContext::new(CellStore::temporary().unwrap(), vec![])
            .unwrap()
            .with_image_deduplication();
        next.emit(image.clone()).unwrap();
        assert_eq!(next.take_output().len(), 1);
        let ordinary = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
        ordinary.emit(image.clone()).unwrap();
        ordinary.emit(image).unwrap();
        assert_eq!(ordinary.take_output().len(), 2);
    }

    #[test]
    fn notification_acceptance_and_empty_queue_closure_are_atomic() {
        let gate = NotificationGate::default();
        let context = CellContext::with_notification_gate(
            CellStore::temporary().unwrap(),
            vec![],
            gate.clone(),
        )
        .unwrap();
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
