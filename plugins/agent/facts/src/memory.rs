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
