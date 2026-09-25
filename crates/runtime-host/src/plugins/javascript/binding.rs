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

//! A JS closure is pinned by the same request binding as a native handler.
use super::callbacks::{self, Callback};
use maka_plugins::filesystem::ReadDirectory;
use maka_runtime::tools::{PreparationFuture, ToolCallContext, ToolError, ToolPreparer};
use maka_tools::plugins::{Binding, BindingProvider, BindingRequest};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) struct Provider {
    pub callback: Arc<Callback>,
    pub names: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Captured {
    callback: u32,
    #[serde(default, rename = "providerTools")]
    provider_tools: std::collections::BTreeMap<String, maka_runtime::tools::ProviderTool>,
    context: Option<String>,
}
impl BindingProvider for Provider {
    fn bind(
        &self,
        request: BindingRequest,
        workspace: ReadDirectory,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Binding>, ToolError>> + Send>> {
        let callback = self.callback.clone();
        let names = self.names.clone();
        Box::pin(async move {
            let view = callback
                .calls
                .borrow_read(workspace)
                .map_err(|error| ToolError::Failed(error.to_string()))?;
            let value = callbacks::invoke(
                &callback.module,
                callback.id,
                json!({"invocation":request.invocation, "behavior":request.behavior, "cwd":request.cwd, "tools":request.tools, "model":request.model}),
                json!({"readView":view.id}),
                request.cancellation,
            )
            .await?;
            let captured: Option<Captured> = serde_json::from_value(value)
                .map_err(|error| ToolError::Failed(error.to_string()))?;
            let Some(captured) = captured else {
                return Ok(None);
            };
            if captured.callback == 0 && captured.provider_tools.is_empty() {
                return Err(ToolError::Failed("invalid bound callback identity".into()));
            }
            Ok(Some(Binding {
                provider_tools: captured.provider_tools,
                handler: (captured.callback != 0).then(|| {
                    Arc::new(Bound {
                        names,
                        callback: Arc::new(Callback {
                            module: callback.module.clone(),
                            id: captured.callback,
                            calls: callback.calls.clone(),
                        }),
                    }) as Arc<dyn ToolPreparer>
                }),
                context: captured.context,
            }))
        })
    }
}

/// A staged definition cannot run without passing through request capture.
impl ToolPreparer for Provider {
    fn names(&self) -> Vec<String> {
        self.names.clone()
    }
    fn prepare(
        &self,
        _: String,
        _: Value,
        _: ToolCallContext,
        _: CancellationToken,
    ) -> PreparationFuture {
        Box::pin(async { Err(maka_runtime::tool_call::ToolRejection::Unavailable) })
    }
}
struct Bound {
    names: Vec<String>,
    callback: Arc<Callback>,
}
impl ToolPreparer for Bound {
    fn names(&self) -> Vec<String> {
        self.names.clone()
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        callbacks::Tool {
            name: name.clone(),
            callback: self.callback.clone(),
        }
        .prepare(
            name.clone(),
            json!({"name": name, "input": input}),
            context,
            cancellation,
        )
    }
}
