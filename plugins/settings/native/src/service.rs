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

use crate::contract::*;
use futures_util::future::BoxFuture;
use maka_agent_facts::configuration::*;
use maka_host_runtime::application::{Context, Handler, NativeOwner};
use serde_json::Value;
use std::sync::Arc;
pub(crate) struct Settings {
    pub source: maka_plugin_core::deployment::DeploymentRef,
    pub workspace_locations: Option<super::workspace_locations::Configuration>,
    pub catalog: Arc<maka_providers::catalog::Catalog>,
    pub configuration: Arc<maka_config::ConfigurationStore>,
    pub log: Arc<maka_event_log::root_store::RootStore>,
    pub configured_locale: maka_agent_facts::language::LanguagePreference,
    pub native_language: maka_agent_facts::language::Language,
}

fn rejected(reason: ConfigurationRejection) -> Result<Value, String> {
    super::connections::encode(CatalogMutationResult::Rejected { reason })
}

fn catalog_result(result: maka_config::Result<CatalogMutationResult>) -> Result<Value, String> {
    match result {
        Ok(result) => super::connections::encode(result),
        // ConfigurationStore returns Invalid either before admission to SQL or
        // after confirmed rollback of its single transaction. Commit, rollback
        // and owner uncertainty must remain the original operation's Unknown.
        Err(maka_config::ConfigError::Invalid(_)) => rejected(ConfigurationRejection::InvalidInput),
        Err(_) => Err("settings_effect_unknown".into()),
    }
}

fn credential_result(
    result: maka_config::Result<CredentialMutationResult>,
) -> Result<Value, String> {
    match result {
        Ok(result) => super::connections::encode(result),
        Err(maka_config::ConfigError::Invalid(_)) => {
            super::connections::encode(CredentialMutationResult::Rejected {
                reason: ConfigurationRejection::InvalidInput,
            })
        }
        Err(_) => Err("settings_effect_unknown".into()),
    }
}
fn selectable(
    row: &ConnectionCatalogEntry,
    snapshot: Arc<maka_providers::catalog::Snapshot>,
) -> bool {
    row.enabled && maka_providers::definition(&row.provider, snapshot).is_ok()
}
async fn model_choice(
    row: &ConnectionCatalogEntry,
    model: &str,
    snapshot: Arc<maka_providers::catalog::Snapshot>,
) -> Option<ModelChoice> {
    let info = row
        .models
        .iter()
        .find(|info| info.id == model)
        .cloned()
        .unwrap_or_else(|| ModelInfo::new(model));
    let metadata = if row.provider.package_id == maka_providers::codex::ID {
        let overrides = row
            .model_overrides
            .as_ref()
            .and_then(|all| all.get(model))
            .cloned();
        let default_thinking_level = overrides.as_ref().and_then(|o| o.default_thinking_level);
        let resolved = maka_providers::definition(&row.provider, snapshot.clone())
            .ok()?
            .prepare(maka_agent_ports::provider::Resolve {
                connection: maka_agent_ports::provider::Connection {
                    id: row.connection_id.clone(),
                    revision: row.revision,
                    configuration: row.configuration.clone(),
                },
                model: info,
                overrides,
                thinking_level: None,
            })
            .await
            .ok()?;
        maka_providers::api::ModelMetadata {
            info: resolved.info,
            thinking_levels: resolved.thinking_levels,
            default_thinking_level,
        }
    } else {
        maka_providers::api::ApiProviders::model_metadata(
            &row.provider.name,
            snapshot,
            maka_agent_ports::provider::Connection {
                id: row.connection_id.clone(),
                revision: row.revision,
                configuration: row.configuration.clone(),
            },
            info,
            row.model_overrides
                .as_ref()
                .and_then(|all| all.get(model))
                .cloned(),
        )
        .ok()?
    };
    let info = metadata.info;
    let overrides = row.model_overrides.as_ref().and_then(|all| all.get(model));
    Some(ModelChoice {
        limits: Some(ModelLimitSettings {
            overrides: ModelLimits {
                context_window: overrides.and_then(|value| value.context_window),
                input_limit: overrides.and_then(|value| value.input_limit),
                max_output_tokens: overrides.and_then(|value| value.max_output_tokens),
                compaction_threshold: overrides.and_then(|value| value.compaction_threshold),
            },
            context_window: info.context_window,
            input_limit: info.input_limit,
            max_output_tokens: info.max_output_tokens,
        }),
        tools: Some(ModelToolPreferences {
            code_mode: overrides.and_then(|value| value.code_mode),
            code_mode_language: overrides.and_then(|value| value.code_mode_language),
            apply_patch: overrides.and_then(|value| value.apply_patch),
        }),
        selection: ModelSelection {
            connection_id: row.connection_id.clone(),
            revision: row.revision,
            model_id: model.into(),
        },
        connection_name: row.name.clone(),
        label: info.display_name.unwrap_or_else(|| model.into()),
        default_thinking_level: metadata.default_thinking_level,
        thinking_levels: metadata.thinking_levels,
    })
}
async fn resolved_model(
    catalog: &ConnectionCatalogSnapshot,
    target: &ConnectionTarget,
    snapshot: Arc<maka_providers::catalog::Snapshot>,
) -> DefaultModel {
    let row = catalog.connections.iter().find(|row| {
        row.connection_id == target.connection_id
            && selectable(row, snapshot.clone())
            && row.enabled_model_ids.contains(&target.model_id)
    });
    let choice = match row {
        Some(row) => model_choice(row, &target.model_id, snapshot).await,
        None => None,
    };
    match choice {
        Some(choice) => DefaultModel::Ready { choice },
        None => DefaultModel::Unavailable {
            target: target.clone(),
        },
    }
}
async fn default_model(
    catalog: &ConnectionCatalogSnapshot,
    snapshot: Arc<maka_providers::catalog::Snapshot>,
) -> DefaultModel {
    match &catalog.default_target {
        None => DefaultModel::None,
        Some(target) => resolved_model(catalog, target, snapshot).await,
    }
}

