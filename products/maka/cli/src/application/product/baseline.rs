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
use maka_plugin_core::composition::{ConfigurationField, Override, RootComposition, Template};
use maka_plugin_core::package::PackageSelection;
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

pub(super) fn template(package: &Package) -> Result<&Template, HostError> {
    package
        .manifest()
        .application
        .as_ref()
        .and_then(|application| application.composition.as_ref())
        .ok_or_else(|| "product baseline must declare a composition".into())
}

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
    for name in ["agent", "coordinator"] {
        if let Some(agent) = configuration.get_mut(name) {
            agent["workspaceRoots"] = roots.clone();
        }
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
    for name in ["processes", "coordinatorProcesses"] {
        if let Some(processes) = configuration.get_mut(name) {
            processes["filesystem"]["rules"] = rules.clone();
        }
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

pub(super) fn keys(input: &Input) -> BTreeMap<String, Uuid> {
    input
        .instances
        .iter()
        .map(|(name, node)| (name.clone(), node.key))
        .collect()
}

fn differences(
    old: Option<&Value>,
    current: Option<&Value>,
    next: Option<&Value>,
    path: &mut Vec<String>,
    fields: &mut Vec<ConfigurationField>,
) {
    if current == old || current == next {
        return;
    }
    if let Some(Value::Object(object)) = current {
        if matches!(next, Some(Value::Object(_))) {
            let keys: std::collections::BTreeSet<_> = object
                .keys()
                .chain(
                    old.and_then(Value::as_object)
                        .into_iter()
                        .flat_map(|object| object.keys()),
                )
                .collect();
            for key in keys {
                path.push(key.clone());
                differences(
                    old.and_then(|value| value.get(key)),
                    object.get(key),
                    next.and_then(|value| value.get(key)),
                    path,
                    fields,
                );
                path.pop();
            }
            return;
        }
    }
    fields.push(ConfigurationField {
        path: path.clone(),
        value: current.cloned(),
    });
}

fn same_family(left: &PackageSelection, right: &PackageSelection) -> bool {
    match (left, right) {
        (
            PackageSelection::Pinned { package: left },
            PackageSelection::Pinned { package: right },
        ) => left.id == right.id,
        (PackageSelection::Current, PackageSelection::Current) => true,
        _ => false,
    }
}

// Only initial migration needs a three-way comparison. Once a source selects a
// baseline, the overrides themselves are its durable, explicit user intent.
pub(super) fn migrate(
    original: &Input,
    current: &Input,
    next: &Package,
) -> Result<Input, HostError> {
    let defaults = flat(next)?;
    let mut result = wrapped(next);
    for (name, before) in &original.instances {
        let Some(default) = defaults.instances.get(name) else {
            // Keep an independently changed retired component instead of dropping it.
            if let Some((alias, node)) = current
                .instances
                .iter()
                .find(|(_, node)| node.key == before.key)
                && node != before
            {
                result.instances.insert(alias.clone(), node.clone());
            }
            continue;
        };
        let now = current
            .instances
            .iter()
            .find(|(_, node)| node.key == before.key);
        if now.is_none_or(|(alias, node)| {
            alias != name
                || !same_family(&node.package, &before.package)
                || node.use_package != before.use_package
        }) {
            result.base.as_mut().unwrap().overrides.push(Override {
                path: vec![name.clone()],
                remove: true,
                ..Override::default()
            });
            if let Some((alias, node)) = now {
                result.instances.insert(alias.clone(), node.clone());
            }
            continue;
        }
        let now = now.unwrap().1;
        let mut patch = Override {
            path: vec![name.clone()],
            ..Override::default()
        };
        // Same-family historical pins followed product releases. Component
        // substitutions above are independent, complete user-selected roots.
        let before_values = serde_json::to_value(&before.configuration.values)?;
        let now_values = serde_json::to_value(&now.configuration.values)?;
        let default_values = serde_json::to_value(&default.configuration.values)?;
        differences(
            Some(&before_values),
            Some(&now_values),
            Some(&default_values),
            &mut Vec::new(),
            &mut patch.configuration_fields,
        );
        for (key, value) in &now.parameters.values {
            if before.parameters.values.get(key) != Some(value)
                && default.parameters.values.get(key) != Some(value)
            {
                patch.parameters.insert(key.clone(), value.clone());
            }
        }
        for key in before.bindings.keys().chain(now.bindings.keys()) {
            let old = before.bindings.get(key);
            let value = now.bindings.get(key);
            if value != old && value != default.bindings.get(key) {
                patch
                    .bindings
                    .insert(key.clone(), value.cloned().unwrap_or_default());
            }
        }
        if now.disabled != before.disabled && now.disabled != default.disabled {
            patch.disabled = Some(now.disabled);
        }
        if patch
            != (Override {
                path: vec![name.clone()],
                ..Override::default()
            })
        {
            result.base.as_mut().unwrap().overrides.push(patch);
        }
        for nested in &now.overrides {
            if !before.overrides.contains(nested) && !default.overrides.contains(nested) {
                let mut nested = nested.clone();
                nested.path.insert(0, name.clone());
                result.base.as_mut().unwrap().overrides.push(nested);
            }
        }
    }
    for (name, node) in &current.instances {
        if original.instances.values().any(|old| old.key == node.key) {
            continue;
        }
        if let Some(default) = defaults.instances.get(name) {
            if default.key == node.key
                && same_family(&default.package, &node.package)
                && default.use_package == node.use_package
            {
                let mut patch = Override {
                    path: vec![name.clone()],
                    ..Override::default()
                };
                let values = serde_json::to_value(&node.configuration.values)?;
                let defaults = serde_json::to_value(&default.configuration.values)?;
                differences(
                    None,
                    Some(&values),
                    Some(&defaults),
                    &mut Vec::new(),
                    &mut patch.configuration_fields,
                );
                for (key, targets) in &node.bindings {
                    if default.bindings.get(key) != Some(targets) {
                        patch.bindings.insert(key.clone(), targets.clone());
                    }
                }
                if node.disabled != default.disabled {
                    patch.disabled = Some(node.disabled);
                }
                if patch
                    != (Override {
                        path: vec![name.clone()],
                        ..Override::default()
                    })
                {
                    result.base.as_mut().unwrap().overrides.push(patch);
                }
                continue;
            }
        }
        result.instances.insert(name.clone(), node.clone());
    }
    if current.ui != original.ui && current.ui != defaults.ui {
        match &current.ui {
            Some(ui) => result.ui = Some(ui.clone()),
            None => result.base.as_mut().unwrap().ui = Some(None),
        }
    }
    Ok(result)
}

pub(super) fn product_owned(configuration: &Value) -> bool {
    configuration
        .get("productMethods")
        .and_then(Value::as_array)
        .is_some_and(|methods| {
            methods
                .iter()
                .any(|name| name == "agent" || name == "coordinator")
        })
}

pub(super) async fn rebase(
    input: &Input,
    installed: &[Package],
    original: Option<&Input>,
    bundled: &BTreeMap<String, Package>,
    deployment: Uuid,
    source: &str,
    release: &str,
) -> Result<Option<(Input, Package)>, HostError> {
    let (mut environment, keys, legacy) = if let Some(base) = &input.base {
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
        (metadata.environment, metadata.identities, false)
    } else {
        let Some(original) = original else {
            return Ok(None);
        };
        // Removing a baseline from an installation that already had one is an
        // explicit source edit, not an old installation awaiting migration.
        if original.base.is_some() {
            return Ok(None);
        }
        let agent = original
            .instances
            .get("agent")
            .ok_or("legacy product Agent missing")?;
        if !matches!(&agent.package, PackageSelection::Pinned { package }
            if Some(&package.id) == bundled.get("agent").map(|bytes| &bytes.manifest().id))
        {
            return Err("legacy product baseline no longer identifies the original Agent".into());
        }
        let values = &agent.configuration.values;
        let roots: Vec<DirectoryRootSpec> = serde_json::from_value(
            values
                .get("workspaceRoots")
                .cloned()
                .ok_or("legacy product workspaces missing")?,
        )?;
        let home = values
            .get("assistant")
            .and_then(|value| value.get("home"))
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()?;
        let workspace = roots
            .first()
            .map(|root| root.path.clone())
            .or_else(|| home.clone())
            .or_else(|| {
                values
                    .get("importRoots")
                    .and_then(Value::as_array)
                    .and_then(|roots| roots.first())
                    .and_then(|root| root.get("path"))
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
            })
            .ok_or("legacy generation workspace missing")?;
        let locale = values
            .get("locale")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .into();
        let mut identities = keys(original);
        for (name, key) in keys(input) {
            identities.entry(name).or_insert(key);
        }
        (
            Environment {
                workspace,
                roots,
                home,
                helper: std::env::current_exe()?,
                locale,
            },
            identities,
            true,
        )
    };
    environment.helper = std::env::current_exe()?;
    let (_, package) = generate(environment, deployment, keys, bundled, source, release).await?;
    let next = if legacy {
        migrate(original.unwrap(), input, &package)?
    } else {
        let mut next = input.clone();
        next.base.as_mut().unwrap().package = package.application_ref();
        next
    };
    Ok(Some((next, package)))
}

#[cfg(test)]
mod tests;
