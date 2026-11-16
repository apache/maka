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

use crate::configuration::ModelCapabilities;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A provider-executed capability. The adapter owns its schema and execution;
/// plugins publish its SDK contract, never a host function pretending to run it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTool {
    pub id: String,
    pub args: Value,
}
impl ProviderTool {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_empty()
            || self.id.len() > 128
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            || !self.id.contains('.')
            || !self.args.is_object()
            || serde_json::to_vec(&self.args)
                .map_err(|_| "invalid provider tool args")?
                .len()
                > 16 * 1024
        {
            return Err("invalid provider tool contract");
        }
        Ok(())
    }
}

/// Non-secret, frozen model facts supplied at logical request capture.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelToolContext {
    pub model: String,
    pub provider_tools: Option<ProviderToolProtocol>,
    pub capabilities: ModelCapabilities,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderToolProtocol {
    OpenaiResponses,
    DeepseekResponses,
    AnthropicMessages,
}

impl ProviderToolProtocol {
    pub fn accepts(self, id: &str) -> bool {
        let namespace = match self {
            Self::OpenaiResponses => "openai",
            Self::DeepseekResponses => "deepseek",
            Self::AnthropicMessages => "anthropic",
        };
        id.split_once('.')
            .is_some_and(|(prefix, _)| prefix == namespace)
    }
}
