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

use super::*;
use auxiliary::{failed, persistence};
use futures_util::FutureExt;
use maka_agent_facts::{model::ModelGeneration, tools::ToolError};
use maka_agent_ports::{llm, session::history};
use maka_capabilities::call::Scope;
use maka_event_log::applications::operations::OperationDispatchScope;
use maka_model::{ModelRequest, prompt::Message};
use maka_plugin_core::operation::RecoveryRef;
use maka_session_recap::recap::{self, Recaps};

#[derive(Clone, Copy)]
enum Purpose {
    Recap,
    Memory { attempt: u32 },
}
struct Backend {
    purpose: Purpose,
    owner: Arc<Owner>,
    session: String,
    generation: Option<(RecoveryRef, OperationDispatchScope, ModelSelection)>,
    original_resources: Arc<maka_plugin_core::work::resources::Resources>,
}
impl Owner {
    async fn check_recap(&self, scope: &Scope, session: &str) -> Result<(), ToolError> {
        if !self.settings.recaps || self.stop.is_cancelled() || scope.cancellation.is_cancelled() {
            return Err(failed("Session recap unavailable"));
        }
        self.scoped_session(scope, session).await.map_err(failed)?;
        Ok(())
    }
    fn recaps(
        self: &Arc<Self>,
        scope: &Scope,
        session: String,
        generation: Option<(RecoveryRef, OperationDispatchScope, ModelSelection)>,
    ) -> Recaps {
        let backend = Arc::new(Backend {
            purpose: Purpose::Recap,
            owner: self.clone(),
            session,
            generation,
            original_resources: scope.resources.clone(),
        });
        Recaps {
            store: self.recap_storage.clone(),
            history: backend.clone(),
            models: backend,
        }
    }
    pub async fn recap(
        self: &Arc<Self>,
        input: RecapRead,
        scope: &Scope,
    ) -> Result<Option<RecapReceipt>, String> {
        self.check_recap(scope, &input.session_id)
            .await
            .map_err(|e| e.to_string())?;
        let recaps = self.recaps(scope, input.session_id.clone(), None);
        match input.operation_id {
            Some(operation) => recaps.query(scope, &input.session_id, operation).await,
            None => recaps.read(scope, &input.session_id).await,
        }
        .map_err(|e| e.to_string())
    }
    pub async fn generate_recap(
        self: &Arc<Self>,
        input: RecapGenerate,
        scope: &Scope,
        operation: &RecoveryRef,
        dispatch: OperationDispatchScope,
    ) -> Result<RecapReceipt, String> {
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                owner
                    .generate_recap_inner(input, &scope, &operation, dispatch)
                    .await
            })
        })
        .await
    }
    async fn generate_recap_inner(
        self: &Arc<Self>,
        input: RecapGenerate,
        scope: &Scope,
        operation: &RecoveryRef,
        dispatch: OperationDispatchScope,
    ) -> Result<RecapReceipt, String> {
        self.check_recap(scope, &input.session_id)
            .await
            .map_err(|e| e.to_string())?;
        let snapshot = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|e| e.to_string())?;
        let language = self.resolve_language(&snapshot);
        // The full admitted identity, including namespace and immutable input, names this cache entry.
        let hash = Sha256::digest(serde_json::to_vec(operation).map_err(|e| e.to_string())?);
        let id = Uuid::from_bytes(hash[..16].try_into().expect("SHA-256 prefix"));
        let recaps = self.recaps(
            scope,
            input.session_id.clone(),
            Some((operation.clone(), dispatch, input.model)),
        );
        recaps
            .generate(scope, &input.session_id, id, language)
            .await
            .map_err(|e| e.to_string())
    }
}
impl recap::History for Backend {
    fn read(
        &self,
        scope: Scope,
        input: history::Read,
    ) -> BoxFuture<'_, Result<history::Page, ToolError>> {
        Box::pin(async move {
            input.validate().map_err(failed)?;
            if input.session_id != self.session {
                return Err(failed("Recap session mismatch"));
            }
            self.owner.check_recap(&scope, &self.session).await?;
            let page = crate::service::history::read_page(
                &self.owner,
                &scope,
                history::Read {
                    include_thinking: false,
                    ..input
                },
            )
            .await
            .map_err(failed)?;
            self.owner.check_recap(&scope, &self.session).await?;
            Ok(page)
        })
    }
}
impl recap::Models for Backend {
    fn generate(
        &self,
        scope: Scope,
        input: llm::Generate,
    ) -> BoxFuture<'_, Result<ModelGeneration, ToolError>> {
        Box::pin(async move {
            let (reference, dispatch, model) = self
                .generation
                .clone()
                .ok_or_else(|| failed("Auxiliary generation not admitted"))?;
            let owner = self.owner.clone();
            let runs = owner.runs.lock().await;
            if runs.closing {
                return Err(failed("Agent owner closing"));
            }
            self.owner
                .check_auxiliary_purpose(self.purpose, &scope, &self.session)
                .await?;
            let purpose = self.purpose;
            let mut call_ticket = scope.resources.reserve().map_err(failed)?;
            // Recaps owns a child Scope. Propagate physical cleanup to the
            // original Host mutation as well as that child and native retirement.
            let mut original_ticket = self.original_resources.reserve().map_err(failed)?;
            let mut owner_ticket = owner.auxiliary.resources.reserve().map_err(failed)?;
            let session = self.session.clone();
            let captured = owner.clone();
            let (reply, result) = tokio::sync::oneshot::channel();
            owner.workers.spawn(async move {
                call_ticket.start();
                original_ticket.start();
                owner_ticket.start();
                let result =
                    std::panic::AssertUnwindSafe(captured.operation_model(
                        scope, session, reference, dispatch, model, input, purpose,
                    ))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        Err(auxiliary::Error::Tool(ToolError::CleanupUnconfirmed(
                            "Auxiliary worker disappeared".into(),
                        )))
                    });
                let result = match result {
                    Err(auxiliary::Error::Cleanup(error)) => {
                        let message = error.to_string();
                        let _ = reply.send(Err(ToolError::CleanupUnconfirmed(message.clone())));
                        match error.wait_physical().await {
                            Ok(auxiliary::PhysicalSettlement::Acknowledged) => {
                                call_ticket.complete(Ok(()));
                                original_ticket.complete(Ok(()));
                                owner_ticket.complete(Ok(()));
                            }
                            Ok(auxiliary::PhysicalSettlement::MetadataFailure(failure)) => {
                                let diagnostic = failure.to_string();
                                call_ticket.unconfirmed(diagnostic.clone(), failure.clone());
                                original_ticket.unconfirmed(diagnostic.clone(), failure.clone());
                                owner_ticket.unconfirmed(diagnostic, failure);
                            }
                            Err(_) => {
                                let error = Arc::new(error);
                                call_ticket.unconfirmed(message.clone(), error.clone());
                                original_ticket.unconfirmed(message.clone(), error.clone());
                                owner_ticket.unconfirmed(message, error);
                            }
                        }
                        return;
                    }
                    Err(auxiliary::Error::Metadata(failure)) => {
                        let diagnostic = failure.to_string();
                        call_ticket.unconfirmed(diagnostic.clone(), failure.clone());
                        original_ticket.unconfirmed(diagnostic.clone(), failure.clone());
                        owner_ticket.unconfirmed(diagnostic, failure.clone());
                        let _ =
                            reply.send(Err(ToolError::from(auxiliary::Error::Metadata(failure))));
                        return;
                    }
                    result => result.map_err(ToolError::from),
                };
                let cleanup = match &result {
                    Err(ToolError::CleanupUnconfirmed(error)) => Err(error.clone()),
                    _ => Ok(()),
                };
                call_ticket.complete(cleanup.clone());
                original_ticket.complete(cleanup.clone());
                owner_ticket.complete(cleanup);
                let _ = reply.send(result);
            });
            drop(runs);
            // Dropping the reply observer does not stop the original worker or its cleanup tickets.
            result
                .await
                .map_err(|e| ToolError::CleanupUnconfirmed(e.to_string()))?
        })
    }
}
impl Owner {
    #[expect(
        clippy::too_many_arguments,
        reason = "auxiliary request retains original scope, operation identity, model and purpose"
    )]
    async fn operation_model(
        &self,
        scope: Scope,
        session: String,
        reference: RecoveryRef,
        dispatch: OperationDispatchScope,
        model: ModelSelection,
        input: llm::Generate,
        purpose: Purpose,
    ) -> Result<ModelGeneration, auxiliary::Error> {
        let cancellation = scope.cancellation.child_token();
        let _cancel = cancellation.clone().drop_guard();
        let operation = async {
            input.validate().map_err(failed)?;
            let source = crate::model::Source::select(
                self.configuration.clone(),
                self.catalog.clone(),
                self.credentials.clone(),
                model,
                None,
                session.clone(),
                self.revision.clone(),
            )
            .await
            .map_err(failed)?;
            let source = match &self.pricing {
                Some(pricing) => source.with_pricing(Arc::clone(pricing)),
                None => source,
            };
            let prepared = source.capture_auxiliary().await.map_err(failed)?;
            let quote = source.quote(&prepared).await.map_err(persistence)?;
            self.check_auxiliary_purpose(purpose, &scope, &session)
                .await?;
            let admission = auxiliary::IdleLease(Some(
                self.auxiliary_lease(&scope, &session)
                    .await
                    .map_err(ToolError::from)?,
            ));
            let mut prompt = Vec::new();
            if let Some(content) = input.system {
                prompt.push(Message::System {
                    content,
                    provider_options: None,
                });
            }
            prompt.push(Message::user(input.prompt));
            let requested = input.max_output_tokens.unwrap_or(1024).min(match purpose {
                Purpose::Recap => 1024,
                Purpose::Memory { .. } => 8192,
            });
            self.auxiliary
                .generate(
                    ModelRequest {
                        operation: maka_agent_facts::context::ModelOperation::Inference,
                        language: input.language,
                        provider: prepared.provider,
                        prompt: prompt.into(),
                        tools: Vec::new(),
                        tool_choice: Default::default(),
                        provider_options: prepared.options,
                        max_output_tokens: Some(
                            prepared
                                .main_output_limit
                                .map_or(requested, |limit| limit.min(requested)),
                        ),
                    },
                    cancellation.clone(),
                    &self.store,
                    auxiliary::Admission::Operation {
                        reference: Box::new(reference),
                        attempt: match purpose {
                            Purpose::Recap => None,
                            Purpose::Memory { attempt } => std::num::NonZeroU32::new(attempt),
                        },
                        scope: Box::new(dispatch),
                        execution: auxiliary::Execution::Prepared(admission),
                        binding: source.accepted.binding.clone(),
                        purpose: maka_agent_facts::context::ModelPurpose::Main,
                        session_id: session,
                    },
                    quote,
                )
                .await
        };
        tokio::pin!(operation);
        let result = tokio::select! {
            biased;
            _ = self.stop.cancelled() => { cancellation.cancel(); operation.await },
            result = &mut operation => result,
        };
        match result {
            Err(error @ (auxiliary::Error::Cleanup(_) | auxiliary::Error::Metadata(_))) => {
                Err(error)
            }
            Err(
                error @ auxiliary::Error::Tool(
                    ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_),
                ),
            ) => Err(error),
            _ if cancellation.is_cancelled() => {
                Err(auxiliary::Error::Tool(ToolError::OutcomeUnknown(
                    "Auxiliary generation cancelled; read its original receipt".into(),
                )))
            }
            result => result,
        }
    }
}

