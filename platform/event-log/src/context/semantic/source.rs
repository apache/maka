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

//! Checked references to projection bytes in the immutable canonical event.

use super::invalid;
use crate::StoreError;
use maka_agent_facts::{
    history::semantic::Payload, model::ModelPart, tool_output::DurableToolProjection,
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sqlx::sqlite::SqliteWorkerConnection;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};

const READ_BUFFER_BYTES: usize = 32 * 1024;

#[derive(Clone, Copy, Debug)]
pub(super) struct CanonicalToolProjectionSpan {
    source_sequence: i64,
    byte_offset: u64,
    byte_len: u64,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum SemanticPayloadSource {
    Pieces,
    CanonicalToolProjection(CanonicalToolProjectionSpan),
    CanonicalModelPart(CanonicalModelPartSpan),
}

#[derive(Clone, Copy, Debug)]
pub(super) struct CanonicalModelPartSpan(CanonicalToolProjectionSpan);

pub(super) fn locate_model_parts(
    source_sequence: u64,
    json: &str,
) -> Result<std::collections::BTreeMap<u64, CanonicalModelPartSpan>, StoreError> {
    #[derive(Deserialize)]
    struct Envelope<'src> {
        #[serde(borrow)]
        fact: Fact<'src>,
    }
    #[derive(Deserialize)]
    struct Fact<'src> {
        kind: &'src str,
        #[serde(borrow)]
        event: Option<Observation<'src>>,
        #[serde(borrow)]
        output: Option<Parts<'src>>,
        #[serde(borrow)]
        partial: Option<Parts<'src>>,
    }
    #[derive(Deserialize)]
    struct Observation<'src> {
        kind: &'src str,
        #[serde(borrow)]
        data: Record<'src>,
    }
    #[derive(Deserialize)]
    struct Parts<'src> {
        #[serde(borrow)]
        parts: Vec<Part<'src>>,
    }
    #[derive(Deserialize)]
    struct Part<'src> {
        kind: &'src str,
        #[serde(borrow)]
        data: Record<'src>,
    }
    #[derive(Deserialize)]
    struct Record<'src> {
        ordinal: Option<u64>,
        #[serde(borrow)]
        part: Option<&'src RawValue>,
    }
    let envelope: Envelope<'_> = serde_json::from_str(json)?;
    let records = match envelope.fact {
        Fact {
            kind: "model_observed",
            event: Some(Observation { kind: "part", data }),
            ..
        } => vec![data],
        Fact {
            kind: "model_completed",
            output: Some(output),
            ..
        } => output
            .parts
            .into_iter()
            .filter_map(|part| (part.kind == "own").then_some(part.data))
            .collect(),
        Fact {
            kind: "model_interrupted",
            partial,
            ..
        } => partial
            .into_iter()
            .flat_map(|partial| partial.parts)
            .filter_map(|part| (part.kind == "own").then_some(part.data))
            .collect(),
        Fact {
            kind: "model_observed",
            ..
        } => Vec::new(),
        _ => return Err(invalid("canonical model part lacks a model fact")),
    };
    let mut spans = std::collections::BTreeMap::new();
    for record in records {
        let ordinal = record
            .ordinal
            .ok_or_else(|| invalid("canonical model part lacks ordinal"))?;
        let raw = record
            .part
            .ok_or_else(|| invalid("canonical model part lacks body"))?
            .get();
        let offset = (raw.as_ptr() as usize)
            .checked_sub(json.as_ptr() as usize)
            .ok_or_else(|| invalid("canonical model part does not borrow its event"))?;
        let end = offset
            .checked_add(raw.len())
            .filter(|end| *end <= json.len())
            .ok_or_else(|| invalid("canonical model part is outside its event"))?;
        i32::try_from(end)
            .map_err(|_| invalid("canonical model part exceeds SQLite Blob range"))?;
        let span = CanonicalModelPartSpan::from_metadata(
            i64::try_from(source_sequence)
                .map_err(|_| invalid("canonical model sequence exceeds SQLite range"))?,
            i64::try_from(offset)
                .map_err(|_| invalid("canonical model offset exceeds SQLite range"))?,
            i64::try_from(raw.len())
                .map_err(|_| invalid("canonical model length exceeds SQLite range"))?,
        )?;
        if spans.insert(ordinal, span).is_some() {
            return Err(invalid("duplicate canonical model ordinal"));
        }
    }
    Ok(spans)
}
impl CanonicalModelPartSpan {
    fn from_metadata(sequence: i64, offset: i64, len: i64) -> Result<Self, StoreError> {
        let span = CanonicalToolProjectionSpan::from_metadata(sequence, offset, len)?;
        if offset
            .checked_add(len)
            .is_none_or(|end| end > i64::from(i32::MAX))
        {
            return Err(invalid("canonical model part exceeds SQLite Blob range"));
        }
        Ok(Self(span))
    }

