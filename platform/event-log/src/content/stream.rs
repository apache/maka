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

use super::{
    ENCODING_RAW, ENCODING_ZSTD_SEEKABLE, EncodedContent, SEEK_ENTRY_SIZE, SEEKABLE_FOOTER_MAGIC,
    SEEKABLE_FOOTER_SIZE, SEEKABLE_FRAME_BYTES, SKIPPABLE_HEADER_SIZE, SKIPPABLE_MAGIC_SEEKABLE,
    encode, with_compressor, with_decompressor,
};
use crate::StoreError;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use tokio_util::sync::CancellationToken;

const STAGE_MEM_LIMIT_BYTES: usize = 2 * 1024 * 1024;

enum StagingSink {
    Mem(Vec<u8>),
    File(File, u64),
}

impl StagingSink {
    fn new() -> Self {
        Self::Mem(Vec::new())
    }

    fn len(&self) -> u64 {
        match self {
            Self::Mem(buf) => buf.len() as u64,
            Self::File(_, len) => *len,
        }
    }

    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        match self {
            Self::Mem(buf) => {
                if buf.len().saturating_add(bytes.len()) <= STAGE_MEM_LIMIT_BYTES {
                    buf.extend_from_slice(bytes);
                    return Ok(());
                }
                let mut file = tempfile::tempfile()?;
                file.write_all(buf)?;
                file.write_all(bytes)?;
                let len = (buf.len() + bytes.len()) as u64;
                *self = Self::File(file, len);
                Ok(())
            }
            Self::File(file, len) => {
                file.write_all(bytes)?;
                *len = len.saturating_add(bytes.len() as u64);
                Ok(())
            }
        }
    }

    fn rewind(&mut self) -> io::Result<()> {
        if let Self::File(file, _) = self {
            file.seek(SeekFrom::Start(0))?;
        }
        Ok(())
    }

    fn write_to_blob(&mut self, blob: &mut rusqlite::blob::Blob<'_>) -> Result<(), StoreError> {
        match self {
            Self::Mem(buf) => {
                let mut offset = 0usize;
                while offset < buf.len() {
                    let end = (offset + SEEKABLE_FRAME_BYTES).min(buf.len());
                    blob.write_at(&buf[offset..end], offset)?;
                    offset = end;
                }
                Ok(())
            }
            Self::File(file, total) => {
                file.seek(SeekFrom::Start(0))?;
                let mut chunk = [0_u8; SEEKABLE_FRAME_BYTES];
                let mut offset = 0usize;
                let total_usize = usize::try_from(*total).map_err(|_| {
                    StoreError::InvalidTransition("staged blob exceeds addressable memory".into())
                })?;
                while offset < total_usize {
                    let take = chunk.len().min(total_usize - offset);
                    file.read_exact(&mut chunk[..take])?;
                    blob.write_at(&chunk[..take], offset)?;
                    offset += take;
                }
                Ok(())
            }
        }
    }

    fn copy_to_writer(&mut self, dst: &mut impl Write) -> io::Result<u64> {
        match self {
            Self::Mem(buf) => {
                dst.write_all(buf)?;
                Ok(buf.len() as u64)
            }
            Self::File(file, total) => {
                file.seek(SeekFrom::Start(0))?;
                let mut chunk = [0_u8; SEEKABLE_FRAME_BYTES];
                let mut remaining = *total;
                while remaining > 0 {
                    let take =
                        usize::try_from(remaining.min(chunk.len() as u64)).unwrap_or(chunk.len());
                    file.read_exact(&mut chunk[..take])?;
                    dst.write_all(&chunk[..take])?;
                    remaining -= take as u64;
                }
                Ok(*total)
            }
        }
    }

    fn read_exact_at(&mut self, cursor: &mut usize, dst: &mut [u8]) -> io::Result<()> {
        match self {
            Self::Mem(buf) => {
                let end = cursor.saturating_add(dst.len());
                if end > buf.len() {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "staged memory buffer truncated",
                    ));
                }
                dst.copy_from_slice(&buf[*cursor..end]);
                *cursor = end;
                Ok(())
            }
            Self::File(file, _) => file.read_exact(dst),
        }
    }
}

enum PreparedPayload {
    Inline {
        bytes: Vec<u8>,
        encoding: i64,
        logical_bytes: Option<i64>,
    },
    Staged {
        sink: StagingSink,
        encoding: i64,
        logical_bytes: Option<i64>,
    },
}

