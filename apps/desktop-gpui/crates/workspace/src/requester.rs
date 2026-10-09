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

//! Typed requests to the connected Host.

use std::sync::Arc;
use std::time::Duration;

use futures_lite::future::Boxed;
use host_client::{RequestError, SupervisorHandle, error_chain};
use host_protocol::{HostOperationErrorCode, Operation, operation_allows_remote_owner};
use serde_json::Value;
use thiserror::Error;

/// How long a request may wait for its answer before it fails.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a request failed, in a form views can keep and show.
#[derive(Debug, Clone, PartialEq, Error)]
#[non_exhaustive]
pub enum HostRequestError {
    /// No connection is ready. Requests are not queued or replayed.
    #[error("not connected to the Runtime Host")]
    NotConnected,
    /// The Host answered `ok: false`.
    #[error("{message}")]
    Operation { operation: &'static str, code: HostOperationErrorCode, message: Arc<str> },
    /// Anything else: the connection dropped, a timeout, an encoding problem.
    #[error("{0}")]
    Transport(Arc<str>),
}

impl HostRequestError {
    fn from_request(operation: &'static str, error: RequestError) -> Self {
        match error {
            RequestError::Operation { error, .. } => {
                Self::Operation { operation, code: error.code, message: error.message.into() }
            }
            other => Self::Transport(error_chain(&other)),
        }
    }
}

/// Sends one encoded request. [`HostSession`](crate::HostSession) uses the
/// supervised connection; tests substitute a scripted transport.
pub trait HostTransport: Send + Sync + 'static {
    fn request(
        &self,
        operation: &'static str,
        input: Value,
        timeout: Duration,
    ) -> Boxed<Result<Value, HostRequestError>>;
}

/// What the connection's credential lets this client do on the Host
/// (`RuntimeHostConnectionAuthority` in
/// `packages/runtime-host/src/server/connection-authority.ts`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum HostAccess {
    /// The local Host's owner, over its socket or pipe: every operation,
    /// with Host paths.
    #[default]
    LocalOwner,
    /// A remote Host's owner, over a paired credential: only
    /// `REMOTE_OWNER_OPERATION_GRANTS`, never with a Host path.
    RemoteOwner,
}

impl HostAccess {
    /// Whether the Host lets this client call `operation` at all.
    pub fn allows(self, operation: &str) -> bool {
        match self {
            Self::LocalOwner => true,
            Self::RemoteOwner => operation_allows_remote_owner(operation),
        }
    }

    /// Whether a request may name a folder by its path on the Host (a
    /// project folder, a task's working folder); the Host refuses it to a
    /// remote owner.
    pub fn can_use_host_paths(self) -> bool {
        self == Self::LocalOwner
    }
}

/// A cheap, cloneable handle for typed Host requests.
///
/// The returned futures are `'static` and hold no entity, so a view can spawn
/// them with `cx.spawn` and apply the result when they finish.
#[derive(Clone)]
pub struct HostRequester {
    transport: Arc<dyn HostTransport>,
    access: HostAccess,
}

impl std::fmt::Debug for HostRequester {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostRequester").field("access", &self.access).finish_non_exhaustive()
    }
}

impl HostRequester {
    /// A requester for a local owner's connection.
    pub fn new(transport: Arc<dyn HostTransport>) -> Self {
        Self { transport, access: HostAccess::LocalOwner }
    }

    /// The same requester for a connection with `access`.
    pub fn with_access(mut self, access: HostAccess) -> Self {
        self.access = access;
        self
    }

    /// What the connection's credential allows.
    pub fn access(&self) -> HostAccess {
        self.access
    }

    /// Sends `Op` with `input` and decodes its result. The input is encoded
    /// before this returns, so the future borrows neither `self` nor `input`.
    pub fn request<Op: Operation + 'static>(
        &self,
        input: &Op::Input,
    ) -> impl Future<Output = Result<Op::Output, HostRequestError>> + use<Op> {
        let encoded = serde_json::to_value(input);
        let transport = self.transport.clone();
        async move {
            let input = encoded.map_err(|error| {
                HostRequestError::Transport(
                    format!("failed to encode {}: {error}", Op::NAME).into(),
                )
            })?;
            let value = transport.request(Op::NAME, input, DEFAULT_REQUEST_TIMEOUT).await?;
            serde_json::from_value(value).map_err(|error| {
                HostRequestError::Transport(
                    format!("failed to decode the {} result: {error}", Op::NAME).into(),
                )
            })
        }
    }

    /// Sends an operation that `host-protocol` does not model yet.
    pub fn request_value(
        &self,
        operation: &'static str,
        input: Value,
    ) -> impl Future<Output = Result<Value, HostRequestError>> + use<> {
        self.transport.request(operation, input, DEFAULT_REQUEST_TIMEOUT)
    }
}

/// Requests over whatever connection the supervisor has ready.
pub(crate) struct SupervisedTransport(pub(crate) SupervisorHandle);

impl HostTransport for SupervisedTransport {
    fn request(
        &self,
        operation: &'static str,
        input: Value,
        timeout: Duration,
    ) -> Boxed<Result<Value, HostRequestError>> {
        let connection = self.0.connection();
        Box::pin(async move {
            let connection = connection.ok_or(HostRequestError::NotConnected)?;
            connection
                .request_value(operation, input, Some(timeout))
                .await
                .map_err(|error| HostRequestError::from_request(operation, error))
        })
    }
}
