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
use maka_agent_facts::artifact::content_digest;
use maka_event_log::{sessions::CatalogSelection, workspace_bindings::WorkspaceBinding};
use maka_sandbox::workspace::BindingRef;
use rusqlite::{OptionalExtension, params_from_iter, types::Value as SqlValue};
use serde_json::Value;

const BASE: &str = "WITH base AS (
 SELECT s.id,s.revision,s.created_at,max(s.updated_at,COALESCE((SELECT MAX(at) FROM agent_catalog_messages m WHERE m.owner=?1 AND m.session=s.id AND m.sequence>COALESCE(source.sequence,0)),0)) AS updated_at,s.archived,s.configuration,
 b.id AS binding_id,b.workspace_json,b.permission_epoch,b.metadata_epoch,
 COALESCE(k.revision,0) AS control_revision,k.read_message,k.lineage,
 CASE WHEN source.run IS NULL THEN COALESCE(a.terminal_sequence,0)>COALESCE(k.read_through,0)
 ELSE EXISTS(SELECT 1 FROM agent_catalog_runs unread_run WHERE unread_run.owner=?1 AND unread_run.session=s.id AND unread_run.admission_sequence>source.sequence AND unread_run.terminal_sequence>max(COALESCE(k.read_through,0),source.sequence)) END AS has_unread,
 (SELECT message FROM agent_catalog_messages m WHERE m.owner=?1 AND m.session=s.id AND m.sequence>COALESCE(source.sequence,0) ORDER BY sequence DESC LIMIT 1) AS tail,
 (SELECT at FROM agent_catalog_messages m WHERE m.owner=?1 AND m.session=s.id AND m.sequence>COALESCE(source.sequence,0) ORDER BY sequence DESC LIMIT 1) AS message_at,
 (SELECT preview FROM agent_catalog_messages m WHERE m.owner=?1 AND m.session=s.id AND m.sequence>COALESCE(source.sequence,0) ORDER BY sequence DESC LIMIT 1) AS preview,
 (SELECT MIN(p.created_at) FROM agent_interaction_pending p JOIN agent_interaction_requests q ON q.request=p.request
  JOIN agent_run_specs spec ON spec.run=q.run JOIN agent_catalog_runs pending_run ON pending_run.run=q.run WHERE p.session=s.id AND spec.owner=?1 AND pending_run.admission_sequence>COALESCE(source.sequence,0)) AS pending_since,
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
 -max(s.created_at,COALESCE((SELECT MAX(at) FROM agent_catalog_messages m WHERE m.owner=?1 AND m.session=s.id AND m.sequence>COALESCE(source.sequence,0)),0),COALESCE(CAST(json_extract(source_summary.summary_json,'$.summary.updatedAt') AS INTEGER),0)) AS recency
 FROM session_control s
 JOIN session_creations route ON route.session_id=s.id AND route.ready=1 AND route.visible=1
 LEFT JOIN workspace_bindings b ON b.id=json_extract(s.configuration,'$.workspace.id')
 LEFT JOIN agent_catalog_controls k ON k.owner=?1 AND k.session=s.id
 LEFT JOIN agent_session_history source ON source.sequence=(SELECT marker.sequence FROM agent_session_history marker INDEXED BY agent_session_history_historical WHERE marker.owner=?1 AND marker.session=s.id AND marker.historical=1 ORDER BY marker.sequence DESC LIMIT 1)
 LEFT JOIN agent_history_snapshot_adoptions source_adoption ON source_adoption.run=source.run
 LEFT JOIN agent_history_snapshot_catalog source_summary ON source_summary.snapshot=source_adoption.snapshot
 LEFT JOIN agent_catalog_sessions a ON a.owner=?1 AND a.session=s.id
 LEFT JOIN agent_catalog_runs r ON r.run=(SELECT run FROM agent_catalog_runs l WHERE l.owner=?1 AND l.session=s.id AND l.admission_sequence>COALESCE(source.sequence,0) ORDER BY admission_sequence DESC LIMIT 1)
 LEFT JOIN agent_run_specs latest_spec ON latest_spec.run=r.run
 WHERE s.id>=?2 AND s.id<?3 AND substr(s.id,1,length(?2))=?2
 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1)
 AND (?4 IS NULL OR s.id=?4)
 AND (?5 IS NULL OR json_extract(b.workspace_json,'$.path')=?5)
 AND (?6 IS NULL OR substr(s.id,1,length(?6))=?6)
 AND (?7 IS NULL OR json_extract(b.workspace_json,'$.projectId')=?7)
 AND (?8 IS NULL OR json_extract(b.workspace_json,'$.identity')=?8)
 AND instr(COALESCE(json_extract(s.configuration,'$.title'),''),?9)>0
 AND (?10 IS NULL OR json_extract(s.configuration,'$.parentSessionId')=?10)
 AND (?11=0 OR (?11=1 AND s.archived=0) OR (?11=2 AND s.archived=1))
), selected AS (SELECT *, (pending_since IS NOT NULL OR blocked) AS needs_you FROM base)";
const FILTER: &str =
    "(?12=0 OR json_extract(configuration,'$.parentSessionId') IS NULL) AND (?13=0 OR needs_you=1)";
