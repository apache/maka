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

-- Dependent SELECT * views expose the renamed canonical header together.
DROP VIEW session_history_events;
DROP VIEW local_runtime_events;
DROP VIEW session_message_sources;
DROP VIEW usage_activity;
DROP VIEW tool_usage;
DROP VIEW model_usage;
DROP VIEW auxiliary_model_usage;
DROP VIEW agent_model_usage;
DROP VIEW accounting_events;
DROP VIEW model_selected_parts;
DROP VIEW model_part_bodies;
DROP VIEW runtime_events;

ALTER TABLE event_log RENAME COLUMN event_json TO event_header;
ALTER TABLE event_log ADD COLUMN canonical_bytes INTEGER CHECK(canonical_bytes IS NULL OR canonical_bytes>=0);
UPDATE event_log SET canonical_bytes=length(CAST(event_header AS BLOB)) WHERE event_header IS NOT NULL;

CREATE TABLE event_bodies (
    id INTEGER PRIMARY KEY,
    digest BLOB NOT NULL UNIQUE CHECK(length(digest)=32),
    raw_bytes INTEGER NOT NULL CHECK(raw_bytes>0),
    sqlite_json_bytes INTEGER NOT NULL CHECK(sqlite_json_bytes>0),
    payload BLOB NOT NULL,
    CHECK(length(payload)=raw_bytes)
);
CREATE TABLE event_body_slots (
    event_sequence INTEGER PRIMARY KEY REFERENCES event_log(sequence) ON DELETE CASCADE,
    header_offset INTEGER NOT NULL CHECK(header_offset>=0),
    body_id INTEGER NOT NULL REFERENCES event_bodies(id)
);
CREATE INDEX event_body_slot_material ON event_body_slots(body_id);

CREATE TEMP TABLE canonical_body_stage AS
    SELECT sequence,
        maka_projection_offset(kind,event_header) AS header_offset,
        maka_projection_bytes(kind,event_header) AS raw
    FROM event_log WHERE kind='tool_settled' AND event_header IS NOT NULL;
DELETE FROM canonical_body_stage WHERE raw IS NULL;
INSERT INTO event_bodies(digest,raw_bytes,sqlite_json_bytes,payload)
    SELECT DISTINCT maka_body_sha(raw),length(raw),
        length(CAST(json(CAST(raw AS TEXT)) AS BLOB)),raw
    FROM canonical_body_stage;
UPDATE event_log SET event_header=maka_event_header(kind,event_header)
    WHERE sequence IN (SELECT sequence FROM canonical_body_stage);
INSERT INTO event_body_slots(event_sequence,header_offset,body_id)
    SELECT stage.sequence,stage.header_offset,body.id
    FROM canonical_body_stage stage JOIN event_bodies body ON body.digest=maka_body_sha(stage.raw);
DROP TABLE canonical_body_stage;

CREATE TRIGGER event_body_immutable BEFORE UPDATE ON event_bodies BEGIN
    SELECT RAISE(ABORT,'canonical body material is immutable');
END;
CREATE TRIGGER event_body_slot_immutable BEFORE UPDATE ON event_body_slots BEGIN
    SELECT RAISE(ABORT,'canonical body slots are immutable');
END;
CREATE TRIGGER event_body_released AFTER DELETE ON event_body_slots BEGIN
    DELETE FROM event_bodies WHERE id=OLD.body_id
        AND NOT EXISTS(SELECT 1 FROM event_body_slots WHERE body_id=OLD.body_id);
END;
CREATE TRIGGER event_live_length_insert BEFORE INSERT ON event_log
    WHEN (NEW.event_header IS NULL)!=(NEW.canonical_bytes IS NULL) BEGIN
    SELECT RAISE(ABORT,'canonical byte length must follow live material');
END;
CREATE TRIGGER event_live_length_update BEFORE UPDATE OF event_header,canonical_bytes ON event_log
    WHEN (NEW.event_header IS NULL)!=(NEW.canonical_bytes IS NULL)
        OR (NEW.event_header IS NULL AND EXISTS(SELECT 1 FROM event_body_slots WHERE event_sequence=NEW.sequence)) BEGIN
    SELECT RAISE(ABORT,'collected events cannot retain live canonical material');
