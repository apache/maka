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

//! Cell facts share the existing Root writer. Interpreter maps are live handles only.
use crate::{Change, ContentBlob, store::invalid};
use maka_agent_facts::{cells::*, durable::*};
use maka_event_log::{StoreError, connection::Query, root_store::DataWriter};
use rusqlite::Connection;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
mod loaded;
mod sql;
pub(crate) use loaded::apply_tools_loaded;
mod standalone;
pub(crate) use sql::{
    apply, clear_run, load_run, native_source_pending, read_cell, rebuild_run, replay,
    verify_native_source,
};
pub use standalone::{StandaloneBatch, StandaloneEvent};

#[derive(Clone)]
pub struct CellsStore {
    data: DataWriter,
}
impl CellsStore {
    pub fn new(data: DataWriter) -> Self {
        Self { data }
    }
    pub async fn read(&self, session: &str, cell: CellId) -> Result<Option<CellView>, StoreError> {
        self.data.query(ReadCell(session.into(), cell)).await
    }
    pub async fn value(&self, session: &str, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.data.query(ReadValue(session.into(), key.into())).await
    }
    pub async fn loaded(&self, session: &str) -> Result<BTreeSet<String>, StoreError> {
        self.data.query(ReadLoaded(session.into())).await
    }
    pub async fn content(
        &self,
        session: &str,
        cell: CellId,
        reference: ContentRef,
    ) -> Result<Vec<u8>, StoreError> {
        self.data
            .query(ReadContent(session.into(), cell, reference))
            .await
    }
    pub async fn notifications(
        &self,
        run: RunId,
        after: Option<FactId>,
        limit: u32,
    ) -> Result<Vec<PendingNotification>, StoreError> {
        self.data.query(ReadNotifications(run, after, limit)).await
    }
    pub async fn rebuild_session(&self, session: &str) -> Result<(), StoreError> {
        self.data
            .write(standalone::RebuildSession(session.into()))
            .await
    }
    /// Invoke synchronous helpers only on dedicated interpreter/blocking threads.
    /// Their own current-thread VM runtime must not be nested with Handle::block_on.
    pub fn reader(
        &self,
        session: String,
        runtime: tokio::runtime::Handle,
    ) -> maka_session_state::Session {
        maka_session_state::Session::new(Arc::new(Reader {
            cells: self.clone(),
            session,
            runtime,
        }))
    }
}
#[derive(Clone, Debug)]
pub struct PendingNotification {
    pub cell: CellId,
    pub id: FactId,
    pub content: ContentRef,
}
struct Reader {
    cells: CellsStore,
    session: String,
    runtime: tokio::runtime::Handle,
}
impl maka_session_state::SessionDataReader for Reader {
    fn load(&self, key: &str) -> maka_session_state::Result<Option<Vec<u8>>> {
        let cells = self.cells.clone();
        let session = self.session.clone();
        let key = key.to_owned();
        let (reply, observed) = std::sync::mpsc::sync_channel(1);
        self.runtime.spawn(async move {
            let result = cells.value(&session, &key).await;
            let _ = reply.send(result);
        });
        observed
            .recv()
            .map_err(|_| {
                maka_session_state::Error::Unavailable("canonical SessionData reader closed".into())
            })?
            .map_err(|e| maka_session_state::Error::Unavailable(e.to_string()))
    }
    fn loaded(&self) -> maka_session_state::Result<BTreeSet<String>> {
        let cells = self.cells.clone();
        let session = self.session.clone();
        let (reply, observed) = std::sync::mpsc::sync_channel(1);
        self.runtime.spawn(async move {
            let result = cells.loaded(&session).await;
            let _ = reply.send(result);
        });
        observed
            .recv()
            .map_err(|_| {
                maka_session_state::Error::Unavailable(
                    "canonical loaded-tools reader closed".into(),
                )
            })?
            .map_err(|e| maka_session_state::Error::Unavailable(e.to_string()))
    }
}
/// Pure final-result acceptance. The Root validates the entire publication set
/// against the original completion; this helper never writes or grants work.
pub fn acceptance(cell: &CellView) -> Result<Vec<Fact>, StoreError> {
    let CellStatus::Completed {
        publication,
        accepted: false,
        ..
    } = &cell.status
    else {
        return Err(invalid("Cell has no unaccepted normal completion"));
    };
    let mut facts = vec![Fact::Cell {
        event: CellEvent::ResultAccepted { cell: cell.id },
    }];
    facts.extend(publication.values.iter().map(|(key, value)| Fact::Cell {
        event: CellEvent::SessionValuePublished {
            cell: cell.id,
            key: key.clone(),
            value: value.clone(),
        },
    }));
    if let Some(names) = &publication.loaded_tools {
        facts.push(Fact::Cell {
            event: CellEvent::LoadedToolsPublished {
                cell: cell.id,
                names: names.clone(),
            },
        });
    }
    Ok(facts)
}
/// Freeze JSON bytes without publishing them. Contents enter the same Root
/// transaction as Completed, and are independently pinned by that Cell evidence.
pub fn completion(
    cell: CellId,
    result: ContentBlob,
    draft: maka_session_state::SessionDraft,
) -> Result<(CellEvent, Vec<ContentBlob>), StoreError> {
    let mut contents = vec![result.clone()];
    let mut values = BTreeMap::new();
    for (key, bytes) in draft.values {
        let _: serde_json::Value = serde_json::from_slice(&bytes)?;
        let content = ContentBlob::new(bytes);
        values.insert(key, content.reference().clone());
        contents.push(content);
    }
    Ok((
        CellEvent::Completed {
            cell,
            result: result.reference().clone(),
            publication: SessionPublication {
                values,
                loaded_tools: draft.loaded_tools,
            },
        },
        contents,
    ))
}
struct ReadCell(String, CellId);
impl Query for ReadCell {
    type Output = Option<CellView>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::read_recorded(c, &self.0, self.1)
    }
}
struct ReadValue(String, String);
impl Query for ReadValue {
    type Output = Option<Vec<u8>>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::value(c, &self.0, &self.1)
    }
}
struct ReadLoaded(String);
impl Query for ReadLoaded {
    type Output = BTreeSet<String>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::loaded(c, &self.0)
    }
}
struct ReadContent(String, CellId, ContentRef);
impl Query for ReadContent {
    type Output = Vec<u8>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::owned_content(c, &self.0, self.1, &self.2)
    }
}
struct ReadNotifications(RunId, Option<FactId>, u32);
impl Query for ReadNotifications {
    type Output = Vec<PendingNotification>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::notifications(c, self.0, self.1, self.2)
    }
}

pub(crate) fn transition_error(error: CellTransitionError) -> StoreError {
    match error {
        CellTransitionError::Conflict(_) => StoreError::EventConflict,
        CellTransitionError::Invalid(reason) => invalid(reason),
    }
}
