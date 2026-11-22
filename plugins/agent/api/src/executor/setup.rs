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

use super::*;
pub use maka_external_agent::setup::{Action, Outcome, Progress};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "ExecutorSetupBinding")]
pub struct Binding {
    #[schemars(length(min = 1))]
    pub import: String,
    #[serde(default)]
    pub member: usize,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentExecutorSetup")]
pub struct Input {
    #[schemars(length(min = 1))]
    pub executor: String,
    pub action: Action,
}
pub fn contract() -> Contract {
    Contract {
        name: "maka.agent.ExecutorSetup".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([(
                "setup".into(),
                Method {
                    mode: MethodMode::Mutation,
                    input: schemars::schema_for!(Action).into(),
                    output: schemars::schema_for!(Outcome).into(),
                    progress: Some(schemars::schema_for!(Progress).into()),
                    resources: BTreeMap::new(),
                },
            )]),
        },
    }
}
