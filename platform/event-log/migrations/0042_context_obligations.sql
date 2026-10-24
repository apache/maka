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

-- Derived unresolved work, maintained by the sole EventLog writer in the same
-- transaction as each admitted fact. Absence means settled, never merely ended.
-- This is not a second execution authority or a private-byte verification cache.
CREATE TABLE context_obligations (
    session_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('invocation','tool','model','call','completed_provider','interrupted_provider')),
    operation_id TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    sealed_unknown INTEGER NOT NULL CHECK(sealed_unknown IN (0,1)),
    PRIMARY KEY(invocation_id, kind, operation_id)
) WITHOUT ROWID;
CREATE INDEX context_obligations_session ON context_obligations(session_id, kind, invocation_id);
CREATE INDEX context_obligations_openings ON context_obligations(opened_at) WHERE kind='invocation';

-- A cut at or beyond this watermark can use current obligations. Earlier cuts
-- derive their own answer; later settlement must not rewrite their meaning.
CREATE TABLE context_safety_heads (
    session_id TEXT PRIMARY KEY,
    through_sequence INTEGER NOT NULL
) WITHOUT ROWID;

INSERT INTO context_safety_heads SELECT event_session, MAX(sequence) FROM runtime_events GROUP BY event_session;

INSERT INTO context_obligations
SELECT e.event_session, e.invocation_id, 'invocation', '', e.sequence,
       0
FROM runtime_events e
WHERE e.kind='invocation_opened'
  AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.kind='invocation_ended');

INSERT INTO context_obligations
SELECT e.event_session, e.invocation_id, 'tool', e.operation_id, e.sequence,
       EXISTS(SELECT 1 FROM runtime_events terminal
         WHERE terminal.invocation_id=e.invocation_id AND terminal.kind='invocation_ended'
           AND json_extract(terminal.event_json,'$.fact.outcome.class')='outcome_unknown')
FROM runtime_events e
WHERE e.kind='tool_dispatched'
  AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.operation_id=e.operation_id AND t.kind='tool_settled');

INSERT INTO context_obligations
SELECT e.event_session, e.invocation_id, 'model', e.operation_id, e.sequence,
       0
FROM runtime_events e
WHERE e.kind='model_requested'
  AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.operation_id=e.operation_id AND t.kind IN ('model_completed','model_interrupted'));

INSERT INTO context_obligations
SELECT e.event_session, e.invocation_id, 'call', e.operation_id || ':' || json_extract(p.value,'$.call.id'), e.sequence,
       0
FROM runtime_events e, json_each(e.event_json,'$.fact.output.parts') p
WHERE e.kind='model_completed' AND json_extract(p.value,'$.kind')='tool_call'
  AND json_extract(p.value,'$.call.provider_executed')=0
  AND NOT EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=e.invocation_id AND r.operation_id=e.operation_id AND r.kind='model_requested' AND json_extract(r.event_json,'$.fact.item_acceptance')=1)
  AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=e.invocation_id
    AND d.operation_id=e.operation_id || ':' || json_extract(p.value,'$.call.id') AND d.kind IN ('tool_dispatched','tool_rejected'));

INSERT INTO context_obligations
SELECT e.event_session, e.invocation_id, 'call', json_extract(e.event_json,'$.fact.step_id') || ':' || json_extract(e.event_json,'$.fact.event.data.id'), e.sequence,
       0
FROM runtime_events e
WHERE e.kind='model_observed' AND json_extract(e.event_json,'$.fact.event.kind')='tool_call'
  AND json_extract(e.event_json,'$.fact.event.data.provider_executed')=0
  AND EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=e.invocation_id
    AND r.operation_id=json_extract(e.event_json,'$.fact.step_id') AND r.kind='model_requested' AND json_extract(r.event_json,'$.fact.item_acceptance')=1)
  AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=e.invocation_id
    AND d.operation_id=json_extract(e.event_json,'$.fact.step_id') || ':' || json_extract(e.event_json,'$.fact.event.data.id') AND d.kind IN ('tool_dispatched','tool_rejected'));

INSERT INTO context_obligations
SELECT e.event_session, e.invocation_id, 'completed_provider', e.operation_id, e.sequence,
       0
FROM runtime_events e
WHERE e.kind='model_completed'
  AND EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') p
    WHERE json_extract(p.value,'$.kind')='tool_call' AND json_extract(p.value,'$.call.provider_executed')=1
    AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') result
      WHERE json_extract(result.value,'$.kind')='tool_result'
        AND json_extract(result.value,'$.id')=json_extract(p.value,'$.call.id')
        AND json_extract(result.value,'$.name')=json_extract(p.value,'$.call.name')));

INSERT INTO context_obligations
SELECT e.event_session, e.invocation_id, 'interrupted_provider', e.operation_id, e.sequence,
       0
FROM runtime_events e
WHERE e.kind='model_interrupted'
  AND EXISTS(SELECT 1 FROM runtime_events call WHERE call.invocation_id=e.invocation_id AND call.kind='model_observed'
    AND CAST(json_extract(call.event_json,'$.fact.step_id') AS TEXT)=e.operation_id
    AND call.sequence<e.sequence AND json_extract(call.event_json,'$.fact.event.kind')='tool_call'
    AND json_extract(call.event_json,'$.fact.event.data.provider_executed')=1
    AND NOT EXISTS(SELECT 1 FROM runtime_events result WHERE result.invocation_id=call.invocation_id
      AND result.kind='model_observed' AND result.sequence>call.sequence AND result.sequence<e.sequence
      AND CAST(json_extract(result.event_json,'$.fact.step_id') AS TEXT)=e.operation_id
      AND json_extract(result.event_json,'$.fact.event.kind')='provider_tool_result'
      AND json_extract(result.event_json,'$.fact.event.data.id')=json_extract(call.event_json,'$.fact.event.data.id')
      AND json_extract(result.event_json,'$.fact.event.data.name')=json_extract(call.event_json,'$.fact.event.data.name')));

