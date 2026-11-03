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

//! History-only checkpoints; neither workspace snapshots nor execution authority.
use maka_plugin_core::operation::{OperationObservation, RecoveryRef};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryCheckpointPublish")]
pub struct HistoryCheckpointPublish {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<Uuid>")]
    pub expected_revision: Option<Uuid>,
    /// Membership confirmation returned by previewHistoryCheckpoint, not a live revision.
    #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
    pub confirmed_subtree_digest: String,
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
#[schemars(rename = "AgentHistoryCheckpointPublication")]
pub struct HistoryCheckpointPublication {
    pub state: HistoryCheckpointState,
    /// Cleanup failure does not undo a successful publication.
    pub cleanup_pending: bool,
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
#[schemars(rename = "AgentHistoryCheckpointReceiptRead")]
pub struct HistoryCheckpointReceiptRead {
    pub reference: RecoveryRef,
    /// The exact original input. Changed input cannot select another publication.
    pub input: HistoryCheckpointPublish,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryCheckpointReceipt")]
pub struct HistoryCheckpointReceipt {
    /// Original Host observation. Domain success never fabricates Host cleanup confirmation.
    pub operation: Option<OperationObservation>,
    /// Authoritative domain result even when the Host response was lost.
    /// Absence is not permission to recapture under a replacement operation.
    pub publication: Option<HistoryCheckpointPublication>,
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
    /// The following bytes use the MAKA-SESSION v2 history format.
    NativeHistoryV1 {
        head: HistoryCheckpointHead,
        inventory: HistoryCheckpointInventory,
        bundle: HistoryCheckpointObject,
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
        assert_eq!(
            methods["publishHistoryCheckpoint"].mode,
            MethodMode::Mutation
        );
        assert_eq!(
            methods["readHistoryCheckpoint"].mode,
            MethodMode::Subscription
        );
        let publish =
            jsonschema::validator_for(&methods["publishHistoryCheckpoint"].input).unwrap();
        let valid = json!({"sessionId":"source","expectedRevision":null,"confirmedSubtreeDigest":"a".repeat(64)});
        assert!(publish.is_valid(&valid));
        for key in ["expectedRevision", "confirmedSubtreeDigest"] {
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
}
