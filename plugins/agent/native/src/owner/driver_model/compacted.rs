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

//! Append complete compacted material from its original bound source.
use super::*;
use maka_agent_facts::context::{CheckpointContent, CompactedContext};
use maka_model::prompt::AssistantPart;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CoveredPrefix {
    message_count: usize,
    digest: String,
}
impl CoveredPrefix {
    async fn read(
        prompt: &maka_agent_engine::prepared_prompt::PreparedPrompt,
        limit: Option<usize>,
    ) -> Result<(Self, usize), RunError> {
        use maka_agent_facts::model::prompt_source::source::MessageRole;
        let directory = prompt
            .recipes()
            .ok_or_else(|| unsupported("compaction-covered-directory"))?;
        let mut cursor = directory.open_metadata(0);
        let mut hash = Sha256::new();
        hash.update(b"maka.compaction-covered-prefix.v1\0");
        let mut count = 0;
        let mut end = 0;
        while let Some(message) = cursor.next().await? {
            if message.role == MessageRole::System {
                continue;
            }
            hash.update((message.logical_identity.len() as u64).to_le_bytes());
            hash.update(message.logical_identity.as_bytes());
            count += 1;
            end = message.message_index + 1;
            if limit == Some(count) {
                break;
            }
        }
        if count == 0 {
            return Err(RunError::CompactionFailed(
                "compaction has no original logical messages".into(),
            ));
        }
        Ok((
            Self {
                message_count: count,
                digest: format!("sha256:{}", hex::encode(hash.finalize())),
            },
            end,
        ))
    }
    pub(super) async fn capture(
        prompt: &maka_agent_engine::prepared_prompt::PreparedPrompt,
    ) -> Result<Self, RunError> {
        Ok(Self::read(prompt, None).await?.0)
    }
    async fn tail_start(
        &self,
        prompt: &maka_agent_engine::prepared_prompt::PreparedPrompt,
    ) -> Result<usize, RunError> {
        if self.message_count == 0
            || !maka_agent_facts::archive::valid_projection_digest(&self.digest)
        {
            return Err(RunError::InvalidInput(
                "invalid original compaction coverage".into(),
            ));
        }
        let (actual, end) = Self::read(prompt, Some(self.message_count)).await?;
        if actual != *self {
            return Err(RunError::ReconciliationRequired(
                "pending input no longer has the exact compacted logical prefix".into(),
            ));
        }
        Ok(end)
    }
}

