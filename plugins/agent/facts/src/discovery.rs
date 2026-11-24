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

use crate::durable::UnixMillis;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

macro_rules! identity {
    ($($name:ident),+) => {$(
        #[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize, JsonSchema)]
        #[serde(transparent)]
        pub struct $name(pub String);
    )+};
}
identity!(TopicId, WatchId, ActionId, SourceUri);

macro_rules! vocabulary {
    ($name:ident { $($variant:ident => $text:literal),+ }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        pub enum $name { $(#[serde(rename = $text)] $variant),+ }
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }
    };
}

vocabulary!(DossierSignal { Red => "red", Yellow => "yellow", Green => "green", Done => "done" });
vocabulary!(WatchKind { FileHash => "file_hash", HttpCheck => "http_check", Deadline => "deadline" });
vocabulary!(WatchTrigger { NotifyDirect => "notify_direct", InvalidateAction => "invalidate_action", EnqueueFollowup => "enqueue_followup" });
vocabulary!(PendingActionStatus {
    AwaitingConfirm => "awaiting_confirm", Stale => "stale", Executing => "executing",
    Done => "done", UnknownPendingReceipt => "unknown_pending_receipt"
});

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DossierArtifact {
    pub path: String,
    pub purpose: String,
    /// Historical attachments may predate staged content fingerprints.
    pub sha256: Option<String>,
    #[serde(default)]
    pub input_hashes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DossierRecord {
    pub topic_id: TopicId,
    pub title: String,
    pub signal: DossierSignal,
    pub priority_weight: f64,
    pub window_at: Option<UnixMillis>,
    pub revision: u64,
    pub summary_md: String,
    pub artifacts: Vec<DossierArtifact>,
    pub linked_task_ids: Vec<String>,
    pub thread_session_id: Option<String>,
    pub muted: bool,
    pub last_checked_at: UnixMillis,
    pub last_material_change_at: UnixMillis,
    pub last_notified_revision: u64,
    pub last_interrupt_reason: Option<String>,
    pub last_interrupt_at: Option<UnixMillis>,
    pub created_at: UnixMillis,
    pub updated_at: UnixMillis,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DossierSummary {
    pub topic_id: TopicId,
    pub title: String,
    pub signal: DossierSignal,
    pub window_at: Option<UnixMillis>,
    pub revision: u64,
    pub last_material_change_at: UnixMillis,
    pub muted: bool,
    pub artifact_count: u64,
    pub last_notified_revision: u64,
    pub last_interrupt_reason: Option<String>,
    pub last_interrupt_at: Option<UnixMillis>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCursorRecord {
    pub source_uri: SourceUri,
    pub last_mtime_ms: UnixMillis,
    pub last_hash: Option<String>,
    pub write_burst_count: u32,
    pub cooldown_until: UnixMillis,
    pub last_explored_at: UnixMillis,
    pub updated_at: UnixMillis,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchRecord {
    pub watch_id: WatchId,
    pub topic_id: TopicId,
    pub kind: WatchKind,
    pub target: String,
    pub predicate: Value,
    pub on_trigger: WatchTrigger,
    pub last_state_hash: Option<String>,
    pub expires_at: Option<UnixMillis>,
    pub created_at: UnixMillis,
    pub updated_at: UnixMillis,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingActionRecord {
    pub action_id: ActionId,
    pub topic_id: TopicId,
    pub connector_tool: String,
    pub params: Value,
    pub input_hashes: BTreeMap<String, String>,
    pub idempotency_key: String,
    pub status: PendingActionStatus,
    pub receipt: Option<Value>,
    pub expires_at: UnixMillis,
    pub created_at: UnixMillis,
    pub updated_at: UnixMillis,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryInterrupt {
    pub topic_id: TopicId,
    pub revision: u64,
    pub reason: String,
    pub at: UnixMillis,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DossierChoice {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub resolves: bool,
    pub instruction: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DossierRevision {
    pub revision: u64,
    pub at: UnixMillis,
    pub title: String,
    pub signal: DossierSignal,
    pub summary_md: String,
    #[serde(default)]
    pub change_note: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<DossierArtifact>,
    #[serde(default)]
    pub choices: Vec<DossierChoice>,
    #[serde(default)]
    pub chosen_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DossierDetail {
    #[serde(flatten)]
    pub dossier: DossierRecord,
    pub watches: Vec<WatchRecord>,
    pub pending_actions: Vec<PendingActionRecord>,
    #[serde(default)]
    pub revisions: Vec<DossierRevision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dossiers {
    pub dossiers: Vec<DossierSummary>,
    pub notifications_enabled: bool,
}
