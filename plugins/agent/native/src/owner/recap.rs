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
use maka_agent_ports::{llm, preferences, session::history};
use maka_capabilities::call::Scope;
use maka_event_log::applications::operations::OperationDispatchScope;
use maka_model::{ModelRequest, prompt::Message};
use maka_plugin_core::operation::RecoveryRef;
use maka_session_recap::recap::{self, Recaps};

struct Backend {
    owner: Arc<Owner>,
    session: String,
    generation: Option<(RecoveryRef, OperationDispatchScope, ModelSelection)>,
    original_resources: Arc<maka_capabilities::call::Resources>,
}
impl Owner {
    async fn check_recap(
        &self,
        scope: &Scope,
        session: &str,
    ) -> Result<RuntimePolicySnapshot, ToolError> {
        if !self.settings.recaps || self.stop.is_cancelled() || scope.cancellation.is_cancelled() {
            return Err(failed("Session recap unavailable"));
        }
        self.scoped_session(scope, session).await.map_err(failed)?;
        let snapshot = self
            .configuration
            .runtime_policy()
            .await
            .map_err(persistence)?;
        if snapshot.policy.privacy.incognito_active {
            return Err(failed("Session recap is unavailable in incognito mode"));
        }
        Ok(snapshot)
    }
    fn recaps(
        self: &Arc<Self>,
        scope: &Scope,
        session: String,
        generation: Option<(RecoveryRef, OperationDispatchScope, ModelSelection)>,
    ) -> Recaps {
        let backend = Arc::new(Backend {
            owner: self.clone(),
            session,
            generation,
            original_resources: scope.resources.clone(),
        });
        Recaps {
            store: self.recap_storage.clone(),
            history: backend.clone(),
            models: backend.clone(),
            preferences: backend,
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
        let snapshot = self
            .check_recap(scope, &input.session_id)
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
            let high_water = *self
                .owner
                .scoped_store(&scope, &self.session)
                .await
                .map_err(failed)?
                .subscribe_commits()
                .map_err(persistence)?
                .borrow();
            let through = input.through.unwrap_or(high_water);
            if through > high_water {
                return Err(failed("Recap history fence invalid"));
            }
            let page = self
                .owner
                .scoped_store(&scope, &self.session)
                .await
                .map_err(failed)?
                .history_text(
                    &self.session,
                    through,
                    input.position,
                    false,
                    8192,
                    8,
                    96 * 1024,
                )
                .await
                .map_err(persistence)?;
            self.owner.check_recap(&scope, &self.session).await?;
            Ok(page)
        })
    }
}
impl preferences::Preferences for Backend {
    fn read(&self) -> BoxFuture<'_, Result<preferences::Snapshot, maka_capabilities::Error>> {
        Box::pin(async {
            let snapshot = self
                .owner
                .configuration
                .runtime_policy()
                .await
                .map_err(|e| maka_capabilities::Error::Invalid(e.to_string()))?;
            Ok(preferences::Snapshot {
                revision: snapshot.revision,
                privacy: snapshot.policy.privacy,
                personalization: snapshot.policy.personalization,
                workspace_instructions: snapshot.policy.workspace_instructions.enabled,
            })
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
                .ok_or_else(|| failed("Recap generation not admitted"))?;
            let owner = self.owner.clone();
            let runs = owner.runs.lock().await;
            if runs.closing {
                return Err(failed("Agent owner closing"));
            }
            self.owner.check_recap(&scope, &self.session).await?;
            let mut call_ticket = scope.resources.reserve().map_err(failed)?;
            // Recaps owns a child Scope. Propagate physical cleanup to the
            // original Host mutation as well as that child and native retirement.
            let mut original_ticket = self.original_resources.reserve().map_err(failed)?;
            let mut owner_ticket = owner.auxiliary.resources.reserve().map_err(failed)?;
            let session = self.session.clone();
            let captured = owner.clone();
            let worker = owner.workers.spawn(async move {
                call_ticket.start();
                original_ticket.start();
                owner_ticket.start();
                let result = std::panic::AssertUnwindSafe(
                    captured.recap_model(scope, session, reference, dispatch, model, input),
                )
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    Err(ToolError::CleanupUnconfirmed(
                        "Recap worker disappeared".into(),
                    ))
                });
                let cleanup = match &result {
                    Err(ToolError::CleanupUnconfirmed(error)) => Err(error.clone()),
                    _ => Ok(()),
                };
                if matches!(
                    result,
                    Err(ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_))
                ) {
                    captured.runs.lock().await.closing = true;
                    captured.stop.cancel();
                }
                call_ticket.complete(cleanup.clone());
                original_ticket.complete(cleanup.clone());
                owner_ticket.complete(cleanup);
                result
            });
            drop(runs);
            // Timeout drops only this observer; the original worker retains both cleanup tickets.
            worker
                .await
                .map_err(|e| ToolError::CleanupUnconfirmed(e.to_string()))?
        })
    }
}
impl Owner {
    async fn recap_model(
        &self,
        scope: Scope,
        session: String,
        reference: RecoveryRef,
        dispatch: OperationDispatchScope,
        model: ModelSelection,
        input: llm::Generate,
    ) -> Result<ModelGeneration, ToolError> {
        let cancellation = scope.cancellation.child_token();
        let _cancel = cancellation.clone().drop_guard();
        let operation = async {
            input.validate().map_err(failed)?;
            let (source, _) = crate::model::Source::select(
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
            let prepared = source.capture_auxiliary().await.map_err(failed)?;
            let quote = self
                .configuration
                .quote_model(prepared.provider_id, source.accepted.binding.model.clone())
                .await
                .map_err(persistence)?;
            self.check_recap(&scope, &session).await?;
            let mut prompt = Vec::new();
            if let Some(content) = input.system {
                prompt.push(Message::System {
                    content,
                    provider_options: None,
                });
            }
            prompt.push(Message::user(input.prompt));
            let requested = input.max_output_tokens.unwrap_or(1024).min(1024);
            self.auxiliary
                .generate(
                    ModelRequest {
                        language: input.language,
                        provider: prepared.provider,
                        prompt: prompt.into(),
                        tools: Vec::new(),
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
                        scope: dispatch,
                        execution: scope
                            .identity
                            .agent()
                            .filter(|invocation| invocation.session_id == session)
                            .and_then(|invocation| {
                                scope
                                    .execution()
                                    .map(|execution| (execution.clone(), invocation.clone()))
                            }),
                        binding: source.accepted.binding.clone(),
                        session_id: session,
                    },
                    quote,
                )
                .await
                .map_err(ToolError::from)
        };
        tokio::pin!(operation);
        let result = tokio::select! {
            biased;
            _ = self.stop.cancelled() => { cancellation.cancel(); operation.await },
            result = &mut operation => result,
        };
        match result {
            Err(error @ (ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_))) => {
                Err(error)
            }
            _ if cancellation.is_cancelled() => Err(ToolError::OutcomeUnknown(
                "Recap generation cancelled; read its original receipt".into(),
            )),
            result => result,
        }
    }
}
