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
//! A public Host opens the same persisted product source across process restarts.
mod publication;
pub(super) mod update;
use super::{HostError, Input, author, installation, launch, packages};
use base64::{Engine, engine::general_purpose::STANDARD};
use maka_event_log::{
    EventLog,
    applications::{LoadedDeployment, PreparedApplication, launch::Launch},
    root::RootOwner,
    root_store::RootStore,
};
use maka_host_runtime::{
    DirectoryRootSpec,
    application::host::{Host, Options},
};
pub(crate) use publication::{LivePublication, prepare_live_publication};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};
use uuid::Uuid;

const PROCESS_INSTANCES: [&str; 2] = ["workspace-processes", "coordinator-workspace-processes"];

/// Managed deployment directories are authoritative; standalone reopen preserves source edits.
pub(crate) enum Roots {
    Saved,
    Configured(Option<Vec<DirectoryRootSpec>>),
}
fn directories(roots: Option<Vec<DirectoryRootSpec>>) -> Result<Vec<DirectoryRootSpec>, HostError> {
    DirectoryRootSpec::normalize(match roots {
        Some(roots) => roots,
        None => vec![DirectoryRootSpec {
            label: "~".into(),
            path: crate::serve::home_directory()?
                .ok_or("public Host needs a home directory or explicit project directories")?,
        }],
    })
}

use maka_host_runtime::application::host::Configuration as Selection;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preparation {
    expected_revision: u64,
    input: Input,
    packages: Vec<BTreeMap<String, String>>,
}

/// Bind an explicitly committed generic Host without reauthoring its source.
pub(crate) async fn select_committed_host(
    store: &RootStore,
    request: &maka_host_runtime::application::host::startup::Request,
) -> Result<(), HostError> {
    if let Some(record) = store.application_launch().await? {
        let _: Selection = serde_json::from_value(record.configuration)?;
        if record.deployment != request.deployment {
            return Err("saved public Host selects another application deployment".into());
        }
        // Existing publication/grants remain authoritative, even when this UI
        // selects a narrower subset. The peer handshake validates that subset.
        return Ok(());
    }
    let source = store
        .read_application_metadata(request.deployment)
        .await?
        .ok_or("commit the selected Host deployment before opening its UI")?;
    if source.source.input.environment.location
        != maka_plugin_core::composition::ExecutionLocation::Host
        || !source.source.remote_exports.is_empty()
    {
        return Err("selected deployment is not a local Host source".into());
    }
    store
        .select_committed_application_launch(
            source.source.reference,
            serde_json::to_value(Selection::PublicHost {
                endpoints: request.endpoints.clone(),
                native: request.native.clone(),
                product_methods: Default::default(),
            })?,
        )
        .await?;
    Ok(())
}

/// Product resources retain their Root until public I/O has been cancelled
/// and joined, even when generic Host shutdown has already drained its store.
pub(crate) struct ProductHost {
    pub host: Arc<Host>,
    catalog: maka_product_native::catalog::RuntimeCatalog,
}
impl ProductHost {
    pub(crate) fn admitted(
        host: Arc<Host>,
        mut catalog: maka_product_native::catalog::RuntimeCatalog,
    ) -> Self {
        catalog.start(host.wait_for_drain());
        Self { host, catalog }
    }
    pub(crate) async fn shutdown(&mut self) -> Result<(), HostError> {
        let catalog = self.catalog.shutdown().await.map_err(HostError::from);
        let host = self.host.shutdown().await.map_err(HostError::from);
        catalog.and(host)
    }
}

