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

//! Product-owned method publication uses the same policy on open and reconnect.
use super::{HostError, Input, LoadedDeployment, RootStore, Selection, update};
use maka_host_runtime::application::{host::Client, transport::HostEndpoint};
use maka_plugin_core::{
    composition::PackageUse,
    contract::{Contract, Interface, Transport},
    deployment::management::ManagedDeployment,
    package::PackageSelection,
    plan::Plan,
};

fn refresh_methods<'a>(
    selection: &mut Selection,
    mut contract: impl FnMut(&str, &HostEndpoint) -> Result<&'a Contract, HostError>,
) -> Result<Vec<String>, HostError> {
    selection.validate()?;
    let Selection::PublicHost {
        endpoints,
        product_methods,
        ..
    } = selection;
    let mut changes = Vec::new();
    for (name, endpoint) in endpoints {
        let contract = contract(name, endpoint)?;
        let Interface::Service { methods } = &contract.interface else {
            return Err("public Host endpoint requires a service".into());
        };
        if contract.transport != Transport::Remote || methods.is_empty() {
            return Err("public Host endpoint requires a public service".into());
        }
        if !product_methods.contains(name) {
            if endpoint
                .grant
                .methods
                .iter()
                .any(|method| !methods.contains_key(method))
            {
                return Err("explicit Host endpoint grants an unavailable method".into());
            }
            continue;
        }
        let methods = methods.keys().cloned().collect();
        if endpoint.grant.methods != methods {
            endpoint.grant.methods = methods;
            changes.push(format!(
                "/publication/endpoints/{}/grant/methods: follow current service contract",
                name.replace('~', "~0").replace('/', "~1")
            ));
        }
    }
    Ok(changes)
}

pub(super) fn refresh_from_plan(
    selection: &mut Selection,
    plan: &Plan,
) -> Result<Vec<String>, HostError> {
    refresh_methods(selection, |_, endpoint| {
        let bindings = plan
            .instances()
            .get(&endpoint.consumer)
            .and_then(|consumer| consumer.bindings.get(&endpoint.import))
            .filter(|bindings| bindings.len() == 1)
            .ok_or("public Host endpoint requires one service binding")?;
        Ok(&bindings[0].declaration.contract)
    })
}

pub(super) async fn synchronize(
    store: &RootStore,
    loaded: &LoadedDeployment,
) -> Result<Selection, HostError> {
    let record = store
        .application_launch()
        .await?
        .ok_or("public Host selection missing")?;
    if record.deployment != loaded.source().reference.deployment {
        return Err("public Host selection changed during startup".into());
    }
    let mut selection: Selection = serde_json::from_value(record.configuration.clone())?;
    let changes = refresh_from_plan(&mut selection, loaded.plan())?;
    if !changes.is_empty()
        && !store
            .compare_and_set_application_launch_configuration(
                loaded.source().reference.clone(),
                record.configuration,
                serde_json::to_value(&selection)?,
            )
            .await?
    {
        return Err("public Host source or publication changed during startup".into());
    }
    Ok(selection)
}

pub(crate) enum LivePublication {
    Current,
    Updated,
    Restart,
}

/// Refresh only explicitly product-owned methods. Original calls keep their
/// captured authority; the launcher reconnects after an update before using it.
pub(crate) async fn prepare_live_publication(
    client: &Client,
) -> Result<LivePublication, HostError> {
    let publication = client.publication().await?;
    if publication.source.state_domain != client.source().state_domain
        || publication.source.deployment != client.source().deployment
    {
        return Err("Host publication belongs to another deployment".into());
    }
    let Selection::PublicHost {
        product_methods, ..
    } = &publication.configuration;
    if product_methods.is_empty() {
        return Ok(LivePublication::Current);
    }
    if update::management_available(client, &publication.configuration, &["read"]) {
        let metadata: ManagedDeployment = serde_json::from_value(
            update::query_management(client, "read", serde_json::json!({})).await?,
        )?;
        if metadata.source.reference.state_domain != publication.source.state_domain
            || metadata.source.reference.deployment != publication.source.deployment
        {
            return Err("Host management read returned another deployment".into());
        }
        if invalid_helper(&metadata.source.input)? {
            return Ok(LivePublication::Restart);
        }
    }
    let mut desired = publication.configuration.clone();
    if refresh_methods(&mut desired, |name, _| {
        Ok(&client.catalogue().describe(name)?.contract)
    })?
    .is_empty()
    {
        return Ok(LivePublication::Current);
    }
    client
        .configure(publication.source, publication.configuration, desired)
        .await?;
    Ok(LivePublication::Updated)
}

fn invalid_helper(input: &Input) -> Result<bool, HostError> {
    for name in ["workspace-processes", "coordinator-workspace-processes"] {
        let Some(node) = input.instances.get(name) else {
            continue;
        };
        let PackageSelection::Pinned { package } = &node.package else {
            continue;
        };
        if package.id != "maka.agent.workspace-processes"
            || node.use_package != PackageUse::Entry
            || !node.configuration.parameters.is_empty()
        {
            continue;
        }
        let settings: maka_workspace_api::processes::Configuration =
            serde_json::from_value(serde_json::to_value(&node.configuration.values)?)?;
        if settings
            .helper
            .as_ref()
            .is_some_and(|path| !path.is_absolute() || !path.is_file())
        {
            return Ok(true);
        }
        #[cfg(windows)]
        if settings.helper.is_none() {
            return Ok(true);
        }
    }
    Ok(false)
}
