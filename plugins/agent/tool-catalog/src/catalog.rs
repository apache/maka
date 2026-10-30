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

use crate::{PreparationFuture, ToolCallContext};
use jsonschema::Validator;
use maka_agent_facts::tool_call::ToolRejection;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;

pub use maka_agent_facts::execution::ToolMode;
pub use maka_agent_facts::tools::ToolDefinition;
pub use maka_agent_facts::tools::ToolNesting;
pub use maka_agent_facts::tools::ToolRegistration;
pub use maka_agent_facts::tools::ToolSemantics;

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("invalid tool catalog: {0}")]
    Invalid(String),
    #[error("invalid tool schema: {0}")]
    Schema(String),
}

#[derive(Clone)]
pub(crate) struct RegisteredTool {
    pub(crate) always_visible: bool,
    pub(crate) definition: Arc<ToolDefinition>,
    pub(crate) nesting: ToolNesting,
    pub(crate) semantics: ToolSemantics,
    pub(crate) handler: maka_agent_facts::tools::ToolHandler,
    pub(crate) validator: Arc<Validator>,
}

#[derive(Clone, Default)]
pub struct ToolCatalog {
    pub(crate) entries: Arc<BTreeMap<String, Arc<RegisteredTool>>>,
    pub(super) discovery: bool,
    pub(crate) request_bindings: Arc<Vec<crate::request::Group>>,
}

impl ToolCatalog {
    pub fn new(
        registrations: impl IntoIterator<Item = ToolRegistration>,
    ) -> Result<Self, CatalogError> {
        let mut entries = BTreeMap::new();
        for mut registration in registrations {
            if let Some(provider) = &registration.definition.provider {
                provider
                    .validate()
                    .map_err(|error| CatalogError::Invalid(error.into()))?;
                if registration.semantics != ToolSemantics::Parallel {
                    return Err(CatalogError::Invalid(
                        "provider tools cannot control Host turn settlement".into(),
                    ));
                }
                registration.nesting = ToolNesting::DirectOnly;
            }
            if registration.semantics == ToolSemantics::FinishTurn
                && registration.nesting != ToolNesting::DirectOnly
            {
                return Err(CatalogError::Invalid(
                    "a finishing tool must be direct-only".into(),
                ));
            }
            let definition = &registration.definition;
            if definition.name.is_empty()
                || definition.name.len() > 128
                || matches!(
                    definition.name.as_str(),
                    "exec" | "wait" | "code_cell" | "invalid" | "tool_search" | "maka_tool_search"
                )
                || entries.contains_key(&definition.name)
                || !registration.handler.names().contains(&definition.name)
            {
                return Err(CatalogError::Invalid(
                    "duplicate, reserved, absent or invalid tool name".into(),
                ));
            }
            // Matches Maka's JSON-schema tool path: no format assertions,
            // defaults/coercion or fetching file/network references.
            let validator = jsonschema::options()
                .offline()
                .should_validate_formats(false)
                .build(&definition.input_schema)
                .map_err(|e| CatalogError::Schema(e.to_string()))?;
            entries.insert(
                definition.name.clone(),
                Arc::new(RegisteredTool {
                    always_visible: false,
                    definition: Arc::new(registration.definition),
                    nesting: registration.nesting,
                    semantics: registration.semantics,
                    handler: registration.handler,
                    validator: Arc::new(validator),
                }),
            );
        }
        Ok(Self {
            entries: Arc::new(entries),
            discovery: false,
            request_bindings: Arc::default(),
        })
    }

    /// Add independently validated registrations without losing request bindings
    /// or visibility of the existing catalog. Duplicate names are rejected.
    pub fn with_additional(
        mut self,
        registrations: impl IntoIterator<Item = ToolRegistration>,
    ) -> Result<Self, CatalogError> {
        let additional = Self::new(registrations)?;
        let entries = Arc::make_mut(&mut self.entries);
        for (name, entry) in additional.entries.iter() {
            if entries.insert(name.clone(), entry.clone()).is_some() {
                return Err(CatalogError::Invalid(
                    "duplicate additional tool name".into(),
                ));
            }
        }
        Ok(self)
    }

    /// Defer non-core schemas until discovered within this Session.
    pub fn with_discovery(mut self) -> Self {
        self.discovery = true;
        self
    }

    /// Keep an already registered control visible while discovery defers other
    /// schemas. Selection and tool authorization still apply normally.
    pub fn with_always_visible(mut self, names: &[&str]) -> Result<Self, CatalogError> {
        for name in names {
            let entries = Arc::make_mut(&mut self.entries);
            let entry = entries.get(*name).ok_or_else(|| {
                CatalogError::Invalid(format!("visible tool is not registered: {name}"))
            })?;
            entries.insert(
                (*name).into(),
                Arc::new(RegisteredTool {
                    always_visible: true,
                    ..(**entry).clone()
                }),
            );
        }
        Ok(self)
    }

