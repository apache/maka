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
use maka_agent_facts::configuration::*;
use maka_agent_facts::provider::Identity;
use maka_agent_ports::provider::{self, Definition};
use maka_config::ConfigurationStore;
use maka_plugin_core::scope::Scope;
use maka_providers::catalog::Snapshot;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(crate) fn encode(value: impl Serialize) -> Result<Value, String> {
    let value = serde_json::to_value(value).map_err(|_| "settings_output_invalid")?;
    Ok(value)
}
pub(crate) fn definition(
    identity: &Identity,
    snapshot: Arc<Snapshot>,
) -> Result<Definition, String> {
    maka_providers::definition(identity, snapshot)
        .map_err(|_| "settings_provider_unavailable".into())
}

pub(crate) async fn page(
    store: &ConfigurationStore,
    input: Value,
    snapshot: Arc<Snapshot>,
) -> Result<Value, String> {
    let input: ConnectionsRead =
        serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    let catalog = store
        .connection_summaries()
        .await
        .map_err(|_| "settings_store_unavailable")?;
    let offset = match input {
        ConnectionsRead::Start => 0,
        ConnectionsRead::Continue { revision, offset } => {
            if revision != catalog.revision {
                return encode(ConnectionsPage::Changed {
                    revision: catalog.revision,
                });
            }
            if offset >= catalog.connections.len() {
                return Err("settings_cursor_invalid".into());
            }
            offset
        }
    };
    let end = (offset + 16).min(catalog.connections.len());
    let connections = catalog.connections[offset..end]
        .iter()
        .map(|row| {
            let provider = definition(&row.provider, snapshot.clone()).ok();
            ConnectionSummary {
                editable: provider.is_some(),
                basis: row.basis.clone(),
                slug: row.slug.clone(),
                name: row.name.clone(),
                provider: row.provider.clone(),
                enabled: row.enabled,
                enabled_model_count: row.enabled_model_count,
                usage_limits: provider
                    .is_some_and(|provider| provider.descriptor().usage_authentication.is_some()),
            }
        })
        .collect();
    encode(ConnectionsPage::Ready {
        revision: catalog.revision,
        default_target: catalog.default_target,
        connections,
        next: (end < catalog.connections.len()).then_some(end),
    })
}

pub(crate) async fn usage_limits(
    store: &Arc<ConfigurationStore>,
    input: Value,
    snapshot: Arc<Snapshot>,
    cancellation: CancellationToken,
) -> Result<Value, String> {
    let expected: ConnectionVersionBasis =
        serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    let Some(observation) = store
        .observe_usage(expected)
        .await
        .map_err(|_| "settings_store_unavailable")?
    else {
        return encode(ConnectionUsageLimits::Superseded);
    };
    let row = &observation.connection;
    let provider = definition(&row.provider, snapshot)?;
    let Some(authentication) = provider.descriptor().usage_authentication else {
        return encode(ConnectionUsageLimits::Unsupported);
    };
    let uses_access_key = authentication != provider::UsageAuthentication::Provider;
    let credential = if uses_access_key {
        let Some(key) = observation
            .access_key()
            .map_err(|_| "settings_store_unavailable")?
        else {
            return encode(ConnectionUsageLimits::UsageCredentialRequired);
        };
        provider::UsageCredential::AccessKey(key)
    } else {
        let Some(credential) = observation
            .provider_credential()
            .map_err(|_| "settings_store_unavailable")?
        else {
            return encode(ConnectionUsageLimits::AuthenticationRequired);
        };
        provider::UsageCredential::Provider {
            credential,
            request_headers: observation
                .request_headers()
                .map_err(|_| "settings_store_unavailable")?,
        }
    };
    let network = &observation.network;
    let policy =
        maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
            .map_err(|_| "settings_network_unavailable")?;
    let transport =
        maka_model::provider_transport(&policy).map_err(|_| "settings_network_unavailable")?;
    let cancellation = cancellation.child_token();
    let _cancel_on_drop = cancellation.clone().drop_guard();
    let call = provider.usage_limits(
        provider::UsageLimitsRequest {
            connection: provider::Connection {
                id: row.connection_id.clone(),
                revision: row.revision,
                configuration: row.configuration.clone(),
            },
            credential,
        },
        provider::Context {
            transport,
            cancellation: cancellation.clone(),
            interaction: None,
        },
    );
    tokio::pin!(call);
    let result = tokio::select! {
        result = &mut call => result,
        _ = tokio::time::sleep(Duration::from_secs(15)) => {
            cancellation.cancel();
            let settled = call.await;
            tracing::warn!(error = ?settled.err(), connection_id = %row.connection_id, "Provider usage request timed out");
            Err(provider::Error::Cancelled)
        }
    };
    if !store
        .usage_observation_current(&observation, uses_access_key)
        .await
        .map_err(|_| "settings_store_unavailable")?
    {
        return encode(ConnectionUsageLimits::Superseded);
    }
    let result = match result {
        Ok(limits) => ConnectionUsageLimits::Ready { limits },
        Err(provider::Error::AuthenticationRequired) if uses_access_key => {
            ConnectionUsageLimits::UsageCredentialRequired
        }
        Err(provider::Error::AuthenticationRequired) => {
            ConnectionUsageLimits::AuthenticationRequired
        }
        Err(provider::Error::Unavailable) => ConnectionUsageLimits::Unsupported,
        Err(provider::Error::Cancelled) => ConnectionUsageLimits::Unavailable,
        Err(error) => {
            tracing::warn!(%error, connection_id = %row.connection_id, "Provider usage limits unavailable");
            ConnectionUsageLimits::Unavailable
        }
    };
    encode(result)
}

