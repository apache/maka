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

mod catalog;

use agent_client_protocol::schema::v2 as acp;
use maka_client::Client;
use maka_protocol::session::*;
use maka_runtime::configuration::Patch;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Selector {
    Model,
    ThinkingLevel,
    CollaborationMode,
    SandboxMode,
}

pub async fn create(
    client: &Client,
    id: &str,
    cwd: &Path,
) -> Result<SessionCatalogProjection, crate::Error> {
    // The same omissions as TUI creation let Host resolve persisted defaults.
    let input = SessionCreateInput {
        session_id: id.into(),
        workspace: WorkspaceTarget::HostPath {
            path: cwd.to_str().ok_or("Workspace path must be UTF-8")?.into(),
        },
        target: SessionCreateTarget::Model {
            model_target: SessionModelTarget::Default,
        },
        mode: None,
        name: None,
        labels: None,
        thinking_level: SessionThinkingPreference::ModelDefault,
        tool_profile: None,
        sandbox_mode: None,
        approval_policy: None,
        collaboration_mode: None,
        orchestration_mode: None,
    };
    Ok(client.create_session(input).await?)
}

pub async fn options(
    client: &Client,
    session: &SessionCatalogProjection,
) -> Result<Vec<acp::SessionConfigOption>, crate::Error> {
    let models = catalog::read(client).await?;
    project(session, &models)
}

fn project(
    session: &SessionCatalogProjection,
    models: &[catalog::Model],
) -> Result<Vec<acp::SessionConfigOption>, crate::Error> {
    let mut options = Vec::new();
    let current = catalog::identity(
        session.llm_connection_id.as_deref().unwrap_or(""),
        &session.model,
    );
    if session.executor_id.is_none() {
        if models.iter().any(|model| model.id == current) {
            options.push(select(
                "model",
                "Model",
                acp::SessionConfigOptionCategory::Model,
                &current,
                models
                    .iter()
                    .map(|model| {
                        acp::SessionConfigSelectOption::new(model.id.clone(), model.name.clone())
                    })
                    .collect(),
            ));
        }
        if let Some(model) = models
            .iter()
            .find(|model| model.id == current)
            .filter(|model| !model.thinking.is_empty())
        {
            let mut choices = vec![acp::SessionConfigSelectOption::new(
                "default",
                "Provider default",
            )];
            for level in &model.thinking {
                let value = wire(level)?;
                choices.push(acp::SessionConfigSelectOption::new(value.clone(), value));
            }
            options.push(select(
                "thinking_level",
                "Thinking level",
                acp::SessionConfigOptionCategory::ThoughtLevel,
                &session
                    .thinking_level
                    .map(|level| wire(&level))
                    .transpose()?
                    .unwrap_or_else(|| "default".into()),
                choices,
            ));
        }
        options.push(select(
            "collaboration_mode",
            "Collaboration mode",
            acp::SessionConfigOptionCategory::Mode,
            &wire(&session.collaboration_mode)?,
            choices(&[("agent", "Agent"), ("plan", "Plan")]),
        ));
    }
    options.push(select(
        "sandbox_mode",
        "Permission mode",
        acp::SessionConfigOptionCategory::Other("_maka/sandbox_mode".into()),
        &wire(&session.sandbox_mode)?,
        choices(&[
            ("read-only", "Read only"),
            ("workspace-write", "Workspace write"),
            ("danger-full-access", "Full access"),
        ]),
    ));
    Ok(options)
}

