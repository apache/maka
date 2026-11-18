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

//! Read-only symbol navigation (definitions, references, hover) within a Session workspace.
//! Prefers an installed local Language Server when available and responsive, and falls back
//! to a fast capability-scoped lexical/declaration index without failing the request.

pub mod index;
pub mod lsp;

use crate::path::WorkspacePath;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use lsp::{LspPool, LspRequestContext};

/// Zero-based line and UTF-16 code-unit column, matching LSP and NSH Editor positions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCodePosition")]
pub struct CodePosition {
    pub line: u64,
    pub column: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCodeRange")]
pub struct CodeRange {
    pub start: CodePosition,
    pub end: CodePosition,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentCodeBackend")]
pub enum CodeBackend {
    Lsp { server: String },
    Indexed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCodeLocation")]
pub struct CodeLocation {
    pub path: WorkspacePath,
    pub range: CodeRange,
    pub preview: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCodeDefinitionResult")]
pub struct CodeDefinitionResult {
    pub backend: CodeBackend,
    pub symbol: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<CodeRange>")]
    pub origin_range: Option<CodeRange>,
    pub locations: Vec<CodeLocation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCodeReferencesResult")]
pub struct CodeReferencesResult {
    pub backend: CodeBackend,
    pub symbol: String,
    pub locations: Vec<CodeLocation>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCodeHoverResult")]
pub struct CodeHoverResult {
    pub backend: CodeBackend,
    pub symbol: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<CodeRange>")]
    pub range: Option<CodeRange>,
    pub markdown: String,
}
