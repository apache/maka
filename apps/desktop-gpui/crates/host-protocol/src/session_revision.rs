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

//! Copying a Session's conversation into a new Session:
//! `session.branch.create`, which a side chat uses to fork the task it
//! talks about.
//!
//! Sources: `packages/runtime-host/src/protocol/session-revision.ts`
//! (`SESSION_REVISION_OPERATION_SPECS`, `decodeSessionConversationCopyInput`,
//! `decodeSessionConversationCopyResult`), `packages/core/src/side-conversation.ts`
//! (`SIDE_CONVERSATION_SESSION_LABEL`, `isSideConversationSession`).

use serde::{Deserialize, Serialize};

use crate::{Operation, SessionCatalogItem};

/// `SIDE_CONVERSATION_SESSION_LABEL`: the label the Host gives a side
/// conversation's fork, beside the source's own labels.
pub const SIDE_CONVERSATION_SESSION_LABEL: &str = "mode:side_conversation";

/// `isSideConversationSession`: whether `labels` mark a side
/// conversation's fork.
pub fn is_side_conversation(labels: &[String]) -> bool {
    labels.iter().any(|label| label == SIDE_CONVERSATION_SESSION_LABEL)
}

wire_enum! {
    /// `SessionConversationCopyInput.intent`.
    pub enum ConversationCopyIntent {
        SideConversation = "side_conversation",
    }
}

/// `SessionConversationCopyInput` (`decodeSessionConversationCopyInput`):
/// copy the conversation of `source_session_id` through `source_turn_id`
/// into a new Session `target_session_id`. Without a Turn the copy is empty
/// (only with the side-conversation intent). The target's id is the
/// request's identity: sent again, the same input resolves to the Session
/// the first one committed, whatever the source's revision is by then
/// (`conversationCopyFingerprint` leaves the revision out).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionConversationCopyInput {
    pub source_session_id: String,
    pub target_session_id: String,
    /// A settled Turn of the source; absent for an empty copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_turn_id: Option<String>,
    /// The source's catalog `revision`; positive.
    pub expected_source_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<ConversationCopyIntent>,
}

impl SessionConversationCopyInput {
    /// A side conversation of `source_session_id` in a new Session
    /// `target_session_id`: through `source_turn_id`, or empty.
    pub fn side_conversation(
        source_session_id: impl Into<String>,
        target_session_id: impl Into<String>,
        source_turn_id: Option<String>,
        expected_source_revision: u64,
    ) -> Self {
        Self {
            source_session_id: source_session_id.into(),
            target_session_id: target_session_id.into(),
            source_turn_id,
            expected_source_revision,
            intent: Some(ConversationCopyIntent::SideConversation),
        }
    }

    /// The same request at the source's revision `revision`.
    pub fn at_revision(mut self, revision: u64) -> Self {
        self.expected_source_revision = revision;
        self
    }
}

/// `SessionConversationCopyResult` (`decodeSessionConversationCopyResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SessionConversationCopyResult {
    /// The target Session exists, with its catalog item. A side
    /// conversation's carries the source's name, its labels with
    /// [`SIDE_CONVERSATION_SESSION_LABEL`], and `parentSessionId`.
    Committed { session: SessionCatalogItem },
    /// The source moved on since `expected_revision`; nothing was copied.
    #[serde(rename_all = "camelCase")]
    SourceRevisionConflict { expected_revision: u64, actual_revision: u64 },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `session.branch.create` (mode `command`). Errors include `not_found`
/// (no such source), `session_busy` (a linked child of the source runs),
/// `operation_unavailable` (the source's context cannot be copied yet),
/// `operation_conflict` (the target id names another copy) and
/// `commit_outcome_unknown`. A side conversation may fork while the source
/// runs a Turn.
#[derive(Debug)]
pub enum SessionBranchCreate {}

impl Operation for SessionBranchCreate {
    const NAME: &'static str = "session.branch.create";
    type Input = SessionConversationCopyInput;
    type Output = SessionConversationCopyResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_side_conversation_names_its_intent_and_leaves_an_empty_boundary_out() {
        let through =
            SessionConversationCopyInput::side_conversation("s1", "f1", Some("t9".to_owned()), 4);
        assert_eq!(
            serde_json::to_value(&through).expect("encode"),
            json!({"sourceSessionId": "s1", "targetSessionId": "f1", "sourceTurnId": "t9",
                   "expectedSourceRevision": 4, "intent": "side_conversation"})
        );
        let empty =
            SessionConversationCopyInput::side_conversation("s1", "f1", None, 4).at_revision(5);
        assert_eq!(
            serde_json::to_value(&empty).expect("encode"),
            json!({"sourceSessionId": "s1", "targetSessionId": "f1",
                   "expectedSourceRevision": 5, "intent": "side_conversation"})
        );
    }

    #[test]
    fn an_unknown_result_kind_is_kept_apart() {
        let conflict: SessionConversationCopyResult = serde_json::from_value(
            json!({"kind": "source_revision_conflict", "expectedRevision": 4, "actualRevision": 6}),
        )
        .expect("decode");
        assert_eq!(
            conflict,
            SessionConversationCopyResult::SourceRevisionConflict {
                expected_revision: 4,
                actual_revision: 6
            }
        );
        let unknown: SessionConversationCopyResult =
            serde_json::from_value(json!({"kind": "later"})).expect("decode");
        assert_eq!(unknown, SessionConversationCopyResult::Unknown);
    }

    #[test]
    fn the_label_marks_a_fork() {
        assert!(is_side_conversation(&["a".into(), SIDE_CONVERSATION_SESSION_LABEL.into()]));
        assert!(!is_side_conversation(&["mode:other".into()]));
    }
}
