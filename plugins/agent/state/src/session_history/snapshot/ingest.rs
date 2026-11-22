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
//! Verified immutable file ingestion. Neither source ids nor its old namespace
//! can issue live execution, permission or filesystem capabilities.
use super::*;
use maka_agent_facts::{artifact::content_digest, history_snapshot::ArchiveInventory};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::{fs::File, io::BufReader, sync::Arc};
use uuid::Uuid;
mod graph;
mod guard;
mod inventory;
mod wire;

impl SessionHistory {
    /// Reconcile an original ingestion after uncertain acknowledgement; absence
    /// is not permission to repeat a Host effect or read a different input.
    pub async fn imported_snapshot(
        &self,
        operation: Uuid,
        expected: &maka_event_log::checkpoints::HistorySnapshot,
        stop: tokio_util::sync::CancellationToken,
    ) -> Result<Option<Snapshot>, StoreError> {
        let source = self.imported_snapshot_receipt(operation, expected).await?;
        if let Some(source) = &source {
            source.ensure_navigation(stop).await?;
        }
        Ok(source)
    }

    /// Read the original authorized immutable source without building derived
    /// navigation state. Ordinary page/media reads must not perform recovery.
    pub async fn imported_snapshot_receipt(
        &self,
        operation: Uuid,
        expected: &maka_event_log::checkpoints::HistorySnapshot,
    ) -> Result<Option<Snapshot>, StoreError> {
        if operation.is_nil() {
            return Err(invalid("nil snapshot import operation"));
        }
        let Some((id, manifest)) = self
            .data
            .query(Imported(
                self.namespace.clone(),
                operation,
                expected.clone(),
            ))
            .await?
        else {
            return Ok(None);
        };
        Ok(Some(Snapshot {
            data: self.data.clone(),
            id,
            manifest: manifest.clone(),
            authority_id: id,
            authority_manifest: manifest,
            access: Access::Imported {
                owner: self.namespace.owner.clone(),
                session: self.namespace.session.clone(),
                operation,
            },
        }))
    }

    pub async fn import_snapshot(
        &self,
        operation: Uuid,
        expected: maka_event_log::checkpoints::HistorySnapshot,
        file: File,
        stop: tokio_util::sync::CancellationToken,
    ) -> Result<Snapshot, StoreError> {
        if operation.is_nil() {
            return Err(invalid("nil snapshot import operation"));
        }
        let (id, manifest) = self
            .data
            .write(Ingest {
                target: self.namespace.clone(),
                operation,
                expected,
                file: Arc::new(file),
            })
            .await?;
        let source = Snapshot {
            data: self.data.clone(),
            id,
            manifest: manifest.clone(),
            authority_id: id,
            authority_manifest: manifest,
            access: Access::Imported {
                owner: self.namespace.owner.clone(),
                session: self.namespace.session.clone(),
                operation,
            },
        };
        source.ensure_navigation(stop).await?;
        Ok(source)
    }
}

struct Ingest {
    target: HistoryNamespace,
    operation: Uuid,
    expected: maka_event_log::checkpoints::HistorySnapshot,
    file: Arc<File>,
}
impl Statement for Ingest {
    type Value = (SnapshotId, ContentRef);
    type Output = Self::Value;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        vec![self.file.clone()]
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let owner = serde_json::to_string(&self.target.owner)?;
        let key = content_digest(&serde_json::to_vec(&(
            "maka.snapshot-import.v1",
            &self.target.owner,
            &self.target.session,
            self.operation,
        ))?);
        let expected = serde_json::to_string(&self.expected)?;
        if let Some(value) = receipt(c, &self.target, self.operation, &self.expected)? {
            return Ok(Prepared {
                value,
                changed: false,
                notification: Notification::NONE,
            });
        }
        let inventory = wire::copy(c, &key, &self.expected, &self.file)?;
        let manifest: Manifest = decode(c, &key, &inventory.manifest)?;
        manifest.validate().map_err(invalid)?;
        if manifest.objects != inventory.objects
            || serde_json::to_vec(&manifest.origin)? != self.expected.cut
        {
            return Err(invalid(
                "snapshot manifest differs from its original inventory/cut",
            ));
        }
        graph::register(c, &key, &self.target, &inventory.manifest, &manifest)?;
        let manifest_content = copied(c, &key, &inventory.manifest)?;
        c.execute(
            "INSERT INTO agent_history_snapshot_imports VALUES(?,?,?,?,?,?,?)",
            params![
                key,
                owner,
                self.target.session,
                self.operation.to_string(),
                expected,
                manifest.id.to_string(),
                manifest_content
            ],
        )?;
        c.execute(
            "DELETE FROM agent_history_snapshot_ingest_edges WHERE ingest=?",
            [&key],
        )?;
        c.execute(
            "DELETE FROM agent_history_snapshot_ingest_nodes WHERE ingest=?",
            [&key],
        )?;
        c.execute(
            "DELETE FROM agent_history_snapshot_ingest_frames WHERE ingest=?",
            [&key],
        )?;
        Ok(Prepared {
            value: (manifest.id, inventory.manifest),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_)
                | StoreError::EventConflict
                | StoreError::Json(_)
                | StoreError::Io(_)
        ) || matches!(error, StoreError::Sqlite(error) if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation))
    }
}

