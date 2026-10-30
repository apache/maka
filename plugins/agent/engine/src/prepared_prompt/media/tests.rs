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
use base64::Engine;
use image::{GenericImageView, ImageEncoder};
use maka_agent_facts::{
    artifact::{Artifact, ArtifactKind, ArtifactSource, content_digest},
    attachment::StorageRef,
    event::{EventWrite, Fact, Invocation, RuntimeEvent},
    input::InvocationInput,
    language::Language,
    model::prompt_source::source::MediaSource,
    tool_call::ToolCallIdentity,
    tool_output::{
        DurableToolProjection, ImageDetail, ImageOutput, ProjectionPart, ToolOutput, ToolSuccess,
    },
};
use maka_event_log::{
    context::semantic::SemanticSelection,
    root_store::{RootStore, SessionExecutionLease, SessionStore},
};
use maka_model::{ModelPreparationResources, ModelRequest, ProviderKind};
use serde_json::{Value, json};

const WIDTH: u32 = 390;
const HEIGHT: u32 = 45480;

fn invocation() -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    }
}
async fn artifact(store: &SessionStore, id: &str, mime: &str, body: Vec<u8>, tool: bool) {
    store
        .commit_artifact(
            Artifact {
                id: id.into(),
                session_id: "session".into(),
                turn_id: "upload".into(),
                created_at: 1,
                name: "display-name".into(),
                kind: if mime.starts_with("image/") {
                    ArtifactKind::Image
                } else {
                    ArtifactKind::File
                },
                size_bytes: body.len() as u64,
                mime_type: Some(mime.into()),
                source: if tool {
                    ArtifactSource::ToolResult
                } else {
                    ArtifactSource::UserUpload
                },
                summary: Some(maka_agent_facts::artifact::content_digest(&body)),
            },
            body,
        )
        .await
        .unwrap();
}
async fn append(store: &SessionStore, fact: Fact) -> u64 {
    store
        .append(&EventWrite::plain(RuntimeEvent::new(invocation(), fact)).unwrap())
        .await
        .unwrap()
}
async fn open_model(store: &SessionStore) {
    append(
        store,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "prior".into(),
                request_fingerprint: None,
            },
        },
    )
    .await;
    append(
        store,
        Fact::ModelRequested {
            source_capture: maka_agent_facts::event::SourceCapture {
                publication_watermark: 0,
                prior_unknown: false,
            },
            item_acceptance: false,
            effective_source_digest: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            context_breakdown: None,
            checkpoint_event_id: None,
            step_id: "step".into(),
            model_id: "test".into(),
            source_scope: maka_agent_facts::event::LogScope::Session {
                id: "session".into(),
            },
            source_high_water: 1,
            source_digest: "fixture".into(),
            input_digest: "fixture".into(),
            route_identity: "fixture".into(),
        },
    )
    .await;
}
fn model_completion(
    parts: Vec<maka_agent_facts::model::ModelPart>,
) -> maka_agent_facts::model::recorded::ModelCompletion {
    use maka_agent_facts::model::recorded::{CompletionPart, ModelCompletion, ModelPartRecord};
    ModelCompletion {
        parts: parts
            .into_iter()
            .enumerate()
            .map(|(ordinal, part)| {
                CompletionPart::Own(ModelPartRecord {
                    ordinal: ordinal as u64,
                    message_id: match &part {
                        maka_agent_facts::model::ModelPart::ToolCall { call } => {
                            maka_agent_facts::tool_call::tool_use_id(
                                "invocation",
                                &format!("step:{}", call.id),
                            )
                        }
                        _ => uuid::Uuid::new_v4().to_string(),
                    },
                    started_at: std::time::SystemTime::now(),
                    provider_part_id: None,
                    part: Arc::new(part),
                })
            })
            .collect(),
        finish_reason: maka_agent_facts::model::ModelFinishReason::ToolCalls,
        usage: Default::default(),
        provider_options: None,
        response_id: None,
        model: None,
        timestamp: None,
    }
}
async fn open_tool(store: &SessionStore) {
    open_model(store).await;
    append(
        store,
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: model_completion(vec![maka_agent_facts::model::ModelPart::ToolCall {
                call: maka_agent_facts::model::ModelToolCall {
                    id: "call".into(),
                    name: "Read".into(),
                    input: maka_agent_facts::model::ToolInput::Json(serde_json::json!({})),
                    provider_executed: false,
                    provider_options: None,
                },
            }]),
        },
    )
    .await;
    append(
        store,
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "step:call".into(),
            call: ToolCallIdentity::provider("step".into(), "call".into()),
            name: "Read".into(),
            input: serde_json::json!({}),
        },
    )
    .await;
}
fn row_image(width: u32, height: u32) -> Vec<u8> {
    let mut pixels = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for _ in 0..width {
            pixels.extend_from_slice(&[(y >> 8) as u8, y as u8, 71]);
        }
    }
    let mut encoded = Vec::new();
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(&pixels, width, height, image::ExtendedColorType::Rgb8)
        .unwrap();
    encoded
}

