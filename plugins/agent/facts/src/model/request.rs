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

use super::{PlaintextResponses, prompt::Prompt};
use crate::tools::ToolDefinition;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    OpenaiChatCompletions,
    OpenaiResponses,
    OpenResponses(PlaintextResponses),
    OpenaiCompatible { name: String },
    Anthropic,
}

/// Resolved credentials for one admitted adapter call; never canonical history.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Credentials {
    ApiKey(String),
    /// Already prepared authentication, including an empty map for no credentials.
    /// Kept separate from public connection headers because these values are secret.
    RequestHeaders(BTreeMap<String, String>),
}

impl Credentials {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::ApiKey(key) => {
                if key.is_empty() || key.chars().any(char::is_control) {
                    return Err("invalid provider API key".into());
                }
            }
            Self::RequestHeaders(headers) => {
                let mut seen = std::collections::BTreeSet::new();
                for (name, value) in headers {
                    let name_lower = name.to_ascii_lowercase();
                    if name.is_empty()
                        || !name.bytes().all(|c| {
                            c.is_ascii_alphanumeric() || b"!#$%&'*+.^_\x60|~-".contains(&c)
                        })
                        || value.chars().any(|c| c.is_control() && c != '\t')
                        || !seen.insert(name_lower.clone())
                        || [
                            "connection",
                            "content-length",
                            "host",
                            "proxy-authorization",
                            "transfer-encoding",
                            "upgrade",
                        ]
                        .contains(&name_lower.as_str())
                    {
                        return Err("invalid provider authentication header".into());
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub kind: ProviderKind,
    pub model: String,
    pub base_url: String,
    #[serde(flatten)]
    pub auth: Credentials,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_overlay: Option<serde_json::Map<String, Value>>,
}

/// Typed adapter input. Wire encoding and optional provider extensions belong
/// to the selected implementation, not to the canonical log.
#[derive(Clone)]
pub struct Request {
    pub language: crate::language::Language,
    pub provider: Provider,
    pub prompt: Prompt,
    pub tools: Vec<Arc<ToolDefinition>>,
    pub provider_options: Value,
    pub max_output_tokens: Option<u64>,
}
