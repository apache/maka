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
//! Product authoring loads checked packages embedded in this executable.
use super::{HostError, Input, Package, RemoteObservation, read_json};
use clap::Args;
use maka_event_log::applications::PreparedApplication;
use maka_js_runtime::plugin::Vm;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, io::Write, path::PathBuf};

mod headless;
mod launch;
mod update;
pub(crate) use headless::update::live_update_available;
pub(crate) use headless::{
    LivePublication, ProductHost, Roots, configure_workspace_locations, directories, open_host,
    prepare_live_publication, select_committed_host,
};
pub(super) use update::Update;

pub(super) fn root_path(root: Option<PathBuf>) -> Result<PathBuf, HostError> {
    match root {
        Some(root) => Ok(std::path::absolute(root)?),
        None => Ok(crate::serve::home_directory()?
            .ok_or("home directory unavailable; select --root")?
            .join(".maka/application/host")),
    }
}

struct Bundled {
    name: &'static str,
    files: &'static [(&'static str, &'static [u8])],
}
include!(concat!(env!("OUT_DIR"), "/product-assets.rs"));

#[derive(Args)]
pub(crate) struct Compose {
    /// Installation configuration and explicit grants; omitted identities are generated once.
    #[arg(long, value_name = "FILE")]
    configuration: PathBuf,
    /// New output directory for checked sources, connection input and exact packages.
    #[arg(long, value_name = "DIRECTORY")]
    output: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sources {
    host: Input,
    deployment: uuid::Uuid,
    endpoints: BTreeMap<String, maka_host_runtime::application::transport::HostEndpoint>,
    native: Vec<maka_host_runtime::application::transport::NativeGrant>,
}

impl Compose {
    pub(super) async fn run(self) -> Result<(), HostError> {
        let configuration = read_json(&self.configuration)?;
        let version = bundle_fingerprint()?;
        let packages = tokio::task::spawn_blocking(packages).await??;
        let authoring = authoring()?;
        verified_fingerprint(&authoring, &packages, &version)?;
        let (sources, installation, _) =
            author_with_source(configuration, &packages, &authoring).await?;
        tokio::task::spawn_blocking(move || export(self.output, sources, installation, packages))
            .await??;
        println!("Checked product sources and immutable packages written");
        Ok(())
    }
}

fn packages() -> Result<BTreeMap<String, Package>, HostError> {
    BUNDLED
        .iter()
        .map(|bundled| {
            let files = bundled
                .files
                .iter()
                .map(|(name, bytes)| ((*name).into(), bytes.to_vec()))
                .collect();
            Ok((bundled.name.into(), Package::new(files)?))
        })
        .collect()
}

fn fingerprint(source: &str, packages: impl IntoIterator<Item = (String, String)>) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"maka-product-v1\0");
    hash.update((source.len() as u64).to_be_bytes());
    hash.update(source.as_bytes());
    let packages: BTreeMap<_, _> = packages.into_iter().collect();
    for (name, digest) in packages {
        hash.update((name.len() as u64).to_be_bytes());
        hash.update(name.as_bytes());
        hash.update((digest.len() as u64).to_be_bytes());
        hash.update(digest.as_bytes());
    }
    format!("sha256-{}", hex::encode(hash.finalize()))
}
// This generated identifier is a no-op hint, never package execution admission.
// Actual installation/update candidates must pass verified_fingerprint below.
fn bundle_fingerprint() -> Result<String, HostError> {
    Ok(PRODUCT_VERSION.trim_end().into())
}
fn verified_fingerprint(
    source: &str,
    packages: &BTreeMap<String, Package>,
    expected: &str,
) -> Result<String, HostError> {
    let actual = fingerprint(
        source,
        packages
            .iter()
            .map(|(name, package)| (name.clone(), package.digest().to_owned())),
    );
    if actual != expected {
        return Err(
            "product bundle does not match its generated version; rebuild the product bundle"
                .into(),
        );
    }
    Ok(actual)
}
fn authoring() -> Result<String, HostError> {
    Ok(AUTHORING.into())
}

async fn author(
    configuration: Value,
    packages: &BTreeMap<String, Package>,
) -> Result<(Sources, Value, PreparedApplication), HostError> {
    let source = authoring()?;
    verified_fingerprint(&source, packages, &bundle_fingerprint()?)?;
    author_with_source(configuration, packages, &source).await
}
async fn author_with_source(
    mut configuration: Value,
    packages: &BTreeMap<String, Package>,
    source: &str,
) -> Result<(Sources, Value, PreparedApplication), HostError> {
    let values = configuration
        .as_object_mut()
        .ok_or("installation configuration must be an object")?;
    let references: BTreeMap<_, _> = packages
        .iter()
        .map(|(name, package)| (name, package.application_ref()))
        .collect();
    // Caller-supplied package locators cannot substitute for actual build bytes.
    values.insert("packages".into(), serde_json::to_value(references)?);
    values
        .entry("hostDeployment")
        .or_insert_with(|| Value::String(uuid::Uuid::new_v4().to_string()));
    let vm = Vm::pure(Default::default())?;
    let result: Result<Value, HostError> =
        match vm.load("maka-product-authoring".into(), source.to_owned()) {
            Ok(module) => {
                let result = async {
                    {
                        // The ordinary authoring code supplies every installation
                        // identity, including configuration-dependent instances.
                        let names: Vec<String> = serde_json::from_value(
                            module
                                .call(
                                    vec!["installationNames".into()],
                                    vec![Value::Object(values.clone())],
                                )
                                .await?,
                        )?;
                        let keys = values
                            .entry("keys")
                            .or_insert_with(|| serde_json::json!({}))
                            .as_object_mut()
                            .ok_or("installation keys must be an object")?;
                        for name in names {
                            keys.entry(name)
                                .or_insert_with(|| Value::String(uuid::Uuid::new_v4().to_string()));
                        }
                    }
                    Ok(module
                        .call(
                            vec!["composition".into()],
                            vec![Value::Object(values.clone())],
                        )
                        .await?)
                }
                .await;
                let closed = module.close().await.map_err(HostError::from);
                result.and_then(|value| closed.map(|()| value))
            }
            Err(error) => Err(error.into()),
        };
    vm.shutdown().await;
    let sources: Sources = serde_json::from_value(result?)?;
    let checked: Vec<_> = packages.values().cloned().collect();
    let mut applications =
        maka_event_log::applications::prepare_applications(&[(&sources.host, &[])], &checked)?;
    let prepared = applications.pop().expect("one authored Host");
    if sources.deployment.is_nil() {
        return Err("Host deployment must not be nil".into());
    }
    maka_host_runtime::application::host::Configuration::PublicHost {
        endpoints: sources.endpoints.clone(),
        native: sources.native.clone(),
        product_methods: Default::default(),
    }
    .validate()?;
    values.remove("packages");
    Ok((sources, configuration, prepared))
}