pub(crate) async fn open_host(
    owner: RootOwner,
    options: Options,
    roots: Roots,
    catalog_transport: Option<Arc<dyn maka_agent_ports::model::Transport>>,
) -> Result<ProductHost, HostError> {
    let store = Arc::new(maka_transport::open_store(Arc::new(owner)).await?);
    let catalog = async {
        let configuration = maka_config::ConfigurationStore::for_root(store.owned_root()?).await?;
        let catalog = match catalog_transport {
            Some(transport) => {
                maka_product_native::catalog::RuntimeCatalog::with_transport(
                    configuration,
                    transport,
                )
                .await?
            }
            None => maka_product_native::catalog::RuntimeCatalog::open(configuration).await?,
        };
        Ok::<_, HostError>(catalog)
    }
    .await;
    let mut catalog = match catalog {
        Ok(catalog) => catalog,
        Err(error) => {
            store.drain().await;
            return Err(error);
        }
    };
    let result = async {
        let (loaded, selection) = prepare(&store, roots).await?;
        Ok(Host::open_loaded_with_options(
            store.clone(),
            loaded,
            crate::application::serve::native(catalog.catalog())?,
            Some(maka_host_js::factory(Default::default())),
            selection,
            options,
        )
        .await?)
    }
    .await;
    match result {
        Ok(host) => Ok(ProductHost::admitted(host, catalog)),
        Err(error) => {
            let cleanup = catalog.shutdown().await;
            store.drain().await;
            cleanup.map_err(HostError::from)?;
            Err(error)
        }
    }
}
async fn prepare(
    store: &RootStore,
    roots: Roots,
) -> Result<(LoadedDeployment, Selection), HostError> {
    // A fresh Host is already authored from the current bundle.
    if store.application_launch().await?.is_none() {
        return prepare_saved(store, roots).await;
    }
    // Recover a frozen operation before considering the executing bundle. The
    // updater uses prepare_saved too, so applying a replacement cannot recurse.
    let (loaded, _) = prepare_saved(store, Roots::Saved).await?;
    let root = store.owned_root()?.canonical_path().to_owned();
    let outcome = update::synchronize(store, true).await.map_err(|error| {
        HostError::from(format!(
            "Automatic bundled application update failed: {error}. Resolve the reported error and retry starting the Host; application update-defaults --root {} previews the update.",
            root.display()
        ))
    })?;
    let roots = match roots {
        Roots::Saved => None,
        Roots::Configured(roots) => Some(directories(roots)?),
    };
    let configured =
        apply_launch_configuration(store, loaded.source().reference.deployment, roots).await?;
    let loaded = if outcome.applied || configured {
        store
            .load_application(loaded.source().reference.deployment)
            .await?
            .ok_or("public Host source missing")?
    } else {
        loaded
    };
    let selection = publication::synchronize(store, &loaded).await?;
    Ok((loaded, selection))
}