struct Fixture {
    directory: tempfile::TempDir,
    root: RootStore,
    log: Arc<SessionStore>,
    execution: SessionExecutionLease,
    selection: SemanticSelection,
    original: Vec<u8>,
}
impl Fixture {
    async fn new(tool: bool, width: u32, height: u32) -> Self {
        let (directory, root) = crate::test_support::root().await;
        let store = crate::test_support::session(&root, "session").await;
        let original = tokio::task::spawn_blocking(move || row_image(width, height))
            .await
            .unwrap();
        artifact(&store, "source-image", "image/png", original.clone(), tool).await;
        let through = if tool {
            open_tool(&store).await;
            let event = EventWrite::tool_success(
                "result".into(),
                std::time::SystemTime::now(),
                invocation(),
                "step:call".into(),
                ToolSuccess::projected(
                    ToolOutput::Json(json!({"source":"immutable image"})),
                    DurableToolProjection::Content {
                        parts: vec![ProjectionPart::Artifact {
                            image: ImageOutput {
                                detail: Some(ImageDetail::High),
                                mime_type: "image/png".into(),
                                reference: StorageRef::SessionFile {
                                    session_id: "session".into(),
                                    relative_path: "source-image".into(),
                                },
                            },
                        }],
                    },
                ),
            )
            .unwrap()
            .0;
            store.append(&event).await.unwrap()
        } else {
            append(&store, Fact::InvocationOpened { configuration: None, input: InvocationInput::Message {
                source_messages: Vec::new(), request_fingerprint: None,
                content: serde_json::from_value(json!({"text":"Describe the image", "attachments":[{"kind":"image","name":"source.png","mimeType":"image/png","bytes":original.len(),"ref":{"kind":"session_file","sessionId":"session","relativePath":"source-image"}}]})).unwrap(),
            }}).await
        };
        let execution = store.execution_scope(None).await.unwrap().accept();
        let log = Arc::new(execution.store());
        Self {
            directory,
            root,
            log,
            execution,
            original,
            selection: SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 0,
                through,
                before: u64::MAX,
                captured_through: through,
                replay: None,
                prior_unknown: false,
            },
        }
    }
    async fn capture(&self, provider: &ProviderConfig) -> PreparedPrompt {
        self.capture_with_resources(
            provider,
            ModelPreparationResources::new(Default::default()).unwrap(),
        )
        .await
    }
    async fn capture_with_resources(
        &self,
        provider: &ProviderConfig,
        resources: ModelPreparationResources,
    ) -> PreparedPrompt {
        let history = crate::history::prepare_view(
            &self.log,
            self.selection.clone(),
            Language::En,
            true,
            &provider.kind,
            &CancellationToken::new(),
            resources,
            0,
        )
        .await
        .unwrap();
        PreparedPrompt::from_history(history)
    }
    async fn unchanged(&self) {
        let mut original = Vec::new();
        loop {
            let chunk = self
                .log
                .read_artifact_chunk("session", "source-image", original.len() as u64, 32 * 1024)
                .await
                .unwrap()
                .unwrap();
            original.extend_from_slice(&chunk.bytes);
            if original.len() as u64 == chunk.total_bytes {
                break;
            }
            assert!(
                !chunk.bytes.is_empty(),
                "original artifact read must make progress"
            );
        }
        assert_eq!(content_digest(&original), content_digest(&self.original));
        assert_eq!(original, self.original);
    }
    async fn close(self) {
        let Self {
            directory,
            root,
            log,
            execution,
            ..
        } = self;
        drop(log);
        execution.finish();
        root.shutdown().await.unwrap();
        drop(directory);
    }
}

