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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct MemoryId(pub uuid::Uuid);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct MemoryRevision(pub u64);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryMode {
    AutoRecall,
    UserRecall,
    UserAlways,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryState {
    Active,
    Unresolved,
    Suppressed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MemorySource {
    UserOperation {
        operation_id: uuid::Uuid,
        observed_at: i64,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryRecord {
    pub id: MemoryId,
    pub revision: MemoryRevision,
    pub mode: MemoryMode,
    pub state: MemoryState,
    pub body: String,
    pub created_at: i64,
    pub modified_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryVersion {
    pub revision: MemoryRevision,
    pub body: String,
    pub source: MemorySource,
    pub corrects: Option<MemoryRevision>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MemoryEdit {
    Create {
        body: String,
    },
    Correct {
        id: MemoryId,
        expected_revision: MemoryRevision,
        body: String,
    },
    SetAlways {
        id: MemoryId,
        expected_revision: MemoryRevision,
        always: bool,
    },
    Delete {
        id: MemoryId,
        expected_revision: MemoryRevision,
    },
    Restore {
        id: MemoryId,
        expected_revision: MemoryRevision,
        body: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MemoryResult {
    Saved {
        id: MemoryId,
        revision: MemoryRevision,
    },
    Deleted {
        id: MemoryId,
        revision: MemoryRevision,
    },
    Conflict {
        actual: MemoryRevision,
    },
    NotFound,
    InvalidState,
}
