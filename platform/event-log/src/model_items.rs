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

//! Complete canonical model parts and their original identity/acceptance boundary.
use crate::StoreError;
use futures_util::TryStreamExt;
use maka_agent_facts::{
    context::ModelPurpose,
    event::{Fact, Invocation, RuntimeEvent, StoredEvent},
    model::{
        ModelPart, ModelToolCall,
        recorded::{CompletionPart, ModelObservation, ModelPartRecord},
    },
};
use sqlx::{SqliteConnection, sqlite::SqliteWorkerConnection};
use std::collections::{HashMap, HashSet};

// One selection rule for recovery, context fences and archive causality.
macro_rules! accepted_calls {
    () => { "accepted_calls AS NOT MATERIALIZED (
        SELECT s.invocation_id,s.step_id,s.sequence,s.event_id,json_extract(b.part,'$.call') AS call
        FROM model_selected_parts s JOIN runtime_events m ON m.sequence=s.sequence JOIN model_part_bodies b
          ON b.event_id=s.body_event_id AND b.ordinal=s.ordinal
        JOIN runtime_events r ON r.invocation_id=s.invocation_id AND r.operation_id=s.step_id AND r.kind='model_requested'
        WHERE s.terminal_kind='model_completed' AND COALESCE(json_extract(r.event_header,'$.fact.item_acceptance'),0)=0
          AND json_extract(b.part,'$.kind')='tool_call'
        UNION ALL
        SELECT b.invocation_id,b.step_id,b.source_sequence,b.event_id,json_extract(b.part,'$.call')
        FROM model_part_bodies b JOIN runtime_events o ON o.sequence=b.source_sequence JOIN runtime_events r ON r.invocation_id=b.invocation_id
          AND r.operation_id=b.step_id AND r.kind='model_requested'
        WHERE b.source_kind='model_observed' AND json_extract(r.event_header,'$.fact.item_acceptance')=1
          AND json_extract(b.part,'$.kind')='tool_call'
    )" };
}
pub(crate) use accepted_calls;

fn invalid(reason: impl std::fmt::Display) -> StoreError {
    StoreError::InvalidTransition(format!("invalid model part: {reason}"))
}

fn provider_identity(value: &str) -> Result<(), StoreError> {
    if value.is_empty() {
        Err(invalid("empty provider identity"))
    } else {
        Ok(())
    }
}

pub(crate) async fn mode(
    connection: &mut SqliteConnection,
    invocation: &str,
    step: &str,
) -> Result<(bool, Option<ModelPurpose>), StoreError> {
    let (enabled, purpose): (bool, Option<String>) = sqlx::query_as(
        "SELECT COALESCE(json_extract(event_header,'$.fact.item_acceptance'),0),
                json_extract(event_header,'$.fact.purpose') FROM runtime_events
         WHERE invocation_id=? AND operation_id=? AND kind='model_requested'",
    )
    .bind(invocation)
    .bind(step)
    .fetch_optional(connection)
    .await?
    .ok_or_else(|| invalid("model part lacks its original request"))?;
    let purpose = purpose
        .map(|value| serde_json::from_value(serde_json::Value::String(value)))
        .transpose()?;
    Ok((enabled, purpose))
}

