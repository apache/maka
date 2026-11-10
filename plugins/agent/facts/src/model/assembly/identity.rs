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
    pub fn for_step(_step_id: crate::durable::StepId) -> Result<Self, ModelError> {
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
