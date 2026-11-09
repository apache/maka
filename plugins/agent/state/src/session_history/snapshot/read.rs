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
use serde::de::DeserializeOwned;

pub(super) fn authorize(c: &Connection, snapshot: &Snapshot) -> Result<(), StoreError> {
    let row:Option<(String,String,i64)>=c.query_row("SELECT owner,session,manifest_content_id FROM agent_history_snapshots WHERE snapshot=?",[snapshot.authority_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (owner, session, content) =
        row.ok_or_else(|| invalid("snapshot registration unavailable"))?;
    if capture::reference(c, content)? != snapshot.authority_manifest {
        return Err(StoreError::EventConflict);
    }
    match &snapshot.access {
        Access::Imported { .. } => super::ingest::authorize(c, snapshot)?,
        Access::Captured {
            owner: scope,
            session: scope_session,
        } => {
            if owner != serde_json::to_string(scope)? || &session != scope_session {
                return Err(invalid("snapshot belongs to another source scope"));
            }
        }
        Access::Adopted {
            owner: scope,
            session: scope_session,
            run,
        } => {
            authorize_adopted(
                c,
                snapshot.authority_id,
                &snapshot.authority_manifest,
                scope,
                scope_session,
                *run,
            )?;
        }
    }
    if snapshot.id != snapshot.authority_id {
        let member:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshots s JOIN agent_history_snapshot_pins p ON p.content_id=s.manifest_content_id JOIN contents b ON b.id=p.content_id WHERE s.snapshot=?1 AND p.snapshot=?2 AND b.content_sha256=?3 AND length(b.payload)=?4)",params![snapshot.id.to_string(),snapshot.authority_id.to_string(),snapshot.manifest.digest,bind_u64(snapshot.manifest.bytes)?],|r|r.get(0))?;
        if !member {
            return Err(invalid(
                "nested snapshot is outside its actual parent inventory",
            ));
        }
    }
    Ok(())
}
pub(super) fn pinned(
    c: &Connection,
    snapshot: &Snapshot,
    reference: &ContentRef,
    run: Option<RunId>,
) -> Result<i64, StoreError> {
    authorize(c, snapshot)?;
    pinned_registered(c, snapshot.id, reference, run)
}
pub(super) fn pinned_registered(
    c: &Connection,
    snapshot: SnapshotId,
    reference: &ContentRef,
    run: Option<RunId>,
) -> Result<i64, StoreError> {
    let id = content_id(c, reference)?;
    let accepted: bool = if let Some(run) = run {
        c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_run_refs r JOIN agent_history_snapshot_pins p USING(snapshot,content_id) WHERE r.snapshot=? AND r.run=? AND r.content_id=?)",params![snapshot.to_string(),run.to_string(),id],|r|r.get(0))?
    } else {
        c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_pins WHERE snapshot=? AND content_id=?)",params![snapshot.to_string(),id],|r|r.get(0))?
    };
    if !accepted {
        return Err(invalid(
            "content is outside the original snapshot inventory closure",
        ));
    }
    Ok(id)
}
pub(super) fn decode<T: DeserializeOwned>(
    c: &Connection,
    snapshot: &Snapshot,
    reference: &ContentRef,
    run: Option<RunId>,
) -> Result<T, StoreError> {
    let id = pinned(c, snapshot, reference, run)?;
    super::super::sql::decode_original(c, id, reference)
}
pub(super) fn decode_registered<T: DeserializeOwned>(
    c: &Connection,
    snapshot: SnapshotId,
    reference: &ContentRef,
    run: Option<RunId>,
) -> Result<T, StoreError> {
    let id = pinned_registered(c, snapshot, reference, run)?;
    super::super::sql::decode_original(c, id, reference)
}
fn authorize_adopted(
    c: &Connection,
    id: SnapshotId,
    manifest: &ContentRef,
    owner: &RunOwner,
    session: &str,
    run: RunId,
) -> Result<(), StoreError> {
    let content = content_id(c, manifest)?;
    let accepted:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_adoptions a JOIN agent_history_snapshots s ON s.snapshot=a.snapshot AND s.manifest_content_id=?1 JOIN agent_run_specs r ON r.run=a.run JOIN agent_content_pins p ON p.run=r.run AND p.content_id=?1 WHERE a.run=?2 AND a.snapshot=?3 AND r.owner=?4 AND r.session=?5)",params![content,run.to_string(),id.to_string(),serde_json::to_string(owner)?,session],|r|r.get(0))?;
    if !accepted {
        return Err(invalid(
            "snapshot is not adopted by this original target Run",
        ));
    }
    Ok(())
}
pub(super) struct Open(pub HistoryNamespace, pub HistoryCut, pub RunId);
impl Query for Open {
    type Output = (SnapshotId, ContentRef);
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        super::super::sql::validate_cut(c, &self.0.owner, &self.0.session, &self.1)?;
        let source = super::super::sql::run_source(c, &self.0, self.2)?;
        if source.admission_sequence > self.1.through_sequence {
            return Err(invalid("snapshot adoption is outside the captured cut"));
        }
        let reference = match source.spec.origin {
            RunOrigin::Imported { source } | RunOrigin::Forked { source, .. } => source,
            RunOrigin::Local => {
                return Err(invalid(
                    "local execution is not an adopted historical source",
                ));
            }
        };
        let raw:String=c.query_row("SELECT a.snapshot FROM agent_history_snapshot_adoptions a JOIN agent_history_snapshots s ON s.snapshot=a.snapshot JOIN contents b ON b.id=s.manifest_content_id JOIN agent_content_pins p ON p.run=a.run AND p.content_id=b.id WHERE a.run=? AND b.content_sha256=? AND length(b.payload)=?",params![self.2.to_string(),reference.digest,bind_u64(reference.bytes)?],|r|r.get(0))?;
        let id = super::super::sql::identity(raw)?;
        Ok((id, reference))
    }
}
pub(super) struct Header(pub Snapshot);
impl Query for Header {
    type Output = Manifest;
    fn execute(self, c: &Connection) -> Result<Manifest, StoreError> {
        let manifest: Manifest = decode(c, &self.0, &self.0.manifest, None)?;
        manifest.validate().map_err(invalid)?;
        if manifest.id != self.0.id {
            return Err(StoreError::EventConflict);
        }
        Ok(manifest)
    }
}