pub(crate) async fn validate(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let (step, parts, inputs) = match &event.fact {
        Fact::ModelRequested {
            item_acceptance: true,
            purpose,
            ..
        } => {
            return if *purpose == ModelPurpose::Main {
                Ok(())
            } else {
                Err(invalid("item acceptance requires a main request"))
            };
        }
        Fact::ModelObserved {
            step_id,
            event: ModelObservation::Part(record),
        } => {
            let (enabled, purpose) =
                mode(connection, &event.invocation.invocation_id, step_id).await?;
            if !(purpose == Some(ModelPurpose::Main) && enabled)
                && !matches!(record.part.as_ref(),
                ModelPart::ToolCall { call } if call.provider_executed)
                && !matches!(record.part.as_ref(), ModelPart::ToolResult { .. })
            {
                return Err(invalid(
                    "completion-only request cannot accept an early local part",
                ));
            }
            check_record(connection, event, step_id, record).await?;
            validate_result(connection, event, step_id, record, &HashMap::new()).await?;
            return Ok(());
        }
        Fact::ModelCompleted { step_id, output } => {
            let (enabled, _) = mode(connection, &event.invocation.invocation_id, step_id).await?;
            let witness: Option<(String, String)> = sqlx::query_as(
                "SELECT json_extract(event_header,'$.fact.event.data.reason'),json_extract(event_header,'$.fact.event.data.usage')
                 FROM runtime_events WHERE invocation_id=? AND kind='model_observed'
                 AND json_extract(event_header,'$.fact.step_id')=? AND json_extract(event_header,'$.fact.event.kind')='finished'
                 ORDER BY sequence DESC LIMIT 1",
            ).bind(&event.invocation.invocation_id).bind(step_id).fetch_optional(&mut *connection).await?;
            if let Some((reason, usage)) = witness {
                let reason: maka_agent_facts::model::ModelFinishReason =
                    serde_json::from_value(serde_json::Value::String(reason))?;
                let usage: maka_agent_facts::model::ModelUsage = serde_json::from_str(&usage)?;
                if reason != output.finish_reason || usage != output.usage {
                    return Err(invalid(
                        "completion differs from its original terminal witness",
                    ));
                }
            } else if enabled {
                return Err(invalid(
                    "item-acceptance completion lacks its terminal witness",
                ));
            }
            (step_id, output.parts.as_slice(), &[][..])
        }
        Fact::ModelInterrupted {
            step_id,
            partial: Some(partial),
            ..
        } => {
            let (_, purpose) = mode(connection, &event.invocation.invocation_id, step_id).await?;
            if purpose == Some(ModelPurpose::Summary) {
                return Err(invalid(
                    "summary interruption cannot publish private partial output",
                ));
            }
            (
                step_id,
                partial.parts.as_slice(),
                partial.tool_inputs.as_slice(),
            )
        }
        _ => return Ok(()),
    };
    let incoming_provider_calls: HashMap<_, _> = parts
        .iter()
        .filter_map(|part| match part {
            CompletionPart::Own(record) => match record.part.as_ref() {
                ModelPart::ToolCall { call } if call.provider_executed => {
                    Some(((call.id.as_str(), call.name.as_str()), record.ordinal))
                }
                _ => None,
            },
            CompletionPart::Ref(_) => None,
        })
        .collect();
    let mut results = HashSet::new();
    let mut previous = None;
    let mut messages = HashSet::new();
    for (index, part) in parts.iter().enumerate() {
        let ordinal =
            match part {
                CompletionPart::Own(record) => {
                    if !messages.insert(record.message_id.as_str()) {
                        return Err(invalid("duplicate visible message identity"));
                    }
                    check_record(connection, event, step, record).await?;
                    if let ModelPart::ToolResult { id, name, .. } = record.part.as_ref()
                        && !results.insert((id.as_str(), name.as_str()))
                    {
                        return Err(invalid("duplicate provider result"));
                    }
                    validate_result(connection, event, step, record, &incoming_provider_calls)
                        .await?;

                    record.ordinal
                }
                CompletionPart::Ref(reference) => {
                    let original: Option<(String, String, String, i64)> = sqlx::query_as(
                    "SELECT owner_session_id,invocation_id,step_id,ordinal FROM model_part_records
                     WHERE event_id=? AND ordinal=? AND record_kind='part'",
                ).bind(&reference.event_id).bind(i64::try_from(reference.ordinal).map_err(invalid)?)
                    .fetch_optional(&mut *connection).await?;
                    if original
                        != Some((
                            event.invocation.session_id.clone(),
                            event.invocation.invocation_id.clone(),
                            step.clone(),
                            i64::try_from(reference.ordinal).map_err(invalid)?,
                        ))
                    {
                        return Err(invalid(
                            "reference does not name this invocation's original step part",
                        ));
                    }
                    reference.ordinal
                }
            };
        if matches!(&event.fact, Fact::ModelCompleted { .. }) && ordinal != index as u64 {
            return Err(invalid(
                "completion does not contain the whole original ordinal sequence",
            ));
        }
        if previous.is_some_and(|prior| prior >= ordinal) {
            return Err(invalid("terminal parts are not in original ordinal order"));
        }
        previous = Some(ordinal);
    }
    // A completion names the whole attempt. An interruption may omit already
    // accepted items because their original rows remain authoritative.
    if matches!(&event.fact, Fact::ModelCompleted { .. }) {
        let originals: Vec<(String, i64)> = sqlx::query_as(
            "SELECT event_id,ordinal FROM model_part_records WHERE invocation_id=? AND step_id=?
             AND record_kind='part' ORDER BY ordinal",
        )
        .bind(&event.invocation.invocation_id)
        .bind(step)
        .fetch_all(&mut *connection)
        .await?;
        let references: HashSet<_> = parts
            .iter()
            .filter_map(|part| match part {
                CompletionPart::Ref(reference) => {
                    Some((reference.event_id.as_str(), reference.ordinal))
                }
                CompletionPart::Own(_) => None,
            })
            .collect();
        for (id, ordinal) in originals {
            if !references.contains(&(id.as_str(), ordinal as u64)) {
                return Err(invalid("terminal output omits an observed original part"));
            }
        }
    }
    for input in inputs {
        if !messages.insert(input.message_id.as_str()) {
            return Err(invalid("duplicate partial tool-input display identity"));
        }
        provider_identity(&input.id)?;
        if input.message_id
            != maka_agent_facts::tool_call::tool_use_id(
                &event.invocation.invocation_id,
                &format!("{step}:{}", input.id),
            )
        {
            return Err(invalid(
                "tool-input identity differs from its original call",
            ));
        }
        validate_derived_tool_identity(
            connection,
            event,
            &input.message_id,
            &format!("{step}:{}", input.id),
        )
        .await?;
    }
    Ok(())
}

