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

CREATE TABLE agent_history_tool_metadata (
    sequence INTEGER PRIMARY KEY REFERENCES agent_session_history(sequence) ON DELETE CASCADE,
    is_error INTEGER NOT NULL CHECK(is_error IN (0,1)),
    image INTEGER NOT NULL CHECK(image IN (0,1)),
    images INTEGER NOT NULL CHECK(images >= 0),
    external_settlement TEXT
);

-- This source is used only when the canonical fact is indexed, and for the
-- initial backfill. Browsing reads the small materialized rows above.
CREATE VIEW agent_history_tool_metadata_source AS
WITH facts AS (
    SELECT h.sequence, h.kind, jsonb(CAST(c.payload AS TEXT)) AS fact
    FROM agent_session_history h
    JOIN agent_facts f ON f.sequence=h.sequence
    JOIN contents c ON c.id=f.body_content_id
    WHERE h.result_source=1
), evidence AS (
    SELECT f.sequence, f.kind, c.payload AS payload
    FROM facts f
    JOIN contents c ON c.content_sha256=CASE f.kind
        WHEN 'cell' THEN json_extract(f.fact,'$.fact.event.result.digest')
        WHEN 'external_effect' THEN json_extract(f.fact,'$.fact.event.output.digest')
        ELSE json_extract(f.fact,'$.fact.result.digest') END
), returns AS (
    SELECT e.sequence, e.kind,
           jsonb(CAST(CASE WHEN e.kind='tool_result_accepted' THEN c.payload ELSE e.payload END AS TEXT)) AS value
    FROM evidence e
    LEFT JOIN contents c ON e.kind='tool_result_accepted'
        AND json_extract(CAST(e.payload AS TEXT),'$.kind') IN ('local','host','operation')
        AND c.content_sha256=json_extract(CAST(e.payload AS TEXT),'$.result.digest')
    WHERE e.kind<>'tool_result_accepted' OR c.id IS NOT NULL
), bodies AS (
    SELECT sequence,kind, CASE WHEN kind='external_effect' THEN value
                              ELSE jsonb_extract(value,'$.body') END AS body
    FROM returns
), media AS (
    SELECT sequence,
           CASE WHEN kind='external_effect' AND json_extract(body,'$.kind')='failure' THEN 1
                ELSE COALESCE(json_extract(body,'$.is_error'),json_extract(body,'$.isError')) END AS is_error,
           CASE WHEN json_extract(body,'$.output.format')='image' THEN json_extract(body,'$.output.value.ref') END AS inline_image,
           CASE json_extract(body,'$.projection.kind')
                WHEN 'inline' THEN jsonb_extract(body,'$.projection.projection.parts')
                WHEN 'content' THEN jsonb_extract(body,'$.projection.parts') END AS parts,
           CASE WHEN kind='external_effect' THEN
                CASE json_extract(body,'$.kind') WHEN 'failure' THEN json_extract(body,'$.settlement')
                                                WHEN 'output' THEN 'returned' END END AS external_settlement
    FROM bodies
)
SELECT m.sequence, m.is_error,
       m.inline_image IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM json_each(m.parts) p
           WHERE json_extract(p.value,'$.kind')='artifact'
             AND json_extract(p.value,'$.image.ref.kind')=json_extract(m.inline_image,'$.kind')
             AND json_extract(p.value,'$.image.ref.sessionId') IS json_extract(m.inline_image,'$.sessionId')
             AND json_extract(p.value,'$.image.ref.refId') IS json_extract(m.inline_image,'$.refId')
             AND json_extract(p.value,'$.image.ref.relativePath') IS json_extract(m.inline_image,'$.relativePath')
             AND json_extract(p.value,'$.image.ref.absolutePath') IS json_extract(m.inline_image,'$.absolutePath')
       ) AS image,
       (SELECT count(*) FROM json_each(m.parts) p WHERE json_extract(p.value,'$.kind')='artifact') AS images,
       m.external_settlement
FROM media m;

INSERT INTO agent_history_tool_metadata SELECT * FROM agent_history_tool_metadata_source;

CREATE TRIGGER agent_history_tool_metadata_insert AFTER INSERT ON agent_session_history
WHEN NEW.result_source=1
BEGIN
    INSERT INTO agent_history_tool_metadata
    SELECT * FROM agent_history_tool_metadata_source WHERE sequence=NEW.sequence;
END;