fn provider(kind: ProviderKind) -> ProviderConfig {
    ProviderConfig {
        adapter: None,
        capabilities: maka_agent_facts::configuration::ModelCapabilities {
            vision: None,
            ..Default::default()
        },
        image_input: None,
        network: Default::default(),
        kind,
        model: "fixture".into(),
        base_url: "https://example.invalid/v1".into(),
        auth: maka_model::ProviderAuth::ApiKey("fixture".into()),
        headers: Default::default(),
        body_overlay: None,
    }
}
async fn compile(prompt: &mut PreparedPrompt, provider: &ProviderConfig) {
    prompt
        .prepare_media(provider, &CancellationToken::new())
        .await
        .unwrap();
    prompt
        .compile_wire(
            Language::En,
            provider,
            &Value::Null,
            &[],
            &CancellationToken::new(),
        )
        .await
        .unwrap();
}
#[derive(Debug, PartialEq, Eq)]
struct View {
    bytes: Vec<u8>,
    mime: String,
}
async fn views(prompt: &PreparedPrompt) -> Vec<View> {
    let logical = prompt.model();
    let mut media = Vec::<MediaSource>::new();
    visit_images(logical.recipes().unwrap().as_ref(), &mut |_, source, _| {
        media.push(source);
        Ok(())
    })
    .await
    .unwrap();
    let work = prompt.resources().unwrap().acquire_work().await.unwrap();
    let mut result = Vec::new();
    for source in media {
        let mime = read_text(&source.media_type, work.budget()).await.unwrap();
        result.push(View {
            bytes: source_bytes(&source.bytes, work.budget()).await,
            mime,
        });
    }
    result
}
async fn source_bytes(source: &SourceBytes, budget: Arc<dyn SourceBudget>) -> Vec<u8> {
    let mut cursor = source.open(budget.clone());
    let mut buffer = budget.allocate(32 * 1024).await.unwrap();
    let mut bytes = Vec::new();
    loop {
        let read = cursor.read_chunk(buffer).await.unwrap();
        bytes.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            return bytes;
        }
        assert_ne!(read.bytes_read, 0, "captured media must make progress");
    }
}
fn assert_whole_tall_image(view: &View, dimensions: (u32, u32)) {
    let image = image::load_from_memory(&view.bytes).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), dimensions);
    assert!(
        image.get_pixel(0, 0)[0] < 8,
        "top of original remains in the whole-image view"
    );
    assert!(
        image.get_pixel(0, image.height() - 1)[0] > 160,
        "bottom of original remains; shrinking must not select only the first area"
    );
}
async fn wire_items(prompt: &PreparedPrompt) -> Vec<Vec<u8>> {
    let mut cursor = prompt.wire.as_ref().unwrap().open(0);
    let mut items = Vec::<Vec<u8>>::new();
    while let Some(chunk) = cursor.next().await.unwrap() {
        if chunk.item_start {
            items.push(Vec::new());
        }
        items
            .last_mut()
            .expect("wire item start precedes bytes")
            .extend_from_slice(&chunk.bytes);
    }
    items
}
fn encoded_images(value: &Value, output: &mut Vec<Vec<u8>>) {
    match value {
        Value::String(value) => {
            if let Some((prefix, encoded)) = value.split_once(";base64,")
                && prefix.starts_with("data:image/")
            {
                output.push(
                    base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .unwrap(),
                );
            }
        }
        Value::Array(values) => {
            for value in values {
                encoded_images(value, output);
            }
        }
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("image")
                && let Some(encoded) = object
                    .get("source")
                    .and_then(|source| source.get("data"))
                    .and_then(Value::as_str)
            {
                output.push(
                    base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .unwrap(),
                );
            }
            for value in object.values() {
                encoded_images(value, output);
            }
        }
        _ => {}
    }
}
async fn request_size(prompt: &PreparedPrompt, provider: &ProviderConfig) -> u64 {
    ModelRequest {
        language: Language::En,
        provider: provider.clone(),
        prompt: prompt.model(),
        tools: Vec::new(),
        provider_options: Value::Null,
        max_output_tokens: Some(1024),
    }
    .encoded_request_sizes()
    .await
    .unwrap()
    .largest()
}

