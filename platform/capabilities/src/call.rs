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

//! Call ownership shared by native and JavaScript adapters, never a wire grant.

mod attachments;
mod files;
pub use attachments::{Attachments, ReadResource, ResourceEncoding, immutable_bytes};
pub use files::OwnedTempDirectory;
use maka_plugin_core::work::resources::Resources;

use maka_agent_facts::durable::ExecutionIdentity;
use maka_agent_facts::tools::ToolError;
use maka_plugin_core::work::WorkCustody;
use serde::{Deserialize, Serialize};
use std::{any::Any, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Identity {
    /// Native owner observation only; actual Host origin and method capabilities authorize calls.
    Native,
    Agent {
        execution: ExecutionIdentity,
        operation_id: Option<String>,
    },
    Remote {
        request_id: uuid::Uuid,
    },
    Background {
        grant: crate::authorization::Id,
    },
    /// Captured browser source lease observation, not a grant or Agent invocation.
    BrowserLease {
        session_id: String,
        turn_id: String,
    },
}
impl Identity {
    pub fn agent(&self) -> Option<&ExecutionIdentity> {
        match self {
            Self::Agent { execution, .. } => Some(execution),
            _ => None,
        }
    }
    pub fn operation_id(&self) -> Option<&str> {
        match self {
            Self::Agent { operation_id, .. } => operation_id.as_deref(),
            _ => None,
        }
    }
}

/// Host dispatch creates the initial scope after authorization. Identity is
/// observation, not a grant: resource services must still validate admission.
/// Forwarding keeps revocation but owns a distinct resource settlement group.
#[derive(Clone)]
pub struct Scope {
    source: Arc<()>,
    // The embedding owns its authorization evidence. It is neither part of the
    // public observation nor serializable into a plugin-supplied wire grant.
    evidence: Option<Arc<dyn Any + Send + Sync>>,
    custody: Option<Arc<dyn WorkCustody>>,
    sandbox_floor: maka_sandbox::Sandbox,
    context: Metadata,
}

/// Read-only through Scope; observation cannot be rewritten into authority.
#[derive(Clone)]
pub struct Metadata {
    pub identity: Identity,
    pub cancellation: CancellationToken,
    pub resources: Arc<Resources>,
}

impl std::ops::Deref for Scope {
    type Target = Metadata;
    fn deref(&self) -> &Metadata {
        &self.context
    }
}

/// Embedding dispatch owns an issuer. A different embedding can create its own
/// issuer but cannot mint scopes accepted by this one's resource adapters.
#[derive(Clone, Default)]
pub struct Issuer {
    source: Arc<()>,
}
impl Issuer {
    pub fn issue(
        &self,
        identity: Identity,
        cancellation: CancellationToken,
    ) -> Result<Scope, ToolError> {
        Scope::new(self.source.clone(), identity, None, cancellation)
    }
    pub fn owns(&self, scope: &Scope) -> bool {
        Arc::ptr_eq(&self.source, &scope.source)
    }
    pub fn issue_with<T: Any + Send + Sync>(
        &self,
        identity: Identity,
        evidence: T,
        cancellation: CancellationToken,
    ) -> Result<Scope, ToolError> {
        Scope::new(
            self.source.clone(),
            identity,
            Some(Arc::new(evidence)),
            cancellation,
        )
    }
    /// Forward an actual admitted custody token with the original issuer evidence.
    /// The receiving Root validates this opaque token; public Identity cannot mint it.
    pub fn issue_with_work<T: Any + Send + Sync>(
        &self,
        identity: Identity,
        evidence: T,
        cancellation: CancellationToken,
        custody: Arc<dyn WorkCustody>,
    ) -> Result<Scope, ToolError> {
        let mut scope = self.issue_with(identity, evidence, cancellation)?;
        scope.custody = Some(custody);
        Ok(scope)
    }

    /// Only the issuing embedding can inspect its private evidence type.
    pub fn evidence<'a, T: Any + Send + Sync>(&self, scope: &'a Scope) -> Option<&'a T> {
        self.owns(scope).then_some(())?;
        scope.evidence.as_ref()?.downcast_ref()
    }
}

impl Scope {
    fn new(
        source: Arc<()>,
        identity: Identity,
        evidence: Option<Arc<dyn Any + Send + Sync>>,
        cancellation: CancellationToken,
    ) -> Result<Self, ToolError> {
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed("plugin invocation is closed".into()));
        }
        Ok(Self {
            source,
            evidence,
            custody: None,
            sandbox_floor: maka_sandbox::Sandbox::Disabled,
            context: Metadata {
                identity,
                cancellation: cancellation.child_token(),
                resources: Arc::default(),
            },
        })
    }

    pub fn work_custody(&self) -> Option<&Arc<dyn WorkCustody>> {
        self.custody.as_ref()
    }

    /// An inherited restriction, never authority to perform an effect.
    pub fn sandbox_floor(&self) -> &maka_sandbox::Sandbox {
        &self.sandbox_floor
    }

    /// Child scopes may only narrow the original constraint, including FullAccess.
    pub fn restrict_sandbox(&mut self, floor: &maka_sandbox::Sandbox) -> Result<(), ToolError> {
        self.sandbox_floor = self
            .sandbox_floor
            .intersect(floor)
            .map_err(|error| ToolError::Failed(error.to_string()))?;
        Ok(())
    }

    /// Fork cancellation without changing this dispatch's original resource proof.
    pub fn with_child_cancellation(&self) -> Result<Self, ToolError> {
        if self.cancellation.is_cancelled() {
            return Err(ToolError::Failed("plugin invocation is closed".into()));
        }
        let mut child = self.clone();
        child.context.cancellation = self.cancellation.child_token();
        Ok(child)
    }

    pub fn child(&self) -> Result<Self, ToolError> {
        let mut child = Self::new(
            self.source.clone(),
            self.identity.clone(),
            self.evidence.clone(),
            self.cancellation.clone(),
        )?;
        child.custody = self.custody.clone();
        child.sandbox_floor = self.sandbox_floor.clone();
        Ok(child)
    }

    /// Transfer a host-owned effect to its actual custody lifetime. The caller
    /// must supply custody recovered from the issuing Root, never wire identity.
    /// Finishing the observation request cannot cancel this accepted effect.
    pub fn for_work(
        &self,
        custody: Arc<dyn WorkCustody>,
        cancellation: CancellationToken,
    ) -> Result<Self, ToolError> {
        let mut child = Self::new(
            self.source.clone(),
            self.identity.clone(),
            self.evidence.clone(),
            cancellation,
        )?;
        child.custody = Some(custody);
        child.sandbox_floor = self.sandbox_floor.clone();
        Ok(child)
    }

    pub async fn finish(&self) -> Result<(), ToolError> {
        self.cancellation.cancel();
        self.resources.finish().await.map_err(Into::into)
    }
}

/// The caller owns this lifetime; forwarding a Scope does not transfer it.
/// Drop requests cancellation. `finish` additionally confirms resource cleanup.
pub struct Owned(Scope);
impl Owned {
    pub fn new(scope: Scope) -> Self {
        Self(scope)
    }
    pub fn scope(&self) -> Scope {
        self.0.clone()
    }
    pub async fn finish(self) -> Result<(), ToolError> {
        self.0.finish().await
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        self.0.cancellation.cancel();
    }
}
