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
mod canonical;
mod locator;
use super::{SemanticCursor, SemanticSelection, available_at, invalid, rows_query};
use crate::{EventLog, StoreError};
use canonical::CanonicalRead;
mod directory;
pub use directory::{CapturedDirectoryRow, ChildPage, DirectoryPage};
use maka_agent_facts::history::RowPosition;
use maka_agent_facts::model::prompt_source::source::{
    ByteCursor, ByteSource, ChargedBuffer, ReadSource, SourceBuffer, SourceRead,
};
use maka_agent_facts::model::prompt_source::source::{SourceBacking as Backing, SourceLocator};
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

type Domain = maka_agent_facts::model::prompt_source::source::SourceIdentity;
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
const METADATA_WORDS: usize = 12;
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
    ArtifactMetadata,
}
#[derive(Clone)]
pub struct PayloadSource {
    domain: Arc<Domain>,
    backing: Backing,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct SourcePosition {
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
            Backing::ArtifactMetadata { .. } => PayloadEncoding::ArtifactMetadata,
        }
    }
    pub fn byte_len(&self) -> Option<u64> {
        match self.backing {
            Backing::Row { bytes, .. } | Backing::Canonical { bytes, .. } => Some(bytes),
            Backing::Pieces { bytes, .. } => Some(bytes),
            Backing::ArtifactMetadata { bytes, .. } => Some(bytes),
        }
    }
}
impl CapturedSource {
    pub fn locator_metadata_bytes() -> usize {
        std::mem::size_of::<CapturedBytes>() + 2 * std::mem::size_of::<usize>()
    }
    pub fn owns_locator(
        &self,
        identity: &Arc<maka_agent_facts::model::prompt_source::source::SourceIdentity>,
    ) -> bool {
        Arc::ptr_eq(&self.0.domain, identity)
    }
    /// Resolve a descriptor emitted by this captured owner's controlled request writer.
    /// Numeric request directories are ephemeral internal state, never external input.
    pub fn restore_locator(
        &self,
        backing: Backing,
        range: std::ops::Range<u64>,
    ) -> Result<Arc<dyn ByteSource>, StoreError> {
        let source = PayloadSource {
            domain: self.0.domain.clone(),
            backing,
        };
        if range.start > range.end {
            return Err(invalid("inverted captured locator range"));
        }
        self.byte_range(&source, range.start, range.end - range.start)
    }
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
            domain: Arc::new(maka_agent_facts::model::prompt_source::source::SourceIdentity),
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
                        let mut words = [rowid as u64,id.source_sequence,id.item_index,order.source_sequence,order.item_index,revision,bytes,0,0,0,0,0];
                        match payload {
                            None => {},
                            Some(Backing::Pieces{key,bytes}) => { words[7]=1; words[8]=key.source_sequence; words[9]=key.item_index; words[11]=bytes; },
                            Some(Backing::Canonical{key,offset,bytes}) => { words[7]=2; words[8]=key.source_sequence; words[9]=key.item_index; words[10]=offset; words[11]=bytes; },
                            Some(Backing::Row{..}|Backing::ArtifactMetadata{..}) => unreachable!("payload is never row metadata"),
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
                        "INSERT INTO context_semantic_fragments VALUES(0,?,'pieces',NULL,NULL,'null',?)",
                    )
                    .bind(index as i64)
                    .bind(bytes as i64)
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
                    let mut statement = raw.prepare("SELECT a.content_sha256,a.canonical_at IS NOT NULL,c.rowid FROM artifacts a JOIN artifact_contents c USING(content_sha256) WHERE a.rowid=?")?;
                    let mut records = statement.query([rowid])?;
                    let record = records.next()?.ok_or_else(||invalid("captured artifact disappeared"))?;
                    let content_rowid: i64 = record.get(2)?;
                    let length = blob_length(raw,"artifact_contents","payload",content_rowid)?;
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
                    let protected_metadata=protected.then_some(PayloadSource { domain,backing:Backing::ArtifactMetadata { rowid,bytes:metadata_bytes,payload_bytes:length,digest } });
                    let capture = ArtifactCapture { bytes:length,digest,metadata_bytes,protected_metadata };
                    with_blob(raw,"artifacts","record_json",rowid,0,metadata_bytes,|metadata| {
                        with_blob(raw,"artifact_contents","payload",content_rowid,0,length,|body| {
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
                            let canonical = CanonicalRead::load(worker, &backing).await?;
                            with_raw(worker, |raw| {
                                read_chunk(
                                    raw,
                                    &backing,
                                    position,
                                    buffer,
                                    None,
                                    canonical.as_ref(),
                                )
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
                            let canonical = CanonicalRead::load(worker, &backing).await?;
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
                                Backing::Canonical { bytes, .. } => canonical
                                    .as_ref()
                                    .ok_or_else(|| {
                                        invalid("canonical source metadata was not resolved")
                                    })?
                                    .with_range(raw, 0, bytes, consume),
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

pub(super) fn with_raw<T>(
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
        None => Ok(None),
    }
}

pub(super) fn with_fragment_reader<T>(
    raw: &RawConnection,
    key: RowPosition,
    source: super::source::SemanticPayloadSource,
    consume: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    match source {
        super::source::SemanticPayloadSource::CanonicalToolProjection(span) => {
            crate::canonical::with_span(
                raw,
                key.source_sequence as i64,
                span.offset() as u64,
                span.len() as u64,
                consume,
            )
        }
        super::source::SemanticPayloadSource::CanonicalModelPart(span) => with_blob(
            raw,
            "event_log",
            "event_header",
            key.source_sequence as i64,
            span.offset() as u64,
            span.len() as u64,
            consume,
        ),
        super::source::SemanticPayloadSource::Pieces => {
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
        Some((kind, offset, bytes)) => {
            let source = super::source::SemanticPayloadSource::from_metadata(
                key.source_sequence as i64,
                key.item_index as i64,
                &kind,
                offset,
                bytes,
            )?;
            let (offset, bytes) = match source {
                super::source::SemanticPayloadSource::CanonicalToolProjection(span) => {
                    (span.offset(), span.len())
                }
                super::source::SemanticPayloadSource::CanonicalModelPart(span) => {
                    (span.offset(), span.len())
                }
                super::source::SemanticPayloadSource::Pieces => {
                    return Err(invalid("invalid captured pieces"));
                }
            };
            Ok(Backing::Canonical {
                key,
                offset: offset as u64,
                bytes: bytes as u64,
            })
        }
        _ => Err(invalid("captured semantic fragment is missing or invalid")),
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
    let valid:bool=raw.query_row("SELECT EXISTS(SELECT 1 FROM artifacts a JOIN artifact_contents c USING(content_sha256) WHERE a.rowid=? AND length(c.payload)=? AND CAST(a.content_sha256 AS BLOB)=?)",params![rowid,bytes as i64,&encoded[..]],|row|row.get(0))?;
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
    canonical: Option<&CanonicalRead>,
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
        Backing::Canonical { key, bytes, .. } => {
            if position.offset > bytes {
                return Err(invalid("captured source position exceeds its span"));
            }
            let count = (bytes - position.offset).min(output.len() as u64) as usize;
            canonical
                .ok_or_else(|| invalid("canonical source metadata was not resolved"))?
                .with_range(raw, position.offset, count as u64, |reader| {
                    reader.read_exact(&mut output[..count])?;
                    Ok(())
                })?;
            let end = position.offset + count as u64 == bytes;
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
        Backing::Pieces { key, .. } => read_piece_chunk(raw, key, position, output)?,
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
fn read_piece_chunk(
    raw: &RawConnection,
    key: RowPosition,
    position: SourcePosition,
    output: &mut [u8],
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
            offset: position.offset + count as u64,
            ..position
        })
    } else if more_piece {
        Some(SourcePosition {
            piece: position.piece + 1,
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
    fn locator(&self) -> Option<SourceLocator> {
        Some(SourceLocator::Captured {
            identity: self.source.domain.clone(),
            backing: self.source.backing.clone(),
            range: self.start..self.start + self.bytes,
        })
    }
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
                Backing::Pieces { .. } => SourcePosition {
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
                                let canonical = CanonicalRead::load(worker, &backing).await?;
                                with_raw(worker, |raw| {
                                    read_chunk(
                                        raw,
                                        &backing,
                                        cursor,
                                        buffer,
                                        Some(usize::try_from(remaining).unwrap_or(usize::MAX)),
                                        canonical.as_ref(),
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
