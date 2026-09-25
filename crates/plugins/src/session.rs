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

pub mod catalog;
pub mod history;
pub mod import;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};

/// A bounded configuration projection. Revision is for optimistic control;
/// reading this document cannot mint execution or filesystem authority.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct View {
    pub session_id: String,
    pub revision: u64,
    pub name: String,
    pub boundary_revision: u64,
    pub workspace: maka_runtime::execution::WorkspaceProjection,
    pub target: crate::execution::Target,
    pub sandbox_mode: maka_runtime::execution::SandboxMode,
    pub approval_policy: maka_runtime::execution::ApprovalPolicy,
    pub collaboration_mode: maka_runtime::execution::CollaborationMode,
    pub behavior: maka_runtime::execution::BehaviorId,
    pub bound_tools: Option<BTreeSet<String>>,
}

/// Session behavior prepares its scoped capabilities. It cannot modify an
/// already-frozen model request or replace Host execution authority.
pub struct Request {
    /// The candidate configuration, including any per-execution behavior override.
    /// This is an observation, not permission to access or execute the Session.
    pub session: View,
    pub cancellation: tokio_util::sync::CancellationToken,
}

pub trait Behavior: Send + Sync {
    fn prepare(&self, request: Request) -> BoxFuture<'_, Result<Preparation, String>>;
}

/// Explicit delegation of canonical native message admission to the Host.
/// This is registration metadata; preparing a behavior cannot grant input access.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeInputPolicy {
    #[default]
    Denied,
    NativeUserMessages,
}

pub struct SessionBehavior {
    pub behavior: Arc<dyn Behavior>,
    pub native_input: NativeInputPolicy,
}

impl SessionBehavior {
    pub fn new(behavior: Arc<dyn Behavior>) -> Self {
        Self {
            behavior,
            native_input: NativeInputPolicy::Denied,
        }
    }

    pub fn with_native_input(mut self, policy: NativeInputPolicy) -> Self {
        self.native_input = policy;
        self
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preparation {
    pub instructions: String,
    pub native_tools: maka_runtime::execution::NativeToolSet,
    pub required_clients: Option<ClientTools>,
    pub tool_ceiling: Option<BTreeSet<String>>,
    /// A captured domain version, checked and pinned during durable admission.
    #[serde(skip)]
    pub basis: Option<crate::revision::Basis>,
}

/// Required tools must share one Session-bound provider. Optional tools are
/// exposed only when available; neither list can grant a Client capability.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientTools {
    pub required: Vec<String>,
    #[serde(default)]
    pub optional: Vec<String>,
    #[serde(default)]
    pub private: BTreeSet<String>,
}
impl Preparation {
    pub fn validate(&self) -> Result<(), crate::Error> {
        if let Some(clients) = &self.required_clients {
            if clients.required.is_empty() || clients.required.len() + clients.optional.len() > 128
            {
                return Err(crate::Error::Invalid(
                    "Invalid required Client tool selection".into(),
                ));
            }
            for name in clients.required.iter().chain(&clients.optional) {
                crate::name(name)?;
            }
            if clients
                .private
                .iter()
                .any(|name| !clients.required.contains(name) && !clients.optional.contains(name))
            {
                return Err(crate::Error::Invalid(
                    "Private Client tools must be bound by the behavior".into(),
                ));
            }
        }
        if self.instructions.len() > 16 * 1024
            || self
                .tool_ceiling
                .as_ref()
                .is_some_and(|names| names.len() > 128)
        {
            return Err(crate::Error::Invalid(
                "Session behavior surface exceeds its budget".into(),
            ));
        }
        if let Some(names) = &self.tool_ceiling {
            for name in names {
                crate::name(name)?;
            }
        }
        Ok(())
    }
}
