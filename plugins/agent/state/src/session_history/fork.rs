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
use crate::store::invalid;
use maka_agent_facts::session::ForkPosition;
use maka_plugin_core::operation::OperationCleanup;
use rusqlite::{OptionalExtension, params};
use std::collections::BTreeMap;

impl SessionHistory {
    pub async fn fork_cut(&self, position: ForkPosition) -> Result<HistoryCut, StoreError> {
        self.data
            .query(ForkCut(self.namespace.clone(), position))
            .await
    }
}

struct ForkCut(HistoryNamespace, ForkPosition);
impl Query for ForkCut {
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let latest = sql::capture_at(c, &self.0.owner, &self.0.session, None)?;
        let ranges = ranges(c, &self.0)?;
        let turns = turns(&ranges);
        let limit = match &self.1 {
            ForkPosition::Start => 0,
            ForkPosition::End => latest.through_sequence,
            ForkPosition::BeforeSourceTurn { .. } | ForkPosition::ThroughSourceTurn { .. } => {
                return Err(invalid(
                    "source-qualified fork positions require a bound fork snapshot",
                ));
            }
            ForkPosition::BeforeTurn { turn_id } | ForkPosition::ThroughTurn { turn_id } => {
                maka_agent_facts::interaction::entity_id(turn_id).map_err(invalid)?;
                let &(first, last) = turns
                    .get(turn_id)
                    .ok_or_else(|| invalid("fork Turn is not in this source history"))?;
                if matches!(self.1, ForkPosition::BeforeTurn { .. }) {
                    first - 1
                } else {
                    last
                }
            }
        };
        let owner = serde_json::to_string(&self.0.owner)?;
        let through: u64 = c.query_row(
            "SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND sequence<=? ORDER BY sequence DESC LIMIT 1",
            params![owner, self.0.session, sql::bind_u64(limit)?],
            |row| sql::read_u64(row, 0),
        ).optional()?.unwrap_or(0);
        let cut = sql::capture_at(c, &self.0.owner, &self.0.session, Some(through))?;
        validate_ranges(c, &ranges, &turns, &cut)?;
        Ok(cut)
    }
}

pub(in crate::session_history) const TITLE_DIAGNOSTIC_KIND: &str = "session_title_failed";
pub(in crate::session_history) fn extends_turn(kind: &str) -> bool {
    kind != TITLE_DIAGNOSTIC_KIND
}

pub(in crate::session_history) struct Range {
    pub(in crate::session_history) run: RunId,
    pub(in crate::session_history) turn: String,
    pub(in crate::session_history) first: u64,
    pub(in crate::session_history) last: u64,
}
pub(in crate::session_history) fn ranges(
    c: &Connection,
    history: &HistoryNamespace,
) -> Result<Vec<Range>, StoreError> {
    let mut statement = c.prepare_cached(
        "SELECT run FROM agent_session_history WHERE owner=? AND session=? AND kind='run_admitted' ORDER BY sequence",
    )?;
    let mut rows = statement.query(params![
        serde_json::to_string(&history.owner)?,
        history.session
    ])?;
    let mut ranges = vec![];
    while let Some(row) = rows.next()? {
        let run = sql::identity(row.get(0)?)?;
        let source = sql::run_source(c, history, run)?;
        let last=c.query_row("SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND run=? AND kind<>? ORDER BY sequence DESC LIMIT 1",params![serde_json::to_string(&history.owner)?,history.session,run.to_string(),TITLE_DIAGNOSTIC_KIND],|row|sql::read_u64(row,0))?;
        ranges.push(Range {
            run,
            turn: source.spec.turn_id,
            first: source.admission_sequence,
            last,
        });
    }
    Ok(ranges)
}
fn turns(ranges: &[Range]) -> BTreeMap<String, (u64, u64)> {
    let mut turns = BTreeMap::<String, (u64, u64)>::new();
    for range in ranges {
        turns
            .entry(range.turn.clone())
            .and_modify(|(first, last)| {
                *first = (*first).min(range.first);
                *last = (*last).max(range.last);
            })
            .or_insert((range.first, range.last));
    }
    turns
}