    pub(super) fn select(&self, keep: impl Fn(&str) -> bool) -> Self {
        self.filtered(|name, _| keep(name))
    }

    fn filtered(&self, keep: impl Fn(&str, &RegisteredTool) -> bool) -> Self {
        let mut entries = self.entries.iter().enumerate();
        while let Some((index, (name, entry))) = entries.next() {
            if !keep(name, entry) {
                let prefix = self.entries.iter().take(index);
                let remaining = entries
                    .map(|(_, entry)| entry)
                    .filter(|(name, entry)| keep(name, entry));
                return Self {
                    entries: Arc::new(
                        prefix
                            .chain(remaining)
                            .map(|(name, entry)| (name.clone(), entry.clone()))
                            .collect(),
                    ),
                    discovery: self.discovery,
                    request_bindings: self.request_bindings.clone(),
                };
            }
        }
        self.clone()
    }

    pub fn definitions(&self) -> impl Iterator<Item = &ToolDefinition> {
        self.entries.values().map(|entry| entry.definition.as_ref())
    }

    /// Narrow registered Host tools without changing plugin scope or authority.
    pub fn excluding(&self, names: &[&str]) -> Self {
        self.select(|name| !names.contains(&name))
    }

    pub fn nested(&self) -> Self {
        self.filtered(|_, entry| entry.nesting == ToolNesting::Nestable)
    }

    pub(super) fn direct_only(&self) -> Self {
        self.select(|name| self.entries[name].nesting == ToolNesting::DirectOnly)
    }

    /// Stable request-surface identity; process-local handler addresses are excluded.
    pub fn digest(&self) -> String {
        let entries: Vec<_> = self
            .entries
            .values()
            .map(|entry| {
                let r = entry;
                (
                    &r.definition,
                    r.nesting == ToolNesting::Nestable,
                    r.semantics != ToolSemantics::Parallel,
                )
            })
            .collect();
        let finishing: Vec<_> = self
            .entries
            .values()
            .filter(|entry| entry.semantics == ToolSemantics::FinishTurn)
            .map(|entry| &entry.definition.name)
            .collect();
        let visible: Vec<_> = self
            .entries
            .values()
            .filter(|entry| entry.always_visible)
            .map(|entry| &entry.definition.name)
            .collect();
        // Preserve the existing durable identity when no new semantic is used.
        let bytes = if !visible.is_empty() {
            serde_json::to_vec(&(self.discovery, entries, finishing, visible))
        } else if finishing.is_empty() {
            serde_json::to_vec(&(self.discovery, entries))
        } else {
            serde_json::to_vec(&(self.discovery, entries, finishing))
        }
        .expect("tool definitions are JSON");
        maka_agent_facts::artifact::content_digest(&bytes)
    }

    pub fn semantics(&self, name: &str) -> Result<ToolSemantics, ToolRejection> {
        self.entries
            .get(name)
            .map(|entry| entry.semantics)
            .ok_or(ToolRejection::Unavailable)
    }

    pub fn validate(&self, name: &str, input: &Value) -> Result<(), ToolRejection> {
        let entry = self.entries.get(name).ok_or(ToolRejection::Unavailable)?;
        if entry.definition.provider.is_some() {
            return Err(ToolRejection::Unavailable);
        }
        if !entry.validator.is_valid(input) {
            return Err(ToolRejection::InvalidInput {
                message: "arguments do not match the declared schema".into(),
            });
        }
        Ok(())
    }
}

impl ToolCatalog {
    pub fn names(&self) -> Vec<String> {
        self.entries.keys().cloned().collect()
    }

    pub fn contains(&self, name: &str) -> bool {
        self.entries.contains_key(name)
    }

    pub(crate) fn always_visible(&self, name: &str) -> bool {
        self.entries
            .get(name)
            .is_some_and(|entry| entry.always_visible)
    }

    pub fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        if cancellation.is_cancelled() {
            return Box::pin(async { Err(ToolRejection::Cancelled) });
        }
        if let Err(reason) = self.validate(&name, &input) {
            return Box::pin(async move { Err(reason) });
        }
        let preparation =
            self.entries[&name]
                .handler
                .prepare(name, input, context, cancellation.clone());
        Box::pin(async move {
            let effect = preparation.await?;
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            Ok(effect)
        })
    }
}

#[cfg(test)]
mod tests;