-- All canonical append, fast append and import paths insert event_log rows.
-- Restrict work to effect-bearing facts; streaming token deltas do no safety SQL.
CREATE TRIGGER context_obligations_append AFTER INSERT ON event_log
WHEN NEW.invocation_id IS NOT NULL AND NEW.event_json IS NOT NULL AND (
    NEW.kind IN ('invocation_opened','invocation_ended','tool_dispatched','tool_rejected','tool_settled','model_requested','model_completed','model_interrupted')
    OR (NEW.kind='model_observed' AND json_extract(NEW.event_json,'$.fact.event.kind')='tool_call'))
BEGIN
    INSERT INTO context_safety_heads VALUES(NEW.event_session, NEW.sequence)
      ON CONFLICT(session_id) DO UPDATE SET through_sequence=MAX(through_sequence, excluded.through_sequence);

    DELETE FROM context_obligations WHERE invocation_id=NEW.invocation_id AND (
      (NEW.kind='invocation_ended' AND kind='invocation')
      OR (NEW.kind='tool_settled' AND kind='tool' AND operation_id=NEW.operation_id)
      OR (NEW.kind IN ('model_completed','model_interrupted') AND kind='model' AND operation_id=NEW.operation_id)
      OR (NEW.kind IN ('tool_dispatched','tool_rejected') AND kind='call' AND operation_id=NEW.operation_id));

    -- A manual message can observe a sealed unknown dispatch; replay cannot.
    UPDATE context_obligations SET sealed_unknown=1
      WHERE NEW.kind='invocation_ended' AND json_extract(NEW.event_json,'$.fact.outcome.class')='outcome_unknown'
        AND invocation_id=NEW.invocation_id AND kind='tool';

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'invocation', '', e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='invocation_opened'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.kind='invocation_ended');

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'tool', e.operation_id, e.sequence,
           EXISTS(SELECT 1 FROM runtime_events terminal
             WHERE terminal.invocation_id=e.invocation_id AND terminal.kind='invocation_ended'
               AND json_extract(terminal.event_json,'$.fact.outcome.class')='outcome_unknown')
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='tool_dispatched'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.operation_id=e.operation_id AND t.kind='tool_settled');

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'model', e.operation_id, e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='model_requested'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.operation_id=e.operation_id AND t.kind IN ('model_completed','model_interrupted'));

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'call', e.operation_id || ':' || json_extract(p.value,'$.call.id'), e.sequence,
           0
    FROM runtime_events e, json_each(e.event_json,'$.fact.output.parts') p
    WHERE e.sequence=NEW.sequence AND e.kind='model_completed' AND json_extract(p.value,'$.kind')='tool_call'
      AND json_extract(p.value,'$.call.provider_executed')=0
      AND NOT EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=e.invocation_id AND r.operation_id=e.operation_id AND r.kind='model_requested' AND json_extract(r.event_json,'$.fact.item_acceptance')=1)
      AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=e.invocation_id
        AND d.operation_id=e.operation_id || ':' || json_extract(p.value,'$.call.id') AND d.kind IN ('tool_dispatched','tool_rejected'));

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'call', json_extract(e.event_json,'$.fact.step_id') || ':' || json_extract(e.event_json,'$.fact.event.data.id'), e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='model_observed' AND json_extract(e.event_json,'$.fact.event.kind')='tool_call'
      AND json_extract(e.event_json,'$.fact.event.data.provider_executed')=0
      AND EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=e.invocation_id
        AND r.operation_id=json_extract(e.event_json,'$.fact.step_id') AND r.kind='model_requested' AND json_extract(r.event_json,'$.fact.item_acceptance')=1)
      AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=e.invocation_id
        AND d.operation_id=json_extract(e.event_json,'$.fact.step_id') || ':' || json_extract(e.event_json,'$.fact.event.data.id') AND d.kind IN ('tool_dispatched','tool_rejected'));

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'completed_provider', e.operation_id, e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='model_completed'
      AND EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') p
        WHERE json_extract(p.value,'$.kind')='tool_call' AND json_extract(p.value,'$.call.provider_executed')=1
        AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') result
          WHERE json_extract(result.value,'$.kind')='tool_result'
            AND json_extract(result.value,'$.id')=json_extract(p.value,'$.call.id')
            AND json_extract(result.value,'$.name')=json_extract(p.value,'$.call.name')));

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'interrupted_provider', e.operation_id, e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='model_interrupted'
      AND EXISTS(SELECT 1 FROM runtime_events call WHERE call.invocation_id=e.invocation_id AND call.kind='model_observed'
        AND CAST(json_extract(call.event_json,'$.fact.step_id') AS TEXT)=e.operation_id
        AND call.sequence<e.sequence AND json_extract(call.event_json,'$.fact.event.kind')='tool_call'
        AND json_extract(call.event_json,'$.fact.event.data.provider_executed')=1
        AND NOT EXISTS(SELECT 1 FROM runtime_events result WHERE result.invocation_id=call.invocation_id
          AND result.kind='model_observed' AND result.sequence>call.sequence AND result.sequence<e.sequence
          AND CAST(json_extract(result.event_json,'$.fact.step_id') AS TEXT)=e.operation_id
          AND json_extract(result.event_json,'$.fact.event.kind')='provider_tool_result'
          AND json_extract(result.event_json,'$.fact.event.data.id')=json_extract(call.event_json,'$.fact.event.data.id')
          AND json_extract(result.event_json,'$.fact.event.data.name')=json_extract(call.event_json,'$.fact.event.data.name')));

END;
