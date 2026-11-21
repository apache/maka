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

//! Short, model-only questions share the configured backend and auxiliary accounting.
use super::*;
use maka_capabilities::call::Scope;
use maka_event_log::applications::operations::OperationDispatchScope;
use maka_plugin_core::operation::RecoveryRef;
#[derive(Default)]
pub(super) struct QuickHistory {
    session: String,
    latest: String,
    messages: Vec<maka_model::prompt::Message>,
}

impl QuickHistory {
    fn begin(&mut self, input: &QuickQuestion) -> Result<Vec<maka_model::prompt::Message>, String> {
        use maka_model::prompt::Message;
        if let Some(previous) = &input.continue_from {
            if self.session != input.session_id || self.latest != *previous {
                return Err("This quick question has been replaced".into());
            }
            if self.messages.len() >= 64 {
                return Err("Start a new quick question to continue".into());
            }
        } else {
            if input.history.len() >= 32
                || input
                    .history
                    .iter()
                    .any(|turn| turn.question.len() > 16000 || turn.answer.len() > 131072)
            {
                return Err("Quick question history is too long".into());
            }
            self.messages.clear();
            for turn in &input.history {
                self.messages.push(Message::user(&turn.question));
                if !turn.answer.is_empty() {
                    self.messages.push(Message::Assistant {
                        content: vec![maka_model::prompt::AssistantPart::Text {
                            text: turn.answer.clone(),
                            provider_options: None,
                        }],
                        provider_options: None,
                    });
                }
            }
        }
        self.session.clone_from(&input.session_id);
        self.latest.clone_from(&input.request_id);
        self.messages.push(Message::user(&input.question));
        Ok(self.messages.clone())
    }

    fn finish(&mut self, input: &QuickQuestion, text: String) {
        use maka_model::prompt::{AssistantPart, Message};
        if self.session == input.session_id && self.latest == input.request_id && !text.is_empty() {
            self.messages.push(Message::Assistant {
                content: vec![AssistantPart::Text {
                    text,
                    provider_options: None,
                }],
                provider_options: None,
            });
        }
    }
}

impl Owner {
    async fn quick_tool_model(
        &self,
        scope: &Scope,
        session_id: &str,
    ) -> Result<Option<crate::model::Source>, String> {
        let session = self.scoped_session(scope, session_id).await?;
        if session.archived {
            return Ok(None);
        }
        let backend = match session.configuration.backend {
            Some(value) => Some(value),
            None => self.remembered_backend(session_id).await?,
        };
        let Some(BackendPreference::Model {
            connection_id,
            model_id,
            thinking_level,
            service_tier,
        }) = backend
        else {
            return Ok(None);
        };
        let source = crate::model::Source::select(
            self.configuration.clone(),
            self.catalog.clone(),
            self.credentials.clone(),
            ModelSelection {
                service_tier,
                connection_id,
                model_id,
            },
            thinking_level,
            session_id.to_owned(),
            self.revision.clone(),
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok(Some(match &self.pricing {
            Some(pricing) => source.with_pricing(pricing.clone()),
            None => source,
        }))
    }

    pub async fn ask_quick_question(
        self: &Arc<Self>,
        input: QuickQuestion,
        scope: &Scope,
        operation: &RecoveryRef,
        dispatch: OperationDispatchScope,
        progress: tokio::sync::watch::Sender<String>,
    ) -> Result<(), String> {
        use maka_model::prompt::Message;
        if input.question.trim().is_empty()
            || input.question.len() > 16000
            || input.request_id.len() > 128
            || input.request_id.is_empty()
        {
            return Err("Invalid quick question".into());
        }
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let source = owner
                    .quick_tool_model(&scope, &input.session_id)
                    .await?
                    .ok_or("quick_question_model_required")?;
                let prepared = source
                    .capture_auxiliary()
                    .await
                    .map_err(|e| e.to_string())?;
                let language = owner.resolve_language(
                    &owner
                        .configuration
                        .runtime_policy()
                        .await
                        .map_err(|e| e.to_string())?,
                );
                let quote = source.quote(&prepared).await.map_err(|e| e.to_string())?;
                let admission = auxiliary::IdleLease(Some(
                    owner
                        .auxiliary_lease(&scope, &input.session_id)
                        .await
                        .map_err(|e| maka_agent_facts::tools::ToolError::from(e).to_string())?,
                ));
                let mut prompt = vec![Message::System {
                    content: "Answer the user's question directly and concisely in their language."
                        .into(),
                    provider_options: None,
                }];
                prompt.extend(owner.quick_answer.lock().await.begin(&input)?);
                let cancellation = scope.cancellation.child_token();
                let _guard = cancellation.clone().drop_guard();
                let generation = owner.auxiliary.generate_streamed(
                    maka_model::ModelRequest {
                        operation: maka_agent_facts::context::ModelOperation::Inference,
                        language,
                        provider: prepared.provider,
                        prompt: prompt.into(),
                        tools: vec![],
                        tool_choice: Default::default(),
                        provider_options: prepared.options,
                        max_output_tokens: Some(
                            prepared.main_output_limit.map_or(2048, |n| n.min(2048)),
                        ),
                    },
                    cancellation.clone(),
                    &owner.store,
                    auxiliary::Admission::Operation {
                        reference: Box::new(operation),
                        scope: Box::new(dispatch),
                        attempt: None,
                        purpose: maka_agent_facts::context::ModelPurpose::Main,
                        execution: auxiliary::Execution::Prepared(admission),
                        binding: source.accepted.binding.clone(),
                        session_id: input.session_id.clone(),
                    },
                    quote,
                    |delta| progress.send_modify(|answer| answer.push_str(delta)),
                );
                tokio::pin!(generation);
                let result = tokio::select! {
                    result = &mut generation => result,
                    _ = owner.stop.cancelled() => { cancellation.cancel(); generation.await }
                };
                let answer = progress.borrow().clone();
                owner.quick_answer.lock().await.finish(&input, answer);
                result
                    .map(|_| ())
                    .map_err(|e| maka_agent_facts::tools::ToolError::from(e).to_string())
            })
        })
        .await
    }
}
