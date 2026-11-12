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

use crate::args::Root;
use clap::Args;
use maka_agent_facts::{
    configuration::{
        CatalogMutationResult, ConnectionCatalogEntryDraft, ConnectionCatalogEntryUpdate,
        ConnectionCredentialKind, ConnectionCredentialTarget, ConnectionTarget,
        ConnectionVersionBasis, CreateCatalogConnectionInput, CredentialLocator,
        CredentialMutationResult, ModelInfo, ModelOverride, SetCredentialInput,
        SetDefaultConnectionTargetInput, UpdateCatalogConnectionInput,
        policy::{
            NetworkProxy,
            network_update::{CredentialUpdate, Update, UpdateResult},
        },
        validation,
    },
    oauth::{LoginStart, Target},
    provider::{AuthenticationInput, Identity},
};
use maka_agent_ports::provider::{self, authentication::Authenticate};
use maka_config::{
    ConfigurationStore,
    oauth::enrollment::{LoginCompletion, LoginPreparation},
};
use maka_event_log::root::{RootNamespaces, RootOwner, initialize};
use maka_host_runtime::HostError;
use maka_plugin_core::scope::Scope;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

#[derive(Args)]
pub(super) struct Init {
    #[command(flatten)]
    root: Root,
    /// Read initial proxy and connection settings from stdin. Requires a new, empty root.
    #[arg(long)]
    pub(super) settings_stdin: bool,
}

