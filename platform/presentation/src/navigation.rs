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

//! Small transcript navigation projections. No model history or mutable Turn state.
use maka_agent_facts::{history::RowPosition, message::MessageOrigin};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnLandmark {
    pub turn_id: String,
    pub position: RowPosition,
    pub last_position: RowPosition,
    pub label: String,
    /// The Host's attribution of the Turn's opening message, when it generated it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<MessageOrigin>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnContribution {
    pub turn_id: String,
    pub first_position: RowPosition,
    pub latest_state: Option<RecordedTurnState>,
    pub user_prompt_preview: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordedTurnState {
    pub position: RowPosition,
    pub message: TurnStateMessage,
}

/// The client presentation vocabulary is wider than the runtime's terminal outcome.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnStateMessage {
    #[serde(rename = "type")]
    pub kind: TurnStateKind,
    pub id: String,
    pub turn_id: String,
    pub ts: f64,
    pub status: TurnStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retried_from_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regenerated_from_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_of_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aborted_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abort_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryDecision>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStateKind {
    TurnState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Running,
    Completed,
    Aborted,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case", deny_unknown_fields)]
pub enum RetryDecision {
    Exhausted { attempts: u64 },
    Declined { because: RetryDeclined },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryDeclined {
    SideEffects,
    ObservableOutput,
    Policy,
    Budget,
}

/// Same UTF-8 prefix as the wire projector, without adding an ellipsis.
pub fn truncate(text: &str, bytes: usize) -> &str {
    &text[..text.floor_char_boundary(bytes.min(text.len()))]
}

pub fn prompt_preview(text: &str, bytes: usize) -> &str {
    truncate(
        text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'),
        bytes,
    )
}
