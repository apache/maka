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

//! Consent descriptions and durable references, never bearer capabilities.

use maka_plugin_core::authorization::Boundary;
use maka_sandbox::{Mode as SandboxMode, workspace::WorkspaceTarget};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use uuid::Uuid;

/// Resolving a reference requires the original package/scope, a live activation,
/// an unrevoked Host record and the issuing principal's current authorization.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(transparent)]
pub struct Id(pub Uuid);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    ReadFiles,
    WriteFiles,
    Network,
    Models,
    Processes,
    ClientCapabilities,
    Executions,
    Notifications,
    ReadSessions,
    ReadHistory,
    ReadUsage,
    ManagePricing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Target {
    Profile,
    /// Host-created scratch workspace for this package/scope, never arbitrary state files.
    PluginWorkspace {
        sandbox_mode: SandboxMode,
    },
    Directory {
        path: String,
    },
    Session {
        session_id: String,
    },
    Workspace {
        workspace: WorkspaceTarget,
        sandbox_mode: SandboxMode,
    },
}

/// A proposal is inert. Only the authenticated Host consent path may approve it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    /// Stable across a lost reply; a different proposal needs a new identity.
    pub operation_id: Uuid,
    pub title: String,
    pub target: Target,
    pub capabilities: BTreeSet<Capability>,
}
impl Request {
    pub fn validate(&self) -> Result<(), crate::Error> {
        if self.title.trim().is_empty()
            || self.title.chars().any(char::is_control)
            || self.capabilities.is_empty()
        {
            return Err(crate::Error::Invalid(
                "invalid authorization description".into(),
            ));
        }
        match &self.target {
            Target::Profile
                if self.capabilities.iter().all(|capability| {
                    matches!(
                        capability,
                        Capability::Notifications
                            | Capability::ReadSessions
                            | Capability::ReadHistory
                            | Capability::ReadUsage
                            | Capability::ManagePricing
                    )
                }) => {}
            Target::Profile => {
                return Err(crate::Error::Invalid(
                    "profile authorization has no workspace or execution target".into(),
                ));
            }
            Target::Session { session_id } => crate::name(session_id)?,
            Target::PluginWorkspace { sandbox_mode } => self.validate_mode(*sandbox_mode)?,
            Target::Directory { path } => {
                if path.is_empty()
                    || path.contains('\0')
                    || self.capabilities.iter().any(|capability| {
                        !matches!(capability, Capability::ReadFiles | Capability::WriteFiles)
                    })
                {
                    return Err(crate::Error::Invalid(
                        "directory consent only authorizes file access".into(),
                    ));
                }
            }
            Target::Workspace {
                workspace,
                sandbox_mode,
            } => {
                match workspace {
                    WorkspaceTarget::Project { project_id } => crate::name(project_id)?,
                    WorkspaceTarget::HostPath { path }
                        if !path.is_empty() && !path.contains('\0') => {}
                    _ => {
                        return Err(crate::Error::Invalid(
                            "invalid authorization workspace".into(),
                        ));
                    }
                }
                self.validate_mode(*sandbox_mode)?;
            }
        }
        if self.capabilities.contains(&Capability::ReadUsage)
            && !matches!(self.target, Target::Profile | Target::Session { .. })
        {
            return Err(crate::Error::Invalid(
                "Usage authorization requires a profile or Session target".into(),
            ));
        }
        if self.capabilities.contains(&Capability::ManagePricing) && self.target != Target::Profile
        {
            return Err(crate::Error::Invalid(
                "pricing changes require profile authorization".into(),
            ));
        }
        Ok(())
    }
    /// Explicit HTTP consent is independent of the file/process sandbox. Client
    /// capabilities can cross that sandbox and still require unrestricted access.
    pub fn validate_mode(&self, mode: SandboxMode) -> Result<(), crate::Error> {
        if mode != SandboxMode::DangerFullAccess
            && self.capabilities.contains(&Capability::ClientCapabilities)
        {
            return Err(crate::Error::Invalid(
                "client capabilities require unrestricted sandbox permission".into(),
            ));
        }
        if mode == SandboxMode::ReadOnly && self.capabilities.contains(&Capability::WriteFiles) {
            return Err(crate::Error::Invalid(
                "read-only authorization cannot grant file writes".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub id: Id,
    pub request: Request,
    pub revoked: bool,
}

pub struct Authorized {
    /// Observation of the consent being used, not a second source of authority.
    pub grant: Grant,
    /// Host-resolved observation: aliases in the proposal are not canonical paths.
    /// This value cannot be used to mint or widen authority.
    pub boundary: Boundary,
    pub call: crate::call::Owned,
}

pub trait Access: Send + Sync {
    /// Restore current authority, not a serialized in-memory capability. Each
    /// resource operation must still check revocation and current policy.
    fn open(
        &self,
        id: Id,
    ) -> futures_util::future::BoxFuture<'_, Result<Authorized, crate::authorization::CommandError>>;
}

pub fn validate_boundary(boundary: &Boundary, request: &Request) -> Result<(), crate::Error> {
    let invalid = || crate::Error::Invalid("authorization boundary does not match proposal".into());
    let mode = match (boundary, &request.target) {
        (Boundary::Profile, Target::Profile) => SandboxMode::ReadOnly,
        (Boundary::Directory { path, .. }, Target::Directory { .. }) if !path.is_empty() => {
            SandboxMode::DangerFullAccess
        }
        (
            Boundary::Workspace {
                workspace,
                sandbox_mode,
                origin: maka_sandbox::workspace::WorkspaceOrigin::Allocated,
                ..
            },
            Target::PluginWorkspace {
                sandbox_mode: proposed,
            },
        ) if sandbox_mode == proposed
            && !workspace.host_cwd.is_empty()
            && matches!(&workspace.target, WorkspaceTarget::HostPath { path } if path == &workspace.host_cwd) =>
        {
            *sandbox_mode
        }
        (Boundary::Session { boundary, .. }, Target::Session { session_id })
            if &boundary.session_id == session_id =>
        {
            boundary.validate().map_err(|_| invalid())?;
            boundary.sandbox_mode
        }
        (
            Boundary::Workspace {
                workspace,
                sandbox_mode,
                origin: maka_sandbox::workspace::WorkspaceOrigin::Selected,
                ..
            },
            Target::Workspace {
                workspace: target,
                sandbox_mode: proposed,
            },
        ) if sandbox_mode == proposed
            && match (&workspace.target, target) {
                (
                    WorkspaceTarget::Project { project_id: left },
                    WorkspaceTarget::Project { project_id: right },
                ) => left == right,
                // Only Host resolves path aliases into this canonical snapshot.
                (WorkspaceTarget::HostPath { .. }, WorkspaceTarget::HostPath { .. }) => true,
                _ => false,
            }
            && !workspace.host_cwd.is_empty() =>
        {
            *sandbox_mode
        }
        _ => return Err(invalid()),
    };
    request.validate_mode(mode)
}

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("plugin execution authority is retired or revoked")]
    Revoked,
    #[error("execution request is not authorized")]
    Denied,
    #[error("operation identity belongs to different content")]
    Conflict,
    #[error("execution operation was not accepted")]
    NotFound,
    #[error("Host is draining")]
    Draining,
    #[error("Session is busy")]
    Busy,
    #[error("execution acceptance outcome is unknown: {0}")]
    OutcomeUnknown(String),
    #[error("invalid execution request: {0}")]
    Invalid(String),
    #[error("execution capability is unavailable: {0}")]
    Unavailable(String),
    #[error("Host execution failed: {0}")]
    Host(String),
}

impl From<CommandError> for maka_agent_facts::tools::ToolError {
    fn from(error: CommandError) -> Self {
        match error {
            CommandError::Denied | CommandError::Revoked => Self::Io {
                kind: std::io::ErrorKind::PermissionDenied,
                message: error.to_string(),
            },
            CommandError::OutcomeUnknown(message) => Self::OutcomeUnknown(message),
            other => Self::Failed(other.to_string()),
        }
    }
}
