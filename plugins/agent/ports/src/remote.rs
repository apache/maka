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

//! Client-facing handlers are distinct from Agent tools: a UI call never fabricates
//! an Agent invocation or inherits its permissions.
pub mod executor_session;
pub mod projects;
use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
pub struct Caller {
    /// Captured transport identity; never chosen by a Client payload.
    pub connection_id: Uuid,
    pub client_instance_id: String,
    pub document_id: Uuid,
    pub session_id: Option<String>,
    /// Captured endpoint requirement after transport authorization, not input.
    pub access: Access,
    /// Host-bound views capture the original caller. Changing metadata above
    /// cannot retarget or elevate this capability.
    pub views: Arc<dyn Views>,
    /// Canonical writes use captured caller authority, separately from observations.
    pub controls: Arc<dyn Controls>,
    pub resources: Arc<maka_capabilities::call::Resources>,
    pub cancellation: CancellationToken,
}

/// Read-only user-request scope, including a borrowed workspace capability.
/// The projection is observation; only `files` permits bounded filesystem reads.
pub struct SessionView {
    pub workspace: maka_agent_facts::execution::WorkspaceProjection,
    pub tools: std::collections::HashSet<String>,
    pub files: maka_capabilities::filesystem::ReadDirectory,
}

/// A proposed Session view does not create a Session or grant execution rights.
/// Endpoints accepting Host paths must declare `Access::HostPaths`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceViewInput {
    pub workspace: maka_agent_facts::execution::WorkspaceTarget,
    pub sandbox_mode: maka_agent_facts::execution::SandboxMode,
    pub collaboration_mode: maka_agent_facts::execution::CollaborationMode,
}
pub trait Views: Send + Sync {
    fn executor_session(
        &self,
        _session: String,
    ) -> BoxFuture<'_, Result<Option<executor_session::Session>, Error>> {
        Box::pin(async { Err(Error::Invalid("Session control is unavailable".into())) })
    }
    fn executor_creation(
        &self,
        _input: executor_session::Create,
    ) -> BoxFuture<'_, Result<Option<executor_session::Session>, Error>> {
        Box::pin(async { Err(Error::Invalid("Creation receipts are unavailable".into())) })
    }

    fn preferences(&self) -> BoxFuture<'_, Result<crate::preferences::Snapshot, Error>> {
        Box::pin(async { Err(Error::Invalid("Preferences are unavailable".into())) })
    }

    fn projects(&self, _query: projects::Query) -> BoxFuture<'_, Result<projects::Output, Error>> {
        Box::pin(async { Err(Error::Invalid("Project catalog is unavailable".into())) })
    }
    fn authorize(
        &self,
        request: maka_capabilities::authorization::Request,
    ) -> BoxFuture<'_, Result<maka_capabilities::call::Owned, Error>>;
    fn session(&self) -> BoxFuture<'_, Result<SessionView, Error>>;
    fn workspace(&self, input: WorkspaceViewInput) -> BoxFuture<'_, Result<SessionView, Error>>;
    /// Consistent SELECT batch over an explicit trusted Host pathname and its
    /// SQLite sidecars. Requires HostPaths; never accepts a read-view handle.
    fn query_database(
        &self,
        input: maka_capabilities::filesystem::database::Read,
    ) -> BoxFuture<
        '_,
        Result<
            Vec<maka_capabilities::filesystem::database::Table>,
            maka_capabilities::filesystem::database::Error,
        >,
    >;
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum Error {
    #[error("remote registration retired")]
    Retired,
    #[error("remote request cancelled")]
    Cancelled,
    #[error("invalid remote request or result: {0}")]
    Invalid(String),
    #[error("remote provider failed: {0}")]
    Provider(String),
    /// The provider cannot prove whether its operation committed. Recovery,
    /// not blind retry, determines the result; resource cleanup is independent.
    #[error("remote operation outcome is unknown: {0}")]
    OutcomeUnknown(String),
    #[error("remote resource cleanup is unconfirmed")]
    CleanupUnconfirmed,
}

pub trait Method: Send + Sync {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>>;
}
#[derive(Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// The caller's existing Remote grant is sufficient.
    #[default]
    Granted,
    /// The Host must additionally authorize caller-supplied filesystem paths.
    HostPaths,
}
/// User-requested canonical mutations; no Agent or ambient execution authority.
/// Embeddings without this capability reject writes by default.
pub trait Controls: Send + Sync {
    fn create_executor_session(
        &self,
        _input: executor_session::Create,
    ) -> BoxFuture<'_, Result<executor_session::Session, Error>> {
        Box::pin(async { Err(Error::Invalid("Session creation is unavailable".into())) })
    }
    fn configure_executor_session(
        &self,
        _input: executor_session::Configure,
    ) -> BoxFuture<'_, Result<executor_session::Configured, Error>> {
        Box::pin(async {
            Err(Error::Invalid(
                "Session configuration is unavailable".into(),
            ))
        })
    }
    fn update_preferences(
        &self,
        _update: crate::preferences::Update,
    ) -> BoxFuture<'_, Result<crate::preferences::Updated, Error>> {
        Box::pin(async { Err(Error::Invalid("Preference edits are unavailable".into())) })
    }
}
impl Controls for () {}
