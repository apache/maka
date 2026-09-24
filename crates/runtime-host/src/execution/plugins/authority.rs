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

use super::{
    BoundCommands, Commands, Context, Error, Executions, Grant, RootGrant, Scope,
    SessionConfiguration, storage,
};
use maka_plugins::{
    authorization::Boundary,
    execution::{RootApproval, SessionBoundary},
    storage::Namespace,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

impl Executions {
    pub(crate) async fn request_plugin_permissions(
        &self,
        call: &maka_plugins::call::Scope,
        input: maka_plugins::permissions::Request,
        cancellation: &CancellationToken,
    ) -> Result<maka_plugins::permissions::Permissions, Error> {
        use maka_runtime::{interaction::PermissionRequest, tool_call::ToolRejection};
        let invocation = call.identity.agent().ok_or(Error::Denied)?;
        let boundary = self.plugin_execution_boundary(call).await?;
        let Boundary::Session {
            boundary: session, ..
        } = &boundary
        else {
            return Err(Error::Denied);
        };
        let permissions = tokio::task::spawn_blocking(move || {
            crate::execution::permissions::materialize(input.permissions)
        })
        .await
        .map_err(|error| Error::Host(error.to_string()))?
        .map_err(|error| Error::Invalid(error.to_string()))?;
        let request = PermissionRequest {
            reason: input.reason,
            permissions,
            command: None,
        };
        request
            .validate()
            .map_err(|error| Error::Invalid(error.into()))?;
        let cwd = session.cwd.clone();
        let mode = session.sandbox_mode;
        let origin = session.workspace_origin;
        let state_root = self.paths.state_root.clone();
        let ceiling = tokio::task::spawn_blocking(move || {
            crate::execution::permissions::resolve(
                mode,
                std::path::Path::new(&cwd),
                &state_root,
                origin,
            )
            .map(|(_, ceiling)| ceiling)
        })
        .await
        .map_err(|error| Error::Host(error.to_string()))?
        .map_err(|error| Error::Invalid(error.to_string()))?;
        if !ceiling
            .permits(&request.permissions)
            .map_err(|error| Error::Invalid(error.to_string()))?
        {
            return Err(Error::Denied);
        }
        if self
            .plugin_sandbox(call, &boundary, None)
            .await?
            .permits(&request.permissions)
            .map_err(|error| Error::Invalid(error.to_string()))?
        {
            return Ok(request.permissions);
        }
        let tool_use = call
            .identity
            .operation_id()
            .map(|id| maka_runtime::tool_call::tool_use_id(&invocation.invocation_id, id));
        let requested = request.permissions.clone();
        let granted = self
            .interactions
            .request_permissions(
                invocation,
                tool_use.as_deref(),
                request,
                session.boundary_revision,
                cancellation,
            )
            .await
            .map_err(|error| match error {
                ToolRejection::Cancelled => Error::Revoked,
                ToolRejection::PolicyDenied { .. } => Error::Denied,
                ToolRejection::InvalidInput { message } => Error::Invalid(message),
                other => Error::Unavailable(other.to_string()),
            })?;
        // A concurrent call may have obtained a broader reusable grant while
        // this request was being prepared. Return only this request's surface;
        // a newly answered partial approval is already validated as its subset.
        if granted
            .permissions
            .contains(&requested)
            .map_err(|error| Error::Invalid(error.to_string()))?
        {
            Ok(requested)
        } else {
            Ok(granted.permissions)
        }
    }

    /// Canonical additions follow the actual caller. Executor callbacks have no
    /// tool-use identity and may consume Turn/Session grants, never Once grants.
    pub(super) async fn plugin_permission_grants(
        &self,
        call: &maka_plugins::call::Scope,
        revision: u64,
    ) -> Result<Vec<maka_event_log::interactions::PermissionGrant>, Error> {
        let invocation = call.identity.agent().ok_or(Error::Denied)?;
        let tool_use = call
            .identity
            .operation_id()
            .map(|id| maka_runtime::tool_call::tool_use_id(&invocation.invocation_id, id));
        self.log
            .permission_grants(invocation, tool_use.as_deref(), revision)
            .await
            .map_err(storage)
    }

    pub(crate) async fn acquire_plugin_execution(
        self: &Arc<Self>,
        context: Context,
        call: maka_plugins::call::Scope,
        root_id: &str,
    ) -> Result<Arc<dyn Commands>, Error> {
        let _lease = context.admit().map_err(|_| Error::Revoked)?;
        let boundary = self.plugin_execution_boundary(&call).await?;
        let mut commands =
            self.bind_plugin_boundary(context, boundary, root_id, call.cancellation.clone())?;
        commands.call = Some(call);
        Ok(Arc::new(commands))
    }

    pub(super) async fn plugin_execution_boundary(
        &self,
        call: &maka_plugins::call::Scope,
    ) -> Result<Boundary, Error> {
        if !self.accepting() || !self.plugin_calls.owns(call) || call.cancellation.is_cancelled() {
            return Err(Error::Revoked);
        }
        if call.identity.agent().is_none() {
            return self
                .plugin_resource_boundary(call, maka_plugins::authorization::Capability::Executions)
                .await;
        }
        Ok(self.plugin_agent_evidence(call).await?.boundary.clone())
    }

    pub(crate) async fn restore_plugin_consent(
        self: &Arc<Self>,
        context: Context,
        id: maka_plugins::authorization::Id,
        root_id: &str,
    ) -> Result<Arc<dyn Commands>, Error> {
        let identity = context.identity().map_err(|_| Error::Revoked)?;
        let namespace = Namespace::new(identity.package_id, identity.scope)
            .map_err(|error| Error::Invalid(error.to_string()))?;
        let record = crate::server::plugin_authorization::validate(
            &self.log,
            &self.configuration,
            &namespace,
            id,
            maka_plugins::authorization::Capability::Executions,
        )
        .await
        .map_err(consent_error)?;
        let mut commands = self.bind_plugin_boundary(
            context.clone(),
            record.boundary,
            root_id,
            context.stopping().map_err(|_| Error::Revoked)?,
        )?;
        commands.consent = Some(id);
        Ok(Arc::new(commands))
    }
    pub(crate) async fn authorize_plugin(
        self: &Arc<Self>,
        context: Context,
        sessions: &[String],
        root_id: &str,
        submission_stop: CancellationToken,
    ) -> Result<Arc<dyn Commands>, Error> {
        if sessions.len() > 256 {
            return Err(Error::Denied);
        }
        let mut boundaries = Vec::with_capacity(sessions.len());
        for id in sessions {
            let session = self
                .log
                .get_session::<SessionConfiguration>(id)
                .await
                .map_err(storage)?
                .ok_or(Error::NotFound)?;
            if session.archived {
                return Err(Error::Denied);
            }
            boundaries.push(SessionBoundary {
                workspace_origin: session.configuration.workspace_origin,
                session_id: id.clone(),
                boundary_revision: session.configuration.boundary_revision,
                sandbox_mode: session.configuration.sandbox_mode,
                approval_policy: session.configuration.approval_policy,
                cwd: session.configuration.workspace.host_cwd,
            });
        }
        self.restore_plugin_authority(context, boundaries, root_id, submission_stop)
    }

    /// Explicit Host grant constrained by its original persisted boundary, not
    /// reinterpreted using current (possibly broader) Session configuration.
    pub(crate) fn restore_plugin_authority(
        self: &Arc<Self>,
        context: Context,
        boundaries: Vec<SessionBoundary>,
        root_id: &str,
        submission_stop: CancellationToken,
    ) -> Result<Arc<dyn Commands>, Error> {
        Ok(Arc::new(self.bind_plugin_authority(
            context,
            boundaries,
            None,
            root_id,
            submission_stop,
        )?))
    }

    pub(crate) fn authorize_plugin_root(
        self: &Arc<Self>,
        context: Context,
        approval: RootApproval,
        root_id: &str,
        submission_stop: CancellationToken,
    ) -> Result<Arc<dyn Commands>, Error> {
        approval
            .template
            .validate()
            .map_err(|error| Error::Invalid(error.to_string()))?;
        if let Some(source) = &approval.source {
            source
                .validate()
                .map_err(|error| Error::Invalid(error.to_string()))?;
        }
        Ok(Arc::new(self.bind_plugin_authority(
            context,
            Vec::new(),
            Some(RootGrant::from(approval)),
            root_id,
            submission_stop,
        )?))
    }

    fn bind_plugin_boundary(
        self: &Arc<Self>,
        context: Context,
        boundary: Boundary,
        root_id: &str,
        submission_stop: CancellationToken,
    ) -> Result<BoundCommands, Error> {
        let (sessions, root) = match boundary {
            Boundary::Session { boundary, .. } => (vec![boundary], None),
            Boundary::Workspace {
                workspace,
                workspace_identity,
                origin,
                sandbox_mode,
            } => (
                Vec::new(),
                Some(RootGrant {
                    workspace_origin: origin,
                    workspace,
                    workspace_identity,
                    sandbox_mode,
                    approval_policy: maka_runtime::execution::ApprovalPolicy::OnRequest,
                    source: None,
                }),
            ),
            Boundary::Profile | Boundary::Directory { .. } => return Err(Error::Denied),
        };
        self.bind_plugin_authority(context, sessions, root, root_id, submission_stop)
    }

    fn bind_plugin_authority(
        self: &Arc<Self>,
        context: Context,
        boundaries: Vec<SessionBoundary>,
        root_grant: Option<RootGrant>,
        root_id: &str,
        submission_stop: CancellationToken,
    ) -> Result<BoundCommands, Error> {
        let identity = context.identity().map_err(|_| Error::Revoked)?;
        if boundaries.len() > 256 || matches!(identity.scope, Scope::DesktopUi) {
            return Err(Error::Denied);
        }
        if let Scope::Session(scope) = &identity.scope
            && root_grant.as_ref().is_some_and(|root| {
                root.source
                    .as_ref()
                    .is_none_or(|source| &source.session_id != scope)
            })
        {
            return Err(Error::Denied);
        }
        let mut grants = BTreeMap::new();
        for boundary in boundaries {
            boundary
                .validate()
                .map_err(|error| Error::Invalid(error.to_string()))?;
            if let Scope::Session(scope) = &identity.scope
                && scope != &boundary.session_id
            {
                return Err(Error::Denied);
            }
            let grant = Grant {
                workspace_origin: boundary.workspace_origin,
                boundary_revision: boundary.boundary_revision,
                sandbox_mode: boundary.sandbox_mode,
                approval_policy: boundary.approval_policy,
                cwd: boundary.cwd,
            };
            if grants.insert(boundary.session_id, grant).is_some() {
                return Err(Error::Invalid("duplicate Session authorization".into()));
            }
        }
        Ok(BoundCommands {
            executions: Arc::downgrade(self),
            namespace: Namespace::new(identity.package_id, identity.scope)
                .map_err(|error| Error::Invalid(error.to_string()))?,
            context,
            grants: Arc::new(Mutex::new(grants)),
            root_id: root_id.into(),
            submission_stop,
            root_grant,
            consent: None,
            call: None,
        })
    }
}

pub(super) fn consent_error(error: maka_protocol::OperationError) -> Error {
    match error.code {
        maka_protocol::OperationErrorCode::Unauthorized => Error::Revoked,
        maka_protocol::OperationErrorCode::CommitOutcomeUnknown => {
            Error::OutcomeUnknown(error.message)
        }
        _ => Error::Host(error.message),
    }
}