END;
CREATE TRIGGER event_body_slot_valid BEFORE INSERT ON event_body_slots
    WHEN NOT EXISTS(SELECT 1 FROM event_log e JOIN event_bodies b ON b.id=NEW.body_id
        WHERE e.sequence=NEW.event_sequence AND e.event_header IS NOT NULL
        AND e.kind='tool_settled'
        AND json_extract(e.event_header,'$.fact.outcome.kind')='succeeded'
        AND e.canonical_bytes=length(CAST(e.event_header AS BLOB))-4+b.raw_bytes
        AND substr(CAST(e.event_header AS BLOB),NEW.header_offset+1,4)=X'6e756c6c') BEGIN
    SELECT RAISE(ABORT,'invalid canonical body slot recipe');
END;

CREATE VIEW runtime_events AS
    SELECT * FROM event_log WHERE invocation_id IS NOT NULL AND event_header IS NOT NULL;

CREATE VIEW model_part_bodies AS
SELECT p.*, e.kind AS source_kind,
    json_extract(e.event_header, CASE e.kind
      WHEN 'model_observed' THEN '$.fact.event.data'
      WHEN 'model_completed' THEN '$.fact.output.parts[' || p.record_index || '].data'
      WHEN 'model_interrupted' THEN '$.fact.partial.parts[' || p.record_index || '].data'
    END) AS record,
    json_extract(e.event_header, CASE e.kind
      WHEN 'model_observed' THEN '$.fact.event.data.part'
      WHEN 'model_completed' THEN '$.fact.output.parts[' || p.record_index || '].data.part'
      WHEN 'model_interrupted' THEN '$.fact.partial.parts[' || p.record_index || '].data.part'
    END) AS part
FROM model_part_records p JOIN runtime_events e ON e.sequence=p.source_sequence
WHERE p.record_kind='part';

CREATE VIEW model_selected_parts AS
SELECT e.invocation_id,e.operation_id AS step_id,e.kind AS terminal_kind,e.sequence,e.event_id,
    CAST(json_extract(s.value,'$.data.ordinal') AS INTEGER) AS ordinal,
    CASE json_extract(s.value,'$.kind') WHEN 'own' THEN e.event_id
      WHEN 'ref' THEN json_extract(s.value,'$.data.event_id') END AS body_event_id
FROM runtime_events e, json_each(e.event_header, CASE e.kind
    WHEN 'model_completed' THEN '$.fact.output.parts'
    WHEN 'model_interrupted' THEN '$.fact.partial.parts' END) s
WHERE e.kind IN ('model_completed','model_interrupted');

CREATE VIEW accounting_events AS
    SELECT sequence, event_id, invocation_id, kind, operation_id,
        accounting_at, accounting_usage, invocation_model, accounting_tool,
        COALESCE(event_header, retained_json) AS event_header
    FROM event_log;

CREATE VIEW agent_model_usage AS
WITH attempts AS (
    SELECT request.sequence, request.event_id,
        json_extract(request.event_header, '$.invocation') AS invocation,
        opening.invocation_model AS binding,
        json_extract(request.event_header, '$.fact.model_id') AS model_id,
        json_extract(request.event_header, '$.fact.purpose') AS purpose,
        request.accounting_at AS started_at,
        COALESCE(completed.accounting_at, interrupted.accounting_at, terminal.accounting_at) AS completed_at,
        COALESCE(completed.sequence, interrupted.sequence, terminal.sequence) AS completed_sequence,
        CASE
            WHEN completed.sequence IS NOT NULL THEN 'success'
            WHEN json_extract(interrupted.event_header, '$.fact.status') = 'cancelled' THEN 'aborted'
            WHEN interrupted.sequence IS NOT NULL THEN 'error'
            WHEN json_extract(terminal.event_header, '$.fact.outcome.kind') = 'cancelled' THEN 'aborted'
            WHEN terminal.sequence IS NOT NULL THEN 'unknown'
        END AS outcome,
        COALESCE(completed.accounting_usage, (
            SELECT observed.accounting_usage
            FROM event_log observed INDEXED BY model_usage_observation
            WHERE observed.kind = 'model_observed'
              AND json_extract(COALESCE(observed.event_header, observed.retained_json), '$.fact.event.kind') = 'finished'
              AND observed.invocation_id = request.invocation_id
              AND json_extract(COALESCE(observed.event_header, observed.retained_json), '$.fact.step_id') = request.operation_id
            ORDER BY observed.sequence DESC LIMIT 1
        ), '{}') AS usage
    FROM accounting_events request
    JOIN accounting_events opening ON opening.invocation_id = request.invocation_id
        AND opening.kind = 'invocation_opened'
    LEFT JOIN accounting_events completed ON completed.operation_id = request.operation_id
        AND completed.kind = 'model_completed'
    LEFT JOIN accounting_events interrupted ON interrupted.operation_id = request.operation_id
        AND interrupted.kind = 'model_interrupted'
    LEFT JOIN accounting_events terminal ON terminal.invocation_id = request.invocation_id
        AND terminal.kind = 'invocation_ended'
    WHERE request.kind = 'model_requested'
)
SELECT sequence, event_id,
    json_object('kind', 'agent', 'invocation', json(invocation), 'purpose', purpose) AS origin,
    binding, model_id, outcome, usage,
    json_extract(invocation, '$.session_id') AS session_id,
    started_at, completed_at,
    completed_sequence
