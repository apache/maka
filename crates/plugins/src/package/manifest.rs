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

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

use super::validate_path;
use crate::{Error, identifier};

pub const SDK_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VmMode {
    #[default]
    Shared,
    Dedicated,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u8,
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
    #[serde(default)]
    pub configuration: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<HostEntrypoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<ClientEntrypoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composition: Option<CompositionFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dependency {
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostEntrypoint {
    pub entry: String,
    pub sdk_version: u32,
    #[serde(default)]
    pub vm: VmMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientEntrypoint {
    pub entry: String,
    pub sdk_version: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompositionFile {
    pub patch: String,
    #[serde(default)]
    pub structural_dependencies: Vec<String>,
}

impl Manifest {
    pub fn validate(&self) -> Result<(), Error> {
        identifier(&self.id)?;
        if self.schema_version != 1 || (self.runtime.is_none() && self.client.is_none()) {
            return Err(Error::Invalid(
                "unsupported manifest version or missing entrypoints".into(),
            ));
        }
        if self.display_name.len() > 512 || self.description.len() > 4096 {
            return Err(Error::Invalid(
                "package description exceeds its limit".into(),
            ));
        }
        let mut dependencies = BTreeSet::new();
        for dependency in &self.dependencies {
            identifier(&dependency.id)?;
            if dependency.id == self.id || !dependencies.insert(&dependency.id) {
                return Err(Error::Invalid(
                    "cyclic or duplicate package dependency".into(),
                ));
            }
        }
        if let Some(entry) = &self.runtime {
            validate_path(&entry.entry)?;
            if entry.sdk_version == 0 {
                return Err(Error::Invalid("invalid Host SDK version".into()));
            }
        }
        if let Some(entry) = &self.client {
            validate_path(&entry.entry)?;
            if entry.sdk_version == 0 {
                return Err(Error::Invalid("invalid client SDK version".into()));
            }
        }
        if let Some(composition) = &self.composition {
            validate_path(&composition.patch)?;
            let mut dependencies = BTreeSet::new();
            for dependency in &composition.structural_dependencies {
                identifier(dependency)?;
                if dependency == &self.id || !dependencies.insert(dependency) {
                    return Err(Error::Invalid(
                        "cyclic or duplicate structural dependency".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn require_host_sdk(&self) -> Result<(), Error> {
        if self
            .runtime
            .as_ref()
            .is_some_and(|entry| entry.sdk_version != SDK_VERSION)
        {
            return Err(Error::Invalid(format!(
                "Host supports plugin SDK {SDK_VERSION}"
            )));
        }
        Ok(())
    }
}