/// Bootstrap secrets travel through stdin, never command arguments or diagnostics.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    network_proxy: Option<NetworkProxy>,
    proxy_password: Option<String>,
    connections: Option<Vec<ConnectionSettings>>,
    default_target: Option<DefaultTargetSettings>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionSettings {
    slug: String,
    name: Option<String>,
    provider: String,
    configuration: Option<Value>,
    api_key: Option<String>,
    request_headers: Option<BTreeMap<String, String>>,
    enabled: Option<bool>,
    #[serde(default)]
    enabled_model_ids: Vec<String>,
    model_overrides: Option<BTreeMap<String, ModelOverride>>,
    request_body_overlay: Option<Value>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DefaultTargetSettings {
    slug: String,
    model_id: String,
}

struct PreparedSettings {
    proxy_update: Option<Update>,
    connections: Vec<PreparedConnection>,
    default_target: Option<DefaultTargetSettings>,
}

struct PreparedConnection {
    draft: ConnectionCatalogEntryDraft,
    definition: provider::Definition,
    authentication: Option<AuthenticationInput>,
    request_headers: Option<String>,
}

impl Init {
    pub async fn run(self) -> Result<(), HostError> {
        let namespaces = RootNamespaces::for_current_account()?;
        let id = if self.settings_stdin {
            let settings = Settings::parse(&settings_input().await?)?;
            let prepared = settings.prepare().await?;
            // Never reconfigure an existing root or race its running Host.
            let owner = Arc::new(RootOwner::create(&self.root.root, &namespaces)?);
            let id = owner.root_id().to_owned();
            let store = Arc::new(ConfigurationStore::for_root(owner).await?);
            if let Some(update) = prepared.proxy_update {
                let now = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
                if !matches!(
                    store.update_network_proxy(update, now).await?,
                    UpdateResult::Committed { .. }
                ) {
                    return Err("initial proxy settings were not committed".into());
                }
            }
            let mut catalog_revision = 0;
            let mut connection_ids = BTreeMap::new();
            for (index, connection) in prepared.connections.into_iter().enumerate() {
                let enabled = connection.draft.enabled;
                let slug = connection.draft.slug.clone();
                let provider = connection.draft.provider.clone();
                let configuration = connection.draft.configuration.clone();
                let created = store
                    .create_connection(CreateCatalogConnectionInput {
                        expected_catalog_revision: catalog_revision,
                        connection: connection.draft,
                    })
                    .await?;
                let CatalogMutationResult::Committed {
                    catalog_revision: next_revision,
                    connection: Some(basis),
                } = created
                else {
                    return Err("initial connection was not committed".into());
                };
                catalog_revision = next_revision;
                let mut target = ConnectionCredentialTarget {
                    connection_id: basis.connection_id.clone(),
                    revision: basis.revision,
                    slug: slug.clone(),
                    provider,
                    configuration,
                };
                if let Some(authentication) = connection.authentication {
                    let prepared_login = store
                        .prepare_oauth_login(LoginStart {
                            attempt_id: format!("bootstrap-connection-{index}"),
                            target: Target::Existing {
                                expected: target.clone(),
                                configuration: target.configuration.clone(),
                            },
                            expected_credential: None,
                            authentication: authentication.clone(),
                        })
                        .await?;
                    let LoginPreparation::Ready(ticket) = prepared_login else {
                        return Err("initial connection credential was not prepared".into());
                    };
                    if !ticket.claim().await? {
                        return Err("initial connection credential was not claimed".into());
                    }
                    let row = ticket.connection();
                    let credential = connection
                        .definition
                        .authenticate(
                            Authenticate {
                                connection: provider::Connection {
                                    id: row.connection_id.clone(),
                                    revision: row.revision,
                                    configuration: row.configuration.clone(),
                                },
                                method: authentication.method,
                                input: authentication.input,
                            },
                            provider::Context::local(CancellationToken::new()),
                        )
                        .await
                        .map_err(|_| {
                            HostError::from("initial connection credential was rejected")
                        })?;
                    let now_secs = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
                    let LoginCompletion::Committed(_) =
                        ticket.complete(credential, now_secs).await?
                    else {
                        return Err("initial connection credential was not committed".into());
                    };
                    let catalog = store.catalog().await?;
                    catalog_revision = catalog.revision;
                    let Some(row) = catalog
                        .connections
                        .iter()
                        .find(|row| row.connection_id == target.connection_id)
                    else {
                        return Err(
                            "initial connection was not found after credential commit".into()
                        );
                    };
                    target.revision = row.revision;
                    if !enabled {
                        let updated = store
                            .update_connection(UpdateCatalogConnectionInput {
                                expected: ConnectionVersionBasis {
                                    connection_id: target.connection_id.clone(),
                                    revision: target.revision,
                                },
                                changes: ConnectionCatalogEntryUpdate {
                                    enabled: Some(false),
                                    ..Default::default()
                                },
                            })
                            .await?;
                        let CatalogMutationResult::Committed {
                            catalog_revision: next_revision,
                            connection: Some(updated_basis),
                        } = updated
                        else {
                            return Err("initial connection state was not committed".into());
                        };
                        catalog_revision = next_revision;
                        target.revision = updated_basis.revision;
                    }
                }
                if let Some(request_headers) = connection.request_headers {
                    let now =
                        u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
                    if !matches!(
                        store
                            .set_credential(
                                SetCredentialInput {
                                    locator: CredentialLocator::Connection {
                                        connection_id: target.connection_id.clone(),
                                        kind: ConnectionCredentialKind::RequestHeaders,
                                    },
                                    expected: None,
                                    expected_connection: Some(target),
                                    secret: request_headers,
                                },
                                now,
                            )
                            .await?,
                        CredentialMutationResult::Committed { .. }
                    ) {
                        return Err("initial connection request headers were not committed".into());
                    }
                }
                connection_ids.insert(slug, basis.connection_id);
            }
            if let Some(default_target) = prepared.default_target {
                let Some(connection_id) = connection_ids.get(&default_target.slug).cloned() else {
                    return Err("initial default target connection was not found".into());
                };
                if !matches!(
                    store
                        .set_default_target(SetDefaultConnectionTargetInput {
                            expected_catalog_revision: catalog_revision,
                            target: Some(ConnectionTarget {
                                connection_id,
                                model_id: default_target.model_id,
                            }),
                        })
                        .await?,
                    CatalogMutationResult::Committed { .. }
                ) {
                    return Err("initial default target was not committed".into());
                }
            }
            store.shutdown().await?;
            id
        } else {
            initialize(&self.root.root, &namespaces)?
        };
        println!("{}", serde_json::json!({"rootId":id}));
        Ok(())
    }
}

pub(crate) async fn settings_input() -> Result<Vec<u8>, HostError> {
    Ok(tokio::task::spawn_blocking(|| {
        let mut bytes = Vec::new();
        std::io::stdin().lock().read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    })
    .await??)
}

// Validate the entire input before handing it to a detached worker. If replay
// is cut short, only trailing whitespace may be lost from an accepted JSON value.
pub(crate) async fn validate_settings_input(bytes: &[u8]) -> std::io::Result<()> {
    let settings = Settings::parse(bytes)?;
    settings
        .prepare()
        .await
        .map(|_| ())
        .map_err(|error| std::io::Error::other(error.to_string()))
}

fn provider_identity(name: String) -> Identity {
    let package = if name == "chatgpt" {
        maka_providers::codex::ID
    } else {
        maka_providers::api::ID
    };
    Identity {
        package_id: package.into(),
        entry_id: package.into(),
        scope: Scope::Profile,
        name,
    }
}

impl Settings {
    fn parse(bytes: &[u8]) -> std::io::Result<Self> {
        serde_json::from_slice(bytes).map_err(|_| std::io::Error::other("invalid initial settings"))
    }

    async fn prepare(&self) -> Result<PreparedSettings, HostError> {
        let proxy_update = self.proxy_update()?;
        let connections = match &self.connections {
            Some(connections) if !connections.is_empty() => {
                let snapshot = Arc::new(
                    maka_providers::catalog::Snapshot::bundled()
                        .map_err(|_| HostError::from("invalid initial settings"))?,
                );
                let mut slugs = BTreeSet::new();
                let mut prepared = Vec::with_capacity(connections.len());
                for connection in connections {
                    if connection
                        .name
                        .as_ref()
                        .is_some_and(|name| name.trim().is_empty())
                    {
                        return Err("invalid initial settings: connection name is required".into());
                    }
                    let name = connection
                        .name
                        .clone()
                        .unwrap_or_else(|| connection.slug.clone());
                    let provider = provider_identity(connection.provider.clone());
                    let definition = maka_providers::definition(&provider, snapshot.clone())
                        .map_err(|_| {
                            HostError::from("invalid initial settings: provider is unavailable")
                        })?;
                    let raw_configuration = connection
                        .configuration
                        .clone()
                        .unwrap_or_else(|| json!({}));
                    let configuration = definition.configure(raw_configuration).map_err(|_| {
                        HostError::from("invalid initial settings: invalid provider configuration")
                    })?;
                    let created = validation::normalize_create(CreateCatalogConnectionInput {
                        expected_catalog_revision: 0,
                        connection: ConnectionCatalogEntryDraft {
                            slug: connection.slug.clone(),
                            name,
                            provider,
                            configuration,
                            enabled: connection.enabled.unwrap_or(true),
                            enabled_model_ids: connection.enabled_model_ids.clone(),
                            model_overrides: connection.model_overrides.clone(),
                            request_body_overlay: connection.request_body_overlay.clone(),
                        },
                    })
                    .map_err(|_| {
                        HostError::from(
                            "invalid initial settings: invalid connection configuration",
                        )
                    })?;
                    let draft = created.connection;
                    if !slugs.insert(draft.slug.clone()) {
                        return Err("invalid initial settings: duplicate connection slug".into());
                    }
                    let authentication = match &connection.api_key {
                        Some(secret) => {
                            let authentication = AuthenticationInput {
                                method: "api-key".into(),
                                input: json!({ "apiKey": secret }),
                            };
                            definition
                                .authenticate(
                                    Authenticate {
                                        connection: provider::Connection {
                                            id: draft.slug.clone(),
                                            revision: 0,
                                            configuration: draft.configuration.clone(),
                                        },
                                        method: authentication.method.clone(),
                                        input: authentication.input.clone(),
                                    },
                                    provider::Context::local(CancellationToken::new()),
                                )
                                .await
                                .map_err(|_| {
                                    HostError::from(
                                        "invalid initial settings: connection API key is invalid",
                                    )
                                })?;
                            Some(authentication)
                        }
                        None => None,
                    };
                    let request_headers = match &connection.request_headers {
                        Some(headers) => {
                            if headers.is_empty() {
                                return Err("invalid initial settings: connection request headers are invalid".into());
                            }
                            let encoded = serde_json::to_string(headers).map_err(|_| {
                                HostError::from("invalid initial settings: connection request headers are invalid")
                            })?;
                            Some(validation::normalize_headers(&encoded).map_err(|_| {
                                HostError::from("invalid initial settings: connection request headers are invalid")
                            })?)
                        }
                        None => None,
                    };
                    prepared.push(PreparedConnection {
                        draft,
                        definition,
                        authentication,
                        request_headers,
                    });
                }
                prepared
            }
            _ => Vec::new(),
        };
        let default_target = match &self.default_target {
            Some(target) => {
                if target.slug.is_empty() || target.model_id.is_empty() {
                    return Err("invalid initial settings: default target is invalid".into());
                }
                let Some(connection) = connections
                    .iter()
                    .find(|connection| connection.draft.slug == target.slug)
                else {
                    return Err(
                        "invalid initial settings: default target connection was not found".into(),
                    );
                };
                if !connection.draft.enabled
                    || !connection
                        .draft
                        .enabled_model_ids
                        .contains(&target.model_id)
                {
                    return Err("invalid initial settings: default target must reference an enabled model on an enabled connection".into());
                }
                connection
                    .definition
                    .prepare(provider::Resolve {
                        connection: provider::Connection {
                            id: connection.draft.slug.clone(),
                            revision: 0,
                            configuration: connection.draft.configuration.clone(),
                        },
                        model: ModelInfo::new(&target.model_id),
                        overrides: connection
                            .draft
                            .model_overrides
                            .as_ref()
                            .and_then(|overrides| overrides.get(&target.model_id))
                            .cloned(),
                        thinking_level: None,
                    })
                    .await
                    .map_err(|_| {
                        HostError::from(
                            "invalid initial settings: invalid default model configuration",
                        )
                    })?;
                Some(target.clone())
            }
            None => None,
        };
        Ok(PreparedSettings {
            proxy_update,
            connections,
            default_target,
        })
    }

    fn proxy_update(&self) -> Result<Option<Update>, HostError> {
        let Some(proxy) = &self.network_proxy else {
            return if self.proxy_password.is_some() {
                Err("invalid initial settings: proxy password requires proxy settings".into())
            } else {
                Ok(None)
            };
        };
        let credential = match (proxy.auth_enabled, &self.proxy_password) {
            (true, Some(secret)) => CredentialUpdate::Replace {
                secret: secret.clone(),
                expected_target: None,
            },
            (false, None) => CredentialUpdate::Delete {},
            _ => {
                return Err(
                    "invalid initial settings: proxy authentication does not match its credential"
                        .into(),
                );
            }
        };
        let mut update = Update {
            expected_policy_revision: 0,
            expected_credential: None,
            network_proxy: proxy.clone(),
            credential,
        };
        update
            .normalize()
            .map_err(|_| HostError::from("invalid initial settings: invalid network proxy"))?;
        Ok(Some(update))
    }
}
