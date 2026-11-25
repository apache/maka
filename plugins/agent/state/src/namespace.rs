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
use maka_agent_facts::durable::RunOwner;
use maka_event_log::StoreError;
use rusqlite::{
    Connection, OptionalExtension, ToSql, params,
    types::{FromSql, FromSqlResult, ToSqlOutput, ValueRef},
};

/// Surrogate key for an `(owner, session)` namespace in `agent_namespaces`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct NamespaceId(i64);

impl NamespaceId {
    pub(crate) fn as_i64(self) -> i64 {
        self.0
    }
}

impl ToSql for NamespaceId {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.0))
    }
}

impl FromSql for NamespaceId {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        value.as_i64().map(Self)
    }
}

pub(crate) fn find_id(
    c: &Connection,
    owner: &str,
    session: &str,
) -> Result<Option<NamespaceId>, StoreError> {
    c.prepare_cached("SELECT id FROM agent_namespaces WHERE owner=?1 AND session=?2")?
        .query_row(params![owner, session], |r| r.get(0))
        .optional()
        .map_err(StoreError::from)
}

pub(crate) fn ensure_id(
    c: &Connection,
    owner: &str,
    session: &str,
) -> Result<NamespaceId, StoreError> {
    if let Some(id) = find_id(c, owner, session)? {
        return Ok(id);
    }
    c.prepare_cached("INSERT OR IGNORE INTO agent_namespaces(owner, session) VALUES(?1, ?2)")?
        .execute(params![owner, session])?;
    find_id(c, owner, session)?.ok_or_else(|| {
        StoreError::InvalidTransition("agent_namespaces row missing after insert".into())
    })
}

pub(crate) fn find_owner_id(
    c: &Connection,
    owner: &RunOwner,
    session: &str,
) -> Result<Option<NamespaceId>, StoreError> {
    find_id(c, &serde_json::to_string(owner)?, session)
}

/// Child tables referencing `agent_session_history`, `agent_recall_messages`,
/// or `agent_usage_calls`, ordered grandchildren-first for drop and reversed for restore.
const CHILD_TABLES: &[&str] = &[
    "agent_memory_cell_candidates",
    "agent_history_tool_metadata",
    "agent_memory_recall_calls",
    "agent_memory_cell_observations",
    "agent_memory_cell_events",
    "agent_memory_run_restrictions",
    "agent_memory_recall_attachments",
    "agent_memory_shared_fields",
    "agent_usage_results",
];

