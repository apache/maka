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

mod boundary;
pub(crate) mod evidence;
pub(crate) mod frozen;
pub(crate) mod history;
pub use history::{FrozenSessionHistory, HistoryCapture, HistoryCut};
mod latest_main;
mod lineage;
mod proof;
pub(crate) mod read;
mod report;
mod request;
pub use report::{ContextReport, ContextRequest, ContextRequestState};
pub mod prepared;
pub(crate) mod safety;
pub(crate) mod selection;
pub mod semantic;
mod tail;
mod usage;
pub use usage::ContextUsage;
mod validate;

use crate::StoreError;
use maka_agent_facts::context::ContextCheckpoint;
use maka_agent_facts::context::ModelRequestContext;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::model::ModelUsage;
pub(crate) use validate::require_terminal as validate_checkpoint_terminal;
pub(crate) use validate::{validate_append, validate_batch};

#[derive(Clone, Debug)]
pub struct SourceEvidence {
    pub scope: LogScope,
    pub high_water: u64,
    pub digest: String,
}

#[derive(Debug)]
pub struct ContextBaseline {
    pub event_id: String,
    pub checkpoint: ContextCheckpoint,
}

/// Immutable selection metadata for paged model-history rendering. The view
/// carries no complete canonical tail or rendered prompt.
#[derive(Debug)]
pub struct ContextView {
    pub source_evidence: SourceEvidence,
    pub baseline: Option<ContextBaseline>,
    pub anchor: Option<StoredEvent>,
    pub effective_source_digest: String,
    pub latest_main: LatestMainContext,
    pub selection: semantic::SemanticSelection,
    pub has_new_history: bool,
    pub prior_unknown: bool,
    pub unknown_tools: Vec<(String, String)>,
    pub unknown_tool_count: u64,
}

/// Complete source evidence and its distinct, bounded model rendering input.
#[derive(Debug)]
pub struct ModelContextSource {
    pub source_evidence: SourceEvidence,
    pub baseline: Option<ContextBaseline>,
    pub anchor: Option<StoredEvent>,
    pub tail: Vec<ContextEvent>,
    pub effective_source_digest: String,
    pub latest_main: LatestMainContext,
}

#[derive(Clone, Debug)]
pub enum LatestMainContext {
    NoCompletedRequest,
    TraceUnavailable,
    Selected(Box<AcceptedMainContext>),
}

#[derive(Clone, Debug)]
pub struct AcceptedMainContext {
    pub projection_current: bool,
    pub sequence: u64,
    /// The model stream's finish observation, before any remaining tool settlement.
    pub finished_at: Option<std::time::SystemTime>,
    pub requested_at: Option<std::time::SystemTime>,
    pub model_id: String,
    pub route_identity: String,
    pub connection_id: Option<String>,
    pub checkpoint_event_id: Option<String>,
    pub context: Option<ModelRequestContext>,
    pub usage: ModelUsage,
}

#[derive(Debug)]
pub enum ContextEvent {
    Canonical(Box<StoredEvent>),
    Archived(Box<ArchivedToolResult>),
    ModelItems(Box<AcceptedModelStep>),
}

/// A bounded read projection of real item acceptance facts, never a new log
/// authority. Source digests still cover the original canonical observations.
#[derive(Debug, serde::Serialize)]
pub struct AcceptedModelStep {
    pub sequence: u64,
    pub event_id: String,
    pub invocation: maka_agent_facts::event::Invocation,
    pub step_id: String,
    pub items: Vec<AcceptedModelItem>,
}
#[derive(Debug, serde::Serialize)]
pub struct AcceptedModelItem {
    pub sequence: u64,
    pub event_id: String,
    pub index: usize,
    pub part: maka_agent_facts::model::ModelPart,
}

#[derive(Debug)]
pub struct ArchivedToolResult {
    pub sequence: u64,
    pub event_id: String,
    pub invocation: maka_agent_facts::event::Invocation,
    pub operation_id: String,
    /// Canonical archive evidence; current model guidance is projected after verification.
    pub replacement: maka_agent_facts::tool_output::DurableToolProjection,
    pub is_error: bool,
}

fn invalid(reason: &str) -> StoreError {
    StoreError::InvalidTransition(format!("invalid context checkpoint: {reason}"))
}

#[cfg(test)]
mod admission_tests;
