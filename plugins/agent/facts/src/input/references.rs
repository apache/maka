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

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryReference {
    pub host_id: String,
    pub path: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuoteRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SessionQuoteSource>,
}

/// Display provenance of an immutable excerpt, never authority to read its source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionQuoteSource {
    pub session_id: String,
    pub session_name: String,
    pub captured_at: CaptureTime,
    pub truncated: bool,
}

/// JavaScript epoch milliseconds, preserving fractional timestamps within Date's range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "serde_json::Number", into = "serde_json::Number")]
#[schemars(with = "f64")]
pub struct CaptureTime(serde_json::Number);

impl TryFrom<serde_json::Number> for CaptureTime {
    type Error = &'static str;

    fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> {
        if value
            .as_f64()
            .is_some_and(|value| (0.0..=8_640_000_000_000_000.0).contains(&value))
        {
            Ok(Self(value))
        } else {
            Err("invalid Session quote capture time")
        }
    }
}

impl From<CaptureTime> for serde_json::Number {
    fn from(value: CaptureTime) -> Self {
        value.0
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InlineReference {
    pub kind: InlineReferenceKind,
    pub value: String,
    pub label: String,
    pub start: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InlineReferenceKind {
    Skill,
    WorkspaceFile,
}
