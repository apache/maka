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

//! Structured composition editing. Products define their own extension contracts.
use super::*;
use crate::composition::{PackageUse, Target};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BindingConsumer {
    Root { name: String },
    Package { package: PackageRef },
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingCandidatesRead {
    pub source: Option<DeploymentRef>,
    pub consumer: BindingConsumer,
    pub import: String,
    pub include_packages: bool,
    pub after: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BindingCandidate {
    Bound {
        key: String,
        label: String,
        #[serde(default)]
        presentation: crate::package::PackagePresentation,
        target: Target,
    },
    Package {
        key: String,
        label: String,
        #[serde(default)]
        presentation: crate::package::PackagePresentation,
        package: PackageRef,
        export: String,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingCandidatesPage {
    pub source: DeploymentRef,
    pub configuration: BTreeMap<String, serde_json::Value>,
    pub current: Vec<Target>,
    pub candidates: Vec<BindingCandidate>,
    pub next: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageSettingsRead {
    pub source: DeploymentRef,
    pub package: PackageRef,
    pub use_package: PackageUse,
    pub path: Vec<String>,
    pub after: Option<String>,
    pub changes: Vec<SettingChange>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageSettingsPage {
    pub source: DeploymentRef,
    pub package: PackageRef,
    pub path: Vec<String>,
    pub fields: Vec<SettingField>,
    pub next: Option<String>,
    pub imports: Vec<ManagedImport>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedImport {
    pub name: String,
    pub contract: String,
    pub cardinality: crate::contract::Cardinality,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompositionEdit {
    pub expected_revision: u64,
    pub edits: Vec<CompositionChange>,
}
/// One atomic patch to the original source, not a saved plan or draft registry.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CompositionChange {
    Insert {
        name: String,
        package: PackageRef,
        #[serde(rename = "usePackage")]
        use_package: PackageUse,
        settings: Vec<SettingChange>,
        bindings: BTreeMap<String, Vec<Target>>,
    },
    Update {
        name: String,
        configuration: BTreeMap<String, serde_json::Value>,
        bindings: BTreeMap<String, Vec<Target>>,
    },
    Remove {
        name: String,
    },
}
