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

use super::*;
use maka_agent_api::contract::{
    ModelChoice, ModelRead, ModelResult, ModelsCursor, ModelsPage, ModelsRead,
};
use maka_agent_facts::executor::{BackendPreference, Selection, Settings};
use maka_agent_ports::executor::Error as ExecutorError;

impl Owner {
    async fn native_choices(&self) -> Result<Vec<ModelChoice>, String> {
        let snapshot = self
            .catalog
            .snapshot
            .read()
            .await
            .as_ref()
            .map_err(|_| "agent_configuration_unavailable")?
            .clone();
        let catalog = self
            .configuration
            .catalog()
            .await
            .map_err(|_| "agent_configuration_unavailable")?;
        let mut choices = Vec::new();
        for row in catalog.connections.iter().filter(|row| row.enabled) {
            if maka_providers::definition(&row.provider, snapshot.clone()).is_err() {
                continue;
            }
            for id in &row.enabled_model_ids {
                let overrides = row
                    .model_overrides
                    .as_ref()
                    .and_then(|all| all.get(id))
                    .cloned();
                let metadata = match maka_providers::model_metadata(
                    row,
                    id,
                    overrides,
                    snapshot.clone(),
                )
                .await
                {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                choices.push(ModelChoice {
                    selection: BackendPreference::Model {
                        connection_id: row.connection_id.clone(),
                        model_id: id.clone(),
                        thinking_level: None,
                    },
                    source_name: row.name.clone(),
                    label: metadata.info.display_name.unwrap_or_else(|| id.clone()),
                    thinking_levels: metadata.thinking_levels.into_iter().map(level).collect(),
                    default_thinking_level: metadata.default_thinking_level.map(level),
                });
            }
        }
        Ok(choices)
    }
    async fn external_choices(
        &self,
        requested_runtime: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ModelChoice>, ExecutorError> {
        if !self.executors.contains("external") {
            return Ok(Vec::new());
        }
        let Some(cwd) = self.external_cwd().await.map_err(ExecutorError::Provider)? else {
            return Ok(Vec::new());
        };
        let request = serde_json::json!({"kind":"catalog", "cwd":cwd});
        let Some(catalog) = self
            .executors
            .external_query(cwd, request, cancellation.clone())
            .await?
        else {
            return Ok(Vec::new());
        };
        let runtimes = catalog
            .as_array()
            .ok_or_else(|| ExecutorError::Provider("agent_external_catalog_invalid".into()))?;
        let mut choices = Vec::new();
        for runtime in runtimes {
            let runtime_id = runtime
                .get("runtime")
                .and_then(Value::as_str)
                .ok_or_else(|| ExecutorError::Provider("agent_external_catalog_invalid".into()))?;
            if requested_runtime.is_some_and(|requested| requested != runtime_id) {
                continue;
            }
            for field in ["installation", "models"] {
                if let Some(error) = runtime
                    .get(field)
                    .filter(|value| value.get("kind").and_then(Value::as_str) == Some("error"))
                {
                    tracing::warn!(
                        runtime = runtime_id,
                        stage = field,
                        detail = error.get("detail").and_then(serde_json::Value::as_str),
                        "External agent model discovery failed"
                    );
                }
            }
            if runtime.get("installation").is_some_and(|installation| {
                !matches!(
                    installation.get("kind").and_then(Value::as_str),
                    Some("not_found" | "error" | "unsupported")
                )
            }) && runtime
                .pointer("/authentication/kind")
                .and_then(Value::as_str)
                != Some("unauthenticated")
            {
                let native = runtime_id
                    .parse::<maka_agent_api::executor::NativeRuntime>()
                    .map_err(|error| {
                        ExecutorError::Provider(format!("agent_external_catalog_invalid: {error}"))
                    })?;
                choices.push(ModelChoice {
                    selection: BackendPreference::Executor {
                        selection: Selection {
                            executor: "external".into(),
                            settings: Settings {
                                runtime: Some(runtime_id.into()),
                                model: None,
                                thinking_level: None,
                            },
                        },
                    },
                    source_name: format!("Native CLI · {}", native.name()),
                    label: format!("{} · native default", native.name()),
                    thinking_levels: vec![],
                    default_thinking_level: None,
                });
            }
            if runtime.pointer("/models/kind").and_then(Value::as_str) != Some("ok") {
                continue;
            }
            let models = runtime
                .pointer("/models/models")
                .and_then(Value::as_array)
                .ok_or_else(|| ExecutorError::Provider("agent_external_catalog_invalid".into()))?;
            for model in models {
                let id = model.get("id").and_then(Value::as_str).ok_or_else(|| {
                    ExecutorError::Provider("agent_external_catalog_invalid".into())
                })?;
                let levels: Vec<String> = model
                    .get("effortLevels")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| {
                        ExecutorError::Provider(format!("agent_external_catalog_invalid: {error}"))
                    })?
                    .unwrap_or_default();
                choices.push(ModelChoice {
                    selection: BackendPreference::Executor {
                        selection: Selection {
                            executor: "external".into(),
                            settings: Settings {
                                runtime: Some(runtime_id.into()),
                                model: Some(id.into()),
                                thinking_level: None,
                            },
                        },
                    },
                    source_name: format!("Native CLI · {runtime_id}"),
                    label: model
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .into(),
                    thinking_levels: levels,
                    default_thinking_level: model
                        .get("defaultEffort")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
        }
        Ok(choices)
    }
    pub(super) async fn external_cwd(&self) -> Result<Option<String>, String> {
        let DirectoryPage::Roots { roots } =
            workspace::query(self.workspace_roots.clone(), Directories::Roots).await?
        else {
            unreachable!("roots query")
        };
        Ok(roots.into_iter().next().map(|root| root.path))
    }
    pub async fn models(
        &self,
        input: ModelsRead,
        cancellation: &CancellationToken,
    ) -> Result<ModelsPage, String> {
        if cancellation.is_cancelled() {
            return Err(ExecutorError::Cancelled.to_string());
        }
        let (query, offset, expected) = match input {
            ModelsRead::Start { query } => (query, 0, None),
            ModelsRead::Continue { revision, cursor } => {
                (cursor.query, cursor.offset, Some(revision))
            }
        };
        if query.chars().any(char::is_control) {
            return Err("agent_model_query_invalid".into());
        }
        let mut choices = self.native_choices().await?;
        match self.external_choices(None, cancellation).await {
            Ok(external) => choices.extend(external),
            Err(error @ (ExecutorError::Cancelled | ExecutorError::Retired)) => {
                return Err(error.to_string());
            }
            Err(error) => {
                tracing::warn!(%error, "External model discovery unavailable; retaining native choices")
            }
        }
        let revision = hex::encode(Sha256::digest(
            serde_json::to_vec(&choices).map_err(|e| e.to_string())?,
        ));
        if expected
            .as_ref()
            .is_some_and(|expected| *expected != revision)
        {
            return Ok(ModelsPage::Changed);
        }
        let terms: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
        choices.retain(|choice| {
            let haystack = format!(
                "{} {} {}",
                choice.source_name,
                choice.label,
                serde_json::to_string(&choice.selection).expect("model identity")
            )
            .to_lowercase();
            terms.iter().all(|term| haystack.contains(term))
        });
        let offset = usize::try_from(offset).map_err(|_| "agent_model_cursor_invalid")?;
        if offset > choices.len() {
            return Err("agent_model_cursor_invalid".into());
        }
        let complete = choices.len().saturating_sub(offset) <= 16;
        let choices = choices.into_iter().skip(offset).take(16).collect();
        Ok(ModelsPage::Ready {
            revision,
            choices,
            complete,
            next: (!complete).then_some(ModelsCursor {
                query,
                offset: (offset + 16) as u64,
            }),
        })
    }
    pub async fn model(
        &self,
        input: ModelRead,
        cancellation: &CancellationToken,
    ) -> Result<ModelResult, String> {
        if cancellation.is_cancelled() {
            return Err(ExecutorError::Cancelled.to_string());
        }
        let choices = match &input.backend {
            BackendPreference::Model { .. } => self.native_choices().await?,
            BackendPreference::Executor { selection } if selection.executor == "external" => {
                match selection.settings.runtime.as_deref() {
                    Some(runtime) => match self.external_choices(Some(runtime), cancellation).await
                    {
                        Ok(choices) => choices,
                        Err(error @ (ExecutorError::Cancelled | ExecutorError::Retired)) => {
                            return Err(error.to_string());
                        }
                        Err(error) => {
                            tracing::warn!(runtime, %error, "External model validation unavailable");
                            Vec::new()
                        }
                    },
                    None => Vec::new(),
                }
            }
            BackendPreference::Executor { .. } => Vec::new(),
        };
        match choices
            .into_iter()
            .find(|choice| same_model(&choice.selection, &input.backend))
        {
            Some(choice) => Ok(ModelResult::Ready { choice }),
            None => Ok(ModelResult::Unavailable {
                message: "Selected execution source or model is unavailable".into(),
            }),
        }
    }
}
fn level(level: maka_agent_facts::execution::ThinkingLevel) -> String {
    serde_json::to_value(level)
        .expect("thinking level")
        .as_str()
        .expect("thinking level string")
        .into()
}
fn same_model(a: &BackendPreference, b: &BackendPreference) -> bool {
    match (a, b) {
        (
            BackendPreference::Model {
                connection_id: a,
                model_id: am,
                ..
            },
            BackendPreference::Model {
                connection_id: b,
                model_id: bm,
                ..
            },
        ) => a == b && am == bm,
        (
            BackendPreference::Executor { selection: a },
            BackendPreference::Executor { selection: b },
        ) => {
            a.executor == b.executor
                && a.settings.runtime == b.settings.runtime
                && a.settings.model == b.settings.model
        }
        _ => false,
    }
}
