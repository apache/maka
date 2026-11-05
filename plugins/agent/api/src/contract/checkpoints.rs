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

//! Explicit history/Workspace checkpoints, private inspections and bounded local recovery.
use maka_plugin_core::operation::{OperationObservation, RecoveryRef};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentCheckpointWorkspaceConsistency")]
pub enum CheckpointWorkspaceConsistency {
    /// The caller confirms all other writers remain paused for the entire copy.
    CallerConfirmedQuiescent,
    /// Files may not represent one instant; successful digest checks do not change this.
    Unverified,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointWorkspaceNotice")]
pub struct CheckpointWorkspaceNotice {
    pub consistency: CheckpointWorkspaceConsistency,
    pub warning: CheckpointWorkspaceWarning,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentCheckpointWorkspaceWarning")]
pub enum CheckpointWorkspaceWarning {
    /// Display to users: pause editors, terminals and other writers for the entire
    /// capture. Hash verification is not a point-in-time consistency guarantee.
    ExternalWritersNotFenced,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointPublish")]
pub struct CheckpointPublish {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<Uuid>")]
    pub expected_revision: Option<Uuid>,
    /// Membership confirmation returned by previewHistoryCheckpoint, not a live revision.
    #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
    pub confirmed_subtree_digest: String,
    /// Null captures history only. Otherwise the caller explicitly selects the
    /// Workspace consistency guarantee; other applications are never fenced.
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<CheckpointWorkspaceConsistency>"
    )]
    pub workspace_consistency: Option<CheckpointWorkspaceConsistency>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryCheckpointObject")]
pub struct HistoryCheckpointObject {
    #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
    pub digest: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryCheckpointHead")]
pub struct HistoryCheckpointHead {
    pub revision: Uuid,
    pub manifest: HistoryCheckpointObject,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryCheckpointInventory")]
pub struct HistoryCheckpointInventory {
    pub root_session_id: String,
    pub subtree_digest: String,
    pub sessions: Vec<HistoryCheckpointSession>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryCheckpointSession")]
pub struct HistoryCheckpointSession {
    pub id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub revision: u64,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointPublication")]
pub struct CheckpointPublication {
    pub state: HistoryCheckpointState,
    /// Cleanup failure does not undo a successful publication.
    pub cleanup_pending: bool,
    pub workspace: Option<CheckpointWorkspaceNotice>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryCheckpointState")]
pub enum HistoryCheckpointState {
    Capturing,
    Prepared,
    Published { head: HistoryCheckpointHead },
    Conflict { actual: Option<Uuid> },
    Interrupted,
    Unavailable,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointReceiptRead")]
pub struct CheckpointReceiptRead {
    pub reference: RecoveryRef,
    /// The exact original input. Changed input cannot select another publication.
    pub input: CheckpointPublish,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointReceipt")]
pub struct CheckpointReceipt {
    /// Original Host observation. Domain success never fabricates Host cleanup confirmation.
    pub operation: Option<OperationObservation>,
    /// Authoritative domain result even when the Host response was lost.
    /// Absence is not permission to recapture under a replacement operation.
    pub publication: Option<CheckpointPublication>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryCheckpointRead")]
pub struct HistoryCheckpointRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    /// Only the exact currently retained revision is readable; no latest fallback.
    pub revision: Uuid,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentHistoryCheckpointFrame")]
pub enum HistoryCheckpointFrame {
    /// MAKA-SESSION v2 history bytes follow; Workspace objects are separate.
    Checkpoint {
        head: HistoryCheckpointHead,
        inventory: HistoryCheckpointInventory,
        bundle: HistoryCheckpointObject,
        workspace: Option<CheckpointWorkspaceSnapshot>,
    },
    Chunk {
        #[schemars(range(max = 9_007_199_254_740_991u64))]
        offset: u64,
        #[schemars(length(min = 1, max = 43692))]
        data: String,
    },
    End {
        digest: String,
        #[schemars(range(max = 9_007_199_254_740_991u64))]
        bytes: u64,
    },
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointInspection")]
pub struct CheckpointInspection {
    #[schemars(length(min = 1))]
    pub source_session_id: String,
    pub operation_id: Uuid,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointLoad")]
pub struct CheckpointLoad {
    pub head: HistoryCheckpointHead,
    pub inspection: CheckpointInspection,
    pub state: CheckpointLoadState,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentCheckpointLoadState")]
pub enum CheckpointLoadState {
    Preparing,
    Ready {
        session_ids: Vec<String>,
        workspace: Option<CheckpointWorkspaceSnapshot>,
    },
    Unavailable,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointWorkspaceSnapshot")]
pub struct CheckpointWorkspaceSnapshot {
    pub identity: String,
    pub consistency: CheckpointWorkspaceConsistency,
    pub warning: CheckpointWorkspaceWarning,
    pub inventory: HistoryCheckpointObject,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointLoadReceiptRead")]
pub struct CheckpointLoadReceiptRead {
    pub reference: RecoveryRef,
    pub input: HistoryCheckpointRead,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointLoadReceipt")]
pub struct CheckpointLoadReceipt {
    pub operation: Option<OperationObservation>,
    pub load: Option<CheckpointLoad>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointHistoryRead")]
pub struct CheckpointHistoryRead {
    pub inspection: CheckpointInspection,
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub position: super::HistoryPosition,
    #[serde(default)]
    pub include_thinking: bool,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointArtifactsRead")]
pub struct CheckpointArtifactsRead {
    pub inspection: CheckpointInspection,
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub offset: u64,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointArtifactRead")]
pub struct CheckpointArtifactRead {
    pub inspection: CheckpointInspection,
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub artifact_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub offset: u64,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointArtifact")]
pub struct CheckpointArtifact {
    pub id: String,
    pub name: String,
    pub mime_type: Option<String>,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub bytes: u64,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointArtifacts")]
pub struct CheckpointArtifacts {
    pub artifacts: Vec<CheckpointArtifact>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub next_offset: Option<u64>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCheckpointArtifactChunk")]
pub struct CheckpointArtifactChunk {
    pub artifact: CheckpointArtifact,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub offset: u64,
    /// Base64, at most 32 KiB decoded. Empty only at the end.
    #[schemars(length(max = 43692))]
    pub data: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_plugin_core::contract::{Interface, MethodMode};
    use serde_json::json;

