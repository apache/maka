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
use super::*;
mod address;
mod data_source;
pub(in crate::session_history) use data_source::CompactionDuration;
mod queries;
use crate::store::invalid;
use address::coordinate;
pub(in crate::session_history) use address::{location, qualify};
use maka_agent_facts::{
    history::{HistoryOrder, HistoryRowAddress},
    history_snapshot::{ImportedMessage, SnapshotId, SnapshotPosition},
};
use queries::{Latest, LivePositions, LiveToolPositions, RequestAt};
use rusqlite::{OptionalExtension, params};
use snapshot::{Snapshot, SnapshotSources, Source};

/// Real scoped read capabilities. Addresses and original IDs never construct one.
#[derive(Clone)]
pub enum HistoryDataSource {
    Live {
        history: SessionHistory,
        cut: HistoryCut,
    },
    Snapshot(Snapshot),
}
#[derive(Clone, Debug)]
pub struct QualifiedRow {
    pub address: HistoryRowAddress,
    pub order: HistoryOrder,
}
#[derive(Clone, Debug)]
pub enum SourceItem {
    Canonical(HistoryItem),
    Imported {
        message: ImportedMessage,
        message_ordinal: u64,
        part_ordinal: u64,
    },
}
#[derive(Clone)]
pub(crate) struct Segment {
    pub(crate) source: HistoryDataSource,
    pub(crate) path: Vec<RunId>,
    pub(crate) order: Vec<u64>,
    pub(crate) after_admission: u64,
}
#[derive(Clone)]
pub struct SourceTree {
    segments: Vec<Segment>,
    live_only: bool,
}
impl SourceTree {
    pub(crate) fn sections(&self) -> &[Segment] {
        &self.segments
    }
    pub fn is_live_only(&self) -> bool {
        self.live_only
    }
    pub fn sources(&self) -> impl Iterator<Item = (&[RunId], &HistoryDataSource)> {
        self.segments
            .iter()
            .map(|segment| (segment.path.as_slice(), &segment.source))
    }
    pub async fn imported_tool_result(
        &self,
        address: &HistoryRowAddress,
        budget: std::sync::Arc<dyn maka_agent_facts::model::prompt_source::source::SourceBudget>,
        stop: &tokio_util::sync::CancellationToken,
    ) -> Result<super::tool_result_source::ImportedToolResult, StoreError> {
        address.validate().map_err(invalid)?;
        let HistoryRowAddress::Imported {
            path,
            snapshot,
            message_ordinal,
            part_ordinal,
        } = address
        else {
            return Err(invalid(
                "imported tool-result locator requires an imported source address",
            ));
        };
        let section = &self.segments[self.section(path, Some(*snapshot))?];
        let HistoryDataSource::Snapshot(source) = &section.source else {
            return Err(invalid(
                "imported tool-result source is not the actual snapshot leaf",
            ));
        };
        super::tool_result_source::ToolResultReader::imported_result(
            source,
            *message_ordinal,
            *part_ordinal,
            budget,
            stop,
        )
        .await
        .map_err(StoreError::Io)
    }
    pub async fn after_run(&self, run: RunId) -> Result<Self, StoreError> {
        let root = self
            .segments
            .last()
            .ok_or_else(|| invalid("source tree has no root"))?;
        let boundary = root.source.run_source(run).await?.admission_sequence;
        let mut segments: Vec<Segment> = self
            .segments
            .iter()
            .filter(|section| {
                section
                    .order
                    .first()
                    .is_none_or(|marker| *marker > boundary)
            })
            .cloned()
            .collect();
        let root = segments
            .last_mut()
            .ok_or_else(|| invalid("source tree lost its actual root"))?;
        root.after_admission = root.after_admission.max(boundary);
        Ok(Self {
            segments,
            live_only: false,
        })
    }
    pub async fn live(history: &SessionHistory, cut: &HistoryCut) -> Result<Self, StoreError> {
        history
            .data
            .query(BuildTree(HistoryDataSource::Live {
                history: history.clone(),
                cut: cut.clone(),
            }))
            .await
    }
    pub async fn snapshot(source: &Snapshot) -> Result<Self, StoreError> {
        source.source_tree().await
    }
    pub(crate) fn snapshot_in_snapshot(
        c: &Connection,
        source: &Snapshot,
    ) -> Result<Self, StoreError> {
        Self::build_in_snapshot(c, HistoryDataSource::Snapshot(source.clone()))
    }
    pub(in crate::session_history) fn build_in_snapshot(
        c: &Connection,
        mut source: HistoryDataSource,
    ) -> Result<Self, StoreError> {
        let mut segments = Vec::new();
        let mut path = Vec::new();
        let mut order = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        loop {
            if let Some(id) = source.snapshot_id()
                && !seen.insert(id)
            {
                return Err(invalid("historical source snapshot cycle"));
            }
            let marker = source.latest_source_in_snapshot(c)?;
            segments.push(Segment {
                source: source.clone(),
                path: path.clone(),
                order: order.clone(),
                after_admission: marker
                    .as_ref()
                    .map_or(0, |marker| marker.admission_sequence),
            });
            let Some(marker) = marker else { break };
            source = source.nested_in_snapshot(c, &marker)?;
            path.push(marker.run);
            order.push(marker.admission_sequence);
        }
        let live_only = segments.len() == 1
            && matches!(segments[0].source, HistoryDataSource::Live { .. })
            && segments[0].after_admission == 0;
        segments.reverse();
        Ok(Self {
            segments,
            live_only,
        })
    }
    fn section(&self, path: &[RunId], snapshot: Option<SnapshotId>) -> Result<usize, StoreError> {
        self.segments
            .iter()
            .position(|section| section.path == path && section.source.snapshot_id() == snapshot)
            .ok_or_else(|| invalid("history address is outside this actual visible source tree"))
    }
    pub async fn source_for_path(
        &self,
        path: &[RunId],
        snapshot: Option<SnapshotId>,
    ) -> Result<HistoryDataSource, StoreError> {
        Ok(self.segments[self.section(path, snapshot)?].source.clone())
    }
    pub(in crate::session_history) async fn validate_address(
        &self,
        address: &HistoryRowAddress,
    ) -> Result<usize, StoreError> {
        address.validate().map_err(invalid)?;
        let (path, snapshot, coordinate) = location(address);
        let index = self.section(path, snapshot)?;
        let section = &self.segments[index];
        let row = section
            .source
            .positions(Some(coordinate), false, true, section.after_admission, 1)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| invalid("history row address is not an original source position"))?;
        let qualified = qualify(section, &row)?;
        if qualified.address != *address {
            return Err(invalid(
                "history address does not match the original source fact or part",
            ));
        }
        Ok(index)
    }
    pub async fn item(&self, address: &HistoryRowAddress) -> Result<SourceItem, StoreError> {
        let section = &self.segments[self.validate_address(address).await?];
        match address {
            HistoryRowAddress::Live { sequence, fact, .. } => {
                let HistoryDataSource::Live { history, cut } = &section.source else {
                    return Err(invalid("history source kind mismatch"));
                };
                let item = history
                    .item(cut, *sequence)
                    .await?
                    .ok_or_else(|| invalid("original canonical source fact missing"))?;
                if item.recorded.id != *fact {
                    return Err(invalid(
                        "position metadata disagrees with the original canonical fact",
                    ));
                }
                Ok(SourceItem::Canonical(item))
            }
            HistoryRowAddress::Snapshot { sequence, fact, .. } => {
                let HistoryDataSource::Snapshot(source) = &section.source else {
                    return Err(invalid("history source kind mismatch"));
                };
                let item = source
                    .item(*sequence)
                    .await?
                    .ok_or_else(|| invalid("original snapshot fact missing"))?;
                if item.recorded.id != *fact {
                    return Err(invalid(
                        "position metadata disagrees with the original snapshot fact",
                    ));
                }
                Ok(SourceItem::Canonical(item))
            }
            HistoryRowAddress::Imported {
                message_ordinal,
                part_ordinal,
                ..
            } => {
                let HistoryDataSource::Snapshot(source) = &section.source else {
                    return Err(invalid("imported source kind mismatch"));
                };
                let message = source.imported_message(*message_ordinal).await?;
                if *part_ordinal >= message.parts.len() as u64 {
                    return Err(invalid(
                        "imported position is outside its actual original message parts",
                    ));
                }
                Ok(SourceItem::Imported {
                    message,
                    message_ordinal: *message_ordinal,
                    part_ordinal: *part_ordinal,
                })
            }
        }
    }
    pub async fn tool_positions(
        &self,
        tool_use_id: &str,
        after: Option<HistoryRowAddress>,
        limit: u32,
    ) -> Result<Vec<QualifiedRow>, StoreError> {
        if limit == 0 {
            return Ok(vec![]);
        }
        let (start, mut bound) = if let Some(address) = &after {
            let (path, snapshot, position) = location(address);
            self.validate_address(address).await?;
            (self.section(path, snapshot)?, Some(position))
        } else {
            (0, None)
        };
        let mut rows = Vec::new();
        for section in &self.segments[start..] {
            let local = section
                .source
                .tool_positions(
                    tool_use_id,
                    bound,
                    section.after_admission,
                    limit - rows.len() as u32,
                )
                .await?;
            for row in local {
                rows.push(qualify(section, &row)?);
            }
            if rows.len() == limit as usize {
                break;
            }
            bound = None;
        }
        Ok(rows)
    }
    pub async fn event_position(
        &self,
        sequence: u64,
        include_internal: bool,
    ) -> Result<Option<QualifiedRow>, StoreError> {
        let section = self
            .segments
            .last()
            .ok_or_else(|| invalid("source tree has no actual root"))?;
        let rows = match &section.source {
            HistoryDataSource::Live { history, cut } => {
                if !history
                    .data
                    .query(queries::EventExists(
                        history.namespace.clone(),
                        cut.clone(),
                        sequence,
                    ))
                    .await?
                {
                    return Ok(None);
                }
                section
                    .source
                    .positions(
                        Some((sequence, 0)),
                        false,
                        include_internal,
                        section.after_admission,
                        1,
                    )
                    .await?
            }
            HistoryDataSource::Snapshot(source) => {
                if matches!(
                    source.manifest().await?.origin,
                    maka_agent_facts::history_snapshot::Origin::Imported { .. }
                ) {
                    return Err(invalid(
                        "imported history has no canonical event sequence coordinate",
                    ));
                }
                if !source.event_exists(sequence).await? {
                    return Ok(None);
                }
                source
                    .seek_positions(
                        Some((sequence, 0)),
                        false,
                        include_internal,
                        section.after_admission,
                        1,
                    )
                    .await?
            }
        };
        rows.first().map(|row| qualify(section, row)).transpose()
    }
    /// Inclusive anchor; rows follow traversal direction, including DESC for a
    /// reverse window. The caller can exclude its anchor without inventing IDs.
    pub async fn positions(
        &self,
        anchor: Option<HistoryRowAddress>,
        reverse: bool,
        include_internal: bool,
        limit: u32,
    ) -> Result<Vec<QualifiedRow>, StoreError> {
        if limit == 0 {
            return Ok(vec![]);
        }
        let (mut section, mut bound) = if let Some(address) = &anchor {
            address.validate().map_err(invalid)?;
            let (path, snapshot, coordinate) = location(address);
            let index = self.section(path, snapshot)?;
            self.validate_address(address).await?;
            (index, Some(coordinate))
        } else if reverse {
            (self.segments.len() - 1, None)
        } else {
            (0, None)
        };
        let mut output = Vec::new();
        loop {
            let current = &self.segments[section];
            let mut exclude_anchor = false;
            loop {
                // Existing Recall/Snapshot query batch size, not a total input
                // cap. Continue from actual keys, never synthetic row addresses.
                let batch = (limit - output.len() as u32 + u32::from(exclude_anchor)).min(256);
                let mut rows = current
                    .source
                    .positions(
                        bound,
                        reverse,
                        include_internal,
                        current.after_admission,
                        batch,
                    )
                    .await?;
                let full = rows.len() == batch as usize;
                if exclude_anchor
                    && rows
                        .first()
                        .is_some_and(|row| Some(coordinate(row)) == bound)
                {
                    rows.remove(0);
                }
                let last = rows.last().map(coordinate);
                for row in rows {
                    output.push(qualify(current, &row)?);
                }
                if output.len() == limit as usize {
                    return Ok(output);
                }
                if !full {
                    break;
                }
                let Some(last) = last else { break };
                bound = Some(last);
                exclude_anchor = true;
            }
            bound = None;
            if reverse {
                if section == 0 {
                    break;
                }
                section -= 1
            } else {
                section += 1;
                if section == self.segments.len() {
                    break;
                }
            }
        }
        Ok(output)
    }
}

pub(in crate::session_history) struct BuildTree(pub(in crate::session_history) HistoryDataSource);
impl Query for BuildTree {
    type Output = SourceTree;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        SourceTree::build_in_snapshot(c, self.0)
    }
}
