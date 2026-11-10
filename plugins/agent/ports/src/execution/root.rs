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

use super::{Error, SessionBoundary, name};
use maka_agent_facts::execution::BehaviorId;
use maka_agent_facts::execution::CollaborationMode;
use maka_agent_facts::execution::ModelBinding;
use maka_agent_facts::execution::SandboxMode;
use maka_agent_facts::execution::ThinkingLevel;
use maka_sandbox::workspace::WorkspaceIdentity;
use maka_sandbox::workspace::WorkspaceTarget;
use serde::{Deserialize, Serialize};

/// Explicit choices for a new root Session. No mutable Host defaults are
/// resolved behind a retry identity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub target: super::Target,
    pub sandbox_mode: SandboxMode,
    pub approval_policy: maka_agent_facts::execution::ApprovalPolicy,
    pub collaboration_mode: CollaborationMode,
    pub behavior: BehaviorId,
    #[serde(default)]
    pub bound_tools: Option<std::collections::BTreeSet<String>>,
    #[serde(default)]
    pub instructions: Option<String>,
}
impl Settings {
    pub fn validate(&self) -> Result<(), Error> {
        self.target.validate()?;
        if let Some(tools) = &self.bound_tools {
            for tool in tools {
                name(tool)?;
            }
        }
        Ok(())
    }
}

/// Fully explicit execution surface approved by Host. Defaults are resolved
/// before persistence; a later restart cannot reinterpret configuration defaults.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootTemplate {
    pub workspace: WorkspaceTarget,
    pub cwd: String,
    pub workspace_identity: WorkspaceIdentity,
    pub model: ModelBinding,
    pub thinking_level: Option<ThinkingLevel>,
    pub sandbox_mode: SandboxMode,
    pub approval_policy: maka_agent_facts::execution::ApprovalPolicy,
    pub collaboration_mode: CollaborationMode,
    pub orchestration_mode: BehaviorId,
}
impl RootTemplate {
    pub fn settings(&self) -> Settings {
        Settings {
            target: super::Target::Model {
                model: self.model.clone(),
                thinking_level: self.thinking_level,
            },
            sandbox_mode: self.sandbox_mode,
            approval_policy: self.approval_policy,
            collaboration_mode: self.collaboration_mode,
            behavior: self.orchestration_mode.clone(),
            bound_tools: None,
            instructions: None,
        }
    }
    pub fn validate(&self) -> Result<(), Error> {
        name(&self.model.connection_id)?;
        name(&self.model.connection_slug)?;
        name(&self.model.model)?;
        if self.cwd.is_empty() || self.cwd.contains('\0') {
            return Err(Error::Invalid("invalid root Session workspace".into()));
        }
        match &self.workspace {
            WorkspaceTarget::Project { project_id } => name(project_id)?,
            WorkspaceTarget::HostPath { path } if path == &self.cwd => {}
            _ => {
                return Err(Error::Invalid(
                    "root Session workspace must be canonical".into(),
                ));
            }
        }
        Ok(())
    }
}

/// Frozen Host approval data. Restoring a capability requires an explicit Host
/// grant; normal execution capabilities cannot create root Sessions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootApproval {
    pub template: RootTemplate,
    /// Agent-created plans retain their originating Session's permission ceiling.
    pub source: Option<SessionBoundary>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRoot {
    /// Only the creating package/scope may admit work or change this Session.
    /// Canonical execution facts and already accepted work remain Host-owned.
    #[serde(default)]
    pub managed: bool,
    pub operation_id: String,
    pub name: String,
    pub settings: Settings,
}
impl CreateRoot {
    pub fn validate(&self) -> Result<(), Error> {
        name(&self.operation_id)?;
        self.settings.validate()?;
        if self.name.trim().is_empty() || self.name.len() > 1024 || self.name.contains('\0') {
            return Err(Error::Invalid("invalid root Session name".into()));
        }
        Ok(())
    }
}
