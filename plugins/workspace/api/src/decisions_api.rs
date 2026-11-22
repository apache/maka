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

pub use maka_decisions_api::{
    decision::{
        Answer, Choice, ChoiceProbability, ChoiceValue, Evaluation, EvaluationResult, Level,
        Question, ScoreProbability, Usage,
    },
    settings::{Protocol, Settings, Snapshot},
};
use maka_plugin_core::contract::{
    Contract, Interface, Method, MethodMode, ResourceType, Transport,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WorkspaceDecisionsApiConfiguration")]
pub struct Configuration {
    pub network: maka_sandbox::Network,
}
pub fn configuration_schema() -> Value {
    schemars::schema_for!(Configuration).into()
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "DecisionsApiSet")]
pub struct Set {
    pub revision: Option<u64>,
    pub settings: Settings,
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "DecisionsApiCredentialTarget")]
pub enum CredentialTarget {
    ApiKey,
    Header {
        #[schemars(length(min = 1))]
        name: String,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "DecisionsApiCredentialChange")]
pub enum CredentialChange {
    Replace,
    Remove,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "DecisionsApiCredential")]
pub struct Credential {
    #[schemars(length(min = 1))]
    pub url: String,
    pub revision: Option<u64>,
    pub target: CredentialTarget,
    pub change: CredentialChange,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "DecisionsApiUpdate")]
pub enum Update {
    Updated { snapshot: Snapshot },
    Changed,
    Invalid,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "DecisionsApiResult")]
pub enum ResultValue {
    Completed { value: EvaluationResult },
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
        name: "maka.workspace.DecisionsApi".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "snapshot".into(),
                    Method {
                        input: json!({"type":"object","additionalProperties":false}).into(),
                        ..method::<Value, Snapshot>(MethodMode::Query)
                    },
                ),
                ("save".into(), method::<Set, Update>(MethodMode::Mutation)),
                (
                    "credential".into(),
                    Method {
                        resources: BTreeMap::from([(
                            "secret".into(),
                            ResourceType {
                                name: "maka.text.utf8".into(),
                                version: 1,
                            }
                            .optional(),
                        )]),
                        ..method::<Credential, Update>(MethodMode::Mutation)
                    },
                ),
                (
                    "evaluate".into(),
                    method::<Evaluation, ResultValue>(MethodMode::Mutation),
                ),
            ]),
        },
    }
}

pub const IMPLEMENTATION: &str = "maka.workspace.decisions_api";
pub const EXPORT: &str = "decisions_api";

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        configuration_schema(),
        [(EXPORT, contract())],
    )
}