FROM attempts;

CREATE VIEW auxiliary_model_usage AS
SELECT started.sequence, started.event_id,
    json_object('kind', 'auxiliary', 'source', json_extract(started.event_header, '$.source')) AS origin,
    json_extract(started.event_header, '$.binding') AS binding,
    json_extract(started.event_header, '$.binding.model') AS model_id,
    json_extract(settled.event_header, '$.outcome') AS outcome,
    COALESCE(observed.accounting_usage, '{}') AS usage,
    json_extract(started.event_header, '$.session_id') AS session_id,
    started.accounting_at AS started_at, settled.accounting_at AS completed_at,
    settled.sequence AS completed_sequence
FROM event_log started
LEFT JOIN event_log settled ON settled.kind = 'auxiliary_model_settled'
    AND json_extract(settled.event_header, '$.request_id') = started.event_id
LEFT JOIN event_log observed ON observed.kind = 'auxiliary_model_usage'
    AND json_extract(COALESCE(observed.event_header, observed.retained_json), '$.request_id') = started.event_id
WHERE started.kind = 'auxiliary_model_started';

CREATE VIEW model_usage AS
SELECT calls.*, accounting.quote_json, valuation.usd
FROM (SELECT * FROM agent_model_usage UNION ALL SELECT * FROM auxiliary_model_usage) calls
LEFT JOIN model_accounting accounting ON accounting.request_id = calls.event_id
LEFT JOIN model_valuations valuation ON valuation.request_id = calls.event_id;

CREATE VIEW tool_usage AS
SELECT request.sequence, request.event_id,
    json_extract(request.accounting_tool, '$.invocation') AS invocation,
    json_extract(request.accounting_tool, '$.invocation.session_id') AS session_id,
    json_extract(request.accounting_tool, '$.call') AS call,
    json_extract(request.accounting_tool, '$.name') AS name,
    opening.invocation_model AS binding,
    CASE WHEN request.kind = 'tool_rejected' THEN request.accounting_at
        ELSE COALESCE(settled.accounting_at, terminal.accounting_at) END AS completed_at,
    CASE WHEN request.kind = 'tool_rejected' THEN request.sequence
        ELSE COALESCE(settled.sequence, terminal.sequence) END AS completed_sequence,
    CASE WHEN request.kind = 'tool_rejected' THEN json_object(
        'kind', 'rejected', 'reason', json_extract(request.accounting_tool, '$.rejection'))
    ELSE json_object('kind', 'settled', 'startedAt', request.accounting_at,
        'outcome', CASE json_extract(settled.accounting_tool, '$.outcome')
            WHEN 'succeeded' THEN 'success' WHEN 'failed' THEN 'error' ELSE 'unknown' END)
    END AS result
FROM accounting_events request
JOIN accounting_events opening ON opening.invocation_id = request.invocation_id
    AND opening.kind = 'invocation_opened'
LEFT JOIN accounting_events settled ON settled.invocation_id = request.invocation_id
    AND settled.operation_id = request.operation_id AND settled.kind = 'tool_settled'
LEFT JOIN accounting_events terminal ON terminal.invocation_id = request.invocation_id
    AND terminal.kind = 'invocation_ended'
WHERE request.kind IN ('tool_dispatched', 'tool_rejected');

