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

use maka_agent_facts::read::ReadInput;

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub session_id: String,
    pub artifact_id: String,
    pub offset: Option<usize>,
    pub limit: Option<std::num::NonZeroUsize>,
}
impl Input {
    pub fn validate(&self) -> Result<(), String> {
        for id in [&self.session_id, &self.artifact_id] {
            maka_agent_facts::interaction::entity_id(id).map_err(str::to_owned)?;
        }
        ReadInput {
            path: self.artifact_id.clone(),
            offset: self.offset,
            limit: self.limit,
        }
        .resolve()
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
