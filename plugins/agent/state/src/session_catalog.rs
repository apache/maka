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

//! Agent catalog reads join Root metadata and Agent indexes in one snapshot.
//! User read/provenance decisions have their own immutable canonical journal.
use crate::{session_history::HistoryCut, store::invalid};
use maka_agent_facts::{durable::*, session::Lineage};
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::{DataChange, DataWriter},
    sessions::{CatalogFilter, CatalogScope, SessionRecord},
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

const CATALOG_SCHEMA_VERSION: u32 = 1;

fn sqlite_integer(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("catalog integer exceeds SQLite range"))
}
fn unsigned_integer(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| invalid("negative stored catalog integer"))
}

mod composition;
pub use composition::ControlledStatement;
mod index;
mod planned;
mod query;
pub(crate) use index::{fact_message, index_fact, index_run, run_status};
pub use planned::PlannedCatalog;
pub(crate) use planned::SourceSummary;
pub(crate) use query::records_in_snapshot;

#[derive(Clone, Debug, Serialize)]
pub struct Filter {
    pub base: CatalogFilter,
    pub needs_you_only: bool,
}
#[derive(Clone, Debug)]
pub enum Position {
    Start,
    At(String),
    After(String),
    Before(String),
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadState {
    pub has_unread: bool,
    pub last_read_message_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub recorded_at: u64,
    pub preview: Option<String>,
    pub tail_message_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    pub run: RunId,
    pub terminal: Option<Terminal>,
    pub stopped: bool,
    pub blocked: bool,
    pub unknown_effects: bool,
    pub cleanup_pending: bool,
    pub late_sequence: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub latest: Option<RunStatus>,
    pub working: bool,
    pub blocked: bool,
    pub unknown_effects: bool,
    pub cleanup_pending: bool,
    pub late_evidence: bool,
    pub pending_interaction_since: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct Record {
    pub metadata: SessionRecord,
    pub control_revision: u64,
    pub status: Status,
    pub read_state: ReadState,
    pub last_message: Option<Message>,
    pub lineage: Option<Lineage>,
}
#[derive(Clone, Debug)]
pub struct Page {
    pub revision: String,
    pub sessions: Vec<Record>,
    pub pending_session_count: u64,
    pub next_cursor: Option<String>,
    pub previous_cursor: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[expect(
    clippy::large_enum_variant,
    reason = "Catalog commands are serialized individually; keep lineage payloads inline"
)]
pub enum ControlEdit {
    MarkRead {
        message_id: String,
    },
    EstablishLineage {
        lineage: Lineage,
        source: HistoryCut,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlCommand {
    pub id: FactId,
    pub at: UnixMillis,
    pub expected_revision: u64,
    pub edit: ControlEdit,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[expect(
    clippy::large_enum_variant,
    reason = "Catalog facts are serialized individually; keep lineage payloads inline"
)]
enum Event {
    ReadThrough {
        message_id: String,
        through_sequence: u64,
    },
    LineageEstablished {
        lineage: Lineage,
        source: HistoryCut,
    },
}
#[derive(Clone)]
pub struct SessionCatalog {
    data: DataWriter,
    owner: RunOwner,
    id_prefix: String,
}
impl SessionCatalog {
    pub fn new(data: DataWriter, owner: RunOwner, id_prefix: String) -> Result<Self, StoreError> {
        maka_agent_facts::interaction::entity_id(&id_prefix).map_err(invalid)?;
        if owner.deployment.is_nil() {
            return Err(invalid("nil catalog deployment"));
        }
        Ok(Self {
            data,
            owner,
            id_prefix,
        })
    }
    pub async fn revision(
        &self,
        scope: CatalogScope,
        filter: Filter,
    ) -> Result<String, StoreError> {
        self.data
            .query(ReadRevision {
                catalog: self.clone(),
                scope,
                filter,
            })
            .await
    }
    pub async fn page(
        &self,
        scope: CatalogScope,
        expected_revision: Option<String>,
        position: Position,
        filter: Filter,
        limit: u32,
    ) -> Result<Page, StoreError> {
        self.data
            .query(ReadPage {
                catalog: self.clone(),
                scope,
                expected_revision,
                position,
                filter,
                limit,
            })
            .await
    }
    pub async fn record(&self, session: &str) -> Result<Option<Record>, StoreError> {
        let page = self
            .page(
                CatalogScope::Session(session.to_owned()),
                None,
                Position::Start,
                Filter {
                    base: CatalogFilter {
                        roots_only: false,
                        archived_only: false,
                        include_archived: true,
                    },
                    needs_you_only: false,
                },
                1,
            )
            .await?;
        Ok(page.sessions.into_iter().next())
    }
    /// Preparing neither writes the marker nor replays a handler. Host may
    /// atomically commit this decision with its original provider receipt.
    pub fn control_statement(&self, session: String, command: ControlCommand) -> ControlStatement {
        ControlStatement(self.clone(), session, command)
    }
    pub fn prepare(&self, session: String, command: ControlCommand) -> DataChange {
        self.data.prepare(self.control_statement(session, command))
    }
    pub async fn apply(&self, session: String, command: ControlCommand) -> Result<u64, StoreError> {
        self.data
            .write(self.control_statement(session, command))
            .await
    }
    pub async fn rebuild(&self, session: String) -> Result<(), StoreError> {
        self.data.write(Rebuild(self.clone(), session)).await
    }
    fn owner_key(&self) -> Result<String, StoreError> {
        Ok(serde_json::to_string(&self.owner)?)
    }
    fn check_session(&self, session: &str) -> Result<(), StoreError> {
        maka_agent_facts::interaction::entity_id(session).map_err(invalid)?;
        if !session.starts_with(&self.id_prefix) {
            return Err(invalid("foreign catalog session"));
        }
        Ok(())
    }
}
struct ReadRevision {
    catalog: SessionCatalog,
    scope: CatalogScope,
    filter: Filter,
}
impl Query for ReadRevision {
    type Output = String;
    fn execute(self, c: &Connection) -> Result<String, StoreError> {
        query::revision(c, &self.catalog, &self.scope, &self.filter)
    }
}
struct ReadPage {
    catalog: SessionCatalog,
    scope: CatalogScope,
    expected_revision: Option<String>,
    position: Position,
    filter: Filter,
    limit: u32,
}
impl Query for ReadPage {
    type Output = Page;
    fn execute(self, c: &Connection) -> Result<Page, StoreError> {
        query::page(c, self)
    }
}
pub struct ControlStatement(SessionCatalog, String, ControlCommand);
impl Statement for ControlStatement {
    type Value = u64;
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<Prepared<u64>, StoreError> {
        let (value, changed) = index::control(c, &self.0, &self.1, self.2)?;
        Ok(Prepared {
            value,
            changed,
            notification: Notification::METADATA.with_sessions([self.1]),
        })
    }
    fn committed(value: u64) -> u64 {
        value
    }
    fn isolated_rejection(e: &StoreError) -> bool {
        matches!(
            e,
            StoreError::InvalidTransition(_)
                | StoreError::EventConflict
                | StoreError::RevisionConflict { .. }
                | StoreError::SessionNotFound
        )
    }
}
struct Rebuild(SessionCatalog, String);
impl Statement for Rebuild {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        index::rebuild(c, &self.0, &self.1)?;
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::METADATA.with_sessions([self.1]),
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(e: &StoreError) -> bool {
        matches!(
            e,
            StoreError::InvalidTransition(_) | StoreError::EventConflict
        )
    }
}
