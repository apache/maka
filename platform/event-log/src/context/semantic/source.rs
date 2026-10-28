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
use maka_agent_facts::{history::semantic::Payload, tool_output::DurableToolProjection};
use serde::Deserialize;
use serde_json::value::RawValue;
use sqlx::sqlite::SqliteWorkerConnection;
use std::io::{BufReader, Read, Seek, SeekFrom};

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
        let end = offset
            .checked_add(projection.len())
            .filter(|end| *end <= json.len())
            .ok_or_else(|| invalid("canonical projection is outside its event"))?;
        i32::try_from(end)
            .map_err(|_| invalid("canonical projection exceeds SQLite Blob range"))?;
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
        if sequence <= 0
            || offset < 0
            || len <= 0
            || offset
                .checked_add(len)
                .is_none_or(|end| end > i64::from(i32::MAX))
        {
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

    pub(super) fn read(
        self,
        worker: &mut SqliteWorkerConnection<'_>,
    ) -> Result<Payload, StoreError> {
        // SAFETY: the original SQLite worker is exclusively borrowed. The wrapper
        // is non-owning, and it and the Blob are dropped before this callback returns.
        let borrowed =
            unsafe { rusqlite::Connection::from_handle(worker.as_raw_handle().as_ptr()) }?;
        let mut blob = borrowed.blob_open(
            "main",
            "event_log",
            "event_json",
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
            let projection: DurableToolProjection = serde_json::from_reader(reader)?;
            Ok(Payload::Tool(projection))
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