// Recheck immediately before guarded capture, not merely when selecting a cut:
// a late fact can split a previously complete Turn or retain an original effect.
pub(super) fn validate_current(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
) -> Result<(), StoreError> {
    sql::validate_cut(c, &history.owner, &history.session, cut)?;
    let ranges = ranges(c, history)?;
    validate_ranges(c, &ranges, &turns(&ranges), cut)
}
fn validate_ranges(
    c: &Connection,
    ranges: &[Range],
    turns: &BTreeMap<String, (u64, u64)>,
    cut: &HistoryCut,
) -> Result<(), StoreError> {
    if turns
        .values()
        .any(|&(first, last)| first <= cut.through_sequence && last > cut.through_sequence)
    {
        return Err(invalid("fork source cut splits a complete Turn"));
    }
    for range in ranges
        .iter()
        .filter(|range| range.first <= cut.through_sequence)
    {
        // The canonical writer maintains pending indexes. Do not replay every
        // completed model item or materialize the source transcript to fork it.
        let view = crate::sql::load(c, range.run, &[], false)?;
        // Unknown policy is shared with the catalog; its late counter is not used here.
        let unknown = crate::session_catalog::run_status(&view, 0).unknown_effects;
        if view.terminal.is_none()
            || unknown
            || view.attempts.values().any(|attempt| {
                attempt.closed.is_none() || attempt.cleanup != OperationCleanup::Confirmed
            })
            || view.tools.values().any(crate::fold::tool_pending)
            || view.cells.values().any(|cell| cell.pending())
            || view.external.as_ref().is_some_and(|task| {
                (task.closed.is_none()
                    && view.terminal != Some(maka_agent_facts::durable::Terminal::Cancelled))
                    || task.cleanup != OperationCleanup::Confirmed
                    || task.effects.values().any(|effect| effect.pending())
            })
        {
            return Err(invalid(
                "fork source has unresolved original effects or cleanup",
            ));
        }
    }
    Ok(())
}

pub struct GuardedFork<S> {
    history: HistoryNamespace,
    cut: HistoryCut,
    guard: maka_event_log::root_store::SessionRevisionGuard,
    statement: S,
    baseline: Option<RunId>,
}
impl SessionHistory {
    pub fn guard_fork<S: Statement>(
        &self,
        cut: HistoryCut,
        guard: maka_event_log::root_store::SessionRevisionGuard,
        statement: S,
    ) -> Result<GuardedFork<S>, StoreError> {
        if !guard.same_root(&self.data)
            || guard.session_id() != self.namespace.session
            || cut.owner != self.namespace.owner
            || cut.session != self.namespace.session
        {
            return Err(invalid(
                "fork publication differs from its original source scope",
            ));
        }
        Ok(GuardedFork {
            history: self.namespace.clone(),
            cut,
            guard,
            statement,
            baseline: None,
        })
    }
}
impl<S: Statement> Statement for GuardedFork<S> {
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<std::sync::Arc<dyn Send + Sync>> {
        self.statement.retain()
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.statement = self.statement.prepare()?;
        Ok(self)
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        self.guard.validate(c)?;
        if let Some(marker) = self.baseline {
            validate_baseline(c, &self.history, &self.cut, marker)?;
        } else {
            validate_current(c, &self.history, &self.cut)?;
        }
        self.statement.execute(c)
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::SessionRevisionConflict { .. }
                | StoreError::SessionNotFound
                | StoreError::InvalidTransition(_)
        ) || S::isolated_rejection(error)
    }
}

impl<S: Statement> GuardedFork<S> {
    pub(in crate::session_history) fn baseline(mut self, marker: Option<RunId>) -> Self {
        self.baseline = marker;
        self
    }
}
pub(in crate::session_history) fn validate_baseline(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    marker: RunId,
) -> Result<(), StoreError> {
    sql::validate_cut(c, &history.owner, &history.session, cut)?;
    let source = sql::run_source(c, history, marker)?;
    let view = crate::sql::load(c, marker, &[], false)?;
    if source.admission_sequence > cut.through_sequence
        || !matches!(source.spec.backend, BackendSpec::Historical {})
        || matches!(source.spec.origin, RunOrigin::Local)
        || view.terminal != Some(Terminal::Completed)
        || view.revision != 2
    {
        return Err(invalid(
            "fork baseline is not an actual completed historical marker",
        ));
    }
    let through=c.query_row("SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND run=? AND kind='run_terminated'",params![serde_json::to_string(&history.owner)?,history.session,marker.to_string()],|row|sql::read_u64(row,0))?;
    if through != cut.through_sequence {
        return Err(invalid(
            "fork baseline guard is not its actual complete marker fence",
        ));
    }
    Ok(())
}
