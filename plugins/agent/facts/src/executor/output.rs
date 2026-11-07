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

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// External tool activity is observation, never a request to dispatch a Host tool.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "ExecutorOutput")]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Output {
    MessageStart {
        message_id: String,
    },
    OutputDelta {
        message_id: String,
        text: String,
    },
    ThinkingDelta {
        message_id: String,
        text: String,
    },
    MessageEnd {
        message_id: String,
    },
    ToolStart {
        tool_call_id: String,
        name: String,
        input: Value,
    },
    ToolProgress {
        tool_call_id: String,
        text: String,
    },
    ToolResult {
        tool_call_id: String,
        text: String,
        #[serde(default)]
        is_error: bool,
    },
}

impl Output {
    pub fn validate(&self) -> Result<(), &'static str> {
        let (id, text) = match self {
            Self::MessageStart { message_id } | Self::MessageEnd { message_id } => {
                (Some(message_id), None)
            }
            Self::OutputDelta { message_id, text } | Self::ThinkingDelta { message_id, text } => {
                (Some(message_id), Some(text))
            }
            Self::ToolStart {
                tool_call_id,
                name,
                input: _,
            } => {
                opaque(name)?;
                (Some(tool_call_id), None)
            }
            Self::ToolProgress { tool_call_id, text }
            | Self::ToolResult {
                tool_call_id, text, ..
            } => (Some(tool_call_id), Some(text)),
        };
        if let Some(id) = id {
            opaque(id)?;
        }
        if text.is_some_and(|text| text.contains('\0')) {
            return Err("invalid executor text");
        }
        Ok(())
    }
}

fn opaque(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err("invalid executor activity identity");
    }
    Ok(())
}
