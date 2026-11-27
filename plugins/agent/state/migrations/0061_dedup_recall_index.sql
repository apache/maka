-- Licensed to the Apache Software Foundation (ASF) under one
-- or more contributor license agreements.  See the NOTICE file
-- distributed with this work for additional information
-- regarding copyright ownership.  The ASF licenses this file
-- to you under the Apache License, Version 2.0 (the
-- "License"); you may not use this file except in compliance
-- with the License.  You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing,
-- software distributed under the License is distributed on an
-- "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
-- KIND, either express or implied.  See the License for the
-- specific language governing permissions and limitations
-- under the License.

-- Deduplicate Recall indexing at the source (body and FTS5 together):
-- 1. Preserve pre-v60 Memory-evidenced conversation fact IDs so historical
--    evidence byte offsets remain exact across migration and future rebuilds.
-- 2. Mark v60+ snapshot positions with compact = 1 so snapshot navigation matches
--    live compact Recall layout while historical snapshots keep legacy layout.
-- 3. Add explicit single-hop body_ref columns on agent_recall_messages so
--    superseded CellEvent::Completed and LocalToolReturned rows release their
--    duplicate bodies and FTS5 postings without disappearing from fixed cuts.
-- 4. Track external streaming delta segments explicitly in
--    agent_recall_external_segments for O(1) live coalescing, O(tail) sealing,
--    lazy fixed-cut reads, and exact per-delta time-window filtering.
-- 5. Update agent_memory_cell_code_insert so CellEvent::Started rows without
--    the legacy JSON receipt prefix still register their code span.
-- 6. The companion data migration rebuilds Recall and optimizes FTS5.
ALTER TABLE agent_history_snapshot_positions
    ADD COLUMN compact INTEGER NOT NULL DEFAULT 0 CHECK(compact IN (0, 1));

ALTER TABLE agent_recall_messages ADD COLUMN body_ref_sequence INTEGER;
ALTER TABLE agent_recall_messages ADD COLUMN body_ref_start INTEGER;
ALTER TABLE agent_recall_messages ADD COLUMN body_ref_end INTEGER;

CREATE INDEX agent_recall_body_ref
    ON agent_recall_messages(owner, session, body_ref_sequence)
    WHERE body_ref_sequence IS NOT NULL;

CREATE TABLE agent_recall_external_segments (
    owner TEXT NOT NULL,
    session TEXT NOT NULL,
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
    PRIMARY KEY(owner, session, run, task, message_id, is_thinking, s0_sequence)
) WITHOUT ROWID;

CREATE INDEX agent_recall_external_segments_open
    ON agent_recall_external_segments(owner, session, run)
    WHERE sealed = 0;

CREATE INDEX agent_recall_external_segments_cut
    ON agent_recall_external_segments(owner, session, tail_start_sequence, tail_end_sequence)
    WHERE tail_start_sequence IS NOT NULL;

CREATE INDEX agent_recall_external_segments_sealed_seq
    ON agent_recall_external_segments(owner, session, tail_end_sequence)
    WHERE sealed = 1 AND tail_end_sequence IS NOT NULL;

CREATE TABLE agent_recall_legacy_evidenced (
    fact_id TEXT PRIMARY KEY
) WITHOUT ROWID;

INSERT OR IGNORE INTO agent_recall_legacy_evidenced(fact_id)
SELECT DISTINCT CAST(json_extract(source, '$.reference.factId') AS TEXT)
FROM agent_memory_evidence
WHERE json_extract(source, '$.kind') = 'conversation'
  AND json_extract(source, '$.reference.factId') IS NOT NULL;

DROP TRIGGER agent_memory_cell_code_insert;

CREATE TRIGGER agent_memory_cell_code_insert AFTER INSERT ON agent_recall_messages
 WHEN NEW.ordinal=0 AND (
   NEW.fields_json->>'$[#-1].field'='arguments'
   OR (
     NEW.fields_json->>'$[#-1].field'='body'
     AND EXISTS(SELECT 1 FROM agent_session_history h WHERE h.sequence=NEW.sequence AND h.kind='cell')
   )
 ) BEGIN
 INSERT INTO agent_memory_shared_fields SELECT * FROM agent_memory_cell_code_fields WHERE message=NEW.id;
END;
