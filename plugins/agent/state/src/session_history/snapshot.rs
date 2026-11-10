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
//! Immutable historical sources, with actual Root ownership separate from their descriptors.
use super::*;
use crate::{ContentBlob, store::invalid};
use maka_agent_facts::{
    artifact::{Artifact, PublishedArtifact},
    history_snapshot::{
        Entry, InventoryPage, Manifest, Origin, PAGE_ENTRIES, SNAPSHOT_VERSION, SnapshotId,
    },
};
use rusqlite::{OptionalExtension, params};

mod archive;
mod capture;
mod catalog;
mod checkpoint;
pub(in crate::session_history) mod metrics_metadata;
mod model_evidence;
pub(crate) use checkpoint::checkpoint_member;
mod imported;
mod ingest;
mod install;
pub(in crate::session_history) mod navigation;
pub use archive::ExportedSnapshot;
pub(crate) use imported::ImportedSessionIds;
pub use imported::{IMPORT_TAPE_MAGIC, ImportedCaptureRequest, ImportedSessions};
pub use install::{AdoptSnapshot, Adoption};
mod positions;
mod read;
mod subset;
pub use subset::{ForkSnapshot, ForkSnapshotSource};

/// Retain the original capture identity across uncertain acknowledgement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRequest {
    pub id: SnapshotId,
    pub cut: HistoryCut,
}

/// Constructed by an authorized native read/adoption, never deserialized from a
/// resource locator. Every use rechecks the exact original pin/manifest binding.
#[derive(Clone)]
pub struct Snapshot {
    data: DataWriter,
    id: SnapshotId,
    manifest: ContentRef,
    authority_id: SnapshotId,
    authority_manifest: ContentRef,
    access: Access,
}
#[derive(Clone)]
enum Access {
    Imported {
        owner: RunOwner,
        session: String,
        operation: uuid::Uuid,
    },
    Captured {
        owner: RunOwner,
        session: String,
    },
    Adopted {
        owner: RunOwner,
        session: String,
        run: RunId,
    },
}

