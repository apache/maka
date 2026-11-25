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
use crate::session_history::{
    SessionHistory,
    snapshot::{IndexedRead, IndexedReadError, Snapshot, catalog as snapshot_catalog},
};
use maka_agent_facts::artifact::content_digest;
use maka_event_log::{sessions::CatalogSelection, workspace_bindings::WorkspaceBinding};
use maka_sandbox::workspace::BindingRef;
use rusqlite::{OptionalExtension, params_from_iter, types::Value as SqlValue};
use serde_json::Value;
use std::sync::LazyLock;

const BASE: &str = "WITH base AS (
 SELECT s.id,s.revision,s.created_at,max(s.updated_at,COALESCE((SELECT MAX(at) FROM agent_catalog_messages m WHERE m.owner=?1 AND m.session=s.id AND m.sequence>COALESCE(source.sequence,0)),0),COALESCE((SELECT MAX(at) FROM agent_room_messages m WHERE m.owner=?1 AND m.session=s.id),0)) AS updated_at,s.archived,s.configuration,
 b.id AS binding_id,b.workspace_json,b.permission_epoch,b.metadata_epoch,
 COALESCE(k.revision,0) AS control_revision,k.read_message,k.lineage,
 CASE WHEN room.session IS NOT NULL THEN COALESCE(a.last_sequence,0)>COALESCE(k.read_through,0)
 WHEN source.run IS NULL THEN COALESCE(a.terminal_sequence,0)>COALESCE(k.read_through,0)
 ELSE EXISTS(SELECT 1 FROM agent_catalog_runs unread_run WHERE unread_run.owner=?1 AND unread_run.session=s.id AND unread_run.admission_sequence>source.sequence AND unread_run.terminal_sequence>max(COALESCE(k.read_through,0),source.sequence)) END AS has_unread,
 COALESCE((SELECT message FROM agent_room_messages m WHERE m.owner=?1 AND m.session=s.id ORDER BY sequence DESC LIMIT 1),(SELECT message FROM agent_catalog_messages m WHERE m.owner=?1 AND m.session=s.id AND m.sequence>COALESCE(source.sequence,0) ORDER BY sequence DESC LIMIT 1)) AS tail,
 COALESCE((SELECT at FROM agent_room_messages m WHERE m.owner=?1 AND m.session=s.id ORDER BY sequence DESC LIMIT 1),(SELECT at FROM agent_catalog_messages m WHERE m.owner=?1 AND m.session=s.id AND m.sequence>COALESCE(source.sequence,0) ORDER BY sequence DESC LIMIT 1)) AS message_at,
 COALESCE((SELECT substr(COALESCE(json_extract(body_json,'$.content.display_text'),json_extract(body_json,'$.content.text')),1,160) FROM agent_room_messages m WHERE m.owner=?1 AND m.session=s.id ORDER BY sequence DESC LIMIT 1),(SELECT preview FROM agent_catalog_messages m WHERE m.owner=?1 AND m.session=s.id AND m.sequence>COALESCE(source.sequence,0) ORDER BY sequence DESC LIMIT 1)) AS preview,
 (SELECT MIN(p.created_at) FROM agent_interaction_pending p JOIN agent_interaction_requests q ON q.request=p.request
  JOIN agent_run_specs spec ON spec.run=q.run JOIN agent_catalog_runs pending_run ON pending_run.run=q.run WHERE p.session=s.id AND spec.owner=?1 AND pending_run.live=1 AND pending_run.admission_sequence>COALESCE(source.sequence,0)) AS pending_since,
 r.run,r.terminal,r.stopped,r.blocked AS run_blocked,r.unknown_effects AS run_unknown,r.cleanup_pending AS run_cleanup,r.late_sequence,
 EXISTS(SELECT 1 FROM agent_catalog_runs w WHERE w.owner=?1 AND w.session=s.id AND w.admission_sequence>COALESCE(source.sequence,0) AND w.live=1) AS working,
 EXISTS(SELECT 1 FROM agent_catalog_runs w WHERE w.owner=?1 AND w.session=s.id AND w.admission_sequence>COALESCE(source.sequence,0) AND w.blocked=1) AS blocked,
 EXISTS(SELECT 1 FROM agent_catalog_runs w WHERE w.owner=?1 AND w.session=s.id AND w.admission_sequence>COALESCE(source.sequence,0) AND w.unknown_effects=1) AS unknown_effects,
 EXISTS(SELECT 1 FROM agent_catalog_runs w WHERE w.owner=?1 AND w.session=s.id AND w.admission_sequence>COALESCE(source.sequence,0) AND w.cleanup_pending=1) AS cleanup_pending,
 EXISTS(SELECT 1 FROM agent_catalog_runs w WHERE w.owner=?1 AND w.session=s.id AND w.admission_sequence>COALESCE(source.sequence,0) AND w.late_sequence>COALESCE(k.read_through,0)) AS late_evidence,
 EXISTS(SELECT 1 FROM agent_run_specs spec WHERE spec.owner=?1 AND spec.session=s.id
   AND NOT EXISTS(SELECT 1 FROM agent_catalog_runs idx WHERE idx.run=spec.run))
 OR COALESCE((SELECT MAX(e.revision) FROM agent_catalog_events e WHERE e.owner=?1 AND e.session=s.id),0)<>COALESCE(k.revision,0) AS index_gap,
 latest_spec.schema_version AS latest_schema,
 (SELECT e.schema_version FROM agent_catalog_events e WHERE e.owner=?1 AND e.session=s.id ORDER BY revision DESC LIMIT 1) AS control_schema,
 s.catalog_unpinned AS unpinned,
 source.run AS source_run,COALESCE(source.sequence,0)>COALESCE(k.read_through,0) AS source_unread,
 room.session IS NOT NULL AS is_room,
 -max(s.created_at,COALESCE((SELECT m.at FROM agent_catalog_runs admitted
  JOIN agent_catalog_messages m ON m.owner=admitted.owner AND m.session=admitted.session AND m.sequence=admitted.admission_sequence
  WHERE admitted.owner=?1 AND admitted.session=s.id AND admitted.admission_sequence>COALESCE(source.sequence,0)
  ORDER BY admitted.admission_sequence DESC LIMIT 1),0),COALESCE((SELECT m.at FROM agent_room_messages m WHERE m.owner=?1 AND m.session=s.id ORDER BY m.sequence DESC LIMIT 1),0),COALESCE(CAST(json_extract(source_summary.summary_json,'$.summary.updatedAt') AS INTEGER),0)) AS recency
 FROM session_control s
 JOIN session_creations route ON route.session_id=s.id AND route.ready=1 AND route.visible=1
 LEFT JOIN workspace_bindings b ON b.id=json_extract(s.configuration,'$.workspace.id')
 LEFT JOIN agent_catalog_controls k ON k.owner=?1 AND k.session=s.id
 LEFT JOIN agent_rooms room ON room.owner=?1 AND room.session=s.id
 LEFT JOIN agent_session_history source ON source.sequence=(SELECT marker.sequence FROM agent_session_history marker INDEXED BY agent_session_history_historical WHERE marker.owner=?1 AND marker.session=s.id AND marker.historical=1 ORDER BY marker.sequence DESC LIMIT 1)
 LEFT JOIN agent_history_snapshot_adoptions source_adoption ON source_adoption.run=source.run
 LEFT JOIN agent_history_snapshot_catalog source_summary ON source_summary.snapshot=source_adoption.snapshot
 LEFT JOIN agent_catalog_sessions a ON a.owner=?1 AND a.session=s.id
 LEFT JOIN agent_catalog_runs r ON r.run=(SELECT run FROM agent_catalog_runs l WHERE l.owner=?1 AND l.session=s.id AND l.admission_sequence>COALESCE(source.sequence,0) ORDER BY admission_sequence DESC LIMIT 1)
 LEFT JOIN agent_run_specs latest_spec ON latest_spec.run=r.run
 WHERE s.id>=?2 AND s.id<?3 AND substr(s.id,1,length(?2))=?2
 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1)
 {CANDIDATE_FILTERS}
), selected AS (SELECT *, (pending_since IS NOT NULL) AS needs_you FROM base)";
const CANDIDATE_FILTERS: &str = "AND (?4 IS NULL OR s.id=?4)
 AND (?5 IS NULL OR json_extract(b.workspace_json,'$.path')=?5)
 AND (?6 IS NULL OR substr(s.id,1,length(?6))=?6)
 AND (?7 IS NULL OR json_extract(b.workspace_json,'$.projectId')=?7)
 AND instr(COALESCE(json_extract(s.configuration,'$.title'),''),?8)>0
 AND (?9 IS NULL OR json_extract(s.configuration,'$.parentSessionId')=?9)
 AND (?10=0 OR (?10=1 AND s.archived=0) OR (?10=2 AND s.archived=1))
 AND (?13 IS NULL OR (room.session IS NOT NULL)=?13)
 AND (?14=0
  OR (?14=1 AND (COALESCE(json_extract(k.lineage,'$.origin.side'),json_extract(k.lineage,'$.branch.side'),0)=0
   OR NOT EXISTS(SELECT 1 FROM session_control p WHERE p.id=COALESCE(json_extract(k.lineage,'$.origin.parent_session_id'),json_extract(k.lineage,'$.branch.parent_session_id'))
    AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=p.id AND d.remove_session=1))))
  OR (?14=2 AND COALESCE(json_extract(k.lineage,'$.origin.side'),json_extract(k.lineage,'$.branch.side'))=1
   AND COALESCE(json_extract(k.lineage,'$.origin.parent_session_id'),json_extract(k.lineage,'$.branch.parent_session_id'))=?15))";
