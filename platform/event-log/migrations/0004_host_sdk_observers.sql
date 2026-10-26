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

DROP TRIGGER context_execution_append;

CREATE TRIGGER context_execution_append AFTER INSERT ON event_log
WHEN NEW.invocation_id IS NOT NULL AND NEW.event_json IS NOT NULL
  AND NEW.kind IN ('model_requested','model_observed','model_completed','model_interrupted','tool_dispatched','tool_rejected','tool_settled')
BEGIN
    INSERT INTO context_execution_steps(invocation_id,operation_id,requested_at,purpose,item_acceptance)
    SELECT NEW.invocation_id,NEW.operation_id,NEW.sequence,json_extract(NEW.event_json,'$.fact.purpose'),
        COALESCE(json_extract(NEW.event_json,'$.fact.item_acceptance'),0)
    WHERE NEW.kind='model_requested';

    UPDATE context_execution_steps SET
        observed_at=COALESCE(observed_at,NEW.sequence),
        tool_observed_at=COALESCE(tool_observed_at,CASE WHEN json_extract(NEW.event_json,'$.fact.event.kind') IN ('tool_call','provider_tool_result') THEN NEW.sequence END),
        barrier_at=COALESCE(barrier_at,CASE WHEN (json_extract(NEW.event_json,'$.fact.event.kind') IN ('provider_tool_result','finished')
    OR (json_extract(NEW.event_json,'$.fact.event.kind')='tool_call' AND json_extract(NEW.event_json,'$.fact.event.data.provider_executed')=1)
    OR (json_extract(NEW.event_json,'$.fact.event.data.provider_options') IS NOT NULL
        AND json_extract(NEW.event_json,'$.fact.event.data.provider_options')!='{}')) THEN NEW.sequence END),
        accepted_at=COALESCE(accepted_at,CASE WHEN json_extract(NEW.event_json,'$.fact.event.kind') IN ('source','part_finished','tool_call','provider_tool_result') THEN NEW.sequence END)
    WHERE NEW.kind='model_observed' AND invocation_id=NEW.invocation_id
      AND operation_id=CAST(json_extract(NEW.event_json,'$.fact.step_id') AS TEXT)
      AND (observed_at IS NULL OR (tool_observed_at IS NULL AND json_extract(NEW.event_json,'$.fact.event.kind') IN ('tool_call','provider_tool_result'))
        OR (barrier_at IS NULL AND (json_extract(NEW.event_json,'$.fact.event.kind') IN ('provider_tool_result','finished')
    OR (json_extract(NEW.event_json,'$.fact.event.kind')='tool_call' AND json_extract(NEW.event_json,'$.fact.event.data.provider_executed')=1)
    OR (json_extract(NEW.event_json,'$.fact.event.data.provider_options') IS NOT NULL
        AND json_extract(NEW.event_json,'$.fact.event.data.provider_options')!='{}'))) OR (accepted_at IS NULL AND json_extract(NEW.event_json,'$.fact.event.kind') IN ('source','part_finished','tool_call','provider_tool_result')));

    UPDATE context_execution_steps SET terminal_at=NEW.sequence,terminal_kind=NEW.kind,
        terminal_status=json_extract(NEW.event_json,'$.fact.status')
    WHERE NEW.kind IN ('model_completed','model_interrupted')
      AND invocation_id=NEW.invocation_id AND operation_id=NEW.operation_id;

    INSERT INTO context_independent_tools
    SELECT NEW.invocation_id,NEW.operation_id,NEW.sequence
    WHERE NEW.kind IN ('tool_dispatched','tool_rejected')
      AND ((NEW.kind='tool_dispatched' AND (
          json_extract(NEW.event_json,'$.fact.call.origin.kind')='code_cell'
          OR (json_extract(NEW.event_json,'$.fact.call.origin.kind')='host_sdk'
            AND json_extract(NEW.event_json,'$.fact.call.origin.parent_relationship.kind')='evaluation_observer')))
        OR EXISTS(SELECT 1 FROM context_independent_tools p WHERE p.invocation_id=NEW.invocation_id
          AND p.operation_id=json_extract(NEW.event_json,'$.fact.call.origin.parent_operation_id')));

    UPDATE context_execution_work SET closed_at=NEW.sequence
    WHERE NEW.kind='tool_settled' AND invocation_id=NEW.invocation_id AND kind='tool'
      AND operation_id=NEW.operation_id AND closed_at IS NULL;
    UPDATE context_execution_work SET closed_at=NEW.sequence
    WHERE NEW.kind IN ('model_completed','model_interrupted') AND invocation_id=NEW.invocation_id AND kind='model'
      AND operation_id=NEW.operation_id AND closed_at IS NULL;
    UPDATE context_execution_work SET closed_at=NEW.sequence
    WHERE NEW.kind IN ('tool_dispatched','tool_rejected') AND invocation_id=NEW.invocation_id AND kind='call'
      AND operation_id=NEW.operation_id AND closed_at IS NULL;
    UPDATE context_execution_work SET closed_at=NEW.sequence
    WHERE NEW.kind='model_observed' AND json_extract(NEW.event_json,'$.fact.event.kind')='provider_tool_result'
      AND invocation_id=NEW.invocation_id AND kind='accepted_provider'
      AND operation_id=CAST(json_extract(NEW.event_json,'$.fact.step_id') AS TEXT)
      AND call_id=json_extract(NEW.event_json,'$.fact.event.data.id')
      AND call_name=json_extract(NEW.event_json,'$.fact.event.data.name') AND closed_at IS NULL;

INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'tool',e.operation_id,e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id
       AND t.operation_id=e.operation_id AND t.kind='tool_settled')
FROM runtime_events e WHERE e.kind='tool_dispatched' AND e.sequence=NEW.sequence;

INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'model',e.operation_id,e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id
       AND t.operation_id=e.operation_id AND t.kind IN ('model_completed','model_interrupted'))
FROM runtime_events e WHERE e.kind='model_requested' AND e.sequence=NEW.sequence;

INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'call',e.operation_id || ':' || json_extract(p.value,'$.call.id'),e.sequence,
    (SELECT MIN(d.sequence) FROM runtime_events d WHERE d.invocation_id=e.invocation_id
       AND d.operation_id=e.operation_id || ':' || json_extract(p.value,'$.call.id')
       AND d.kind IN ('tool_dispatched','tool_rejected'))
FROM runtime_events e,json_each(e.event_json,'$.fact.output.parts') p
WHERE e.kind='model_completed' AND e.sequence=NEW.sequence AND json_extract(p.value,'$.kind')='tool_call'
  AND json_extract(p.value,'$.call.provider_executed')=0
  AND NOT EXISTS(SELECT 1 FROM context_execution_steps s WHERE s.invocation_id=e.invocation_id
    AND s.operation_id=e.operation_id AND s.item_acceptance=1);

INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'call',s.operation_id || ':' || json_extract(e.event_json,'$.fact.event.data.id'),e.sequence,
    (SELECT MIN(d.sequence) FROM runtime_events d WHERE d.invocation_id=e.invocation_id
       AND d.operation_id=s.operation_id || ':' || json_extract(e.event_json,'$.fact.event.data.id')
       AND d.kind IN ('tool_dispatched','tool_rejected'))
FROM runtime_events e JOIN context_execution_steps s ON s.invocation_id=e.invocation_id
    AND s.operation_id=CAST(json_extract(e.event_json,'$.fact.step_id') AS TEXT) AND s.item_acceptance=1
WHERE e.kind='model_observed' AND e.sequence=NEW.sequence AND json_extract(e.event_json,'$.fact.event.kind')='tool_call'
  AND json_extract(e.event_json,'$.fact.event.data.provider_executed')=0;

INSERT INTO context_execution_work(invocation_id,kind,operation_id,call_id,call_name,opened_at,closed_at)
SELECT e.invocation_id,'accepted_provider',s.operation_id,
    json_extract(e.event_json,'$.fact.event.data.id'),json_extract(e.event_json,'$.fact.event.data.name'),e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.kind='model_observed'
       AND CAST(json_extract(t.event_json,'$.fact.step_id') AS TEXT)=s.operation_id
       AND json_extract(t.event_json,'$.fact.event.kind')='provider_tool_result'
       AND json_extract(t.event_json,'$.fact.event.data.id')=json_extract(e.event_json,'$.fact.event.data.id')
       AND json_extract(t.event_json,'$.fact.event.data.name')=json_extract(e.event_json,'$.fact.event.data.name'))
FROM runtime_events e JOIN context_execution_steps s ON s.invocation_id=e.invocation_id
    AND s.operation_id=CAST(json_extract(e.event_json,'$.fact.step_id') AS TEXT) AND s.item_acceptance=1
WHERE e.kind='model_observed' AND e.sequence=NEW.sequence AND json_extract(e.event_json,'$.fact.event.kind')='tool_call'
  AND json_extract(e.event_json,'$.fact.event.data.provider_executed')=1;

INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at)
SELECT e.invocation_id,'completed_provider',e.operation_id,e.sequence
FROM runtime_events e WHERE e.kind='model_completed' AND e.sequence=NEW.sequence
  AND EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') p
    WHERE json_extract(p.value,'$.kind')='tool_call' AND json_extract(p.value,'$.call.provider_executed')=1
      AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') result
        WHERE json_extract(result.value,'$.kind')='tool_result'
          AND json_extract(result.value,'$.id')=json_extract(p.value,'$.call.id')
          AND json_extract(result.value,'$.name')=json_extract(p.value,'$.call.name')));

INSERT OR IGNORE INTO context_execution_work(invocation_id,kind,operation_id,opened_at)
SELECT s.invocation_id,'interrupted',s.operation_id,
    MAX(s.terminal_at,s.observed_at,CASE WHEN s.terminal_status='retryable_failure' THEN s.barrier_at ELSE s.observed_at END)
FROM context_execution_steps s WHERE s.terminal_kind='model_interrupted' AND s.observed_at IS NOT NULL
  AND (s.terminal_status!='retryable_failure' OR (s.item_acceptance!=1 AND s.barrier_at IS NOT NULL))
  AND NOT COALESCE(s.purpose='summary' AND s.tool_observed_at IS NULL,0) AND s.invocation_id=NEW.invocation_id AND s.operation_id=CAST(json_extract(NEW.event_json,'$.fact.step_id') AS TEXT);
END;
