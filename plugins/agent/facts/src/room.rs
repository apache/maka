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
pub enum RoomAuthor {
    Human,
    Session { execution: ExecutionIdentity },
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
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomPage {
    pub items: Vec<RoomMessage>,
    pub through: u64,
    pub before: Option<String>,
    pub after: Option<String>,
}