const FILTER: &str =
    "(?11=0 OR json_extract(configuration,'$.parentSessionId') IS NULL) AND (?12=0 OR needs_you=1)";
const COLUMNS: &str = "id,revision,created_at,updated_at,archived,configuration,binding_id,workspace_json,permission_epoch,metadata_epoch,control_revision,read_message,lineage,has_unread,tail,message_at,preview,pending_since,run,terminal,stopped,run_blocked,run_unknown,run_cleanup,late_sequence,working,blocked,unknown_effects,cleanup_pending,late_evidence,index_gap,latest_schema,control_schema,source_run,source_unread,is_room";
const SELECTION_PARAMS: usize = 15;
const RECORD_BUCKETS: [usize; 4] = [8, 32, 128, 256];

static BASE_SQL: LazyLock<String> =
    LazyLock::new(|| BASE.replace("{CANDIDATE_FILTERS}", CANDIDATE_FILTERS));
static KEY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{} SELECT unpinned,recency,id FROM selected WHERE {FILTER} AND id=?16",
        *BASE_SQL
    )
});
// CROSS JOIN forces SQLite to drive from the small partial index
// `agent_session_history_historical` instead of scanning `agent_session_history_run`,
// while reusing the exact selection filters so unmatched snapshots are never rebuilt.
static STALE_CATALOG_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT s.id, source.run
FROM (
    SELECT session, MAX(sequence) AS sequence
    FROM agent_session_history INDEXED BY agent_session_history_historical
    WHERE owner=?1 AND historical=1
      AND session>=?2 AND session<?3 AND substr(session,1,length(?2))=?2
    GROUP BY session
) latest
CROSS JOIN session_control s ON s.id=latest.session
CROSS JOIN session_creations route ON route.session_id=s.id AND route.ready=1 AND route.visible=1
CROSS JOIN agent_session_history source
  ON source.sequence=latest.sequence AND source.owner=?1 AND source.session=latest.session
