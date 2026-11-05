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

use crate::StoreError;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::executor::Output;
use sqlx::SqliteConnection;

pub(crate) async fn validate(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let id = &event.invocation.invocation_id;
    if !matches!(
        event.fact,
        Fact::ExecutorStarted { .. }
            | Fact::ExecutorObserved { .. }
            | Fact::ExecutorCompleted { .. }
            | Fact::ModelRequested { .. }
            | Fact::ToolDispatched { .. }
            | Fact::MessageSteered { .. }
            | Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed
            }
    ) {
        return Ok(());
    }
    let (started, completed): (bool, bool) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?1 AND kind = 'executor_started'),
                EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?1 AND kind = 'executor_completed')"
    ).bind(id).fetch_one(&mut *connection).await?;
    match &event.fact {
        Fact::ExecutorStarted { .. } => {
            if started {
                return Err(invalid("executor already started"));
            }
            let opening: String = sqlx::query_scalar(
                "SELECT event_header FROM runtime_events WHERE invocation_id = ? AND kind = 'invocation_opened'"
            ).bind(id).fetch_one(&mut *connection).await?;
            let opening: RuntimeEvent = serde_json::from_str(&opening)?;
            if !matches!(opening.fact, Fact::InvocationOpened {
                input: maka_agent_facts::input::InvocationInput::Message { .. },
                configuration: Some(ref config),
            } if config.model.is_none())
            {
                return Err(invalid("executor requires a non-model Message invocation"));
            }
            let native: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ? AND kind IN ('model_requested','tool_dispatched','message_steered'))"
            ).bind(id).fetch_one(&mut *connection).await?;
            if native {
                return Err(invalid(
                    "cannot replace an already executing native backend",
                ));
            }
        }
        Fact::ExecutorObserved { .. } | Fact::ExecutorCompleted { .. } => {
            if !started || completed {
                return Err(invalid("executor output outside its execution"));
            }
        }
        Fact::ToolDispatched { call, .. }
            if started
                && !completed
                && matches!(
                    call.origin,
                    maka_agent_facts::tool_call::ToolOrigin::HostSdk { .. }
                ) => {}
        Fact::MessageSteered { .. } if started && completed => {
            return Err(invalid("steering outside the active executor"));
        }
        Fact::ModelRequested { .. } | Fact::ToolDispatched { .. } if started => {
            return Err(invalid(
                "external executor cannot dispatch native model or tool effects",
            ));
        }
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        } if started && !completed => {
            return Err(invalid(
                "executor completion requires a durable final result",
            ));
        }
        _ => {}
    }
    match &event.fact {
        Fact::ExecutorObserved { output } => match output {
            Output::MessageStart { message_id } => {
                let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=?1 AND kind='executor_observed' AND json_extract(event_header, '$.fact.output.messageId')=?2)")
                        .bind(id).bind(message_id).fetch_one(&mut *connection).await?;
                if exists {
                    return Err(invalid("executor reused a message ID"));
                }
            }
            Output::OutputDelta { message_id, .. }
            | Output::ThinkingDelta { message_id, .. }
            | Output::MessageEnd { message_id } => {
                let state: Option<String> = sqlx::query_scalar("SELECT json_extract(event_header, '$.fact.output.type') FROM runtime_events WHERE invocation_id=?1 AND kind='executor_observed' AND json_extract(event_header, '$.fact.output.messageId')=?2 ORDER BY sequence DESC LIMIT 1")
                        .bind(id).bind(message_id).fetch_optional(&mut *connection).await?;
                if state.is_none() || state.as_deref() == Some("message_end") {
                    return Err(invalid("executor output outside its message"));
                }
            }
            _ => {}
        },
        Fact::ExecutorCompleted { message_id } => {
            let unfinished: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events start WHERE start.invocation_id=?1 AND start.kind='executor_observed' AND json_extract(start.event_header, '$.fact.output.type')='message_start' AND NOT EXISTS(SELECT 1 FROM runtime_events done WHERE done.invocation_id=?1 AND done.kind='executor_observed' AND json_extract(done.event_header, '$.fact.output.messageId')=json_extract(start.event_header, '$.fact.output.messageId') AND json_extract(done.event_header, '$.fact.output.type')='message_end'))")
                .bind(id).fetch_one(&mut *connection).await?;
            if unfinished {
                return Err(invalid("executor completion with unfinished messages"));
            }
            let last: Option<String> = sqlx::query_scalar("SELECT json_extract(ended.event_header, '$.fact.output.messageId') FROM runtime_events ended WHERE ended.invocation_id=?1 AND ended.kind='executor_observed' AND json_extract(ended.event_header, '$.fact.output.type')='message_end' AND EXISTS(SELECT 1 FROM runtime_events delta WHERE delta.invocation_id=?1 AND delta.kind='executor_observed' AND json_extract(delta.event_header, '$.fact.output.messageId')=json_extract(ended.event_header, '$.fact.output.messageId') AND json_extract(delta.event_header, '$.fact.output.type')='output_delta' AND json_extract(delta.event_header, '$.fact.output.text')!='') ORDER BY ended.sequence DESC LIMIT 1")
                .bind(id).fetch_optional(&mut *connection).await?;
            if last.as_ref() != message_id.as_ref() {
                return Err(invalid(
                    "executor final pointer is not its last completed body message",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}
fn invalid(reason: &str) -> StoreError {
    StoreError::InvalidTransition(reason.into())
}

#[cfg(test)]
mod tests;
