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

use super::{Host, authority::Authority};
use crate::session::SessionConfiguration;
use maka_config::{
    ConfigurationStore,
    plugin_authorization::{Approval, Boundary, Principal, Record},
};
use maka_event_log::EventLog;
use maka_plugins::{
    authorization::{Capability, Id, Request, Target},
    execution::SessionBoundary,
    storage::Namespace,
};
use maka_protocol::{
    Operation, OperationError, OperationErrorCode as Code,
    plugin::{AuthorizationCommand, AuthorizationInput, AuthorizationResult},
};
use maka_runtime::execution::{WorkspaceIdentity, WorkspaceTarget};
use std::sync::Arc;
mod workspace;

pub(super) async fn execute(
    host: &Arc<Host>,
    authority: &Authority,
    client: &str,
    input: AuthorizationInput,
) -> Result<AuthorizationResult, OperationError> {
    input.validate().map_err(invalid)?;
    let principal = principal(authority, client);
    let current = principal_authority(&host.configuration, &principal).await?;
    if !current.has_grant(Operation::PluginAuthorization) {
        return Err(denied());
    }
    let (namespace, published) = subject(host, &current, &input)?;
    let _lease = published.admit().map_err(invalid)?;
    match input.command().clone() {
        AuthorizationCommand::Query { id } => {
            let record = host
                .configuration
                .plugin_authorization(namespace, id)
                .await
                .map_err(persistence)?;
            Ok(AuthorizationResult::Grant {
                grant: record.map(|record| record.grant),
            })
        }
        AuthorizationCommand::Revoke { id } => {
            let _gate = host.executions.lock_admission().await;
            let current = principal_authority(&host.configuration, &principal).await?;
            if !current.has_grant(Operation::PluginAuthorization) {
                return Err(denied());
            }
            let (_, published) = subject(host, &current, &input)?;
            let _lease = published.admit().map_err(invalid)?;
            host.configuration
                .revoke_plugin_authorization(namespace, id)
                .await
                .map_err(persistence)?;
            Ok(AuthorizationResult::Revoked)
        }
        AuthorizationCommand::Approve { request } => {
            if let Some(result) =
                previous(&host.configuration, &namespace, &principal, &request).await?
            {
                return Ok(result);
            }
            allow(&current, &request)?;
            if host
                .configuration
                .runtime_policy()
                .await
                .map_err(persistence)?
                .policy
                .privacy
                .incognito_active
            {
                return Err(invalid(
                    "persistent plugin authorization is unavailable in incognito mode",
                ));
            }
            // A concurrent approval may commit while the target is resolving.
            // Recover its receipt before interpreting a now-stale capture.
            let boundary =
                capture(&host.log, host.root.canonical_path(), &namespace, &request).await;
            let _gate = host.executions.lock_admission().await;
            let current = principal_authority(&host.configuration, &principal).await?;
            if !current.has_grant(Operation::PluginAuthorization) {
                return Err(denied());
            }
            let (_, published) = subject(host, &current, &input)?;
            let _lease = published.admit().map_err(invalid)?;
            if let Some(result) =
                previous(&host.configuration, &namespace, &principal, &request).await?
            {
                return Ok(result);
            }
            allow(&current, &request)?;
            let boundary = boundary?;
            validate_boundary(&host.log, &boundary).await?;
            match host
                .configuration
                .approve_plugin_authorization(namespace, principal, request, boundary)
                .await
                .map_err(persistence)?
            {
                Approval::Granted(record) => Ok(AuthorizationResult::Grant {
                    grant: Some(record.grant),
                }),
                Approval::Conflict => Err(conflict()),
            }
        }
    }
}