struct Imported(
    HistoryNamespace,
    Uuid,
    maka_event_log::checkpoints::HistorySnapshot,
);
impl Query for Imported {
    type Output = Option<(SnapshotId, ContentRef)>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        receipt(c, &self.0, self.1, &self.2)
    }
}
fn receipt(
    c: &Connection,
    target: &HistoryNamespace,
    operation: Uuid,
    expected: &maka_event_log::checkpoints::HistorySnapshot,
) -> Result<Option<(SnapshotId, ContentRef)>, StoreError> {
    let row: Option<(String, String, i64)> = c.query_row(
        "SELECT expected_json,snapshot,manifest_content_id FROM agent_history_snapshot_imports WHERE owner=? AND session=? AND operation=?",
        params![serde_json::to_string(&target.owner)?, target.session, operation.to_string()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).optional()?;
    let Some((original, snapshot, content)) = row else {
        return Ok(None);
    };
    if original != serde_json::to_string(expected)? {
        return Err(StoreError::EventConflict);
    }
    let reference = capture::reference(c, content)?;
    let inventory: ArchiveInventory = serde_json::from_slice(&expected.inventory)?;
    if inventory.manifest != reference {
        return Err(StoreError::EventConflict);
    }
    let registered: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshots WHERE snapshot=? AND manifest_content_id=?)", params![snapshot,content], |row| row.get(0))?;
    if !registered {
        return Err(invalid(
            "original snapshot import registration is incomplete",
        ));
    }
    Ok(Some((super::super::sql::identity(snapshot)?, reference)))
}

pub(super) fn authorize(c: &Connection, snapshot: &Snapshot) -> Result<(), StoreError> {
    let Access::Imported {
        owner,
        session,
        operation,
    } = &snapshot.access
    else {
        return Err(invalid("snapshot has no imported-file authority"));
    };
    let accepted: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_imports i JOIN contents b ON b.id=i.manifest_content_id WHERE i.owner=?1 AND i.session=?2 AND i.operation=?3 AND i.snapshot=?4 AND b.content_sha256=?5 AND length(b.payload)=?6)",
        params![serde_json::to_string(owner)?, session, operation.to_string(), snapshot.authority_id.to_string(), snapshot.authority_manifest.digest, bind_u64(snapshot.authority_manifest.bytes)?], |row| row.get(0),
    )?;
    if !accepted {
        return Err(invalid(
            "snapshot is not bound to this original import operation/target namespace",
        ));
    }
    Ok(())
}

fn copied(c: &Connection, ingest: &str, reference: &ContentRef) -> Result<i64, StoreError> {
    let content = content_id(c, reference)?;
    let present: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_ingest_frames WHERE ingest=? AND content_id=?)", params![ingest, content], |row| row.get(0))?;
    if !present {
        return Err(invalid(
            "snapshot closure references an object absent from the actual imported file",
        ));
    }
    Ok(content)
}
fn decode<T: DeserializeOwned>(
    c: &Connection,
    ingest: &str,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    let content = copied(c, ingest, reference)?;
    super::super::sql::read_blob(c, content, reference, |reader| {
        Ok(serde_json::from_reader(BufReader::new(reader))?)
    })
}
