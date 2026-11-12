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

//! Semantic request preparation. No attempt admission, execution or recovery decisions.
pub use crate::continuation::{validate_continuation, validate_replay_boundary};
use crate::{RunError, digest, history, prepared_prompt::PreparedPrompt};
use maka_agent_facts::tool_output::ReturnedToolResult;
use maka_agent_facts::{context::ModelPurpose, language::Language};
use maka_model::{ModelRequest, ToolDefinition};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

// Measured usage and separate preparation/adoption follow OpenCode V2
// 55276f2108c8853f94cf16dc530e7754a6ce8318; see docs/code-origin-audit.md and LICENSE.
#[derive(Clone, Copy)]
pub struct Calibration {
    input: u64,
    estimated: u64,
}
impl Calibration {
    pub fn for_route(
        sample: maka_agent_state::session_history::ModelCalibrationSample,
        binding: &maka_agent_facts::execution::ModelBinding,
        model: &str,
        route: &str,
        checkpoint: Option<&str>,
    ) -> Option<Self> {
        (sample.binding.connection_id == binding.connection_id
            && sample.model_id == model
            && sample.route_identity == route
            && sample.previous_checkpoint_id.as_deref() == checkpoint
            && sample.input_tokens > 0)
            .then_some(Self {
                input: sample.input_tokens,
                estimated: sample.original_estimate,
            })
    }
    pub fn estimate(self, current: u64) -> u64 {
        if current >= self.estimated {
            self.input.saturating_add(current - self.estimated)
        } else {
            self.input.saturating_sub(self.estimated - current)
        }
    }
}

pub struct PromptSettings<'a> {
    pub operation: maka_agent_facts::context::ModelOperation,
    pub codex: Option<&'a maka_agent_facts::context::CodexRequestProvenance>,
    pub language: Language,
    pub provider: &'a maka_model::ProviderConfig,
    pub options: &'a serde_json::Value,
    pub context_window: Option<u64>,
    pub tool_choice: maka_model::ToolChoiceMode,
}

pub use crate::history::preparation_io::PreparationIo;

pub struct PromptBuilder {
    builder: crate::history::canonical_prompt::Builder,
    arena: crate::history::capture_arena::CaptureArena,
    resources: maka_model::ModelPreparationResources,
    preparation: Arc<crate::history::preparation::RequestPreparation>,
}
impl PromptBuilder {
    pub async fn new(
        io: PreparationIo,
        resources: maka_model::ModelPreparationResources,
        cancellation: &CancellationToken,
    ) -> Result<Self, RunError> {
        let metadata = crate::history::capture_arena::CaptureArena::metadata_bytes()
            + crate::history::preparation::RequestPreparation::metadata_bytes();
        let staged = tokio::select! {biased;_=cancellation.cancelled()=>return Err(RunError::Cancelled),staged=resources.reserve_staging(metadata)=>staged?};
        let preparation = crate::history::preparation::RequestPreparation::new(staged);
        let arena = crate::history::capture_arena::CaptureArena::new(io, None).await?;
        let builder = crate::history::canonical_prompt::Builder::new(
            arena.clone(),
            resources.clone(),
            preparation.clone(),
            cancellation.clone(),
        )
        .await?;
        Ok(Self {
            builder,
            arena,
            resources,
            preparation,
        })
    }
    pub async fn append(&mut self, message: maka_model::prompt::Message) -> Result<(), RunError> {
        self.builder
            .append(message)
            .await
            .map_err(RunError::Preparation)
    }
    pub async fn append_recipe(
        &mut self,
        recipe: &maka_agent_facts::model::prompt_source::source::MessageRecipe,
    ) -> Result<(), RunError> {
        self.builder.append_recipe(recipe).await?;
        Ok(())
    }
    pub async fn close(&self) -> std::io::Result<()> {
        self.arena.close().await
    }

    pub async fn finish(self) -> Result<PreparedPrompt, RunError> {
        let captured = match self.builder.finish_captured().await {
            Ok(captured) => captured,
            Err(error) => {
                let original = RunError::from(error);
                return Err(match self.arena.close().await {
                    Ok(()) => original,
                    Err(close) => preparation_cleanup_error(original, close),
                });
            }
        };
        Ok(PreparedPrompt::from_canonical(
            captured.prompt,
            self.arena,
            self.resources,
            self.preparation,
            captured.resident_bytes,
        ))
    }
}