/// Verified, pre-compressed immutable content ready for insertion inside a short
/// SQLite write transaction without holding the writer lock across compression or
/// staging I/O.
pub struct PreparedStreamContent {
    digest: String,
    size: i32,
    payload: PreparedPayload,
}

impl PreparedStreamContent {
    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn logical_bytes(&self) -> u64 {
        self.size as u64
    }
}

fn validate_stream_header(digest: &str, bytes: u64) -> Result<i32, StoreError> {
    if !digest.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        return Err(StoreError::InvalidTransition(
            "invalid immutable content digest".into(),
        ));
    }
    i32::try_from(bytes).map_err(|_| {
        StoreError::InvalidTransition(
            "immutable content exceeds SQLite incremental Blob length limit".into(),
        )
    })
}

/// Verify and compress an immutable content stream completely outside any SQLite
/// transaction so foreground imports do not hold `BEGIN IMMEDIATE` across zstd CPU
/// work or temporary staging I/O.
pub fn prepare_stream(
    digest: &str,
    bytes: u64,
    reader: &mut dyn Read,
) -> Result<PreparedStreamContent, StoreError> {
    let size = validate_stream_header(digest, bytes)?;
    let length = size as usize;
    if length <= SEEKABLE_FRAME_BYTES {
        let mut buf = vec![0_u8; length];
        reader.read_exact(&mut buf)?;
        if reader.read(&mut [0_u8; 1])? != 0 {
            return Err(StoreError::InvalidTransition(
                "immutable content stream exceeds its declared byte length".into(),
            ));
        }
        if format!("sha256:{}", hex::encode(Sha256::digest(&buf))) != digest {
            return Err(StoreError::InvalidTransition(
                "immutable content stream does not match its declared digest".into(),
            ));
        }
        let EncodedContent {
            payload,
            encoding,
            logical_bytes,
        } = encode(&buf)?;
        return Ok(PreparedStreamContent {
            digest: digest.to_owned(),
            size,
            payload: PreparedPayload::Inline {
                bytes: payload.into_owned(),
                encoding,
                logical_bytes,
            },
        });
    }

    let num_frames = length.div_ceil(SEEKABLE_FRAME_BYTES);
    let table_body_len = num_frames
        .checked_mul(SEEK_ENTRY_SIZE)
        .and_then(|n| n.checked_add(SEEKABLE_FOOTER_SIZE))
        .ok_or_else(|| StoreError::InvalidTransition("seekable frame table overflow".into()))?;
    let table_body_u32 = u32::try_from(table_body_len)
        .map_err(|_| StoreError::InvalidTransition("seekable frame table exceeds u32".into()))?;
    let table_total_len = SKIPPABLE_HEADER_SIZE
        .checked_add(table_body_len)
        .ok_or_else(|| StoreError::InvalidTransition("seekable footer length overflow".into()))?;

    let mut hash = Sha256::new();
    let mut chunk_buf = vec![0_u8; SEEKABLE_FRAME_BYTES];
    let mut staged = StagingSink::new();
    let mut entries: Vec<(u32, u32)> = Vec::with_capacity(num_frames);
    let mut remaining = length;
    while remaining > 0 {
        let take = chunk_buf.len().min(remaining);
        reader.read_exact(&mut chunk_buf[..take])?;
        hash.update(&chunk_buf[..take]);
        let frame = with_compressor(|compressor| compressor.compress(&chunk_buf[..take]))?;
        let comp_size = u32::try_from(frame.len()).map_err(|_| {
            StoreError::InvalidTransition("compressed seekable frame exceeds u32".into())
        })?;
        let dec_size = u32::try_from(take).map_err(|_| {
            StoreError::InvalidTransition("decompressed seekable frame exceeds u32".into())
        })?;
        staged.write_all(&frame)?;
        entries.push((comp_size, dec_size));
        remaining -= take;
    }
    if reader.read(&mut [0_u8; 1])? != 0 {
        return Err(StoreError::InvalidTransition(
            "immutable content stream exceeds its declared byte length".into(),
        ));
    }
    if format!("sha256:{}", hex::encode(hash.finalize())) != digest {
        return Err(StoreError::InvalidTransition(
            "immutable content stream does not match its declared digest".into(),
        ));
    }

    let total_seekable = staged
        .len()
        .checked_add(table_total_len as u64)
        .ok_or_else(|| StoreError::InvalidTransition("seekable blob length overflow".into()))?;

    if total_seekable < bytes {
        let num_frames_u32 = u32::try_from(entries.len()).map_err(|_| {
            StoreError::InvalidTransition("seekable frame count exceeds u32".into())
        })?;
        let mut footer = Vec::with_capacity(table_total_len);
        footer.extend_from_slice(&SKIPPABLE_MAGIC_SEEKABLE.to_le_bytes());
        footer.extend_from_slice(&table_body_u32.to_le_bytes());
        for (comp_size, dec_size) in &entries {
            footer.extend_from_slice(&comp_size.to_le_bytes());
            footer.extend_from_slice(&dec_size.to_le_bytes());
        }
        footer.extend_from_slice(&num_frames_u32.to_le_bytes());
        footer.push(0);
        footer.extend_from_slice(&SEEKABLE_FOOTER_MAGIC.to_le_bytes());
        staged.write_all(&footer)?;
        return Ok(PreparedStreamContent {
            digest: digest.to_owned(),
            size,
            payload: PreparedPayload::Staged {
                sink: staged,
                encoding: ENCODING_ZSTD_SEEKABLE,
                logical_bytes: Some(i64::from(size)),
            },
        });
    }

    // Incompressible stream: materialize raw bytes into a staged sink outside the write lock
    // so put_prepared_stream only streams sequential bytes into SQLite without decompression.
    staged.rewind()?;
    let mut raw_sink = StagingSink::new();
    let mut comp_buf = Vec::new();
    let mut dec_buf = vec![0_u8; SEEKABLE_FRAME_BYTES];
    let mut cursor = 0usize;
    for (comp_size, dec_size) in entries {
        let comp_len = comp_size as usize;
        let dec_len = dec_size as usize;
        comp_buf.resize(comp_len, 0);
        staged.read_exact_at(&mut cursor, &mut comp_buf)?;
        let written = with_decompressor(|decompressor| {
            decompressor.decompress_to_buffer(&comp_buf, &mut dec_buf[..dec_len])
        })?;
        if written != dec_len {
            return Err(StoreError::InvalidTransition(
                "incompressible stream fallback frame size mismatch".into(),
            ));
        }
        raw_sink.write_all(&dec_buf[..dec_len])?;
    }
    Ok(PreparedStreamContent {
        digest: digest.to_owned(),
        size,
        payload: PreparedPayload::Staged {
            sink: raw_sink,
            encoding: ENCODING_RAW,
            logical_bytes: None,
        },
    })
}

