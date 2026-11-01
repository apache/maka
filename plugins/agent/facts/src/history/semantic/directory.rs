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

//! Closed semantic schema positions and leaf commitments in actual stored bytes.
//!
//! Serde variant order, field order and attributes form the persisted directory
//! schema, including `RowPosition`, `TextKind` and the leaf measure types. Changes
//! require a storage migration or an explicit rebuild decision.
use super::super::RowPosition;
use crate::model::{
    TextKind,
    prompt_source::source::{DecodedTextMeasure, RawJsonMeasure},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ByteRange {
    pub start: u64,
    pub len: u64,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct TextSpan {
    pub range: ByteRange,
    pub measure: DecodedTextMeasure,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct JsonSpan {
    pub range: ByteRange,
    pub measure: RawJsonMeasure,
    pub kind: ValueKind,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ValueKind {
    Null,
    Bool,
    Number,
    String,
    Array,
    Object,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum PartSource {
    Complete(RowPosition),
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum RowDirectory {
    User {
        payload: RowPosition,
        steering: bool,
    },
    ImportedUser {
        payload: RowPosition,
    },
    ImportedAssistant {
        payload: RowPosition,
    },
    ExecutorText {
        payload: RowPosition,
    },
    AssistantPart {
        model_id: TextSpan,
        route_identity: TextSpan,
        payload: PartSource,
    },
    ToolResult {
        payload: RowPosition,
        call_id: TextSpan,
        name: TextSpan,
        custom: bool,
        is_error: bool,
        archived: bool,
    },
    Notification {
        payload: RowPosition,
        call_id: TextSpan,
        custom: bool,
    },
    UnknownTool {
        call_id: TextSpan,
        name: TextSpan,
        custom: bool,
    },
}
impl RowDirectory {
    pub fn payload(self) -> Option<PartSource> {
        match self {
            Self::User { payload, .. }
            | Self::ImportedUser { payload }
            | Self::ImportedAssistant { payload }
            | Self::ExecutorText { payload }
            | Self::ToolResult { payload, .. }
            | Self::Notification { payload, .. } => Some(PartSource::Complete(payload)),
            Self::AssistantPart { payload, .. } => Some(payload),
            Self::UnknownTool { .. } => None,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum InputDirectory {
    Json(JsonSpan),
    Text(TextSpan),
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum PayloadDirectory {
    User {
        text: TextSpan,
        quotes: u64,
        attachments: u64,
        directory_references: Option<JsonSpan>,
    },
    Text(TextSpan),
    Part(PartDirectory),
    Tool(ToolDirectory),
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum PartDirectory {
    Source,
    Text {
        text_kind: TextKind,
        text: TextSpan,
        provider_options: Option<JsonSpan>,
    },
    ToolCall {
        id: TextSpan,
        name: TextSpan,
        input: InputDirectory,
        provider_executed: bool,
        provider_options: Option<JsonSpan>,
    },
    ToolResult {
        id: TextSpan,
        name: TextSpan,
        output: JsonSpan,
        is_error: bool,
        provider_options: Option<JsonSpan>,
    },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum ToolDirectory {
    Text(TextSpan),
    Json(JsonSpan),
    Content { parts: u64 },
    Failure,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ListKind {
    Quotes,
    Attachments,
    ToolParts,
}
impl ListKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quotes => "quotes",
            Self::Attachments => "attachments",
            Self::ToolParts => "tool_parts",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum StorageDirectory {
    SessionFile {
        session_id: TextSpan,
        relative_path: TextSpan,
    },
    WorkspaceFile {
        relative_path: TextSpan,
    },
    ExternalFile {
        absolute_path: TextSpan,
    },
    SessionContext {
        session_id: TextSpan,
        ref_id: TextSpan,
    },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct MediaDirectory {
    pub reference: StorageDirectory,
    pub mime_type: TextSpan,
    pub detail: Option<TextSpan>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct AttachmentDirectory {
    pub image: bool,
    pub name: TextSpan,
    pub mime_type: TextSpan,
    pub reference: StorageDirectory,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum ToolPartDirectory {
    Text(TextSpan),
    Artifact(MediaDirectory),
    Audio(MediaDirectory),
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum ChildDirectory {
    Quote {
        label: Option<TextSpan>,
        source: Option<JsonSpan>,
        text: TextSpan,
    },
    Attachment(AttachmentDirectory),
    ToolPart(ToolPartDirectory),
}