#[tokio::test]
async fn captured_user_and_tool_images_share_one_whole_view_across_protocols_and_replay() {
    let mut expected = None;
    for tool in [false, true] {
        let fixture = Fixture::new(tool, WIDTH, HEIGHT).await;
        for kind in [
            ProviderKind::OpenaiChatCompletions,
            ProviderKind::OpenaiResponses,
            ProviderKind::Anthropic,
        ] {
            let provider = provider(kind);
            let mut prompt = fixture.capture(&provider).await;
            compile(&mut prompt, &provider).await;
            let actual = views(&prompt).await;
            assert_eq!(actual.len(), 1, "one source produces one whole-image view");
            assert_eq!(actual[0].mime, "image/png");
            assert_whole_tall_image(&actual[0], (17, 2000));
            if let Some(expected) = &expected {
                assert_eq!(&actual, expected);
            } else {
                expected = Some(actual);
            }
            let wire = wire_items(&prompt).await;
            let mut encoded = Vec::new();
            for item in &wire {
                encoded_images(
                    &serde_json::from_slice::<Value>(item).unwrap(),
                    &mut encoded,
                );
            }
            assert_eq!(encoded, vec![expected.as_ref().unwrap()[0].bytes.clone()]);
            let count = request_size(&prompt, &provider).await;
            assert_eq!(
                prompt
                    .media_view
                    .as_ref()
                    .unwrap()
                    .decoded_jobs
                    .load(std::sync::atomic::Ordering::Relaxed),
                1,
                "one source is decoded once for the frozen whole-image view"
            );
            assert_eq!(
                wire_items(&prompt).await,
                wire,
                "replay reads the same frozen encoding"
            );
            prompt
                .compile_wire(
                    Language::En,
                    &provider,
                    &Value::Null,
                    &[],
                    &CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(wire_items(&prompt).await, wire);
            assert_eq!(request_size(&prompt, &provider).await, count);
            assert_eq!(
                prompt
                    .media_view
                    .as_ref()
                    .unwrap()
                    .decoded_jobs
                    .load(std::sync::atomic::Ordering::Relaxed),
                1,
                "count/send/replay must reuse prepared bytes"
            );
            fixture.unchanged().await;
            prompt.close().await.unwrap();
            drop(prompt);
        }
        fixture.close().await;
    }
}

#[tokio::test]
async fn unknown_gateway_preserves_an_image_already_within_the_whole_image_bounds() {
    for tool in [false, true] {
        let fixture = Fixture::new(tool, 39, 45).await;
        let provider = provider(ProviderKind::OpenaiCompatible {
            name: "unknown-gateway".into(),
        });
        let mut prompt = fixture.capture(&provider).await;
        compile(&mut prompt, &provider).await;
        let actual = views(&prompt).await;
        assert_eq!(
            actual,
            vec![View {
                bytes: fixture.original.clone(),
                mime: "image/png".into()
            }]
        );
        fixture.unchanged().await;
        prompt.close().await.unwrap();
        drop(prompt);
        fixture.close().await;
    }
}

#[tokio::test]
async fn declared_minimums_above_fallback_prepare_a_captured_whole_image() {
    let fixture = Fixture::new(false, 4000, 4000).await;
    let mut provider = provider(ProviderKind::OpenaiChatCompletions);
    provider.image_input = Some(ImageInput {
        min_width: Some(3000),
        min_height: Some(3000),
        ..Default::default()
    });
    let mut prompt = fixture.capture(&provider).await;
    compile(&mut prompt, &provider).await;
    let actual = views(&prompt).await;
    assert_eq!(actual.len(), 1);
    let image = image::load_from_memory(&actual[0].bytes).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), (3000, 3000));
    assert_eq!(image.get_pixel(0, 0)[0], 0);
    assert!(
        image.get_pixel(0, 2999)[0] >= 14,
        "the minimum-sized result retains the bottom of the original"
    );
    fixture.unchanged().await;
    prompt.close().await.unwrap();
    drop(prompt);
    fixture.close().await;
}