    pub(super) fn offset(self) -> i64 {
        self.0.offset()
    }
    pub(super) fn len(self) -> i64 {
        self.0.len()
    }
    pub(super) fn read(
        self,
        worker: &mut SqliteWorkerConnection<'_>,
    ) -> Result<Payload, StoreError> {
        self.0
            .read_inline_value::<ModelPart>(worker)
            .map(Payload::Part)
    }
}

impl CanonicalToolProjectionSpan {
    pub(super) fn locate(source_sequence: u64, json: &str) -> Result<Self, StoreError> {
        #[derive(Deserialize)]
        struct Envelope<'src> {
            #[serde(borrow)]
            fact: Fact<'src>,
        }
        #[derive(Deserialize)]
        struct Fact<'src> {
            #[serde(borrow)]
            outcome: Outcome<'src>,
        }
        #[derive(Deserialize)]
        struct Outcome<'src> {
            #[serde(borrow)]
            model_projection: &'src RawValue,
        }
        let envelope: Envelope<'_> = serde_json::from_str(json)?;
        let projection = envelope.fact.outcome.model_projection.get();
        let offset = (projection.as_ptr() as usize)
            .checked_sub(json.as_ptr() as usize)
            .ok_or_else(|| invalid("canonical projection does not borrow its event"))?;
        offset
            .checked_add(projection.len())
            .filter(|end| *end <= json.len())
            .ok_or_else(|| invalid("canonical projection is outside its event"))?;
        Self::from_metadata(
            i64::try_from(source_sequence)
                .map_err(|_| invalid("canonical source sequence exceeds SQLite range"))?,
            i64::try_from(offset)
                .map_err(|_| invalid("canonical projection offset exceeds SQLite range"))?,
            i64::try_from(projection.len())
                .map_err(|_| invalid("canonical projection length exceeds SQLite range"))?,
        )
    }

    fn from_metadata(sequence: i64, offset: i64, len: i64) -> Result<Self, StoreError> {
        if sequence <= 0 || offset < 0 || len <= 0 || offset.checked_add(len).is_none() {
            return Err(invalid("invalid canonical projection span"));
        }
        Ok(Self {
            source_sequence: sequence,
            byte_offset: offset as u64,
            byte_len: len as u64,
        })
    }

    pub(super) fn offset(self) -> i64 {
        self.byte_offset as i64
    }
    pub(super) fn len(self) -> i64 {
        self.byte_len as i64
    }
    pub(super) fn matches_projection(
        self,
        json: &str,
        projection: &DurableToolProjection,
    ) -> Result<bool, StoreError> {
        let start = usize::try_from(self.byte_offset)
            .map_err(|_| invalid("canonical projection offset exceeds address range"))?;
        let end = start
            .checked_add(
                usize::try_from(self.byte_len)
                    .map_err(|_| invalid("canonical projection length exceeds address range"))?,
            )
            .ok_or_else(|| invalid("canonical projection span overflows"))?;
        let expected = json
            .as_bytes()
            .get(start..end)
            .ok_or_else(|| invalid("canonical projection exceeds its event"))?;
        serialized_matches(expected, projection)
    }

    pub(super) fn read(
        self,
        worker: &mut SqliteWorkerConnection<'_>,
    ) -> Result<Payload, StoreError> {
        super::captured::with_raw(worker, |raw| {
            crate::canonical::with_span(
                raw,
                self.source_sequence,
                self.byte_offset,
                self.byte_len,
                |reader| {
                    let reader = BufReader::with_capacity(READ_BUFFER_BYTES, reader);
                    Ok(Payload::Tool(serde_json::from_reader::<
                        _,
                        DurableToolProjection,
                    >(reader)?))
                },
            )
        })
    }
    fn read_inline_value<T: serde::de::DeserializeOwned>(
        self,
        worker: &mut SqliteWorkerConnection<'_>,
    ) -> Result<T, StoreError> {
        // SAFETY: the original SQLite worker is exclusively borrowed. The wrapper
        // is non-owning, and it and the Blob are dropped before this callback returns.
        let borrowed =
            unsafe { rusqlite::Connection::from_handle(worker.as_raw_handle().as_ptr()) }?;
        let mut blob = borrowed.blob_open(
            "main",
            "event_log",
            "event_header",
            self.source_sequence,
            true,
        )?;
        let result = (|| {
            let end = self
                .byte_offset
                .checked_add(self.byte_len)
                .ok_or_else(|| invalid("canonical projection span overflows"))?;
            if end > blob.len() as u64 {
                return Err(invalid("canonical projection span exceeds its event"));
            }
            blob.seek(SeekFrom::Start(self.byte_offset))?;
            let reader =
                BufReader::with_capacity(READ_BUFFER_BYTES, (&mut blob).take(self.byte_len));
            Ok(serde_json::from_reader(reader)?)
        })();
        let closed = blob.close();
        drop(borrowed);
        match (result, closed) {
            (result, Ok(())) => result,
            (Ok(_), Err(close)) => Err(close.into()),
            (Err(read), Err(close)) => {
                Err(std::io::Error::other(ReadAndCloseError { read, close }).into())
            }
        }
    }
}

