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

//! Immutable final logical recipes, persisted and restored without flattening.
use super::PreparationIo;
use crate::{
    RunError,
    history::{
        canonical_prompt::{self, Builder, Layout},
        capture_arena::CaptureArena,
        preparation::RequestPreparation,
    },
    prepared_prompt::PreparedPrompt,
};
use maka_agent_facts::{
    durable::{ContentRef, RunId},
    model::prompt_source::source::{
        ChargedBuffer, MessageMetadata, MessageRecipe, MessageSource, NextRecipe, RecipeCursor,
        RecipeIdentity, RecipeSource, SourceBytes,
    },
};
use maka_agent_state::{
    ContentBlob, ImmutableContentBody,
    session_history::{HistoryCut, SessionHistory},
};
use maka_model::{DirectoryLease, ModelPreparationResources, prompt::Prompt};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    io::{self, Read, Write},
    pin::Pin,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

pub type FrozenPromptCleanup = Pin<Box<dyn Future<Output = Result<(), RunError>> + Send + 'static>>;

pub struct FrozenPrompt {
    pub content: ContentBlob,
    pub layout: Layout,
    cleanup: FrozenPromptCleanup,
}
impl FrozenPrompt {
    pub fn into_parts(self) -> (ContentBlob, Layout, FrozenPromptCleanup) {
        (self.content, self.layout, self.cleanup)
    }
}

struct Staging {
    preparation: Arc<RequestPreparation>,
    directory: DirectoryLease,
    resident_bytes: usize,
}
async fn staging(
    resources: &ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<Staging, RunError> {
    let metadata = CaptureArena::metadata_bytes()
        + RequestPreparation::metadata_bytes()
        + std::mem::size_of::<ArenaBody>()
        + std::mem::size_of::<ArenaReader<'static>>()
        + 4 * std::mem::size_of::<usize>();
    let resident_bytes = metadata
        .checked_add(Builder::resident_bytes())
        .ok_or_else(overflow)?;
    let staged = tokio::select! {
        biased;
        _=cancellation.cancelled()=>return Err(RunError::Cancelled),
        staged=resources.reserve_staging(resident_bytes)=>staged?,
    };
    let preparation = RequestPreparation::new(staged);
    let directory = preparation.plan_directory(metadata)?;
    Ok(Staging {
        preparation,
        directory,
        resident_bytes,
    })
}

pub async fn snapshot_prompt(
    io: PreparationIo,
    resources: ModelPreparationResources,
    prompt: &Prompt,
    cancellation: &CancellationToken,
) -> Result<FrozenPrompt, RunError> {
    let source = prompt.recipes().ok_or_else(|| {
        RunError::Internal("snapshot requires final source-backed prompt recipes".into())
    })?;
    let staging = staging(&resources, cancellation).await?;
    let arena = CaptureArena::new(io.clone(), None).await?;
    let result = async {
        let mut builder = Builder::new(
            arena.clone(),
            resources.clone(),
            staging.preparation.clone(),
            cancellation.clone(),
        )
        .await?;
        let mut cursor = source.open(0);
        while let Some(message) = cursor.next().await? {
            check(cancellation)?;
            builder.append_recipe(&message).await?;
        }
        let captured = builder.finish_captured().await?;
        let work = tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Err(RunError::Cancelled),
            work=resources.acquire_work()=>work?,
        };
        let budget = work.budget();
        let mut reader = captured.bytes.open(budget.clone());
        let mut buffer = budget.allocate(32 * 1024).await?;
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        loop {
            check(cancellation)?;
            let read = reader.read_chunk(buffer).await?;
            hash.update(&read.buffer.as_ref()[..read.bytes_read]);
            bytes = bytes
                .checked_add(read.bytes_read as u64)
                .ok_or_else(overflow)?;
            buffer = read.buffer;
            if read.eof {
                break;
            }
            if read.bytes_read == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "frozen prompt source made no progress",
                )
                .into());
            }
        }
        if bytes != captured.layout.byte_len {
            return Err(invalid("frozen prompt length changed").into());
        }
        let reference = ContentRef {
            digest: format!("sha256:{}", hex::encode(hash.finalize())),
            bytes,
        };
        let (released, done) = tokio::sync::oneshot::channel();
        let cleanup_arena = arena.clone();
        let cleanup_preparation = staging.preparation.clone();
        let cleanup: FrozenPromptCleanup = Box::pin(async move {
            let released = done.await;
            let closed = cleanup_arena.close().await;
            drop(cleanup_preparation);
            closed.map_err(RunError::PreparationCleanup)?;
            released.map_err(|_| {
                RunError::Internal("frozen prompt body release signal was lost".into())
            })
        });
        let body = ArenaBody {
            arena: arena.clone(),
            bytes,
            access: Mutex::new(()),
            _io: io,
            _preparation: staging.preparation,
            _directory: staging.directory,
            _source: captured.bytes,
            released: Some(released),
        };
        Ok(FrozenPrompt {
            content: ContentBlob::prepared(reference, Arc::new(body))?,
            layout: captured.layout,
            cleanup,
        })
    }
    .await;
    close_failed(&arena, result).await
}

