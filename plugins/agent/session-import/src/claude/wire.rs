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

use crate::{Error, jsonl, transcript::Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Row<'a> {
    #[serde(rename = "type")]
    pub kind: Kind,
    pub uuid: Option<String>,
    pub parent_uuid: Option<String>,
    pub session_id: Option<String>,
    pub timestamp: Option<Timestamp>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub is_sidechain: bool,
    #[serde(default)]
    pub is_meta: bool,
    #[serde(default)]
    pub is_compact_summary: bool,
    #[serde(default)]
    pub is_api_error_message: bool,
    pub subtype: Option<Subtype>,
    pub custom_title: Option<String>,
    pub ai_title: Option<String>,
    pub last_prompt: Option<String>,
    pub summary: Option<String>,
    pub title: Option<String>,
    pub prompt: Option<String>,
    #[serde(borrow)]
    pub message: Option<&'a RawValue>,
}
impl Row<'_> {
    pub fn message(&self, line: &jsonl::Line<'_>) -> Result<Message, Error> {
        crate::jsonl::decode(
            self.message
                .ok_or(Error::Invalid("missing Claude message"))?,
            line.number,
        )
    }
    pub fn compacted(&self) -> bool {
        matches!(self.subtype, Some(Subtype::Compact))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
pub(super) enum Kind {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "assistant")]
    Assistant,
    #[serde(rename = "ai-title")]
    AiTitle,
    #[serde(rename = "last-prompt")]
    LastPrompt,
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
pub(super) enum Subtype {
    #[serde(rename = "compact_boundary")]
    Compact,
    #[serde(other)]
    Other,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Message {
    pub id: Option<String>,
    pub model: Option<String>,
    pub content: Content,
    pub stop_reason: Option<StopReason>,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
pub(super) enum StopReason {
    #[serde(rename = "end_turn")]
    EndTurn,
    #[serde(rename = "stop_sequence")]
    StopSequence,
    #[serde(rename = "max_tokens")]
    MaxTokens,
    #[serde(other)]
    Other,
}
#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub(super) enum Content {
    Text(String),
    Blocks(Vec<Block>),
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "type")]
pub(super) enum Block {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: Option<Value>,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: Value,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "document")]
    Document,
    #[serde(other)]
    Other,
}
impl Content {
    pub fn instructions(&self) -> bool {
        match self {
            Self::Text(text) => crate::synthetic::instructions(text),
            Self::Blocks(blocks) => {
                blocks
                    .iter()
                    .all(|block| matches!(block, Block::Text { .. }))
                    && crate::synthetic::instructions(&self.text())
            }
        }
    }
    pub fn has_results(&self) -> bool {
        matches!(self, Self::Blocks(blocks) if blocks.iter().any(|block| matches!(block, Block::ToolResult { .. })))
    }
    pub fn text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Blocks(blocks) => blocks
                .iter()
                .filter_map(|block| match block {
                    Block::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
    pub fn user_text(&self) -> String {
        let text = self.text();
        if !text.is_empty() {
            return text;
        }
        match self {
            Self::Blocks(blocks) if blocks.iter().any(|block| matches!(block, Block::Image)) => {
                "[Image]".into()
            }
            Self::Blocks(blocks) if blocks.iter().any(|block| matches!(block, Block::Document)) => {
                "[Document]".into()
            }
            _ => text,
        }
    }
}
pub(crate) fn synthetic(text: &str) -> bool {
    let text = text.trim_start();
    if text.starts_with("[Request interrupted by user") {
        return true;
    }
    let Some(tag) = text
        .strip_prefix('<')
        .map(|text| text.strip_prefix('/').unwrap_or(text))
    else {
        return false;
    };
    [
        "command-name",
        "command-message",
        "command-args",
        "command-contents",
        "local-command-stdout",
        "local-command-stderr",
        "bash-input",
        "bash-stdout",
        "bash-stderr",
    ]
    .iter()
    .any(|name| {
        tag.strip_prefix(name)
            .is_some_and(|tail| tail.starts_with('>') || tail.starts_with(char::is_whitespace))
    })
}
