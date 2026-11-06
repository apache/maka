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

//! Same-handle immutable body readers; no SQLite handle escapes the callback.
use crate::StoreError;
use std::io::Read;
#[derive(Debug, thiserror::Error)]
#[error("{read}; closing canonical body also failed: {close}")]
struct ReadAndClose {
    #[source]
    read: StoreError,
    close: rusqlite::Error,
}
fn settle<T>(result: Result<T, StoreError>, closed: rusqlite::Result<()>) -> Result<T, StoreError> {
    match (result, closed) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error.into()),
        (Err(read), Err(close)) => Err(std::io::Error::other(ReadAndClose { read, close }).into()),
    }
}

use super::recipe::{Layout, Slot};
use std::io;
fn invalid(reason: &'static str) -> StoreError {
    io::Error::new(io::ErrorKind::InvalidData, reason).into()
}
#[derive(Clone, Copy)]
pub(crate) struct SpanMetadata {
    sequence: i64,
    live: bool,
    length: Option<i64>,
    body_reference: Option<i64>,
    slot_offset: Option<i64>,
    body_id: Option<i64>,
    raw_bytes: Option<i64>,
}
pub(crate) const SPAN_COLUMNS: &str = "e.event_header IS NOT NULL AS canonical_live,
 e.canonical_bytes AS canonical_length,e.body_id AS canonical_body_reference,
 e.header_offset AS canonical_offset,canonical_body.id AS canonical_body_id,
 length(canonical_body.payload) AS canonical_raw_bytes,e.sequence AS canonical_sequence";

impl SpanMetadata {
    pub(crate) fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let base = row.as_ref().column_index("canonical_live")?;
        Ok(Self {
            sequence: row.get(base + 6)?,
            live: row.get(base)?,
            length: row.get(base + 1)?,
            body_reference: row.get(base + 2)?,
            slot_offset: row.get(base + 3)?,
            body_id: row.get(base + 4)?,
            raw_bytes: row.get(base + 5)?,
        })
    }
}

/// Map canonical coordinates to immutable material without reading a full header.
pub(crate) fn with_span<T>(
    raw: &rusqlite::Connection,
    sequence: i64,
    offset: u64,
    bytes: u64,
    consume: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let query = format!(
        "SELECT {SPAN_COLUMNS} FROM event_log e {} WHERE e.sequence=?",
        super::read::JOINS
    );
    raw.query_row(&query, [sequence], |row| {
        Ok(with_span_metadata(
            raw,
            SpanMetadata::from_row(row)?,
            offset,
            bytes,
            consume,
        ))
    })?
}

pub(crate) fn with_span_metadata<T>(
    raw: &rusqlite::Connection,
    metadata: SpanMetadata,
    offset: u64,
    bytes: u64,
    consume: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let SpanMetadata {
        sequence,
        live,
        length,
        body_reference,
        slot_offset,
        body_id,
        raw_bytes,
    } = metadata;
    if !live {
        if length.is_some()
            || body_reference.is_some()
            || slot_offset.is_some()
            || body_id.is_some()
            || raw_bytes.is_some()
        {
            return Err(invalid("collected canonical event retains live material"));
        }
        return Err(StoreError::MaterialCollected);
    }
    let length =
        u64::try_from(length.ok_or_else(|| invalid("canonical span lacks logical length"))?)
            .map_err(|_| invalid("negative canonical byte length"))?;
    let (slot, id) = match (body_reference, slot_offset, body_id, raw_bytes) {
        (Some(reference), Some(position), Some(id), Some(bytes))
            if reference == id && position >= 0 && id > 0 && bytes > 0 =>
        {
            (
                Some(Slot {
                    offset: position as u64,
                    bytes: bytes as u64,
                }),
                Some(id),
            )
        }
        (None, None, None, None) => (None, None),
        _ => return Err(invalid("canonical body binding differs")),
    };
    Layout::new(length, slot)?;
    let end = offset
        .checked_add(bytes)
        .filter(|end| *end <= length)
        .ok_or_else(|| invalid("canonical range exceeds event"))?;
    let in_body = slot.is_some_and(|slot| offset >= slot.offset && end <= slot.offset + slot.bytes);
    let header = if in_body {
        None
    } else {
        Some(raw.blob_open("main", "event_log", "event_header", sequence, true)?)
    };
    let body = if let Some(id) = id {
        Some(raw.blob_open("main", "contents", "payload", id, true)?)
    } else {
        None
    };
    let mut reader = SpanReader {
        header,
        body,
        slot,
        offset,
        remaining: bytes,
    };
    let result = consume(&mut reader);
    let result = settle(
        result,
        reader.body.take().map_or(Ok(()), |body| body.close()),
    );
    settle(
        result,
        reader.header.take().map_or(Ok(()), |header| header.close()),
    )
}

struct SpanReader<'db> {
    header: Option<rusqlite::blob::Blob<'db>>,
    body: Option<rusqlite::blob::Blob<'db>>,
    slot: Option<Slot>,
    offset: u64,
    remaining: u64,
}
impl Read for SpanReader<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let requested = self.remaining.min(out.len() as u64);
        if requested == 0 {
            return Ok(0);
        }
        let (blob, offset, available) = match self.slot {
            Some(slot) if self.offset >= slot.offset && self.offset < slot.offset + slot.bytes => (
                self.body.as_ref(),
                self.offset - slot.offset,
                slot.offset + slot.bytes - self.offset,
            ),
            Some(slot) if self.offset < slot.offset => {
                (self.header.as_ref(), self.offset, slot.offset - self.offset)
            }
            Some(slot) => (
                self.header.as_ref(),
                self.offset - slot.bytes + 4,
                self.remaining,
            ),
            None => (self.header.as_ref(), self.offset, self.remaining),
        };
        let bytes = requested.min(available) as usize;
        let offset = usize::try_from(offset)
            .map_err(|_| io::Error::other("canonical range exceeds address space"))?;
        blob.ok_or_else(|| io::Error::other("missing canonical span material"))?
            .read_at_exact(&mut out[..bytes], offset)
            .map_err(io::Error::other)?;
        self.offset += bytes as u64;
        self.remaining -= bytes as u64;
        Ok(bytes)
    }
}
