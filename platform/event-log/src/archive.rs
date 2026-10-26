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

mod accepted;
mod candidates;
mod effective;
mod target;
pub(crate) use accepted::archived;

pub(crate) use accepted::validate_append;
pub(crate) use accepted::verify_replay;
pub(crate) use effective::{digest_selected, validate_summary};

use maka_agent_facts::tool_output::DurableToolProjection;

#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("archive source identity mismatch")]
    SourceMismatch,
    #[error("archive body size mismatch")]
    SizeMismatch,
    #[error("corrupt archive evidence")]
    Corrupt,
}

/// Verified, immutable model evidence. Does not expose omitted raw output or image bytes.
pub struct ToolResultResource {
    pub tool_name: String,
    pub serialized_result: String,
}

#[derive(Debug)]
pub struct PruneCandidates {
    pub candidates: Vec<PruneCandidate>,
    pub next: Option<PruneCursor>,
    /// Selected source fence, usable as progress only after all pages are inspected.
    pub through: u64,
}

#[derive(Clone, Debug)]
pub enum PruneCursor {
    /// Begin a scan after inspected immutable results in the same selection.
    After(u64),
    /// Continue a page without admitting results published after its fence.
    Page { through: u64, after_sequence: u64 },
}

#[derive(Clone, Debug)]
pub struct PruneCandidate {
    pub event_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub projection: DurableToolProjection,
}