fn records(
    c: &Connection,
    snapshot: &Snapshot,
    run: Option<RunId>,
    after: u64,
    size: u32,
) -> Result<SnapshotPage, StoreError> {
    authorize(c, snapshot)?;
    let size = super::super::sql::limit(size)?;
    let (statement, bound) = if run.is_some() {
        (
            "SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=?1 AND kind='fact' AND run=?2 AND json_extract(entry_json,'$.revision')>?3 ORDER BY json_extract(entry_json,'$.revision') LIMIT ?4",
            Some(after),
        )
    } else {
        (
            "SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=?1 AND kind='fact' AND sequence>?3 ORDER BY sequence LIMIT ?4",
            Some(after),
        )
    };
    let mut query = c.prepare_cached(statement)?;
    let raw: Vec<String> = query
        .query_map(
            params![
                snapshot.id.to_string(),
                run.map(|run| run.to_string()),
                bind_u64(bound.expect("bound"))?,
                size + 1
            ],
            |r| r.get(0),
        )?
        .collect::<Result<_, _>>()?;
    let more = raw.len() > size as usize;
    let mut items = Vec::with_capacity(size as usize);
    for raw in raw.into_iter().take(size as usize) {
        let Entry::Fact {
            run,
            sequence,
            admission_sequence,
            revision,
            step,
            attempt,
            id,
            body,
            ..
        } = serde_json::from_str(&raw)?
        else {
            return Err(invalid("snapshot fact index has another entry kind"));
        };
        let recorded: RecordedFact = decode(c, snapshot, &body, Some(run))?;
        if recorded.run != run
            || recorded.id != id
            || recorded.revision != revision
            || recorded.schema_version != SCHEMA_VERSION
        {
            return Err(invalid(
                "snapshot original fact identity differs from its index",
            ));
        }
        items.push(HistoryItem {
            sequence,
            admission_sequence,
            scope: HistoryScope { step, attempt },
            recorded,
        });
    }
    let next = if more {
        items.last().map(|item| {
            if run.is_some() {
                item.recorded.revision
            } else {
                item.sequence
            }
        })
    } else {
        None
    };
    Ok(SnapshotPage { items, next })
}
pub(super) struct Page(pub Snapshot, pub u64, pub u32);
impl Query for Page {
    type Output = SnapshotPage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        records(c, &self.0, None, self.1, self.2)
    }
}
pub(super) struct History(pub Snapshot, pub RunId, pub u64, pub u32);
impl Query for History {
    type Output = Vec<RecordedFact>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(records(c, &self.0, Some(self.1), self.2, self.3)?
            .items
            .into_iter()
            .map(|item| item.recorded)
            .collect())
    }
}
pub(super) struct Run(pub Snapshot, pub RunId);
impl Query for Run {
    type Output = RunSource;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        authorize(c, &self.0)?;
        run_registered(c, self.0.id, self.1)
    }
}
fn run_registered(
    c: &Connection,
    snapshot: SnapshotId,
    wanted: RunId,
) -> Result<RunSource, StoreError> {
    let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='run' AND run=?",params![snapshot.to_string(),wanted.to_string()],|r|r.get(0))?;
    let Entry::Run {
        run,
        admission_sequence,
        spec,
        admission,
    } = serde_json::from_str(&raw)?
    else {
        return Err(invalid("snapshot Run index has another entry kind"));
    };
    let value: RunSpec = decode_registered(c, snapshot, &spec, Some(run))?;
    let admitted: RecordedFact = decode_registered(c, snapshot, &admission, Some(run))?;
    if run != wanted
        || admitted.run != run
        || admitted.revision != 1
        || !matches!(&admitted.fact,Fact::RunAdmitted{spec:actual} if actual==&spec)
    {
        return Err(invalid(
            "snapshot original Run differs from its immutable admission",
        ));
    }
    Ok(RunSource {
        run,
        admission_sequence,
        spec: value,
        spec_ref: spec,
        admission: admitted,
    })
}