#[test]
fn fallback_dimensions_yield_to_real_minimums_on_both_aspect_axes() {
    let square = codec::Geometry {
        width: 4000,
        height: 4000,
    };
    let tall = codec::Geometry {
        width: 4000,
        height: 8000,
    };
    for (original, limits, expected) in [
        (
            square,
            ImageInput {
                min_width: Some(3000),
                min_height: Some(3000),
                ..Default::default()
            },
            codec::Geometry {
                width: 3000,
                height: 3000,
            },
        ),
        (
            tall,
            ImageInput {
                min_width: Some(3000),
                ..Default::default()
            },
            codec::Geometry {
                width: 3000,
                height: 6000,
            },
        ),
        (
            tall,
            ImageInput {
                min_height: Some(3000),
                ..Default::default()
            },
            codec::Geometry {
                width: 1500,
                height: 3000,
            },
        ),
        (
            tall,
            ImageInput {
                min_width: Some(3000),
                max_height: Some(7000),
                ..Default::default()
            },
            codec::Geometry {
                width: 3000,
                height: 6000,
            },
        ),
        (
            tall,
            ImageInput {
                min_width: Some(3000),
                max_width: Some(3500),
                ..Default::default()
            },
            codec::Geometry {
                width: 3000,
                height: 6000,
            },
        ),
        (
            tall,
            ImageInput {
                min_width: Some(1000),
                ..Default::default()
            },
            codec::Geometry {
                width: 1000,
                height: 2000,
            },
        ),
        (
            codec::Geometry {
                width: 8000,
                height: 4000,
            },
            ImageInput {
                min_height: Some(3000),
                ..Default::default()
            },
            codec::Geometry {
                width: 6000,
                height: 3000,
            },
        ),
    ] {
        assert_eq!(
            geometry(original, &limits).unwrap(),
            expected,
            "original {original:?}, declarations {limits:?}"
        );
        assert!(
            expected.width <= original.width && expected.height <= original.height,
            "minimum declarations cannot authorize upscaling"
        );
    }
    assert!(
        geometry(
            tall,
            &ImageInput {
                min_width: Some(3000),
                max_height: Some(5000),
                ..Default::default()
            }
        )
        .is_err(),
        "an actual maximum may make the aspect-preserving minimum impossible"
    );
    assert!(
        geometry(
            square,
            &ImageInput {
                min_width: Some(4001),
                ..Default::default()
            }
        )
        .is_err(),
        "an undersized original is not upscaled"
    );
}

#[test]
fn byte_fitting_stops_at_actual_minimums_instead_of_fallback_dimensions() {
    let original = codec::Geometry {
        width: 4000,
        height: 8000,
    };
    let limits = ImageInput {
        min_width: Some(3000),
        max_height: Some(7000),
        ..Default::default()
    };
    let minimum = codec::Geometry {
        width: 3000,
        height: 6000,
    };
    assert_eq!(
        smaller_geometry(
            original,
            codec::Geometry {
                width: 3500,
                height: 7000
            },
            &limits
        ),
        Some(minimum)
    );
    assert_eq!(smaller_geometry(original, minimum, &limits), None);
    let square = codec::Geometry {
        width: 4000,
        height: 4000,
    };
    let limits = ImageInput {
        min_width: Some(3000),
        min_height: Some(3000),
        ..Default::default()
    };
    assert_eq!(
        smaller_geometry(
            square,
            codec::Geometry {
                width: 3500,
                height: 3500
            },
            &limits
        ),
        Some(codec::Geometry {
            width: 3000,
            height: 3000
        })
    );
    assert_eq!(
        smaller_geometry(
            codec::Geometry {
                width: 390,
                height: 45480
            },
            codec::Geometry {
                width: 1,
                height: 2
            },
            &ImageInput::default()
        ),
        Some(codec::Geometry {
            width: 1,
            height: 1
        }),
        "unknown minimums retain the existing one-pixel termination boundary"
    );
}

