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

//! Bounded form projections. Numeric values stay decimal text across JavaScript.
use super::*;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceSettingsRead {
    pub source: DeploymentRef,
    pub instance: InstanceId,
    pub path: Vec<String>,
    pub after: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceSettingsPage {
    pub source: DeploymentRef,
    pub instance: InstanceId,
    pub path: Vec<String>,
    #[schemars(length(max = 8))]
    pub fields: Vec<SettingField>,
    pub next: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingField {
    pub key: String,
    pub label: String,
    pub description: String,
    pub kind: SettingKind,
    pub present: bool,
    pub required: bool,
    pub nullable: bool,
    pub editable: bool,
    pub value: Option<SettingValue>,
    pub options: Vec<SettingValue>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingKind {
    Text,
    Number,
    Boolean,
    Object,
    Array,
    Null,
    Unsupported,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SettingValue {
    Text { text: String },
    Number { text: String },
    Boolean { value: bool },
    Null,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceConfigure {
    #[schemars(range(min = 1, max = 9_007_199_254_740_990_u64))]
    pub expected_revision: u64,
    pub instance: InstanceId,
    #[schemars(length(min = 1))]
    pub changes: Vec<SettingChange>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceConfigureBatch {
    #[schemars(range(min = 1, max = 9_007_199_254_740_990_u64))]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub edits: Vec<InstanceConfigureEdit>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstanceConfigureEdit {
    pub instance: InstanceId,
    #[schemars(length(min = 1))]
    pub changes: Vec<SettingChange>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SettingChange {
    #[schemars(length(min = 1))]
    pub path: Vec<String>,
    /// None removes the field; all other fields retain their original source.
    pub value: Option<SettingValue>,
}
