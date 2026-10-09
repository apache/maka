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

//! `session.catalog.query` and the Session catalog projection.
//!
//! Source: `packages/runtime-host/src/protocol/session-catalog.ts`
//! (`decodeSessionCatalogQueryInput`, `decodeSessionCatalogQueryResult`,
//! `decodeSessionCatalogItem`, `decodeSessionCatalogProjection`).

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{
    CollaborationMode, Operation, OrchestrationMode, PermissionMode, PersistedBackendKind,
    SessionBlockedReason, SessionStatus, ThinkingLevel, WorkspaceProjection,
};

/// `SessionCatalogQueryInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub enum SessionCatalogQueryInput {
    /// First page, newest activity first.
    ListStart,
    /// The next page of the listing identified by `revision`.
    ListContinue {
        /// `sha256:<64 hex>` from the previous page.
        revision: String,
        /// `nextCursor` from the previous page (at most 512 UTF-8 bytes).
        cursor: String,
    },
    /// One Session by id.
    #[serde(rename_all = "camelCase")]
    Get { session_id: String },
}

/// `SessionCatalogQueryResult`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SessionCatalogQueryResult {
    /// At most 32 items (`SESSION_CATALOG_PAGE_MAX_ITEMS`).
    #[serde(rename_all = "camelCase")]
    Page {
        revision: String,
        sessions: Vec<SessionCatalogItem>,
        /// `null` on the last page.
        next_cursor: Option<String>,
    },
    /// The catalog changed between pages; restart with `list_start`.
    #[serde(rename_all = "camelCase")]
    RevisionChanged { expected_revision: String, actual_revision: String },
    /// Answer to `get`; `null` when the Session does not exist.
    Session { session: Option<SessionCatalogItem> },
    /// A result kind this client does not recognize. The payload is dropped;
    /// a recognized kind with a malformed body is still a decode error.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `SessionCatalogItem`: a projection, or a legacy record the Host cannot
/// represent on the wire.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SessionCatalogItem {
    Session(Box<SessionCatalogProjection>),
    UnsupportedLegacy(UnsupportedLegacySessionCatalogRecord),
}

impl SessionCatalogItem {
    /// The Session id either variant carries.
    pub fn id(&self) -> &str {
        match self {
            Self::Session(session) => &session.id,
            Self::UnsupportedLegacy(record) => &record.id,
        }
    }
}

impl<'de> Deserialize<'de> for SessionCatalogItem {
    /// Mirrors `decodeSessionCatalogItem`: only an explicit
    /// `kind: "unsupported_legacy_record"` selects the legacy shape.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let is_legacy =
            value.get("kind").and_then(Value::as_str) == Some(UnsupportedLegacyKind::WIRE);
        if is_legacy {
            serde_json::from_value(value).map(Self::UnsupportedLegacy).map_err(D::Error::custom)
        } else {
            serde_json::from_value(value)
                .map(|session| Self::Session(Box::new(session)))
                .map_err(D::Error::custom)
        }
    }
}

wire_tag! {
    /// `UnsupportedLegacySessionCatalogRecord.kind`.
    UnsupportedLegacyKind = "unsupported_legacy_record"
}

/// `UnsupportedLegacySessionCatalogRecord`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UnsupportedLegacySessionCatalogRecord {
    kind: UnsupportedLegacyKind,
    pub id: String,
    pub revision: u64,
    /// Currently always `not_wire_representable`.
    pub reason: String,
}

wire_enum! {
    /// `SessionCatalogProjection.revisionState`.
    pub enum SessionRevisionState {
        Preparing = "preparing",
        Committed = "committed",
    }
}

