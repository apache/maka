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

use crate::health::{Health, Input};
use futures_util::future::BoxFuture;
use maka_plugins::{
    composition::Scope,
    contributions::Staged,
    kernel::{Plugin, PluginContext},
};
use maka_runtime::{
    tool_call::ToolRejection,
    tools::{
        PreparationFuture, PreparedEffect, ToolCallContext, ToolDefinition, ToolError, ToolHandler,
        ToolNesting, ToolPreparer, ToolRegistration, ToolSemantics,
    },
};
use maka_tool_catalog::plugins::PluginTool;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
pub const ID: &str = "maka.background-health";
pub const TOOL: &str = "BackgroundTaskHealth";
pub struct Builtin;
impl Plugin for Builtin {
    fn supports_scope(&self, scope: &Scope) -> bool {
        matches!(scope, Scope::Profile | Scope::Session(_))
    }
    fn validate(&self, _: &Scope, config: &Value) -> Result<(), maka_plugins::Error> {
        if config.is_null() || config.as_object().is_some_and(|v| v.is_empty()) {
            Ok(())
        } else {
            Err(maka_plugins::Error::Invalid(
                "Background health takes no instance configuration".into(),
            ))
        }
    }
    fn activate(
        &self,
        context: PluginContext,
        _: Value,
    ) -> BoxFuture<'static, Result<Staged, String>> {
        Box::pin(async move {
            let host = context
                .host
                .ok_or("Background health requires Host capabilities")?;
            let health = Arc::new(Health {
                files: host.files,
                http: host.http,
                preferences: host.preferences,
            });
            let tool = PluginTool::new(ToolRegistration {
                definition: ToolDefinition {
                    freeform: None, output_schema: None, provider: None,
                    name: TOOL.into(),
                    description: "Check a tracked background task returned by Shell and optionally \
                        an HTTP(S) endpoint. Reports process state separately from HTTP readiness; \
                        a healthy endpoint does not prove listener ownership or browser readiness. \
                        Uses HEAD with one GET fallback for 405/501, never follows redirects and \
                        discards bodies. Logs are omitted unless include_logs is true. Endpoint \
                        probing uses Host network timeouts; elapsed time includes permission approval."
                        .into(),
                    input_schema: schemars::schema_for!(Input).into(),
                },
                nesting: ToolNesting::Nestable,
                semantics: ToolSemantics::Parallel,
                handler: ToolHandler::Prepared(health),
            })
            .map_err(|error| error.to_string())?
            .always_visible();
            let mut staged = Staged::default();
            staged.insert(TOOL, tool).map_err(|e| e.to_string())?;
            Ok(staged)
        })
    }
}
impl ToolPreparer for Health {
    fn names(&self) -> Vec<String> {
        vec![TOOL.into()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        _: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let health = self.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            if name != TOOL {
                return Err(ToolRejection::Unavailable);
            }
            let input: Input =
                serde_json::from_value(input).map_err(|e| ToolRejection::InvalidInput {
                    message: e.to_string(),
                })?;
            input
                .validate()
                .map_err(|message| ToolRejection::InvalidInput { message })?;
            Ok(PreparedEffect::new(move |_| {
                Box::pin(async move {
                    let scope = maka_plugins::call::current().ok_or_else(|| {
                        ToolError::Failed(
                            "Background health requires an admitted Agent call".into(),
                        )
                    })?;
                    let report = health.check(&scope, input).await?;
                    Ok(serde_json::to_value(report)
                        .map_err(|e| ToolError::Failed(e.to_string()))?
                        .into())
                })
            }))
        })
    }
}
