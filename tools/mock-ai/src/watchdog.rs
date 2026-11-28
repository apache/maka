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

use crate::protocol::{NormalizedRequest, Protocol};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Configuration for the inline protocol-invariant watchdog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchdogConfig {
    pub enabled: bool,
    /// Maximum violation records kept in the diagnostic ring buffer.
    pub max_violations: usize,
    /// Maximum tracked sessions before oldest entries are evicted.
    pub max_tracked_sessions: usize,
    /// Optional byte ceiling for a single session's prompt before flagging unbounded growth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_session_prompt_bytes: Option<usize>,
    /// Verify that after server-side compaction, the next turn replays compaction or shrinks context.
    pub check_compaction_effectiveness: bool,
    /// Verify tool_result call_ids against previously emitted tool calls (duplicates & unknown IDs).
    pub check_tool_accounting: bool,
    /// Also flag when a previously emitted tool_call_id has no tool_result on the following turn.
    /// Off by default because user steering/cancellation can legitimately abort tool execution.
    pub check_missing_tool_results: bool,
}

impl Default for WatchdogConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_violations: 256,
            max_tracked_sessions: 65_536,
            max_session_prompt_bytes: Some(8 * 1024 * 1024),
            check_compaction_effectiveness: true,
            check_tool_accounting: true,
            check_missing_tool_results: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViolationKind {
    CompactionNotApplied,
    CompactionNotReplayed,
    /// A previously observed call ID was replayed with different result content.
    DuplicateToolResult,
    CrossSessionToolResult,
    ToolResultBeforeDelivery,
    UnknownToolResult,
    MissingToolResult,
    UnboundedPromptGrowth,
    InvalidPreviousResponseId,
    AbandonedStream,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViolationRecord {
    pub id: u64,
    pub kind: ViolationKind,
    pub protocol: Protocol,
    pub session_key: String,
    pub model: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub prompt_bytes: usize,
    pub detail: String,
    /// Truncated excerpt of the offending request JSON (never blows up memory).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_excerpt: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogSnapshot {
    pub total_violations: u64,
    pub by_kind: HashMap<ViolationKind, u64>,
    pub recent: Vec<ViolationRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamCloseReason {
    Completed,
    InjectedFault,
    ClientDisconnected,
    ServerShutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySize {
    pub bytes: usize,
    pub tokens: u64,
}

impl HistorySize {
    /// For full requests only. Continuations need the effective history of their accepted prefix.
    pub fn from_request(req: &NormalizedRequest) -> Self {
        Self {
            bytes: req.size_breakdown.history_bytes,
            tokens: req.size_breakdown.estimated_history_tokens,
        }
    }

    fn shrank_from(self, before: Self) -> bool {
        (self.tokens, self.bytes) < (before.tokens, before.bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum CompactionAudit {
    Requested {
        before: HistorySize,
    },
    Issued {
        before: HistorySize,
        checkpoint_id: Option<String>,
    },
    Adopted {
        before: HistorySize,
        checkpoint_id: Option<String>,
        after: Option<HistorySize>,
    },
    Effective {
        before: HistorySize,
        checkpoint_id: Option<String>,
        after: HistorySize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAuditSnapshot {
    pub audit_incomplete: bool,
    pub compaction: Option<CompactionAudit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct ResultDigest(u64);

#[derive(Clone, Copy)]
enum CallState {
    Issued,
    DeliveredComplete,
    ReceiptObserved(ResultDigest),
}

#[derive(Default)]
struct SessionAuditState {
    calls: HashMap<Arc<str>, CallState>,
    call_order: VecDeque<Arc<str>>,
    pending_tool_calls: HashSet<Arc<str>>,
    audit_incomplete: bool,
    compaction: Option<CompactionAudit>,
}

const MAX_SESSION_TOOL_CALLS: usize = 4096;

#[derive(Default)]
struct WatchdogInner {
    sessions: HashMap<String, SessionAuditState>,
    order: VecDeque<String>,
    // Used to diagnose foreign receipts. Only the session's own call state can accept one.
    call_owners: HashMap<Arc<str>, usize>,
    violations: VecDeque<ViolationRecord>,
    by_kind: HashMap<ViolationKind, u64>,
}

impl WatchdogInner {
    fn session(&mut self, key: &str, max_sessions: usize) -> &mut SessionAuditState {
        if !self.sessions.contains_key(key) {
            if self.sessions.len() >= max_sessions
                && let Some(oldest) = self.order.pop_front()
                && let Some(old) = self.sessions.remove(&oldest)
            {
                for call_id in old.call_order {
                    remove_owner(&mut self.call_owners, &call_id);
                }
            }
            self.order.push_back(key.to_owned());
            self.sessions
                .insert(key.to_owned(), SessionAuditState::default());
        }
        self.sessions.get_mut(key).expect("audit session exists")
    }

    fn register_call(
        &mut self,
        session_key: &str,
        call_id: &str,
        update: CallState,
        check_missing: bool,
    ) {
        let state = self
            .sessions
            .get_mut(session_key)
            .expect("audit session exists");
        if let Some(existing) = state.calls.get_mut(call_id) {
            if matches!(
                (*existing, update),
                (CallState::Issued, CallState::DeliveredComplete)
            ) {
                *existing = update;
            } else {
                return;
            }
        } else {
            if state.calls.len() == MAX_SESSION_TOOL_CALLS
                && let Some(evicted) = state.call_order.pop_front()
            {
                state.calls.remove(&evicted);
                state.pending_tool_calls.remove(&evicted);
                remove_owner(&mut self.call_owners, &evicted);
                state.audit_incomplete = true;
            }
            let id: Arc<str> = Arc::from(call_id);
            *self.call_owners.entry(id.clone()).or_default() += 1;
            state.call_order.push_back(id.clone());
            state.calls.insert(id, update);
        }
        if check_missing && matches!(update, CallState::DeliveredComplete) {
            let (id, _) = state
                .calls
                .get_key_value(call_id)
                .expect("registered call exists");
            state.pending_tool_calls.insert(id.clone());
        }
    }
}

fn remove_owner(owners: &mut HashMap<Arc<str>, usize>, call_id: &str) {
    let count = owners
        .get_mut(call_id)
        .expect("registered call has an owner");
    *count -= 1;
    if *count == 0 {
        owners.remove(call_id);
    }
}

/// Lightweight inline invariant checker that captures only violating evidence even in MetricsOnly mode.
pub struct ProtocolWatchdog {
    config: WatchdogConfig,
    next_id: AtomicU64,
    total_violations: AtomicU64,
    inner: Mutex<WatchdogInner>,
}

impl ProtocolWatchdog {
    pub fn new(config: WatchdogConfig) -> Self {
        Self {
            config,
            next_id: AtomicU64::new(1),
            total_violations: AtomicU64::new(0),
            inner: Mutex::new(WatchdogInner::default()),
        }
    }

    pub fn total_violations(&self) -> u64 {
        self.total_violations.load(Ordering::Relaxed)
    }

    pub fn inspect_request(&self, req: &NormalizedRequest) {
        self.inspect_request_with_verified_history(req, 0);
    }

    /// `verified_items` counts matching items from the already accepted history prefix.
    pub fn inspect_request_with_verified_history(
        &self,
        req: &NormalizedRequest,
        verified_items: usize,
    ) {
        if !self.config.enabled {
            return;
        }

        let receipts = if self.config.check_tool_accounting {
            result_receipts(req)
        } else {
            Vec::new()
        };
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.session(&req.session_key, self.config.max_tracked_sessions.max(1));
        let WatchdogInner {
            sessions,
            call_owners,
            ..
        } = &mut *inner;
        let state = sessions
            .get_mut(&req.session_key)
            .expect("audit session exists");
        let mut violations = Vec::new();

        if self.config.check_compaction_effectiveness {
            if req.has_compaction_trigger {
                if req.previous_response_id.is_none() {
                    state.compaction = Some(CompactionAudit::Requested {
                        before: HistorySize::from_request(req),
                    });
                }
            } else if req.previous_response_id.is_none()
                && let Some(CompactionAudit::Issued {
                    before,
                    checkpoint_id: None,
                }) = state.compaction
            {
                if req
                    .messages
                    .iter()
                    .any(|message| message.is_compaction_item)
                {
                    if let Some(detail) =
                        adopt_compaction(state, None, before, Some(HistorySize::from_request(req)))
                    {
                        violations.push((ViolationKind::CompactionNotApplied, detail));
                    }
                } else {
                    violations.push((
                        ViolationKind::CompactionNotReplayed,
                        "full post-compaction request omitted the compaction item".into(),
                    ));
                }
            }
        }

        if self.config.check_tool_accounting {
            let mut seen = HashSet::new();
            for (index, id, digest) in receipts {
                if index < verified_items
                    && state.audit_incomplete
                    && !state.calls.contains_key(id)
                    && !call_owners.contains_key(id)
                {
                    continue;
                }
                if !seen.insert((id, digest)) {
                    continue;
                }
                let (kind, detail) = match state.calls.get_mut(id) {
                    Some(call @ CallState::DeliveredComplete) => {
                        *call = CallState::ReceiptObserved(digest);
                        if self.config.check_missing_tool_results {
                            state.pending_tool_calls.remove(id);
                        }
                        continue;
                    }
                    Some(CallState::ReceiptObserved(previous)) if *previous == digest => continue,
                    Some(CallState::ReceiptObserved(_)) => (
                        ViolationKind::DuplicateToolResult,
                        "changed the result digest for",
                    ),
                    Some(CallState::Issued) => (
                        ViolationKind::ToolResultBeforeDelivery,
                        "referenced an issued but incompletely delivered",
                    ),
                    None if call_owners.contains_key(id) => (
                        ViolationKind::CrossSessionToolResult,
                        "referenced another session's",
                    ),
                    None => (
                        ViolationKind::UnknownToolResult,
                        "referenced an unrecognized",
                    ),
                };
                violations.push((kind, format!("tool_result {detail} call_id '{id}'")));
            }
            if self.config.check_missing_tool_results
                && !req.has_compaction_trigger
                && !state.pending_tool_calls.is_empty()
            {
                let mut missing: Vec<&str> =
                    state.pending_tool_calls.iter().map(AsRef::as_ref).collect();
                missing.sort_unstable();
                violations.push((
                    ViolationKind::MissingToolResult,
                    format!(
                        "missing tool_result(s) for previously delivered call_ids: {missing:?}"
                    ),
                ));
                state.pending_tool_calls.clear();
            }
        }

        if let Some(limit) = self.config.max_session_prompt_bytes
            && req.prompt_bytes > limit
        {
            violations.push((
                ViolationKind::UnboundedPromptGrowth,
                format!(
                    "prompt_bytes {} exceeded watchdog limit {limit}",
                    req.prompt_bytes
                ),
            ));
        }
        self.push_violations_locked(&mut inner, req, violations);
    }

    pub fn on_call_issued(&self, req: &NormalizedRequest, call_id: &str) {
        self.on_call(req, call_id, CallState::Issued);
    }

    /// Record a complete call as soon as its last required frame is consumed by the transport.
    pub fn on_call_delivered_complete(&self, req: &NormalizedRequest, call_id: &str) {
        self.on_call(req, call_id, CallState::DeliveredComplete);
    }

    fn on_call(&self, req: &NormalizedRequest, call_id: &str, state: CallState) {
        if !self.config.enabled || !self.config.check_tool_accounting {
            return;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.session(&req.session_key, self.config.max_tracked_sessions.max(1));
        inner.register_call(
            &req.session_key,
            call_id,
            state,
            self.config.check_missing_tool_results,
        );
    }

    pub fn on_stream_closed(&self, req: &NormalizedRequest, reason: StreamCloseReason) {
        if self.config.enabled && reason == StreamCloseReason::ClientDisconnected {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            self.push_violations_locked(
                &mut inner,
                req,
                [(
                    ViolationKind::AbandonedStream,
                    "client disconnected before terminal stream event completed".into(),
                )],
            );
        }
    }

    /// The legacy call site knows which items were delivered. Its boolean conflates all close causes.
    pub fn record_turn_outcome(
        &self,
        req: &NormalizedRequest,
        emitted_tool_call_ids: &[String],
        emitted_compaction: bool,
        _completed_cleanly: bool,
    ) {
        if !self.config.enabled {
            return;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let state = inner.session(&req.session_key, self.config.max_tracked_sessions.max(1));
        if self.config.check_compaction_effectiveness && emitted_compaction {
            let before = match state.compaction {
                Some(CompactionAudit::Requested { before }) => Some(before),
                _ if req.previous_response_id.is_none() => Some(HistorySize::from_request(req)),
                _ => None,
            };
            if let Some(before) = before {
                state.compaction = Some(CompactionAudit::Issued {
                    before,
                    checkpoint_id: None,
                });
            }
        }
        if self.config.check_tool_accounting {
            for id in emitted_tool_call_ids {
                inner.register_call(
                    &req.session_key,
                    id,
                    CallState::DeliveredComplete,
                    self.config.check_missing_tool_results,
                );
            }
        }
    }

    pub fn on_compaction_requested(&self, req: &NormalizedRequest, before: HistorySize) {
        if self.config.enabled && self.config.check_compaction_effectiveness {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner
                .session(&req.session_key, self.config.max_tracked_sessions.max(1))
                .compaction = Some(CompactionAudit::Requested { before });
        }
    }

    pub fn on_compaction_issued(
        &self,
        req: &NormalizedRequest,
        checkpoint_id: &str,
        before: HistorySize,
    ) {
        if self.config.enabled && self.config.check_compaction_effectiveness {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let state = inner.session(&req.session_key, self.config.max_tracked_sessions.max(1));
            if matches!(&state.compaction,
                Some(CompactionAudit::Issued { checkpoint_id: Some(id), .. }
                    | CompactionAudit::Adopted { checkpoint_id: Some(id), .. }
                    | CompactionAudit::Effective { checkpoint_id: Some(id), .. }) if id == checkpoint_id)
            {
                return;
            }
            state.compaction = Some(CompactionAudit::Issued {
                before,
                checkpoint_id: Some(checkpoint_id.into()),
            });
        }
    }

    /// Supply the size of the same effective history prefix excluding system, tools and new input.
    /// An incremental request can establish adoption before a comparable history size is available.
    pub fn on_compaction_adopted(
        &self,
        req: &NormalizedRequest,
        checkpoint_id: &str,
        after: Option<HistorySize>,
    ) {
        if !self.config.enabled || !self.config.check_compaction_effectiveness {
            return;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(state) = inner.sessions.get_mut(&req.session_key) else {
            return;
        };
        let before = match &state.compaction {
            Some(
                CompactionAudit::Issued {
                    before,
                    checkpoint_id: Some(id),
                }
                | CompactionAudit::Adopted {
                    before,
                    checkpoint_id: Some(id),
                    after: None,
                },
            ) if id == checkpoint_id => *before,
            _ => return,
        };
        if let Some(detail) = adopt_compaction(state, Some(checkpoint_id.into()), before, after) {
            self.push_violations_locked(
                &mut inner,
                req,
                [(ViolationKind::CompactionNotApplied, detail)],
            );
        }
    }

    pub fn record_invalid_previous_response_id(&self, req: &NormalizedRequest, prev_id: &str) {
        if self.config.enabled {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            self.push_violations_locked(
                &mut inner,
                req,
                [(
                    ViolationKind::InvalidPreviousResponseId,
                    format!(
                        "previous_response_id '{prev_id}' not found on this connection or store"
                    ),
                )],
            );
        }
    }

    pub fn session_audit(&self, session_id: &str) -> Option<SessionAuditSnapshot> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .sessions
            .get(session_id)
            .map(|state| SessionAuditSnapshot {
                audit_incomplete: state.audit_incomplete,
                compaction: state.compaction.clone(),
            })
    }

    pub(crate) fn remove_session(&self, session_id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = inner.sessions.remove(session_id) {
            inner.order.retain(|key| key != session_id);
            for call_id in session.call_order {
                remove_owner(&mut inner.call_owners, &call_id);
            }
        }
        inner
            .violations
            .retain(|record| record.session_key != session_id);
    }

    pub fn violations_for_session(&self, session_id: &str) -> Vec<ViolationRecord> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .violations
            .iter()
            .filter(|record| record.session_key == session_id)
            .cloned()
            .collect()
    }

    pub fn snapshot(&self) -> WatchdogSnapshot {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        WatchdogSnapshot {
            total_violations: self.total_violations.load(Ordering::Relaxed),
            by_kind: inner.by_kind.clone(),
            recent: inner.violations.iter().cloned().collect(),
        }
    }

    /// Legacy reset entry point. Use clear_violations for the diagnostics-only operation.
    pub fn clear(&self) {
        self.reset_all();
    }

    pub fn clear_violations(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.violations.clear();
        inner.by_kind.clear();
        self.total_violations.store(0, Ordering::Relaxed);
    }

    pub fn reset_all(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::mem::take(&mut *inner);
        self.total_violations.store(0, Ordering::Relaxed);
        drop(inner);
        drop(previous);
    }

    fn push_violations_locked(
        &self,
        inner: &mut WatchdogInner,
        req: &NormalizedRequest,
        violations: impl IntoIterator<Item = (ViolationKind, String)>,
    ) {
        let mut excerpt = None;
        for (kind, detail) in violations {
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            self.total_violations.fetch_add(1, Ordering::Relaxed);
            *inner.by_kind.entry(kind).or_insert(0) += 1;
            if self.config.max_violations == 0 {
                continue;
            }
            let request_excerpt = excerpt.get_or_insert_with(|| wire_excerpt(req)).clone();
            if inner.violations.len() == self.config.max_violations {
                inner.violations.pop_front();
            }
            let timestamp_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64);
            inner.violations.push_back(ViolationRecord {
                id,
                kind,
                protocol: req.protocol,
                session_key: req.session_key.clone(),
                model: req.model.clone(),
                sequence: req.sequence,
                timestamp_ms,
                prompt_bytes: req.prompt_bytes,
                detail,
                request_excerpt,
            });
        }
    }
}

fn adopt_compaction(
    state: &mut SessionAuditState,
    checkpoint_id: Option<String>,
    before: HistorySize,
    after: Option<HistorySize>,
) -> Option<String> {
    if let Some(after) = after.filter(|size| size.shrank_from(before)) {
        state.compaction = Some(CompactionAudit::Effective {
            before,
            checkpoint_id,
            after,
        });
        return None;
    }
    state.compaction = Some(CompactionAudit::Adopted {
        before,
        checkpoint_id,
        after,
    });
    after.map(|after| {
        format!(
            "compaction did not shrink comparable history (bytes {} -> {}, tokens {} -> {})",
            before.bytes, after.bytes, before.tokens, after.tokens
        )
    })
}

fn wire_excerpt(req: &NormalizedRequest) -> Option<String> {
    const MAX_BYTES: usize = 2048;
    let wire = &req.raw_wire_bytes;
    if wire.is_empty() {
        return None;
    }
    if wire.len() <= MAX_BYTES {
        return Some(String::from_utf8_lossy(wire).into_owned());
    }
    // Truncate at a UTF-8 boundary without inspecting the rest of the request.
    let end = (0..=MAX_BYTES)
        .rev()
        .find(|&i| wire[i] & 0b1100_0000 != 0b1000_0000)
        .unwrap_or(0);
    let mut excerpt = String::from_utf8_lossy(&wire[..end]).into_owned();
    excerpt.push_str("...[truncated]");
    Some(excerpt)
}

fn result_receipts<'a>(req: &'a NormalizedRequest) -> Vec<(usize, &'a str, ResultDigest)> {
    let mut receipts = Vec::new();
    let mut add = |index, id: Option<&'a str>, payload: &Value, is_error: bool| {
        if let Some(id) = id {
            let mut hasher = DefaultHasher::new();
            (payload, is_error).hash(&mut hasher);
            receipts.push((index, id, ResultDigest(hasher.finish())));
        }
    };
    let body = &req.raw_body;
    match req.protocol {
        Protocol::OpenaiChatCompletions => {
            for (index, message) in body["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                if message["role"] == "tool" {
                    add(
                        index,
                        message["tool_call_id"].as_str(),
                        &message["content"],
                        false,
                    );
                }
            }
        }
        Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => {
            for (index, item) in body["input"].as_array().into_iter().flatten().enumerate() {
                if matches!(
                    item["type"].as_str(),
                    Some("function_call_output" | "custom_tool_call_output")
                ) {
                    add(index, item["call_id"].as_str(), &item["output"], false);
                }
            }
        }
        Protocol::AnthropicMessages => {
            for (index, message) in body["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                for block in message["content"].as_array().into_iter().flatten() {
                    if block["type"] == "tool_result" {
                        add(
                            index,
                            block["tool_use_id"].as_str(),
                            &block["content"],
                            block["is_error"].as_bool().unwrap_or(false),
                        );
                    }
                }
            }
        }
    }
    receipts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Transport, normalize_request};
    use serde_json::json;

    fn request(session_id: &str, protocol: Protocol, body: Value) -> NormalizedRequest {
        let transport = if protocol == Protocol::OpenaiResponsesWs {
            Transport::WebSocket {
                connection_id: 1,
                turn_on_connection: 2,
            }
        } else {
            Transport::Http
        };
        normalize_request(
            1,
            protocol,
            transport,
            "/v1/responses".into(),
            [("x-session-id".into(), session_id.into())].into(),
            body.to_string().into(),
            body,
        )
    }

    fn tool_request(session_id: &str, results: &[(&str, &str)]) -> NormalizedRequest {
        let input: Vec<_> = results.iter().map(|(id, output)| {
            json!({"type": "function_call_output", "call_id": id, "output": output})
        }).collect();
        request(
            session_id,
            Protocol::OpenaiResponsesHttp,
            json!({"input": input}),
        )
    }

    fn kinds(watchdog: &ProtocolWatchdog, session_id: &str) -> Vec<ViolationKind> {
        watchdog
            .violations_for_session(session_id)
            .into_iter()
            .map(|record| record.kind)
            .collect()
    }

    #[test]
    fn receipts_require_own_delivered_call_and_identical_history_is_replay() {
        let watchdog = ProtocolWatchdog::new(WatchdogConfig::default());
        let issued = tool_request("owner", &[]);
        watchdog.on_call_issued(&issued, "call");
        watchdog.inspect_request(&tool_request("owner", &[("call", "ok")]));
        assert_eq!(
            kinds(&watchdog, "owner"),
            [ViolationKind::ToolResultBeforeDelivery]
        );

        watchdog.on_call_delivered_complete(&issued, "call");
        watchdog.inspect_request(&tool_request("intruder", &[("call", "ok")]));
        watchdog.inspect_request(&tool_request("intruder", &[("call", "ok")]));
        assert_eq!(
            kinds(&watchdog, "intruder"),
            [ViolationKind::CrossSessionToolResult; 2]
        );

        watchdog.clear_violations();
        watchdog.inspect_request(&tool_request("owner", &[("call", "ok"), ("call", "ok")]));
        watchdog.inspect_request(&tool_request("owner", &[("call", "ok")]));
        assert_eq!(watchdog.total_violations(), 0);

        watchdog.inspect_request(&tool_request(
            "owner",
            &[("call", "edited"), ("unknown", "ok")],
        ));
        assert_eq!(
            kinds(&watchdog, "owner"),
            [
                ViolationKind::DuplicateToolResult,
                ViolationKind::UnknownToolResult,
            ]
        );
        watchdog.reset_all();
        assert!(watchdog.session_audit("owner").is_none());
        watchdog.inspect_request(&tool_request("owner", &[("call", "ok")]));
        assert_eq!(
            kinds(&watchdog, "owner"),
            [ViolationKind::UnknownToolResult]
        );
    }

    #[test]
    fn close_diagnostics_distinguish_injected_faults_from_client_disconnects() {
        let watchdog = ProtocolWatchdog::new(WatchdogConfig::default());
        let req = tool_request("session", &[]);
        watchdog.on_call_issued(&req, "partial");
        watchdog.on_stream_closed(&req, StreamCloseReason::InjectedFault);
        watchdog.on_stream_closed(&req, StreamCloseReason::ServerShutdown);
        watchdog.on_stream_closed(&req, StreamCloseReason::Completed);
        assert_eq!(watchdog.total_violations(), 0);
        watchdog.on_stream_closed(&req, StreamCloseReason::ClientDisconnected);
        assert_eq!(
            kinds(&watchdog, "session"),
            [ViolationKind::AbandonedStream]
        );
    }

    #[test]
    fn overflowing_audit_still_checks_new_calls_and_unknown_receipts() {
        let watchdog = ProtocolWatchdog::new(WatchdogConfig::default());
        let req = tool_request("session", &[]);
        watchdog.on_call_delivered_complete(&req, "call-0");
        watchdog.inspect_request(&tool_request("session", &[("call-0", "original")]));
        for index in 1..=MAX_SESSION_TOOL_CALLS {
            watchdog.on_call_delivered_complete(&req, &format!("call-{index}"));
        }
        assert!(watchdog.session_audit("session").unwrap().audit_incomplete);
        let latest_call = format!("call-{MAX_SESSION_TOOL_CALLS}");
        watchdog.inspect_request_with_verified_history(
            &tool_request("session", &[("call-0", "original"), (&latest_call, "ok")]),
            1,
        );
        assert_eq!(watchdog.total_violations(), 0);
        watchdog.inspect_request(&tool_request(
            "session",
            &[(&latest_call, "edited"), ("never-issued", "ok")],
        ));
        assert_eq!(
            kinds(&watchdog, "session"),
            [
                ViolationKind::DuplicateToolResult,
                ViolationKind::UnknownToolResult,
            ]
        );
    }

    #[test]
    fn compaction_requires_comparable_history_after_adoption() {
        let watchdog = ProtocolWatchdog::new(WatchdogConfig::default());
        let before_req = request(
            "session",
            Protocol::OpenaiResponsesHttp,
            json!({
                "instructions": "fixed".repeat(500),
                "tools": [{"type": "function", "name": "example", "description": "fixed".repeat(200)}],
                "input": [{"role": "user", "content": "history".repeat(30)}]
            }),
        );
        let before = HistorySize::from_request(&before_req);
        assert!(before.bytes < before_req.prompt_bytes / 2);
        watchdog.on_compaction_requested(&before_req, before);
        assert!(matches!(
            watchdog.session_audit("session").unwrap().compaction,
            Some(CompactionAudit::Requested { .. })
        ));
        watchdog.on_compaction_issued(&before_req, "checkpoint", before);

        let delta = request(
            "session",
            Protocol::OpenaiResponsesWs,
            json!({
                "previous_response_id": "parent", "input": "next"
            }),
        );
        watchdog.inspect_request(&delta);
        assert!(matches!(
            watchdog.session_audit("session").unwrap().compaction,
            Some(CompactionAudit::Issued { .. })
        ));
        watchdog.on_compaction_adopted(
            &delta,
            "older-candidate",
            Some(HistorySize {
                bytes: 10,
                tokens: 2,
            }),
        );
        watchdog.on_compaction_adopted(&delta, "checkpoint", None);
        assert!(matches!(
            watchdog.session_audit("session").unwrap().compaction,
            Some(CompactionAudit::Adopted { after: None, .. })
        ));

        let after = HistorySize {
            bytes: 80,
            tokens: 16,
        };
        watchdog.on_compaction_adopted(&delta, "checkpoint", Some(after));
        assert!(
            matches!(watchdog.session_audit("session").unwrap().compaction, Some(CompactionAudit::Effective { after: got, .. }) if got == after)
        );
        assert_eq!(watchdog.total_violations(), 0);

        watchdog.on_compaction_issued(&before_req, "ineffective-checkpoint", before);
        watchdog.on_compaction_adopted(&delta, "ineffective-checkpoint", Some(before));
        assert_eq!(
            kinds(&watchdog, "session"),
            [ViolationKind::CompactionNotApplied]
        );
    }
}