fn subject(
    host: &Host,
    authority: &Authority,
    input: &AuthorizationInput,
) -> Result<(Namespace, maka_plugins::fiber::Context), OperationError> {
    match input {
        AuthorizationInput::Client { client, scope, .. } => {
            let published = host.plugins.bind_client(client)?;
            let namespace =
                Namespace::new(client.extension_id.clone(), scope.clone()).map_err(invalid)?;
            Ok((namespace, published.owner))
        }
        AuthorizationInput::Remote {
            binding, target, ..
        } => {
            if !authority.has_grant(Operation::PluginRemote) {
                return Err(denied());
            }
            let bound = host.plugins.bind_remote(binding, Some(target))?;
            if bound.endpoint.value.access == maka_plugins::remote::Access::HostPaths
                && !authority.can_use_host_paths()
            {
                return Err(denied());
            }
            let identity = bound.endpoint.owner.identity().map_err(invalid)?;
            if let maka_plugins::composition::Scope::Session(id) = &identity.scope
                && let AuthorizationCommand::Approve { request } = input.command()
                && !matches!(&request.target, Target::Session { session_id } if session_id == id)
            {
                return Err(denied());
            }
            // Storage authority follows the actual backend owner, not a scope
            // supplied by the application or inherited from a frontend entry.
            let namespace = Namespace::new(identity.package_id, identity.scope).map_err(invalid)?;
            Ok((namespace, bound.endpoint.owner))
        }
    }
}

async fn previous(
    configuration: &ConfigurationStore,
    namespace: &Namespace,
    principal: &Principal,
    request: &Request,
) -> Result<Option<AuthorizationResult>, OperationError> {
    configuration
        .plugin_authorization_operation(namespace.clone(), request.operation_id)
        .await
        .map_err(persistence)?
        .map(|record| {
            if record.grant.request == *request && record.principal == *principal {
                Ok(AuthorizationResult::Grant {
                    grant: Some(record.grant),
                })
            } else {
                Err(conflict())
            }
        })
        .transpose()
}

fn conflict() -> OperationError {
    OperationError {
        code: Code::OperationConflict,
        message: "authorization operation belongs to a different proposal or principal".into(),
    }
}

/// Shared by live execution/resource handles; possessing an ID is insufficient.
pub(crate) async fn validate(
    log: &EventLog,
    configuration: &ConfigurationStore,
    namespace: &Namespace,
    id: Id,
    capability: Capability,
) -> Result<Record, OperationError> {
    let record = restore(log, configuration, namespace, id).await?;
    if !record.grant.request.capabilities.contains(&capability) {
        return Err(denied());
    }
    Ok(record)
}

pub(crate) async fn restore(
    log: &EventLog,
    configuration: &ConfigurationStore,
    namespace: &Namespace,
    id: Id,
) -> Result<Record, OperationError> {
    if configuration
        .runtime_policy()
        .await
        .map_err(persistence)?
        .policy
        .privacy
        .incognito_active
    {
        return Err(denied());
    }
    let record = configuration
        .plugin_authorization(namespace.clone(), id)
        .await
        .map_err(persistence)?
        .filter(|record| !record.grant.revoked)
        .ok_or_else(denied)?;
    let authority = principal_authority(configuration, &record.principal).await?;
    allow(&authority, &record.grant.request)?;
    validate_boundary(log, &record.boundary).await?;
    Ok(record)
}

async fn principal_authority(
    configuration: &ConfigurationStore,
    principal: &Principal,
) -> Result<Authority, OperationError> {
    match principal {
        Principal::LocalUser { .. } => Ok(Authority::LocalOwner),
        Principal::Credential {
            credential_id,
            client_instance_id,
        } => {
            let credential = configuration
                .active_access_credentials()
                .await
                .map_err(persistence)?
                .into_iter()
                .find(|credential| &credential.credential_id == credential_id)
                .ok_or_else(denied)?;
            let authority = Authority::Managed(Box::new(credential));
            authority
                .validate_client(configuration, client_instance_id)
                .await
                .map_err(|_| denied())?;
            Ok(authority)
        }
    }
}

pub(crate) async fn client_identity(
    configuration: &ConfigurationStore,
    principal: &Principal,
) -> Result<maka_runtime::capability::Identity, OperationError> {
    let client = match principal {
        Principal::LocalUser { client_instance_id }
        | Principal::Credential {
            client_instance_id, ..
        } => client_instance_id,
    };
    principal_authority(configuration, principal)
        .await?
        .capability_identity(client.clone())
        .ok_or_else(denied)
}

pub(crate) async fn validate_principal(
    configuration: &ConfigurationStore,
    principal: &Principal,
    request: &Request,
) -> Result<(), OperationError> {
    allow(
        &principal_authority(configuration, principal).await?,
        request,
    )
}