pub(super) struct ToolCall(pub Snapshot, pub RunId, pub ToolKey);
impl Query for ToolCall {
    type Output = maka_agent_facts::model::ModelToolCall;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        use maka_agent_facts::model::ModelPart;
        authorize(c, &self.0)?;
        let use_id =
            maka_agent_facts::tool_call::tool_use_id(self.1, &crate::fold::tool_key(&self.2));
        let raw: Option<String> = c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_tool_source WHERE snapshot=? AND kind='fact' AND json_extract(entry_json,'$.tool_use_id')=? ORDER BY sequence LIMIT 1",params![self.0.id.to_string(),use_id],|r|r.get(0)).optional()?;
        let raw = raw.ok_or_else(|| invalid("original model tool call missing from snapshot"))?;
        let Entry::Fact {
            run,
            id,
            revision,
            body,
            ..
        } = serde_json::from_str(&raw)?
        else {
            return Err(invalid("snapshot tool call index has another entry kind"));
        };
        if run != self.1 {
            return Err(invalid(
                "snapshot original tool call belongs to another Run",
            ));
        }
        let recorded: RecordedFact = decode_registered(c, self.0.id, &body, Some(run))?;
        if recorded.run != run
            || recorded.id != id
            || recorded.revision != revision
            || recorded.schema_version != SCHEMA_VERSION
        {
            return Err(invalid("snapshot original tool call fact identity differs"));
        }
        match recorded.fact {
            Fact::ModelObserved {
                attempt,
                part: ModelPart::ToolCall { call },
                ..
            } if attempt == self.2.attempt && call.id == self.2.call => Ok(call),
            _ => Err(invalid(
                "snapshot original tool call source identity differs",
            )),
        }
    }
}

