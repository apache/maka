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
    BoundCommands, ChildSession, Context, Error, Executions, Grant, SessionConfiguration, storage,
};
use crate::session::PreparedSession;
use maka_plugins::session::history::{CopyResult, CopySource};
use maka_plugins::{
    authorization::Boundary,
    execution::{CreateRoot, RootApproval, SessionBoundary, Target},
};
use maka_protocol::session::{
    SessionCreateInput, SessionCreateTarget, SessionModelTarget, WorkspaceProjection,
};
use maka_runtime::execution::{SandboxMode, WorkspaceIdentity, WorkspaceTarget};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(super) struct HistorySeed {
    pub input: CopySource,
    pub call: maka_plugins::call::Scope,
    pub owner: Context,
}

#[derive(Clone, serde::Serialize)]
pub(super) struct RootGrant {
    pub workspace_origin: maka_runtime::execution::WorkspaceOrigin,
    pub workspace: WorkspaceProjection,
    pub workspace_identity: WorkspaceIdentity,
    pub sandbox_mode: SandboxMode,
    pub approval_policy: maka_runtime::execution::ApprovalPolicy,
    pub source: Option<SessionBoundary>,
}
impl From<RootApproval> for RootGrant {
    fn from(approval: RootApproval) -> Self {
        Self {
            workspace_origin: approval.source.as_ref().map_or(
                maka_runtime::execution::WorkspaceOrigin::Selected,
                |source| source.workspace_origin,
            ),
            workspace: WorkspaceProjection {
                target: approval.template.workspace,
                host_cwd: approval.template.cwd,
            },
            workspace_identity: approval.template.workspace_identity,
            sandbox_mode: approval.template.sandbox_mode,
            approval_policy: approval.template.approval_policy,
            source: approval.source,
        }
    }
}

