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

//! Explicit Host sources retain their composition while selected package pins advance.
use super::super::{
    Package, selected,
    update::{Outcome, Scope},
};
use super::{HostError, Input, Preparation, Roots, Selection, launch};
use base64::{Engine, engine::general_purpose::STANDARD};
use maka_event_log::applications::launch::Launch;
use maka_event_log::root_store::RootStore;
use maka_plugin_core::{
    composition::ExecutionLocation,
    package::{PackageRef, PackageSelection},
};
use std::collections::{BTreeMap, BTreeSet};

pub(in super::super) async fn synchronize(
    store: &RootStore,
    apply: bool,
) -> Result<Outcome, HostError> {
    let record = store
        .application_launch()
        .await?
        .ok_or("public Host selection missing")?;
    let current = store.load_application(record.deployment).await?;
    let base = if let (Some(pending), Some(current)) = (&record.pending, &current) {
        let preparation: Preparation = serde_json::from_slice(pending)?;
        let mut reference = current.source().reference.clone();
        reference.revision = preparation.expected_revision.max(1);
        store.load_application_at(&reference).await?
    } else {
        None
    };
    synchronize_loaded(apply.then_some(store), record, current, base).await
}

/// Offline preview reads only the existing control database; no runtime partition opens.
pub(in super::super) async fn preview(
    store: &maka_event_log::EventLog,
) -> Result<Outcome, HostError> {
    let record = store
        .application_launch()
        .await?
        .ok_or("public Host selection missing")?;
    let current = store.load_application(record.deployment).await?;
    let base = if let (Some(pending), Some(current)) = (&record.pending, &current) {
        let preparation: Preparation = serde_json::from_slice(pending)?;
        let mut reference = current.source().reference.clone();
        reference.revision = preparation.expected_revision.max(1);
        store.load_application_at(&reference).await?
    } else {
        None
    };
    synchronize_loaded(None, record, current, base).await
}

async fn synchronize_loaded(
    apply: Option<&RootStore>,
    record: Launch,
    current: Option<maka_event_log::applications::LoadedDeployment>,
    base: Option<maka_event_log::applications::LoadedDeployment>,
) -> Result<Outcome, HostError> {
    let selection: Selection = serde_json::from_value(record.configuration.clone())?;
    selection.validate()?;
    if let Some(pending) = &record.pending {
        let preparation: Preparation = serde_json::from_slice(pending)?;
        let packages = launch::decode_packages(preparation.packages.clone())?;
        validate_target(&preparation.input, &packages)?;
        let previous = check_pending(current.as_ref(), base.as_ref(), &preparation, &packages)?;
        let initializing = preparation.expected_revision == 0;
        let mut outcome = Outcome {
            scope: if initializing {
                Scope::Initialization
            } else {
                Scope::SelectedPackages
            },
            changed: true,
            applied: false,
            changes: if initializing {
                Vec::new()
            } else {
                changes(previous.as_ref(), &preparation.input)
            },
        };
        if let Some(store) = apply {
            // Recover only this frozen operation, even under a newer executable.
            super::prepare_saved(store, Roots::Saved).await?;
            outcome.applied = true;
        }
        return Ok(outcome);
    }
    let version = tokio::task::spawn_blocking(super::super::bundle_fingerprint).await??;
    let packages = tokio::task::spawn_blocking(super::super::packages).await??;
    let authoring = super::super::authoring()?;
    super::super::verified_fingerprint(&authoring, &packages, &version)?;
    synchronize_loaded_packages(
        apply,
        record,
        current.ok_or("public Host source missing")?,
        packages,
    )
    .await
}

/// Read the ordinary management query through the live Host, never its database.
/// Generic Hosts that do not expose product management remain independently owned.
pub(crate) async fn live_update_available(
    client: &maka_host_runtime::application::host::Client,
) -> Result<bool, HostError> {
    use maka_plugin_core::contract::{Interface, MethodMode};
    let Ok(description) = client.catalogue().describe("management") else {
        return Ok(false);
    };
    let expected = maka_plugin_core::deployment::management::deployment_manager_contract();
    if description.contract.name != expected.name
        || description.contract.version != expected.version
    {
        return Ok(false);
    }
    let Interface::Service { methods } = &description.contract.interface else {
        return Ok(false);
    };
    if !matches!(methods.get("read"), Some(method) if method.mode == MethodMode::Query) {
        return Ok(false);
    }
    let metadata: maka_plugin_core::deployment::management::ManagedDeployment =
        serde_json::from_value(query_management(client, "read", serde_json::json!({})).await?)?;
    if metadata.source.reference.state_domain != client.source().state_domain
        || metadata.source.reference.deployment != client.source().deployment
    {
        return Err("Host management read returned another deployment".into());
    }
    let version = tokio::task::spawn_blocking(super::super::bundle_fingerprint).await??;
    let packages = tokio::task::spawn_blocking(super::super::packages).await??;
    let authoring = super::super::authoring()?;
    super::super::verified_fingerprint(&authoring, &packages, &version)?;
    let replacements = bundled_replacements(&packages)?;
    let needs_update = |input: &Input| {
        pins(input).values().any(|package| {
            replacements
                .get(&package.id)
                .is_some_and(|replacement| replacement != *package)
        })
    };
    if needs_update(&metadata.source.input) {
        return Ok(true);
    }
    if metadata.source.reference == *client.source() {
        return Ok(false);
    }
    // Management reads the desired head; this incarnation's initial source may
    // still select older bundled pins while asynchronous adoption is pending.
    // A revision change by itself never authorizes a restart.
    let initial = read_initial_document(client).await?;
    Ok(needs_update(&initial.input))
}

