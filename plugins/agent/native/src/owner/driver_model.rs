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

//! Live model capabilities. Frozen request data does not restore credentials or permissions.
use crate::model::{AcceptedModel, Source};
use futures_util::{FutureExt, future::BoxFuture, stream};
use maka_agent_engine::{
    ModelSource, RunError,
    cleanup::Evidence,
    ports::{ModelConnection, ModelObservation, Preparation, PreparedStep, RecoveryEvidence},
    preparation::{self, PromptSettings, RequestSource},
};
use maka_agent_facts::{
    composition::{RequestComposition, SourceRevision},
    context::{ModelOperation, ModelPurpose},
    durable::*,
    execution::SystemPrompt,
    input::RunInput,
    model::prompt::Message,
};
use maka_agent_state::{ContentBlob, Store, fold::RunView};
use maka_event_log::SessionStore;
use maka_model::{ModelExecutor, ModelPreparationResources, ModelRequest, ToolChoiceMode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, panic::AssertUnwindSafe, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(super) mod auxiliary;
mod compacted;
mod history_source;
mod imported;
mod materialize;
mod original;
mod recovered;
mod replay;
mod replay_admission;
use replay_admission::ReplayTarget;
mod summary_repair;
mod tool_projection;
use compacted::CoveredPrefix;
use history_source::HistorySource;
use materialize::FrozenMaterializer;

const PROTOCOL: &str = "maka.native-model-input";
const VERSION: u32 = 2;

pub(in crate::owner) fn validate_native_compaction_producer(
    enabled: bool,
    context: Option<&maka_agent_facts::context::ModelRequestContext>,
) -> Result<(), RunError> {
    if enabled && context.and_then(|context| context.codex.as_ref()).is_none() {
        return Err(RunError::InvalidInput(
            "native compaction requires ChatGPT producer provenance".into(),
        ));
    }
    Ok(())
}

pub(super) struct DriverModel {
    pub state: Store,
    pub log: Arc<SessionStore>,
    pub source: Arc<Source>,
    pub executor: ModelExecutor,
    pub resources: ModelPreparationResources,
    pub execution: ExecutionIdentity,
    pub cancellation: CancellationToken,
    pub cleanup: Evidence,
    pub workers: TaskTracker,
    pub original_cleanup: original::OriginalModelCleanup,
    pub conversation: Arc<std::sync::Mutex<Option<maka_model::Conversation>>>,
    pub preview:
        tokio::sync::watch::Sender<Option<Arc<maka_agent_facts::model::assembly::AttemptCut>>>,
}

struct ProjectedStepInput<'a> {
    system: Option<SystemPrompt>,
    messages: preparation::PromptBuilder,
    source_evidence: RequestSource,
    reader: HistorySource<'a>,
    previous_checkpoint_id: Option<String>,
    adjudications: Vec<AdjudicationBasis>,
    recovered_cells: Vec<FrozenCellKnowledge>,
}