pub async fn set(
    client: &Client,
    session: &SessionCatalogProjection,
    request: acp::SetSessionConfigOptionRequest,
) -> Result<SessionCatalogProjection, crate::Error> {
    if request.session_id.0.as_ref() != session.id {
        return Err("Configuration request does not match session".into());
    }
    let selector: Selector =
        serde_json::from_value(serde_json::Value::String(request.config_id.to_string()))?;
    let value = request
        .value
        .as_id()
        .ok_or("Configuration requires a select value")?
        .0
        .as_ref();
    let models = catalog::read(client).await?;
    let available = project(session, &models)?;
    let option = available
        .iter()
        .find(|option| option.config_id == request.config_id)
        .ok_or("Configuration option unavailable for this session")?;
    let acp::SessionConfigKind::Select(select) = &option.kind else {
        return Err("Configuration is not a select option".into());
    };
    let acp::SessionConfigSelectOptions::Ungrouped(choices) = &select.options else {
        return Err("Unsupported configuration choices".into());
    };
    if !choices
        .iter()
        .any(|choice| choice.value.0.as_ref() == value)
    {
        return Err("Unsupported configuration value".into());
    }
    let patch = patch(selector, value, &models)?;
    match client
        .update_session_configuration(SessionConfigurationUpdateInput {
            session_id: session.id.clone(),
            expected_revision: session.revision,
            patch,
        })
        .await?
    {
        SessionUpdateResult::Committed { session } => Ok(*session),
        SessionUpdateResult::RevisionConflict { .. } => {
            Err("Session configuration changed; retry with the current session".into())
        }
    }
}

fn patch(
    selector: Selector,
    value: &str,
    models: &[catalog::Model],
) -> Result<SessionConfigurationPatch, crate::Error> {
    let mut patch = SessionConfigurationPatch {
        model_target: None,
        executor_target: None,
        thinking_level: Patch::Keep,
        sandbox_mode: None,
        approval_policy: None,
        collaboration_mode: None,
        orchestration_mode: None,
    };
    let encoded = serde_json::Value::String(value.into());
    match selector {
        Selector::Model => {
            patch.model_target = Some(
                models
                    .iter()
                    .find(|model| model.id == value)
                    .ok_or("Model unavailable")?
                    .target
                    .clone(),
            );
            // Thinking from the previous model must not leak into the new model.
            patch.thinking_level = Patch::Clear;
        }
        Selector::ThinkingLevel => {
            patch.thinking_level = if value == "default" {
                Patch::Clear
            } else {
                Patch::Set(serde_json::from_value(encoded)?)
            }
        }
        Selector::CollaborationMode => {
            patch.collaboration_mode = Some(serde_json::from_value(encoded)?)
        }
        Selector::SandboxMode => patch.sandbox_mode = Some(serde_json::from_value(encoded)?),
    }
    Ok(patch)
}

fn wire(value: &impl Serialize) -> Result<String, crate::Error> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "Configuration value is not a string".into())
}

fn choices(values: &[(&str, &str)]) -> Vec<acp::SessionConfigSelectOption> {
    values
        .iter()
        .map(|(value, name)| acp::SessionConfigSelectOption::new(*value, *name))
        .collect()
}

fn select(
    id: &str,
    name: &str,
    category: acp::SessionConfigOptionCategory,
    current: &str,
    options: Vec<acp::SessionConfigSelectOption>,
) -> acp::SessionConfigOption {
    acp::SessionConfigOption::select(id, name, current, options).category(category)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changing_sandbox_does_not_disable_approval_or_accept_unknown_values() {
        let patch = patch(Selector::SandboxMode, "danger-full-access", &[]).unwrap();
        assert_eq!(patch.sandbox_mode, Some(SandboxMode::DangerFullAccess));
        assert_eq!(patch.approval_policy, None);
        assert!(super::patch(Selector::SandboxMode, "unrestricted", &[]).is_err());
        assert!(super::patch(Selector::CollaborationMode, "swarm", &[]).is_err());
    }

    #[test]
    fn model_change_clears_previous_thinking_and_requires_configured_identity() {
        let model = catalog::Model {
            id: catalog::identity("connection", "model"),
            name: "Model".into(),
            target: SessionModelTarget::Explicit {
                connection_id: "connection".into(),
                connection_slug: "connection".into(),
                model: "model".into(),
            },
            thinking: vec![ThinkingLevel::Low],
        };
        let selected = model.id.clone();
        let models = [model];
        let patch = patch(Selector::Model, &selected, &models).unwrap();
        assert_eq!(patch.thinking_level, Patch::Clear);
        assert_eq!(patch.model_target, Some(models[0].target.clone()));
        assert!(super::patch(Selector::Model, "model", &models).is_err());
    }
}