impl BoundCommands {
    pub(super) fn root_id(&self, operation_id: &str) -> Result<String, Error> {
        if operation_id.is_empty()
            || operation_id.len() > 256
            || operation_id
                .chars()
                .any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(Error::Invalid("invalid root operation ID".into()));
        }
        let bytes = serde_json::to_vec(&(
            "plugin-root-v1",
            self.namespace.package(),
            String::from(self.namespace.scope().clone()),
            operation_id,
        ))
        .map_err(|error| Error::Invalid(error.to_string()))?;
        Ok(format!("plugin-root-{:x}", Sha256::digest(bytes)))
    }

    pub(super) async fn restore_created_root(
        &self,
        operation_id: String,
    ) -> Result<Option<ChildSession>, Error> {
        let id = self.root_id(&operation_id)?;
        let approval = self.root_grant.as_ref().ok_or(Error::Denied)?;
        let host = self.executions()?;
        let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
        self.authorize_origin(&host).await?;
        let project = observe_workspace(&host, approval).await?;
        let _gate = host.interactions.own_admission().await;
        self.authorize_origin(&host).await?;
        recheck_project(&host, project).await?;
        if !host.accepting() {
            return Err(Error::Draining);
        }
        if self.submission_stop.is_cancelled() {
            return Err(Error::Revoked);
        }
        let Some(record) = self.owned_root(&host, &id, approval).await? else {
            return Ok(None);
        };
        let current = &record.configuration;
        self.grants.lock().unwrap().insert(
            id.clone(),
            Grant {
                workspace_origin: current.workspace_origin,
                boundary_revision: current.boundary_revision,
                sandbox_mode: current.sandbox_mode,
                approval_policy: current.approval_policy,
                cwd: current.workspace.host_cwd.clone(),
            },
        );
        Ok(Some(ChildSession { session_id: id }))
    }

    pub(super) async fn owned_root(
        &self,
        host: &Executions,
        id: &str,
        approval: &RootGrant,
    ) -> Result<Option<maka_event_log::sessions::SessionRecord<SessionConfiguration>>, Error> {
        let Some(record) = host
            .log
            .get_session::<SessionConfiguration>(id)
            .await
            .map_err(storage)?
        else {
            return Ok(None);
        };
        if host
            .log
            .session_creator(id)
            .await
            .map_err(storage)?
            .as_ref()
            != Some(&self.namespace)
        {
            return Err(Error::Denied);
        }
        self.check_root_configuration(host, &record.configuration, approval)
            .await?;
        Ok(Some(record))
    }

    pub(super) async fn check_root_configuration(
        &self,
        host: &Executions,
        current: &SessionConfiguration,
        approval: &RootGrant,
    ) -> Result<(), Error> {
        if current.workspace != approval.workspace
            || current.workspace_origin != approval.workspace_origin
            || rank(current.sandbox_mode) > rank(approval.sandbox_mode)
            || !current
                .approval_policy
                .is_subset_of(approval.approval_policy)
        {
            return Err(Error::Denied);
        }
        if let Some(source) = &approval.source {
            let origin = host
                .log
                .get_session::<SessionConfiguration>(&source.session_id)
                .await
                .map_err(storage)?
                .ok_or(Error::NotFound)?;
            let parent = &origin.configuration;
            if rank(current.sandbox_mode) > rank(parent.sandbox_mode)
                || !current.approval_policy.is_subset_of(parent.approval_policy)
                || current.workspace.host_cwd != parent.workspace.host_cwd
                || current.workspace_origin != parent.workspace_origin
                || parent.bound_tools.as_ref().is_some_and(|ceiling| {
                    current
                        .bound_tools
                        .as_ref()
                        .is_none_or(|tools| !tools.is_subset(ceiling))
                })
                || parent.tool_profile.is_some() && current.tool_profile != parent.tool_profile
                || parent.instructions.as_ref().is_some_and(|base| {
                    current.instructions.as_ref().is_none_or(|text| {
                        text != base
                            && !text
                                .strip_prefix(base)
                                .is_some_and(|tail| tail.starts_with("\n\n"))
                    })
                })
            {
                return Err(Error::Denied);
            }
        }
        Ok(())
    }

    pub(super) async fn abandon_created_revision(
        &self,
        operation_id: String,
    ) -> Result<maka_plugins::execution::RevisionDisposition, Error> {
        use maka_plugins::execution::RevisionDisposition;
        let id = self.root_id(&operation_id)?;
        let approval = self.root_grant.as_ref().ok_or(Error::Denied)?;
        let host = self.executions()?;
        let lease = self.context.admit().map_err(|_| Error::Revoked)?;
        self.authorize_origin(&host).await?;
        let project = observe_workspace(&host, approval).await?;
        let gate = host.interactions.own_admission().await;
        self.authorize_origin(&host).await?;
        recheck_project(&host, project).await?;
        if !host.accepting() {
            return Err(Error::Draining);
        }
        if self.submission_stop.is_cancelled() {
            return Err(Error::Revoked);
        }
        // A removed draft retains its creator and receipt, but no live
        // configuration. Never interpret an arbitrary missing ID as success.
        if host
            .log
            .session_creator(&id)
            .await
            .map_err(storage)?
            .as_ref()
            != Some(&self.namespace)
        {
            return Err(Error::NotFound);
        }
        self.owned_root(&host, &id, approval).await?;
        let receipt = host
            .log
            .session_copy_receipt(&id)
            .await
            .map_err(storage)?
            .ok_or(Error::NotFound)?;
        if !matches!(
            receipt.request.purpose,
            maka_runtime::session::CopyPurpose::Revision { .. }
        ) {
            return Err(Error::Invalid(
                "only a revision draft can be abandoned".into(),
            ));
        }
        let worker = host.clone();
        let grants = self.grants.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        host.workers.spawn(async move {
            let result = worker.log.abandon_revision(&id).await.map_err(storage);
            let result = match result {
                Ok(maka_event_log::sessions::AbandonRevision::Abandoned) => {
                    grants.lock().unwrap().remove(&id);
                    worker.request_removal_recovery();
                    worker.publish_session_change(&id).await;
                    Ok(RevisionDisposition::Abandoned)
                }
                Ok(maka_event_log::sessions::AbandonRevision::Retained) => {
                    Ok(RevisionDisposition::Retained)
                }
                Err(error) => Err(error),
            };
            if matches!(result, Err(Error::OutcomeUnknown(_))) {
                worker.begin_drain();
            }
            drop(gate);
            drop(lease);
            let _ = send.send(result);
        });
        receive
            .await
            .map_err(|_| Error::OutcomeUnknown("revision abandonment owner disappeared".into()))?
    }

    pub(super) async fn authorize_origin(&self, host: &Executions) -> Result<(), Error> {
        if let Some(call) = &self.call {
            match host.plugin_execution_boundary(call).await? {
                Boundary::Session { boundary, .. } => {
                    let grants = self.grants.lock().unwrap();
                    let grant = grants.get(&boundary.session_id).ok_or(Error::Denied)?;
                    if grant.boundary_revision != boundary.boundary_revision
                        || grant.sandbox_mode != boundary.sandbox_mode
                        || grant.approval_policy != boundary.approval_policy
                        || grant.cwd != boundary.cwd
                        || grant.workspace_origin != boundary.workspace_origin
                    {
                        return Err(Error::Denied);
                    }
                }
                Boundary::Workspace {
                    workspace,
                    workspace_identity,
                    origin,
                    sandbox_mode,
                } => {
                    let grant = self.root_grant.as_ref().ok_or(Error::Denied)?;
                    if grant.workspace != workspace
                        || grant.workspace_origin != origin
                        || grant.workspace_identity != workspace_identity
                        || grant.sandbox_mode != sandbox_mode
                    {
                        return Err(Error::Denied);
                    }
                }
                Boundary::Profile | Boundary::Directory { .. } => return Err(Error::Denied),
            }
        }
        if let Some(id) = self.consent {
            crate::server::plugin_authorization::validate(
                &host.log,
                &host.configuration,
                &self.namespace,
                id,
                maka_plugins::authorization::Capability::Executions,
            )
            .await
            .map_err(super::authority::consent_error)?;
        }
        let Some(source) = self
            .root_grant
            .as_ref()
            .and_then(|root| root.source.as_ref())
        else {
            return Ok(());
        };
        if host
            .log
            .session_manager(&source.session_id)
            .await
            .map_err(storage)?
            .is_some_and(|manager| manager != self.namespace)
        {
            return Err(Error::Denied);
        }
        let current = host
            .log
            .get_session::<SessionConfiguration>(&source.session_id)
            .await
            .map_err(storage)?
            .ok_or(Error::NotFound)?;
        if current.archived
            || current.configuration.boundary_revision != source.boundary_revision
            || current.configuration.sandbox_mode != source.sandbox_mode
            || current.configuration.approval_policy != source.approval_policy
            || current.configuration.workspace.host_cwd != source.cwd
            || current.configuration.workspace_origin != source.workspace_origin
        {
            return Err(Error::Denied);
        }
        Ok(())
    }
    pub(super) async fn root(&self, request: CreateRoot) -> Result<ChildSession, Error> {
        match self.root_with_history(request, None).await? {
            CopyResult::Committed { session } => Ok(session),
            CopyResult::SourceRevisionConflict { .. } => Err(Error::Conflict),
        }
    }

    pub(super) async fn root_with_history(
        &self,
        request: CreateRoot,
        history: Option<HistorySeed>,
    ) -> Result<CopyResult, Error> {
        request
            .validate()
            .map_err(|error| Error::Invalid(error.to_string()))?;
        let approval = self.root_grant.as_ref().ok_or(Error::Denied)?;
        if rank(request.settings.sandbox_mode) > rank(approval.sandbox_mode)
            || !request
                .settings
                .approval_policy
                .is_subset_of(approval.approval_policy)
        {
            return Err(Error::Denied);
        }
        let host = self.executions()?;
        let lease = self.context.admit().map_err(|_| Error::Revoked)?;
        self.authorize_origin(&host).await?;
        let id = self.root_id(&request.operation_id)?;
        let fingerprint = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(&(approval, &request, history.as_ref().map(|seed| &seed.input)))
                    .map_err(|error| Error::Invalid(error.to_string()))?
            )
        );
        let observed_project = observe_workspace(&host, approval).await?;
        let gate = host.interactions.own_admission().await;
        self.authorize_origin(&host).await?;
        recheck_project(&host, observed_project).await?;
        let history_lease = history
            .as_ref()
            .map(|seed| seed.owner.admit().map_err(|_| Error::Revoked))
            .transpose()?;
        let existing = host
            .log
            .probe_session_create::<SessionConfiguration>(&id, &fingerprint)
            .await
            .map_err(storage)?;
        if existing.is_none()
            && let Some(seed) = &history
        {
            if let Target::Executor { executor_id, .. } = &request.settings.target
                && !host
                    .executor_binding(&id, executor_id)
                    .map_err(|error| Error::Invalid(error.message))?
                    .capabilities()
                    .history_copy
            {
                return Err(Error::Invalid(
                    "executor conversations cannot be seeded from copied history".into(),
                ));
            }
            host.check_history_target(&seed.call, &seed.input.session_id)
                .await?;
            let source = host
                .log
                .get_session::<SessionConfiguration>(&seed.input.session_id)
                .await
                .map_err(storage)?
                .ok_or(Error::NotFound)?;
            if source.configuration.workspace.host_cwd != approval.workspace.host_cwd {
                return Err(Error::Invalid(
                    "copied workspace references require the same destination workspace".into(),
                ));
            }
        }
        let approval = approval.clone();
        let worker = host.clone();
        let grants = self.grants.clone();
        let namespace = self.namespace.clone();
        let submission_stop = self.submission_stop.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        host.workers.spawn(async move {
            let result = async {
                if !worker.accepting() {
                    return Err(Error::Draining);
                }
                let expected =
                    configuration(&worker, &id, &request, &approval, existing.is_none()).await?;
                worker.validate_workspace(&expected).map_err(|error| Error::Invalid(error.message))?;
                let record = match existing {
                    Some(record) => record,
                    None => {
                        if submission_stop.is_cancelled() {
                            return Err(Error::Revoked);
                        }
                        let origin = maka_event_log::sessions::PluginSession {
                            session_id: id.clone(),
                            creator: namespace.clone(),
                            fingerprint: fingerprint.clone(),
                            managed: request.managed,
                            authority_session_id: approval.source.as_ref().map(|source| source.session_id.clone()),
                        };
                        let record = if let Some(seed) = &history {
                            match worker.log.copy_plugin_session(
                                maka_runtime::session::CopyRequest {
                                    source_session_id: seed.input.session_id.clone(),
                                    target_session_id: id.clone(),
                                    expected_source_revision: seed.input.expected_revision,
                                    purpose: seed.input.purpose.clone(),
                                }, &expected, now()?, origin,
                            ).await.map_err(storage)? {
                                maka_event_log::sessions::SessionCopyResult::Committed(record) => *record,
                                maka_event_log::sessions::SessionCopyResult::SourceRevisionConflict { expected, actual } => {
                                    return Ok(CopyResult::SourceRevisionConflict { expected_revision: expected, actual_revision: actual });
                                }
                            }
                        } else {
                            worker.log.create_plugin_session(&origin, &expected, now()?).await.map_err(storage)?
                        };
                        let changed = std::iter::once(id.as_str())
                            .chain(history.as_ref().map(|seed| seed.input.session_id.as_str()))
                            .chain(approval.source.as_ref().map(|source| source.session_id.as_str()))
                            .collect::<std::collections::BTreeSet<_>>();
                        for session in changed {
                            worker.publish_session_change(session).await;
                        }
                        record
                    }
                };
                let manager = worker.log.session_manager(&id).await.map_err(storage)?;
                if manager.as_ref() != request.managed.then_some(&namespace)
                    || worker
                        .log
                        .session_creator(&id)
                        .await
                        .map_err(storage)?
                        .as_ref()
                        != Some(&namespace)
                {
                    return Err(Error::Denied);
                }
                let current = &record.configuration;
                if record.archived
                    || current.boundary_revision != 0
                    || current.workspace != expected.workspace
                    || current.workspace_origin != expected.workspace_origin
                    || current.sandbox_mode != expected.sandbox_mode
                    || current.approval_policy != expected.approval_policy
                    || current.collaboration_mode != expected.collaboration_mode
                    || current.orchestration_mode != expected.orchestration_mode
                    || current.instructions != expected.instructions
                    || current.tool_profile != expected.tool_profile
                    || current.bound_tools != expected.bound_tools
                {
                    return Err(Error::Denied);
                }
                grants.lock().unwrap().insert(
                    id.clone(),
                    Grant {
                        workspace_origin: record.configuration.workspace_origin,
                        boundary_revision: 0,
                        sandbox_mode: expected.sandbox_mode,
                        approval_policy: expected.approval_policy,
                        cwd: expected.workspace.host_cwd,
                    },
                );
                Ok(CopyResult::Committed { session: ChildSession { session_id: id } })
            }
            .await;
            if matches!(result, Err(Error::OutcomeUnknown(_))) {
                worker.begin_drain();
            }
            drop(gate);
            drop(lease);
            drop(history_lease);
            let _ = send.send(result);
        });
        receive
            .await
            .map_err(|_| Error::OutcomeUnknown("root Session owner disappeared".into()))?
    }
}

