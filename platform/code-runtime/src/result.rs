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

use maka_agent_facts::tools::{NativeToolError, ToolError};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum CellAbort {
    #[error(transparent)]
    Tool(#[from] ToolError),
    #[error("cell cancelled")]
    Cancelled,
    #[error("cell executor failed: {0}")]
    Internal(String),
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CellDiagnosticKind {
    ParseError,
    ExecutionError,
    UnknownTool,
    LimitExceeded,
    ToolFailure,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CellDiagnostic {
    pub kind: CellDiagnosticKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native: Option<Box<NativeToolError>>,
}

impl CellDiagnostic {
    pub fn new(kind: CellDiagnosticKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            native: None,
        }
    }
    pub fn limit(message: impl Into<String>) -> Self {
        Self::new(CellDiagnosticKind::LimitExceeded, message)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ToolCall {
    pub index: usize,
    pub name: String,
}

#[derive(Debug)]
pub enum CellResult {
    Success {
        value: Value,
        tool_calls: Vec<ToolCall>,
    },
    Failure {
        error: CellDiagnostic,
        tool_calls: Vec<ToolCall>,
    },
}

impl Serialize for CellResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("CellResult", 3)?;
        match self {
            Self::Success { value, tool_calls } => {
                state.serialize_field("ok", &true)?;
                state.serialize_field("value", value)?;
                state.serialize_field("toolCalls", tool_calls)?;
            }
            Self::Failure { error, tool_calls } => {
                state.serialize_field("ok", &false)?;
                state.serialize_field("error", error)?;
                state.serialize_field("toolCalls", tool_calls)?;
            }
        }
        state.end()
    }
}

pub fn complete(result: Result<Value, CellDiagnostic>, calls: Vec<ToolCall>) -> CellResult {
    match result {
        Ok(value) => CellResult::Success {
            value,
            tool_calls: calls,
        },
        Err(error) => CellResult::Failure {
            error,
            tool_calls: calls,
        },
    }
}
