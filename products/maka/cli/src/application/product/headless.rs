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
mod decisions;
mod publication;
pub(super) mod update;
use super::{HostError, Input, launch, packages};
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
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use uuid::Uuid;

/// Configured directories seed a new Host; saved application sources own later edits.
pub(crate) enum Roots {
    Saved,
    Configured(Option<Vec<DirectoryRootSpec>>),
}
pub(crate) fn directories(
    roots: Option<Vec<DirectoryRootSpec>>,
) -> Result<Vec<DirectoryRootSpec>, HostError> {
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
    if !source.source.remote_exports.is_empty() {
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

/// launchd starts Dock apps with a soft limit of 256 descriptors, which an idle
/// Host nearly fills; a store that then fails to open a file stops the Host.
#[cfg(unix)]
fn raise_open_file_limit() {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a valid rlimit for the duration of the call.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        eprintln!(
            "open file limit unchanged: {}",
            std::io::Error::last_os_error()
        );
        return;
    }
    let wanted = limit.rlim_max;
    #[cfg(target_os = "macos")]
    let wanted = {
        let mut maximum: libc::c_int = 0;
        let mut size = std::mem::size_of_val(&maximum);
        // SAFETY: the named sysctl writes one c_int into `maximum`; no new value is supplied.
        if unsafe {
            libc::sysctlbyname(
                c"kern.maxfilesperproc".as_ptr(),
                (&raw mut maximum).cast(),
                &raw mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            eprintln!(
                "open file limit unchanged: cannot read kern.maxfilesperproc: {}",
                std::io::Error::last_os_error()
            );
            return;
        }
        wanted.min(maximum as libc::rlim_t)
    };
    if wanted <= limit.rlim_cur {
        return;
    }
    limit.rlim_cur = wanted;
    // SAFETY: `limit` is a valid rlimit; its hard limit is unchanged.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
        eprintln!(
            "open file limit unchanged: cannot raise to {wanted}: {}",
            std::io::Error::last_os_error()
        );
    }
}

pub(crate) async fn open_host(
    owner: RootOwner,
    options: Options,
    roots: Roots,
    catalog_transport: Option<Arc<dyn maka_agent_ports::model::Transport>>,
) -> Result<ProductHost, HostError> {
    #[cfg(unix)]
    raise_open_file_limit();
    let store = Arc::new(
        maka_transport::open_store(Arc::new(owner), &maka_product_native::root_migrations())
            .await?,
    );
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
        let data = store.data_writer()?;
        let state =
            maka_agent_state::Store::new(data.clone(), maka_agent_state::DriverDomain::new(data)?)?;
        Ok(Host::open_loaded_with_options(
            store.clone(),
            loaded,
            crate::application::serve::native(catalog.catalog(), state, std::env::current_exe()?)?,
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
    let configured =
        apply_launch_configuration(store, loaded.source().reference.deployment, None).await?;
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
        store
            .complete_application_launch(deployment, serde_json::to_value(&selection)?)
            .await?;
        return Ok((loaded, selection));
    }
    let record = store
        .application_launch()
        .await?
        .ok_or("public Host selection missing")?;
    // A terminal launcher cannot accidentally reinterpret this Root as its Host.
    let mut selection: Selection = serde_json::from_value(record.configuration.clone())?;
    if let Some(pending) = record.pending {
        let preparation: Preparation = serde_json::from_slice(&pending)?;
        let packages = launch::decode_packages(preparation.packages)?;
        let frozen = PreparedApplication::new(preparation.input.clone(), vec![], packages.clone())?;
        let current = if preparation.expected_revision == 0 {
            store.load_application(record.deployment).await?
        } else {
            None
        };
        if preparation.expected_revision != 0 {
            let mut reference = store
                .read_application_metadata(record.deployment)
                .await?
                .ok_or("public Host source missing")?
                .source
                .reference;
            reference.revision = preparation.expected_revision;
            let previous = store
                .load_application_at(&reference)
                .await?
                .ok_or("prepared Host update source missing")?;
            selection = launch_update(&previous, &frozen, &record.configuration)?.0;
        } else if let Some(current) = &current {
            publication::refresh_from_plan(&mut selection, current.plan())?;
        } else {
            publication::refresh_from_plan(&mut selection, frozen.plan())?;
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
        store
            .complete_application_launch(record.deployment, serde_json::to_value(&selection)?)
            .await?;
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
    let roots = directories(roots)?;
    let packages = tokio::task::spawn_blocking(packages).await??;
    let source = super::authoring()?;
    let release = super::bundle_fingerprint()?;
    super::verified_fingerprint(&source, &packages, &release)?;
    let (sources, baseline) = super::baseline::generate(
        super::baseline::Environment {
            workspace: roots
                .first()
                .map(|root| root.path.clone())
                .unwrap_or(store.owned_root()?.canonical_path().into()),
            roots,
            home: crate::serve::home_directory()?,
            helper: std::env::current_exe()?,
            locale: "auto".into(),
        },
        Uuid::new_v4(),
        BTreeMap::new(),
        &packages,
        &source,
        &release,
    )
    .await?;
    let prepared = PreparedApplication::new(
        sources.host.clone(),
        vec![],
        packages.into_values().chain([baseline]).collect(),
    )?;
    let deployment = sources.deployment;
    // These product endpoints publish every method of their selected service.
    // Explicit generic Host selections leave this ownership set empty.
    let product_methods = ["agent", "settings", "authentication", "setup", "terminal"]
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
    launch_changes(prepared.plan(), &serde_json::to_value(&selection)?)?;
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
    let Some(roots) = roots else {
        return Ok(false);
    };
    let loaded = store
        .load_application(deployment)
        .await?
        .ok_or("public Host source missing")?;
    let (mut source, packages, _, _) = loaded.into_parts();
    let previous = source.input.clone();
    let mut declarations = maka_plugin_core::package::Packages::default();
    for package in &packages {
        declarations.insert_checked(
            package.application_ref(),
            package
                .manifest()
                .application
                .as_ref()
                .ok_or("application package declaration missing")?
                .clone(),
        )?;
    }
    let effective = source.input.materialize(&declarations)?;
    let targets = workspace_location_targets(&effective);
    maka_settings_native::workspace_locations::replace(
        &mut source.input,
        &packages,
        &targets,
        &roots,
    )?;
    if source.input == previous {
        return Ok(false);
    }
    store
        .commit_application(
            deployment,
            source.reference.revision,
            source.input,
            source.remote_exports,
            packages,
        )
        .await?;
    Ok(true)
}

fn workspace_location_targets(
    input: &Input,
) -> maka_settings_native::workspace_locations::Configuration {
    maka_settings_native::workspace_locations::Configuration {
        agent: "agent".into(),
        skills: input
            .instances
            .contains_key("skills")
            .then(|| "skills".into()),
        processes: input
            .instances
            .contains_key("workspace-processes")
            .then(|| "workspace-processes".into()),
    }
}

pub(super) fn launch_changes(
    plan: &maka_plugin_core::plan::Plan,
    configuration: &Value,
) -> Result<Vec<String>, HostError> {
    let mut selection = serde_json::from_value(configuration.clone())?;
    publication::refresh_from_plan(&mut selection, plan)
}

fn launch_update(
    previous: &LoadedDeployment,
    target: &PreparedApplication,
    configuration: &Value,
) -> Result<(Selection, Vec<String>), HostError> {
    let mut selection = serde_json::from_value(configuration.clone())?;
    let mut changes = decisions::publication(&mut selection, previous.plan(), target.plan())?;
    changes.extend(publication::rebase(&mut selection, previous, target)?);
    changes.extend(publication::refresh_from_plan(
        &mut selection,
        target.plan(),
    )?);
    Ok((selection, changes))
}

pub(super) async fn preview_update(store: &EventLog) -> Result<super::update::Outcome, HostError> {
    update::preview(store).await
}

pub(super) async fn apply_update(store: &RootStore) -> Result<super::update::Outcome, HostError> {
    update::synchronize(store, true).await
}

pub(crate) async fn configure_workspace_locations(
    owner: Arc<RootOwner>,
    roots: Vec<DirectoryRootSpec>,
) -> Result<(), HostError> {
    let store = maka_transport::open_store(owner, &maka_product_native::root_migrations()).await?;
    let result = replace_workspace_locations(&store, roots).await;
    store.drain().await;
    result
}

async fn replace_workspace_locations(
    store: &RootStore,
    roots: Vec<DirectoryRootSpec>,
) -> Result<(), HostError> {
    let (loaded, _) = prepare_saved(store, Roots::Configured(Some(roots.clone()))).await?;
    apply_launch_configuration(store, loaded.source().reference.deployment, Some(roots)).await?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::raise_open_file_limit;

    #[cfg(unix)]
    #[test]
    fn a_low_open_file_limit_is_raised_within_the_hard_limit() {
        const CHILD: &str = "MAKA_OPEN_FILE_LIMIT_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "application::product::headless::tests::a_low_open_file_limit_is_raised_within_the_hard_limit",
                    "--test-threads=1",
                ])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated open file limit test failed: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        // This exact-test subprocess owns its limit.
        let read = || {
            let mut limit = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            // SAFETY: `limit` is a valid rlimit for the duration of the call.
            assert_eq!(
                unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
                0
            );
            limit
        };
        let original = read();
        #[cfg(not(target_os = "macos"))]
        {
            let low = libc::rlimit {
                rlim_cur: original.rlim_max.min(64),
                rlim_max: original.rlim_max,
            };
            // SAFETY: only this subprocess's soft limit is lowered.
            assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &low) }, 0);
            raise_open_file_limit();
            let raised = read();
            assert_eq!(raised.rlim_cur, original.rlim_max);
            assert_eq!(raised.rlim_max, original.rlim_max);
        }

        let hard = original.rlim_max.min(200);
        let low = libc::rlimit {
            rlim_cur: hard.min(64),
            rlim_max: hard,
        };
        // SAFETY: `low` is a valid rlimit for the duration of the call.
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &low) }, 0);
        raise_open_file_limit();
        assert_eq!(read().rlim_cur, hard);
    }
}
