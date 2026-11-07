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

use crate::{CellContext, CellDiagnostic, CellDiagnosticKind, ToolCall};
use maka_agent_facts::tools::{ToolError, ToolExecutor};
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use tokio::{runtime::Handle, sync::oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub struct ToolScope {
    context: CellContext,
    executor: Arc<dyn ToolExecutor>,
    names: HashSet<String>,
    cancellation: CancellationToken,
    tasks: TaskTracker,
    host: Handle,
    calls: Mutex<Vec<ToolCall>>,
}

impl ToolScope {
    pub fn new(
        context: CellContext,
        executor: Arc<dyn ToolExecutor>,
        cancellation: CancellationToken,
        host: Handle,
    ) -> Arc<Self> {
        Arc::new(Self {
            names: executor.names().into_iter().collect(),
            context,
            executor,
            cancellation,
            tasks: TaskTracker::new(),
            host,
            calls: Mutex::new(Vec::new()),
        })
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub async fn settle(&self) {
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub fn calls(&self) -> Vec<ToolCall> {
        self.calls.lock().unwrap().clone()
    }

    pub fn start(
        self: &Arc<Self>,
        name: String,
        input: Value,
    ) -> Result<oneshot::Receiver<Result<Value, CellDiagnostic>>, CellDiagnostic> {
        if self.cancellation.is_cancelled() {
            return Err(CellDiagnostic::new(
                CellDiagnosticKind::ExecutionError,
                "cell cancelled",
            ));
        }
        if !self.names.contains(&name) {
            return Err(CellDiagnostic::new(
                CellDiagnosticKind::UnknownTool,
                format!("unknown tool: {name}"),
            ));
        }
        {
            let mut calls = self.calls.lock().unwrap();
            if self.cancellation.is_cancelled() {
                return Err(CellDiagnostic::new(
                    CellDiagnosticKind::ExecutionError,
                    "cell cancelled",
                ));
            }
            let index = calls.len() + 1;
            calls.push(ToolCall {
                index,
                name: name.clone(),
            });
        }
        let (sender, receiver) = oneshot::channel();
        let scope = self.clone();
        self.tasks.spawn_on(
            async move {
                use futures_util::FutureExt;
                let result = std::panic::AssertUnwindSafe(async {
                    if scope.cancellation.is_cancelled() {
                        return Err(ToolError::Failed(
                            "cell cancelled before tool dispatch".into(),
                        ));
                    }
                    scope
                        .executor
                        .invoke(name, input, scope.cancellation.clone())
                        .await
                })
                .catch_unwind()
                .await;
                let result = result.unwrap_or_else(|_| {
                    Err(ToolError::CleanupUnconfirmed(
                        "tool executor panicked".into(),
                    ))
                });
                if let Err(error @ (ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_))) =
                    &result
                {
                    scope.cancellation.cancel();
                    scope.context.fail(error.clone());
                }
                // The effect is settled even if user code no longer observes its result.
                let result = result.map_err(|error| {
                    let mut diagnostic =
                        CellDiagnostic::new(CellDiagnosticKind::ToolFailure, error.to_string());
                    if let ToolError::Native(error) = error {
                        diagnostic.native = Some(error);
                    }
                    diagnostic
                });
                let _ = sender.send(result);
            },
            &self.host,
        );
        Ok(receiver)
    }
}
