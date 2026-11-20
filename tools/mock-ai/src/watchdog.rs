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

use crate::protocol::{NormalizedRequest, NormalizedRole, Protocol};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
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
    DuplicateToolResult,
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

struct SessionAuditState {
    last_sequence: u64,
    turns_observed: u64,
    /// Tool call IDs emitted by mock-ai in the most recent turn.
    pending_tool_calls: HashSet<String>,
    /// Bounded FIFO ring of tool call IDs emitted in this session.
    known_tool_calls: HashSet<String>,
    known_tool_order: VecDeque<String>,
    known_tool_evicted: bool,
    /// Set when mock-ai just emitted a server-side compaction item/block.
    awaiting_compaction_replay: Option<CompactionExpectation>,
    /// Peak prompt bytes observed before last shrink.
    last_prompt_bytes: usize,
    consecutive_growth_turns: u32,
}

struct CompactionExpectation {
    pre_compaction_bytes: usize,
    pre_compaction_messages: usize,
}

struct WatchdogInner {
    sessions: HashMap<String, SessionAuditState>,
    order: VecDeque<String>,
    violations: VecDeque<ViolationRecord>,
    by_kind: HashMap<ViolationKind, u64>,
}

/// Lightweight inline invariant checker that captures only violating evidence even in `MetricsOnly` mode.
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
            inner: Mutex::new(WatchdogInner {
                sessions: HashMap::new(),
                order: VecDeque::new(),
                violations: VecDeque::new(),
                by_kind: HashMap::new(),
            }),
        }
    }

    pub fn total_violations(&self) -> u64 {
        self.total_violations.load(Ordering::Relaxed)
    }

    pub fn inspect_request(&self, req: &NormalizedRequest) {
        if !self.config.enabled {
            return;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let max_sessions = self.config.max_tracked_sessions.max(1);
        if !inner.sessions.contains_key(&req.session_key) {
            if inner.sessions.len() >= max_sessions
                && let Some(old) = inner.order.pop_front()
            {
                inner.sessions.remove(&old);
            }
            inner.order.push_back(req.session_key.clone());
            inner.sessions.insert(
                req.session_key.clone(),
                SessionAuditState {
                    last_sequence: req.sequence,
                    turns_observed: 0,
                    pending_tool_calls: HashSet::new(),
                    known_tool_calls: HashSet::new(),
                    known_tool_order: VecDeque::new(),
                    known_tool_evicted: false,
                    awaiting_compaction_replay: None,
                    last_prompt_bytes: 0,
                    consecutive_growth_turns: 0,
                },
            );
        }

        let mut pending_violations: Vec<(ViolationKind, String)> = Vec::new();
        let has_replayed_compaction = request_contains_compaction_replay(req);
        let is_incremental_ws = req.previous_response_id.is_some();

        if let Some(state) = inner.sessions.get_mut(&req.session_key) {
            state.last_sequence = req.sequence;
            state.turns_observed = state.turns_observed.saturating_add(1);

            // 1. Check compaction effectiveness on the first non-trigger turn after compaction.
            if self.config.check_compaction_effectiveness
                && !req.has_compaction_trigger
                && let Some(exp) = state.awaiting_compaction_replay.take()
            {
                if !has_replayed_compaction {
                    pending_violations.push((
                            ViolationKind::CompactionNotReplayed,
                            format!(
                                "post-compaction turn did not replay compaction item/block (prev_bytes={}, cur_bytes={})",
                                exp.pre_compaction_bytes, req.prompt_bytes
                            ),
                        ));
                } else if !is_incremental_ws
                    && exp.pre_compaction_messages > 4
                    && req.messages.len() >= exp.pre_compaction_messages
                    && req.prompt_bytes >= exp.pre_compaction_bytes
                {
                    pending_violations.push((
                            ViolationKind::CompactionNotApplied,
                            format!(
                                "history did not shrink after compaction (messages {} -> {}, bytes {} -> {})",
                                exp.pre_compaction_messages,
                                req.messages.len(),
                                exp.pre_compaction_bytes,
                                req.prompt_bytes
                            ),
                        ));
                }
            }

            // 2. Check tool_result accounting.
            if self.config.check_tool_accounting && !req.has_compaction_trigger {
                let mut seen_in_req: HashSet<&str> = HashSet::new();
                for msg in &req.messages {
                    if msg.role == NormalizedRole::Tool
                        && let Some(ref call_id) = msg.tool_call_id
                    {
                        if !seen_in_req.insert(call_id.as_str()) {
                            pending_violations.push((
                                ViolationKind::DuplicateToolResult,
                                format!(
                                    "duplicate tool_result for call_id '{call_id}' in same request"
                                ),
                            ));
                        }
                        if !state.known_tool_evicted && !state.known_tool_calls.contains(call_id) {
                            pending_violations.push((
                                    ViolationKind::UnknownToolResult,
                                    format!("tool_result references unknown call_id '{call_id}' never emitted in this session"),
                                ));
                        }
                    }
                }
                if self.config.check_missing_tool_results && !state.pending_tool_calls.is_empty() {
                    let missing: Vec<&String> = state
                        .pending_tool_calls
                        .iter()
                        .filter(|id| !seen_in_req.contains(id.as_str()))
                        .collect();
                    if !missing.is_empty() {
                        pending_violations.push((
                            ViolationKind::MissingToolResult,
                            format!(
                                "missing tool_result(s) for previously emitted call_ids: {:?}",
                                missing
                            ),
                        ));
                    }
                }
                state.pending_tool_calls.clear();
            }

            // 3. Check unbounded prompt byte growth.
            if req.prompt_bytes > state.last_prompt_bytes {
                state.consecutive_growth_turns = state.consecutive_growth_turns.saturating_add(1);
            } else {
                state.consecutive_growth_turns = 0;
            }
            state.last_prompt_bytes = req.prompt_bytes;

            if let Some(limit) = self.config.max_session_prompt_bytes
                && req.prompt_bytes > limit
            {
                pending_violations.push((
                    ViolationKind::UnboundedPromptGrowth,
                    format!(
                        "prompt_bytes {} exceeded watchdog limit {} (consecutive_growth_turns={})",
                        req.prompt_bytes, limit, state.consecutive_growth_turns
                    ),
                ));
            }
        }

        for (kind, detail) in pending_violations {
            self.push_violation_locked(&mut inner, kind, req, detail);
        }
    }

    pub fn record_turn_outcome(
        &self,
        req: &NormalizedRequest,
        emitted_tool_call_ids: &[String],
        emitted_compaction: bool,
        completed_cleanly: bool,
    ) {
        if !self.config.enabled {
            return;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(state) = inner.sessions.get_mut(&req.session_key) {
            state.pending_tool_calls.clear();
            for id in emitted_tool_call_ids {
                state.pending_tool_calls.insert(id.clone());
                if state.known_tool_calls.insert(id.clone()) {
                    state.known_tool_order.push_back(id.clone());
                    if state.known_tool_order.len() > 4096
                        && let Some(evicted) = state.known_tool_order.pop_front()
                    {
                        state.known_tool_calls.remove(&evicted);
                        state.known_tool_evicted = true;
                    }
                }
            }
            if emitted_compaction {
                state.awaiting_compaction_replay = Some(CompactionExpectation {
                    pre_compaction_bytes: req.prompt_bytes,
                    pre_compaction_messages: req.messages.len(),
                });
            }
        }
        if !completed_cleanly {
            self.push_violation_locked(
                &mut inner,
                ViolationKind::AbandonedStream,
                req,
                "client disconnected before terminal stream event completed".into(),
            );
        }
    }

    pub fn record_invalid_previous_response_id(&self, req: &NormalizedRequest, prev_id: &str) {
        if !self.config.enabled {
            return;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.push_violation_locked(
            &mut inner,
            ViolationKind::InvalidPreviousResponseId,
            req,
            format!("previous_response_id '{prev_id}' not found on this connection or store"),
        );
    }

    pub fn snapshot(&self) -> WatchdogSnapshot {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        WatchdogSnapshot {
            total_violations: self.total_violations.load(Ordering::Relaxed),
            by_kind: inner.by_kind.clone(),
            recent: inner.violations.iter().cloned().collect(),
        }
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.sessions.clear();
        inner.order.clear();
        inner.violations.clear();
        inner.by_kind.clear();
        self.total_violations.store(0, Ordering::Relaxed);
    }

    fn push_violation_locked(
        &self,
        inner: &mut WatchdogInner,
        kind: ViolationKind,
        req: &NormalizedRequest,
        detail: String,
    ) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.total_violations.fetch_add(1, Ordering::Relaxed);
        *inner.by_kind.entry(kind).or_insert(0) += 1;

        let max_keep = self.config.max_violations;
        if max_keep == 0 {
            return;
        }
        while inner.violations.len() >= max_keep {
            inner.violations.pop_front();
        }
        let mut excerpt = req.raw_body.to_string();
        if excerpt.len() > 2048 {
            let cut = excerpt.floor_char_boundary(2048);
            excerpt.truncate(cut);
            excerpt.push_str("...[truncated]");
        }
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
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
            request_excerpt: Some(excerpt),
        });
    }
}

fn request_contains_compaction_replay(req: &NormalizedRequest) -> bool {
    match req.protocol {
        Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => req
            .raw_body
            .get("input")
            .and_then(|v| v.as_array())
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item.get("type").and_then(|v| v.as_str()) == Some("compaction"))
            }),
        Protocol::AnthropicMessages => req
            .raw_body
            .get("messages")
            .and_then(|v| v.as_array())
            .is_some_and(|msgs| {
                msgs.iter().any(|m| {
                    m.get("content")
                        .and_then(|c| c.as_array())
                        .is_some_and(|blocks| {
                            blocks.iter().any(|b| {
                                b.get("type").and_then(|v| v.as_str()) == Some("compaction")
                            })
                        })
                })
            }),
        Protocol::OpenaiChatCompletions => false,
    }
}