#[tokio::test]
async fn actual_route_dimensions_replace_fallback_bounds_and_keep_the_entire_image() {
    let fixture = Fixture::new(false, WIDTH, HEIGHT).await;
    let mut provider = provider(ProviderKind::OpenaiChatCompletions);
    provider.image_input = Some(ImageInput {
        max_width: Some(8192),
        max_height: Some(8192),
        ..Default::default()
    });
    let mut prompt = fixture.capture(&provider).await;
    compile(&mut prompt, &provider).await;
    let actual = views(&prompt).await;
    assert_eq!(actual.len(), 1);
    assert_whole_tall_image(&actual[0], (70, 8192));
    fixture.unchanged().await;
    prompt.close().await.unwrap();
    drop(prompt);
    fixture.close().await;
}

#[tokio::test]
async fn exact_mime_declaration_reencodes_the_whole_image_without_changing_original() {
    let fixture = Fixture::new(false, 39, 45).await;
    let mut provider = provider(ProviderKind::OpenaiChatCompletions);
    provider.image_input = Some(ImageInput {
        mime_types: Some(vec!["image/jpeg".into()]),
        ..Default::default()
    });
    let mut prompt = fixture.capture(&provider).await;
    compile(&mut prompt, &provider).await;
    let actual = views(&prompt).await;
    assert_eq!(actual.len(), 1);
    assert_eq!(actual[0].mime, "image/jpeg");
    assert_eq!(
        image::guess_format(&actual[0].bytes).unwrap(),
        image::ImageFormat::Jpeg
    );
    assert_eq!(
        image::load_from_memory(&actual[0].bytes)
            .unwrap()
            .dimensions(),
        (39, 45)
    );
    fixture.unchanged().await;
    prompt.close().await.unwrap();
    drop(prompt);
    fixture.close().await;
}

#[tokio::test]
async fn known_per_image_byte_limit_shrinks_one_whole_image() {
    let fixture = Fixture::new(false, WIDTH, HEIGHT).await;
    let mut provider = provider(ProviderKind::OpenaiChatCompletions);
    provider.image_input = Some(ImageInput {
        max_bytes: Some(512),
        ..Default::default()
    });
    let mut prompt = fixture.capture(&provider).await;
    compile(&mut prompt, &provider).await;
    let actual = views(&prompt).await;
    assert_eq!(actual.len(), 1);
    assert!(actual[0].bytes.len() <= 512);
    let image = image::load_from_memory(&actual[0].bytes).unwrap().to_rgb8();
    assert!(image.width() <= 17 && image.height() <= 2000);
    assert_whole_tall_image(&actual[0], image.dimensions());
    fixture.unchanged().await;
    prompt.close().await.unwrap();
    drop(prompt);
    fixture.close().await;
}

