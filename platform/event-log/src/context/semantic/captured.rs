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

//! Frozen semantic sources retain the original execution guards, never a new admission.
mod artifact_identity;
mod locator;
use super::{SemanticCursor, SemanticSelection, available_at, invalid, rows_query};
use crate::{EventLog, StoreError};
use maka_agent_facts::history::RowPosition;
use maka_agent_facts::model::prompt_source::source::{
    ByteCursor, ByteSource, ChargedBuffer, ReadSource, SourceBuffer, SourceRead,
};
use rusqlite::{Connection as RawConnection, OptionalExtension, params};
use sqlx::Connection;
use std::io::{Read, Seek, SeekFrom};
use std::ops::Range;
use std::sync::{Arc, Weak, atomic::AtomicU64};

/// Cache identity does not retain a partition, execution, or Root lease.
#[derive(Clone, Debug)]
pub struct SourceDomain(Weak<AtomicU64>);
impl PartialEq for SourceDomain {
    fn eq(&self, other: &Self) -> bool {
        Weak::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for SourceDomain {}
impl std::hash::Hash for SourceDomain {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::hash::Hash::hash(&self.0.as_ptr(), state);
    }
}

struct Domain;
struct Inner {
    log: EventLog,
    execution: crate::SessionStore,
    selection: Arc<SemanticSelection>,
    domain: Arc<Domain>,
}
#[derive(Clone)]
pub struct CapturedSource(Arc<Inner>);

#[derive(Clone)]
pub struct CapturedRow {
    domain: Arc<Domain>,
    rowid: i64,
    pub id: RowPosition,
    pub order: RowPosition,
    pub revision: u64,
    bytes: u64,
    payload: Option<Backing>,
}
const METADATA_WORDS: usize = 13;
const METADATA_BYTES: usize = METADATA_WORDS * 8;
pub struct SourcePage<B> {
    domain: Arc<Domain>,
    buffer: B,
    count: usize,
    pub next: Option<SemanticCursor>,
}
impl<B: SourceBuffer> SourcePage<B> {
    pub fn into_buffer(self) -> B {
        self.buffer
    }
    pub fn len(&self) -> usize {
        self.count
    }
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }
    pub fn row(&mut self, index: usize) -> Option<CapturedRow> {
        if index >= self.count {
            return None;
        }
        let record = &self.buffer.as_mut()[index * METADATA_BYTES..(index + 1) * METADATA_BYTES];
        let mut values = [0u64; METADATA_WORDS];
        for (value, bytes) in values.iter_mut().zip(record.as_chunks::<8>().0.iter()) {
            *value = u64::from_le_bytes(*bytes);
        }
        let key = RowPosition {
            source_sequence: values[8],
            item_index: values[9],
        };
        let payload = match values[7] {
            0 => None,
            1 => Some(Backing::Pieces {
                key,
                bytes: values[11],
            }),
            2 => Some(Backing::Canonical {
                key,
                offset: values[10],
                bytes: values[11],
            }),
            3 => Some(Backing::PartText {
                part: key,
                through: values[12],
            }),
            _ => unreachable!("metadata words are written only by the source worker"),
        };
        Some(CapturedRow {
            domain: self.domain.clone(),
            rowid: values[0] as i64,
            id: RowPosition {
                source_sequence: values[1],
                item_index: values[2],
            },
            order: RowPosition {
                source_sequence: values[3],
                item_index: values[4],
            },
            revision: values[5],
            bytes: values[6],
            payload,
        })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadEncoding {
    SemanticRow,
    Payload,
    CanonicalProjection,
    TextFragments,
    Artifact,
    ArtifactMetadata,
}
#[derive(Clone)]
pub struct PayloadSource {
    domain: Arc<Domain>,
    backing: Backing,
}
#[derive(Clone)]
enum Backing {
    Row {
        rowid: i64,
        bytes: u64,
    },
    Canonical {
        key: RowPosition,
        offset: u64,
        bytes: u64,
    },
    Pieces {
        key: RowPosition,
        bytes: u64,
    },
    PartText {
        part: RowPosition,
        through: u64,
    },
    Artifact {
        rowid: i64,
        bytes: u64,
        digest: [u8; 32],
    },
    ArtifactMetadata {
        rowid: i64,
        bytes: u64,
        payload_bytes: u64,
        digest: [u8; 32],
    },
}
#[derive(Clone, Copy, Debug, Default)]
pub struct SourcePosition {
    fragment: Option<RowPosition>,
    piece: i64,
    offset: u64,
}
pub struct SourceChunk<B> {
    pub buffer: B,
    pub bytes_read: usize,
    pub fragment: Option<RowPosition>,
    pub fragment_end: bool,
    pub next: Option<SourcePosition>,
}
pub struct ArtifactLookup<B> {
    source: PayloadSource,
    session_token: Range<u64>,
    artifact_token: Range<u64>,
    work: B,
}
impl<B: SourceBuffer> ArtifactLookup<B> {
    /// Token ranges include quotes and are relative to the complete source.
    pub fn new(
        source: PayloadSource,
        session_token: Range<u64>,
        artifact_token: Range<u64>,
        mut work: B,
    ) -> Result<Self, StoreError> {
        let bytes = source
            .byte_len()
            .ok_or_else(|| invalid("artifact identity needs addressable source"))?;
        for range in [&session_token, &artifact_token] {
            if range.start >= range.end || range.end > bytes {
                return Err(invalid("artifact identity token exceeds source"));
            }
        }
        if work.as_mut().len() < 2 {
            return Err(invalid(
                "artifact identity work requires input and output bytes",
            ));
        }
        Ok(Self {
            source,
            session_token,
            artifact_token,
            work,
        })
    }
    pub fn into_buffer(self) -> B {
        self.work
    }
}
/// Well-formed JSON identity tokens may still be outside the entity identity alphabet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactIdentityValidity {
    Valid,
    Invalid,
}
/// Invalid references and missing material are normal capture outcomes.
#[derive(Debug)]
pub enum ArtifactLookupResult<T> {
    InvalidIdentity,
    Missing,
    Captured(T),
}
pub struct ArtifactCapture {
    pub bytes: u64,
    pub digest: [u8; 32],
    pub metadata_bytes: u64,
    pub protected_source: Option<PayloadSource>,
    pub protected_metadata: Option<PayloadSource>,
}
/// The original Run or read scope owns the file until its physical close is confirmed.
pub struct CapturedLocalResource {
    receipt: LocalReceipt,
}
/// Create only inside an accepted request-local worker callback.
pub fn create_request_file() -> std::io::Result<std::fs::File> {
    tempfile::tempfile()
}
/// Consume the original descriptor exactly once; a failed close is not retried.
#[cfg(unix)]
pub fn close_request_file(file: std::fs::File) -> std::io::Result<()> {
    use std::os::fd::IntoRawFd;
    let descriptor = file.into_raw_fd();
    // SAFETY: into_raw_fd transfers the one owned descriptor. No File or
    // borrower retains it, and retrying close could affect a reused descriptor.
    let closed = unsafe { libc::close(descriptor) };
    if closed == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
#[cfg(windows)]
pub fn close_request_file(file: std::fs::File) -> std::io::Result<()> {
    use std::os::windows::io::IntoRawHandle;
    let handle = file.into_raw_handle();
    // SAFETY: into_raw_handle transfers this unique owned File handle.
    let closed = unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    if closed != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
enum LocalReceipt {
    Invocation(crate::root_store::InvocationEffectLease),
    Read(crate::root_store::SessionExecutionLease),
}
impl CapturedLocalResource {
    pub fn retain_original_material(self, material: impl Send + Sync + 'static, reason: String) {
        match self.receipt {
            LocalReceipt::Invocation(effect) => effect.retain_original_material(material, reason),
            LocalReceipt::Read(lease) => lease.retain_original_material((material, reason)),
        }
    }
    pub fn finish(self, result: Result<(), String>) {
        match self.receipt {
            LocalReceipt::Invocation(effect) => effect.finish(result),
            LocalReceipt::Read(lease) => match result {
                Ok(()) => lease.finish(),
                Err(reason) => lease.retain_original_material(reason),
            },
        }
    }
}
impl PayloadSource {
    pub fn encoding(&self) -> PayloadEncoding {
        match self.backing {
            Backing::Row { .. } => PayloadEncoding::SemanticRow,
            Backing::Canonical { .. } => PayloadEncoding::CanonicalProjection,
            Backing::Pieces { .. } => PayloadEncoding::Payload,
            Backing::PartText { .. } => PayloadEncoding::TextFragments,
            Backing::Artifact { .. } => PayloadEncoding::Artifact,
            Backing::ArtifactMetadata { .. } => PayloadEncoding::ArtifactMetadata,
        }
    }
    pub fn byte_len(&self) -> Option<u64> {
        match self.backing {
            Backing::Row { bytes, .. } | Backing::Canonical { bytes, .. } => Some(bytes),
            Backing::Pieces { bytes, .. } => Some(bytes),
            Backing::PartText { .. } => None,
            Backing::Artifact { bytes, .. } => Some(bytes),
            Backing::ArtifactMetadata { bytes, .. } => Some(bytes),
        }
    }
}
impl CapturedSource {
    pub(crate) async fn capture(
        log: EventLog,
        execution: crate::SessionStore,
        selection: SemanticSelection,
    ) -> Result<Self, StoreError> {
        log.validate_root()?;
        log.check_bound_session(&selection.session)?;
        if selection.after > selection.through || selection.through > selection.captured_through {
            return Err(invalid("invalid captured semantic source window"));
        }
        for sequence in [
            selection.after,
            selection.through,
            selection.captured_through,
        ] {
            i64::try_from(sequence)
                .map_err(|_| invalid("captured source sequence exceeds SQLite range"))?;
        }
        let selection = Arc::new(selection);
        let selected = selection.clone();
        log.connection
            .read(move |db| {
                Box::pin(async move {
                    available_at(db, &selected.session, selected.captured_through).await
                })
            })
            .await?;
        Ok(Self(Arc::new(Inner {
            log,
            execution,
            selection,
            domain: Arc::new(Domain),
        })))
    }
    pub fn selection(&self) -> &SemanticSelection {
        &self.0.selection
    }
    pub fn domain(&self) -> SourceDomain {
        SourceDomain(self.0.log.connection.owner_identity())
    }
    pub fn reserve_local_resource(&self) -> Result<CapturedLocalResource, StoreError> {
        let receipt = match self.0.execution.source_invocation_effect()? {
            Some(effect) => LocalReceipt::Invocation(effect),
            None => LocalReceipt::Read(self.0.execution.source_execution_lease()?),
        };
        Ok(CapturedLocalResource { receipt })
    }
    fn check(&self, domain: &Arc<Domain>) -> Result<(), StoreError> {
        if !Arc::ptr_eq(&self.0.domain, domain) {
            return Err(invalid("foreign captured semantic source"));
        }
        Ok(())
    }
    pub fn byte_source(&self, source: &PayloadSource) -> Result<Arc<dyn ByteSource>, StoreError> {
        let bytes = source
            .byte_len()
            .ok_or_else(|| invalid("text fragments require their boundary-aware cursor"))?;
        self.byte_range(source, 0, bytes)
    }
    pub fn byte_range(
        &self,
        source: &PayloadSource,
        start: u64,
        bytes: u64,
    ) -> Result<Arc<dyn ByteSource>, StoreError> {
        self.check(&source.domain)?;
        let total = source
            .byte_len()
            .ok_or_else(|| invalid("text fragments require their boundary-aware cursor"))?;
        if start.checked_add(bytes).is_none_or(|end| end > total) {
            return Err(invalid("captured byte range exceeds source"));
        }
        Ok(Arc::new(CapturedBytes {
            captured: self.clone(),
            source: source.clone(),
            start,
            bytes,
        }))
    }
    pub fn metadata_source(&self, row: &CapturedRow) -> Result<PayloadSource, StoreError> {
        self.check(&row.domain)?;
        Ok(PayloadSource {
            domain: row.domain.clone(),
            backing: Backing::Row {
                rowid: row.rowid,
                bytes: row.bytes,
            },
        })
    }
    /// Descriptors occupy the supplied allocation; open identifiers remain source-backed.
    pub async fn metadata_page<B: SourceBuffer>(
        &self,
        cursor: Option<SemanticCursor>,
        mut buffer: B,
    ) -> Result<SourcePage<B>, StoreError> {
        let capacity = buffer.as_mut().len() / METADATA_BYTES;
        if capacity == 0 {
            return Err(invalid(
                "semantic metadata allocation cannot hold one descriptor",
            ));
        }
        let selection = self.0.selection.clone();
        let domain = self.0.domain.clone();
        self.0.log.connection.read(move |db| Box::pin(async move {
            available_at(db, &selection.session, selection.captured_through).await?;
            let mut tx = db.begin().await?;
            let result = crate::connection::worker_query(&mut tx, move |worker| Box::pin(async move {
                with_raw(worker, |raw| {
                    let zero = RowPosition { source_sequence: 0, item_index: 0 };
                    let point = cursor.unwrap_or(SemanticCursor { order: zero, id: zero });
                    let query = rows_query(true)
                        .replace("r.order_sequence=?11", "?11 IS NULL")
                        .replace("?13 IS NULL", "?15 IS NULL")
                        .replace("json_extract(?13,'$.base')", "?15")
                        .replace("json_extract(?13,'$.current')", "?16")
                        .replace("SELECT r.row_json FROM", "SELECT r.rowid,r.source_sequence,r.source_index,r.revision,r.order_sequence,r.order_index,length(CAST(r.row_json AS BLOB)) AS bytes FROM");
                    let mut statement = raw.prepare(&query)?;
                    let mut records = statement.query(params![
                        &selection.session, selection.after as i64, selection.through as i64,
                        selection.captured_through as i64, selection.before.min(i64::MAX as u64) as i64,
                        &selection.lineage, point.order.source_sequence as i64, point.order.item_index as i64,
                        point.id.source_sequence as i64, point.id.item_index as i64, None::<i64>,
                        i64::try_from(capacity.saturating_add(1)).map_err(|_| invalid("metadata allocation exceeds SQLite range"))?,
                        None::<i64>, selection.prior_unknown,
                        selection.replay.as_ref().map(|replay|replay.base as i64),
                        selection.replay.as_ref().map(|replay|replay.current.as_str()),
                    ])?;
                    let mut count = 0;
                    let mut last = None;
                    let mut more = false;
                    while let Some(record) = records.next()? {
                        if count == capacity { more = true; break; }
                        let rowid = record.get::<_,i64>(0)?;
                        let id = RowPosition { source_sequence: crate::sequence_number(record.get(1)?)?, item_index: crate::sequence_number(record.get(2)?)? };
                        let revision = crate::sequence_number(record.get(3)?)?;
                        let order = RowPosition { source_sequence: crate::sequence_number(record.get(4)?)?, item_index: crate::sequence_number(record.get(5)?)? };
                        let bytes = crate::sequence_number(record.get(6)?)?;
                        let payload = row_payload(raw,rowid,revision,bytes)?;
                        let mut words = [rowid as u64,id.source_sequence,id.item_index,order.source_sequence,order.item_index,revision,bytes,0,0,0,0,0,0];
                        match payload {
                            None => {},
                            Some(Backing::Pieces{key,bytes}) => { words[7]=1; words[8]=key.source_sequence; words[9]=key.item_index; words[11]=bytes; },
                            Some(Backing::Canonical{key,offset,bytes}) => { words[7]=2; words[8]=key.source_sequence; words[9]=key.item_index; words[10]=offset; words[11]=bytes; },
                            Some(Backing::PartText{part,through}) => { words[7]=3; words[8]=part.source_sequence; words[9]=part.item_index; words[12]=through; },
                            Some(Backing::Row{..}|Backing::Artifact{..}|Backing::ArtifactMetadata{..}) => unreachable!("payload is never row metadata"),
                        }
                        for (target,word) in buffer.as_mut()[count*METADATA_BYTES..(count+1)*METADATA_BYTES].as_chunks_mut::<8>().0.iter_mut().zip(words) { target.copy_from_slice(&word.to_le_bytes()); }
                        count+=1; last=Some(SemanticCursor{order,id});
                    }
                    Ok(SourcePage{domain,buffer,count,next:more.then_some(last).flatten()})
                })
            })).await;
            let closed = tx.rollback().await;
            settle_read(result,closed)
        })).await
    }
    pub fn describe_payload(&self, row: &CapturedRow) -> Result<Option<PayloadSource>, StoreError> {
        self.check(&row.domain)?;
        Ok(row.payload.clone().map(|backing| PayloadSource {
            domain: row.domain.clone(),
            backing,
        }))
    }
    /// Bounded request-local file work settles on the original accepted worker.
    pub async fn with_local_io<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.0
            .log
            .connection
            .read(move |connection| {
                Box::pin(async move {
                    crate::connection::worker_query(connection, move |_worker| {
                        Box::pin(async move { operation() })
                    })
                    .await
                })
            })
            .await
    }
    pub async fn next_text_fragment(
        &self,
        source: &PayloadSource,
        after: Option<RowPosition>,
    ) -> Result<Option<(RowPosition, PayloadSource)>, StoreError> {
        self.check(&source.domain)?;
        let Backing::PartText { part, through } = source.backing else {
            return Err(invalid("source is not a streamed text part"));
        };
        let domain = source.domain.clone();
        self.0
            .log
            .connection
            .read(move |db| {
                Box::pin(async move {
                    let mut tx = db.begin().await?;
                    let result = crate::connection::worker_query(&mut tx, move |worker| {
                        Box::pin(async move {
                            with_raw(worker, |raw| {
                                next_fragment(raw, part, through, after)?
                                    .map(|key| {
                                        fragment_backing(raw, key)
                                            .map(|backing| (key, PayloadSource { domain, backing }))
                                    })
                                    .transpose()
                            })
                        })
                    })
                    .await;
                    let close = tx.rollback().await;
                    settle_read(result, close)
                })
            })
            .await
    }
    #[cfg(test)]
    pub(crate) async fn artifact_lookup_fixture(
        &self,
        json: Vec<u8>,
        session: Range<u64>,
        artifact: Range<u64>,
    ) -> ArtifactLookup<ChargedBuffer> {
        static INDEX: AtomicU64 = AtomicU64::new(123456);
        let index = INDEX.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let bytes = json.len() as u64;
        self.0
            .log
            .connection
            .run(move |db| {
                Box::pin(async move {
                    sqlx::query(
                        "INSERT INTO context_semantic_fragments VALUES(0,?,0,?,'pieces',NULL,NULL)",
                    )
                    .bind(index as i64)
                    .bind(index as i64)
                    .execute(&mut *db)
                    .await?;
                    for (piece, chunk) in json.chunks(32 * 1024).enumerate() {
                        sqlx::query("INSERT INTO context_semantic_fragment_pieces VALUES(0,?,?,?)")
                            .bind(index as i64)
                            .bind(piece as i64)
                            .bind(chunk)
                            .execute(&mut *db)
                            .await?;
                    }
                    Ok(())
                })
            })
            .await
            .unwrap();
        ArtifactLookup::new(
            PayloadSource {
                domain: self.0.domain.clone(),
                backing: Backing::Pieces {
                    key: RowPosition {
                        source_sequence: 0,
                        item_index: index,
                    },
                    bytes,
                },
            },
            session,
            artifact,
            ChargedBuffer::new(vec![0; 64], ()),
        )
        .unwrap()
    }
    /// Validate original identity tokens without looking up artifact material.
    pub async fn validate_artifact_identity<B: SourceBuffer>(
        &self,
        mut lookup: ArtifactLookup<B>,
    ) -> Result<ArtifactIdentityValidity, StoreError> {
        self.check(&lookup.source.domain)?;
        self.0
            .log
            .connection
            .read(move |db| {
                Box::pin(async move {
                    let mut tx = db.begin().await?;
                    let result = crate::connection::worker_query(&mut tx, move |worker| {
                        Box::pin(async move {
                            with_raw(worker, |raw| artifact_identity::validate(raw, &mut lookup))
                        })
                    })
                    .await;
                    let close = tx.rollback().await;
                    settle_read(result, close)
                })
            })
            .await
    }
    /// Identity, protection proof, metadata and body share this original read snapshot.
    pub async fn with_artifact_capture<B: SourceBuffer, T: Send + 'static>(
        &self,
        mut lookup: ArtifactLookup<B>,
        consume: impl FnOnce(ArtifactCapture, &mut dyn Read, &mut dyn Read) -> Result<T, StoreError>
        + Send
        + 'static,
    ) -> Result<ArtifactLookupResult<T>, StoreError> {
        self.check(&lookup.source.domain)?;
        let selection = self.0.selection.clone();
        let domain = self.0.domain.clone();
        self.0.log.connection.read(move |db| Box::pin(async move {
            let mut tx = db.begin().await?;
            let result = crate::connection::worker_query(&mut tx, move |worker| Box::pin(async move {
                with_raw(worker, |raw| {
                    let (rowid,alias_protected)=match artifact_identity::resolve(raw,&selection.session,&mut lookup)? {
                        ArtifactLookupResult::InvalidIdentity=>return Ok(ArtifactLookupResult::InvalidIdentity),
                        ArtifactLookupResult::Missing=>return Ok(ArtifactLookupResult::Missing),
                        ArtifactLookupResult::Captured(found)=>found,
                    };
                    let mut statement = raw.prepare("SELECT content_sha256,canonical_at IS NOT NULL FROM artifacts WHERE rowid=?")?;
                    let mut records = statement.query([rowid])?;
                    let record = records.next()?.ok_or_else(||invalid("captured artifact disappeared"))?;
                    let length = blob_length(raw,"artifacts","payload",rowid)?;
                    let metadata_bytes = blob_length(raw,"artifacts","record_json",rowid)?;
                    let mut digest = [0u8;32];
                    let encoded = record.get_ref(0)?.as_str().map_err(|_| invalid("captured artifact digest is not UTF-8"))?;
                    let encoded = encoded.strip_prefix("sha256:").filter(|value|value.len()==64)
                        .ok_or_else(||invalid("captured artifact digest is invalid"))?;
                    hex::decode_to_slice(encoded, &mut digest).map_err(|_|invalid("captured artifact digest is invalid"))?;
                    let protection:bool = record.get(1)?;
                    drop(records);
                    drop(statement);
                    let deletable=with_blob(raw,"artifacts","record_json",rowid,0,metadata_bytes,locator::artifact_user_deletable)?;
                    let protected=protection||alias_protected||!deletable;
                    let protected_source = protected.then(||PayloadSource {
                        domain:domain.clone(),backing:Backing::Artifact { rowid,bytes:length,digest },
                    });
                    let protected_metadata=protected.then_some(PayloadSource { domain,backing:Backing::ArtifactMetadata { rowid,bytes:metadata_bytes,payload_bytes:length,digest } });
                    let capture = ArtifactCapture { bytes:length,digest,metadata_bytes,protected_source,protected_metadata };
                    with_blob(raw,"artifacts","record_json",rowid,0,metadata_bytes,|metadata| {
                        with_blob(raw,"artifacts","payload",rowid,0,length,|body| {
                            consume(capture,metadata,body)
                        })
                    }).map(ArtifactLookupResult::Captured)
                })
            })).await;
            let close = tx.rollback().await;
            settle_read(result,close)
        })).await
    }
    pub async fn read_chunk<B: SourceBuffer>(
        &self,
        source: &PayloadSource,
        position: SourcePosition,
        buffer: B,
    ) -> Result<SourceChunk<B>, StoreError> {
        self.check(&source.domain)?;
        let backing = source.backing.clone();
        self.0
            .log
            .connection
            .read(move |db| {
                Box::pin(async move {
                    let mut tx = db.begin().await?;
                    let result = crate::connection::worker_query(&mut tx, move |worker| {
                        Box::pin(async move {
                            with_raw(worker, |raw| {
                                read_chunk(raw, &backing, position, buffer, None)
                            })
                        })
                    })
                    .await;
                    let closed = tx.rollback().await;
                    settle_read(result, closed)
                })
            })
            .await
    }
    /// The local synchronous consumer cannot retain a Blob, transaction, or SQL handle.
    pub async fn with_sequential_source<T: Send + 'static>(
        &self,
        source: &PayloadSource,
        consume: impl FnOnce(&mut dyn Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.check(&source.domain)?;
        let backing = source.backing.clone();
        self.0
            .log
            .connection
            .read(move |db| {
                Box::pin(async move {
                    let mut tx = db.begin().await?;
                    let result = crate::connection::worker_query(&mut tx, move |worker| {
                        Box::pin(async move {
                            with_raw(worker, |raw| match backing {
                                Backing::Row { rowid, bytes } => with_blob(
                                    raw,
                                    "context_semantic_rows",
                                    "row_json",
                                    rowid,
                                    0,
                                    bytes,
                                    consume,
                                ),
                                Backing::Canonical { key, offset, bytes } => {
                                    check_canonical(raw, key, offset, bytes)?;
                                    with_blob(
                                        raw,
                                        "event_log",
                                        "event_json",
                                        key.source_sequence as i64,
                                        offset,
                                        bytes,
                                        consume,
                                    )
                                }
                                Backing::Pieces { key, .. } => {
                                    check_pieces(raw, key)?;
                                    let mut reader = PieceReader {
                                        raw,
                                        key,
                                        piece: 0,
                                        offset: 0,
                                        failed: None,
                                    };
                                    let result = consume(&mut reader);
                                    match reader.failed {
                                        Some(error) => Err(error),
                                        None => result,
                                    }
                                }
                                Backing::PartText { .. } => {
                                    Err(invalid("sequential text source requires fragment cursor"))
                                }
                                Backing::Artifact {
                                    rowid,
                                    bytes,
                                    digest,
                                } => {
                                    check_artifact(raw, rowid, bytes, &digest)?;
                                    with_blob(raw, "artifacts", "payload", rowid, 0, bytes, consume)
                                }
                                Backing::ArtifactMetadata {
                                    rowid,
                                    bytes,
                                    payload_bytes,
                                    digest,
                                } => {
                                    check_artifact(raw, rowid, payload_bytes, &digest)?;
                                    with_blob(
                                        raw,
                                        "artifacts",
                                        "record_json",
                                        rowid,
                                        0,
                                        bytes,
                                        consume,
                                    )
                                }
                            })
                        })
                    })
                    .await;
                    let closed = tx.rollback().await;
                    settle_read(result, closed)
                })
            })
            .await
    }
}

fn with_raw<T>(
    worker: &mut sqlx::sqlite::SqliteWorkerConnection<'_>,
    action: impl FnOnce(&RawConnection) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    // SAFETY: the original worker is exclusively borrowed; this non-owning
    // wrapper and every Blob/statement close before returning to SQLx.
    let raw = unsafe { RawConnection::from_handle(worker.as_raw_handle().as_ptr()) }?;
    let result = action(&raw);
    drop(raw);
    result
}
fn row_payload(
    raw: &RawConnection,
    rowid: i64,
    revision: u64,
    bytes: u64,
) -> Result<Option<Backing>, StoreError> {
    let locator = with_blob(
        raw,
        "context_semantic_rows",
        "row_json",
        rowid,
        0,
        bytes,
        |reader| locator::read(reader, revision),
    )?;
    match locator {
        Some(locator::Locator::Fragment(key)) => {
            key.validate().map_err(invalid)?;
            fragment_backing(raw, key).map(Some)
        }
        Some(locator::Locator::Text { part, through }) => {
            part.validate().map_err(invalid)?;
            i64::try_from(through)
                .map_err(|_| invalid("captured text end exceeds SQLite range"))?;
            Ok(Some(Backing::PartText { part, through }))
        }
        None => Ok(None),
    }
}

fn fragment_backing(raw: &RawConnection, key: RowPosition) -> Result<Backing, StoreError> {
    let row:Option<(String,Option<i64>,Option<i64>)>=raw.query_row("SELECT storage_kind,byte_offset,byte_len FROM context_semantic_fragments WHERE source_sequence=? AND source_index=?",params![key.source_sequence as i64,key.item_index as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    match row {
        Some((kind, None, None)) if kind == "pieces" => {
            let bytes:i64=raw.query_row("SELECT COALESCE(SUM(length(bytes)),0) FROM context_semantic_fragment_pieces WHERE source_sequence=? AND source_index=?",params![key.source_sequence as i64,key.item_index as i64],|r|r.get(0))?;
            if bytes <= 0 {
                return Err(invalid("captured fragment has no pieces"));
            }
            Ok(Backing::Pieces {
                key,
                bytes: bytes as u64,
            })
        }
        Some((kind, Some(offset), Some(bytes)))
            if kind == "canonical_tool_projection"
                && key.item_index == 0
                && offset >= 0
                && bytes > 0
                && offset
                    .checked_add(bytes)
                    .is_some_and(|end| end <= i64::from(i32::MAX)) =>
        {
            Ok(Backing::Canonical {
                key,
                offset: offset as u64,
                bytes: bytes as u64,
            })
        }
        _ => Err(invalid("captured semantic fragment is missing or invalid")),
    }
}
fn check_canonical(
    raw: &RawConnection,
    key: RowPosition,
    offset: u64,
    bytes: u64,
) -> Result<(), StoreError> {
    match fragment_backing(raw, key)? {
        Backing::Canonical {
            offset: actual,
            bytes: length,
            ..
        } if actual == offset && length == bytes => Ok(()),
        _ => Err(invalid("captured canonical source changed")),
    }
}
fn check_pieces(raw: &RawConnection, key: RowPosition) -> Result<(), StoreError> {
    let valid:bool=raw.query_row("SELECT EXISTS(SELECT 1 FROM context_semantic_fragments WHERE source_sequence=? AND source_index=? AND storage_kind='pieces')",params![key.source_sequence as i64,key.item_index as i64],|r|r.get(0))?;
    if valid {
        Ok(())
    } else {
        Err(invalid("captured pieces source changed"))
    }
}
fn check_artifact(
    raw: &RawConnection,
    rowid: i64,
    bytes: u64,
    digest: &[u8; 32],
) -> Result<(), StoreError> {
    let mut encoded = [0u8; 71];
    encoded[..7].copy_from_slice(b"sha256:");
    hex::encode_to_slice(digest, &mut encoded[7..])
        .map_err(|_| invalid("artifact digest encoding failed"))?;
    let valid:bool=raw.query_row("SELECT EXISTS(SELECT 1 FROM artifacts WHERE rowid=? AND length(payload)=? AND CAST(content_sha256 AS BLOB)=?)",params![rowid,bytes as i64,&encoded[..]],|row|row.get(0))?;
    if valid {
        Ok(())
    } else {
        Err(invalid("captured artifact is missing or changed"))
    }
}
fn blob_length(
    raw: &RawConnection,
    table: &str,
    column: &str,
    rowid: i64,
) -> Result<u64, StoreError> {
    let blob = raw.blob_open("main", table, column, rowid, true)?;
    let length = blob.len() as u64;
    close_blob(Ok(length), blob.close())
}
fn with_blob<T>(
    raw: &RawConnection,
    table: &str,
    column: &str,
    rowid: i64,
    offset: u64,
    bytes: u64,
    consume: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let mut blob = raw.blob_open("main", table, column, rowid, true)?;
    let result = (|| {
        if offset
            .checked_add(bytes)
            .is_none_or(|end| end > blob.len() as u64)
        {
            return Err(invalid("captured source exceeds its Blob"));
        }
        blob.seek(SeekFrom::Start(offset))?;
        consume(&mut (&mut blob).take(bytes))
    })();
    let close = blob.close();
    match (result, close) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error.into()),
        (Err(read), Err(close)) => {
            Err(std::io::Error::other(ReadAndCloseError { read, close }).into())
        }
    }
}
fn read_blob(
    raw: &RawConnection,
    location: (&str, &str, i64),
    start: u64,
    total: u64,
    offset: u64,
    output: &mut [u8],
) -> Result<(usize, bool), StoreError> {
    let (table, column, rowid) = location;
    if offset > total {
        return Err(invalid("captured source position exceeds its span"));
    }
    let count = (total - offset).min(output.len() as u64) as usize;
    let mut blob = raw.blob_open("main", table, column, rowid, true)?;
    let result = (|| {
        if start
            .checked_add(total)
            .is_none_or(|end| end > blob.len() as u64)
        {
            return Err(invalid("captured source exceeds its Blob"));
        }
        blob.seek(SeekFrom::Start(start + offset))?;
        blob.read_exact(&mut output[..count])?;
        Ok(())
    })();
    close_blob(result, blob.close())?;
    Ok((count, offset + count as u64 == total))
}
fn piece(
    raw: &RawConnection,
    key: RowPosition,
    index: i64,
) -> Result<Option<(i64, u64)>, StoreError> {
    raw.query_row("SELECT rowid,length(bytes) FROM context_semantic_fragment_pieces WHERE source_sequence=? AND source_index=? AND piece_index=?",params![key.source_sequence as i64,key.item_index as i64,index],|r|Ok((r.get(0)?,r.get::<_,i64>(1)? as u64))).optional().map_err(Into::into)
}
fn read_chunk<B: SourceBuffer>(
    raw: &RawConnection,
    backing: &Backing,
    position: SourcePosition,
    mut buffer: B,
    limit: Option<usize>,
) -> Result<SourceChunk<B>, StoreError> {
    let output = buffer.as_mut();
    let output_len = output.len().min(limit.unwrap_or(output.len()));
    let output = &mut output[..output_len];
    if output.is_empty() {
        return Err(invalid("captured source buffer is empty"));
    }
    let (bytes_read, fragment, fragment_end, next) = match *backing {
        Backing::Row { rowid, bytes } => {
            let actual: i64 = raw.query_row(
                "SELECT length(CAST(row_json AS BLOB)) FROM context_semantic_rows WHERE rowid=?",
                [rowid],
                |r| r.get(0),
            )?;
            if actual as u64 != bytes {
                return Err(invalid("captured metadata source changed"));
            }
            let (count, end) = read_blob(
                raw,
                ("context_semantic_rows", "row_json", rowid),
                0,
                bytes,
                position.offset,
                output,
            )?;
            (
                count,
                None,
                end,
                (!end).then_some(SourcePosition {
                    offset: position.offset + count as u64,
                    ..position
                }),
            )
        }
        Backing::Canonical { key, offset, bytes } => {
            check_canonical(raw, key, offset, bytes)?;
            let (count, end) = read_blob(
                raw,
                ("event_log", "event_json", key.source_sequence as i64),
                offset,
                bytes,
                position.offset,
                output,
            )?;
            (
                count,
                Some(key),
                end,
                (!end).then_some(SourcePosition {
                    offset: position.offset + count as u64,
                    ..position
                }),
            )
        }
        Backing::Pieces { key, .. } => read_piece_chunk(raw, key, position, output, None)?,
        Backing::PartText { part, through } => {
            let key = match position.fragment {
                Some(key) => {
                    let valid:bool=raw.query_row("SELECT EXISTS(SELECT 1 FROM context_semantic_fragments WHERE source_sequence=? AND source_index=? AND part_sequence=? AND part_index=? AND source_sequence<=?)",params![key.source_sequence as i64,key.item_index as i64,part.source_sequence as i64,part.item_index as i64,through as i64],|r|r.get(0))?;
                    if !valid {
                        return Err(invalid("captured text position is outside its part"));
                    }
                    key
                }
                None => next_fragment(raw, part, through, None)?
                    .ok_or_else(|| invalid("captured text has no fragments"))?,
            };
            read_piece_chunk(raw, key, position, output, Some((part, through)))?
        }
        Backing::Artifact {
            rowid,
            bytes,
            digest,
        } => {
            check_artifact(raw, rowid, bytes, &digest)?;
            let (count, end) = read_blob(
                raw,
                ("artifacts", "payload", rowid),
                0,
                bytes,
                position.offset,
                output,
            )?;
            (
                count,
                None,
                end,
                (!end).then_some(SourcePosition {
                    offset: position.offset + count as u64,
                    ..position
                }),
            )
        }
        Backing::ArtifactMetadata {
            rowid,
            bytes,
            payload_bytes,
            digest,
        } => {
            check_artifact(raw, rowid, payload_bytes, &digest)?;
            let (count, end) = read_blob(
                raw,
                ("artifacts", "record_json", rowid),
                0,
                bytes,
                position.offset,
                output,
            )?;
            (
                count,
                None,
                end,
                (!end).then_some(SourcePosition {
                    offset: position.offset + count as u64,
                    ..position
                }),
            )
        }
    };
    Ok(SourceChunk {
        buffer,
        bytes_read,
        fragment,
        fragment_end,
        next,
    })
}
fn next_fragment(
    raw: &RawConnection,
    part: RowPosition,
    through: u64,
    after: Option<RowPosition>,
) -> Result<Option<RowPosition>, StoreError> {
    let after = after.unwrap_or(RowPosition {
        source_sequence: 0,
        item_index: 0,
    });
    let row:Option<(i64,i64)>=raw.query_row("SELECT source_sequence,source_index FROM context_semantic_fragments WHERE part_sequence=?1 AND part_index=?2 AND source_sequence<=?3 AND (source_sequence,source_index)>(?4,?5) ORDER BY source_sequence,source_index LIMIT 1",params![part.source_sequence as i64,part.item_index as i64,through as i64,after.source_sequence as i64,after.item_index as i64],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(s, i)| {
        Ok(RowPosition {
            source_sequence: crate::sequence_number(s)?,
            item_index: crate::sequence_number(i)?,
        })
    })
    .transpose()
}
fn read_piece_chunk(
    raw: &RawConnection,
    key: RowPosition,
    position: SourcePosition,
    output: &mut [u8],
    part: Option<(RowPosition, u64)>,
) -> Result<(usize, Option<RowPosition>, bool, Option<SourcePosition>), StoreError> {
    check_pieces(raw, key)?;
    let (rowid, bytes) = piece(raw, key, position.piece)?
        .ok_or_else(|| invalid("captured fragment piece is missing"))?;
    let (count, piece_end) = read_blob(
        raw,
        ("context_semantic_fragment_pieces", "bytes", rowid),
        0,
        bytes,
        position.offset,
        output,
    )?;
    let more_piece = piece_end && piece(raw, key, position.piece + 1)?.is_some();
    let fragment_end = piece_end && !more_piece;
    let next = if !piece_end {
        Some(SourcePosition {
            fragment: Some(key),
            offset: position.offset + count as u64,
            ..position
        })
    } else if more_piece {
        Some(SourcePosition {
            fragment: Some(key),
            piece: position.piece + 1,
            offset: 0,
        })
    } else if let Some((part, through)) = part {
        next_fragment(raw, part, through, Some(key))?.map(|next| SourcePosition {
            fragment: Some(next),
            piece: 0,
            offset: 0,
        })
    } else {
        None
    };
    Ok((count, Some(key), fragment_end, next))
}
struct PieceReader<'a> {
    raw: &'a RawConnection,
    key: RowPosition,
    piece: i64,
    offset: u64,
    failed: Option<StoreError>,
}
impl Read for PieceReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        let result = (|| {
            let Some((rowid, bytes)) = piece(self.raw, self.key, self.piece)? else {
                return Ok(0);
            };
            let (count, end) = read_blob(
                self.raw,
                ("context_semantic_fragment_pieces", "bytes", rowid),
                0,
                bytes,
                self.offset,
                output,
            )?;
            if end {
                self.piece += 1;
                self.offset = 0
            } else {
                self.offset += count as u64
            }
            Ok::<_, StoreError>(count)
        })();
        result.map_err(|error| {
            let message = error.to_string();
            self.failed = Some(error);
            std::io::Error::other(message)
        })
    }
}

