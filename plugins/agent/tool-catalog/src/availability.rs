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

/// Session-owned discovery preferences, never executable capabilities. Runs
/// borrow this one source; each request still captures the current catalog.
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
    pub fn clear(&self) -> Result<(), ToolError> {
        self.0.update_loaded(BTreeSet::clear).map_err(state_error)
    }
    pub fn snapshot(&self) -> Result<BTreeSet<String>, ToolError> {
        self.0.loaded().map_err(state_error)
    }
}
fn state_error(error: maka_session_state::Error) -> ToolError {
    // Storage failure is fatal even after a successful tool journal settlement.
    // Ordinary Failed errors are model-visible tool outcomes and may continue.
    ToolError::Persistence(error.to_string())
}

#[derive(Clone)]
pub struct Availability {
    catalog: ToolCatalog,
    names: Arc<[String]>,
    behavior: Option<maka_agent_facts::execution::BehaviorId>,
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
        invocation: maka_agent_facts::event::Invocation,
        execution: Option<std::sync::Arc<dyn maka_agent_facts::tools::ExecutionCustody>>,
        cwd: String,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<Self, ToolError> {
        let mut catalog = self.catalog.clone();
        let request = crate::request::BindingRequest {
            behavior: self.behavior.clone(),
            model,
            invocation,
            execution,
            cwd,
            tools: BTreeSet::new(),
            available_tools: self.names.clone(),
            cancellation,
        };
        catalog.bind_native_request(request).await?;
        // Only the complete, successfully bound catalog is authoritative here.
        // Base and nested-only views would erase live DirectOnly names.
        self.loaded
            .0
            .update_loaded(|names| names.retain(|name| catalog.contains(name)))
            .map_err(state_error)?;
        Ok(self.with_subset(catalog))
    }

