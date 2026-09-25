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

use super::{AcceptedMainContext, LatestMainContext, latest_main};
use crate::{EventLog, StoreError};
use maka_runtime::{
    context::ModelPurpose,
    event::{Fact, RuntimeEvent, ToolOutcome},
    input::{InvocationInput, MessageInput},
    model::ModelEvent,
    tool_output::{DurableToolProjection, ProjectionPart},
};
use sqlx::{Connection, Row, SqliteConnection};

#[derive(Debug, PartialEq, Eq)]
pub struct ContextUsage {
    pub tokens: u64,
    pub approximate: bool,
}

impl EventLog {
    /// Existing provider usage plus bounded additions since its completion.
    /// One read transaction; no prompt reconstruction, plugins or persisted meter.
    pub async fn context_usage(
        &self,
        session: &str,
    ) -> Result<(LatestMainContext, Option<ContextUsage>), StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let selected = latest_main::read(&mut tx, &session).await?;
                    let usage = match &selected {
                        LatestMainContext::Selected(basis) => {
                            additions(&mut tx, &session, basis).await?
                        }
                        _ => None,
                    };
                    tx.commit().await?;
                    Ok((selected, usage))
                })
            })
            .await
    }
}

async fn additions(
    connection: &mut SqliteConnection,
    session: &str,
    basis: &AcceptedMainContext,
) -> Result<Option<ContextUsage>, StoreError> {
    let (Some(input), Some(output)) = (basis.usage.input_tokens, basis.usage.output_tokens) else {
        return Ok(None);
    };
    if !basis.projection_current {
        return Ok(None);
    }
    // A background notification can precede completion without having been in
    // that request's frozen input. Wait for fresh provider usage instead of
    // counting it as already consumed (or inventing a second usage meter).
    let unobserved_notification: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runtime_events c JOIN runtime_events r
         ON r.invocation_id=c.invocation_id AND r.operation_id=c.operation_id AND r.kind='model_requested'
         JOIN runtime_events n ON n.invocation_id=c.invocation_id AND n.kind='tool_notified'
         WHERE c.sequence=? AND n.sequence>json_extract(r.event_json,'$.fact.source_high_water') AND n.sequence<c.sequence)",
    ).bind(basis.sequence as i64).fetch_one(&mut *connection).await?;
    if unobserved_notification {
        return Ok(None);
    }
    // A changed system/tool/plugin surface or provider route is not a text
    // addition. Reuse the already-frozen composition identities; never rerun it.
    let changed: bool = sqlx::query_scalar(
        "SELECT EXISTS(
          SELECT 1 FROM runtime_events c
          JOIN runtime_events base ON base.invocation_id=c.invocation_id
            AND base.operation_id=c.operation_id AND base.kind='model_requested'
          LEFT JOIN model_request_compositions bc ON bc.event_id=base.event_id
          JOIN runtime_events r ON r.sequence>c.sequence AND r.kind='model_requested'
            AND json_extract(r.event_json,'$.invocation.session_id')=?2
            AND json_extract(r.event_json,'$.fact.purpose')='main'
          LEFT JOIN model_request_compositions rc ON rc.event_id=r.event_id
          WHERE c.sequence=?1 AND (rc.digest IS NULL OR bc.digest IS NULL
            OR rc.digest!=bc.digest OR json_extract(r.event_json,'$.fact.route_identity')
                !=json_extract(base.event_json,'$.fact.route_identity')))",
    )
    .bind(basis.sequence as i64)
    .bind(session)
    .fetch_one(&mut *connection)
    .await?;
    if changed {
        return Ok(None);
    }
    // Only model-facing tool results, not nested Code Mode/SDK model calls.
    // Interrupted stream fragments never become retained context. Completed
    // Main output is already in the newest usage; Summary output is not.
    const FILTER: &str = "
        e.sequence > ?1 AND json_extract(e.event_json,'$.invocation.session_id')=?2
        AND e.kind IN ('invocation_opened','message_steered','model_requested',
            'model_observed','executor_completed','tool_settled','tool_rejected','tool_notified',
            'context_checkpoint_recorded','tool_result_archived')
        AND (e.kind NOT IN ('tool_settled','tool_rejected') OR
            json_extract(e.event_json,'$.fact.call.origin.kind')='provider' OR
            EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=e.invocation_id
                AND d.operation_id=e.operation_id AND d.kind='tool_dispatched'
                AND json_extract(d.event_json,'$.fact.call.origin.kind')='provider'))
        AND (e.kind!='model_observed' OR EXISTS(
            SELECT 1 FROM runtime_events r WHERE r.invocation_id=e.invocation_id
                AND r.kind='model_requested'
                AND r.operation_id=json_extract(e.event_json,'$.fact.step_id')
                AND json_extract(r.event_json,'$.fact.purpose')='main'
                AND NOT EXISTS(SELECT 1 FROM runtime_events c
                    WHERE c.invocation_id=r.invocation_id AND c.operation_id=r.operation_id
                    AND c.kind IN ('model_completed','model_interrupted'))))";
    let (count, bytes): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*),COALESCE(SUM(length(CAST(e.event_json AS BLOB))),0) FROM runtime_events e WHERE {FILTER}"
    ))).bind(basis.sequence as i64).bind(session).fetch_one(&mut *connection).await?;
    if count > 4096 || bytes > 1024 * 1024 {
        return Ok(None);
    }
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT e.event_json FROM runtime_events e WHERE {FILTER} ORDER BY e.sequence"
    )))
    .bind(basis.sequence as i64)
    .bind(session)
    .fetch_all(connection)
    .await?;
    let mut units = 0_u64;
    for row in rows {
        let event: RuntimeEvent = serde_json::from_str(row.try_get("event_json")?)?;
        let Some(added) = increment(&event.fact, basis) else {
            return Ok(None);
        };
        units = units.saturating_add(added);
    }
    Ok(Some(ContextUsage {
        tokens: input
            .saturating_add(output)
            .saturating_add(units.div_ceil(4))
            .min(9_007_199_254_740_991),
        // Provider output is a useful existing baseline, not an exact tokenizer
        // count of its future prompt encoding (reasoning/framing may differ).
        approximate: output != 0 || units != 0,
    }))
}

