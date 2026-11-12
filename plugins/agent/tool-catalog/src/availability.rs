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

use crate::{PreparedEffect, ToolCatalog, ToolDefinition};
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};

pub const SEARCH: &str = "tool_search";

/// Read-only canonical discovery preferences, never executable capabilities.
/// Each request still captures its current authorized catalog.
#[derive(Clone)]
pub struct LoadedTools(maka_session_state::Session);

impl LoadedTools {
    pub fn new(session: maka_session_state::Session) -> Self {
        Self(session)
    }
    pub fn session(&self) -> &maka_session_state::Session {
        &self.0
    }
    pub fn temporary() -> Result<Self, ToolError> {
        Ok(Self::new(
            maka_session_state::Backend::temporary()
                .map_err(state_error)?
                .session("tools"),
        ))
    }
    pub async fn snapshot(&self) -> Result<BTreeSet<String>, ToolError> {
        // Ignore any private staging on the supplied Session. Only accepted
        // canonical facts can affect a subsequent model request.
        let session = self.0.fork_draft();
        tokio::task::spawn_blocking(move || session.loaded())
            .await
            .map_err(|error| {
                ToolError::Persistence(format!("loaded tools reader failed: {error}"))
            })?
            .map_err(state_error)
    }
}
fn state_error(error: maka_session_state::Error) -> ToolError {
    // A canonical read failure must not masquerade as an empty loaded set.
    ToolError::Persistence(error.to_string())
}