pub enum ContentSource<'a> {
    Live {
        history: &'a SessionHistory,
        cut: &'a HistoryCut,
    },
    Snapshot(&'a maka_agent_state::session_history::snapshot::Snapshot),
}

pub async fn restore_prompt(
    io: PreparationIo,
    resources: ModelPreparationResources,
    history: &SessionHistory,
    cut: &HistoryCut,
    run: RunId,
    reference: &ContentRef,
    layout: &Layout,
    cancellation: &CancellationToken,
) -> Result<PreparedPrompt, RunError> {
    restore_prompt_from(
        io,
        resources,
        ContentSource::Live { history, cut },
        run,
        reference,
        layout,
        cancellation,
    )
    .await
}

pub async fn restore_prompt_from(
    io: PreparationIo,
    resources: ModelPreparationResources,
    source: ContentSource<'_>,
    run: RunId,
    reference: &ContentRef,
    layout: &Layout,
    cancellation: &CancellationToken,
) -> Result<PreparedPrompt, RunError> {
    reference
        .validate()
        .map_err(|reason| RunError::InvalidInput(reason.into()))?;
    if reference.bytes != layout.byte_len {
        return Err(RunError::InvalidInput(
            "frozen prompt manifest length differs from its content".into(),
        ));
    }
    let staging = staging(&resources, cancellation).await?;
    let arena = CaptureArena::new(io, None).await?;
    let result = async {
        let work = tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Err(RunError::Cancelled),
            work=resources.acquire_work()=>work?,
        };
        let budget = work.budget();
        let buffer = budget.allocate(32 * 1024).await?;
        let copy_arena = arena.clone();
        let expected = reference.clone();
        let copy_cancellation = cancellation.clone();
        let consume = move |reader: &mut dyn Read| {
            Ok(copy_arena.with_writer_sync(|writer| {
                copy_content(reader, writer, buffer, &expected, &copy_cancellation)
            }))
        };
        let copied = match source {
            ContentSource::Live { history, cut } => {
                history.with_content(cut, run, reference, consume).await?
            }
            ContentSource::Snapshot(snapshot) => {
                snapshot.with_content(run, reference, consume).await?
            }
        };
        copied.map_err(RunError::preparation)?;
        drop((budget, work));
        check(cancellation)?;
        let source_directory = staging
            .preparation
            .plan_directory(Builder::resident_bytes())?;
        let body =
            canonical_prompt::restore(arena.clone(), resources.clone(), layout.clone()).await?;
        let source = body
            .recipes()
            .cloned()
            .ok_or_else(|| RunError::Internal("restored prompt lacks source recipes".into()))?;
        let source = ChargedSource {
            source,
            owner: Arc::new((staging.directory, source_directory)),
        };
        let body = Prompt::from_recipes(
            Arc::new(source),
            body.identity().to_owned(),
            body.len(),
            body.breakdown().clone(),
        );
        let prompt = PreparedPrompt::from_canonical(
            body,
            arena.clone(),
            resources,
            staging.preparation,
            staging.resident_bytes,
        );
        Ok(prompt)
    }
    .await;
    close_failed(&arena, result).await
}

