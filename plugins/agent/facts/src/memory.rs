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

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct MemoryId(pub uuid::Uuid);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct MemoryRevision(pub u64);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryMode {
    AutoRecall,
    UserRecall,
    UserAlways,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryState {
    Active,
    Unresolved,
    Suppressed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MemorySource {
    Conversation {
        reference: MemoryEvidenceReference,
        observed_at: i64,
        operation_id: uuid::Uuid,
    },
    UserOperation {
        operation_id: uuid::Uuid,
        observed_at: i64,
    },
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    #[default]
    Unspecified,
    Fact,
    Preference,
    Instruction,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatement {
    #[default]
    Unspecified,
    Assertion,
    Preference,
    Intention,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MemoryTemporal {
    #[default]
    Unspecified,
    Timeless,
    /// Half-open validity interval in Unix milliseconds; no end means unbounded.
    Interval {
        start: i64,
        end: Option<i64>,
    },
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryMetadata {
    pub kind: MemoryKind,
    pub statement: MemoryStatement,
    pub temporal: MemoryTemporal,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryGeneration {
    UserInput,
    Extraction,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryRecord {
    pub assertion: MemoryRevision,
    pub id: MemoryId,
    pub revision: MemoryRevision,
    pub mode: MemoryMode,
    pub state: MemoryState,
    pub body: String,
    pub metadata: MemoryMetadata,
    pub created_at: i64,
    pub modified_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryVersion {
    pub revision: MemoryRevision,
    pub body: String,
    pub metadata: MemoryMetadata,
    pub source: MemorySource,
    pub generation: MemoryGeneration,
    pub corrects: Option<MemoryRevision>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MemoryEdit {
    AddEvidence {
        id: MemoryId,
        expected_revision: MemoryRevision,
        assertion: MemoryRevision,
        reference: MemoryEvidenceReference,
    },
    Create {
        body: String,
        #[serde(default)]
        metadata: MemoryMetadata,
    },
    Correct {
        id: MemoryId,
        expected_revision: MemoryRevision,
        body: String,
        #[serde(default)]
        metadata: MemoryMetadata,
    },
    SetAlways {
        id: MemoryId,
        expected_revision: MemoryRevision,
        always: bool,
    },
    Delete {
        id: MemoryId,
        expected_revision: MemoryRevision,
    },
    Restore {
        id: MemoryId,
        expected_revision: MemoryRevision,
        body: String,
        #[serde(default)]
        metadata: MemoryMetadata,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MemoryResult {
    Created {
        id: MemoryId,
        revision: MemoryRevision,
    },
    Revised {
        id: MemoryId,
        revision: MemoryRevision,
    },
    Unresolved {
        id: MemoryId,
        revision: MemoryRevision,
    },
    Retryable {
        reason: String,
    },
    EvidenceAdded {
        id: MemoryId,
        revision: MemoryRevision,
    },
    Suppressed,

    Saved {
        id: MemoryId,
        revision: MemoryRevision,
    },
    Deleted {
        id: MemoryId,
        revision: MemoryRevision,
    },
    Conflict {
        actual: MemoryRevision,
    },
    NotFound,
    InvalidState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryEvidenceReference {
    pub session_id: String,
    pub sequence: u64,
    pub item_index: u64,
    pub fact_id: uuid::Uuid,
    pub fingerprint: String,
    /// UTF-8 byte offsets into the immutable message text.
    pub start: u32,
    pub end: u32,
    pub quote: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryEvidence {
    pub id: u64,
    pub source: MemorySource,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySourceSelection {
    pub session_id: String,
    pub sequence: u64,
    pub item_index: u64,
    pub start: u32,
    pub end: u32,
    pub quote: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryWrite {
    pub edit: MemoryEdit,
    /// A verified conversation source grants automatic extraction authority only.
    pub evidence: Option<MemoryEvidenceReference>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MemoryBatchResult {
    Committed { results: Vec<MemoryResult> },
    Retryable { reason: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MemoryScope {
    Personal,
    Project { session_id: String },
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecallFact {
    pub metadata: MemoryMetadata,
    pub id: MemoryId,
    pub revision: MemoryRevision,
    pub assertion: MemoryRevision,
    pub scope: MemoryScope,
    pub body: String,
    pub sources: Vec<RecallFactSource>,
    pub sources_complete: bool,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RecallFactSource {
    UserOperation {
        operation_id: uuid::Uuid,
    },
    Conversation {
        session_id: String,
        row: crate::history::HistoryRowAddress,
        start: u32,
        end: u32,
    },
}

/// Archived output from these tools requires a fresh, authorized read.
pub fn is_recall_output(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "Recall" | "RecallMore" | "RecallMaterial" | "SessionRead"
    )
}

/// The exact assertion and management revision admitted to a Run, in projection order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadedMemory {
    pub scope: String,
    pub id: MemoryId,
    pub revision: MemoryRevision,
    pub assertion: MemoryRevision,
}

impl LoadedMemory {
    pub fn from_record(scope: &str, record: &MemoryRecord) -> Self {
        Self {
            scope: scope.to_owned(),
            id: record.id.clone(),
            revision: record.revision,
            assertion: record.assertion,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedMemory {
    pub loaded: LoadedMemory,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryProjection {
    pub policy_revision: u64,
    pub entries: Vec<PinnedMemory>,
}

impl MemoryProjection {
    pub fn check_admitted_window(
        &self,
        limit: Option<u64>,
        system: Option<&crate::execution::SystemPrompt>,
        tool_tokens: u64,
    ) -> Result<(), String> {
        let fixed = system.map_or(0, |system| {
            crate::context::measure::estimate(&[crate::model::prompt::Message::System {
                content: system.text.clone(),
                provider_options: None,
            }])
        });
        self.check_window(limit, fixed.saturating_add(tool_tokens))
    }

    pub fn check_window(&self, limit: Option<u64>, fixed_tokens: u64) -> Result<(), String> {
        let message =
            crate::model::prompt::Message::user(self.message().map_err(|e| e.to_string())?);
        let estimated = crate::context::measure::estimate(&[message]);
        let limit = limit.ok_or("pinned memory requires a known model input window; configure the model window or unpin entries")?;
        if estimated.saturating_add(fixed_tokens) >= limit {
            return Err(
                "pinned memory exceeds the selected model input window; shorten or unpin entries"
                    .into(),
            );
        }
        Ok(())
    }
    pub fn message(&self) -> Result<String, serde_json::Error> {
        let bodies: Vec<_> = self
            .entries
            .iter()
            .map(|entry| entry.body.as_str())
            .collect();
        Ok(format!(
            "User-selected memory (JSON data):\n{}",
            serde_json::to_string(&bodies)?
        ))
    }
}

/// Eligibility at admission distinguishes a user Run with reads disabled from an internal Run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryAdmission {
    /// The original receiver could not be established.
    #[default]
    #[serde(alias = "legacy")]
    Unknown,
    Excluded,
    Disabled,
    Enabled,
}

impl MemoryAdmission {
    pub fn is_unknown(&self) -> bool {
        matches!(self, Self::Unknown)
    }
}

/// Authority carried by frozen requests and by the checkpoints derived from them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryReplay {
    #[default]
    #[serde(rename = "legacy")]
    Unrecorded,
    Shared,
    Run(crate::durable::RunId),
}

impl MemoryReplay {
    pub fn is_unrecorded(&self) -> bool {
        matches!(self, Self::Unrecorded)
    }
}