async fn query_management(
    client: &maka_host_runtime::application::host::Client,
    method: &str,
    input: serde_json::Value,
) -> Result<serde_json::Value, HostError> {
    use maka_host_runtime::application::transport::Reply;
    use maka_plugin_core::contract::{Interface, MethodMode};
    let description = client.catalogue().describe("management")?;
    if !matches!(&description.contract.interface, Interface::Service { methods } if matches!(methods.get(method), Some(declaration) if declaration.mode == MethodMode::Query))
    {
        return Err(format!("Host management {method} is not a query").into());
    }
    let mut call = client
        .call("management", method.into(), input, Default::default())
        .await?;
    let result = async {
        call.start().await?;
        match call.receive().await? {
            Reply::Finished { result, cleanup } => {
                cleanup?;
                Ok::<_, HostError>(result?)
            }
            _ => Err(format!("Host management {method} returned an unexpected reply").into()),
        }
    }
    .await;
    let cleanup = call.close().await;
    let value = result?;
    cleanup?;
    Ok(value)
}

async fn read_initial_document(
    client: &maka_host_runtime::application::host::Client,
) -> Result<maka_plugin_core::deployment::management::DeploymentDocument, HostError> {
    use maka_plugin_core::deployment::management::DeploymentDocumentChunk;
    let mut text = String::new();
    let mut total = None;
    loop {
        let offset = text.len();
        let chunk: DeploymentDocumentChunk = serde_json::from_value(
            query_management(
                client,
                "readDocument",
                serde_json::json!({"source": client.source(), "offset": offset}),
            )
            .await?,
        )?;
        if chunk.source != *client.source()
            || chunk.offset != offset
            || total.is_some_and(|total| total != chunk.total_bytes)
        {
            return Err("Host initial source document changed during paging".into());
        }
        total = Some(chunk.total_bytes);
        text.push_str(&chunk.text);
        match chunk.next {
            Some(next) if next == text.len() && next > offset && next < chunk.total_bytes => {}
            None if text.len() == chunk.total_bytes => break,
            _ => return Err("Host initial source document returned an invalid page".into()),
        }
    }
    Ok(serde_json::from_str(&text)?)
}

#[cfg(test)]
async fn synchronize_packages(
    store: &RootStore,
    record: Launch,
    apply: bool,
    bundled: BTreeMap<String, Package>,
) -> Result<Outcome, HostError> {
    let loaded = store
        .load_application(record.deployment)
        .await?
        .ok_or("public Host source missing")?;
    synchronize_loaded_packages(apply.then_some(store), record, loaded, bundled).await
}

async fn synchronize_loaded_packages(
    apply: Option<&RootStore>,
    record: Launch,
    loaded: maka_event_log::applications::LoadedDeployment,
    bundled: BTreeMap<String, Package>,
) -> Result<Outcome, HostError> {
    if !loaded.source().remote_exports.is_empty() {
        return Err("public Host source cannot use remote observations".into());
    }
    validate_target(&loaded.source().input, loaded.packages())?;
    let replacements = bundled_replacements(&bundled)?;
    let mut next = loaded.source().input.clone();
    for node in next.instances.values_mut() {
        if let PackageSelection::Pinned { package } = &mut node.package {
            replace(package, &replacements);
        }
        for override_ in &mut node.overrides {
            if let Some(package) = &mut override_.package {
                replace(package, &replacements);
            }
        }
    }
    let changes = changes(Some(&loaded.source().input), &next);
    let mut outcome = Outcome {
        scope: Scope::SelectedPackages,
        changed: !changes.is_empty(),
        changes,
        ..Default::default()
    };
    if !outcome.changed {
        return Ok(outcome);
    }
    let mut available = BTreeMap::new();
    for package in loaded.packages().iter().chain(bundled.values()) {
        available.insert(package.application_ref(), package.clone());
    }
    let old_required: BTreeSet<_> = loaded
        .plan()
        .instances()
        .values()
        .map(|instance| instance.package.clone())
        .collect();
    let mut inventory: BTreeMap<_, _> = loaded
        .packages()
        .iter()
        .filter(|package| !old_required.contains(&package.application_ref()))
        .map(|package| (package.application_ref(), package.clone()))
        .collect();
    for package in selected(&next, &[], &available.into_values().collect::<Vec<_>>())? {
        inventory.insert(package.application_ref(), package);
    }
    let packages: Vec<_> = inventory.into_values().collect();
    validate_target(&next, &packages)?;
    if let Some(store) = apply {
        let preparation = Preparation {
            expected_revision: loaded.source().reference.revision,
            input: next,
            packages: packages
                .iter()
                .map(|package| {
                    package
                        .files()
                        .iter()
                        .map(|(path, bytes)| (path.clone(), STANDARD.encode(bytes)))
                        .collect()
                })
                .collect(),
        };
        store
            .begin_application_restore(record.deployment, serde_json::to_vec(&preparation)?)
            .await?;
        super::prepare_saved(store, Roots::Saved).await?;
        outcome.applied = true;
    }
    Ok(outcome)
}

