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

use super::{ApiProtocol, ModelModalities, present, validation};
use serde::{Deserialize, Serialize};

/// Canonical provider inventory, distinct from execution policy and model overrides.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelInfo {
    pub id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub display_name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub description: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub api_protocol: Option<ApiProtocol>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    /// Total model capacity for input plus generated output, before any reply reserve.
    pub context_window: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    /// Independent provider input ceiling; not context_window minus max_output_tokens.
    pub input_limit: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    /// Provider output ceiling; also the default request budget when none is selected.
    pub max_output_tokens: Option<u64>,
    /// Choices reported by the provider plugin.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub thinking_levels: Option<Vec<crate::execution::ThinkingLevel>>,
    /// Provider default, distinct from a user's execution override.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub default_thinking_level: Option<crate::execution::ThinkingLevel>,
    /// Whether the provider accepts a request for a visible reasoning summary.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub supports_reasoning_summary: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub knowledge_cutoff: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub structured_output: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub last_updated: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub capabilities: Option<ModelCapabilities>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub modalities: Option<ModelModalities>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub image_input: Option<ImageInput>,
}

/// Route declarations for image input; absent fields remain unknown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageInput {
    /// Exact MIME declarations. A generic image modality leaves this unknown.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub mime_types: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub max_per_message: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub max_per_request: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub max_bytes: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub min_width: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub min_height: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub max_width: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub max_height: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub request_bytes: Option<u64>,
}

impl ImageInput {
    pub fn validate(&self) -> Result<(), String> {
        for value in [
            self.max_per_message,
            self.max_per_request,
            self.max_bytes,
            self.request_bytes,
        ]
        .into_iter()
        .flatten()
        {
            validation::revision(value, false)?;
        }
        for (min, max) in [
            (self.min_width, self.max_width),
            (self.min_height, self.max_height),
        ] {
            if matches!((min, max), (Some(min), Some(max)) if min > max) {
                return Err("image minimum dimension exceeds maximum".into());
            }
        }
        if let Some(types) = &self.mime_types {
            for (index, mime) in types.iter().enumerate() {
                let Some(subtype) = mime.strip_prefix("image/") else {
                    return Err("invalid image MIME type".into());
                };
                if subtype.is_empty()
                    || !subtype
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b".+-".contains(&byte))
                    || types[..index].contains(mime)
                {
                    return Err("invalid or duplicate image MIME type".into());
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCapabilities {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub chat: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub vision: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub reasoning: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub function_calling: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub parallel_tool_calls: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub image_generation: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub web_search: Option<bool>,
}

impl ModelInfo {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            ..Self::default()
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        validation::text(&self.id)?;
        if let Some(image) = &self.image_input {
            image.validate()?;
        }
        if let Some(levels) = &self.thinking_levels {
            for (index, level) in levels.iter().enumerate() {
                if levels[..index].contains(level) {
                    return Err("duplicate model thinking level".into());
                }
            }
        }
        if self.default_thinking_level.is_some_and(|level| {
            !self
                .thinking_levels
                .as_ref()
                .is_some_and(|levels| levels.contains(&level))
        }) {
            return Err("model default thinking level is not advertised".into());
        }
        for value in [
            self.context_window,
            self.input_limit,
            self.max_output_tokens,
        ]
        .into_iter()
        .flatten()
        {
            validation::revision(value, true)?;
        }
        Ok(())
    }
}
