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

//! Outbound ACP agents. All effects use the same capabilities as external plugins.
mod callbacks;
mod conversation;
mod driver;
mod install;
pub mod plugin;
mod projection;
mod settings;
mod setup;
mod transport;

use maka_plugins::process::{Command, Lifetime};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Agent {
    pub id: String,
    pub display_name: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Ordinary launch settings only. Credentials belong to the agent's login store.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

impl Agent {
    pub fn validate(&self) -> Result<(), maka_plugins::Error> {
        maka_runtime::executor::ExecutorId::try_from(self.id.clone())
            .map_err(|error| maka_plugins::Error::Invalid(error.to_string()))?;
        if self.display_name.trim().is_empty()
            || self.display_name.len() > 256
            || self.display_name.chars().any(char::is_control)
        {
            return Err(maka_plugins::Error::Invalid(
                "invalid agent display name".into(),
            ));
        }
        self.command()
            .validate()
            .map_err(|error| maka_plugins::Error::Invalid(error.to_string()))
    }

    fn command(&self) -> Command {
        Command {
            executable: self.executable.clone(),
            args: self.args.clone(),
            env: self.env.clone(),
            lifetime: Lifetime::Instance,
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error(transparent)]
    Sdk(#[from] agent_client_protocol::Error),
    #[error(transparent)]
    Process(#[from] maka_plugins::process::Error),
    #[error(transparent)]
    Storage(#[from] maka_plugins::storage::StoreError),
    #[error(transparent)]
    Output(#[from] maka_plugins::executor::Error),
    #[error("invalid ACP response: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("external conversation cannot be continued: {0}")]
    Continuity(&'static str),
    #[error("external agent request timed out")]
    Timeout,
    #[error("external agent request cancelled")]
    Cancelled,
    #[error("external agent contract: {0}")]
    Invalid(&'static str),
}

fn digest(value: &impl Serialize) -> Result<String, serde_json::Error> {
    use sha2::{Digest, Sha256};
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