fn copy_content(
    reader: &mut dyn Read,
    writer: &mut crate::history::request_backing::RequestBackingBuilder,
    mut buffer: ChargedBuffer,
    expected: &ContentRef,
    cancellation: &CancellationToken,
) -> io::Result<()> {
    if writer.position() != 0 {
        return Err(invalid("restored prompt arena is not empty"));
    }
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    loop {
        if cancellation.is_cancelled() {
            return Err(crate::preparation_cancelled(
                "frozen prompt restore cancelled",
            ));
        }
        let count = reader.read(buffer.as_mut())?;
        if count == 0 {
            break;
        }
        bytes = bytes.checked_add(count as u64).ok_or_else(overflow)?;
        if bytes > expected.bytes {
            return Err(invalid("frozen prompt exceeds its content reference"));
        }
        let chunk = &buffer.as_ref()[..count];
        hash.update(chunk);
        writer.write_all(chunk)?;
    }
    if bytes != expected.bytes
        || format!("sha256:{}", hex::encode(hash.finalize())) != expected.digest
    {
        return Err(invalid(
            "frozen prompt content digest or length differs from its reference",
        ));
    }
    Ok(())
}

struct ArenaBody {
    arena: CaptureArena,
    bytes: u64,
    access: Mutex<()>,
    _io: PreparationIo,
    _preparation: Arc<RequestPreparation>,
    _directory: DirectoryLease,
    _source: SourceBytes,
    released: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Drop for ArenaBody {
    fn drop(&mut self) {
        // Borrowed readers cannot outlive this final content owner. CAS hits,
        // which need no reader at all, follow this same release boundary.
        let _ = self
            .released
            .take()
            .expect("live frozen prompt body")
            .send(());
    }
}
impl ImmutableContentBody for ArenaBody {
    fn reader(&self) -> io::Result<Box<dyn Read + Send + '_>> {
        Ok(Box::new(ArenaReader {
            body: self,
            position: 0,
        }))
    }
}
struct ArenaReader<'a> {
    body: &'a ArenaBody,
    position: u64,
}
impl Read for ArenaReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = (self.body.bytes - self.position).min(buffer.len() as u64) as usize;
        if count == 0 {
            return Ok(0);
        }
        let _access = self
            .body
            .access
            .lock()
            .map_err(|_| io::Error::other("frozen prompt reader lock poisoned"))?;
        self.body
            .arena
            .with_writer_sync(|writer| writer.read_exact_at(self.position, &mut buffer[..count]))?;
        self.position += count as u64;
        Ok(count)
    }
}

fn check(cancellation: &CancellationToken) -> Result<(), RunError> {
    if cancellation.is_cancelled() {
        Err(RunError::Cancelled)
    } else {
        Ok(())
    }
}
fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}
fn overflow() -> io::Error {
    io::Error::other("frozen prompt size overflow")
}
async fn close_failed<T>(arena: &CaptureArena, result: Result<T, RunError>) -> Result<T, RunError> {
    match result {
        Ok(value) => Ok(value),
        Err(preparation) => match arena.close().await {
            Ok(()) => Err(preparation),
            Err(cleanup) => Err(RunError::PreparationCleanup(io::Error::other(
                CleanupError {
                    preparation,
                    cleanup,
                },
            ))),
        },
    }
}
#[derive(Debug)]
struct CleanupError {
    preparation: RunError,
    cleanup: io::Error,
}
impl std::fmt::Display for CleanupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}; closing frozen prompt also failed: {}",
            self.preparation, self.cleanup
        )
    }
}
impl std::error::Error for CleanupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cleanup)
    }
}