pub(super) struct Request(pub Snapshot, pub RunId, pub StepId);
impl Query for Request {
    type Output = RequestSpec;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        authorize(c, &self.0)?;
        let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.step')=? ORDER BY sequence LIMIT 1",params![self.0.id.to_string(),self.1.to_string(),self.2.to_string()],|r|r.get(0))?;
        let Entry::Fact { body, run, .. } = serde_json::from_str(&raw)? else {
            return Err(invalid("snapshot Step index has another entry kind"));
        };
        let recorded: RecordedFact = decode(c, &self.0, &body, Some(run))?;
        let Fact::StepPrepared { step, request, .. } = recorded.fact else {
            return Err(invalid("snapshot Step has no original preparation"));
        };
        if step != self.2 || run != self.1 {
            return Err(invalid("snapshot request belongs to another Step/Run"));
        }
        let request: RequestSpec = decode(c, &self.0, &request, Some(run))?;
        if request.step != step || request.schema_version != SCHEMA_VERSION {
            return Err(invalid("invalid original snapshot request"));
        }
        Ok(request)
    }
}
pub(super) struct Sources(pub Snapshot, pub u64, pub Option<u64>, pub u32);
impl Query for Sources {
    type Output = SnapshotSources;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        authorize(c, &self.0)?;
        let size = super::super::sql::limit(self.3)?;
        let after = self.2.map(bind_u64).transpose()?.unwrap_or(-1);
        let mut raw:Vec<String>=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='source' AND sequence=? AND position>? ORDER BY position LIMIT ?")?.query_map(params![self.0.id.to_string(),bind_u64(self.1)?,after,size+1],|r|r.get(0))?.collect::<Result<_,_>>()?;
        let more = raw.len() > size as usize;
        raw.truncate(size as usize);
        let mut sources = Vec::with_capacity(raw.len());
        for raw in raw {
            let Entry::Source {
                position,
                source,
                resources,
                ..
            } = serde_json::from_str(&raw)?
            else {
                return Err(invalid("snapshot source index has another entry kind"));
            };
            sources.push(Source {
                position,
                source,
                resources,
            });
        }
        let next = if more {
            sources.last().map(|source| source.position)
        } else {
            None
        };
        Ok(SnapshotSources { sources, next })
    }
}
pub(super) struct Content<F>(pub Snapshot, pub Option<RunId>, pub ContentRef, pub F);
impl<T: Send + 'static, F: FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static>
    Query for Content<F>
{
    type Output = T;
    fn execute(self, c: &Connection) -> Result<T, StoreError> {
        let row = pinned(c, &self.0, &self.2, self.1)?;
        super::super::sql::read_blob(c, row, &self.2, |blob| (self.3)(blob))
    }
}
pub(super) struct SourceContent<F>(pub Snapshot, pub u64, pub u64, pub ContentRef, pub F);
impl<T: Send + 'static, F: FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static>
    Query for SourceContent<F>
{
    type Output = T;
    fn execute(self, c: &Connection) -> Result<T, StoreError> {
        authorize(c, &self.0)?;
        let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='source' AND sequence=? AND position=?",params![self.0.id.to_string(),bind_u64(self.1)?,bind_u64(self.2)?],|r|r.get(0))?;
        let Entry::Source {
            source, resources, ..
        } = serde_json::from_str(&raw)?
        else {
            return Err(invalid("snapshot source index has another entry kind"));
        };
        if self.3 != source && self.3 != resources {
            return Err(invalid("content is not this original snapshot source"));
        }
        let row = pinned(c, &self.0, &self.3, None)?;
        super::super::sql::read_blob(c, row, &self.3, |blob| (self.4)(blob))
    }
}
fn artifact(
    c: &Connection,
    snapshot: &Snapshot,
    owner: &RunOwner,
    session: &str,
    run: Option<RunId>,
    id: &str,
) -> Result<Option<PublishedArtifact>, StoreError> {
    authorize(c, snapshot)?;
    let raw:Vec<String>=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_artifact WHERE snapshot=?1 AND kind='artifact' AND json_extract(entry_json,'$.owner')=?2 AND json_extract(entry_json,'$.session')=?3 AND json_extract(entry_json,'$.record.artifact.id')=?4 AND (?5 IS NULL OR run=?5) ORDER BY sequence LIMIT 2")?.query_map(params![snapshot.id.to_string(),serde_json::to_string(owner)?,session,id,run.map(|r|r.to_string())],|r|r.get(0))?.collect::<Result<_,_>>()?;
    let mut found = None;
    for raw in raw {
        let Entry::Artifact { record, .. } = serde_json::from_str(&raw)? else {
            return Err(invalid("snapshot artifact index has another entry kind"));
        };
        record.artifact.validate().map_err(invalid)?;
        if record.artifact.id != id
            || record.artifact.session_id != session
            || record.artifact.size_bytes != record.payload.bytes
        {
            return Err(invalid(
                "snapshot media descriptor differs from its original payload",
            ));
        }
        pinned(c, snapshot, &record.payload, None)?;
        if found.as_ref().is_some_and(|old| old != &record) {
            return Err(invalid(
                "snapshot has conflicting original artifact identities",
            ));
        }
        found = Some(record);
    }
    Ok(found)
}
pub(super) struct ArtifactMetadata(
    pub Snapshot,
    pub RunOwner,
    pub String,
    pub Option<RunId>,
    pub String,
);
impl Query for ArtifactMetadata {
    type Output = Option<PublishedArtifact>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        artifact(c, &self.0, &self.1, &self.2, self.3, &self.4)
    }
}
pub(super) struct ArtifactContent<F>(
    pub Snapshot,
    pub RunOwner,
    pub String,
    pub Option<RunId>,
    pub String,
    pub F,
);
impl<
    T: Send + 'static,
    F: FnOnce(&Artifact, &mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
> Query for ArtifactContent<F>
{
    type Output = Option<T>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let Some(record) = artifact(c, &self.0, &self.1, &self.2, self.3, &self.4)? else {
            return Ok(None);
        };
        let row = pinned(c, &self.0, &record.payload, None)?;
        super::super::sql::read_blob(c, row, &record.payload, |blob| {
            (self.5)(&record.artifact, blob)
        })
        .map(Some)
    }
}
pub(super) struct Imported(pub Snapshot, pub Option<u64>, pub u32);
impl Query for Imported {
    type Output = ImportedPage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        authorize(c, &self.0)?;
        let size = super::super::sql::limit(self.2)?;
        let after = self.1.map(bind_u64).transpose()?.unwrap_or(-1);
        let mut raw:Vec<String>=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='imported' AND position>? ORDER BY position LIMIT ?")?.query_map(params![self.0.id.to_string(),after,size+1],|r|r.get(0))?.collect::<Result<_,_>>()?;
        let more = raw.len() > size as usize;
        raw.truncate(size as usize);
        let mut items = Vec::with_capacity(raw.len());
        for raw in raw {
            let Entry::Imported { ordinal, message } = serde_json::from_str(&raw)? else {
                return Err(invalid("imported snapshot index has another entry kind"));
            };
            let value = decode(c, &self.0, &message, None)?;
            items.push((ordinal, value));
        }
        let next = if more {
            items.last().map(|item| item.0)
        } else {
            None
        };
        Ok(ImportedPage { items, next })
    }
}
pub(super) struct ImportedContent<F>(pub Snapshot, pub u64, pub ContentRef, pub F);
impl<T: Send + 'static, F: FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static>
    Query for ImportedContent<F>
{
    type Output = T;
    fn execute(self, c: &Connection) -> Result<T, StoreError> {
        authorize(c, &self.0)?;
        let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='imported' AND position=?",params![self.0.id.to_string(),bind_u64(self.1)?],|r|r.get(0))?;
        let Entry::Imported { message, .. } = serde_json::from_str(&raw)? else {
            return Err(invalid("imported snapshot index has another entry kind"));
        };
        let original: maka_agent_facts::history_snapshot::ImportedMessage =
            decode(c, &self.0, &message, None)?;
        if message != self.2
            && original.original != self.2
            && original.provider_metadata.as_ref() != Some(&self.2)
            && !original.parts.contains(&self.2)
        {
            return Err(invalid(
                "payload is not part of this original imported message",
            ));
        }
        let row = pinned(c, &self.0, &self.2, None)?;
        super::super::sql::read_blob(c, row, &self.2, |blob| (self.3)(blob))
    }
}
pub(super) struct Chunk(pub Snapshot, pub ContentRef, pub u64, pub u32);
impl Query for Chunk {
    type Output = Vec<u8>;
    fn execute(self, c: &Connection) -> Result<Vec<u8>, StoreError> {
        use std::io::{Read, Seek, SeekFrom};
        if self.2 > self.1.bytes {
            return Err(invalid("invalid snapshot chunk range"));
        }
        let row = pinned(c, &self.0, &self.1, None)?;
        super::super::sql::read_blob(c, row, &self.1, |blob| {
            blob.seek(SeekFrom::Start(self.2))?;
            let amount = u64::from(self.3).min(self.1.bytes - self.2);
            let mut bytes = Vec::with_capacity(
                usize::try_from(amount).map_err(|_| invalid("snapshot chunk size overflow"))?,
            );
            blob.take(amount).read_to_end(&mut bytes)?;
            if bytes.len() as u64 != amount {
                return Err(invalid("snapshot payload truncated"));
            }
            Ok(bytes)
        })
    }
}