async fn validate_display_identity(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
    message: &str,
) -> Result<(), StoreError> {
    crate::sessions::validate_id(message)?;
    if message == event.id {
        return Err(invalid("part identity collides with its canonical event"));
    }
    crate::message_identity::validate_source_id(connection, &event.invocation.session_id, message)
        .await?;
    let admitted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_message_sources WHERE owner_session_id=?1 AND message_id=?2
         UNION ALL SELECT 1 FROM message_admissions WHERE session_id=?1 AND message_id=?2)",
    ).bind(&event.invocation.session_id).bind(message).fetch_one(connection).await?;
    if admitted {
        Err(invalid(
            "part identity collides with a visible source message",
        ))
    } else {
        Ok(())
    }
}

async fn validate_derived_tool_identity(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
    message: &str,
    operation: &str,
) -> Result<(), StoreError> {
    if message == event.id {
        return Err(invalid("part identity collides with its canonical event"));
    }
    crate::message_identity::validate_derived_tool_id(
        connection,
        &event.invocation.session_id,
        message,
        &event.invocation.invocation_id,
        operation,
    )
    .await
}

async fn check_record(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
    step: &str,
    record: &ModelPartRecord,
) -> Result<(), StoreError> {
    if let ModelPart::ToolCall { call } = record.part.as_ref() {
        provider_identity(&call.id)?;
        if call.name.is_empty() {
            return Err(invalid("empty model tool name"));
        }
        let operation = format!("{step}:{}", call.id);
        if record.message_id
            != maka_agent_facts::tool_call::tool_use_id(&event.invocation.invocation_id, &operation)
        {
            return Err(invalid("tool part identity differs from its original call"));
        }
        validate_derived_tool_identity(connection, event, &record.message_id, &operation).await?;
    } else {
        validate_display_identity(connection, event, &record.message_id).await?;
    }
    let ordinal = i64::try_from(record.ordinal).map_err(invalid)?;
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM model_part_records WHERE invocation_id=? AND step_id=? AND ordinal=?)",
    ).bind(&event.invocation.invocation_id).bind(step).bind(ordinal).fetch_one(&mut *connection).await?;
    if duplicate {
        return Err(invalid("observed part requires a reference at terminal"));
    }
    Ok(())
}

