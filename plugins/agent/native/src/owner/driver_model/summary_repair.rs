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

pub(super) enum FrozenSummary {
    Repair(ModelAttemptId),
    Overflow(ModelAttemptId),
}
impl DriverModel {
    pub(super) async fn prepare_compaction_fallback(
        &self,
        view: &RunView,
        main: StepId,
        summary: ModelAttemptId,
    ) -> Result<PreparedStep, RunError> {
        let original = view.attempts.get(&summary).ok_or_else(|| {
            RunError::InvalidInput("compaction fallback Summary attempt is absent".into())
        })?;
        if view.current_attempt != Some(summary) || view.current_step != Some(original.step) {
            return Err(RunError::InvalidInput(
                "compaction fallback is not the current original Summary".into(),
            ));
        }
        let reader = self.history_reader(view.run).await?;
        let summary_request = reader.request(view.run, original.step).await?;
        let mut request = reader.request(view.run, main).await?;
        if summary_request.accounting.purpose != ModelPurpose::Summary
            || summary_request.compaction_recovery.is_some()
            || request.accounting.purpose != ModelPurpose::Main
            || view.attempts.values().any(|attempt| attempt.step == main)
        {
            return Err(RunError::InvalidInput(
                "compaction fallback lacks the original unattempted Main".into(),
            ));
        }
        if request.compaction_recovery.is_some()
            && self
                .state
                .compaction_progress(view.run, main)
                .await?
                .is_none()
        {
            return Err(RunError::InvalidInput(
                "compaction continuation has no original progress beyond its frozen budget cut"
                    .into(),
            ));
        }
        let frozen = self.frozen_input(&reader, view.run, &request).await?;
        if frozen.accepted != self.source.accepted {
            return Err(unsupported("compaction-fallback-model-changed"));
        }
        request.step = StepId::new();
        request.summary_repair_of = None;
        request.compaction_recovery = Some(summary);
        request.adjudications.clear();
        Ok(PreparedStep {
            request,
            contents: vec![],
            notifications: vec![],
            steering: None,
        })
    }

