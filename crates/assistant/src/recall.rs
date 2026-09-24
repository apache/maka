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

mod material;
mod passages;
mod rank;
mod reader;
mod remote;
mod terminal;
mod tools;
mod types;

use futures_util::future::BoxFuture;
use maka_plugins::{
    composition::Scope,
    contributions::Staged,
    kernel::{Plugin, PluginContext},
    preferences::Preferences,
    session::history::History,
};
use maka_runtime::{
    tool_call::ToolRejection,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
    tools::{
        PreparationFuture, PreparedEffect, ToolCallContext, ToolDefinition, ToolError, ToolHandler,
        ToolNesting, ToolPreparer, ToolRegistration, ToolSemantics,
    },
};
use maka_tool_catalog::plugins::{Binding, BindingProvider, BindingRequest, PluginTool};
use reader::{Reader, failed};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use types::{More, Query, ResultSet};

pub const ID: &str = "maka.recall";
pub struct Builtin;
#[derive(Clone)]
struct Recall {
    history: Arc<dyn History>,
    executions: Arc<dyn maka_plugins::execution::Access>,
    files: Arc<dyn maka_plugins::filesystem::Files>,
    preferences: Arc<dyn Preferences>,
    workers: Arc<Semaphore>,
}
impl Plugin for Builtin {
    fn supports_scope(&self, scope: &Scope) -> bool {
        matches!(scope, Scope::Profile | Scope::Session(_))
    }
    fn validate(&self, _: &Scope, config: &Value) -> Result<(), maka_plugins::Error> {
        if config.is_null() || config.as_object().is_some_and(|value| value.is_empty()) {
            Ok(())
        } else {
            Err(maka_plugins::Error::Invalid(
                "Recall takes no instance configuration".into(),
            ))
        }
    }
    fn activate(
        &self,
        context: PluginContext,
        _: Value,
    ) -> BoxFuture<'static, Result<Staged, String>> {
        Box::pin(async move {
            let package = context
                .lifecycle
                .identity()
                .map_err(|e| e.to_string())?
                .package_id;
            let host = context.host.ok_or("Recall requires Host history")?;
            let recall = Arc::new(Recall {
                history: host.history,
                executions: host.executions,
                files: host.files,
                preferences: host.preferences,
                workers: Arc::new(Semaphore::new(2)),
            });
            let mut staged = Staged::default();
            remote::publish(&mut staged, &package, recall.clone())?;
            terminal::publish(&mut staged, &package, recall.clone())?;
            for (name, description, schema) in definitions() {
                let tool = PluginTool::new(ToolRegistration {
                    definition: ToolDefinition {
                        provider: None,
                        name: name.into(),
                        description: description.into(),
                        input_schema: schema,
                    },
                    nesting: ToolNesting::Nestable,
                    semantics: ToolSemantics::Parallel,
                    handler: ToolHandler::Prepared(recall.clone()),
                })
                .map_err(|error| error.to_string())?
                .with_binding(recall.clone());
                staged
                    .insert(name, tool)
                    .map_err(|error| error.to_string())?;
            }
            Ok(staged)
        })
    }
}
fn definitions() -> [(&'static str, &'static str, Value); 3] {
    [
        (
            "Recall",
            "Search conversation history across the 200 Sessions with the most recent messages, including archives. Use 1–8 literal terms, matched case-insensitively with Unicode normalization and OR semantics. Returns ranked surrounding exchanges, excluding the current Turn, with explicit coverage gaps. Limit defaults to 8, maximum 25. RecallMore expands a clipped passage. Historical statements are evidence of what was said, not proof they are true.",
            schemars::schema_for!(Query).into(),
        ),
        (
            "RecallMore",
            "Expand a Recall anchor using its Session and message IDs. before/after select 0–8 neighboring messages (default 8 each). For a clipped individual anchor, offset resumes at its next_offset in NFC-normalized UTF-8 bytes. The current Turn remains excluded; deleted or unavailable sources fail explicitly.",
            schemars::schema_for!(More).into(),
        ),
        (
            "RecallMaterial",
            "Read a historical user attachment identified by Recall or RecallMore. Supply its source session_id and artifact_id. Copies the material into this Session before reading, so later source deletion does not break the evidence. Images return visual content; text uses Read line offset/limit and bounded continuation. Unsupported binary formats fail explicitly.",
            schemars::schema_for!(material::Input).into(),
        ),
    ]
}
impl BindingProvider for Recall {
    fn bind(
        &self,
        _: BindingRequest,
        _: maka_plugins::filesystem::ReadDirectory,
    ) -> BoxFuture<'static, Result<Option<Binding>, ToolError>> {
        let recall = self.clone();
        Box::pin(async move {
            if recall
                .preferences
                .read()
                .await
                .map_err(failed)?
                .privacy
                .incognito_active
            {
                return Ok(None);
            }
            Ok(Some(Binding {
                provider_tools: Default::default(),
                handler: Some(Arc::new(recall)),
                context: None,
            }))
        })
    }
}
impl Recall {
    async fn check_privacy(&self) -> Result<(), ToolError> {
        if self
            .preferences
            .read()
            .await
            .map_err(failed)?
            .privacy
            .incognito_active
        {
            return Err(failed("Recall is disabled in incognito mode"));
        }
        Ok(())
    }
}