#[derive(Clone, Debug)]
pub struct SnapshotPage {
    pub items: Vec<HistoryItem>,
    pub next: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct ImportedPage {
    pub items: Vec<(u64, maka_agent_facts::history_snapshot::ImportedMessage)>,
    pub next: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct SnapshotSources {
    pub sources: Vec<Source>,
    pub next: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct Source {
    pub position: u64,
    pub source: ContentRef,
    pub resources: ContentRef,
}

impl SessionHistory {
    fn bind_captured_snapshot(&self, id: SnapshotId, manifest: ContentRef) -> Snapshot {
        Snapshot {
            data: self.data.clone(),
            id,
            authority_id: id,
            authority_manifest: manifest.clone(),
            manifest,
            access: Access::Captured {
                owner: self.namespace.owner.clone(),
                session: self.namespace.session.clone(),
            },
        }
    }
    pub async fn capture_snapshot(
        &self,
        request: CaptureRequest,
        stop: tokio_util::sync::CancellationToken,
    ) -> Result<Snapshot, StoreError> {
        let manifest = self
            .data
            .write(capture::Capture(
                self.namespace.clone(),
                request.clone(),
                None,
            ))
            .await?;
        let snapshot = self.bind_captured_snapshot(request.id, manifest);
        snapshot.ensure_navigation(stop).await?;
        Ok(snapshot)
    }
    pub async fn capture_snapshot_guarded(
        &self,
        request: CaptureRequest,
        guard: maka_event_log::root_store::SessionRevisionGuard,
        stop: tokio_util::sync::CancellationToken,
    ) -> Result<Snapshot, StoreError> {
        if guard.session_id() != self.namespace.session || !guard.same_root(&self.data) {
            return Err(invalid(
                "source revision guard belongs to another actual Root/session",
            ));
        }
        let manifest = self
            .data
            .write(capture::Capture(
                self.namespace.clone(),
                request.clone(),
                Some(guard),
            ))
            .await?;
        let snapshot = self.bind_captured_snapshot(request.id, manifest);
        snapshot.ensure_navigation(stop).await?;
        Ok(snapshot)
    }
    pub async fn captured_snapshot(
        &self,
        id: SnapshotId,
        stop: tokio_util::sync::CancellationToken,
    ) -> Result<Option<(CaptureRequest, Snapshot)>, StoreError> {
        let Some((request, manifest)) = self
            .data
            .query(read::Captured(self.namespace.clone(), id))
            .await?
        else {
            return Ok(None);
        };
        let snapshot = self.bind_captured_snapshot(id, manifest);
        snapshot.ensure_navigation(stop).await?;
        Ok(Some((request, snapshot)))
    }
    fn bind_adopted_snapshot(&self, id: SnapshotId, manifest: ContentRef, run: RunId) -> Snapshot {
        Snapshot {
            data: self.data.clone(),
            id,
            authority_id: id,
            authority_manifest: manifest.clone(),
            manifest,
            access: Access::Adopted {
                owner: self.namespace.owner.clone(),
                session: self.namespace.session.clone(),
                run,
            },
        }
    }
    pub(in crate::session_history) fn snapshot_in_snapshot(
        &self,
        c: &Connection,
        cut: &HistoryCut,
        run: RunId,
    ) -> Result<Snapshot, StoreError> {
        let (id, manifest) = read::Open(self.namespace.clone(), cut.clone(), run).execute(c)?;
        Ok(self.bind_adopted_snapshot(id, manifest, run))
    }
    pub(crate) fn catalog_source_in_snapshot(
        &self,
        c: &Connection,
        marker: RunId,
    ) -> Result<Snapshot, StoreError> {
        let cut = super::sql::capture_at(c, &self.namespace.owner, &self.namespace.session, None)?;
        self.snapshot_in_snapshot(c, &cut, marker)
    }
    pub async fn snapshot(&self, cut: &HistoryCut, run: RunId) -> Result<Snapshot, StoreError> {
        let (id, manifest) = self
            .data
            .query(read::Open(self.namespace.clone(), cut.clone(), run))
            .await?;
        Ok(self.bind_adopted_snapshot(id, manifest, run))
    }
}
impl Snapshot {
    pub fn id(&self) -> SnapshotId {
        self.id
    }
    pub fn reference(&self) -> &ContentRef {
        &self.manifest
    }
    pub fn same_root(&self, data: &DataWriter) -> bool {
        self.data.same_root(data)
    }
    fn bind_nested_snapshot(&self, id: SnapshotId, manifest: ContentRef) -> Snapshot {
        Snapshot {
            data: self.data.clone(),
            id,
            manifest,
            authority_id: self.authority_id,
            authority_manifest: self.authority_manifest.clone(),
            access: self.access.clone(),
        }
    }
    pub(in crate::session_history) async fn compaction_started_at(
        &self,
        run: RunId,
        step: StepId,
        sequence: u64,
    ) -> Result<UnixMillis, StoreError> {
        self.data
            .query(super::source_tree::CompactionStarted(
                super::source_tree::HistoryDataSource::Snapshot(self.clone()),
                run,
                step,
                sequence,
            ))
            .await
    }
    pub(in crate::session_history) fn manifest_in_snapshot(
        &self,
        c: &Connection,
    ) -> Result<Manifest, StoreError> {
        read::Header(self.clone()).execute(c)
    }
    pub(in crate::session_history) fn run_in_snapshot(
        &self,
        c: &Connection,
        run: RunId,
    ) -> Result<RunSource, StoreError> {
        read::Run(self.clone(), run).execute(c)
    }
    pub(in crate::session_history) fn metadata_in_snapshot<T: serde::de::DeserializeOwned>(
        &self,
        c: &Connection,
        run: RunId,
        reference: &ContentRef,
    ) -> Result<T, StoreError> {
        read::authorize(c, self)?;
        metrics_metadata::original(c, self.id, run, reference)
    }
    pub(in crate::session_history) fn nested_in_snapshot(
        &self,
        c: &Connection,
        run: RunId,
    ) -> Result<Snapshot, StoreError> {
        let (id, manifest) = read::Nested(self.clone(), run).execute(c)?;
        Ok(self.bind_nested_snapshot(id, manifest))
    }
    pub(in crate::session_history) fn latest_source_in_snapshot(
        &self,
        c: &Connection,
    ) -> Result<Option<RunSource>, StoreError> {
        read::LatestSource(self.clone()).execute(c)
    }
    pub(in crate::session_history) async fn source_tree(
        &self,
    ) -> Result<super::source_tree::SourceTree, StoreError> {
        self.data
            .query(super::source_tree::BuildTree(
                super::source_tree::HistoryDataSource::Snapshot(self.clone()),
            ))
            .await
    }
    pub async fn nested(&self, original_marker_run: RunId) -> Result<Snapshot, StoreError> {
        let (id, manifest) = self
            .data
            .query(read::Nested(self.clone(), original_marker_run))
            .await?;
        Ok(self.bind_nested_snapshot(id, manifest))
    }
    pub async fn manifest(&self) -> Result<Manifest, StoreError> {
        self.data.query(read::Header(self.clone())).await
    }
    pub async fn page(&self, after: u64, limit: u32) -> Result<SnapshotPage, StoreError> {
        self.data
            .query(read::Page(self.clone(), after, limit))
            .await
    }
    pub async fn run_source(&self, run: RunId) -> Result<RunSource, StoreError> {
        self.data.query(read::Run(self.clone(), run)).await
    }
    pub(super) async fn event_exists(&self, sequence: u64) -> Result<bool, StoreError> {
        self.data
            .query(read::EventExists(self.clone(), sequence))
            .await
    }
    pub(super) async fn tool_positions(
        &self,
        tool_use_id: &str,
        after: Option<(u64, u64)>,
        min_admission: u64,
        limit: u32,
    ) -> Result<Vec<maka_agent_facts::history_snapshot::SnapshotPosition>, StoreError> {
        self.data
            .query(read::ToolPositions(
                self.clone(),
                tool_use_id.to_owned(),
                after,
                min_admission,
                limit,
            ))
            .await
    }
    pub async fn item(&self, sequence: u64) -> Result<Option<HistoryItem>, StoreError> {
        self.data.query(read::Item(self.clone(), sequence)).await
    }
    pub(in crate::session_history) async fn imported_reference(
        &self,
        ordinal: u64,
    ) -> Result<ContentRef, StoreError> {
        self.data
            .query(read::ImportedReference(self.clone(), ordinal))
            .await
    }
    pub async fn imported_message(
        &self,
        ordinal: u64,
    ) -> Result<maka_agent_facts::history_snapshot::ImportedMessage, StoreError> {
        self.data
            .query(read::ImportedItem(self.clone(), ordinal))
            .await
    }
    pub async fn view_at(&self, run: RunId) -> Result<crate::fold::RunView, StoreError> {
        self.data.query(read::View(self.clone(), run)).await
    }
    pub async fn history(
        &self,
        run: RunId,
        after_revision: u64,
        limit: u32,
    ) -> Result<Vec<RecordedFact>, StoreError> {
        self.data
            .query(read::History(self.clone(), run, after_revision, limit))
            .await
    }
    pub async fn tool_call(
        &self,
        run: RunId,
        key: &ToolKey,
    ) -> Result<maka_agent_facts::model::ModelToolCall, StoreError> {
        self.data
            .query(read::ToolCall(self.clone(), run, key.clone()))
            .await
    }
    pub async fn request(&self, run: RunId, step: StepId) -> Result<RequestSpec, StoreError> {
        self.data
            .query(read::Request(self.clone(), run, step))
            .await
    }
    pub async fn artifact(
        &self,
        owner: RunOwner,
        session: String,
        run: Option<RunId>,
        id: String,
    ) -> Result<Option<PublishedArtifact>, StoreError> {
        self.data
            .query(read::ArtifactMetadata(
                self.clone(),
                owner,
                session,
                run,
                id,
            ))
            .await
    }
    pub async fn with_payload<T: Send + 'static>(
        &self,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.data
            .query(read::Content(
                self.clone(),
                None,
                reference.clone(),
                consume,
            ))
            .await
    }
    /// Model projection follows the explicit immutable source boundary; history
    /// and exported snapshots still retain every earlier imported message.
    pub async fn model_messages(
        &self,
        after: Option<u64>,
        limit: u32,
    ) -> Result<ImportedPage, StoreError> {
        let Origin::Imported { model_start, .. } = self.manifest().await?.origin else {
            return Err(invalid("model messages require an imported source"));
        };
        self.imported(
            after.max(model_start.and_then(|start| start.checked_sub(1))),
            limit,
        )
        .await
    }

    pub async fn imported(
        &self,
        after: Option<u64>,
        limit: u32,
    ) -> Result<ImportedPage, StoreError> {
        self.data
            .query(read::Imported(self.clone(), after, limit))
            .await
    }
    pub async fn with_imported_content<T: Send + 'static>(
        &self,
        ordinal: u64,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.data
            .query(read::ImportedContent(
                self.clone(),
                ordinal,
                reference.clone(),
                consume,
            ))
            .await
    }
    pub async fn chunk(
        &self,
        reference: &ContentRef,
        offset: u64,
        limit: u32,
    ) -> Result<Vec<u8>, StoreError> {
        self.data
            .query(read::Chunk(self.clone(), reference.clone(), offset, limit))
            .await
    }
    pub async fn sources(
        &self,
        sequence: u64,
        after: Option<u64>,
        limit: u32,
    ) -> Result<SnapshotSources, StoreError> {
        self.data
            .query(read::Sources(self.clone(), sequence, after, limit))
            .await
    }
    pub async fn with_content<T: Send + 'static>(
        &self,
        run: RunId,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.with_pinned_content(Some(run), reference, consume)
            .await
    }

