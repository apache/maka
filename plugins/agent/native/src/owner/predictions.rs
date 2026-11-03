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

//! Optional next-message generation never becomes a conversation turn.
use super::*;
use maka_agent_facts::configuration::policy::default_prediction_prompt;
use maka_capabilities::call::Scope;
use maka_event_log::applications::operations::OperationDispatchScope;
use maka_plugin_core::operation::RecoveryRef;

fn follows_current_backend(
    preference: &BackendPreference,
    model: &maka_agent_facts::execution::ModelBinding,
    thinking: Option<ThinkingLevel>,
) -> bool {
    matches!(preference, BackendPreference::Model { connection_id, model_id, thinking_level }
        if *connection_id == model.connection_id && *model_id == model.model && *thinking_level == thinking)
}

impl Owner {
    pub async fn predict_next_message(
        self: &Arc<Self>,
        input: PredictNextMessage,
        scope: &Scope,
        operation: &RecoveryRef,
        dispatch: OperationDispatchScope,
    ) -> Result<MessagePrediction, String> {
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                owner
                    .predict_message_inner(input, scope, operation, dispatch)
                    .await
            })
        })
        .await
    }

    async fn predict_message_inner(
        &self,
        input: PredictNextMessage,
        scope: Scope,
        operation: RecoveryRef,
        dispatch: OperationDispatchScope,
    ) -> Result<MessagePrediction, String> {
        let session = self.scoped_session(&scope, &input.session_id).await?;
        let policy = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|e| e.to_string())?;
        let language = self.resolve_language(&policy);
        let settings = &policy.policy.predictions;
        let mut result = MessagePrediction {
            source_turn_id: input.expected_turn_id.clone(),
            policy_revision: policy.revision,
            suggestion: None,
        };
        if !settings.enabled
            || session.archived
            || session.configuration.parent_session_id.is_some()
            || (settings.ordinary_sessions_only && self.bot.is(&input.session_id))
        {
            return Ok(result);
        }
        if self.runs.lock().await.busy(&input.session_id) {
            return Ok(result);
        }
        let store = self.scoped_store(&scope, &input.session_id).await?;
        let Some(boundary) = store
            .latest_turn_boundary(&input.session_id)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(result);
        };
        if boundary.root_invocation().turn_id != input.expected_turn_id
            || !matches!(
                boundary.state.terminal_outcome(),
                Some(maka_agent_facts::event::InvocationOutcome::Completed)
            )
        {
            return Ok(result);
        }
        let percent = match input.trigger {
            PredictionTrigger::Live => settings.live_sample_percent,
            PredictionTrigger::CatchUp => settings.catch_up_sample_percent,
        };
        if fastrand::f64() * 100.0 >= percent {
            return Ok(result);
        }
        let report = store
            .context_report(&input.session_id, None)
            .await
            .map_err(|e| e.to_string())?;
        let Some(request) = report.request else {
            return Ok(result);
        };
        if request.invocation_id != boundary.invocation.invocation_id
            || request.state != maka_event_log::context::ContextRequestState::Completed
        {
            return Ok(result);
        }
        let frozen = store
            .read_frozen_model_request(&boundary.invocation, &request.event_id)
            .await
            .map_err(|e| e.to_string())?;
        let maka_agent_facts::event::Fact::InvocationOpened {
            configuration: Some(configuration),
            ..
        } = &frozen.opening.fact
        else {
            return Ok(result);
        };
        let Some(model) = &configuration.model else {
            return Ok(result);
        };
        let backend = match &session.configuration.backend {
            Some(backend) => Some(backend.clone()),
            None => self.remembered_backend(&input.session_id).await?,
        };
        if !backend.as_ref().is_some_and(|backend| {
            follows_current_backend(backend, model, configuration.thinking_level)
        }) {
            return Ok(result);
        }
        let catalog = self
            .configuration
            .catalog()
            .await
            .map_err(|e| e.to_string())?;
        let Some(row) = catalog
            .connections
            .iter()
            .find(|row| row.connection_id == model.connection_id && row.enabled)
        else {
            return Ok(result);
        };
        let selection = ModelSelection {
            connection_id: model.connection_id.clone(),
            model_id: model.model.clone(),
            revision: row.revision,
        };
        let (source, prepared) = crate::model::Source::select(
            self.configuration.clone(),
            self.catalog.clone(),
            self.credentials.clone(),
            selection,
            configuration.thinking_level,
            input.session_id.clone(),
            self.revision.clone(),
        )
        .await
        .map_err(|e| e.to_string())?;
        let quote = self
            .configuration
            .quote_model(prepared.provider_id, source.accepted.binding.model.clone())
            .await
            .map_err(|e| e.to_string())?;
        let cancellation = scope.cancellation.child_token();
        let _cancel = cancellation.clone().drop_guard();
        let output_instruction = match language {
            Language::En => "Return only JSON matching this schema:",
            Language::ZhCn => "仅返回符合以下 JSON Schema 的 JSON：",
            Language::ZhTw => "只回傳符合下列 JSON Schema 的 JSON：",
        };
        let instruction = format!(
            "{}\n\n{output_instruction}\n{}",
            settings
                .prompt
                .as_deref()
                .filter(|prompt| !prompt.trim().is_empty())
                .unwrap_or(default_prediction_prompt(language)),
            r#"{"type":"object","properties":{"suggestion":{"type":["string","null"]}},"required":["suggestion"],"additionalProperties":false}"#,
        );
        let mut admission = auxiliary::IdleLease(Some(
            auxiliary::session_lease(&self.store, &input.session_id)
                .await
                .map_err(|error| maka_agent_facts::tools::ToolError::from(error).to_string())?,
        ));
        let preparation_store = admission
            .0
            .as_ref()
            .expect("prepared auxiliary lease")
            .store();
        let prediction = match self
            .engine
            .prepare_prediction(
                preparation_store,
                maka_agent_engine::PredictionInput {
                    frozen,
                    provider: prepared.provider,
                    model_revision: Some(prepared.revision),
                    instruction,
                },
                &cancellation,
            )
            .await
        {
            Ok(prediction) => prediction,
            Err(error) => {
                if error.is_cleanup_unconfirmed() {
                    admission.retain_unconfirmed();
                }
                return Err(error.to_string());
            }
        };
        let source_current = async {
            let latest = store
                .latest_turn_boundary(&input.session_id)
                .await
                .map_err(|e| e.to_string())?;
            let current = self
                .configuration
                .runtime_policy()
                .await
                .map_err(|e| e.to_string())?;
            let current_session = self.scoped_session(&scope, &input.session_id).await?;
            Ok::<_, String>(
                current_session.configuration.backend == session.configuration.backend
                    && !current_session.archived
                    && !scope.cancellation.is_cancelled()
                    && !self.stop.is_cancelled()
                    && !self.runs.lock().await.busy(&input.session_id)
                    && current.revision == policy.revision
                    && latest.is_some_and(|latest| latest.invocation == boundary.invocation),
            )
        }
        .await;
        match source_current {
            Ok(true) => {}
            stale => {
                if let Err(error) = prediction.close().await {
                    admission.retain_unconfirmed();
                    return Err(format!("agent_prediction_cleanup_unconfirmed: {error}"));
                }
                stale?;
                return Ok(result);
            }
        }
        let generation = {
            let request = self.auxiliary.generate(
                prediction.request(),
                cancellation.clone(),
                &self.store,
                auxiliary::Admission::Operation {
                    reference: Box::new(operation),
                    scope: Box::new(dispatch),
                    execution: Some(auxiliary::Execution::Prepared(admission)),
                    binding: source.accepted.binding.clone(),
                    session_id: input.session_id.clone(),
                },
                quote,
            );
            tokio::pin!(request);
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => { cancellation.cancel(); request.await },
                generation = &mut request => generation,
            }
        };
        prediction
            .close()
            .await
            .map_err(|error| format!("agent_prediction_cleanup_unconfirmed: {error}"))?;
        let generation = generation
            .map_err(|error| maka_agent_facts::tools::ToolError::from(error).to_string())?;
        let latest = store
            .latest_turn_boundary(&input.session_id)
            .await
            .map_err(|e| e.to_string())?;
        let current = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|e| e.to_string())?;
        let current_session = self.scoped_session(&scope, &input.session_id).await?;
        if scope.cancellation.is_cancelled()
            || self.stop.is_cancelled()
            || self.runs.lock().await.busy(&input.session_id)
            || current.revision != policy.revision
            || current_session.archived
            || current_session.configuration.backend != session.configuration.backend
            || !latest.as_ref().is_some_and(|latest| {
                latest.invocation == boundary.invocation
                    && matches!(
                        latest.state.terminal_outcome(),
                        Some(maka_agent_facts::event::InvocationOutcome::Completed)
                    )
            })
        {
            return Ok(result);
        }
        result.suggestion = parse_suggestion(&generation.text)?;
        Ok(result)
    }
}

fn parse_suggestion(text: &str) -> Result<Option<String>, String> {
    #[derive(Deserialize)]
    struct Output {
        #[serde(deserialize_with = "Option::deserialize")]
        suggestion: Option<String>,
    }
    let output: Output =
        serde_json::from_str(text).map_err(|_| "agent_prediction_invalid_output")?;
    Ok(output
        .suggestion
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty()))
}
