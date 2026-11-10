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

//! Versioned immutable historical evidence. None of these values is a live grant.
use crate::{
    artifact::PublishedArtifact,
    durable::{ContentRef, FactId, ModelAttemptId, RunId, RunOwner, StepId},
    input::MessageInput,
    model::ModelPart,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SNAPSHOT_VERSION: u32 = 1;
pub const PAGE_ENTRIES: usize = 256;
pub const ARCHIVE_MAGIC: [u8; 16] = *b"MAKA-SNAPSHOT-1\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "Uuid", into = "Uuid")]
pub struct SnapshotId(Uuid);
impl SnapshotId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
    pub fn as_uuid(self) -> Uuid {
        self.0
    }
}
impl Default for SnapshotId {
    fn default() -> Self {
        Self::new()
    }
}
impl TryFrom<Uuid> for SnapshotId {
    type Error = &'static str;
    fn try_from(value: Uuid) -> Result<Self, Self::Error> {
        if value.is_nil() {
            Err("nil snapshot identity")
        } else {
            Ok(Self(value))
        }
    }
}
impl From<SnapshotId> for Uuid {
    fn from(value: SnapshotId) -> Self {
        value.0
    }
}
impl std::fmt::Display for SnapshotId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryCut {
    pub owner: RunOwner,
    pub session: String,
    pub through_sequence: u64,
    /// Hash of the original canonical fact prefix, never today's UI/model projection.
    pub digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestSource {
    pub cut: HistoryCut,
    pub current: HistoryCut,
    pub current_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub id: SnapshotId,
    pub origin: Origin,
    pub inventory: Option<ContentRef>,
    pub objects: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Origin {
    Canonical {
        cut: HistoryCut,
    },
    Imported {
        source: crate::import::Source,
        fingerprint: ContentRef,
    },
}

/// Pages contain only metadata and references. Large text/media stays in its
/// original immutable payload, with no flattening or lossy result projection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryPage {
    pub previous: Option<ContentRef>,
    pub entries: Vec<Entry>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Entry {
    Position {
        row: SnapshotPosition,
    },
    Run {
        run: RunId,
        admission_sequence: u64,
        spec: ContentRef,
        admission: ContentRef,
    },
    Fact {
        run: RunId,
        sequence: u64,
        admission_sequence: u64,
        revision: u64,
        step: Option<StepId>,
        attempt: Option<ModelAttemptId>,
        tool_use_id: Option<String>,
        id: FactId,
        body: ContentRef,
    },
    Source {
        run: RunId,
        sequence: u64,
        position: u64,
        source: ContentRef,
        resources: ContentRef,
    },
    Artifact {
        owner: RunOwner,
        session: String,
        run: Option<RunId>,
        through_sequence: Option<u64>,
        record: PublishedArtifact,
    },
    Imported {
        ordinal: u64,
        message: ContentRef,
    },
    Payload {
        run: Option<RunId>,
        introduced_sequence: Option<u64>,
        content: ContentRef,
    },
}
impl Entry {
    pub fn content_refs(&self) -> Vec<&ContentRef> {
        match self {
            Self::Position { .. } => vec![],
            Self::Run {
                spec, admission, ..
            } => vec![spec, admission],
            Self::Fact { body, .. } => vec![body],
            Self::Source {
                source, resources, ..
            } => vec![source, resources],
            Self::Artifact { record, .. } => vec![&record.payload],
            Self::Imported { message, .. } => vec![message],
            Self::Payload { content, .. } => vec![content],
        }
    }
}

/// Adapter claims retain their original role, ids and provider metadata. Their
/// presence never authorizes the target to execute a historical tool call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SnapshotPosition {
    Canonical {
        run: RunId,
        sequence: u64,
        admission_sequence: u64,
        fact: FactId,
        item_index: u64,
        internal: bool,
    },
    Imported {
        message_ordinal: u64,
        part_ordinal: u64,
        internal: bool,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OriginalRecordsPage {
    pub previous: Option<ContentRef>,
    pub records: Vec<ContentRef>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OriginalSource {
    pub version: u32,
    pub fingerprint: String,
    pub records: Option<ContentRef>,
}

/// A derived group within one immutable imported source, not a foreign ID or
/// a target Root Turn. Source-qualified row addresses provide its scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ImportedTurnOrdinal(pub u64);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMessage {
    pub turn_ordinal: ImportedTurnOrdinal,
    pub original_ordinal: u64,
    pub media: Vec<String>,
    pub source_message_id: Option<String>,
    pub source_turn_id: Option<String>,
    pub timestamp: Option<u64>,
    pub role: HistoricalRole,
    /// Actual scope under which this producer copied immutable media. A reader
    /// uses it only with the live bound Snapshot, never as an ArtifactStore grant.
    pub artifact_scope: ImportedArtifactScope,
    pub parts: Vec<ContentRef>,
    /// Adapter-owned opaque ImportedProviderMetadata, not active provider options.
    /// Per-part options remain in the original normalized ModelPart itself.
    pub provider_metadata: Option<ContentRef>,
    pub original: ContentRef,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedArtifactScope {
    pub owner: RunOwner,
    pub session: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedProviderMetadata {
    pub version: u32,
    pub source: crate::import::Source,
    pub metadata: serde_json::Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoricalRole {
    System,
    User,
    Assistant,
    Tool,
    Context,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ImportedPart {
    Input {
        content: MessageInput,
    },
    Model {
        part: ModelPart,
    },
    ToolReturn {
        call_id: String,
        name: String,
        result: crate::artifact::ToolReturn<crate::tool_output::ReturnedToolResult>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveInventory {
    pub version: u32,
    pub manifest: ContentRef,
    pub objects: u64,
}
impl Manifest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != SNAPSHOT_VERSION {
            return Err("unsupported Agent history snapshot version");
        }
        if let Some(reference) = &self.inventory {
            reference.validate()?;
        }
        match &self.origin {
            Origin::Canonical { cut } => {
                crate::interaction::entity_id(&cut.session)?;
                if cut.owner.deployment.is_nil()
                    || !crate::archive::valid_projection_digest(&cut.digest)
                {
                    return Err("invalid snapshot source cut");
                }
                cut.owner
                    .namespace
                    .validate()
                    .map_err(|_| "invalid snapshot source namespace")?;
            }
            Origin::Imported {
                source,
                fingerprint,
            } => {
                source.validate()?;
                fingerprint.validate()?;
            }
        }
        Ok(())
    }
}
impl InventoryPage {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.entries.is_empty() || self.entries.len() > PAGE_ENTRIES {
            return Err("invalid snapshot inventory page");
        }
        if let Some(reference) = &self.previous {
            reference.validate()?;
        }
        for entry in &self.entries {
            for reference in entry.content_refs() {
                reference.validate()?;
            }
        }
        Ok(())
    }
}
