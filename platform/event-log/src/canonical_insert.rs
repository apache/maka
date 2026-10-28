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

//! One publication boundary derives indexed metadata from the original JSON.

use sqlx::{Sqlite, query::Query, sqlite::SqliteArguments};

pub(crate) struct Record<'json> {
    pub sequence: Option<i64>,
    pub event_id: &'json str,
    pub invocation_id: Option<&'json str>,
    pub kind: &'json str,
    pub operation_id: Option<&'json str>,
    pub json: &'json str,
}

pub(crate) fn insert(record: Record<'_>) -> Query<'_, Sqlite, SqliteArguments> {
    sqlx::query(
        "WITH source(sequence,event_id,invocation_id,kind,operation_id,event_json,retained_json)
         AS (VALUES(?,?,?,?,?,?,NULL))
         INSERT INTO event_log(sequence,event_id,invocation_id,kind,operation_id,event_json,
                               accounting_at,accounting_usage,invocation_model,accounting_tool,event_session)
         SELECT sequence,event_id,invocation_id,kind,operation_id,event_json,
            CASE WHEN kind IN ('model_requested', 'model_completed', 'model_interrupted',
                           'invocation_ended', 'auxiliary_model_started', 'auxiliary_model_settled',
                           'tool_dispatched', 'tool_settled', 'tool_rejected')
        THEN COALESCE(json_extract(COALESCE(event_json, retained_json), '$.recorded_at.secs_since_epoch'),
                      json_extract(COALESCE(event_json, retained_json), '$.started_at.secs_since_epoch'),
                      json_extract(COALESCE(event_json, retained_json), '$.completed_at.secs_since_epoch')) * 1000.0
            + COALESCE(json_extract(COALESCE(event_json, retained_json), '$.recorded_at.nanos_since_epoch'),
                       json_extract(COALESCE(event_json, retained_json), '$.started_at.nanos_since_epoch'),
                       json_extract(COALESCE(event_json, retained_json), '$.completed_at.nanos_since_epoch')) / 1000000.0
        END,
            CASE
            WHEN kind = 'model_completed' THEN json_extract(COALESCE(event_json, retained_json), '$.fact.output.usage')
            WHEN kind = 'model_observed' AND json_extract(COALESCE(event_json, retained_json), '$.fact.event.kind') = 'finished'
                THEN json_extract(COALESCE(event_json, retained_json), '$.fact.event.data.usage')
            WHEN kind = 'auxiliary_model_usage' THEN json_extract(COALESCE(event_json, retained_json), '$.usage')
        END,
            CASE WHEN kind = 'invocation_opened' THEN json_extract(COALESCE(event_json, retained_json), '$.fact.configuration.model') END,
            CASE
            WHEN kind IN ('tool_dispatched', 'tool_rejected') THEN json_object(
                'invocation', json_extract(COALESCE(event_json, retained_json), '$.invocation'),
                'call', json_extract(COALESCE(event_json, retained_json), '$.fact.call'),
                'name', json_extract(COALESCE(event_json, retained_json), '$.fact.name'),
                'rejection', json_extract(COALESCE(event_json, retained_json), '$.fact.reason.kind'))
            WHEN kind = 'tool_settled' THEN json_object(
                'outcome', json_extract(COALESCE(event_json, retained_json), '$.fact.outcome.kind'))
        END,
            json_extract(COALESCE(event_json, retained_json), '$.invocation.session_id')
         FROM source",
    )
    .bind(record.sequence)
    .bind(record.event_id)
    .bind(record.invocation_id)
    .bind(record.kind)
    .bind(record.operation_id)
    .bind(record.json)
}

#[cfg(test)]
mod tests;