CROSS JOIN agent_history_snapshot_adoptions source_adoption ON source_adoption.run=source.run
LEFT JOIN agent_history_snapshot_catalog source_summary ON source_summary.snapshot=source_adoption.snapshot
LEFT JOIN workspace_bindings b ON b.id=json_extract(s.configuration,'$.workspace.id')
LEFT JOIN agent_catalog_controls k ON k.owner=?1 AND k.session=s.id
LEFT JOIN agent_rooms room ON room.owner=?1 AND room.session=s.id
WHERE NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1)
  AND (source_summary.snapshot IS NULL
       OR (typeof(json_extract(source_summary.summary_json,'$.version'))='integer'
           AND json_extract(source_summary.summary_json,'$.version')!=?16))
  {CANDIDATE_FILTERS}
  AND (?11=0 OR json_extract(s.configuration,'$.parentSessionId') IS NULL)
  AND (?12=0 OR EXISTS(
      SELECT 1 FROM agent_interaction_pending p
      JOIN agent_interaction_requests q ON q.request=p.request
      JOIN agent_run_specs spec ON spec.run=q.run
      JOIN agent_catalog_runs pending_run ON pending_run.run=q.run
      WHERE p.session=s.id AND spec.owner=?1 AND pending_run.live=1
        AND pending_run.admission_sequence>COALESCE(source.sequence,0)
  ))"
    )
});
static PENDING_COUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{} SELECT COUNT(*) FROM selected WHERE needs_you=1 AND ?11 IN(0,1) AND ?12 IN(0,1)",
        *BASE_SQL
    )
});
static SINGLE_RECORD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{} SELECT {COLUMNS} FROM selected WHERE {FILTER} AND id=?16",
        *BASE_SQL
    )
});
static RECORD_BUCKET_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    RECORD_BUCKETS.map(|bucket| {
        let slots = (1..=bucket)
            .map(|offset| format!("?{}", SELECTION_PARAMS + offset))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{} SELECT {COLUMNS} FROM selected WHERE {FILTER} AND id IN ({slots}) ORDER BY unpinned,recency,id",
            *BASE_SQL
        )
    })
});