const COLUMNS: &str = "id,revision,created_at,updated_at,archived,configuration,binding_id,workspace_json,permission_epoch,metadata_epoch,control_revision,read_message,lineage,has_unread,tail,message_at,preview,pending_since,run,terminal,stopped,run_blocked,run_unknown,run_cleanup,late_sequence,working,blocked,unknown_effects,cleanup_pending,late_evidence,index_gap,latest_schema,control_schema,source_run,source_unread";

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
        let mut identity = None;
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
                    CatalogSelection::Workspace {
                        session_id,
                        identity: id,
                    } => {
                        catalog.check_session(session_id)?;
                        identity = Some(String::from(id.clone()));
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
                nullable(identity),
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
            ],
        })
    }
    fn revision(
        &self,
        c: &Connection,
        scope: &CatalogScope,
        filter: &Filter,
    ) -> Result<String, StoreError> {
        let root_revision: i64 = c.query_row(
            "SELECT revision FROM session_catalog_revision WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        let agent_revision: i64 = c.query_row(
            "SELECT revision FROM agent_catalog_revision WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
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
    fn key(&self, c: &Connection, id: &str) -> Result<Option<Key>, StoreError> {
        let mut values = self.values.clone();
        values.push(id.to_owned().into());
        let sql =
            format!("{BASE} SELECT unpinned,recency,id FROM selected WHERE {FILTER} AND id=?14");
        Ok(c.query_row(&sql, params_from_iter(values), |r| {
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
            format!("AND (unpinned,recency,id){operator}(?14,?15,?16)")
        } else {
            String::new()
        };
        values.push(i64::from(limit).into());
        let limit_parameter = values.len();
        let order = if reverse { "DESC" } else { "ASC" };
        let sql = format!(
            "{BASE} SELECT unpinned,recency,id FROM selected WHERE {FILTER} {position} ORDER BY unpinned {order},recency {order},id {order} LIMIT ?{limit_parameter}"
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
    fn records(&self, c: &Connection, keys: &[Key]) -> Result<Vec<Record>, StoreError> {
        if keys.is_empty() {
            return Ok(vec![]);
        }
        let mut values = self.values.clone();
        let mut slots = Vec::new();
        for key in keys {
            values.push(key.id.clone().into());
            slots.push(format!("?{}", values.len()));
        }
        let sql = format!(
            "{BASE} SELECT {COLUMNS} FROM selected WHERE {FILTER} AND id IN ({}) ORDER BY unpinned,recency,id",
            slots.join(",")
        );
        let rows = c
            .prepare_cached(&sql)?
            .query_map(params_from_iter(values), Raw::read)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|mut raw| {
                let marker = raw
                    .source_run
                    .take()
                    .map(|run| serde_json::from_value(Value::String(run)))
                    .transpose()?;
                let source_unread = raw.source_unread;
                planned::overlay(c, &self.catalog, raw.decode()?, marker, source_unread)
            })
            .collect()
    }
    fn pending_count(&self, c: &Connection) -> Result<u64, StoreError> {
        let sql = format!(
            "{BASE} SELECT COUNT(*) FROM selected WHERE needs_you=1 AND ?12 IN(0,1) AND ?13 IN(0,1)"
        );
        let count: i64 = c.query_row(&sql, params_from_iter(self.values.iter()), |r| r.get(0))?;
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

pub(super) fn page(c: &Connection, read: ReadPage) -> Result<Page, StoreError> {
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
    let sessions = selection.records(c, &keys)?;
    let pending_session_count = selection.pending_count(c)?;
    Ok(Page {
        revision,
        sessions,
        pending_session_count,
        next_cursor,
        previous_cursor,
    })
}

pub(crate) fn records_in_snapshot(
    c: &Connection,
    catalog: &SessionCatalog,
    ids: &[String],
) -> Result<Vec<Record>, StoreError> {
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
        },
        limit: 128,
    };
    let selected = Selection::new(&read.catalog, &read.scope, &read.filter)?;
    let mut records = Vec::new();
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
        records.extend(selected.records(c, &keys)?);
    }
    Ok(records)
}
