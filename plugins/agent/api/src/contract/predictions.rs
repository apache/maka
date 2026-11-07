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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentPredictionTrigger")]
pub enum PredictionTrigger {
    Live,
    CatchUp,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPredictNextMessage")]
pub struct PredictNextMessage {
    pub session_id: String,
    pub expected_turn_id: String,
    pub trigger: PredictionTrigger,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMessagePrediction")]
pub struct MessagePrediction {
    pub source_turn_id: String,
    pub policy_revision: u64,
    pub suggestion: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentQuickToolRank")]
pub struct QuickToolRank {
    pub session_id: String,
    pub query: String,
    pub candidates: Vec<QuickToolCandidate>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentQuickToolCandidate")]
pub struct QuickToolCandidate { pub id:String, pub name:String, pub kind:String, pub uses:u32 }
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentQuickToolRanking")]
pub struct QuickToolRanking { pub source:String, pub ids:Vec<String> }