impl Owner {
    async fn check_auxiliary_purpose(
        &self,
        purpose: Purpose,
        scope: &Scope,
        session: &str,
    ) -> Result<(), ToolError> {
        match purpose {
            Purpose::Recap => self.check_recap(scope, session).await,
            Purpose::Memory { .. } => {
                if self.stop.is_cancelled() || scope.cancellation.is_cancelled() {
                    return Err(failed("memory resolution cancelled"));
                }
                let session = self.scoped_session(scope, session).await.map_err(failed)?;
                if session.configuration.incognito {
                    return Err(failed("memory resolution cannot use an incognito session"));
                }
                Ok(())
            }
        }
    }
    pub(super) async fn memory_judgments(
        self: &Arc<Self>,
        parent: &Scope,
        resolution: MemoryResolution,
        reference: RecoveryRef,
        dispatch: OperationDispatchScope,
        prompt: String,
        attempt: u32,
    ) -> Result<maka_agent_state::memory::resolution::Decisions, String> {
        use maka_session_recap::recap::Models;
        let owned = maka_capabilities::call::Owned::new(parent.child().map_err(|e| e.to_string())?);
        let scope = owned.scope();
        let backend = Backend {
            purpose: Purpose::Memory { attempt },
            owner: self.clone(),
            session: resolution.session_id,
            generation: Some((reference, dispatch, resolution.model)),
            original_resources: parent.resources.clone(),
        };
        let policy = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|e| e.to_string())?;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(45),
            backend.generate(
                scope.clone(),
                llm::Generate {
                    language: self.resolve_language(&policy),
                    prompt,
                    system: Some(include_str!("memory/resolution-prompt.md").into()),
                    max_output_tokens: Some(8192),
                },
            ),
        )
        .await;
        scope.cancellation.cancel();
        owned.finish().await.map_err(|e| e.to_string())?;
        let generation = result
            .map_err(|_| "memory semantic resolution timed out")?
            .map_err(|e| e.to_string())?;
        if generation.finish_reason != maka_agent_facts::model::ModelFinishReason::Stop
            || generation.text.len() > 65536
        {
            return Err("memory semantic resolution incomplete".into());
        }
        serde_json::from_str(&generation.text)
            .map_err(|e| format!("invalid memory semantic response: {e}"))
    }
}