fn allow(authority: &Authority, request: &Request) -> Result<(), OperationError> {
    if matches!(
        &request.target,
        Target::Workspace {
            workspace: WorkspaceTarget::HostPath { .. },
            ..
        } | Target::Directory { .. }
    ) && !authority.can_use_host_paths()
    {
        return Err(denied());
    }
    allow_capabilities(authority, request.capabilities.iter().copied())
}

fn allow_capabilities(
    authority: &Authority,
    capabilities: impl IntoIterator<Item = Capability>,
) -> Result<(), OperationError> {
    if !authority.has_grant(Operation::PluginAuthorization) {
        return Err(denied());
    }
    for capability in capabilities {
        let required: &[Operation] = match capability {
            Capability::Executions => &[
                Operation::SessionCreate,
                Operation::TurnStart,
                Operation::TurnStop,
                Operation::SessionTranscriptPage,
            ],
            Capability::Processes => &[
                Operation::RuntimeResourceStart,
                Operation::RuntimeResourceControllerControl,
                Operation::RuntimeResourceStop,
            ],
            Capability::ReadFiles
            | Capability::WriteFiles
            | Capability::Network
            | Capability::Models
            | Capability::ClientCapabilities => &[Operation::TurnStart],
            Capability::Notifications => &[],
            Capability::ReadSessions => &[Operation::SessionCatalogQuery],
            Capability::ReadUsage => &[Operation::UsageQuery],
            Capability::ManagePricing => &[Operation::PricingMutate],
            Capability::ReadHistory => &[
                Operation::SessionCatalogQuery,
                Operation::SessionTranscriptPage,
            ],
        };
        if required
            .iter()
            .any(|operation| !authority.has_grant(*operation))
        {
            return Err(denied());
        }
    }
    Ok(())
}

/// Native manager input retains the same caller standard as an Executions
/// authorization through Remote, without creating or borrowing a stored grant.
pub(crate) async fn validate_native_input(
    configuration: &ConfigurationStore,
    principal: &Principal,
) -> Result<(), OperationError> {
    let authority = principal_authority(configuration, principal)
        .await
        .map_err(|mut error| {
            // Message admission exposes its own persistence/unknown vocabulary.
            if error.code == Code::PersistenceFailed || error.code == Code::CommitOutcomeUnknown {
                error.code = Code::InternalFailure;
            }
            error
        })?;
    if !authority.has_grant(Operation::PluginRemote)
        || !authority.has_grant(Operation::TurnMessageSubmit)
    {
        return Err(denied());
    }
    allow_capabilities(&authority, [Capability::Executions])
}

pub(super) fn principal(authority: &Authority, client: &str) -> Principal {
    match authority.credential() {
        None => Principal::LocalUser {
            client_instance_id: client.into(),
        },
        Some(credential) => Principal::Credential {
            credential_id: credential.credential_id.clone(),
            client_instance_id: client.into(),
        },
    }
}

