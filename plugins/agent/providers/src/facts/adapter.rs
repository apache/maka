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

use maka_agent_facts::configuration::ApiProtocol;
use maka_agent_facts::model::PlaintextResponses;
use maka_agent_ports::provider::Error;
use serde::Deserialize;

/// Bundled provider execution contracts. Each executable adapter speaks one wire protocol.
// Empty struct variants (`{}`) rather than unit variants keep `deny_unknown_fields` active under `#[serde(tag = "kind")]`.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RuntimeAdapter {
    OpenaiChat {},
    OpenaiResponses {
        responses: ResponsesContract,
    },
    OpenaiCodex {
        responses: ResponsesContract,
    },
    OpenaiCompatible {
        name: AdapterName,
        include_usage: Option<bool>,
        replay_assistant_reasoning_as: Option<ReasoningField>,
        replay_assistant_reasoning_details: Option<bool>,
        normalize_usage: Option<bool>,
        normalize_base_url: Option<bool>,
    },
    Anthropic {
        auth: AnthropicAuth,
        normalize_base_url: bool,
        include_beta_headers: Option<bool>,
    },
    Google {},
    Cohere {},
    Unavailable {},
}

impl RuntimeAdapter {
    pub(crate) fn wire(&self) -> Result<ApiProtocol, Error> {
        match self {
            Self::OpenaiChat {} | Self::OpenaiCompatible { .. } => {
                Ok(ApiProtocol::OpenaiChatCompletions)
            }
            Self::OpenaiResponses { .. } | Self::OpenaiCodex { .. } => {
                Ok(ApiProtocol::OpenaiResponses)
            }
            Self::Anthropic { .. } => Ok(ApiProtocol::AnthropicMessages),
            Self::Google {} | Self::Cohere {} | Self::Unavailable {} => {
                Err(Error::UnsupportedProtocol)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AdapterName {
    Provider,
    Connection,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AnthropicAuth {
    ApiKey,
    Bearer,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReasoningField {
    Reasoning,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "adapter",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ResponsesContract {
    Openai {
        reasoning_replay: OpenaiReasoningReplay,
    },
    OpenResponses {
        #[serde(flatten)]
        contract: PlaintextResponses,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenaiReasoningReplay {
    EncryptedContent,
    None,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRuntimeOverride {
    pub adapter: RuntimeAdapter,
    pub base_url: Option<String>,
}