/// Insert an already-prepared `PreparedStreamContent` inside the caller's transaction,
/// deduplicating by `content_sha256` with zero compression or hashing CPU work.
pub fn put_prepared_stream(
    connection: &Connection,
    prepared: &mut PreparedStreamContent,
) -> Result<i64, StoreError> {
    let existing: Option<(i64, i64)> = connection
        .prepare_cached(
            "SELECT id, COALESCE(logical_bytes, length(payload)) FROM contents WHERE content_sha256=?",
        )?
        .query_row([&prepared.digest], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    if let Some((id, length)) = existing {
        if length != i64::from(prepared.size) {
            return Err(StoreError::InvalidTransition(
                "immutable content digest already has a different byte length".into(),
            ));
        }
        return Ok(id);
    }

    match &mut prepared.payload {
        PreparedPayload::Inline {
            bytes,
            encoding,
            logical_bytes,
        } => Ok(connection
            .prepare_cached(
                "INSERT INTO contents(content_sha256,payload,encoding,logical_bytes) VALUES(?1,?2,?3,?4) RETURNING id",
            )?
            .query_row(
                params![&prepared.digest, bytes.as_slice(), *encoding, *logical_bytes],
                |row| row.get(0),
            )?),
        PreparedPayload::Staged {
            sink,
            encoding,
            logical_bytes,
        } => {
            let stored_size = i32::try_from(sink.len()).map_err(|_| {
                StoreError::InvalidTransition(
                    "staged content exceeds SQLite incremental Blob length limit".into(),
                )
            })?;
            let id = connection
                .prepare_cached(
                    "INSERT INTO contents(content_sha256,payload,encoding,logical_bytes) VALUES(?1,zeroblob(?2),?3,?4) RETURNING id",
                )?
                .query_row(
                    params![&prepared.digest, stored_size, *encoding, *logical_bytes],
                    |row| row.get(0),
                )?;
            let mut blob = connection.blob_open("main", "contents", "payload", id, false)?;
            let write_result = sink.write_to_blob(&mut blob).map(|()| id);
            match (write_result, blob.close()) {
                (result, Ok(())) => result,
                (Ok(_), Err(close)) => Err(close.into()),
                (Err(stream), Err(close)) => {
                    Err(io::Error::other(StreamAndClose { stream, close }).into())
                }
            }
        }
    }
}

enum BatchPayload {
    Inline(Vec<u8>),
    Spool { offset: u64, len: u64 },
}

struct BatchEntry {
    digest: String,
    size: i32,
    encoding: i64,
    logical_bytes: Option<i64>,
    payload: BatchPayload,
}

/// Multi-object staging batch that verifies and compresses arbitrary streams
/// completely outside SQLite transactions while bounding working memory to 2 MiB
/// and open temporary file descriptors to at most one shared unlinked spool file.
#[derive(Default)]
pub struct PreparedStreamBatch {
    entries: Vec<BatchEntry>,
    spool: Option<File>,
    spool_len: u64,
    buffered_bytes: usize,
}

impl PreparedStreamBatch {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(
        &mut self,
        digest: &str,
        bytes: u64,
        reader: &mut dyn Read,
    ) -> Result<usize, StoreError> {
        let prepared = prepare_stream(digest, bytes, reader)?;
        let (encoding, logical_bytes, payload) = match prepared.payload {
            PreparedPayload::Inline {
                bytes,
                encoding,
                logical_bytes,
            } => {
                if self.buffered_bytes.saturating_add(bytes.len()) <= STAGE_MEM_LIMIT_BYTES {
                    self.buffered_bytes += bytes.len();
                    (encoding, logical_bytes, BatchPayload::Inline(bytes))
                } else {
                    let offset = self.spool_len;
                    let spool = self.spool_file()?;
                    spool.seek(SeekFrom::Start(offset))?;
                    spool.write_all(&bytes)?;
                    let len = bytes.len() as u64;
                    self.spool_len = self.spool_len.checked_add(len).ok_or_else(|| {
                        StoreError::InvalidTransition("staged batch spool overflow".into())
                    })?;
                    (encoding, logical_bytes, BatchPayload::Spool { offset, len })
                }
            }
            PreparedPayload::Staged {
                mut sink,
                encoding,
                logical_bytes,
            } => match sink {
                StagingSink::Mem(bytes)
                    if self.buffered_bytes.saturating_add(bytes.len()) <= STAGE_MEM_LIMIT_BYTES =>
                {
                    self.buffered_bytes += bytes.len();
                    (encoding, logical_bytes, BatchPayload::Inline(bytes))
                }
                _ => {
                    let offset = self.spool_len;
                    let spool = self.spool_file()?;
                    spool.seek(SeekFrom::Start(offset))?;
                    let len = sink.copy_to_writer(spool)?;
                    self.spool_len = self.spool_len.checked_add(len).ok_or_else(|| {
                        StoreError::InvalidTransition("staged batch spool overflow".into())
                    })?;
                    (encoding, logical_bytes, BatchPayload::Spool { offset, len })
                }
            },
        };
        let index = self.entries.len();
        self.entries.push(BatchEntry {
            digest: prepared.digest,
            size: prepared.size,
            encoding,
            logical_bytes,
            payload,
        });
        Ok(index)
    }

    pub fn insert(&mut self, connection: &Connection, index: usize) -> Result<i64, StoreError> {
        let entry = self.entries.get(index).ok_or_else(|| {
            StoreError::InvalidTransition("staged stream batch index out of bounds".into())
        })?;
        let existing: Option<(i64, i64)> = connection
            .prepare_cached(
                "SELECT id, COALESCE(logical_bytes, length(payload)) FROM contents WHERE content_sha256=?",
            )?
            .query_row([&entry.digest], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        if let Some((id, length)) = existing {
            if length != i64::from(entry.size) {
                return Err(StoreError::InvalidTransition(
                    "immutable content digest already has a different byte length".into(),
                ));
            }
            return Ok(id);
        }

        match &entry.payload {
            BatchPayload::Inline(bytes) => Ok(connection
                .prepare_cached(
                    "INSERT INTO contents(content_sha256,payload,encoding,logical_bytes) VALUES(?1,?2,?3,?4) RETURNING id",
                )?
                .query_row(
                    params![&entry.digest, bytes.as_slice(), entry.encoding, entry.logical_bytes],
                    |row| row.get(0),
                )?),
            BatchPayload::Spool { offset, len } => {
                let stored_size = i32::try_from(*len).map_err(|_| {
                    StoreError::InvalidTransition(
                        "staged content exceeds SQLite incremental Blob length limit".into(),
                    )
                })?;
                let id = connection
                    .prepare_cached(
                        "INSERT INTO contents(content_sha256,payload,encoding,logical_bytes) VALUES(?1,zeroblob(?2),?3,?4) RETURNING id",
                    )?
                    .query_row(
                        params![&entry.digest, stored_size, entry.encoding, entry.logical_bytes],
                        |row| row.get(0),
                    )?;
                let spool = self.spool.as_mut().ok_or_else(|| {
                    StoreError::InvalidTransition("missing staged batch spool file".into())
                })?;
                let mut blob = connection.blob_open("main", "contents", "payload", id, false)?;
                let write_result = write_file_slice_to_blob(spool, *offset, *len, &mut blob).map(|()| id);
                match (write_result, blob.close()) {
                    (result, Ok(())) => result,
                    (Ok(_), Err(close)) => Err(close.into()),
                    (Err(stream), Err(close)) => {
                        Err(io::Error::other(StreamAndClose { stream, close }).into())
                    }
                }
            }
        }
    }

    fn spool_file(&mut self) -> io::Result<&mut File> {
        if self.spool.is_none() {
            self.spool = Some(tempfile::tempfile()?);
        }
        Ok(self.spool.as_mut().expect("spool file just initialized"))
    }
}

fn write_file_slice_to_blob(
    file: &mut File,
    start: u64,
    len: u64,
    blob: &mut rusqlite::blob::Blob<'_>,
) -> Result<(), StoreError> {
    file.seek(SeekFrom::Start(start))?;
    let total_usize = usize::try_from(len).map_err(|_| {
        StoreError::InvalidTransition("staged blob exceeds addressable memory".into())
    })?;
    let mut chunk = [0_u8; SEEKABLE_FRAME_BYTES];
    let mut written = 0usize;
    while written < total_usize {
        let take = chunk.len().min(total_usize - written);
        file.read_exact(&mut chunk[..take])?;
        blob.write_at(&chunk[..take], written)?;
        written += take;
    }
    Ok(())
}

/// Insert already-prepared immutable bytes in the caller's transaction while
/// applying tiered zstd compression with bounded working memory.
/// Any error requires that transaction or its statement savepoint to roll back.
pub fn put_stream(
    connection: &Connection,
    digest: &str,
    bytes: u64,
    reader: &mut dyn Read,
) -> Result<i64, StoreError> {
    let size = validate_stream_header(digest, bytes)?;
    let existing: Option<(i64, i64)> = connection
        .prepare_cached(
            "SELECT id, COALESCE(logical_bytes, length(payload)) FROM contents WHERE content_sha256=?",
        )?
        .query_row([digest], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    if let Some((id, length)) = existing {
        if length != i64::from(size) {
            return Err(StoreError::InvalidTransition(
                "immutable content digest already has a different byte length".into(),
            ));
        }
        return Ok(id);
    }
    let mut prepared = prepare_stream(digest, bytes, reader)?;
    put_prepared_stream(connection, &mut prepared)
}

/// Bounded-RAM staged seekable zstd payload for streaming recompression of oversized
/// legacy raw `contents` rows (spills to an unlinked tempfile beyond 2 MiB).
pub(crate) struct StagedSeekable {
    sink: StagingSink,
}

impl StagedSeekable {
    pub(super) fn len(&self) -> u64 {
        self.sink.len()
    }

    pub(super) fn write_to_blob(
        &mut self,
        blob: &mut rusqlite::blob::Blob<'_>,
    ) -> Result<(), StoreError> {
        self.sink.write_to_blob(blob)
    }
}

pub(super) enum StageOversizedOutcome {
    Staged(StagedSeekable),
    Skipped,
    Cancelled,
}

/// Stream an oversized raw `contents` row directly from an incremental SQLite `Blob`
/// into independent 64 KiB seekable zstd frames + Zstd Seekable Format footer.
/// Stops promptly if `stop` is cancelled, and skips when compressed size is not strictly
/// smaller than `raw_len` or exceeds `max_write_bytes`.
pub(super) fn stage_seekable_from_blob(
    blob: &rusqlite::blob::Blob<'_>,
    raw_len: usize,
    max_write_bytes: u64,
    stop: Option<&CancellationToken>,
) -> Result<StageOversizedOutcome, StoreError> {
    if raw_len <= SEEKABLE_FRAME_BYTES {
        return Ok(StageOversizedOutcome::Skipped);
    }
    let num_frames = raw_len.div_ceil(SEEKABLE_FRAME_BYTES);
    let table_body_len = num_frames
        .checked_mul(SEEK_ENTRY_SIZE)
        .and_then(|n| n.checked_add(SEEKABLE_FOOTER_SIZE))
        .ok_or_else(|| StoreError::InvalidTransition("seekable frame table overflow".into()))?;
    let table_body_u32 = u32::try_from(table_body_len)
        .map_err(|_| StoreError::InvalidTransition("seekable frame table exceeds u32".into()))?;
    let table_total_len = SKIPPABLE_HEADER_SIZE
        .checked_add(table_body_len)
        .ok_or_else(|| StoreError::InvalidTransition("seekable footer length overflow".into()))?;
    let size_limit = (raw_len as u64).saturating_sub(1).min(max_write_bytes);
    if table_total_len as u64 > size_limit {
        return Ok(StageOversizedOutcome::Skipped);
    }

    let mut chunk_buf = vec![0_u8; SEEKABLE_FRAME_BYTES];
    let mut staged = StagingSink::new();
    let mut entries: Vec<(u32, u32)> = Vec::with_capacity(num_frames);
    let mut offset = 0usize;
    while offset < raw_len {
        if stop.is_some_and(CancellationToken::is_cancelled) {
            return Ok(StageOversizedOutcome::Cancelled);
        }
        let take = chunk_buf.len().min(raw_len - offset);
        blob.read_at_exact(&mut chunk_buf[..take], offset)?;
        let frame = with_compressor(|compressor| compressor.compress(&chunk_buf[..take]))?;
        let comp_size = u32::try_from(frame.len()).map_err(|_| {
            StoreError::InvalidTransition("compressed seekable frame exceeds u32".into())
        })?;
        let dec_size = u32::try_from(take).map_err(|_| {
            StoreError::InvalidTransition("decompressed seekable frame exceeds u32".into())
        })?;
        staged.write_all(&frame)?;
        if staged.len().saturating_add(table_total_len as u64) > size_limit {
            return Ok(StageOversizedOutcome::Skipped);
        }
        entries.push((comp_size, dec_size));
        offset += take;
    }

    let mut footer = Vec::with_capacity(table_total_len);
    footer.extend_from_slice(&SKIPPABLE_MAGIC_SEEKABLE.to_le_bytes());
    footer.extend_from_slice(&table_body_u32.to_le_bytes());
    for (comp_size, dec_size) in &entries {
        footer.extend_from_slice(&comp_size.to_le_bytes());
        footer.extend_from_slice(&dec_size.to_le_bytes());
    }
    let num_frames_u32 = u32::try_from(entries.len())
        .map_err(|_| StoreError::InvalidTransition("seekable frame count exceeds u32".into()))?;
    footer.extend_from_slice(&num_frames_u32.to_le_bytes());
    footer.push(0);
    footer.extend_from_slice(&SEEKABLE_FOOTER_MAGIC.to_le_bytes());
    staged.write_all(&footer)?;

    Ok(StageOversizedOutcome::Staged(StagedSeekable {
        sink: staged,
    }))
}

#[derive(Debug)]
struct StreamAndClose {
    stream: StoreError,
    close: rusqlite::Error,
}
impl std::fmt::Display for StreamAndClose {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "content stream failed: {}; closing its Blob also failed: {}",
            self.stream, self.close
        )
    }
}
impl std::error::Error for StreamAndClose {}