// Filesystem observation never holds Host-wide admission.
pub(super) async fn observe_workspace(
    host: &Executions,
    approval: &RootGrant,
) -> Result<Option<maka_event_log::projects::ProjectRecord>, Error> {
    let project = match &approval.workspace.target {
        WorkspaceTarget::Project { project_id } => Some(
            host.log
                .get_project(project_id)
                .await
                .map_err(storage)?
                .ok_or(Error::NotFound)?,
        ),
        WorkspaceTarget::HostPath { .. } => None,
    };
    if let Some(project) = &project {
        let resolved = crate::server::resolve_project_workspace(project.clone())
            .await
            .map_err(|error| Error::Invalid(error.message))?;
        if resolved.host_cwd != approval.workspace.host_cwd {
            return Err(Error::Denied);
        }
    }
    let path = std::path::PathBuf::from(&approval.workspace.host_cwd);
    let expected = approval.workspace_identity.clone();
    tokio::task::spawn_blocking(move || {
        let canonical = path
            .canonicalize()
            .map_err(|error| Error::Host(error.to_string()))?;
        if maka_fs_tools::workspace::project::host_path(&canonical)
            .map_err(|error| Error::Host(error.to_string()))?
            != path.to_str().ok_or(Error::Denied)?
            || maka_fs_tools::workspace::read_identity(&canonical)
                .map_err(|error| Error::Host(error.to_string()))?
                != expected
        {
            return Err(Error::Denied);
        }
        Ok(())
    })
    .await
    .map_err(|error| Error::Host(error.to_string()))??;
    Ok(project)
}