pub(super) struct PreparedContinuation {
    pub source: maka_agent_facts::continuation::RunBoundary,
    pub base: maka_agent_facts::continuation::SessionBase,
    pub replay: maka_agent_facts::continuation::ReplayEvidence,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenInput {
    accepted: AcceptedModel,
    adapter: SourceRevision,
    item_acceptance: bool,
    route_identity: String,
    operation: ModelOperation,
    language: maka_agent_facts::language::Language,
    prompt: ContentRef,
    layout: preparation::FrozenPromptLayout,
    covered_prefix: Option<CoveredPrefix>,
    normalization: Option<maka_model::ProviderKind>,
    wire: FrozenWire,
    notifications: Vec<FrozenNotification>,
    recovered_cells: Vec<FrozenCellKnowledge>,
    instructions: Option<String>,
    system: Option<SystemPrompt>,
    tool_choice: ToolChoiceMode,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenNotification {
    cell: maka_agent_facts::cells::CellId,
    id: FactId,
    content: ContentRef,
    dependencies: Vec<ContentRef>,
    knowledge: FrozenCellKnowledge,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenCellKnowledge {
    cell: maka_agent_facts::cells::CellId,
    through: u64,
    children: std::collections::BTreeMap<uuid::Uuid, maka_agent_facts::cells::CellChild>,
}
impl FrozenCellKnowledge {
    fn capture(view: &RunView, cell: maka_agent_facts::cells::CellId) -> Result<Self, RunError> {
        let source = view.cells.get(&cell).ok_or_else(|| {
            RunError::ReconciliationRequired(
                "Cell knowledge is absent from the selected canonical head".into(),
            )
        })?;
        Ok(Self {
            cell,
            through: view.revision,
            children: source.children.clone(),
        })
    }
    fn content_refs(&self) -> Vec<ContentRef> {
        let mut refs = Vec::new();
        for child in self.children.values() {
            refs.push(child.input.clone());
            for result in [&child.local_result, &child.provider_result]
                .into_iter()
                .flatten()
            {
                refs.push(result.result.clone());
            }
        }
        refs
    }
}
impl FrozenInput {
    fn content_refs(&self) -> Vec<ContentRef> {
        let mut refs = vec![self.prompt.clone()];
        for notice in &self.notifications {
            for reference in &notice.dependencies {
                if !refs.contains(reference) {
                    refs.push(reference.clone());
                }
            }
        }
        for cell in &self.recovered_cells {
            for reference in cell.content_refs() {
                if !refs.contains(&reference) {
                    refs.push(reference);
                }
            }
        }
        refs
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenWire {
    format: maka_model::prompt::WireFormat,
    codec: String,
    identity: String,
}
impl FrozenWire {
    fn capture(prompt: &maka_model::prompt::Prompt) -> Result<Self, RunError> {
        [
            maka_model::prompt::WireFormat::ChatCompletions,
            maka_model::prompt::WireFormat::Responses,
            maka_model::prompt::WireFormat::Anthropic,
        ]
        .into_iter()
        .find_map(|format| prompt.wire(format))
        .map(|wire| Self {
            format: wire.format,
            codec: wire.codec.to_string(),
            identity: wire.identity.to_string(),
        })
        .ok_or_else(|| RunError::Internal("frozen input lacks prepared wire".into()))
    }
    fn validate(&self, prompt: &maka_model::prompt::Prompt) -> Result<(), RunError> {
        let wire = prompt
            .wire(self.format)
            .ok_or_else(|| unsupported("frozen-wire-format"))?;
        if wire.codec.as_ref() != self.codec || wire.identity.as_ref() != self.identity {
            return Err(unsupported("frozen-wire-signature"));
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrefixProof {
    run: RunId,
    attempt: ModelAttemptId,
    request: ContentRef,
    adapter: SourceRevision,
    items: u64,
    digest: String,
    basis: PrefixBasis,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PrefixBasis {
    ProviderFailure {
        failure: maka_model::ProviderFailure,
    },
    ClosedItems {
        contract: ContentRef,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenRecovery {
    protocol: String,
    version: u32,
    request: ContentRef,
    adapter: SourceRevision,
    contract: Option<maka_agent_ports::model::RecoveryContract>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemContinuation {
    protocol: String,
    version: u32,
    run: RunId,
    attempt: ModelAttemptId,
    contract: ContentRef,
    index: u64,
    part_digest: String,
    cursor: Value,
}

impl DriverModel {
    pub(super) fn prepare_step<'a>(
        &'a self,
        view: &'a RunView,
        mode: Preparation,
        driver: &'a super::driver::NativeDriver,
    ) -> BoxFuture<'a, Result<PreparedStep, RunError>> {
        if self.execution.run_id != view.run || self.log.id() != view.spec.session_id {
            return futures_util::future::ready(Err(RunError::InvalidInput(
                "model capability belongs to another execution".into(),
            )))
            .boxed();
        }
        match mode {
            Preparation::SummaryRepair { attempt } => self
                .prepare_frozen_summary(view, summary_repair::FrozenSummary::Repair(attempt))
                .boxed(),
            Preparation::ContextOverflow { attempt } => self
                .prepare_frozen_summary(view, summary_repair::FrozenSummary::Overflow(attempt))
                .boxed(),
            Preparation::CompactionFallback { main, summary }
            | Preparation::CompactionDeferred { main, summary } => async move {
                let prepared = self
                    .prepare_compaction_fallback(view, main, summary)
                    .await?;
                driver
                    .reuse_step_tools(view, main, prepared.request.step)
                    .await?;
                Ok(prepared)
            }
            .boxed(),
            Preparation::AfterCompaction { attempt } => {
                self.prepare_compacted_main(view, attempt, driver).boxed()
            }
            mode => self.prepare_main_step(view, mode, driver).boxed(),
        }
    }

    async fn prepare_main_step(
        &self,
        view: &RunView,
        mode: Preparation,
        driver: &super::driver::NativeDriver,
    ) -> Result<PreparedStep, RunError> {
        let input: RunInput = self.decode(view.run, &view.spec.input).await?;
        if matches!(input, RunInput::HistorySource { .. }) {
            return Err(unsupported("history-source-is-not-a-model-request"));
        }
        if let Preparation::Prefix { attempt, proof } = &mode {
            self.validate_prefix(view, *attempt, proof).await?;
        }
        let summary = !matches!(mode, Preparation::Replan { .. })
            && (matches!(mode, Preparation::Summary)
                || matches!(input, RunInput::ContextCompact { .. }));
        let model = tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => return Err(RunError::Cancelled),
            result = self.source.capture() => result?,
        };
        let (definitions, catalog) = if summary {
            (Vec::new(), None)
        } else {
            let bound = driver.bind_step_tools(view, &model).await?;
            (bound.definitions, Some(bound.catalog))
        };
        let definitions: Vec<_> = definitions.into_iter().map(Arc::new).collect();
        let ProjectedStepInput {
            mut system,
            mut messages,
            source_evidence,
            reader,
            previous_checkpoint_id,
            adjudications,
            recovered_cells,
        } = self
            .project_step_input(view, &input, &mode, &model, summary)
            .await?;
        let reader = &reader;
        let queue = self.state.queue();
        let cut = if summary {
            None
        } else {
            Some(
                queue
                    .steering(view.spec.session_id.clone(), view.run)
                    .await?,
            )
        };
        let mut steering_refs = Vec::new();
        let mut steering_contents = Vec::new();
        let mut steering_evidence = Vec::new();
        for entry in cut.as_ref().into_iter().flat_map(|cut| &cut.entries) {
            let request = &entry.request;
            if request.spec.workspace != view.spec.workspace
                || request.spec.permission_basis != view.spec.permission_basis
            {
                return Err(RunError::InvalidInput(
                    "steering workspace basis changed".into(),
                ));
            }
            let source_bytes = queue
                .content(
                    view.spec.session_id.clone(),
                    request.id.clone(),
                    request.source.clone(),
                )
                .await?;
            let input_bytes = queue
                .content(
                    view.spec.session_id.clone(),
                    request.id.clone(),
                    request.spec.input.clone(),
                )
                .await?;
            let resource_bytes = queue
                .content(
                    view.spec.session_id.clone(),
                    request.id.clone(),
                    request.resources.clone(),
                )
                .await?;
            let source: maka_agent_facts::message::RootSourceMessage =
                serde_json::from_slice(&source_bytes).map_err(RunError::Json)?;
            source
                .validate()
                .map_err(|error| RunError::InvalidInput(error.into()))?;
            let steering_input: RunInput =
                serde_json::from_slice(&input_bytes).map_err(RunError::Json)?;
            let RunInput::Message { content, .. } = &steering_input else {
                return Err(RunError::InvalidInput(
                    "steering is not message input".into(),
                ));
            };
            if content != &source.message.content {
                return Err(RunError::InvalidInput(
                    "steering input and original source differ".into(),
                ));
            }
            let resources: Value =
                serde_json::from_slice(&resource_bytes).map_err(RunError::Json)?;
            if resources["attachments"]
                != serde_json::to_value(&content.attachments).map_err(RunError::Json)?
            {
                return Err(RunError::InvalidInput(
                    "steering immutable resources differ from input".into(),
                ));
            }
            messages
                .append(
                    preparation::project_input(
                        &self.state.artifacts(),
                        &maka_agent_state::artifacts::SessionScope {
                            owner: view.spec.owner.clone(),
                            session: view.spec.session_id.clone(),
                        },
                        content,
                        view.spec.language,
                        model.supports_vision,
                        true,
                        source.message.origin.as_ref(),
                        &self.resources,
                        &self.cancellation,
                    )
                    .await?,
                )
                .await?;
            merge_skill(&mut system, content)?;
            steering_evidence.push(json!({"input": steering_input, "resources": resources}));
            steering_refs.push(request.source.clone());
            steering_contents.push(ContentBlob::new(source_bytes));
        }
        let steering = cut
            .as_ref()
            .filter(|cut| !cut.entries.is_empty())
            .map(|cut| maka_agent_state::queue::Consume {
                session: view.spec.session_id.clone(),
                expected_revision: cut.revision,
                requests: cut
                    .entries
                    .iter()
                    .map(|entry| entry.request.id.clone())
                    .collect(),
            });
        let notifications = if summary {
            Vec::new()
        } else {
            self.state
                .cells()
                .notifications(view.run, None, 128)
                .await?
        };
        let notification_through = view.revision;
        let mut notification_sources = Vec::with_capacity(notifications.len());
        for notice in &notifications {
            let knowledge = FrozenCellKnowledge::capture(view, notice.cell)?;
            let dependencies = self
                .append_notification(
                    reader,
                    view,
                    notification_through,
                    notice,
                    &knowledge,
                    model.supports_vision,
                    &mut messages,
                )
                .await?;
            notification_sources.push(FrozenNotification {
                cell: notice.cell,
                id: notice.id,
                content: notice.content.clone(),
                dependencies,
                knowledge,
            });
        }
        let purpose = if summary {
            ModelPurpose::Summary
        } else {
            ModelPurpose::Main
        };
        let native_compaction = purpose == ModelPurpose::Summary
            && model.provider.capabilities.native_compaction == Some(true);
        let context = model.context.as_ref();
        validate_native_compaction_producer(native_compaction, context)?;
        let settings = PromptSettings {
            operation: if !adjudications.is_empty() {
                ModelOperation::Inference
            } else if native_compaction {
                ModelOperation::CodexCompaction
            } else {
                context.map_or(ModelOperation::Inference, |value| value.operation)
            },
            codex: context.and_then(|value| value.codex.as_ref()),
            language: view.spec.language,
            provider: &model.provider,
            options: &model.options,
            context_window: context.and_then(|value| value.model_context_window),
            tool_choice: ToolChoiceMode::Auto,
        };
        let accounting = maka_agent_facts::accounting::ModelEvidence {
            binding: self.source.accepted.binding.clone(),
            model_id: model.provider.model.clone(),
            purpose,
            quote: Some(self.source.quote(&model).await?),
        };
        let adapter = self.executor.binding(&model.provider)?;
        let dynamic_context = vec![format!(
            "{}\n{}",
            match view.spec.language {
                maka_agent_facts::language::Language::En => "Session context (data):",
                maka_agent_facts::language::Language::ZhCn => "会话上下文（数据）：",
                maka_agent_facts::language::Language::ZhTw => "工作階段上下文（資料）：",
            },
            json!({"cwd": view.spec.workspace, "sessionId": view.spec.session_id})
        )];
        let mut rendered = system
            .as_ref()
            .map(|value| value.text.clone())
            .unwrap_or_default();
        for section in &dynamic_context {
            if !rendered.is_empty() {
                rendered.push_str("\n\n");
            }
            rendered.push_str(section);
        }
        let instruction = if purpose == ModelPurpose::Summary && !native_compaction {
            Some(Arc::new(match &view.spec.compaction_prompt {
                Some(reference) => self.decode::<String>(view.run, reference).await?,
                None => {
                    maka_agent_facts::context::default_compaction_prompt(view.spec.language).into()
                }
            }))
        } else {
            None
        };
        let rendered = Arc::new(rendered);
        let mut prompt = preparation::prepare_prompt(
            messages,
            &settings,
            &self.cancellation,
            Some(rendered.clone()),
            purpose,
            None,
        )
        .await?;
        let prepared = Box::pin(async {
            let covered_prefix=if purpose==ModelPurpose::Summary{
                let covered=CoveredPrefix::capture(&prompt).await?;
                prompt.initialize_overlays(Some(rendered),true,instruction).await?;
                Some(covered)
            }else{None};
            preparation::prepare_wire(
                &settings,
                &mut prompt,
                &definitions,
                model.main_output_limit,
                &self.cancellation,
            )
            .await?;
            if purpose == ModelPurpose::Summary && !native_compaction {
                prompt = maka_agent_engine::context_input::fit_prepared_summary(
                    &prompt,
                    maka_agent_engine::context_input::summary_budget(context),
                    view.spec.language,
                    &self.cancellation,
                )
                .await?;
                preparation::prepare_wire(
                    &settings,
                    &mut prompt,
                    &definitions,
                    model.main_output_limit,
                    &self.cancellation,
                )
                .await?;
            }
            let calibration = if purpose==ModelPurpose::Main {
                self.calibration(view,&source_evidence,&model,previous_checkpoint_id.as_deref()).await?
            }else{None};
            let request = preparation::prepare_request(
                &settings,
                prompt.clone(),
                definitions.clone(),
                model.main_output_limit,
                purpose,
                calibration,
            )?;
            if view.steps.is_empty()
                && adjudications.is_empty()
                && let RunInput::Continuation { claim, .. } = &input
            {
                maka_agent_engine::preparation::validate_continuation(
                    &self.state,
                    &self.execution,
                    claim,
                    &view.spec.permission_basis,
                    &view.spec.workspace,
                    &prompt,
                    &request,
                )
                .await?;
            }
            let snapshot = preparation::snapshot_prompt(
                self.preparation_io()?,
                self.resources.clone(),
                &request.request.prompt,
                &self.cancellation,
            )
            .await?;
            let (payload, layout, cleanup) = snapshot.into_parts();
            let cleanup_evidence = self.cleanup.clone();
            self.workers.spawn(async move {
                if let Err(error) = cleanup.await {
                    cleanup_evidence.observe(&error);
                }
            });
            let frozen = FrozenInput {
                accepted: self.source.accepted.clone(),
                adapter: adapter.source().clone(),
                item_acceptance: purpose == ModelPurpose::Main
                    && adapter.supports_item_acceptance(),
                route_identity: request.route_identity.clone(),
                operation: request.request.operation,
                language: request.request.language,
                prompt: payload.reference().clone(),
                layout,
                covered_prefix,
                normalization: request.request.prompt.normalization().cloned(),
                wire: FrozenWire::capture(&request.request.prompt)?,
                notifications: notification_sources,
                recovered_cells,
                instructions: request.request.prompt.instructions().map(str::to_owned),
                system: system.clone(),
                tool_choice: request.request.tool_choice,
            };
            let body = ContentBlob::json(&frozen)?;
            let recovery_contract = ContentBlob::json(&FrozenRecovery {
                protocol: format!("{PROTOCOL}/recovery"),
                version: VERSION,
                request: body.reference().clone(),
                adapter: adapter.source().clone(),
                contract: original_recovery_contract(
                    &adapter,
                    &model.provider,
                    &definitions,
                    frozen.operation,
                ),
            })?;
            let capture = ContentBlob::json(&source_evidence)?;
            let projection = ContentBlob::json(&json!({
                "execution": self.execution, "canonicalRevision": view.revision,
                "input": view.spec.input, "historicalSourceDigest": source_evidence.cut.digest,
                "steering": steering_refs,
                "notifications": &frozen.notifications,
                "recoveredCells": &frozen.recovered_cells,
            }))?;
            let mut request_context = model.context.clone();
            if let Some(context) = request_context.as_mut() {
                context.operation = settings.operation;
            }
            let tool_contracts = match catalog.as_ref() {
                Some(catalog) => driver.tool_contracts(catalog, &definitions)?,
                None => std::collections::BTreeMap::new(),
            };
            let provenance = ContentBlob::json(&json!({
                "inputDigest": request.input_digest,
                "toolContracts": tool_contracts,
                "routeIdentity": request.route_identity,
                "modelInputPolicy": {"vision": model.supports_vision, "imageInput": model.provider.image_input},
                "breakdown": request.context_breakdown,
                "estimatedInputTokens":request.estimated_input_tokens,
                "modelContext": request_context,
                "previousCheckpointId":previous_checkpoint_id,
                "steering": steering_evidence,
                "notifications": &frozen.notifications,
                "recoveredCells": &frozen.recovered_cells,
            }))?;
            let mut revisions = system
                .as_ref()
                .map(|value| value.sources.clone())
                .unwrap_or_default();
            revisions.push(adapter.source().clone());
            revisions.push(model.revision.clone());
            let composition = RequestComposition {
                system_prompt: system.map(|value| value.text),
                dynamic_context,
                tool_catalog_digest: maka_agent_engine::digest(&definitions)?,
                tools: definitions,
                provider_options: Some(model.options.clone()),
                max_output_tokens: request.request.max_output_tokens,
                sources: revisions,
            };
            let spec = RequestSpec {
                schema_version: SCHEMA_VERSION,
                step: StepId::new(),
                composition,
                accounting,
                summary_repair_of: None,
                compaction_recovery: match (&mode,view.current_step) {
                    (Preparation::Summary,_)=>None,
                    (_,Some(step)) => {
                        let prior = reader.request(view.run, step).await?;
                        prior.compaction_recovery.or_else(|| {
                            if prior.accounting.purpose != ModelPurpose::Summary {
                                return None;
                            }
                            view.current_attempt.filter(|id| {
                                view.attempts
                                    .get(id)
                                    .is_some_and(|attempt| attempt.step == step)
                            })
                        })
                    }
                    (_,None) => None,
                },
                source_capture: capture.reference().clone(),
                source_digest: source_evidence.cut.digest.clone(),
                effective_source_digest: if adjudications.is_empty() {
                    projection.reference().digest.clone()
                } else {
                    maka_agent_engine::digest(&(
                        &source_evidence,
                        &adjudications,
                        &request.input_digest,
                    ))?
                },
                provenance: provenance.reference().clone(),
                projection: if adjudications.is_empty() {
                    Some(projection.reference().clone())
                } else {
                    None
                },
                adjudications: adjudications.clone(),
                steering: steering_refs,
                request: body.reference().clone(),
                request_contents: frozen.content_refs(),
                recovery_contract: recovery_contract.reference().clone(),
                protocol: PROTOCOL.into(),
                protocol_version: VERSION,
            };
            Ok(PreparedStep {
                notifications,
                request: spec,
                contents: {
                    let mut contents = vec![
                        body,
                        payload,
                        recovery_contract,
                        capture,
                        provenance,
                        projection,
                    ];
                    contents.extend(steering_contents);
                    contents
                },
                steering,
            })
        })
        .await;
        let prepared = match prompt.close().await {
            Ok(()) => prepared,
            Err(close) => Err(match prepared {
                Ok(_) => self.cleanup.preparation_failed(close),
                Err(error) => preparation::preparation_cleanup_error(error, close),
            }),
        }?;
        if let Some(catalog) = catalog {
            driver.install_step_tools(prepared.request.step, catalog)?;
        }
        Ok(prepared)
    }

    fn project_step_input<'a>(
        &'a self,
        view: &'a RunView,
        input: &'a RunInput,
        mode: &'a Preparation,
        model: &'a maka_agent_engine::PreparedModel,
        summary: bool,
    ) -> BoxFuture<'a, Result<ProjectedStepInput<'a>, RunError>> {
        Box::pin(async move {
            let target = ReplayTarget::new(
                model,
                if summary && model.provider.capabilities.native_compaction == Some(true) {
                    ModelOperation::CodexCompaction
                } else {
                    ModelOperation::Inference
                },
            );

            let mut system: Option<SystemPrompt> =
                self.decode(view.run, &view.spec.system_prompt).await?;
            merge_input_skills(&mut system, input)?;
            let history = self
                .state
                .session_history(view.spec.owner.clone(), view.spec.session_id.clone());
            let root = self.ancestry_root(view.run, input).await?;
            let mut source_evidence = RequestSource {
                cut: history.capture_before(root).await?,
                current: history.capture().await?,
                current_revision: view.revision,
            };
            let captured = HistorySource::live(&self.state, &source_evidence.current);
            let reader = &captured;
            let mut messages = preparation::PromptBuilder::new(
                self.preparation_io()?,
                self.resources.clone(),
                &self.cancellation,
            )
            .await?;
            let mut previous_checkpoint_id = None;
            let mut recovered_cells = Vec::new();
            let adjudications: Vec<AdjudicationBasis> = if let Preparation::Replan {
                attempt,
                adjudications: inputs,
            } = mode
            {
                let attempt = attempt.ok_or_else(|| unsupported("replan-without-model-base"))?;
                let (source, baseline, knowledge) = self
                    .replan_input(
                        reader,
                        view,
                        attempt,
                        inputs,
                        model.supports_vision,
                        &mut messages,
                    )
                    .await?;
                source_evidence = source;
                system = baseline;
                recovered_cells = knowledge;
                let original = view
                    .attempts
                    .get(&attempt)
                    .ok_or_else(|| RunError::InvalidInput("replan attempt is absent".into()))?;
                previous_checkpoint_id = self
                    .request_checkpoint(
                        reader,
                        view.run,
                        &reader.request(view.run, original.step).await?,
                    )
                    .await?;
                inputs.iter().map(|input| input.basis.clone()).collect()
            } else {
                Vec::new()
            };
            let mut has_main_attempt = false;
            if summary {
                for attempt in view.attempts.values() {
                    if reader
                        .request(view.run, attempt.step)
                        .await?
                        .accounting
                        .purpose
                        == ModelPurpose::Main
                    {
                        has_main_attempt = true;
                        break;
                    }
                }
            }
            let pre_turn_summary = summary && !has_main_attempt;
            if adjudications.is_empty() {
                if pre_turn_summary {
                    let before = history.capture_before(view.run).await?;
                    previous_checkpoint_id = match input {
                        RunInput::Continuation { claim, .. } => {
                            self.inherited_messages(
                                target,
                                reader,
                                claim.source.execution.run_id,
                                view.spec.language,
                                model.supports_vision,
                                &mut system,
                                &mut messages,
                            )
                            .await?
                        }
                        _ => {
                            self.canonical_messages(
                                target,
                                &before,
                                model.supports_vision,
                                view.spec.language,
                                &mut messages,
                            )
                            .await?
                        }
                    };
                    source_evidence.current = before;
                    source_evidence.current_revision = 0;
                } else if view.baseline.is_some() {
                    (previous_checkpoint_id, recovered_cells) = self
                        .project_history(
                            target,
                            reader,
                            model.supports_vision,
                            view.spec.language,
                            &mut messages,
                        )
                        .await?;
                } else if let Some((after, request)) = self.latest_replan(reader, view).await? {
                    let (source, baseline) = self
                        .request_base(target, reader, view.run, &request, &mut messages)
                        .await?;
                    source_evidence = source;
                    source_evidence.current = history.capture().await?;
                    source_evidence.current_revision = view.revision;
                    system = baseline;
                    previous_checkpoint_id =
                        self.request_checkpoint(reader, view.run, &request).await?;
                    recovered_cells = self
                        .semantic_tail(
                            target,
                            reader,
                            view,
                            model.supports_vision,
                            &mut system,
                            &mut messages,
                            after,
                        )
                        .await?;
                } else {
                    match input {
                        RunInput::Continuation { claim, .. } => {
                            previous_checkpoint_id = self
                                .inherited_messages(
                                    target,
                                    reader,
                                    claim.source.execution.run_id,
                                    view.spec.language,
                                    model.supports_vision,
                                    &mut system,
                                    &mut messages,
                                )
                                .await?
                        }
                        _ => {
                            previous_checkpoint_id = self
                                .canonical_messages(
                                    target,
                                    &source_evidence.cut,
                                    model.supports_vision,
                                    view.spec.language,
                                    &mut messages,
                                )
                                .await?;
                            self.project_message_input(
                                reader,
                                view,
                                input,
                                model.supports_vision,
                                false,
                                &mut messages,
                            )
                            .await?;
                        }
                    }
                    recovered_cells = self
                        .semantic_tail(
                            target,
                            reader,
                            view,
                            model.supports_vision,
                            &mut system,
                            &mut messages,
                            0,
                        )
                        .await?;
                }
            }
            Ok(ProjectedStepInput {
                system,
                messages,
                source_evidence,
                reader: captured,
                previous_checkpoint_id,
                adjudications,
                recovered_cells,
            })
        })
    }

    pub(super) async fn step_tool_model(
        &self,
        view: &RunView,
        request: &RequestSpec,
    ) -> Result<maka_agent_engine::PreparedModel, RunError> {
        if self.execution.run_id != view.run || self.log.id() != view.spec.session_id {
            return Err(RunError::InvalidInput(
                "tool model belongs to another execution".into(),
            ));
        }
        let reader = self.history_reader(view.run).await?;
        let frozen = self.frozen_input(&reader, view.run, request).await?;
        if frozen.accepted != self.source.accepted
            || request.request_contents != frozen.content_refs()
        {
            return Err(unsupported("frozen-tool-model-source-changed"));
        }
        let original = self.workers.spawn({
            let source = Arc::clone(&self.source);
            async move { source.capture().await }
        });
        let model = original
            .await
            .map_err(|error| RunError::Internal(error.to_string()))??;
        let binding = self.executor.binding(&model.provider)?;
        if !same_adapter_revision(binding.source(), &frozen.adapter)
            || preparation::route_identity(&model.provider)? != frozen.route_identity
        {
            return Err(unsupported("frozen-tool-model-route-changed"));
        }
        let provenance: Value = self.decode(view.run, &request.provenance).await?;
        validate_model_input_policy(&provenance, &model)?;
        let recovery: FrozenRecovery = self
            .protocol_data(
                view.run,
                &request.recovery_contract,
                "recovery-contract-schema",
            )
            .await?;
        if recovery.request != request.request
            || recovery.adapter != frozen.adapter
            || recovery.protocol != format!("{PROTOCOL}/recovery")
            || recovery.version != VERSION
            || recovery.contract
                != original_recovery_contract(
                    &binding,
                    &model.provider,
                    &request.composition.tools,
                    frozen.operation,
                )
        {
            return Err(super::driver::source_authority_changed(
                "original model binding contract changed",
            ));
        }
        Ok(model)
    }

    async fn history_reader(&self, run: RunId) -> Result<HistorySource<'_>, RunError> {
        let view = self.state.frontier(run).await?;
        let history = self
            .state
            .session_history(view.spec.owner.clone(), view.spec.session_id.clone());
        let cut = history.capture().await?;
        Ok(HistorySource::live(&self.state, &cut))
    }

    async fn append_notification(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        through: u64,
        notification: &maka_agent_state::cells::PendingNotification,
        knowledge: &FrozenCellKnowledge,
        vision: bool,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<Vec<ContentRef>, RunError> {
        let (message, dependencies) = preparation::project_cell_notification_from(
            reader.notification_source(),
            &maka_agent_state::artifacts::ArtifactScope {
                owner: view.spec.owner.clone(),
                session: view.spec.session_id.clone(),
                run: view.run,
                through,
            },
            notification,
            view.spec.language,
            vision,
            &self.resources,
            &self.cancellation,
        )
        .await?;
        messages.append(message).await?;
        let (message, extra) = preparation::project_cell_knowledge(
            reader.notification_source(),
            &maka_agent_state::artifacts::ArtifactScope {
                owner: view.spec.owner.clone(),
                session: view.spec.session_id.clone(),
                run: view.run,
                through: knowledge.through,
            },
            knowledge.cell,
            knowledge.through,
            &knowledge.children,
            view.spec.language,
            vision,
            &self.resources,
            &self.cancellation,
        )
        .await?;
        messages.append(message).await?;
        let mut dependencies = dependencies;
        for reference in extra {
            if !dependencies.contains(&reference) {
                dependencies.push(reference);
            }
        }
        Ok(dependencies)
    }

    async fn project_message_input(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        input: &RunInput,
        vision: bool,
        steering: bool,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<(), RunError> {
        if matches!(input, RunInput::HistorySource { .. }) {
            return Err(unsupported(
                "history-source-requires-bound-snapshot-projection",
            ));
        }
        if let RunInput::Message {
            content,
            source_messages,
            ..
        } = input
        {
            let scope = maka_agent_state::artifacts::SessionScope {
                owner: view.spec.owner.clone(),
                session: view.spec.session_id.clone(),
            };
            if source_messages.is_empty() {
                messages
                    .append(
                        preparation::project_input_from(
                            reader.media_source(scope.clone().into()),
                            content,
                            view.spec.language,
                            vision,
                            steering,
                            None,
                            &self.resources,
                            &self.cancellation,
                        )
                        .await?,
                    )
                    .await?;
            } else {
                for source in source_messages {
                    messages
                        .append(
                            preparation::project_input_from(
                                reader.media_source(scope.clone().into()),
                                &source.message.content,
                                view.spec.language,
                                vision,
                                steering,
                                source.message.origin.as_ref(),
                                &self.resources,
                                &self.cancellation,
                            )
                            .await?,
                        )
                        .await?;
                }
            }
        }
        Ok(())
    }

    async fn latest_replan(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
    ) -> Result<Option<(u64, RequestSpec)>, RunError> {
        let mut after = 0;
        let mut latest = None;
        while after < view.revision {
            let page = reader.history(view.run, after, 256).await?;
            if page.is_empty() {
                break;
            }
            for item in page {
                if item.revision > view.revision {
                    break;
                }
                after = item.revision;
                if let Fact::StepPrepared { step, .. } = item.fact {
                    let request = reader.request(view.run, step).await?;
                    if !request.adjudications.is_empty() {
                        latest = Some((after, request));
                    }
                }
            }
        }
        Ok(latest)
    }
    async fn frozen_input(
        &self,
        reader: &HistorySource<'_>,
        run: RunId,
        request: &RequestSpec,
    ) -> Result<FrozenInput, RunError> {
        if request.protocol != PROTOCOL || request.protocol_version != VERSION {
            return Err(unsupported("frozen-input-protocol-version"));
        }
        super::driver::validate_tool_digest(request)?;
        let value: Value = reader.decode(run, &request.request).await?;
        serde_json::from_value(value).map_err(|_| unsupported("frozen-input-manifest-schema"))
    }
    async fn restore_frozen(
        &self,
        reader: &HistorySource<'_>,
        run: RunId,
        request: &RequestSpec,
        frozen: &FrozenInput,
    ) -> Result<maka_agent_engine::prepared_prompt::PreparedPrompt, RunError> {
        if request.protocol != PROTOCOL || request.protocol_version != VERSION {
            return Err(unsupported("frozen-input-protocol"));
        }
        if request.request_contents != frozen.content_refs() {
            return Err(unsupported("frozen-input-content-dependencies"));
        }
        let prompt = preparation::restore_prompt_from(
            self.preparation_io()?,
            self.resources.clone(),
            reader.content_source(),
            run,
            &frozen.prompt,
            &frozen.layout,
            &self.cancellation,
        )
        .await?;
        Ok(prompt
            .with_frozen_transport(frozen.instructions.as_deref(), frozen.normalization.clone()))
    }
    async fn append_frozen_base(
        &self,
        target: ReplayTarget<'_>,
        reader: &HistorySource<'_>,
        run: RunId,
        request: &RequestSpec,
        frozen: &FrozenInput,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<(), RunError> {
        let prompt = self.restore_frozen(reader, run, request, frozen).await?;
        let result = async {
            let context: maka_agent_facts::context::RequestContextEvidence =
                reader.decode(run, &request.provenance).await?;
            let producer = context
                .model_context
                .as_ref()
                .and_then(|context| context.codex.as_ref());
            let source = prompt
                .recipes()
                .ok_or_else(|| unsupported("frozen-recipe-source"))?;
            let mut cursor = source.open(0);
            while let Some(recipe) = cursor.next().await? {
                if !matches!(
                    recipe,
                    maka_agent_facts::model::prompt_source::source::MessageRecipe::System { .. }
                ) {
                    if let Some(recipe) = target
                        .recipe(recipe, &request.accounting.model_id, producer)
                        .await?
                    {
                        messages.append_recipe(&recipe).await?;
                    }
                }
            }
            Ok(())
        }
        .await;
        prompt
            .close()
            .await
            .map_err(|error| self.cleanup.preparation_failed(error))?;
        result
    }
    async fn request_base(
        &self,
        target: ReplayTarget<'_>,
        reader: &HistorySource<'_>,
        run: RunId,
        request: &RequestSpec,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<(RequestSource, Option<SystemPrompt>), RunError> {
        let frozen = self.frozen_input(reader, run, request).await?;
        self.append_frozen_base(target, reader, run, request, &frozen, messages)
            .await?;
        let source: RequestSource = reader.decode(run, &request.source_capture).await?;
        let system = frozen.system;
        Ok((source, system))
    }

    async fn replan_input(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        attempt: ModelAttemptId,
        inputs: &[maka_agent_engine::ports::ReplanInput],
        vision: bool,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<
        (
            RequestSource,
            Option<SystemPrompt>,
            Vec<FrozenCellKnowledge>,
        ),
        RunError,
    > {
        use maka_model::prompt::{ContentPart, ToolOutput};
        let original = view
            .attempts
            .get(&attempt)
            .ok_or_else(|| RunError::InvalidInput("adjudicated model attempt is missing".into()))?;
        let request = reader.request(view.run, original.step).await?;
        let frozen = self.frozen_input(reader, view.run, &request).await?;
        let model = self.source.capture().await?;
        let binding = self.executor.binding(&model.provider)?;
        if frozen.accepted != self.source.accepted
            || !same_adapter_revision(binding.source(), &frozen.adapter)
            || preparation::route_identity(&model.provider)? != frozen.route_identity
        {
            return Err(unsupported("replan-base-route-changed"));
        }
        self.append_frozen_base(
            ReplayTarget::new(&model, ModelOperation::Inference),
            reader,
            view.run,
            &request,
            &frozen,
            messages,
        )
        .await?;
        let observed = self.canonical_parts(view, attempt).await?;
        let original_cells = self.recorded_inputs(reader, view, 0).await?.cells;
        let mut reports = Vec::with_capacity(inputs.len());
        for input in inputs {
            let evidence: Value = reader.decode(view.run, &input.basis.evidence).await?;
            reports.push(json!({"adjudication":input.basis,"decision":input.decision,"humanEvidence":evidence}));
        }
        let report = json!({"type":"host_model_interruption","attempt":attempt,"originalRequest":request.request,"observedThrough":view.revision,"adjudications":reports,"completeItemObservations":observed,"upstreamClosedNotInferred":true,"unknownProviderEffectsNotDeclaredSuccessful":true});
        let mut content = vec![
            ContentPart::text(
                "The original model attempt was interrupted. The following are Host-recorded observations and an explicit human risk decision, not a replayable assistant response or proof of upstream completion. Start a new plan from the legal request base; do not resend an operation whose original outcome remains unknown.",
            ),
            ContentPart::text(serde_json::to_string(&report).map_err(RunError::Json)?),
        ];
        let mut source: RequestSource = reader.decode(view.run, &request.source_capture).await?;
        let mut after = source.current_revision;
        let mut seen = std::collections::BTreeSet::new();
        loop {
            let page = reader.history(view.run, after, 256).await?;
            if page.is_empty() {
                break;
            }
            for fact in page {
                after = fact.revision;
                if after > view.revision {
                    break;
                }
                let Fact::ToolResultAccepted {
                    tool: link, result, ..
                } = &fact.fact
                else {
                    continue;
                };
                if link.attempt != attempt {
                    continue;
                }
                if !seen.insert(link.clone()) {
                    continue;
                }
                let tool = reader.tool_call(view.run, link).await?;
                let output = if let Some(output) = self
                    .archived_tool_result(reader, view, fact.id, &fact.fact, &tool)
                    .await?
                {
                    output
                } else {
                    let evidence = reader.decode(view.run, result).await?;
                    self.project_accepted(
                        reader,
                        view,
                        view.revision,
                        &original_cells,
                        evidence,
                        vision,
                        view.spec.language,
                    )
                    .await?
                };
                content.push(ContentPart::text(format!(
                    "Original tool observation for {} ({}):",
                    tool.name, tool.id
                )));
                match output {
                    ToolOutput::Text(text) | ToolOutput::ErrorText(text) => {
                        content.push(ContentPart::text(text))
                    }
                    ToolOutput::Json(value) | ToolOutput::ErrorJson(value) => content.push(
                        ContentPart::text(serde_json::to_string(&value).map_err(RunError::Json)?),
                    ),
                    ToolOutput::Content(parts) => content.extend(parts),
                }
            }
            if after >= view.revision {
                break;
            }
        }
        messages
            .append(Message::User {
                content,
                provider_options: None,
            })
            .await?;
        source.current = self
            .state
            .session_history(view.spec.owner.clone(), view.spec.session_id.clone())
            .capture()
            .await?;
        source.current_revision = view.revision;
        let system = frozen.system;
        Ok((source, system, original_cells.into_values().collect()))
    }

    async fn decode<T: serde::de::DeserializeOwned>(
        &self,
        run: RunId,
        reference: &ContentRef,
    ) -> Result<T, RunError> {
        let bytes = self.state.content(run, reference.clone()).await?;
        serde_json::from_slice(&bytes).map_err(RunError::Json)
    }

    async fn protocol_data<T: serde::de::DeserializeOwned>(
        &self,
        run: RunId,
        reference: &ContentRef,
        feature: &str,
    ) -> Result<T, RunError> {
        let bytes = self.state.content(run, reference.clone()).await?;
        serde_json::from_slice(&bytes).map_err(|_| unsupported(feature))
    }

    /// Computes replay evidence only. The Owner alone creates/adopts the new claim and Run.
    pub(super) async fn prepare_continuation(
        &self,
        source_run: RunId,
        mut system: Option<SystemPrompt>,
        visible_defs: Vec<maka_agent_facts::tools::ToolDefinition>,
    ) -> Result<PreparedContinuation, RunError> {
        let reader = &self.history_reader(source_run).await?;
        use maka_agent_facts::continuation::{
            REPLAY_VERSION, ReplayEvidence, RunBoundary, SessionBase,
        };
        let original = self.state.frontier(source_run).await?;
        if original.terminal.is_none()
            || original.spec.session_id != self.execution.session_id
            || source_run == self.execution.run_id
        {
            return Err(RunError::InvalidInput(
                "continuation requires a sealed source and fresh target in the same Session".into(),
            ));
        }
        let mut history = Vec::new();
        let mut after = 0;
        loop {
            let page = self.state.history(source_run, after, 256).await?;
            if page.is_empty() {
                break;
            }
            after = page.last().expect("nonempty history").revision;
            history.extend(page);
        }
        let first_step = history
            .iter()
            .find_map(|item| match item.fact {
                Fact::StepPrepared { step, .. } => Some(step),
                _ => None,
            })
            .ok_or_else(|| RunError::InvalidInput("continuation source has no request".into()))?;
        let first = self.state.request(source_run, first_step).await?;
        let capture: RequestSource = self.decode(source_run, &first.source_capture).await?;
        let base = SessionBase {
            high_water: capture.cut.through_sequence,
            digest: capture.cut.digest.clone(),
        };
        let model = self.source.capture().await?;
        let target = ReplayTarget::new(&model, ModelOperation::Inference);
        let mut messages = preparation::PromptBuilder::new(
            self.preparation_io()?,
            self.resources.clone(),
            &self.cancellation,
        )
        .await?;
        if let Err(original) = self
            .inherited_messages(
                target,
                reader,
                source_run,
                original.spec.language,
                model.supports_vision,
                &mut system,
                &mut messages,
            )
            .await
        {
            return Err(match messages.close().await {
                Ok(()) => original,
                Err(close) => {
                    let error = preparation::preparation_cleanup_error(original, close);
                    self.cleanup.observe(&error);
                    error
                }
            });
        }
        let settings = PromptSettings {
            operation: ModelOperation::Inference,
            codex: model
                .context
                .as_ref()
                .and_then(|context| context.codex.as_ref()),
            language: original.spec.language,
            provider: &model.provider,
            options: &model.options,
            context_window: model
                .context
                .as_ref()
                .and_then(|context| context.model_context_window),
            tool_choice: ToolChoiceMode::Auto,
        };
        let definitions: Vec<_> = visible_defs.into_iter().map(Arc::new).collect();
        let mut rendered = system.map(|system| system.text).unwrap_or_default();
        if !rendered.is_empty() {
            rendered.push_str("\n\n");
        }
        rendered.push_str(&format!(
            "{}\n{}",
            match original.spec.language {
                maka_agent_facts::language::Language::En => "Session context (data):",
                maka_agent_facts::language::Language::ZhCn => "会话上下文（数据）：",
                maka_agent_facts::language::Language::ZhTw => "工作階段上下文（資料）：",
            },
            json!({"cwd":original.spec.workspace,"sessionId":original.spec.session_id})
        ));
        let mut prompt = preparation::prepare_prompt(
            messages,
            &settings,
            &self.cancellation,
            Some(Arc::new(rendered)),
            ModelPurpose::Main,
            None,
        )
        .await?;
        let result = async {
            preparation::prepare_wire(
                &settings,
                &mut prompt,
                &definitions,
                model.main_output_limit,
                &self.cancellation,
            )
            .await?;
            let request = preparation::prepare_request(
                &settings,
                prompt.clone(),
                definitions,
                model.main_output_limit,
                ModelPurpose::Main,
                None,
            )?;
            preparation::validate_replay_boundary(&prompt).await?;
            Ok(PreparedContinuation {
                source: RunBoundary {
                    execution: ExecutionIdentity {
                        session_id: original.spec.session_id.clone(),
                        turn_id: original.spec.turn_id.clone(),
                        run_id: source_run,
                    },
                    high_water: original.revision,
                    digest: maka_agent_engine::digest(&history)?,
                },
                base,
                replay: ReplayEvidence {
                    version: REPLAY_VERSION,
                    digest: request.input_digest,
                    route_identity: request.route_identity,
                },
            })
        }
        .await;
        prompt
            .close()
            .await
            .map_err(|error| self.cleanup.preparation_failed(error))?;
        result
    }

    async fn ancestry_root(&self, mut run: RunId, input: &RunInput) -> Result<RunId, RunError> {
        let mut prior = input
            .inherited_claim()
            .map(|claim| claim.source.execution.run_id);
        let mut seen = std::collections::BTreeSet::new();
        while let Some(source) = prior {
            if !seen.insert(source) {
                return Err(RunError::InvalidInput(
                    "cyclic continuation ancestry".into(),
                ));
            }
            run = source;
            let view = self.state.frontier(run).await?;
            let input: RunInput = self.decode(run, &view.spec.input).await?;
            prior = input
                .inherited_claim()
                .map(|claim| claim.source.execution.run_id);
        }
        Ok(run)
    }
    async fn canonical_messages(
        &self,
        target: ReplayTarget<'_>,
        cut: &maka_agent_state::session_history::HistoryCut,
        vision: bool,
        language: maka_agent_facts::language::Language,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<Option<String>, RunError> {
        let reader = HistorySource::live(&self.state, cut);
        self.project_history(target, &reader, vision, language, messages)
            .await
            .map(|(previous, _)| previous)
    }

    async fn project_history(
        &self,
        target: ReplayTarget<'_>,
        reader: &HistorySource<'_>,
        vision: bool,
        language: maka_agent_facts::language::Language,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<(Option<String>, Vec<FrozenCellKnowledge>), RunError> {
        enum Base {
            Request {
                sequence: u64,
                run: RunId,
                request: RequestSpec,
            },
            Compacted {
                id: FactId,
                run: RunId,
                baseline: ContentRef,
            },
            Snapshot {
                sequence: u64,
                run: RunId,
            },
        }
        struct Frame<'reader, 'source: 'reader> {
            reader: std::borrow::Cow<'reader, HistorySource<'source>>,
            covered: u64,
            order: std::collections::BTreeMap<u64, (RunId, u64)>,
        }
        let mut current = std::borrow::Cow::Borrowed(reader);
        let mut frames = Vec::new();
        let (mut covered, previous_checkpoint_id, mut order) = loop {
            let reader = current.as_ref();
            if let Some(snapshot) = reader.as_snapshot() {
                let manifest = snapshot.manifest().await?;
                manifest
                    .validate()
                    .map_err(|error| RunError::InvalidInput(error.into()))?;
                if matches!(
                    manifest.origin,
                    maka_agent_facts::history_snapshot::Origin::Imported { .. }
                ) {
                    self.imported_messages(
                        target,
                        snapshot,
                        reader.source_path(),
                        vision,
                        language,
                        messages,
                    )
                    .await?;
                    break (None, None, std::collections::BTreeMap::new());
                }
            }
            let mut base = None;
            let mut order = std::collections::BTreeMap::<u64, (RunId, u64)>::new();
            let mut after = 0;
            loop {
                let (items, next) = reader.page(after, 256).await?;
                for item in items {
                    match &item.recorded.fact {
                        Fact::RunAdmitted { .. } => {
                            let source = reader.run_source(item.recorded.run).await?;
                            if !matches!(source.spec.origin, RunOrigin::Local) {
                                if !matches!(source.spec.backend, BackendSpec::Historical {}) {
                                    return Err(unsupported("historical-installation-backend"));
                                }
                                base = Some(Base::Snapshot {
                                    sequence: item.sequence,
                                    run: item.recorded.run,
                                });
                            }
                        }
                        Fact::StepPrepared { step, .. } => {
                            let request = reader.request(item.recorded.run, *step).await?;
                            if !request.adjudications.is_empty() {
                                base = Some(Base::Request {
                                    sequence: item.sequence,
                                    run: item.recorded.run,
                                    request,
                                });
                            }
                        }
                        Fact::ContextCompacted { baseline } => {
                            base = Some(Base::Compacted {
                                id: item.recorded.id,
                                run: item.recorded.run,
                                baseline: baseline.clone(),
                            })
                        }
                        _ => {}
                    }
                    order
                        .entry(item.admission_sequence)
                        .and_modify(|entry| entry.1 = item.recorded.revision)
                        .or_insert((item.recorded.run, item.recorded.revision));
                }
                let Some(next) = next else {
                    break;
                };
                after = next;
            }
            let (covered, previous_checkpoint_id) = match base {
                None => (None, None),
                Some(Base::Request {
                    sequence,
                    run,
                    request,
                }) => {
                    self.request_base(target, reader, run, &request, messages)
                        .await?;
                    (
                        Some(sequence),
                        self.request_checkpoint(reader, run, &request).await?,
                    )
                }
                Some(Base::Compacted { id, run, baseline }) => {
                    let capture = self
                        .append_compacted(reader, run, &baseline, target, messages)
                        .await?;
                    (Some(capture.current.through_sequence), Some(id.to_string()))
                }
                Some(Base::Snapshot { sequence, run }) => {
                    let nested = reader.nested(run).await?;
                    frames.push(Frame {
                        reader: current,
                        covered: sequence,
                        order,
                    });
                    current = std::borrow::Cow::Owned(nested);
                    continue;
                }
            };
            break (covered, previous_checkpoint_id, order);
        };
        loop {
            let reader = current.as_ref();
            let covered_revisions = match covered {
                Some(through) => self.covered_revisions(reader, through).await?,
                None => Default::default(),
            };
            let mut recovered_cells = Vec::new();
            for (admission, (run, through)) in order {
                let source = reader.run_source(run).await?;
                if matches!(source.spec.backend, BackendSpec::Historical {}) {
                    continue;
                }
                let after = covered_revisions.get(&run).copied().unwrap_or(0);
                if after >= through {
                    continue;
                }
                let view = reader.view(run).await?;
                if !covered.is_some_and(|through| admission <= through) {
                    let input: RunInput = reader.decode(run, &view.spec.input).await?;
                    self.project_message_input(reader, &view, &input, vision, false, messages)
                        .await?;
                }
                let knowledge = self
                    .semantic_tail(target, reader, &view, vision, &mut None, messages, after)
                    .await?;
                if run == self.execution.run_id {
                    recovered_cells = knowledge;
                }
            }
            let Some(frame) = frames.pop() else {
                return Ok((previous_checkpoint_id, recovered_cells));
            };
            current = frame.reader;
            covered = Some(frame.covered);
            order = frame.order;
        }
    }

    async fn covered_revisions(
        &self,
        reader: &HistorySource<'_>,
        through: u64,
    ) -> Result<std::collections::BTreeMap<RunId, u64>, RunError> {
        let mut revisions = std::collections::BTreeMap::new();
        let mut after = 0;
        loop {
            let (items, next) = reader.page(after, 256).await?;
            for item in items {
                if item.sequence > through {
                    return Ok(revisions);
                }
                revisions.insert(item.recorded.run, item.recorded.revision);
            }
            let Some(next) = next else {
                return Ok(revisions);
            };
            after = next;
        }
    }

    async fn request_checkpoint(
        &self,
        reader: &HistorySource<'_>,
        run: RunId,
        request: &RequestSpec,
    ) -> Result<Option<String>, RunError> {
        let evidence: maka_agent_facts::context::RequestContextEvidence =
            reader.decode(run, &request.provenance).await?;
        Ok(evidence.previous_checkpoint_id)
    }

    async fn inherited_messages(
        &self,
        target: ReplayTarget<'_>,
        reader: &HistorySource<'_>,
        mut source_run: RunId,
        language: maka_agent_facts::language::Language,
        vision: bool,
        system: &mut Option<SystemPrompt>,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<Option<String>, RunError> {
        let mut ancestry = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        loop {
            if !seen.insert(source_run) {
                return Err(RunError::InvalidInput(
                    "continuation ancestry is cyclic".into(),
                ));
            }
            let prior = reader.view(source_run).await?;
            if prior.spec.session_id != self.execution.session_id {
                return Err(RunError::InvalidInput(
                    "continuation ancestry crosses Sessions".into(),
                ));
            }
            let input: RunInput = reader.decode(source_run, &prior.spec.input).await?;
            let predecessor = input
                .inherited_claim()
                .map(|claim| claim.source.execution.run_id);
            ancestry.push((prior, input));
            let Some(predecessor) = predecessor else {
                break;
            };
            source_run = predecessor;
        }
        enum Base {
            Request { after: u64, request: RequestSpec },
            Compacted { id: FactId, baseline: ContentRef },
        }
        let mut selected = None;
        for (index, (prior, _)) in ancestry.iter().enumerate() {
            let mut after = 0;
            let mut base = None;
            while after < prior.revision {
                let page = reader.history(prior.run, after, 256).await?;
                if page.is_empty() {
                    break;
                }
                for fact in page {
                    if fact.revision > prior.revision {
                        break;
                    }
                    after = fact.revision;
                    match fact.fact {
                        Fact::StepPrepared { step, .. } => {
                            let request = reader.request(prior.run, step).await?;
                            if !request.adjudications.is_empty() {
                                base = Some(Base::Request { after, request });
                            }
                        }
                        Fact::ContextCompacted { baseline } => {
                            base = Some(Base::Compacted {
                                id: fact.id,
                                baseline,
                            })
                        }
                        _ => {}
                    }
                }
            }
            if let Some(base) = base {
                selected = Some((index, base));
                break;
            }
        }
        if let Some((index, base)) = selected {
            let run = ancestry[index].0.run;
            let (previous, covered, request_after) = match base {
                Base::Request { after, request } => {
                    let (_, baseline) = self
                        .request_base(target, reader, run, &request, messages)
                        .await?;
                    *system = baseline;
                    (
                        self.request_checkpoint(reader, run, &request).await?,
                        None,
                        Some(after),
                    )
                }
                Base::Compacted { id, baseline } => {
                    let capture = self
                        .append_compacted(reader, run, &baseline, target, messages)
                        .await?;
                    (
                        Some(id.to_string()),
                        Some(capture.current.through_sequence),
                        None,
                    )
                }
            };
            let covered_revisions = match covered {
                Some(through) => self.covered_revisions(reader, through).await?,
                None => Default::default(),
            };
            for (position, (prior, input)) in ancestry.into_iter().enumerate().take(index + 1).rev()
            {
                merge_input_skills(system, &input)?;
                let after = if position == index {
                    request_after
                        .unwrap_or_else(|| covered_revisions.get(&prior.run).copied().unwrap_or(0))
                } else {
                    covered_revisions.get(&prior.run).copied().unwrap_or(0)
                };
                let admission = reader.run_source(prior.run).await?.admission_sequence;
                if !(position == index && request_after.is_some())
                    && !covered.is_some_and(|through| admission <= through)
                {
                    self.project_message_input(reader, &prior, &input, vision, false, messages)
                        .await?;
                }
                let _ = self
                    .semantic_tail(target, reader, &prior, vision, system, messages, after)
                    .await?;
            }
            Ok(previous)
        } else {
            let root = &ancestry.last().expect("source ancestry").0;
            let history = self
                .state
                .session_history(root.spec.owner.clone(), root.spec.session_id.clone());
            let cut = history.capture_before(root.run).await?;
            let previous = self
                .canonical_messages(target, &cut, vision, language, messages)
                .await?;
            for (prior, input) in ancestry.into_iter().rev() {
                merge_input_skills(system, &input)?;
                self.project_message_input(reader, &prior, &input, vision, false, messages)
                    .await?;
                let _ = self
                    .semantic_tail(target, reader, &prior, vision, system, messages, 0)
                    .await?;
            }
            Ok(previous)
        }
    }

    fn semantic_tail<'a>(
        &'a self,
        target: ReplayTarget<'a>,
        reader: &'a HistorySource<'_>,
        view: &'a RunView,
        vision: bool,
        system: &'a mut Option<SystemPrompt>,
        messages: &'a mut preparation::PromptBuilder,
        after_revision: u64,
    ) -> BoxFuture<'a, Result<Vec<FrozenCellKnowledge>, RunError>> {
        Box::pin(async move {
            let recorded = self.recorded_inputs(reader, view, after_revision).await?;
            let mut replay = replay::TailReplay::new(
                self, target, reader, view, vision, system, messages, recorded,
            );
            let mut after = after_revision;
            loop {
                let page = reader.history(view.run, after, 256).await?;
                if page.is_empty() {
                    break;
                }
                for fact in &page {
                    if fact.revision > view.revision {
                        return replay.finish().await;
                    }
                    after = fact.revision;
                    if let Some(work) = replay.apply(fact)? {
                        work.await?;
                    }
                }
            }
            replay.finish().await
        })
    }

    async fn project_accepted(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        through: u64,
        original_cells: &BTreeMap<maka_agent_facts::cells::CellId, FrozenCellKnowledge>,
        evidence: maka_agent_facts::tool_output::AcceptedToolResult,
        vision: bool,
        language: maka_agent_facts::language::Language,
    ) -> Result<maka_model::prompt::ToolOutput, RunError> {
        use maka_agent_facts::tool_output::AcceptedToolResult;
        use maka_model::prompt::ToolOutput;
        use maka_plugin_core::operation::{OperationOutcome, OperationResult, Receipt};
        Ok(match evidence {
            AcceptedToolResult::Local { result }
            | AcceptedToolResult::Operation {
                result: Some(result),
                ..
            } => {
                self.returned_projection(reader, view, through, &result, vision, language)
                    .await?
            }
            AcceptedToolResult::Operation {
                reply,
                result: None,
            } => match reply.receipt {
                Receipt::Recorded {
                    outcome:
                        OperationOutcome::Returned {
                            result: OperationResult::Success { value },
                        },
                    ..
                } => ToolOutput::Json(value),
                Receipt::Recorded {
                    outcome:
                        OperationOutcome::Returned {
                            result: OperationResult::Failure { diagnostic },
                        },
                    ..
                } => ToolOutput::ErrorText(diagnostic),
                Receipt::Recorded {
                    outcome: OperationOutcome::NotExecuted { proof },
                    ..
                } => ToolOutput::ErrorJson(json!({"notExecuted": proof})),
                _ => {
                    return Err(RunError::ReconciliationRequired(
                        "unresolved original operation cannot enter model context".into(),
                    ));
                }
            },
            AcceptedToolResult::RecoveredCell { cell, evidence } => {
                let (message, _dependencies) = preparation::project_cell_final(
                    reader.notification_source(),
                    &maka_agent_state::artifacts::ArtifactScope {
                        owner: view.spec.owner.clone(),
                        session: view.spec.session_id.clone(),
                        run: view.run,
                        through,
                    },
                    cell,
                    &evidence,
                    language,
                    vision,
                    &self.resources,
                    &self.cancellation,
                )
                .await?;
                let Message::User { content, .. } = message else {
                    return Err(RunError::Internal(
                        "Cell final projection lost its data role".into(),
                    ));
                };
                let knowledge = original_cells.get(&cell).ok_or_else(|| {
                    RunError::ReconciliationRequired(
                        "Cell knowledge is absent from the selected canonical head".into(),
                    )
                })?;
                let (message, _) = preparation::project_cell_knowledge(
                    reader.notification_source(),
                    &maka_agent_state::artifacts::ArtifactScope {
                        owner: view.spec.owner.clone(),
                        session: view.spec.session_id.clone(),
                        run: view.run,
                        through: knowledge.through,
                    },
                    cell,
                    knowledge.through,
                    &knowledge.children,
                    language,
                    vision,
                    &self.resources,
                    &self.cancellation,
                )
                .await?;
                let Message::User {
                    content: additional,
                    ..
                } = message
                else {
                    return Err(RunError::Internal(
                        "Cell knowledge lost its data role".into(),
                    ));
                };
                let mut content = content;
                content.extend(additional);
                ToolOutput::Content(content)
            }
            AcceptedToolResult::Provider {
                output, is_error, ..
            } => {
                if is_error {
                    ToolOutput::ErrorJson(output)
                } else {
                    ToolOutput::Json(output)
                }
            }
            AcceptedToolResult::Rejected { diagnostic } => ToolOutput::ErrorText(diagnostic),
            AcceptedToolResult::RiskAdjudicated { blocker, decision } => match decision {
                RiskDecision::RecordExternalObservation { evidence } => {
                    let evidence: Value = reader.decode(view.run, &evidence).await?;
                    ToolOutput::Json(
                        json!({"humanRiskAdjudication": blocker, "decision": "record_external_observation", "evidence": evidence, "operationSuccessNotInferred": true}),
                    )
                }
                RiskDecision::AuthorizeReplan { evidence } => {
                    let evidence: Value = reader.decode(view.run, &evidence).await?;
                    ToolOutput::Json(
                        json!({"humanRiskAdjudication": blocker, "decision": "authorize_replan", "evidence": evidence, "operationSuccessNotInferred": true}),
                    )
                }
                RiskDecision::CancelBlockedRun { diagnostic } => ToolOutput::ErrorText(diagnostic),
            },
        })
    }

    async fn returned_projection(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        through: u64,
        result: &ContentRef,
        vision: bool,
        language: maka_agent_facts::language::Language,
    ) -> Result<maka_model::prompt::ToolOutput, RunError> {
        let returned: maka_agent_facts::artifact::ToolReturn<
            maka_agent_facts::tool_output::ReturnedToolResult,
        > = reader.decode(view.run, result).await?;
        returned
            .validate()
            .map_err(|_| unsupported("tool-return-envelope-version"))?;
        preparation::project_returned_tool_from(
            reader.media_source(
                maka_agent_state::artifacts::ArtifactScope {
                    owner: view.spec.owner.clone(),
                    session: view.spec.session_id.clone(),
                    run: view.run,
                    through,
                }
                .into(),
            ),
            &returned.body,
            language,
            vision,
            &self.resources,
            &self.cancellation,
        )
        .await
    }

    pub(super) fn validate_transport_selection(
        &self,
        view: &RunView,
        attempt: ModelAttemptId,
        phase: maka_agent_facts::model::retry_transport::RetryTransportPhase,
    ) -> Result<(), RunError> {
        use maka_agent_facts::model::retry_transport::{FallbackAvailability, RetryTransportPhase};
        if view.run != self.execution.run_id || view.spec.session_id != self.execution.session_id {
            return Err(RunError::InvalidInput(
                "transport selection belongs to another execution".into(),
            ));
        }
        if !view.attempts.contains_key(&attempt) {
            return Err(RunError::InvalidInput(
                "transport selection lost its original attempt".into(),
            ));
        }
        if phase == RetryTransportPhase::Primary && view.retry_phase != phase {
            return Err(unsupported("canonical-transport-cannot-reset-to-primary"));
        }
        let conversation = self.conversation.lock().unwrap().as_ref().cloned();
        if let Some(conversation) = conversation {
            if conversation.retry_transport_phase() != view.retry_phase {
                return Err(unsupported(
                    "canonical-transport-phase-differs-from-conversation",
                ));
            }
            if phase == RetryTransportPhase::Fallback
                && view.retry_phase != phase
                && conversation.fallback_availability() != FallbackAvailability::WarmIdlePrimary
            {
                return Err(unsupported("canonical-fallback-transport-unavailable"));
            }
        }
        Ok(())
    }

    pub(super) async fn start_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        request: RequestSpec,
        bytes: Vec<u8>,
        witness: maka_agent_engine::ModelWitness,
        access: Arc<super::access::RunAccess>,
    ) -> Result<ModelConnection, RunError> {
        if run != self.execution.run_id {
            return Err(RunError::InvalidInput(
                "model start belongs to another execution".into(),
            ));
        }
        let work = self.original_cleanup.work(attempt, &self.cancellation);
        let _activation = work.activate()?;
        if request.protocol != PROTOCOL || request.protocol_version != VERSION {
            return Err(unsupported(&request.protocol));
        }
        if request.request.bytes != bytes.len() as u64
            || request.request.digest != maka_agent_facts::artifact::content_digest(&bytes)
        {
            return Err(RunError::ReconciliationRequired(
                "frozen model input changed".into(),
            ));
        }
        super::driver::validate_tool_digest(&request)?;
        let frozen: FrozenInput = serde_json::from_slice(&bytes)
            .map_err(|_| unsupported("frozen-input-manifest-schema"))?;
        if frozen.accepted != self.source.accepted {
            return Err(RunError::ReconciliationRequired(
                "frozen model input differs from admitted composition".into(),
            ));
        }
        let recovery: FrozenRecovery = self
            .protocol_data(run, &request.recovery_contract, "recovery-contract-schema")
            .await?;
        if recovery.protocol != format!("{PROTOCOL}/recovery")
            || recovery.version != VERSION
            || recovery.request != request.request
            || recovery.adapter != frozen.adapter
        {
            return Err(unsupported("admitted-recovery-contract"));
        }
        let provenance: Value = self.decode(run, &request.provenance).await?;
        let expected_breakdown: maka_agent_facts::context::PreparedContextBreakdown =
            serde_json::from_value(
                provenance
                    .get("breakdown")
                    .ok_or_else(|| unsupported("frozen-budget-signature"))?
                    .clone(),
            )
            .map_err(RunError::Json)?;
        if request.request_contents != frozen.content_refs() {
            return Err(unsupported("frozen-input-content-dependencies"));
        }
        let view = self.state.frontier(run).await?;
        if view
            .attempts
            .get(&attempt)
            .is_none_or(|original| original.step != request.step)
        {
            return Err(RunError::InvalidInput(
                "model source lost its original admitted attempt".into(),
            ));
        }
        self.original_cleanup.own(attempt, witness.clone());
        if work.cancellation.is_cancelled() || view.finish_requested() {
            work.cancellation.cancel();
            let fact = self
                .original_cleanup
                .publish_confirmed(attempt, witnessed_at()?)
                .await
                .map_err(|error| {
                    RunError::ReconciliationRequired(format!(
                        "prevented model source cleanup metadata unresolved: {error}"
                    ))
                })?;
            return Ok(Box::pin(stream::iter([Ok(ModelObservation::Recorded {
                fact,
            })])));
        }
        let history = self
            .state
            .session_history(view.spec.owner.clone(), view.spec.session_id.clone());
        let cut = history.capture().await?;
        let io = self.preparation_io()?;
        let resources = self.resources.clone();
        let contract_ref = request.recovery_contract.clone();
        let prefix_request = request.request.clone();
        let prefix_adapter = frozen.adapter.clone();
        let source = self.source.clone();
        let executor = self.executor.clone();
        let conversation = self.conversation.clone();
        let retry_phase = view.retry_phase;
        let cancellation = work.cancellation.clone();
        let cleanup = self.cleanup.clone();
        let state = self.state.clone();
        let preview = self.preview.clone();
        let attempt_binding = maka_agent_facts::model::assembly::AttemptBinding {
            execution: self.execution.clone(),
            step_id: request.step,
            attempt_id: attempt,
            purpose: request.accounting.purpose,
        };
        let mut writer = maka_agent_facts::model::assembly::AttemptWriter::new(
            attempt_binding.clone(),
            frozen.item_acceptance,
        )?;
        // Bind in admission order, not when an arbitrarily delayed stream first emits.
        preview.send_replace(
            (request.accounting.purpose == ModelPurpose::Main).then(|| writer.snapshot()),
        );
        let (send, recv) = mpsc::channel(4);
        let original_cleanup = self.original_cleanup.clone();
        self.workers.spawn(work.worker.track_future(async move {
            let _preview_owner = PreviewOwner {
                sender: preview.clone(),
                scope: attempt_binding.clone(),
            };
            let mut stream_opened = false;
            let mut late_cleanup = None;
            let mut private_cut = None;
            let mut materialization: Option<maka_agent_engine::prepared_prompt::PreparedPrompt> =
                None;
            let result = async {
                if cancellation.is_cancelled() {
                    return Err(RunError::Cancelled);
                }
                let prepared = source.capture().await?;
                validate_model_input_policy(&provenance, &prepared)?;
                let binding = executor.binding(&prepared.provider)?;
                if !same_adapter_revision(binding.source(), &frozen.adapter) {
                    return Err(unsupported("adapter-revision"));
                }
                if preparation::route_identity(&prepared.provider)? != frozen.route_identity
                    || recovery.contract
                        != original_recovery_contract(
                            &binding,
                            &prepared.provider,
                            &request.composition.tools,
                            frozen.operation,
                        )
                {
                    return Err(unsupported("admitted-recovery-contract-changed"));
                }
                let observation = ObservationProtocol {
                    run,
                    attempt,
                    contract_ref,
                    binding: binding.clone(),
                    contract: recovery.contract.clone(),
                    witness: witness.clone(),
                    history: history.clone(),
                    state: state.clone(),
                    preview: preview.clone(),
                    scope: attempt_binding,
                };
                let item_acceptance = request.accounting.purpose == ModelPurpose::Main
                    && binding.supports_item_acceptance();
                if item_acceptance != frozen.item_acceptance {
                    return Err(unsupported("item-acceptance-contract"));
                }
                let transport_adapter = binding.source().clone();
                let transport_route = frozen.route_identity.clone();
                let factory = Arc::new(FrozenMaterializer {
                    io,
                    resources,
                    history,
                    cut,
                    run,
                    frozen,
                    request: request.clone(),
                    access: access.clone(),
                    model_source: source.clone(),
                    executor: executor.clone(),
                    provenance,
                    recovery,
                    authorization_failure: std::sync::Mutex::new(None),
                    provider: prepared.provider,
                    budget: expected_breakdown,
                });
                let (prompt, input) = factory.build(&cancellation).await?;
                let source = maka_agent_ports::model::RequestSource {
                    cleanup: prompt.cleanup(),
                    frozen: factory,
                };
                materialization = Some(prompt);
                if cancellation.is_cancelled() {
                    return Err(RunError::Cancelled);
                }
                let conversation = if request.accounting.purpose == ModelPurpose::Main {
                    let mut owned = conversation.lock().unwrap();
                    let conversation = owned.get_or_insert_with(|| {
                        maka_model::Conversation::with_retry_transport_phase(retry_phase)
                    });
                    if retry_phase
                        == maka_agent_facts::model::retry_transport::RetryTransportPhase::Fallback
                        && conversation.retry_transport_phase() != retry_phase
                        && !conversation.try_switch_fallback_transport()
                    {
                        return Err(unsupported("canonical-fallback-transport-unavailable"));
                    }
                    if conversation.retry_transport_phase() != retry_phase {
                        return Err(unsupported(
                            "canonical-transport-phase-differs-from-conversation",
                        ));
                    }
                    Some(conversation.clone())
                } else {
                    None
                };
                let mut stream = match executor
                    .stream_with_source(
                        input,
                        cancellation.clone(),
                        conversation.clone(),
                        binding,
                        Some(source),
                    )
                    .await
                {
                    Ok(stream) => stream,
                    Err(maka_model::StreamOpeningError::Preparation(error)) => {
                        return Err(RunError::Model(error));
                    }
                    Err(maka_model::StreamOpeningError::Cleanup(error)) => {
                        original_cleanup.retain_failure(error);
                        return Err(original_cleanup.physical.unconfirmed());
                    }
                };
                stream_opened = true;
                let received = AssertUnwindSafe(receive(
                    &mut stream,
                    &mut writer,
                    item_acceptance,
                    &observation,
                    &send,
                    &cancellation,
                ))
                .catch_unwind()
                .await;
                if !matches!(&received, Ok(Ok(()))) {
                    let cut = writer.snapshot();
                    if cut.binding.purpose == ModelPurpose::Main && cut.revision > 0 {
                        private_cut = Some(cut);
                    }
                }
                let failure = match &received {
                    Ok(Err(RunError::Model(failure)))
                        if !matches!(
                            failure,
                            maka_model::ModelError::Cancelled
                                | maka_model::ModelError::CleanupUnconfirmed
                                | maka_model::ModelError::LocalAuthorization(_)
                        ) =>
                    {
                        Some(failure.clone())
                    }
                    _ => None,
                };
                let terminal = match &received {
                    Ok(Err(error)) => {
                        terminal_outcome(error).map(|outcome| (outcome, error.to_string()))
                    }
                    _ => None,
                };
                let observer = stream.cleanup_observer();
                let settled = stream.cancel_and_wait().await;
                let source_settled = settled.is_ok();
                let terminal_publication = async {
                    let partial = || {
                        if source_settled {
                            private_cut.as_deref().map(private_partial_blob).transpose()
                        } else {
                            Ok(None)
                        }
                    };
                    if let Some(failure) = failure {
                        let transport =
                            if source_settled {
                                conversation.as_ref().map(|conversation|
                            maka_agent_facts::model::retry_transport::ModelTransportEvidence{
                                adapter:transport_adapter,route_identity:transport_route,
                                fallback:conversation.fallback_availability(),
                            })
                            } else {
                                None
                            };
                        let protocol =
                            maka_agent_facts::context::ModelFailureProtocol { failure, transport };
                        if let Some((outcome, diagnostic)) = terminal {
                            let fact = witness
                                .closed_with_private(
                                    outcome,
                                    Some(diagnostic),
                                    Default::default(),
                                    serde_json::to_value(protocol).map_err(RunError::Json)?,
                                    partial()?,
                                    witnessed_at()?,
                                )
                                .await?;
                            emit(
                                &send,
                                &cancellation,
                                Ok(ModelObservation::Recorded { fact }),
                            )
                            .await;
                        } else {
                            let fact = witness
                                .source_failure(ContentBlob::json(&protocol)?, witnessed_at()?)
                                .await?;
                            emit(
                                &send,
                                &cancellation,
                                Ok(ModelObservation::Recorded { fact }),
                            )
                            .await;
                            if let Some(partial) = partial()? {
                                let fact =
                                    witness.private_partial(partial, witnessed_at()?).await?;
                                emit(
                                    &send,
                                    &cancellation,
                                    Ok(ModelObservation::Recorded { fact }),
                                )
                                .await;
                            }
                        }
                    } else if let Some(partial) = partial()? {
                        let fact = witness.private_partial(partial, witnessed_at()?).await?;
                        emit(
                            &send,
                            &cancellation,
                            Ok(ModelObservation::Recorded { fact }),
                        )
                        .await;
                    }
                    if source_settled {
                        private_cut = None;
                    }
                    Ok::<(), RunError>(())
                }
                .await;
                if let Err(error) = settled {
                    match error.observer() {
                        Some(_) => {
                            late_cleanup = Some(observer);
                            return Err(RunError::CleanupUnconfirmed);
                        }
                        None => {
                            original_cleanup.retain_failure(error);
                            return Err(original_cleanup.physical.unconfirmed());
                        }
                    }
                }
                terminal_publication?;
                #[cfg(test)]
                if let Some(path) = std::env::var_os("MAKA_TEST_MODEL_CLEANUP_BARRIER") {
                    tokio::fs::write(path, attempt.to_string())
                        .await
                        .map_err(|_| {
                            RunError::Internal("model cleanup test barrier failed".into())
                        })?;
                    std::future::pending::<()>().await;
                }
                match received {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err(RunError::ReconciliationRequired(
                        "original model stream observer panicked".into(),
                    )),
                }
            }
            .await;
            let mut result = result;
            let mut cleanup_state = if result.as_ref().is_err_and(RunError::is_cleanup_unconfirmed)
            {
                maka_plugin_core::operation::OperationCleanup::Unconfirmed
            } else if let Some(prompt) = materialization.as_ref() {
                match prompt.close().await {
                    Ok(()) => maka_plugin_core::operation::OperationCleanup::Confirmed,
                    Err(error) => {
                        let diagnostic = error.to_string();
                        result = Err(cleanup.preparation_failed(error));
                        maka_plugin_core::operation::OperationCleanup::Failed { diagnostic }
                    }
                }
            } else {
                maka_plugin_core::operation::OperationCleanup::Confirmed
            };
            if late_cleanup.is_none()
                && cleanup_state != maka_plugin_core::operation::OperationCleanup::Confirmed
            {
                original_cleanup
                    .physical
                    .observe(&RunError::CleanupUnconfirmed);
                if let Some(prompt) = materialization.take() {
                    original_cleanup.retain(prompt);
                }
            }
            if late_cleanup.is_none() && private_cut.is_some() {
                original_cleanup.retain_partial(
                    private_cut
                        .take()
                        .expect("original unacknowledged private cut"),
                );
                cleanup_state = maka_plugin_core::operation::OperationCleanup::Failed {
                    diagnostic: result
                        .as_ref()
                        .err()
                        .expect("private partial publication failed")
                        .to_string(),
                };
            }
            let cleanup_confirmed =
                cleanup_state == maka_plugin_core::operation::OperationCleanup::Confirmed;
            let cleanup_publication = async {
                let fact = if cleanup_confirmed {
                    original_cleanup
                        .publish_confirmed(attempt, witnessed_at()?)
                        .await
                        .map_err(|error| {
                            RunError::ReconciliationRequired(format!(
                                "original model cleanup metadata unresolved: {error}"
                            ))
                        })?
                } else {
                    witness.cleanup(cleanup_state, witnessed_at()?).await?
                };
                Ok::<_, RunError>(fact)
            }
            .await;
            match cleanup_publication {
                Ok(fact) => {
                    emit(
                        &send,
                        &cancellation,
                        Ok(ModelObservation::Recorded { fact }),
                    )
                    .await
                }
                Err(error) => {
                    cleanup.observe(&error);
                    emit(&send, &cancellation, Err(error)).await;
                }
            }
            if let Some(observer) = late_cleanup {
                original_cleanup.follow(
                    attempt,
                    observer,
                    materialization.take(),
                    private_cut.take(),
                );
            } else if let Some(cut) = private_cut {
                original_cleanup.retain_partial(cut);
            }
            if let Err(error) = result {
                cleanup.observe(&error);
                // Preparation failure and lost local observation are not upstream closure.
                if !stream_opened || !matches!(&error, RunError::Model(_)) {
                    emit(&send, &cancellation, Err(error)).await;
                    return;
                }
                let published = async {
                    let view = state.frontier(run).await?;
                    let parts = canonical_parts_for(&state, &view, attempt).await?;
                    let evidence = recovery_for_failure(
                        &error,
                        run,
                        attempt,
                        prefix_request,
                        prefix_adapter,
                        &parts,
                    )?;
                    if let Some(fact) = witness.recovery(evidence, witnessed_at()?).await? {
                        emit(
                            &send,
                            &cancellation,
                            Ok(ModelObservation::Recorded { fact }),
                        )
                        .await;
                    }
                    Ok::<(), RunError>(())
                }
                .await;
                if let Err(error) = published {
                    emit(&send, &cancellation, Err(error)).await;
                } else if terminal_outcome(&error).is_none() {
                    emit(&send, &cancellation, Err(error)).await;
                }
            }
        }));
        Ok(Box::pin(stream::unfold(recv, |mut recv| async {
            recv.recv().await.map(|value| (value, recv))
        })))
    }

    async fn canonical_parts(
        &self,
        view: &RunView,
        attempt: ModelAttemptId,
    ) -> Result<Vec<maka_agent_facts::model::ModelPart>, RunError> {
        canonical_parts_for(&self.state, view, attempt).await
    }

    async fn validate_prefix(
        &self,
        view: &RunView,
        attempt: ModelAttemptId,
        reference: &ContentRef,
    ) -> Result<(), RunError> {
        let reader = &self.history_reader(view.run).await?;
        let proof: PrefixProof = self
            .protocol_data(view.run, reference, "prefix-proof-schema")
            .await?;
        let original = view
            .attempts
            .get(&attempt)
            .ok_or_else(|| RunError::InvalidInput("prefix attempt is missing".into()))?;
        let request = self.state.request(view.run, original.step).await?;
        let parts = self.canonical_parts(view, attempt).await?;
        let frozen = self.frozen_input(reader, view.run, &request).await?;
        if frozen.adapter != proof.adapter || frozen.accepted != self.source.accepted {
            return Err(RunError::ReconciliationRequired(
                "prefix adapter contract changed".into(),
            ));
        }
        if proof.run != view.run
            || proof.attempt != attempt
            || proof.request != request.request
            || proof.items != parts.len() as u64
            || proof.items != original.observed
            || proof.digest != maka_agent_engine::digest(&parts)?
        {
            return Err(RunError::ReconciliationRequired(
                "model prefix protocol evidence differs from canonical output".into(),
            ));
        }
        match &proof.basis {
            PrefixBasis::ProviderFailure { failure }
                if frozen.item_acceptance
                    && failure.retained_output_safe()
                    && failure.retryable() =>
            {
                failure.validate()?
            }
            PrefixBasis::ClosedItems { contract } if contract == &request.recovery_contract => {
                self.validate_cold_contract(view, attempt, &request, &frozen)
                    .await?;
            }
            _ => return Err(unsupported("prefix-proof-version")),
        }
        ensure_no_unknown_provider_effect(attempt, &parts)?;
        Ok(())
    }

    async fn validate_cold_contract(
        &self,
        view: &RunView,
        attempt: ModelAttemptId,
        request: &RequestSpec,
        frozen: &FrozenInput,
    ) -> Result<Vec<maka_agent_facts::model::ModelPart>, RunError> {
        let recovery: FrozenRecovery = self
            .protocol_data(
                view.run,
                &request.recovery_contract,
                "recovery-contract-schema",
            )
            .await?;
        if recovery.protocol != format!("{PROTOCOL}/recovery")
            || recovery.version != VERSION
            || recovery.request != request.request
            || recovery.adapter != frozen.adapter
            || frozen.accepted != self.source.accepted
        {
            return Err(unsupported("recovery-contract-version"));
        }
        let model = self.source.capture().await?;
        let binding = self.executor.binding(&model.provider)?;
        let Some(contract) = recovery.contract.as_ref() else {
            return Err(unsupported("provider-effects-or-unproved-adapter"));
        };
        if !same_adapter_revision(binding.source(), &frozen.adapter)
            || preparation::route_identity(&model.provider)? != frozen.route_identity
            || original_recovery_contract(
                &binding,
                &model.provider,
                &request.composition.tools,
                frozen.operation,
            )
            .as_ref()
                != Some(contract)
        {
            return Err(unsupported("recovery-adapter-revision"));
        }
        let mut parts = Vec::new();
        let mut after = 0;
        'history: loop {
            let page = self.state.history(view.run, after, 256).await?;
            if page.is_empty() {
                break;
            }
            for item in page {
                if item.revision > view.revision {
                    break 'history;
                }
                after = item.revision;
                if let Fact::ModelObserved {
                    attempt: original,
                    index,
                    part,
                    continuation,
                } = item.fact
                {
                    if original != attempt {
                        continue;
                    }
                    let reference = continuation
                        .ok_or_else(|| unsupported("closed-item-without-continuation-proof"))?;
                    let proof: ItemContinuation = self
                        .protocol_data(view.run, &reference, "continuation-proof-schema")
                        .await?;
                    let cursor = binding
                        .continuation_cursor(contract, &part)
                        .ok_or_else(|| unsupported("unreplayable-signature-item"))?;
                    if index != parts.len() as u64
                        || proof.protocol != format!("{PROTOCOL}/continuation")
                        || proof.version != VERSION
                        || proof.run != view.run
                        || proof.attempt != attempt
                        || proof.contract != request.recovery_contract
                        || proof.index != index
                        || proof.part_digest != maka_agent_engine::digest(&part)?
                        || proof.cursor != cursor
                    {
                        return Err(unsupported("closed-item-proof-mismatch"));
                    }
                    parts.push(part);
                }
            }
        }
        if parts.len() as u64 != view.attempts[&attempt].observed {
            return Err(unsupported("incomplete-canonical-prefix"));
        }
        ensure_no_unknown_provider_effect(attempt, &parts)?;
        Ok(parts)
    }

    pub(super) async fn assess_recovery(
        &self,
        view: &RunView,
        attempt: ModelAttemptId,
        request: RequestSpec,
    ) -> Result<RecoveryEvidence, RunError> {
        let reader = &self.history_reader(view.run).await?;
        if request.protocol != PROTOCOL || request.protocol_version != VERSION {
            return Err(unsupported("request-protocol-version"));
        }
        let original = view
            .attempts
            .get(&attempt)
            .ok_or_else(|| RunError::InvalidInput("model attempt is missing".into()))?;
        if let Some(AttemptRecovery::ProjectPrefixSafe { prefix, .. }) = &original.recovery {
            self.validate_prefix(view, attempt, prefix).await?;
            return Ok(RecoveryEvidence {
                recovery: original.recovery.clone().expect("checked recovery"),
                contents: vec![],
            });
        }
        // Only a failure actually recorded by this adapter can prove replay safety.
        let failure = if let Some(reference) = &original.source_failure {
            let protocol: maka_agent_facts::context::ModelFailureProtocol =
                reader.decode(view.run, reference).await?;
            Some(protocol.failure)
        } else if let Some(closed) = original
            .closed
            .as_ref()
            .filter(|closed| closed.outcome == maka_agent_facts::accounting::Outcome::Error)
        {
            let protocol: maka_agent_facts::context::ModelFailureProtocol =
                serde_json::from_value(closed.protocol.clone()).map_err(RunError::Json)?;
            Some(protocol.failure)
        } else {
            None
        };
        let Some(failure) = failure else {
            let frozen = self.frozen_input(reader, view.run, &request).await?;
            let parts = self
                .validate_cold_contract(view, attempt, &request, &frozen)
                .await?;
            if parts.is_empty() {
                return Ok(RecoveryEvidence {
                    recovery: AttemptRecovery::Blocked {
                        diagnostic:
                            "the original source has no failure or accepted-item replay proof"
                                .into(),
                    },
                    contents: vec![],
                });
            }
            let proof = ContentBlob::json(&PrefixProof {
                run: view.run,
                attempt,
                request: request.request.clone(),
                adapter: frozen.adapter,
                items: parts.len() as u64,
                digest: maka_agent_engine::digest(&parts)?,
                basis: PrefixBasis::ClosedItems {
                    contract: request.recovery_contract,
                },
            })?;
            return Ok(RecoveryEvidence {
                recovery: AttemptRecovery::ProjectPrefixSafe {
                    prefix: proof.reference().clone(),
                    not_before: None,
                },
                contents: vec![proof],
            });
        };
        let frozen = self.frozen_input(reader, view.run, &request).await?;
        let parts = self.canonical_parts(view, attempt).await?;
        if !parts.is_empty() && !frozen.item_acceptance {
            return Err(unsupported("retained-item-contract"));
        }
        recovery_for_failure(
            &RunError::Model(failure),
            view.run,
            attempt,
            request.request,
            frozen.adapter,
            &parts,
        )
    }

    pub(super) async fn observe_model(
        &self,
        _run: RunId,
        _attempt: ModelAttemptId,
        _descriptor: ContentRef,
        _after_index: u64,
        _witness: maka_agent_engine::ModelWitness,
    ) -> Result<ModelConnection, RunError> {
        Err(unsupported("original-response-observation"))
    }
    pub(super) async fn finish(&self) -> Result<(), RunError> {
        self.workers.close();
        self.workers.wait().await;
        if self.cleanup.confirmed() {
            Ok(())
        } else {
            Err(RunError::CleanupUnconfirmed)
        }
    }
}

async fn canonical_parts_for(
    state: &Store,
    view: &RunView,
    attempt: ModelAttemptId,
) -> Result<Vec<maka_agent_facts::model::ModelPart>, RunError> {
    let mut parts = Vec::new();
    let mut after = 0;
    loop {
        let page = state.history(view.run, after, 256).await?;
        if page.is_empty() {
            break;
        }
        for item in page {
            if item.revision > view.revision {
                return Ok(parts);
            }
            after = item.revision;
            if let Fact::ModelObserved {
                attempt: original,
                index,
                part,
                ..
            } = item.fact
                && original == attempt
            {
                if index != parts.len() as u64 {
                    return Err(RunError::ReconciliationRequired(
                        "canonical model prefix is not contiguous".into(),
                    ));
                }
                parts.push(part);
            }
        }
    }
    Ok(parts)
}

fn extend_observation(
    content: &mut Vec<maka_model::prompt::ContentPart>,
    output: maka_model::prompt::ToolOutput,
) -> Result<(), RunError> {
    use maka_model::prompt::{ContentPart, ToolOutput};
    match output {
        ToolOutput::Text(text) => content.push(ContentPart::text(text)),
        ToolOutput::ErrorText(text) => {
            content.push(ContentPart::text(format!("Tool error: {text}")))
        }
        ToolOutput::Json(value) => content.push(ContentPart::text(
            serde_json::to_string(&value).map_err(RunError::Json)?,
        )),
        ToolOutput::ErrorJson(value) => content.push(ContentPart::text(format!(
            "Tool error: {}",
            serde_json::to_string(&value).map_err(RunError::Json)?
        ))),
        ToolOutput::Content(parts) => content.extend(parts),
    }
    Ok(())
}

async fn flush_assistant(
    messages: &mut preparation::PromptBuilder,
    parts: &mut Vec<maka_model::prompt::AssistantPart>,
) -> Result<(), RunError> {
    if !parts.is_empty() {
        messages
            .append(Message::Assistant {
                content: std::mem::take(parts),
                provider_options: None,
            })
            .await?;
    }
    Ok(())
}

fn validate_model_input_policy(
    provenance: &Value,
    model: &maka_agent_engine::PreparedModel,
) -> Result<(), RunError> {
    let original = provenance
        .get("modelInputPolicy")
        .ok_or_else(|| unsupported("original-model-input-policy"))?;
    if original
        != &json!({"vision": model.supports_vision, "imageInput": model.provider.image_input})
    {
        return Err(super::driver::source_authority_changed(
            "original model input policy changed",
        ));
    }
    Ok(())
}

fn same_adapter_revision(current: &SourceRevision, original: &SourceRevision) -> bool {
    // Activation identifies live custody, not the adapter implementation revision.
    current.kind == original.kind
        && current.name == original.name
        && current.package_id == original.package_id
        && current.entry_id == original.entry_id
        && current.revision == original.revision
}

fn original_recovery_contract(
    binding: &maka_agent_ports::model::Binding,
    provider: &maka_model::ProviderConfig,
    tools: &[Arc<maka_agent_facts::tools::ToolDefinition>],
    operation: ModelOperation,
) -> Option<maka_agent_ports::model::RecoveryContract> {
    // Untyped request overlays could add remote tools outside the captured function catalog.
    if operation != ModelOperation::Inference
        || provider
            .body_overlay
            .as_ref()
            .is_some_and(|overlay| !overlay.is_empty())
    {
        return None;
    }
    binding.recovery_contract(&provider.kind, tools)
}

fn unsupported(feature: &str) -> RunError {
    RunError::Blocked(BlockerKind::UnsupportedProtocol {
        protocol: format!("{PROTOCOL}/{feature}"),
        version: VERSION,
    })
}

struct PreviewOwner {
    sender: tokio::sync::watch::Sender<Option<Arc<maka_agent_facts::model::assembly::AttemptCut>>>,
    scope: maka_agent_facts::model::assembly::AttemptBinding,
}
impl Drop for PreviewOwner {
    fn drop(&mut self) {
        self.sender.send_if_modified(|cut| {
            if cut.as_ref().is_some_and(|cut| cut.binding == self.scope) {
                *cut = None;
                true
            } else {
                false
            }
        });
    }
}
fn publish_preview(
    sender: &tokio::sync::watch::Sender<Option<Arc<maka_agent_facts::model::assembly::AttemptCut>>>,
    cut: Arc<maka_agent_facts::model::assembly::AttemptCut>,
) {
    sender.send_if_modified(|current| {
        if current
            .as_ref()
            .is_some_and(|current| current.binding == cut.binding)
        {
            *current = Some(cut);
            true
        } else {
            false
        }
    });
}

struct ObservationProtocol {
    run: RunId,
    attempt: ModelAttemptId,
    contract_ref: ContentRef,
    binding: maka_agent_ports::model::Binding,
    contract: Option<maka_agent_ports::model::RecoveryContract>,
    witness: maka_agent_engine::ModelWitness,
    history: maka_agent_state::session_history::SessionHistory,
    state: Store,
    preview: tokio::sync::watch::Sender<Option<Arc<maka_agent_facts::model::assembly::AttemptCut>>>,
    scope: maka_agent_facts::model::assembly::AttemptBinding,
}
impl ObservationProtocol {
    fn continuation(
        &self,
        index: u64,
        part: &maka_agent_facts::model::ModelPart,
    ) -> Result<Option<ContentBlob>, RunError> {
        self.contract
            .as_ref()
            .and_then(|contract| self.binding.continuation_cursor(contract, part))
            .map(|cursor| -> Result<ContentBlob, RunError> {
                Ok(ContentBlob::json(&ItemContinuation {
                    protocol: format!("{PROTOCOL}/continuation"),
                    version: VERSION,
                    run: self.run,
                    attempt: self.attempt,
                    contract: self.contract_ref.clone(),
                    index,
                    part_digest: maka_agent_engine::digest(part)?,
                    cursor,
                })?)
            })
            .transpose()
    }
    async fn part(
        &self,
        part: maka_agent_facts::model::ModelPart,
        index: u64,
        writer: &mut maka_agent_facts::model::assembly::AttemptWriter,
        send: &mpsc::Sender<Result<ModelObservation, RunError>>,
        cancellation: &CancellationToken,
    ) -> Result<(), RunError> {
        let continuation = self.continuation(index, &part)?;
        let fact = self
            .witness
            .part(index, part, continuation, witnessed_at()?)
            .await?;
        emit(send, cancellation, Ok(ModelObservation::Recorded { fact })).await;
        let cut = self.history.capture().await?;
        let sequence = self
            .history
            .fact_sequence(&cut, self.run, fact)
            .await?
            .ok_or_else(|| {
                RunError::ReconciliationRequired(
                    "committed model witness has no canonical sequence".into(),
                )
            })?;
        writer.recorded(maka_agent_facts::model::assembly::PartReceipt {
            part: maka_agent_facts::model::recorded::RecordedPartRef {
                event_id: fact.to_string(),
                ordinal: index,
            },
            sequence,
        });
        publish_preview(&self.preview, writer.snapshot());
        Ok(())
    }
    async fn recorded_batch(
        &self,
        first: u64,
        end: u64,
        writer: &mut maka_agent_facts::model::assembly::AttemptWriter,
    ) -> Result<(), RunError> {
        if first == end {
            return Ok(());
        }
        let cut = self.history.capture().await?;
        let mut next = first;
        while next < end {
            let parts = self
                .state
                .model_items(
                    self.run,
                    self.attempt,
                    next.checked_sub(1),
                    (end - next).min(256) as u32,
                )
                .await?;
            if parts.is_empty() {
                return Err(RunError::ReconciliationRequired(
                    "committed buffered parts are missing from the original model index".into(),
                ));
            }
            for part in parts {
                let Fact::ModelObserved { index, .. } = part.fact else {
                    unreachable!("model_items returns canonical parts")
                };
                let sequence = self
                    .history
                    .fact_sequence(&cut, self.run, part.id)
                    .await?
                    .ok_or_else(|| {
                        RunError::ReconciliationRequired(
                            "committed buffered part has no canonical sequence".into(),
                        )
                    })?;
                writer.recorded(maka_agent_facts::model::assembly::PartReceipt {
                    part: maka_agent_facts::model::recorded::RecordedPartRef {
                        event_id: part.id.to_string(),
                        ordinal: index,
                    },
                    sequence,
                });
                next = index + 1;
            }
        }
        publish_preview(&self.preview, writer.snapshot());
        Ok(())
    }
}
async fn receive(
    stream: &mut maka_model::ModelStream,
    writer: &mut maka_agent_facts::model::assembly::AttemptWriter,
    item_acceptance: bool,
    observation: &ObservationProtocol,
    send: &mpsc::Sender<Result<ModelObservation, RunError>>,
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    use maka_agent_facts::model::recorded::ModelObservation as RawObservation;
    let private_summary = observation.scope.purpose == ModelPurpose::Summary;
    let mut pending = BTreeMap::new();
    let mut emitted = 0u64;
    while let Some(next) = stream.next().await {
        let emission = next?;
        let finished = matches!(
            &emission.event,
            maka_agent_facts::model::ModelEvent::Finished { .. }
        );
        let observations = writer.push(emission.event, std::time::SystemTime::now())?;
        if !private_summary {
            publish_preview(&observation.preview, writer.snapshot());
        }
        if item_acceptance && !private_summary && !finished {
            for event in observations {
                if let RawObservation::Part(record) = event {
                    pending.insert(record.ordinal, record.part.as_ref().clone());
                }
            }
            while let Some(part) = pending.remove(&emitted) {
                observation
                    .part(part, emitted, writer, send, cancellation)
                    .await?;
                emitted += 1;
            }
        }
        if finished {
            let step = writer.completed()?;
            let first_buffered = emitted;
            let mut buffered = Vec::new();
            if !private_summary {
                for record in step
                    .parts()
                    .iter()
                    .filter(|record| record.ordinal >= first_buffered)
                {
                    let part = record.part.as_ref().clone();
                    let continuation = observation.continuation(record.ordinal, &part)?;
                    buffered.push((record.ordinal, part, continuation));
                    emitted = record.ordinal + 1;
                }
            }
            let summary = if private_summary {
                let result = maka_agent_facts::context::SummaryResult::from_parts(
                    step.finish_reason,
                    step.parts().iter().map(|record| record.part.as_ref()),
                );
                match &result {
                    maka_agent_facts::context::SummaryResult::Text { .. }
                        if step.compaction.is_some() =>
                    {
                        None
                    }
                    _ => Some(result),
                }
            } else {
                None
            };
            let protocol = serde_json::to_value(maka_agent_facts::context::ModelClosureProtocol {
                finish_reason: step.finish_reason,
                provider_options: step.provider_options.map(Arc::unwrap_or_clone),
                response_id: step.response_id,
                model: step.model,
                timestamp: step.timestamp,
                compaction: step.compaction,
                summary,
            })
            .map_err(RunError::Json)?;
            let fact = observation
                .witness
                .closed_with_parts(
                    buffered,
                    maka_agent_facts::accounting::Outcome::Success,
                    None,
                    step.usage,
                    protocol,
                    witnessed_at()?,
                )
                .await?;
            if !private_summary {
                observation
                    .recorded_batch(first_buffered, emitted, writer)
                    .await?;
            }
            emit(send, cancellation, Ok(ModelObservation::Recorded { fact })).await;
            return Ok(());
        }
    }
    Err(maka_model::ModelError::Adapter(
        "original stream ended without an upstream Finished receipt".into(),
    )
    .into())
}
fn private_partial_blob(
    cut: &maka_agent_facts::model::assembly::AttemptCut,
) -> Result<ContentBlob, RunError> {
    let partial = cut.partial().ok_or_else(|| {
        RunError::InvalidInput("private model partial requires its original Main cut".into())
    })?;
    Ok(ContentBlob::json(
        &maka_agent_facts::model::recorded::PrivateModelPartial {
            binding: cut.binding.clone(),
            revision: cut.revision,
            depends_on: cut.depends_on,
            partial,
        },
    )?)
}
fn witnessed_at() -> Result<UnixMillis, RunError> {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| RunError::Internal(error.to_string()))?
        .as_millis()
        .try_into()
        .map_err(|_| RunError::Internal("model observation timestamp overflows".into()))?;
    Ok(UnixMillis(at))
}

fn terminal_outcome(error: &RunError) -> Option<maka_agent_facts::accounting::Outcome> {
    let RunError::Model(error) = error else {
        return None;
    };
    if matches!(
        error,
        maka_model::ModelError::ImageInputPayloadTooLarge { .. }
            | maka_model::ModelError::LocalAuthorization(_)
    ) {
        return None;
    }
    (crate::model::inference_outcome(error) == maka_agent_facts::accounting::Outcome::Error)
        .then_some(maka_agent_facts::accounting::Outcome::Error)
}

fn merge_input_skills(system: &mut Option<SystemPrompt>, input: &RunInput) -> Result<(), RunError> {
    let RunInput::Message {
        content,
        source_messages,
        ..
    } = input
    else {
        return Ok(());
    };
    if source_messages.is_empty() {
        return merge_skill(system, content);
    }
    let mut seen = std::collections::BTreeSet::new();
    for source in source_messages {
        if let Some(skill) =
            super::skills::prompt(&source.message.content).map_err(RunError::InvalidInput)?
        {
            if seen.insert(maka_agent_engine::digest(&skill)?) {
                append_skill(system, skill);
            }
        }
    }
    Ok(())
}
fn merge_skill(
    system: &mut Option<SystemPrompt>,
    content: &maka_agent_facts::input::MessageInput,
) -> Result<(), RunError> {
    if let Some(skill) = super::skills::prompt(content).map_err(RunError::InvalidInput)? {
        append_skill(system, skill);
    }
    Ok(())
}
fn append_skill(system: &mut Option<SystemPrompt>, skill: SystemPrompt) {
    match system {
        Some(system) => {
            system.text.push_str("\n\n");
            system.text.push_str(&skill.text);
            system.sources.extend(skill.sources);
        }
        None => *system = Some(skill),
    }
}

async fn emit(
    send: &mpsc::Sender<Result<ModelObservation, RunError>>,
    _cancellation: &CancellationToken,
    value: Result<ModelObservation, RunError>,
) {
    // This channel only wakes the driver. Canonical evidence precedes every Recorded ack.
    let _ = send.try_send(value);
}

fn ensure_no_unknown_provider_effect(
    attempt: ModelAttemptId,
    parts: &[maka_agent_facts::model::ModelPart],
) -> Result<(), RunError> {
    use maka_agent_facts::model::ModelPart;
    let results: std::collections::BTreeSet<_> = parts
        .iter()
        .filter_map(|part| match part {
            ModelPart::ToolResult { id, .. } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    for part in parts {
        if let ModelPart::ToolCall { call } = part
            && call.provider_executed
            && !results.contains(call.id.as_str())
        {
            return Err(RunError::Blocked(BlockerKind::ProviderEffectUnknown {
                attempt,
                call: call.id.clone(),
            }));
        }
    }
    Ok(())
}

fn recovery_for_failure(
    error: &RunError,
    run: RunId,
    attempt: ModelAttemptId,
    request: ContentRef,
    adapter: SourceRevision,
    parts: &[maka_agent_facts::model::ModelPart],
) -> Result<RecoveryEvidence, RunError> {
    if let RunError::Model(maka_model::ModelError::ContextOverflow { observed_output }) = error {
        if !observed_output && !parts.is_empty() {
            return Err(RunError::ReconciliationRequired(
                "provider no-output overflow contradicts recorded model parts".into(),
            ));
        }
        return Ok(RecoveryEvidence {
            recovery: AttemptRecovery::ContextOverflow {
                observed_output: *observed_output,
            },
            contents: vec![],
        });
    }
    let blocked = || RecoveryEvidence {
        recovery: AttemptRecovery::Blocked {
            diagnostic: "original adapter supplied no safe replay or prefix continuation proof"
                .into(),
        },
        contents: vec![],
    };
    let RunError::Model(maka_model::ModelError::Provider(failure)) = error else {
        return Ok(blocked());
    };
    failure.validate()?;
    if !failure.retryable() {
        return Ok(blocked());
    }
    let not_before = failure
        .retry_at_unix_ms()
        .map(|time| i64::try_from(time).map(UnixMillis))
        .transpose()
        .map_err(|_| RunError::InvalidInput("provider retry deadline overflows".into()))?;
    if parts.is_empty() && failure.replay_safe() {
        return Ok(RecoveryEvidence {
            recovery: AttemptRecovery::FrozenRetrySafe { not_before },
            contents: vec![],
        });
    }
    if !parts.is_empty() && failure.retained_output_safe() {
        ensure_no_unknown_provider_effect(attempt, parts)?;
        let proof = ContentBlob::json(&PrefixProof {
            run,
            attempt,
            request,
            adapter,
            items: parts.len() as u64,
            digest: maka_agent_engine::digest(&parts)?,
            basis: PrefixBasis::ProviderFailure {
                failure: failure.clone(),
            },
        })?;
        return Ok(RecoveryEvidence {
            recovery: AttemptRecovery::ProjectPrefixSafe {
                prefix: proof.reference().clone(),
                not_before,
            },
            contents: vec![proof],
        });
    }
    Ok(blocked())
}
