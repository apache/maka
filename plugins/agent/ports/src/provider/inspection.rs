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

use super::{Connection, Context, Definition, Error, authentication::Credential};
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_facts::configuration::ModelOverride;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Host-supplied account material; never catalog metadata or canonical history.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Discovery {
    pub connection: Connection,
    pub credential: Option<Credential>,
    pub request_headers: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verification {
    pub connection: Connection,
    pub credential: Option<Credential>,
    pub request_headers: BTreeMap<String, String>,
    pub model: ModelInfo,
    pub overrides: Option<ModelOverride>,
    pub request_body_overlay: Option<serde_json::Value>,
}

impl Definition {
    fn validate_inspection(
        &self,
        connection: &Connection,
        credential: Option<&Credential>,
        headers: &BTreeMap<String, String>,
    ) -> Result<(), Error> {
        self.validate_configuration(&connection.configuration)?;
        if let Some(credential) = credential {
            credential.validate().map_err(Error::Invalid)?;
        }
        crate::model::Credentials::RequestHeaders(headers.clone())
            .validate()
            .map_err(Error::Invalid)
    }

    pub async fn discover(
        &self,
        request: Discovery,
        context: Context,
    ) -> Result<Vec<ModelInfo>, Error> {
        if !self.policy.descriptor.discovery {
            return Err(Error::Unavailable);
        }
        self.validate_inspection(
            &request.connection,
            request.credential.as_ref(),
            &request.request_headers,
        )?;
        let models = self.implementation.discover(request, context).await?;
        let mut seen = std::collections::HashSet::new();
        for model in &models {
            model.validate().map_err(Error::Invalid)?;
            if !seen.insert(&model.id) {
                return Err(Error::Invalid("duplicate model identity".into()));
            }
        }
        Ok(models)
    }

    pub async fn verify(&self, request: Verification, context: Context) -> Result<(), Error> {
        self.validate_inspection(
            &request.connection,
            request.credential.as_ref(),
            &request.request_headers,
        )?;
        request.model.validate().map_err(Error::Invalid)?;
        if let Some(overlay) = &request.request_body_overlay {
            maka_agent_facts::configuration::validation::overlay(overlay)
                .map_err(Error::Invalid)?;
        }
        self.implementation.verify(request, context).await
    }
}
