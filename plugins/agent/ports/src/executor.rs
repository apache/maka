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

use futures_util::future::BoxFuture;
use maka_agent_facts::durable::ExecutionIdentity;
use maka_agent_facts::executor::ExecutorId;
use maka_agent_facts::executor::Output;
use maka_agent_facts::input::MessageInput;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    #[serde(default)]
    pub thinking: bool,
    #[serde(default)]
    pub tool_activity: bool,
    #[serde(default)]
    pub attachments: bool,
    /// Can initialize a new conversation from Host-owned copied history through
    /// the public history APIs. The Host never copies opaque provider state.
    #[serde(default)]
    pub history_copy: bool,
}

/// Non-secret choices visible in the plugin's scope; discovery grants no execution authority.
pub trait Executors: Send + Sync {
    fn search(&self, query: Search) -> BoxFuture<'_, Result<SearchResult, crate::Error>>;
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Search {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub cursor: Option<Cursor>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    pub query: String,
    pub generation: uuid::Uuid,
    pub revision: u64,
    pub scope: maka_plugin_core::scope::Scope,
    pub offset: u64,
}
impl Search {
    pub fn validate(&self) -> Result<(), crate::Error> {
        if self.query.chars().any(char::is_control)
            || self.cursor.as_ref().is_some_and(|cursor| {
                cursor.query.chars().any(char::is_control)
                    || cursor.revision > (1 << 53) - 1
                    || cursor.offset > (1 << 53) - 1
            })
        {
            return Err(crate::Error::Invalid(
                "invalid executor search query".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choice {
    pub id: ExecutorId,
    pub display_name: String,
    pub capabilities: Capabilities,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choices {
    pub revision: u64,
    pub executors: Vec<Choice>,
    pub complete: bool,
    pub next_cursor: Option<Cursor>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SearchResult {
    Page { page: Choices },
    Stale,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    #[serde(default)]
    pub scope: maka_plugin_core::scope::Scope,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub cursor: Option<Cursor>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub task_id: maka_agent_facts::durable::ExternalTaskId,
    pub language: maka_agent_facts::language::Language,
    pub execution: ExecutionIdentity,
    pub conversation_key: String,
    pub content: MessageInput,
    pub cwd: String,
    pub instructions: Option<String>,
    pub settings: maka_agent_facts::executor::Settings,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "ExecutorOutcome")]
pub enum Outcome {
    Completed {
        /// Final completed assistant message, or no answer for a tool-only turn.
        message_id: Option<String>,
    },
    Cancelled {
        reason: Option<String>,
    },
    Failed {
        message: String,
        code: Option<String>,
        #[serde(default)]
        recoverable: bool,
    },
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum Error {
    #[error("external task Root observation retired")]
    ObservationRetired,
    #[error("{diagnostic}")]
    Blocked {
        reason: maka_agent_facts::durable::BlockerKind,
        diagnostic: String,
    },
    #[error("external task isolation unavailable: {0}")]
    IsolationUnavailable(String),
    #[error("executor outcome is unknown")]
    Unknown,
    #[error("executor registration retired")]
    Retired,
    #[error("execution cancelled by caller")]
    Cancelled,
    #[error("executor did not settle after cancellation")]
    CleanupUnconfirmed,
    #[error("invalid executor input or output: {0}")]
    Invalid(String),
    #[error("executor output persistence failed: {0}")]
    Persistence(String),
    #[error("executor failed: {0}")]
    Provider(String),
}

/// Resolves only after the observation is committed. Consumer loss does not
/// undo accepted execution or permit unbounded output buffering.
pub trait OutputSink: Send + Sync {
    fn emit(&self, output: Output) -> BoxFuture<'_, Result<(), Error>>;
}
#[derive(Clone)]
pub struct Context {
    pub cancellation: CancellationToken,
    pub output: Arc<dyn OutputSink>,
    /// Issued by the embedding Host after admission, never reconstructed from
    /// Request.execution. Absent in embedders without system capabilities.
    pub call: Option<maka_capabilities::call::Scope>,
}
pub trait Provider: Send + Sync {
    fn execute(
        &self,
        request: Request,
        context: Context,
    ) -> BoxFuture<'static, Result<Outcome, Error>>;
}

pub struct Admitted {
    pub identity: maka_agent_facts::executor::Binding,
    pub execution: Box<dyn Execution>,
}
pub trait Execution: Send {
    fn execute(
        self: Box<Self>,
        custody: Arc<dyn maka_plugin_core::work::WorkCustody>,
        output: Arc<dyn OutputSink>,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Settlement>;
}

/// Physical evidence from the same original Root owner, never private job EOF.
pub trait RootSettlementOwner: Send + Sync {
    fn original_root_cleanup(&self) -> maka_plugin_core::operation::OperationCleanup;
    fn original_root_cleanup_signal(self: Arc<Self>) -> BoxFuture<'static, ()>;
}
impl RootSettlementOwner for () {
    fn original_root_cleanup_signal(self: Arc<Self>) -> BoxFuture<'static, ()> {
        Box::pin(std::future::pending())
    }
    fn original_root_cleanup(&self) -> maka_plugin_core::operation::OperationCleanup {
        maka_plugin_core::operation::OperationCleanup::Confirmed
    }
}
impl<T: RootSettlementOwner + ?Sized + 'static> RootSettlementOwner for Arc<T> {
    fn original_root_cleanup_signal(self: Arc<Self>) -> BoxFuture<'static, ()> {
        (*self).clone().original_root_cleanup_signal()
    }
    fn original_root_cleanup(&self) -> maka_plugin_core::operation::OperationCleanup {
        (**self).original_root_cleanup()
    }
}

/// Keep this value alive until the Host commits the terminal execution fact.
pub struct Settlement {
    pub result: Result<Outcome, Error>,
    /// This caller's actual Root resources, independent of provider job cleanup.
    pub root_cleanup: maka_plugin_core::operation::OperationCleanup,
    _lease: Arc<dyn RootSettlementOwner>,
}
impl Settlement {
    pub fn original_root_cleanup_signal(&self) -> BoxFuture<'static, ()> {
        self._lease.clone().original_root_cleanup_signal()
    }
    pub fn observe_root_cleanup(&mut self) {
        if self.root_cleanup != maka_plugin_core::operation::OperationCleanup::Confirmed {
            self.root_cleanup = self._lease.original_root_cleanup();
        }
    }
    /// The actual admitted owner remains alive through the canonical terminal commit.
    pub fn new(
        result: Result<Outcome, Error>,
        root_cleanup: maka_plugin_core::operation::OperationCleanup,
        owner: impl RootSettlementOwner + 'static,
    ) -> Self {
        Self {
            result,
            root_cleanup,
            _lease: Arc::new(owner),
        }
    }
}
