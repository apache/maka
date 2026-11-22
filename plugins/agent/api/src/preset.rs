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

//! Persistent Agent-scoped role configuration. Execution is a separate operation.
use crate::ModelSelection;
use maka_agent_facts::execution::ThinkingLevel;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct PresetId(pub uuid::Uuid);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct PresetRevision(#[schemars(range(min = 1, max = 9007199254740991_u64))] pub u64);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preset {
    pub id: PresetId,
    pub revision: PresetRevision,
    pub name: String,
    pub description: String,
    pub instruction: String,
    pub model: ModelSelection,
    pub thinking_level: Option<ThinkingLevel>,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PresetAvailability {
    Available,
    Disabled,
    ModelUnavailable,
    ThinkingLevelUnavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetSummary {
    pub id: PresetId,
    pub revision: PresetRevision,
    pub name: String,
    pub description: String,
    pub model: ModelSelection,
    pub thinking_level: Option<ThinkingLevel>,
    pub enabled: bool,
    pub availability: PresetAvailability,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PresetsRead {}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PresetRead {
    pub id: PresetId,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PresetDetail {
    pub preset: Preset,
    pub availability: PresetAvailability,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetCreate {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub instruction: String,
    pub model: ModelSelection,
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(default = "enabled")]
    pub enabled: bool,
}
fn enabled() -> bool {
    true
}

/// Omission preserves the setting; Default explicitly clears it.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PresetThinkingChange {
    Default,
    Set { value: ThinkingLevel },
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetUpdate {
    pub id: PresetId,
    pub expected_revision: PresetRevision,
    pub name: Option<String>,
    pub description: Option<String>,
    pub instruction: Option<String>,
    pub model: Option<ModelSelection>,
    pub thinking_level: Option<PresetThinkingChange>,
    pub enabled: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetDelete {
    pub id: PresetId,
    pub expected_revision: PresetRevision,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PresetResult {
    Saved { preset: Preset },
    Deleted { id: PresetId },
    NotFound,
    Conflict { actual: PresetRevision },
    NameConflict,
    InvalidInput { field: String },
    ModelUnavailable,
    ThinkingLevelUnavailable,
}

/// Immutable execution configuration captured when a session is created.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedPreset {
    pub id: PresetId,
    pub revision: PresetRevision,
    pub name: String,
    pub instruction: String,
    pub model: ModelSelection,
    pub thinking_level: Option<ThinkingLevel>,
}
