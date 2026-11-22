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

use super::*;
use maka_event_log::{
    root_store::RootStore,
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::work::WorkCustody;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StandaloneEvent {
    pub id: FactId,
    pub at: UnixMillis,
    pub event: CellEvent,
}
impl StandaloneEvent {
    pub fn new(event: CellEvent, at: UnixMillis) -> Self {
        Self {
            id: FactId::new(),
            at,
            event,
        }
    }
}
#[derive(Clone)]
pub struct StandaloneBatch {
    pub session: String,
    pub events: Vec<StandaloneEvent>,
    pub contents: Vec<ContentBlob>,
}
impl StandaloneBatch {
    /// Pure assembly: retry the original events, not newly minted publication ids.
    pub fn with_publications(
        session: String,
        events: Vec<StandaloneEvent>,
        contents: Vec<ContentBlob>,
    ) -> Result<Self, StoreError> {
        let mut complete = Vec::new();
        for event in events {
            if matches!(
                event.event,
                CellEvent::ResultAccepted { .. }
                    | CellEvent::SessionValuePublished { .. }
                    | CellEvent::LoadedToolsPublished { .. }
            ) {
                return Err(invalid(
                    "standalone publication assembly requires original source events",
                ));
            }
            let generated = if let CellEvent::Completed {
                cell, publication, ..
            } = &event.event
            {
                let mut facts = vec![(0, None, CellEvent::ResultAccepted { cell: *cell })];
                for (key, value) in &publication.values {
                    facts.push((
                        1,
                        Some(key.as_str()),
                        CellEvent::SessionValuePublished {
                            cell: *cell,
                            key: key.clone(),
                            value: value.clone(),
                        },
                    ));
                }
                if let Some(names) = &publication.loaded_tools {
                    facts.push((
                        2,
                        None,
                        CellEvent::LoadedToolsPublished {
                            cell: *cell,
                            names: names.clone(),
                        },
                    ));
                }
                facts
                    .into_iter()
                    .map(|(slot, key, fact)| {
                        Ok(StandaloneEvent {
                            id: publication_id(event.id, slot, key)?,
                            at: event.at,
                            event: fact,
                        })
                    })
                    .collect::<Result<Vec<_>, StoreError>>()?
            } else {
                Vec::new()
            };
            complete.push(event);
            complete.extend(generated);
        }
        Ok(Self {
            session,
            events: complete,
            contents,
        })
    }
}
fn publication_id(completion: FactId, slot: u8, key: Option<&str>) -> Result<FactId, StoreError> {
    let key = key.unwrap_or("").as_bytes();
    let mut input = b"maka.standalone.cell.publication.v1\0".to_vec();
    input.extend_from_slice(completion.as_uuid().as_bytes());
    input.push(slot);
    input.extend_from_slice(
        &u64::try_from(key.len())
            .map_err(|_| invalid("Cell publication key too large"))?
            .to_be_bytes(),
    );
    input.extend_from_slice(key);
    let digest = maka_agent_facts::artifact::content_digest(&input);
    let hash = u128::from_str_radix(&digest["sha256:".len()..][..32], 16)
        .map_err(|_| invalid("invalid Cell publication hash"))?;
    let mut bytes = hash.to_be_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    FactId::try_from(uuid::Uuid::from_bytes(bytes)).map_err(invalid)
}
impl CellsStore {
    pub async fn append_standalone(
        &self,
        root: &RootStore,
        custody: Arc<dyn WorkCustody>,
        batch: StandaloneBatch,
    ) -> Result<(), StoreError> {
        let writer = root.data_writer_for_work(custody.as_ref(), &batch.session)?;
        if !self.data.same_root(&writer) {
            return Err(invalid("Standalone Cell belongs to another Root"));
        }
        let work = root.fork_effect(custody.as_ref(), &batch.session)?;
        let (reply, observed) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let result = writer.write(AppendStandalone { batch }).await;
            // The writer job has physically returned; metadata failure is not cleanup failure.
            work.finish(Ok(()));
            let _ = reply.send(result);
        });
        observed
            .await
            .map_err(|_| invalid("Standalone Cell commit observation closed"))?
    }
}
struct AppendStandalone {
    batch: StandaloneBatch,
}
impl Statement for AppendStandalone {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        if self.batch.events.is_empty() {
            return Err(invalid("empty standalone Cell batch"));
        }
        for blob in &self.batch.contents {
            blob.store(c)?;
        }
        let cursor: i64 = c.query_row(
            "SELECT coalesce(max(sequence),0) FROM agent_facts",
            [],
            |r| r.get(0),
        )?;
        let changes: Vec<Change> = self
            .batch
            .events
            .iter()
            .map(|e| Change {
                id: e.id,
                at: e.at,
                fact: Fact::Cell {
                    event: e.event.clone(),
                },
            })
            .collect();
        let mut existing = 0;
        let mut seen = std::collections::BTreeSet::new();
        for event in &self.batch.events {
            if !seen.insert(event.id) {
                return Err(StoreError::EventConflict);
            }
            let original:Option<(String,Vec<u8>)>=c.query_row("SELECT e.session,c.payload FROM agent_standalone_cell_events e JOIN contents c ON c.id=e.body_content_id WHERE e.id=?",[event.id.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((session, bytes)) = original {
                if session != self.batch.session
                    || serde_json::from_slice::<StandaloneEvent>(&bytes)? != *event
                {
                    return Err(StoreError::EventConflict);
                }
                existing += 1;
            }
        }
        if existing != 0 {
            if existing != self.batch.events.len() {
                return Err(StoreError::EventConflict);
            }
            return Ok(Prepared {
                value: (),
                changed: false,
                notification: Notification::NONE,
            });
        }
        for event in &self.batch.events {
            if let CellEvent::Completed { cell, .. } = &event.event
                && self.batch.events.iter().filter(|candidate|matches!(&candidate.event,CellEvent::ResultAccepted{cell:id} if id==cell)).count()!=1{return Err(invalid("standalone completion requires same-batch final acceptance"));}
            let view = match &event.event {
                CellEvent::Started {
                    owner: CellOwner::Standalone { session },
                    ..
                } if session == &self.batch.session => {
                    if event.id != event.event.cell().started_fact_id() {
                        return Err(StoreError::EventConflict);
                    }
                    if sql::exists(c, event.event.cell(), None)? {
                        return Err(StoreError::EventConflict);
                    }
                    CellView::started(&event.event).map_err(transition_error)?
                }
                CellEvent::Started { .. } => {
                    return Err(invalid("Standalone Cell has a foreign owner"));
                }
                CellEvent::NotificationConsumed { .. } => {
                    return Err(invalid("Standalone cells have no Agent context Step"));
                }
                _ => {
                    let mut view = sql::read(c, &self.batch.session, event.event.cell())?
                        .ok_or_else(|| invalid("Standalone Cell has not started"))?;
                    if !matches!(&view.owner,CellOwner::Standalone{session} if session==&self.batch.session)
                    {
                        return Err(invalid("Cell is not owned by this standalone session"));
                    }
                    sql::validate_batch(&view, &event.event, &changes)?;
                    sql::validate_notification(c, &view, &event.event)?;
                    view.apply(&event.event).map_err(transition_error)?;
                    view
                }
            };
            let body = ContentBlob::json(event)?;
            let body_id = body.store(c)?;
            c.execute("INSERT INTO agent_standalone_cell_events(id,cell,session,at,agent_cursor,body_content_id) VALUES(?,?,?,?,?,?)",params![event.id.to_string(),event.event.cell().to_string(),self.batch.session,event.at.0,cursor,body_id])?;
            for r in event.event.content_refs() {
                let id = sql::content_id(c, r)?;
                c.execute(
                    "INSERT OR IGNORE INTO agent_standalone_cell_pins(cell,content_id) VALUES(?,?)",
                    params![event.event.cell().to_string(), id],
                )?;
            }
            sql::project(c, &self.batch.session, None, event.id, &event.event, &view)?;
        }
        for event in &self.batch.events {
            let sequence: i64 = c.query_row(
                "SELECT sequence FROM agent_standalone_cell_events WHERE id=?",
                [event.id.to_string()],
                |r| r.get(0),
            )?;
            crate::usage::index_cell(
                c,
                None,
                crate::usage::UsagePosition {
                    source: "cell",
                    session: &self.batch.session,
                    run: None,
                    sequence: u64::try_from(sequence)
                        .map_err(|_| invalid("negative standalone Cell sequence"))?,
                    at: event.at,
                },
                &event.event,
            )?;
        }
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_)
                | StoreError::EventConflict
                | StoreError::RevisionConflict { .. }
        )
    }
}
pub(super) struct RebuildSession(pub String);
impl Statement for RebuildSession {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        sql::rebuild_session(c, &self.0)?;
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_)
                | StoreError::EventConflict
                | StoreError::RevisionConflict { .. }
        )
    }
}
