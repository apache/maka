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
use maka_event_log::connection::Query;
use rusqlite::{Connection, OptionalExtension, params};

pub(super) struct Material {
    pub record: PublishedArtifact,
    pub rowid: i64,
    pub proof: SourceProof,
    pub provenance: Option<(ContentRef, i64)>,
}
pub(super) fn lookup(
    c: &Connection,
    scope: &ArtifactReadScope,
    id: &str,
) -> Result<Option<Material>, StoreError> {
    identity(scope.session())?;
    identity(id)?;
    let owner = serde_json::to_string(scope.owner())?;
    let (body, proof, retained_content_id, provenance) = match scope {
        ArtifactReadScope::Session { scope } => {
            let row:Option<(Vec<u8>,String,i64,i64)>=c.query_row("SELECT b.payload,b.content_sha256,length(b.payload),r.content_id FROM agent_session_artifact_registrations r JOIN contents b ON b.id=r.body_content_id WHERE r.session=? AND r.artifact=? AND r.owner=?",params![scope.session,id,owner],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            let Some((bytes, digest, length, raw_content_id)) = row else {
                return Ok(None);
            };
            let registration: session::Registration = serde_json::from_slice(&bytes)?;
            registration.validate(scope)?;
            let provenance = registration.provenance(c)?;
            if registration.record.artifact.id != id {
                return Err(invalid("session artifact canonical identity differs"));
            }
            (
                registration.record,
                SourceProof::Session {
                    scope: scope.clone(),
                    id: id.into(),
                    registration: ContentRef {
                        digest,
                        bytes: from_sql_integer(length)?,
                    },
                },
                raw_content_id,
                provenance,
            )
        }
        ArtifactReadScope::Run { scope } => {
            let spec = tool::run_spec(c, scope.run)?;
            if spec.owner != scope.owner || spec.session_id != scope.session {
                return Err(invalid(
                    "artifact read belongs to another Run owner/session",
                ));
            }
            let high_water: i64 = c.query_row(
                "SELECT max(revision) FROM agent_facts WHERE run=?",
                [scope.run.to_string()],
                |r| r.get(0),
            )?;
            if scope.through == 0 || scope.through > from_sql_integer(high_water)? {
                return Err(invalid("artifact read cut exceeds canonical Run"));
            }
            let row:Option<(String,String,i64,i64)>=c.query_row("SELECT a.record_json,b.source_digest,b.source_bytes,a.content_id FROM agent_artifact_run_bindings b JOIN agent_artifacts a ON a.session=b.session AND a.artifact=b.artifact JOIN agent_facts f ON f.id=b.fact AND f.run=b.run AND f.revision=b.revision JOIN contents x ON x.id=a.content_id JOIN agent_run_content p ON p.run=b.run AND p.content_id=x.id WHERE b.run=? AND b.session=? AND b.artifact=? AND b.revision<=? AND a.owner=? ORDER BY b.revision,b.fact LIMIT 1",params![scope.run.to_string(),scope.session,id,to_sql_integer(scope.through)?,owner],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            let Some((body, digest, bytes, raw_content_id)) = row else {
                return Ok(None);
            };
            // The immutable source ref is also pinned by this original Run.
            let reference = ContentRef {
                digest,
                bytes: from_sql_integer(bytes)?,
            };
            let retained:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_run_content p JOIN contents x ON x.id=p.content_id WHERE p.run=? AND x.content_sha256=? AND length(x.payload)=?)",params![scope.run.to_string(),reference.digest,to_sql_integer(reference.bytes)?],|r|r.get(0))?;
            if !retained {
                return Err(invalid(
                    "artifact source evidence is not retained by its original Run",
                ));
            }
            (
                serde_json::from_str(&body)?,
                SourceProof::Run {
                    scope: scope.clone(),
                    id: id.into(),
                    result: reference,
                },
                raw_content_id,
                None,
            )
        }
    };
    validate_record(&body)?;
    if body.artifact.session_id != scope.session() || body.artifact.id != id {
        return Err(invalid("artifact identity differs from scoped lookup"));
    }
    let rowid = tool::content_id(c, &body.payload)?;
    if rowid != retained_content_id {
        return Err(invalid(
            "artifact payload reference differs from original ownership pin",
        ));
    }
    Ok(Some(Material {
        record: body,
        rowid,
        proof,
        provenance,
    }))
}
pub(super) fn original(c: &Connection, source: &CopySource) -> Result<Material, StoreError> {
    let (scope, id) = match &source.proof {
        SourceProof::Session { scope, id, .. } => (ArtifactReadScope::from(scope.clone()), id),
        SourceProof::Run { scope, id, .. } => (ArtifactReadScope::from(scope.clone()), id),
    };
    let material = lookup(c, &scope, id)?
        .ok_or_else(|| invalid("copy source no longer has original canonical evidence"))?;
    if material.record != source.record || material.proof != source.proof {
        return Err(StoreError::EventConflict);
    }
    Ok(material)
}
pub(super) struct Resolve {
    pub scope: SessionScope,
    pub id_or_prefix: String,
}
fn prefix_end(prefix: &str) -> Option<String> {
    for (offset, character) in prefix.char_indices().rev() {
        let next = match character {
            '\u{10ffff}' => continue,
            '\u{d7ff}' => '\u{e000}',
            _ => char::from_u32(u32::from(character) + 1)
                .expect("nonmaximum Unicode scalar has a successor outside the surrogate gap"),
        };
        let mut end = prefix[..offset].to_owned();
        end.push(next);
        return Some(end);
    }
    None
}
impl Query for Resolve {
    type Output = Option<Artifact>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        identity(&self.scope.session)?;
        identity(&self.id_or_prefix)?;
        let owner = serde_json::to_string(&self.scope.owner)?;
        let exact:Option<String>=c.query_row("SELECT artifact FROM agent_artifacts INDEXED BY agent_artifacts_owner WHERE owner=? AND session=? AND artifact=?",params![owner,self.scope.session,self.id_or_prefix],|row|row.get(0)).optional()?;
        let id = match exact {
            Some(id) => id,
            None => {
                let ids = if let Some(end) = prefix_end(&self.id_or_prefix) {
                    c.prepare_cached("SELECT artifact FROM agent_artifacts INDEXED BY agent_artifacts_owner WHERE owner=? AND session=? AND artifact>=? AND artifact<? ORDER BY artifact LIMIT 2")?.query_map(params![owner,self.scope.session,self.id_or_prefix,end],|row|row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?
                } else {
                    c.prepare_cached("SELECT artifact FROM agent_artifacts INDEXED BY agent_artifacts_owner WHERE owner=? AND session=? AND artifact>=? ORDER BY artifact LIMIT 2")?.query_map(params![owner,self.scope.session,self.id_or_prefix],|row|row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?
                };
                let mut ids = ids.into_iter();
                let Some(id) = ids.next() else {
                    return Ok(None);
                };
                if ids.next().is_some() {
                    return Err(invalid("artifact id prefix is ambiguous"));
                }
                id
            }
        };
        let session_scope = ArtifactReadScope::from(self.scope.clone());
        if let Some(material) = lookup(c, &session_scope, &id)? {
            return Ok(Some(material.record.artifact));
        }
        // Tool metadata remains owned by its original canonical producer. This
        // verification does not turn the selected descriptor into a byte grant.
        let origin:Option<(String,i64)>=c.query_row("SELECT b.run,b.revision FROM agent_artifact_run_bindings b INDEXED BY agent_artifact_bindings_session JOIN agent_run_specs r ON r.run=b.run WHERE b.session=? AND b.artifact=? AND r.owner=? AND r.session=? ORDER BY b.run LIMIT 1",params![self.scope.session,id,owner,self.scope.session],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        let (run, revision) = origin.ok_or_else(|| {
            invalid("artifact index has no original canonical registration or producer")
        })?;
        let scope = ArtifactReadScope::from(ArtifactScope {
            owner: self.scope.owner,
            session: self.scope.session,
            run: serde_json::from_value(serde_json::Value::String(run))?,
            through: from_sql_integer(revision)?,
        });
        let material = lookup(c, &scope, &id)?
            .ok_or_else(|| invalid("artifact original producer evidence is unavailable"))?;
        Ok(Some(material.record.artifact))
    }
}
pub(super) struct Get {
    pub scope: ArtifactReadScope,
    pub id: String,
}
impl Query for Get {
    type Output = Option<PublishedArtifact>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(lookup(c, &self.scope, &self.id)?.map(|item| item.record))
    }
}
pub(super) struct Source {
    pub scope: ArtifactReadScope,
    pub id: String,
    pub root: DataWriter,
}
impl Query for Source {
    type Output = Option<CopySource>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(lookup(c, &self.scope, &self.id)?.map(|item| CopySource {
            record: item.record,
            proof: item.proof,
            root: self.root,
        }))
    }
}
pub(super) struct Chunk {
    pub scope: ArtifactReadScope,
    pub id: String,
    pub offset: u64,
    pub limit: u32,
}
impl Query for Chunk {
    type Output = Option<ArtifactChunk>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        if !(1..=1_048_576).contains(&self.limit) {
            return Err(invalid("artifact chunk limit must be 1..=1048576"));
        }
        let Some(material) = lookup(c, &self.scope, &self.id)? else {
            return Ok(None);
        };
        let total = material.record.payload.bytes;
        if self.offset > total {
            return Err(invalid(
                "artifact offset is outside immutable payload or SQLite index range",
            ));
        }
        let start = to_sql_integer(self.offset)?.checked_add(1).ok_or(invalid(
            "artifact offset is outside immutable payload or SQLite index range",
        ))?;
        let bytes: Vec<u8> = c.query_row(
            "SELECT substr(payload,?,?) FROM contents WHERE id=?",
            params![start, self.limit, material.rowid],
            |r| r.get(0),
        )?;
        if bytes.len() as u64 != (total - self.offset).min(self.limit as u64) {
            return Err(invalid(
                "artifact chunk length differs from immutable descriptor",
            ));
        }
        Ok(Some(ArtifactChunk {
            record: material.record,
            total_bytes: total,
            bytes,
        }))
    }
}
pub(super) struct WithContent<F> {
    pub scope: ArtifactReadScope,
    pub id: String,
    pub read: F,
}
impl<T: Send + 'static, F: FnOnce(&Artifact, &mut dyn Read) -> T + Send + 'static> Query
    for WithContent<F>
{
    type Output = Option<T>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let Some(material) = lookup(c, &self.scope, &self.id)? else {
            return Ok(None);
        };
        let mut blob = c.blob_open("main", "contents", "payload", material.rowid, true)?;
        if blob.len() as u64 != material.record.payload.bytes {
            return Err(invalid(
                "artifact blob size differs from immutable descriptor",
            ));
        }
        let result = (self.read)(&material.record.artifact, &mut blob);
        blob.close()?;
        Ok(Some(result))
    }
}

pub(super) struct WithProvenance<F> {
    pub scope: SessionScope,
    pub id: String,
    pub read: F,
}
impl<T: Send + 'static, F: FnOnce(&Artifact, &mut dyn Read) -> T + Send + 'static> Query
    for WithProvenance<F>
{
    type Output = Option<T>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let Some(material) = lookup(c, &ArtifactReadScope::from(self.scope), &self.id)? else {
            return Ok(None);
        };
        let Some((reference, rowid)) = material.provenance else {
            return Ok(None);
        };
        let mut blob = c.blob_open("main", "contents", "payload", rowid, true)?;
        if blob.len() as u64 != reference.bytes {
            return Err(invalid(
                "Produced provenance blob size differs from original descriptor",
            ));
        }
        let result = (self.read)(&material.record.artifact, &mut blob);
        blob.close()?;
        Ok(Some(result))
    }
}