    pub(super) async fn prepare_frozen_summary(
        &self,
        view: &RunView,
        mode: FrozenSummary,
    ) -> Result<PreparedStep, RunError> {
        let (attempt, repair) = match mode {
            FrozenSummary::Repair(attempt) => (attempt, true),
            FrozenSummary::Overflow(attempt) => (attempt, false),
        };
        let original = view
            .attempts
            .get(&attempt)
            .ok_or_else(|| RunError::InvalidInput("summary source attempt is absent".into()))?;
        if view.current_attempt != Some(attempt) {
            return Err(RunError::InvalidInput(
                "summary source is not the current original attempt".into(),
            ));
        }
        // Inspect original request metadata only; effective input stays in its frozen closure.
        let reader = self.history_reader(view.run).await?;
        let mut request = reader.request(view.run, original.step).await?;
        if repair {
            if request.accounting.purpose != ModelPurpose::Summary
                || request.summary_repair_of.is_some()
            {
                return Err(RunError::CompactionFailed(
                    "summary repair is limited to its one original Summary".into(),
                ));
            }
        } else if request.accounting.purpose != ModelPurpose::Main
            || original.semantic
            || original.has_tools
            || !matches!(
                original.recovery,
                Some(AttemptRecovery::ContextOverflow {
                    observed_output: false
                })
            )
        {
            return Err(RunError::InvalidInput(
                "summary recovery lacks the original no-output Main overflow".into(),
            ));
        }
        if !repair
            && request.compaction_recovery.is_some()
            && self
                .state
                .compaction_progress(view.run, original.step)
                .await?
                .is_none()
        {
            return Err(RunError::InvalidInput(
                "overflow compaction has no original progress beyond its frozen budget cut".into(),
            ));
        }
        let mut frozen = self.frozen_input(&reader, view.run, &request).await?;
        if frozen.accepted != self.source.accepted {
            return Err(unsupported("summary-source-model-changed"));
        }
        let model = tokio::select! {biased;_=self.cancellation.cancelled()=>return Err(RunError::Cancelled),value=self.source.capture()=>value?};
        let adapter = self.executor.binding(&model.provider)?;
        if !same_adapter_revision(adapter.source(), &frozen.adapter)
            || preparation::route_identity(&model.provider)? != frozen.route_identity
        {
            return Err(unsupported("summary-source-adapter-changed"));
        }
        let original_prompt = self
            .restore_frozen(&reader, view.run, &request, &frozen)
            .await?;
        let native_compaction =
            !repair && model.provider.capabilities.native_compaction == Some(true);
        let context = model.context.as_ref();
        let operation = if native_compaction {
            ModelOperation::CodexCompaction
        } else {
            frozen.operation
        };
        // Coverage names the original Main, not the filtered Summary directory.
        let projected = async {
            if native_compaction && context.and_then(|value| value.codex.as_ref()).is_none() {
                return Err(unsupported("native-summary-provenance"));
            }
            if !repair {
                frozen.covered_prefix = Some(CoveredPrefix::capture(&original_prompt).await?);
            }
            let settings = PromptSettings {
                operation,
                codex: context.and_then(|value| value.codex.as_ref()),
                language: frozen.language,
                provider: &model.provider,
                options: request.composition.provider_options.as_ref()
                    .ok_or_else(|| unsupported("frozen-summary-options"))?,
                context_window: context.and_then(|value| value.model_context_window),
                tool_choice: frozen.tool_choice,
            };
            let source = original_prompt.recipes()
                .ok_or_else(|| unsupported("frozen-summary-recipes"))?;
            let mut builder = preparation::PromptBuilder::new(
                self.preparation_io()?, self.resources.clone(), &self.cancellation,
            ).await?;
            let built = async {
                let mut cursor = source.open(0);
                while let Some(recipe) = cursor.next().await? {
                    if frozen.instructions.is_some() && matches!(recipe,
                        maka_agent_facts::model::prompt_source::source::MessageRecipe::System { .. })
                    {
                        continue;
                    }
                    if let Some(recipe) = ReplayTarget::new(&model, operation).recipe(recipe).await? {
                        builder.append_recipe(&recipe).await?;
                    }
                }
                Ok::<(), RunError>(())
            }.await;
            if let Err(error) = built {
                return Err(match builder.close().await {
                    Ok(()) => error,
                    Err(close) => preparation::preparation_cleanup_error(error, close),
                });
            }
            preparation::prepare_prompt(
                builder, &settings, &self.cancellation,
                frozen.instructions.clone().map(Arc::new), ModelPurpose::Main, None,
            ).await
        }.await;
        let mut prompt = match (original_prompt.close().await, projected) {
            (Ok(()), Ok(prompt)) => prompt,
            (Ok(()), Err(error)) => return Err(error),
            (Err(close), Err(error)) => {
                return Err(preparation::preparation_cleanup_error(error, close));
            }
            (Err(close), Ok(prompt)) => {
                let error = self.cleanup.preparation_failed(close);
                return Err(match prompt.close().await {
                    Ok(()) => error,
                    Err(close) => preparation::preparation_cleanup_error(error, close),
                });
            }
        };
        let result: Result<PreparedStep, RunError> = async {
            if !repair {
                let instruction = if native_compaction {
                    None
                } else {
                    Some(Arc::new(match &view.spec.compaction_prompt {
                        Some(reference) => self.decode::<String>(view.run, reference).await?,
                        None => {
                            maka_agent_facts::context::default_compaction_prompt(view.spec.language)
                                .into()
                        }
                    }))
                };
                prompt
                    .initialize_overlays(
                        frozen.instructions.clone().map(Arc::new),
                        true,
                        instruction,
                    )
                    .await?;
            }
            let settings = PromptSettings {
                operation,
                codex: context.and_then(|value| value.codex.as_ref()),
                language: frozen.language,
                provider: &model.provider,
                options: request
                    .composition
                    .provider_options
                    .as_ref()
                    .ok_or_else(|| unsupported("frozen-summary-options"))?,
                context_window: if repair {
                    None
                } else {
                    context.and_then(|value| value.model_context_window)
                },
                tool_choice: if repair {
                    ToolChoiceMode::None
                } else {
                    ToolChoiceMode::Auto
                },
            };
            let output = if repair {
                request.composition.max_output_tokens
            } else {
                model.main_output_limit
            };
            preparation::prepare_wire(
                &settings,
                &mut prompt,
                &request.composition.tools,
                output,
                &self.cancellation,
            )
            .await?;
            if !repair && !native_compaction {
                prompt = maka_agent_engine::context_input::fit_prepared_summary(
                    &prompt,
                    maka_agent_engine::context_input::summary_budget(context),
                    frozen.language,
                    &self.cancellation,
                )
                .await?;
                preparation::prepare_wire(
                    &settings,
                    &mut prompt,
                    &request.composition.tools,
                    output,
                    &self.cancellation,
                )
                .await?;
            }
            let prepared = preparation::prepare_request(
                &settings,
                prompt.clone(),
                request.composition.tools.clone(),
                output,
                ModelPurpose::Summary,
                None,
            )?;
            let mut contents = Vec::new();
            let snapshot = preparation::snapshot_prompt(
                self.preparation_io()?,
                self.resources.clone(),
                &prepared.request.prompt,
                &self.cancellation,
            )
            .await?;
            let (prompt, chunks, layout, cleanup) = snapshot.into_parts();
            let evidence = self.cleanup.clone();
            self.workers.spawn(async move {
                if let Err(error) = cleanup.await {
                    evidence.observe(&error);
                }
            });
            frozen.prompt = prompt;
            frozen.prompt_chunks = chunks
                .iter()
                .map(|chunk| chunk.reference().clone())
                .collect();
            frozen.layout = layout;
            contents.extend(chunks);
            let mut provenance: Value = reader.decode(view.run, &request.provenance).await?;
            current_context(&mut provenance, &model, settings.operation)?;
            let fields = provenance
                .as_object_mut()
                .ok_or_else(|| unsupported("frozen-summary-provenance"))?;
            fields.insert("inputDigest".into(), json!(prepared.input_digest));
            fields.insert("routeIdentity".into(), json!(prepared.route_identity));
            fields.insert("breakdown".into(), json!(prepared.context_breakdown));
            fields.insert(
                "estimatedInputTokens".into(),
                json!(prepared.estimated_input_tokens),
            );
            let provenance = ContentBlob::json(&provenance)?;
            request.provenance = provenance.reference().clone();
            contents.push(provenance);
            request.composition.max_output_tokens = prepared.request.max_output_tokens;
            if !repair {
                request.adjudications.clear();
                request.compaction_recovery = Some(attempt);
            }
            frozen.operation = prepared.request.operation;
            frozen.tool_choice = prepared.request.tool_choice;
            frozen.item_acceptance = false;
            frozen.instructions = prepared.request.prompt.instructions().map(str::to_owned);
            frozen.normalization = prepared.request.prompt.normalization().cloned();
            frozen.wire = FrozenWire::capture(&prepared.request.prompt)?;
            let body = ContentBlob::json(&frozen)?;
            let recovery = ContentBlob::json(&FrozenRecovery {
                protocol: format!("{PROTOCOL}/recovery"),
                version: VERSION,
                request: body.reference().clone(),
                adapter: frozen.adapter.clone(),
                contract: original_recovery_contract(
                    &adapter,
                    &model.provider,
                    &request.composition.tools,
                    frozen.operation,
                ),
            })?;
            request.step = StepId::new();
            request.accounting.purpose = ModelPurpose::Summary;
            request.summary_repair_of = if repair { Some(attempt) } else { None };
            request.request = body.reference().clone();
            request.request_contents = frozen.content_refs();
            request.recovery_contract = recovery.reference().clone();
            contents.extend([body, recovery]);
            Ok(PreparedStep {
                request,
                contents,
                notifications: vec![],
                steering: None,
            })
        }
        .await;
        match prompt.close().await {
            Ok(()) => result,
            Err(error) => Err(match result {
                Ok(_) => self.cleanup.preparation_failed(error),
                Err(original) => preparation::preparation_cleanup_error(original, error),
            }),
        }
    }
}