fn increment(fact: &Fact, basis: &AcceptedMainContext) -> Option<u64> {
    Some(match fact {
        Fact::ContextCheckpointRecorded { .. } | Fact::ToolResultArchived { .. } => return None,
        Fact::InvocationOpened {
            input,
            configuration,
        } => {
            if configuration
                .as_ref()
                .and_then(|c| c.model.as_ref())
                .is_some_and(|m| {
                    Some(&m.connection_id) != basis.connection_id.as_ref()
                        || m.model != basis.model_id
                })
            {
                return None;
            }
            match input {
                InvocationInput::Message { content, .. } => message(content)?,
                // Branch/replay changes are not additive.
                InvocationInput::Continuation { .. } | InvocationInput::Handoff { .. } => {
                    return None;
                }
                InvocationInput::ContextCompact { .. } => 0,
                InvocationInput::Code { .. } => return None,
            }
        }
        Fact::MessageSteered { message: delivered } => {
            message(&delivered.content)?.saturating_add(88)
        }
        Fact::ModelRequested {
            purpose: ModelPurpose::Main,
            model_id,
            context,
            ..
        } => {
            if *model_id != basis.model_id || *context != basis.context {
                return None;
            }
            0
        }
        Fact::ModelObserved { event, .. } => match event {
            ModelEvent::PartStarted { .. } => 12,
            ModelEvent::PartDelta { text, .. } => text_units(text),
            ModelEvent::ToolCall(call) => {
                text_units(&call.name) + text_units(&call.input.to_string()) + 12
            }
            ModelEvent::ProviderToolResult { output, .. } => text_units(&output.to_string()) + 12,
            _ => 0,
        },
        Fact::ToolSettled { outcome, .. } => {
            12 + match outcome {
                ToolOutcome::Succeeded {
                    model_projection, ..
                } => projection_units(model_projection)?,
                ToolOutcome::Failed { message } | ToolOutcome::Unknown { message } => {
                    text_units(message)
                }
            }
        }
        Fact::ToolNotified { model_text, .. } => 12 + text_units(model_text),
        Fact::ToolRejected { reason, .. } => 12 + text_units(&reason.to_string()),
        Fact::ExecutorCompleted { .. } => return None,
        _ => 0,
    })
}

