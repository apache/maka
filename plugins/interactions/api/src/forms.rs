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

use maka_agent_facts::capability::FormField;
use maka_agent_facts::capability::FormResult;
use maka_agent_facts::interaction::ClosureReason;
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const IMPLEMENTATION: &str = "maka.interactions.forms";
pub const EXPORT: &str = "forms";
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "FormAsk")]
pub struct Ask {
    #[schemars(length(min = 1))]
    pub message: String,
    pub fields: Vec<FormField>,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "FormResponse")]
pub enum Answer {
    Answered { result: FormResult },
    Closed { reason: ClosureReason },
    Rejected { reason: super::questions::Rejection },
}
pub fn contract() -> Contract {
    Contract {
        name: "maka.interactions.Forms".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([(
                "ask".into(),
                Method {
                    progress: None,
                    mode: MethodMode::Mutation,
                    input: schemars::schema_for!(Ask).into(),
                    output: schemars::schema_for!(Answer).into(),
                    resources: BTreeMap::new(),
                },
            )]),
        },
    }
}

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        serde_json::json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        [(EXPORT, contract())],
    )
}
