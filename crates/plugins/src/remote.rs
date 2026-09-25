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
use crate::fiber::Identity;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientIdentity {
    pub entry_id: String,
    pub extension_id: String,
    pub activation: String,
    pub content_digest: String,
    pub client_digest: String,
}

/// A registration identity, not a name that can silently resolve to new code.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub entry_id: String,
    pub activation: String,
    pub registration: Uuid,
}

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
    pub resources: Arc<crate::call::Resources>,
    pub cancellation: CancellationToken,
}

/// Read-only user-request scope, including a borrowed workspace capability.
/// The projection is observation; only `files` permits bounded filesystem reads.
pub struct SessionView {
    pub workspace: maka_runtime::execution::WorkspaceProjection,
    pub tools: std::collections::HashSet<String>,
    pub files: crate::filesystem::ReadDirectory,
}

/// A proposed Session view does not create a Session or grant execution rights.
/// Endpoints accepting Host paths must declare `Access::HostPaths`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceViewInput {
    pub workspace: maka_runtime::execution::WorkspaceTarget,
    pub sandbox_mode: maka_runtime::execution::SandboxMode,
    pub collaboration_mode: maka_runtime::execution::CollaborationMode,
}
pub trait Views: Send + Sync {
    fn authorize(
        &self,
        request: crate::authorization::Request,
    ) -> BoxFuture<'_, Result<crate::call::Owned, Error>>;
    fn session(&self) -> BoxFuture<'_, Result<SessionView, Error>>;
    fn workspace(&self, input: WorkspaceViewInput) -> BoxFuture<'_, Result<SessionView, Error>>;
    /// Consistent SELECT batch over an explicit trusted Host pathname and its
    /// SQLite sidecars. Requires HostPaths; never accepts a read-view handle.
    fn query_database(
        &self,
        input: crate::filesystem::database::Read,
    ) -> BoxFuture<
        '_,
        Result<Vec<crate::filesystem::database::Table>, crate::filesystem::database::Error>,
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
    /// An isolated terminal presenter is created once per Remote document.
    /// Opening must only reserve ownership and queue initialization, never
    /// execute UI code or wait for it. Ordinary Rust methods need no factory.
    fn page_factory(&self) -> Option<Arc<dyn crate::terminal_ui::presenter::Factory>> {
        None
    }
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>>;
}
pub trait StreamProvider: Send + Sync {
    fn open(
        &self,
        input: Value,
        caller: Caller,
    ) -> BoxFuture<'static, Result<Box<dyn Stream>, Error>>;
}
pub trait Stream: Send + Sync {
    /// One pending read is enforced by the Host. EOF does not replace close.
    fn next(&self) -> BoxFuture<'_, Result<Option<Value>, Error>>;
    /// Must signal pending reads and resources synchronously, without waiting.
    fn cancel(&self);
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), Error>>;
}

pub enum Handler {
    Method(Arc<dyn Method>),
    Stream(Arc<dyn StreamProvider>),
}

pub struct Endpoint {
    pub access: Access,
    /// Typed source metadata; it does not grant membership in any terminal app.
    pub observation: Option<crate::terminal_ui::presenter::ObservationRole>,
    /// Present when a plugin frontend may bind this endpoint by package bytes.
    pub content_digest: Option<String>,
    pub handler: Handler,
    registration: Uuid,
    terminal_view: Option<crate::terminal_ui::Descriptor>,
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
impl Endpoint {
    pub fn new(content_digest: String, handler: Handler) -> Self {
        Self {
            access: Access::Granted,
            observation: None,
            content_digest: Some(content_digest),
            handler,
            registration: Uuid::new_v4(),
            terminal_view: None,
        }
    }
    /// An application/CLI endpoint does not require a plugin frontend bundle.
    pub fn standalone(handler: Handler) -> Self {
        Self {
            access: Access::Granted,
            observation: None,
            content_digest: None,
            handler,
            registration: Uuid::new_v4(),
            terminal_view: None,
        }
    }
    pub fn requiring_host_paths(mut self) -> Self {
        self.access = Access::HostPaths;
        self
    }
    pub fn with_terminal_view(
        mut self,
        descriptor: crate::terminal_ui::Descriptor,
    ) -> Result<Self, crate::Error> {
        descriptor.validate()?;
        if !matches!(self.handler, Handler::Method(_)) {
            return Err(crate::Error::Invalid(
                "Terminal views require a Remote method".into(),
            ));
        }
        self.terminal_view = Some(descriptor);
        Ok(self)
    }
    pub fn terminal_view(&self) -> Option<&crate::terminal_ui::Descriptor> {
        matches!(self.handler, Handler::Method(_))
            .then_some(self.terminal_view.as_ref())
            .flatten()
    }
    pub fn target(&self, owner: &Identity) -> Target {
        Target {
            entry_id: owner.entry_id.clone(),
            activation: owner.activation.clone(),
            registration: self.registration,
        }
    }
}

pub fn key(package_id: &str, method: &str) -> Result<String, crate::Error> {
    crate::identifier(package_id)?;
    crate::identifier(method)?;
    Ok(format!("{package_id}/{method}"))
}

pub fn validate_payload(value: &Value) -> Result<(), Error> {
    let bytes = serde_json::to_vec(value).map_err(|error| Error::Invalid(error.to_string()))?;
    if bytes.len() > 64 * 1024 {
        return Err(Error::Invalid("remote payload exceeds 64 KiB".into()));
    }
    Ok(())
}