fn close_blob<T>(
    result: Result<T, StoreError>,
    closed: Result<(), rusqlite::Error>,
) -> Result<T, StoreError> {
    match (result, closed) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error.into()),
        (Err(read), Err(close)) => {
            Err(std::io::Error::other(ReadAndCloseError { read, close }).into())
        }
    }
}
#[derive(Debug)]
struct ReadAndCloseError {
    read: StoreError,
    close: rusqlite::Error,
}
impl std::fmt::Display for ReadAndCloseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}; closing captured source Blob also failed: {}",
            self.read, self.close
        )
    }
}
impl std::error::Error for ReadAndCloseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.read)
    }
}

#[derive(Clone)]
struct CapturedBytes {
    captured: CapturedSource,
    source: PayloadSource,
    start: u64,
    bytes: u64,
}
impl ByteSource for CapturedBytes {
    fn len(&self) -> Option<u64> {
        Some(self.bytes)
    }
    fn open(
        &self,
        _budget: Arc<dyn maka_agent_facts::model::prompt_source::source::SourceBudget>,
    ) -> Box<dyn ByteCursor> {
        Box::new(CapturedByteCursor {
            source: self.clone(),
            position: 0,
        })
    }
    fn slice(&self, range: std::ops::Range<u64>) -> std::io::Result<Arc<dyn ByteSource>> {
        if range.start > range.end || range.end > self.bytes {
            return Err(std::io::Error::other("captured source slice exceeds range"));
        }
        let start = self
            .start
            .checked_add(range.start)
            .ok_or_else(|| std::io::Error::other("captured source slice overflows"))?;
        Ok(Arc::new(Self {
            captured: self.captured.clone(),
            source: self.source.clone(),
            start,
            bytes: range.end - range.start,
        }))
    }
}
struct CapturedByteCursor {
    source: CapturedBytes,
    position: u64,
}
impl ByteCursor for CapturedByteCursor {
    fn read_chunk(&mut self, buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let position = self.position;
            if position > self.source.bytes {
                return Err(std::io::Error::other(
                    "captured byte position exceeds range",
                ));
            }
            if position == self.source.bytes {
                return Ok(SourceRead {
                    buffer,
                    bytes_read: 0,
                    eof: true,
                });
            }
            let absolute = self.source.start + position;
            let cursor = match self.source.source.backing {
                Backing::Pieces { key, .. } => SourcePosition {
                    fragment: Some(key),
                    piece: (absolute / (32 * 1024)) as i64,
                    offset: absolute % (32 * 1024),
                },
                _ => SourcePosition {
                    offset: absolute,
                    ..SourcePosition::default()
                },
            };
            let backing = self.source.source.backing.clone();
            let remaining = self.source.bytes - position;
            let chunk = self
                .source
                .captured
                .0
                .log
                .connection
                .read(move |db| {
                    Box::pin(async move {
                        let mut tx = db.begin().await?;
                        let result = crate::connection::worker_query(&mut tx, move |worker| {
                            Box::pin(async move {
                                with_raw(worker, |raw| {
                                    read_chunk(
                                        raw,
                                        &backing,
                                        cursor,
                                        buffer,
                                        Some(usize::try_from(remaining).unwrap_or(usize::MAX)),
                                    )
                                })
                            })
                        })
                        .await;
                        let close = tx.rollback().await;
                        settle_read(result, close)
                    })
                })
                .await
                .map_err(std::io::Error::other)?;
            let next_position = position + chunk.bytes_read as u64;
            if chunk.bytes_read == 0 {
                return Err(std::io::Error::other(
                    "captured byte source ended before its range",
                ));
            }
            self.position = next_position;
            Ok(SourceRead {
                buffer: chunk.buffer.retain_owner(self.source.captured.clone()),
                bytes_read: chunk.bytes_read,
                eof: next_position == self.source.bytes,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::history::semantic::Payload;

    struct Buffer(Vec<u8>);
    impl AsMut<[u8]> for Buffer {
        fn as_mut(&mut self) -> &mut [u8] {
            &mut self.0
        }
    }
    impl SourceBuffer for Buffer {}
    fn database() -> RawConnection {
        let db = RawConnection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE event_log(sequence INTEGER PRIMARY KEY,event_json TEXT);
CREATE TABLE context_semantic_fragments(source_sequence INTEGER,source_index INTEGER,part_sequence INTEGER,part_index INTEGER,storage_kind TEXT,byte_offset INTEGER,byte_len INTEGER,PRIMARY KEY(source_sequence,source_index)) WITHOUT ROWID;
CREATE TABLE context_semantic_fragment_pieces(source_sequence INTEGER,source_index INTEGER,piece_index INTEGER,bytes BLOB,PRIMARY KEY(source_sequence,source_index,piece_index));
CREATE INDEX part_fragments ON context_semantic_fragments(part_sequence,part_index,source_sequence,source_index);").unwrap();
        db
    }
    fn insert_pieces(db: &RawConnection, key: RowPosition, part: RowPosition, bytes: &[u8]) {
        db.execute(
            "INSERT INTO context_semantic_fragments VALUES(?,?,?,?,'pieces',NULL,NULL)",
            params![
                key.source_sequence as i64,
                key.item_index as i64,
                part.source_sequence as i64,
                part.item_index as i64
            ],
        )
        .unwrap();
        for (index, bytes) in bytes.chunks(32 * 1024).enumerate() {
            db.execute(
                "INSERT INTO context_semantic_fragment_pieces VALUES(?,?,?,?)",
                params![
                    key.source_sequence as i64,
                    key.item_index as i64,
                    index as i64,
                    bytes
                ],
            )
            .unwrap();
        }
    }
    fn collect(
        db: &RawConnection,
        backing: &Backing,
        capacity: usize,
    ) -> Vec<(RowPosition, Vec<u8>)> {
        let mut cursor = SourcePosition::default();
        let mut fragments = Vec::new();
        let mut current = Vec::new();
        loop {
            let chunk = read_chunk(db, backing, cursor, Buffer(vec![0; capacity]), None).unwrap();
            assert!(chunk.bytes_read <= capacity);
            current.extend_from_slice(&chunk.buffer.0[..chunk.bytes_read]);
            if chunk.fragment_end {
                fragments.push((chunk.fragment.unwrap(), std::mem::take(&mut current)));
            }
            let Some(next) = chunk.next else { break };
            cursor = next;
        }
        assert!(current.is_empty());
        fragments
    }
    #[test]
    fn bounded_canonical_projection_reads_exact_span_not_event_envelope() {
        let db = database();
        let projection = br#"{"kind":"content","parts":[{"kind":"text","text":"hello"}]}"#;
        let prefix = br#"{"fact":{"outcome":{"model_projection":"#;
        let mut event = prefix.to_vec();
        event.extend_from_slice(projection);
        event.extend_from_slice(b"}}}");
        db.execute(
            "INSERT INTO event_log VALUES(1,?)",
            [std::str::from_utf8(&event).unwrap()],
        )
        .unwrap();
        db.execute("INSERT INTO context_semantic_fragments VALUES(1,0,1,0,'canonical_tool_projection',?,?)",params![prefix.len() as i64,projection.len() as i64]).unwrap();
        let backing = fragment_backing(
            &db,
            RowPosition {
                source_sequence: 1,
                item_index: 0,
            },
        )
        .unwrap();
        for capacity in [1, 3, 17] {
            assert_eq!(collect(&db, &backing, capacity)[0].1, projection);
        }
    }
    #[test]
    fn piece_cursor_crosses_storage_boundaries_and_text_stops_at_frozen_end() {
        let db = database();
        let first = RowPosition {
            source_sequence: 10,
            item_index: 0,
        };
        let second = RowPosition {
            source_sequence: 11,
            item_index: 0,
        };
        let later = RowPosition {
            source_sequence: 12,
            item_index: 0,
        };
        let values = [
            Payload::TextDelta {
                text: "a".repeat(70_000),
                provider_options: None,
            },
            Payload::TextDelta {
                text: "世界".into(),
                provider_options: None,
            },
            Payload::TextDelta {
                text: "later".into(),
                provider_options: None,
            },
        ];
        let encoded: Vec<_> = values
            .iter()
            .map(|v| serde_json::to_vec(v).unwrap())
            .collect();
        for (key, bytes) in [first, second, later].into_iter().zip(&encoded) {
            insert_pieces(&db, key, first, bytes);
        }
        let fragments = collect(
            &db,
            &Backing::PartText {
                part: first,
                through: 11,
            },
            97,
        );
        assert_eq!(
            fragments,
            vec![(first, encoded[0].clone()), (second, encoded[1].clone())]
        );
        let backing = fragment_backing(&db, first).unwrap();
        let position = SourcePosition {
            piece: 1,
            offset: 5,
            fragment: Some(first),
        };
        let chunk = read_chunk(&db, &backing, position, Buffer(vec![0; 19]), None).unwrap();
        assert_eq!(
            &chunk.buffer.0[..chunk.bytes_read],
            &encoded[0][32 * 1024 + 5..32 * 1024 + 24]
        );
        let mut reader = PieceReader {
            raw: &db,
            key: first,
            piece: 0,
            offset: 0,
            failed: None,
        };
        let mut observed = Vec::new();
        reader.read_to_end(&mut observed).unwrap();
        assert_eq!(observed, encoded[0]);
    }
    #[test]
    fn payload_locator_streams_large_metadata_without_materializing_semantic_row() {
        use maka_agent_facts::event::Invocation;
        use maka_agent_facts::history::semantic::{PartPayload, SemanticKind, SemanticRow};
        let db = database();
        db.execute(
            "CREATE TABLE context_semantic_rows(revision INTEGER,row_json TEXT)",
            [],
        )
        .unwrap();
        let key = RowPosition {
            source_sequence: 7,
            item_index: 0,
        };
        let encoded =
            serde_json::to_vec(&Payload::Part(maka_agent_facts::model::ModelPart::Text {
                text_kind: maka_agent_facts::model::TextKind::Text,
                text: "body".into(),
                provider_options: None,
            }))
            .unwrap();
        insert_pieces(&db, key, key, &encoded);
        let row = SemanticRow {
            id: key,
            revision: 7,
            order: key,
            invocation: Invocation {
                session_id: "s".into(),
                turn_id: "t".into(),
                run_id: "r".into(),
                invocation_id: "i".into(),
            },
            kind: SemanticKind::AssistantPart {
                step_id: "step".into(),
                model_id: "m".repeat(2 * 1024 * 1024),
                route_identity: "route".into(),
                accepted_at: 7,
                index: 0,
                payload: PartPayload::Complete(key),
            },
        };
        let json = serde_json::to_string(&row).unwrap();
        db.execute(
            "INSERT INTO context_semantic_rows VALUES(?,?)",
            params![7, &json],
        )
        .unwrap();
        let backing = row_payload(&db, db.last_insert_rowid(), 7, json.len() as u64)
            .unwrap()
            .unwrap();
        assert_eq!(collect(&db, &backing, 3), vec![(key, encoded)]);
    }
}

fn settle_read<T>(
    result: Result<T, StoreError>,
    closed: Result<(), sqlx::Error>,
) -> Result<T, StoreError> {
    match (result, closed) {
        (result, Ok(())) => result,
        (Ok(_), Err(close)) => Err(close.into()),
        (Err(read), Err(close)) => {
            Err(std::io::Error::other(ReadAndRollbackError { read, close }).into())
        }
    }
}
#[derive(Debug)]
struct ReadAndRollbackError {
    read: StoreError,
    close: sqlx::Error,
}
impl std::fmt::Display for ReadAndRollbackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}; closing captured source read transaction also failed: {}",
            self.read, self.close
        )
    }
}
impl std::error::Error for ReadAndRollbackError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.read)
    }
}
