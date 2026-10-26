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

/// Incremental, policy-independent model-history interpretation.
pub mod semantic;

pub mod media;
