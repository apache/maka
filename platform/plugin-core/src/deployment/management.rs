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

//! Same-Root deployment management contracts; metadata never grants access.
use crate::{
    composition::{Input, InstanceId},
    contract::{Contract, Interface, Method, MethodMode, Transport, binary_resource_type},
    deployment::{Deployment, DeploymentRef, RemoteObservation},
    package::PackageRef,
};
mod composition;
mod settings;
pub use composition::*;
pub use settings::*;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeploymentRead {}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageInstall {
    #[schemars(range(min = 1, max = 9_007_199_254_740_990_u64))]
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageUrlInstall {
    pub expected_revision: u64,
    pub url: String,
    /// Optional SHA-256 of the downloaded bundle bytes, from a trusted publisher.
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageInstalled {
    pub source: DeploymentRef,
    pub package: PackageRef,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentReplace {
    #[schemars(range(min = 1, max = 9_007_199_254_740_990_u64))]
    pub expected_revision: u64,
}

/// Source document edited by one native buffer, never a second desired plan.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentDocument {
    pub input: Input,
    pub remote_exports: Vec<RemoteObservation>,
    pub packages: Vec<PackageRef>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageSourceInstall {
    pub expected_revision: u64,
    /// UTF-8 package files, including maka.extension.json. Bytes determine identity.
    pub files: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageSourceRead {
    pub source: DeploymentRef,
    pub package: PackageRef,
    pub path: Option<String>,
    pub offset: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageSourceChunk {
    pub paths: Vec<String>,
    pub text: Option<String>,
    pub next: Option<usize>,
}

/// An immutable package from one committed revision, including binary files.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PackageBundleRead {
    pub source: DeploymentRef,
    pub package: PackageRef,
}

/// Bundle JSON already encodes file bytes; text chunks add no second base64 layer.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PackageBundleExport {
    Chunk {
        offset: usize,
        #[serde(rename = "totalBytes")]
        total_bytes: usize,
        #[schemars(length(max = 16384))]
        text: String,
    },
    Complete {},
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentSourceReplace {
    pub expected_revision: u64,
    pub document: DeploymentDocument,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeploymentDocumentRead {
    pub source: DeploymentRef,
    pub offset: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentDocumentChunk {
    pub source: DeploymentRef,
    pub offset: usize,
    pub total_bytes: usize,
    #[schemars(length(max = 65536))]
    pub text: String,
    pub next: Option<usize>,
}

/// A fixed committed source for continuation; no runtime or permission claim.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DeploymentInstances {
    Start {},
    Continue {
        source: DeploymentRef,
        after: Option<InstanceId>,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedInstance {
    pub instance: InstanceId,
    pub path: Vec<String>,
    pub package: PackageRef,
    #[serde(default)]
    pub presentation: crate::package::PackagePresentation,
    pub structural: bool,
    pub disabled: bool,
    pub parent_disabled: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedInstancesPage {
    pub source: DeploymentRef,
    #[schemars(length(max = 8))]
    pub instances: Vec<ManagedInstance>,
    pub next: Option<InstanceId>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceSetEnabled {
    #[schemars(range(min = 1, max = 9_007_199_254_740_990_u64))]
    pub expected_revision: u64,
    pub instance: InstanceId,
    pub enabled: bool,
}

/// Committed desired source and available immutable packages, not runtime readiness.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedDeployment {
    pub source: Deployment,
    pub packages: Vec<PackageRef>,
}

/// UI contributions derived from one committed deployment source.
#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiRead {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<DeploymentRef>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiWatch {
    pub source: DeploymentRef,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiInstance {
    pub instance: InstanceId,
    pub path: Vec<String>,
    pub package: PackageRef,
    pub configuration: serde_json::Value,
    pub module: String,
    #[serde(rename = "definitionBasis")]
    pub definition_basis: String,
    #[serde(rename = "bindingBasis")]
    pub binding_basis: String,
    pub imports: BTreeMap<String, usize>,
    pub contributions: BTreeMap<String, crate::package::UiContribution>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiCatalog {
    pub source: DeploymentRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<crate::plan::UiRoot>,
    pub instances: Vec<UiInstance>,
}

/// A deterministic refusal is a recorded business result. Uncertain SQL/worker
/// failures remain in the original operation journal's Unknown outcome.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "ManagementResultFor{T}")]
pub enum ManagementResult<T> {
    Committed {
        value: T,
    },
    Conflict {
        #[serde(rename = "currentRevision")]
        current_revision: u64,
    },
    Rejected {
        reason: ManagementRejection,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diagnostic: Option<String>,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ManagementRejection {
    InvalidBundle,
    DownloadFailed,
    InvalidDocument,
    InvalidSource,
    PackageUnavailable,
    InstanceUnavailable,
    ParentDisabled,
}

pub fn deployment_manager_contract() -> Contract {
    fn method<I: JsonSchema, O: JsonSchema>(mode: MethodMode) -> Method {
        Method {
            progress: None,
            mode,
            input: serde_json::to_value(schemars::schema_for!(I))
                .expect("management input schema")
                .into(),
            output: serde_json::to_value(schemars::schema_for!(O))
                .expect("management output schema")
                .into(),
            resources: BTreeMap::new(),
        }
    }
    let mut install =
        method::<PackageInstall, ManagementResult<PackageInstalled>>(MethodMode::Mutation);
    install
        .resources
        .insert("package".into(), binary_resource_type().required());
    let mut replace =
        method::<DeploymentReplace, ManagementResult<DeploymentRef>>(MethodMode::Mutation);
    replace.resources.insert(
        "document".into(),
        crate::contract::text_resource_type().required(),
    );
    // Optional JSON array of existing package bundle objects. The document's
    // package references select the exact resulting set in the same CAS commit.
    replace
        .resources
        .insert("packages".into(), binary_resource_type().optional());
    Contract {
        name: "maka.application.DeploymentManager".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "read".into(),
                    method::<DeploymentRead, ManagedDeployment>(MethodMode::Query),
                ),
                (
                    "readUi".into(),
                    method::<UiRead, UiCatalog>(MethodMode::Query),
                ),
                (
                    "watch".into(),
                    method::<UiWatch, DeploymentRef>(MethodMode::Subscription),
                ),
                ("install".into(), install),
                (
                    "installUrl".into(),
                    method::<PackageUrlInstall, ManagementResult<PackageInstalled>>(
                        MethodMode::Mutation,
                    ),
                ),
                (
                    "installSource".into(),
                    method::<PackageSourceInstall, ManagementResult<PackageInstalled>>(
                        MethodMode::Mutation,
                    ),
                ),
                (
                    "readPackage".into(),
                    method::<PackageSourceRead, PackageSourceChunk>(MethodMode::Query),
                ),
                (
                    "exportPackage".into(),
                    method::<PackageBundleRead, PackageBundleExport>(MethodMode::Subscription),
                ),
                (
                    "replaceSource".into(),
                    method::<DeploymentSourceReplace, ManagementResult<DeploymentRef>>(
                        MethodMode::Mutation,
                    ),
                ),
                (
                    "bindingCandidates".into(),
                    method::<BindingCandidatesRead, BindingCandidatesPage>(MethodMode::Query),
                ),
                (
                    "packageSettings".into(),
                    method::<PackageSettingsRead, PackageSettingsPage>(MethodMode::Query),
                ),
                (
                    "editComposition".into(),
                    method::<CompositionEdit, ManagementResult<DeploymentRef>>(
                        MethodMode::Mutation,
                    ),
                ),
                (
                    "readSettings".into(),
                    method::<InstanceSettingsRead, InstanceSettingsPage>(MethodMode::Query),
                ),
                (
                    "configure".into(),
                    method::<InstanceConfigure, ManagementResult<DeploymentRef>>(
                        MethodMode::Mutation,
                    ),
                ),
                (
                    "readDocument".into(),
                    method::<DeploymentDocumentRead, DeploymentDocumentChunk>(MethodMode::Query),
                ),
                (
                    "instances".into(),
                    method::<DeploymentInstances, ManagedInstancesPage>(MethodMode::Query),
                ),
                (
                    "setEnabled".into(),
                    method::<InstanceSetEnabled, ManagementResult<DeploymentRef>>(
                        MethodMode::Mutation,
                    ),
                ),
                ("replace".into(), replace),
            ]),
        },
    }
}
