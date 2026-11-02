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

//! Same-transaction typed metadata over the actual immutable payload encoding.
pub(super) mod codec;
mod scan;
use super::{captured, invalid};
use crate::StoreError;
use maka_agent_facts::history::{RowPosition, semantic::directory::RowDirectory};
use rusqlite::params;
use sqlx::sqlite::SqliteWorkerConnection;

pub(super) fn row(json: &str) -> Result<RowDirectory, StoreError> {
    scan::row(&mut json.as_bytes())
}

pub(super) fn prepare_fragment(
    worker: &mut SqliteWorkerConnection<'_>,
    key: RowPosition,
    source: super::source::SemanticPayloadSource,
) -> Result<
    (
        maka_agent_facts::history::semantic::directory::PayloadDirectory,
        u64,
    ),
    StoreError,
> {
    captured::with_raw(worker, |raw| {
        let root = match source {
            super::source::SemanticPayloadSource::Pieces => scan::PayloadRoot::Payload,
            super::source::SemanticPayloadSource::CanonicalToolProjection(_) => {
                scan::PayloadRoot::ToolProjection
            }
            super::source::SemanticPayloadSource::CanonicalModelPart(_) => {
                scan::PayloadRoot::ModelPart
            }
        };
        captured::with_fragment_reader(raw, key, source, |reader| {
            scan::payload(reader, root, |kind, ordinal, child| {
                raw.execute("INSERT INTO context_semantic_directory_children(source_sequence,source_index,list_kind,ordinal,directory_bytes) VALUES(?,?,?,?,?)",params![key.source_sequence as i64,key.item_index as i64,kind.as_str(),i64::try_from(ordinal).map_err(|_|invalid("directory ordinal exceeds SQLite range"))?,codec::encode(&child)?])?;
                Ok(())
            })
        })
    })
}
