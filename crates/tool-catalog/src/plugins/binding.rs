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

use super::{Guarded, PluginTool};
use crate::{ToolCatalog, ToolHandler, ToolPreparer, catalog::RegisteredTool};
use maka_plugins::{contributions::Captured, prompt::Resolved};
use maka_runtime::{composition::SourceKind, event::Invocation, tools::ToolError};
use std::{collections::BTreeSet, future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct BindingRequest {
    /// Frozen behavior identity for visibility decisions, never authority.
    pub behavior: Option<maka_runtime::execution::BehaviorId>,
    pub model: Option<maka_runtime::tools::ModelToolContext>,
    pub invocation: Invocation,
    pub cwd: String,
    /// Effective catalog, already restricted by the Host's tool ceiling.
    pub tools: BTreeSet<String>,
    pub cancellation: CancellationToken,
}

/// Handler and supporting context are one immutable request snapshot.
#[derive(Clone)]
pub struct Binding {
    /// Provider-executed descriptors for names owned by this binding.
    pub provider_tools: std::collections::BTreeMap<String, maka_runtime::tools::ProviderTool>,
    pub handler: Option<Arc<dyn ToolPreparer>>,
    pub context: Option<String>,
}
pub trait BindingProvider: Send + Sync {
    fn bind(
        &self,
        request: BindingRequest,
        workspace: maka_plugins::filesystem::ReadDirectory,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Binding>, ToolError>> + Send>>;
}

impl ToolCatalog {
    pub(crate) async fn bind_request(
        &mut self,
        captured: &Captured,
        request: BindingRequest,
    ) -> Result<Resolved, ToolError> {
        let mut groups: Vec<(Arc<dyn BindingProvider>, String, Option<Binding>)> = Vec::new();
        let mut context = Resolved::default();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let workspace = self.workspace.clone();
        let contributions = captured.typed::<PluginTool>().entries;
        for (name, contribution) in contributions.clone() {
            let Some(entry) = self.entries.get(&name).cloned() else {
                continue;
            };
            let Some(provider) = &contribution.value.binding else {
                continue;
            };
            let activation = contribution.owner.identity().map_err(failed)?.activation;
            let binding = if let Some((_, _, binding)) =
                groups.iter().find(|(candidate, owner, _)| {
                    Arc::ptr_eq(candidate, provider) && owner == &activation
                }) {
                binding.clone()
            } else {
                let _lease = contribution.admit().map_err(failed)?;
                let stopping = contribution.owner.stopping().map_err(failed)?;
                let root = workspace
                    .as_ref()
                    .ok_or_else(|| failed("tool binding workspace capability is unavailable"))?;
                let cancellation = request.cancellation.child_token();
                let _closed = cancellation.clone().drop_guard();
                let files = root.bind(contribution.owner.clone(), cancellation);
                let binding = tokio::select! {
                    biased;
                    _ = request.cancellation.cancelled() => return Err(failed("request cancelled")),
                    _ = stopping.cancelled() => return Err(failed("tool contribution retired")),
                    result = tokio::time::timeout_at(deadline, provider.bind(request.clone(), files)) => result.map_err(failed)??,
                };
                if let Some(binding) = &binding {
                    for name in binding.provider_tools.keys() {
                        let owned = contributions.get(name).is_some_and(|candidate| {
                            candidate
                                .owner
                                .identity()
                                .is_ok_and(|owner| owner.activation == activation)
                                && candidate
                                    .value
                                    .binding
                                    .as_ref()
                                    .is_some_and(|binding| Arc::ptr_eq(binding, provider))
                        });
                        if !owned {
                            return Err(failed("provider tool is not owned by this binding"));
                        }
                    }
                }
                if let Some(text) = binding
                    .as_ref()
                    .and_then(|binding| binding.context.as_ref())
                {
                    if text.len() > 64 * 1024
                        || context.contexts.iter().map(String::len).sum::<usize>() + text.len()
                            > 64 * 1024
                    {
                        return Err(failed("tool binding context exceeds its budget"));
                    }
                    context.sources.push(
                        maka_plugins::prompt::source(
                            &contribution,
                            SourceKind::PromptContext,
                            &name,
                            &Some(text.clone()),
                        )
                        .map_err(failed)?,
                    );
                    context.contexts.push(text.clone());
                }
                groups.push((provider.clone(), activation, binding.clone()));
                binding
            };
            let entries = Arc::make_mut(&mut self.entries);
            let Some(binding) = binding else {
                entries.remove(&name);
                continue;
            };
            if !binding.provider_tools.contains_key(&name)
                && binding
                    .handler
                    .as_ref()
                    .is_none_or(|handler| !handler.names().contains(&name))
            {
                return Err(failed("bound handler does not implement its declared tool"));
            }
            let mut registration = entry.registration.clone();
            if let Some(provider) = binding.provider_tools.get(&name) {
                provider.validate().map_err(failed)?;
                if registration.semantics != maka_runtime::tools::ToolSemantics::Parallel {
                    return Err(failed("provider tools cannot control Host turn settlement"));
                }
                registration.definition.provider = Some(provider.clone());
                registration.nesting = maka_runtime::tools::ToolNesting::DirectOnly;
            }
            if let Some(handler) = binding.handler {
                registration.handler = ToolHandler::Prepared(Arc::new(Guarded {
                    handler: ToolHandler::Prepared(handler),
                    owner: contribution,
                    calls: captured.call_issuer(),
                }));
            }
            entries.insert(
                name,
                Arc::new(RegisteredTool {
                    always_visible: entry.always_visible,
                    registration,
                    validator: entry.validator.clone(),
                    bytes: entry.bytes,
                }),
            );
        }
        let bytes = serde_json::to_vec(&self.definitions().collect::<Vec<_>>()).map_err(failed)?;
        if bytes.len() > 1024 * 1024 {
            return Err(failed("bound tool catalog exceeds 1 MiB"));
        }
        Ok(context)
    }
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
