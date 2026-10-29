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

use crate::{
    StoreError,
    turns::{InvocationState, TurnBoundary},
};
use sqlx::Row;
use std::collections::{BTreeMap, HashSet};

/// Original replay starts for active tool display, never effect authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolStreamSeed {
    pub tool_use_id: String,
    pub start_sequence: u64,
}

pub(super) async fn read(
    connection: &mut sqlx::SqliteConnection,
    root: Option<&TurnBoundary>,
) -> Result<Vec<ToolStreamSeed>, StoreError> {
    let Some(root) = root else {
        return Ok(Vec::new());
    };
    if matches!(root.state, InvocationState::Ended { .. })
        || matches!(
            root.input,
            maka_agent_facts::input::InvocationInput::ContextCompact { .. }
        )
    {
        return Ok(Vec::new());
    }
    let invocation = &root.invocation.invocation_id;
    let rows = sqlx::query(SEEDS)
        .bind(invocation)
        .fetch_all(&mut *connection)
        .await?;
    let mut starts = BTreeMap::<String, i64>::new();
    for row in rows {
        let sequence = row.try_get(0)?;
        starts
            .entry(row.try_get(1)?)
            .and_modify(|start| *start = (*start).min(sequence))
            .or_insert(sequence);
    }
    let parts = sqlx::query(PROVIDER_PARTS)
        .bind(invocation)
        .fetch_all(connection)
        .await?;
    let mut provider_calls = BTreeMap::<String, i64>::new();
    let mut provider_results = HashSet::new();
    for part in parts {
        let step: String = part.try_get("step_id")?;
        let call: String = part.try_get("call_id")?;
        let operation = format!("{step}:{call}");
        if part.try_get::<bool, _>("settled")? {
            provider_results.insert(operation);
        } else {
            let sequence = part.try_get("source_sequence")?;
            provider_calls
                .entry(operation)
                .and_modify(|start| *start = (*start).min(sequence))
                .or_insert(sequence);
        }
    }
    for (operation, sequence) in provider_calls {
        if !provider_results.contains(&operation) {
            starts
                .entry(operation)
                .and_modify(|start| *start = (*start).min(sequence))
                .or_insert(sequence);
        }
    }
    let mut starts: Vec<_> = starts.into_iter().collect();
    starts.sort_unstable_by(|(left_id, left), (right_id, right)| {
        left.cmp(right).then_with(|| left_id.cmp(right_id))
    });
    starts
        .into_iter()
        .map(|(operation, sequence)| {
            Ok(ToolStreamSeed {
                tool_use_id: maka_agent_facts::tool_call::tool_use_id(invocation, &operation),
                start_sequence: crate::sequence_number(sequence)?,
            })
        })
        .collect()
}

const SEEDS: &str = r#"
SELECT CASE WHEN w.kind='tool'
    THEN MIN(w.opened_at,COALESCE(call.opened_at,w.opened_at)) ELSE w.opened_at END,
    w.operation_id
FROM context_execution_work w INDEXED BY context_execution_live
LEFT JOIN context_execution_work call ON call.invocation_id=w.invocation_id
    AND call.kind='call' AND call.operation_id=w.operation_id
    AND call.call_id='' AND call.call_name=''
LEFT JOIN runtime_events source ON w.kind='call' AND source.sequence=w.opened_at
LEFT JOIN context_execution_steps step ON step.invocation_id=w.invocation_id
    AND step.operation_id=json_extract(source.event_json,'$.fact.step_id')
WHERE w.invocation_id=?1 AND w.closed_at IS NULL
    AND w.kind IN ('call','tool','executor_tool')
    AND (w.kind!='call' OR (step.purpose='main'
        AND (step.terminal_kind IS NULL OR step.terminal_kind!='model_interrupted')))
"#;

const PROVIDER_PARTS: &str = r#"
SELECT p.source_sequence,p.step_id,
    json_extract(e.event_json,'$.fact.event.data.part.kind')='tool_result' AS settled,
    CASE json_extract(e.event_json,'$.fact.event.data.part.kind')
        WHEN 'tool_call' THEN json_extract(e.event_json,'$.fact.event.data.part.call.id')
        ELSE json_extract(e.event_json,'$.fact.event.data.part.id') END AS call_id
FROM context_execution_work w INDEXED BY context_execution_live
CROSS JOIN context_execution_steps step ON step.invocation_id=w.invocation_id
    AND step.operation_id=w.operation_id AND step.purpose='main'
CROSS JOIN model_part_records p ON p.invocation_id=w.invocation_id AND p.step_id=w.operation_id
    AND p.record_kind='part'
CROSS JOIN runtime_events e ON e.sequence=p.source_sequence AND e.kind='model_observed'
WHERE w.invocation_id=?1 AND w.kind='model' AND w.closed_at IS NULL
    AND (json_extract(e.event_json,'$.fact.event.data.part.kind')='tool_result'
        OR (json_extract(e.event_json,'$.fact.event.data.part.kind')='tool_call'
            AND json_extract(e.event_json,'$.fact.event.data.part.call.provider_executed')=1))
"#;

#[cfg(test)]
mod tests;