pub(super) struct Nested(pub Snapshot, pub RunId);
impl Query for Nested {
    type Output = (SnapshotId, ContentRef);
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        authorize(c, &self.0)?;
        nested_registered(c, self.0.id, self.0.authority_id, self.1)
    }
}
pub(super) fn nested_registered(
    c: &Connection,
    snapshot: SnapshotId,
    authority: SnapshotId,
    wanted: RunId,
) -> Result<(SnapshotId, ContentRef), StoreError> {
    let source = run_registered(c, snapshot, wanted)?;
    let reference = match source.spec.origin {
        RunOrigin::Imported { source } | RunOrigin::Forked { source, .. } => source,
        RunOrigin::Local => {
            return Err(invalid("original Run is not a historical source marker"));
        }
    };
    let manifest: Manifest = decode_registered(c, snapshot, &reference, Some(wanted))?;
    manifest.validate().map_err(invalid)?;
    let registered:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshots s JOIN contents b ON b.id=s.manifest_content_id WHERE s.snapshot=? AND b.content_sha256=? AND length(b.payload)=?)",params![manifest.id.to_string(),reference.digest,bind_u64(reference.bytes)?],|r|r.get(0))?;
    if !registered {
        return Err(invalid(
            "nested snapshot index missing; explicit snapshot rebuild required",
        ));
    }
    let missing:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_pins child WHERE child.snapshot=?1 AND NOT EXISTS(SELECT 1 FROM agent_history_snapshot_pins parent WHERE parent.snapshot=?2 AND parent.content_id=child.content_id))",params![manifest.id.to_string(),authority.to_string()],|r|r.get(0))?;
    if missing {
        return Err(invalid(
            "nested snapshot payload closure was not copied into its actual parent",
        ));
    }
    Ok((manifest.id, reference))
}

