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
pub type RecallQuery = maka_assistant::recall::search::Query;
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentRecallPage")]
pub struct RecallPage {
    pub titles: Vec<Session>,
    pub passages: Vec<RecallPassage>,
    pub complete: bool,
    pub gaps: Vec<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentRecallPassage")]
pub struct RecallPassage {
    pub session: Session,
    pub anchor_message_id: String,
    pub anchor_position: RowPosition,
    /// Match-centered display preview. The anchor retains access to the complete source.
    pub excerpt: String,
    /// Highlight ranges in UTF-16 code units within `excerpt`.
    pub highlights: Vec<RecallHighlight>,
    pub matched_terms: Vec<String>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentRecallHighlight")]
pub struct RecallHighlight {
    pub start: usize,
    pub end: usize,
}
