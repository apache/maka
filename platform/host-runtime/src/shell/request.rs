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

//! Shared shell request parsing; authority and resource ownership remain with the caller.

use serde::Deserialize;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Execute {
    #[schemars(length(min = 1))]
    pub command: String,
    /// Explicit interpreter choice; absent uses the Runtime Host preference.
    pub shell: Option<maka_agent_facts::configuration::policy::ShellPolicy>,
    /// Load the shell's login profile. Set false to skip it.
    #[serde(default = "default_login")]
    pub login: bool,
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub run_in_background: bool,
    /// Allocate a terminal; requires run_in_background=true.
    #[serde(default)]
    pub pty: bool,
    /// Request additional filesystem or network access before this command.
    /// On Linux/Windows, request an existing parent directory when creating a new path.
    pub additional_permissions: Option<maka_sandbox::grant::Permissions>,
    /// Explain why the additional access is necessary. Required with additional_permissions.
    pub justification: Option<String>,
}

fn default_login() -> bool {
    true
}

impl Execute {
    pub fn parse(value: serde_json::Value) -> Result<Self, maka_agent_facts::tools::ToolError> {
        let failed = |error: String| maka_agent_facts::tools::ToolError::Failed(error);
        let input: Self =
            serde_json::from_value(value).map_err(|error| failed(error.to_string()))?;
        maka_process::validate_command(&input.command)?;
        if input.pty && !input.run_in_background {
            return Err(failed("PTY mode requires run_in_background=true".into()));
        }
        if input
            .timeout_ms
            .is_some_and(|ms| maka_process::validate_timeout(ms).is_err())
        {
            return Err(failed("Shell timeout must be positive".into()));
        }
        if input.additional_permissions.is_some() != input.justification.is_some() {
            return Err(failed(
                "additional_permissions and justification must be supplied together".into(),
            ));
        }
        Ok(input)
    }
}

pub fn parse_ref(reference: &str) -> Option<&str> {
    reference
        .strip_prefix(maka_presentation::shell::RESOURCE_REF_PREFIX)
        .filter(|id| maka_agent_facts::interaction::entity_id(id).is_ok())
}