pub(super) async fn recheck_project(
    host: &Executions,
    project: Option<maka_event_log::projects::ProjectRecord>,
) -> Result<(), Error> {
    if let Some(project) = project
        && host
            .log
            .get_project(&project.id)
            .await
            .map_err(storage)?
            .as_ref()
            != Some(&project)
    {
        return Err(Error::Conflict);
    }
    Ok(())
}

pub(super) async fn configuration(
    host: &Arc<Executions>,
    id: &str,
    request: &CreateRoot,
    approval: &RootGrant,
    resolve_target: bool,
) -> Result<SessionConfiguration, Error> {
    let settings = &request.settings;
    let (target, bound, thinking_level) = match &settings.target {
        Target::Model {
            model,
            thinking_level,
        } => {
            let target = SessionModelTarget::Explicit {
                connection_id: model.connection_id.clone(),
                connection_slug: model.connection_slug.clone(),
                model: model.model.clone(),
            };
            let bound = if resolve_target {
                crate::session::model::resolve(&host.configuration, &target, *thinking_level)
                    .await
                    .map_err(|error| Error::Invalid(error.message))?
            } else {
                model.clone()
            };
            (
                SessionCreateTarget::Model {
                    model_target: target,
                },
                bound.into(),
                *thinking_level,
            )
        }
        Target::Executor {
            executor_id,
            settings,
        } => {
            if resolve_target {
                host.executor_binding(id, executor_id)
                    .map_err(|error| Error::Invalid(error.message))?;
            }
            (
                SessionCreateTarget::Executor {
                    executor_id: executor_id.clone(),
                    executor_settings: settings.clone(),
                },
                crate::session::SessionTarget::Executor {
                    executor_id: executor_id.clone(),
                    settings: settings.clone(),
                },
                None,
            )
        }
    };
    let prepared = PreparedSession::new(SessionCreateInput {
        session_id: id.into(),
        workspace: approval.workspace.target.clone(),
        target,
        mode: None,
        name: Some(request.name.clone()),
        labels: None,
        thinking_level: match &settings.target {
            Target::Model { .. } => thinking_level.into(),
            Target::Executor { .. } => Default::default(),
        },
        tool_profile: None,
        // bind below uses the explicit root settings, never global defaults.
        sandbox_mode: None,
        approval_policy: Some(settings.approval_policy),
        collaboration_mode: Some(settings.collaboration_mode),
        orchestration_mode: Some(settings.behavior.clone()),
    })
    .map_err(|error| Error::Invalid(error.to_string()))?;
    let mut config = prepared.bind(approval.workspace.clone(), bound, settings.sandbox_mode);
    config.bound_tools = settings.bound_tools.clone();
    config.workspace_origin = approval.workspace_origin;
    config.instructions = settings.instructions.clone();
    if let Some(source) = &approval.source {
        if rank(settings.sandbox_mode) > rank(source.sandbox_mode)
            || !settings
                .approval_policy
                .is_subset_of(source.approval_policy)
            || approval.workspace.host_cwd != source.cwd
        {
            return Err(Error::Denied);
        }
        let origin = host
            .log
            .get_session::<SessionConfiguration>(&source.session_id)
            .await
            .map_err(storage)?
            .ok_or(Error::NotFound)?;
        if let Some(ceiling) = origin.configuration.bound_tools {
            config.bound_tools = Some(match config.bound_tools {
                Some(selected) => selected.intersection(&ceiling).cloned().collect(),
                None => ceiling,
            });
        }
        config.tool_profile = origin.configuration.tool_profile;
        config.instructions = match (origin.configuration.instructions, config.instructions) {
            (Some(base), Some(extra)) => Some(format!("{base}\n\n{extra}")),
            (base, extra) => base.or(extra),
        };
        if config
            .instructions
            .as_ref()
            .is_some_and(|text| text.len() > 16 * 1024)
        {
            return Err(Error::Invalid("combined instructions exceed 16 KiB".into()));
        }
    }
    Ok(config)
}
pub(super) fn rank(mode: SandboxMode) -> u8 {
    match mode {
        SandboxMode::ReadOnly => 0,
        SandboxMode::WorkspaceWrite => 1,
        SandboxMode::DangerFullAccess => 2,
    }
}
pub(super) fn now() -> Result<u64, Error> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| Error::Host(error.to_string()))?
        .as_millis()
        .try_into()
        .map_err(|_| Error::Host("clock overflow".into()))
}
