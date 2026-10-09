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

//! Archiving and removing Sessions: `session.lifecycle.set`,
//! `session.remove.preview`, `session.remove`.
//!
//! Source: `packages/runtime-host/src/protocol/session-retirement.ts`
//! (`SESSION_RETIREMENT_OPERATION_SPECS`, `decodeSessionLifecycleSetInput`,
//! `decodeSessionRemovePreviewInput`, `decodeSessionRemovePreviewResult`,
//! `decodeSessionRemoveInput`, `decodeSessionRemoveResult`).

use serde::{Deserialize, Serialize};

use crate::{Operation, SessionCatalogItem};

wire_enum! {
    /// `SessionLifecycleState`.
    pub enum SessionLifecycleState {
        Active = "active",
        Archived = "archived",
    }
}

/// `SessionLifecycleSetInput` (`decodeSessionLifecycleSetInput`, exactly
/// these two fields).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionLifecycleSetInput {
    pub session_id: String,
    pub state: SessionLifecycleState,
}

impl SessionLifecycleSetInput {
    /// Archives `session_id` (`archived: true`) or makes it active again.
    pub fn new(session_id: impl Into<String>, archived: bool) -> Self {
        let state =
            if archived { SessionLifecycleState::Archived } else { SessionLifecycleState::Active };
        Self { session_id: session_id.into(), state }
    }
}

/// `session.lifecycle.set` (mode `command`). Answers with the Session's
/// catalog item, whose `isArchived` matches the requested state. Errors
/// include `session_busy` (a Turn runs) and `operation_conflict`.
#[derive(Debug)]
pub enum SessionLifecycleSet {}

impl Operation for SessionLifecycleSet {
    const NAME: &'static str = "session.lifecycle.set";
    type Input = SessionLifecycleSetInput;
    type Output = SessionCatalogItem;
}

/// `SessionRemovePreviewInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionRemovePreviewInput {
    pub session_id: String,
}

impl SessionRemovePreviewInput {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self { session_id: session_id.into() }
    }
}

/// `SessionRemovePreviewResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionRemovePreviewResult {
    /// How many linked subagent subtasks a removal would move to the
    /// archive instead of deleting.
    pub archivable_subtask_count: u64,
}

/// `session.remove.preview` (mode `query`): what `session.remove` would do.
#[derive(Debug)]
pub enum SessionRemovePreview {}

impl Operation for SessionRemovePreview {
    const NAME: &'static str = "session.remove.preview";
    type Input = SessionRemovePreviewInput;
    type Output = SessionRemovePreviewResult;
}

/// `SessionRemoveInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionRemoveInput {
    pub session_id: String,
    /// The catalog projection's `revision` the removal was decided on.
    pub expected_revision: u64,
}

impl SessionRemoveInput {
    pub fn new(session_id: impl Into<String>, expected_revision: u64) -> Self {
        Self { session_id: session_id.into(), expected_revision }
    }
}

/// `SessionRemoveResult` (`decodeSessionRemoveResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SessionRemoveResult {
    #[serde(rename_all = "camelCase")]
    Removed {
        session_id: String,
        /// Subtasks moved to the archive instead of deleted; absent when none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        archived_subtask_count: Option<u64>,
    },
    /// The Session moved on since `expected_revision`; nothing was removed.
    #[serde(rename_all = "camelCase")]
    RevisionConflict { expected_revision: u64, actual_revision: u64 },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `session.remove` (mode `command`): deletes the Session and its
/// transcript. Not undoable.
#[derive(Debug)]
pub enum SessionRemove {}

impl Operation for SessionRemove {
    const NAME: &'static str = "session.remove";
    type Input = SessionRemoveInput;
    type Output = SessionRemoveResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lifecycle_input_names_the_state() {
        assert_eq!(
            serde_json::to_value(SessionLifecycleSetInput::new("s1", true)).expect("encode"),
            json!({"sessionId": "s1", "state": "archived"})
        );
        assert_eq!(
            serde_json::to_value(SessionLifecycleSetInput::new("s1", false)).expect("encode"),
            json!({"sessionId": "s1", "state": "active"})
        );
    }

    #[test]
    fn remove_inputs_and_results_round_trip() {
        assert_eq!(
            serde_json::to_value(SessionRemoveInput::new("s1", 4)).expect("encode"),
            json!({"sessionId": "s1", "expectedRevision": 4})
        );
        assert_eq!(
            serde_json::to_value(SessionRemovePreviewInput::new("s1")).expect("encode"),
            json!({"sessionId": "s1"})
        );
        let preview: SessionRemovePreviewResult =
            serde_json::from_value(json!({"archivableSubtaskCount": 2})).expect("decode");
        assert_eq!(preview.archivable_subtask_count, 2);
        for value in [
            json!({"kind": "removed", "sessionId": "s1"}),
            json!({"kind": "removed", "sessionId": "s1", "archivedSubtaskCount": 1}),
            json!({"kind": "revision_conflict", "expectedRevision": 4, "actualRevision": 5}),
        ] {
            let result: SessionRemoveResult =
                serde_json::from_value(value.clone()).expect("decode");
            assert_eq!(serde_json::to_value(result).expect("encode"), value);
        }
    }
}
