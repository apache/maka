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
mod resources;
pub use attachments::{Attachments, ReadResource, ResourceEncoding};
pub use resources::{Resources, Ticket};

use maka_agent_facts::event::Invocation;
use maka_agent_facts::tools::ToolError;
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
    Agent {
        invocation: Invocation,
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
    pub fn agent(&self) -> Option<&Invocation> {
        match self {
            Self::Agent { invocation, .. } => Some(invocation),
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
    execution: Option<Arc<dyn maka_agent_facts::tools::ExecutionCustody>>,
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
    /// Forward an actual admitted execution token with the original issuer evidence.
    /// The receiving Root validates this opaque token; public Identity cannot mint it.
    pub fn issue_with_execution<T: Any + Send + Sync>(
        &self,
        identity: Identity,
        evidence: T,
        cancellation: CancellationToken,
        execution: Arc<dyn maka_agent_facts::tools::ExecutionCustody>,
    ) -> Result<Scope, ToolError> {
        let mut scope = self.issue_with(identity, evidence, cancellation)?;
        scope.execution = Some(execution);
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
            execution: None,
            context: Metadata {
                identity,
                cancellation: cancellation.child_token(),
                resources: Arc::default(),
            },
        })
    }

    pub fn execution(&self) -> Option<&Arc<dyn maka_agent_facts::tools::ExecutionCustody>> {
        self.execution.as_ref()
    }

    pub fn child(&self) -> Result<Self, ToolError> {
        let mut child = Self::new(
            self.source.clone(),
            self.identity.clone(),
            self.evidence.clone(),
            self.cancellation.clone(),
        )?;
        child.execution = self.execution.clone();
        Ok(child)
    }

    /// Transfer a host-owned effect to its actual execution lifetime. The caller
    /// must supply custody recovered from the issuing Root, never wire identity.
    /// Finishing the observation request cannot cancel this accepted effect.
    pub fn for_execution(
        &self,
        execution: Arc<dyn maka_agent_facts::tools::ExecutionCustody>,
        cancellation: CancellationToken,
    ) -> Result<Self, ToolError> {
        let mut child = Self::new(
            self.source.clone(),
            self.identity.clone(),
            self.evidence.clone(),
            cancellation,
        )?;
        child.execution = Some(execution);
        Ok(child)
    }

    pub async fn finish(&self) -> Result<(), ToolError> {
        self.cancellation.cancel();
        self.resources.finish().await
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

#[cfg(test)]
mod execution_tests {
    use super::*;

    struct Custody;
    impl maka_agent_facts::tools::ExecutionCustody for Custody {
        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    #[tokio::test]
    async fn child_keeps_actual_custody_and_identity_alone_does_not_recreate_it() {
        let issuer = Issuer::default();
        let identity = Identity::Agent {
            invocation: Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            },
            operation_id: Some("operation".into()),
        };
        let execution: Arc<dyn maka_agent_facts::tools::ExecutionCustody> = Arc::new(Custody);
        let original = issuer
            .issue_with_execution(
                identity.clone(),
                42u64,
                CancellationToken::new(),
                execution.clone(),
            )
            .unwrap();
        let child = original.child().unwrap();
        assert!(Arc::ptr_eq(child.execution().unwrap(), &execution));
        assert!(Arc::ptr_eq(
            original.clone().execution().unwrap(),
            &execution
        ));
        assert_eq!(issuer.evidence::<u64>(&child), Some(&42));
        assert!(!Arc::ptr_eq(&original.resources, &child.resources));
        let observation_only = issuer.issue(identity, CancellationToken::new()).unwrap();
        assert!(observation_only.execution().is_none());
        original.finish().await.unwrap();
        assert!(child.cancellation.is_cancelled());
        child.finish().await.unwrap();
    }
}
