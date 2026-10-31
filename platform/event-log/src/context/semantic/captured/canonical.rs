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

//! Callback-local source metadata uses the original worker's statement cache.
use super::{Backing, RawConnection, RowPosition, StoreError, invalid, with_blob};
use crate::canonical::SpanMetadata;
use sqlx::{Row, sqlite::SqliteWorkerConnection};
use std::io::Read;

pub(super) struct CanonicalRead {
    key: RowPosition,
    offset: u64,
    bytes: u64,
    material: Option<SpanMetadata>,
}
impl CanonicalRead {
    pub(super) async fn load(
        worker: &mut SqliteWorkerConnection<'_>,
        backing: &Backing,
    ) -> Result<Option<Self>, StoreError> {
        let Backing::Canonical { key, offset, bytes } = *backing else {
            return Ok(None);
        };
        let query = format!("SELECT f.storage_kind,f.byte_offset,f.byte_len,{} FROM context_semantic_fragments f
            LEFT JOIN event_log e ON e.sequence=f.source_sequence AND f.storage_kind='canonical_tool_projection' {}
            WHERE f.source_sequence=? AND f.source_index=?", crate::canonical::SPAN_COLUMNS, crate::canonical::JOINS);
        let row = sqlx::query(sqlx::AssertSqlSafe(query))
            .bind(key.source_sequence as i64)
            .bind(key.item_index as i64)
            .fetch_one(&mut *worker)
            .await?;
        let source = super::super::source::SemanticPayloadSource::from_metadata(
            key.source_sequence as i64,
            key.item_index as i64,
            row.try_get("storage_kind")?,
            row.try_get("byte_offset")?,
            row.try_get("byte_len")?,
        )?;
        let (actual, length, model) = match source {
            super::super::source::SemanticPayloadSource::CanonicalToolProjection(span) => {
                (span.offset(), span.len(), false)
            }
            super::super::source::SemanticPayloadSource::CanonicalModelPart(span) => {
                (span.offset(), span.len(), true)
            }
            super::super::source::SemanticPayloadSource::Pieces => {
                return Err(invalid("captured canonical source changed"));
            }
        };
        if actual as u64 != offset || length as u64 != bytes {
            return Err(invalid("captured canonical source changed"));
        }
        Ok(Some(Self {
            key,
            offset,
            bytes,
            material: if model {
                None
            } else {
                Some(SpanMetadata::from_row(&row)?)
            },
        }))
    }
    pub(super) fn with_range<T>(
        &self,
        raw: &RawConnection,
        start: u64,
        count: u64,
        consume: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        if start.checked_add(count).is_none_or(|end| end > self.bytes) {
            return Err(invalid("canonical range exceeds captured span"));
        }
        let position = self
            .offset
            .checked_add(start)
            .ok_or_else(|| invalid("canonical span offset overflows"))?;
        match self.material {
            Some(material) => crate::canonical::with_span_metadata(
                raw,
                self.key.source_sequence as i64,
                material,
                position,
                count,
                consume,
            ),
            None => with_blob(
                raw,
                "event_log",
                "event_header",
                self.key.source_sequence as i64,
                position,
                count,
                consume,
            ),
        }
    }
}
