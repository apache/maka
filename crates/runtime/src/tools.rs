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

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::event::{EventSink, Invocation};

mod journal;
mod preparation;
mod provider;
use crate::tool_call::ToolCallIdentity;
pub use journal::ToolJournal;
pub use preparation::{
    PreparationFuture, PreparedEffect, ToolCallContext, ToolHandler, ToolNesting, ToolPreparer,
    ToolRegistration, ToolSemantics,
};
pub use provider::{ModelToolContext, ProviderTool, ProviderToolProtocol};

/// A callable function's closed contract; only its JSON Schema is open-ended.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolDefinition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderTool>,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    /// Native freeform transport where supported; input_schema is the JSON fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freeform: Option<FreeformGrammar>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "syntax", rename_all = "snake_case", deny_unknown_fields)]
pub enum FreeformGrammar {
    Lark { definition: String },
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum ToolError {
    /// An ordinary tool failure with a known outcome.
    #[error("tool failed: {0}")]
    Failed(String),
    /// A completed filesystem operation that failed before making its effect.
    #[error("tool I/O failed: {message}")]
    Io {
        kind: std::io::ErrorKind,
        message: String,
    },
    #[error("tool persistence failed: {0}")]
    Persistence(String),
    /// The worker has stopped; its external effect cannot be confirmed.
    #[error("tool effect outcome unknown: {0}")]
    OutcomeUnknown(String),
    /// The worker or its resources may still be active. Do not admit more work.
    #[error("tool cleanup unconfirmed: {0}")]
    CleanupUnconfirmed(String),
}

pub type ToolFuture<T = Value> = Pin<Box<dyn Future<Output = Result<T, ToolError>> + Send>>;

/// Returning means effects have settled. An executor must report uncertainty
/// explicitly; a generic failed result cannot stand for an unknown side effect.
pub trait ToolExecutor: Send + Sync + 'static {
    fn names(&self) -> Vec<String>;
    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture;
}

/// Durable dispatch precedes effects, and durable outcomes precede delivery.
/// The inner executor does not own invocation terminal facts.
pub struct JournaledTools {
    journal: ToolJournal,
    executor: Arc<dyn ToolExecutor>,
}

impl JournaledTools {
    pub fn new(
        sink: Arc<dyn EventSink>,
        invocation: Invocation,
        executor: Arc<dyn ToolExecutor>,
    ) -> Self {
        Self {
            journal: ToolJournal::new(sink, invocation),
            executor,
        }
    }
}

impl ToolExecutor for JournaledTools {
    fn names(&self) -> Vec<String> {
        self.executor.names()
    }

    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        if cancellation.is_cancelled() {
            return Box::pin(async { Err(ToolError::Failed("cancelled before dispatch".into())) });
        }
        let executor = self.executor.clone();
        let effect_name = name.clone();
        let effect_input = input.clone();
        self.journal.invoke_call_with(
            Uuid::new_v4().to_string(),
            ToolCallIdentity::standalone(Uuid::new_v4().to_string()),
            name,
            input,
            cancellation,
            move |cancellation| executor.invoke(effect_name, effect_input, cancellation),
        )
    }
}
