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

//! Per-request projection of explicitly registered tools. A projection can
//! narrow availability or replace its own handler/descriptor, never add a name.

use crate::{CatalogError, ToolCatalog};
use maka_agent_facts::tools::ProviderTool;
use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolHandler;
use maka_agent_facts::tools::ToolNesting;
use maka_agent_facts::tools::ToolPreparer;
use maka_agent_facts::tools::ToolSemantics;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use std::{future::Future, pin::Pin};
pub enum BoundTool {
    Unavailable,
    Prepared(Arc<dyn ToolPreparer>),
    /// Update descriptive process state without changing schema or authority.
    Described {
        handler: Arc<dyn ToolPreparer>,
        description: String,
    },
    /// A request-scoped model input projection; execution retains its registered binding.
    Input {
        handler: Arc<dyn ToolPreparer>,
        schema: serde_json::Value,
    },
    Provider(ProviderTool),
}
pub type BindingFuture =
    Pin<Box<dyn Future<Output = Result<BTreeMap<String, BoundTool>, ToolError>> + Send>>;
pub trait RequestBinding: Send + Sync {
    fn bind(&self, request: BindingRequest) -> BindingFuture;
}
#[derive(Clone)]
pub(crate) struct Group {
    names: BTreeSet<String>,
    binding: Arc<dyn RequestBinding>,
}
impl ToolCatalog {
    pub fn with_request_binding(
        mut self,
        names: BTreeSet<String>,
        binding: Arc<dyn RequestBinding>,
    ) -> Result<Self, CatalogError> {
        if names.is_empty()
            || names.iter().any(|name| {
                !self.entries.contains_key(name)
                    || self
                        .request_bindings
                        .iter()
                        .any(|group| group.names.contains(name))
            })
        {
            return Err(CatalogError::Invalid(
                "request binding must own distinct registered tools".into(),
            ));
        }
        Arc::make_mut(&mut self.request_bindings).push(Group { names, binding });
        Ok(self)
    }
    pub(crate) async fn bind_native_request(
        &mut self,
        request: BindingRequest,
    ) -> Result<(), ToolError> {
        for group in self.request_bindings.iter() {
            let selected: BTreeSet<_> = group
                .names
                .iter()
                .filter(|name| self.entries.contains_key(*name))
                .cloned()
                .collect();
            if selected.is_empty() {
                continue;
            }
            let mut input = request.clone();
            input.tools = selected.clone();
            // The embedding owns cancellation and actual cleanup of this work.
            let bound = group.binding.bind(input).await?;
            if !bound.keys().eq(selected.iter()) {
                return Err(ToolError::Failed(
                    "request binding changed its registered tool names".into(),
                ));
            }
            for (name, projection) in bound {
                let entries = Arc::make_mut(&mut self.entries);
                let entry = entries.get(&name).expect("selected entry");
                let mut projected = (**entry).clone();
                let handler = match projection {
                    BoundTool::Described {
                        handler,
                        description,
                    } => {
                        if description.trim().is_empty() {
                            return Err(ToolError::Failed(
                                "request tool description invalid".into(),
                            ));
                        }
                        if projected.definition.description != description {
                            Arc::make_mut(&mut projected.definition).description = description;
                        }
                        Some(handler)
                    }
                    BoundTool::Input { handler, schema } => {
                        if schema != projected.definition.input_schema {
                            projected.validator = Arc::new(
                                jsonschema::options()
                                    .offline()
                                    .should_validate_formats(false)
                                    .build(&schema)
                                    .map_err(|e| ToolError::Failed(e.to_string()))?,
                            );
                            Arc::make_mut(&mut projected.definition).input_schema = schema;
                        }
                        Some(handler)
                    }
                    BoundTool::Prepared(handler) => Some(handler),
                    BoundTool::Unavailable => {
                        entries.remove(&name);
                        continue;
                    }
                    BoundTool::Provider(provider) => {
                        provider
                            .validate()
                            .map_err(|e| ToolError::Failed(e.into()))?;
                        if projected.definition.provider.as_ref() != Some(&provider) {
                            Arc::make_mut(&mut projected.definition).provider = Some(provider);
                        }
                        projected.nesting = ToolNesting::DirectOnly;
                        projected.semantics = ToolSemantics::Parallel;
                        None
                    }
                };
                if let Some(handler) = handler {
                    if !handler.names().contains(&name) {
                        return Err(ToolError::Failed(
                            "request handler does not own its tool".into(),
                        ));
                    }
                    if projected.definition.provider.is_some() {
                        Arc::make_mut(&mut projected.definition).provider = None;
                    }
                    projected.handler = ToolHandler::Prepared(handler);
                }
                entries.insert(name, Arc::new(projected));
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct BindingRequest {
    /// Frozen behavior identity for visibility decisions, never authority.
    pub behavior: Option<maka_agent_facts::execution::BehaviorId>,
    pub model: Option<maka_agent_facts::tools::ModelToolContext>,
    pub invocation: maka_agent_facts::event::Invocation,
    pub execution: Option<Arc<dyn maka_agent_facts::tools::ExecutionCustody>>,
    pub cwd: String,
    /// This binding group's names, restricted by the Host's tool ceiling.
    pub tools: BTreeSet<String>,
    /// Complete frozen tool ceiling before individual binding groups project it.
    pub available_tools: Arc<[String]>,
    pub cancellation: tokio_util::sync::CancellationToken,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ToolDefinition, ToolRegistration};
    use maka_agent_facts::{event::Invocation, tool_call::ToolRejection};
    use serde_json::{Value, json};
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };

    struct Handler;
    impl ToolPreparer for Handler {
        fn names(&self) -> Vec<String> {
            vec!["fixture".into()]
        }
        fn prepare(
            &self,
            _: String,
            _: Value,
            _: crate::ToolCallContext,
            _: tokio_util::sync::CancellationToken,
        ) -> crate::PreparationFuture {
            Box::pin(async { Err(ToolRejection::Unavailable) })
        }
    }
    struct Binding;
    impl RequestBinding for Binding {
        fn bind(&self, request: BindingRequest) -> BindingFuture {
            Box::pin(async move {
                let handler = Arc::new(Handler);
                let projection = if request.cwd == "changed" {
                    BoundTool::Input {
                        handler,
                        schema: json!({"type":"integer"}),
                    }
                } else if request.cwd == "boolean" {
                    BoundTool::Input {
                        handler,
                        schema: json!({"type":"boolean"}),
                    }
                } else if request.cwd.starts_with("description-") {
                    BoundTool::Described {
                        handler,
                        description: request.cwd,
                    }
                } else {
                    BoundTool::Prepared(handler)
                };
                Ok(BTreeMap::from([("fixture".into(), projection)]))
            })
        }
    }
    fn capture(catalog: &mut ToolCatalog, cwd: &str) {
        let request = BindingRequest {
            execution: None,
            behavior: None,
            model: None,
            invocation: Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            },
            cwd: cwd.into(),
            tools: BTreeSet::new(),
            available_tools: Arc::default(),
            cancellation: tokio_util::sync::CancellationToken::new(),
        };
        // This fixture's binder has no external asynchronous work.
        let mut future = std::pin::pin!(catalog.bind_native_request(request));
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(result) => result.unwrap(),
            Poll::Pending => panic!("fixture binding unexpectedly waited"),
        }
    }

