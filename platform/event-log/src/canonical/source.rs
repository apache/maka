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
pub(super) fn with_material<T>(
    raw: &rusqlite::Connection,
    id: i64,
    bytes: u64,
    use_reader: impl FnOnce(&mut rusqlite::blob::Blob<'_>) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let mut blob = raw.blob_open("main", "event_bodies", "payload", id, true)?;
    let result = (|| {
        if blob.len() as u64 != bytes {
            return Err(invalid("canonical body length changed"));
        }
        use_reader(&mut blob)
    })();
    settle(result, blob.close())
}
fn settle<T>(result: Result<T, StoreError>, closed: rusqlite::Result<()>) -> Result<T, StoreError> {
    match (result, closed) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error.into()),
        (Err(read), Err(close)) => Err(std::io::Error::other(ReadAndClose { read, close }).into()),
    }
}

use super::recipe::{Layout, Slot};
use std::io::{self, Seek, SeekFrom};
fn invalid(reason: &'static str) -> StoreError {
    io::Error::new(io::ErrorKind::InvalidData, reason).into()
}
#[derive(Clone, Copy)]
pub(crate) struct SpanMetadata {
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
 canonical_body.raw_bytes AS canonical_raw_bytes";

impl SpanMetadata {
    pub(crate) fn from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self, StoreError> {
        use sqlx::Row;
        Ok(Self {
            live: row.try_get("canonical_live")?,
            length: row.try_get("canonical_length")?,
            body_reference: row.try_get("canonical_body_reference")?,
            slot_offset: row.try_get("canonical_offset")?,
            body_id: row.try_get("canonical_body_id")?,
            raw_bytes: row.try_get("canonical_raw_bytes")?,
        })
    }
    pub(crate) fn from_handle(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let base = row.as_ref().column_index("canonical_live")?;
        Ok(Self {
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
            SpanMetadata::from_handle(row)?,
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
                Slot {
                    offset: position as u64,
                    bytes: bytes as u64,
                },
                id,
            )
        }
        _ => return Err(invalid("canonical tool projection lacks its body slot")),
    };
    Layout::new(length, Some(slot))?;
    let end = offset
        .checked_add(bytes)
        .ok_or_else(|| invalid("canonical span length overflows"))?;
    if offset < slot.offset || end > slot.offset + slot.bytes {
        return Err(invalid("canonical tool range exceeds its body slot"));
    }
    with_material(raw, id, slot.bytes, |reader| {
        reader.seek(SeekFrom::Start(offset - slot.offset))?;
        consume(&mut reader.take(bytes))
    })
}
