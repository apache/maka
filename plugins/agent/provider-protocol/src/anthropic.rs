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

//! Anthropic Messages protocol. This module owns wire types and request-local
//! state; authentication, network access and cancellation belong to the host.

pub mod citations;
pub mod error;
pub mod hosted;
pub mod prompt;
pub mod request;
pub mod response;
mod schema;
pub mod stream;
#[cfg(test)]
mod tests;
mod tools;
pub use schema::constrained_schema;
pub use tools::*;

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Provider-reported accounting. Unknown fields remain available to the caller
/// through its raw response; they do not influence executor token totals.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub output_tokens_details: Option<OutputTokensDetails>,
    pub iterations: Option<Vec<UsageIteration>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OutputTokensDetails {
    pub thinking_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UsageIteration {
    #[serde(rename = "type")]
    pub kind: IterationKind,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IterationKind {
    Message,
    Compaction,
    AdvisorMessage,
    FallbackMessage,
    #[serde(other)]
    Other,
}

#[derive(Debug, PartialEq, Eq)]
pub struct TokenCounts {
    pub input: u64,
    pub uncached_input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub reasoning: Option<u64>,
}

impl Usage {
    pub fn totals(&self) -> Result<TokenCounts> {
        let iterations = self.iterations.as_deref().unwrap_or_default();
        let mut executor = iterations
            .iter()
            .filter(|v| matches!(v.kind, IterationKind::Message | IterationKind::Compaction));
        let served_fallback = iterations
            .iter()
            .any(|v| v.kind == IterationKind::FallbackMessage);
        let (input, output) = if !served_fallback && executor.clone().next().is_some() {
            executor.try_fold((0, 0), |(input, output), v| {
                Ok::<_, Error>((add(input, v.input_tokens)?, add(output, v.output_tokens)?))
            })?
        } else {
            (self.input_tokens, self.output_tokens)
        };
        let cache_read = self.cache_read_input_tokens.unwrap_or_default();
        let cache_write = self.cache_creation_input_tokens.unwrap_or_default();
        Ok(TokenCounts {
            input: add(add(input, cache_read)?, cache_write)?,
            uncached_input: input,
            cache_read,
            cache_write,
            output,
            reasoning: self
                .output_tokens_details
                .as_ref()
                .and_then(|v| v.thinking_tokens),
        })
    }
}

fn add(left: u64, right: u64) -> Result<u64> {
    left.checked_add(right)
        .ok_or_else(|| Error::invalid("Provider token count overflow.", Value::Null))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum CacheTtl {
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "1h")]
    OneHour,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CacheDirective {
    Ephemeral {
        #[serde(skip_serializing_if = "Option::is_none")]
        ttl: Option<CacheTtl>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum CacheSite {
    System,
    Text,
    Image,
    Document,
    ToolResult,
    ToolDefinition,
    Reasoning,
    RedactedReasoning,
}
impl CacheSite {
    fn can_cache(self) -> bool {
        !matches!(self, Self::Reasoning | Self::RedactedReasoning)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Warning {
    CacheNotAllowed(CacheSite),
    CacheLimit { attempted: usize },
    StrictToolIgnored { name: String },
    ForcedToolChoiceIgnored { name: Option<String> },
    UnsupportedTool { id: String },
}

/// Owned by one request builder and shared across its message and tool passes.
/// It cannot leak capacity or warnings into another concurrent request.
#[derive(Default)]
pub struct CacheBudget {
    attempted: usize,
    warnings: Vec<Warning>,
}
impl CacheBudget {
    pub fn reserve(
        &mut self,
        directive: Option<CacheDirective>,
        site: CacheSite,
    ) -> Option<CacheDirective> {
        let directive = directive?;
        if !site.can_cache() {
            self.warnings.push(Warning::CacheNotAllowed(site));
            return None;
        }
        self.attempted = self.attempted.saturating_add(1);
        if self.attempted > 4 {
            self.warnings.push(Warning::CacheLimit {
                attempted: self.attempted,
            });
            None
        } else {
            Some(directive)
        }
    }
    pub fn warnings(&self) -> &[Warning] {
        &self.warnings
    }
    pub fn into_warnings(self) -> Vec<Warning> {
        self.warnings
    }
}