fn message(input: &MessageInput) -> Option<u64> {
    if input.attachments.as_ref().is_some_and(|v| !v.is_empty())
        || input.quotes.as_ref().is_some_and(|v| !v.is_empty())
        || input
            .directory_references
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        || input
            .inline_references
            .as_ref()
            .is_some_and(|v| !v.is_empty())
    {
        // Unknown additions must not be represented as zero.
        return None;
    }
    Some(12 + text_units(&input.text))
}

fn projection_units(value: &DurableToolProjection) -> Option<u64> {
    use maka_runtime::tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE;
    match value {
        DurableToolProjection::Text { text } => Some(text_units(text)),
        DurableToolProjection::Json { value } => Some(text_units(&value.to_string())),
        DurableToolProjection::Failure => Some(text_units(DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE)),
        DurableToolProjection::Content { parts } => {
            parts.iter().try_fold(0, |sum, part| match part {
                ProjectionPart::Text { text } => Some(sum + text_units(text)),
                ProjectionPart::Artifact { .. } | ProjectionPart::Audio { .. } => None,
            })
        }
    }
}

/// A display-only estimate of new text, accumulated before rounding so splitting
/// one delta into many transport chunks cannot change its token estimate.
fn text_units(text: &str) -> u64 {
    text.chars()
        .map(|ch| if ch.is_ascii() { 1 } else { 4 })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_runtime::{context::ModelRequestContext, model::ModelUsage};
    use std::time::SystemTime;

    #[test]
    fn additions_are_chunk_independent_and_unknown_content_invalidates_the_baseline() {
        let basis = AcceptedMainContext {
            projection_current: true,
            sequence: 3,
            recorded_at: SystemTime::UNIX_EPOCH,
            model_id: "model".into(),
            route_identity: "route".into(),
            connection_id: Some("connection".into()),
            checkpoint_event_id: None,
            context: Some(ModelRequestContext {
                provider_id: "openai".into(),
                context_window: Some(96000),
                model_context_window: Some(128000),
                declared_window: None,
            }),
            usage: ModelUsage {
                input_tokens: Some(1000),
                output_tokens: Some(200),
                ..Default::default()
            },
        };
        let fragments = ["ab", "c", "中文", "🦀"];
        assert_eq!(
            text_units(&fragments.concat()),
            fragments.into_iter().map(text_units).sum::<u64>()
        );
        let text = DurableToolProjection::Text {
            text: "only model-visible output".into(),
        };
        assert_eq!(
            projection_units(&text),
            Some(text_units("only model-visible output"))
        );
        assert_eq!(
            message(&MessageInput::from("draft now admitted".to_owned())),
            Some(12 + text_units("draft now admitted"))
        );
        let request = Fact::ModelRequested {
            step_id: "next".into(),
            model_id: "other".into(),
            source_scope: maka_runtime::event::LogScope::Session { id: "s".into() },
            source_high_water: 3,
            source_digest: "digest".into(),
            input_digest: "input".into(),
            route_identity: "route".into(),
            checkpoint_event_id: None,
            purpose: ModelPurpose::Main,
            context: basis.context.clone(),
            effective_source_digest: None,
        };
        assert_eq!(
            increment(&request, &basis),
            None,
            "a different model cannot inherit the old count"
        );
        assert_eq!(
            increment(
                &Fact::ExecutorCompleted {
                    text: "opaque executor".into()
                },
                &basis
            ),
            None
        );
    }
}
