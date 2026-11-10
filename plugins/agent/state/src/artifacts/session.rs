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
use crate::ContentBlob;
use maka_agent_facts::artifact::{ArtifactSource, content_digest, upload_artifact_id};
use maka_event_log::{
    content,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::{Connection, OptionalExtension, params};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Origin {
    Upload {
        logical_id: String,
    },
    Copy {
        source: SourceProof,
        provenance: Option<ContentRef>,
    },
    Produced {
        provenance: ContentRef,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Registration {
    schema_version: u32,
    owner: RunOwner,
    operation: String,
    pub record: PublishedArtifact,
    origin: Origin,
}
impl Registration {
    fn provenance_ref(&self) -> Option<&ContentRef> {
        match &self.origin {
            Origin::Produced { provenance }
            | Origin::Copy {
                provenance: Some(provenance),
                ..
            } => Some(provenance),
            Origin::Upload { .. }
            | Origin::Copy {
                provenance: None, ..
            } => None,
        }
    }
    pub(super) fn retained_provenance(&self, c: &Connection) -> Result<(), StoreError> {
        self.provenance(c).map(|_| ())
    }
    pub(super) fn provenance(
        &self,
        c: &Connection,
    ) -> Result<Option<(ContentRef, i64)>, StoreError> {
        let Some(provenance) = self.provenance_ref() else {
            return Ok(None);
        };
        let rowid = tool::content_id(c, provenance)?;
        let retained: Option<i64> = c.query_row(
            "SELECT provenance_content_id FROM agent_session_artifact_registrations WHERE session=? AND artifact=? AND owner=?",
            params![self.record.artifact.session_id, self.record.artifact.id, serde_json::to_string(&self.owner)?],
            |row| row.get(0),
        )?;
        if retained != Some(rowid) {
            return Err(invalid(
                "Produced provenance differs from original session ownership pin",
            ));
        }
        Ok(Some((provenance.clone(), rowid)))
    }
    pub(super) fn validate(&self, scope: &SessionScope) -> Result<(), StoreError> {
        identity(&scope.session)?;
        identity(&self.operation)?;
        validate_record(&self.record)?;
        if self.schema_version != SCHEMA_VERSION
            || self.owner != scope.owner
            || self.record.artifact.session_id != scope.session
        {
            return Err(invalid(
                "session artifact registration scope/schema differs",
            ));
        }
        if let Some(provenance) = self.provenance_ref() {
            provenance.validate().map_err(invalid)?;
            if !matches!(
                self.record.artifact.source,
                ArtifactSource::SessionEffect | ArtifactSource::SubagentWriteback
            ) {
                return Err(invalid(
                    "Produced provenance requires the original Produced artifact source",
                ));
            }
        }
        match &self.origin {
            Origin::Upload { logical_id } => {
                identity(logical_id)?;
                if self.record.artifact.id != upload_artifact_id(&scope.session, logical_id)
                    || self.record.artifact.source != ArtifactSource::UserUpload
                    || self.record.artifact.summary.as_deref()
                        != Some(self.record.payload.digest.as_str())
                {
                    return Err(invalid("upload identity or immutable digest differs"));
                }
            }
            Origin::Copy { .. } => {
                if self.record.artifact.id != copy_id(&scope.session, &self.operation) {
                    return Err(invalid("copy identity differs from original command"));
                }
            }
            Origin::Produced { .. } => {}
        }
        Ok(())
    }
}
#[derive(Clone)]
pub(super) struct LocalCopy {
    pub copy: CopyArtifact,
    pub store: DataWriter,
    pub writer: DataWriter,
}
impl Statement for LocalCopy {
    type Value = PublishedArtifact;
    type Output = PublishedArtifact;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        vec![Arc::new(self.clone())]
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let result = if !self.store.same_root(&self.writer)
            || !self.copy.source.root.same_root(&self.writer)
        {
            Err(invalid(
                "artifact copy source belongs to another selected Root",
            ))
        } else {
            Write::copy(self.copy).execute(c)
        };
        result.map_err(|error| {
            if Write::isolated_rejection(&error) {
                StoreError::StatementRejected {
                    diagnostic: COPY_REJECTED.into(),
                    cause: Arc::new(error),
                }
            } else {
                error
            }
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::StatementRejected { diagnostic, .. } if diagnostic == COPY_REJECTED)
    }
}

pub(super) enum Write {
    Upload(Upload),
    Produced(SessionArtifactWrite),
    PreparedMaterial {
        scope: SessionScope,
        registration: Registration,
        body: ContentBlob,
        bytes: Arc<Vec<u8>>,
        provenance: Option<ContentBlob>,
    },
    Copy(CopyArtifact),
}
impl Write {
    pub(super) fn upload(upload: Upload) -> Self {
        Self::Upload(upload)
    }
    pub(super) fn produced(write: SessionArtifactWrite) -> Self {
        Self::Produced(write)
    }
    pub(super) fn copy(copy: CopyArtifact) -> Self {
        Self::Copy(copy)
    }
}
impl Statement for Write {
    type Value = PublishedArtifact;
    type Output = PublishedArtifact;
    const PREPARE_OFF_THREAD: bool = true;
    fn prepare(self) -> Result<Self, StoreError> {
        match self {
            Self::Upload(upload) => {
                let record = PublishedArtifact {
                    artifact: upload.artifact,
                    payload: ContentRef {
                        digest: content_digest(&upload.bytes),
                        bytes: upload.bytes.len() as u64,
                    },
                };
                let registration = Registration {
                    schema_version: SCHEMA_VERSION,
                    owner: upload.scope.owner.clone(),
                    operation: upload.operation,
                    record,
                    origin: Origin::Upload {
                        logical_id: upload.logical_id,
                    },
                };
                registration.validate(&upload.scope)?;
                let body = ContentBlob::json(&registration)?;
                Ok(Self::PreparedMaterial {
                    scope: upload.scope,
                    registration,
                    body,
                    bytes: upload.bytes,
                    provenance: None,
                })
            }
            Self::Produced(write) => {
                let record = PublishedArtifact {
                    artifact: write.artifact,
                    payload: ContentRef {
                        digest: content_digest(&write.bytes),
                        bytes: write.bytes.len() as u64,
                    },
                };
                let registration = Registration {
                    schema_version: SCHEMA_VERSION,
                    owner: write.scope.owner.clone(),
                    operation: write.operation,
                    record,
                    origin: Origin::Produced {
                        provenance: write.provenance.reference().clone(),
                    },
                };
                registration.validate(&write.scope)?;
                let body = ContentBlob::json(&registration)?;
                Ok(Self::PreparedMaterial {
                    scope: write.scope,
                    registration,
                    body,
                    bytes: write.bytes,
                    provenance: Some(write.provenance),
                })
            }
            other => Ok(other),
        }
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let (scope, registration, body, bytes, provenance) = match self {
            Self::PreparedMaterial {
                scope,
                registration,
                body,
                bytes,
                provenance,
            } => (scope, registration, Some(body), Some(bytes), provenance),
            Self::Copy(copy) => {
                let source = read::original(c, &copy.source)?;
                let record = PublishedArtifact {
                    artifact: copy.artifact,
                    payload: source.record.payload,
                };
                let registration = Registration {
                    schema_version: SCHEMA_VERSION,
                    owner: copy.destination.owner.clone(),
                    operation: copy.operation,
                    record,
                    origin: Origin::Copy {
                        source: copy.source.proof,
                        provenance: source.provenance.map(|(reference, _)| reference),
                    },
                };
                registration.validate(&copy.destination)?;
                (copy.destination, registration, None, None, None)
            }
            Self::Upload(_) | Self::Produced(_) => {
                return Err(invalid("artifact bytes were not prepared off thread"));
            }
        };
        let (record, changed) = register(
            c,
            &scope,
            registration,
            body,
            bytes.as_deref().map(Vec::as_slice),
            provenance,
        )?;
        Ok(Prepared {
            value: record,
            changed,
            notification: if changed {
                Notification::METADATA.with_sessions([scope.session])
            } else {
                Notification::NONE
            },
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::EventConflict
        )
    }
}
fn register(
    c: &Connection,
    scope: &SessionScope,
    mut registration: Registration,
    body: Option<ContentBlob>,
    bytes: Option<&[u8]>,
    provenance: Option<ContentBlob>,
) -> Result<(PublishedArtifact, bool), StoreError> {
    let previous:Option<Vec<u8>>=c.query_row("SELECT b.payload FROM agent_session_artifact_registrations r JOIN contents b ON b.id=r.body_content_id WHERE r.session=? AND (r.artifact=? OR r.operation=?)",params![scope.session,registration.record.artifact.id,registration.operation],|r|r.get(0)).optional()?;
    if let Some(body) = previous {
        let previous: Registration = serde_json::from_slice(&body)?;
        previous.validate(scope)?;
        // First capture time is stable; it is not a caller's command argument.
        registration.record.artifact.created_at = previous.record.artifact.created_at;
        if previous != registration {
            return Err(StoreError::EventConflict);
        }
        tool::content_id(c, &previous.record.payload)?;
        previous.retained_provenance(c)?;
        return Ok((previous.record, false));
    }
    if let Some(bytes) = bytes {
        content::put(c, &registration.record.payload.digest, bytes)?;
    }
    let payload_id = tool::content_id(c, &registration.record.payload)?;
    let stored_provenance = provenance.as_ref().map(|blob| blob.store(c)).transpose()?;
    let provenance_id = registration
        .provenance_ref()
        .map(|reference| tool::content_id(c, reference))
        .transpose()?;
    if matches!(registration.origin, Origin::Produced { .. }) && stored_provenance != provenance_id
    {
        return Err(invalid("session artifact provenance bytes differ"));
    }
    let body = match body {
        Some(body) => body,
        None => ContentBlob::json(&registration)?,
    };
    let body_id = body.store(c)?;
    c.execute("INSERT INTO agent_session_artifact_registrations(session,artifact,owner,operation,body_content_id,content_id,provenance_content_id) VALUES(?,?,?,?,?,?,?)",params![scope.session,registration.record.artifact.id,serde_json::to_string(&scope.owner)?,registration.operation,body_id,payload_id,provenance_id])?;
    tool::project_record(c, &scope.owner, &registration.record)?;
    Ok((registration.record, true))
}
pub(super) struct Rebuild(pub SessionScope);
impl Statement for Rebuild {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        identity(&self.0.session)?;
        let owner = serde_json::to_string(&self.0.owner)?;
        c.execute(
            "DELETE FROM agent_artifacts WHERE session=? AND owner=?",
            params![self.0.session, owner],
        )?;
        let mut after = String::new();
        loop {
            let rows=c.prepare_cached("SELECT r.artifact,b.payload FROM agent_session_artifact_registrations r JOIN contents b ON b.id=r.body_content_id WHERE r.session=? AND r.owner=? AND r.artifact>? ORDER BY r.artifact LIMIT 128")?.query_map(params![self.0.session,owner,after],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Vec<u8>>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
            if rows.is_empty() {
                break;
            }
            for (id, body) in rows {
                let registration: Registration = serde_json::from_slice(&body)?;
                registration.validate(&self.0)?;
                registration.retained_provenance(c)?;
                if registration.record.artifact.id != id {
                    return Err(invalid("session artifact registry identity differs"));
                }
                tool::project_record(c, &self.0.owner, &registration.record)?;
                after = id;
            }
        }
        let mut after = String::new();
        loop {
            let runs=c.prepare_cached("SELECT run FROM agent_run_specs WHERE session=? AND owner=? AND run>? ORDER BY run LIMIT 128")?.query_map(params![self.0.session,owner,after],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            if runs.is_empty() {
                break;
            }
            for run in runs {
                let id: RunId = serde_json::from_value(serde_json::Value::String(run.clone()))?;
                tool::rebuild(c, id)?;
                after = run;
            }
        }
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::METADATA.with_sessions([self.0.session]),
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        Write::isolated_rejection(error)
    }
}

impl ArtifactStore {
    /// Release only this quiescent session's owned artifact references inside
    /// the original Root Session Remove transaction, not a separate write.
    pub fn retire_session_in_transaction(
        &self,
        c: &Connection,
        guard: &crate::SessionQuiescenceGuard,
        root: &maka_event_log::root_store::RootStore,
    ) -> Result<Prepared<()>, StoreError> {
        if !self.data.same_root(guard.data_writer()) {
            return Err(invalid("artifact retirement belongs to another Root owner"));
        }
        root.validate_data_writer_in_transaction(guard.data_writer(), c)?;
        guard.validate(c)?;
        let session = guard.session();
        let owner = serde_json::to_string(guard.owner())?;
        let mut changed = false;
        let mut after = String::new();
        loop {
            let rows: Vec<(String, i64)> = c.prepare_cached(
                "SELECT artifact,content_id FROM agent_artifacts WHERE owner=? AND session=? AND artifact>? ORDER BY artifact LIMIT 128"
            )?.query_map(params![owner, session, after], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()?;
            if rows.is_empty() {
                break;
            }
            let mut candidates = Vec::with_capacity(rows.len());
            for (artifact, content_id) in rows {
                // The existing FK cascades only the released projection's Run bindings.
                changed |= c.execute(
                    "DELETE FROM agent_artifacts WHERE owner=? AND session=? AND artifact=?",
                    params![owner, session, artifact],
                )? != 0;
                candidates.push(content_id);
                after = artifact;
            }
            release_candidates(c, &candidates)?;
        }
        let mut after = String::new();
        loop {
            let rows: Vec<(String, i64, i64, Option<i64>)> = c.prepare_cached(
                "SELECT artifact,body_content_id,content_id,provenance_content_id FROM agent_session_artifact_registrations WHERE session=? AND owner=? AND artifact>? ORDER BY artifact LIMIT 128"
            )?.query_map(params![session, owner, after], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                .collect::<Result<_, _>>()?;
            if rows.is_empty() {
                break;
            }
            let mut candidates = Vec::with_capacity(rows.len() * 3);
            for (artifact, body, content, provenance) in rows {
                changed |= c.execute(
                    "DELETE FROM agent_session_artifact_registrations WHERE session=? AND owner=? AND artifact=?",
                    params![session, owner, artifact],
                )? != 0;
                candidates.extend([body, content]);
                candidates.extend(provenance);
                after = artifact;
            }
            release_candidates(c, &candidates)?;
        }
        Ok(Prepared {
            value: (),
            changed,
            notification: if changed {
                Notification::MATERIAL_RELEASED
                    .combine(Notification::METADATA.with_sessions([session.to_owned()]))
            } else {
                Notification::NONE
            },
        })
    }
}

fn release_candidates(c: &Connection, candidates: &[i64]) -> Result<(), StoreError> {
    for page in candidates.chunks(128) {
        for content in page {
            c.execute(
                "DELETE FROM contents WHERE id=? AND NOT EXISTS(SELECT 1 FROM content_references r WHERE r.content_id=contents.id)",
                [content],
            )?;
        }
    }
    Ok(())
}