pub(crate) async fn record(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
) -> Result<(), StoreError> {
    let (step, parts, inputs) = match &stored.event.fact {
        Fact::ModelObserved {
            step_id,
            event: ModelObservation::Part(part),
        } => {
            insert_record(db, stored, step_id, 0, RecordIdentity::Part(part)).await?;
            return Ok(());
        }
        Fact::ModelCompleted { step_id, output } => (step_id, output.parts.as_slice(), &[][..]),
        Fact::ModelInterrupted {
            step_id,
            partial: Some(partial),
            ..
        } => (
            step_id,
            partial.parts.as_slice(),
            partial.tool_inputs.as_slice(),
        ),
        _ => return Ok(()),
    };
    for (index, part) in parts.iter().enumerate() {
        if let CompletionPart::Own(part) = part {
            insert_record(db, stored, step, index, RecordIdentity::Part(part)).await?;
        }
    }
    for (index, input) in inputs.iter().enumerate() {
        insert_record(db, stored, step, index, RecordIdentity::ToolInput(input)).await?;
    }
    Ok(())
}

async fn validate_result(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
    step: &str,
    record: &ModelPartRecord,
    incoming: &HashMap<(&str, &str), u64>,
) -> Result<(), StoreError> {
    let ModelPart::ToolResult { id, name, .. } = record.part.as_ref() else {
        return Ok(());
    };
    provider_identity(id)?;
    if name.is_empty() {
        return Err(invalid("empty provider result name"));
    }
    let (original_call, duplicate): (bool, bool) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM model_part_bodies WHERE invocation_id=?1 AND step_id=?2
           AND ordinal<?3 AND json_extract(part,'$.kind')='tool_call'
           AND json_extract(part,'$.call.provider_executed')=1 AND json_extract(part,'$.call.id')=?4 AND json_extract(part,'$.call.name')=?5),
           EXISTS(SELECT 1 FROM model_part_bodies WHERE invocation_id=?1 AND step_id=?2
           AND json_extract(part,'$.kind')='tool_result' AND json_extract(part,'$.id')=?4 AND json_extract(part,'$.name')=?5)",
    ).bind(&event.invocation.invocation_id).bind(step).bind(i64::try_from(record.ordinal).map_err(invalid)?)
        .bind(id).bind(name).fetch_one(connection).await?;
    if duplicate {
        return Err(invalid("provider result was already recorded"));
    }
    if !original_call
        && !incoming
            .get(&(id.as_str(), name.as_str()))
            .is_some_and(|ordinal| *ordinal < record.ordinal)
    {
        return Err(invalid(
            "provider result lacks its original matching provider call",
        ));
    }
    Ok(())
}

