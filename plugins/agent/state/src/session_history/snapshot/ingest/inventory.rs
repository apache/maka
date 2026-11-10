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

impl Snapshot {
    pub async fn artifact_record(
        &self,
        session: String,
        id: String,
    ) -> Result<Option<PublishedArtifact>, StoreError> {
        self.data
            .query(ArtifactRecord {
                snapshot: self.clone(),
                session,
                id,
            })
            .await
    }
    pub async fn inventory_entries(
        &self,
        after: Option<u64>,
        limit: u32,
    ) -> Result<(Vec<(u64, Entry)>, Option<u64>), StoreError> {
        self.data
            .query(Entries {
                snapshot: self.clone(),
                scope: None,
                after,
                limit,
            })
            .await
    }
    pub async fn artifact_entries(
        &self,
        owner: RunOwner,
        session: String,
        after: Option<u64>,
        limit: u32,
    ) -> Result<(Vec<(u64, Entry)>, Option<u64>), StoreError> {
        self.data
            .query(Entries {
                snapshot: self.clone(),
                scope: Some((Some(owner), session)),
                after,
                limit,
            })
            .await
    }
    /// Original media scopes remain metadata inside this actual Snapshot; this
    /// does not create a current ArtifactStore owner from a serialized locator.
    pub async fn artifact_records(
        &self,
        session: String,
        after: Option<u64>,
        limit: u32,
    ) -> Result<(Vec<(u64, Entry)>, Option<u64>), StoreError> {
        self.data
            .query(Entries {
                snapshot: self.clone(),
                scope: Some((None, session)),
                after,
                limit,
            })
            .await
    }
}
struct ArtifactRecord {
    snapshot: Snapshot,
    session: String,
    id: String,
}
impl Query for ArtifactRecord {
    type Output = Option<PublishedArtifact>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        read::authorize(c, &self.snapshot)?;
        let mut statement=c.prepare_cached("SELECT DISTINCT json_extract(entry_json,'$.owner'),json_extract(entry_json,'$.record') FROM agent_history_snapshot_entries WHERE snapshot=?1 AND kind='artifact' AND json_extract(entry_json,'$.session')=?2 AND json_extract(entry_json,'$.record.artifact.id')=?3 LIMIT 2")?;
        let mut rows =
            statement.query(params![self.snapshot.id.to_string(), self.session, self.id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let encoded: String = row.get(1)?;
        let record = serde_json::from_str(&encoded)?;
        if rows.next()?.is_some() {
            return Err(invalid(
                "historical artifact has ambiguous original scopes or records",
            ));
        }
        Ok(Some(record))
    }
}
struct Entries {
    snapshot: Snapshot,
    scope: Option<(Option<RunOwner>, String)>,
    after: Option<u64>,
    limit: u32,
}
impl Query for Entries {
    type Output = (Vec<(u64, Entry)>, Option<u64>);
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        read::authorize(c, &self.snapshot)?;
        let limit = super::super::super::sql::limit(self.limit)?;
        let after = self.after.map(bind_u64).transpose()?.unwrap_or(-1);
        let (sql, values) = match &self.scope {
            None => (
                "SELECT ordinal,entry_json FROM agent_history_snapshot_entries WHERE snapshot=?1 AND ordinal>?2 ORDER BY ordinal LIMIT ?3",
                vec![
                    rusqlite::types::Value::Text(self.snapshot.id.to_string()),
                    after.into(),
                    i64::from(limit + 1).into(),
                ],
            ),
            Some((Some(owner), session)) => (
                "SELECT ordinal,entry_json FROM agent_history_snapshot_entries WHERE snapshot=?1 AND kind='artifact' AND json_extract(entry_json,'$.owner')=?2 AND json_extract(entry_json,'$.session')=?3 AND ordinal>?4 ORDER BY ordinal LIMIT ?5",
                vec![
                    self.snapshot.id.to_string().into(),
                    serde_json::to_string(owner)?.into(),
                    session.clone().into(),
                    after.into(),
                    i64::from(limit + 1).into(),
                ],
            ),
            Some((None, session)) => (
                "SELECT ordinal,entry_json FROM agent_history_snapshot_entries WHERE snapshot=?1 AND kind='artifact' AND json_extract(entry_json,'$.session')=?2 AND ordinal>?3 ORDER BY ordinal LIMIT ?4",
                vec![
                    self.snapshot.id.to_string().into(),
                    session.clone().into(),
                    after.into(),
                    i64::from(limit + 1).into(),
                ],
            ),
        };
        let mut entries = c
            .prepare_cached(sql)?
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((read_u64(row, 0)?, row.get::<_, String>(1)?))
            })?
            .map(|row| {
                let (ordinal, encoded) = row?;
                let entry: Entry = serde_json::from_str(&encoded)?;
                Ok((ordinal, entry))
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        let more = entries.len() > limit as usize;
        entries.truncate(limit as usize);
        let next = if more {
            entries.last().map(|(ordinal, _)| *ordinal)
        } else {
            None
        };
        Ok((entries, next))
    }
}
