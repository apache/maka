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

use maka_event_log::{RootStore, StoreError, applications::PreparedApplication};
use maka_host_runtime::DirectoryRootSpec;
use maka_packages::Package;
use maka_plugin_core::{
    composition::{Input, PackageUse},
    deployment::{
        DeploymentRef,
        management::{ManagementRejection, ManagementResult},
    },
    package::{Implementation, PackageSelection},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    pub agent: String,
    pub skills: Option<String>,
    pub processes: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SettingsWorkspaceLocationsRead")]
pub struct Read {}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsWorkspaceLocations")]
pub struct Snapshot {
    pub source: DeploymentRef,
    pub roots: Vec<DirectoryRootSpec>,
}

impl Snapshot {
    fn new(source: DeploymentRef, mut roots: Vec<DirectoryRootSpec>) -> Result<Self, String> {
        for root in &mut roots {
            root.path = maka_fs_tools::workspace::project::host_path(&root.path)
                .map_err(|error| error.to_string())?
                .into();
        }
        Ok(Self { source, roots })
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsWorkspaceLocationsUpdate")]
pub struct Update {
    pub source: DeploymentRef,
    pub roots: Vec<DirectoryRootSpec>,
}

pub fn configuration_values<'a>(
    input: &'a mut Input,
    packages: &[Package],
    name: &str,
    expected: &str,
) -> Option<&'a mut BTreeMap<String, Value>> {
    let node = input.instances.get_mut(name)?;
    let PackageSelection::Pinned { package } = &node.package else {
        return None;
    };
    let native = packages
        .iter()
        .find(|bytes| bytes.application_ref() == *package)
        .and_then(|bytes| bytes.manifest().application.as_ref())
        .and_then(|declaration| declaration.host.as_ref());
    if node.use_package != PackageUse::Host
        || !node.configuration.parameters.is_empty()
        || !matches!(native, Some(entry) if matches!(&entry.implementation,
            Implementation::Native { implementation } if implementation == expected))
    {
        return None;
    }
    Some(&mut node.configuration.values)
}

pub fn replace(
    input: &mut Input,
    packages: &[Package],
    targets: &Configuration,
    roots: &[DirectoryRootSpec],
) -> Result<(), String> {
    let agent = configuration_values(
        input,
        packages,
        &targets.agent,
        maka_agent_api::IMPLEMENTATION,
    )
    .ok_or("Workspace locations require the configured native Agent.")?;
    let previous: Vec<DirectoryRootSpec> = serde_json::from_value(
        agent
            .get("workspaceRoots")
            .cloned()
            .ok_or("Workspace locations are missing.")?,
    )
    .map_err(|error| error.to_string())?;
    let value = serde_json::to_value(roots).map_err(|error| error.to_string())?;
    agent.insert("workspaceRoots".into(), value.clone());
    if let Some(name) = &targets.skills {
        configuration_values(input, packages, name, maka_skills_api::IMPLEMENTATION)
            .ok_or("Workspace locations require the configured native skills service.")?
            .insert("projectRoots".into(), value);
    }
    if let Some(name) = &targets.processes {
        let previous_paths = previous
            .iter()
            .map(|root| {
                maka_fs_tools::workspace::project::host_path(&root.path)
                    .map(|path| Value::String(path.into()))
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let filesystem = configuration_values(
            input,
            packages,
            name,
            maka_workspace_api::processes::IMPLEMENTATION,
        )
        .and_then(|values| values.get_mut("filesystem"))
        .and_then(Value::as_object_mut)
        .ok_or("The configured command filesystem policy is unavailable.")?;
        let rules = filesystem
            .get_mut("rules")
            .and_then(Value::as_array_mut)
            .ok_or("The configured command filesystem rules are unavailable.")?;
        rules.retain(|rule| {
            !(rule["scope"] == "subtree"
                && rule["access"] == "write"
                && (previous_paths.contains(&rule["path"])
                    || previous.iter().any(|root| {
                        serde_json::to_value(&root.path).ok().as_ref() == Some(&rule["path"])
                    })))
        });
        for root in roots {
            let path = Value::String(
                maka_fs_tools::workspace::project::host_path(&root.path)
                    .map_err(|error| error.to_string())?
                    .into(),
            );
            if !rules.iter().any(|rule| rule["path"] == path) {
                rules.push(serde_json::json!({"path":path,"scope":"subtree","access":"write"}));
            }
        }
    }
    Ok(())
}

pub(crate) async fn read(
    store: &RootStore,
    source: &DeploymentRef,
    targets: Option<&Configuration>,
    input: Value,
) -> Result<Value, String> {
    let _: Read = serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    let Some(targets) = targets else {
        return Ok(Value::Null);
    };
    let metadata = store
        .read_application_metadata(source.deployment)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Workspace configuration is unavailable.")?;
    let roots = metadata
        .source
        .input
        .instances
        .get(&targets.agent)
        .and_then(|node| node.configuration.values.get("workspaceRoots"))
        .ok_or("Workspace locations are unavailable.")?;
    let roots = serde_json::from_value(roots.clone()).map_err(|error| error.to_string())?;
    super::connections::encode(Snapshot::new(metadata.source.reference, roots)?)
}

pub(crate) async fn update(
    store: &RootStore,
    source: &DeploymentRef,
    targets: Option<&Configuration>,
    input: Value,
) -> Result<Value, String> {
    let input: Update = serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    let rejected = |diagnostic: String| ManagementResult::<Snapshot>::Rejected {
        reason: ManagementRejection::InvalidSource,
        diagnostic: Some(diagnostic),
    };
    let Some(targets) = targets else {
        return super::connections::encode(rejected(
            "This Host does not manage workspace locations.".into(),
        ));
    };
    if input.source.state_domain != source.state_domain
        || input.source.deployment != source.deployment
    {
        return super::connections::encode(rejected(
            "Workspace settings belong to another Host.".into(),
        ));
    }
    let metadata = store
        .read_application_metadata(source.deployment)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Workspace configuration is unavailable.")?;
    if metadata.source.reference != input.source {
        return super::connections::encode(ManagementResult::<Snapshot>::Conflict {
            current_revision: metadata.source.reference.revision,
        });
    }
    let roots = match tokio::task::spawn_blocking(move || DirectoryRootSpec::normalize(input.roots))
        .await
        .map_err(|error| error.to_string())?
    {
        Ok(roots) => roots,
        Err(error) => return super::connections::encode(rejected(error.to_string())),
    };
    let managed = store
        .owned_root()
        .map_err(|error| error.to_string())?
        .canonical_path()
        .join("subagent-worktrees");
    if roots.iter().any(|root| root.path.starts_with(&managed)) {
        return super::connections::encode(rejected(
            "Managed worktrees cannot be published as workspace locations.".into(),
        ));
    }
    let loaded = store
        .load_application_at(&input.source)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Workspace configuration is unavailable.")?;
    let (mut current, packages, _, _) = loaded.into_parts();
    if let Err(error) = replace(&mut current.input, &packages, targets, &roots) {
        return super::connections::encode(rejected(error));
    }
    let prepared = match tokio::task::spawn_blocking(move || {
        PreparedApplication::new(current.input, current.remote_exports, packages)
    })
    .await
    .map_err(|error| error.to_string())?
    {
        Ok(prepared) => prepared,
        Err(error) => return super::connections::encode(rejected(error.to_string())),
    };
    match store
        .commit_prepared_application(source.deployment, input.source.revision, prepared)
        .await
    {
        Ok(loaded) => super::connections::encode(ManagementResult::Committed {
            value: Snapshot::new(loaded.source().reference.clone(), roots)?,
        }),
        Err(StoreError::RevisionConflict { actual, .. }) => {
            super::connections::encode(ManagementResult::<Snapshot>::Conflict {
                current_revision: actual.parse().map_err(|_| "invalid workspace revision")?,
            })
        }
        Err(error) => Err(error.to_string()),
    }
}
