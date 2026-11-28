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

use super::{Owner, SubscriptionEvent, execute};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use maka_packages::Package;
use maka_plugin_core::{
    composition::InstanceId,
    deployment::{
        DeploymentRef,
        management::{PackageBundleExport, UiCatalog, UiInstance},
    },
    package::PackageRef,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
use tokio::sync::OnceCell;

const URI_COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

#[derive(Default)]
pub(super) struct Packages(Mutex<State>);

#[derive(Clone, Default)]
struct CachedAssets {
    files: Arc<BTreeMap<String, Vec<u8>>>,
}

impl CachedAssets {
    fn from_package(package: &Package) -> Self {
        let mut skipped = BTreeSet::from([maka_packages::MANIFEST_FILE]);
        if let Some(application) = package.manifest().application.as_ref() {
            if let Some(ui) = application.ui.as_ref() {
                skipped.insert(ui.module.as_str());
            }
            if let Some(host) = application.host.as_ref()
                && let maka_plugin_core::package::Implementation::JavaScript { module, .. } =
                    &host.implementation
            {
                skipped.insert(module.as_str());
            }
        }
        let files = package
            .files()
            .iter()
            .filter(|(path, _)| !skipped.contains(path.as_str()))
            .map(|(path, bytes)| (path.clone(), bytes.clone()))
            .collect();
        Self {
            files: Arc::new(files),
        }
    }

    fn get(&self, path: &str) -> Option<&[u8]> {
        self.files.get(path).map(Vec::as_slice)
    }
}

#[derive(Default)]
struct State {
    source: Option<DeploymentRef>,
    modules: BTreeMap<String, Module>,
    instances: BTreeMap<InstanceId, Arc<UiInstance>>,
    packages: BTreeMap<PackageRef, Arc<OnceCell<CachedAssets>>>,
}

#[derive(Clone)]
struct Module {
    source: DeploymentRef,
    package: PackageRef,
    path: String,
}

impl Packages {
    pub(super) fn observe(&self, catalog: UiCatalog) {
        let mut packages = BTreeSet::new();
        let instances: BTreeMap<_, _> = catalog
            .instances
            .into_iter()
            .map(|instance| (instance.instance.clone(), Arc::new(instance)))
            .collect();
        let modules = instances
            .values()
            .map(|instance| {
                let id = module_id(&instance.package);
                packages.insert(instance.package.clone());
                (
                    id,
                    Module {
                        source: catalog.source.clone(),
                        package: instance.package.clone(),
                        path: instance.module.clone(),
                    },
                )
            })
            .collect();
        let mut state = self.0.lock().unwrap();
        if state
            .source
            .as_ref()
            .is_some_and(|source| source.revision > catalog.source.revision)
        {
            return;
        }
        state.modules = modules;
        state.instances = instances;
        state
            .packages
            .retain(|package, _| packages.contains(package));
        state.source = Some(catalog.source);
    }

    pub(super) fn current_ui(
        &self,
        instance: &InstanceId,
    ) -> Option<(DeploymentRef, Arc<UiInstance>)> {
        let state = self.0.lock().unwrap();
        Some((
            state.source.as_ref()?.clone(),
            state.instances.get(instance)?.clone(),
        ))
    }

    fn module(&self, id: &str) -> Option<Module> {
        self.0.lock().unwrap().modules.get(id).cloned()
    }

    fn entry(&self, package: &PackageRef) -> Arc<OnceCell<CachedAssets>> {
        let mut state = self.0.lock().unwrap();
        // A late asset read may outlive its module without retaining its package.
        if !state.modules.contains_key(&module_id(package)) {
            return Arc::default();
        }
        state.packages.entry(package.clone()).or_default().clone()
    }

    fn cached_assets(&self, package: &PackageRef) -> Option<CachedAssets> {
        self.0.lock().unwrap().packages.get(package)?.get().cloned()
    }
}

fn module_id(package: &PackageRef) -> String {
    format!(
        "maka-ui-{}.js",
        package.revision.trim_start_matches("sha256-")
    )
}

pub(super) struct Loader(pub(super) Arc<Owner>);

impl nsh_engine::ChunkLoader for Loader {
    fn load(&self, id: &str) -> nsh_engine::ChunkLoad {
        if id == crate::MERMAID_CHUNK_ID {
            return Box::pin(async move {
                Ok(nsh_engine::ChunkSource::new(crate::mermaid_chunk_source()))
            });
        }
        let owner = self.0.clone();
        let id = id.to_owned();
        Box::pin(async move {
            execute(owner.clone(), async move {
                let module = owner
                    .plugins
                    .module(&id)
                    .ok_or_else(|| format!("UI module is no longer enabled: {id}"))?;
                let package = fetch_package(&owner, &module.source, &module.package).await?;
                let _ = owner
                    .plugins
                    .entry(&module.package)
                    .set(CachedAssets::from_package(&package));
                let bytes = package
                    .file(&module.path)
                    .ok_or_else(|| format!("UI module is missing: {}", module.path))?;
                let code = String::from_utf8(bytes.to_vec())
                    .map_err(|error| format!("UI module is not UTF-8: {error}"))?;
                Ok(nsh_engine::ChunkSource::new(code).with_asset_base(asset_base(&module)?))
            })
            .await
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    source: DeploymentRef,
    package: PackageRef,
}

fn asset_base(module: &Module) -> Result<String, String> {
    let selector = serde_json::to_vec(&Asset {
        source: module.source.clone(),
        package: module.package.clone(),
    })
    .map_err(|error| error.to_string())?;
    // Keep the package identity in one valid bundled-asset path segment.
    let selector = URL_SAFE_NO_PAD.encode(selector);
    let directory = module
        .path
        .rsplit_once('/')
        .map(|(directory, _)| directory)
        .unwrap_or("");
    let directory = directory
        .split('/')
        .filter(|part| !part.is_empty())
        .map(|part| percent_encoding::utf8_percent_encode(part, URI_COMPONENT).to_string())
        .collect::<Vec<_>>()
        .join("/");
    Ok(if directory.is_empty() {
        format!("asset:/plugin/{selector}/")
    } else {
        format!("asset:/plugin/{selector}/{directory}/")
    })
}

pub(super) fn asset(owner: &Arc<Owner>, encoded: &str) -> Result<Vec<u8>, String> {
    let (selector, path) = encoded.split_once('/').ok_or("Plugin asset has no path")?;
    let decoded = URL_SAFE_NO_PAD
        .decode(selector)
        .map_err(|error| error.to_string())?;
    let asset: Asset = serde_json::from_slice(&decoded).map_err(|error| error.to_string())?;
    let path = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .map_err(|error| error.to_string())?
        .into_owned();
    maka_packages::validate_path(&path).map_err(|error| error.to_string())?;
    if let Some(assets) = owner.plugins.cached_assets(&asset.package) {
        return assets
            .get(&path)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| format!("Plugin asset is missing: {path}"));
    }
    let owner = owner.clone();
    owner
        .runtime
        .clone()
        .block_on(execute(owner.clone(), async move {
            let assets = load_assets(&owner, &asset.source, &asset.package).await?;
            assets
                .get(&path)
                .map(<[u8]>::to_vec)
                .ok_or_else(|| format!("Plugin asset is missing: {path}"))
        }))
}

async fn load_assets(
    owner: &Arc<Owner>,
    source: &DeploymentRef,
    reference: &PackageRef,
) -> Result<CachedAssets, String> {
    let entry = owner.plugins.entry(reference);
    entry
        .get_or_try_init(|| async {
            let package = fetch_package(owner, source, reference).await?;
            Ok(CachedAssets::from_package(&package))
        })
        .await
        .cloned()
}

async fn fetch_package(
    owner: &Arc<Owner>,
    source: &DeploymentRef,
    reference: &PackageRef,
) -> Result<Package, String> {
    let stream = owner
        .client
        .subscribe(
            "management",
            "exportPackage",
            json!({"source":source,"package":reference}),
        )
        .await?;
    let read = async {
        let mut bytes = Vec::new();
        let mut length = None;
        loop {
            match stream.next().await? {
                Some(SubscriptionEvent::Item(value)) => {
                    let PackageBundleExport::Chunk {
                        offset,
                        total_bytes,
                        text,
                    } = serde_json::from_value(value).map_err(|error| error.to_string())?
                    else {
                        return Err("Package export ended in a data frame".into());
                    };
                    if offset != bytes.len() || length.is_some_and(|length| length != total_bytes) {
                        return Err("Package export changed its original position or length".into());
                    }
                    if length.is_none() {
                        bytes
                            .try_reserve(total_bytes)
                            .map_err(|error| error.to_string())?;
                        length = Some(total_bytes);
                    }
                    bytes.extend_from_slice(text.as_bytes());
                }
                Some(SubscriptionEvent::Finished(value)) => {
                    if !matches!(
                        serde_json::from_value::<PackageBundleExport>(value)
                            .map_err(|error| error.to_string())?,
                        PackageBundleExport::Complete {}
                    ) || length != Some(bytes.len())
                    {
                        return Err("Package export ended before its complete contents".into());
                    }
                    return Ok(bytes);
                }
                None => return Err("Package export closed before completion".into()),
            }
        }
    }
    .await;
    let closed = stream.close().await;
    let bytes = match (read, closed) {
        (Ok(bytes), Ok(())) => bytes,
        (Err(error), Ok(())) | (Ok(_), Err(error)) => return Err(error),
        (Err(error), Err(close)) => {
            return Err(format!("{error}; package export cleanup: {close}"));
        }
    };
    let package = tokio::task::spawn_blocking(move || Package::from_bundle(&bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    if &package.application_ref() != reference {
        return Err("Plugin package does not match its requested immutable identity".into());
    }
    Ok(package)
}

#[cfg(test)]
mod asset_url_tests {
    use super::*;

    #[test]
    fn imported_plugin_image_is_a_valid_bundled_asset() {
        let module = Module {
            source: serde_json::from_value(json!({
                "stateDomain": "1ed344c4ccf82403a883813a21f3241b087fc867e8312ca24088fe6b24647316",
                "deployment": "b0684512-e9cb-4806-8bf9-10480786b142",
                "revision": 7
            }))
            .unwrap(),
            package: serde_json::from_value(json!({
                "id": "maka.composer",
                "revision": format!("sha256-{}", "a".repeat(64))
            }))
            .unwrap(),
            path: "ui/index.js".into(),
        };
        let uri = format!(
            "{}products/maka/workbench/app/assets/maka.png",
            asset_base(&module).unwrap()
        );
        assert!(nsh_core::access::is_inside_assets(&uri));
    }

    #[test]
    fn cached_assets_keeps_icons_and_drops_manifest_and_script_entries() {
        let manifest = json!({
            "schemaVersion": 1,
            "id": "example.ui",
            "application": {
                "ui": {
                    "module": "ui/index.js",
                    "configuration": { "type": "object" },
                    "contributions": { "root": { "kind": "root" } }
                }
            }
        });
        let package = Package::new(BTreeMap::from([
            (
                maka_packages::MANIFEST_FILE.into(),
                serde_json::to_vec(&manifest).unwrap(),
            ),
            (
                "ui/index.js".into(),
                b"export default function() {}".to_vec(),
            ),
            ("assets/icon.svg".into(), b"<svg/>".to_vec()),
        ]))
        .unwrap();
        let cached = CachedAssets::from_package(&package);
        assert!(cached.get(maka_packages::MANIFEST_FILE).is_none());
        assert!(cached.get("ui/index.js").is_none());
        assert_eq!(cached.get("assets/icon.svg"), Some(b"<svg/>".as_slice()));
    }
}