pub(super) struct Captured(pub HistoryNamespace, pub SnapshotId);
impl Query for Captured {
    type Output = Option<(CaptureRequest, ContentRef)>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let row:Option<(String,String,String,i64)>=c.query_row("SELECT owner,session,request_json,manifest_content_id FROM agent_history_snapshots WHERE snapshot=?",[self.1.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((owner, session, request, manifest)) = row else {
            return Ok(None);
        };
        if owner != serde_json::to_string(&self.0.owner)? || session != self.0.session {
            return Err(invalid(
                "capture receipt belongs to another actual session namespace",
            ));
        }
        let request: CaptureRequest = serde_json::from_str(&request)?;
        if request.id != self.1
            || request.cut.owner != self.0.owner
            || request.cut.session != self.0.session
        {
            return Err(invalid("capture receipt identity corrupt"));
        }
        Ok(Some((request, capture::reference(c, manifest)?)))
    }
}

/// A real borrowed Root transaction plus its canonical adoption, never a
/// fabricated DataWriter or a descriptor accepted as external authority.
pub(super) struct TransactionSnapshot<'c> {
    c: &'c Connection,
    namespace: HistoryNamespace,
    target: RunId,
    root: SnapshotId,
    root_manifest: ContentRef,
    id: SnapshotId,
    manifest: ContentRef,
}
impl<'c> TransactionSnapshot<'c> {
    pub(super) fn open(
        c: &'c Connection,
        namespace: &HistoryNamespace,
        cut: &HistoryCut,
        target: RunId,
    ) -> Result<Self, StoreError> {
        let (id, manifest) = Open(namespace.clone(), cut.clone(), target).execute(c)?;
        authorize_adopted(
            c,
            id,
            &manifest,
            &namespace.owner,
            &namespace.session,
            target,
        )?;
        Ok(Self {
            c,
            namespace: namespace.clone(),
            target,
            root: id,
            root_manifest: manifest.clone(),
            id,
            manifest,
        })
    }
    fn authorize(&self) -> Result<(), StoreError> {
        authorize_adopted(
            self.c,
            self.root,
            &self.root_manifest,
            &self.namespace.owner,
            &self.namespace.session,
            self.target,
        )
    }
    pub(super) fn id(&self) -> SnapshotId {
        self.id
    }
    pub(super) fn manifest(&self) -> Result<Manifest, StoreError> {
        self.authorize()?;
        let manifest: Manifest = decode_registered(self.c, self.id, &self.manifest, None)?;
        manifest.validate().map_err(invalid)?;
        if manifest.id != self.id {
            return Err(invalid("snapshot header identity corrupt"));
        }
        Ok(manifest)
    }
    pub(super) fn run(&self, run: RunId) -> Result<RunSource, StoreError> {
        self.authorize()?;
        run_registered(self.c, self.id, run)
    }
    pub(super) fn nested(&self, run: RunId) -> Result<Self, StoreError> {
        self.authorize()?;
        let (id, manifest) = nested_registered(self.c, self.id, self.root, run)?;
        Ok(Self {
            c: self.c,
            namespace: self.namespace.clone(),
            target: self.target,
            root: self.root,
            root_manifest: self.root_manifest.clone(),
            id,
            manifest,
        })
    }
    pub(super) fn fact(&self, id: FactId) -> Result<Option<HistoryItem>, StoreError> {
        self.authorize()?;
        let raw:Option<String>=self.c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND json_extract(entry_json,'$.id')=?",params![self.id.to_string(),id.to_string()],|r|r.get(0)).optional()?;
        let Some(raw) = raw else { return Ok(None) };
        let Entry::Fact {
            run,
            sequence,
            admission_sequence,
            revision,
            step,
            attempt,
            id: actual,
            body,
            ..
        } = serde_json::from_str(&raw)?
        else {
            return Err(invalid("snapshot fact index kind corrupt"));
        };
        let recorded: RecordedFact = decode_registered(self.c, self.id, &body, Some(run))?;
        if actual != id
            || recorded.id != id
            || recorded.run != run
            || recorded.revision != revision
            || recorded.schema_version != SCHEMA_VERSION
        {
            return Err(invalid("snapshot fact identity corrupt"));
        }
        Ok(Some(HistoryItem {
            sequence,
            admission_sequence,
            scope: HistoryScope { step, attempt },
            recorded,
        }))
    }
}