#[derive(Clone)]
pub struct Availability {
    catalog: ToolCatalog,
    names: Arc<[String]>,
    loaded: LoadedTools,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SearchInput {
    #[schemars(length(min = 1))]
    query: String,
    #[serde(default = "default_limit")]
    #[schemars(range(min = 1, max = 20))]
    limit: usize,
}
fn default_limit() -> usize {
    8
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchResult {
    activated: Vec<String>,
}

impl Availability {
    pub async fn capture(
        &self,
        model: Option<maka_agent_facts::tools::ModelToolContext>,
        execution: maka_agent_facts::durable::ExecutionIdentity,
        custody: Option<Arc<dyn maka_plugin_core::work::WorkCustody>>,
        cwd: String,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<Self, ToolError> {
        let mut catalog = self.catalog.clone();
        let request = crate::request::BindingRequest {
            behavior: None,
            model,
            execution,
            custody,
            cwd,
            tools: BTreeSet::new(),
            available_tools: self.names.clone(),
            cancellation,
        };
        catalog.bind_request(request).await?;
        Ok(self.with_subset(catalog))
    }

    pub fn new(catalog: ToolCatalog, loaded: LoadedTools) -> Self {
        Self {
            names: catalog.names().into(),
            catalog,
            loaded,
        }
    }
    pub fn enabled(&self) -> bool {
        self.catalog.discovery
            && self
                .catalog
                .definitions()
                .any(|definition| !self.direct(&definition.name))
    }
    pub fn nested(&self) -> Self {
        self.with_subset(self.catalog.nested())
    }

    fn with_subset(&self, catalog: ToolCatalog) -> Self {
        // Binding and nesting can only remove names from this frozen ceiling.
        let names = if catalog.entries.len() == self.names.len() {
            self.names.clone()
        } else {
            catalog.names().into()
        };
        Self {
            catalog,
            names,
            loaded: self.loaded.clone(),
        }
    }

    pub fn direct_only(&self) -> ToolCatalog {
        self.catalog.direct_only()
    }
    pub fn digest(&self) -> String {
        self.catalog.digest()
    }
    pub async fn snapshot(&self) -> Result<ToolCatalog, ToolError> {
        let active = self.loaded.snapshot().await?;
        Ok(self.select(&active))
    }
    pub fn select(&self, active: &BTreeSet<String>) -> ToolCatalog {
        if !self.enabled() {
            return self.catalog.clone();
        }
        self.catalog
            .select(|name| self.direct(name) || active.contains(name))
    }
    /// The full, already-authorized request snapshot. Code Mode defers only
    /// descriptions, so metadata discovery never changes executable authority.
    pub fn all(&self) -> ToolCatalog {
        self.catalog.clone()
    }
    pub fn definition(&self) -> Option<ToolDefinition> {
        if !self.enabled() {
            return None;
        }
        let names = self
            .catalog
            .definitions()
            .filter(|d| !self.direct(&d.name))
            .map(|d| d.name.as_str())
            .collect::<Vec<_>>();
        Some(ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: SEARCH.into(),
            description: format!(
                "Find tools by name or description. Matches become callable on the next model step. Accepted loaded names persist in this Session across Host restarts; current permissions and availability apply. Inventory: {}.",
                names.join(", ")
            ),
            input_schema: crate::input::inline_refs(schemars::schema_for!(SearchInput).into()),
        })
    }
    pub fn prepare_search(&self, input: &Value) -> Result<PreparedEffect, ToolRejection> {
        if !self.enabled() {
            return Err(ToolRejection::Unavailable);
        }
        let input: SearchInput = serde_json::from_value(input.clone()).map_err(|_| invalid())?;
        if input.query.trim().is_empty() || !(1..=20).contains(&input.limit) {
            return Err(invalid());
        }
        use maka_agent_facts::display::Text;
        let title = Text::single_line(&input.query).map(|query| {
            let query = query.fallback;
            Text::localized(
                &format!("Find tools · {query}"),
                &format!("查找工具 · {query}"),
                &format!("尋找工具 · {query}"),
            )
        });
        let availability = self.clone();
        let effect = PreparedEffect::new(move |_| {
            Box::pin(async move {
                let found = availability.search(&input).await?;
                let loaded_tools = found.activated.iter().cloned().collect();
                let output = serde_json::to_value(found)
                    .map_err(|error| ToolError::Failed(error.to_string()))?;
                Ok(maka_agent_facts::tool_output::ToolSuccess::from(output)
                    .with_loaded_tools(loaded_tools))
            })
        })
        .presented("maka.agent.Builtin@1/tool_search".into());
        Ok(if let Some(title) = title {
            effect.titled(title)
        } else {
            effect
        })
    }
    fn direct(&self, name: &str) -> bool {
        self.catalog.always_visible(name) || direct(name)
    }

    async fn search(&self, input: &SearchInput) -> Result<SearchResult, ToolError> {
        let active = self.loaded.snapshot().await?;
        let query = input.query.trim().to_lowercase();
        let terms: Vec<_> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect();
        // Scan the bound catalog metadata directly;
        // no search service or dependency graph is needed for this request view.
        let mut ranked: Vec<_> = self
            .catalog
            .definitions()
            .filter(|d| !self.direct(&d.name) && !active.contains(&d.name))
            .filter_map(|d| {
                let name = d.name.to_lowercase();
                let description = d.description.to_lowercase();
                let score = usize::from(name == query) * 1000
                    + terms
                        .iter()
                        .map(|term| {
                            if name.contains(term) {
                                10
                            } else if description.contains(term) {
                                1
                            } else {
                                0
                            }
                        })
                        .sum::<usize>();
                (score > 0).then_some((score, d))
            })
            .collect();
        ranked.sort_by(|(left, a), (right, b)| right.cmp(left).then_with(|| a.name.cmp(&b.name)));
        Ok(SearchResult {
            activated: ranked
                .into_iter()
                .take(input.limit)
                .map(|(_, definition)| definition.name.clone())
                .collect(),
        })
    }
}
fn invalid() -> ToolRejection {
    ToolRejection::InvalidInput {
        message: "Search requires a nonempty query and an optional limit from 1 to 20".into(),
    }
}
fn direct(name: &str) -> bool {
    matches!(
        name,
        "Shell" | "Read" | "Glob" | "Grep" | "AskUserQuestion" | "ProcessStop" | "ProcessInput"
    )
}
