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

use std::collections::BTreeSet;

use maka_agent_facts::{
    durable::*,
    history_snapshot::{HistoryCut, Origin, RequestSource},
};
use maka_event_log::StoreError;
use rusqlite::{Connection, OptionalExtension, params};

use super::read::TransactionSnapshot;
use crate::{
    fold::RunView,
    session_history::{HistoryNamespace, sql},
    store::invalid,
};

fn live_baseline(
    c: &Connection,
    namespace: &HistoryNamespace,
    cut: &HistoryCut,
) -> Result<Option<(RunId, u64)>, StoreError> {
    let row: Option<(String, u64)> = c.query_row(
        "SELECT h.run,h.sequence FROM agent_session_history h INDEXED BY agent_session_history_historical
        WHERE h.owner=? AND h.session=? AND h.sequence<=? AND h.historical=1
        ORDER BY h.sequence DESC LIMIT 1",
        params![serde_json::to_string(&namespace.owner)?, namespace.session, sql::bind_u64(cut.through_sequence)?],
        |row| Ok((row.get(0)?, sql::read_u64(row, 1)?)),
    ).optional()?;
    row.map(|(run, sequence)| {
        let run = sql::identity(run)?;
        let original = sql::run_source(c, namespace, run)?;
        if original.admission_sequence != sequence
            || !matches!(original.spec.backend, BackendSpec::Historical {})
            || matches!(original.spec.origin, RunOrigin::Local)
        {
            return Err(invalid(
                "historical checkpoint baseline differs from its canonical admission",
            ));
        }
        Ok((run, sequence))
    })
    .transpose()
}

fn snapshot_baseline(
    c: &Connection,
    snapshot: &TransactionSnapshot<'_>,
    cut: &HistoryCut,
) -> Result<Option<(RunId, u64)>, StoreError> {
    let row: Option<(String, u64)> = c
        .query_row(
            "SELECT e.run,e.sequence FROM agent_history_snapshot_entries e INDEXED BY agent_history_snapshot_historical
        WHERE e.snapshot=? AND e.sequence<=? AND e.historical=1
        ORDER BY e.sequence DESC LIMIT 1",
            params![
                snapshot.id().to_string(),
                sql::bind_u64(cut.through_sequence)?
            ],
            |row| Ok((row.get(0)?, sql::read_u64(row, 1)?)),
        )
        .optional()?;
    row.map(|(run, sequence)| {
        let run = sql::identity(run)?;
        let original = snapshot.run(run)?;
        if original.admission_sequence != sequence
            || original.spec.owner != cut.owner
            || original.spec.session_id != cut.session
            || !matches!(original.spec.backend, BackendSpec::Historical {})
            || matches!(original.spec.origin, RunOrigin::Local)
        {
            return Err(invalid(
                "copied historical checkpoint baseline differs from its source admission",
            ));
        }
        Ok((run, sequence))
    })
    .transpose()
}

/// Checks existence within the actual source closure, not which checkpoint a
/// prompt selector should choose. All nested authority comes from one adoption.
pub(crate) fn checkpoint_member(
    c: &Connection,
    target: &RunView,
    source: &RequestSource,
    id: FactId,
) -> Result<bool, StoreError> {
    let namespace = HistoryNamespace {
        owner: target.spec.owner.clone(),
        session: target.spec.session_id.clone(),
    };
    sql::validate_cut(c, &namespace.owner, &namespace.session, &source.cut)?;
    sql::validate_cut(c, &namespace.owner, &namespace.session, &source.current)?;
    let original_target = sql::run_source(c, &namespace, target.run)?;
    if original_target.spec != target.spec
        || source.cut.through_sequence > source.current.through_sequence
    {
        return Err(invalid(
            "checkpoint membership has no original target source namespace",
        ));
    }
    let baseline = live_baseline(c, &namespace, &source.current)?;
    let floor = baseline.map_or(0, |(_, sequence)| sequence);
    let run: Option<String> = c
        .query_row(
            "SELECT f.run FROM agent_facts f JOIN agent_run_specs s ON s.run=f.run
        JOIN agent_facts a ON a.run=f.run AND a.revision=1 JOIN contents b ON b.id=f.body_content_id
        WHERE f.id=? AND s.owner=? AND s.session=? AND f.sequence<=? AND a.sequence>?
        AND json_extract(CAST(b.payload AS TEXT),'$.fact.kind')='context_compacted'",
            params![
                id.to_string(),
                serde_json::to_string(&namespace.owner)?,
                namespace.session,
                sql::bind_u64(source.current.through_sequence)?,
                sql::bind_u64(floor)?
            ],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(run) = run {
        let recorded = crate::sql::fact(c, sql::identity(run)?, id)?.ok_or_else(|| {
            invalid("original checkpoint fact disappeared from its canonical source")
        })?;
        if !matches!(recorded.fact, Fact::ContextCompacted { .. }) {
            return Err(invalid(
                "checkpoint source index differs from its canonical fact kind",
            ));
        }
        return Ok(true);
    }
    let Some((run, _)) = baseline else {
        return Ok(false);
    };
    let mut snapshot = TransactionSnapshot::open(c, &namespace, &source.current, run)?;
    let mut visited = BTreeSet::new();
    loop {
        if !visited.insert(snapshot.id()) {
            return Err(invalid(
                "historical checkpoint source chain contains a cycle",
            ));
        }
        let manifest = snapshot.manifest()?;
        let Origin::Canonical { cut } = manifest.origin else {
            return Ok(false);
        };
        let baseline = snapshot_baseline(c, &snapshot, &cut)?;
        let floor = baseline.map_or(0, |(_, sequence)| sequence);
        if let Some(item) = snapshot.fact(id)? {
            if item.sequence <= cut.through_sequence && item.admission_sequence > floor {
                let original = snapshot.run(item.recorded.run)?;
                if original.admission_sequence != item.admission_sequence
                    || original.spec.owner != cut.owner
                    || original.spec.session_id != cut.session
                {
                    return Err(invalid(
                        "checkpoint fact belongs to another copied source scope",
                    ));
                }
                return Ok(matches!(item.recorded.fact, Fact::ContextCompacted { .. }));
            }
        }
        let Some((run, _)) = baseline else {
            return Ok(false);
        };
        snapshot = snapshot.nested(run)?;
    }
}
