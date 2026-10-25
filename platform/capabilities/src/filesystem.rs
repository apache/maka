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

//! Source-scoped filesystem operations. Host supplies authority, not callers.
pub mod database;
mod directory;
pub mod entries;
mod read;
use maka_agent_facts::read::ReadInput;
pub use read::{
    FileInfo, ListInput, OpenFile, PinnedFile, PinnedReader, ReadAuthorization, ReadDirectory,
    ReadError, ReadInput as ReadViewInput, ReadRange, ReadRoot, Reader, Symlinks,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Authenticated call source and current workspace permission are both checked
/// by Host. Supplying a Session ID is not a way to acquire this authority.
pub trait Files: Send + Sync {
    fn invoke(
        &self,
        call: crate::call::Scope,
        operation: Operation,
    ) -> futures_util::future::BoxFuture<'_, Result<Output, maka_agent_facts::tools::ToolError>>;
}

/// Native callers retain image bytes; only the JS boundary encodes them. Tool
/// calls may instead return their canonical artifact reference as ordinary data.
pub enum Output {
    Value(Value),
    Image { bytes: Vec<u8>, mime_type: String },
    Entries(entries::Output),
}
impl Output {
    pub fn into_json(self) -> Value {
        match self {
            Self::Value(value) => value,
            Self::Entries(value) => {
                serde_json::to_value(value).expect("filesystem result serialization")
            }
            Self::Image { bytes, mime_type } => {
                json!({"kind":"image", "mimeType":mime_type, "bytes":bytes})
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    content = "input",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Operation {
    Read(ReadInput),
    Write(Write),
    Edit(Edit),
    Glob(Glob),
    Grep(Grep),
    Patch(Patch),
    Entries(entries::Operation),
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Write {
    pub path: String,
    pub content: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Glob {
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Grep {
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glob: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Patch {
    CreateFile { path: String, diff: String },
    UpdateFile { path: String, diff: String },
    DeleteFile { path: String },
}
impl Operation {
    pub fn is_read(&self) -> bool {
        match self {
            Self::Read(_) | Self::Glob(_) | Self::Grep(_) => true,
            Self::Entries(operation) => operation.is_read(),
            _ => false,
        }
    }
    pub fn required_tool(&self) -> &'static str {
        match self {
            Self::Entries(operation) => operation.required_tool(),
            _ => self.name(),
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Read(_) => "Read",
            Self::Write(_) => "Write",
            Self::Edit(_) => "Edit",
            Self::Glob(_) => "Glob",
            Self::Grep(_) => "Grep",
            Self::Patch(_) => "apply_patch",
            Self::Entries(operation) => operation.name(),
        }
    }
}
