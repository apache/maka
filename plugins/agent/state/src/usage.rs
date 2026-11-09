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

//! Physical model/tool accounting derived from canonical Agent evidence.
use maka_agent_facts::{
    accounting::{self, Activity, ModelEvidence, ToolUsage, ToolUsageSource},
    durable::*,
};
use maka_event_log::{StoreError, root_store::DataWriter};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
mod auxiliary;
mod index;
mod query;
pub use auxiliary::{AuxiliaryEvent, AuxiliaryJournal, AuxiliarySpec, AuxiliaryWrite};
pub(crate) use index::{index_cell, index_fact, rebuild_run};
pub const SCHEMA_VERSION: u32 = 1;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid usage query: {0}")]
    Invalid(String),
    #[error("auxiliary source was already admitted as {request}")]
    SourceAlreadyAdmitted { request: uuid::Uuid },
    #[error(transparent)]
    Store(#[from] StoreError),
}
#[derive(Clone)]
pub struct UsageStore {
    pub(super) data: DataWriter,
}
impl UsageStore {
    pub fn new(data: DataWriter) -> Self {
        Self { data }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageFence {
    pub schema_version: u32,
    pub state_domain: String,
    pub sequence: u64,
    pub auxiliary_sequence: u64,
    pub cell_sequence: u64,
    pub query_digest: String,
}
#[derive(Clone, Debug)]
pub struct UsageQuery {
    pub from: f64,
    pub to: f64,
    pub owner: Option<RunOwner>,
    pub session_id: Option<String>,
    pub through: Option<UsageFence>,
}
impl UsageQuery {
    pub fn validate(&self) -> Result<(), Error> {
        if !self.from.is_finite()
            || !self.to.is_finite()
            || self.from < 0.0
            || self.to < self.from
            || self.to > 9_007_199_254_740_991.0
            || self
                .session_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.chars().any(char::is_control))
        {
            return Err(Error::Invalid("invalid time or Session range".into()));
        }
        Ok(())
    }
    pub(super) fn digest(&self) -> Result<String, StoreError> {
        Ok(maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&(
                "maka.usage.v1",
                self.from.to_bits(),
                self.to.to_bits(),
                &self.owner,
                &self.session_id,
            ))?,
        ))
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageActivityCursor {
    pub completed_at: f64,
    pub request_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageGroupCursor {
    pub group: accounting::Group,
    pub key: Option<String>,
}
pub struct UsageActivityPage {
    pub through: UsageFence,
    pub attempts: Vec<Activity>,
    pub total: u64,
    pub next_cursor: Option<UsageActivityCursor>,
}
pub struct UsageReport {
    pub through: UsageFence,
    pub summary: accounting::Summary,
    pub next_cursor: Option<UsageGroupCursor>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionUsageTotals {
    pub input: accounting::Tokens,
    pub output: accounting::Tokens,
    pub cache_read: accounting::Tokens,
    pub cache_write: accounting::Tokens,
    pub reasoning: accounting::Tokens,
}
pub(super) fn invalid(reason: impl Into<String>) -> StoreError {
    StoreError::InvalidTransition(reason.into())
}
pub(super) fn integer(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("usage number exceeds SQLite range"))
}
pub(super) fn unsigned(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| invalid("negative usage number"))
}
