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
use maka_agent_engine::prepared_prompt::PreparedPrompt;
use maka_agent_state::session_history::{HistoryCut, SessionHistory};

pub(super) struct FrozenMaterializer {
    pub io: preparation::PreparationIo,
    pub resources: ModelPreparationResources,
    pub history: SessionHistory,
    pub cut: HistoryCut,
    pub run: RunId,
    pub frozen: FrozenInput,
    pub request: RequestSpec,
    pub access: Arc<crate::owner::RunAccess>,
    pub model_source: Arc<Source>,
    pub executor: ModelExecutor,
    pub provenance: Value,
    pub recovery: FrozenRecovery,
    pub authorization_failure: std::sync::Mutex<Option<maka_model::ModelError>>,
    pub provider: maka_model::ProviderConfig,
    pub budget: maka_agent_facts::context::PreparedContextBreakdown,
}
impl FrozenMaterializer {
    pub async fn authorize_current(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(), RunError> {
        if let Some(failure) = self.authorization_failure.lock().unwrap().clone() {
            return Err(RunError::Model(failure));
        }
        let result = tokio::select! {
            biased;
            _=cancellation.cancelled()=>Err(RunError::Cancelled),
            result=async{
                maka_agent_authority::permissions::Access::live_configuration(self.access.as_ref()).await?;
                let model=self.model_source.capture().await?;
                self.access.authorize_model_request(&self.request,&model,cancellation).await?;
                let model=self.model_source.capture().await?;
                validate_model_input_policy(&self.provenance,&model)?;
                let recovery=&self.recovery;
                let binding=self.executor.binding(&model.provider)?;
                if self.frozen.accepted!=self.model_source.accepted||!same_adapter_revision(binding.source(),&self.frozen.adapter)
                    ||preparation::route_identity(&model.provider)?!=self.frozen.route_identity
                    ||recovery.protocol!=format!("{PROTOCOL}/recovery")||recovery.version!=VERSION
                    ||recovery.request!=self.request.request||recovery.adapter!=self.frozen.adapter
                    ||recovery.contract!=original_recovery_contract(&binding,&model.provider,&self.request.composition.tools,self.frozen.operation){
                    return Err(unsupported("current-frozen-model-dispatch-contract"));
                }
                Ok(())
            }=>result,
        };
        match result {
            Err(error)
                if !matches!(error, RunError::Cancelled) && !error.is_cleanup_unconfirmed() =>
            {
                self.authorization_failure
                    .lock()
                    .unwrap()
                    .get_or_insert_with(|| {
                        maka_model::ModelError::LocalAuthorization(error.to_string())
                    });
                Err(RunError::Preparation(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    error,
                )))
            }
            result => result,
        }
    }
    pub async fn build(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(PreparedPrompt, ModelRequest), RunError> {
        self.authorize_current(cancellation).await?;
        let mut prompt = preparation::restore_prompt(
            self.io.clone(),
            self.resources.clone(),
            &self.history,
            &self.cut,
            self.run,
            &self.frozen.prompt,
            &self.frozen.layout,
            cancellation,
        )
        .await?
        .with_frozen_transport(
            self.frozen.instructions.as_deref(),
            self.frozen.normalization.clone(),
        );
        let result = async {
            let options = self
                .request
                .composition
                .provider_options
                .as_ref()
                .ok_or_else(|| unsupported("frozen-provider-options"))?;
            let settings = PromptSettings {
                operation: self.frozen.operation,
                codex: None,
                language: self.frozen.language,
                provider: &self.provider,
                options,
                context_window: None,
                tool_choice: self.frozen.tool_choice,
            };
            preparation::prepare_wire(
                &settings,
                &mut prompt,
                &self.request.composition.tools,
                self.request.composition.max_output_tokens,
                cancellation,
            )
            .await?;
            let rebuilt = preparation::prepare_request(
                &settings,
                prompt.clone(),
                self.request.composition.tools.clone(),
                self.request.composition.max_output_tokens,
                self.request.accounting.purpose,
                None,
            )?;
            self.frozen.wire.validate(&rebuilt.request.prompt)?;
            if rebuilt.context_breakdown != self.budget {
                return Err(unsupported("frozen-budget-signature"));
            }
            self.authorize_current(cancellation).await?;
            Ok(rebuilt.request)
        }
        .await;
        match result {
            Ok(request) => Ok((prompt, request)),
            Err(error) => {
                if let Err(cleanup) = prompt.close().await {
                    return Err(RunError::PreparationCleanup(std::io::Error::other(
                        FailedCleanup {
                            original: error,
                            cleanup,
                        },
                    )));
                }
                Err(error)
            }
        }
    }
}
impl maka_agent_ports::model::FrozenPrompt for FrozenMaterializer {
    fn authorize(
        &self,
        cancellation: CancellationToken,
    ) -> futures_util::future::BoxFuture<'_, Result<(), maka_model::ModelError>> {
        Box::pin(async move {
            self.authorize_current(&cancellation)
                .await
                .map_err(|error| {
                    self.authorization_failure
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or_else(|| {
                            if error.is_cleanup_unconfirmed() {
                                maka_model::ModelError::CleanupUnconfirmed
                            } else {
                                maka_model::ModelError::Cancelled
                            }
                        })
                })
        })
    }
    fn authorization_failure(&self) -> Option<maka_model::ModelError> {
        self.authorization_failure.lock().unwrap().clone()
    }
    fn open(
        &self,
        cancellation: CancellationToken,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<maka_agent_ports::model::MaterializedPrompt, maka_model::ModelError>,
    > {
        Box::pin(async move {
            let (prompt, request) = self.build(&cancellation).await.map_err(|error| {
                if matches!(error, RunError::Cancelled) {
                    maka_model::ModelError::Cancelled
                } else if error.is_cleanup_unconfirmed() {
                    maka_model::ModelError::CleanupUnconfirmed
                } else {
                    self.authorization_failure
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or_else(|| maka_model::ModelError::Adapter(error.to_string()))
                }
            })?;
            Ok(maka_agent_ports::model::MaterializedPrompt {
                prompt: request.prompt,
                cleanup: prompt.cleanup(),
            })
        })
    }
}

#[derive(Debug)]
struct FailedCleanup {
    original: RunError,
    cleanup: std::io::Error,
}
impl std::fmt::Display for FailedCleanup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}; materialization cleanup failed: {}",
            self.original, self.cleanup
        )
    }
}
impl std::error::Error for FailedCleanup {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.original)
    }
}