pub(crate) async fn detail(store: &ConfigurationStore, input: Value) -> Result<Value, String> {
    let expected: ConnectionRead =
        serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    let catalog = store
        .catalog()
        .await
        .map_err(|_| "settings_store_unavailable")?;
    let row = catalog
        .connections
        .into_iter()
        .find(|row| row.connection_id == expected.connection_id);
    match row {
        Some(row)
            if expected
                .revision
                .is_none_or(|revision| row.revision == revision) =>
        {
            encode(ConnectionDetail::Ready {
                target: Box::new(ConnectionCredentialTarget {
                    connection_id: row.connection_id,
                    revision: row.revision,
                    slug: row.slug,
                    provider: row.provider,
                    configuration: row.configuration,
                }),
                name: row.name,
                enabled: row.enabled,
                enabled_model_count: row.enabled_model_ids.len(),
                editing: expected
                    .include_editing_facts
                    .then_some(ConnectionEditingFacts {
                        enabled_model_ids: row.enabled_model_ids,
                        model_overrides: row.model_overrides,
                        request_body_overlay: row.request_body_overlay,
                    }),
            })
        }
        actual => encode(ConnectionDetail::Stale {
            actual: actual.map(|row| ConnectionVersionBasis {
                connection_id: row.connection_id,
                revision: row.revision,
            }),
        }),
    }
}
pub(crate) fn providers(input: Value, snapshot: Arc<Snapshot>) -> Result<Value, String> {
    let input: ProvidersRead =
        serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    let mut identities = vec![Identity {
        package_id: maka_providers::codex::ID.into(),
        entry_id: maka_providers::codex::ID.into(),
        scope: Scope::Profile,
        name: "chatgpt".into(),
    }];
    identities.extend(
        maka_providers::api::ApiProviders::names()
            .map_err(|_| "settings_provider_unavailable")?
            .into_iter()
            .map(|name| Identity {
                package_id: maka_providers::api::ID.into(),
                entry_id: maka_providers::api::ID.into(),
                scope: Scope::Profile,
                name,
            }),
    );
    if input.offset >= identities.len() && input.offset != 0 {
        return Err("settings_cursor_invalid".into());
    }
    let mut providers = Vec::new();
    let mut next = None;
    let mut provider_bytes = 0;
    // Include the envelope and largest possible cursor in the byte budget.
    let envelope_bytes = serde_json::to_vec(&ProvidersPage {
        providers: Vec::new(),
        next: Some(usize::MAX),
    })
    .map_err(|_| "settings_output_invalid")?
    .len();
    for (offset, identity) in identities.into_iter().enumerate().skip(input.offset) {
        let provider = definition(&identity, snapshot.clone())?;
        let descriptor = provider.descriptor();
        let summary = ProviderSummary {
            custom_endpoint: descriptor.custom_endpoint,
            identity,
            label: descriptor.label.clone(),
            authentication: descriptor
                .authentication
                .iter()
                .map(|method| ProviderAuthenticationSummary {
                    label: method.label.clone(),
                    interactive: method.interactive,
                })
                .collect(),
        };
        let row_bytes = serde_json::to_vec(&summary)
            .map_err(|_| "settings_output_invalid")?
            .len()
            + usize::from(!providers.is_empty());
        let bytes = provider_bytes + row_bytes + envelope_bytes;
        if !providers.is_empty() && bytes > 128 * 1024 {
            next = Some(offset);
            break;
        }
        provider_bytes += row_bytes;
        providers.push(summary);
    }
    encode(ProvidersPage { providers, next })
}

pub(crate) fn provider(input: Value, snapshot: Arc<Snapshot>) -> Result<Value, String> {
    let identity = serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    let descriptor = definition(&identity, snapshot)?.descriptor().clone();
    encode(Provider {
        identity,
        descriptor,
    })
}
