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
use crate::{Error, client::Client};
use agent_client_protocol::schema::v2 as acp;
use maka_agent_api::contract::{MetadataResult, Session, WorkspaceAccess};
use maka_agent_facts::configuration::ModelSelection;
use maka_agent_facts::execution::ThinkingLevel;
use maka_capabilities::call::Attachments;
use maka_settings_native::contract::{DefaultModel, ModelChoice};
use serde_json::json;

/// Per-ACP-session choices; immutable model revisions are resolved at each send.
#[derive(Clone, Default)]
pub(crate) struct Preferences {
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
}
fn selected<'a>(
    preferences: &Preferences,
    models: &'a catalog::Catalog,
) -> Result<&'a ModelChoice, Error> {
    match &preferences.model {
        Some(id) => models
            .choices
            .iter()
            .find(|choice| catalog::identity(choice) == *id)
            .ok_or_else(|| "Selected model is unavailable".into()),
        None => match &models.default {
            DefaultModel::Ready { choice, .. } => Ok(choice),
            _ => Err("Configure a default model or select an available model".into()),
        },
    }
}
pub(crate) async fn resolve(
    client: &Client,
    preferences: &Preferences,
) -> Result<ModelSelection, Error> {
    let models = catalog::read(client).await?;
    let choice = selected(preferences, &models)?;
    if preferences
        .thinking
        .is_some_and(|level| !choice.thinking_levels.contains(&level))
    {
        return Err("Thinking level is unavailable for the current model".into());
    }
    Ok(choice.selection.clone())
}
pub async fn options(
    client: &Client,
    session: &Session,
    preferences: &Preferences,
) -> Result<Vec<acp::SessionConfigOption>, Error> {
    project(session, preferences, &catalog::read(client).await?)
}
fn project(
    session: &Session,
    preferences: &Preferences,
    models: &catalog::Catalog,
) -> Result<Vec<acp::SessionConfigOption>, Error> {
    let mut model_choices = vec![acp::SessionConfigSelectOption::new(
        "default",
        "Configured default",
    )];
    model_choices.extend(models.choices.iter().map(|choice| {
        acp::SessionConfigSelectOption::new(
            catalog::identity(choice),
            format!("{} ({})", choice.label, choice.connection_name),
        )
    }));
    let mut options = vec![
        acp::SessionConfigOption::select(
            "model",
            "Model",
            preferences.model.as_deref().unwrap_or("default"),
            model_choices,
        )
        .category(acp::SessionConfigOptionCategory::Model),
    ];
    if let Ok(choice) = selected(preferences, models)
        && !choice.thinking_levels.is_empty()
    {
        let mut levels = vec![acp::SessionConfigSelectOption::new(
            "default",
            "Provider default",
        )];
        for level in &choice.thinking_levels {
            let value = wire(level)?;
            levels.push(acp::SessionConfigSelectOption::new(value.clone(), value));
        }
        options.push(
            acp::SessionConfigOption::select(
                "thinking_level",
                "Thinking level",
                preferences
                    .thinking
                    .map(|level| wire(&level))
                    .transpose()?
                    .unwrap_or_else(|| "default".into()),
                levels,
            )
            .category(acp::SessionConfigOptionCategory::ThoughtLevel),
        );
    }
    options.push(
        acp::SessionConfigOption::select(
            "sandbox_mode",
            "Workspace access",
            wire(&session.permissions.access)?,
            vec![
                acp::SessionConfigSelectOption::new("read_only", "Read only"),
                acp::SessionConfigSelectOption::new("workspace_write", "Workspace write"),
            ],
        )
        .category(acp::SessionConfigOptionCategory::Other(
            "_maka/sandbox_mode".into(),
        )),
    );
    Ok(options)
}
pub async fn set(
    client: &Client,
    session: &Session,
    preferences: &mut Preferences,
    request: acp::SetSessionConfigOptionRequest,
) -> Result<Vec<acp::SessionConfigOption>, Error> {
    if request.session_id.0.as_ref() != session.id {
        return Err("Configuration request does not match session".into());
    }
    let value = request
        .value
        .as_id()
        .ok_or("Configuration requires a select value")?
        .0
        .as_ref();
    let models = catalog::read(client).await?;
    let options = project(session, preferences, &models)?;
    let option = options
        .iter()
        .find(|option| option.config_id == request.config_id)
        .ok_or("Configuration option unavailable")?;
    let acp::SessionConfigKind::Select(select) = &option.kind else {
        return Err("Configuration requires a select option".into());
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
    match request.config_id.0.as_ref() {
        "model" => {
            preferences.model = (value != "default").then(|| value.to_owned());
            preferences.thinking = None;
        }
        "thinking_level" => {
            preferences.thinking = if value == "default" {
                None
            } else {
                Some(serde_json::from_value(json!(value))?)
            };
        }
        "sandbox_mode" => {
            let access: WorkspaceAccess = serde_json::from_value(json!(value))?;
            let mut permissions = session.permissions.clone();
            permissions.access = access;
            let result: MetadataResult = client.mutate("agent", "metadata", json!({"sessionId":session.id,"expectedRevision":session.revision,"title":session.title,"labels":session.labels,"permissions":{"settings":permissions,"revokeGrants":false}}), Attachments::new()).await?;
            return match result {
                MetadataResult::Committed { session } => project(&session, preferences, &models),
                _ => {
                    Err("Session metadata changed or was rejected; read the current session".into())
                }
            };
        }
        _ => return Err("Unsupported configuration option".into()),
    }
    project(session, preferences, &models)
}
fn wire(value: &impl serde::Serialize) -> Result<String, Error> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "Configuration value is not a string".into())
}