    /// Stream a specific immutable inventory reference under this snapshot's
    /// custody. Imported entries may have no originating canonical Run.
    pub async fn with_pinned_content<T: Send + 'static>(
        &self,
        run: Option<RunId>,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.data
            .query(read::Content(self.clone(), run, reference.clone(), consume))
            .await
    }
    pub async fn with_source<T: Send + 'static>(
        &self,
        sequence: u64,
        position: u64,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.data
            .query(read::SourceContent(
                self.clone(),
                sequence,
                position,
                reference.clone(),
                consume,
            ))
            .await
    }
    pub async fn with_artifact<T: Send + 'static>(
        &self,
        owner: RunOwner,
        session: String,
        run: Option<RunId>,
        id: String,
        consume: impl FnOnce(&Artifact, &mut dyn std::io::Read) -> Result<T, StoreError>
        + Send
        + 'static,
    ) -> Result<Option<T>, StoreError> {
        self.data
            .query(read::ArtifactContent(
                self.clone(),
                owner,
                session,
                run,
                id,
                consume,
            ))
            .await
    }
}
fn bind_u64(value: u64) -> Result<i64, StoreError> {
    super::sql::bind_u64(value)
}
fn read_u64(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    super::sql::read_u64(row, column)
}
fn content_id(c: &Connection, reference: &ContentRef) -> Result<i64, StoreError> {
    reference.validate().map_err(invalid)?;
    c.query_row(
        "SELECT id FROM contents WHERE content_sha256=? AND length(payload)=?",
        params![reference.digest, bind_u64(reference.bytes)?],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| invalid("snapshot payload unavailable"))
}
fn pin(
    c: &Connection,
    id: SnapshotId,
    reference: &ContentRef,
    run: Option<RunId>,
) -> Result<(), StoreError> {
    let row = content_id(c, reference)?;
    c.execute(
        "INSERT OR IGNORE INTO agent_history_snapshot_pins VALUES(?,?)",
        params![id.to_string(), row],
    )?;
    if let Some(run) = run {
        c.execute(
            "INSERT OR IGNORE INTO agent_history_snapshot_run_refs VALUES(?,?,?)",
            params![id.to_string(), run.to_string(), row],
        )?;
    }
    Ok(())
}
