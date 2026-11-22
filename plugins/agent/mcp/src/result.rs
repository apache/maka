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

use maka_agent_facts::{
    capability::ContentBlock,
    tool_output::{ToolContent, ToolOutput, ToolSuccess},
};
use serde_json::Value;

/// Keep the complete protocol result as durable evidence and the Code Mode value.
/// Native text/media projection never fetches external resource links.
pub(crate) fn project(result: rmcp::model::CallToolResult) -> ToolSuccess {
    let raw = serde_json::to_value(result).expect("MCP result is JSON");
    let mut parts = Vec::new();
    let is_error = raw.get("isError").and_then(Value::as_bool) == Some(true);
    if is_error {
        parts.push(ToolContent::Text(
            "MCP tool reported an error (isError: true).".into(),
        ));
    }
    for block in raw
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let string = |key: &str| block.get(key).and_then(Value::as_str);
        let media = match (string("type"), string("data"), string("mimeType")) {
            (Some("image"), Some(data), Some(mime)) => Some(ContentBlock::Image {
                data: data.into(),
                mime_type: mime.into(),
            }),
            (Some("audio"), Some(data), Some(mime)) => Some(ContentBlock::Audio {
                data: data.into(),
                mime_type: mime.into(),
            }),
            _ => None,
        };
        if let Some(content) = media {
            parts.push(ToolContent::Media {
                content,
                detail: None,
            });
        } else if let (Some("text"), Some(text)) = (string("type"), string("text")) {
            parts.push(ToolContent::Text(text.into()));
        } else {
            parts.push(ToolContent::Text(block.to_string()));
        }
    }
    if let Some(value) = raw.get("structuredContent") {
        parts.push(ToolContent::Text(
            serde_json::json!({"structuredContent":value}).to_string(),
        ));
    }
    if parts.is_empty() {
        parts.push(ToolContent::Text(
            "MCP tool completed with no content.".into(),
        ));
    }
    ToolSuccess::content(ToolOutput::Json(raw), parts).reporting_error(is_error)
}
