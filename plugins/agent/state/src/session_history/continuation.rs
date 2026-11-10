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
use crate::{fold::RunView, store::invalid};
use maka_agent_facts::{
    artifact::content_digest, history_snapshot::RequestSource, input::RunInput,
};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::io::Write;

impl SessionHistory {
    pub async fn successor(&self, source: RunId) -> Result<Option<RunId>, StoreError> {
        self.data
            .query(Successor(self.namespace.clone(), source))
            .await
    }
}
struct Successor(HistoryNamespace, RunId);
impl Query for Successor {
    type Output = Option<RunId>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let owner = serde_json::to_string(&self.0.owner)?;
        let run:Option<String>=c.query_row("SELECT x.run FROM agent_continuation_successors x JOIN agent_run_specs s ON s.run=x.source_run JOIN agent_run_specs t ON t.run=x.run WHERE x.source_run=?1 AND s.owner=?2 AND t.owner=?2 AND s.session=?3 AND t.session=?3",params![self.1.to_string(),owner,self.0.session],|r|r.get(0)).optional()?;
        run.map(sql::identity).transpose()
    }
}

/// New-admission only. Original admission recovery precedes this call; an
/// immutable historical source never consumes a current continuation claim.
pub(crate) fn admit_continuation(
    c: &Connection,
    view: &RunView,
    record: &RecordedFact,
) -> Result<(), StoreError> {
    if !matches!(record.fact, Fact::RunAdmitted { .. }) || record.run != view.run {
        return Err(invalid(
            "continuation constraint requires its actual new Run admission",
        ));
    }
    if view.spec.origin != RunOrigin::Local {
        if matches!(view.spec.trigger, Trigger::HistorySource) {
            let input: RunInput =
                serde_json::from_slice(&crate::sql::owned_content(c, view.run, &view.spec.input)?)?;
            let RunInput::HistorySource { source } = input else {
                return Err(invalid(
                    "historical installation must carry its actual typed source input",
                ));
            };
            let original = match &view.spec.origin {
                RunOrigin::Imported { source } | RunOrigin::Forked { source, .. } => source,
                RunOrigin::Local => unreachable!(),
            };
            if &source != original {
                return Err(invalid(
                    "historical input differs from its original immutable source manifest",
                ));
            }
        }
        return Ok(());
    }
    let bytes = crate::sql::owned_content(c, view.run, &view.spec.input)?;
    if content_digest(&bytes) != view.spec.input.digest {
        return Err(invalid(
            "Run input bytes differ from their immutable reference",
        ));
    }
    let input: RunInput = serde_json::from_slice(&bytes)?;
    if matches!(view.spec.trigger, Trigger::HistorySource)
        || matches!(input, RunInput::HistorySource { .. })
    {
        return Err(invalid(
            "historical source data cannot be admitted as local executable input",
        ));
    }
    let (source, claim) = match (&view.spec.trigger, &input) {
        (Trigger::Continuation { source }, RunInput::Continuation { claim, .. }) => {
            (*source, claim.as_ref())
        }
        (Trigger::ContextCompact, RunInput::ContextCompact { .. }) => return Ok(()),
        (Trigger::Continuation { .. } | Trigger::ContextCompact, _)
        | (_, RunInput::Continuation { .. } | RunInput::ContextCompact { .. }) => {
            return Err(invalid(
                "Run trigger differs from its original typed continuation/compact input",
            ));
        }
        _ => return Ok(()),
    };
    let execution = ExecutionIdentity {
        session_id: view.spec.session_id.clone(),
        turn_id: view.spec.turn_id.clone(),
        run_id: view.run,
    };
    claim.validate(&execution).map_err(invalid)?;
    if claim.source.execution.run_id != source {
        return Err(invalid("continuation trigger names another source Run"));
    }
    let original = crate::sql::load(c, source, &[], false)?;
    if original.spec.owner != view.spec.owner
        || original.spec.session_id != claim.source.execution.session_id
        || original.spec.turn_id != claim.source.execution.turn_id
        || original.spec.session_id != view.spec.session_id
        || original.terminal.is_none()
        || original.revision != claim.source.high_water
        || original.spec.workspace != view.spec.workspace
        || original.spec.permission_basis.binding.id != view.spec.permission_basis.binding.id
    {
        return Err(invalid(
            "continuation source identity, terminal boundary or current workspace basis changed",
        ));
    }
    let current_basis =
        maka_event_log::workspace_bindings::permission_basis(c, &view.spec.session_id)?
            .ok_or_else(|| {
                invalid("continuation target has no current workspace permission basis")
            })?;
    if current_basis != view.spec.permission_basis {
        return Err(invalid(
            "continuation admission no longer matches its actual current permission basis",
        ));
    }
    let (digest, first_step) = boundary(c, source, claim.source.high_water)?;
    if digest != claim.source.digest {
        return Err(invalid(
            "continuation does not name the exact sealed canonical source",
        ));
    }
    let first = crate::sql::request(
        c,
        source,
        first_step.ok_or_else(|| invalid("continuation source has no actual prepared request"))?,
    )?;
    let bytes = crate::sql::owned_content(c, source, &first.source_capture)?;
    if content_digest(&bytes) != first.source_capture.digest {
        return Err(invalid(
            "continuation source capture bytes differ from their canonical reference",
        ));
    }
    let capture: RequestSource = serde_json::from_slice(&bytes)?;
    if capture.cut.through_sequence != claim.base.high_water
        || capture.cut.digest != claim.base.digest
    {
        return Err(invalid(
            "continuation changed its actual source request base",
        ));
    }
    sql::validate_cut(c, &view.spec.owner, &view.spec.session_id, &capture.cut)?;
    let prior: Option<String> = c
        .query_row(
            "SELECT run FROM agent_continuation_successors WHERE source_run=?",
            [source.to_string()],
            |r| r.get(0),
        )
        .optional()?;
    if prior.is_some() {
        return Err(invalid(
            "the sealed source Run already has an original continuation successor",
        ));
    }
    c.execute(
        "INSERT INTO agent_continuation_successors VALUES(?,?,?)",
        params![
            source.to_string(),
            view.run.to_string(),
            record.id.to_string()
        ],
    )?;
    // Prepared prompt/input_digest/route checks occur at the real first target
    // request boundary in Engine, not before such a request exists at admission.
    Ok(())
}
struct Hasher(Sha256);
impl Write for Hasher {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
/// Exactly Engine::digest(Vec<RecordedFact>) in canonical revision order, with
/// the same DTO serialization, but only one original fact materialized at once.
fn boundary(
    c: &Connection,
    run: RunId,
    through: u64,
) -> Result<(String, Option<StepId>), StoreError> {
    let mut hash = Hasher(Sha256::new());
    hash.write_all(b"[")?;
    let mut statement=c.prepare_cached("SELECT f.id,f.revision,f.schema_version,b.payload,b.content_sha256 FROM agent_facts f JOIN contents b ON b.id=f.body_content_id WHERE f.run=? AND f.revision<=? ORDER BY f.revision")?;
    let mut rows = statement.query(params![run.to_string(), sql::bind_u64(through)?])?;
    let mut previous = 0u64;
    let mut first = None;
    while let Some(row) = rows.next()? {
        let revision = sql::read_u64(row, 1)?;
        if revision
            != previous
                .checked_add(1)
                .ok_or_else(|| invalid("source revision exhausted"))?
        {
            return Err(invalid("canonical continuation source prefix has a gap"));
        }
        let bytes: Vec<u8> = row.get(3)?;
        if content_digest(&bytes) != row.get::<_, String>(4)? {
            return Err(invalid("canonical continuation source bytes corrupt"));
        }
        let fact = sql::decode_record(row.get(2)?, &bytes)?;
        if fact.run != run
            || fact.revision != revision
            || fact.id.to_string() != row.get::<_, String>(0)?
        {
            return Err(invalid("canonical continuation source identity changed"));
        }
        if first.is_none()
            && let Fact::StepPrepared { step, .. } = &fact.fact
        {
            first = Some(*step)
        }
        if previous != 0 {
            hash.write_all(b",")?;
        }
        serde_json::to_writer(&mut hash, &fact)?;
        previous = revision;
    }
    if previous != through {
        return Err(invalid("canonical continuation source boundary missing"));
    }
    hash.write_all(b"]")?;
    Ok((format!("sha256:{}", hex::encode(hash.0.finalize())), first))
}

pub(super) fn rebuild_record(
    c: &Connection,
    scope: &HistoryNamespace,
    record: &RecordedFact,
) -> Result<(), StoreError> {
    if !matches!(record.fact, Fact::RunAdmitted { .. }) {
        return Ok(());
    }
    let source = sql::run_source(c, scope, record.run)?;
    if source.spec.origin != RunOrigin::Local {
        return Ok(());
    }
    let Trigger::Continuation { source: parent } = source.spec.trigger else {
        return Ok(());
    };
    let input: RunInput = serde_json::from_slice(&crate::sql::owned_content(
        c,
        record.run,
        &source.spec.input,
    )?)?;
    let RunInput::Continuation { claim, .. } = input else {
        return Err(invalid(
            "committed continuation lacks its original typed input",
        ));
    };
    claim
        .validate(&ExecutionIdentity {
            session_id: source.spec.session_id,
            turn_id: source.spec.turn_id,
            run_id: record.run,
        })
        .map_err(invalid)?;
    if claim.source.execution.run_id != parent {
        return Err(invalid(
            "committed continuation source differs from its trigger",
        ));
    }
    // Only derive the original immutable reference. Current source terminal,
    // revision and policy may legitimately differ due to later observations.
    c.execute(
        "INSERT INTO agent_continuation_successors VALUES(?,?,?)",
        params![
            parent.to_string(),
            record.run.to_string(),
            record.id.to_string()
        ],
    )?;
    Ok(())
}
