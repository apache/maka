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

use super::present;
use crate::execution::ThinkingLevel;
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum ApiProtocol {
    OpenaiChatCompletions,
    OpenaiResponses,
    AnthropicMessages,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelModality {
    Text,
    Image,
    Audio,
    Pdf,
    Video,
}

#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogModelReference {
    #[schemars(length(min = 1))]
    pub provider: String,
    #[schemars(length(min = 1))]
    pub model_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelOverride {
    /// Catalog defaults for this connection's model; the request model ID is unchanged.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "CatalogModelReference")]
    pub catalog_model: Option<CatalogModelReference>,
    /// Public adapter contribution name; omitted selects the wire's default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "String")]
    pub adapter: Option<String>,
    /// Omitted means model-specific defaults; false is an explicit opt-out.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "bool")]
    pub code_mode: Option<bool>,
    /// Code Mode interpreter; omitted selects JavaScript.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "crate::execution::CodeLanguage")]
    pub code_mode_language: Option<crate::execution::CodeLanguage>,
    /// Independent of Code Mode: select patch editing or structured Edit/Write.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "bool")]
    pub apply_patch: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "Vec<ThinkingLevel>")]
    pub thinking_levels: Option<Vec<ThinkingLevel>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "ThinkingLevel")]
    pub default_thinking_level: Option<ThinkingLevel>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "bool")]
    pub vision: Option<bool>,
    /// Explicit route image declarations; replaces catalog image constraints.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub image_input: Option<super::ImageInput>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    /// Override total input-plus-output capacity, without subtracting a reply budget.
    #[schemars(with = "u64")]
    pub context_window: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    /// Optional override of the automatic compaction threshold, in retained tokens.
    /// By default Host uses 85% of the smaller total window/input ceiling.
    #[schemars(with = "u64")]
    pub compaction_threshold: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    /// Independent input ceiling; also caps the default compaction input budget.
    #[schemars(with = "u64")]
    pub input_limit: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    /// Requested per-step output budget, subject to provider and remaining-capacity caps.
    #[schemars(with = "u64")]
    pub max_output_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "String")]
    pub display_name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "String")]
    pub description: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "ApiProtocol")]
    pub api_protocol: Option<ApiProtocol>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "String")]
    pub knowledge_cutoff: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "ModelOverrideCapabilities")]
    pub capabilities: Option<ModelOverrideCapabilities>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "ModelModalities")]
    pub modalities: Option<ModelModalities>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "RelayServiceTier")]
    pub service_tier: Option<RelayServiceTier>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RelayServiceTier {
    Fast,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelModalities {
    pub input: Vec<ModelModality>,
    pub output: Vec<ModelModality>,
}

/// Vision has one declaration owner: ModelOverride::vision.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelOverrideCapabilities {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "bool")]
    pub chat: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "bool")]
    pub reasoning: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "bool")]
    pub function_calling: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "bool")]
    pub parallel_tool_calls: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "bool")]
    pub image_generation: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "bool")]
    pub web_search: Option<bool>,
}

impl ModelOverride {
    /// Model facts are distinct from execution policy (thinking, service tier,
    /// compaction threshold and reply budget).
    pub fn apply(&self, model: &super::ModelInfo) -> super::ModelInfo {
        let mut result = model.clone();
        result.context_window = self.context_window.or(result.context_window);
        result.input_limit = self.input_limit.or(result.input_limit);
        result.api_protocol = self.api_protocol.or(result.api_protocol);
        result.display_name = self.display_name.clone().or(result.display_name);
        result.description = self.description.clone().or(result.description);
        result.knowledge_cutoff = self.knowledge_cutoff.clone().or(result.knowledge_cutoff);
        result.modalities = self.modalities.clone().or(result.modalities);
        result.image_input = self.image_input.clone().or(result.image_input);
        if let Some(declared) = &self.capabilities {
            let capabilities = result.capabilities.get_or_insert_default();
            capabilities.chat = declared.chat.or(capabilities.chat);
            capabilities.reasoning = declared.reasoning.or(capabilities.reasoning);
            capabilities.function_calling =
                declared.function_calling.or(capabilities.function_calling);
            capabilities.parallel_tool_calls = declared
                .parallel_tool_calls
                .or(capabilities.parallel_tool_calls);
            capabilities.image_generation =
                declared.image_generation.or(capabilities.image_generation);
            capabilities.web_search = declared.web_search.or(capabilities.web_search);
        }
        if let Some(vision) = self.vision {
            result.capabilities.get_or_insert_default().vision = Some(vision);
        }
        result
    }
}