    pub fn new(catalog: ToolCatalog, loaded: LoadedTools) -> Self {
        Self {
            names: catalog.names().into(),
            catalog,
            behavior: None,
            loaded,
        }
    }
    pub fn set_behavior(&mut self, behavior: maka_agent_facts::execution::BehaviorId) {
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
            behavior: self.behavior.clone(),
            loaded: self.loaded.clone(),
        }
    }

    pub fn direct_only(&self) -> ToolCatalog {
        self.catalog.direct_only()
    }
    pub fn digest(&self) -> String {
        self.catalog.digest()
    }
    pub fn snapshot(&self) -> Result<ToolCatalog, ToolError> {
        let active = self.loaded.snapshot()?;
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
    pub fn checkpoint(&self) -> Result<maka_agent_facts::handoff::HandoffTools, ToolError> {
        Ok(maka_agent_facts::handoff::HandoffTools {
            catalog_digest: self.catalog.digest(),
            // Names survive handoff; implementations and grants do not. The
            // successor intersects them with its freshly bound capabilities.
            loaded: self.loaded.snapshot()?,
        })
    }

    pub fn restore(
        &self,
        checkpoint: &maka_agent_facts::handoff::HandoffTools,
    ) -> Result<(), ToolError> {
        if checkpoint.catalog_digest != self.catalog.digest()
            || checkpoint
                .loaded
                .iter()
                .any(|name| name.is_empty() || name.len() > 128)
        {
            return Err(ToolError::Failed("handoff tool catalog changed".into()));
        }
        self.loaded
            .0
            .update_loaded(|names| *names = checkpoint.loaded.clone())
            .map_err(state_error)?;
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
                "Find tools by name or description. Matches become callable on the next model step. Loaded names persist in this Session until successful compaction or Host restart; current permissions and availability apply. Inventory: {}.",
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
                serde_json::to_value(availability.search(&input)?)
                    .map(Into::into)
                    .map_err(|error| ToolError::Failed(error.to_string()))
            })
        }))
    }
    /// Delivery from ToolJournal proves T2 committed. These preferences change only
    /// future snapshots; neither an in-flight step nor its captured effects widen.
    pub fn settled(&self, name: &str, result: &Value) -> Result<(), ToolError> {
        if name != SEARCH || !self.enabled() {
            return Ok(());
        }
        let result: SearchResult = serde_json::from_value(result.clone()).map_err(|error| {
            ToolError::OutcomeUnknown(format!("invalid committed search result: {error}"))
        })?;
        self.loaded
            .0
            .update_loaded(|names| names.extend(result.activated))
            .map_err(state_error)?;
        Ok(())
    }
    fn direct(&self, name: &str) -> bool {
        self.catalog.always_visible(name) || direct(name)
    }

    fn search(&self, input: &SearchInput) -> Result<SearchResult, ToolError> {
        let active = self.loaded.snapshot()?;
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

#[cfg(test)]
mod state_tests {
    use super::*;

    #[test]
    fn binding_ceiling_names_share_refresh_and_outlive_only_their_catalog_data() {
        use crate::request::{BindingFuture, BindingRequest, BoundTool, RequestBinding};
        use crate::{
            PreparationFuture, ToolCallContext, ToolHandler, ToolNesting, ToolPreparer,
            ToolRegistration, ToolSemantics,
        };
        use maka_agent_facts::event::Invocation;
        use std::{
            collections::BTreeMap,
            future::Future,
            sync::Mutex,
            task::{Context, Poll, Waker},
        };

        struct Handler;
        impl ToolPreparer for Handler {
            fn names(&self) -> Vec<String> {
                ["alpha", "beta", "gamma"].map(str::to_owned).into()
            }
            fn prepare(
                &self,
                _: String,
                _: Value,
                _: ToolCallContext,
                _: tokio_util::sync::CancellationToken,
            ) -> PreparationFuture {
                Box::pin(async { Err(ToolRejection::Unavailable) })
            }
        }
        struct Capture {
            selected: BTreeSet<String>,
            ceiling: Arc<[String]>,
        }
        struct Binding(Arc<Mutex<Vec<Capture>>>);
        impl RequestBinding for Binding {
            fn bind(&self, request: BindingRequest) -> BindingFuture {
                self.0.lock().unwrap().push(Capture {
                    selected: request.tools.clone(),
                    ceiling: request.available_tools.clone(),
                });
                let projected = request
                    .tools
                    .into_iter()
                    .map(|name| {
                        let tool = if request.cwd == "drop-alpha" && name == "alpha" {
                            BoundTool::Unavailable
                        } else {
                            BoundTool::Prepared(Arc::new(Handler))
                        };
                        (name, tool)
                    })
                    .collect::<BTreeMap<_, _>>();
                Box::pin(async move { Ok(projected) })
            }
        }
        fn capture(view: &Availability, cwd: &str) -> Availability {
            let mut pending = std::pin::pin!(view.capture(
                None,
                Invocation {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                None,
                cwd.into(),
                tokio_util::sync::CancellationToken::new()
            ));
            match pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
            {
                Poll::Ready(result) => result.unwrap(),
                Poll::Pending => panic!("fixture binding has no asynchronous external work"),
            }
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let binding = Arc::new(Binding(seen.clone()));
        let catalog = ToolCatalog::new(["alpha", "beta", "gamma"].map(|name| ToolRegistration {
            definition: ToolDefinition {
                name: name.into(),
                description: name.into(),
                input_schema: serde_json::json!({"type":"string"}),
                provider: None,
                output_schema: None,
                freeform: None,
            },
            nesting: if name == "gamma" {
                ToolNesting::DirectOnly
            } else {
                ToolNesting::Nestable
            },
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Prepared(Arc::new(Handler)),
        }))
        .unwrap()
        .with_request_binding(BTreeSet::from(["alpha".into()]), binding.clone())
        .unwrap()
        .with_request_binding(BTreeSet::from(["beta".into(), "gamma".into()]), binding)
        .unwrap();
        let definition = Arc::downgrade(&catalog.shared_definitions().next().unwrap());
        let view = Availability::new(catalog, LoadedTools::temporary().unwrap());
        let first = capture(&view, "keep");
        let narrowed = capture(&view, "drop-alpha");
        let refreshed = capture(&narrowed, "keep");
        let nested = narrowed.nested();
        let nested_capture = capture(&nested, "keep");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 6);
        assert_eq!(seen[0].selected, BTreeSet::from(["alpha".into()]));
        assert_eq!(
            seen[1].selected,
            BTreeSet::from(["beta".into(), "gamma".into()])
        );
        assert_eq!(seen[0].ceiling.as_ref(), ["alpha", "beta", "gamma"]);
        for next in &seen[1..4] {
            assert!(Arc::ptr_eq(&seen[0].ceiling, &next.ceiling));
        }
        assert_eq!(seen[4].ceiling.as_ref(), ["beta", "gamma"]);
        assert!(!Arc::ptr_eq(&seen[0].ceiling, &seen[4].ceiling));
        assert_eq!(seen[5].selected, BTreeSet::from(["beta".into()]));
        assert_eq!(seen[5].ceiling.as_ref(), ["beta"]);
        assert!(first.all().contains("alpha"));
        assert!(!refreshed.all().contains("alpha"));
        drop((view, first, narrowed, refreshed, nested, nested_capture));
        assert!(
            definition.upgrade().is_none(),
            "retained name snapshots must not retain tool definitions"
        );
        assert_eq!(seen[0].ceiling.as_ref(), ["alpha", "beta", "gamma"]);
    }

    #[test]
    fn discovery_handles_restore_clear_and_retire_together() {
        let backend = maka_session_state::Backend::temporary().unwrap();
        let session = backend.session("s");
        let first = LoadedTools::new(session.clone());
        let catalog = ToolCatalog::default();
        let view = Availability::new(catalog.clone(), first.clone());
        let checkpoint = maka_agent_facts::handoff::HandoffTools {
            catalog_digest: catalog.digest(),
            loaded: BTreeSet::from(["preference-without-authority".into()]),
        };
        view.restore(&checkpoint).unwrap();
        drop(first);
        let restored = LoadedTools::new(backend.session("s"));
        assert_eq!(restored.snapshot().unwrap(), checkpoint.loaded);
        assert!(
            !view
                .snapshot()
                .unwrap()
                .contains("preference-without-authority")
        );
        restored.clear().unwrap();
        assert!(view.checkpoint().unwrap().loaded.is_empty());
        session.retire().unwrap();
        assert!(matches!(
            restored.snapshot(),
            Err(ToolError::Persistence(_))
        ));
        assert!(matches!(restored.clear(), Err(ToolError::Persistence(_))));
        assert!(matches!(
            view.restore(&checkpoint),
            Err(ToolError::Persistence(_))
        ));
        assert!(matches!(view.snapshot(), Err(ToolError::Persistence(_))));
        assert!(LoadedTools::new(backend.session("s")).snapshot().is_err());
    }
}
