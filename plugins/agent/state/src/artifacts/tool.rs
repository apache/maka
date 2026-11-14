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
use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{CellEvent, CellId},
    event::ProjectionArtifactWrite,
};
use maka_event_log::content;
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::IgnoredAny;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) enum ArtifactBatch {
    Pending(Vec<ProjectionArtifactWrite>),
    Prepared(Vec<Checked>),
}
pub(crate) struct Checked {
    write: ProjectionArtifactWrite,
    record: PublishedArtifact,
}
impl Default for ArtifactBatch {
    fn default() -> Self {
        Self::Prepared(Vec::new())
    }
}
impl ArtifactBatch {
    pub(crate) fn new(writes: Vec<ProjectionArtifactWrite>) -> Self {
        Self::Pending(writes)
    }
    /// Hashing and metadata preparation run on the original Root preparation lane.
    pub(crate) fn prepare(self) -> Result<Self, StoreError> {
        let Self::Pending(writes) = self else {
            return Ok(self);
        };
        let mut checked = Vec::with_capacity(writes.len());
        let mut ids = BTreeSet::new();
        for write in writes {
            let evidence = write.evidence();
            let record = PublishedArtifact {
                artifact: write.artifact().clone(),
                payload: ContentRef {
                    digest: evidence.digest,
                    bytes: evidence.bytes,
                },
            };
            validate_record(&record)?;
            if evidence.id != record.artifact.id
                || !ids.insert((
                    record.artifact.session_id.clone(),
                    record.artifact.id.clone(),
                ))
            {
                return Err(StoreError::EventConflict);
            }
            checked.push(Checked { write, record });
        }
        Ok(Self::Prepared(checked))
    }
    fn checked(&self) -> Result<&[Checked], StoreError> {
        match self {
            Self::Prepared(writes) => Ok(writes),
            Self::Pending(_) => Err(invalid("artifact bytes were not prepared off thread")),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum BindingOrigin {
    Input,
    Steering,
    Tool {
        tool: ToolKey,
    },
    ExternalTool {
        key: maka_agent_facts::external_effects::ExternalEffectKey,
    },
    CellChild {
        cell: CellId,
        operation: uuid::Uuid,
    },
    Cell {
        cell: CellId,
    },
}
struct Declaration {
    record: PublishedArtifact,
    fact: FactId,
    revision: u64,
    origin: BindingOrigin,
    result: ContentRef,
}
fn declarations(
    c: &Connection,
    run: RunId,
    facts: &[RecordedFact],
) -> Result<Vec<Declaration>, StoreError> {
    let mut records = Vec::new();
    for recorded in facts {
        let (origin, result, artifacts) = match &recorded.fact {
            Fact::LocalToolReturned { tool, result, .. }
            | Fact::HostToolResultRecorded { tool, result, .. } => {
                (BindingOrigin::Tool { tool: tool.clone() }, result, None)
            }
            Fact::Cell {
                event:
                    CellEvent::LocalChildReturned {
                        cell,
                        operation,
                        result,
                        ..
                    }
                    | CellEvent::ChildResultRecorded {
                        cell,
                        operation,
                        result,
                        ..
                    },
            } => (
                BindingOrigin::CellChild {
                    cell: *cell,
                    operation: *operation,
                },
                result,
                None,
            ),
            Fact::ExternalEffect {
                event:
                    maka_agent_facts::external_effects::ExternalEffectEvent::Returned {
                        key,
                        output,
                        ..
                    },
            } => {
                #[derive(serde::Deserialize)]
                struct Manifest {
                    #[serde(default)]
                    artifacts: Vec<PublishedArtifact>,
                }
                let manifest: Manifest = owned_decode(c, run, output)?;
                (
                    BindingOrigin::ExternalTool { key: *key },
                    output,
                    Some(manifest.artifacts),
                )
            }
            _ => continue,
        };
        if recorded.run != run {
            return Err(invalid("artifact fact belongs to another Run"));
        }
        let artifacts = match artifacts {
            Some(artifacts) => artifacts,
            None => {
                let returned: ToolReturn<IgnoredAny> = owned_decode(c, run, result)?;
                returned.validate().map_err(invalid)?;
                returned.artifacts
            }
        };
        let mut ids = BTreeSet::new();
        for record in artifacts {
            if !ids.insert(record.artifact.id.clone()) {
                return Err(StoreError::EventConflict);
            }
            records.push(Declaration {
                record,
                fact: recorded.id,
                revision: recorded.revision,
                origin: origin.clone(),
                result: result.clone(),
            });
        }
    }
    Ok(records)
}
pub(super) fn run_spec(c: &Connection, run: RunId) -> Result<RunSpec, StoreError> {
    let row:Option<(u32,Vec<u8>)>=c.query_row("SELECT r.schema_version,c.payload FROM agent_run_specs r JOIN contents c ON c.id=r.spec_content_id WHERE r.run=?",[run.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let (version, bytes) = row.ok_or_else(|| invalid("artifact Run not found"))?;
    let spec: RunSpec = serde_json::from_slice(&bytes)?;
    if version != SCHEMA_VERSION || spec.schema_version != SCHEMA_VERSION {
        return Err(invalid("unsupported artifact Run schema"));
    }
    Ok(spec)
}
pub(super) fn content_id(c: &Connection, reference: &ContentRef) -> Result<i64, StoreError> {
    reference.validate().map_err(invalid)?;
    c.query_row(
        "SELECT id FROM contents WHERE content_sha256=? AND length(payload)=?",
        params![reference.digest, to_sql_integer(reference.bytes)?],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| invalid("artifact immutable content unavailable"))
}
pub(super) fn project_record(
    c: &Connection,
    owner: &RunOwner,
    record: &PublishedArtifact,
) -> Result<i64, StoreError> {
    let content_id = content_id(c, &record.payload)?;
    let existing: Option<(String, String)> = c
        .query_row(
            "SELECT owner,record_json FROM agent_artifacts WHERE session=? AND artifact=?",
            params![record.artifact.session_id, record.artifact.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((original_owner, body)) = existing {
        if serde_json::from_str::<RunOwner>(&original_owner)? != *owner
            || serde_json::from_str::<PublishedArtifact>(&body)? != *record
        {
            return Err(StoreError::EventConflict);
        }
    } else {
        c.execute("INSERT INTO agent_artifacts(session,artifact,owner,record_json,content_id) VALUES(?,?,?,?,?)",params![record.artifact.session_id,record.artifact.id,serde_json::to_string(owner)?,serde_json::to_string(record)?,content_id])?;
    }
    Ok(content_id)
}
pub(super) fn owned_decode<T: serde::de::DeserializeOwned>(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    reference.validate().map_err(invalid)?;
    let rowid:i64=c.query_row("SELECT x.id FROM agent_run_content p JOIN contents x ON x.id=p.content_id WHERE p.run=? AND x.content_sha256=? AND length(x.payload)=?",params![run.to_string(),reference.digest,to_sql_integer(reference.bytes)?],|row|row.get(0)).optional()?.ok_or_else(||invalid("artifact source is not pinned by original Run"))?;
    let mut blob = c.blob_open("main", "contents", "payload", rowid, true)?;
    let decoded = serde_json::from_reader(std::io::BufReader::new(&mut blob));
    blob.close()?;
    Ok(decoded?)
}
#[derive(Clone, Copy)]
pub(super) struct BindingEvidence<'a> {
    pub fact: FactId,
    pub revision: u64,
    pub source: &'a ContentRef,
    pub origin: &'a BindingOrigin,
}

pub(super) fn bind(
    c: &Connection,
    run: RunId,
    spec: &RunSpec,
    record: &PublishedArtifact,
    evidence: BindingEvidence<'_>,
) -> Result<(), StoreError> {
    let BindingEvidence {
        fact,
        revision,
        source,
        origin,
    } = evidence;
    if record.artifact.session_id != spec.session_id {
        return Err(invalid(
            "artifact manifest session differs from producer Run",
        ));
    }
    let content_id = project_record(c, &spec.owner, record)?;
    c.execute(
        "INSERT OR IGNORE INTO agent_content_pins(run,content_id) VALUES(?,?)",
        params![run.to_string(), content_id],
    )?;
    let source_id = self::content_id(c, source)?;
    c.execute(
        "INSERT OR IGNORE INTO agent_content_pins(run,content_id) VALUES(?,?)",
        params![run.to_string(), source_id],
    )?;
    let (kind, tool_json, cell_json) = match origin {
        BindingOrigin::Tool { tool } => ("tool", Some(serde_json::to_string(tool)?), None),
        BindingOrigin::CellChild { .. } | BindingOrigin::Cell { .. } => {
            ("cell", None, Some(serde_json::to_string(origin)?))
        }
        BindingOrigin::ExternalTool { key } => ("tool", Some(serde_json::to_string(key)?), None),
        BindingOrigin::Input => ("input", None, None),
        BindingOrigin::Steering => ("steering", None, None),
    };
    c.execute("INSERT INTO agent_artifact_run_bindings(run,session,artifact,fact,revision,origin,tool_json,cell_json,source_digest,source_bytes) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run,artifact,fact) DO UPDATE SET fact=excluded.fact,revision=excluded.revision,origin=excluded.origin,tool_json=excluded.tool_json,cell_json=excluded.cell_json,source_digest=excluded.source_digest,source_bytes=excluded.source_bytes WHERE excluded.revision<agent_artifact_run_bindings.revision OR (excluded.revision=agent_artifact_run_bindings.revision AND excluded.source_digest<agent_artifact_run_bindings.source_digest)",params![run.to_string(),spec.session_id,record.artifact.id,fact.to_string(),to_sql_integer(revision)?,kind,tool_json,cell_json,source.digest,to_sql_integer(source.bytes)?])?;
    Ok(())
}
fn project(
    c: &Connection,
    run: RunId,
    spec: &RunSpec,
    declaration: &Declaration,
) -> Result<(), StoreError> {
    bind(
        c,
        run,
        spec,
        &declaration.record,
        BindingEvidence {
            fact: declaration.fact,
            revision: declaration.revision,
            source: &declaration.result,
            origin: &declaration.origin,
        },
    )
}
/// Runs inside the original canonical fact statement. Pending bytes never
/// become another execution fact or replace the original provider settlement.
pub(crate) fn append(
    c: &Connection,
    run: RunId,
    facts: &[RecordedFact],
    batch: &ArtifactBatch,
) -> Result<(), StoreError> {
    let checked = batch.checked()?;
    let declarations = declarations(c, run, facts)?;
    if declarations.is_empty() && checked.is_empty() {
        return project_inputs(c, run, facts);
    }
    let spec = run_spec(c, run)?;
    let mut pending: BTreeMap<_, _> = checked
        .iter()
        .map(|item| {
            (
                (
                    item.record.artifact.session_id.as_str(),
                    item.record.artifact.id.as_str(),
                ),
                item,
            )
        })
        .collect();
    for declaration in &declarations {
        let record = &declaration.record;
        if let Some(prepared) = pending.remove(&(
            record.artifact.session_id.as_str(),
            record.artifact.id.as_str(),
        )) {
            if prepared.record != *record
                || record.artifact.turn_id != spec.turn_id
                || !matches!(spec.origin, RunOrigin::Local)
            {
                return Err(StoreError::EventConflict);
            }
            content::put(c, &record.payload.digest, prepared.write.bytes())?;
        } else {
            // A pre-existing digest is not authority. Reuse needs this Run's
            // original pin or the same owner's canonical session registration.
            let retained:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_run_content p JOIN contents x ON x.id=p.content_id WHERE p.run=?1 AND x.content_sha256=?2) OR EXISTS(SELECT 1 FROM agent_session_artifact_registrations s JOIN contents x ON x.id=s.content_id WHERE s.session=?3 AND s.artifact=?4 AND s.owner=?5 AND x.content_sha256=?2)",params![run.to_string(),record.payload.digest,spec.session_id,record.artifact.id,serde_json::to_string(&spec.owner)?],|r|r.get(0))?;
            if !retained {
                return Err(invalid("artifact bytes lack original Run/session evidence"));
            }
        }
        project(c, run, &spec, declaration)?;
    }
    if !pending.is_empty() {
        return Err(invalid(
            "pending artifact has no canonical tool-return manifest",
        ));
    }
    project_inputs(c, run, facts)
}
fn project_inputs(c: &Connection, run: RunId, facts: &[RecordedFact]) -> Result<(), StoreError> {
    for recorded in facts {
        super::input::step(c, run, recorded)?;
        super::input::external(c, run, recorded)?;
        super::cell::completed(c, run, recorded)?;
    }
    Ok(())
}
pub(crate) fn rebuild(c: &Connection, run: RunId) -> Result<(), StoreError> {
    let spec = run_spec(c, run)?;
    c.execute(
        "DELETE FROM agent_artifact_run_bindings WHERE run=?",
        [run.to_string()],
    )?;
    let mut after = 0;
    loop {
        let facts = crate::sql::history(c, run, after, 128)?;
        if facts.is_empty() {
            break;
        }
        after = facts.last().expect("nonempty fact page").revision;
        for recorded in &facts {
            if matches!(&recorded.fact, Fact::RunAdmitted { .. }) {
                super::input::admit(c, run, &spec, recorded.id)?;
            }
        }
        for declaration in declarations(c, run, &facts)? {
            let retained:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_run_content p JOIN contents x ON x.id=p.content_id WHERE p.run=? AND x.content_sha256=?)",params![run.to_string(),declaration.record.payload.digest],|r|r.get(0))?;
            if !retained {
                return Err(invalid("canonical artifact evidence pin is missing"));
            }
            project(c, run, &spec, &declaration)?;
        }
        project_inputs(c, run, &facts)?;
    }
    Ok(())
}
