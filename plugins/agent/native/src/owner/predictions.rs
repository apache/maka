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
use maka_agent_engine::{ModelSource, preparation::PreparationIo};
use maka_agent_facts::{
    configuration::policy::default_prediction_prompt,
    durable::{BackendSpec, Terminal},
    tools::ToolError,
};
use maka_agent_state::session_history::{HistoryCut, SessionHistory};
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
        let owner = self.clone();
        let scope = scope.clone();
        let mut ticket = scope.resources.reserve().map_err(|_| "agent_work_closed")?;
        let mut owner_ticket = self
            .auxiliary
            .resources
            .reserve()
            .map_err(|_| "agent_work_closed")?;
        let (reply, result) = tokio::sync::oneshot::channel();
        self.workers.spawn(async move {
            ticket.start();
            owner_ticket.start();
            match owner
                .predict_message_inner(input, scope, operation, dispatch)
                .await
            {
                Ok(prediction) => {
                    let _ = reply.send(Ok(prediction));
                    ticket.complete(Ok(()));
                    owner_ticket.complete(Ok(()));
                }
                Err(error) => {
                    let message = error.message();
                    let _ = reply.send(Err(message.clone()));
                    match error {
                        PredictionError::Metadata(error) => {
                            owner_ticket.unconfirmed(message.clone(), error.clone());
                            ticket.unconfirmed(message, error);
                        }
                        PredictionError::AuxiliaryCleanup {
                            cleanup,
                            source,
                            material,
                        } => {
                            // A healthy original source still running is not a cleanup failure.
                            let physical = cleanup.wait_physical().await;
                            let closed = match (physical.as_ref(), source) {
                                (Ok(_), Some(source)) => source.close().await,
                                (Ok(_), None) => false,
                                (Err(_), _) => false,
                            };
                            match physical {
                                Ok(auxiliary::PhysicalSettlement::Acknowledged) if closed => {
                                    ticket.complete(Ok(()));
                                    owner_ticket.complete(Ok(()));
                                }
                                Ok(auxiliary::PhysicalSettlement::MetadataFailure(error))
                                    if closed =>
                                {
                                    owner_ticket.unconfirmed(message.clone(), error.clone());
                                    ticket.unconfirmed(message, error);
                                }
                                observation => {
                                    let retained = Arc::new((cleanup, observation, material));
                                    owner_ticket.unconfirmed(message.clone(), retained.clone());
                                    ticket.unconfirmed(message, retained);
                                }
                            }
                        }
                        PredictionError::Cleanup {
                            metadata, material, ..
                        } => {
                            let retained = Arc::new((metadata, material));
                            owner_ticket.unconfirmed(message.clone(), retained.clone());
                            ticket.unconfirmed(message, retained);
                        }
                        PredictionError::Failed(_) => {
                            ticket.complete(Ok(()));
                            owner_ticket.complete(Ok(()));
                        }
                    }
                }
            }
        });
        result.await.map_err(|_| "agent_work_unknown".to_owned())?
    }

    async fn predict_message_inner(
        &self,
        input: PredictNextMessage,
        scope: Scope,
        operation: RecoveryRef,
        dispatch: OperationDispatchScope,
    ) -> Result<MessagePrediction, PredictionError> {
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
        if self.runs.state().await.busy(&input.session_id) {
            return Ok(result);
        }
        if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Ok(result);
        }
        let admission = auxiliary::IdleLease(Some(
            self.auxiliary_lease(&scope, &input.session_id)
                .await
                .map_err(|error| ToolError::from(error).to_string())?,
        ));
        let preparation_store = admission
            .0
            .as_ref()
            .expect("prepared auxiliary lease")
            .store();
        let custody = preparation_store
            .work_custody()
            .map_err(|error| error.to_string())?;
        let state = self
            .durable
            .with_data_writer(
                self.store
                    .data_writer_for_work(custody.as_ref(), &input.session_id)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        drop(custody);
        let history = state.session_history(self.run_owner(), input.session_id.clone());
        let cut = history.capture().await.map_err(|error| error.to_string())?;
        let Some(boundary) = history
            .latest(&cut)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(result);
        };
        if boundary.spec.turn_id != input.expected_turn_id
            || history
                .view_at(&cut, boundary.run)
                .await
                .map_err(|error| error.to_string())?
                .terminal
                != Some(Terminal::Completed)
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
        let Some(request) =
            context::original_request(&history, &cut, &boundary, &scope.cancellation, &self.stop)
                .await?
        else {
            return Ok(result);
        };
        if !matches!(request.state, ContextRequestState::Completed) {
            return Ok(result);
        }
        let BackendSpec::Model {
            descriptor,
            binding: model,
        } = &boundary.spec.backend
        else {
            return Ok(result);
        };
        let accepted = crate::model::AcceptedModel::from_backend(
            &boundary.spec.backend,
            &history
                .content(boundary.run, descriptor)
                .await
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let backend = match &session.configuration.backend {
            Some(backend) => Some(backend.clone()),
            None => self.remembered_backend(&input.session_id).await?,
        };
        if !backend
            .as_ref()
            .is_some_and(|backend| follows_current_backend(backend, model, accepted.thinking_level))
        {
            return Ok(result);
        }
        let source = crate::model::Source::restore(
            self.configuration.clone(),
            self.credentials.clone(),
            accepted,
            input.session_id.clone(),
            self.revision.clone(),
        )
        .map_err(|error| error.to_string())?;
        let source = match &self.pricing {
            Some(pricing) => source.with_pricing(Arc::clone(pricing)),
            None => source,
        };
        let prepared = match source.capture().await {
            Ok(prepared) => prepared,
            Err(maka_agent_engine::RunError::InvalidInput(_)) => return Ok(result),
            Err(error) => return Err(error.to_string().into()),
        };
        let quote = source.quote(&prepared).await.map_err(|e| e.to_string())?;
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
        let source_io =
            PreparationIo::new(&preparation_store).map_err(|error| error.to_string())?;
        let source_lease = preparation_store
            .fork_effect()
            .map_err(|error| error.to_string())?;
        let preparation = driver_model::auxiliary::prepare_completed(
            &history,
            &cut,
            &request,
            source_io.clone(),
            self.services.model_preparation_resources(),
            &prepared,
            maka_agent_facts::context::ModelPurpose::Main,
            instruction,
            &cancellation,
        );
        tokio::pin!(preparation);
        let prediction = match tokio::select! {
            biased;
            _ = self.stop.cancelled() => { cancellation.cancel(); preparation.await },
            result = &mut preparation => result,
        } {
            Ok(prediction) => prediction,
            Err(error) => {
                if error.is_cleanup_unconfirmed() {
                    let message = error.to_string();
                    let material = failed_preparation(source_io, error);
                    source_lease.retain_unconfirmed(material.clone(), message.clone());
                    return Err(PredictionError::Cleanup {
                        message,
                        metadata: None,
                        material: Some(material),
                    });
                }
                source_lease.finish(Ok(()));
                return Err(error.to_string().into());
            }
        };
        let source_current = self
            .prediction_current(
                &scope,
                &session,
                policy.revision,
                &history,
                &cut,
                &source.accepted.binding,
                source.accepted.thinking_level,
            )
            .await;
        match source_current {
            Ok(true) => {}
            stale => {
                if let Err(error) = prediction.close().await {
                    let message = format!("agent_prediction_cleanup_unconfirmed: {error}");
                    let material = failed_preparation(source_io, error);
                    source_lease.retain_unconfirmed(material.clone(), message.clone());
                    return Err(PredictionError::Cleanup {
                        message,
                        metadata: None,
                        material: Some(material),
                    });
                }
                source_lease.finish(Ok(()));
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
                    execution: auxiliary::Execution::Work {
                        custody: preparation_store
                            .work_custody()
                            .map_err(|error| error.to_string())?,
                        session: input.session_id.clone(),
                    },
                    binding: source.accepted.binding.clone(),
                    purpose: maka_agent_facts::context::ModelPurpose::Main,
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
        if let Err(auxiliary::Error::Cleanup(cleanup)) = &generation {
            let cleanup = cleanup.clone();
            let message = cleanup.to_string();
            let material = Arc::new(std::sync::Mutex::new(Some(PredictionSource::Prepared {
                io: source_io,
                prompt: prediction,
            })));
            let source = if cleanup.pending() {
                let settlement =
                    source_lease.retain_original_material(material.clone(), message.clone());
                Some(PendingPredictionSource {
                    material: material.clone(),
                    settlement,
                })
            } else {
                source_lease.retain_unconfirmed((material.clone(), cleanup.clone()), message);
                None
            };
            return Err(PredictionError::AuxiliaryCleanup {
                cleanup,
                source,
                material: Some(material),
            });
        }
        if let Err(error) = &generation {
            let unconfirmed = match error {
                auxiliary::Error::Model(error) => error.cleanup_unconfirmed(),
                auxiliary::Error::Admission(ToolError::CleanupUnconfirmed(_))
                | auxiliary::Error::Tool(ToolError::CleanupUnconfirmed(_)) => true,
                _ => false,
            };
            if unconfirmed {
                let message =
                    PredictionError::from(generation.err().expect("observed failure")).message();
                let material = Arc::new(std::sync::Mutex::new(Some(PredictionSource::Prepared {
                    io: source_io,
                    prompt: prediction,
                })));
                source_lease.retain_unconfirmed(material.clone(), message.clone());
                return Err(PredictionError::Cleanup {
                    message,
                    metadata: None,
                    material: Some(material),
                });
            }
        }
        if let Err(error) = prediction.close().await {
            let message = format!("agent_prediction_cleanup_unconfirmed: {error}");
            let material = failed_preparation(source_io, error);
            source_lease.retain_unconfirmed(material.clone(), message.clone());
            return Err(PredictionError::Cleanup {
                message,
                metadata: match &generation {
                    Err(auxiliary::Error::Metadata(failure)) => Some(failure.clone()),
                    _ => None,
                },
                material: Some(material),
            });
        }
        source_lease.finish(Ok(()));
        let generation = generation.map_err(PredictionError::from)?;
        if !self
            .prediction_current(
                &scope,
                &session,
                policy.revision,
                &history,
                &cut,
                &source.accepted.binding,
                source.accepted.thinking_level,
            )
            .await?
        {
            return Ok(result);
        }
        result.suggestion = parse_suggestion(&generation.text)?;
        Ok(result)
    }

    async fn prediction_current(
        &self,
        scope: &Scope,
        original: &SessionRecord<ResolvedConfiguration>,
        policy_revision: u64,
        history: &SessionHistory,
        cut: &HistoryCut,
        model: &maka_agent_facts::execution::ModelBinding,
        thinking: Option<ThinkingLevel>,
    ) -> Result<bool, String> {
        if scope.cancellation.is_cancelled()
            || self.stop.is_cancelled()
            || self.runs.state().await.busy(&original.id)
        {
            return Ok(false);
        }
        let current = self.scoped_session(scope, &original.id).await?;
        if current.archived
            || current.configuration.parent_session_id.is_some()
            || current.configuration.backend != original.configuration.backend
            || current.configuration.workspace != original.configuration.workspace
            || current.configuration.permissions != original.configuration.permissions
            || current.configuration.permission_basis() != original.configuration.permission_basis()
            || self
                .configuration
                .runtime_policy()
                .await
                .map_err(|error| error.to_string())?
                .revision
                != policy_revision
        {
            return Ok(false);
        }
        let backend = match &current.configuration.backend {
            Some(backend) => Some(backend.clone()),
            None => self.remembered_backend(&original.id).await?,
        };
        if !backend
            .as_ref()
            .is_some_and(|backend| follows_current_backend(backend, model, thinking))
        {
            return Ok(false);
        }
        Ok(history.capture().await.map_err(|error| error.to_string())? == *cut)
    }
}

enum PredictionSource {
    Prepared {
        io: PreparationIo,
        prompt: driver_model::auxiliary::PreparedAuxiliary,
    },
    Failed {
        _io: PreparationIo,
        _error: maka_agent_engine::RunError,
    },
}
type PredictionMaterial = Arc<std::sync::Mutex<Option<PredictionSource>>>;
fn failed_preparation(io: PreparationIo, error: maka_agent_engine::RunError) -> PredictionMaterial {
    Arc::new(std::sync::Mutex::new(Some(PredictionSource::Failed {
        _io: io,
        _error: error,
    })))
}
struct PendingPredictionSource {
    material: PredictionMaterial,
    settlement: maka_event_log::root_store::RetainedWorkSettlement,
}
impl PendingPredictionSource {
    async fn close(self) -> bool {
        let PredictionSource::Prepared { io, prompt } = self
            .material
            .lock()
            .unwrap()
            .take()
            .expect("original prediction preparation")
        else {
            unreachable!("prediction source closes once");
        };
        if let Err(error) = prompt.close().await {
            *self.material.lock().unwrap() = Some(PredictionSource::Failed {
                _io: io,
                _error: error,
            });
            return false;
        }
        drop(io);
        self.settlement.confirm_cleanup();
        true
    }
}
enum PredictionError {
    Failed(String),
    Cleanup {
        message: String,
        metadata: Option<Arc<auxiliary::MetadataFailure>>,
        material: Option<PredictionMaterial>,
    },
    Metadata(Arc<auxiliary::MetadataFailure>),
    AuxiliaryCleanup {
        cleanup: auxiliary::Cleanup,
        source: Option<PendingPredictionSource>,
        material: Option<PredictionMaterial>,
    },
}
impl PredictionError {
    fn message(&self) -> String {
        match self {
            Self::Failed(message) | Self::Cleanup { message, .. } => message.clone(),
            Self::Metadata(error) => error.to_string(),
            Self::AuxiliaryCleanup { cleanup, .. } => cleanup.to_string(),
        }
    }
}
impl From<String> for PredictionError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}
impl From<auxiliary::Error> for PredictionError {
    fn from(error: auxiliary::Error) -> Self {
        let error = match error {
            auxiliary::Error::Metadata(error) => return Self::Metadata(error),
            auxiliary::Error::Cleanup(cleanup) => {
                return Self::AuxiliaryCleanup {
                    cleanup,
                    source: None,
                    material: None,
                };
            }
            error => error,
        };
        match ToolError::from(error) {
            error @ ToolError::CleanupUnconfirmed(_) => Self::Cleanup {
                message: error.to_string(),
                metadata: None,
                material: None,
            },
            error => Self::Failed(error.to_string()),
        }
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
