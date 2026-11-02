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

use maka_agent_facts::interaction::ComputerAppActivity;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentComputerApps")]
pub struct ComputerApps {
    pub entries: Vec<ComputerAppActivityState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentComputerAppActivityState")]
pub struct ComputerAppActivityState {
    pub activity: ComputerAppActivity,
    pub stopped: bool,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentStopComputerApp")]
pub struct StopComputerApp {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub operation_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stop_uses_only_observed_source_operation_and_cannot_supply_app_authority() {
        let input: StopComputerApp = serde_json::from_value(json!({
            "sessionId":"session","operationId":"original-native-operation"
        }))
        .unwrap();
        assert_eq!(input.session_id, "session");
        assert_eq!(input.operation_id, "original-native-operation");
        for field in ["applicationId", "appPath", "risk", "target"] {
            let mut invalid =
                json!({"sessionId":"session","operationId":"original-native-operation"});
            invalid[field] = json!("caller-provided");
            assert!(serde_json::from_value::<StopComputerApp>(invalid).is_err());
        }
        let maka_plugin_core::contract::Interface::Service { methods } =
            super::super::contract().interface
        else {
            panic!("agent service contract");
        };
        let validate = jsonschema::validator_for(&methods["stopComputerApp"].input).unwrap();
        assert!(
            validate.is_valid(
                &json!({"sessionId":"session","operationId":"original-native-operation"})
            )
        );
        assert!(!validate.is_valid(&json!({"sessionId":"session","operationId":""})));
        assert!(
            !validate.is_valid(&json!({"sessionId":"","operationId":"original-native-operation"}))
        );
    }
}
