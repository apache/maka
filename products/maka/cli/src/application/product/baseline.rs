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
//! Product-owned immutable defaults, separated from the deployment's user overrides.
use super::{HostError, Input, Package, Sources, author_with_source, installation_with_source};
use maka_host_runtime::DirectoryRootSpec;
use maka_plugin_core::composition::{RootComposition, Template};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};
use uuid::Uuid;

pub(super) const ID: &str = "maka.product.installation";
const METADATA: &str = "installation.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Environment {
    pub workspace: PathBuf,
    pub roots: Vec<DirectoryRootSpec>,
    pub home: Option<PathBuf>,
    pub helper: PathBuf,
    pub locale: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Metadata {
    pub release: String,
    pub environment: Environment,
    /// Logical product slots, independent of their current source aliases.
    pub identities: BTreeMap<String, Uuid>,
    // Observations of the product's publication defaults, never authority grants.
    pub endpoints: BTreeMap<String, maka_host_runtime::application::transport::HostEndpoint>,
    pub native: Vec<maka_host_runtime::application::transport::NativeGrant>,
}

pub(super) fn metadata(package: &Package) -> Result<Metadata, HostError> {
    if package.application_ref().id != ID {
        return Err("not a product baseline package".into());
    }
    Ok(serde_json::from_slice(
        package
            .files()
            .get(METADATA)
            .ok_or("product baseline is missing its generation inputs")?,
    )?)
}

#[cfg(test)]
pub(super) fn template(package: &Package) -> Result<&Template, HostError> {
    package
        .manifest()
        .application
        .as_ref()
        .and_then(|application| application.composition.as_ref())
        .ok_or_else(|| "product baseline must declare a composition".into())
}

#[cfg(test)]
pub(super) fn flat(package: &Package) -> Result<Input, HostError> {
    let template = template(package)?;
    Ok(Input {
        base: None,
        instances: template.children.clone(),
        ui: template.ui.clone(),
    })
}

pub(super) fn wrapped(package: &Package) -> Input {
    Input {
        base: Some(RootComposition {
            package: package.application_ref(),
            parameters: BTreeMap::new(),
            overrides: Vec::new(),
            ui: None,
        }),
        instances: BTreeMap::new(),
        ui: None,
    }
}

pub(super) async fn generate(
    environment: Environment,
    deployment: Uuid,
    keys: BTreeMap<String, Uuid>,
    packages: &BTreeMap<String, Package>,
    source: &str,
    release: &str,
) -> Result<(Sources, Package), HostError> {
    let mut configuration = installation_with_source(
        json!({
            "workspace": environment.workspace,
            "helper": environment.helper, "home": environment.home, "locale": environment.locale,
        }),
        source,
    )
    .await?;
    let roots = serde_json::to_value(&environment.roots)?;
    if let Some(agent) = configuration.get_mut("agent") {
        agent["workspaceRoots"] = roots.clone();
    }
    configuration["skills"]["projectRoots"] = roots;
    let rules = Value::Array(
        environment
            .roots
            .iter()
            .map(|root| {
                maka_fs_tools::workspace::project::host_path(&root.path)
                    .map(|path| json!({"path":path,"scope":"subtree","access":"write"}))
            })
            .collect::<Result<_, _>>()?,
    );
    if let Some(processes) = configuration.get_mut("processes") {
        processes["filesystem"]["rules"] = rules;
    }
    configuration["keys"] = serde_json::to_value(keys)?;
    configuration["hostDeployment"] = serde_json::to_value(deployment)?;
    let (mut sources, authored, _) = author_with_source(configuration, packages, source).await?;
    if sources.host.base.is_some() {
        return Err("product authoring must return a flat composition".into());
    }
    let template = Template {
        ui: sources.host.ui.clone(),
        parameters: BTreeMap::new(),
        imports: BTreeMap::new(),
        exports: BTreeMap::new(),
        children: sources.host.instances.clone(),
    };
    let package = Package::new(BTreeMap::from([
        (
            "maka.extension.json".into(),
            serde_json::to_vec(&json!({
                "schemaVersion":1, "id":ID, "displayName":"Maka installation baseline",
                "application":{"composition":template}
            }))?,
        ),
        (
            METADATA.into(),
            serde_json::to_vec(&Metadata {
                release: release.into(),
                environment,
                identities: serde_json::from_value(authored["keys"].clone())?,
                endpoints: sources.endpoints.clone(),
                native: sources.native.clone(),
            })?,
        ),
    ]))?;
    sources.host = wrapped(&package);
    Ok((sources, package))
}

pub(super) async fn rebase(
    input: &Input,
    installed: &[Package],
    bundled: &BTreeMap<String, Package>,
    deployment: Uuid,
    source: &str,
    release: &str,
) -> Result<Option<(Input, Package)>, HostError> {
    let Some(base) = &input.base else {
        return Ok(None);
    };
    if base.package.id != ID {
        return Ok(None);
    }
    let package = installed
        .iter()
        .find(|bytes| bytes.application_ref() == base.package)
        .ok_or("installed product baseline bytes missing")?;
    let metadata = metadata(package)?;
    if metadata.release == release && metadata.environment.helper == std::env::current_exe()? {
        return Ok(None);
    }
    let mut environment = metadata.environment;
    environment.helper = std::env::current_exe()?;
    let (_, package) = generate(
        environment,
        deployment,
        metadata.identities,
        bundled,
        source,
        release,
    )
    .await?;
    let mut next = input.clone();
    next.base.as_mut().unwrap().package = package.application_ref();
    Ok(Some((next, package)))
}

#[cfg(test)]
mod tests;
