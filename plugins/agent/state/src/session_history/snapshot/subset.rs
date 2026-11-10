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
use crate::session_history::{
    fork,
    source_tree::{HistoryDataSource, SourceTree},
};
use maka_agent_facts::{
    history::HistoryRowAddress,
    history_snapshot::{ImportedTurnOrdinal, SnapshotPosition},
    session::ForkPosition,
};
mod imported;
mod kind;
use maka_event_log::root_store::SessionRevisionGuard;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ForkSnapshotSource {
    Empty,
    Canonical { run: RunId },
    Imported,
}
/// The immutable source and its actual live Session fence are separate units.
pub struct ForkSnapshot {
    snapshot: Snapshot,
    source: ForkSnapshotSource,
    guard_cut: HistoryCut,
    baseline: Option<RunId>,
}
impl ForkSnapshot {
    pub fn snapshot(&self) -> &Snapshot {
        &self.snapshot
    }
    pub fn source(&self) -> ForkSnapshotSource {
        self.source
    }
    pub fn guard_cut(&self) -> &HistoryCut {
        &self.guard_cut
    }
    pub fn guard<S: Statement>(
        &self,
        history: &SessionHistory,
        guard: SessionRevisionGuard,
        statement: S,
    ) -> Result<fork::GuardedFork<S>, StoreError> {
        if !self.snapshot.data.same_root(&history.data) {
            return Err(invalid("fork snapshot belongs to another physical Root"));
        }
        Ok(history
            .guard_fork(self.guard_cut.clone(), guard, statement)?
            .baseline(self.baseline))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Parent {
    id: SnapshotId,
    manifest: ContentRef,
    cut: SelectionCut,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SelectionCut {
    Canonical { cut: HistoryCut },
    Imported { through_message: Option<u64> },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReceiptKind {
    ForkSnapshot,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    kind: ReceiptKind,
    id: SnapshotId,
    position: ForkPosition,
    parent: Option<Parent>,
    guard_cut: HistoryCut,
    baseline: Option<RunId>,
    source: ForkSnapshotSource,
}
impl SessionHistory {
    pub async fn capture_fork_snapshot(
        &self,
        id: SnapshotId,
        position: ForkPosition,
        guard: SessionRevisionGuard,
        stop: tokio_util::sync::CancellationToken,
    ) -> Result<ForkSnapshot, StoreError> {
        if !guard.same_root(&self.data) || guard.session_id() != self.namespace.session {
            return Err(invalid(
                "fork capture differs from its actual Root/Session guard",
            ));
        }
        if let Some((receipt, manifest)) = self
            .data
            .query(Original(self.namespace.clone(), id, position.clone()))
            .await?
        {
            let captured = open(self, receipt, manifest);
            captured.snapshot.ensure_navigation(stop).await?;
            return Ok(captured);
        }
        if stop.is_cancelled() {
            return Err(invalid("fork snapshot capture cancelled"));
        }
        let live = self.capture().await?;
        let selected = match &position {
            ForkPosition::Start => Selected::Live(self.capture_at(0).await?),
            ForkPosition::End => Selected::Live(self.fork_cut(position.clone()).await?),
            ForkPosition::BeforeTurn { .. }
            | ForkPosition::ThroughTurn { .. }
            | ForkPosition::BeforeSourceTurn { .. }
            | ForkPosition::ThroughSourceTurn { .. } => select(self, &live, &position).await?,
        };
        let (guard_cut, baseline) = match &selected {
            Selected::Live(cut) => (cut.clone(), None),
            Selected::Snapshot { baseline, .. } => (
                self.data
                    .query(MarkerCut(self.namespace.clone(), *baseline))
                    .await?,
                Some(*baseline),
            ),
        };
        let (receipt, manifest) = self
            .data
            .write(CaptureFork {
                history: self.namespace.clone(),
                id,
                position,
                selected,
                guard_cut,
                baseline,
                guard,
            })
            .await?;
        let captured = open(self, receipt, manifest);
        captured.snapshot.ensure_navigation(stop).await?;
        Ok(captured)
    }
}
fn open(history: &SessionHistory, receipt: Receipt, manifest: ContentRef) -> ForkSnapshot {
    ForkSnapshot {
        snapshot: Snapshot {
            data: history.data.clone(),
            id: receipt.id,
            manifest: manifest.clone(),
            authority_id: receipt.id,
            authority_manifest: manifest,
            access: Access::Captured {
                owner: history.namespace.owner.clone(),
                session: history.namespace.session.clone(),
            },
        },
        source: receipt.source,
        guard_cut: receipt.guard_cut,
        baseline: receipt.baseline,
    }
}
struct Original(HistoryNamespace, SnapshotId, ForkPosition);
impl Query for Original {
    type Output = Option<(Receipt, ContentRef)>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        original(c, &self.0, self.1, &self.2)
    }
}
fn original(
    c: &Connection,
    namespace: &HistoryNamespace,
    id: SnapshotId,
    position: &ForkPosition,
) -> Result<Option<(Receipt, ContentRef)>, StoreError> {
    let row: Option<(String,String,String,i64)> = c.query_row(
        "SELECT owner,session,request_json,manifest_content_id FROM agent_history_snapshots WHERE snapshot=?",
        [id.to_string()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).optional()?;
    let Some((owner, session, receipt, footer)) = row else {
        return Ok(None);
    };
    if owner != serde_json::to_string(&namespace.owner)? || session != namespace.session {
        return Err(invalid(
            "fork snapshot receipt belongs to another actual creator scope",
        ));
    }
    let receipt: Receipt = serde_json::from_str(&receipt)?;
    if receipt.id != id
        || receipt.position != *position
        || receipt.guard_cut.owner != namespace.owner
        || receipt.guard_cut.session != namespace.session
    {
        return Err(StoreError::EventConflict);
    }
    let manifest = capture::reference(c, footer)?;
    let header: Manifest = super::super::sql::read_blob(c, footer, &manifest, |reader| {
        Ok(serde_json::from_reader(std::io::BufReader::new(reader))?)
    })?;
    header.validate().map_err(invalid)?;
    if header.id != id {
        return Err(StoreError::EventConflict);
    }
    let consistent = match (&receipt.parent, &header.origin) {
        (None, Origin::Canonical { cut }) => cut == &receipt.guard_cut,
        (
            Some(Parent {
                cut: SelectionCut::Canonical { cut: expected },
                ..
            }),
            Origin::Canonical { cut },
        ) => cut == expected,
        (
            Some(Parent {
                cut: SelectionCut::Imported { .. },
                ..
            }),
            Origin::Imported { .. },
        ) => true,
        _ => false,
    };
    if !consistent {
        return Err(invalid(
            "fork receipt differs from its original bound snapshot",
        ));
    }
    Ok(Some((receipt, manifest)))
}

#[expect(
    clippy::large_enum_variant,
    reason = "Snapshot preparation holds one selection at a time; avoid a separate allocation for its live cut"
)]
enum Selected {
    Live(HistoryCut),
    Snapshot {
        parent: Snapshot,
        cut: SelectionCut,
        baseline: RunId,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Turn {
    Canonical {
        owner: String,
        session: String,
        id: String,
    },
    Imported {
        section: usize,
        ordinal: ImportedTurnOrdinal,
    },
}
fn canonical_turn(spec: &RunSpec) -> Result<Turn, StoreError> {
    Ok(Turn::Canonical {
        owner: serde_json::to_string(&spec.owner)?,
        session: spec.session_id.clone(),
        id: spec.turn_id.clone(),
    })
}
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Coordinate {
    section: usize,
    position: u64,
}
struct Range {
    turn: Turn,
    first: u64,
    last: u64,
}
async fn select(
    history: &SessionHistory,
    live: &HistoryCut,
    position: &ForkPosition,
) -> Result<Selected, StoreError> {
    let tree = SourceTree::live(history, live).await?;
    let mut turns = BTreeMap::<Turn, (Coordinate, Coordinate)>::new();
    for (index, section) in tree.sections().iter().enumerate() {
        let ranges = match &section.source {
            HistoryDataSource::Live { history, cut } => {
                history
                    .data
                    .query(LiveRanges(history.namespace.clone(), cut.clone()))
                    .await?
            }
            HistoryDataSource::Snapshot(parent) => {
                parent
                    .data
                    .query(SnapshotRanges(parent.clone(), index))
                    .await?
            }
        };
        for range in ranges {
            if matches!(range.turn, Turn::Canonical { .. })
                && range.first <= section.after_admission
            {
                continue;
            }
            let first = Coordinate {
                section: index,
                position: range.first,
            };
            let last = Coordinate {
                section: index,
                position: range.last,
            };
            turns
                .entry(range.turn)
                .and_modify(|range| {
                    range.0 = range.0.min(first);
                    range.1 = range.1.max(last);
                })
                .or_insert((first, last));
        }
    }
    let (target, before) = match position {
        ForkPosition::BeforeTurn { turn_id } | ForkPosition::ThroughTurn { turn_id } => {
            maka_agent_facts::interaction::entity_id(turn_id).map_err(invalid)?;
            let mut matching = turns
                .keys()
                .filter(|turn| matches!(turn,Turn::Canonical {id,..} if id==turn_id));
            let target = matching
                .next()
                .cloned()
                .ok_or_else(|| invalid("canonical fork Turn is not in the visible source"))?;
            if matching.next().is_some() {
                return Err(invalid(
                    "ambiguous original Turn requires a qualified source row",
                ));
            }
            (target, matches!(position, ForkPosition::BeforeTurn { .. }))
        }
        ForkPosition::BeforeSourceTurn { position: address }
        | ForkPosition::ThroughSourceTurn { position: address } => {
            let index = tree.validate_address(address).await?;
            let source = &tree.sections()[index].source;
            let turn = match (source, address) {
                (
                    HistoryDataSource::Snapshot(parent),
                    HistoryRowAddress::Imported {
                        message_ordinal, ..
                    },
                ) => {
                    let message = parent
                        .data
                        .query(read::ImportedItem(parent.clone(), *message_ordinal))
                        .await?;
                    Turn::Imported {
                        section: index,
                        ordinal: message.turn_ordinal,
                    }
                }
                (
                    HistoryDataSource::Live { history, .. },
                    HistoryRowAddress::Live { sequence, .. },
                ) => {
                    let run = history
                        .data
                        .query(AddressRun::Live(history.namespace.clone(), *sequence))
                        .await?;
                    canonical_turn(&history.run_source(run).await?.spec)?
                }
                (
                    HistoryDataSource::Snapshot(parent),
                    HistoryRowAddress::Snapshot { sequence, .. },
                ) => {
                    let run = parent
                        .data
                        .query(AddressRun::Snapshot(parent.clone(), *sequence))
                        .await?;
                    canonical_turn(&parent.run_source(run).await?.spec)?
                }
                _ => {
                    return Err(invalid(
                        "fork address differs from its actual source capability",
                    ));
                }
            };
            (
                turn,
                matches!(position, ForkPosition::BeforeSourceTurn { .. }),
            )
        }
        ForkPosition::Start | ForkPosition::End => {
            return Err(invalid("whole-source fork has no selected row"));
        }
    };
    let &(first, last) = turns
        .get(&target)
        .ok_or_else(|| invalid("fork Turn is outside the visible source"))?;
    let boundary = if before { first } else { last };
    if turns.values().any(|&(first, last)| {
        if before {
            first < boundary && last >= boundary
        } else {
            first <= boundary && last > boundary
        }
    }) {
        return Err(invalid("fork source cut splits a complete visible Turn"));
    }
    let section = &tree.sections()[boundary.section];
    match &section.source {
        HistoryDataSource::Live { history, .. } => Ok(Selected::Live(
            history
                .data
                .query(LiveCut(
                    history.namespace.clone(),
                    boundary.position,
                    before,
                ))
                .await?,
        )),
        HistoryDataSource::Snapshot(parent) => {
            let cut = match target {
                Turn::Imported { .. } => SelectionCut::Imported {
                    through_message: parent
                        .data
                        .query(imported::Boundary(
                            parent.clone(),
                            boundary.position,
                            before,
                        ))
                        .await?,
                },
                Turn::Canonical { .. } => SelectionCut::Canonical {
                    cut: parent
                        .data
                        .query(SubsetCut(parent.clone(), boundary.position, before))
                        .await?,
                },
            };
            let baseline = *section
                .path
                .first()
                .ok_or_else(|| invalid("historical source has no actual live baseline"))?;
            Ok(Selected::Snapshot {
                parent: parent.clone(),
                cut,
                baseline,
            })
        }
    }
}
enum AddressRun {
    Live(HistoryNamespace, u64),
    Snapshot(Snapshot, u64),
}
impl Query for AddressRun {
    type Output = RunId;
    fn execute(self, c: &Connection) -> Result<RunId, StoreError> {
        let run: String = match self {
            Self::Live(history, sequence) => c.query_row(
                "SELECT run FROM agent_session_history WHERE owner=? AND session=? AND sequence=?",
                params![
                    serde_json::to_string(&history.owner)?,
                    history.session,
                    bind_u64(sequence)?
                ],
                |row| row.get(0),
            )?,
            Self::Snapshot(parent, sequence) => {
                read::authorize(c, &parent)?;
                c.query_row("SELECT run FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND sequence=?",params![parent.id.to_string(),bind_u64(sequence)?],|row|row.get(0))?
            }
        };
        super::super::sql::identity(run)
    }
}
struct LiveRanges(HistoryNamespace, HistoryCut);
impl Query for LiveRanges {
    type Output = Vec<Range>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        super::super::sql::validate_cut(c, &self.0.owner, &self.0.session, &self.1)?;
        fork::ranges(c, &self.0)?
            .into_iter()
            .filter(|range| range.first <= self.1.through_sequence)
            .map(|range| {
                Ok(Range {
                    turn: Turn::Canonical {
                        owner: serde_json::to_string(&self.0.owner)?,
                        session: self.0.session.clone(),
                        id: range.turn,
                    },
                    first: range.first,
                    last: range.last.min(self.1.through_sequence),
                })
            })
            .collect()
    }
}
struct SnapshotRanges(Snapshot, usize);
impl Query for SnapshotRanges {
    type Output = Vec<Range>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        read::authorize(c, &self.0)?;
        if matches!(
            read::Header(self.0.clone()).execute(c)?.origin,
            Origin::Imported { .. }
        ) {
            return imported::ranges(c, &self.0, self.1);
        }
        let mut statement=c.prepare_cached("SELECT run,sequence FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='run' ORDER BY sequence")?;
        let mut rows = statement.query([self.0.id.to_string()])?;
        let mut ranges = vec![];
        while let Some(row) = rows.next()? {
            let run = super::super::sql::identity(row.get(0)?)?;
            let source = read::Run(self.0.clone(), run).execute(c)?;
            let mut facts=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND run=? ORDER BY sequence DESC")?;
            let mut facts = facts.query(params![self.0.id.to_string(), run.to_string()])?;
            let last = loop {
                let row = facts
                    .next()?
                    .ok_or_else(|| invalid("snapshot Run has no normal Turn fact boundary"))?;
                let Entry::Fact { sequence, body, .. } =
                    serde_json::from_str(&row.get::<_, String>(0)?)?
                else {
                    return Err(invalid("snapshot fact index kind corrupt"));
                };
                let blob = read::pinned(c, &self.0, &body, Some(run))?;
                let fact_kind =
                    super::super::sql::read_blob(c, blob, &body, |reader| kind::read(reader))?;
                if fork::extends_turn(&fact_kind) {
                    break sequence;
                }
            };
            ranges.push(Range {
                turn: canonical_turn(&source.spec)?,
                first: read_u64(row, 1)?,
                last,
            });
        }
        Ok(ranges)
    }
}
struct LiveCut(HistoryNamespace, u64, bool);
impl Query for LiveCut {
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let limit = if self.2 {
            self.1
                .checked_sub(1)
                .ok_or_else(|| invalid("invalid canonical Turn boundary"))?
        } else {
            self.1
        };
        let through = c.query_row("SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND sequence<=? ORDER BY sequence DESC LIMIT 1",
            params![serde_json::to_string(&self.0.owner)?,self.0.session,bind_u64(limit)?],|row|read_u64(row,0)).optional()?.unwrap_or(0);
        super::super::sql::capture_at(c, &self.0.owner, &self.0.session, Some(through))
    }
}
struct MarkerCut(HistoryNamespace, RunId);
impl Query for MarkerCut {
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let through = c.query_row("SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND run=? ORDER BY sequence DESC LIMIT 1",
            params![serde_json::to_string(&self.0.owner)?,self.0.session,self.1.to_string()],|row|read_u64(row,0))?;
        let cut = super::super::sql::capture_at(c, &self.0.owner, &self.0.session, Some(through))?;
        fork::validate_baseline(c, &self.0, &cut, self.1)?;
        Ok(cut)
    }
}
struct SubsetCut(Snapshot, u64, bool);
impl Query for SubsetCut {
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        read::authorize(c, &self.0)?;
        let Origin::Canonical { cut } = read::Header(self.0.clone()).execute(c)?.origin else {
            return Err(invalid("subset has no canonical source cut"));
        };
        let limit = if self.2 {
            self.1
                .checked_sub(1)
                .ok_or_else(|| invalid("invalid original Turn boundary"))?
        } else {
            self.1
        };
        let mut digest = super::super::sql::seed(&cut.owner, &cut.session)?;
        let mut through = 0;
        let mut statement=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND sequence<=? ORDER BY sequence")?;
        let mut rows = statement.query(params![self.0.id.to_string(), bind_u64(limit)?])?;
        while let Some(row) = rows.next()? {
            let Entry::Fact { sequence, body, .. } =
                serde_json::from_str(&row.get::<_, String>(0)?)?
            else {
                return Err(invalid("snapshot fact index kind corrupt"));
            };
            read::pinned(c, &self.0, &body, None)?;
            digest = super::super::sql::chain(&digest, sequence, &body.digest)?;
            through = sequence;
        }
        if through == cut.through_sequence && digest != cut.digest {
            return Err(invalid("snapshot original source cut digest corrupt"));
        }
        Ok(HistoryCut {
            owner: cut.owner,
            session: cut.session,
            through_sequence: through,
            digest,
        })
    }
}

