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
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_BATCH: usize = 4;
const GROUP_LIMIT: usize = 8;
const GROUP_BYTES: usize = 8192;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    Independent,
    Equivalent,
    Supplement,
    Replaces,
    Conflict,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Judgment {
    pub relation: Relation,
    pub replacement_quote: Option<String>,
}
pub type Decisions = Vec<Vec<Judgment>>;
#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub id: MemoryId,
    pub revision: MemoryRevision,
    pub assertion: MemoryRevision,
    pub body: String,
    pub metadata: MemoryMetadata,
    pub mode: MemoryMode,
    pub state: MemoryState,
    pub restricted: bool,
    pub source: MemorySource,
    pub latest_observed_at: i64,
}
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub revision: u64,
    pub candidates: Vec<Candidate>,
    #[serde(skip)]
    exact_matches: Vec<Vec<usize>>,
}
pub struct Inspect {
    pub scope: Scope,
    pub writes: Vec<MemoryWrite>,
}

pub fn body(edit: &MemoryEdit) -> Option<(&str, &MemoryMetadata)> {
    match edit {
        MemoryEdit::Create { body, metadata }
        | MemoryEdit::Correct { body, metadata, .. }
        | MemoryEdit::Restore { body, metadata, .. } => Some((body, metadata)),
        _ => None,
    }
}
fn target(edit: &MemoryEdit) -> Option<(&MemoryId, MemoryRevision)> {
    match edit {
        MemoryEdit::Create { .. } => None,
        MemoryEdit::Correct {
            id,
            expected_revision,
            ..
        }
        | MemoryEdit::Restore {
            id,
            expected_revision,
            ..
        }
        | MemoryEdit::Delete {
            id,
            expected_revision,
        }
        | MemoryEdit::SetAlways {
            id,
            expected_revision,
            ..
        }
        | MemoryEdit::AddEvidence {
            id,
            expected_revision,
            ..
        } => Some((id, *expected_revision)),
    }
}
fn preflight(
    c: &Connection,
    scope: &Scope,
    edit: &MemoryEdit,
) -> Result<Option<MemoryResult>, StoreError> {
    let Some((id, expected)) = target(edit) else {
        return Ok(None);
    };
    let current: Option<(i64, String)> = c
        .query_row(
            "SELECT revision,state FROM agent_memories WHERE namespace=? AND scope=? AND id=?",
            params![scope.namespace, scope.location, id.0.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((revision, state)) = current else {
        return Ok(Some(MemoryResult::NotFound));
    };
    let actual = revision_value(revision)?;
    if actual != expected {
        return Ok(Some(MemoryResult::Conflict { actual }));
    }
    if matches!(edit, MemoryEdit::Restore { .. }) != (state == "suppressed") {
        return Ok(Some(MemoryResult::InvalidState));
    }
    Ok(None)
}
fn scope_revision(c: &Connection, scope: &Scope) -> Result<u64, StoreError> {
    let value: Option<i64> = c
        .query_row(
            "SELECT revision FROM agent_memory_scopes WHERE namespace=? AND scope=?",
            params![scope.namespace, scope.location],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value.map(revision_value).transpose()?.map_or(0, |r| r.0))
}
pub fn validate(writes: &[MemoryWrite]) -> Result<(), StoreError> {
    if writes.is_empty() || writes.len() > MAX_BATCH {
        return Err(invalid("memory batch must contain 1..4 writes"));
    }
    let mut targets = BTreeSet::new();
    for write in writes {
        if let Some((text, meta)) = body(&write.edit) {
            if text.trim().is_empty() || text.len() > 8192 {
                return Err(invalid("memory resolution body must contain 1..8192 bytes"));
            }
            if matches!(meta.temporal, MemoryTemporal::Interval { start, end: Some(end) } if end <= start)
            {
                return Err(invalid("invalid memory interval"));
            }
        }
        if write
            .evidence
            .as_ref()
            .is_some_and(|reference| reference.quote.is_empty() || reference.quote.len() > 16384)
        {
            return Err(invalid("memory evidence quote must contain 1..16384 bytes"));
        }
        if write.evidence.is_some() && !matches!(write.edit, MemoryEdit::Create { .. }) {
            return Err(invalid("automatic writes cannot authorize user edits"));
        }
        if let Some((id, _)) = target(&write.edit)
            && !targets.insert(id.0)
        {
            return Err(invalid("multiple edits of one memory in a batch"));
        }
    }
    Ok(())
}
fn expression(text: &str) -> String {
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    // A fixed query budget, preserving deterministic order across retries.
    let grams: BTreeSet<String> = chars
        .windows(3)
        .filter(|w| w.iter().all(|c| c.is_alphanumeric()))
        .map(|w| w.iter().collect())
        .collect();
    grams
        .into_iter()
        .take(48)
        .map(|v| format!("\"{}\"", v.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}
const COLUMNS: &str = "m.id,m.revision,v.revision,v.body,v.metadata,m.mode,m.state,v.disposition,v.source,COALESCE((SELECT json_extract(e.source,'$.observedAt') FROM agent_memory_evidence e WHERE e.namespace=v.namespace AND e.scope=v.scope AND e.id=v.id AND e.assertion=v.revision ORDER BY json_extract(e.source,'$.observedAt') DESC LIMIT 1),json_extract(v.source,'$.observedAt'))";
const CATEGORIES: [&str; 3] = [
    "v.disposition='current' AND m.state='active' AND m.mode='auto_recall'",
    "v.disposition='current' AND m.state<>'suppressed' AND (m.mode<>'auto_recall' OR m.state='unresolved')",
    "v.disposition<>'current' OR m.state='suppressed'",
];
fn candidate_sql(exact: bool, category: &str) -> String {
    let columns = COLUMNS.replace("v.body", "t.body");
    let restored = matching::RESTORED;
    let selection = if exact {
        "t.digest=?3 AND json(v.metadata)=json(?5)"
    } else {
        "t.rowid IN (SELECT rowid FROM agent_memory_matches WHERE namespace=?1 AND scope=?2 AND digest=?3 UNION SELECT rowid FROM agent_memory_search WHERE agent_memory_search MATCH ?4 UNION SELECT a.rowid FROM agent_memories pinned JOIN agent_memory_matches a ON a.namespace=pinned.namespace AND a.scope=pinned.scope AND a.id=pinned.id AND a.assertion=pinned.assertion WHERE pinned.namespace=?1 AND pinned.scope=?2 AND pinned.mode='user_always' AND pinned.state='active')"
    };
    let limit = if exact { 1 } else { 9 };
    // Drive joins from digest/rowid hits; scope or mode indexes otherwise scan unrelated history.
    let index = if exact { "" } else { "NOT INDEXED" };
    format!(
        "SELECT {columns} FROM agent_memory_matches t {index} CROSS JOIN agent_memory_versions v ON v.namespace=t.namespace AND v.scope=t.scope AND v.id=t.id AND v.revision=t.assertion CROSS JOIN agent_memories m ON m.namespace=v.namespace AND m.scope=v.scope AND m.id=v.id WHERE t.namespace=?1 AND t.scope=?2 AND ({category}) AND ({selection}) AND NOT ({restored}) ORDER BY (t.digest=?3 AND json(v.metadata)=json(?5)) DESC,m.id,v.revision DESC LIMIT {limit}"
    )
}
type CandidateRow = (
    String,
    i64,
    i64,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
);
fn candidate(r: &rusqlite::Row<'_>) -> rusqlite::Result<CandidateRow> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
        r.get(8)?,
        r.get(9)?,
    ))
}
impl Query for Inspect {
    type Output = Snapshot;
    fn execute(self, c: &Connection) -> Result<Snapshot, StoreError> {
        self.scope.validate(c)?;
        validate(&self.writes)?;
        if self.writes.len() == 1 && preflight(c, &self.scope, &self.writes[0].edit)?.is_some() {
            return Ok(Snapshot {
                revision: scope_revision(c, &self.scope)?,
                candidates: Vec::new(),
                exact_matches: vec![Vec::new(); self.writes.len()],
            });
        }
        let mut candidates = Vec::new();
        let mut seen = BTreeMap::new();
        let mut exact_matches = vec![Vec::new(); self.writes.len()];
        let mut sizes = [0usize; 3];
        let mut counts = [0usize; 3];
        for exact in [true, false] {
            for (input, write) in self.writes.iter().enumerate() {
                let Some((text, metadata)) = body(&write.edit) else {
                    continue;
                };
                let expr = expression(text);
                let location = format!("{}:{}", self.scope.namespace, self.scope.location)
                    .replace('"', "\"\"");
                let search = format!("location:\"{location}\" AND body:({expr})");
                for (group, category) in CATEGORIES.iter().enumerate() {
                    let sql = candidate_sql(exact, category);
                    // Empty MATCH expressions are invalid; an impossible phrase retains the indexed path.
                    let search = if expr.is_empty() {
                        "body:\"00000000000000000000000000000000\""
                    } else {
                        &search
                    };
                    let mut stmt = c.prepare(&sql)?;
                    let rows = stmt.query_map(
                        params![
                            self.scope.namespace,
                            self.scope.location,
                            matching::digest(text),
                            search,
                            serde_json::to_string(metadata)?
                        ],
                        candidate,
                    )?;
                    for row in rows {
                        let (
                            id,
                            revision,
                            assertion,
                            body,
                            metadata,
                            mode,
                            state,
                            disposition,
                            source,
                            latest_observed_at,
                        ) = row?;
                        if let Some(&index) = seen.get(&(id.clone(), assertion)) {
                            if exact {
                                exact_matches[input].push(index);
                            }
                            continue;
                        }
                        if counts[group] == GROUP_LIMIT {
                            break;
                        }
                        sizes[group] += body.len();
                        if sizes[group] > GROUP_BYTES {
                            return Err(invalid("memory candidate byte budget exceeded"));
                        }
                        counts[group] += 1;
                        let index = candidates.len();
                        seen.insert((id.clone(), assertion), index);
                        if exact {
                            exact_matches[input].push(index);
                        }
                        candidates.push(Candidate {
                            id: MemoryId(
                                uuid::Uuid::parse_str(&id).map_err(|e| invalid(e.to_string()))?,
                            ),
                            revision: revision_value(revision)?,
                            assertion: revision_value(assertion)?,
                            body,
                            metadata: serde_json::from_str(&metadata)?,
                            mode: serde_json::from_value(serde_json::Value::String(mode))?,
                            state: serde_json::from_value(serde_json::Value::String(
                                state.clone(),
                            ))?,
                            restricted: disposition != "current" || state == "suppressed",
                            source: serde_json::from_str(&source)?,
                            latest_observed_at,
                        });
                    }
                }
            }
        }
        Ok(Snapshot {
            revision: scope_revision(c, &self.scope)?,
            candidates,
            exact_matches,
        })
    }
}

impl Snapshot {
    pub fn deterministic(&self, writes: &[MemoryWrite]) -> Option<Decisions> {
        let mut result = Vec::new();
        for (i, write) in writes.iter().enumerate() {
            let mut row = Vec::new();
            let suppressed = matches!(write.edit, MemoryEdit::Create { .. })
                && body(&write.edit).is_some_and(|(text, meta)| {
                    self.candidates.iter().enumerate().any(|(j, other)| {
                        other.restricted
                            && meta == &other.metadata
                            && (self.exact_matches[i].contains(&j)
                                || matching::digest(text) == matching::digest(&other.body))
                            && !self.candidates.iter().any(|active| {
                                active.id == other.id
                                    && !active.restricted
                                    && active.metadata == other.metadata
                                    && matching::digest(&active.body)
                                        == matching::digest(&other.body)
                            })
                    })
                });
            if suppressed {
                result.push(vec![
                    Judgment {
                        relation: Relation::Independent,
                        replacement_quote: None
                    };
                    self.candidates.len() + i
                ]);
                continue;
            }
            for (j, other) in self
                .candidates
                .iter()
                .map(|c| Some((c.body.as_str(), &c.metadata)))
                .chain(writes[..i].iter().map(|w| body(&w.edit)))
                .enumerate()
            {
                if j < self.candidates.len()
                    && target(&write.edit).is_some_and(|(id, _)| id == &self.candidates[j].id)
                {
                    row.push(Judgment {
                        relation: Relation::Independent,
                        replacement_quote: None,
                    });
                    continue;
                }
                // Different confirmed aliases can share a deduplicated candidate assertion.
                let known_equivalent = if j < self.candidates.len() {
                    self.exact_matches[i].contains(&j)
                } else {
                    self.exact_matches[i]
                        .iter()
                        .any(|index| self.exact_matches[j - self.candidates.len()].contains(index))
                };
                let relation = match (body(&write.edit), other) {
                    (Some(_), Some(_)) if known_equivalent => Relation::Equivalent,
                    (Some((a, am)), Some((b, bm)))
                        if am == bm && matching::digest(a) == matching::digest(b) =>
                    {
                        Relation::Equivalent
                    }
                    (Some((_, am)), Some((_, bm))) if disjoint(&am.temporal, &bm.temporal) => {
                        Relation::Independent
                    }
                    (None, _) | (_, None) => Relation::Independent,
                    _ => return None,
                };
                row.push(Judgment {
                    relation,
                    replacement_quote: None,
                });
            }
            result.push(row);
        }
        Some(result)
    }
}

pub struct Commit {
    pub scope: Scope,
    pub source_scopes: Vec<Scope>,
    pub writes: Vec<MemoryWrite>,
    pub snapshot: Snapshot,
    pub decisions: Decisions,
    pub operation: uuid::Uuid,
    pub at: i64,
}
fn verified_source(
    c: &Connection,
    scope: &Scope,
    reference: &MemoryEvidenceReference,
    operation: uuid::Uuid,
) -> Result<MemorySource, StoreError> {
    let (text, fact, observed_at) = evidence_source(
        c,
        &scope.namespace,
        &reference.session_id,
        reference.sequence,
        reference.item_index,
    )?;
    if fact != reference.fact_id.to_string()
        || hex::encode(Sha256::digest(text.as_bytes())) != reference.fingerprint
        || reference.quote.is_empty()
        || text.get(reference.start as usize..reference.end as usize)
            != Some(reference.quote.as_str())
    {
        return Err(invalid("memory evidence does not match immutable source"));
    }
    Ok(MemorySource::Conversation {
        reference: reference.clone(),
        observed_at,
        operation_id: operation,
    })
}
fn disjoint(a: &MemoryTemporal, b: &MemoryTemporal) -> bool {
    match (a, b) {
        (
            MemoryTemporal::Interval { start: a, end: ae },
            MemoryTemporal::Interval { start: b, end: be },
        ) => ae.is_some_and(|end| end <= *b) || be.is_some_and(|end| end <= *a),
        _ => false,
    }
}
fn replacement_is_newer(
    incoming: &MemoryMetadata,
    previous: &MemoryMetadata,
    source: &MemorySource,
    latest_observed_at: i64,
) -> bool {
    let temporal = match (&incoming.temporal, &previous.temporal) {
        (MemoryTemporal::Interval { start, .. }, MemoryTemporal::Interval { start: old, .. }) => {
            start > old
        }
        (MemoryTemporal::Timeless, MemoryTemporal::Timeless)
        | (MemoryTemporal::Unspecified, MemoryTemporal::Unspecified) => true,
        _ => false,
    };
    temporal && observed(source) > latest_observed_at
}
fn observed(source: &MemorySource) -> i64 {
    match source {
        MemorySource::Conversation { observed_at, .. }
        | MemorySource::UserOperation { observed_at, .. } => *observed_at,
    }
}
impl Statement for Commit {
    type Value = MemoryBatchResult;
    type Output = MemoryBatchResult;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        self.scope.validate(c)?;
        for scope in &self.source_scopes {
            scope.validate(c)?;
        }
        validate(&self.writes)?;
        if scope_revision(c, &self.scope)? != self.snapshot.revision {
            return Ok(Prepared {
                value: MemoryBatchResult::Retryable {
                    reason: "memory scope changed; resolve again".into(),
                },
                changed: false,
                notification: Notification::NONE,
            });
        }
        if self.decisions.len() != self.writes.len()
            || self
                .decisions
                .iter()
                .enumerate()
                .any(|(i, r)| r.len() != self.snapshot.candidates.len() + i)
        {
            return Err(invalid("invalid memory relation matrix"));
        }
        for candidate in &self.snapshot.candidates {
            let revision: i64 = c.query_row(
                "SELECT revision FROM agent_memories WHERE namespace=? AND scope=? AND id=?",
                params![
                    self.scope.namespace,
                    self.scope.location,
                    candidate.id.0.to_string()
                ],
                |r| r.get(0),
            )?;
            if revision_value(revision)? != candidate.revision {
                return Err(invalid("memory target changed"));
            }
        }
        let sources: Vec<_> = self
            .writes
            .iter()
            .map(|w| match &w.evidence {
                Some(reference) => verified_source(c, &self.scope, reference, self.operation),
                None => Ok(MemorySource::UserOperation {
                    operation_id: self.operation,
                    observed_at: self.at,
                }),
            })
            .collect::<Result<_, _>>()?;
        // Validate every requested edit before writing any item in the batch.
        for write in &self.writes {
            if let Some(result) = preflight(c, &self.scope, &write.edit)? {
                return Ok(Prepared {
                    value: if self.writes.len() == 1 {
                        MemoryBatchResult::Committed {
                            results: vec![result],
                        }
                    } else {
                        MemoryBatchResult::Retryable {
                            reason: "memory target changed or is unavailable".into(),
                        }
                    },
                    changed: false,
                    notification: Notification::NONE,
                });
            }
        }
        c.execute_batch("SAVEPOINT memory_resolution")?;
        let result = self.apply(c, &sources);
        match result {
            Ok(results) => {
                c.execute_batch("RELEASE memory_resolution")?;
                Ok(Prepared {
                    value: MemoryBatchResult::Committed { results },
                    changed: true,
                    notification: Notification::NONE,
                })
            }
            Err(error) => {
                c.execute_batch("ROLLBACK TO memory_resolution; RELEASE memory_resolution")?;
                Err(error)
            }
        }
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
impl Commit {
    fn apply(
        &self,
        c: &Connection,
        sources: &[MemorySource],
    ) -> Result<Vec<MemoryResult>, StoreError> {
        let mut results = Vec::new();
        let mut batch = Vec::<Option<Candidate>>::new();
        for (index, write) in self.writes.iter().enumerate() {
            let Some((text, meta)) = body(&write.edit) else {
                let mut edit = write.edit.clone();
                let (id, expected_revision) = match &mut edit {
                    MemoryEdit::Delete {
                        id,
                        expected_revision,
                    }
                    | MemoryEdit::SetAlways {
                        id,
                        expected_revision,
                        ..
                    }
                    | MemoryEdit::AddEvidence {
                        id,
                        expected_revision,
                        ..
                    } => (id, expected_revision),
                    _ => unreachable!(),
                };
                // External CAS was checked before the batch; only our earlier writes can advance it.
                *expected_revision = self.current(c, id)?.revision;
                let result = UserChange {
                    source_scope: None,
                    scope: self.scope.clone(),
                    edit,
                    operation: self.operation,
                    at: self.at,
                }
                .apply(c)?;
                if matches!(
                    result,
                    MemoryResult::Conflict { .. }
                        | MemoryResult::NotFound
                        | MemoryResult::InvalidState
                ) {
                    return Err(invalid("memory target invalidated within batch"));
                }
                if let MemoryEdit::Delete { id, .. } = &write.edit
                    && matches!(result, MemoryResult::Deleted { .. })
                {
                    // Follow assertion identities so an old relation cannot delete a newer user correction.
                    c.execute("WITH RECURSIVE related(id,assertion) AS (SELECT id,revision FROM agent_memory_versions WHERE namespace=?1 AND scope=?2 AND id=?3 UNION SELECT r.id,r.assertion FROM agent_memory_relations r JOIN related x ON r.target=x.id AND r.target_assertion=x.assertion WHERE r.namespace=?1 AND r.scope=?2) UPDATE agent_memory_versions SET disposition='suppressed' WHERE namespace=?1 AND scope=?2 AND (id,revision) IN (SELECT id,assertion FROM related)",params![self.scope.namespace,self.scope.location,id.0.to_string()])?;
                    c.execute("WITH RECURSIVE related(id,assertion) AS (SELECT id,revision FROM agent_memory_versions WHERE namespace=?1 AND scope=?2 AND id=?3 UNION SELECT r.id,r.assertion FROM agent_memory_relations r JOIN related x ON r.target=x.id AND r.target_assertion=x.assertion WHERE r.namespace=?1 AND r.scope=?2) UPDATE agent_memories SET state='suppressed',mode='user_recall',revision=revision+1 WHERE namespace=?1 AND scope=?2 AND (id,assertion) IN (SELECT id,assertion FROM related) AND state<>'suppressed'",params![self.scope.namespace,self.scope.location,id.0.to_string()])?;
                }
                results.push(result);
                batch.push(None);
                continue;
            };
            if matches!(write.edit, MemoryEdit::Create { .. })
                && let Some((id, assertion)) = matching::restricted(c, &self.scope, text, meta)?
            {
                let mut other = self.assertion(c, &id, assertion)?;
                other.body = text.into();
                results.push(MemoryResult::Suppressed);
                batch.push(Some(other));
                continue;
            }
            let mut equivalent = None;
            let mut equivalent_targets = Vec::new();
            let mut replace = None;
            let mut conflicts = Vec::new();
            let mut suppressed = None;
            for (j, judgment) in self.decisions[index].iter().enumerate() {
                let other = if j < self.snapshot.candidates.len() {
                    Some(&self.snapshot.candidates[j])
                } else {
                    batch[j - self.snapshot.candidates.len()].as_ref()
                };
                let Some(other) = other else { continue };
                // Earlier writes can protect, correct or delete a snapshot assertion.
                let mut refreshed;
                let other = if index > 0 {
                    refreshed = self.assertion(c, &other.id, other.assertion)?;
                    refreshed.body = other.body.clone();
                    &refreshed
                } else {
                    other
                };
                if target(&write.edit).is_some_and(|(id, _)| id == &other.id) {
                    continue;
                }
                let identical = meta == &other.metadata && c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_memory_matches WHERE namespace=? AND scope=? AND id=? AND assertion=? AND digest=?)",
                    params![self.scope.namespace, self.scope.location, other.id.0.to_string(), other.assertion.0 as i64, matching::digest(text)],
                    |r| r.get::<_, bool>(0),
                )?;
                let relation = if identical {
                    &Relation::Equivalent
                } else {
                    &judgment.relation
                };
                if other.restricted {
                    if matching::restored(c, &self.scope, &other.id, other.assertion)?
                        || self.restores(c, &write.edit, other)?
                    {
                        continue;
                    }
                    let active = self.current(c, &other.id)?;
                    if !active.restricted
                        && active.state == MemoryState::Active
                        && active.metadata == other.metadata
                        && c.query_row(
                            "SELECT EXISTS(SELECT 1 FROM agent_memory_matches WHERE namespace=? AND scope=? AND id=? AND assertion=? AND digest=?)",
                            params![self.scope.namespace, self.scope.location, other.id.0.to_string(), other.assertion.0 as i64, matching::digest(&active.body)],
                            |r| r.get::<_, bool>(0),
                        )?
                    {
                        continue;
                    }
                }
                match relation {
                    Relation::Independent | Relation::Supplement => {}
                    Relation::Equivalent if meta != &other.metadata => {
                        return Err(invalid("equivalence crosses assertion metadata"));
                    }
                    Relation::Equivalent if other.restricted => {
                        if self.match_text(c, other, text)? != 0 {
                            self.bump(c)?;
                        }
                        let mut matched = other.clone();
                        matched.body = text.into();
                        suppressed = Some(matched);
                    }
                    Relation::Equivalent if other.state != MemoryState::Suppressed => {
                        equivalent_targets.push(other.clone());
                        // A target-bound edit cannot retire another protected identity or silently change its own ID.
                        if target(&write.edit).is_some() {
                            conflicts.push(other.clone());
                            continue;
                        }
                        if equivalent
                            .as_ref()
                            .is_some_and(|old: &Candidate| old.id != other.id)
                        {
                            conflicts.push(other.clone());
                        } else {
                            equivalent = Some(other.clone());
                        }
                    }
                    Relation::Replaces
                        if write.evidence.is_some()
                            && !other.restricted
                            && other.state == MemoryState::Active
                            && other.mode == MemoryMode::AutoRecall
                            && meta.kind == other.metadata.kind
                            && meta.statement == other.metadata.statement
                            && replacement_is_newer(
                                meta,
                                &other.metadata,
                                &sources[index],
                                other.latest_observed_at,
                            ) =>
                    {
                        let quote = judgment
                            .replacement_quote
                            .as_deref()
                            .filter(|q| !q.trim().is_empty())
                            .ok_or_else(|| invalid("replacement requires explicit source quote"))?;
                        if !write
                            .evidence
                            .as_ref()
                            .is_some_and(|r| r.quote.contains(quote))
                        {
                            return Err(invalid("replacement quote is not in verified evidence"));
                        }
                        if replace.as_ref().is_some_and(|old: &Candidate| {
                            old.id != other.id || old.assertion != other.assertion
                        }) {
                            return Err(invalid("ambiguous replacement targets"));
                        }
                        replace = Some(other.clone());
                    }
                    _ => conflicts.push(other.clone()),
                }
            }
            if let Some(other) = suppressed {
                results.push(MemoryResult::Suppressed);
                batch.push(Some(other));
                continue;
            }
            if equivalent.is_some() && replace.is_some() {
                return Err(invalid("incompatible memory actions"));
            }
            if let Some(current) = equivalent.as_ref().or(replace.as_ref()) {
                conflicts.retain(|other| other.id != current.id || !other.restricted);
            }
            if let Some(other) = self.active_restore_target(c, &write.edit)? {
                equivalent_targets.push(other.clone());
                conflicts.push(other);
            }
            let source = &sources[index];
            let (result, current) = if !conflicts.is_empty() {
                let record = if let Some(other) = equivalent
                    .as_ref()
                    .filter(|other| other.state == MemoryState::Unresolved)
                {
                    self.evidence(c, other, text, source, write.evidence.is_none())?;
                    self.current(c, &other.id)?
                } else {
                    self.insert(
                        c,
                        text,
                        meta,
                        source,
                        MemoryState::Unresolved,
                        write.evidence.is_some(),
                    )?
                };
                for other in &conflicts {
                    self.relate(c, &record, other, "conflict")?;
                }
                for other in &equivalent_targets {
                    if other.id != record.id {
                        self.relate(c, &record, other, "equivalent")?;
                    }
                }
                if let Some((id, _)) = target(&write.edit) {
                    self.relate(c, &record, &self.current(c, id)?, "conflict")?;
                }
                (
                    MemoryResult::Unresolved {
                        id: record.id.clone(),
                        revision: record.revision,
                    },
                    record,
                )
            } else if let Some(other) = equivalent {
                self.evidence(c, &other, text, source, write.evidence.is_none())?;
                let current = self.current(c, &other.id)?;
                (
                    MemoryResult::EvidenceAdded {
                        id: current.id.clone(),
                        revision: current.revision,
                    },
                    current,
                )
            } else if let Some(other) = replace {
                let current = self.revise(
                    c,
                    &other.id,
                    self.current(c, &other.id)?.revision,
                    text,
                    meta,
                    source,
                    true,
                    false,
                )?;
                (
                    MemoryResult::Revised {
                        id: current.id.clone(),
                        revision: current.revision,
                    },
                    current,
                )
            } else if let Some((id, _)) = target(&write.edit) {
                let current = self.revise(
                    c,
                    id,
                    self.current(c, id)?.revision,
                    text,
                    meta,
                    source,
                    false,
                    matches!(write.edit, MemoryEdit::Restore { .. }),
                )?;
                (
                    MemoryResult::Revised {
                        id: current.id.clone(),
                        revision: current.revision,
                    },
                    current,
                )
            } else {
                let current = self.insert(
                    c,
                    text,
                    meta,
                    source,
                    MemoryState::Active,
                    write.evidence.is_some(),
                )?;
                (
                    MemoryResult::Created {
                        id: current.id.clone(),
                        revision: current.revision,
                    },
                    current,
                )
            };
            results.push(result);
            batch.push(Some(current));
        }
        Ok(results)
    }
    fn active_restore_target(
        &self,
        c: &Connection,
        edit: &MemoryEdit,
    ) -> Result<Option<Candidate>, StoreError> {
        let MemoryEdit::Restore {
            id, body, metadata, ..
        } = edit
        else {
            return Ok(None);
        };
        let sql = format!(
            "{} SELECT m.id FROM equivalent e JOIN agent_memories m ON m.namespace=?1 AND m.scope=?2 AND m.id=e.id JOIN agent_memory_versions current ON current.namespace=m.namespace AND current.scope=m.scope AND current.id=m.id AND current.revision=m.assertion JOIN agent_memory_matches known ON known.namespace=m.namespace AND known.scope=m.scope AND known.id=m.id AND known.assertion=e.assertion AND known.digest=current.digest WHERE m.id<>?3 AND m.state='active' AND json(current.metadata)=json(?5) LIMIT 1",
            matching::EQUIVALENT_HISTORY
        );
        let target: Option<String> = c
            .query_row(
                &sql,
                params![
                    self.scope.namespace,
                    self.scope.location,
                    id.0.to_string(),
                    matching::digest(body),
                    serde_json::to_string(metadata)?
                ],
                |r| r.get(0),
            )
            .optional()?;
        target
            .map(|id| {
                self.current(
                    c,
                    &MemoryId(uuid::Uuid::parse_str(&id).map_err(|e| invalid(e.to_string()))?),
                )
            })
            .transpose()
    }
    fn restores(
        &self,
        c: &Connection,
        edit: &MemoryEdit,
        other: &Candidate,
    ) -> Result<bool, StoreError> {
        let MemoryEdit::Restore {
            id, body, metadata, ..
        } = edit
        else {
            return Ok(false);
        };
        Ok(c.query_row(
            &format!(
                "{} SELECT EXISTS(SELECT 1 FROM equivalent WHERE id=?6 AND assertion=?7)",
                matching::EQUIVALENT_HISTORY
            ),
            params![
                self.scope.namespace,
                self.scope.location,
                id.0.to_string(),
                matching::digest(body),
                serde_json::to_string(metadata)?,
                other.id.0.to_string(),
                other.assertion.0 as i64
            ],
            |r| r.get(0),
        )?)
    }
    fn bump(&self, c: &Connection) -> Result<(), StoreError> {
        c.execute("INSERT INTO agent_memory_scopes(namespace,scope,revision) VALUES(?,?,1) ON CONFLICT(namespace,scope) DO UPDATE SET revision=revision+1",params![self.scope.namespace,self.scope.location])?;
        Ok(())
    }
    fn current(&self, c: &Connection, id: &MemoryId) -> Result<Candidate, StoreError> {
        self.load_assertion(c, id, None)
    }
    fn assertion(
        &self,
        c: &Connection,
        id: &MemoryId,
        assertion: MemoryRevision,
    ) -> Result<Candidate, StoreError> {
        self.load_assertion(c, id, Some(assertion))
    }
    fn load_assertion(
        &self,
        c: &Connection,
        id: &MemoryId,
        assertion: Option<MemoryRevision>,
    ) -> Result<Candidate, StoreError> {
        let sql = format!(
            "SELECT {COLUMNS} FROM agent_memories m JOIN agent_memory_versions v ON v.namespace=m.namespace AND v.scope=m.scope AND v.id=m.id AND v.revision=COALESCE(?4,m.assertion) WHERE m.namespace=?1 AND m.scope=?2 AND m.id=?3"
        );
        let (
            _,
            revision,
            assertion,
            body,
            metadata,
            mode,
            state,
            disposition,
            source,
            latest_observed_at,
        ) = c.query_row(
            &sql,
            params![
                self.scope.namespace,
                self.scope.location,
                id.0.to_string(),
                assertion.map(|r| r.0 as i64)
            ],
            candidate,
        )?;
        Ok(Candidate {
            id: id.clone(),
            revision: revision_value(revision)?,
            assertion: revision_value(assertion)?,
            body,
            metadata: serde_json::from_str(&metadata)?,
            mode: serde_json::from_value(serde_json::Value::String(mode))?,
            state: serde_json::from_value(serde_json::Value::String(state))?,
            restricted: disposition != "current",
            source: serde_json::from_str(&source)?,
            latest_observed_at,
        })
    }
    fn insert(
        &self,
        c: &Connection,
        text: &str,
        meta: &MemoryMetadata,
        source: &MemorySource,
        state: MemoryState,
        automatic: bool,
    ) -> Result<Candidate, StoreError> {
        let id = MemoryId(uuid::Uuid::new_v4());
        let key = id.0.to_string();
        c.execute("INSERT INTO agent_memories(namespace,scope,id,revision,assertion,mode,state,created_at,modified_at) VALUES(?,?,?,1,1,?,?,?,?)",params![self.scope.namespace,self.scope.location,key,if automatic {"auto_recall"}else{"user_recall"},if state==MemoryState::Active {"active"}else{"unresolved"},self.at,self.at])?;
        c.execute("INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,digest,disposition,metadata,method) VALUES(?,?,?,1,?,?,?,'current',?,?)",params![self.scope.namespace,self.scope.location,key,text,serde_json::to_string(source)?,matching::digest(text),serde_json::to_string(meta)?,if automatic {"extraction"}else{"user_input"}])?;
        self.initial_evidence(c, &id, MemoryRevision(1), source)?;
        self.bump(c)?;
        self.current(c, &id)
    }
    fn initial_evidence(
        &self,
        c: &Connection,
        id: &MemoryId,
        assertion: MemoryRevision,
        source: &MemorySource,
    ) -> Result<bool, StoreError> {
        let key = match source {
            MemorySource::Conversation { reference, .. } => {
                hex::encode(Sha256::digest(serde_json::to_vec(reference)?))
            }
            MemorySource::UserOperation { operation_id, .. } => format!("user:{operation_id}"),
        };
        let inserted=c.execute("INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key) VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,scope,id,assertion,source_key) DO NOTHING",params![self.scope.namespace,self.scope.location,id.0.to_string(),assertion.0 as i64,serde_json::to_string(source)?,key])?;
        Ok(inserted != 0)
    }
    fn match_text(
        &self,
        c: &Connection,
        other: &Candidate,
        text: &str,
    ) -> Result<usize, StoreError> {
        Ok(c.execute("INSERT OR IGNORE INTO agent_memory_matches(namespace,scope,id,assertion,body,digest) VALUES(?,?,?,?,?,?)", params![self.scope.namespace, self.scope.location, other.id.0.to_string(), other.assertion.0 as i64, text, matching::digest(text)])?)
    }
    fn evidence(
        &self,
        c: &Connection,
        other: &Candidate,
        text: &str,
        source: &MemorySource,
        user: bool,
    ) -> Result<(), StoreError> {
        let current = self.current(c, &other.id)?;
        if current.state == MemoryState::Suppressed || current.assertion != other.assertion {
            return Err(invalid("memory assertion no longer active"));
        }
        let alias = self.match_text(c, other, text)?;
        let inserted = self.initial_evidence(c, &other.id, other.assertion, source)?;
        if alias == 0 && !inserted && !(user && current.mode == MemoryMode::AutoRecall) {
            return Ok(());
        }
        c.execute("UPDATE agent_memories SET revision=revision+1,mode=CASE WHEN ?1 AND mode='auto_recall' THEN 'user_recall' ELSE mode END WHERE namespace=?2 AND scope=?3 AND id=?4",params![user,self.scope.namespace,self.scope.location,other.id.0.to_string()])?;
        self.bump(c)
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "one assertion and its explicit write authority"
    )]
    fn revise(
        &self,
        c: &Connection,
        id: &MemoryId,
        revision: MemoryRevision,
        text: &str,
        meta: &MemoryMetadata,
        source: &MemorySource,
        automatic: bool,
        restore: bool,
    ) -> Result<Candidate, StoreError> {
        let edit = if restore {
            MemoryEdit::Restore {
                id: id.clone(),
                expected_revision: revision,
                body: text.into(),
                metadata: meta.clone(),
            }
        } else {
            MemoryEdit::Correct {
                id: id.clone(),
                expected_revision: revision,
                body: text.into(),
                metadata: meta.clone(),
            }
        };
        let result = UserChange {
            source_scope: None,
            scope: self.scope.clone(),
            edit,
            operation: self.operation,
            at: self.at,
        }
        .apply(c)?;
        let MemoryResult::Saved { revision, .. } = result else {
            return Err(invalid("memory revision rejected"));
        };
        c.execute("INSERT OR IGNORE INTO agent_memory_matches(namespace,scope,id,assertion,body,digest) SELECT aliases.namespace,aliases.scope,aliases.id,?4,aliases.body,aliases.digest FROM agent_memory_matches known JOIN agent_memory_versions v ON v.namespace=known.namespace AND v.scope=known.scope AND v.id=known.id AND v.revision=known.assertion JOIN agent_memory_matches aliases ON aliases.namespace=known.namespace AND aliases.scope=known.scope AND aliases.id=known.id AND aliases.assertion=known.assertion WHERE known.namespace=?1 AND known.scope=?2 AND known.id=?3 AND known.assertion<>?4 AND known.digest=?5 AND json(v.metadata)=json(?6)", params![self.scope.namespace,self.scope.location,id.0.to_string(),revision.0 as i64,matching::digest(text),serde_json::to_string(meta)?])?;
        if restore {
            let copy = format!(
                "{} INSERT OR IGNORE INTO agent_memory_matches(namespace,scope,id,assertion,body,digest) SELECT a.namespace,a.scope,?3,?6,a.body,a.digest FROM equivalent e JOIN agent_memory_matches a ON a.namespace=?1 AND a.scope=?2 AND a.id=e.id AND a.assertion=e.assertion",
                matching::EQUIVALENT_HISTORY
            );
            c.execute(
                &copy,
                params![
                    self.scope.namespace,
                    self.scope.location,
                    id.0.to_string(),
                    matching::digest(text),
                    serde_json::to_string(meta)?,
                    revision.0 as i64
                ],
            )?;
            let authorize = format!(
                "{} INSERT OR IGNORE INTO agent_memory_relations(namespace,scope,id,assertion,target,target_assertion,kind) SELECT ?1,?2,e.id,e.assertion,?3,?6,'restored' FROM equivalent e JOIN agent_memory_versions v ON v.namespace=?1 AND v.scope=?2 AND v.id=e.id AND v.revision=e.assertion WHERE v.disposition<>'current'",
                matching::EQUIVALENT_HISTORY
            );
            c.execute(
                &authorize,
                params![
                    self.scope.namespace,
                    self.scope.location,
                    id.0.to_string(),
                    matching::digest(text),
                    serde_json::to_string(meta)?,
                    revision.0 as i64
                ],
            )?;
        }
        c.execute("UPDATE agent_memory_versions SET source=?1,method=?2 WHERE namespace=?3 AND scope=?4 AND id=?5 AND revision=?6",params![serde_json::to_string(source)?,if automatic {"extraction"}else{"user_input"},self.scope.namespace,self.scope.location,id.0.to_string(),revision.0 as i64])?;
        c.execute("DELETE FROM agent_memory_evidence WHERE namespace=? AND scope=? AND id=? AND assertion=?",params![self.scope.namespace,self.scope.location,id.0.to_string(),revision.0 as i64])?;
        self.initial_evidence(c, id, revision, source)?;
        if automatic {
            c.execute("UPDATE agent_memories SET mode='auto_recall' WHERE namespace=? AND scope=? AND id=?",params![self.scope.namespace,self.scope.location,id.0.to_string()])?;
        }
        self.current(c, id)
    }
    fn relate(
        &self,
        c: &Connection,
        record: &Candidate,
        other: &Candidate,
        kind: &str,
    ) -> Result<(), StoreError> {
        c.execute("INSERT OR IGNORE INTO agent_memory_relations(namespace,scope,id,assertion,target,target_assertion,kind) VALUES(?,?,?,?,?,?,?)",params![self.scope.namespace,self.scope.location,record.id.0.to_string(),record.assertion.0 as i64,other.id.0.to_string(),other.assertion.0 as i64,kind])?;
        Ok(())
    }
}