pub async fn prepare_prompt(
    builder: PromptBuilder,
    settings: &PromptSettings<'_>,
    cancellation: &CancellationToken,
    system: Option<Arc<String>>,
    purpose: ModelPurpose,
    instruction: Option<Arc<String>>,
) -> Result<PreparedPrompt, RunError> {
    let mut prompt = builder.finish().await?;
    let result = async {
        prompt
            .initialize_overlays(system, purpose == ModelPurpose::Summary, instruction)
            .await?;
        prompt.prepare_media(settings.provider, cancellation).await
    }
    .await;
    if let Err(error) = result {
        return Err(match prompt.close().await {
            Ok(()) => error,
            Err(close) => preparation_cleanup_error(error, close),
        });
    }
    Ok(prompt)
}

#[derive(Debug, thiserror::Error)]
#[error("{original}; closing the original preparation also failed: {cleanup}")]
struct PreparationAbort {
    #[source]
    original: RunError,
    cleanup: std::io::Error,
}
pub fn preparation_cleanup_error(original: RunError, cleanup: std::io::Error) -> RunError {
    RunError::PreparationCleanup(std::io::Error::other(PreparationAbort {
        original,
        cleanup,
    }))
}

pub use maka_agent_facts::history_snapshot::RequestSource;

pub async fn prepare_wire(
    settings: &PromptSettings<'_>,
    prompt: &mut PreparedPrompt,
    definitions: &[Arc<ToolDefinition>],
    max_output_tokens: Option<u64>,
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    prompt
        .compile_wire(
            settings.language,
            settings.provider,
            settings.options,
            definitions,
            cancellation,
        )
        .await?;
    prompt
        .fit_image_request(
            settings.language,
            settings.provider,
            settings.options,
            definitions,
            max_output_tokens,
            cancellation,
        )
        .await?;
    Ok(())
}

pub struct PreparedRequest {
    pub context_breakdown: maka_agent_facts::context::PreparedContextBreakdown,
    pub estimated_input_tokens: u64,
    pub request: ModelRequest,
    pub input_digest: String,
    pub route_identity: String,
}

pub fn prepare_request(
    settings: &PromptSettings<'_>,
    prompt: PreparedPrompt,
    definitions: Vec<Arc<ToolDefinition>>,
    max_output_tokens: Option<u64>,
    purpose: ModelPurpose,
    calibration: Option<Calibration>,
) -> Result<PreparedRequest, RunError> {
    let prompt = prompt.model();
    let format = match settings.provider.kind {
        maka_model::ProviderKind::OpenaiChatCompletions
        | maka_model::ProviderKind::OpenaiCompatible { .. } => {
            maka_model::prompt::WireFormat::ChatCompletions
        }
        maka_model::ProviderKind::OpenaiResponses | maka_model::ProviderKind::OpenResponses(_) => {
            maka_model::prompt::WireFormat::Responses
        }
        maka_model::ProviderKind::Anthropic => maka_model::prompt::WireFormat::Anthropic,
    };
    let wire = prompt
        .wire(format)
        .ok_or_else(|| RunError::Internal("request evidence requires prepared wire".into()))?;
    let mut context_breakdown = prompt.breakdown().clone();
    context_breakdown.accumulate(&maka_agent_facts::context::measure::breakdown(
        &[],
        &definitions,
    ));
    context_breakdown
        .validate()
        .map_err(|error| RunError::Internal(error.into()))?;
    let estimated_input_tokens = calibration
        .filter(|_| purpose == ModelPurpose::Main)
        .map_or_else(
            || context_breakdown.estimated_tokens(),
            |baseline| baseline.estimate(context_breakdown.estimated_tokens()),
        );
    let requested_output = maka_agent_facts::context::effective_output_limit(max_output_tokens);
    let requested_output = if purpose == ModelPurpose::Summary {
        requested_output.max(
            settings
                .context_window
                .unwrap_or(200_000)
                .saturating_mul(4)
                .div_ceil(100)
                .max(1),
        )
    } else {
        requested_output
    };
    let max_output_tokens = Some(crate::context_input::output_limit(
        settings.context_window,
        estimated_input_tokens,
        requested_output,
        purpose,
    ));
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Evidence<'a> {
        #[serde(skip_serializing_if = "maka_agent_facts::context::ModelOperation::is_inference")]
        operation: maka_agent_facts::context::ModelOperation,
        projection: &'static str,
        #[serde(skip_serializing_if = "Language::is_english")]
        language: Language,
        prompt_root: &'a str,
        wire_codec: &'a str,
        wire_root: &'a str,
        route_identity: &'a str,
        tools: &'a [Arc<ToolDefinition>],
        #[serde(skip_serializing_if = "maka_model::ToolChoiceMode::is_auto")]
        tool_choice: maka_model::ToolChoiceMode,
        provider_options: &'a serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_output_tokens: Option<u64>,
    }
    let route_identity = route_identity(settings.provider)?;
    let input_digest = digest(&Evidence {
        operation: settings.operation,
        projection: "maka.model-history.v1",
        language: settings.language,
        prompt_root: prompt.identity(),
        wire_codec: &wire.codec,
        wire_root: &wire.identity,
        route_identity: &route_identity,
        tools: &definitions,
        tool_choice: settings.tool_choice,
        provider_options: settings.options,
        max_output_tokens,
    })?;
    Ok(PreparedRequest {
        context_breakdown,
        estimated_input_tokens,
        request: ModelRequest {
            operation: settings.operation,
            language: settings.language,
            provider: settings.provider.clone(),
            prompt,
            tools: definitions,
            tool_choice: settings.tool_choice,
            provider_options: settings.options.clone(),
            max_output_tokens,
        },
        input_digest,
        route_identity,
    })
}

