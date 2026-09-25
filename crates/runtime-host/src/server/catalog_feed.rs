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

use std::collections::HashSet;
use tokio::sync::Mutex;

use maka_event_log::EventLog;
use serde_json::{Value, json};
use tokio::sync::broadcast;

use super::HostError;

const PAGE_SIZE: usize = 32;
const MAX_NOTICE_REVISION: u64 = 9_007_199_254_740_991;

/// Disposable delivery state; the log remains the source of execution changes.
/// One lock orders both cursor advancement and all session notice publication.
pub(crate) struct CatalogFeed {
    cursor: Mutex<Cursor>,
    changes: broadcast::Sender<Value>,
}

struct Cursor {
    after: u64,
    revision: u64,
}

impl CatalogFeed {
    pub(super) fn new(after: u64, changes: broadcast::Sender<Value>) -> Self {
        Self {
            cursor: Mutex::new(Cursor { after, revision: 0 }),
            changes,
        }
    }

    pub(crate) async fn publish_session(&self, session_id: &str) -> Result<(), HostError> {
        self.cursor
            .lock()
            .await
            .publish(&self.changes, Some(session_id))
    }

    pub(crate) async fn publish_all(&self) -> Result<(), HostError> {
        self.cursor.lock().await.publish(&self.changes, None)
    }

    /// Processes one bounded page. True asks the connection loop to schedule
    /// another page; any connection may continue the shared committed cursor.
    pub(super) async fn publish_commits(
        &self,
        log: &EventLog,
        through: u64,
    ) -> Result<bool, HostError> {
        let mut cursor = self.cursor.lock().await;
        if through <= cursor.after {
            return Ok(false);
        }
        let rows = log
            .session_catalog_changes(cursor.after, through, PAGE_SIZE + 1)
            .await?;
        let more = rows.len() > PAGE_SIZE;
        let mut seen = HashSet::new();
        for (sequence, session_id) in rows.iter().take(PAGE_SIZE) {
            if seen.insert(session_id) {
                cursor.publish(&self.changes, Some(session_id))?;
            }
            cursor.after = *sequence;
        }
        if !more {
            cursor.after = through;
        }
        Ok(more)
    }
}

impl Cursor {
    fn publish(
        &mut self,
        changes: &broadcast::Sender<Value>,
        session_id: Option<&str>,
    ) -> Result<(), HostError> {
        if self.revision == MAX_NOTICE_REVISION {
            return Err("session notice revision exhausted".into());
        }
        self.revision += 1;
        let mut notice = json!({"kind": "session.catalog.changed", "revision": self.revision});
        if let Some(id) = session_id {
            notice["sessionId"] = id.into();
        }
        let _ = changes.send(notice);
        Ok(())
    }
}
