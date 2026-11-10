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

//! Safe diagnostic projections over original canonical Agent facts only.
use crate::store::invalid;
use maka_agent_facts::{diagnostics::DiagnosticDetail, durable::*};
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::Connection;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

mod bootstrap;
mod index;
mod read;
pub(crate) use bootstrap::ensure_owner;
pub(crate) use index::index_fact;
const MAX_BYTES: usize = 48 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticEntry {
    pub sequence: u64,
    pub event_id: FactId,
    pub recorded_at: UnixMillis,
    pub detail: DiagnosticDetail,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticPage {
    pub through: u64,
    pub next_before: Option<u64>,
    pub entries: Vec<DiagnosticEntry>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticHead {
    pub through: u64,
    pub latest: Option<u64>,
}
#[derive(Clone)]
struct Scope {
    owner: RunOwner,
    session: String,
}
#[derive(Clone)]
pub struct DiagnosticsStore {
    data: DataWriter,
    scope: Scope,
}
impl DiagnosticsStore {
    pub fn new(data: DataWriter, owner: RunOwner, session: String) -> Result<Self, StoreError> {
        maka_agent_facts::interaction::entity_id(&session).map_err(invalid)?;
        if owner.deployment.is_nil() {
            return Err(invalid("nil diagnostics deployment"));
        }
        owner
            .namespace
            .validate()
            .map_err(|error| invalid(error.to_string()))?;
        Ok(Self {
            data,
            scope: Scope { owner, session },
        })
    }
    pub async fn page(
        &self,
        through: Option<u64>,
        before: Option<u64>,
        limit: u32,
        max_bytes: usize,
    ) -> Result<DiagnosticPage, StoreError> {
        if !(1..=128).contains(&limit) || !(1..=MAX_BYTES).contains(&max_bytes) {
            return Err(invalid("invalid diagnostic page limit or JSON budget"));
        }
        self.data
            .query_barrier(ReadPage {
                scope: self.scope.clone(),
                through,
                before,
                limit,
                max_bytes,
            })
            .await
    }
    pub async fn head(&self) -> Result<DiagnosticHead, StoreError> {
        self.data.query_barrier(ReadHead(self.scope.clone())).await
    }
    pub fn subscribe(&self) -> Result<tokio::sync::watch::Receiver<()>, StoreError> {
        self.data.subscribe_changes()
    }
    pub async fn rebuild(&self) -> Result<(), StoreError> {
        self.data.write(Rebuild(self.scope.clone())).await
    }
}
struct ReadPage {
    scope: Scope,
    through: Option<u64>,
    before: Option<u64>,
    limit: u32,
    max_bytes: usize,
}
impl Query for ReadPage {
    type Output = DiagnosticPage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        read::page(c, self)
    }
}
struct ReadHead(Scope);
impl Query for ReadHead {
    type Output = DiagnosticHead;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        read::head(c, self.0)
    }
}
struct Rebuild(Scope);
impl Statement for Rebuild {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        index::rebuild(c, &self.0)?;
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::METADATA.with_sessions([self.0.session]),
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::EventConflict
        )
    }
}
fn signed(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("diagnostic sequence exceeds SQLite range"))
}
fn unsigned(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| invalid("negative diagnostic source number"))
}
fn identity<T: DeserializeOwned>(value: String) -> Result<T, StoreError> {
    Ok(serde_json::from_value(serde_json::Value::String(value))?)
}
