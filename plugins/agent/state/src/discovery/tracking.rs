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

const CURSOR_FIELDS: &str = "source_uri,last_mtime_ms,last_hash,write_burst_count,cooldown_until,last_explored_at,updated_at";
pub(super) const WATCH_FIELDS: &str = "watch_id,topic_id,kind,target,predicate_json,on_trigger,last_state_hash,expires_at,created_at,updated_at";
pub(super) const ACTION_FIELDS: &str = "action_id,topic_id,connector_tool,params_json,input_hashes_json,idempotency_key,status,receipt_json,expires_at,created_at,updated_at";

fn cursor(r: &Row<'_>) -> rusqlite::Result<SourceCursorRecord> {
    Ok(SourceCursorRecord {
        source_uri: SourceUri(r.get(0)?),
        last_mtime_ms: UnixMillis(r.get(1)?),
        last_hash: r.get(2)?,
        write_burst_count: r.get(3)?,
        cooldown_until: UnixMillis(r.get(4)?),
        last_explored_at: UnixMillis(r.get(5)?),
        updated_at: UnixMillis(r.get(6)?),
    })
}
pub(super) fn watch_record(r: &Row<'_>) -> rusqlite::Result<WatchRecord> {
    Ok(WatchRecord {
        watch_id: WatchId(r.get(0)?),
        topic_id: TopicId(r.get(1)?),
        kind: vocabulary(r, 2)?,
        target: r.get(3)?,
        predicate: json(r, 4)?,
        on_trigger: vocabulary(r, 5)?,
        last_state_hash: r.get(6)?,
        expires_at: optional_time(r, 7)?,
        created_at: UnixMillis(r.get(8)?),
        updated_at: UnixMillis(r.get(9)?),
    })
}
pub(super) fn action(r: &Row<'_>) -> rusqlite::Result<PendingActionRecord> {
    Ok(PendingActionRecord {
        action_id: ActionId(r.get(0)?),
        topic_id: TopicId(r.get(1)?),
        connector_tool: r.get(2)?,
        params: json(r, 3)?,
        input_hashes: json(r, 4)?,
        idempotency_key: r.get(5)?,
        status: vocabulary(r, 6)?,
        receipt: match r.get_ref(7)? {
            rusqlite::types::ValueRef::Null => None,
            _ => Some(json(r, 7)?),
        },
        expires_at: UnixMillis(r.get(8)?),
        created_at: UnixMillis(r.get(9)?),
        updated_at: UnixMillis(r.get(10)?),
    })
}
pub(super) fn watches(
    c: &Connection,
    owner: &str,
    topic: &TopicId,
) -> Result<Vec<WatchRecord>, StoreError> {
    let mut stmt = c.prepare_cached(&format!(
        "SELECT {WATCH_FIELDS} FROM discovery_watches
         WHERE owner=?1 AND topic_id=?2 ORDER BY watch_id"
    ))?;
    Ok(stmt
        .query_map(params![owner, topic.0], watch_record)?
        .collect::<Result<_, _>>()?)
}
pub(super) fn actions(
    c: &Connection,
    owner: &str,
    topic: &TopicId,
    open_only: bool,
) -> Result<Vec<PendingActionRecord>, StoreError> {
    let visible = if open_only { "AND status!='done'" } else { "" };
    let mut stmt = c.prepare_cached(&format!(
        "SELECT {ACTION_FIELDS} FROM discovery_pending_actions
         WHERE owner=?1 AND topic_id=?2 {visible} ORDER BY action_id"
    ))?;
    Ok(stmt
        .query_map(params![owner, topic.0], action)?
        .collect::<Result<_, _>>()?)
}
impl DiscoveryStore {
    pub async fn get_source_cursor(
        &self,
        uri: SourceUri,
    ) -> Result<Option<SourceCursorRecord>, StoreError> {
        self.read(move |c, owner| {
            Ok(c.query_row(
                &format!("SELECT {CURSOR_FIELDS} FROM discovery_source_cursors WHERE owner=?1 AND source_uri=?2"),
                params![owner, uri.0], cursor,
            ).optional()?)
        }).await
    }
    pub async fn list_source_cursors(
        &self,
        limit: u32,
    ) -> Result<Vec<SourceCursorRecord>, StoreError> {
        self.read(move |c, owner| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT {CURSOR_FIELDS} FROM discovery_source_cursors
                 WHERE owner=?1 ORDER BY last_explored_at,source_uri LIMIT ?2"
            ))?;
            Ok(stmt
                .query_map(params![owner, limit], cursor)?
                .collect::<Result<_, _>>()?)
        })
        .await
    }
    /// None inserts a new cursor. Replacement requires the exact watermark previously read.
    pub async fn save_source_cursor(
        &self,
        r: SourceCursorRecord,
        expected: Option<UnixMillis>,
    ) -> Result<bool, StoreError> {
        self.data.write(self.mutation(false, move |c, owner| {
            let args = params![
                owner, r.source_uri.0, r.last_mtime_ms.0, r.last_hash, r.write_burst_count,
                r.cooldown_until.0, r.last_explored_at.0, r.updated_at.0, expected.map(|t| t.0),
            ];
            let count = if expected.is_some() {
                c.execute(
                    "UPDATE discovery_source_cursors SET last_mtime_ms=?3,last_hash=?4,write_burst_count=?5,
                         cooldown_until=?6,last_explored_at=?7,updated_at=?8
                     WHERE owner=?1 AND source_uri=?2 AND updated_at=?9 AND ?8>?9",
                    args,
                )?
            } else {
                c.execute(
                    "INSERT INTO discovery_source_cursors(owner,source_uri,last_mtime_ms,last_hash,
                         write_burst_count,cooldown_until,last_explored_at,updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(owner,source_uri) DO NOTHING",
                    &args[..8],
                )?
            };
            Ok(count == 1)
        })).await
    }
    pub async fn delete_source_cursor(&self, uri: SourceUri) -> Result<bool, StoreError> {
        self.data
            .write(self.mutation(false, move |c, owner| {
                Ok(c.execute(
                    "DELETE FROM discovery_source_cursors WHERE owner=?1 AND source_uri=?2",
                    params![owner, uri.0],
                )? == 1)
            }))
            .await
    }
    pub async fn get_watch(&self, id: WatchId) -> Result<Option<WatchRecord>, StoreError> {
        self.read(move |c, owner| {
            Ok(c.query_row(
                &format!(
                    "SELECT {WATCH_FIELDS} FROM discovery_watches WHERE owner=?1 AND watch_id=?2"
                ),
                params![owner, id.0],
                watch_record,
            )
            .optional()?)
        })
        .await
    }
    pub async fn list_watches(&self, topic: TopicId) -> Result<Vec<WatchRecord>, StoreError> {
        self.read(move |c, owner| watches(c, owner, &topic)).await
    }
    pub async fn get_pending_action(
        &self,
        id: ActionId,
    ) -> Result<Option<PendingActionRecord>, StoreError> {
        self.read(move |c, owner| {
            Ok(c.query_row(
                &format!("SELECT {ACTION_FIELDS} FROM discovery_pending_actions WHERE owner=?1 AND action_id=?2"),
                params![owner, id.0], action,
            ).optional()?)
        }).await
    }
    pub async fn list_pending_actions(
        &self,
        topic: TopicId,
    ) -> Result<Vec<PendingActionRecord>, StoreError> {
        self.read(move |c, owner| actions(c, owner, &topic, false))
            .await
    }
}