async fn update_default_ui(
    input: &Input,
    packages: &BTreeMap<String, Package>,
) -> Result<Input, HostError> {
    let source = authoring()?;
    let vm = Vm::pure(Default::default())?;
    let result = match vm.load("maka-product-ui-update".into(), source) {
        Ok(module) => {
            let result = async {
                let names: Vec<String> = serde_json::from_value(
                    module
                        .call(
                            vec!["installationNames".into()],
                            vec![serde_json::json!({})],
                        )
                        .await?,
                )?;
                let keys: BTreeMap<_, _> = input
                    .instances
                    .keys()
                    .flat_map(|root| {
                        names
                            .iter()
                            .map(move |name| (format!("{root}/{name}"), uuid::Uuid::new_v4()))
                    })
                    .collect();
                let references: BTreeMap<_, _> = packages
                    .iter()
                    .map(|(name, package)| (name, package.application_ref()))
                    .collect();
                Ok::<Input, HostError>(serde_json::from_value(
                    module
                        .call(
                            vec!["updateDefaultUi".into()],
                            vec![
                                serde_json::to_value(input)?,
                                serde_json::to_value(references)?,
                                serde_json::to_value(keys)?,
                            ],
                        )
                        .await?,
                )?)
            }
            .await;
            let closed = module.close().await.map_err(HostError::from);
            result.and_then(|value| closed.map(|()| value))
        }
        Err(error) => Err(error.into()),
    };
    vm.shutdown().await;
    result
}

fn export(
    output: PathBuf,
    sources: Sources,
    installation: Value,
    packages: BTreeMap<String, Package>,
) -> Result<(), HostError> {
    let output = std::path::absolute(output)?;
    // All source validation precedes filesystem effects. Existing output,
    // including an empty directory or a symlink, is never replaced.
    std::fs::create_dir(&output)?;
    maka_event_log::root::private_directory(&output)?;
    let package_directory = output.join("packages");
    std::fs::create_dir(&package_directory)?;
    let mut references = BTreeMap::new();
    for (name, package) in packages {
        package.export_to(&package_directory.join(format!("{name}.maka-plugin")))?;
        references.insert(name, package.application_ref());
    }
    for (name, value) in [
        ("host", serde_json::to_value(sources.host)?),
        ("endpoints", serde_json::to_value(sources.endpoints)?),
        ("native-grants", serde_json::to_value(sources.native)?),
        ("packages", serde_json::to_value(references)?),
        ("installation", installation),
    ] {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output.join(format!("{name}.json")))?;
        serde_json::to_writer(&mut file, &value)?;
        file.write_all(b"\n")?;
    }
    Ok(())
}

async fn installation(options: Value) -> Result<Value, HostError> {
    installation_with_source(options, &authoring()?).await
}
async fn installation_with_source(options: Value, source: &str) -> Result<Value, HostError> {
    let vm = maka_js_runtime::plugin::Vm::pure(Default::default())?;
    let result = match vm.load("maka-product-installation".into(), source.to_owned()) {
        Ok(module) => {
            let result = module
                .call(vec!["installation".into()], vec![options])
                .await
                .map_err(HostError::from);
            let closed = module.close().await.map_err(HostError::from);
            result.and_then(|value| closed.map(|()| value))
        }
        Err(error) => Err(error.into()),
    };
    vm.shutdown().await;
    result
}
fn selected(
    input: &Input,
    observations: &[RemoteObservation],
    packages: &[Package],
) -> Result<Vec<Package>, HostError> {
    let mut declarations = maka_plugin_core::package::Packages::default();
    for package in packages {
        declarations.insert_checked(
            package.application_ref(),
            package
                .manifest()
                .application
                .as_ref()
                .ok_or("missing application declaration")?
                .clone(),
        )?;
    }
    let remote = observations
        .iter()
        .map(|observation| {
            (
                observation.capability.clone(),
                observation.declaration.clone(),
            )
        })
        .collect();
    let plan = maka_plugin_core::plan::Plan::prepare(input, &declarations, &remote)?;
    let required: std::collections::BTreeSet<_> = plan
        .instances()
        .values()
        .map(|instance| &instance.package)
        .collect();
    Ok(packages
        .iter()
        .filter(|package| required.contains(&package.application_ref()))
        .cloned()
        .collect())
}

#[cfg(test)]
mod tests;