pub struct SingleCommit(pub Commit);
impl Statement for SingleCommit {
    type Value = MemoryResult;
    type Output = MemoryResult;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let result = self.0.execute(c)?;
        let value = match result.value {
            MemoryBatchResult::Retryable { reason } => MemoryResult::Retryable { reason },
            MemoryBatchResult::Committed { mut results } => match results.remove(0) {
                MemoryResult::Created { id, revision } | MemoryResult::Revised { id, revision } => {
                    MemoryResult::Saved { id, revision }
                }
                result => result,
            },
        };
        Ok(Prepared {
            value,
            changed: result.changed,
            notification: result.notification,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        for sql in [
            include_str!("../../migrations/0043_memory.sql"),
            include_str!("../../migrations/0044_memory_metadata.sql"),
            include_str!("../../migrations/0045_memory_evidence.sql"),
            include_str!("../../migrations/0046_memory_resolution.sql"),
        ] {
            c.execute_batch(sql).unwrap();
        }
        c
    }
    fn scope() -> Scope {
        Scope {
            namespace: "host/agent".into(),
            location: "personal".into(),
            binding: None,
        }
    }
    fn write(text: &str) -> MemoryWrite {
        MemoryWrite {
            edit: MemoryEdit::Create {
                body: text.into(),
                metadata: MemoryMetadata::default(),
            },
            evidence: None,
        }
    }
    fn inspect(c: &Connection, writes: &[MemoryWrite]) -> Snapshot {
        Inspect {
            scope: scope(),
            writes: writes.into(),
        }
        .execute(c)
        .unwrap()
    }
    fn decisions(snapshot: &Snapshot, writes: &[MemoryWrite], relation: Relation) -> Decisions {
        writes
            .iter()
            .enumerate()
            .map(|(i, _)| {
                (0..snapshot.candidates.len() + i)
                    .map(|_| Judgment {
                        relation: relation.clone(),
                        replacement_quote: None,
                    })
                    .collect()
            })
            .collect()
    }
    fn commit(c: &Connection, writes: Vec<MemoryWrite>, relation: Relation) -> Vec<MemoryResult> {
        let snapshot = inspect(c, &writes);
        let decisions = decisions(&snapshot, &writes, relation);
        let MemoryBatchResult::Committed { results } = Commit {
            scope: scope(),
            source_scopes: vec![],
            writes,
            snapshot,
            decisions,
            operation: uuid::Uuid::new_v4(),
            at: 100,
        }
        .execute(c)
        .unwrap()
        .value
        else {
            panic!()
        };
        results
    }
    fn id(result: &MemoryResult) -> MemoryId {
        match result {
            MemoryResult::Created { id, .. }
            | MemoryResult::Revised { id, .. }
            | MemoryResult::Unresolved { id, .. }
            | MemoryResult::EvidenceAdded { id, .. } => id.clone(),
            _ => panic!("{result:?}"),
        }
    }
    #[test]
    fn semantic_spelling_and_batch_equivalence_reuse_one_assertion() {
        let c = db();
        let writes = vec![
            write("Use PostgreSQL for project storage"),
            write("Use Postgres for project storage"),
        ];
        let result = commit(&c, writes, Relation::Equivalent);
        assert_eq!(id(&result[0]), id(&result[1]));
        assert_eq!(
            Page {
                scope: scope(),
                after: None,
                limit: 10
            }
            .execute(&c)
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM agent_memory_versions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let snapshot = inspect(&c, &[write("Use Postgress for project storage")]);
        assert_eq!(snapshot.candidates.len(), 1);
        let result = commit(
            &c,
            vec![write("Use Postgress for project storage")],
            Relation::Equivalent,
        );
        assert!(matches!(result[0], MemoryResult::EvidenceAdded { .. }));
    }
    #[test]
    fn scope_revision_rejects_concurrent_insert_and_delete_without_writes() {
        let c = db();
        let writes = vec![write("Use PostgreSQL")];
        let snapshot = inspect(&c, &writes);
        let plan = Commit {
            scope: scope(),
            source_scopes: vec![],
            decisions: decisions(&snapshot, &writes, Relation::Independent),
            writes,
            snapshot,
            operation: uuid::Uuid::new_v4(),
            at: 100,
        };
        commit(&c, vec![write("Use Postgres")], Relation::Independent);
        assert!(matches!(
            plan.execute(&c).unwrap().value,
            MemoryBatchResult::Retryable { .. }
        ));
        assert_eq!(
            c.query_row("SELECT count(*) FROM agent_memories", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let writes = vec![write("Use PostgreSQL")];
        let snapshot = inspect(&c, &writes);
        let old = snapshot.candidates[0].clone();
        let plan = Commit {
            scope: scope(),
            source_scopes: vec![],
            decisions: decisions(&snapshot, &writes, Relation::Equivalent),
            writes,
            snapshot,
            operation: uuid::Uuid::new_v4(),
            at: 100,
        };
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Delete {
                    id: old.id,
                    expected_revision: old.revision,
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        assert!(matches!(
            plan.execute(&c).unwrap().value,
            MemoryBatchResult::Retryable { .. }
        ));
    }
    #[test]
    fn protected_conflicts_are_unresolved_and_deleting_target_suppresses_them() {
        let c = db();
        let saved = commit(
            &c,
            vec![write("Default language is Chinese")],
            Relation::Independent,
        );
        let target = id(&saved[0]);
        let conflict = commit(
            &c,
            vec![write("Default language is English")],
            Relation::Conflict,
        );
        assert!(matches!(conflict[0], MemoryResult::Unresolved { .. }));
        let visible = Page {
            scope: scope(),
            after: None,
            limit: 10,
        }
        .execute(&c)
        .unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, target);
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Delete {
                    id: target,
                    expected_revision: MemoryRevision(1),
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM agent_memories WHERE state='suppressed'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        let blocked = commit(
            &c,
            vec![write("Default language Chinese")],
            Relation::Equivalent,
        );
        assert!(matches!(blocked[0], MemoryResult::Suppressed));
    }
    #[test]
    fn deleting_old_conflict_target_preserves_user_resolved_fact() {
        let c = db();
        let target = id(&commit(
            &c,
            vec![write("Default language Chinese")],
            Relation::Independent,
        )[0]);
        let pending = id(&commit(
            &c,
            vec![write("Default language English")],
            Relation::Conflict,
        )[0]);
        let writes = vec![write("Default language English for work")];
        let snapshot = inspect(&c, &writes);
        let mut matrix = decisions(&snapshot, &writes, Relation::Independent);
        for (j, candidate) in snapshot.candidates.iter().enumerate() {
            if candidate.id == pending {
                matrix[0][j].relation = Relation::Conflict;
            }
        }
        Commit {
            scope: scope(),
            source_scopes: vec![],
            writes,
            snapshot,
            decisions: matrix,
            operation: uuid::Uuid::new_v4(),
            at: 100,
        }
        .execute(&c)
        .unwrap();
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Correct {
                    id: pending.clone(),
                    expected_revision: MemoryRevision(1),
                    body: "Prefer Python for scripting".into(),
                    metadata: Default::default(),
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Delete {
                    id: target,
                    expected_revision: MemoryRevision(1),
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        let current = record(&c, &scope(), &pending).unwrap().unwrap();
        assert_eq!(current.body, "Prefer Python for scripting");
        assert_eq!(current.mode, MemoryMode::UserRecall);
        assert!(
            PendingPage(Page {
                scope: scope(),
                after: None,
                limit: 10
            })
            .execute(&c)
            .unwrap()
            .is_empty()
        );
    }
    #[test]
    fn pending_conflict_retains_equivalent_target_for_deletion() {
        let c = db();
        let target = id(&commit(&c, vec![write("我使用中文交流")], Relation::Independent)[0]);
        commit(
            &c,
            vec![write("Default language is English")],
            Relation::Independent,
        );
        let writes = vec![write("我使用中文交流 / Default language is Chinese")];
        let snapshot = inspect(&c, &writes);
        let mut matrix = decisions(&snapshot, &writes, Relation::Conflict);
        for (j, candidate) in snapshot.candidates.iter().enumerate() {
            if candidate.id == target {
                matrix[0][j].relation = Relation::Equivalent;
            }
        }
        let MemoryBatchResult::Committed { results } = Commit {
            scope: scope(),
            source_scopes: vec![],
            writes,
            snapshot,
            decisions: matrix,
            operation: uuid::Uuid::new_v4(),
            at: 100,
        }
        .execute(&c)
        .unwrap()
        .value
        else {
            panic!()
        };
        assert!(matches!(results[0], MemoryResult::Unresolved { .. }));
        let conflict_only = commit(
            &c,
            vec![write("Default language German")],
            Relation::Conflict,
        );
        assert!(matches!(conflict_only[0], MemoryResult::Unresolved { .. }));
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Delete {
                    id: target.clone(),
                    expected_revision: MemoryRevision(1),
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        assert!(
            PendingPage(Page {
                scope: scope(),
                after: None,
                limit: 10
            })
            .execute(&c)
            .unwrap()
            .is_empty()
        );
        assert!(matches!(
            commit(
                &c,
                vec![write("我使用中文交流 / Default language is Chinese")],
                Relation::Independent
            )[0],
            MemoryResult::Suppressed
        ));
        let restored = commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Restore {
                    id: target.clone(),
                    expected_revision: MemoryRevision(2),
                    body: "我使用中文交流".into(),
                    metadata: Default::default(),
                },
                evidence: None,
            }],
            Relation::Equivalent,
        );
        assert!(matches!(restored[0], MemoryResult::Revised { .. }));
        assert!(matches!(
            commit(
                &c,
                vec![write("Default language German")],
                Relation::Independent
            )[0],
            MemoryResult::Suppressed
        ));
        let alias = commit(
            &c,
            vec![write("我使用中文交流 / Default language is Chinese")],
            Relation::Independent,
        );
        assert!(matches!(alias[0], MemoryResult::EvidenceAdded { .. }));
        assert_eq!(id(&alias[0]), target);
        let revision = record(&c, &scope(), &target).unwrap().unwrap().revision;
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Correct {
                    id: target.clone(),
                    expected_revision: revision,
                    body: "我使用中文交流".into(),
                    metadata: Default::default(),
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        let repeated = commit(
            &c,
            vec![write("我使用中文交流 / Default language is Chinese")],
            Relation::Independent,
        );
        assert!(matches!(repeated[0], MemoryResult::EvidenceAdded { .. }));
        assert_eq!(id(&repeated[0]), target);
        let current = record(&c, &scope(), &target).unwrap().unwrap();
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Delete {
                    id: target,
                    expected_revision: current.revision,
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        assert!(matches!(
            commit(
                &c,
                vec![write("我使用中文交流 / Default language is Chinese")],
                Relation::Independent
            )[0],
            MemoryResult::Suppressed
        ));
    }
    #[test]
    fn confirmed_aliases_in_one_batch_do_not_require_semantic_resolution() {
        let c = db();
        let original = "Use PostgreSQL for storage";
        let alias = "Use Postgres for storage";
        let target = id(&commit(&c, vec![write(original)], Relation::Independent)[0]);
        assert_eq!(
            id(&commit(&c, vec![write(alias)], Relation::Equivalent)[0]),
            target
        );
        for suppressed in [false, true] {
            if suppressed {
                let revision = record(&c, &scope(), &target).unwrap().unwrap().revision;
                commit(
                    &c,
                    vec![MemoryWrite {
                        edit: MemoryEdit::Delete {
                            id: target.clone(),
                            expected_revision: revision,
                        },
                        evidence: None,
                    }],
                    Relation::Independent,
                );
                commit(
                    &c,
                    vec![write("Use MongoDB for storage")],
                    Relation::Independent,
                );
            }
            for texts in [[original, alias], [alias, original]] {
                let writes = texts.into_iter().map(write).collect::<Vec<_>>();
                let snapshot = inspect(&c, &writes);
                let decisions = snapshot
                    .deterministic(&writes)
                    .expect("confirmed aliases have a known assertion identity");
                let MemoryBatchResult::Committed { results } = Commit {
                    scope: scope(),
                    source_scopes: vec![],
                    writes,
                    snapshot,
                    decisions,
                    operation: uuid::Uuid::new_v4(),
                    at: 100,
                }
                .execute(&c)
                .unwrap()
                .value
                else {
                    panic!()
                };
                for result in results {
                    if suppressed {
                        assert!(matches!(result, MemoryResult::Suppressed));
                    } else {
                        assert!(matches!(result, MemoryResult::EvidenceAdded { .. }));
                        assert_eq!(id(&result), target);
                    }
                }
            }
        }
        let unknown = vec![write("Use PostgreSQL on my servers")];
        assert!(inspect(&c, &unknown).deterministic(&unknown).is_none());
    }
    #[test]
    fn candidate_reads_do_not_scan_unrelated_history() {
        let c = db();
        c.set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_ENABLE_QPSG,
            true,
        )
        .unwrap();
        let metadata = serde_json::to_string(&MemoryMetadata::default()).unwrap();
        let source = serde_json::to_string(&MemorySource::UserOperation {
            operation_id: uuid::Uuid::nil(),
            observed_at: 0,
        })
        .unwrap();
        let mut previous = 0;
        let mut baseline = Vec::new();
        for count in [100, 10_000] {
            c.execute_batch("BEGIN").unwrap();
            for i in previous..count {
                let id = uuid::Uuid::from_u128(i + 1).to_string();
                let text = if i < 3 {
                    "xyz".to_owned()
                } else {
                    format!("aaaa bbbb cccc {i}")
                };
                let (mode, state, disposition) = match i % 3 {
                    0 => ("auto_recall", "active", "current"),
                    1 => ("user_recall", "active", "current"),
                    _ => ("auto_recall", "suppressed", "suppressed"),
                };
                c.execute(
                    "INSERT INTO agent_memories VALUES('host/agent','personal',?1,1,1,?2,?3,0,0)",
                    params![id, mode, state],
                )
                .unwrap();
                c.execute(
                    "INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,digest,disposition,metadata) VALUES('host/agent','personal',?1,1,?2,?3,?4,?5,?6)",
                    params![id, text, source, matching::digest(&text), disposition, metadata],
                )
                .unwrap();
            }
            c.execute_batch("COMMIT").unwrap();
            let mut steps = Vec::new();
            for exact in [true, false] {
                for (group, category) in CATEGORIES.iter().enumerate() {
                    for text in ["xyz", "xyzz", "qzx"] {
                        let sql = candidate_sql(exact, category);
                        let search = format!(
                            "location:\"host/agent:personal\" AND body:({})",
                            expression(text)
                        );
                        let mut stmt = c.prepare(&sql).unwrap();
                        let ids = stmt
                            .query_map(
                                params![
                                    "host/agent",
                                    "personal",
                                    matching::digest(text),
                                    search,
                                    metadata
                                ],
                                |r| r.get::<_, String>(0),
                            )
                            .unwrap()
                            .collect::<rusqlite::Result<Vec<_>>>()
                            .unwrap();
                        let hit = text == "xyz" || (!exact && text == "xyzz");
                        let expected = if hit {
                            vec![uuid::Uuid::from_u128(group as u128 + 1).to_string()]
                        } else {
                            vec![]
                        };
                        assert_eq!(ids, expected);
                        steps.push(stmt.get_status(rusqlite::StatementStatus::VmStep));
                    }
                }
            }
            for (sql, target) in [
                (matching::restricted_sql(), 3),
                (matching::CURRENT_SQL.to_owned(), 1),
            ] {
                for text in ["xyz", "qzx"] {
                    let mut stmt = c.prepare(&sql).unwrap();
                    let ids = stmt
                        .query_map(
                            params!["host/agent", "personal", matching::digest(text), metadata],
                            |r| r.get::<_, String>(0),
                        )
                        .unwrap()
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .unwrap();
                    let expected = if text == "xyz" {
                        vec![uuid::Uuid::from_u128(target).to_string()]
                    } else {
                        vec![]
                    };
                    assert_eq!(ids, expected);
                    steps.push(stmt.get_status(rusqlite::StatementStatus::VmStep));
                }
            }
            if baseline.is_empty() {
                baseline = steps;
            } else {
                for (query, (before, after)) in baseline.iter().zip(steps).enumerate() {
                    assert!(
                        after <= before * 2 + 100,
                        "candidate query {query} VM steps grew from {before} to {after}"
                    );
                }
            }
            previous = count;
        }
        assert_eq!(inspect(&c, &[write("xyzz")]).candidates.len(), 3);
    }
    #[test]
    fn restricted_candidates_have_a_separate_budget_and_multilingual_index() {
        let c = db();
        let first = commit(
            &c,
            vec![write("数据库使用 PostgreSQL")],
            Relation::Independent,
        );
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Delete {
                    id: id(&first[0]),
                    expected_revision: MemoryRevision(1),
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        for i in 0..12 {
            commit(
                &c,
                vec![write(&format!("数据库使用 independent {i}"))],
                Relation::Independent,
            );
        }
        c.execute(
            "UPDATE agent_memories SET mode='auto_recall' WHERE state='active'",
            [],
        )
        .unwrap();
        let snapshot = inspect(&c, &[write("数据库使用 Postgres")]);
        assert!(snapshot.candidates.iter().any(|c| c.restricted));
        assert_eq!(
            snapshot.candidates.iter().filter(|c| !c.restricted).count(),
            8
        );
    }
    #[test]
    fn deleting_a_pending_alias_requires_its_own_restore_authority() {
        let c = db();
        let a = id(&commit(&c, vec![write("I live in Beijing")], Relation::Independent)[0]);
        let b = id(&commit(&c, vec![write("I live in Shanghai")], Relation::Independent)[0]);
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::SetAlways {
                    id: a.clone(),
                    expected_revision: MemoryRevision(1),
                    always: true,
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        let pending = commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Correct {
                    id: b.clone(),
                    expected_revision: MemoryRevision(1),
                    body: "我的常住城市是北京".into(),
                    metadata: Default::default(),
                },
                evidence: None,
            }],
            Relation::Equivalent,
        );
        let alias = id(&pending[0]);
        assert!(matches!(pending[0], MemoryResult::Unresolved { .. }));
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::SetAlways {
                    id: a.clone(),
                    expected_revision: MemoryRevision(2),
                    always: false,
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Delete {
                    id: alias.clone(),
                    expected_revision: MemoryRevision(1),
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        assert!(matches!(
            commit(&c, vec![write("我的常住城市是北京")], Relation::Independent)[0],
            MemoryResult::Suppressed
        ));
        let restored = commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Restore {
                    id: alias.clone(),
                    expected_revision: MemoryRevision(2),
                    body: "我的常住城市是北京".into(),
                    metadata: Default::default(),
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        assert!(matches!(restored[0], MemoryResult::Unresolved { .. }));
        assert!(record(&c, &scope(), &alias).unwrap().is_none());
        assert_eq!(
            record(&c, &scope(), &a).unwrap().unwrap().body,
            "I live in Beijing"
        );
        assert_eq!(
            record(&c, &scope(), &b).unwrap().unwrap().body,
            "I live in Shanghai"
        );
    }
    #[test]
    fn invalid_matrix_and_cross_time_equivalence_are_atomic_errors() {
        let c = db();
        commit(&c, vec![write("Use Postgres")], Relation::Independent);
        let writes = vec![write("Use PostgreSQL")];
        let snapshot = inspect(&c, &writes);
        assert!(
            Commit {
                scope: scope(),
                source_scopes: vec![],
                writes,
                snapshot,
                decisions: vec![],
                operation: uuid::Uuid::new_v4(),
                at: 100
            }
            .execute(&c)
            .is_err()
        );
        let mut writes = vec![write("Use PostgreSQL")];
        if let MemoryEdit::Create { metadata, .. } = &mut writes[0].edit {
            metadata.temporal = MemoryTemporal::Interval {
                start: 10,
                end: Some(20),
            };
        }
        let snapshot = inspect(&c, &writes);
        let plan = Commit {
            scope: scope(),
            source_scopes: vec![],
            decisions: decisions(&snapshot, &writes, Relation::Equivalent),
            writes,
            snapshot,
            operation: uuid::Uuid::new_v4(),
            at: 100,
        };
        assert!(plan.execute(&c).is_err());
        assert_eq!(
            c.query_row("SELECT count(*) FROM agent_memories", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    fn automatic(c: &Connection, text: &str, at: i64) -> MemoryWrite {
        c.execute_batch("CREATE TABLE IF NOT EXISTS session_control(id TEXT PRIMARY KEY,configuration TEXT,archived INTEGER); CREATE TABLE IF NOT EXISTS session_retirements(session_id TEXT,remove_session INTEGER); CREATE TABLE IF NOT EXISTS agent_namespaces(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, session TEXT NOT NULL, UNIQUE(owner, session)); CREATE TABLE IF NOT EXISTS agent_recall_messages(namespace_id INTEGER,sequence INTEGER,ordinal INTEGER,body TEXT,at INTEGER,internal INTEGER,body_ref_sequence INTEGER,body_ref_start INTEGER,body_ref_end INTEGER); CREATE TABLE IF NOT EXISTS agent_session_history(namespace_id INTEGER,sequence INTEGER,fact_id TEXT);").unwrap();
        c.execute(
            "INSERT OR IGNORE INTO session_control VALUES('s','{}',0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT OR IGNORE INTO agent_namespaces VALUES(1,'host/agent','s')",
            [],
        )
        .unwrap();
        let fact = uuid::Uuid::new_v4();
        c.execute(
            "INSERT INTO agent_recall_messages(namespace_id,sequence,ordinal,body,at,internal) VALUES(1,?,0,?,?,0)",
            params![at, text, at],
        )
        .unwrap();
        c.execute(
            "INSERT INTO agent_session_history VALUES(1,?,?)",
            params![at, fact.to_string()],
        )
        .unwrap();
        MemoryWrite {
            edit: MemoryEdit::Create {
                body: text.into(),
                metadata: MemoryMetadata::default(),
            },
            evidence: Some(MemoryEvidenceReference {
                session_id: "s".into(),
                sequence: at as u64,
                item_index: 0,
                fact_id: fact,
                fingerprint: hex::encode(Sha256::digest(text.as_bytes())),
                start: 0,
                end: text.len() as u32,
                quote: text.into(),
            }),
        }
    }
    fn replace(c: &Connection, writes: Vec<MemoryWrite>) -> Vec<MemoryResult> {
        let snapshot = inspect(c, &writes);
        let mut matrix = decisions(&snapshot, &writes, Relation::Independent);
        for (i, write) in writes.iter().enumerate() {
            if let Some(reference) = &write.evidence {
                for judgment in &mut matrix[i][..snapshot.candidates.len()] {
                    judgment.relation = Relation::Replaces;
                    judgment.replacement_quote = Some(reference.quote.clone());
                }
            }
        }
        let MemoryBatchResult::Committed { results } = Commit {
            scope: scope(),
            source_scopes: vec![],
            writes,
            snapshot,
            decisions: matrix,
            operation: uuid::Uuid::new_v4(),
            at: 100,
        }
        .execute(c)
        .unwrap()
        .value
        else {
            panic!()
        };
        results
    }
    #[test]
    fn batch_edits_follow_revisions_created_by_earlier_evidence() {
        for action in ["delete", "pin", "correct", "evidence"] {
            let c = db();
            let text = "Default language Chinese";
            let target = id(&commit(&c, vec![write(text)], Relation::Independent)[0]);
            let edit = match action {
                "delete" => MemoryEdit::Delete {
                    id: target.clone(),
                    expected_revision: MemoryRevision(1),
                },
                "pin" => MemoryEdit::SetAlways {
                    id: target.clone(),
                    expected_revision: MemoryRevision(1),
                    always: true,
                },
                "correct" => MemoryEdit::Correct {
                    id: target.clone(),
                    expected_revision: MemoryRevision(1),
                    body: "Default language English".into(),
                    metadata: Default::default(),
                },
                "evidence" => MemoryEdit::AddEvidence {
                    id: target.clone(),
                    expected_revision: MemoryRevision(1),
                    assertion: MemoryRevision(1),
                    reference: automatic(&c, text, 10).evidence.unwrap(),
                },
                _ => unreachable!(),
            };
            let results = commit(
                &c,
                vec![
                    write(text),
                    MemoryWrite {
                        edit,
                        evidence: None,
                    },
                ],
                Relation::Independent,
            );
            assert!(matches!(results[0], MemoryResult::EvidenceAdded { .. }));
            match action {
                "delete" => {
                    assert!(matches!(
                        results[1],
                        MemoryResult::Deleted {
                            revision: MemoryRevision(3),
                            ..
                        }
                    ));
                    assert!(record(&c, &scope(), &target).unwrap().is_none());
                }
                _ => {
                    assert!(matches!(
                        results[1],
                        MemoryResult::Saved { .. }
                            | MemoryResult::Revised { .. }
                            | MemoryResult::EvidenceAdded { .. }
                    ));
                    let current = record(&c, &scope(), &target).unwrap().unwrap();
                    assert_eq!(current.revision, MemoryRevision(3));
                    if action == "pin" {
                        assert_eq!(current.mode, MemoryMode::UserAlways);
                    }
                    if action == "correct" {
                        assert_eq!(current.body, "Default language English");
                    }
                    if action == "evidence" {
                        assert_eq!(current.assertion, MemoryRevision(1));
                    }
                }
            }
        }
    }

    #[test]
    fn batch_state_invalidation_rolls_back_earlier_writes() {
        let c = db();
        let target = id(&commit(
            &c,
            vec![write("Default language Chinese")],
            Relation::Independent,
        )[0]);
        let pending = id(&commit(
            &c,
            vec![write("Default language English")],
            Relation::Conflict,
        )[0]);
        let writes = vec![
            MemoryWrite {
                edit: MemoryEdit::Delete {
                    id: target.clone(),
                    expected_revision: MemoryRevision(1),
                },
                evidence: None,
            },
            MemoryWrite {
                edit: MemoryEdit::SetAlways {
                    id: pending.clone(),
                    expected_revision: MemoryRevision(1),
                    always: true,
                },
                evidence: None,
            },
        ];
        let snapshot = inspect(&c, &writes);
        let decisions = snapshot.deterministic(&writes).unwrap();
        assert!(
            Commit {
                scope: scope(),
                source_scopes: vec![],
                writes,
                snapshot,
                decisions,
                operation: uuid::Uuid::new_v4(),
                at: 100
            }
            .execute(&c)
            .is_err()
        );
        assert_eq!(
            record(&c, &scope(), &target).unwrap().unwrap().revision,
            MemoryRevision(1)
        );
        let rows = PendingPage(Page {
            scope: scope(),
            after: None,
            limit: 10,
        })
        .execute(&c)
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, pending);
        assert_eq!(rows[0].revision, MemoryRevision(1));
    }

    #[test]
    fn batch_pin_prevents_later_automatic_replacement() {
        let c = db();
        let initial = automatic(&c, "Default language Chinese", 10);
        let target = id(&commit(&c, vec![initial], Relation::Independent)[0]);
        let next = automatic(&c, "Default language now English instead of Chinese", 20);
        let results = replace(
            &c,
            vec![
                MemoryWrite {
                    edit: MemoryEdit::SetAlways {
                        id: target.clone(),
                        expected_revision: MemoryRevision(1),
                        always: true,
                    },
                    evidence: None,
                },
                next,
            ],
        );
        assert!(matches!(results[1], MemoryResult::Unresolved { .. }));
        let current = record(&c, &scope(), &target).unwrap().unwrap();
        assert_eq!(current.mode, MemoryMode::UserAlways);
        assert_eq!(current.body, "Default language Chinese");
    }
    #[test]
    fn repeated_unresolved_assertion_reuses_identity_and_evidence() {
        let c = db();
        commit(
            &c,
            vec![write("Default language Chinese")],
            Relation::Independent,
        );
        let first = commit(
            &c,
            vec![write("Default language English")],
            Relation::Conflict,
        );
        let again = commit(
            &c,
            vec![write("Default language English")],
            Relation::Conflict,
        );
        assert_eq!(id(&first[0]), id(&again[0]));
        assert!(matches!(again[0], MemoryResult::Unresolved { .. }));
        let page = PendingPage(Page {
            scope: scope(),
            after: None,
            limit: 10,
        })
        .execute(&c)
        .unwrap();
        assert_eq!(page.len(), 1);
        let evidence = Evidence {
            scope: scope(),
            id: page[0].id.clone(),
            assertion: page[0].assertion,
            after: None,
            limit: 10,
        }
        .execute(&c)
        .unwrap();
        assert_eq!(evidence.len(), 2);
    }
    #[test]
    fn newer_evidence_prevents_delayed_automatic_replacement() {
        for same_batch in [false, true] {
            let c = db();
            let initial = automatic(&c, "Default language Chinese", 10);
            let target = id(&commit(&c, vec![initial], Relation::Independent)[0]);
            let confirmation = automatic(&c, "Default language Chinese", 30);
            let delayed = automatic(&c, "Default language now English instead of Chinese", 20);
            let writes = if same_batch {
                vec![confirmation, delayed]
            } else {
                commit(&c, vec![confirmation], Relation::Equivalent);
                vec![delayed]
            };
            let results = replace(&c, writes);
            assert!(matches!(
                results.last(),
                Some(MemoryResult::Unresolved { .. })
            ));
            assert_eq!(
                record(&c, &scope(), &target).unwrap().unwrap().body,
                "Default language Chinese"
            );
        }
    }
    #[test]
    fn batch_delete_suppresses_later_paraphrase() {
        let c = db();
        let target = id(&commit(&c, vec![write("Use PostgreSQL")], Relation::Independent)[0]);
        let results = commit(
            &c,
            vec![
                MemoryWrite {
                    edit: MemoryEdit::Delete {
                        id: target,
                        expected_revision: MemoryRevision(1),
                    },
                    evidence: None,
                },
                write("Use Postgres"),
            ],
            Relation::Equivalent,
        );
        assert!(matches!(results[1], MemoryResult::Suppressed));
    }
    #[test]
    fn batch_budget_preserves_later_exact_match() {
        let c = db();
        for i in 0..8 {
            commit(
                &c,
                vec![write(&format!("Apple project unique {i}"))],
                Relation::Independent,
            );
        }
        let target = id(&commit(&c, vec![write("Zebra stripes")], Relation::Independent)[0]);
        let results = commit(
            &c,
            vec![write("Apple project new"), write("Zebra stripes")],
            Relation::Independent,
        );
        assert!(matches!(results[1], MemoryResult::EvidenceAdded { .. }));
        assert_eq!(id(&results[1]), target);
    }
    #[test]
    fn suppressed_batch_input_retains_identity_for_later_relations() {
        let c = db();
        let target = id(&commit(&c, vec![write("Use PostgreSQL")], Relation::Independent)[0]);
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Delete {
                    id: target,
                    expected_revision: MemoryRevision(1),
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        let writes = vec![
            write("Use Postgres"),
            write("Use Postgres"),
            write("Use Postgress"),
        ];
        let snapshot = inspect(&c, &writes);
        let mut matrix = decisions(&snapshot, &writes, Relation::Independent);
        matrix[0][0].relation = Relation::Equivalent;
        matrix[1][snapshot.candidates.len()].relation = Relation::Equivalent;
        matrix[2][snapshot.candidates.len() + 1].relation = Relation::Equivalent;
        let MemoryBatchResult::Committed { results } = Commit {
            scope: scope(),
            source_scopes: vec![],
            writes,
            snapshot,
            decisions: matrix,
            operation: uuid::Uuid::new_v4(),
            at: 100,
        }
        .execute(&c)
        .unwrap()
        .value
        else {
            panic!()
        };
        assert!(
            results
                .iter()
                .all(|r| matches!(r, MemoryResult::Suppressed))
        );
        assert!(matches!(
            commit(&c, vec![write("Use Postgress")], Relation::Independent)[0],
            MemoryResult::Suppressed
        ));
    }
    #[test]
    fn confirmed_alias_stays_suppressed_after_delete_or_correction() {
        for delete in [true, false] {
            let c = db();
            let target =
                id(&commit(&c, vec![write("I live in Beijing")], Relation::Independent)[0]);
            commit(
                &c,
                vec![MemoryWrite {
                    edit: MemoryEdit::SetAlways {
                        id: target.clone(),
                        expected_revision: MemoryRevision(1),
                        always: true,
                    },
                    evidence: None,
                }],
                Relation::Independent,
            );
            let alias = automatic(&c, "我的常住城市是北京", 10);
            let accepted = commit(&c, vec![alias.clone()], Relation::Equivalent);
            assert_eq!(id(&accepted[0]), target);
            let edit = if delete {
                MemoryEdit::Delete {
                    id: target.clone(),
                    expected_revision: MemoryRevision(3),
                }
            } else {
                MemoryEdit::Correct {
                    id: target.clone(),
                    expected_revision: MemoryRevision(3),
                    body: "I live in Shanghai".into(),
                    metadata: Default::default(),
                }
            };
            commit(
                &c,
                vec![MemoryWrite {
                    edit,
                    evidence: None,
                }],
                Relation::Independent,
            );
            // A known alias must remain blocked even if the model says independent.
            let result = commit(&c, vec![alias.clone()], Relation::Independent);
            assert!(matches!(result[0], MemoryResult::Suppressed));
            let restore_revision = if delete {
                MemoryRevision(4)
            } else {
                commit(
                    &c,
                    vec![MemoryWrite {
                        edit: MemoryEdit::Delete {
                            id: target.clone(),
                            expected_revision: MemoryRevision(4),
                        },
                        evidence: None,
                    }],
                    Relation::Independent,
                );
                MemoryRevision(5)
            };
            {
                commit(
                    &c,
                    vec![MemoryWrite {
                        edit: MemoryEdit::Restore {
                            id: target.clone(),
                            expected_revision: restore_revision,
                            body: "I live in Beijing".into(),
                            metadata: Default::default(),
                        },
                        evidence: None,
                    }],
                    Relation::Independent,
                );
                let result = commit(&c, vec![alias], Relation::Independent);
                assert!(matches!(result[0], MemoryResult::EvidenceAdded { .. }));
                assert_eq!(id(&result[0]), target);
            }
        }
    }
    #[test]
    fn automatic_replacement_requires_verified_newer_explicit_evidence_and_keeps_history() {
        let c = db();
        let initial = automatic(&c, "Default language Chinese", 10);
        let original = commit(&c, vec![initial], Relation::Independent);
        let next = automatic(&c, "Default language now English instead of Chinese", 20);
        let writes = vec![next];
        let snapshot = inspect(&c, &writes);
        let mut matrix = decisions(&snapshot, &writes, Relation::Replaces);
        matrix[0][0].replacement_quote = Some("now English instead of Chinese".into());
        let MemoryBatchResult::Committed { results } = Commit {
            scope: scope(),
            source_scopes: vec![],
            writes,
            snapshot,
            decisions: matrix,
            operation: uuid::Uuid::new_v4(),
            at: 30,
        }
        .execute(&c)
        .unwrap()
        .value
        else {
            panic!()
        };
        assert_eq!(id(&original[0]), id(&results[0]));
        assert!(matches!(results[0], MemoryResult::Revised { .. }));
        let current = record(&c, &scope(), &id(&results[0])).unwrap().unwrap();
        assert_eq!(current.mode, MemoryMode::AutoRecall);
        let history = History {
            scope: scope(),
            id: current.id.clone(),
            after: None,
            limit: 10,
        }
        .execute(&c)
        .unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].generation, MemoryGeneration::Extraction);
        let old = automatic(&c, "Default language Chinese instead of English", 5);
        let stale = commit(&c, vec![old], Relation::Replaces);
        assert!(matches!(stale[0], MemoryResult::Unresolved { .. }));
        assert_eq!(
            record(&c, &scope(), &current.id).unwrap().unwrap().body,
            current.body
        );
        assert_eq!(
            Evidence {
                scope: scope(),
                id: current.id,
                assertion: current.assertion,
                after: None,
                limit: 10
            }
            .execute(&c)
            .unwrap()
            .len(),
            1
        );
    }
    #[test]
    fn replacement_batch_reuses_actual_assertion_identity() {
        for duplicate_replacement in [false, true] {
            let c = db();
            let initial = automatic(&c, "Default language Chinese", 10);
            let target = id(&commit(&c, vec![initial], Relation::Independent)[0]);
            let text = "Default language now English instead of Chinese";
            let writes = vec![
                automatic(
                    &c,
                    if duplicate_replacement {
                        text
                    } else {
                        "Default language Chinese"
                    },
                    20,
                ),
                automatic(&c, text, 30),
            ];
            let snapshot = inspect(&c, &writes);
            let mut matrix = decisions(&snapshot, &writes, Relation::Replaces);
            for (i, row) in matrix.iter_mut().enumerate() {
                for judgment in row {
                    judgment.replacement_quote =
                        Some(writes[i].evidence.as_ref().unwrap().quote.clone());
                }
            }
            if duplicate_replacement {
                matrix[1][snapshot.candidates.len()].relation = Relation::Equivalent;
            }
            let MemoryBatchResult::Committed { results } = Commit {
                scope: scope(),
                source_scopes: vec![],
                writes,
                snapshot,
                decisions: matrix,
                operation: uuid::Uuid::new_v4(),
                at: 100,
            }
            .execute(&c)
            .unwrap()
            .value
            else {
                panic!()
            };
            assert_eq!(id(&results[0]), target);
            assert_eq!(id(&results[1]), target);
            assert!(if duplicate_replacement {
                matches!(results[1], MemoryResult::EvidenceAdded { .. })
            } else {
                matches!(results[1], MemoryResult::Revised { .. })
            });
            assert!(
                PendingPage(Page {
                    scope: scope(),
                    after: None,
                    limit: 10
                })
                .execute(&c)
                .unwrap()
                .is_empty()
            );
        }
    }
    #[test]
    fn successive_automatic_replacements_preserve_identity_and_old_suppression() {
        for batched in [false, true] {
            let c = db();
            let original = "Default language is Chinese";
            let initial = automatic(&c, original, 10);
            let target = id(&commit(&c, vec![initial], Relation::Independent)[0]);
            let english = automatic(
                &c,
                "From now on use English instead of Chinese as my default language",
                20,
            );
            let french = automatic(
                &c,
                "From now on use French instead of either English or Chinese as my default language",
                30,
            );
            let writes = if batched {
                vec![english, french]
            } else {
                assert!(matches!(
                    replace(&c, vec![english])[0],
                    MemoryResult::Revised { .. }
                ));
                vec![french]
            };
            let snapshot = inspect(&c, &writes);
            let mut matrix = decisions(&snapshot, &writes, Relation::Replaces);
            for (i, row) in matrix.iter_mut().enumerate() {
                for judgment in row {
                    judgment.replacement_quote =
                        Some(writes[i].evidence.as_ref().unwrap().quote.clone());
                }
            }
            let MemoryBatchResult::Committed { results } = Commit {
                scope: scope(),
                source_scopes: vec![],
                writes,
                snapshot,
                decisions: matrix,
                operation: uuid::Uuid::new_v4(),
                at: 100,
            }
            .execute(&c)
            .unwrap()
            .value
            else {
                panic!()
            };
            for result in results {
                assert!(matches!(result, MemoryResult::Revised { .. }));
                assert_eq!(id(&result), target);
            }
            let current = record(&c, &scope(), &target).unwrap().unwrap();
            assert!(current.body.contains("French"));
            assert_eq!(current.mode, MemoryMode::AutoRecall);
            let old = automatic(&c, original, 40);
            assert!(matches!(
                replace(&c, vec![old])[0],
                MemoryResult::Suppressed
            ));
        }
    }
    #[test]
    fn distinct_automatic_replacement_targets_remain_ambiguous() {
        let c = db();
        let chinese = automatic(&c, "Default language Chinese", 10);
        commit(&c, vec![chinese], Relation::Independent);
        let spanish = automatic(&c, "Default language Spanish", 11);
        commit(&c, vec![spanish], Relation::Independent);
        let writes = vec![automatic(
            &c,
            "Default language now English instead of Chinese and Spanish",
            30,
        )];
        let snapshot = inspect(&c, &writes);
        let mut matrix = decisions(&snapshot, &writes, Relation::Replaces);
        for judgment in &mut matrix[0] {
            judgment.replacement_quote = Some(writes[0].evidence.as_ref().unwrap().quote.clone());
        }
        assert!(
            Commit {
                scope: scope(),
                source_scopes: vec![],
                writes,
                snapshot,
                decisions: matrix,
                operation: uuid::Uuid::new_v4(),
                at: 100
            }
            .execute(&c)
            .is_err()
        );
        let current = Page {
            scope: scope(),
            after: None,
            limit: 10,
        }
        .execute(&c)
        .unwrap();
        assert_eq!(current.len(), 2);
        assert!(current.iter().all(|r| r.revision == MemoryRevision(1)));
    }
    #[test]
    fn forged_evidence_and_unquoted_replacement_never_write() {
        let c = db();
        let initial = automatic(&c, "Default language Chinese", 10);
        commit(&c, vec![initial], Relation::Independent);
        let mut forged = automatic(&c, "Default language English", 20);
        forged.evidence.as_mut().unwrap().quote = "Forged".into();
        let writes = vec![forged];
        let snapshot = inspect(&c, &writes);
        let plan = Commit {
            scope: scope(),
            source_scopes: vec![],
            decisions: decisions(&snapshot, &writes, Relation::Replaces),
            writes,
            snapshot,
            operation: uuid::Uuid::new_v4(),
            at: 30,
        };
        assert!(plan.execute(&c).is_err());
        let next = automatic(&c, "Default language English", 21);
        let writes = vec![next];
        let snapshot = inspect(&c, &writes);
        let plan = Commit {
            scope: scope(),
            source_scopes: vec![],
            decisions: decisions(&snapshot, &writes, Relation::Replaces),
            writes,
            snapshot,
            operation: uuid::Uuid::new_v4(),
            at: 30,
        };
        assert!(plan.execute(&c).is_err());
        assert_eq!(
            c.query_row("SELECT count(*) FROM agent_memory_versions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn bounded_retrieval_fixture_report() {
        let cases = [
            (
                "Use PostgreSQL for storage",
                "Use Postgres for storage",
                true,
            ),
            ("喜欢使用中文交流", "中文交流偏好", true),
            (
                "Use English for work email",
                "Use English for work emails",
                true,
            ),
            (
                "Default language Chinese",
                "Default language is not Chinese",
                true,
            ),
            ("Prefer Python", "Python preferred", true),
            ("I live in Beijing", "我的常住城市是北京", false),
        ];
        let mut hits = 0;
        let mut micros = Vec::new();
        for (stored, query, expected) in cases {
            let c = db();
            let original = commit(&c, vec![write(stored)], Relation::Independent);
            let started = std::time::Instant::now();
            let snapshot = inspect(&c, &[write(query)]);
            micros.push(started.elapsed().as_micros());
            let found = snapshot
                .candidates
                .iter()
                .any(|candidate| candidate.id == id(&original[0]));
            assert_eq!(found, expected, "{stored} -> {query}");
            hits += usize::from(found);
        }
        micros.sort_unstable();
        eprintln!(
            "memory lexical fixture recall={hits}/6; misses={}; lookup p50={}us p95={}us; semantic false merges/suppressions: not measured by this retrieval-only fixture",
            6 - hits,
            micros[2],
            micros[5]
        );
        let c = db();
        let mut records = Vec::new();
        for i in 0..64 {
            records.push(commit(
                &c,
                vec![write(&format!("Different scoped fact {i}"))],
                Relation::Independent,
            ));
        }
        let pending = commit(
            &c,
            vec![write("Different scoped fact conflict")],
            Relation::Conflict,
        );
        assert!(matches!(pending[0], MemoryResult::Unresolved { .. }));
        let page = PendingPage(Page {
            scope: scope(),
            after: None,
            limit: 10,
        })
        .execute(&c)
        .unwrap();
        assert_eq!(page.len(), 1);
        assert!(
            !Evidence {
                scope: scope(),
                id: page[0].id.clone(),
                assertion: page[0].assertion,
                after: None,
                limit: 10
            }
            .execute(&c)
            .unwrap()
            .is_empty()
        );
    }
    #[test]
    fn correction_to_another_identity_does_not_retire_or_unpin_either_record() {
        let c = db();
        let a = id(&commit(
            &c,
            vec![write("Default language Chinese")],
            Relation::Independent,
        )[0]);
        let b = id(&commit(
            &c,
            vec![write("Default language English")],
            Relation::Independent,
        )[0]);
        commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::SetAlways {
                    id: a.clone(),
                    expected_revision: MemoryRevision(1),
                    always: true,
                },
                evidence: None,
            }],
            Relation::Independent,
        );
        let result = commit(
            &c,
            vec![MemoryWrite {
                edit: MemoryEdit::Correct {
                    id: a.clone(),
                    expected_revision: MemoryRevision(2),
                    body: "Default language English".into(),
                    metadata: Default::default(),
                },
                evidence: None,
            }],
            Relation::Equivalent,
        );
        assert!(matches!(result[0], MemoryResult::Unresolved { .. }));
        let original = record(&c, &scope(), &a).unwrap().unwrap();
        assert_eq!(original.mode, MemoryMode::UserAlways);
        assert_eq!(original.body, "Default language Chinese");
        assert!(record(&c, &scope(), &b).unwrap().is_some());
    }
}