pub(super) struct Item(pub Snapshot, pub u64);
impl Query for Item {
    type Output = Option<HistoryItem>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        if self.1 == 0 {
            authorize(c, &self.0)?;
            return Ok(None);
        }
        Ok(records(c, &self.0, None, self.1 - 1, 1)?
            .items
            .into_iter()
            .next()
            .filter(|item| item.sequence == self.1))
    }
}
pub(super) struct ImportedItem(pub Snapshot, pub u64);
pub(super) struct ImportedReference(pub Snapshot, pub u64);
impl Query for ImportedReference {
    type Output = ContentRef;
    fn execute(self, c: &Connection) -> Result<ContentRef, StoreError> {
        Header(self.0.clone()).execute(c)?;
        let raw: String = c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='imported' AND position=?", params![self.0.id.to_string(),bind_u64(self.1)?], |row|row.get(0))?;
        let Entry::Imported { ordinal, message } = serde_json::from_str(&raw)? else {
            return Err(invalid("imported source index kind differs"));
        };
        if ordinal != self.1 {
            return Err(invalid("imported source original message ordinal differs"));
        }
        message.validate().map_err(invalid)?;
        pinned(c, &self.0, &message, None)?;
        Ok(message)
    }
}
impl Query for ImportedItem {
    type Output = maka_agent_facts::history_snapshot::ImportedMessage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        authorize(c, &self.0)?;
        let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='imported' AND position=?",params![self.0.id.to_string(),bind_u64(self.1)?],|r|r.get(0))?;
        let Entry::Imported { message, .. } = serde_json::from_str(&raw)? else {
            return Err(invalid("imported source index kind corrupt"));
        };
        decode(c, &self.0, &message, None)
    }
}
pub(super) struct View(pub Snapshot, pub RunId);
impl Query for View {
    type Output = crate::fold::RunView;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        view_with_late(c, &self.0, self.1).map(|(view, _)| view)
    }
}
pub(super) fn view_with_late(
    c: &Connection,
    snapshot: &Snapshot,
    run_id: RunId,
) -> Result<(crate::fold::RunView, u64), StoreError> {
    authorize(c, snapshot)?;
    let source = run_registered(c, snapshot.id, run_id)?;
    let mut view = crate::fold::RunView::admitted(source.run, source.spec)?;
    let mut statement=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND run=? ORDER BY json_extract(entry_json,'$.revision')")?;
    let mut rows = statement.query(params![snapshot.id.to_string(), run_id.to_string()])?;
    let mut terminal_sequence = None;
    let mut late_sequence = 0;
    while let Some(row) = rows.next()? {
        let Entry::Fact {
            run,
            revision,
            sequence,
            id,
            body,
            ..
        } = serde_json::from_str(&row.get::<_, String>(0)?)?
        else {
            return Err(invalid("snapshot fact index kind corrupt"));
        };
        let record: RecordedFact = decode_registered(c, snapshot.id, &body, Some(run_id))?;
        if record.run != run
            || run != run_id
            || record.id != id
            || record.revision != revision
            || record.schema_version != SCHEMA_VERSION
        {
            return Err(invalid("snapshot fact identity corrupt"));
        }
        view.apply(&record)?;
        if matches!(record.fact, Fact::RunTerminated { .. }) {
            terminal_sequence = Some(sequence);
        } else if record.fact.is_late()
            && terminal_sequence.is_some_and(|terminal| sequence > terminal)
        {
            late_sequence = late_sequence.max(sequence);
        }
    }
    Ok((view, late_sequence))
}
pub(super) struct LatestSource(pub Snapshot);
impl Query for LatestSource {
    type Output = Option<RunSource>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        authorize(c, &self.0)?;
        if matches!(
            Header(self.0.clone()).execute(c)?.origin,
            Origin::Imported { .. }
        ) {
            return Ok(None);
        }
        let run:Option<String>=c.query_row("SELECT e.run FROM agent_history_snapshot_entries e INDEXED BY agent_history_snapshot_historical WHERE e.snapshot=? AND e.historical=1 ORDER BY e.sequence DESC LIMIT 1",[self.0.id.to_string()],|r|r.get(0)).optional()?;
        let Some(run) = run else { return Ok(None) };
        let source = run_registered(c, self.0.id, super::super::sql::identity(run)?)?;
        if !super::super::sql::historical_backend(&source.spec)?
            || source.spec.origin == RunOrigin::Local
        {
            return Err(invalid(
                "historical source index refers to a local executable Run",
            ));
        }
        Ok(Some(source))
    }
}

