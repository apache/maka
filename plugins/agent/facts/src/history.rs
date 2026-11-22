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

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Disposable presentation locator, never authority or a canonical execution fact.
/// The source is the original emitting fact; the index precedes UI filtering.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "HistoryRowPosition")]
pub struct RowPosition {
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub source_sequence: u64,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub item_index: u64,
}

impl RowPosition {
    pub fn validate(&self) -> Result<(), &'static str> {
        const MAX: u64 = 9_007_199_254_740_991;
        if self.source_sequence == 0 || self.source_sequence > MAX || self.item_index > MAX {
            return Err("invalid history row position");
        }
        Ok(())
    }
}

/// An original row within the actual read capability supplied by the caller.
/// Marker paths are relative to that capability; none of these fields grants access.
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HistoryRowAddress {
    Live {
        sequence: u64,
        fact: crate::durable::FactId,
        item_index: u64,
    },
    Snapshot {
        path: Vec<crate::durable::RunId>,
        #[schemars(with = "uuid::Uuid")]
        snapshot: crate::history_snapshot::SnapshotId,
        sequence: u64,
        fact: crate::durable::FactId,
        item_index: u64,
    },
    Imported {
        path: Vec<crate::durable::RunId>,
        #[schemars(with = "uuid::Uuid")]
        snapshot: crate::history_snapshot::SnapshotId,
        message_ordinal: u64,
        part_ordinal: u64,
    },
}
impl HistoryRowAddress {
    pub fn validate(&self) -> Result<(), &'static str> {
        const MAX: u64 = 9_007_199_254_740_991;
        match self {
            Self::Live {
                sequence,
                item_index,
                ..
            }
            | Self::Snapshot {
                sequence,
                item_index,
                ..
            } if *sequence > 0 && *sequence <= MAX && *item_index <= MAX => Ok(()),
            Self::Imported {
                message_ordinal,
                part_ordinal,
                ..
            } if *message_ordinal <= MAX && *part_ordinal <= MAX => Ok(()),
            _ => Err("invalid history source address"),
        }
    }
    pub fn with_item_index(&self, index: u64) -> Self {
        let mut address = self.clone();
        match &mut address {
            Self::Live { item_index, .. } | Self::Snapshot { item_index, .. } => {
                *item_index = index
            }
            Self::Imported { part_ordinal, .. } => *part_ordinal = index,
        }
        address
    }
    pub fn path(&self) -> &[crate::durable::RunId] {
        match self {
            Self::Live { .. } => &[],
            Self::Snapshot { path, .. } | Self::Imported { path, .. } => path,
        }
    }
}

/// Lexicographic tree order: original marker sequences followed by the leaf
/// sequence/ordinal. This is presentation order, never a fabricated Root sequence.
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryOrder {
    pub path: Vec<u64>,
    pub item_index: u64,
}

/// Incremental, policy-independent model-history interpretation.
pub mod semantic;

pub mod media;
