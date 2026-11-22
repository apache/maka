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

//! Imported conversation is historical evidence, never local execution or usage.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    /// Adapter-owned identity, not a Host provider allowlist.
    pub adapter: String,
    pub session_id: String,
}

/// No provider options, tool dispatches, credentials or executable bindings can
/// enter this vocabulary. Source timestamps are claims, distinct from import time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub source_message_id: String,
    pub source_turn_id: String,
    pub timestamp: Option<u64>,
    pub content: Content,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Content {
    User {
        text: String,
    },
    Assistant {
        text: String,
        model: Option<String>,
        thinking: Option<String>,
    },
    /// Foreign tool activity remains an observation, not a replayable tool call.
    ToolCall {
        /// Adapter-normalized occurrence key, unique among ToolCall records in
        /// the complete imported Session. Normalize reused foreign IDs first.
        call_id: String,
        name: String,
        input: Option<serde_json::Value>,
    },
    ToolResult {
        /// Refers to the normalized call occurrence when present; unmatched
        /// result keys are allowed.
        call_id: String,
        output: serde_json::Value,
        is_error: bool,
    },
    Note {
        text: String,
    },
}

impl Source {
    pub fn validate(&self) -> Result<(), &'static str> {
        for value in [&self.adapter, &self.session_id] {
            if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
                return Err("invalid imported source identity");
            }
        }
        Ok(())
    }
}

impl Record {
    pub fn validate(&self) -> Result<(), &'static str> {
        for value in [&self.source_message_id, &self.source_turn_id] {
            if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
                return Err("invalid imported message identity");
            }
        }
        if self.timestamp.is_some_and(|ts| ts > 9_007_199_254_740_991) {
            return Err("invalid imported timestamp");
        }
        if let Content::ToolCall { call_id, .. } | Content::ToolResult { call_id, .. } =
            &self.content
            && (call_id.is_empty() || call_id.len() > 1024 || call_id.chars().any(char::is_control))
        {
            return Err("invalid imported tool identity");
        }
        Ok(())
    }

    pub fn is_conversation(&self) -> bool {
        match &self.content {
            Content::User { text } | Content::Assistant { text, .. } => !text.trim().is_empty(),
            Content::ToolCall { .. } | Content::ToolResult { .. } | Content::Note { .. } => false,
        }
    }
}

/// An adapter normalizes foreign call keys within the source Session. Copies
/// retain the original canonical Session identity, so their links stay stable.
pub fn tool_call_id(session_id: &str, call_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for part in [session_id, call_id] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("import-tool:{}", hex::encode(hash.finalize()))
}
