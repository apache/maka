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

//! Typed hosted-tool results. Response decoding and history replay share these
//! wire types so a round trip does not rename or reconstruct opaque tool data.
use super::Citations;
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|error| Error::InvalidArgument {
        field: error.to_string(),
        value: value.clone(),
    })
}
pub fn wire(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("hosted results contain JSON fields")
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CodeResult {
    CodeExecutionResult {
        stdout: String,
        stderr: String,
        return_code: f64,
        #[serde(default)]
        content: Vec<CodeFile>,
    },
    EncryptedCodeExecutionResult {
        encrypted_stdout: String,
        stderr: String,
        return_code: f64,
        #[serde(default)]
        content: Vec<CodeFile>,
    },
    BashCodeExecutionResult {
        stdout: String,
        stderr: String,
        return_code: f64,
        content: Vec<BashFile>,
    },
    BashCodeExecutionToolResultError {
        error_code: String,
    },
    TextEditorCodeExecutionToolResultError {
        error_code: String,
    },
    TextEditorCodeExecutionViewResult {
        content: String,
        file_type: String,
        num_lines: Option<f64>,
        start_line: Option<f64>,
        total_lines: Option<f64>,
    },
    TextEditorCodeExecutionCreateResult {
        is_file_update: bool,
    },
    TextEditorCodeExecutionStrReplaceResult {
        lines: Option<Vec<String>>,
        new_lines: Option<f64>,
        new_start: Option<f64>,
        old_lines: Option<f64>,
        old_start: Option<f64>,
    },
}
#[derive(Debug, Deserialize, Serialize)]
pub struct CodeFile {
    #[serde(rename = "type")]
    pub kind: CodeFileTag,
    pub file_id: String,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct BashFile {
    #[serde(rename = "type")]
    pub kind: BashFileTag,
    pub file_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SearchResult {
    #[serde(rename = "type")]
    pub kind: SearchResultTag,
    pub url: String,
    pub title: Option<String>,
    pub page_age: Option<String>,
    pub encrypted_content: String,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct FetchResult {
    #[serde(rename = "type")]
    pub kind: FetchResultTag,
    pub url: String,
    pub retrieved_at: Option<String>,
    pub content: Document,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Document {
    #[serde(rename = "type")]
    pub kind: DocumentTag,
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citations: Option<Citations>,
    pub source: DocumentSource,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DocumentSource {
    Base64 { media_type: Pdf, data: String },
    Text { media_type: PlainText, data: String },
}
#[derive(Debug, Deserialize, Serialize)]
pub enum Pdf {
    #[serde(rename = "application/pdf")]
    Pdf,
}
#[derive(Debug, Deserialize, Serialize)]
pub enum PlainText {
    #[serde(rename = "text/plain")]
    PlainText,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct ToolReference {
    #[serde(rename = "type")]
    pub kind: ToolReferenceTag,
    pub tool_name: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AdvisorResult {
    AdvisorResult {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
    },
    AdvisorRedactedResult {
        encrypted_content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
    },
    AdvisorToolResultError {
        error_code: String,
    },
}

// Explicit single-variant fields validate discriminators during deserialization;
// serde struct tags alone only control serialization.
#[derive(Debug, Deserialize, serde::Serialize)]
pub enum CodeFileTag {
    #[serde(rename = "code_execution_output")]
    Value,
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub enum BashFileTag {
    #[serde(rename = "bash_code_execution_output")]
    Value,
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub enum SearchResultTag {
    #[serde(rename = "web_search_result")]
    Value,
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub enum FetchResultTag {
    #[serde(rename = "web_fetch_result")]
    Value,
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub enum DocumentTag {
    #[serde(rename = "document")]
    Value,
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub enum ToolReferenceTag {
    #[serde(rename = "tool_reference")]
    Value,
}