// Explicit update recovery must finish only its frozen target, without starting
// another update from a potentially newer bundle.
async fn prepare_saved(
    store: &RootStore,
    roots: Roots,
) -> Result<(LoadedDeployment, Selection), HostError> {
    if store.application_launch().await?.is_none() {
        let initial = match &roots {
            Roots::Saved => None,
            Roots::Configured(roots) => roots.clone(),
        };
        let (deployment, selection, prepared) = begin(store, initial).await?;
        let loaded = store
            .commit_prepared_application(deployment, 0, prepared)
            .await?;
        store.complete_application_launch(deployment).await?;
        return Ok((loaded, selection));
    }
    let record = store
        .application_launch()
        .await?
        .ok_or("public Host selection missing")?;
    // A terminal launcher cannot accidentally reinterpret this Root as its Host.
    let selection: Selection = serde_json::from_value(record.configuration.clone())?;
    if let Some(pending) = record.pending {
        let preparation: Preparation = serde_json::from_slice(&pending)?;
        let packages = launch::decode_packages(preparation.packages)?;
        if preparation.input.environment.location
            != maka_plugin_core::composition::ExecutionLocation::Host
        {
            return Err("public Host update requires a local Host source".into());
        }
        let frozen = PreparedApplication::new(preparation.input.clone(), vec![], packages.clone())?;
        let current = if preparation.expected_revision == 0 {
            store.load_application(record.deployment).await?
        } else {
            None
        };
        if let Some(current) = &current {
            launch_changes(
                &current.source().input,
                current.packages(),
                current.plan(),
                &record.configuration,
            )?;
        } else {
            launch_changes(
                frozen.input(),
                frozen.packages(),
                frozen.plan(),
                &record.configuration,
            )?;
        }
        if preparation.expected_revision == 0 {
            launch::ensure(store, record.deployment, &preparation.input, &[], &packages).await?;
        } else {
            launch::ensure_replacement(
                store,
                record.deployment,
                preparation.expected_revision,
                &preparation.input,
                &[],
                &packages,
            )
            .await?;
        }
        store.complete_application_launch(record.deployment).await?;
    }
    let loaded = store
        .load_application(record.deployment)
        .await?
        .ok_or("public Host source missing")?;
    Ok((loaded, selection))
}
async fn begin(
    store: &RootStore,
    roots: Option<Vec<DirectoryRootSpec>>,
) -> Result<(Uuid, Selection, PreparedApplication), HostError> {
    let home = crate::serve::home_directory()?;
    let roots = directories(roots)?;
    let root = store.owned_root()?;
    let mut configuration = installation(json!({
        "workspace": roots.first().map(|root| root.path.as_path()).unwrap_or(root.canonical_path()),
        "helper": std::env::current_exe()?,
        "home": home,
    }))
    .await?;
    configuration["agent"]["workspaceRoots"] = serde_json::to_value(&roots)?;
    configuration["skills"]["projectRoots"] = serde_json::to_value(&roots)?;
    configuration["processes"]["filesystem"]["rules"] = Value::Array(
        roots
            .iter()
            .map(|root| json!({"path": root.path, "scope": "subtree", "access": "write"}))
            .collect(),
    );
    let packages = tokio::task::spawn_blocking(packages).await??;
    let (sources, _, prepared) = author(configuration, &packages).await?;
    let deployment = sources.deployment;
    // These product endpoints publish every method of their selected service.
    // Explicit generic Host selections leave this ownership set empty.
    let product_methods = [
        "agent",
        "coordinator",
        "settings",
        "authentication",
        "setup",
        "terminal",
        "coordinatorTerminal",
        "workhub",
    ]
    .into_iter()
    .filter(|name| sources.endpoints.contains_key(*name))
    .map(str::to_owned)
    .collect();
    let selection = Selection::PublicHost {
        endpoints: sources.endpoints,
        native: sources.native,
        product_methods,
    };
    let preparation = Preparation {
        expected_revision: 0,
        input: prepared.input().clone(),
        packages: prepared
            .packages()
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
    launch_changes(
        prepared.input(),
        prepared.packages(),
        prepared.plan(),
        &serde_json::to_value(&selection)?,
    )?;
    store
        .begin_application_launch(Launch {
            deployment,
            configuration: serde_json::to_value(&selection)?,
            pending: Some(serde_json::to_vec(&preparation)?),
        })
        .await?;
    Ok((deployment, selection, prepared))
}

async fn apply_launch_configuration(
    store: &RootStore,
    deployment: Uuid,
    roots: Option<Vec<DirectoryRootSpec>>,
) -> Result<bool, HostError> {
    let metadata = store
        .read_application_metadata(deployment)
        .await?
        .ok_or("public Host source missing")?;
    // The bootstrap helper implements this executable's internal protocol. Its
    // installation path is launcher-owned, even when the bundle is unchanged.
    let helper = serde_json::to_value(std::env::current_exe()?)?;
    let processes: Vec<_> = PROCESS_INSTANCES
        .into_iter()
        .filter(|name| {
            metadata
                .source
                .input
                .instances
                .get(*name)
                .is_some_and(|node| node.configuration.values.get("helper") != Some(&helper))
        })
        .collect();
    let current = metadata
        .source
        .input
        .instances
        .get("agent")
        .and_then(|node| node.configuration.values.get("workspaceRoots"));
    let roots = roots
        .map(serde_json::to_value)
        .transpose()?
        .filter(|roots| current != Some(roots));
    if roots.is_none() && processes.is_empty() {
        return Ok(false);
    }
    // Read payloads only when a launcher-owned value might change.
    let loaded = store
        .load_application_at(&metadata.source.reference)
        .await?
        .ok_or("public Host source missing")?;
    let (mut source, packages, _, _) = loaded.into_parts();
    let input = &mut source.input;
    let helper_changes = refresh_helpers(input, &packages, &helper);
    if roots.is_none() && helper_changes.is_empty() {
        return Ok(false);
    }
    if let Some(roots) = roots {
        configuration_values(input, &packages, "agent", maka_agent_api::IMPLEMENTATION)
            .ok_or("managed Agent configuration no longer targets the saved native component")?
            .insert("workspaceRoots".into(), roots.clone());
        if input.instances.contains_key("skills") {
            configuration_values(input, &packages, "skills", maka_skills_api::IMPLEMENTATION)
                .ok_or("managed skills configuration no longer targets the saved native component")?
                .insert("projectRoots".into(), roots.clone());
        }
        if input.instances.contains_key("workspace-processes") {
            let filesystem = configuration_values(
                input,
                &packages,
                "workspace-processes",
                maka_workspace_api::processes::IMPLEMENTATION,
            )
            .ok_or("managed process configuration no longer targets the saved native component")?
            .get_mut("filesystem")
            .and_then(Value::as_object_mut)
            .ok_or("public Host filesystem ceiling missing")?;
            let previous = current
                .and_then(Value::as_array)
                .ok_or("saved published directories missing")?;
            let rules = filesystem
                .get_mut("rules")
                .and_then(Value::as_array_mut)
                .ok_or("saved filesystem rules missing")?;
            // Replace the published roots' write ceiling, preserving narrower
            // user-authored read/deny rules and unrelated filesystem restrictions.
            rules.retain(|rule| {
                !(rule["scope"] == "subtree"
                    && rule["access"] == "write"
                    && previous.iter().any(|root| root["path"] == rule["path"]))
            });
            for root in roots.as_array().expect("directory list") {
                if !rules.iter().any(|rule| rule["path"] == root["path"]) {
                    rules
                        .push(json!({"path": root["path"], "scope": "subtree", "access": "write"}));
                }
            }
        }
    }
    store
        .commit_application(
            deployment,
            metadata.source.reference.revision,
            source.input,
            source.remote_exports,
            packages,
        )
        .await?;
    Ok(true)
}

fn refresh_helpers(input: &mut Input, packages: &[super::Package], helper: &Value) -> Vec<String> {
    let mut changes = Vec::new();
    for name in PROCESS_INSTANCES {
        // Custom components and composition wrappers own their configuration.
        if let Some(values) = configuration_values(
            input,
            packages,
            name,
            maka_workspace_api::processes::IMPLEMENTATION,
        ) && values.get("helper") != Some(helper)
        {
            values.insert("helper".into(), helper.clone());
            changes.push(format!(
                "/instances/{name}/configuration/values/helper: use launcher executable"
            ));
        }
    }
    changes
}

pub(super) fn launch_changes(
    input: &Input,
    packages: &[super::Package],
    plan: &maka_plugin_core::plan::Plan,
    configuration: &Value,
) -> Result<Vec<String>, HostError> {
    let helper = serde_json::to_value(std::env::current_exe()?)?;
    let mut changes = refresh_helpers(&mut input.clone(), packages, &helper);
    let mut selection = serde_json::from_value(configuration.clone())?;
    changes.extend(publication::refresh_from_plan(&mut selection, plan)?);
    Ok(changes)
}

pub(super) async fn preview_update(store: &EventLog) -> Result<super::update::Outcome, HostError> {
    let (mut outcome, target) = update::preview(store).await?;
    let record = store
        .application_launch()
        .await?
        .ok_or("public Host selection missing")?;
    let changes = launch_changes(
        target.input(),
        target.packages(),
        target.plan(),
        &record.configuration,
    )?;
    outcome.changed |= !changes.is_empty();
    outcome.changes.extend(changes);
    Ok(outcome)
}

pub(super) async fn apply_update(store: &RootStore) -> Result<super::update::Outcome, HostError> {
    // Recover exactly one frozen package target before reconciling launcher
    // values. Calling prepare here would select the executing bundle again.
    let mut outcome = update::synchronize(store, true).await?;
    let record = store
        .application_launch()
        .await?
        .ok_or("public Host selection missing")?;
    let loaded = store
        .load_application(record.deployment)
        .await?
        .ok_or("public Host source missing")?;
    let changes = launch_changes(
        &loaded.source().input,
        loaded.packages(),
        loaded.plan(),
        &record.configuration,
    )?;
    if changes.is_empty() {
        return Ok(outcome);
    }
    let configured = apply_launch_configuration(store, record.deployment, None).await?;
    let loaded = if configured {
        store
            .load_application(record.deployment)
            .await?
            .ok_or("public Host source missing")?
    } else {
        loaded
    };
    publication::synchronize(store, &loaded).await?;
    outcome.changed = true;
    outcome.applied = true;
    outcome.changes.extend(changes);
    Ok(outcome)
}

fn configuration_values<'a>(
    input: &'a mut Input,
    packages: &[super::Package],
    name: &str,
    expected: &str,
) -> Option<&'a mut BTreeMap<String, Value>> {
    use maka_plugin_core::{
        composition::PackageUse,
        package::{EntryTarget, Implementation, PackageSelection},
    };
    let node = input.instances.get_mut(name)?;
    let PackageSelection::Pinned { package } = &node.package else {
        return None;
    };
    let native = packages
        .iter()
        .find(|bytes| bytes.application_ref() == *package)
        .and_then(|bytes| bytes.manifest().application.as_ref())
        .and_then(|declaration| declaration.entries.get(&EntryTarget::Host));
    if node.use_package != PackageUse::Entry
        || !node.configuration.parameters.is_empty()
        || !matches!(native, Some(entry) if matches!(&entry.implementation, Implementation::Native { implementation } if implementation == expected))
    {
        return None;
    }
    Some(&mut node.configuration.values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn explicit_update_previews_and_applies_launch_drift_with_current_packages() {
        let directory = tempfile::tempdir().unwrap();
        let store = launch::create(directory.path().join("host")).await.unwrap();
        let (initial, mut selection) = prepare(&store, Roots::Configured(Some(vec![])))
            .await
            .unwrap();
        let original = store.application_launch().await.unwrap().unwrap();
        let mut input = initial.source().input.clone();
        let missing = directory.path().join("removed-cli");
        for name in PROCESS_INSTANCES {
            input
                .instances
                .get_mut(name)
                .unwrap()
                .configuration
                .values
                .insert("helper".into(), json!(missing));
        }
        let stale_source = store
            .commit_application(
                original.deployment,
                initial.source().reference.revision,
                input.clone(),
                vec![],
                initial.packages().to_vec(),
            )
            .await
            .unwrap();
        let Selection::PublicHost { endpoints, .. } = &mut selection;
        for name in ["agent", "coordinator"] {
            assert!(
                endpoints
                    .get_mut(name)
                    .unwrap()
                    .grant
                    .methods
                    .remove("projectMcp")
            );
        }
        let stale_selection = serde_json::to_value(selection).unwrap();
        assert!(
            store
                .compare_and_set_application_launch_configuration(
                    stale_source.clone(),
                    original.configuration.clone(),
                    stale_selection.clone(),
                )
                .await
                .unwrap()
        );

        let owner = store.owned_root().unwrap();
        store.drain().await;
        drop(store);
        let inspection = maka_transport::open_application_inspection(owner.clone())
            .await
            .unwrap();
        let preview = preview_update(&inspection).await.unwrap();
        assert!(preview.changed);
        assert!(!preview.applied);
        assert_eq!(
            preview.changes,
            [
                "/instances/workspace-processes/configuration/values/helper: use launcher executable",
                "/instances/coordinator-workspace-processes/configuration/values/helper: use launcher executable",
                "/publication/endpoints/agent/grant/methods: follow current service contract",
                "/publication/endpoints/coordinator/grant/methods: follow current service contract",
            ]
        );
        let unchanged = inspection
            .load_application(original.deployment)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.source().reference, stale_source);
        assert_eq!(unchanged.source().input, input);
        assert_eq!(
            inspection
                .application_launch()
                .await
                .unwrap()
                .unwrap()
                .configuration,
            stale_selection
        );
        inspection.drain().await;
        drop(inspection);

        let store = maka_transport::open_store(owner.clone()).await.unwrap();
        let applied = apply_update(&store).await.unwrap();
        assert!(applied.changed && applied.applied);
        assert_eq!(applied.changes, preview.changes);
        let updated = store
            .load_application(original.deployment)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            updated.source().reference.revision,
            stale_source.revision + 1
        );
        assert_eq!(updated.source().input, initial.source().input);
        assert_eq!(
            store
                .application_launch()
                .await
                .unwrap()
                .unwrap()
                .configuration,
            original.configuration
        );
        store.drain().await;
        drop(store);
        let inspection = maka_transport::open_application_inspection(owner)
            .await
            .unwrap();
        let again = preview_update(&inspection).await.unwrap();
        assert!(!again.changed && !again.applied);
        assert!(again.changes.is_empty());
        inspection.drain().await;
    }

    #[tokio::test]
    async fn startup_refreshes_product_methods_without_expanding_explicit_publications() {
        let directory = tempfile::tempdir().unwrap();
        let store = launch::create(directory.path().join("host")).await.unwrap();
        let (initial, original) = prepare(&store, Roots::Configured(Some(vec![])))
            .await
            .unwrap();
        let original = serde_json::to_value(original).unwrap();
        for product_owned in [true, false] {
            let mut narrowed: Selection = serde_json::from_value(original.clone()).unwrap();
            let Selection::PublicHost {
                endpoints,
                product_methods,
                ..
            } = &mut narrowed;
            for name in ["agent", "coordinator"] {
                for method in ["projectMcp", "trustProjectMcp", "fileCandidates"] {
                    assert!(
                        endpoints
                            .get_mut(name)
                            .unwrap()
                            .grant
                            .methods
                            .remove(method)
                    );
                }
            }
            if !product_owned {
                product_methods.clear();
            }
            let narrowed = serde_json::to_value(narrowed).unwrap();
            let previous = store.application_launch().await.unwrap().unwrap();
            assert!(
                store
                    .compare_and_set_application_launch_configuration(
                        initial.source().reference.clone(),
                        previous.configuration,
                        narrowed.clone(),
                    )
                    .await
                    .unwrap()
            );

            let (reopened, selection) = prepare(&store, Roots::Saved).await.unwrap();
            assert_eq!(reopened.source().reference, initial.source().reference);
            assert_eq!(reopened.source().input, initial.source().input);
            let Selection::PublicHost { endpoints, .. } = &selection;
            for name in ["agent", "coordinator"] {
                for method in ["projectMcp", "trustProjectMcp", "fileCandidates"] {
                    assert_eq!(
                        endpoints[name].grant.methods.contains(method),
                        product_owned
                    );
                }
            }
            let expected = if product_owned { &original } else { &narrowed };
            assert_eq!(serde_json::to_value(selection).unwrap(), *expected);
            let record = store.application_launch().await.unwrap().unwrap();
            assert_eq!(record.configuration, *expected);
            assert!(record.pending.is_none());

            let (again, selection) = prepare(&store, Roots::Saved).await.unwrap();
            assert_eq!(again.source().reference, initial.source().reference);
            assert_eq!(serde_json::to_value(selection).unwrap(), *expected);
            assert_eq!(
                store
                    .application_launch()
                    .await
                    .unwrap()
                    .unwrap()
                    .configuration,
                *expected
            );
        }
        store.drain().await;
    }

    #[tokio::test]
    async fn startup_updates_old_selected_packages_and_retries_after_incompatible_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let store = launch::create(directory.path().join("host")).await.unwrap();
        let (initial, _) = prepare(&store, Roots::Configured(Some(vec![])))
            .await
            .unwrap();
        let deployment = initial.source().reference.deployment;
        let selection = store
            .application_launch()
            .await
            .unwrap()
            .unwrap()
            .configuration;
        let current = initial
            .packages()
            .iter()
            .find(|package| package.application_ref().id == "maka.agent.settings")
            .unwrap();
        // Model an older, valid settings package whose configuration accepted a
        // setting removed by the current bundled revision.
        let mut files = current.files().clone();
        let mut manifest: Value = serde_json::from_slice(&files["maka.extension.json"]).unwrap();
        manifest["application"]["entries"]["host"]["configuration"]["properties"]["legacySetting"] =
            json!({"type":"boolean"});
        files.insert(
            "maka.extension.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        let previous = super::super::Package::new(files).unwrap();
        let mut input = initial.source().input.clone();
        let settings = input.instances.get_mut("settings").unwrap();
        settings.package = previous.application_ref().into();
        settings
            .configuration
            .values
            .insert("legacySetting".into(), json!(true));
        settings
            .configuration
            .values
            .insert("locale".into(), json!("zh-CN"));
        let packages: Vec<_> = initial
            .packages()
            .iter()
            .map(|package| {
                if package.application_ref() == current.application_ref() {
                    previous.clone()
                } else {
                    package.clone()
                }
            })
            .collect();
        let old = store
            .commit_application(
                deployment,
                initial.source().reference.revision,
                input.clone(),
                vec![],
                packages.clone(),
            )
            .await
            .unwrap();
        let error = prepare(&store, Roots::Saved).await.err().unwrap();
        assert!(
            error
                .to_string()
                .contains("Automatic bundled application update failed"),
            "{error}"
        );
        assert!(error.to_string().contains("configuration"), "{error}");
        let unchanged = store.load_application(deployment).await.unwrap().unwrap();
        assert_eq!(unchanged.source().reference, old);
        assert_eq!(unchanged.source().input, input);
        assert!(
            store
                .application_launch()
                .await
                .unwrap()
                .unwrap()
                .pending
                .is_none()
        );
        // Fix the reported user configuration and retry the exact startup path.
        input
            .instances
            .get_mut("settings")
            .unwrap()
            .configuration
            .values
            .remove("legacySetting");
        let fixed = store
            .commit_application(deployment, old.revision, input.clone(), vec![], packages)
            .await
            .unwrap();
        let (updated, _) = prepare(&store, Roots::Saved).await.unwrap();
        input.instances.get_mut("settings").unwrap().package = current.application_ref().into();
        assert_eq!(updated.source().input, input);
        assert_eq!(updated.source().reference.revision, fixed.revision + 1);
        let record = store.application_launch().await.unwrap().unwrap();
        assert_eq!(record.configuration, selection);
        assert!(record.pending.is_none());
        let (again, _) = prepare(&store, Roots::Saved).await.unwrap();
        assert_eq!(again.source().reference, updated.source().reference);
        store.drain().await;
    }

    #[tokio::test]
    async fn public_host_starts_with_workspace_write_and_preserves_saved_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let namespaces = maka_event_log::root::RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let root = directory.path().join("root");
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let store = RootStore::open(Arc::new(RootOwner::create(&root, &namespaces).unwrap()))
            .await
            .unwrap();
        let roots = vec![DirectoryRootSpec {
            label: "Workspace".into(),
            path: workspace.clone(),
        }];
        begin(&store, Some(roots)).await.unwrap();
        let record = store.application_launch().await.unwrap().unwrap();
        assert!(record.pending.is_some());
        let selected_id = record.deployment;
        let (loaded, Selection::PublicHost { endpoints, .. }) =
            prepare(&store, Roots::Saved).await.unwrap();
        let deployment = loaded.source().reference.deployment;
        assert_eq!(deployment, selected_id);
        assert!(endpoints.contains_key("agent"));
        assert!(
            store
                .application_launch()
                .await
                .unwrap()
                .unwrap()
                .pending
                .is_none()
        );
        let original = store.load_application(deployment).await.unwrap().unwrap();
        let agent = original.source().input.instances.get("agent").unwrap();
        let config = serde_json::to_value(agent).unwrap();
        assert_eq!(
            config["configuration"]["values"]["permissions"]["access"],
            "workspace_write"
        );
        assert_eq!(
            config["configuration"]["values"]["workspaceRoots"][0]["path"],
            serde_json::to_value(workspace.canonicalize().unwrap()).unwrap()
        );
        assert!(original.packages().iter().all(|package| {
            package
                .manifest()
                .application
                .as_ref()
                .unwrap()
                .entries
                .contains_key(&maka_plugin_core::package::EntryTarget::Host)
        }));
        let revision = original.source().reference.revision;
        let (reopened, _) = prepare(&store, Roots::Saved).await.unwrap();
        let reopened = reopened.source().reference.deployment;
        assert_eq!(reopened, deployment);
        assert_eq!(
            store
                .load_application(reopened)
                .await
                .unwrap()
                .unwrap()
                .source()
                .reference
                .revision,
            revision
        );
        let mut customized = original.source().input.clone();
        customized
            .instances
            .get_mut("agent")
            .unwrap()
            .configuration
            .values
            .get_mut("permissions")
            .unwrap()["access"] = json!("read_only");
        let restriction =
            json!({"path": workspace.join("private"), "scope": "subtree", "access": "deny"});
        customized
            .instances
            .get_mut("workspace-processes")
            .unwrap()
            .configuration
            .values
            .get_mut("filesystem")
            .unwrap()["rules"]
            .as_array_mut()
            .unwrap()
            .push(restriction.clone());
        store
            .commit_application(
                deployment,
                revision,
                customized,
                original.source().remote_exports.clone(),
                original.packages().to_vec(),
            )
            .await
            .unwrap();
        prepare(&store, Roots::Configured(Some(vec![])))
            .await
            .unwrap();
        let changed = store.load_application(deployment).await.unwrap().unwrap();
        assert_eq!(changed.source().reference.revision, revision + 2);
        assert_eq!(
            changed.source().input.instances["agent"]
                .configuration
                .values["workspaceRoots"],
            json!([])
        );
        assert_eq!(
            changed.source().input.instances["skills"]
                .configuration
                .values["projectRoots"],
            json!([])
        );
        assert_eq!(
            changed.source().input.instances["workspace-processes"]
                .configuration
                .values["filesystem"]["rules"],
            json!([restriction])
        );
        assert_eq!(
            changed.source().input.instances["agent"]
                .configuration
                .values["permissions"]["access"],
            "read_only"
        );
        prepare(&store, Roots::Configured(Some(vec![])))
            .await
            .unwrap();
        prepare(&store, Roots::Saved).await.unwrap();
        assert_eq!(
            store
                .read_application_metadata(deployment)
                .await
                .unwrap()
                .unwrap()
                .source
                .reference,
            changed.source().reference
        );
        // A moved/rebuilt CLI must replace even an existing older helper, with
        // no package update and without changing the user's source or permissions.
        let old_helper = directory.path().join("old-maka");
        std::fs::write(&old_helper, b"old executable").unwrap();
        let expected = changed.source().input.clone();
        let mut revision = changed.source().reference.revision;
        for exists in [true, false] {
            if !exists {
                std::fs::remove_file(&old_helper).unwrap();
            }
            let mut stale = expected.clone();
            for name in ["workspace-processes", "coordinator-workspace-processes"] {
                stale
                    .instances
                    .get_mut(name)
                    .unwrap()
                    .configuration
                    .values
                    .insert("helper".into(), json!(old_helper));
            }
            let stale = store
                .commit_application(
                    deployment,
                    revision,
                    stale,
                    changed.source().remote_exports.clone(),
                    changed.packages().to_vec(),
                )
                .await
                .unwrap();
            let (repaired, _) = prepare(&store, Roots::Saved).await.unwrap();
            assert_eq!(repaired.source().input, expected);
            assert_eq!(repaired.source().reference.deployment, deployment);
            assert_eq!(repaired.source().reference.revision, stale.revision + 1);
            let (again, _) = prepare(&store, Roots::Saved).await.unwrap();
            assert_eq!(again.source().reference, repaired.source().reference);
            revision = repaired.source().reference.revision;
        }
        store.drain().await;
    }
}
