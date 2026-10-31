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
    use_reader: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
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

use super::recipe::{Layout, Segment, Slot};
use std::io::{self, Seek, SeekFrom, Take};
fn invalid(reason: &'static str) -> StoreError {
    io::Error::new(io::ErrorKind::InvalidData, reason).into()
}
struct Parts<'a> {
    parts: [Option<Take<rusqlite::blob::Blob<'a>>>; 3],
    current: usize,
}
impl Read for Parts<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        while self.current < self.parts.len() {
            let read = match self.parts[self.current].as_mut() {
                Some(reader) => reader.read(output)?,
                None => 0,
            };
            if read > 0 {
                return Ok(read);
            }
            self.current += 1;
        }
        Ok(0)
    }
}
#[derive(Clone, Copy)]
pub(crate) struct SpanMetadata {
    live: bool,
    length: Option<i64>,
    slot_sequence: Option<i64>,
    slot_offset: Option<i64>,
    body_id: Option<i64>,
    raw_bytes: Option<i64>,
}
pub(crate) const SPAN_COLUMNS: &str = "e.event_header IS NOT NULL AS canonical_live,
 e.canonical_bytes AS canonical_length,canonical_slot.event_sequence AS canonical_slot_sequence,
 canonical_slot.header_offset AS canonical_offset,canonical_body.id AS canonical_body_id,
 canonical_body.raw_bytes AS canonical_raw_bytes";

impl SpanMetadata {
    pub(crate) fn from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self, StoreError> {
        use sqlx::Row;
        Ok(Self {
            live: row.try_get("canonical_live")?,
            length: row.try_get("canonical_length")?,
            slot_sequence: row.try_get("canonical_slot_sequence")?,
            slot_offset: row.try_get("canonical_offset")?,
            body_id: row.try_get("canonical_body_id")?,
            raw_bytes: row.try_get("canonical_raw_bytes")?,
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
        Ok(with_span_on_row(raw, row, sequence, offset, bytes, consume))
    })?
}

/// Consume metadata borrowed from a caller's existing same-snapshot query.
pub(crate) fn with_span_on_row<T>(
    raw: &rusqlite::Connection,
    row: &rusqlite::Row<'_>,
    sequence: i64,
    offset: u64,
    bytes: u64,
    consume: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    // SPAN_COLUMNS is one contiguous projection even when prefixed by a
    // caller's fields. Resolve its base once rather than rescan all names.
    let base = row.as_ref().column_index("canonical_live")?;
    let metadata = SpanMetadata {
        live: row.get(base)?,
        length: row.get(base + 1)?,
        slot_sequence: row.get(base + 2)?,
        slot_offset: row.get(base + 3)?,
        body_id: row.get(base + 4)?,
        raw_bytes: row.get(base + 5)?,
    };
    with_span_metadata(raw, sequence, metadata, offset, bytes, consume)
}

pub(crate) fn with_span_metadata<T>(
    raw: &rusqlite::Connection,
    sequence: i64,
    metadata: SpanMetadata,
    offset: u64,
    bytes: u64,
    consume: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let SpanMetadata {
        live,
        length,
        slot_sequence,
        slot_offset,
        body_id,
        raw_bytes,
    } = metadata;
    if !live {
        if length.is_some() || slot_sequence.is_some() || body_id.is_some() {
            return Err(invalid("collected canonical event retains live material"));
        }
        return Err(StoreError::MaterialCollected);
    }
    let length =
        u64::try_from(length.ok_or_else(|| invalid("canonical span lacks logical length"))?)
            .map_err(|_| invalid("negative canonical byte length"))?;
    let (slot, material) = match (slot_sequence, slot_offset, body_id, raw_bytes) {
        (None, None, None, None) => (None, None),
        (Some(source), Some(position), Some(id), Some(length))
            if source == sequence && position >= 0 && id > 0 && length > 0 =>
        {
            (
                Some(Slot {
                    offset: position as u64,
                    bytes: length as u64,
                }),
                Some((id, length as u64)),
            )
        }
        _ => return Err(invalid("canonical span has an incomplete body slot")),
    };
    let layout = Layout::new(length, slot)?;
    let end = offset
        .checked_add(bytes)
        .ok_or_else(|| invalid("canonical span length overflows"))?;
    let segments = layout.segments(offset..end)?;
    let mut parts = Parts {
        parts: std::array::from_fn(|_| None),
        current: 0,
    };
    let result = (|| {
        for (index, segment) in segments.into_iter().enumerate() {
            let Some(segment) = segment else { continue };
            let (table, column, rowid, expected, offset, bytes) = match segment {
                Segment::Header { offset, bytes } => (
                    "event_log",
                    "event_header",
                    sequence,
                    layout.header_bytes(),
                    offset,
                    bytes,
                ),
                Segment::Body { offset, bytes } => {
                    let (id, raw_bytes) = material
                        .ok_or_else(|| invalid("canonical range requires missing body material"))?;
                    ("event_bodies", "payload", id, raw_bytes, offset, bytes)
                }
            };
            let blob = raw.blob_open("main", table, column, rowid, true)?;
            // Install ownership before any validation or seek can fail.
            parts.parts[index] = Some(blob.take(bytes));
            let reader = parts.parts[index]
                .as_mut()
                .expect("installed canonical reader");
            if reader.get_ref().len() as u64 != expected {
                return Err(invalid("canonical material length changed"));
            }
            reader.get_mut().seek(SeekFrom::Start(offset))?;
        }
        consume(&mut parts)
    })();
    let mut closing = Ok(());
    for part in parts.parts.into_iter().flatten() {
        if let Err(error) = part.into_inner().close() {
            closing = match closing {
                Ok(()) => Err(error),
                Err(previous) => Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                    io::Error::other(format!("{previous}; {error}")),
                ))),
            };
        }
    }
    settle(result, closing)
}
