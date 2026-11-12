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

use super::*;

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ComputerWatchStage")]
pub struct WatchStage {
    pub session_id: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ComputerStageSnapshot")]
pub struct StageSnapshot {
    pub session_id: String,
    pub binding_id: Option<String>,
    pub revision: u64,
    pub targets: Vec<StageTarget>,
    pub active_target_id: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ComputerStageTarget")]
pub struct StageTarget {
    pub id: String,
    pub revision: u64,
    pub title: String,
    pub kind: StageTargetKind,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "ComputerStageTargetKind")]
pub enum StageTargetKind {
    App,
    Browser,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ComputerWatchFrames")]
pub struct WatchFrames {
    pub session_id: String,
    pub binding_id: String,
    #[schemars(length(min = 1, max = 5))]
    pub target_ids: Vec<String>,
    pub selected_target_id: Option<String>,
}

/// Notifications are small. Encoded images stay in one replaceable slot per
/// target, never in the ordered Host subscription queue or durable history.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ComputerFrameNotice")]
pub struct FrameNotice {
    pub session_id: String,
    pub binding_id: String,
    pub feed_id: String,
    pub target_id: String,
    pub sequence: u64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ComputerReadFrame")]
pub struct ReadFrame {
    pub session_id: String,
    pub binding_id: String,
    pub feed_id: String,
    pub target_id: String,
    pub after: u64,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ComputerStageFrame")]
pub struct StageFrame {
    pub revision: u64,
    pub session_id: String,
    pub binding_id: String,
    pub target_id: String,
    pub sequence: u64,
    pub mime_type: String,
    pub data_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "ComputerFrameResult")]
pub enum FrameResult {
    Frame { frame: StageFrame },
    Pending,
    Unavailable { message: String },
}

pub(super) fn method<I: JsonSchema, O: JsonSchema>(
    name: &str,
    mode: MethodMode,
) -> (String, Method) {
    (
        name.into(),
        Method {
            mode,
            input: schemars::schema_for!(I).into(),
            output: schemars::schema_for!(O).into(),
            progress: None,
            resources: BTreeMap::new(),
        },
    )
}