#[tokio::test]
async fn complete_request_limit_shrinks_the_whole_image_and_preserves_replay() {
    let fixture = Fixture::new(false, WIDTH, HEIGHT).await;
    for kind in [
        ProviderKind::OpenaiChatCompletions,
        ProviderKind::OpenaiResponses,
        ProviderKind::Anthropic,
    ] {
        let mut provider = provider(kind);
        let mut measured = fixture.capture(&provider).await;
        compile(&mut measured, &provider).await;
        let initial_size = request_size(&measured, &provider).await;
        let original_view = views(&measured).await;
        assert_eq!(original_view.len(), 1);
        measured.close().await.unwrap();
        drop(measured);

        let limit = initial_size - 100;
        provider.image_input = Some(ImageInput {
            request_bytes: Some(limit),
            ..Default::default()
        });
        // The actual route declaration must exist before admission, including
        // when the initial image view would otherwise be a passthrough.
        let mut prompt = fixture.capture(&provider).await;
        compile(&mut prompt, &provider).await;
        assert!(request_size(&prompt, &provider).await > limit);
        prompt
            .fit_image_request(
                Language::En,
                &provider,
                &Value::Null,
                &[],
                Some(1024),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let request = ModelRequest {
            language: Language::En,
            provider: provider.clone(),
            prompt: prompt.model(),
            tools: Vec::new(),
            provider_options: Value::Null,
            max_output_tokens: Some(1024),
        };
        let sizes = request.encoded_request_sizes().await.unwrap();
        assert!(sizes.http <= limit);
        assert!(sizes.websocket.is_none_or(|bytes| bytes <= limit));
        drop(request);
        let fitted = views(&prompt).await;
        assert_eq!(
            fitted.len(),
            original_view.len(),
            "whole-request fitting cannot remove image parts"
        );
        let image = image::load_from_memory(&fitted[0].bytes).unwrap();
        assert!(
            image.width() < 17 || image.height() < 2000,
            "a smaller whole-image candidate must satisfy the declared request cap"
        );
        assert_whole_tall_image(&fitted[0], image.dimensions());
        let wire = wire_items(&prompt).await;
        assert!(
            String::from_utf8(wire.concat())
                .unwrap()
                .contains("Describe the image"),
            "non-image request text must survive fitting"
        );
        let mut encoded = Vec::new();
        for item in &wire {
            encoded_images(
                &serde_json::from_slice::<Value>(item).unwrap(),
                &mut encoded,
            );
        }
        assert_eq!(encoded, vec![fitted[0].bytes.clone()]);
        assert_eq!(
            wire_items(&prompt).await,
            wire,
            "upload replay uses the selected frozen candidate"
        );
        prompt
            .fit_image_request(
                Language::En,
                &provider,
                &Value::Null,
                &[],
                Some(1024),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(views(&prompt).await, fitted);
        assert_eq!(wire_items(&prompt).await, wire);
        fixture.unchanged().await;
        prompt.close().await.unwrap();
        drop(prompt);
    }
    fixture.close().await;
}

#[tokio::test]
async fn irreducible_request_overhead_returns_typed_payload_error_without_dropping_image() {
    let fixture = Fixture::new(false, 1, 1).await;
    let mut provider = provider(ProviderKind::OpenaiResponses);
    provider.image_input = Some(ImageInput {
        request_bytes: Some(1),
        min_width: Some(1),
        min_height: Some(1),
        ..Default::default()
    });
    let mut prompt = fixture.capture(&provider).await;
    compile(&mut prompt, &provider).await;
    let before = views(&prompt).await;
    assert_eq!(before.len(), 1);
    assert_eq!(
        image::load_from_memory(&before[0].bytes)
            .unwrap()
            .dimensions(),
        (1, 1)
    );
    let size = request_size(&prompt, &provider).await;
    assert!(size > 1);
    let result = prompt
        .fit_image_request(
            Language::En,
            &provider,
            &Value::Null,
            &[],
            Some(1024),
            &CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(result, Err(RunError::Model(maka_model::ModelError::ImageInputPayloadTooLarge { bytes, limit: 1 })) if bytes == size)
    );
    assert_eq!(
        views(&prompt).await,
        before,
        "irreducible full-body overhead cannot be hidden by removing an image"
    );
    fixture.unchanged().await;
    prompt.close().await.unwrap();
    drop(prompt);
    fixture.close().await;
}

#[tokio::test]
async fn unsupported_route_input_fails_without_silently_dropping_original_media() {
    let fixture = Fixture::new(false, 39, 45).await;
    for limits in [
        None,
        Some(ImageInput {
            mime_types: Some(vec!["image/svg+xml".into()]),
            ..Default::default()
        }),
    ] {
        let mut provider = provider(ProviderKind::OpenaiChatCompletions);
        provider.capabilities.vision = if limits.is_none() {
            Some(false)
        } else {
            Some(true)
        };
        provider.image_input = limits;
        let mut prompt = fixture.capture(&provider).await;
        assert!(
            prompt
                .prepare_media(&provider, &CancellationToken::new())
                .await
                .is_err()
        );
        let actual = views(&prompt).await;
        assert_eq!(actual.len(), 1);
        assert_eq!(actual[0].bytes, fixture.original);
        prompt.close().await.unwrap();
        drop(prompt);
    }
    fixture.unchanged().await;
    fixture.close().await;
}

#[tokio::test]
async fn long_image_cannot_decode_before_its_complete_peak_is_admitted() {
    let fixture = Fixture::new(false, WIDTH, HEIGHT).await;
    let provider = provider(ProviderKind::OpenaiChatCompletions);
    let resources =
        ModelPreparationResources::new(maka_capabilities::model_preparation::PreparationPolicy {
            resident_bytes: 32 * 1024 * 1024,
            ..Default::default()
        })
        .unwrap();
    let mut prompt = fixture.capture_with_resources(&provider, resources).await;
    prompt
        .prepare_media(&provider, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        prompt
            .media_view
            .as_ref()
            .unwrap()
            .decoded_jobs
            .load(std::sync::atomic::Ordering::Relaxed),
        0
    );
    let result = prompt
        .compile_wire(
            Language::En,
            &provider,
            &Value::Null,
            &[],
            &CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(result, Err(RunError::Preparation(_))),
        "the admitted peak must include the original decoded image, not just its tiny output"
    );
    assert_eq!(
        prompt
            .media_view
            .as_ref()
            .unwrap()
            .decoded_jobs
            .load(std::sync::atomic::Ordering::Relaxed),
        0,
        "rejected admission cannot start an uncharged decoder worker"
    );
    fixture.unchanged().await;
    prompt.close().await.unwrap();
    drop(prompt);
    fixture.close().await;
}

struct EncodingStartedWriter<'a, W> {
    writer: &'a mut W,
    started: Option<tokio::sync::oneshot::Sender<()>>,
    resume: std::sync::mpsc::Receiver<()>,
    fail_after_start: bool,
}
impl<W: Write> Write for EncodingStartedWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.writer.write(bytes)?;
        if let Some(started) = self.started.take() {
            assert!(written > 0, "codec output must reach the physical arena");
            started.send(()).unwrap();
            self.resume.recv().unwrap();
            if self.fail_after_start {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "encoding writer failed after its first output",
                ));
            }
        }
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

