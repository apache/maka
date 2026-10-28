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

//! Native protocol events. The host projects these into its own event types;
//! serialization conventions of any external validation harness stay outside.
use crate::{Error, input::Extensions};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextKind {
    Text,
    Reasoning,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningField {
    Content,
    Reasoning,
}
impl ReasoningField {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Content => "reasoning_content",
            Self::Reasoning => "reasoning",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    Interrupted,
    Error,
    Other,
}
#[derive(Debug, Clone)]
pub struct Finish {
    pub reason: Stop,
    pub raw_reason: Option<String>,
    pub usage: Option<Usage>,
    pub extensions: Extensions,
}
#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub input: Option<u64>,
    pub uncached_input: Option<i128>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
    pub output: Option<u64>,
    pub reasoning: Option<u64>,
    pub text: Option<i128>,
    pub raw: Option<Value>,
}
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: String,
    pub provider_executed: bool,
    pub dynamic: bool,
    pub extensions: Extensions,
}
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub id: String,
    pub name: String,
    pub value: Value,
    pub is_error: bool,
    pub dynamic: bool,
    pub extensions: Extensions,
}
#[derive(Debug, Clone)]
pub enum Source {
    Url {
        id: String,
        url: String,
        title: Option<String>,
        extensions: Extensions,
    },
    Document {
        id: String,
        media_type: String,
        title: String,
        filename: Option<String>,
        extensions: Extensions,
    },
}
#[derive(Debug, Clone)]
pub struct Citation {
    pub source: Source,
    pub text: String,
}
#[derive(Debug, Clone)]
pub struct ProviderError {
    pub message: Option<String>,
    pub kind: Option<String>,
    pub code: Option<Value>,
    pub status: Option<u16>,
    pub retryable: Option<bool>,
    pub data: Value,
}
#[derive(Debug, Clone)]
pub enum Event {
    Raw(Value),
    Response {
        id: Option<String>,
        model: Option<String>,
        created_at_unix_seconds: Option<f64>,
    },
    TextStart {
        id: String,
        kind: TextKind,
        extensions: Extensions,
    },
    TextDelta {
        reasoning_field: Option<ReasoningField>,
        id: String,
        kind: TextKind,
        text: String,
        extensions: Extensions,
    },
    TextEnd {
        id: String,
        kind: TextKind,
        citations: Vec<Citation>,
        extensions: Extensions,
    },
    ToolStart {
        id: String,
        name: String,
        provider_executed: bool,
        dynamic: bool,
        extensions: Extensions,
    },
    ToolDelta {
        id: String,
        text: String,
    },
    ToolEnd {
        id: String,
    },
    ToolCall(ToolCall),
    ToolResult(ToolResult),
    Source(Source),
    Custom {
        kind: String,
        extensions: Extensions,
    },
    Finish(Finish),
    Error(Error),
    ProviderError(ProviderError),
}
#[derive(Debug)]
pub enum Part {
    Text {
        kind: TextKind,
        text: String,
        citations: Vec<Citation>,
        extensions: Extensions,
    },
    ToolCall(ToolCall),
    ToolResult(ToolResult),
    Source(Source),
    Custom {
        kind: String,
        extensions: Extensions,
    },
}
#[derive(Debug)]
pub struct Response {
    pub id: Option<String>,
    pub created_at_unix_seconds: Option<f64>,
    pub model: Option<String>,
    pub parts: Vec<Part>,
    pub finish: Finish,
    pub raw: Value,
}
