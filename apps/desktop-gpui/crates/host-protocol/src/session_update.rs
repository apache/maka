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

//! Session commands: `session.create`, `session.metadata.update`,
//! `session.configuration.update`.
//!
//! Source: `packages/runtime-host/src/protocol/session-catalog.ts`
//! (`SESSION_CATALOG_OPERATION_SPECS`, `decodeSessionCreateInput`,
//! `decodeSessionMetadataUpdateInput`, `decodeSessionConfigurationUpdateInput`,
//! `decodeSessionUpdateResult`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::serde_util::Nullable;
use crate::{
    CollaborationMode, Operation, OrchestrationMode, PermissionMode, SessionCatalogItem,
    ThinkingLevel, WorkspaceTarget,
};

/// `SessionModelTarget`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SessionModelTarget {
    /// The catalog's default connection and model.
    Default,
    /// A specific connection and model (from `connection.catalog.query`).
    #[serde(rename_all = "camelCase")]
    Explicit { connection_id: String, connection_slug: String, model: String },
}

/// `SessionCreateInput` (`decodeSessionCreateInput`). Exactly one of
/// `model_target` and `executor_id` must be set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionCreateInput {
    /// Client-chosen entity id (`^[A-Za-z0-9_-]{1,128}$`).
    pub session_id: String,
    pub workspace: WorkspaceTarget,
    /// `SessionStartMode` (`packages/core/src/session-start-mode.ts`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_target: Option<SessionModelTarget>,
    /// A plugin executor instead of a model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
    /// Only with `executor_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_model: Option<String>,
    /// `ExecutorConfiguration` (`packages/core/src/executor-catalog.ts`),
    /// only with `executor_id`; its `model` must agree with `executor_model`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_config: Option<Value>,
    /// Absent applies the model preference; `null` uses the provider default.
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub thinking_level: Nullable<ThinkingLevel>,
    /// `SESSION_TOOL_PROFILES`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_mode: Option<CollaborationMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration_mode: Option<OrchestrationMode>,
}

impl SessionCreateInput {
    /// A Session in `workspace` on `model_target`, everything else defaulted.
    pub fn new(
        session_id: impl Into<String>,
        workspace: WorkspaceTarget,
        model_target: SessionModelTarget,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            workspace,
            mode: None,
            name: None,
            labels: None,
            model_target: Some(model_target),
            executor_id: None,
            executor_model: None,
            executor_config: None,
            thinking_level: Nullable::Absent,
            tool_profile: None,
            permission_mode: None,
            collaboration_mode: None,
            orchestration_mode: None,
        }
    }
}

/// `session.create` (mode `command`). Answers with the new catalog item.
#[derive(Debug)]
pub enum SessionCreate {}

impl Operation for SessionCreate {
    const NAME: &'static str = "session.create";
    type Input = SessionCreateInput;
    type Output = SessionCatalogItem;
}

/// `SessionMetadataPatch`: at least one field.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionMetadataPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_flagged: Option<bool>,
}

impl SessionMetadataPatch {
    /// Renames the Session.
    pub fn name(name: impl Into<String>) -> Self {
        Self { name: Some(name.into()), ..Self::default() }
    }

    /// Flags or unflags the Session.
    pub fn flagged(flagged: bool) -> Self {
        Self { is_flagged: Some(flagged), ..Self::default() }
    }
}

/// `SessionMetadataUpdateInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionMetadataUpdateInput {
    pub session_id: String,
    /// The catalog projection's `revision` the patch was made against.
    pub expected_revision: u64,
    pub patch: SessionMetadataPatch,
}

impl SessionMetadataUpdateInput {
    /// Applies `patch` to `session_id` at `expected_revision`.
    pub fn new(
        session_id: impl Into<String>,
        expected_revision: u64,
        patch: SessionMetadataPatch,
    ) -> Self {
        Self { session_id: session_id.into(), expected_revision, patch }
    }
}

/// `SessionExecutorTarget`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionExecutorTarget {
    pub executor_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// `SessionConfigurationPatch`: at least one field; not both targets.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionConfigurationPatch {
    /// A plugin executor's `ExecutorConfiguration`; not with either target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_config: Option<Value>,
    /// Must be [`SessionModelTarget::Explicit`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_target: Option<SessionModelTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_target: Option<SessionExecutorTarget>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub thinking_level: Nullable<ThinkingLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_mode: Option<CollaborationMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration_mode: Option<OrchestrationMode>,
}

impl SessionConfigurationPatch {
    /// Moves the session to `model` on the connection `connection_id`
    /// (`connection_slug` names the same connection).
    pub fn model(
        connection_id: impl Into<String>,
        connection_slug: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            model_target: Some(SessionModelTarget::Explicit {
                connection_id: connection_id.into(),
                connection_slug: connection_slug.into(),
                model: model.into(),
            }),
            ..Self::default()
        }
    }

    /// Changes only the permission mode.
    pub fn permission_mode(mode: PermissionMode) -> Self {
        Self { permission_mode: Some(mode), ..Self::default() }
    }
}

