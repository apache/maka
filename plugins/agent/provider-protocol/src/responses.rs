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

//! Pure Responses request encoding and incremental output decoding.
pub mod decode;
pub mod replay;
pub mod request;
pub mod sse;

use crate::output::{Stop, TextKind, Usage};
pub use replay::Replay;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningMode {
    Encrypted,
    PlaintextContent,
    PlaintextSummary,
}
impl ReasoningMode {
    pub fn is_plaintext(self) -> bool {
        self != Self::Encrypted
    }
}

#[derive(Debug, Clone)]
pub struct ItemMetadata {
    pub id: String,
    pub replay: Option<Replay>,
    pub encrypted_content: Option<String>,
}
#[derive(Debug, Clone)]
pub enum PartMetadata {
    Item(ItemMetadata),
    PlaintextSummary {
        item_id: String,
        summary_part_lengths: Vec<usize>,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolInput {
    Function(String),
    Custom(String),
}
#[derive(Debug, Clone)]
pub struct Citation {
    pub id: String,
    pub url: String,
    pub title: Option<String>,
    pub start_index: Option<u64>,
    pub end_index: Option<u64>,
}
#[derive(Debug, Clone)]
pub enum Event {
    ResponseMetadata {
        id: Option<String>,
        model: Option<String>,
        created_at_unix_seconds: Option<f64>,
    },
    PartStarted {
        id: String,
        kind: TextKind,
    },
    PartDelta {
        id: String,
        text: String,
        summary_breaks: Option<Vec<usize>>,
    },
    PartFinished {
        id: String,
        metadata: Option<PartMetadata>,
    },
    ToolInputStarted {
        id: String,
        name: String,
    },
    ToolInputDelta {
        id: String,
        text: String,
    },
    ToolInputFinished {
        id: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: ToolInput,
        provider_executed: bool,
        metadata: ItemMetadata,
    },
    ToolResult {
        id: String,
        name: String,
        action: Value,
        is_error: bool,
        metadata: ItemMetadata,
    },
    Citation(Citation),
    Finished {
        reason: Stop,
        usage: Usage,
        response_id: Option<String>,
    },
}

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub enum Error {
    Invalid(String),
    Truncated {
        replay_safe: bool,
        retained_output_safe: bool,
    },
    Provider {
        error: Box<crate::output::ProviderError>,
        observed_output: bool,
        replay_safe: bool,
        retained_output_safe: bool,
    },
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::Truncated { .. } => f.write_str("Responses stream ended without completion"),
            Self::Provider { error, .. } => write!(
                f,
                "Responses provider failed: {}",
                error.message.as_deref().unwrap_or("provider error")
            ),
        }
    }
}
impl std::error::Error for Error {}
