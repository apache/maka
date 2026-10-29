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

//! The Bot is a mode of this Agent: one persistent Session per installation that
//! speaks to its user only through `SendUser`. Ordinary model output stays internal.
use super::*;

/// Open this installation's Bot Session, creating it on first use.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentBotOpen")]
pub struct BotOpen {
    pub workspace: WorkspaceSelection,
    #[serde(default)]
    #[schemars(length(min = 1))]
    pub title: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentBotOpened")]
pub enum BotOpened {
    /// `created` is false when the existing Bot Session was returned.
    Opened {
        session_id: String,
        created: bool,
    },
    Rejected {
        reason: BotRejection,
    },
}

#[derive(Serialize, Deserialize, JsonSchema, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentBotRejection")]
pub enum BotRejection {
    /// The Bot mode is not enabled for this Agent.
    Disabled,
    /// The Session could not be created; see the creation reason.
    CreationRejected,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentBotOutboxRead")]
pub struct BotOutboxRead {
    /// Return messages with a sequence greater than this cursor, oldest first.
    #[serde(default)]
    pub after: u64,
    /// Most messages to return, at most 100. Zero reads only the head
    /// (`sessionId` and `through`).
    #[serde(default = "default_limit")]
    #[schemars(range(max = 100))]
    pub limit: u32,
}
fn default_limit() -> u32 {
    100
}

/// One message the Bot deliberately sent to its user.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentBotMessage")]
pub struct BotMessage {
    /// Monotonic position in the outbox, starting at 1.
    pub sequence: u64,
    /// The model-chosen idempotency key of the `SendUser` call.
    pub message_id: String,
    /// Position of this message within its `SendUser` call.
    pub index: u32,
    pub text: String,
    /// Milliseconds since the Unix epoch when the message was recorded.
    pub at: i64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentBotOutbox")]
pub struct BotOutbox {
    pub enabled: bool,
    pub session_id: Option<String>,
    /// Highest sequence recorded so far; 0 when empty.
    pub through: u64,
    #[schemars(length(max = 100))]
    pub messages: Vec<BotMessage>,
    /// Pass as `after` to read the next page; absent when caught up.
    pub next_after: Option<u64>,
}
