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

use super::{Connection, Error};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Method {
    pub id: String,
    pub label: String,
    /// Secret-bearing form input never enters the connection configuration.
    pub input_schema: Value,
    pub interactive: bool,
}
impl Method {
    pub fn validate(&self) -> Result<(), Error> {
        crate::name(&self.id).map_err(|e| Error::Invalid(e.to_string()))?;
        if self.label.trim().is_empty() || !self.input_schema.is_object() {
            return Err(Error::Invalid("invalid authentication method".into()));
        }
        Ok(())
    }
}

pub use maka_agent_facts::provider::Credential;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authenticate {
    pub connection: Connection,
    pub method: String,
    pub input: Value,
}

/// Presentation is attached to the originating client; it cannot choose another
/// client or acquire arbitrary workspace capabilities.
pub trait Interaction: Send + Sync {
    fn open_external(
        &self,
        url: String,
        user_code: Option<String>,
    ) -> BoxFuture<'_, Result<(), Error>>;
}
