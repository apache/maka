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

//! Session metadata policy. Execution content remains in the runtime log.
mod constraints;
mod metadata;
pub(crate) mod model;
mod name;
mod projection;
pub use projection::catalog_projection;
pub(crate) use projection::mutation_projection;

pub use metadata::apply_metadata_patch;

/// Persistent manager ownership survives unload, disabled entries and restart.
pub(crate) async fn require_unmanaged(
    log: &maka_event_log::EventLog,
    session_id: &str,
    code: maka_protocol::OperationErrorCode,
) -> std::result::Result<(), maka_protocol::OperationError> {
    if log
        .session_manager(session_id)
        .await
        .map_err(|error| maka_protocol::OperationError {
            code: maka_protocol::OperationErrorCode::PersistenceFailed,
            message: error.to_string(),
        })?
        .is_some()
    {
        return Err(maka_protocol::OperationError {
            code,
            message: "Session operation requires its manager".into(),
        });
    }
    Ok(())
}

use maka_event_log::sessions::SessionRecord;
use maka_protocol::session::*;
use maka_protocol::{ProtocolError, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

pub use maka_runtime::execution::ModelBinding as SessionModel;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum SessionTarget {
    Model {
        model: SessionModel,
    },
    Executor {
        executor_id: maka_runtime::executor::ExecutorId,
        settings: maka_runtime::executor::Settings,
    },
}
impl SessionTarget {
    pub fn model(&self) -> Option<&SessionModel> {
        match self {
            Self::Model { model } => Some(model),
            Self::Executor { .. } => None,
        }
    }
}
impl From<SessionModel> for SessionTarget {
    fn from(model: SessionModel) -> Self {
        Self::Model { model }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionConfiguration {
    pub workspace_origin: maka_runtime::execution::WorkspaceOrigin,
    pub workspace: WorkspaceProjection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<maka_fs_tools::worktree::Binding>,
    pub name: String,
    pub labels: Vec<String>,
    #[serde(default)]
    pub is_flagged: bool,
    #[serde(default)]
    pub title_is_manual: bool,
    #[serde(flatten)]
    pub target: SessionTarget,
    #[serde(default)]
    pub connection_locked: bool,
    pub thinking_level: Option<ThinkingLevel>,
    pub tool_profile: Option<SessionToolProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_tools: Option<std::collections::BTreeSet<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub sandbox_mode: SandboxMode,
    pub approval_policy: ApprovalPolicy,
    /// Revision of the enforced policy, independent of unrelated catalog changes.
    pub boundary_revision: u64,
    pub collaboration_mode: CollaborationMode,
    pub orchestration_mode: BehaviorId,
}

impl SessionConfiguration {
    pub(crate) fn plugin_view(
        &self,
        session_id: String,
        revision: u64,
    ) -> maka_plugins::session::View {
        let target = match &self.target {
            SessionTarget::Model { model } => maka_plugins::execution::Target::Model {
                model: model.clone(),
                thinking_level: self.thinking_level,
            },
            SessionTarget::Executor {
                executor_id,
                settings,
            } => maka_plugins::execution::Target::Executor {
                executor_id: executor_id.clone(),
                settings: settings.clone(),
            },
        };
        maka_plugins::session::View {
            session_id,
            revision,
            name: self.name.clone(),
            boundary_revision: self.boundary_revision,
            workspace: self.workspace.clone(),
            target,
            sandbox_mode: self.sandbox_mode,
            approval_policy: self.approval_policy,
            collaboration_mode: self.collaboration_mode,
            behavior: self.orchestration_mode.clone(),
            bound_tools: self.bound_tools.clone(),
        }
    }

    pub async fn invocation_configuration(
        &self,
    ) -> std::io::Result<maka_runtime::execution::InvocationConfiguration> {
        let workspace_identity = maka_fs_tools::workspace::ensure_identity(std::path::Path::new(
            &self.workspace.host_cwd,
        ))
        .await?;
        Ok(self.observed_configuration(workspace_identity))
    }

    pub(crate) fn observed_configuration(
        &self,
        workspace_identity: maka_runtime::execution::WorkspaceIdentity,
    ) -> maka_runtime::execution::InvocationConfiguration {
        maka_runtime::execution::InvocationConfiguration {
            system_prompt: None,
            tool_composition: None,
            cwd: self.workspace.host_cwd.clone(),
            workspace_identity: Some(workspace_identity),
            workspace_origin: self.workspace_origin,
            sandbox_mode: self.sandbox_mode,
            approval_policy: self.approval_policy,
            boundary_revision: self.boundary_revision,
            collaboration_mode: self.collaboration_mode,
            orchestration_mode: self.orchestration_mode.clone(),
            // Model presentation is resolved from the actual route at admission.
            tool_mode: maka_runtime::execution::ToolMode::Direct,
            model: self.target.model().cloned(),
            thinking_level: self.thinking_level,
        }
    }
}

/// Preparing the stable request identity precedes model/workspace resolution.
/// An exact replay can therefore succeed even if its old connection was removed.
pub struct PreparedSession {
    session_id: String,
    workspace: WorkspaceTarget,
    target: SessionCreateTarget,
    name: String,
    labels: Vec<String>,
    sandbox_mode: Option<SandboxMode>,
    approval_policy: ApprovalPolicy,
    thinking_level: SessionThinkingPreference,
    tool_profile: Option<SessionToolProfile>,
    collaboration_mode: CollaborationMode,
    orchestration_mode: BehaviorId,
}

impl PreparedSession {
    pub fn new(input: SessionCreateInput) -> Result<Self> {
        if let SessionCreateTarget::Executor {
            executor_settings, ..
        } = &input.target
        {
            executor_settings
                .validate()
                .map_err(ProtocolError::invalid)?;
        }
        if matches!(input.target, SessionCreateTarget::Executor { .. })
            && (!input.thinking_level.is_model_default()
                || input.tool_profile.is_some()
                || input.mode.is_some()
                || input
                    .orchestration_mode
                    .as_ref()
                    .is_some_and(|mode| mode != &BehaviorId::default())
                || input
                    .collaboration_mode
                    .is_some_and(|mode| mode != CollaborationMode::Agent))
        {
            return Err(ProtocolError::invalid(
                "Executor Sessions do not accept native model or orchestration settings",
            ));
        }
        if input
            .labels
            .as_ref()
            .is_some_and(|labels| labels.iter().any(|label| label == "mode:bot"))
        {
            return Err(ProtocolError::invalid(
                "Session creation cannot set reserved execution labels",
            ));
        }
        let name = name::normalize(input.name.as_deref().unwrap_or("New Chat"))?;
        let mut labels = input.labels.clone().unwrap_or_default();
        match input.mode {
            Some(SessionStartMode::Bot) => labels.push("mode:bot".into()),
            None => {}
        }
        let sandbox_mode = if input.mode.is_some() {
            Some(SandboxMode::ReadOnly)
        } else {
            input.sandbox_mode
        };
        Ok(Self {
            session_id: input.session_id,
            workspace: input.workspace,
            target: input.target,
            name,
            labels,
            sandbox_mode,
            approval_policy: input.approval_policy.unwrap_or(ApprovalPolicy::OnRequest),
            thinking_level: input.thinking_level,
            tool_profile: input.tool_profile,
            collaboration_mode: input.collaboration_mode.unwrap_or(CollaborationMode::Agent),
            orchestration_mode: input.orchestration_mode.unwrap_or_default(),
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn workspace(&self) -> &WorkspaceTarget {
        &self.workspace
    }
    pub fn target(&self) -> &SessionCreateTarget {
        &self.target
    }

    pub fn fingerprint(&self) -> String {
        let workspace = match &self.workspace {
            WorkspaceTarget::HostPath { path } => json!(["host_path", path]),
            WorkspaceTarget::Project { project_id } => json!(["project", project_id]),
        };
        let model = match &self.target {
            SessionCreateTarget::Executor {
                executor_id,
                executor_settings,
            } => json!(["executor", executor_id, executor_settings]),
            SessionCreateTarget::Model {
                model_target: SessionModelTarget::Default,
            } => json!(["default"]),
            SessionCreateTarget::Model {
                model_target:
                    SessionModelTarget::Explicit {
                        connection_id,
                        connection_slug,
                        model,
                    },
            } => json!([connection_id, connection_slug, model]),
        };
        let permission = self
            .sandbox_mode
            .map(|mode| json!(mode))
            .unwrap_or_else(|| json!(["runtime_default"]));
        let identity = json!([
            "session.create.v4",
            self.session_id,
            workspace,
            self.name,
            self.labels,
            model,
            if self.thinking_level.is_model_default() {
                json!(["model_default"])
            } else {
                json!(self.thinking_level)
            },
            self.tool_profile,
            permission,
            self.approval_policy,
            self.collaboration_mode,
            self.orchestration_mode,
        ]);
        format!(
            "sha256:{:x}",
            Sha256::digest(identity.to_string().as_bytes())
        )
    }

    pub fn bind(
        self,
        workspace: WorkspaceProjection,
        target: impl Into<SessionTarget>,
        default_permission: SandboxMode,
    ) -> SessionConfiguration {
        SessionConfiguration {
            workspace_origin: maka_runtime::execution::WorkspaceOrigin::Selected,
            workspace,
            worktree: None,
            name: self.name,
            labels: self.labels,
            is_flagged: false,
            title_is_manual: false,
            target: target.into(),
            connection_locked: false,
            thinking_level: self.thinking_level.explicit_level(),
            tool_profile: self.tool_profile,
            bound_tools: None,
            instructions: None,
            sandbox_mode: self.sandbox_mode.unwrap_or(default_permission),
            approval_policy: self.approval_policy,
            boundary_revision: 0,
            collaboration_mode: self.collaboration_mode,
            orchestration_mode: self.orchestration_mode,
        }
    }
}

/// Durable control metadata baseline. The host overlays execution status from
/// canonical runtime facts before presenting a live catalog entry.
pub fn metadata_projection(
    record: SessionRecord<SessionConfiguration>,
) -> SessionCatalogProjection {
    let config = record.configuration;
    let mut labels = Vec::new();
    let mut labels_truncated = false;
    for label in config.labels {
        if labels.len() >= 32
            || label.is_empty()
            || label.len() > 128
            || label.trim() != label
            || label.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
            || labels.contains(&label)
        {
            labels_truncated = true;
        } else {
            labels.push(label);
        }
    }
    let thinking_level = match &config.target {
        SessionTarget::Executor { settings, .. } => settings.thinking_level,
        SessionTarget::Model { .. } => config.thinking_level,
    };
    let executor_settings = match &config.target {
        SessionTarget::Executor { settings, .. } => Some(settings.clone()),
        SessionTarget::Model { .. } => None,
    };
    let (backend, executor_id, connection_id, connection_slug, model) = match config.target {
        SessionTarget::Model { model } => (
            Backend::AiSdk,
            None,
            Some(model.connection_id),
            model.connection_slug,
            model.model,
        ),
        SessionTarget::Executor {
            executor_id,
            settings,
        } => {
            let name = executor_id.as_str().to_owned();
            (
                Backend::PluginExecutor,
                Some(executor_id),
                None,
                format!("executor:{name}"),
                settings.model.unwrap_or(name),
            )
        }
    };
    SessionCatalogProjection {
        native_input: NativeInputAvailability::Ordinary,
        id: record.id,
        revision: record.revision,
        workspace: config.workspace,
        created_at: record.created_at,
        activity_at: record.updated_at,
        name: config.name,
        is_flagged: config.is_flagged,
        is_archived: record.archived,
        labels,
        labels_truncated,
        has_unread: record.read_state.has_unread,
        status: SessionStatus::Active,
        backend,
        executor_id,
        executor_settings,
        llm_connection_id: connection_id,
        llm_connection_slug: connection_slug,
        connection_locked: config.connection_locked,
        model,
        sandbox_mode: config.sandbox_mode,
        approval_policy: config.approval_policy,
        collaboration_mode: config.collaboration_mode,
        orchestration_mode: config.orchestration_mode,
        thinking_level,
        last_message_at: None,
        last_message_preview: None,
        blocked_reason: None,
        status_updated_at: None,
        parent_session_id: None,
        branch_of_turn_id: None,
        subagent: None,
        revision_root_session_id: None,
        revision_parent_session_id: None,
        revision_of_turn_id: None,
        revision_index: None,
        revision_state: None,
        last_read_message_id: record.read_state.last_read_message_id,
        live_run_state: None,
    }
}
