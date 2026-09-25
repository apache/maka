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

use crate::attachment::StorageRef;
use crate::capability::CallResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod audio;
mod durable;
mod mcp;
mod media;
pub(crate) use durable::encode_raw_tool_result;
pub use durable::{
    DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE, DurableToolProjection, MAX_RAW_TOOL_RESULT_BYTES,
    MAX_RAW_TOOL_RESULT_JSON_DEPTH, ProjectionPart, RawToolResultRef, decode_raw_tool_result,
};
pub use media::{ToolContent, ToolSuccess};

/// Live successful output. Durable evidence and projection are encoded separately.
/// JSON with MCP-looking fields is still JSON unless its executor says otherwise.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "format", content = "value", rename_all = "snake_case")]
pub enum ToolOutput {
    Model(Box<crate::model::ModelGeneration>),
    Json(Value),
    Mcp(CallResult),
    Image(ImageOutput),
    Text(String),
}

/// Host-issued image evidence keeps bytes out of the canonical execution log.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageOutput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<ImageDetail>,
    pub mime_type: String,
    #[serde(rename = "ref")]
    pub reference: StorageRef,
}

/// Immutable audio evidence; byte materialization belongs to the model request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioOutput {
    pub mime_type: String,
    #[serde(rename = "ref")]
    pub reference: StorageRef,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageDetail {
    Auto,
    Low,
    High,
    Original,
}

impl ImageOutput {
    fn to_json(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("image evidence is JSON");
        value["kind"] = Value::String("image".into());
        value
    }
}

impl From<Value> for ToolOutput {
    fn from(value: Value) -> Self {
        Self::Json(value)
    }
}

impl ToolOutput {
    /// JavaScript and presentation see the original result, not model clipping.
    pub fn into_json(self) -> Value {
        match self {
            Self::Model(result) => serde_json::to_value(result).expect("typed model result"),
            Self::Json(value) => value,
            Self::Mcp(result) => {
                serde_json::to_value(result).expect("MCP evidence contains only JSON values")
            }
            Self::Image(result) => result.to_json(),
            Self::Text(text) => serde_json::json!({"kind":"text","text":text}),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Model(result) => serde_json::to_value(result).expect("typed model result"),
            Self::Json(value) => value.clone(),
            Self::Mcp(result) => {
                serde_json::to_value(result).expect("MCP evidence contains only JSON values")
            }
            Self::Image(result) => result.to_json(),
            Self::Text(text) => serde_json::json!({"kind":"text","text":text}),
        }
    }
}
