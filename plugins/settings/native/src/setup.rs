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

use crate::{connections::encode, contract::SetupResult};
use maka_agent_facts::{
    configuration::ConnectionCredentialTarget,
    configuration::onboarding::{OnboardingRejection, OnboardingSaveResult},
    oauth::Target,
};
use maka_agent_ports::provider;
use maka_config::{ConfigurationStore, onboarding::OnboardingPreparation};
use maka_host_runtime::application::Context;
use serde_json::Value;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) async fn discover(
    store: &Arc<ConfigurationStore>,
    catalog: &maka_providers::catalog::Catalog,
    input: Value,
    context: Context,
) -> Result<Value, String> {
    context.operation().ok_or("settings_mutation_required")?;
    let expected: ConnectionCredentialTarget =
        serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    // Explicit refresh schedules the Root-owned public sources without waiting
    // for an unrelated public endpoint. Account discovery uses last-good facts.
    if let Ok(completed) = catalog.request_refresh() {
        drop(completed);
    }
    let snapshot = catalog
        .snapshot
        .read()
        .await
        .as_ref()
        .map_err(|_| "settings_store_unavailable")?
        .clone();
    let Ok(definition) = crate::connections::definition(&expected.provider, snapshot) else {
        return encode(SetupResult::Failed);
    };
    let ticket = match store
        .prepare_onboarding(Target::Existing {
            configuration: expected.configuration.clone(),
            expected,
        })
        .await
        .map_err(|_| "settings_store_unavailable")?
    {
        OnboardingPreparation::Ready(ticket) => ticket,
        OnboardingPreparation::Rejected(_) => return encode(SetupResult::Superseded),
    };
    let network = ticket.network_configuration();
    let Ok(policy) =
        maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
    else {
        return encode(SetupResult::Failed);
    };
    let Ok(transport) = maka_model::provider_transport(&policy) else {
        return encode(SetupResult::Failed);
    };
    discover_prepared(
        ticket,
        definition,
        provider::Context {
            transport,
            cancellation: context.scope().cancellation.clone(),
            interaction: None,
        },
    )
    .await
}

pub(crate) async fn discover_prepared(
    ticket: Box<maka_config::onboarding::PreparedOnboarding>,
    definition: provider::Definition,
    context: provider::Context,
) -> Result<Value, String> {
    let Ok(credential) = ticket.provider_credential() else {
        return encode(SetupResult::Failed);
    };
    let Ok(request_headers) = ticket
        .request_headers()
        .map(serde_json::from_str)
        .transpose()
    else {
        return encode(SetupResult::Failed);
    };
    let row = ticket.connection();
    let request = provider::Discovery {
        connection: provider::Connection {
            id: row.connection_id.clone(),
            revision: row.revision,
            configuration: row.configuration.clone(),
        },
        credential: credential.map(|value| value.credential().clone()),
        request_headers: request_headers.unwrap_or_default(),
    };
    let cancellation = context.cancellation.clone();
    let models = match definition.discover(request, context).await {
        Ok(models) if !models.is_empty() => models,
        _ => return encode(SetupResult::Failed),
    };
    if cancellation.is_cancelled() {
        return encode(SetupResult::Failed);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "settings_clock_unavailable")?
        .as_secs();
    match ticket
        .complete(models, now)
        .await
        .map_err(|_| "settings_effect_unknown")?
    {
        OnboardingSaveResult::Saved { connection } => encode(SetupResult::Ready {
            connection: connection.basis(),
        }),
        OnboardingSaveResult::Rejected {
            reason: OnboardingRejection::Superseded | OnboardingRejection::ConnectionNotFound,
        } => encode(SetupResult::Superseded),
        _ => encode(SetupResult::Failed),
    }
}
