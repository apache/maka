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
use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

/// Canonical SessionData reader; each Cell owns a separate unpublished draft.
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

pub use maka_agent_facts::cells::CellOutput;

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
    draft: maka_session_state::Draft,
    state: Mutex<State>,
    changed: Notify,
    notification_ready: Notify,
    metadata: Vec<ToolMetadata>,
    notification_gate: NotificationGate,
    timeout: crate::timeout::TimeoutClock,
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
        let draft = store.0.draft();
        Ok(Self(Arc::new(Inner {
            draft,
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
            timeout: Default::default(),
        })))
    }

    pub fn metadata(&self) -> &[ToolMetadata] {
        &self.0.metadata
    }

    /// Exclude a trusted Host wait from the REPL timeout. JavaScript cannot
    /// acquire this scope; execution continues to consume budget while it lives.
    pub fn suspend_timeout(&self) -> crate::CellTimeoutGuard {
        self.0.timeout.suspend()
    }

    /// Interpreter-only scope around each synchronous VM dispatch or poll.
    pub fn enter_execution(&self) -> crate::CellTimeoutGuard {
        self.0.timeout.execute()
    }

    /// Start an interpreter watchdog now, excluding only suspended Host waits.
    /// This does not suspend cancellation or heap accounting.
    pub fn timeout_budget(&self, budget: std::time::Duration) -> crate::CellTimeoutBudget {
        self.0.timeout.budget(budget)
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
            .draft
            .load(key)
            .map_err(|error| self.state_failure(error))
    }

    pub fn store(&self, key: String, value: Value) -> Result<(), CellDiagnostic> {
        self.0
            .draft
            .store(&key, &value)
            .map_err(|error| self.state_failure(error))
    }

    fn state_failure(&self, error: maka_session_state::Error) -> CellDiagnostic {
        // Storage failure remains fatal even if user code catches the helper error.
        self.fail(ToolError::Persistence(error.to_string()));
        state_error(error)
    }

    /// Seal and transfer this Cell's private changes. The caller must first
    /// settle all effects and verify success, then publish these changes with
    /// Run acceptance and Cell completion in one canonical Root transaction.
    /// Taking the draft alone never publishes anything.
    pub fn take_draft(&self) -> Result<maka_session_state::SessionDraft, CellDiagnostic> {
        if let Some(error) = self.failure() {
            return Err(CellDiagnostic::new(
                crate::CellDiagnosticKind::ToolFailure,
                error.to_string(),
            ));
        }
        self.0
            .draft
            .freeze()
            .map_err(|error| self.state_failure(error))
    }

    /// Explicit Cell-local discovery staging, separate from Session staging.
    pub fn stage_loaded(
        &self,
        names: std::collections::BTreeSet<String>,
    ) -> Result<(), CellDiagnostic> {
        self.0
            .draft
            .stage_loaded(names)
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
