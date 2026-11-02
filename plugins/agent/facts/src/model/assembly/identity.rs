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

use super::StepBuilder;
use super::{ModelError, invalid};
use crate::model::ModelToolCall;

impl StepBuilder {
    /// Validate the durable step identity before consuming its stream.
    /// Provider identities remain unchanged throughout acceptance.
    pub fn for_step(step_id: &str) -> Result<Self, ModelError> {
        if step_id.is_empty() {
            return Err(invalid("invalid model step identity"));
        }
        Ok(Self::default())
    }

    pub(super) fn validate_call(&self, call: &ModelToolCall) -> Result<(), ModelError> {
        self.validate_tool_identity(&call.id, &call.name)
    }

    pub(super) fn validate_tool_identity(&self, id: &str, name: &str) -> Result<(), ModelError> {
        if id.is_empty() {
            return Err(invalid("tool call identity must be nonempty"));
        }
        if name.is_empty() {
            return Err(invalid("tool name must be nonempty"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ModelEvent, ModelFinishReason, ModelUsage};
    use serde_json::json;

    fn call(id: String, name: String, provider_executed: bool) -> ModelEvent {
        ModelEvent::ToolCall(ModelToolCall {
            id,
            name,
            provider_executed,
            input: json!({}).into(),
            provider_options: None,
        })
    }

    fn finish() -> ModelEvent {
        ModelEvent::Finished {
            reason: ModelFinishReason::ToolCalls,
            usage: ModelUsage::default(),
            provider_options: None,
        }
    }

    #[test]
    fn complete_step_and_tool_identities_and_names_preserve_original_values() {
        assert!(StepBuilder::for_step("").is_err());
        let mut builder = StepBuilder::for_step(&"step".repeat(1025)).unwrap();
        builder
            .push(call("call".repeat(2049), "echo_name".repeat(40), false))
            .unwrap();
        builder.push(finish()).unwrap();
        let step = builder.finish().unwrap();
        let call = step.tool_calls().next().unwrap();
        assert_eq!(call.id, "call".repeat(2049));
        assert_eq!(call.name, "echo_name".repeat(40));
    }

    #[test]
    fn malformed_call_poisoning_prevents_completed_steps() {
        for provider in [false, true] {
            for (id, name) in [(String::new(), "echo".into()), ("id".into(), String::new())] {
                let mut builder = StepBuilder::for_step("step").unwrap();
                assert!(builder.push(call(id, name, provider)).is_err());
                assert!(builder.push(finish()).is_err());
                assert!(builder.finish().is_err());
            }
        }
    }
}