pub(crate) async fn capture(
    log: &EventLog,
    state_root: &std::path::Path,
    namespace: &Namespace,
    request: &Request,
) -> Result<Boundary, OperationError> {
    Ok(match &request.target {
        Target::Profile => Boundary::Profile,
        Target::PluginWorkspace { sandbox_mode } => {
            let (workspace, workspace_identity) = workspace::prepare(state_root, namespace).await?;
            Boundary::Workspace {
                workspace,
                workspace_identity,
                origin: maka_runtime::execution::WorkspaceOrigin::Allocated,
                sandbox_mode: *sandbox_mode,
            }
        }
        Target::Directory { path } => {
            let path = path.clone();
            let (path, identity) = tokio::task::spawn_blocking(move || {
                maka_fs_tools::directory::capture(std::path::Path::new(&path))
            })
            .await
            .map_err(invalid)?
            .map_err(invalid)?;
            Boundary::Directory {
                path: path
                    .to_str()
                    .ok_or_else(|| invalid("Directory path is not UTF-8"))?
                    .into(),
                identity,
            }
        }
        Target::Session { session_id } => {
            let session = log
                .get_session::<SessionConfiguration>(session_id)
                .await
                .map_err(persistence)?
                .filter(|record| !record.archived)
                .ok_or_else(denied)?;
            let session = session.configuration;
            request
                .validate_mode(session.sandbox_mode)
                .map_err(invalid)?;
            let workspace_identity = maka_fs_tools::workspace::ensure_identity(
                std::path::Path::new(&session.workspace.host_cwd),
            )
            .await
            .map_err(invalid)?;
            Boundary::Session {
                boundary: SessionBoundary {
                    workspace_origin: session.workspace_origin,
                    session_id: session_id.clone(),
                    boundary_revision: session.boundary_revision,
                    sandbox_mode: session.sandbox_mode,
                    approval_policy: session.approval_policy,
                    cwd: session.workspace.host_cwd,
                },
                workspace_identity,
            }
        }
        Target::Workspace {
            workspace,
            sandbox_mode,
        } => {
            let workspace = match workspace {
                WorkspaceTarget::Project { project_id } => {
                    let project = log
                        .get_project(project_id)
                        .await
                        .map_err(persistence)?
                        .ok_or_else(denied)?;
                    super::resolve_project_workspace(project).await?
                }
                WorkspaceTarget::HostPath { path } => {
                    super::resolve_workspace_path(path.clone()).await?
                }
            };
            let workspace_identity = maka_fs_tools::workspace::ensure_identity(
                std::path::Path::new(&workspace.host_cwd),
            )
            .await
            .map_err(invalid)?;
            Boundary::Workspace {
                workspace,
                workspace_identity,
                origin: maka_runtime::execution::WorkspaceOrigin::Selected,
                sandbox_mode: *sandbox_mode,
            }
        }
    })
}

pub(crate) async fn validate_boundary(
    log: &EventLog,
    boundary: &Boundary,
) -> Result<(), OperationError> {
    let (cwd, expected) = match boundary {
        Boundary::Profile => return Ok(()),
        Boundary::Directory { path, identity } => {
            let path = path.clone();
            let identity = identity.clone();
            return tokio::task::spawn_blocking(move || {
                maka_fs_tools::directory::open(std::path::Path::new(&path), &identity).map(|_| ())
            })
            .await
            .map_err(invalid)?
            .map_err(|_| denied());
        }
        Boundary::Session {
            boundary,
            workspace_identity,
        } => {
            let current = log
                .get_session::<SessionConfiguration>(&boundary.session_id)
                .await
                .map_err(persistence)?
                .filter(|record| !record.archived)
                .ok_or_else(denied)?;
            let current = current.configuration;
            if current.boundary_revision != boundary.boundary_revision
                || current.workspace_origin != boundary.workspace_origin
                || current.sandbox_mode != boundary.sandbox_mode
                || current.approval_policy != boundary.approval_policy
                || current.workspace.host_cwd != boundary.cwd
            {
                return Err(denied());
            }
            (boundary.cwd.clone(), workspace_identity)
        }
        Boundary::Workspace {
            workspace,
            workspace_identity,
            ..
        } => {
            if let WorkspaceTarget::Project { project_id } = &workspace.target {
                let project = log
                    .get_project(project_id)
                    .await
                    .map_err(persistence)?
                    .ok_or_else(denied)?;
                if super::resolve_project_workspace(project).await?.host_cwd != workspace.host_cwd {
                    return Err(denied());
                }
            }
            (workspace.host_cwd.clone(), workspace_identity)
        }
    };
    if &identity(cwd).await? != expected {
        return Err(denied());
    }
    Ok(())
}
async fn identity(cwd: String) -> Result<WorkspaceIdentity, OperationError> {
    tokio::task::spawn_blocking(move || {
        maka_fs_tools::workspace::read_identity(std::path::Path::new(&cwd))
    })
    .await
    .map_err(invalid)?
    .map_err(|_| denied())
}
fn denied() -> OperationError {
    OperationError {
        code: Code::Unauthorized,
        message: "plugin authorization is absent, revoked or outside the current boundary".into(),
    }
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError {
        code: Code::InvalidRequest,
        message: error.to_string(),
    }
}
fn persistence(error: impl Into<maka_config::ConfigError>) -> OperationError {
    let error = error.into();
    OperationError {
        code: if matches!(error, maka_config::ConfigError::CommitUnknown) {
            Code::CommitOutcomeUnknown
        } else {
            Code::PersistenceFailed
        },
        message: error.to_string(),
    }
}