    #[test]
    fn checkpoint_inputs_preserve_explicit_cas_and_reject_caller_authority_or_paths() {
        let Interface::Service { methods } = crate::contract().interface else {
            unreachable!()
        };
        assert_eq!(methods["publishCheckpoint"].mode, MethodMode::Mutation);
        assert_eq!(
            methods["readHistoryCheckpoint"].mode,
            MethodMode::Subscription
        );
        let publish = jsonschema::validator_for(&methods["publishCheckpoint"].input).unwrap();
        let valid = json!({"sessionId":"source","expectedRevision":null,"confirmedSubtreeDigest":"a".repeat(64),"workspaceConsistency":null});
        assert!(publish.is_valid(&valid));
        for key in [
            "expectedRevision",
            "confirmedSubtreeDigest",
            "workspaceConsistency",
        ] {
            let mut absent = valid.clone();
            absent.as_object_mut().unwrap().remove(key);
            assert!(!publish.is_valid(&absent));
        }
        for (key, value) in [
            ("scope", json!({})),
            ("path", json!("/tmp/output")),
            ("operation", json!(Uuid::new_v4())),
            ("expectedRevision", json!(23)),
            ("confirmedSubtreeDigest", json!("member-count")),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            assert!(!publish.is_valid(&invalid), "{key}");
        }
        let read = jsonschema::validator_for(&methods["readHistoryCheckpoint"].input).unwrap();
        assert!(!read.is_valid(&json!({"sessionId":"source"})));
        assert!(!read.is_valid(&json!({"sessionId":"source","revision":23})));
        assert!(read.is_valid(&json!({"sessionId":"source","revision":Uuid::new_v4()})));
    }
    #[test]
    fn checkpoint_load_requires_exact_revision_and_never_accepts_execution_authority() {
        let Interface::Service { methods } = crate::contract().interface else {
            unreachable!()
        };
        assert_eq!(methods["loadHistoryCheckpoint"].mode, MethodMode::Mutation);
        for method in [
            "historyCheckpointLoadReceipt",
            "loadedHistoryCheckpointHistory",
            "loadedHistoryCheckpointArtifacts",
        ] {
            assert_eq!(methods[method].mode, MethodMode::Query);
        }
        let validator = jsonschema::validator_for(&methods["loadHistoryCheckpoint"].input).unwrap();
        let valid = json!({"sessionId":"source", "revision":Uuid::new_v4()});
        assert!(validator.is_valid(&valid));
        assert!(!validator.is_valid(&json!({"sessionId":"source"})));
        for (key, value) in [
            ("revision", json!(null)),
            ("path", json!("/tmp/target")),
            ("activate", json!(true)),
            ("configuration", json!({})),
            ("scope", json!({})),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            assert!(!validator.is_valid(&invalid), "{key}");
        }
        assert_eq!(
            methods["loadedHistoryCheckpointArtifact"].mode,
            MethodMode::Subscription
        );
        let validator =
            jsonschema::validator_for(&methods["loadedHistoryCheckpointArtifact"].input).unwrap();
        let mut valid = json!({"inspection":{"sourceSessionId":"source","operationId":Uuid::new_v4()},"sessionId":"source","artifactId":"a","offset":0});
        assert!(validator.is_valid(&valid));
        valid["offset"] = json!(9_007_199_254_740_992u64);
        assert!(!validator.is_valid(&valid));
    }
}

/// Restore files into a new child of a selected directory and rebind the same,
/// unchanged local Session. It never starts a model/tool call or rewinds history.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionCheckpointRestore")]
pub struct SessionCheckpointRestore {
    pub checkpoint: HistoryCheckpointRead,
    /// Absolute parent path. The Host captures and validates its directory identity.
    #[schemars(length(min = 1))]
    pub parent: String,
    pub permissions: super::WorkspacePermissions,
    pub backend: super::BackendPreference,
    pub accept_external_writers_risk: bool,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionCheckpointRestored")]
pub struct SessionCheckpointRestored {
    pub operation: Uuid,
    pub session_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub session_revision: u64,
    pub head: HistoryCheckpointHead,
    pub workspace: CheckpointWorkspaceSnapshot,
    pub path: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionCheckpointRestoreReceiptRead")]
pub struct SessionCheckpointRestoreReceiptRead {
    pub reference: RecoveryRef,
    pub input: SessionCheckpointRestore,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionCheckpointRestoreReceipt")]
pub struct SessionCheckpointRestoreReceipt {
    pub operation: Option<OperationObservation>,
    pub restore: Option<SessionCheckpointRestored>,
}
