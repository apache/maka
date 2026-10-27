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
use maka_agent_ports::provider::Definition;
use maka_config::ConfigurationStore;
use maka_plugin_core::scope::Scope;
use maka_providers::catalog::Snapshot;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

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
        .map(|row| ConnectionSummary {
            editable: definition(&row.provider, snapshot.clone()).is_ok(),
            basis: ConnectionVersionBasis {
                connection_id: row.basis.connection_id.clone(),
                revision: row.basis.revision,
            },
            slug: row.slug.clone(),
            name: row.name.clone(),
            provider: row.provider.clone(),
            enabled: row.enabled,
            enabled_model_count: row.enabled_model_count,
        })
        .collect();
    encode(ConnectionsPage::Ready {
        revision: catalog.revision,
        default_target: catalog.default_target,
        connections,
        next: (end < catalog.connections.len()).then_some(end),
    })
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
        Some(row) if row.revision == expected.revision => encode(ConnectionDetail::Ready {
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
        }),
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
