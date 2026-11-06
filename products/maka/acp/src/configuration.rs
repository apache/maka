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
use maka_agent_api::contract::{MetadataResult, Session, WorkspaceAccess};
use maka_agent_facts::configuration::ModelSelection;
use maka_agent_facts::execution::ThinkingLevel;
use maka_capabilities::call::Attachments;
use maka_settings_native::contract::{DefaultModel, ModelChoice};
use serde_json::json;

#[derive(Clone)]
pub(crate) struct Select {
    pub id: String,
    pub name: String,
    pub current: String,
    pub category: Category,
    pub choices: Vec<Choice>,
}
#[derive(Clone, Copy)]
pub(crate) enum Category {
    Model,
    ThoughtLevel,
    WorkspaceAccess,
}
#[derive(Clone)]
pub(crate) struct Choice {
    pub value: String,
    pub name: String,
}
impl Choice {
    fn new(value: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            name: name.into(),
        }
    }
}

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
) -> Result<Vec<Select>, Error> {
    project(session, preferences, &catalog::read(client).await?)
}
fn project(
    session: &Session,
    preferences: &Preferences,
    models: &catalog::Catalog,
) -> Result<Vec<Select>, Error> {
    let mut choices = vec![Choice::new("default", "Configured default")];
    choices.extend(models.choices.iter().map(|choice| {
        Choice::new(
            catalog::identity(choice),
            format!("{} ({})", choice.label, choice.connection_name),
        )
    }));
    let mut options = vec![Select {
        id: "model".into(),
        name: "Model".into(),
        current: preferences.model.as_deref().unwrap_or("default").into(),
        category: Category::Model,
        choices,
    }];
    if let Ok(choice) = selected(preferences, models)
        && !choice.thinking_levels.is_empty()
    {
        let mut choices = vec![Choice::new("default", "Provider default")];
        for level in &choice.thinking_levels {
            let value = wire(level)?;
            choices.push(Choice::new(value.clone(), value));
        }
        options.push(Select {
            id: "thinking_level".into(),
            name: "Thinking level".into(),
            current: preferences
                .thinking
                .map(|level| wire(&level))
                .transpose()?
                .unwrap_or_else(|| "default".into()),
            category: Category::ThoughtLevel,
            choices,
        });
    }
    options.push(Select {
        id: "sandbox_mode".into(),
        name: "Workspace access".into(),
        current: wire(&session.permissions.access)?,
        category: Category::WorkspaceAccess,
        choices: vec![
            Choice::new("read_only", "Read only"),
            Choice::new("workspace_write", "Workspace write"),
        ],
    });
    Ok(options)
}

pub async fn set(
    client: &Client,
    session: &Session,
    preferences: &mut Preferences,
    id: &str,
    value: &str,
) -> Result<Vec<Select>, Error> {
    let models = catalog::read(client).await?;
    let options = project(session, preferences, &models)?;
    let option = options
        .iter()
        .find(|option| option.id == id)
        .ok_or("Configuration option unavailable")?;
    if !option.choices.iter().any(|choice| choice.value == value) {
        return Err("Unsupported configuration value".into());
    }
    match id {
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
