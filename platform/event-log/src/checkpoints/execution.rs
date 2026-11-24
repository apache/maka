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

//! Trusted control-plane execution authority. Reading an archive is not a grant.
use super::repository::{Binding, Commit, CommitReceipt, VerifiedCheckpoint};
use super::{Revision, invalid};
use crate::{StoreError, connection::BoxFuture};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

mod files;
mod repository;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    pub sandbox: maka_sandbox::Sandbox,
    /// None permits the tools independently granted by the Host; Some is an upper bound.
    pub tools: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    /// Stable idempotency key for this activation, including rejected claims.
    pub activation: Uuid,
    pub binding: Binding,
    pub start: Option<Revision>,
    pub permissions: Permissions,
    pub lease_millis: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub activation: Uuid,
    pub generation: u64,
    pub binding: Binding,
    pub start: Option<Revision>,
    pub permissions: Permissions,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClaimResult {
    Granted { grant: Box<Grant>, expires_at: u64 },
    Busy,
    Conflict { actual: Option<Revision> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Status {
    Active { expires_at: u64 },
    Draining,
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Renewal {
    pub operation: Uuid,
    pub grant: Grant,
    pub lease_millis: u64,
}

/// Supplied by trusted embedding, never decoded from a caller's success flag.
/// Confirmation covers the original environment and all its managed writers.
pub trait Environment: Send + Sync {
    fn stop_and_drain(&self, grant: &Grant) -> BoxFuture<'_, Result<(), StoreError>>;
}

pub struct Stopped {
    grant: Arc<Grant>,
}
impl Stopped {
    pub async fn verify(
        environment: &dyn Environment,
        grant: Arc<Grant>,
    ) -> Result<Self, StoreError> {
        environment.stop_and_drain(&grant).await?;
        Ok(Self { grant })
    }
    pub fn grant(&self) -> &Grant {
        &self.grant
    }
}

/// Implementations are trusted capabilities. Every successful mutation is durable.
/// Revocation/expiry closes admission but NEVER proves physical cleanup. Claiming a
/// successor requires Stopped evidence. Commit validates the generation and Head
/// in the same atomic authority, including its original receipt.
pub trait ExecutionAuthority: Send + Sync {
    fn repository_identity(&self) -> &str;
    fn claim(&self, request: Claim) -> BoxFuture<'_, Result<ClaimResult, StoreError>>;
    fn observe(&self, grant: Arc<Grant>) -> BoxFuture<'_, Result<Status, StoreError>>;
    fn renew(&self, request: Renewal) -> BoxFuture<'_, Result<Status, StoreError>>;
    fn revoke(&self, grant: Arc<Grant>) -> BoxFuture<'_, Result<Status, StoreError>>;
    fn stopped(&self, evidence: Stopped) -> BoxFuture<'_, Result<(), StoreError>>;
    fn receipt(
        &self,
        grant: Arc<Grant>,
        request: Commit,
    ) -> BoxFuture<'_, Result<Option<CommitReceipt>, StoreError>>;
    fn commit(
        &self,
        grant: Arc<Grant>,
        request: Commit,
        verified: VerifiedCheckpoint,
    ) -> BoxFuture<'_, Result<CommitReceipt, StoreError>>;
}

/// A bootstrap capability, not a serializable bearer credential. The shared
/// cancellation is irreversible even if the control service later recovers.
#[derive(Clone)]
pub struct Execution {
    authority: Arc<dyn ExecutionAuthority>,
    grant: Arc<Grant>,
    cancellation: CancellationToken,
}
impl Execution {
    pub async fn attach(
        authority: Arc<dyn ExecutionAuthority>,
        grant: Arc<Grant>,
    ) -> Result<Self, StoreError> {
        let execution = Self {
            authority,
            grant,
            cancellation: CancellationToken::new(),
        };
        execution.check().await?;
        Ok(execution)
    }
    pub fn grant(&self) -> &Grant {
        &self.grant
    }
    pub fn repository_identity(&self) -> &str {
        self.authority.repository_identity()
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    pub async fn check(&self) -> Result<(), StoreError> {
        if self.cancellation.is_cancelled() {
            return Err(invalid("Session execution is draining"));
        }
        let observation = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.authority.observe(self.grant.clone()),
        )
        .await
        .unwrap_or_else(|_| Err(invalid("execution authority observation timed out")));
        match observation {
            Ok(Status::Active { .. }) if !self.cancellation.is_cancelled() => Ok(()),
            Ok(_) => {
                self.cancellation.cancel();
                Err(invalid("Session execution is not active"))
            }
            Err(error) => {
                self.cancellation.cancel();
                Err(error)
            }
        }
    }
    pub async fn check_session(&self, session: &str) -> Result<(), StoreError> {
        if self.grant.binding.source.session != session {
            return Err(invalid("Session is outside the execution grant"));
        }
        self.check().await
    }
    pub async fn stop(&self, environment: &dyn Environment) -> Result<(), StoreError> {
        self.cancellation.cancel();
        // Losing the control service must still stop local work. A failed revoke
        // keeps acknowledgement pending and cannot authorize a successor.
        let (revoked, stopped) = tokio::join!(
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                self.authority.revoke(self.grant.clone())
            ),
            Stopped::verify(environment, self.grant.clone()),
        );
        let stopped = stopped?;
        revoked.map_err(|_| invalid("execution revocation timed out"))??;
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.authority.stopped(stopped),
        )
        .await
        .map_err(|_| invalid("execution stop acknowledgement timed out"))?
    }
    pub(crate) fn authority(&self) -> &Arc<dyn ExecutionAuthority> {
        &self.authority
    }
}