/// `SessionCatalogProjection` (`PROJECTION_FIELDS`). Timestamps are
/// non-negative integers (`requireCount`); the TS code treats them as epoch
/// milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionCatalogProjection {
    pub id: String,
    /// Positive; increments on every committed change to this Session.
    pub revision: u64,
    pub workspace: WorkspaceProjection,
    pub created_at: u64,
    pub activity_at: u64,
    pub name: String,
    pub is_flagged: bool,
    pub is_archived: bool,
    pub labels: Vec<String>,
    pub labels_truncated: bool,
    pub has_unread: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_read_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
    pub status: SessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_run_state: Option<SessionCatalogLiveRunState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<SessionBlockedReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_updated_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_of_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<SessionSubagentProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_root_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_of_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_index: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_state: Option<SessionRevisionState>,
    pub backend: PersistedBackendKind,
    /// Present exactly when `backend` is `plugin-executor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
    /// `ExecutorConfiguration` (`packages/core/src/executor-catalog.ts`),
    /// only with `executor_id`: the executor's confirmed model and options.
    /// Kept as sent; no feature reads it yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_config: Option<Value>,
    /// Required on the wire, `null` for Sessions without a model connection.
    pub llm_connection_id: Option<String>,
    pub llm_connection_slug: String,
    pub connection_locked: bool,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    pub permission_mode: PermissionMode,
    pub collaboration_mode: CollaborationMode,
    pub orchestration_mode: OrchestrationMode,
}

/// `SessionCatalogLiveRunState` (`optionalLiveRunState`).
///
/// `revision` does not move when a Turn starts or ends, so two reads of the
/// same revision can disagree about `running_turn_ids`; `run_epoch` orders
/// them within one Host process and `host_generation` tells processes apart
/// (apache/maka#5713). This client needs neither: it replaces the whole
/// catalog on each load and drops superseded loads by generation, so the
/// later read always wins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionCatalogLiveRunState {
    /// `SESSION_CATALOG_LIVE_RUN_STATE_SCHEMA_VERSION`, currently 1.
    pub schema_version: u32,
    pub running_turn_ids: Vec<String>,
    /// Bumped by the runtime on every Turn start and end; restarts at zero
    /// with a new Host process. Absent from Hosts that do not track it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_epoch: Option<u64>,
    /// The Host process generation that produced this state, at most 128
    /// characters (`SESSION_CATALOG_HOST_GENERATION_MAX_CHARS`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_generation: Option<String>,
}

/// `SessionSubagentProjection` (`packages/core/src/session.ts`,
/// decoded by `optionalSubagent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionSubagentProjection {
    pub parent_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

/// The `session.catalog.query` operation (availability `ready`: a Host
/// still starting answers `host_not_ready`).
#[derive(Debug)]
pub enum SessionCatalogQuery {}

impl Operation for SessionCatalogQuery {
    const NAME: &'static str = "session.catalog.query";
    type Input = SessionCatalogQueryInput;
    type Output = SessionCatalogQueryResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WorkspaceTarget;
    use serde_json::json;

    fn projection_json() -> Value {
        json!({
            "id": "s1",
            "revision": 3,
            "workspace": {"target": {"kind": "host_path", "path": "/w"}, "hostCwd": "/w"},
            "createdAt": 1700000000000u64,
            "activityAt": 1700000000500u64,
            "name": "New chat",
            "isFlagged": false,
            "isArchived": false,
            "labels": ["a"],
            "labelsTruncated": false,
            "hasUnread": true,
            "status": "waiting_for_user",
            "liveRunState": {"schemaVersion": 1, "runningTurnIds": ["t1"]},
            "subagent": {"parentSessionId": "s0", "agentName": "helper"},
            "backend": "ai-sdk",
            "llmConnectionId": null,
            "llmConnectionSlug": "env-deepseek",
            "connectionLocked": false,
            "model": "deepseek-v4-flash",
            "thinkingLevel": "high",
            "permissionMode": "ask",
            "collaborationMode": "agent",
            "orchestrationMode": "default"
        })
    }

