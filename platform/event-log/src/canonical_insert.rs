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

use crate::StoreError;

pub(crate) struct Record<'json> {
    pub sequence: Option<i64>,
    pub event_id: &'json str,
    pub invocation_id: Option<&'json str>,
    pub kind: &'json str,
    pub operation_id: Option<&'json str>,
    pub json: &'json str,
}

#[derive(Clone, Copy)]
pub(crate) struct BodyReference {
    pub id: i64,
    pub offset: i64,
    pub json_bytes: i64,
}

pub(crate) fn insert(
    connection: &rusqlite::Connection,
    record: Record<'_>,
) -> Result<usize, StoreError> {
    let bytes = record.json.len();
    insert_header(connection, record, bytes, None)
}

pub(crate) fn insert_header(
    connection: &rusqlite::Connection,
    record: Record<'_>,
    canonical_bytes: usize,
    body: Option<BodyReference>,
) -> Result<usize, StoreError> {
    Ok(connection.prepare_cached(
        "INSERT INTO event_log(sequence,event_id,invocation_id,kind,operation_id,event_header,canonical_bytes,body_id,header_offset,body_json_bytes,
                               accounting_at,accounting_usage,invocation_model,accounting_tool,event_session)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,
            CASE WHEN ?4 IN ('model_requested', 'model_completed', 'model_interrupted',
                           'invocation_ended', 'auxiliary_model_started', 'auxiliary_model_settled',
                           'tool_dispatched', 'tool_settled', 'tool_rejected')
        THEN COALESCE(json_extract(COALESCE(?6, NULL), '$.recorded_at.secs_since_epoch'),
                      json_extract(COALESCE(?6, NULL), '$.started_at.secs_since_epoch'),
                      json_extract(COALESCE(?6, NULL), '$.completed_at.secs_since_epoch')) * 1000.0
            + COALESCE(json_extract(COALESCE(?6, NULL), '$.recorded_at.nanos_since_epoch'),
                       json_extract(COALESCE(?6, NULL), '$.started_at.nanos_since_epoch'),
                       json_extract(COALESCE(?6, NULL), '$.completed_at.nanos_since_epoch')) / 1000000.0
        END,
            CASE
            WHEN ?4 = 'model_completed' THEN json_extract(COALESCE(?6, NULL), '$.fact.output.usage')
            WHEN ?4 = 'model_observed' AND json_extract(COALESCE(?6, NULL), '$.fact.event.kind') = 'finished'
                THEN json_extract(COALESCE(?6, NULL), '$.fact.event.data.usage')
            WHEN ?4 = 'auxiliary_model_usage' THEN json_extract(COALESCE(?6, NULL), '$.usage')
        END,
            CASE WHEN ?4 = 'invocation_opened' THEN json_extract(COALESCE(?6, NULL), '$.fact.configuration.model') END,
            CASE
            WHEN ?4 IN ('tool_dispatched', 'tool_rejected') THEN json_object(
                'invocation', json_extract(COALESCE(?6, NULL), '$.invocation'),
                'call', json_extract(COALESCE(?6, NULL), '$.fact.call'),
                'name', json_extract(COALESCE(?6, NULL), '$.fact.name'),
                'rejection', json_extract(COALESCE(?6, NULL), '$.fact.reason.kind'))
            WHEN ?4 = 'tool_settled' THEN json_object(
                'outcome', json_extract(COALESCE(?6, NULL), '$.fact.outcome.kind'))
        END,
            json_extract(COALESCE(?6, NULL), '$.invocation.session_id'));",
    )?.execute(rusqlite::params![record.sequence,record.event_id,record.invocation_id,record.kind,record.operation_id,record.json,canonical_bytes as i64,body.map(|body| body.id),body.map(|body| body.offset),body.map(|body| body.json_bytes)] )?)
}