pub(super) fn validate_target(input: &Input, packages: &[Package]) -> Result<(), HostError> {
    if input.environment.location != ExecutionLocation::Host {
        return Err("public Host update requires a local Host source".into());
    }
    maka_event_log::applications::validate_application(input, &[], packages)?;
    Ok(())
}

fn bundled_replacements(
    bundled: &BTreeMap<String, Package>,
) -> Result<BTreeMap<String, PackageRef>, HostError> {
    let mut replacements = BTreeMap::new();
    for package in bundled.values() {
        let reference = package.application_ref();
        if replacements
            .insert(reference.id.clone(), reference)
            .is_some()
        {
            return Err("current bundle contains duplicate package IDs".into());
        }
    }
    Ok(replacements)
}

fn replace(package: &mut PackageRef, replacements: &BTreeMap<String, PackageRef>) {
    if let Some(next) = replacements.get(&package.id) {
        *package = next.clone();
    }
}
fn pins(input: &Input) -> BTreeMap<String, &PackageRef> {
    let mut pins = BTreeMap::new();
    for (name, node) in &input.instances {
        let name = name.replace('~', "~0").replace('/', "~1");
        if let PackageSelection::Pinned { package } = &node.package {
            pins.insert(format!("/instances/{name}/package"), package);
        }
        for (index, override_) in node.overrides.iter().enumerate() {
            if let Some(package) = &override_.package {
                pins.insert(
                    format!("/instances/{name}/overrides/{index}/package"),
                    package,
                );
            }
        }
    }
    pins
}
fn changes(previous: Option<&Input>, next: &Input) -> Vec<String> {
    let previous = previous.map(pins).unwrap_or_default();
    pins(next)
        .into_iter()
        .filter_map(|(path, package)| {
            let old = previous.get(&path).copied();
            (old != Some(package)).then(|| {
                let old = old.map_or_else(
                    || "(unselected)".into(),
                    |old| format!("{}@{}", old.id, old.revision),
                );
                format!("{path}: {old} -> {}@{}", package.id, package.revision)
            })
        })
        .collect()
}

fn check_pending(
    current: Option<&maka_event_log::applications::LoadedDeployment>,
    base: Option<&maka_event_log::applications::LoadedDeployment>,
    preparation: &Preparation,
    packages: &[Package],
) -> Result<Option<Input>, HostError> {
    if preparation.expected_revision == 0 {
        if current.is_some() {
            let original = base.ok_or("original public Host source missing")?;
            if !matches_target(original, &preparation.input, packages) {
                return Err(
                    "original product initialization source conflicts with stored revision 1"
                        .into(),
                );
            }
        }
        return Ok(None);
    }
    let current = current.ok_or("public Host source missing")?;
    let revision = current.source().reference.revision;
    if revision != preparation.expected_revision
        && !(revision
            == preparation
                .expected_revision
                .checked_add(1)
                .ok_or("public Host revision exhausted")?
            && matches_target(current, &preparation.input, packages))
    {
        return Err("prepared Host update conflicts with a later source revision".into());
    }
    let previous = base.ok_or("prepared Host update source missing")?;
    Ok(Some(previous.source().input.clone()))
}
fn matches_target(
    loaded: &maka_event_log::applications::LoadedDeployment,
    input: &Input,
    packages: &[Package],
) -> bool {
    let mut actual: Vec<_> = loaded
        .packages()
        .iter()
        .map(Package::application_ref)
        .collect();
    let mut desired: Vec<_> = packages.iter().map(Package::application_ref).collect();
    actual.sort();
    desired.sort();
    actual == desired
        && loaded.source().remote_exports.is_empty()
        && loaded.source().input == *input
}

#[cfg(test)]
mod tests;
