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

//! A loaded checkpoint is isolated history, never a runnable Session.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoadOperation {
    pub operation: Uuid,
    pub fingerprint: String,
    pub revision: Revision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum LoadState {
    Preparing,
    Ready {
        session_ids: Vec<String>,
        through: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace: Option<WorkspaceSnapshot>,
    },
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoadedCheckpoint {
    pub head: Head,
    pub state: LoadState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LoadRequest {
    pub scope: Scope,
    pub session_id: String,
    pub load: LoadOperation,
}
impl LoadRequest {
    pub(crate) fn validate(&self) -> Result<(), StoreError> {
        crate::sessions::validate_id(&self.session_id)?;
        self.scope
            .namespace
            .validate()
            .map_err(|e| invalid(e.to_string()))?;
        if self.scope.deployment.is_nil()
            || !valid_digest(&self.scope.state_domain)
            || self.load.operation.is_nil()
            || self.load.revision.0.is_nil()
            || !valid_digest(&self.load.fingerprint)
        {
            return Err(invalid("invalid checkpoint load request"));
        }
        Ok(())
    }
    pub(crate) fn key(&self) -> Result<String, StoreError> {
        load_key(&self.scope, &self.session_id, self.load.operation)
    }
    pub(crate) fn binding(&self) -> Result<String, StoreError> {
        Ok(format!("sha256:{}", digest(&serde_json::to_vec(self)?)))
    }
}
pub(crate) fn load_key(
    scope: &Scope,
    session: &str,
    operation: Uuid,
) -> Result<String, StoreError> {
    Ok(digest(&serde_json::to_vec(&(scope, session, operation))?))
}