impl DriverModel {
    pub(super) async fn prepare_compacted_main(
        &self,
        view: &RunView,
        summary: ModelAttemptId,
        driver: &super::super::driver::NativeDriver,
    ) -> Result<PreparedStep, RunError> {
        use maka_agent_facts::model::prompt_source::source::MessageRecipe;
        let attempt = view
            .attempts
            .get(&summary)
            .ok_or_else(|| RunError::InvalidInput("adopted Summary attempt is absent".into()))?;
        let reader = self.history_reader(view.run).await?;
        let summary_request = reader.request(view.run, attempt.step).await?;
        let baseline = view.baseline.as_ref().ok_or_else(|| {
            RunError::ReconciliationRequired("adoption has no original baseline".into())
        })?;
        let compacted: CompactedContext = reader.decode(view.run, baseline).await?;
        if compacted.checkpoint.summary_step_id != attempt.step {
            return Err(RunError::InvalidInput(
                "adoption names another original Summary".into(),
            ));
        }
        let covered = self
            .frozen_input(&reader, view.run, &summary_request)
            .await?
            .covered_prefix
            .ok_or_else(|| unsupported("compaction-covered-prefix"))?;
        let current = view
            .current_step
            .ok_or_else(|| RunError::InvalidInput("adoption lost its pending request".into()))?;
        let current_request = reader.request(view.run, current).await?;
        let mut request = if current_request.accounting.purpose == ModelPurpose::Main {
            current_request
        } else {
            let main = match summary_request.compaction_recovery {
                Some(id) => view.attempts.get(&id).map(|attempt| attempt.step),
                None => {
                    self.state
                        .compaction_fallback(view.run, attempt.step)
                        .await?
                }
            }
            .ok_or_else(|| {
                RunError::InvalidInput("adoption has no original pending Main".into())
            })?;
            reader.request(view.run, main).await?
        };
        if request.accounting.purpose != ModelPurpose::Main {
            return Err(RunError::InvalidInput(
                "adoption selected a non-Main request".into(),
            ));
        }
        let mut frozen = self.frozen_input(&reader, view.run, &request).await?;
        if frozen.accepted != self.source.accepted {
            return Err(unsupported("adopted-main-model-changed"));
        }
        let model = self.source.capture().await?;
        let adapter = self.executor.binding(&model.provider)?;
        if !same_adapter_revision(adapter.source(), &frozen.adapter)
            || preparation::route_identity(&model.provider)? != frozen.route_identity
        {
            return Err(unsupported("adopted-main-route-changed"));
        }
        let bound = driver.bind_step_tools(view, &model).await?;
        let capture: RequestSource = reader.decode(view.run, &request.source_capture).await?;
        let summary_capture: RequestSource = reader
            .decode(view.run, &summary_request.source_capture)
            .await?;
        let mut checkpoint = None;
        let mut after = summary_capture.current_revision;
        while after < view.revision {
            let page = self.state.history(view.run, after, 256).await?;
            if page.is_empty() {
                break;
            }
            for fact in page {
                if fact.revision > view.revision {
                    break;
                }
                after = fact.revision;
                if matches!(&fact.fact,Fact::ContextCompacted{baseline:original} if original==baseline)
                {
                    checkpoint = Some(fact.id.to_string());
                }
            }
        }
        let checkpoint = checkpoint.ok_or_else(|| {
            RunError::ReconciliationRequired("adoption lost its original checkpoint fact".into())
        })?;
        let original = self
            .restore_frozen(&reader, view.run, &request, &frozen)
            .await?;
        let result=async{
            let start=covered.tail_start(&original).await?;
            let directory=original.recipes().ok_or_else(||unsupported("pending-main-directory"))?;
            let mut provenance:Value=reader.decode(view.run,&request.provenance).await?;
            let context = current_context(&mut provenance, &model, frozen.operation)?;
            let settings=PromptSettings{operation:frozen.operation,codex:context.as_ref().and_then(|context|context.codex.as_ref()),language:frozen.language,provider:&model.provider,options:request.composition.provider_options.as_ref().ok_or_else(||unsupported("frozen-main-options"))?,context_window:context.as_ref().and_then(|context|context.model_context_window),tool_choice:frozen.tool_choice};
            let definitions:Vec<_>=bound.definitions.into_iter().map(Arc::new).collect();
            let mut builder=preparation::PromptBuilder::new(self.preparation_io()?,self.resources.clone(),&self.cancellation).await?;
            let built=async{
                if frozen.instructions.is_none(){
                    let mut system=directory.open(0);
                    while let Some(recipe)=system.next().await?{if matches!(recipe,MessageRecipe::System{..}){builder.append_recipe(&recipe).await?;}}
                }
                self.append_compacted(&reader,view.run,baseline,ReplayTarget::new(&model, frozen.operation),&mut builder).await?;
                let mut tail=directory.open(start);
                while let Some(recipe)=tail.next().await?{if !matches!(recipe,MessageRecipe::System{..}){if let Some(recipe)=ReplayTarget::new(&model,frozen.operation).recipe(recipe).await?{builder.append_recipe(&recipe).await?;}}}
                Ok::<(),RunError>(())
            }.await;
            if let Err(error)=built{return Err(match builder.close().await{Ok(())=>error,Err(close)=>preparation::preparation_cleanup_error(error,close)});}
            let mut prompt=preparation::prepare_prompt(builder,&settings,&self.cancellation,frozen.instructions.clone().map(Arc::new),ModelPurpose::Main,None).await?;
            let result=async{
                preparation::prepare_wire(&settings,&mut prompt,&definitions,model.main_output_limit,&self.cancellation).await?;
                let calibration=self.calibration(view,&capture,&model,Some(&checkpoint)).await?;
                let prepared=preparation::prepare_request(&settings,prompt.clone(),definitions.clone(),model.main_output_limit,ModelPurpose::Main,calibration)?;
                let snapshot=preparation::snapshot_prompt(self.preparation_io()?,self.resources.clone(),&prepared.request.prompt,&self.cancellation).await?;
                let (payload,layout,cleanup)=snapshot.into_parts();
                let evidence=self.cleanup.clone();
                self.workers.spawn(async move{if let Err(error)=cleanup.await{evidence.observe(&error);}});
                frozen.prompt=payload.reference().clone();frozen.layout=layout;frozen.covered_prefix=None;
                frozen.instructions=prepared.request.prompt.instructions().map(str::to_owned);
                frozen.normalization=prepared.request.prompt.normalization().cloned();frozen.wire=FrozenWire::capture(&prepared.request.prompt)?;
                let body=ContentBlob::json(&frozen)?;
                let recovery=ContentBlob::json(&FrozenRecovery{protocol:format!("{PROTOCOL}/recovery"),version:VERSION,request:body.reference().clone(),adapter:frozen.adapter.clone(),contract:original_recovery_contract(&adapter,&model.provider,&definitions,frozen.operation)})?;
                let projection=ContentBlob::json(&json!({"original":request.projection,"baseline":baseline,"checkpoint":checkpoint}))?;
                let tool_contracts = driver.tool_contracts(&bound.catalog, &definitions)?;
                let fields=provenance.as_object_mut().ok_or_else(||unsupported("frozen-main-provenance"))?;
                fields.insert("modelInputPolicy".into(), json!({"vision": model.supports_vision, "imageInput": model.provider.image_input}));
                fields.insert("toolContracts".into(), json!(tool_contracts));
                fields.insert("inputDigest".into(),json!(prepared.input_digest));fields.insert("routeIdentity".into(),json!(prepared.route_identity));fields.insert("breakdown".into(),json!(prepared.context_breakdown));fields.insert("estimatedInputTokens".into(),json!(prepared.estimated_input_tokens));fields.insert("previousCheckpointId".into(),json!(checkpoint));
                let provenance=ContentBlob::json(&provenance)?;
                request.step=StepId::new();request.summary_repair_of=None;
                request.compaction_recovery=Some(request.compaction_recovery.or(summary_request.compaction_recovery).unwrap_or(summary));
                request.adjudications.clear();request.request=body.reference().clone();request.request_contents=frozen.content_refs();request.recovery_contract=recovery.reference().clone();request.provenance=provenance.reference().clone();request.projection=Some(projection.reference().clone());request.effective_source_digest=projection.reference().digest.clone();request.composition.tool_catalog_digest=maka_agent_engine::digest(&definitions)?;request.composition.tools=definitions;request.composition.max_output_tokens=prepared.request.max_output_tokens;
                Ok(vec![payload,body,recovery,projection,provenance])
            }.await;
            let contents=match prompt.close().await{Ok(())=>result,Err(close)=>Err(match result{Ok(_)=>self.cleanup.preparation_failed(close),Err(error)=>preparation::preparation_cleanup_error(error,close)})}?;
            Ok(PreparedStep{request,contents,notifications:vec![],steering:None})
        }.await;
        let prepared = match original.close().await {
            Ok(()) => result,
            Err(close) => Err(match result {
                Ok(_) => self.cleanup.preparation_failed(close),
                Err(error) => preparation::preparation_cleanup_error(error, close),
            }),
        }?;
        driver.install_step_tools(prepared.request.step, bound.catalog)?;
        Ok(prepared)
    }

