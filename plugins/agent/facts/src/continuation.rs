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

//! Durable continuation identity. The opening itself acquires the claim;
//! a query or an in-memory plan has no execution authority.

use crate::{archive::valid_projection_digest, durable::ExecutionIdentity, interaction::entity_id};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunBoundary {
    pub execution: ExecutionIdentity,
    /// Run-local ordinal, never a root ledger sequence.
    pub high_water: u64,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionBase {
    /// Root ledger position in the source's Session, before the first fresh Run.
    pub high_water: u64,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContinuationClaim {
    pub id: String,
    pub source: RunBoundary,
    pub base: SessionBase,
    /// Engine-owned replay evidence over the inherited prompt and model route.
    /// ModelRequested records the actual request after live tool binding.
    pub replay: ReplayEvidence,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayEvidence {
    pub version: u32,
    pub digest: String,
    pub route_identity: String,
}

pub const REPLAY_VERSION: u32 = 2;

impl ReplayEvidence {
    pub fn uses_logical_prompt(&self) -> bool {
        self.version == REPLAY_VERSION
    }

    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if !matches!(self.version, 1 | REPLAY_VERSION)
            || !valid_projection_digest(&self.digest)
            || !valid_projection_digest(&self.route_identity)
        {
            return Err("invalid provider replay evidence");
        }
        Ok(())
    }
}

impl ContinuationClaim {
    pub fn validate(&self, target: &ExecutionIdentity) -> Result<(), &'static str> {
        entity_id(&self.id)?;
        for execution in [&self.source.execution, target] {
            for id in [&execution.session_id, &execution.turn_id] {
                entity_id(id)?;
            }
        }
        let source = &self.source.execution;
        if source.session_id != target.session_id || source.run_id == target.run_id {
            return Err("continuation requires a fresh logical Run in the same Session");
        }
        if self.source.high_water == 0
            || self.source.high_water > crate::configuration::validation::MAX_SAFE_INTEGER
            || self.base.high_water >= i64::MAX as u64
            || !valid_projection_digest(&self.source.digest)
            || !valid_projection_digest(&self.base.digest)
        {
            return Err("invalid continuation boundary or replay evidence");
        }
        self.replay.validate()
    }
}