    #[test]
    fn inputs_encode_by_kind() {
        assert_eq!(
            serde_json::to_value(SessionCatalogQueryInput::ListStart).expect("encode"),
            json!({"kind": "list_start"})
        );
        assert_eq!(
            serde_json::to_value(SessionCatalogQueryInput::ListContinue {
                revision: "sha256:00".into(),
                cursor: "c".into()
            })
            .expect("encode"),
            json!({"kind": "list_continue", "revision": "sha256:00", "cursor": "c"})
        );
        assert_eq!(
            serde_json::to_value(SessionCatalogQueryInput::Get { session_id: "s1".into() })
                .expect("encode"),
            json!({"kind": "get", "sessionId": "s1"})
        );
    }

    #[test]
    fn page_with_projection_and_legacy_record_decodes() {
        let result: SessionCatalogQueryResult = serde_json::from_value(json!({
            "kind": "page",
            "revision": "sha256:ab",
            "sessions": [
                projection_json(),
                {"kind": "unsupported_legacy_record", "id": "old", "revision": 1,
                 "reason": "not_wire_representable"}
            ],
            "nextCursor": "next"
        }))
        .expect("decode");
        let SessionCatalogQueryResult::Page { sessions, next_cursor, .. } = result else {
            panic!("expected page");
        };
        assert_eq!(next_cursor.as_deref(), Some("next"));
        let SessionCatalogItem::Session(session) = &sessions[0] else {
            panic!("expected projection");
        };
        assert_eq!(session.status, SessionStatus::WaitingForUser);
        assert_eq!(session.llm_connection_id, None);
        assert_eq!(session.thinking_level, Some(ThinkingLevel::High));
        assert_eq!(session.workspace.target, WorkspaceTarget::HostPath { path: "/w".into() });
        assert_eq!(
            session.live_run_state.as_ref().map(|state| state.running_turn_ids.as_slice()),
            Some(["t1".to_owned()].as_slice())
        );
        assert!(matches!(
            &sessions[1],
            SessionCatalogItem::UnsupportedLegacy(record) if record.id == "old"
        ));
        assert_eq!(sessions[1].id(), "old");
    }

    #[test]
    fn projection_round_trips_with_explicit_null_connection() {
        let item: SessionCatalogItem = serde_json::from_value(projection_json()).expect("decode");
        let encoded = serde_json::to_value(&item).expect("encode");
        assert_eq!(encoded, projection_json());
    }

    #[test]
    fn legacy_record_round_trips_with_its_kind() {
        let value = json!({"kind": "unsupported_legacy_record", "id": "old", "revision": 2,
                           "reason": "not_wire_representable"});
        let item: SessionCatalogItem = serde_json::from_value(value.clone()).expect("decode");
        assert_eq!(serde_json::to_value(&item).expect("encode"), value);
    }

    #[test]
    fn unknown_result_kind_is_tolerated_but_malformed_known_kind_is_not() {
        let unknown: SessionCatalogQueryResult =
            serde_json::from_value(json!({"kind": "future", "x": 1})).expect("decode");
        assert_eq!(unknown, SessionCatalogQueryResult::Unknown);
        let malformed = serde_json::from_value::<SessionCatalogQueryResult>(
            json!({"kind": "page", "revision": "sha256:ab", "sessions": "nope", "nextCursor": null}),
        );
        assert!(malformed.is_err());
    }

    #[test]
    fn revision_changed_and_session_results_decode() {
        let changed: SessionCatalogQueryResult = serde_json::from_value(json!({
            "kind": "revision_changed", "expectedRevision": "sha256:a", "actualRevision": "sha256:b"
        }))
        .expect("decode");
        assert!(matches!(changed, SessionCatalogQueryResult::RevisionChanged { .. }));
        let missing: SessionCatalogQueryResult =
            serde_json::from_value(json!({"kind": "session", "session": null})).expect("decode");
        assert_eq!(missing, SessionCatalogQueryResult::Session { session: None });
    }
}
