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

pub use maka_plugin_core::actions::{ActionDefinition, ActionId};
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use schemars::JsonSchema;
use serde::Deserialize;
use std::collections::BTreeMap;

pub const EXPORT: &str = "projectActions";
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub project_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    pub project_id: String,
    pub name: String,
    pub command: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    pub project_id: String,
    pub id: ActionId,
    pub revision: u64,
    pub name: String,
    pub command: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Remove {
    pub project_id: String,
    pub id: ActionId,
    pub revision: u64,
}
fn method<I: JsonSchema, O: JsonSchema>(mode: MethodMode) -> Method {
    Method {
        progress: None,
        mode,
        input: schemars::schema_for!(I).into(),
        output: schemars::schema_for!(super::terminal::Outcome<O>).into(),
        resources: BTreeMap::new(),
    }
}
pub fn contract() -> Contract {
    Contract {
        name: "maka.workspace.ProjectActions".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "definitions".into(),
                    method::<Project, Vec<ActionDefinition>>(MethodMode::Query),
                ),
                (
                    "create".into(),
                    method::<Create, ActionDefinition>(MethodMode::Mutation),
                ),
                (
                    "update".into(),
                    method::<Update, ActionDefinition>(MethodMode::Mutation),
                ),
                ("remove".into(), method::<Remove, ()>(MethodMode::Mutation)),
            ]),
        },
    }
}
