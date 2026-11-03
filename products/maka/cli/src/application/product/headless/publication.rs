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

//! Product routes may follow defaults; publication authority remains explicitly granted.
use super::super::{Input, Package, baseline};
use super::{HostError, LoadedDeployment, PreparedApplication, RootStore, Selection};
use maka_host_runtime::application::{host::Client, transport::HostEndpoint};
use maka_plugin_core::{
    contract::{Contract, Interface, Transport},
    plan::Plan,
};
use std::collections::BTreeMap;

pub(super) fn rebase(
    selection: &mut Selection,
    previous: &LoadedDeployment,
    target: &PreparedApplication,
) -> Result<Vec<String>, HostError> {
    let Some(previous) = baseline_endpoints(&previous.source().input, previous.packages())? else {
        return Ok(Vec::new());
    };
    let Some(target) = baseline_endpoints(target.input(), target.packages())? else {
        return Ok(Vec::new());
    };
    Ok(rebase_endpoints(selection, &previous, &target))
}

fn baseline_endpoints(
    input: &Input,
    packages: &[Package],
) -> Result<Option<BTreeMap<String, HostEndpoint>>, HostError> {
    let Some(base) = input
        .base
        .as_ref()
        .filter(|base| base.package.id == baseline::ID)
    else {
        return Ok(None);
    };
    let package = packages
        .iter()
        .find(|package| package.application_ref() == base.package)
        .ok_or("product publication baseline bytes missing")?;
    Ok(Some(baseline::metadata(package)?.endpoints))
}

fn rebase_endpoints(
    selection: &mut Selection,
    previous: &BTreeMap<String, HostEndpoint>,
    target: &BTreeMap<String, HostEndpoint>,
) -> Vec<String> {
    let Selection::PublicHost {
        endpoints,
        product_methods,
        ..
    } = selection;
    let mut changes = Vec::new();
    // A new default is not a grant. Only existing routes can follow their baseline.
    for (name, before) in previous {
        let Some(current) = endpoints.get_mut(name) else {
            continue;
        };
        if current.consumer != before.consumer || current.import != before.import {
            continue;
        }
        let path = name.replace('~', "~0").replace('/', "~1");
        match target.get(name) {
            Some(after) => {
                if current.consumer != after.consumer || current.import != after.import {
                    current.consumer = after.consumer.clone();
                    current.import.clone_from(&after.import);
                    changes.push(format!(
                        "/publication/endpoints/{path}: follow current product binding"
                    ));
                }
            }
            None => {
                endpoints.remove(name);
                product_methods.remove(name);
                changes.push(format!(
                    "/publication/endpoints/{path}: remove obsolete product endpoint"
                ));
            }
        }
    }
    changes
}

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
            return Err(format!("public Host endpoint {name:?} requires a service").into());
        };
        if contract.transport != Transport::Remote || methods.is_empty() {
            return Err(format!("public Host endpoint {name:?} requires a public service").into());
        }
        if !product_methods.contains(name) {
            if endpoint
                .grant
                .methods
                .iter()
                .any(|method| !methods.contains_key(method))
            {
                return Err(format!(
                    "explicit Host endpoint grants an unavailable method: {name:?}"
                )
                .into());
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
    refresh_methods(selection, |name, endpoint| {
        let bindings = plan
            .instances()
            .get(&endpoint.consumer)
            .and_then(|consumer| consumer.bindings.get(&endpoint.import))
            .filter(|bindings| bindings.len() == 1)
            .ok_or_else(|| {
                format!(
                    "public Host endpoint {name:?} requires one service binding for consumer {:?}, import {:?}",
                    endpoint.consumer, endpoint.import
                )
            })?;
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

#[cfg(test)]
mod tests;
