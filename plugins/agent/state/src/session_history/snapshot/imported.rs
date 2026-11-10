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
use maka_agent_facts::history_snapshot::ImportedMessage;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

/// Private prepared CLI capture tape. It carries actual owned bytes, not a
/// serialized content locator. Canonical exported archives use archive.rs.
pub const IMPORT_TAPE_MAGIC: &[u8] = b"MAKA-IMPORT-1\n";
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedCaptureRequest {
    pub id: SnapshotId,
    pub source: maka_agent_facts::import::Source,
    pub fingerprint: ContentRef,
}
impl SessionHistory {
    pub async fn capture_imported(
        &self,
        request: ImportedCaptureRequest,
        file: File,
        stop: tokio_util::sync::CancellationToken,
    ) -> Result<Snapshot, StoreError> {
        let reference = self
            .data
            .write(CaptureImported(
                self.namespace.clone(),
                request.clone(),
                file,
            ))
            .await?;
        let snapshot = self.bind_captured_snapshot(request.id, reference);
        snapshot.ensure_navigation(stop).await?;
        Ok(snapshot)
    }
}
struct CaptureImported(HistoryNamespace, ImportedCaptureRequest, File);
impl Statement for CaptureImported {
    type Value = ContentRef;
    type Output = ContentRef;
    fn execute(mut self, c: &Connection) -> Result<Prepared<ContentRef>, StoreError> {
        let request = serde_json::to_string(&self.1)?;
        let owner = serde_json::to_string(&self.0.owner)?;
        let old:Option<(String,String,String,i64)>=c.query_row("SELECT owner,session,request_json,manifest_content_id FROM agent_history_snapshots WHERE snapshot=?",[self.1.id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        if let Some((old_owner, session, original, content)) = old {
            if old_owner != owner
                || session != self.0.session
                || serde_json::from_str::<serde_json::Value>(&original)?
                    != serde_json::to_value(&self.1)?
            {
                return Err(StoreError::EventConflict);
            }
            return Ok(Prepared {
                value: capture::reference(c, content)?,
                changed: false,
                notification: Notification::NONE,
            });
        }
        self.2.seek(SeekFrom::Start(0))?;
        let mut magic = vec![0u8; IMPORT_TAPE_MAGIC.len()];
        self.2.read_exact(&mut magic)?;
        if magic != IMPORT_TAPE_MAGIC {
            return Err(invalid("unsupported imported source preparation format"));
        }
        let mut builder = capture::Builder::new(c, self.1.id);
        let mut ordinal = 0u64;
        loop {
            let mut tag = [0u8; 1];
            if self.2.read(&mut tag)? == 0 {
                break;
            }
            match tag[0] {
                0 => {
                    let mut digest = [0u8; 32];
                    self.2.read_exact(&mut digest)?;
                    let bytes = number(&mut self.2)?;
                    let reference = ContentRef {
                        digest: format!("sha256:{}", hex::encode(digest)),
                        bytes,
                    };
                    let mut body = Frame {
                        source: self.2.by_ref().take(bytes),
                        hash: Sha256::new(),
                        bytes: 0,
                    };
                    // put_stream may deduplicate without consuming its reader.
                    // Input bytes still must prove possession of this frame.
                    let id = maka_event_log::content::put_stream(
                        c,
                        &reference.digest,
                        reference.bytes,
                        &mut body,
                    )?;
                    std::io::copy(&mut body, &mut std::io::sink())?;
                    if body.bytes != bytes
                        || format!("sha256:{}", hex::encode(body.hash.finalize()))
                            != reference.digest
                    {
                        return Err(invalid(
                            "imported source frame does not match its actual bytes",
                        ));
                    }
                    c.execute(
                        "INSERT OR IGNORE INTO agent_history_snapshot_pins VALUES(?,?)",
                        params![self.1.id.to_string(), id],
                    )?;
                    builder.add(Entry::Payload {
                        run: None,
                        introduced_sequence: None,
                        content: reference,
                    })?;
                }
                1 => {
                    let bytes = number(&mut self.2)?;
                    let mut frame = self.2.by_ref().take(bytes);
                    let entry: Entry = serde_json::from_reader(&mut frame)?;
                    if frame.limit() != 0 {
                        return Err(invalid("imported source metadata frame is truncated"));
                    }
                    for reference in entry.content_refs() {
                        proved(c, self.1.id, reference)?;
                    }
                    match &entry {
                        Entry::Imported {
                            ordinal: position,
                            message,
                        } => {
                            if *position != ordinal {
                                return Err(invalid(
                                    "imported messages are not in original part order",
                                ));
                            }
                            let content = content_id(c, message)?;
                            let decoded: ImportedMessage =
                                super::super::sql::read_blob(c, content, message, |reader| {
                                    Ok(serde_json::from_reader(std::io::BufReader::new(reader))?)
                                })?;
                            if decoded.artifact_scope.owner != self.0.owner
                                || decoded.artifact_scope.session != self.0.session
                            {
                                return Err(invalid(
                                    "imported media does not use its actual copied source scope",
                                ));
                            }
                            for reference in decoded
                                .parts
                                .iter()
                                .chain(std::iter::once(&decoded.original))
                                .chain(decoded.provider_metadata.iter())
                            {
                                proved(c, self.1.id, reference)?;
                            }
                            for media in &decoded.media {
                                let rows:Vec<String>=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_artifact WHERE snapshot=?1 AND kind='artifact' AND json_extract(entry_json,'$.owner')=?2 AND json_extract(entry_json,'$.session')=?3 AND json_extract(entry_json,'$.record.artifact.id')=?4 AND run IS NULL LIMIT 2")?.query_map(params![self.1.id.to_string(),serde_json::to_string(&decoded.artifact_scope.owner)?,decoded.artifact_scope.session,media],|r|r.get(0))?.collect::<Result<_,_>>()?;
                                let [raw] = rows.as_slice() else {
                                    return Err(invalid(
                                        "imported message media closure is missing or ambiguous",
                                    ));
                                };
                                let Entry::Artifact { record, .. } = serde_json::from_str(raw)?
                                else {
                                    return Err(invalid("imported media index kind corrupt"));
                                };
                                record.artifact.validate().map_err(invalid)?;
                                if record.artifact.id != *media
                                    || record.artifact.session_id != decoded.artifact_scope.session
                                    || record.artifact.size_bytes != record.payload.bytes
                                {
                                    return Err(invalid(
                                        "imported media metadata differs from its actual copied payload",
                                    ));
                                }
                                proved(c, self.1.id, &record.payload)?;
                            }
                            super::positions::imported(
                                c,
                                self.1.id,
                                *position,
                                &decoded,
                                &mut builder,
                            )?;
                            ordinal = ordinal
                                .checked_add(1)
                                .ok_or_else(|| invalid("imported source ordinal exhausted"))?;
                        }
                        Entry::Artifact {
                            owner,
                            session,
                            run: None,
                            through_sequence: None,
                            ..
                        } if owner == &self.0.owner && session == &self.0.session => {}
                        _ => {
                            return Err(invalid(
                                "CLI source cannot install canonical executions or foreign media bindings",
                            ));
                        }
                    }
                    builder.add(entry)?;
                }
                _ => return Err(invalid("unknown imported source preparation record")),
            }
        }
        proved(c, self.1.id, &self.1.fingerprint)?;
        let manifest = builder.finish(Origin::Imported {
            source: self.1.source.clone(),
            fingerprint: self.1.fingerprint.clone(),
        })?;
        let footer = ContentBlob::json(&manifest)?;
        footer.store(c)?;
        c.execute(
            "INSERT INTO agent_history_snapshots VALUES(?,?,?,?,?)",
            params![
                self.1.id.to_string(),
                owner,
                self.0.session,
                request,
                content_id(c, footer.reference())?
            ],
        )?;
        pin(c, self.1.id, footer.reference(), None)?;
        Ok(Prepared {
            value: footer.reference().clone(),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(value: ContentRef) -> ContentRef {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::EventConflict
        )
    }
}
fn number(reader: &mut dyn Read) -> Result<u64, StoreError> {
    let mut bytes = [0u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_be_bytes(bytes))
}
fn proved(c: &Connection, id: SnapshotId, reference: &ContentRef) -> Result<(), StoreError> {
    let row = content_id(c, reference)?;
    let present:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_pins WHERE snapshot=? AND content_id=?)",params![id.to_string(),row],|r|r.get(0))?;
    if !present {
        return Err(invalid(
            "imported reference was not supplied by the actual prepared source bytes",
        ));
    }
    Ok(())
}
struct Frame<R> {
    source: R,
    hash: Sha256,
    bytes: u64,
}
impl<R: Read> Read for Frame<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let n = self.source.read(buffer)?;
        self.hash.update(&buffer[..n]);
        self.bytes = self
            .bytes
            .checked_add(n as u64)
            .ok_or_else(|| std::io::Error::other("imported frame length overflow"))?;
        Ok(n)
    }
}

impl SessionHistory {
    pub async fn captured_imported(
        &self,
        id: SnapshotId,
        stop: tokio_util::sync::CancellationToken,
    ) -> Result<Option<(ImportedCaptureRequest, Snapshot)>, StoreError> {
        let Some((request, manifest)) = self
            .data
            .query(CapturedImported(self.namespace.clone(), id))
            .await?
        else {
            return Ok(None);
        };
        let snapshot = self.bind_captured_snapshot(id, manifest);
        snapshot.ensure_navigation(stop).await?;
        Ok(Some((request, snapshot)))
    }
}
#[derive(Clone, Debug)]
pub struct ImportedSessions {
    pub ids: Vec<String>,
    pub next: Option<String>,
}
struct CapturedImported(HistoryNamespace, SnapshotId);
impl Query for CapturedImported {
    type Output = Option<(ImportedCaptureRequest, ContentRef)>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let row:Option<(String,String,String,i64)>=c.query_row("SELECT owner,session,request_json,manifest_content_id FROM agent_history_snapshots WHERE snapshot=?",[self.1.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((owner, session, request, manifest)) = row else {
            return Ok(None);
        };
        if owner != serde_json::to_string(&self.0.owner)? || session != self.0.session {
            return Err(invalid(
                "import capture receipt belongs to another actual namespace/session",
            ));
        }
        let request: ImportedCaptureRequest = serde_json::from_str(&request)?;
        if request.id != self.1 {
            return Err(invalid("import capture receipt identity corrupt"));
        }
        Ok(Some((request, capture::reference(c, manifest)?)))
    }
}
pub(crate) struct ImportedSessionIds(pub RunOwner, pub String, pub Option<String>, pub u32);
impl Query for ImportedSessionIds {
    type Output = ImportedSessions;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        if self.1.is_empty()
            || self.1.contains('\0')
            || self
                .2
                .as_ref()
                .is_some_and(|after| !after.starts_with(&self.1))
        {
            return Err(invalid("invalid scoped imported session page"));
        }
        let limit = super::super::sql::limit(self.3)?;
        let mut ids:Vec<String>=c.prepare_cached("SELECT DISTINCT r.session FROM agent_run_specs r JOIN agent_history_snapshot_adoptions a ON a.run=r.run JOIN agent_history_snapshots s ON s.snapshot=a.snapshot JOIN contents spec ON spec.id=r.spec_content_id JOIN contents manifest ON manifest.id=s.manifest_content_id JOIN session_control control ON control.id=r.session JOIN session_creations creation ON creation.session_id=control.id AND creation.ready=1 AND creation.visible=1 WHERE r.owner=?1 AND r.session>=?2 AND r.session<?3 AND (?4 IS NULL OR r.session>?4) AND json_extract(CAST(spec.payload AS TEXT),'$.origin.kind')='imported' AND json_extract(CAST(manifest.payload AS TEXT),'$.origin.kind')='imported' AND NOT EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=r.session AND retired.remove_session=1) ORDER BY r.session LIMIT ?5")?.query_map(params![serde_json::to_string(&self.0)?,self.1,format!("{}\u{10ffff}",self.1),self.2,limit+1],|r|r.get(0))?.collect::<Result<_,_>>()?;
        let more = ids.len() > limit as usize;
        ids.truncate(limit as usize);
        let next = if more { ids.last().cloned() } else { None };
        Ok(ImportedSessions { ids, next })
    }
}
