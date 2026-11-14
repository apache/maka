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

pub use crate::search::Query;
use maka_plugin_core::contract::{
    Contract, Interface, Method, MethodMode, ResourceType, Transport,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WorkspaceWebConfiguration")]
pub struct Configuration {
    pub network: maka_sandbox::Network,
}
pub fn configuration_schema() -> Value {
    schemars::schema_for!(Configuration).into()
}
#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "WebBasis")]
pub struct Basis {
    pub revision: Option<u64>,
    pub credential_revision: Option<u64>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "WebCapture")]
pub struct Capture {
    pub basis: Basis,
    pub available: bool,
    pub source: crate::settings::Source,
    pub custom_available: bool,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WebCall_{T}")]
pub struct Call<T> {
    pub basis: Basis,
    pub input: T,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WebFetch")]
pub struct Fetch {
    #[schemars(length(min = 1))]
    pub url: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WebSet")]
pub struct Set {
    pub revision: Option<u64>,
    pub settings: crate::settings::Settings,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WebKey")]
pub struct Key {
    pub revision: Option<u64>,
    #[serde(default, rename = "settingsRevision")]
    pub settings_revision: Option<u64>,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "WebUpdate")]
pub enum Update {
    Updated { snapshot: crate::settings::Snapshot },
    Changed,
    InvalidKey,
    InvalidSettings { message: String },
    CheckUnavailable,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "WebResult")]
pub enum ResultValue {
    Completed { value: Value },
    Failed { message: String },
}
fn method<I: JsonSchema, O: JsonSchema>(mode: MethodMode) -> Method {
    Method {
        mode,
        input: schemars::schema_for!(I).into(),
        output: schemars::schema_for!(O).into(),
        resources: BTreeMap::new(),
        progress: None,
    }
}
pub fn contract() -> Contract {
    Contract {
        name: "maka.workspace.Web".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "snapshot".into(),
                    Method {
                        input: json!({"type":"object","additionalProperties":false}).into(),
                        ..method::<Value, crate::settings::Snapshot>(MethodMode::Query)
                    },
                ),
                (
                    "capture".into(),
                    Method {
                        input: json!({"type":"object","additionalProperties":false}).into(),
                        ..method::<Value, Capture>(MethodMode::Query)
                    },
                ),
                ("save".into(), method::<Set, Update>(MethodMode::Mutation)),
                (
                    "saveKey".into(),
                    Method {
                        resources: BTreeMap::from([(
                            "secret".into(),
                            ResourceType {
                                name: "maka.text.utf8".into(),
                                version: 1,
                            }
                            .required(),
                        )]),
                        ..method::<Key, Update>(MethodMode::Mutation)
                    },
                ),
                (
                    "deleteKey".into(),
                    method::<Key, Update>(MethodMode::Mutation),
                ),
                (
                    "checkKey".into(),
                    method::<Key, Update>(MethodMode::Mutation),
                ),
                (
                    "fetch".into(),
                    method::<Call<Fetch>, ResultValue>(MethodMode::Mutation),
                ),
                (
                    "probe".into(),
                    method::<crate::probe::Input, ResultValue>(MethodMode::Mutation),
                ),
                (
                    "search".into(),
                    method::<Call<crate::search::Query>, ResultValue>(MethodMode::Mutation),
                ),
            ]),
        },
    }
}

pub fn model_input_schema(method: &str) -> Option<Value> {
    match method {
        "fetch" => Some(schemars::schema_for!(Fetch).into()),
        "search" => Some(schemars::schema_for!(crate::search::Query).into()),
        _ => None,
    }
}
