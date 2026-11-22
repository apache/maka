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

pub use maka_agent_facts::language::Language;
pub use maka_agent_facts::model::ModelGeneration;
use serde::{Deserialize, Serialize};

/// A user-selected model name, not provider configuration or execution authority.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Selection {
    Default,
    Named {
        connection_slug: String,
        model: String,
    },
}
impl Selection {
    pub fn validate(&self) -> Result<(), crate::Error> {
        if let Self::Named {
            connection_slug,
            model,
        } = self
        {
            crate::name(connection_slug)?;
            crate::name(model)?;
        }
        Ok(())
    }
}

pub trait Models: Send + Sync {
    /// Bounded, non-secret chat model pages. Continue with the returned cursor.
    /// Discovery does not grant execution authority or promise provider readiness.
    fn search(
        &self,
        query: Search,
    ) -> futures_util::future::BoxFuture<'_, Result<SearchResult, crate::Error>>;
    /// Resolve an enabled model without exposing credentials, endpoints, or overlays.
    /// Admission still validates the selected binding and its current permissions.
    fn resolve(
        &self,
        selection: Selection,
    ) -> futures_util::future::BoxFuture<'_, Result<Option<Choice>, crate::Error>>;

    fn generate(
        &self,
        call: maka_capabilities::call::Scope,
        input: Generate,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<ModelGeneration, maka_agent_facts::tools::ToolError>,
    >;
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Search {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub cursor: Option<Cursor>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    pub query: String,
    pub generation: uuid::Uuid,
    pub configuration_revision: u64,
    pub provider_revision: u64,
    pub offset: u64,
}
impl Search {
    pub fn validate(&self) -> Result<(), crate::Error> {
        if self.query.len() > 512
            || self.query.chars().any(char::is_control)
            || self.cursor.as_ref().is_some_and(|cursor| {
                cursor.query.len() > 512
                    || cursor.query.chars().any(char::is_control)
                    || [
                        cursor.configuration_revision,
                        cursor.provider_revision,
                        cursor.offset,
                    ]
                    .into_iter()
                    .any(|value| value > (1 << 53) - 1)
            })
        {
            return Err(crate::Error::Invalid("invalid model search query".into()));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choice {
    pub model: maka_agent_facts::execution::ModelBinding,
    pub connection_name: String,
    pub display_name: String,
    pub thinking_levels: Vec<maka_agent_facts::execution::ThinkingLevel>,
    pub default_thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choices {
    pub revision: u64,
    pub models: Vec<Choice>,
    pub complete: bool,
    pub next_cursor: Option<Cursor>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SearchResult {
    Page { page: Choices },
    Stale,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Generate {
    #[serde(default, skip_serializing_if = "Language::is_english")]
    pub language: Language,
    pub prompt: String,
    pub system: Option<String>,
    pub max_output_tokens: Option<u64>,
}
impl Generate {
    pub fn validate(&self) -> Result<(), crate::Error> {
        if self.prompt.trim().is_empty()
            || self
                .prompt
                .len()
                .saturating_add(self.system.as_ref().map_or(0, String::len))
                > 256 * 1024
            || self
                .max_output_tokens
                .is_some_and(|value| value == 0 || value > 9_007_199_254_740_991)
        {
            return Err(crate::Error::Invalid(
                "invalid or oversized model generation".into(),
            ));
        }
        Ok(())
    }
}