    pub(super) async fn calibration(
        &self,
        view: &RunView,
        source: &RequestSource,
        model: &maka_agent_engine::PreparedModel,
        checkpoint: Option<&str>,
    ) -> Result<Option<maka_agent_engine::preparation::Calibration>, RunError> {
        let history = self
            .state
            .session_history(view.spec.owner.clone(), view.spec.session_id.clone());
        let sample = history.calibration_sample(&source.current).await?;
        let route = preparation::route_identity(&model.provider)?;
        Ok(sample.and_then(|sample| {
            maka_agent_engine::preparation::Calibration::for_route(
                sample,
                &self.source.accepted.binding,
                &model.provider.model,
                &route,
                checkpoint,
            )
        }))
    }

    pub(super) async fn append_compacted(
        &self,
        reader: &HistorySource<'_>,
        run: RunId,
        baseline: &ContentRef,
        target: ReplayTarget<'_>,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<RequestSource, RunError> {
        let body: CompactedContext = reader.decode(run, baseline).await?;
        if matches!(
            &body.checkpoint.summary,
            CheckpointContent::CodexNative { .. }
        ) && body.native.is_none()
        {
            return Err(unsupported("native-compaction-item"));
        }
        body.validate().map_err(|reason| {
            RunError::InvalidInput(format!("invalid compacted context: {reason}"))
        })?;
        let capture: RequestSource = reader.decode(run, &body.source_capture).await?;
        if body.checkpoint.covered_through != capture.current.through_sequence
            || body.checkpoint.source_digest != capture.current.digest
        {
            return Err(RunError::InvalidInput(
                "compacted context coverage differs from its original canonical source capture"
                    .into(),
            ));
        }
        match &body.checkpoint.summary {
            CheckpointContent::Text(text) => {
                messages
                    .append(Message::user(format!(
                        "Context summary (historical data):\n{text}"
                    )))
                    .await?;
            }
            CheckpointContent::CodexNative { .. } => {
                let native = body
                    .native
                    .as_ref()
                    .ok_or_else(|| unsupported("native-compaction-item"))?;
                let request = reader.request(run, body.checkpoint.summary_step_id).await?;
                if !target.encrypted_allowed(&request.accounting.model_id, Some(&native.producer)) {
                    return Err(RunError::InvalidInput(
                        "native Codex checkpoint requires compatible ChatGPT state or re-compaction".into(),
                    ));
                }
                append_observed(
                    messages,
                    Message::Assistant {
                        content: vec![AssistantPart::CodexCompaction {
                            item: native.item.item().clone(),
                        }],
                        provider_options: None,
                    },
                    maka_agent_facts::model::prompt_source::source::ReplayOrigin::observed(
                        &request.accounting.model_id,
                        Some(&native.producer),
                    ),
                )
                .await?;
            }
        }
        Ok(capture)
    }
}