#[derive(Clone)]
struct Key {
    unpinned: bool,
    recency: i64,
    id: String,
}
struct Selection {
    values: Vec<SqlValue>,
    catalog: SessionCatalog,
}
fn nullable(value: Option<String>) -> SqlValue {
    value.map_or(SqlValue::Null, Into::into)
}
impl Selection {
    fn new(
        catalog: &SessionCatalog,
        scope: &CatalogScope,
        filter: &Filter,
    ) -> Result<Self, StoreError> {
        let mut session = None;
        let mut cwd = None;
        let mut prefix = None;
        let mut project = None;
        let mut title = String::new();
        let mut parent = None;
        match scope {
            CatalogScope::Profile => {}
            CatalogScope::Session(id) => {
                catalog.check_session(id)?;
                session = Some(id.clone());
            }
            CatalogScope::Workspace(path) => cwd = Some(path.clone()),
            CatalogScope::IdPrefix(p) => prefix = Some(p.clone()),
            CatalogScope::Owned {
                id_prefix,
                selection,
                title_query,
            } => {
                prefix = Some(id_prefix.clone());
                title = title_query.clone();
                match selection {
                    CatalogSelection::All => {}
                    CatalogSelection::Children(id) => {
                        catalog.check_session(id)?;
                        parent = Some(id.clone());
                    }
                    CatalogSelection::Project(id) => project = Some(id.to_string()),
                    CatalogSelection::Workspace { session_id, path } => {
                        catalog.check_session(session_id)?;
                        cwd = Some(path.clone());
                    }
                }
            }
        }
        if let Some(prefix) = &prefix {
            maka_agent_facts::interaction::entity_id(prefix).map_err(invalid)?;
            if !prefix.starts_with(&catalog.id_prefix) {
                return Err(invalid("catalog scope broadens the native owner namespace"));
            }
        }
        if let SideQuestions::Of(parent) = &filter.side {
            catalog.check_session(parent)?;
        }
        Ok(Self {
            catalog: catalog.clone(),
            values: vec![
                catalog.owner_key()?.into(),
                catalog.id_prefix.clone().into(),
                format!("{}~", catalog.id_prefix).into(),
                nullable(session),
                nullable(cwd),
                nullable(prefix),
                nullable(project),
                title.into(),
                nullable(parent),
                (if filter.base.archived_only {
                    2i64
                } else {
                    i64::from(!filter.base.include_archived)
                })
                .into(),
                i64::from(filter.base.roots_only).into(),
                i64::from(filter.needs_you_only).into(),
                filter
                    .room
                    .map_or(SqlValue::Null, |room| i64::from(room).into()),
                match &filter.side {
                    SideQuestions::Any => 0i64,
                    SideQuestions::Hidden => 1,
                    SideQuestions::Of(_) => 2,
                }
                .into(),
                match &filter.side {
                    SideQuestions::Of(parent) => parent.clone().into(),
                    SideQuestions::Any | SideQuestions::Hidden => SqlValue::Null,
                },
            ],
        })
    }
    fn revision(
        &self,
        c: &Connection,
        scope: &CatalogScope,
        filter: &Filter,
    ) -> Result<String, StoreError> {
        let root_revision: i64 = c
            .prepare_cached("SELECT revision FROM session_catalog_revision WHERE singleton=1")?
            .query_row([], |r| r.get(0))?;
        let agent_revision: i64 = c
            .prepare_cached("SELECT revision FROM agent_catalog_revision WHERE singleton=1")?
            .query_row([], |r| r.get(0))?;
        Ok(content_digest(&serde_json::to_vec(&(
            "maka.agent-catalog.v1",
            unsigned_integer(root_revision)?,
            unsigned_integer(agent_revision)?,
            &self.catalog.owner,
            &self.catalog.id_prefix,
            scope,
            filter,
        ))?))
    }
    fn stale_catalog_sources(&self, c: &Connection) -> Result<Vec<Snapshot>, StoreError> {
        let mut values = self.values.clone();
        values.push(i64::from(snapshot_catalog::VERSION).into());
        let rows: Vec<(String, String)> = c
            .prepare_cached(&STALE_CATALOG_SQL)?
            .query_map(params_from_iter(values), |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let mut stale = Vec::with_capacity(rows.len());
        for (session, run) in rows {
            let marker: RunId = serde_json::from_value(Value::String(run))?;
            let history = SessionHistory::new(
                self.catalog.data.clone(),
                self.catalog.owner.clone(),
                session,
            );
            stale.push(history.catalog_source_in_snapshot(c, marker)?);
        }
        Ok(stale)
    }
    fn key(&self, c: &Connection, id: &str) -> Result<Option<Key>, StoreError> {
        let mut values = self.values.clone();
        values.push(id.to_owned().into());
        Ok(c.prepare_cached(&KEY_SQL)?
            .query_row(params_from_iter(values), |r| {
                Ok(Key {
                    unpinned: r.get(0)?,
                    recency: r.get(1)?,
                    id: r.get(2)?,
                })
            })
            .optional()?)
    }
    fn keys(
        &self,
        c: &Connection,
        key: Option<&Key>,
        operator: &str,
        reverse: bool,
        limit: u32,
    ) -> Result<Vec<Key>, StoreError> {
        let mut values = self.values.clone();
        let position = if let Some(key) = key {
            values.extend([
                i64::from(key.unpinned).into(),
                key.recency.into(),
                key.id.clone().into(),
            ]);
            format!("AND (unpinned,recency,id){operator}(?16,?17,?18)")
        } else {
            String::new()
        };
        values.push(i64::from(limit).into());
        let limit_parameter = values.len();
        let order = if reverse { "DESC" } else { "ASC" };
        let sql = format!(
            "{} SELECT unpinned,recency,id FROM selected WHERE {FILTER} {position} ORDER BY unpinned {order},recency {order},id {order} LIMIT ?{limit_parameter}",
            *BASE_SQL
        );
        let mut keys = c
            .prepare_cached(&sql)?
            .query_map(params_from_iter(values), |r| {
                Ok(Key {
                    unpinned: r.get(0)?,
                    recency: r.get(1)?,
                    id: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if reverse {
            keys.reverse();
        }
        Ok(keys)
    }
    fn records(&self, c: &Connection, keys: &[Key]) -> Result<Vec<Record>, IndexedReadError> {
        if keys.is_empty() {
            return Ok(vec![]);
        }
        let mut values = self.values.clone();
        let rows = if keys.len() == 1 {
            values.push(keys[0].id.clone().into());
            c.prepare_cached(&SINGLE_RECORD_SQL)?
                .query_map(params_from_iter(values), Raw::read)?
                .collect::<Result<Vec<_>, _>>()?
        } else if let Some(index) = RECORD_BUCKETS
            .iter()
            .position(|&bucket| keys.len() <= bucket)
        {
            let bucket = RECORD_BUCKETS[index];
            values.reserve(bucket);
            for key in keys {
                values.push(key.id.clone().into());
            }
            values.resize(SELECTION_PARAMS + bucket, SqlValue::Null);
            c.prepare_cached(&RECORD_BUCKET_SQL[index])?
                .query_map(params_from_iter(values), Raw::read)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            let mut slots = Vec::with_capacity(keys.len());
            for key in keys {
                values.push(key.id.clone().into());
                slots.push(format!("?{}", values.len()));
            }
            let sql = format!(
                "{} SELECT {COLUMNS} FROM selected WHERE {FILTER} AND id IN ({}) ORDER BY unpinned,recency,id",
                *BASE_SQL,
                slots.join(",")
            );
            c.prepare(&sql)?
                .query_map(params_from_iter(values), Raw::read)?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut records = Vec::with_capacity(rows.len());
        let mut stale = Vec::new();
        for mut raw in rows {
            let marker = raw
                .source_run
                .take()
                .map(|run| serde_json::from_value(Value::String(run)))
                .transpose()?;
            let source_unread = raw.source_unread;
            match planned::overlay(c, &self.catalog, raw.decode()?, marker, source_unread) {
                Ok(record) => records.push(record),
                Err(IndexedReadError::NeedsRebuild(snapshots)) => stale.extend(snapshots),
                Err(IndexedReadError::Store(error)) => return Err(IndexedReadError::Store(error)),
            }
        }
        if !stale.is_empty() {
            return Err(IndexedReadError::NeedsRebuild(stale));
        }
        Ok(records)
    }
    fn pending_count(&self, c: &Connection) -> Result<u64, StoreError> {
        let count: i64 = c
            .prepare_cached(&PENDING_COUNT_SQL)?
            .query_row(params_from_iter(self.values.iter()), |r| r.get(0))?;
        unsigned_integer(count)
    }
}

struct Raw {
    id: String,
    revision: i64,
    created: i64,
    updated: i64,
    archived: bool,
    configuration: String,
    binding_id: Option<String>,
    workspace: Option<String>,
    permission_epoch: Option<i64>,
    metadata_epoch: Option<i64>,
    control_revision: i64,
    read_message: Option<String>,
    lineage: Option<String>,
    unread: bool,
    tail: Option<String>,
    message_at: Option<i64>,
    preview: Option<String>,
    pending_since: Option<i64>,
    run: Option<String>,
    terminal: Option<String>,
    stopped: Option<bool>,
    run_blocked: Option<bool>,
    run_unknown: Option<bool>,
    run_cleanup: Option<bool>,
    late_sequence: Option<i64>,
    working: bool,
    blocked: bool,
    unknown: bool,
    cleanup: bool,
    late: bool,
    index_gap: bool,
    latest_schema: Option<u32>,
    control_schema: Option<u32>,
    source_run: Option<String>,
    source_unread: bool,
    is_room: bool,
}
impl Raw {
    fn read(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            revision: r.get(1)?,
            created: r.get(2)?,
            updated: r.get(3)?,
            archived: r.get(4)?,
            configuration: r.get(5)?,
            binding_id: r.get(6)?,
            workspace: r.get(7)?,
            permission_epoch: r.get(8)?,
            metadata_epoch: r.get(9)?,
            control_revision: r.get(10)?,
            read_message: r.get(11)?,
            lineage: r.get(12)?,
            unread: r.get(13)?,
            tail: r.get(14)?,
            message_at: r.get(15)?,
            preview: r.get(16)?,
            pending_since: r.get(17)?,
            run: r.get(18)?,
            terminal: r.get(19)?,
            stopped: r.get(20)?,
            run_blocked: r.get(21)?,
            run_unknown: r.get(22)?,
            run_cleanup: r.get(23)?,
            late_sequence: r.get(24)?,
            working: r.get(25)?,
            blocked: r.get(26)?,
            unknown: r.get(27)?,
            cleanup: r.get(28)?,
            late: r.get(29)?,
            index_gap: r.get(30)?,
            latest_schema: r.get(31)?,
            control_schema: r.get(32)?,
            source_run: r.get(33)?,
            source_unread: r.get(34)?,
            is_room: r.get(35)?,
        })
    }
    fn decode(self) -> Result<Record, StoreError> {
        if self.index_gap {
            return Err(invalid(
                "Agent catalog index absent; explicit rebuild required",
            ));
        }
        if self
            .latest_schema
            .is_some_and(|schema| schema != SCHEMA_VERSION)
        {
            return Err(invalid("unsupported catalog Run schema"));
        }
        if self
            .control_schema
            .is_some_and(|schema| schema != CATALOG_SCHEMA_VERSION)
        {
            return Err(invalid("unsupported catalog decision schema"));
        }
        let configuration: Value = serde_json::from_str(&self.configuration)?;
        let binding = match (
            self.binding_id,
            self.workspace,
            self.permission_epoch,
            self.metadata_epoch,
        ) {
            (Some(id), Some(workspace), Some(permission_epoch), Some(metadata_epoch)) => {
                Some(WorkspaceBinding {
                    id: uuid::Uuid::parse_str(&id)
                        .map_err(|_| invalid("invalid catalog binding identity"))?,
                    workspace: serde_json::from_str(&workspace)?,
                    permission_epoch: unsigned_integer(permission_epoch)?,
                    metadata_epoch: unsigned_integer(metadata_epoch)?,
                })
            }
            (None, None, None, None) => None,
            _ => return Err(invalid("incomplete catalog workspace binding")),
        };
        let local_revision = unsigned_integer(self.revision)?;
        let revision = match (configuration.get("workspace"), binding.as_ref()) {
            (Some(value), Some(binding)) => {
                let reference: BindingRef = serde_json::from_value(value.clone())?;
                reference.validate().map_err(invalid)?;
                if reference.id != binding.id {
                    return Err(StoreError::EventConflict);
                }
                reference
                    .boundary_revision(0, binding.stamp())
                    .map_err(invalid)?;
                reference
                    .session_revision(local_revision, binding.metadata_epoch)
                    .map_err(invalid)?
            }
            (None, None) => local_revision,
            _ => return Err(invalid("catalog Session binding unavailable")),
        };
        let latest = self
            .run
            .map(|run| -> Result<RunStatus, StoreError> {
                Ok(RunStatus {
                    run: serde_json::from_value(Value::String(run))?,
                    terminal: self
                        .terminal
                        .map(|s| serde_json::from_str(&s))
                        .transpose()?,
                    stopped: self
                        .stopped
                        .ok_or_else(|| invalid("Run stopped index absent"))?,
                    blocked: self
                        .run_blocked
                        .ok_or_else(|| invalid("Run blocker index absent"))?,
                    unknown_effects: self
                        .run_unknown
                        .ok_or_else(|| invalid("Run effect index absent"))?,
                    cleanup_pending: self
                        .run_cleanup
                        .ok_or_else(|| invalid("Run cleanup index absent"))?,
                    late_sequence: unsigned_integer(
                        self.late_sequence
                            .ok_or_else(|| invalid("Run late index absent"))?,
                    )?,
                })
            })
            .transpose()?;
        let last_message = match (self.tail, self.message_at) {
            (Some(tail_message_id), Some(recorded_at)) => Some(Message {
                tail_message_id,
                recorded_at: unsigned_integer(recorded_at)?,
                preview: self.preview,
            }),
            (None, None) => None,
            _ => return Err(invalid("catalog message index incomplete")),
        };
        Ok(Record {
            is_room: self.is_room,
            metadata: SessionRecord {
                id: self.id,
                revision,
                created_at: unsigned_integer(self.created)?,
                updated_at: unsigned_integer(self.updated)?
                    .max(last_message.as_ref().map_or(0, |m| m.recorded_at)),
                archived: self.archived,
                configuration,
                workspace_binding: binding,
                configuration_digest: content_digest(self.configuration.as_bytes()),
            },
            control_revision: unsigned_integer(self.control_revision)?,
            status: Status {
                latest,
                working: self.working,
                blocked: self.blocked,
                unknown_effects: self.unknown,
                cleanup_pending: self.cleanup,
                late_evidence: self.late,
                pending_interaction_since: self.pending_since.map(unsigned_integer).transpose()?,
            },
            read_state: ReadState {
                has_unread: self.unread || self.late,
                last_read_message_id: self.read_message,
            },
            last_message,
            lineage: self.lineage.map(|s| serde_json::from_str(&s)).transpose()?,
        })
    }
}

pub(super) fn revision(
    c: &Connection,
    catalog: &SessionCatalog,
    scope: &CatalogScope,
    filter: &Filter,
) -> Result<String, StoreError> {
    Selection::new(catalog, scope, filter)?.revision(c, scope, filter)
}

pub(super) fn page(c: &Connection, read: ReadPage) -> Result<IndexedRead<Page>, StoreError> {
    if !(1..=256).contains(&read.limit) {
        return Err(invalid("catalog page size must be 1..=256"));
    }
    let selection = Selection::new(&read.catalog, &read.scope, &read.filter)?;
    let cursor = match &read.position {
        Position::Start => None,
        Position::At(id) | Position::After(id) | Position::Before(id) => {
            read.catalog.check_session(id)?;
            Some(id)
        }
    };
    if matches!(read.position, Position::After(_) | Position::Before(_))
        && read.expected_revision.is_none()
    {
        return Err(invalid("catalog continuation requires original revision"));
    }
    let revision = selection.revision(c, &read.scope, &read.filter)?;
    if let Some(expected) = read.expected_revision
        && expected != revision
    {
        return Err(StoreError::RevisionConflict {
            expected,
            actual: revision,
        });
    }
    // Single-session reads need no cross-session recency sort; selection.records checks that session directly.
    if !matches!(read.scope, CatalogScope::Session(_)) {
        let stale = selection.stale_catalog_sources(c)?;
        if !stale.is_empty() {
            return Ok(IndexedRead::NeedsRebuild(stale));
        }
    }
    let anchor = cursor.map(|id| selection.key(c, id)).transpose()?.flatten();
    let reverse = matches!(read.position, Position::Before(_));
    let operator = if reverse {
        "<"
    } else if matches!(read.position, Position::At(_)) {
        ">="
    } else {
        ">"
    };
    let mut keys = selection.keys(c, anchor.as_ref(), operator, reverse, read.limit)?;
    if keys.is_empty() && matches!(read.position, Position::At(_)) && anchor.is_some() {
        keys = selection.keys(c, anchor.as_ref(), "<", true, read.limit)?;
    }
    let previous_cursor = if let Some(first) = keys.first() {
        (!selection.keys(c, Some(first), "<", true, 1)?.is_empty()).then(|| first.id.clone())
    } else {
        None
    };
    let next_cursor = if let Some(last) = keys.last() {
        (!selection.keys(c, Some(last), ">", false, 1)?.is_empty()).then(|| last.id.clone())
    } else {
        None
    };
    let sessions = match selection.records(c, &keys) {
        Ok(sessions) => sessions,
        Err(IndexedReadError::NeedsRebuild(snapshots)) => {
            return Ok(IndexedRead::NeedsRebuild(snapshots));
        }
        Err(IndexedReadError::Store(error)) => return Err(error),
    };
    let pending_session_count = selection.pending_count(c)?;
    Ok(IndexedRead::Ready(Page {
        revision,
        sessions,
        pending_session_count,
        next_cursor,
        previous_cursor,
    }))
}

pub(crate) fn records_in_snapshot(
    c: &Connection,
    catalog: &SessionCatalog,
    ids: &[String],
) -> Result<Vec<Record>, IndexedReadError> {
    let read = ReadPage {
        catalog: catalog.clone(),
        scope: CatalogScope::Profile,
        expected_revision: None,
        position: Position::Start,
        filter: Filter {
            base: CatalogFilter {
                roots_only: false,
                archived_only: false,
                include_archived: true,
            },
            needs_you_only: false,
            room: None,
            side: SideQuestions::Any,
        },
        limit: 128,
    };
    let selected = Selection::new(&read.catalog, &read.scope, &read.filter)?;
    let mut records = Vec::new();
    let mut stale = Vec::new();
    for chunk in ids.chunks(128) {
        for id in chunk {
            catalog.check_session(id)?;
        }
        let keys = chunk
            .iter()
            .map(|id| Key {
                unpinned: false,
                recency: 0,
                id: id.clone(),
            })
            .collect::<Vec<_>>();
        match selected.records(c, &keys) {
            Ok(chunk_records) => records.extend(chunk_records),
            Err(IndexedReadError::NeedsRebuild(snapshots)) => stale.extend(snapshots),
            Err(IndexedReadError::Store(error)) => return Err(IndexedReadError::Store(error)),
        }
    }
    if !stale.is_empty() {
        return Err(IndexedReadError::NeedsRebuild(stale));
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_event_log::{
        RootStore,
        root::{RootNamespaces, RootOwner},
    };
    use std::sync::Arc;
    use uuid::Uuid;

    struct SeedSessions(i64);
    impl Statement for SeedSessions {
        type Output = ();
        type Value = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            for i in 1..=self.0 {
                let id = format!("sess-{i:02}");
                let ts = 1_000 + i;
                c.execute(
                    "INSERT INTO session_control(id,fingerprint,revision,created_at,updated_at,archived,configuration) VALUES(?1,?2,1,?3,?3,0,'{}')",
                    rusqlite::params![id, format!("fp-{i:02}"), ts],
                )?;
                c.execute(
                    "INSERT INTO session_creations(session_id,creation_id,fingerprint,command,ready,visible) VALUES(?1,?2,?3,NULL,1,1)",
                    rusqlite::params![id, format!("create-{i:02}"), format!("fp-{i:02}")],
                )?;
            }
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::default(),
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }

    async fn seeded(
        dir: &std::path::Path,
        sessions: i64,
    ) -> (RootStore, DataWriter, SessionCatalog) {
        let ns = RootNamespaces {
            ownership: dir.join("owners"),
            control: dir.join("control"),
        };
        let owner = Arc::new(RootOwner::create(&dir.join("root"), &ns).unwrap());
        let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        let root = RootStore::open(owner, &migrations).await.unwrap();
        let data = root.data_writer().unwrap();
        data.write(SeedSessions(sessions)).await.unwrap();

        let run_owner: RunOwner = serde_json::from_value(serde_json::json!({
            "deployment": Uuid::now_v7(),
            "namespace": []
        }))
        .unwrap();
        let catalog = SessionCatalog::new(data.clone(), run_owner, "sess-".into()).unwrap();
        (root, data, catalog)
    }

    #[tokio::test]
    async fn catalog_pages_across_sizes_return_exact_records_with_bounded_statement_cache() {
        let dir = tempfile::tempdir().unwrap();
        let (root, _, catalog) = seeded(dir.path(), 10).await;
        let filter = Filter {
            base: CatalogFilter {
                roots_only: false,
                archived_only: false,
                include_archived: true,
            },
            needs_you_only: false,
            room: None,
            side: SideQuestions::Any,
        };

        let expected: Vec<String> = (1..=10).rev().map(|i| format!("sess-{i:02}")).collect();
        for limit in [1u32, 2, 3, 5, 7, 8, 9, 10] {
            let page = catalog
                .page(
                    CatalogScope::Profile,
                    None,
                    Position::Start,
                    filter.clone(),
                    limit,
                )
                .await
                .unwrap();
            let got: Vec<String> = page
                .sessions
                .iter()
                .map(|s| s.metadata.id.clone())
                .collect();
            assert_eq!(got, expected[..limit as usize], "limit={limit}");
            assert_eq!(page.pending_session_count, 0);
        }

        let anchored = catalog
            .page(
                CatalogScope::Profile,
                None,
                Position::At("sess-06".into()),
                filter,
                4,
            )
            .await
            .unwrap();
        let anchored_ids: Vec<String> = anchored
            .sessions
            .iter()
            .map(|s| s.metadata.id.clone())
            .collect();
        assert_eq!(
            anchored_ids,
            vec!["sess-06", "sess-05", "sess-04", "sess-03"]
        );

        let stats = root.sqlite_resource_stats().await.unwrap();
        let reader_stats: Vec<_> = stats.readers.iter().flatten().collect();
        assert!(!reader_stats.is_empty());
        let mut saw_single_record_query = false;
        for reader in &reader_stats {
            let record_queries = reader
                .statements
                .iter()
                .filter(|s| {
                    s.sql
                        .as_deref()
                        .is_some_and(|sql| sql.contains("AND id IN ("))
                })
                .count();
            assert!(
                record_queries <= 2,
                "expected at most 2 bucketed IN queries for limits 1..=10, got {record_queries}"
            );
            saw_single_record_query |= reader.statements.iter().any(|s| {
                s.sql
                    .as_deref()
                    .is_some_and(|sql| sql.ends_with("AND id=?16") && sql.contains(COLUMNS))
            });
        }
        assert!(saw_single_record_query);
        root.close().await.unwrap();
    }

    /// Branches of other sessions, and the removal of one parent.
    struct SeedBranches(String);
    impl Statement for SeedBranches {
        type Output = ();
        type Value = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            use maka_agent_facts::session::{BranchOrigin, ForkPosition, Lineage};
            for (session, parent, side) in [
                ("sess-02", "sess-01", true),
                ("sess-03", "sess-01", false),
                ("sess-04", "sess-05", true),
            ] {
                let lineage = Lineage::Branch {
                    origin: BranchOrigin {
                        parent_session_id: parent.into(),
                        position: ForkPosition::End,
                        side,
                    },
                };
                c.execute(
                    "INSERT INTO agent_catalog_controls(owner,session,revision,lineage) VALUES(?1,?2,0,?3)",
                    rusqlite::params![self.0, session, serde_json::to_string(&lineage)?],
                )?;
            }
            // Explicit `"side": false` must still read as an ordinary branch.
            let explicit_false = serde_json::json!({
                "kind": "branch",
                "origin": {
                    "parent_session_id": "sess-01",
                    "position": { "kind": "end" },
                    "side": false
                }
            })
            .to_string();
            c.execute(
                "INSERT INTO agent_catalog_controls(owner,session,revision,lineage) VALUES(?1,'sess-06',0,?2)",
                rusqlite::params![self.0, explicit_false],
            )?;
            c.execute(
                "INSERT INTO session_retirements(session_id,remove_session,completed) VALUES('sess-05',1,0)",
                [],
            )?;
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::default(),
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn side_questions_are_listed_under_their_parent_until_it_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let (root, data, catalog) = seeded(dir.path(), 6).await;
        data.write(SeedBranches(catalog.owner_key().unwrap()))
            .await
            .unwrap();
        let pages = async |side: SideQuestions, limit: u32| {
            let filter = Filter {
                base: CatalogFilter {
                    roots_only: false,
                    archived_only: false,
                    include_archived: true,
                },
                needs_you_only: false,
                room: None,
                side,
            };
            let mut revision = None;
            let mut position = Position::Start;
            let mut chunks = Vec::new();
            loop {
                let page = catalog
                    .page(
                        CatalogScope::Profile,
                        revision.clone(),
                        position,
                        filter.clone(),
                        limit,
                    )
                    .await
                    .unwrap();
                chunks.push(
                    page.sessions
                        .into_iter()
                        .map(|record| record.metadata.id)
                        .collect::<Vec<_>>(),
                );
                let Some(cursor) = page.next_cursor else {
                    break;
                };
                revision = Some(page.revision);
                position = Position::After(cursor);
            }
            chunks
        };
        // sess-05 is removed, so its side question sess-04 returns to ordinary
        // lists; hidden sess-02 takes no room in a 2-item page.
        assert_eq!(
            pages(SideQuestions::Hidden, 2).await,
            vec![vec!["sess-06", "sess-04"], vec!["sess-03", "sess-01"]]
        );
        // Ordinary branches (omitted or explicit side=false) stay out of Of().
        assert_eq!(
            pages(SideQuestions::Of("sess-01".into()), 2).await,
            vec![vec!["sess-02"]]
        );
        assert_eq!(
            pages(SideQuestions::Any, 32).await,
            vec![vec!["sess-06", "sess-04", "sess-03", "sess-02", "sess-01"]]
        );
        root.close().await.unwrap();
    }
}