/// `SessionConfigurationUpdateInput` (`decodeSessionConfigurationUpdateInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionConfigurationUpdateInput {
    pub session_id: String,
    /// The catalog projection's `revision` the patch was made against
    /// (positive). The Host answers `revision_conflict` naming this value
    /// when the session has moved on (`assertUpdateOutputIdentity`); the
    /// Desktop and the CLI re-read the session and send the patch again.
    pub expected_revision: u64,
    pub patch: SessionConfigurationPatch,
}

impl SessionConfigurationUpdateInput {
    /// Applies `patch` to `session_id` at `expected_revision`.
    pub fn new(
        session_id: impl Into<String>,
        expected_revision: u64,
        patch: SessionConfigurationPatch,
    ) -> Self {
        Self { session_id: session_id.into(), expected_revision, patch }
    }
}

/// `SessionUpdateResult` (`decodeSessionUpdateResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SessionUpdateResult {
    Committed {
        session: SessionCatalogItem,
    },
    /// The Session moved on; reread it and retry.
    #[serde(rename_all = "camelCase")]
    RevisionConflict {
        expected_revision: u64,
        actual_revision: u64,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `session.metadata.update` (mode `command`).
#[derive(Debug)]
pub enum SessionMetadataUpdate {}

impl Operation for SessionMetadataUpdate {
    const NAME: &'static str = "session.metadata.update";
    type Input = SessionMetadataUpdateInput;
    type Output = SessionUpdateResult;
}

/// `session.configuration.update` (mode `command`). Errors include
/// `session_busy` (a linked Turn is active, or the session waits for an
/// answer; widening the permission mode alone is allowed mid-Turn) and
/// `operation_conflict` (an archived session), per
/// `CONFIGURATION_UPDATE_ERRORS` and `SessionManager.transitionSessionConfiguration`
/// (packages/runtime/src/session-manager.ts).
#[derive(Debug)]
pub enum SessionConfigurationUpdate {}

impl Operation for SessionConfigurationUpdate {
    const NAME: &'static str = "session.configuration.update";
    type Input = SessionConfigurationUpdateInput;
    type Output = SessionUpdateResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn create_input_matches_the_capture_request() {
        let mut input = SessionCreateInput::new(
            "s1",
            WorkspaceTarget::HostPath { path: "/w".into() },
            SessionModelTarget::Default,
        );
        input.name = Some("Chat".into());
        input.permission_mode = Some(PermissionMode::Ask);
        assert_eq!(
            serde_json::to_value(&input).expect("encode"),
            json!({
                "sessionId": "s1",
                "workspace": {"kind": "host_path", "path": "/w"},
                "name": "Chat",
                "modelTarget": {"kind": "default"},
                "permissionMode": "ask"
            })
        );
        input.thinking_level = Nullable::Null;
        assert_eq!(serde_json::to_value(&input).expect("encode")["thinkingLevel"], json!(null));
    }

    #[test]
    fn configuration_patch_encodes_explicit_target() {
        let patch = SessionConfigurationPatch {
            model_target: Some(SessionModelTarget::Explicit {
                connection_id: "c".into(),
                connection_slug: "env-deepseek".into(),
                model: "deepseek-chat".into(),
            }),
            ..SessionConfigurationPatch::default()
        };
        let input = SessionConfigurationUpdateInput::new("s1", 3, patch);
        assert_eq!(
            serde_json::to_value(input).expect("encode"),
            json!({"sessionId": "s1", "expectedRevision": 3, "patch": {"modelTarget": {
                "kind": "explicit", "connectionId": "c", "connectionSlug": "env-deepseek",
                "model": "deepseek-chat"
            }}})
        );
    }

    #[test]
    fn patch_constructors_set_one_field() {
        assert_eq!(
            serde_json::to_value(SessionConfigurationPatch::model("c", "slug", "m"))
                .expect("encode"),
            json!({"modelTarget": {"kind": "explicit", "connectionId": "c",
                                   "connectionSlug": "slug", "model": "m"}})
        );
        assert_eq!(
            serde_json::to_value(SessionConfigurationPatch::permission_mode(
                PermissionMode::Bypass
            ))
            .expect("encode"),
            json!({"permissionMode": "bypass"})
        );
    }

    #[test]
    fn metadata_patches_set_one_field() {
        let input = SessionMetadataUpdateInput::new("s1", 2, SessionMetadataPatch::name("Plan"));
        assert_eq!(
            serde_json::to_value(input).expect("encode"),
            json!({"sessionId": "s1", "expectedRevision": 2, "patch": {"name": "Plan"}})
        );
        assert_eq!(
            serde_json::to_value(SessionMetadataPatch::flagged(true)).expect("encode"),
            json!({"isFlagged": true})
        );
    }

    #[test]
    fn update_results_decode() {
        let conflict: SessionUpdateResult = serde_json::from_value(
            json!({"kind": "revision_conflict", "expectedRevision": 1, "actualRevision": 2}),
        )
        .expect("decode");
        assert!(matches!(
            conflict,
            SessionUpdateResult::RevisionConflict { actual_revision: 2, .. }
        ));
    }
}