enum RecordIdentity<'a> {
    Part(&'a ModelPartRecord),
    ToolInput(&'a maka_agent_facts::model::recorded::ToolInputView),
}

async fn insert_record(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    step: &str,
    index: usize,
    identity: RecordIdentity<'_>,
) -> Result<(), StoreError> {
    let (ordinal, message, kind) = match identity {
        RecordIdentity::Part(part) => (Some(part.ordinal), part.message_id.as_str(), "part"),
        RecordIdentity::ToolInput(input) => (None, input.message_id.as_str(), "tool_input"),
    };
    sqlx::query("INSERT INTO model_part_records(owner_session_id,invocation_id,step_id,ordinal,event_id,source_sequence,record_index,message_id,record_kind)
                 VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(&stored.event.invocation.session_id).bind(&stored.event.invocation.invocation_id)
        .bind(step).bind(ordinal.map(i64::try_from).transpose().map_err(invalid)?)
        .bind(&stored.event.id).bind(i64::try_from(stored.sequence).map_err(invalid)?)
        .bind(i64::try_from(index).map_err(invalid)?).bind(message).bind(kind).execute(db).await?;
    Ok(())
}

pub(crate) async fn accepted_call(
    connection: &mut SqliteConnection,
    invocation: &str,
    step: &str,
    call: &str,
) -> Result<Option<ModelToolCall>, StoreError> {
    let value: Option<String> = sqlx::query_scalar(concat!("WITH ", accepted_calls!(),
        " SELECT call FROM accepted_calls WHERE invocation_id=? AND step_id=? AND json_extract(call,'$.id')=? AND json_extract(call,'$.provider_executed')=0"))
        .bind(invocation).bind(step).bind(call).fetch_optional(connection).await?;
    value
        .map(|value| serde_json::from_str(&value).map_err(StoreError::from))
        .transpose()
}

pub(crate) async fn resolve_parts(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<Vec<ModelPartRecord>, StoreError> {
    let parts = match &event.fact {
        Fact::ModelCompleted { output, .. } => output.parts.as_slice(),
        Fact::ModelInterrupted {
            partial: Some(partial),
            ..
        } => partial.parts.as_slice(),
        _ => return Ok(vec![]),
    };
    let mut resolved = Vec::with_capacity(parts.len());
    for part in parts {
        resolved.push(match part {
            CompletionPart::Own(record) => record.clone(),
            CompletionPart::Ref(reference) => {
                let json: String = sqlx::query_scalar("SELECT record FROM model_part_bodies WHERE event_id=? AND ordinal=? AND invocation_id=? AND step_id=?")
                    .bind(&reference.event_id).bind(i64::try_from(reference.ordinal).map_err(invalid)?)
                    .bind(&event.invocation.invocation_id).bind(event.fact.operation_id())
                    .fetch_one(&mut *connection).await?;
                serde_json::from_str(&json)?
            }
        });
    }
    Ok(resolved)
}

pub(crate) async fn project(
    connection: &mut SqliteConnection,
    invocation: Invocation,
    step_id: String,
    sequence: u64,
    event_id: String,
    max_bytes: usize,
) -> Result<crate::context::AcceptedModelStep, StoreError> {
    let mut rows = sqlx::query_as::<_, (i64, String, i64, String)>(
        "SELECT source_sequence,event_id,ordinal,part FROM model_part_bodies
         WHERE invocation_id=? AND step_id=? AND source_sequence<? AND source_kind='model_observed'
         ORDER BY ordinal",
    )
    .bind(&invocation.invocation_id)
    .bind(&step_id)
    .bind(i64::try_from(sequence).map_err(invalid)?)
    .fetch(connection);
    let mut bytes = 0usize;
    let mut items = Vec::new();
    while let Some((sequence, event_id, ordinal, json)) = rows.try_next().await? {
        bytes = bytes
            .checked_add(json.len())
            .ok_or(StoreError::PrefixTooLarge)?;
        if bytes > max_bytes {
            return Err(StoreError::PrefixTooLarge);
        }
        items.push(crate::context::AcceptedModelItem {
            sequence: crate::sequence_number(sequence)?,
            event_id,
            index: usize::try_from(ordinal).map_err(invalid)?,
            part: serde_json::from_str(&json)?,
        });
    }
    drop(rows);
    Ok(crate::context::AcceptedModelStep {
        sequence,
        event_id,
        invocation,
        step_id,
        items,
    })
}