CREATE VIEW usage_activity AS
SELECT 'model' AS kind, sequence, event_id, session_id, completed_sequence,
    binding, completed_at, origin, model_id, started_at, outcome, usage, quote_json, usd,
    NULL AS invocation, NULL AS call, NULL AS name, NULL AS result,
    outcome AS status,
    COALESCE(session_id, '') || ' ' || model_id || ' ' ||
        COALESCE(json_extract(binding, '$.connection_slug'), '') || ' ' ||
        COALESCE(json_extract(quote_json, '$.providerId'), '') AS search
FROM model_usage
UNION ALL
SELECT 'tool', sequence, event_id, session_id, completed_sequence,
    binding, completed_at, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    invocation, call, name, result,
    CASE WHEN json_extract(result, '$.kind') = 'rejected' THEN 'rejected'
        ELSE json_extract(result, '$.outcome') END,
    session_id || ' ' || name || ' ' ||
        COALESCE(json_extract(binding, '$.connection_slug'), '') || ' ' ||
        COALESCE(json_extract(binding, '$.model'), '')
FROM tool_usage;

CREATE VIEW session_message_sources AS
    SELECT session_id AS owner_session_id, session_id AS source_session_id, message_id, event_id
    FROM message_sources
    UNION ALL
    SELECT h.session_id, s.session_id, s.message_id, s.event_id FROM session_history_members h
    JOIN runtime_events e ON e.sequence=h.sequence JOIN message_sources s ON s.event_id=e.event_id
    UNION ALL
    SELECT r.session_id, s.session_id, s.message_id, s.event_id FROM session_revision_sources r
    JOIN runtime_events e ON e.sequence=r.sequence JOIN message_sources s ON s.event_id=e.event_id;

CREATE VIEW local_runtime_events AS
    SELECT e.* FROM runtime_events e
    WHERE NOT EXISTS(SELECT 1 FROM imported_invocations i WHERE i.invocation_id=e.invocation_id);

CREATE VIEW session_history_events AS
    SELECT e.event_session AS owner_session_id,
           0 AS inherited, NULL AS archive_sequence, e.* FROM runtime_events e
    UNION ALL
    SELECT h.session_id, 1, h.archive_sequence, e.*
    FROM session_history_members h JOIN runtime_events e ON e.sequence = h.sequence;


-- Tool spans address logical canonical bytes, while model parts still use a
-- physical SQLite header BLOB. Keep fragment pieces (and their rowids) intact.
CREATE TABLE context_semantic_fragments_new (
    source_sequence INTEGER NOT NULL,
    source_index INTEGER NOT NULL,
    storage_kind TEXT NOT NULL CHECK(storage_kind IN ('pieces','canonical_tool_projection','canonical_model_part')),
    byte_offset INTEGER,
    byte_len INTEGER,
    directory_bytes BLOB NOT NULL,
    payload_bytes INTEGER NOT NULL CHECK(payload_bytes>0),
    CHECK((storage_kind='pieces' AND byte_offset IS NULL AND byte_len IS NULL)
       OR (storage_kind IN ('canonical_tool_projection','canonical_model_part') AND source_sequence>0
           AND (storage_kind='canonical_model_part' OR source_index=0)
           AND byte_offset IS NOT NULL AND byte_offset>=0
           AND byte_len IS NOT NULL AND byte_len>0
           AND byte_offset<=CASE storage_kind WHEN 'canonical_model_part' THEN 2147483647 ELSE 9223372036854775807 END-byte_len)),
    PRIMARY KEY(source_sequence,source_index)
) WITHOUT ROWID;

CREATE TABLE context_semantic_directory_children_new (
    source_sequence INTEGER NOT NULL,
    source_index INTEGER NOT NULL,
    list_kind TEXT NOT NULL CHECK(list_kind IN ('quotes','attachments','tool_parts')),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    directory_bytes BLOB NOT NULL,
    PRIMARY KEY(source_sequence,source_index,list_kind,ordinal),
    FOREIGN KEY(source_sequence,source_index)
        REFERENCES context_semantic_fragments_new(source_sequence,source_index) ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;

INSERT INTO context_semantic_fragments_new SELECT * FROM context_semantic_fragments;
INSERT INTO context_semantic_directory_children_new SELECT * FROM context_semantic_directory_children;
DROP TABLE context_semantic_directory_children;
DROP TABLE context_semantic_fragments;
ALTER TABLE context_semantic_fragments_new RENAME TO context_semantic_fragments;
ALTER TABLE context_semantic_directory_children_new RENAME TO context_semantic_directory_children;