struct CaptureFork {
    history: HistoryNamespace,
    id: SnapshotId,
    position: ForkPosition,
    selected: Selected,
    guard_cut: HistoryCut,
    baseline: Option<RunId>,
    guard: SessionRevisionGuard,
}
impl Statement for CaptureFork {
    type Value = (Receipt, ContentRef);
    type Output = Self::Value;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        if let Some(original) = original(c, &self.history, self.id, &self.position)? {
            return Ok(Prepared {
                value: original,
                changed: false,
                notification: Notification::NONE,
            });
        }
        self.guard.validate(c)?;
        if let Some(marker) = self.baseline {
            fork::validate_baseline(c, &self.history, &self.guard_cut, marker)?;
        } else {
            fork::validate_current(c, &self.history, &self.guard_cut)?;
        }
        let (parent, source, footer) = match self.selected {
            Selected::Live(cut) => {
                let source = super::super::sql::latest(c, &self.history, &cut)?
                    .map_or(ForkSnapshotSource::Empty, |run| {
                        ForkSnapshotSource::Canonical { run: run.run }
                    });
                let prepared = capture::Capture(
                    self.history.clone(),
                    CaptureRequest { id: self.id, cut },
                    None,
                )
                .execute(c)?;
                (None, source, prepared.value)
            }
            Selected::Snapshot { parent, cut, .. } => {
                read::authorize(c, &parent)?;
                let (owner, session) = match &parent.access {
                    Access::Captured { owner, session }
                    | Access::Adopted { owner, session, .. }
                    | Access::Imported { owner, session, .. } => (owner, session),
                };
                if owner != &self.history.owner || session != &self.history.session {
                    return Err(invalid(
                        "subset creator is not its actual parent Snapshot scope",
                    ));
                }
                let (source, footer) = match &cut {
                    SelectionCut::Canonical { cut } => {
                        (latest(c, &parent, cut)?, copy(c, &parent, self.id, cut)?)
                    }
                    SelectionCut::Imported { through_message } => (
                        if through_message.is_some() {
                            ForkSnapshotSource::Imported
                        } else {
                            ForkSnapshotSource::Empty
                        },
                        imported::copy(c, &parent, self.id, *through_message)?,
                    ),
                };
                c.execute(
                    "INSERT INTO agent_history_snapshots VALUES(?,?,?,?,?)",
                    params![
                        self.id.to_string(),
                        serde_json::to_string(&self.history.owner)?,
                        self.history.session,
                        "{}",
                        content_id(c, &footer)?
                    ],
                )?;
                (
                    Some(Parent {
                        id: parent.id,
                        manifest: parent.manifest,
                        cut,
                    }),
                    source,
                    footer,
                )
            }
        };
        let receipt = Receipt {
            kind: ReceiptKind::ForkSnapshot,
            id: self.id,
            position: self.position,
            parent,
            guard_cut: self.guard_cut,
            baseline: self.baseline,
            source,
        };
        c.execute(
            "UPDATE agent_history_snapshots SET request_json=? WHERE snapshot=?",
            params![serde_json::to_string(&receipt)?, self.id.to_string()],
        )?;
        Ok(Prepared {
            value: (receipt, footer),
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
                | StoreError::SessionRevisionConflict { .. }
                | StoreError::SessionNotFound
        )
    }
}
fn latest(
    c: &Connection,
    parent: &Snapshot,
    cut: &HistoryCut,
) -> Result<ForkSnapshotSource, StoreError> {
    let run:Option<String>=c.query_row("SELECT run FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='run' AND sequence<=? ORDER BY sequence DESC LIMIT 1",params![parent.id.to_string(),bind_u64(cut.through_sequence)?],|row|row.get(0)).optional()?;
    match run {
        Some(run) => Ok(ForkSnapshotSource::Canonical {
            run: super::super::sql::identity(run)?,
        }),
        None if cut.through_sequence == 0 => Ok(ForkSnapshotSource::Empty),
        None => Err(invalid(
            "canonical fork prefix is missing its original Run admission",
        )),
    }
}
fn copy(
    c: &Connection,
    parent: &Snapshot,
    id: SnapshotId,
    cut: &HistoryCut,
) -> Result<ContentRef, StoreError> {
    let mut builder = capture::Builder::new(c, id);
    let mut statement = c.prepare_cached(
        "SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? ORDER BY ordinal",
    )?;
    let mut rows = statement.query([parent.id.to_string()])?;
    while let Some(row) = rows.next()? {
        let entry: Entry = serde_json::from_str(&row.get::<_, String>(0)?)?;
        let included = match &entry {
            Entry::Run {
                admission_sequence, ..
            } => *admission_sequence <= cut.through_sequence,
            Entry::Fact { sequence, .. } | Entry::Source { sequence, .. } => {
                *sequence <= cut.through_sequence
            }
            Entry::Payload {
                introduced_sequence: Some(sequence),
                ..
            } => *sequence <= cut.through_sequence,
            Entry::Artifact {
                through_sequence: Some(sequence),
                ..
            } => *sequence <= cut.through_sequence,
            Entry::Position {
                row: SnapshotPosition::Canonical { sequence, .. },
            } => *sequence <= cut.through_sequence,
            _ => false,
        };
        if !included {
            continue;
        }
        for reference in entry.content_refs() {
            read::pinned(c, parent, reference, None)?;
        }
        if let Entry::Run { run, .. } = &entry {
            let original = read::Run(parent.clone(), *run).execute(c)?;
            if !matches!(original.spec.origin, RunOrigin::Local) {
                let (nested, _) = read::Nested(parent.clone(), *run).execute(c)?;
                c.execute("INSERT OR IGNORE INTO agent_history_snapshot_pins(snapshot,content_id) SELECT ?1,content_id FROM agent_history_snapshot_pins WHERE snapshot=?2",params![id.to_string(),nested.to_string()])?;
            }
        }
        builder.add(entry)?;
    }
    let manifest = builder.finish(Origin::Canonical { cut: cut.clone() })?;
    let footer = ContentBlob::json(&manifest)?;
    footer.store(c)?;
    pin(c, id, footer.reference(), None)?;
    Ok(footer.reference().clone())
}
