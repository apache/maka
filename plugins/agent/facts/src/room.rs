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

use crate::{durable::ExecutionIdentity, input::MessageInput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentRoomAuthor")]
pub enum RoomAuthor {
    Human,
    Session { execution: ExecutionIdentity },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentRoomActor")]
pub enum RoomActor {
    Human,
    Session { session_id: String },
}

impl RoomActor {
    pub fn storage_key(&self) -> String {
        match self {
            Self::Human => "human".to_owned(),
            Self::Session { session_id } => format!("session:{session_id}"),
        }
    }

    pub fn from_storage_key(key: &str) -> Self {
        if let Some(session_id) = key.strip_prefix("session:") {
            Self::Session {
                session_id: session_id.to_owned(),
            }
        } else {
            Self::Human
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RoomDelivery {
    Accepted {
        session_id: String,
        message_id: String,
    },
    Rejected {
        session_id: String,
        reason: String,
    },
}

impl RoomDelivery {
    pub fn session_id(&self) -> &str {
        match self {
            Self::Accepted { session_id, .. } | Self::Rejected { session_id, .. } => session_id,
        }
    }
}

/// Derived execution outcome for a Room mention delivery.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentRoomDeliveryState")]
pub enum RoomDeliveryState {
    Queued {
        session_id: String,
        message_id: String,
    },
    Working {
        session_id: String,
        message_id: String,
    },
    Waiting {
        session_id: String,
        message_id: String,
        pending_count: u32,
    },
    Replied {
        session_id: String,
        message_id: String,
        reply_message_id: String,
    },
    /// The mentioned Agent finished its run without posting a reply in the Room.
    Silent {
        session_id: String,
        message_id: String,
    },
    Failed {
        session_id: String,
        message_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Stopped {
        session_id: String,
        message_id: String,
    },
    Rejected {
        session_id: String,
        reason: String,
    },
}

impl RoomDeliveryState {
    pub fn session_id(&self) -> &str {
        match self {
            Self::Queued { session_id, .. }
            | Self::Working { session_id, .. }
            | Self::Waiting { session_id, .. }
            | Self::Replied { session_id, .. }
            | Self::Silent { session_id, .. }
            | Self::Failed { session_id, .. }
            | Self::Stopped { session_id, .. }
            | Self::Rejected { session_id, .. } => session_id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentRoomReaction")]
pub struct RoomReaction {
    pub emoji: String,
    pub actors: Vec<RoomActor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentRoomParticipantActivity")]
pub enum RoomParticipantActivity {
    Idle,
    Working,
    Waiting,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentRoomMember")]
pub struct RoomMember {
    pub session_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_name: Option<String>,
    pub workspace_path: String,
    pub activity: RoomParticipantActivity,
    #[serde(default)]
    pub pending_interactions: u32,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub unavailable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomMessage {
    pub id: String,
    pub sequence: u64,
    pub at: u64,
    pub author: RoomAuthor,
    pub content: MessageInput,
    pub reply_to: Option<String>,
    pub mentions: Vec<String>,
    pub deliveries: Vec<RoomDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reactions: Vec<RoomReaction>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delivery_states: Vec<RoomDeliveryState>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RoomPosition {
    Start,
    #[default]
    Tail,
    Before {
        message_id: String,
    },
    After {
        message_id: String,
    },
    Message {
        message_id: String,
    },
    Around {
        message_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomPage {
    pub items: Vec<RoomMessage>,
    pub through: u64,
    pub before: Option<String>,
    pub after: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub participants: Vec<RoomMember>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomState {
    pub session_id: String,
    pub topic: String,
    pub members: Vec<RoomMember>,
    pub pinned: Vec<RoomMessage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomSearchMatch {
    pub message: RoomMessage,
    pub snippet: String,
}