#[tokio::test]
async fn cancellation_after_png_and_jpeg_output_starts_physically_drains_and_keeps_io_errors() {
    let fixture = Fixture::new(false, 128, 128).await;
    let provider = provider(ProviderKind::OpenaiChatCompletions);
    for format in [image::ImageFormat::Png, image::ImageFormat::Jpeg] {
        for fail_after_start in [false, true] {
            let prompt = fixture.capture(&provider).await;
            let probe = codec::probe(&fixture.original).unwrap();
            let plan =
                codec::plan_format(&probe, fixture.original.len(), probe.geometry, format).unwrap();
            let cancellation = CancellationToken::new();
            prompt
                .promote(prompt.resident_bytes() + plan.peak_bytes, &cancellation)
                .await
                .unwrap();
            let lease = prompt.active().unwrap().directory(plan.peak_bytes).unwrap();
            let arena = prompt.arena().unwrap().clone();
            arena.promote_to_file().await.unwrap();
            let encoded = fixture.original.clone();
            let token = cancellation.clone();
            let (started, entered) = tokio::sync::oneshot::channel();
            let (resume, wait) = std::sync::mpsc::channel();
            let worker = tokio::spawn(async move {
                arena
                    .with_writer(move |writer| {
                        let _lease = lease;
                        let image = codec::decode(&encoded, &plan).unwrap();
                        let mut observed = EncodingStartedWriter {
                            writer,
                            started: Some(started),
                            resume: wait,
                            fail_after_start,
                        };
                        Ok(image.write_image(
                            probe.geometry,
                            format,
                            &mut CancelWriter {
                                writer: &mut observed,
                                cancellation: &token,
                            },
                        ))
                    })
                    .await
            });
            entered.await.unwrap();
            cancellation.cancel();
            let closing = prompt.close();
            tokio::pin!(closing);
            assert!(
                futures_util::poll!(&mut closing).is_pending(),
                "close must wait for the physical encoder worker after output starts"
            );
            resume.send(()).unwrap();
            let result = worker
                .await
                .unwrap()
                .unwrap()
                .map_err(RunError::preparation);
            if fail_after_start {
                assert!(
                    matches!(result, Err(RunError::Preparation(ref error)) if error.kind() == io::ErrorKind::PermissionDenied && error.to_string().contains("encoding writer failed")),
                    "simultaneous cancellation must not replace the actual writer error: {result:?}"
                );
            } else {
                assert!(
                    matches!(result, Err(RunError::Cancelled)),
                    "the typed non-retryable cancellation must survive both codecs and worker return: {result:?}"
                );
            }
            closing.await.unwrap();
        }
    }
    fixture.unchanged().await;
    fixture.close().await;
}