impl Handler for Settings {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let store = self.configuration.clone();
        let public_catalog = self.catalog.clone();
        let log = self.log.clone();
        let configured_locale = self.configured_locale;
        let native_language = self.native_language;
        let source = self.source.clone();
        let workspace_locations = self.workspace_locations.clone();
        Box::pin(async move {
            match method.as_str() {
                "workspaceLocations" => {
                    super::workspace_locations::read(
                        &log,
                        &source,
                        workspace_locations.as_ref(),
                        input,
                    )
                    .await
                }
                "updateWorkspaceLocations" => {
                    context.operation().ok_or("settings_mutation_required")?;
                    super::workspace_locations::update(
                        &log,
                        &source,
                        workspace_locations.as_ref(),
                        input,
                    )
                    .await
                }
                "network" => super::network::read(&store, &log, input).await,
                "updateNetwork" => super::network::update(&store, input, context).await,
                "usage" => super::usage::page(&log, input).await,
                "usageSummary" => super::usage::summary(&log, input).await,
                "prices" => super::usage::prices(&store, input).await,
                "updatePrice" => {
                    context.operation().ok_or("settings_mutation_required")?;
                    super::usage::update_price(&store, input).await
                }
                "assistantPreferences" => {
                    super::preferences::read(&store, configured_locale, native_language, input)
                        .await
                }
                "updateAssistantPreferences" => {
                    context.operation().ok_or("settings_mutation_required")?;
                    super::preferences::update(&store, input).await
                }
                "connections" => {
                    let snapshot = public_catalog
                        .snapshot
                        .read()
                        .await
                        .as_ref()
                        .map_err(|_| "settings_store_unavailable")?
                        .clone();
                    super::connections::page(&store, input, snapshot).await
                }
                "connection" => super::connections::detail(&store, input).await,
                "providers" => {
                    let snapshot = public_catalog
                        .snapshot
                        .read()
                        .await
                        .as_ref()
                        .map_err(|_| "settings_store_unavailable")?
                        .clone();
                    super::connections::providers(input, snapshot)
                }
                "provider" => {
                    let snapshot = public_catalog
                        .snapshot
                        .read()
                        .await
                        .as_ref()
                        .map_err(|_| "settings_store_unavailable")?
                        .clone();
                    super::connections::provider(input, snapshot)
                }
                "discoverModels" => {
                    super::setup::discover(&store, &public_catalog, input, context).await
                }
                "loginCredential" => {
                    let snapshot = public_catalog
                        .snapshot
                        .read()
                        .await
                        .as_ref()
                        .map_err(|_| "settings_store_unavailable")?
                        .clone();
                    super::credential::login(&store, snapshot, input, context).await
                }
                "create" => {
                    context.operation().ok_or("settings_mutation_required")?;
                    let Ok(mut input) =
                        serde_json::from_value::<CreateCatalogConnectionInput>(input)
                    else {
                        return rejected(ConfigurationRejection::InvalidInput);
                    };
                    let snapshot = public_catalog
                        .snapshot
                        .read()
                        .await
                        .as_ref()
                        .map_err(|_| "settings_store_unavailable")?
                        .clone();
                    let Ok(definition) =
                        super::connections::definition(&input.connection.provider, snapshot)
                    else {
                        return rejected(ConfigurationRejection::ProviderUnavailable);
                    };
                    let Ok(configuration) = definition.configure(input.connection.configuration)
                    else {
                        return rejected(ConfigurationRejection::InvalidConfiguration);
                    };
                    input.connection.configuration = configuration;
                    catalog_result(store.create_connection(input).await)
                }
                "update" => {
                    context.operation().ok_or("settings_mutation_required")?;
                    let Ok(input) = serde_json::from_value::<UpdateCatalogConnectionInput>(input)
                    else {
                        return rejected(ConfigurationRejection::InvalidInput);
                    };
                    if let Some(configuration) = &input.changes.configuration {
                        let catalog = store
                            .catalog()
                            .await
                            .map_err(|_| "settings_store_unavailable")?;
                        if let Some(row) = catalog.connections.iter().find(|row| {
                            row.connection_id == input.expected.connection_id
                                && row.revision == input.expected.revision
                        }) {
                            let snapshot = public_catalog
                                .snapshot
                                .read()
                                .await
                                .as_ref()
                                .map_err(|_| "settings_store_unavailable")?
                                .clone();
                            let Ok(definition) =
                                super::connections::definition(&row.provider, snapshot)
                            else {
                                return rejected(ConfigurationRejection::ProviderUnavailable);
                            };
                            if definition.validate_configuration(configuration).is_err() {
                                return rejected(ConfigurationRejection::InvalidConfiguration);
                            }
                        }
                    }
                    catalog_result(store.update_connection(input).await)
                }
                "remove" => {
                    context.operation().ok_or("settings_mutation_required")?;
                    let Ok(input) = serde_json::from_value(input) else {
                        return rejected(ConfigurationRejection::InvalidInput);
                    };
                    catalog_result(store.remove_connection(input).await)
                }
                "credentialStatus" => {
                    let input: CredentialVaultQueryInput =
                        serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
                    super::connections::encode(
                        store
                            .credential_status(input.locator)
                            .await
                            .map_err(|_| "settings_store_unavailable")?,
                    )
                }
                "deleteCredential" => {
                    context.operation().ok_or("settings_mutation_required")?;
                    let Ok(input) = serde_json::from_value(input) else {
                        return super::connections::encode(CredentialMutationResult::Rejected {
                            reason: ConfigurationRejection::InvalidInput,
                        });
                    };
                    credential_result(store.delete_credential(input).await)
                }
                "saveCredential" => {
                    let snapshot = public_catalog
                        .snapshot
                        .read()
                        .await
                        .as_ref()
                        .map_err(|_| "settings_store_unavailable")?
                        .clone();
                    super::credential::save(&store, snapshot, input, context).await
                }
                "updateModelSettings" => {
                    context.operation().ok_or("settings_mutation_required")?;
                    let input: UpdateModelSettings =
                        serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
                    let catalog = store
                        .catalog()
                        .await
                        .map_err(|_| "settings_store_unavailable")?;
                    let expected = ConnectionVersionBasis {
                        connection_id: input.selection.connection_id,
                        revision: input.selection.revision,
                    };
                    let row = catalog
                        .connections
                        .into_iter()
                        .find(|row| row.connection_id == expected.connection_id);
                    let actual = row.as_ref().map(|row| ConnectionVersionBasis {
                        connection_id: row.connection_id.clone(),
                        revision: row.revision,
                    });
                    let Some(row) = row.filter(|row| row.revision == expected.revision) else {
                        return super::connections::encode(
                            CatalogMutationResult::ConnectionStale { expected, actual },
                        );
                    };
                    if !row.enabled_model_ids.contains(&input.selection.model_id) {
                        return rejected(ConfigurationRejection::InvalidInput);
                    }
                    let mut overrides = row.model_overrides.unwrap_or_default();
                    let model = overrides
                        .entry(input.selection.model_id.clone())
                        .or_default();
                    model.code_mode = input.tools.code_mode;
                    model.code_mode_language = input.tools.code_mode_language;
                    model.apply_patch = input.tools.apply_patch;
                    model.context_window = input.limits.context_window;
                    model.input_limit = input.limits.input_limit;
                    model.max_output_tokens = input.limits.max_output_tokens;
                    model.compaction_threshold = input.limits.compaction_threshold;

                    if *model == ModelOverride::default() {
                        overrides.remove(&input.selection.model_id);
                    }
                    catalog_result(
                        store
                            .update_connection(UpdateCatalogConnectionInput {
                                expected,
                                changes: ConnectionCatalogEntryUpdate {
                                    model_overrides: if overrides.is_empty() {
                                        Patch::Clear
                                    } else {
                                        Patch::Set(overrides)
                                    },
                                    ..Default::default()
                                },
                            })
                            .await,
                    )
                }
                "resolveModel" => {
                    let target: ConnectionTarget =
                        serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
                    let public_guard = public_catalog.snapshot.read().await;
                    let snapshot = public_guard
                        .as_ref()
                        .map_err(|_| "settings_store_unavailable")?
                        .clone();
                    let catalog = store
                        .catalog()
                        .await
                        .map_err(|_| "settings_store_unavailable")?;
                    drop(public_guard);
                    super::connections::encode(resolved_model(&catalog, &target, snapshot).await)
                }
                "models" => {
                    let input: ModelsRead =
                        serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
                    let connection_id = match &input {
                        ModelsRead::Start { connection_id, .. } => connection_id.as_deref(),
                        ModelsRead::Continue { cursor, .. } => cursor.connection_id.as_deref(),
                    };
                    let public_guard = public_catalog.snapshot.read().await;
                    let snapshot = public_guard
                        .as_ref()
                        .map_err(|_| "settings_store_unavailable")?
                        .clone();
                    let catalog = store
                        .model_catalog(connection_id)
                        .await
                        .map_err(|_| "settings_store_unavailable")?;
                    drop(public_guard);
                    let start = match input {
                        ModelsRead::Start {
                            query,
                            connection_id,
                        } => ModelCursor {
                            query,
                            connection_id,
                            connection: 0,
                            model: 0,
                        },
                        ModelsRead::Continue { revision, cursor } => {
                            if revision != catalog.revision {
                                return serde_json::to_value(ModelsPage::Changed {
                                    revision: catalog.revision,
                                })
                                .map_err(|_| "settings_output_invalid".into());
                            }
                            if cursor.connection >= catalog.connections.len()
                                || cursor.model
                                    >= catalog.connections[cursor.connection]
                                        .enabled_model_ids
                                        .len()
                            {
                                return Err("settings_cursor_invalid".into());
                            }
                            cursor
                        }
                    };
                    let terms: Vec<_> = start
                        .query
                        .split_whitespace()
                        .map(str::to_lowercase)
                        .collect();
                    let mut choices = Vec::new();
                    let mut next = None;
                    'rows: for (index, row) in catalog
                        .connections
                        .iter()
                        .enumerate()
                        .skip(start.connection)
                    {
                        if start
                            .connection_id
                            .as_ref()
                            .is_some_and(|id| *id != row.connection_id)
                            || !selectable(row, snapshot.clone())
                        {
                            continue;
                        }
                        for (at, model) in row.enabled_model_ids.iter().enumerate().skip(
                            if index == start.connection {
                                start.model
                            } else {
                                0
                            },
                        ) {
                            if choices.len() == 16 {
                                next = Some(ModelCursor {
                                    query: start.query.clone(),
                                    connection_id: start.connection_id.clone(),
                                    connection: index,
                                    model: at,
                                });
                                break 'rows;
                            }
                            let Some(choice) = model_choice(row, model, snapshot.clone()).await
                            else {
                                continue;
                            };
                            let matches = terms.is_empty() || {
                                let label = choice.label.to_lowercase();
                                let model = model.to_lowercase();
                                let connection = choice.connection_name.to_lowercase();
                                terms.iter().all(|term| {
                                    label.contains(term)
                                        || model.contains(term)
                                        || connection.contains(term)
                                })
                            };
                            if matches {
                                choices.push(choice);
                            }
                        }
                    }
                    serde_json::to_value(ModelsPage::Ready {
                        revision: catalog.revision,
                        default_model: Box::new(default_model(&catalog, snapshot).await),
                        choices,
                        next,
                    })
                    .map_err(|_| "settings_output_invalid".into())
                }
                "setDefault" => {
                    context.operation().ok_or("settings_mutation_required")?;
                    let Ok(input) = serde_json::from_value(input) else {
                        return rejected(ConfigurationRejection::InvalidInput);
                    };
                    catalog_result(store.set_default_target(input).await)
                }
                _ => Err("settings_method_unknown".into()),
            }
        })
    }
}
impl NativeOwner for Settings {
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        let store = self.configuration.clone();
        Box::pin(async move {
            store
                .shutdown()
                .await
                .map_err(|_| "settings_cleanup_unconfirmed".into())
        })
    }
}