    #[test]
    fn request_handlers_share_descriptors_and_schema_projection_is_isolated() {
        let base = ToolCatalog::new([ToolRegistration {
            definition: ToolDefinition {
                provider: None,
                name: "fixture".into(),
                description: "catalog definition".into(),
                input_schema: json!({"type":"string"}),
                freeform: None,
                output_schema: None,
            },
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Prepared(Arc::new(Handler)),
        }])
        .unwrap()
        .with_request_binding(BTreeSet::from(["fixture".into()]), Arc::new(Binding))
        .unwrap();
        let mut first = base.excluding(&[]).with_discovery();
        let mut second = first.nested();
        let base = base.with_discovery();
        let mut excluded = base.excluding(&["fixture"]);
        capture(&mut excluded, "changed");
        assert!(excluded.names().is_empty());
        capture(&mut first, "unchanged");
        capture(&mut second, "unchanged");
        let original_owner = base.shared_definitions().next().unwrap();
        assert!(Arc::ptr_eq(
            &original_owner,
            &first.shared_definitions().next().unwrap()
        ));
        assert!(Arc::ptr_eq(
            &original_owner,
            &second.shared_definitions().next().unwrap()
        ));
        let original = original_owner.as_ref();
        assert_eq!(base.digest(), first.digest());
        capture(&mut second, "changed");
        assert!(!Arc::ptr_eq(
            &original_owner,
            &second.shared_definitions().next().unwrap()
        ));
        assert!(base.validate("fixture", &json!("original")).is_ok());
        assert!(first.validate("fixture", &json!("original")).is_ok());
        assert!(second.validate("fixture", &json!(42)).is_ok());
        assert!(second.validate("fixture", &json!("original")).is_err());
        assert_ne!(base.digest(), second.digest());
        let integer_snapshot = second.shared_definitions().next().unwrap();
        capture(&mut second, "boolean");
        let boolean_snapshot = second.shared_definitions().next().unwrap();
        assert!(!Arc::ptr_eq(&integer_snapshot, &boolean_snapshot));
        assert_eq!(integer_snapshot.input_schema, json!({"type":"integer"}));
        assert_eq!(boolean_snapshot.input_schema, json!({"type":"boolean"}));
        assert!(second.validate("fixture", &json!(true)).is_ok());
        assert!(second.validate("fixture", &json!(42)).is_err());

        capture(&mut first, "description-first");
        let first_snapshot = first.shared_definitions().next().unwrap();
        capture(&mut first, "description-second");
        let second_snapshot = first.shared_definitions().next().unwrap();
        assert!(!Arc::ptr_eq(&first_snapshot, &second_snapshot));
        assert_eq!(first_snapshot.description, "description-first");
        assert_eq!(second_snapshot.description, "description-second");
        capture(&mut first, "description-second");
        assert!(Arc::ptr_eq(
            &second_snapshot,
            &first.shared_definitions().next().unwrap()
        ));
        assert_eq!(original.input_schema, json!({"type":"string"}));
    }
}
