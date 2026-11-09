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

use crate::{Error, task::Creator};
use maka_agent_facts::durable::ExecutionIdentity;
use maka_capabilities::authorization::Id;
use maka_capabilities::call::Scope;
use serde::{Deserialize, Serialize};

/// The plugin constructs provenance from the admitted public callback. It is
/// never decoded as an execution capability from a management payload.
#[derive(Clone)]
pub enum Origin {
    User { grant: Option<Id> },
    Agent(Scope),
}
impl Origin {
    pub fn agent(&self) -> Result<Option<&ExecutionIdentity>, Error> {
        match self {
            Self::User { .. } => Ok(None),
            Self::Agent(call) => call
                .identity
                .agent()
                .map(Some)
                .ok_or_else(|| Error::Invalid("expected an admitted Agent call".into())),
        }
    }
    pub fn creator(&self) -> Result<Creator, Error> {
        Ok(match self.agent()? {
            Some(invocation) => Creator::Agent {
                session_id: invocation.session_id.clone(),
            },
            None => Creator::User,
        })
    }
}

/// A durable reference, never a plugin-supplied copy of Host authorization.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authorization {
    pub grant: Id,
}