const UPDATED_VIEWS: &[(&str, &str)] = &[
    (
        "agent_memory_new_history",
        "CREATE VIEW agent_memory_new_history AS SELECT h.* FROM agent_session_history h
 WHERE h.sequence>(SELECT last_existing_fact FROM agent_memory_history_boundary)
 OR EXISTS(SELECT 1 FROM agent_memory_legacy_recap_history l
  JOIN agent_namespaces ns ON ns.id=h.namespace_id
  WHERE l.session=ns.session AND h.sequence>=l.first_sequence)",
    ),
    (
        "agent_memory_recall_attachment_source",
        "CREATE VIEW agent_memory_recall_attachment_source AS
 SELECT ns.owner,a.value->>'$.ref.sessionId',a.value->>'$.ref.relativePath',d.id AS message
 FROM agent_recall_messages d
 JOIN agent_namespaces ns ON ns.id=d.namespace_id,json_each(d.attachments) a
 WHERE d.sequence>(SELECT last_existing_fact FROM agent_memory_history_boundary) AND a.value->>'$.ref.kind'='session_file'",
    ),
    (
        "agent_memory_return_segments",
        "CREATE VIEW agent_memory_return_segments AS
 SELECT h.namespace_id,ns.owner,ns.session,h.run,h.tool_use_id,h.fact_id,h.sequence,d.ordinal,h.kind,d.body,
    CASE h.kind WHEN 'tool_result_accepted' THEN d.references_json->>'$[2].digest'
                ELSE d.references_json->>'$[1].digest' END AS content,
    CASE WHEN h.kind IN ('cell','tool_result_accepted') THEN d.fields_json->>'$[#-1].start'
         ELSE d.fields_json->>'$[0].start' END AS start,
    CASE WHEN h.kind IN ('cell','tool_result_accepted') THEN d.fields_json->>'$[#-1].end'
         ELSE d.fields_json->>'$[0].end' END AS end
 FROM agent_session_history h
 JOIN agent_namespaces ns ON ns.id=h.namespace_id
 JOIN agent_recall_messages d ON d.namespace_id=h.namespace_id AND d.sequence=h.sequence AND d.ordinal=0
 WHERE h.kind IN ('tool_result_accepted','local_tool_returned','host_tool_result_recorded')
    OR (h.kind='model_observed' AND h.tool_use_id IS NOT NULL AND h.tool_start=0)
    OR (h.kind='cell' AND h.tool_use_id IS NOT NULL AND d.fields_json->>'$[#-1].field'='arguments')",
    ),
    (
        "agent_memory_sibling_spans",
        "CREATE VIEW agent_memory_sibling_spans(namespace,fact,ordinal,start,end,session,sequence) AS
 SELECT dest.owner,dest.fact_id,dest.ordinal,
        dest.start + max(hidden.start,src.start) - src.start,
        dest.start + min(hidden.end,src.end) - src.start,dest.session,dest.sequence
 FROM agent_memory_return_segments dest CROSS JOIN agent_memory_return_segments src
 CROSS JOIN agent_memory_hidden_spans hidden
 WHERE src.namespace_id=dest.namespace_id AND src.run=dest.run
 AND src.tool_use_id=dest.tool_use_id AND src.fact_id<>dest.fact_id AND (
    src.content=dest.content OR
    ((src.kind='tool_result_accepted' AND dest.kind='model_observed' OR
      dest.kind='tool_result_accepted' AND src.kind='model_observed')
     AND src.content IS NULL AND dest.content IS NULL AND src.body=dest.body))
 AND src.end-src.start=dest.end-dest.start
 AND hidden.namespace=src.owner AND hidden.fact=src.fact_id AND hidden.ordinal=src.ordinal
 AND hidden.start<src.end AND hidden.end>src.start",
    ),
    (
        "agent_memory_cell_accept_source",
        "CREATE VIEW agent_memory_cell_accept_source AS
 SELECT h.sequence,obs.cell,obs.through_sequence
 FROM agent_memory_new_history h JOIN agent_session_history origin ON origin.namespace_id=h.namespace_id
  AND origin.run=h.run AND origin.tool_use_id=h.tool_use_id AND origin.sequence<h.sequence AND origin.kind='local_tool_returned'
 JOIN agent_memory_cell_observations obs ON obs.sequence=origin.sequence
 JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
 JOIN contents accepted ON accepted.content_sha256=json_extract(CAST(b.payload AS TEXT),'$.fact.result.digest')
 WHERE h.kind='tool_result_accepted' AND json_extract(CAST(accepted.payload AS TEXT),'$.kind')='local'
 UNION ALL
 SELECT h.sequence,json_extract(CAST(b.payload AS TEXT),'$.fact.outcome.cell'),h.sequence
 FROM agent_memory_new_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
 WHERE h.kind='tool_result_accepted' AND json_extract(CAST(b.payload AS TEXT),'$.fact.outcome.kind')='cell_recovered'",
    ),
    (
        "agent_memory_operation_spans",
        "CREATE VIEW agent_memory_operation_spans(namespace,fact,ordinal,start,end) AS
 SELECT namespace,fact,0,
        CASE WHEN same_bytes THEN dest_start+overlap_start ELSE dest_start END,
        CASE WHEN same_bytes THEN dest_start+overlap_end ELSE dest_end END FROM (
 SELECT ns.owner AS namespace,dest.fact,dest.start AS dest_start,dest.end AS dest_end,
        max(hidden.start,src.start)-src.start AS overlap_start,min(hidden.end,src.end)-src.start AS overlap_end,
        src.end-src.start=dest.end-dest.start AND substr(CAST(s.body AS BLOB),src.start+1,src.end-src.start)
              =substr(CAST(d.body AS BLOB),dest.start+1,dest.end-dest.start) AS same_bytes
 FROM agent_memory_shared_fields dest CROSS JOIN agent_recall_messages d ON d.id=dest.message
 CROSS JOIN agent_namespaces ns ON ns.id=d.namespace_id
 CROSS JOIN agent_memory_shared_fields src ON src.run=dest.run AND src.tool=dest.tool
 CROSS JOIN agent_memory_hidden_spans hidden ON hidden.namespace=ns.owner AND hidden.fact=src.fact AND hidden.ordinal=0
 CROSS JOIN agent_recall_messages s ON s.id=src.message
 WHERE (src.fact,src.start)<>(dest.fact,dest.start) AND hidden.start<src.end AND hidden.end>src.start
 )",
    ),
    (
        "agent_memory_failed_terminations",
        "CREATE VIEW agent_memory_failed_terminations AS
 SELECT d.id AS message,d.body,h.fact_id AS fact,h.run,h.namespace_id,h.sequence,length(CAST(d.body AS BLOB)) AS end
 FROM agent_recall_messages d CROSS JOIN agent_memory_new_history h ON h.sequence=d.sequence
 CROSS JOIN agent_facts f ON f.sequence=h.sequence CROSS JOIN contents b ON b.id=f.body_content_id
 WHERE d.ordinal=0 AND h.kind='run_terminated' AND CAST(b.payload AS TEXT)->>'$.fact.terminal'='failed'",
    ),
    (
        "agent_memory_termination_interruptions",
        "CREATE VIEW agent_memory_termination_interruptions AS
 SELECT t.message,t.fact,t.run,t.end,src.id AS source_message,i.fact_id AS source_fact
 FROM agent_memory_failed_terminations t CROSS JOIN agent_memory_new_history i
   ON i.namespace_id=t.namespace_id AND i.run=t.run AND i.kind='model_interrupted' AND i.sequence<t.sequence
   AND i.attempt=(SELECT p.attempt FROM agent_session_history p
       WHERE p.namespace_id=t.namespace_id AND p.run=t.run AND p.kind='model_attempt_prepared'
         AND p.sequence<t.sequence ORDER BY p.sequence DESC LIMIT 1)
   AND i.step=(SELECT p.step FROM agent_session_history p WHERE p.run=t.run AND p.kind='step_prepared'
         AND p.sequence<t.sequence ORDER BY p.sequence DESC LIMIT 1)
 CROSS JOIN agent_recall_messages src ON src.namespace_id=i.namespace_id AND src.sequence=i.sequence AND src.ordinal=0
 WHERE src.body=t.body",
    ),
    (
        "agent_memory_run_restriction_source",
        "CREATE VIEW agent_memory_run_restriction_source AS
 SELECT e.sequence AS evidence,h.run,h.sequence AS source,e.namespace,e.scope,e.id,e.assertion
 FROM agent_memory_restricted_evidence e
 JOIN agent_namespaces ns ON ns.owner=e.namespace
 JOIN agent_memory_new_history h ON h.namespace_id=ns.id AND h.fact_id=CAST(json_extract(e.source,'$.reference.factId') AS TEXT)",
    ),
    (
        "agent_memory_termination_receipts",
        "CREATE VIEW agent_memory_termination_receipts AS
 SELECT DISTINCT t.message,t.fact,t.run,t.end,op.tool_use_id AS tool
 FROM agent_memory_failed_terminations t
 CROSS JOIN agent_session_history blocked ON blocked.namespace_id=t.namespace_id AND blocked.run=t.run
   AND blocked.kind='blocked' AND blocked.sequence<t.sequence
 CROSS JOIN agent_facts bf ON bf.sequence=blocked.sequence CROSS JOIN contents b ON b.id=bf.body_content_id
 CROSS JOIN agent_session_history op ON op.namespace_id=t.namespace_id AND op.run=t.run
   AND op.step=blocked.step AND op.kind='operation_observed' AND op.attempt=blocked.attempt AND op.sequence<t.sequence
 CROSS JOIN agent_facts ofact ON ofact.sequence=op.sequence CROSS JOIN contents r ON r.id=ofact.body_content_id
 WHERE CAST(b.payload AS TEXT)->>'$.fact.reason.kind'='operation_unknown'
   AND CAST(r.payload AS TEXT)->>'$.fact.reply.reference.operation'=CAST(b.payload AS TEXT)->>'$.fact.reason.reference.operation'
   AND CAST(r.payload AS TEXT)->>'$.fact.tool.call'=CAST(b.payload AS TEXT)->>'$.fact.reason.tool.call'
   AND t.body=CASE WHEN CAST(r.payload AS TEXT)->>'$.fact.reply.receipt.outcome.kind'='unknown'
     THEN CAST(r.payload AS TEXT)->>'$.fact.reply.receipt.outcome.diagnostic'
     WHEN CAST(r.payload AS TEXT)->>'$.fact.reply.receipt.kind'='unavailable' THEN CAST(r.payload AS TEXT)->>'$.fact.reply.receipt.diagnostic' END
   AND NOT EXISTS (SELECT 1 FROM agent_session_history later WHERE later.namespace_id=t.namespace_id
     AND later.tool_use_id=op.tool_use_id AND later.run=t.run AND later.kind='operation_observed'
     AND later.sequence>op.sequence AND later.sequence<t.sequence)
 UNION
 SELECT DISTINCT t.message,t.fact,t.run,t.end,op.tool_use_id AS tool
 FROM agent_memory_failed_terminations t
 CROSS JOIN agent_session_history blocked ON blocked.namespace_id=t.namespace_id AND blocked.run=t.run
   AND blocked.kind='blocked' AND blocked.sequence<t.sequence
 CROSS JOIN agent_facts bf ON bf.sequence=blocked.sequence CROSS JOIN contents b ON b.id=bf.body_content_id
 CROSS JOIN agent_session_history op ON op.namespace_id=t.namespace_id AND op.run=t.run
   AND op.kind='external_effect' AND op.tool_start=0 AND op.result_source=0 AND op.sequence<t.sequence
 CROSS JOIN agent_facts ofact ON ofact.sequence=op.sequence CROSS JOIN contents r ON r.id=ofact.body_content_id
 WHERE CAST(b.payload AS TEXT)->>'$.fact.reason.kind'='external_effect_unknown'
   AND CAST(r.payload AS TEXT)->>'$.fact.event.kind'='observed'
   AND CAST(r.payload AS TEXT)->>'$.fact.event.key.task'=CAST(b.payload AS TEXT)->>'$.fact.reason.task'
   AND CAST(r.payload AS TEXT)->>'$.fact.event.key.operation'=CAST(b.payload AS TEXT)->>'$.fact.reason.operation'
   AND t.body IN (
     CASE WHEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.outcome.kind'='unknown'
       THEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.outcome.diagnostic'
       WHEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.kind'='unavailable'
       THEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.diagnostic' END,
     rtrim(CASE WHEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.outcome.kind'='unknown'
       THEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.outcome.diagnostic'
       WHEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.kind'='unavailable'
       THEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.diagnostic' END,'.')
       ||'. The call may still be running; its end was not confirmed.'
   )
   AND NOT EXISTS (
     SELECT 1 FROM agent_session_history later
     CROSS JOIN agent_facts lf ON lf.sequence=later.sequence
     CROSS JOIN contents lr ON lr.id=lf.body_content_id
     WHERE later.namespace_id=t.namespace_id
       AND later.tool_use_id=op.tool_use_id AND later.run=t.run
       AND later.kind='external_effect' AND later.tool_start=0 AND later.result_source=0
       AND later.sequence>op.sequence AND later.sequence<t.sequence
       AND CAST(lr.payload AS TEXT)->>'$.fact.event.kind'='observed'
   )",
    ),
    (
        "agent_memory_recall_outputs",
        "CREATE VIEW agent_memory_recall_outputs(owner,fact) AS
 SELECT ns.owner,h.fact_id FROM agent_session_history h
 JOIN agent_namespaces ns ON ns.id=h.namespace_id WHERE
 ((h.result_source=1 OR h.kind IN ('cell','operation_observed','external_task_observed','model_observed')
   OR (h.kind='external_effect' AND h.tool_start=0))
  AND EXISTS(SELECT 1 FROM agent_memory_recall_calls k
      WHERE k.run=h.run AND k.tool_use_id=h.tool_use_id AND k.sequence<h.sequence))
 OR (h.kind='cell' AND h.tool_use_id IS NULL AND EXISTS(
     SELECT 1 FROM agent_memory_cell_events e JOIN agent_memory_recall_calls k ON k.run=h.run AND k.cell=e.cell
     WHERE e.sequence=h.sequence AND k.sequence<h.sequence))
 OR EXISTS(SELECT 1 FROM agent_memory_cell_observations obs WHERE obs.sequence=h.sequence AND (
     EXISTS(SELECT 1 FROM agent_memory_recall_calls k
       WHERE k.cell=obs.cell AND k.sequence<obs.through_sequence)
     OR EXISTS(
       SELECT 1 FROM agent_memory_cell_candidates c
       JOIN agent_session_history dest ON dest.sequence=c.event
       WHERE c.cell=obs.cell AND c.event<=obs.through_sequence AND (c.direct
         OR EXISTS(SELECT 1 FROM agent_memory_operation_spans s WHERE s.namespace=ns.owner AND s.fact=dest.fact_id)
         OR EXISTS(SELECT 1 FROM agent_memory_sibling_spans s WHERE s.namespace=ns.owner AND s.fact=dest.fact_id))
     )
 ))",
    ),
];

const UPDATED_TRIGGER: (&str, &str) = (
    "agent_memory_run_restriction_history",
    "CREATE TRIGGER agent_memory_run_restriction_history AFTER INSERT ON agent_session_history
 WHEN NEW.sequence>(SELECT last_existing_fact FROM agent_memory_history_boundary) BEGIN
 INSERT INTO agent_memory_run_restrictions SELECT e.sequence,NEW.run,NEW.sequence FROM agent_memory_restricted_evidence e
 WHERE e.namespace=(SELECT ns.owner FROM agent_namespaces ns WHERE ns.id=NEW.namespace_id)
   AND CAST(json_extract(e.source,'$.reference.factId') AS TEXT)=NEW.fact_id;
END",
);

struct SavedChild {
    name: &'static str,
    temp: String,
    create_sql: String,
    index_sqls: Vec<String>,
}

/// Atomically replaces repeated `(owner, session)` text columns on
/// `agent_session_history`, `agent_recall_messages`, and `agent_usage_calls`
/// with integer `namespace_id` keys referencing `agent_namespaces`, drops
/// redundant secondary indexes, and updates dependent views and triggers.
pub(crate) fn migrate_namespace_surrogate_keys(c: &Connection) -> Result<(), StoreError> {
    c.execute_batch(
        "INSERT OR IGNORE INTO agent_namespaces(owner, session)
         SELECT owner, session FROM (
             SELECT DISTINCT owner, session FROM agent_session_history
             UNION
             SELECT DISTINCT owner, session FROM agent_recall_messages
             UNION
             SELECT DISTINCT owner, session FROM agent_recall_external_segments
             UNION
             SELECT DISTINCT owner, session FROM agent_usage_calls WHERE owner IS NOT NULL
         ) ORDER BY owner, session;",
    )?;

    let saved_views: Vec<(String, String)> = c
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='view' AND sql IS NOT NULL ORDER BY rowid")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let saved_triggers: Vec<(String, String)> = c
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY rowid")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;

    let mut saved_children = Vec::with_capacity(CHILD_TABLES.len());
    for &table in CHILD_TABLES {
        let create_sql: String = c.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |r| r.get(0),
        )?;
        let index_sqls: Vec<String> = c
            .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=?1 AND sql IS NOT NULL ORDER BY rowid")?
            .query_map([table], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        saved_children.push(SavedChild {
            name: table,
            temp: format!("_v62_{table}"),
            create_sql,
            index_sqls,
        });
    }

    // Drop triggers before table/view changes so staged copies do not re-fire triggers
    // and SQLite's rename validation does not reject dropped parent tables.
    for (name, _) in &saved_triggers {
        c.execute(&format!(r#"DROP TRIGGER "{name}""#), [])?;
    }
    for (name, _) in &saved_views {
        c.execute(&format!(r#"DROP VIEW "{name}""#), [])?;
    }

    for child in &saved_children {
        c.execute_batch(&format!(
            r#"CREATE TEMP TABLE "{}" AS SELECT * FROM "{}";
             DROP TABLE "{}";"#,
            child.temp, child.name, child.name
        ))?;
    }

    // Rebuild agent_session_history with namespace_id and consolidated indexes.
    c.execute_batch(
        "CREATE TABLE agent_session_history_v62 (
             namespace_id INTEGER NOT NULL REFERENCES agent_namespaces(id),
             sequence INTEGER PRIMARY KEY REFERENCES agent_facts(sequence),
             run TEXT NOT NULL REFERENCES agent_run_specs(run),
             admission_sequence INTEGER NOT NULL,
             step TEXT,
             attempt TEXT,
             kind TEXT NOT NULL,
             prefix_digest TEXT NOT NULL,
             tool_use_id TEXT,
             tool_start INTEGER NOT NULL CHECK(tool_start IN(0,1)),
             opening_message INTEGER NOT NULL CHECK(opening_message IN(0,1)),
             fact_id TEXT NOT NULL UNIQUE REFERENCES agent_facts(id),
             result_source INTEGER NOT NULL CHECK(result_source IN(0,1)),
             tool_name TEXT,
             historical INTEGER NOT NULL DEFAULT 0 CHECK(historical IN(0,1) AND (historical=0 OR kind='run_admitted'))
         );
         INSERT INTO agent_session_history_v62(
             namespace_id, sequence, run, admission_sequence, step, attempt, kind,
             prefix_digest, tool_use_id, tool_start, opening_message, fact_id,
             result_source, tool_name, historical
         )
         SELECT ns.id, h.sequence, h.run, h.admission_sequence, h.step, h.attempt, h.kind,
                h.prefix_digest, h.tool_use_id, h.tool_start, h.opening_message, h.fact_id,
                h.result_source, h.tool_name, h.historical
         FROM agent_session_history h
         JOIN agent_namespaces ns ON ns.owner = h.owner AND ns.session = h.session
         ORDER BY h.sequence;
         DROP TABLE agent_session_history;
         ALTER TABLE agent_session_history_v62 RENAME TO agent_session_history;
         CREATE INDEX agent_session_history_session ON agent_session_history(namespace_id);
         CREATE INDEX agent_session_history_run ON agent_session_history(run, step, kind);
         CREATE INDEX agent_session_history_kind ON agent_session_history(namespace_id, kind);
         CREATE INDEX agent_session_history_tool ON agent_session_history(namespace_id, tool_use_id) WHERE tool_use_id IS NOT NULL;
         CREATE INDEX agent_session_history_message ON agent_session_history(namespace_id) WHERE opening_message=1;
         CREATE INDEX agent_session_history_historical ON agent_session_history(namespace_id, sequence DESC) WHERE historical=1;
         CREATE INDEX agent_session_history_prepared ON agent_session_history(run, sequence DESC, step) WHERE kind='step_prepared';
         CREATE INDEX agent_memory_interruption_attempt ON agent_session_history(run, attempt) WHERE kind='model_interrupted';
         CREATE INDEX agent_memory_cell_tool ON agent_session_history(run, tool_use_id) WHERE tool_use_id IS NOT NULL;",
    )?;

    // Rebuild agent_recall_messages preserving id so agent_recall_terms rowids remain valid.
    c.execute_batch(
        "CREATE TABLE agent_recall_messages_v62 (
             id INTEGER PRIMARY KEY,
             namespace_id INTEGER NOT NULL REFERENCES agent_namespaces(id),
             sequence INTEGER NOT NULL REFERENCES agent_facts(sequence),
             ordinal INTEGER NOT NULL,
             run TEXT NOT NULL REFERENCES agent_run_specs(run),
             turn TEXT NOT NULL,
             message TEXT NOT NULL,
             at INTEGER NOT NULL,
             role TEXT NOT NULL,
             body TEXT NOT NULL,
             fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
             origin_json TEXT CHECK(origin_json IS NULL OR json_valid(origin_json)),
             internal INTEGER NOT NULL CHECK(internal IN(0,1)),
             attachments TEXT NOT NULL CHECK(json_valid(attachments)),
             references_json TEXT NOT NULL CHECK(json_valid(references_json)),
             body_ref_sequence INTEGER,
             body_ref_start INTEGER,
             body_ref_end INTEGER,
             UNIQUE(namespace_id, sequence, ordinal),
             UNIQUE(namespace_id, message)
         );
         INSERT INTO agent_recall_messages_v62(
             id, namespace_id, sequence, ordinal, run, turn, message, at, role,
             body, fields_json, origin_json, internal, attachments, references_json,
             body_ref_sequence, body_ref_start, body_ref_end
         )
         SELECT d.id, ns.id, d.sequence, d.ordinal, d.run, d.turn, d.message, d.at, d.role,
                d.body, d.fields_json, d.origin_json, d.internal, d.attachments, d.references_json,
                d.body_ref_sequence, d.body_ref_start, d.body_ref_end
         FROM agent_recall_messages d
         JOIN agent_namespaces ns ON ns.owner = d.owner AND ns.session = d.session
         ORDER BY d.id;
         DROP TABLE agent_recall_messages;
         ALTER TABLE agent_recall_messages_v62 RENAME TO agent_recall_messages;
         CREATE INDEX agent_recall_visible_order ON agent_recall_messages(namespace_id, internal, sequence, ordinal);
         CREATE INDEX agent_recall_turn ON agent_recall_messages(namespace_id, turn, sequence, ordinal);
         CREATE INDEX agent_recall_messages_run ON agent_recall_messages(run);
         CREATE INDEX agent_recall_messages_sequence ON agent_recall_messages(sequence);
         CREATE INDEX agent_recall_body_ref ON agent_recall_messages(namespace_id, body_ref_sequence) WHERE body_ref_sequence IS NOT NULL;

         CREATE TABLE agent_recall_external_segments_v62 (
             namespace_id INTEGER NOT NULL REFERENCES agent_namespaces(id),
             run TEXT NOT NULL,
             admission_sequence INTEGER NOT NULL,
             turn TEXT NOT NULL,
             task TEXT NOT NULL,
             message_id TEXT NOT NULL,
             is_thinking INTEGER NOT NULL CHECK(is_thinking IN (0, 1)),
             s0_sequence INTEGER NOT NULL,
             tail_start_sequence INTEGER,
             tail_end_sequence INTEGER,
             tail_start_at INTEGER,
             tail_end_at INTEGER,
             tail_end_fact TEXT,
             tail_bytes INTEGER NOT NULL DEFAULT 0,
             sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0, 1)),
             PRIMARY KEY(namespace_id, run, task, message_id, is_thinking, s0_sequence)
         ) WITHOUT ROWID;
         INSERT INTO agent_recall_external_segments_v62(
             namespace_id, run, admission_sequence, turn, task, message_id, is_thinking,
             s0_sequence, tail_start_sequence, tail_end_sequence, tail_start_at,
             tail_end_at, tail_end_fact, tail_bytes, sealed
         )
         SELECT ns.id, s.run, s.admission_sequence, s.turn, s.task, s.message_id, s.is_thinking,
                s.s0_sequence, s.tail_start_sequence, s.tail_end_sequence, s.tail_start_at,
                s.tail_end_at, s.tail_end_fact, s.tail_bytes, s.sealed
         FROM agent_recall_external_segments s
         JOIN agent_namespaces ns ON ns.owner = s.owner AND ns.session = s.session;
         DROP TABLE agent_recall_external_segments;
         ALTER TABLE agent_recall_external_segments_v62 RENAME TO agent_recall_external_segments;
         CREATE INDEX agent_recall_external_segments_open
             ON agent_recall_external_segments(namespace_id, run)
             WHERE sealed = 0;
         CREATE INDEX agent_recall_external_segments_cut
             ON agent_recall_external_segments(namespace_id, tail_start_sequence, tail_end_sequence)
             WHERE tail_start_sequence IS NOT NULL;
         CREATE INDEX agent_recall_external_segments_sealed_seq
             ON agent_recall_external_segments(namespace_id, tail_end_sequence)
             WHERE sealed = 1 AND tail_end_sequence IS NOT NULL;",
    )?;

    // Rebuild agent_usage_calls replacing repeated (owner, session) text with
    // namespace_id for owned rows while keeping standalone_session for ownerless cell usage.
    c.execute_batch(
        "CREATE TABLE agent_usage_calls_v62 (
             request TEXT PRIMARY KEY,
             source TEXT NOT NULL CHECK(source IN ('fact','auxiliary','cell')),
             kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
             namespace_id INTEGER REFERENCES agent_namespaces(id),
             standalone_session TEXT,
             run TEXT,
             admission_sequence INTEGER NOT NULL CHECK(admission_sequence>0),
             started_at INTEGER NOT NULL CHECK(started_at>=0),
             model_id TEXT,
             provider_id TEXT,
             name TEXT,
             purpose TEXT,
             binding_json TEXT CHECK(binding_json IS NULL OR json_valid(binding_json)),
             quote_json TEXT CHECK(quote_json IS NULL OR json_valid(quote_json)),
             origin_json TEXT NOT NULL CHECK(json_valid(origin_json)),
             CHECK((namespace_id IS NOT NULL AND standalone_session IS NULL)
                OR (namespace_id IS NULL AND standalone_session IS NOT NULL))
         );
         INSERT INTO agent_usage_calls_v62(
             request, source, kind, namespace_id, standalone_session, run,
             admission_sequence, started_at, model_id, provider_id, name, purpose,
             binding_json, quote_json, origin_json
         )
         SELECT u.request, u.source, u.kind, ns.id,
                CASE WHEN u.owner IS NULL THEN u.session ELSE NULL END,
                u.run, u.admission_sequence, u.started_at, u.model_id, u.provider_id,
                u.name, u.purpose, u.binding_json, u.quote_json, u.origin_json
         FROM agent_usage_calls u
         LEFT JOIN agent_namespaces ns
           ON u.owner IS NOT NULL AND ns.owner = u.owner AND ns.session = u.session
         ORDER BY u.request;
         DROP TABLE agent_usage_calls;
         ALTER TABLE agent_usage_calls_v62 RENAME TO agent_usage_calls;
         CREATE INDEX agent_usage_call_scope ON agent_usage_calls(namespace_id, admission_sequence, request) WHERE namespace_id IS NOT NULL;
         CREATE INDEX agent_usage_call_time ON agent_usage_calls(started_at, request);
         CREATE INDEX agent_usage_call_owner_time ON agent_usage_calls(namespace_id, started_at, request) WHERE namespace_id IS NOT NULL;
         CREATE INDEX agent_usage_call_standalone_time ON agent_usage_calls(standalone_session, started_at, request) WHERE standalone_session IS NOT NULL;",
    )?;

    // Restore child tables parents-before-grandchildren so foreign keys hold throughout.
    for child in saved_children.iter().rev() {
        c.execute_batch(&child.create_sql)?;
        c.execute_batch(&format!(
            r#"INSERT INTO "{}" SELECT * FROM temp."{}";
             DROP TABLE temp."{}";"#,
            child.name, child.temp, child.temp
        ))?;
        for idx_sql in &child.index_sqls {
            c.execute_batch(idx_sql)?;
        }
    }

    let mut replaced_views = 0usize;
    for (name, sql) in &saved_views {
        if let Some((_, replacement)) = UPDATED_VIEWS.iter().find(|(n, _)| n == name) {
            c.execute_batch(replacement)?;
            replaced_views += 1;
        } else {
            c.execute_batch(sql)?;
        }
    }
    if replaced_views != UPDATED_VIEWS.len() {
        return Err(StoreError::InvalidTransition(format!(
            "migration 59 expected {} updated views, replaced {replaced_views}",
            UPDATED_VIEWS.len()
        )));
    }

    let mut replaced_triggers = 0usize;
    for (name, sql) in &saved_triggers {
        if name == UPDATED_TRIGGER.0 {
            c.execute_batch(UPDATED_TRIGGER.1)?;
            replaced_triggers += 1;
        } else {
            c.execute_batch(sql)?;
        }
    }
    if replaced_triggers != 1 {
        return Err(StoreError::InvalidTransition(format!(
            "migration 59 expected 1 updated trigger, replaced {replaced_triggers}"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ContentBlob;
    use maka_agent_facts::durable::{FactId, RunId, SCHEMA_VERSION};
    use rusqlite::{Connection, params};

    fn catalog() -> Vec<maka_event_log::migration::Migration> {
        maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect()
    }

    #[test]
    fn migration_59_preserves_rows_children_views_triggers_and_fts_rowids() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let all = catalog();
        let through_58: Vec<_> = all.iter().filter(|m| m.version <= 61).copied().collect();
        maka_event_log::migration::run(&db, &through_58).unwrap();

        let owner = r#"{"namespace":"ns-1","deployment":"00000000-0000-0000-0000-000000000001"}"#;
        let spec_blob = ContentBlob::json(&serde_json::json!({"stub": true})).unwrap();
        let spec_cid = spec_blob.store(&db).unwrap();
        let run_a = RunId::new().to_string();
        let run_b = RunId::new().to_string();
        let fact_a = FactId::new().to_string();
        let fact_b = FactId::new().to_string();

        for (run, session, seq, fact, body) in [
            (&run_a, "sess-a", 1_i64, &fact_a, "alpha surrogate needle"),
            (&run_b, "sess-b", 2_i64, &fact_b, "beta surrogate needle"),
        ] {
            db.execute(
                "INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES(?,?,?,?,?)",
                params![run, SCHEMA_VERSION, owner, session, spec_cid],
            )
            .unwrap();
            db.execute(
                "INSERT INTO agent_facts(sequence,id,run,revision,schema_version,at,body_content_id) VALUES(?,?,?,1,?,100,?)",
                params![seq, fact, run, SCHEMA_VERSION, spec_cid],
            )
            .unwrap();
            db.execute(
                "INSERT INTO agent_session_history(owner,session,sequence,run,admission_sequence,kind,prefix_digest,tool_use_id,tool_start,opening_message,fact_id,result_source,historical)
                 VALUES(?,?,?,?,?,'tool_result_accepted','digest','tool-1',0,0,?,1,0)",
                params![owner, session, seq, run, seq, fact],
            )
            .unwrap();
            let msg_id: i64 = db
                .query_row(
                    r#"INSERT INTO agent_recall_messages(id,owner,session,sequence,ordinal,run,turn,message,at,role,body,attachments,references_json,fields_json,origin_json,internal)
                     VALUES(?,?,?,?,0,?,'turn-1',?,100,'"tool_result"',?,'[]','[]','[{"field":"result","start":0,"end":5,"internal":false}]',NULL,0) RETURNING id"#,
                    params![seq, owner, session, seq, run, fact, body],
                    |r| r.get(0),
                )
                .unwrap();
            db.execute(
                "INSERT INTO agent_recall_terms(rowid,grams) VALUES(?,?)",
                params![msg_id, crate::recall::terms::grams(body)],
            )
            .unwrap();
            db.execute(
                "INSERT INTO agent_history_tool_metadata(sequence,is_error,image,images,external_settlement) VALUES(?,0,0,0,NULL)",
                params![seq],
            )
            .unwrap();
            db.execute(
                "INSERT INTO agent_memory_shared_fields(message,fact,run,tool,start,end) VALUES(?,?,?,?,0,5)",
                params![msg_id, fact, run, "tool-1"],
            )
            .unwrap();
        }

        let pre_ids: Vec<(i64, i64)> = db
            .prepare("SELECT sequence, id FROM agent_recall_messages ORDER BY sequence")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        // Seed both an owned usage call (owner IS NOT NULL) and a standalone cell usage call
        // (owner IS NULL) plus child agent_usage_results rows to verify full FK preservation.
        db.execute(
            r#"INSERT INTO agent_usage_calls(request,source,kind,owner,session,run,admission_sequence,started_at,model_id,provider_id,purpose,binding_json,origin_json)
               VALUES('model:owned','fact','model',?,?,?,1,100,'m','p','"main"','{}','{}')"#,
            params![owner, "sess-usage-only", run_a],
        )
        .unwrap();
        db.execute(
            r#"INSERT INTO agent_usage_calls(request,source,kind,owner,session,run,admission_sequence,started_at,name,origin_json)
               VALUES('tool:standalone','cell','tool',NULL,'sess-standalone',NULL,1,101,'Read','{}')"#,
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_usage_results(request,sequence,completed_at,outcome,input,output) VALUES('model:owned',1,110,'success',10,5),('tool:standalone',1,111,'success',NULL,NULL)",
            [],
        )
        .unwrap();

        let pre_outputs: Vec<(String, String)> = db
            .prepare("SELECT owner, fact FROM agent_memory_recall_outputs ORDER BY fact")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        maka_event_log::migration::run(&db, &all).unwrap();

        let integrity: String = db
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        let fk_errors = db
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query_map([], |_| Ok(()))
            .unwrap()
            .count();
        assert_eq!(fk_errors, 0);
        db.execute(
            "INSERT INTO agent_recall_terms(agent_recall_terms) VALUES('integrity-check')",
            [],
        )
        .unwrap();

        let post_ids: Vec<(i64, i64)> = db
            .prepare("SELECT sequence, id FROM agent_recall_messages ORDER BY sequence")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            post_ids, pre_ids,
            "recall message rowids must stay identical for FTS5"
        );

        let fts_hits: Vec<i64> = db
            .prepare("SELECT rowid FROM agent_recall_terms WHERE agent_recall_terms MATCH ? ORDER BY rowid")
            .unwrap()
            .query_map([crate::recall::terms::expression(&["surrogate".to_owned()])], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(fts_hits, vec![pre_ids[0].1, pre_ids[1].1]);

        let post_outputs: Vec<(String, String)> = db
            .prepare("SELECT owner, fact FROM agent_memory_recall_outputs ORDER BY fact")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(post_outputs, pre_outputs);

        for (view, _) in UPDATED_VIEWS {
            let _: i64 = db
                .query_row(&format!("SELECT COUNT(*) FROM {view}"), [], |r| r.get(0))
                .unwrap_or_else(|e| panic!("view {view} failed after v62: {e}"));
        }

        let meta_count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM agent_history_tool_metadata",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let shared_count: i64 = db
            .query_row("SELECT COUNT(*) FROM agent_memory_shared_fields", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(meta_count, 2);
        assert_eq!(shared_count, 2);

        let usage_results: i64 = db
            .query_row("SELECT COUNT(*) FROM agent_usage_results", [], |r| r.get(0))
            .unwrap();
        assert_eq!(usage_results, 2);
        let owned_usage: (Option<i64>, Option<String>) = db
            .query_row(
                "SELECT namespace_id, standalone_session FROM agent_usage_calls WHERE request='model:owned'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(owned_usage.0.is_some() && owned_usage.1.is_none());
        let standalone_usage: (Option<i64>, Option<String>) = db
            .query_row(
                "SELECT namespace_id, standalone_session FROM agent_usage_calls WHERE request='tool:standalone'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(
            standalone_usage.0.is_none()
                && standalone_usage.1.as_deref() == Some("sess-standalone")
        );

        // Verify trigger agent_memory_run_restriction_history still executes cleanly on new inserts.
        let ns_a = ensure_id(&db, owner, "sess-a").unwrap();
        let fact_a2 = FactId::new().to_string();
        db.execute(
            "INSERT INTO agent_facts(sequence,id,run,revision,schema_version,at,body_content_id) VALUES(3,?,?,2,?,101,?)",
            params![fact_a2, run_a, SCHEMA_VERSION, spec_cid],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_session_history(namespace_id,sequence,run,admission_sequence,kind,prefix_digest,tool_start,opening_message,fact_id,result_source,historical)
             VALUES(?,3,?,1,'model_observed','digest2',0,0,?,0,0)",
            params![ns_a, run_a, fact_a2],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn surrogate_key_indexes_support_paginated_recall_cuts_and_namespace_isolation() {
        use crate::recall::SearchQuery;
        use maka_agent_facts::durable::RunOwner;
        use maka_event_log::RootStore;
        use maka_event_log::root::{ROOT_DATABASE, RootNamespaces, RootOwner};
        use std::sync::Arc;
        use tokio_util::sync::CancellationToken;

        let dir = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: dir.path().join("owners"),
            control: dir.path().join("control"),
        };
        let owner_root =
            Arc::new(RootOwner::create(&dir.path().join("root"), &namespaces).unwrap());
        let db_path = owner_root.canonical_path().join(ROOT_DATABASE);
        let all = catalog();
        let root_store = RootStore::open(owner_root, &all).await.unwrap();
        let data = root_store.data_writer().unwrap();
        let agent_store =
            crate::Store::new(data.clone(), crate::DriverDomain::new(data).unwrap()).unwrap();
        let db = Connection::open(&db_path).unwrap();
        crate::memory::recall::configure_writer(&db).unwrap();

        let owner_1_val: RunOwner = serde_json::from_str(
            r#"{"namespace":["00000000-0000-0000-0000-000000000011"],"deployment":"00000000-0000-0000-0000-000000000001"}"#,
        )
        .unwrap();
        let owner_2_val: RunOwner = serde_json::from_str(
            r#"{"namespace":["00000000-0000-0000-0000-000000000022"],"deployment":"00000000-0000-0000-0000-000000000002"}"#,
        )
        .unwrap();
        let owner_1 = serde_json::to_string(&owner_1_val).unwrap();
        let owner_2 = serde_json::to_string(&owner_2_val).unwrap();
        let spec_blob = ContentBlob::json(&serde_json::json!({"stub": true})).unwrap();
        let spec_cid = spec_blob.store(&db).unwrap();

        let ns_1a = ensure_id(&db, &owner_1, "sess-shared").unwrap();
        let ns_1b = ensure_id(&db, &owner_1, "sess-other").unwrap();
        let ns_2a = ensure_id(&db, &owner_2, "sess-shared").unwrap();
        assert_ne!(ns_1a, ns_1b);
        assert_ne!(ns_1a, ns_2a);

        // Register visible ready sessions so production Recall search exercises real routing & cuts.
        for session in ["sess-shared", "sess-other"] {
            db.execute(
                "INSERT OR IGNORE INTO session_control(id,fingerprint,revision,created_at,updated_at,archived,configuration)
                 VALUES(?,'fp',1,1,1,0,'{}')",
                [session],
            )
            .unwrap();
            db.execute(
                "INSERT OR IGNORE INTO session_creations(session_id,creation_id,fingerprint,command,ready,failure,visible)
                 VALUES(?,'c_test','fp',NULL,1,NULL,1)",
                [session],
            )
            .unwrap();
        }

        // Seed 135 matching turns in (owner_1, sess-shared) — crossing the 128-row FTS5 batch
        // boundary — with an aliased fts_doc_id row straddling row 128 (same role, newer timestamp
        // so it must win turn-127 ranking on batch 2), plus decoy turns with identical session,
        // turn IDs, and bodies in (owner_1, sess-other) and (owner_2, sess-shared).
        let mut seq = 0_i64;
        let mut run_1a = None;
        let mut expected_facts_1a = std::collections::BTreeSet::new();
        for (owner, session, ns_id, turns) in [
            (&owner_1, "sess-shared", ns_1a, 135_usize),
            (&owner_1, "sess-other", ns_1b, 5_usize),
            (&owner_2, "sess-shared", ns_2a, 5_usize),
        ] {
            let run_id = RunId::new();
            if ns_id == ns_1a {
                run_1a = Some(run_id);
            }
            let run = run_id.to_string();
            db.execute(
                "INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES(?,?,?,?,?)",
                params![run, SCHEMA_VERSION, owner, session, spec_cid],
            )
            .unwrap();
            let mut rev = 0_i64;
            let mut last_seq = 0_i64;
            for t in 0..turns {
                rev += 1;
                seq += 1;
                last_seq = seq;
                let fact_id = FactId::new();
                let fact = fact_id.to_string();
                let turn_id = format!("turn-{t:03}");
                let body = format!("surrogate_batch_needle {session} {t:03}");
                let fields_json = format!(
                    r#"[{{"field":"body","start":0,"end":{},"internal":false}}]"#,
                    body.len()
                );
                db.execute(
                    "INSERT INTO agent_facts(sequence,id,run,revision,schema_version,at,body_content_id) VALUES(?,?,?,?,?,?,?)",
                    params![seq, fact, run, rev, SCHEMA_VERSION, seq * 10, spec_cid],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO agent_session_history(namespace_id,sequence,run,admission_sequence,step,kind,prefix_digest,tool_start,opening_message,fact_id,result_source,historical)
                     VALUES(?,?,?,?,?,'step_prepared','digest',0,0,?,0,0)",
                    params![ns_id, seq, run, seq, "step-1", fact],
                )
                .unwrap();
                db.execute(
                    r#"INSERT INTO agent_recall_messages(id,namespace_id,sequence,ordinal,run,turn,message,at,role,body,attachments,references_json,fields_json,origin_json,internal)
                     VALUES(?,?,?,0,?,?,?,?,'"user"',?,'[]','[]',?,NULL,0)"#,
                    params![seq, ns_id, seq, run, turn_id, fact, seq * 10, body, fields_json],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO agent_recall_terms(rowid,grams) VALUES(?,?)",
                    params![seq, crate::recall::terms::grams(&body)],
                )
                .unwrap();
                if ns_id == ns_1a {
                    expected_facts_1a.insert(fact_id);
                }
            }
            db.execute(
                "INSERT INTO agent_recall_heads(owner,session,sequence,digest) VALUES(?,?,?,'digest')",
                params![owner, session, last_seq],
            )
            .unwrap();
            db.execute(
                "INSERT OR REPLACE INTO agent_catalog_sessions(owner,session,last_sequence,terminal_sequence) VALUES(?,?,?,0)",
                params![owner, session, last_seq],
            )
            .unwrap();
            db.execute(
                "INSERT OR IGNORE INTO agent_catalog_runs(run,owner,session,admission_sequence) VALUES(?,?,?,1)",
                params![run, owner, session],
            )
            .unwrap();
        }
        let run_1a = run_1a.unwrap();

        // Drive production Recall search across >128 FTS5 hits (2 batches) and verify
        // strict owner+session isolation (every hit belongs to owner_1's run_1a, never owner_2).
        let recall_1 = agent_store.recall(owner_1_val, "sess-".into()).unwrap();
        let result = recall_1
            .search(
                SearchQuery {
                    terms: vec!["surrogate_batch_needle".into()],
                    session_id: Some("sess-shared".into()),
                    since: None,
                    until: None,
                    exclude: None,
                    limit: Some(200),
                    transcript_only: false,
                },
                0,
                0,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.hits.len(), 135);
        assert!(
            result
                .hits
                .iter()
                .all(|h| h.session.metadata.id == "sess-shared" && h.anchor.run == run_1a),
            "every hit must belong strictly to owner_1's run_1a (never sess-other or owner_2)"
        );
        let actual_facts: std::collections::BTreeSet<FactId> =
            result.hits.iter().map(|h| h.anchor.fact).collect();
        assert_eq!(actual_facts, expected_facts_1a);
    }

    #[test]
    fn cross_hop_upgrade_from_v54_through_v62_clears_recall_gaps_cleanly() {
        use maka_agent_facts::durable::{ExternalTaskId, Fact, RecordedFact, UnixMillis};
        use maka_agent_facts::external_effects::{ExternalEffectEvent, ExternalEffectKey};
        use maka_plugin_core::{
            contract::Transport,
            deployment::DeploymentRef,
            operation::{
                OperationCleanup, OperationOutcome, OperationReply, Receipt, RecoveryContract,
                RecoveryProtocol, RecoveryRef,
            },
        };
        use uuid::Uuid;

        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let all = catalog();
        let through_54: Vec<_> = all.iter().filter(|m| m.version <= 54).copied().collect();
        maka_event_log::migration::run(&db, &through_54).unwrap();

        let (mut spec, _) = crate::store::stop_tests::spec();
        spec.session_id = "sess-gap".into();
        let owner = serde_json::to_string(&spec.owner).unwrap();
        let spec_blob = ContentBlob::json(&spec).unwrap();
        let spec_cid = spec_blob.store(&db).unwrap();
        let run = RunId::new();
        let task = ExternalTaskId::new();
        let op = Uuid::new_v4();
        let digest = format!("sha256-{}", "a".repeat(64));
        let observed = RecordedFact {
            schema_version: SCHEMA_VERSION,
            id: FactId::new(),
            run,
            revision: 1,
            at: UnixMillis(100),
            fact: Fact::ExternalEffect {
                event: ExternalEffectEvent::Observed {
                    key: ExternalEffectKey {
                        task,
                        operation: op,
                    },
                    observation: OperationReply {
                        reference: RecoveryRef {
                            source: DeploymentRef {
                                state_domain: "b".repeat(64),
                                deployment: spec.owner.deployment,
                                revision: 1,
                            },
                            namespace: spec.owner.namespace.clone(),
                            export: "workspace".into(),
                            method: "read".into(),
                            operation: op,
                            fingerprint: digest.clone(),
                            contract: RecoveryContract {
                                name: "maka.workspace.Read".into(),
                                version: 1,
                                transport: Transport::Remote,
                                digest,
                            },
                            recovery: RecoveryProtocol::JournalV1,
                        },
                        receipt: Receipt::Recorded {
                            outcome: OperationOutcome::Unknown {
                                diagnostic: "v54_gap_observed_token".into(),
                            },
                            cleanup: OperationCleanup::Confirmed,
                        },
                    },
                },
            },
        };
        let obs_blob = ContentBlob::json(&observed).unwrap();
        let obs_cid = obs_blob.store(&db).unwrap();
        db.execute(
            "INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES(?,?,?,?,?)",
            params![run.to_string(), SCHEMA_VERSION, owner, "sess-gap", spec_cid],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_facts(sequence,id,run,revision,schema_version,at,body_content_id) VALUES(1,?,?,1,?,100,?)",
            params![observed.id.to_string(), run.to_string(), SCHEMA_VERSION, obs_cid],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_external_effects(run,operation,task,revision,pending,body) VALUES(?,?,?,1,0,'{}')",
            params![run.to_string(), op.to_string(), task.to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_session_history(owner,session,sequence,run,admission_sequence,kind,prefix_digest,tool_use_id,tool_start,opening_message,fact_id,result_source,historical)
             VALUES(?,?,1,?,1,'external_effect','digest',?,0,0,?,0,0)",
            params![owner, "sess-gap", run.to_string(), format!("external:{task}:{op}"), observed.id.to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_recall_gaps(owner,session,sequence,reason) VALUES(?,?,1,'legacy_gap')",
            params![owner, "sess-gap"],
        )
        .unwrap();

        maka_event_log::migration::run(&db, &all).unwrap();
        let remaining: i64 = db
            .query_row("SELECT COUNT(*) FROM agent_recall_gaps", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            remaining, 0,
            "v55 hook must clear agent_recall_gaps cleanly across v54->v62"
        );
        let indexed_body: String = db
            .query_row(
                "SELECT d.body FROM agent_recall_messages d
                 JOIN agent_namespaces ns ON ns.id = d.namespace_id
                 WHERE ns.session = 'sess-gap' AND d.sequence = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(indexed_body.contains("v54_gap_observed_token"));
    }

    #[test]
    fn cold_upgrade_handles_legacy_request_spec_and_pinned_memory_queued_run() {
        use crate::queue::{
            Consume, DeliveryTarget, Event, Placement, PreparedRequest, QueueEdit, RequestId,
        };
        use maka_agent_facts::{
            durable::{Fact, RecordedFact, StepId, UnixMillis},
            input::{DeliveredMessage, MessageInput},
            memory::MemoryAdmission,
            message::{MessageDisposition, RootSourceMessage},
        };

        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let all = catalog();
        let through_57: Vec<_> = all.iter().filter(|m| m.version <= 57).copied().collect();
        maka_event_log::migration::run(&db, &through_57).unwrap();

        let (mut queued_spec, _) = crate::store::stop_tests::spec();
        queued_spec.session_id = "sess-v57-upgrade".into();
        let owner = serde_json::to_string(&queued_spec.owner).unwrap();
        let mut admitted_spec = queued_spec.clone();
        // #7184 populates memory_admission / memory_projection on admission after enqueueing.
        admitted_spec.memory_admission = MemoryAdmission::Enabled;
        admitted_spec.memory_projection = Some(
            ContentBlob::json(&serde_json::json!({"pinned": ["k"]}))
                .unwrap()
                .reference()
                .clone(),
        );

        let run = RunId::new();
        let step = StepId::new();
        let spec_blob = ContentBlob::json(&admitted_spec).unwrap();
        let spec_cid = spec_blob.store(&db).unwrap();
        let make_src = |id: &str, text: &str| {
            let content = MessageInput::from(text);
            ContentBlob::json(&RootSourceMessage {
                message: DeliveredMessage {
                    message_id: id.into(),
                    submitted_content_digest: content.content_digest().unwrap(),
                    content: content.clone(),
                    origin: None,
                },
                unprepared_content: content,
                submitted_placement: maka_agent_facts::message::Placement::NextTurn,
                disposition: MessageDisposition::Followup,
                submitted_intent: None,
            })
            .unwrap()
        };
        let run_src_msg = make_src("m-run", "pinned-memory-queued-run-needle");
        let run_src_cid = run_src_msg.store(&db).unwrap();
        let step_src_msg = make_src("m-step", "pre-7115-steering-needle");
        let step_src_cid = step_src_msg.store(&db).unwrap();
        let empty_res = ContentBlob::json(&serde_json::json!([])).unwrap();
        let _ = empty_res.store(&db).unwrap();

        // Pre-#7115 RequestSpec JSON carrying old `systemPrompt`/`tools` fields in `composition`.
        let legacy_req = ContentBlob::json(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "step": step,
            "composition": { "systemPrompt": "legacy-system", "tools": [] },
            "steering": [step_src_msg.reference()],
        }))
        .unwrap();
        let legacy_req_cid = legacy_req.store(&db).unwrap();

        let req_run = PreparedRequest {
            id: RequestId("req-run".into()),
            message_id: "m-run".into(),
            spec: queued_spec.clone(),
            source: run_src_msg.reference().clone(),
            resources: empty_res.reference().clone(),
            required_tools: Default::default(),
        };
        let req_step = PreparedRequest {
            id: RequestId("req-step".into()),
            message_id: "m-step".into(),
            spec: queued_spec,
            source: step_src_msg.reference().clone(),
            resources: empty_res.reference().clone(),
            required_tools: Default::default(),
        };

        let admitted_fact = RecordedFact {
            schema_version: SCHEMA_VERSION,
            id: FactId::new(),
            run,
            revision: 1,
            at: UnixMillis(10),
            fact: Fact::RunAdmitted {
                spec: spec_blob.reference().clone(),
            },
        };
        let step_fact = RecordedFact {
            schema_version: SCHEMA_VERSION,
            id: FactId::new(),
            run,
            revision: 2,
            at: UnixMillis(20),
            fact: Fact::StepPrepared {
                step,
                request: legacy_req.reference().clone(),
                adjudications: Vec::new(),
            },
        };
        let admitted_cid = ContentBlob::json(&admitted_fact)
            .unwrap()
            .store(&db)
            .unwrap();
        let step_cid = ContentBlob::json(&step_fact).unwrap().store(&db).unwrap();

        db.execute(
            "INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES(?,?,?,?,?)",
            params![run.to_string(), SCHEMA_VERSION, owner, "sess-v57-upgrade", spec_cid],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_request_specs(step,run,content_id) VALUES(?,?,?)",
            params![step.to_string(), run.to_string(), legacy_req_cid],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_facts(sequence,id,run,revision,schema_version,at,body_content_id) VALUES(1,?,?,1,?,10,?),(2,?,?,2,?,20,?)",
            params![
                admitted_fact.id.to_string(),
                run.to_string(),
                SCHEMA_VERSION,
                admitted_cid,
                step_fact.id.to_string(),
                run.to_string(),
                SCHEMA_VERSION,
                step_cid,
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_session_history(owner,session,sequence,run,admission_sequence,kind,prefix_digest,tool_use_id,tool_start,opening_message,fact_id,result_source,historical)
             VALUES(?1,'sess-v57-upgrade',1,?2,1,'run_admitted','d1',NULL,0,1,?3,0,0),
                   (?1,'sess-v57-upgrade',2,?2,1,'step_prepared','d2',NULL,0,0,?4,0,0)",
            params![owner, run.to_string(), admitted_fact.id.to_string(), step_fact.id.to_string()],
        )
        .unwrap();
        // Seed queue events + content pins for both DeliveryTarget::Run and DeliveryTarget::Step.
        let q1 = ContentBlob::json(&Event::Command {
            expected_revision: 0,
            resume_after_interrupt: None,
            edit: QueueEdit::Enqueue {
                request: Box::new(req_run),
                placement: Placement::Followup,
            },
        })
        .unwrap()
        .store(&db)
        .unwrap();
        let q2 = ContentBlob::json(&Event::Consumed {
            cut: Consume {
                session: "sess-v57-upgrade".into(),
                requests: vec![RequestId("req-run".into())],
                expected_revision: 1,
            },
            run,
            target: DeliveryTarget::Run,
        })
        .unwrap()
        .store(&db)
        .unwrap();
        let q3 = ContentBlob::json(&Event::Command {
            expected_revision: 2,
            resume_after_interrupt: None,
            edit: QueueEdit::Enqueue {
                request: Box::new(req_step),
                placement: Placement::Followup,
            },
        })
        .unwrap()
        .store(&db)
        .unwrap();
        let q4 = ContentBlob::json(&Event::Consumed {
            cut: Consume {
                session: "sess-v57-upgrade".into(),
                requests: vec![RequestId("req-step".into())],
                expected_revision: 3,
            },
            run,
            target: DeliveryTarget::Step { step },
        })
        .unwrap()
        .store(&db)
        .unwrap();
        db.execute(
            "INSERT INTO agent_queue_events(session,revision,id,at,body_content_id)
             VALUES('sess-v57-upgrade',1,'q1',10,?1),
                   ('sess-v57-upgrade',2,?2,10,?3),
                   ('sess-v57-upgrade',3,'q3',20,?4),
                   ('sess-v57-upgrade',4,?5,20,?6)",
            params![
                q1,
                admitted_fact.id.to_string(),
                q2,
                q3,
                step_fact.id.to_string(),
                q4,
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_history_queue_requests(session,request,revision,event_id)
             VALUES('sess-v57-upgrade','req-run',1,'q1'),
                   ('sess-v57-upgrade','req-step',3,'q3')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO agent_queue_content_pins(session,request,content_id)
             VALUES('sess-v57-upgrade','req-run',?1),('sess-v57-upgrade','req-step',?2)",
            params![run_src_cid, step_src_cid],
        )
        .unwrap();
        // Seed a v57 Recall head so m0061 enumerates this session and replays index_sources_with_layout!
        db.execute(
            "INSERT INTO agent_recall_heads(owner,session,sequence,digest) VALUES(?1,'sess-v57-upgrade',2,'d2')",
            params![owner],
        )
        .unwrap();

        maka_event_log::migration::run(&db, &all).unwrap();

        let bodies: Vec<String> = db
            .prepare(
                "SELECT d.body FROM agent_recall_messages d
                 JOIN agent_namespaces ns ON ns.id = d.namespace_id
                 WHERE ns.session = 'sess-v57-upgrade' ORDER BY d.sequence, d.ordinal",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            bodies
                .iter()
                .any(|b| b.contains("pinned-memory-queued-run-needle")),
            "v57+ queued run with memory_projection must survive m0061/m0062: {bodies:?}"
        );
        assert!(
            bodies
                .iter()
                .any(|b| b.contains("pre-7115-steering-needle")),
            "pre-#7115 RequestSpec steering must survive m0061/m0062: {bodies:?}"
        );
    }
}
