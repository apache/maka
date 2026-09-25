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

use super::{ModelCapabilities, present, validation};
use crate::execution::ThinkingLevel;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCatalogEntry {
    /// Effective facts for execution; the catalog's metadata remains the wire authority.
    #[serde(skip)]
    pub capabilities: ModelCapabilities,
    pub id: String,
    pub can_use_as_chat_default: bool,
    pub is_default: bool,
    pub supports_vision: bool,
    pub thinking_levels: Vec<ThinkingLevel>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub default_thinking_level: Option<ThinkingLevel>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub default_supports_vision: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub default_context_window: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub default_input_limit: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub input_limit: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub compaction_threshold: Option<u64>,
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
    pub context_window: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub knowledge_cutoff: Option<String>,
}

impl ModelCatalogEntry {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            can_use_as_chat_default: true,
            ..Self::default()
        }
    }

    pub fn validate(&self) -> validation::ValidationResult {
        validation::text(&self.id, 512, true)?;
        for (value, max) in [
            (self.display_name.as_deref(), 512),
            (self.description.as_deref(), 2048),
            (self.knowledge_cutoff.as_deref(), 2048),
        ] {
            if let Some(value) = value {
                validation::text(value, max, false)?;
            }
        }
        for value in [
            self.context_window,
            self.input_limit,
            self.compaction_threshold,
            self.default_context_window,
            self.default_input_limit,
        ]
        .into_iter()
        .flatten()
        {
            validation::revision(value, true)?;
        }
        for (index, level) in self.thinking_levels.iter().enumerate() {
            if self.thinking_levels[..index].contains(level) {
                return Err("duplicate catalog thinking level".into());
            }
        }
        if self
            .default_thinking_level
            .is_some_and(|level| !self.thinking_levels.contains(&level))
        {
            return Err("unsupported default thinking level".into());
        }
        Ok(())
    }
}