mod snapshot;
pub use crate::history::canonical_prompt::Layout as FrozenPromptLayout;
pub use snapshot::{
    ContentSource, FrozenPrompt, restore_prompt, restore_prompt_from, snapshot_prompt,
};
mod media_source;
pub use media_source::MediaSource;

/// Render admitted input data under this execution's current Session artifact authority.
#[expect(
    clippy::too_many_arguments,
    reason = "Projection keeps media authority, source content, language, model capabilities and preparation resources explicit"
)]
pub async fn project_input(
    artifacts: &maka_agent_state::artifacts::ArtifactStore,
    scope: &maka_agent_state::artifacts::SessionScope,
    content: &maka_agent_facts::input::MessageInput,
    language: Language,
    vision: bool,
    steering: bool,
    origin: Option<&maka_agent_facts::message::MessageOrigin>,
    resources: &maka_model::ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<maka_model::prompt::Message, RunError> {
    project_input_from(
        MediaSource::Live {
            artifacts,
            scope: scope.clone().into(),
        },
        content,
        language,
        vision,
        steering,
        origin,
        resources,
        cancellation,
    )
    .await
}

#[expect(
    clippy::too_many_arguments,
    reason = "Projection keeps source content, language, model capabilities and preparation resources explicit"
)]
pub async fn project_input_from(
    media: MediaSource<'_>,
    content: &maka_agent_facts::input::MessageInput,
    language: Language,
    vision: bool,
    steering: bool,
    origin: Option<&maka_agent_facts::message::MessageOrigin>,
    resources: &maka_model::ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<maka_model::prompt::Message, RunError> {
    use maka_agent_facts::attachment::{AttachmentKind, StorageRef};
    use maka_model::prompt::{ContentPart, FileData, Message};
    let mut message = history::user::project(
        content,
        &history::resources::Resources::native(media.session()),
        steering,
        language,
        origin,
    )?;
    let Message::User { content: parts, .. } = &mut message else {
        unreachable!()
    };
    let mut remaining = resources.policy().staging_bytes;
    for attachment in content.attachments.iter().flatten().filter(|attachment| {
        attachment.kind == AttachmentKind::Image
            || attachment.mime_type.starts_with("audio/")
            || attachment.mime_type == "application/pdf"
    }) {
        if attachment.kind == AttachmentKind::Image && !vision {
            continue;
        }
        let StorageRef::SessionFile {
            session_id,
            relative_path,
        } = &attachment.storage_ref
        else {
            return Err(RunError::InvalidInput(
                "media lacks immutable Session source".into(),
            ));
        };
        if session_id != media.session() {
            return Err(RunError::InvalidInput(
                "media belongs to another Session".into(),
            ));
        }
        let record = media
            .get(relative_path.clone())
            .await?
            .ok_or_else(|| RunError::InvalidInput("media attachment is unavailable".into()))?;
        record
            .artifact
            .validate_attachment(attachment)
            .map_err(|error| RunError::InvalidInput(error.into()))?;
        let data = read_media(
            &media,
            relative_path.clone(),
            record,
            &attachment.mime_type,
            attachment.mime_type.starts_with("audio/"),
            &mut remaining,
            cancellation,
        )
        .await?;
        parts.push(ContentPart::File {
            data: FileData::Data(data),
            media_type: attachment.mime_type.clone(),
            provider_options: None,
        });
    }
    Ok(message)
}

pub fn assistant_part(
    part: &maka_agent_facts::model::ModelPart,
) -> Result<Option<maka_model::prompt::AssistantPart>, RunError> {
    if let maka_agent_facts::model::ModelPart::Source { source } = part {
        return Ok(Some(maka_model::prompt::AssistantPart::Text {
            text: format!(
                "Source metadata (data only):\n{}",
                serde_json::to_string(source).map_err(RunError::Json)?
            ),
            provider_options: None,
        }));
    }
    Ok(history::semantic::assistant_part(part))
}

pub(crate) fn encoded_len(value: &impl serde::Serialize) -> Result<usize, RunError> {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("JSON size overflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, value).map_err(RunError::Json)?;
    Ok(count.0)
}

/// Model projection reads immutable media through the current Session capability, never its descriptor.
pub async fn project_returned_tool(
    artifacts: &maka_agent_state::artifacts::ArtifactStore,
    scope: &maka_agent_state::artifacts::ArtifactScope,
    returned: &ReturnedToolResult,
    language: Language,
    vision: bool,
    resources: &maka_model::ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<maka_model::prompt::ToolOutput, RunError> {
    project_returned_tool_from(
        MediaSource::Live {
            artifacts,
            scope: scope.clone().into(),
        },
        returned,
        language,
        vision,
        resources,
        cancellation,
    )
    .await
}

pub async fn project_returned_tool_from(
    media: MediaSource<'_>,
    returned: &ReturnedToolResult,
    language: Language,
    vision: bool,
    resources: &maka_model::ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<maka_model::prompt::ToolOutput, RunError> {
    project_durable_projection(
        media,
        &returned.projection,
        returned.is_error,
        language,
        vision,
        resources,
        cancellation,
    )
    .await
}

pub async fn project_durable_projection(
    media: MediaSource<'_>,
    projection: &maka_agent_facts::tool_output::DurableToolProjection,
    is_error: bool,
    language: Language,
    vision: bool,
    resources: &maka_model::ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<maka_model::prompt::ToolOutput, RunError> {
    use maka_agent_facts::tool_output::{DurableToolProjection, ProjectionPart};
    use maka_model::prompt::{ContentPart, FileData, ToolOutput};
    projection
        .validate(media.session())
        .map_err(|error| RunError::InvalidInput(error.into()))?;
    let output = match projection {
        DurableToolProjection::Text { text } => ToolOutput::Text(text.clone()),
        DurableToolProjection::Json { value } => ToolOutput::Json(value.clone()),
        DurableToolProjection::Failure => ToolOutput::ErrorText(
            maka_agent_facts::tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE.into(),
        ),
        DurableToolProjection::Content { parts } => {
            let mut content = Vec::with_capacity(parts.len());
            let mut remaining = resources.policy().staging_bytes;
            if is_error {
                content.push(ContentPart::text("Tool reported an error:"));
            }
            for part in parts {
                match part {
                    ProjectionPart::Text { text } => content.push(ContentPart::text(text.clone())),
                    ProjectionPart::Artifact { .. } if !vision => {
                        content.push(ContentPart::text(history::images::no_vision(language)))
                    }
                    ProjectionPart::Artifact { image } => {
                        let data = projection_media_from(
                            &media,
                            &image.reference,
                            &image.mime_type,
                            false,
                            &mut remaining,
                            cancellation,
                        )
                        .await?;
                        content.push(ContentPart::File {
                            data: FileData::Data(data),
                            media_type: image.mime_type.clone(),
                            provider_options: image
                                .detail
                                .map(|detail| serde_json::json!({"openai":{"imageDetail":detail}})),
                        });
                    }
                    ProjectionPart::Audio { audio } => {
                        let data = projection_media_from(
                            &media,
                            &audio.reference,
                            &audio.mime_type,
                            true,
                            &mut remaining,
                            cancellation,
                        )
                        .await?;
                        content.push(ContentPart::File {
                            data: FileData::Data(data),
                            media_type: audio.mime_type.clone(),
                            provider_options: None,
                        });
                    }
                }
            }
            ToolOutput::Content(content)
        }
    };
    Ok(if is_error {
        match output {
            ToolOutput::Text(text) => ToolOutput::ErrorText(text),
            ToolOutput::Json(value) => ToolOutput::ErrorJson(value),
            output => output,
        }
    } else {
        output
    })
}

async fn projection_media_from(
    media: &MediaSource<'_>,
    reference: &maka_agent_facts::attachment::StorageRef,
    mime: &str,
    audio: bool,
    remaining: &mut usize,
    cancellation: &CancellationToken,
) -> Result<String, RunError> {
    let maka_agent_facts::attachment::StorageRef::SessionFile {
        session_id,
        relative_path,
    } = reference
    else {
        return Err(RunError::InvalidInput(
            "tool media lacks immutable Session source".into(),
        ));
    };
    if session_id != media.session() {
        return Err(RunError::InvalidInput(
            "tool media belongs to another Session".into(),
        ));
    }
    let record = media
        .get(relative_path.clone())
        .await?
        .ok_or_else(|| RunError::InvalidInput("tool media unavailable at original cut".into()))?;
    read_media(
        media,
        relative_path.clone(),
        record,
        mime,
        audio,
        remaining,
        cancellation,
    )
    .await
}

async fn read_media(
    media: &MediaSource<'_>,
    id: String,
    expected: maka_agent_facts::artifact::PublishedArtifact,
    mime: &str,
    audio: bool,
    remaining: &mut usize,
    cancellation: &CancellationToken,
) -> Result<String, RunError> {
    use base64::Engine as _;
    let length = usize::try_from(expected.payload.bytes)
        .map_err(|_| RunError::InvalidInput("media size overflow".into()))?;
    *remaining = remaining
        .checked_sub(
            length
                .checked_mul(3)
                .ok_or_else(|| RunError::InvalidInput("media size overflow".into()))?,
        )
        .ok_or_else(|| RunError::InvalidInput("media exceeds preparation staging limit".into()))?;
    let mime = mime.to_owned();
    let cancellation = cancellation.clone();
    media
        .with_content(id, move |record, reader| -> Result<String, RunError> {
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            if record != &expected.artifact
                || record.mime_type.as_deref() != Some(mime.as_str())
                || record.size_bytes != expected.payload.bytes
            {
                return Err(RunError::InvalidInput("media changed after capture".into()));
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes)?;
            if bytes.is_empty()
                || maka_agent_facts::artifact::content_digest(&bytes) != expected.payload.digest
            {
                return Err(RunError::InvalidInput("media digest changed".into()));
            }
            if if audio {
                !maka_agent_facts::tool_output::audio::valid_mime(&mime)
            } else {
                maka_agent_facts::attachment::sniff_binary_mime(&bytes) != Some(mime.as_str())
            } {
                return Err(RunError::InvalidInput(
                    "media MIME does not match bytes".into(),
                ));
            }
            Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
        })
        .await?
        .ok_or_else(|| RunError::InvalidInput("media unavailable at original cut".into()))?
}

pub fn route_identity(provider: &maka_model::ProviderConfig) -> Result<String, RunError> {
    // Credential refresh must not change replay identity; the caller reauthorizes transport separately.
    digest(
        &serde_json::json!({"adapter":provider.adapter,"kind":provider.kind,"model":provider.model,"baseUrl":provider.base_url,"headers":provider.headers,"imageInput":provider.image_input,"bodyOverlay":provider.body_overlay}),
    )
}

mod cell_notification;
pub use cell_notification::{
    NotificationSource, project_cell_final, project_cell_notification,
    project_cell_notification_from,
};

mod cell_knowledge;
pub use cell_knowledge::project_cell_knowledge;