struct ChargedSource {
    source: Arc<dyn MessageSource>,
    owner: Arc<(DirectoryLease, DirectoryLease)>,
}
impl RecipeSource<MessageRecipe> for ChargedSource {
    fn len(&self) -> usize {
        self.source.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        Box::new(ChargedCursor {
            cursor: self.source.open(start),
            _owner: self.owner.clone(),
        })
    }
}
impl MessageSource for ChargedSource {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        Box::new(ChargedCursor {
            cursor: self.source.open_metadata(start),
            _owner: self.owner.clone(),
        })
    }
    fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_> {
        self.source.prefix_identity(messages)
    }
}
struct ChargedCursor<T> {
    cursor: Box<dyn RecipeCursor<T>>,
    _owner: Arc<(DirectoryLease, DirectoryLease)>,
}
impl<T: Send + 'static> RecipeCursor<T> for ChargedCursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        self.cursor.next()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::test_support as canonical;
    use maka_capabilities::model_preparation::PreparationPolicy;
    use maka_model::prompt::Message;
    use std::task::Poll;

    #[tokio::test]
    async fn snapshot_cleanup_waits_for_last_blob_owner_without_needing_a_reader() {
        let directory = tempfile::tempdir().unwrap();
        let root = canonical::open(directory.path(), false).await;
        root.create_session("session", "create", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let (log, execution, effects) = canonical::work(&root).await;
        let resources = ModelPreparationResources::new(PreparationPolicy::default()).unwrap();
        let cancellation = CancellationToken::new();
        let original = canonical::capture(
            &log,
            vec![Message::user("snapshot source")],
            resources.clone(),
        )
        .await;
        let frozen = snapshot_prompt(
            PreparationIo::new(&log).unwrap(),
            resources.clone(),
            &original.model(),
            &cancellation,
        )
        .await
        .unwrap();
        original.close().await.unwrap();
        drop(original);
        let (content, layout, mut cleanup) = frozen.into_parts();
        assert_eq!(content.reference().bytes, layout.byte_len);
        let writer_owner = content.clone();
        drop(content);
        std::future::poll_fn(|context| {
            assert!(cleanup.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(writer_owner);
        cleanup.await.unwrap();
        let all_staging = resources
            .reserve_staging(resources.policy().staging_bytes)
            .await
            .unwrap();
        drop((all_staging, log));
        effects.settle().await.unwrap();
        execution.finish();
        root.shutdown().await.unwrap();
    }
    #[derive(serde::Serialize, serde::Deserialize)]
    struct ReplayManifest {
        content: ContentRef,
        layout: Layout,
        instructions: Option<String>,
        normalization: Option<maka_model::ProviderKind>,
        format: maka_model::prompt::WireFormat,
        codec: String,
        wire_identity: String,
        budget: maka_agent_facts::context::PreparedContextBreakdown,
    }

    #[tokio::test]
    async fn committed_snapshot_reopens_with_identical_responses_wire_and_budget() {
        use crate::preparation::{self, PromptSettings};
        use base64::Engine as _;
        use image::ImageEncoder as _;
        use maka_agent_facts::{
            artifact::content_digest,
            composition::RequestComposition,
            configuration::ImageInput,
            context::{ModelOperation, ModelPurpose},
            durable::{Fact, UnixMillis},
            language::Language,
            tools::{FreeformGrammar, ToolDefinition},
        };
        use maka_agent_state::Change;
        use maka_model::{
            ProviderConfig, ProviderKind, ToolChoiceMode,
            prompt::{AssistantPart, ContentPart, FileData, ToolOutput, WireFormat},
        };
        use serde_json::json;

        let directory = tempfile::tempdir().unwrap();
        let root = canonical::open(directory.path(), false).await;
        root.create_session("session", "create", &json!({}), 1)
            .await
            .unwrap();
        let (log, execution, effects) = canonical::work(&root).await;
        let state = canonical::state(&root);
        let run = canonical::admit(&state, "opening".into()).await;
        let policy = PreparationPolicy {
            staging_bytes: 128 * 1024,
            resident_bytes: 2 * 1024 * 1024,
            progress_bytes: 2 * 1024 * 1024,
            work_bytes: 512 * 1024,
        };
        let resources = ModelPreparationResources::new(policy).unwrap();
        let cancellation = CancellationToken::new();
        let provider = ProviderConfig {
            image_input: Some(ImageInput {
                max_width: Some(1),
                max_height: Some(1),
                ..Default::default()
            }),
            adapter: None,
            capabilities: Default::default(),
            network: Default::default(),
            kind: ProviderKind::OpenaiResponses,
            model: "fixture".into(),
            base_url: "https://example.invalid".into(),
            auth: maka_model::ProviderAuth::ApiKey("fixture".into()),
            headers: Default::default(),
            body_overlay: None,
        };
        let definitions = vec![Arc::new(ToolDefinition {
            provider: None,
            name: "exec".into(),
            description: "Run fixture commands".into(),
            input_schema: json!({"type":"object","properties":{"command":{"type":"string"}},"required":["command"],"additionalProperties":false}),
            freeform: Some(FreeformGrammar::Lark {
                definition: "start: /[\\s\\S]+/".into(),
            }),
            output_schema: None,
        })];
        let options = json!({"openai":{"store":false}});
        let settings = PromptSettings {
            operation: ModelOperation::Inference,
            codex: None,
            language: Language::En,
            provider: &provider,
            options: &options,
            context_window: None,
            tool_choice: ToolChoiceMode::Auto,
        };
        let mut image = Vec::new();
        image::codecs::png::PngEncoder::new(&mut image)
            .write_image(&[90; 12], 2, 2, image::ExtendedColorType::Rgb8)
            .unwrap();
        let mut result = Message::tool(
            "custom-call",
            "exec",
            ToolOutput::Text("snapshot result".into()),
        );
        if let Message::Tool { content, .. } = &mut result {
            content[0].provider_options = Some(json!({"openai":{"toolKind":"custom"}}));
        }
        let messages = vec![
            Message::User {
                content: vec![
                    ContentPart::text("large retained body\n".repeat(32 * 1024)),
                    ContentPart::File {
                        data: FileData::Data(
                            base64::engine::general_purpose::STANDARD.encode(image),
                        ),
                        media_type: "image/png".into(),
                        provider_options: Some(json!({"openai":{"imageDetail":"high"}})),
                    },
                ],
                provider_options: None,
            },
            Message::Assistant {
                content: vec![
                    AssistantPart::Reasoning {
                        text: "reasoning text".into(),
                        provider_options: Some(
                            json!({"openai":{"itemId":"reasoning-id","reasoningEncryptedContent":"signature+/=opaque"}}),
                        ),
                    },
                    AssistantPart::ToolCall {
                        tool_call_id: "custom-call".into(),
                        tool_name: "exec".into(),
                        input: maka_agent_facts::model::ToolInput::Json(json!("printf snapshot\n")),
                        provider_executed: Some(false),
                        provider_options: Some(json!({"openai":{"toolKind":"custom"}})),
                    },
                ],
                provider_options: None,
            },
            result,
        ];
        let mut original = canonical::capture(&log, messages, resources.clone())
            .await
            .with_frozen_transport(None, Some(provider.kind.clone()));
        original
            .initialize_overlays(
                Some(Arc::new("snapshot system".into())),
                false,
                Some(Arc::new("snapshot suffix".into())),
            )
            .await
            .unwrap();
        original
            .prepare_media(&provider, &cancellation)
            .await
            .unwrap();
        preparation::prepare_wire(
            &settings,
            &mut original,
            &definitions,
            Some(128),
            &cancellation,
        )
        .await
        .unwrap();
        let prepared = preparation::prepare_request(
            &settings,
            original.clone(),
            definitions.clone(),
            Some(128),
            ModelPurpose::Main,
            None,
        )
        .unwrap();
        let logical = original.model();
        let (content, layout, cleanup) = snapshot_prompt(
            PreparationIo::new(&log).unwrap(),
            resources.clone(),
            &logical,
            &cancellation,
        )
        .await
        .unwrap()
        .into_parts();
        assert!(content.reference().bytes > policy.staging_bytes as u64);
        let cleanup = tokio::spawn(cleanup);
        let wire = prepared.request.prompt.wire(WireFormat::Responses).unwrap();
        let manifest = ContentBlob::json(&ReplayManifest {
            content: content.reference().clone(),
            layout,
            instructions: logical.instructions().map(str::to_owned),
            normalization: logical.normalization().cloned(),
            format: wire.format,
            codec: wire.codec.to_string(),
            wire_identity: wire.identity.to_string(),
            budget: prepared.context_breakdown.clone(),
        })
        .unwrap();
        let manifest_reference = manifest.reference().clone();
        let composition = RequestComposition {
            system_prompt: Some("snapshot system".into()),
            dynamic_context: vec![],
            tool_catalog_digest: content_digest(&serde_json::to_vec(&definitions).unwrap()),
            tools: definitions,
            provider_options: Some(options.clone()),
            max_output_tokens: Some(128),
            sources: vec![],
        };
        let (step, request, mut contents) = canonical::request_with_composition(
            vec![],
            vec![content.reference().clone(), manifest_reference.clone()],
            composition,
        );
        contents.extend([content, manifest]);
        let claim = state.claim(run).await.unwrap();
        let view = state.frontier(run).await.unwrap();
        state
            .append(
                &claim,
                (&view).into(),
                vec![Change::new(
                    Fact::StepPrepared {
                        step,
                        request: request.reference().clone(),
                        adjudications: vec![],
                    },
                    UnixMillis(2),
                )],
                contents,
            )
            .await
            .unwrap();
        cleanup.await.unwrap().unwrap();
        original.close().await.unwrap();
        drop((
            prepared, logical, original, claim, view, request, state, log, resources,
        ));
        effects.settle().await.unwrap();
        execution.finish();
        root.shutdown().await.unwrap();
        drop(root);

        let root = canonical::open(directory.path(), true).await;
        let (log, execution, effects) = canonical::work(&root).await;
        let history = SessionHistory::new(
            root.data_writer().unwrap(),
            canonical::owner(),
            "session".into(),
        );
        let cut = history.capture().await.unwrap();
        let persisted = history.request(&cut, run, step).await.unwrap();
        let manifest: ReplayManifest = history
            .with_content(&cut, run, &manifest_reference, |reader| {
                let mut bytes = Vec::new();
                reader.take(32 * 1024).read_to_end(&mut bytes)?;
                Ok(serde_json::from_slice(&bytes)?)
            })
            .await
            .unwrap();
        let resources = ModelPreparationResources::new(policy).unwrap();
        let mut restored = restore_prompt(
            PreparationIo::new(&log).unwrap(),
            resources,
            &history,
            &cut,
            run,
            &manifest.content,
            &manifest.layout,
            &cancellation,
        )
        .await
        .unwrap()
        .with_frozen_transport(manifest.instructions.as_deref(), manifest.normalization);
        let composition = persisted.composition;
        let settings = PromptSettings {
            operation: ModelOperation::Inference,
            codex: None,
            language: Language::En,
            provider: &provider,
            options: composition.provider_options.as_ref().unwrap(),
            context_window: None,
            tool_choice: ToolChoiceMode::Auto,
        };
        preparation::prepare_wire(
            &settings,
            &mut restored,
            &composition.tools,
            composition.max_output_tokens,
            &cancellation,
        )
        .await
        .unwrap();
        let rebuilt = preparation::prepare_request(
            &settings,
            restored.clone(),
            composition.tools.clone(),
            composition.max_output_tokens,
            ModelPurpose::Main,
            None,
        )
        .unwrap();
        let wire = rebuilt.request.prompt.wire(manifest.format).unwrap();
        assert_eq!(wire.format, manifest.format);
        assert_eq!(wire.codec.as_ref(), manifest.codec);
        assert_eq!(wire.identity.as_ref(), manifest.wire_identity);
        assert_eq!(rebuilt.context_breakdown, manifest.budget);
        let mut cursor = wire.open(0);
        let mut bytes = Vec::new();
        let mut items = Vec::<serde_json::Value>::new();
        while let Some(chunk) = cursor.next().await.unwrap() {
            bytes.extend_from_slice(&chunk.bytes);
            if chunk.item_end {
                items.push(serde_json::from_slice(&bytes).unwrap());
                bytes.clear();
            }
        }
        let reasoning = items
            .iter()
            .find(|item| item["type"] == "reasoning")
            .unwrap();
        assert_eq!(reasoning["encrypted_content"], "signature+/=opaque");
        let call = items
            .iter()
            .find(|item| item["type"] == "custom_tool_call")
            .unwrap();
        assert_eq!(call["input"], "printf snapshot\n");
        let image = items
            .iter()
            .filter_map(|item| item["content"].as_array())
            .flatten()
            .find(|part| part["type"] == "input_image")
            .unwrap();
        assert_eq!(image["detail"], "high");
        let encoded = image["image_url"]
            .as_str()
            .unwrap()
            .strip_prefix("data:image/png;base64,")
            .unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let decoded = image::load_from_memory(&decoded).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1, 1));
        drop((cursor, rebuilt));
        restored.close().await.unwrap();
        drop((restored, history, log));
        effects.settle().await.unwrap();
        execution.finish();
        root.shutdown().await.unwrap();
    }
}