pub(super) struct ToolPositions(
    pub Snapshot,
    pub String,
    pub Option<(u64, u64)>,
    pub u64,
    pub u32,
);
impl Query for ToolPositions {
    type Output = Vec<maka_agent_facts::history_snapshot::SnapshotPosition>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        use maka_agent_facts::history_snapshot::SnapshotPosition;
        let manifest = Header(self.0.clone()).execute(c)?;
        let Origin::Canonical { cut } = manifest.origin else {
            return Ok(vec![]);
        };
        let bound = self.2.unwrap_or((0, 0));
        let rows:Vec<(String,u64,u64,String,u64,bool)>=c.prepare_cached("SELECT p.run,p.major,p.admission_sequence,p.fact,p.minor,p.internal FROM agent_history_snapshot_entries e INDEXED BY agent_history_snapshot_tool_source CROSS JOIN agent_history_snapshot_positions p ON p.snapshot=e.snapshot AND p.kind='canonical' AND p.major=e.sequence WHERE e.snapshot=?1 AND e.kind='fact' AND json_extract(e.entry_json,'$.tool_use_id')=?2 AND p.admission_sequence>?3 AND p.major<=?4 AND (p.major,p.minor)>(?5,?6) ORDER BY p.major,p.minor LIMIT ?7")?.query_map(params![self.0.id.to_string(),self.1,bind_u64(self.3)?,bind_u64(cut.through_sequence)?,bind_u64(bound.0)?,bind_u64(bound.1)?,i64::from(self.4)],|r|Ok((r.get(0)?,read_u64(r,1)?,read_u64(r,2)?,r.get(3)?,read_u64(r,4)?,r.get(5)?)))?.collect::<Result<_,_>>()?;
        rows.into_iter()
            .map(
                |(run, sequence, admission_sequence, fact, item_index, internal)| {
                    Ok(SnapshotPosition::Canonical {
                        run: super::super::sql::identity(run)?,
                        sequence,
                        admission_sequence,
                        fact: super::super::sql::identity(fact)?,
                        item_index,
                        internal,
                    })
                },
            )
            .collect()
    }
}

pub(super) struct EventExists(pub Snapshot, pub u64);
impl Query for EventExists {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let Origin::Canonical { cut } = Header(self.0.clone()).execute(c)?.origin else {
            return Err(invalid("imported source has no canonical event sequence"));
        };
        Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND sequence=? AND sequence<=?)",params![self.0.id.to_string(),bind_u64(self.1)?,bind_u64(cut.through_sequence)?],|r|r.get(0))?)
    }
}
