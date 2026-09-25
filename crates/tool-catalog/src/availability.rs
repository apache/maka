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
use maka_runtime::{tool_call::ToolRejection, tools::ToolError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

pub const SEARCH: &str = "tool_search";

#[derive(Clone)]
pub struct Availability {
    catalog: ToolCatalog,
    behavior: Option<maka_runtime::execution::BehaviorId>,
    active: Arc<Mutex<BTreeSet<String>>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked: Option<Blocked>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Blocked {
    name: String,
    reason: BlockReason,
    schema_chars: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BlockReason {
    SchemaTooLarge,
    SchemaBudgetExhausted,
}

impl Availability {
    pub async fn capture(
        &self,
        model: Option<maka_runtime::tools::ModelToolContext>,
        invocation: maka_runtime::event::Invocation,
        cwd: String,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<
        (
            Self,
            Option<maka_plugins::contributions::Captured>,
            maka_plugins::prompt::Resolved,
        ),
        ToolError,
    > {
        let captured = self.catalog.capture_plugins();
        let mut catalog = match &captured {
            Some(captured) => self.catalog.resolve_captured(captured),
            None => Ok(self.catalog.clone()),
        }
        .map_err(|error| ToolError::Failed(error.to_string()))?;
        let context = if let Some(captured) = &captured {
            let request = crate::plugins::BindingRequest {
                behavior: self.behavior.clone(),
                model,
                invocation,
                cwd,
                tools: catalog.names().into_iter().collect(),
                cancellation,
            };
            catalog.bind_request(captured, request).await?
        } else {
            Default::default()
        };
        Ok((
            Self {
                catalog,
                behavior: self.behavior.clone(),
                active: self.active.clone(),
            },
            captured,
            context,
        ))
    }

    pub fn new(catalog: ToolCatalog) -> Self {
        Self {
            catalog,
            behavior: None,
            active: Arc::default(),
        }
    }
    pub fn set_behavior(&mut self, behavior: maka_runtime::execution::BehaviorId) {
        self.behavior = Some(behavior);
    }
    pub fn enabled(&self) -> bool {
        self.catalog.discovery
            && self
                .catalog
                .definitions()
                .any(|definition| !self.direct(&definition.name))
    }
    pub fn nested(&self) -> Self {
        Self {
            catalog: self.catalog.nested(),
            behavior: self.behavior.clone(),
            active: self.active.clone(),
        }
    }

    pub fn direct_only(&self) -> ToolCatalog {
        self.catalog.direct_only()
    }
    pub fn digest(&self) -> String {
        self.catalog.digest()
    }
    pub fn snapshot(&self) -> ToolCatalog {
        if !self.enabled() {
            return self.catalog.clone();
        }
        let active = self.active.lock().unwrap();
        self.catalog
            .select(|name| self.direct(name) || active.contains(name))
    }
    /// The full, already-authorized request snapshot. Code Mode defers only
    /// descriptions, so metadata discovery never changes executable authority.
    pub fn all(&self) -> ToolCatalog {
        self.catalog.clone()
    }
    pub fn clear(&self) {
        self.active.lock().unwrap().clear();
    }

    pub fn checkpoint(&self) -> maka_runtime::handoff::HandoffTools {
        maka_runtime::handoff::HandoffTools {
            catalog_digest: self.catalog.digest(),
            // A successor samples dynamic plugins again. Their executable
            // identities are not promised across Host handoff or restart.
            loaded: self
                .active
                .lock()
                .unwrap()
                .iter()
                .filter(|name| self.catalog.contains(name))
                .cloned()
                .collect(),
        }
    }

    pub fn restore(
        &self,
        checkpoint: &maka_runtime::handoff::HandoffTools,
    ) -> Result<(), ToolError> {
        if checkpoint.catalog_digest != self.catalog.digest()
            || (!checkpoint.loaded.is_empty() && !self.enabled())
            || checkpoint
                .loaded
                .iter()
                .any(|name| self.direct(name) || !self.catalog.contains(name))
        {
            return Err(ToolError::Failed("handoff tool catalog changed".into()));
        }
        *self.active.lock().unwrap() = checkpoint.loaded.clone();
        Ok(())
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
                "Search available capabilities by name or description. Activated tools become callable on the next model step, never in the same batch or JavaScript cell. A successful context compaction unloads them. Inventory: {}.",
                names.join(", ")
            ),
            input_schema: schemars::schema_for!(SearchInput).into(),
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
        let availability = self.clone();
        Ok(PreparedEffect::new(move |_| {
            Box::pin(async move {
                serde_json::to_value(availability.search(&input))
                    .map(Into::into)
                    .map_err(|error| ToolError::Failed(error.to_string()))
            })
        }))
    }
    /// Delivery from ToolJournal proves T2 committed. This cache changes only
    /// future snapshots; neither an in-flight step nor its captured effects widen.
    pub fn settled(&self, name: &str, result: &Value) -> Result<(), ToolError> {
        if name != SEARCH || !self.enabled() {
            return Ok(());
        }
        let result: SearchResult = serde_json::from_value(result.clone()).map_err(|error| {
            ToolError::OutcomeUnknown(format!("invalid committed search result: {error}"))
        })?;
        self.active.lock().unwrap().extend(result.activated);
        Ok(())
    }
    fn direct(&self, name: &str) -> bool {
        self.catalog.always_visible(name) || direct(name)
    }

    fn search(&self, input: &SearchInput) -> SearchResult {
        let query = input.query.trim().to_lowercase();
        let terms: Vec<_> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect();
        let active = self.active.lock().unwrap();
        // The bound inventory is small (at most 128 tools). Scan metadata directly;
        // no search service or dependency graph is needed for this Run-local view.
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
        let mut result = SearchResult {
            activated: Vec::new(),
            blocked: None,
        };
        let mut used = 0;
        for (_, definition) in ranked.into_iter().take(20) {
            if result.activated.len() == input.limit {
                break;
            }
            let chars = serde_json::to_string(definition)
                .expect("function definition is JSON")
                .encode_utf16()
                .count();
            if chars > 64 * 1024 {
                result.blocked.get_or_insert(Blocked {
                    name: definition.name.clone(),
                    reason: BlockReason::SchemaTooLarge,
                    schema_chars: chars,
                });
                continue;
            }
            if used + chars > 64 * 1024 {
                result.blocked = Some(Blocked {
                    name: definition.name.clone(),
                    reason: BlockReason::SchemaBudgetExhausted,
                    schema_chars: chars,
                });
                break;
            }
            used += chars;
            result.activated.push(definition.name.clone());
        }
        result
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
        "Shell"
            | "Read"
            | "Write"
            | "Edit"
            | "Glob"
            | "Grep"
            | "AskUserQuestion"
            | "StopBackgroundTask"
            | "WriteStdin"
            | "apply_patch"
    )
}
