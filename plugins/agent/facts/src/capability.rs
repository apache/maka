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

mod contract;
pub mod form;
pub mod form_decode;
pub(crate) mod form_result_decode;
mod form_validation;
pub mod json;
pub use contract::ContractId;
mod composition;
pub use composition::{ClientComposition, ClientOffer, PinnedAffinity, PublicationIdentity};
mod identity;
pub use identity::{Identity, PrincipalKind};
mod result;
pub use form::{
    FormField, FormFieldSpec, FormFormat, FormInput, FormOption, FormRequester, FormResult,
    FormValue,
};
pub use result::{CallResult, ContentBlock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub offer_id: String,
    pub version: String,
    pub affinity: Affinity,
    pub host_path_access: HostPathAccess,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admission: Option<Admission>,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub tools: Vec<ToolDescriptor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Admission {
    Mcp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Affinity {
    Call,
    Turn,
    Session,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostPathAccess {
    None,
    Cwd,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub server_id: String,
    pub name: String,
    pub input_schema: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<ToolAnnotations>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_kind: Option<ToolActivityKind>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotations {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_world_hint: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolActivityKind {
    Computer,
    Read,
    Search,
    #[serde(rename = "websearch")]
    WebSearch,
    #[serde(rename = "webfetch")]
    WebFetch,
    Edit,
    Command,
    Explore,
    Browser,
    Tool,
}