fn serialized_matches(expected: &[u8], value: &impl Serialize) -> Result<bool, StoreError> {
    struct Compare<'a> {
        expected: &'a [u8],
        position: usize,
        equal: bool,
    }
    impl Write for Compare<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let end = self
                .position
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("serialized projection length overflows"))?;
            self.equal &= self.expected.get(self.position..end) == Some(bytes);
            self.position = end;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut compare = Compare {
        expected,
        position: 0,
        equal: true,
    };
    serde_json::to_writer(&mut compare, value)?;
    Ok(compare.equal && compare.position == expected.len())
}

impl SemanticPayloadSource {
    pub(super) fn from_metadata(
        sequence: i64,
        index: i64,
        kind: &str,
        offset: Option<i64>,
        len: Option<i64>,
    ) -> Result<Self, StoreError> {
        match (kind, offset, len) {
            ("pieces", None, None) => Ok(Self::Pieces),
            ("canonical_tool_projection", Some(offset), Some(len)) if index == 0 => {
                Ok(Self::CanonicalToolProjection(
                    CanonicalToolProjectionSpan::from_metadata(sequence, offset, len)?,
                ))
            }
            ("canonical_model_part", Some(offset), Some(len)) if index >= 0 => {
                Ok(Self::CanonicalModelPart(
                    CanonicalModelPartSpan::from_metadata(sequence, offset, len)?,
                ))
            }
            _ => Err(invalid("invalid semantic payload source")),
        }
    }
}

#[derive(Debug)]
struct ReadAndCloseError {
    read: StoreError,
    close: rusqlite::Error,
}
impl std::fmt::Display for ReadAndCloseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}; closing canonical projection Blob also failed: {}",
            self.read, self.close
        )
    }
}
impl std::error::Error for ReadAndCloseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.read)
    }
}

#[cfg(test)]
mod logical_span_tests {
    use super::*;
    #[test]
    fn tools_use_logical_positions_while_model_parts_keep_physical_blob_bounds() {
        let offset = i64::from(i32::MAX) + 1;
        assert!(
            SemanticPayloadSource::from_metadata(
                1,
                0,
                "canonical_tool_projection",
                Some(offset),
                Some(32)
            )
            .is_ok()
        );
        assert!(
            SemanticPayloadSource::from_metadata(
                1,
                0,
                "canonical_model_part",
                Some(offset),
                Some(32)
            )
            .is_err()
        );
        assert!(CanonicalToolProjectionSpan::from_metadata(1, i64::MAX - 32, 32).is_ok());
        assert!(CanonicalToolProjectionSpan::from_metadata(1, i64::MAX - 31, 32).is_err());
    }
}
