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

//! Read the original prepared request without resolving today's prompt or model.
use super::*;
use maka_capabilities::call::Scope;

impl Owner {
    pub async fn context(
        self: &Arc<Self>,
        input: ContextRead,
        scope: &Scope,
    ) -> Result<ContextReport, String> {
        if input
            .through
            .is_some_and(|value| value > maka_agent_facts::interaction::MAX_SAFE_INTEGER)
        {
            return Err("agent_context_input_invalid".into());
        }
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                owner.session(&input.session_id).await?;
                let report = owner.store.session(&input.session_id).await.map_err(|error| error.to_string())?.context_report(&input.session_id, input.through).await
                    .map_err(|error| {
                        tracing::warn!(stage = "context_read", cause = crate::diagnostics::store_cause(&error),
                            sql_code = crate::diagnostics::store_sql_code(&error), session_id = %input.session_id,
                            "Prepared context query failed");
                        "agent_context_unavailable"
                    })?;
                owner.session(&input.session_id).await?;
                if scope.cancellation.is_cancelled() || owner.stop.is_cancelled() {
                    return Err("agent_context_cancelled".into());
                }
                let request = report.request.map(|request| {
                    use maka_event_log::context::ContextRequestState as State;
                    let recorded_at = request.recorded_at.duration_since(std::time::UNIX_EPOCH)
                        .map_err(|_| "agent_context_output_unavailable")?.as_secs_f64() * 1000.0;
                    Ok::<_, &'static str>(ContextRequest {
                        invocation_id: request.invocation_id,
                        step_id: request.step_id,
                        sequence: request.sequence,
                        recorded_at,
                        source_through: request.source_through,
                        model_id: request.model_id,
                        context_window: request.context_window,
                        input_limit: request.input_limit,
                        state: match request.state {
                            State::Requested => ContextRequestState::Requested,
                            State::Completed => ContextRequestState::Completed,
                            State::Interrupted => ContextRequestState::Interrupted,
                        },
                        breakdown: request.breakdown,
                        reported_input_tokens: request.reported_input_tokens,
                    })
                }).transpose()?;
                let report = ContextReport { through: report.through, request };
                report.validate()?;
                Ok(report)
            })
        }).await
    }
}
