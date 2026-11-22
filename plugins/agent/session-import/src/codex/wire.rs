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

use crate::{Error, transcript::Timestamp};
use serde::Deserialize;
use serde_json::{Value, value::RawValue};

pub(super) fn decode<'a, T: Deserialize<'a>>(value: &'a RawValue, line: u64) -> Result<T, Error> {
    crate::jsonl::decode(value, line)
}
#[derive(Deserialize)]
pub(super) struct Envelope<'a> {
    #[serde(rename = "type")]
    pub kind: Kind,
    pub timestamp: Option<Timestamp>,
    #[serde(borrow)]
    pub payload: Option<&'a RawValue>,
}
#[derive(Deserialize)]
pub(super) enum Kind {
    #[serde(rename = "session_meta")]
    SessionMeta,
    #[serde(rename = "turn_context")]
    TurnContext,
    #[serde(rename = "event_msg")]
    Event,
    #[serde(rename = "response_item")]
    Response,
    #[serde(rename = "compacted")]
    Compacted,
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
pub(super) struct Meta {
    pub id: Option<String>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
}
#[derive(Deserialize)]
pub(super) struct Turn {
    pub turn_id: Option<String>,
    pub model: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "type")]
pub(super) enum Event {
    #[serde(rename = "task_started", alias = "turn_started")]
    Started { turn_id: Option<String> },
    #[serde(rename = "item_completed")]
    CompletedItem { turn_id: Option<String>, item: Item },
    #[serde(rename = "user_message")]
    User(User),
    #[serde(rename = "agent_message")]
    Agent { message: String },
    #[serde(rename = "agent_reasoning")]
    Reasoning { text: String },
    #[serde(rename = "agent_reasoning_raw_content")]
    RawReasoning { text: String },
    #[serde(rename = "thread_rolled_back")]
    RolledBack { num_turns: u64 },
    #[serde(rename = "context_compacted")]
    Compacted,
    #[serde(rename = "error")]
    Error { message: Option<String> },
    #[serde(rename = "task_complete", alias = "turn_complete")]
    Finished {
        turn_id: Option<String>,
        error: Option<Value>,
    },
    #[serde(rename = "turn_aborted")]
    Aborted {
        turn_id: Option<String>,
        reason: Option<String>,
    },
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
pub(super) struct Compacted {
    pub message: Option<String>,
}
#[derive(Deserialize)]
pub(super) struct Item {
    #[serde(rename = "type")]
    pub kind: ItemKind,
    pub id: Option<String>,
    pub client_id: Option<String>,
    pub content: Option<Content>,
    pub summary_text: Option<Summary>,
    pub raw_content: Option<Vec<String>>,
    pub text: Option<String>,
}
#[derive(Deserialize)]
pub(super) enum ItemKind {
    #[serde(rename = "Plan", alias = "plan")]
    Plan,
    #[serde(rename = "UserMessage", alias = "usermessage", alias = "user_message")]
    User,
    #[serde(
        rename = "AgentMessage",
        alias = "agentmessage",
        alias = "agent_message"
    )]
    Agent,
    #[serde(rename = "Reasoning", alias = "reasoning")]
    Reasoning,
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum Content {
    Text(String),
    Parts(Vec<Part>),
}
impl Content {
    pub fn text(self) -> String {
        match self {
            Self::Text(text) => text,
            Self::Parts(parts) => parts
                .into_iter()
                .filter_map(|part| match part {
                    Part::Text { text } => Some(text),
                    _ => None,
                })
                .collect(),
        }
    }
    pub fn user_text(self) -> String {
        match self {
            Self::Text(text) => text,
            Self::Parts(parts) => {
                let mut text = String::new();
                let mut image = false;
                let mut audio = false;
                for part in parts {
                    match part {
                        Part::Text { text: value } => text.push_str(&value),
                        Part::Image => image = true,
                        Part::Audio => audio = true,
                        Part::Other => {}
                    }
                }
                if text.is_empty() {
                    if image {
                        text.push_str("[Image]");
                    }
                    if audio {
                        text.push_str("[Audio]");
                    }
                }
                text
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "type")]
pub(super) enum Part {
    #[serde(
        rename = "text",
        alias = "input_text",
        alias = "output_text",
        alias = "Text"
    )]
    Text { text: String },
    #[serde(
        rename = "image",
        alias = "input_image",
        alias = "Image",
        alias = "local_image",
        alias = "LocalImage"
    )]
    Image,
    #[serde(rename = "audio", alias = "input_audio", alias = "Audio")]
    Audio,
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum Summary {
    Text(String),
    Parts(Vec<Fragment>),
}
#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum Fragment {
    Text(String),
    Part { text: String },
}
impl Summary {
    pub fn text(self) -> String {
        match self {
            Self::Text(text) => text,
            Self::Parts(parts) => parts
                .into_iter()
                .map(|part| match part {
                    Fragment::Text(text) | Fragment::Part { text } => text,
                })
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}
#[derive(Deserialize)]
pub(super) struct User {
    pub client_id: Option<String>,
    pub message: Option<String>,
    images: Option<Vec<serde::de::IgnoredAny>>,
    local_images: Option<Vec<serde::de::IgnoredAny>>,
    audio: Option<Vec<serde::de::IgnoredAny>>,
    local_audio: Option<Vec<serde::de::IgnoredAny>>,
}
impl User {
    pub fn text(self) -> String {
        if let Some(message) = self.message.filter(|value| !value.is_empty()) {
            return message;
        }
        let mut text = String::new();
        if self.images.is_some_and(|values| !values.is_empty())
            || self.local_images.is_some_and(|values| !values.is_empty())
        {
            text.push_str("[Image]");
        }
        if self.audio.is_some_and(|values| !values.is_empty())
            || self.local_audio.is_some_and(|values| !values.is_empty())
        {
            text.push_str("[Audio]");
        }
        text
    }
}
#[derive(Deserialize)]
#[serde(tag = "type")]
pub(super) enum Response {
    #[serde(rename = "function_call")]
    Function {
        call_id: String,
        name: String,
        namespace: Option<String>,
        arguments: Option<String>,
    },
    #[serde(rename = "custom_tool_call")]
    Custom {
        call_id: String,
        name: String,
        namespace: Option<String>,
        input: Option<String>,
    },
    #[serde(rename = "function_call_output", alias = "custom_tool_call_output")]
    Output {
        call_id: String,
        output: Value,
        id: Option<String>,
    },
    #[serde(other)]
    Other,
}
