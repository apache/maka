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
//! Small rebuildable catalog metadata, sealed by the original cold source scan.
use super::*;
use crate::{
    session_catalog::{Message, SourceSummary, fact_message, run_status},
    session_history::source_tree::{HistoryDataSource, SourceTree},
};
use maka_agent_facts::history_snapshot::ImportedMessage;

const VERSION: u32 = 2;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cached {
    version: u32,
    manifest: ContentRef,
    summary: SourceSummary,
}

impl Snapshot {
    pub(crate) fn catalog_summary_in_snapshot(
        &self,
        c: &Connection,
    ) -> Result<SourceSummary, StoreError> {
        load(c, self)?
            .ok_or_else(|| invalid("snapshot catalog index is unavailable; cold rebuild required"))
    }
}

pub(super) fn is_ready(c: &Connection, snapshot: &Snapshot) -> Result<bool, StoreError> {
    Ok(load(c, snapshot)?.is_some())
}

fn load(c: &Connection, snapshot: &Snapshot) -> Result<Option<SourceSummary>, StoreError> {
    read::Header(snapshot.clone()).execute(c)?;
    let raw: Option<String> = c
        .prepare_cached("SELECT summary_json FROM agent_history_snapshot_catalog WHERE snapshot=?")?
        .query_row([snapshot.id.to_string()], |row| row.get(0))
        .optional()?;
    let Some(raw) = raw else { return Ok(None) };
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| invalid("snapshot catalog metadata version is absent"))?;
    if version != u64::from(VERSION) {
        return Ok(None);
    }
    let cached: Cached = serde_json::from_value(value)?;
    if cached.manifest != snapshot.manifest {
        return Err(StoreError::EventConflict);
    }
    if cached.summary.last_message.as_ref().is_some_and(|message| {
        message
            .preview
            .as_ref()
            .is_some_and(|preview| preview.chars().count() > 160)
            || cached
                .summary
                .updated_at
                .is_none_or(|at| at < message.recorded_at)
    }) {
        return Err(invalid("invalid snapshot catalog message metadata"));
    }
    Ok(Some(cached.summary))
}

/// Fed by the existing navigation producer, never by a catalog read.
pub(super) struct CatalogBuilder {
    snapshot: SnapshotId,
    manifest: ContentRef,
    after_admission: u64,
    summary: SourceSummary,
    last_fact: Option<(RunId, FactId)>,
}
impl CatalogBuilder {
    pub(super) async fn new(snapshot: &Snapshot) -> Result<Self, StoreError> {
        snapshot.data.query(Begin(snapshot.clone())).await
    }
    pub(super) fn observe_canonical(
        &mut self,
        spec: &RunSpec,
        item: &HistoryItem,
    ) -> Result<(), StoreError> {
        if item.admission_sequence <= self.after_admission
            || self.last_fact == Some((item.recorded.run, item.recorded.id))
        {
            return Ok(());
        }
        self.last_fact = Some((item.recorded.run, item.recorded.id));
        if matches!(spec.backend, BackendSpec::Historical {}) {
            return Err(invalid(
                "historical marker is not a catalog message or latest Run",
            ));
        }
        if let Some((id, preview)) = fact_message(spec, &item.recorded) {
            let at = u64::try_from(item.recorded.at.0)
                .map_err(|_| invalid("negative original catalog message timestamp"))?;
            self.message(Some(id), Some(at), preview);
        }
        Ok(())
    }
    pub(super) fn observe_imported(
        &mut self,
        message: &ImportedMessage,
        preview: Option<String>,
    ) -> Result<(), StoreError> {
        if let Some(at) = message.timestamp {
            bind_u64(at)?;
        }
        self.message(
            message.source_message_id.clone(),
            message.timestamp,
            preview,
        );
        Ok(())
    }
    fn message(&mut self, id: Option<String>, at: Option<u64>, preview: Option<String>) {
        if let Some(at) = at {
            self.summary.updated_at = Some(self.summary.updated_at.map_or(at, |old| old.max(at)));
        }
        if let (Some(id), Some(at)) = (id, at) {
            self.summary.last_message = Some(Message {
                tail_message_id: id,
                recorded_at: at,
                preview: preview
                    .filter(|preview| !preview.is_empty())
                    .map(|preview| preview.chars().take(160).collect()),
            });
        }
    }

    pub(super) fn finish(self, c: &Connection, snapshot: &Snapshot) -> Result<(), StoreError> {
        read::Header(snapshot.clone()).execute(c)?;
        if self.snapshot != snapshot.id || self.manifest != snapshot.manifest {
            return Err(StoreError::EventConflict);
        }
        let value = Cached {
            version: VERSION,
            manifest: self.manifest,
            summary: self.summary,
        };
        c.execute("INSERT INTO agent_history_snapshot_catalog(snapshot,summary_json) VALUES(?,?) ON CONFLICT(snapshot) DO UPDATE SET summary_json=excluded.summary_json", params![self.snapshot.to_string(), serde_json::to_string(&value)?])?;
        Ok(())
    }
}

struct Begin(Snapshot);
impl Query for Begin {
    type Output = CatalogBuilder;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let tree = SourceTree::snapshot_in_snapshot(c, &self.0)?;
        let sections = tree.sections();
        let root = sections
            .last()
            .ok_or_else(|| invalid("source tree has no actual root"))?;
        let mut summary = if let Some(parent) = sections.iter().rev().nth(1) {
            let HistoryDataSource::Snapshot(source) = &parent.source else {
                return Err(invalid(
                    "snapshot catalog inherited an executable live source",
                ));
            };
            source.catalog_summary_in_snapshot(c)?
        } else {
            SourceSummary {
                latest: None,
                last_message: None,
                updated_at: None,
            }
        };
        let raw: Option<String> = c
            .prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=?1 AND kind='run' AND sequence>?2 ORDER BY sequence DESC LIMIT 1")?
            .query_row(params![self.0.id.to_string(), bind_u64(root.after_admission)?], |row| row.get(0))
            .optional()?;
        if let Some(raw) = raw {
            let Entry::Run { run, .. } = serde_json::from_str(&raw)? else {
                return Err(invalid("snapshot Run metadata has another entry kind"));
            };
            let (view, late) = read::view_with_late(c, &self.0, run)?;
            if matches!(view.spec.backend, BackendSpec::Historical {}) {
                return Err(invalid(
                    "historical marker cannot become the latest real catalog Run",
                ));
            }
            summary.latest = Some(run_status(&view, late));
        }
        Ok(CatalogBuilder {
            snapshot: self.0.id,
            manifest: self.0.manifest,
            after_admission: root.after_admission,
            summary,
            last_fact: None,
        })
    }
}
