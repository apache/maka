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
use crate::{history::test_support as canonical, preparation};
use base64::Engine;
use image::{GenericImageView, ImageEncoder};
use maka_agent_facts::{
    artifact::{
        Artifact, ArtifactKind, ArtifactSource, PublishedArtifact, ToolReturn, content_digest,
        upload_artifact_id,
    },
    attachment::StorageRef,
    durable::{ContentRef, ExecutionIdentity, Fact, SCHEMA_VERSION, UnixMillis},
    input::MessageInput,
    language::Language,
    model::prompt_source::source::MediaSource,
    tool_output::{
        DurableToolProjection, ImageDetail, ProjectionPart, ReturnedToolResult, ToolSuccess,
    },
};
use maka_agent_state::{
    Change, ContentBlob, Store,
    artifacts::{ArtifactReadScope, ArtifactScope, ArtifactStore, SessionScope, Upload},
};
use maka_event_log::root_store::{RootStore, SessionStore, SessionWorkLease, WorkEffects};
use maka_model::{ModelPreparationResources, ModelRequest, ProviderKind, prompt::Message};
use serde_json::{Value, json};
use std::sync::Mutex;

const WIDTH: u32 = 390;
const HEIGHT: u32 = 45480;

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
    execution: SessionWorkLease,
    effects: WorkEffects,
    state: Store,
    artifacts: ArtifactStore,
    scope: SessionScope,
    tool: Option<(ArtifactScope, ContentRef)>,
    id: String,
    input: MessageInput,
    original: Vec<u8>,
}
impl Fixture {
    async fn new(tool: bool, width: u32, height: u32) -> Self {
        Self::with_images(tool, width, height, 1).await
    }
    async fn with_images(tool: bool, width: u32, height: u32, images: usize) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = canonical::open(directory.path(), false).await;
        root.create_session("session", "fixture", &json!({}), 1)
            .await
            .unwrap();
        let (log, execution, effects) = canonical::work(&root).await;
        let state = canonical::state(&root);
        let artifacts = ArtifactStore::new(root.data_writer().unwrap());
        let scope = SessionScope {
            owner: canonical::owner(),
            session: "session".into(),
        };
        let original = tokio::task::spawn_blocking(move || row_image(width, height))
            .await
            .unwrap();
        let (id, tool) = if tool {
            let (run, key) = canonical::admit_tool(&state).await;
            let mut normalized = ToolSuccess::image(
                original.clone(),
                "image/png".into(),
                Some(ImageDetail::High),
            )
            .unwrap()
            .into_durable(
                "fixture-result",
                std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1),
                &ExecutionIdentity {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: run,
                },
            )
            .unwrap();
            let DurableToolProjection::Content { parts } = &mut normalized.projection else {
                panic!("image must normalize to immutable projection")
            };
            let image_index = parts
                .iter()
                .position(|part| matches!(part, ProjectionPart::Artifact { .. }))
                .expect("normalized image artifact");
            let image = parts[image_index].clone();
            parts.splice(
                image_index..=image_index,
                std::iter::repeat_n(image, images),
            );
            let id = normalized.artifacts[0].artifact().id.clone();
            let published = normalized
                .artifacts
                .iter()
                .map(|write| {
                    let evidence = write.evidence();
                    PublishedArtifact {
                        artifact: write.artifact().clone(),
                        payload: ContentRef {
                            digest: evidence.digest,
                            bytes: evidence.bytes,
                        },
                    }
                })
                .collect();
            let blob = ContentBlob::json(&ToolReturn {
                schema_version: SCHEMA_VERSION,
                artifacts: published,
                body: ReturnedToolResult {
                    output: normalized.output,
                    projection: normalized.projection,
                    loaded_tools: normalized.loaded_tools,
                    is_error: normalized.is_error,
                },
            })
            .unwrap();
            let commit = state
                .observe_artifacts(
                    run,
                    vec![Change::new(
                        Fact::LocalToolReturned {
                            tool: key,
                            settlement: maka_agent_facts::tool_call::ToolSettlement::Returned,
                            result: blob.reference().clone(),
                            is_error: false,
                        },
                        UnixMillis(3),
                    )],
                    vec![blob.clone()],
                    normalized.artifacts,
                )
                .await
                .unwrap();
            (
                id,
                Some((
                    ArtifactScope {
                        owner: scope.owner.clone(),
                        session: scope.session.clone(),
                        run,
                        through: commit.head.revision,
                    },
                    blob.reference().clone(),
                )),
            )
        } else {
            let id = upload_artifact_id("session", "source-image");
            artifacts
                .upload(Upload::new(
                    scope.clone(),
                    "fixture-upload".into(),
                    "source-image".into(),
                    Artifact {
                        id: id.clone(),
                        session_id: "session".into(),
                        turn_id: id.clone(),
                        created_at: 1,
                        name: "source.png".into(),
                        kind: ArtifactKind::Image,
                        size_bytes: original.len() as u64,
                        mime_type: Some("image/png".into()),
                        source: ArtifactSource::UserUpload,
                        summary: Some(content_digest(&original)),
                    },
                    original.clone(),
                ))
                .await
                .unwrap();
            (id, None)
        };
        let input = serde_json::from_value(json!({"text":"Describe the image", "attachments":vec![json!({"kind":"image","name":"source.png","mimeType":"image/png","bytes":original.len(),"ref":{"kind":"session_file","sessionId":"session","relativePath":id}}); images]})).unwrap();
        Self {
            directory,
            root,
            log,
            execution,
            effects,
            state,
            artifacts,
            scope,
            tool,
            id,
            input,
            original,
        }
    }
    async fn returned(&self) -> ToolReturn<ReturnedToolResult> {
        let (scope, reference) = self.tool.as_ref().expect("tool fixture");
        let bytes = self
            .state
            .content(scope.run, reference.clone())
            .await
            .unwrap();
        let returned: ToolReturn<ReturnedToolResult> = serde_json::from_slice(&bytes).unwrap();
        returned.validate().unwrap();
        returned
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
        _provider: &ProviderConfig,
        resources: ModelPreparationResources,
    ) -> PreparedPrompt {
        let cancellation = CancellationToken::new();
        let messages = if let Some((scope, _)) = &self.tool {
            let returned = self.returned().await;
            let output = preparation::project_returned_tool(
                &self.artifacts,
                scope,
                &returned.body,
                Language::En,
                true,
                &resources,
                &cancellation,
            )
            .await
            .unwrap();
            vec![
                Message::user("prior"),
                Message::Assistant {
                    content: vec![maka_model::prompt::AssistantPart::ToolCall {
                        tool_call_id: "call".into(),
                        tool_name: "Read".into(),
                        input: maka_agent_facts::model::ToolInput::Json(json!({})),
                        provider_executed: None,
                        provider_options: None,
                    }],
                    provider_options: None,
                },
                Message::tool("call", "Read", output),
            ]
        } else {
            vec![
                preparation::project_input(
                    &self.artifacts,
                    &self.scope,
                    &self.input,
                    Language::En,
                    true,
                    false,
                    None,
                    &resources,
                    &cancellation,
                )
                .await
                .unwrap(),
            ]
        };
        canonical::capture(&self.log, messages, resources).await
    }
    fn read_scope(&self) -> ArtifactReadScope {
        match &self.tool {
            Some((scope, _)) => scope.clone().into(),
            None => self.scope.clone().into(),
        }
    }
    async fn unchanged(&self) {
        let mut original = Vec::new();
        loop {
            let chunk = self
                .artifacts
                .chunk(
                    self.read_scope(),
                    self.id.clone(),
                    original.len() as u64,
                    32 * 1024,
                )
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
            effects,
            ..
        } = self;
        drop(log);
        effects.settle().await.unwrap();
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
        operation: maka_agent_facts::context::ModelOperation::Inference,
        language: Language::En,
        provider: provider.clone(),
        prompt: prompt.model(),
        tools: Vec::new(),
        tool_choice: Default::default(),
        provider_options: Value::Null,
        max_output_tokens: Some(1024),
    }
    .encoded_request_sizes()
    .await
    .unwrap()
    .largest()
}

#[tokio::test]
async fn canonical_tool_artifacts_require_the_original_run_cut_and_complete_typed_return() {
    let fixture = Fixture::new(true, 8, 8).await;
    let (scope, reference) = fixture.tool.as_ref().unwrap();
    let bytes = fixture
        .state
        .content(scope.run, reference.clone())
        .await
        .unwrap();
    let returned: ToolReturn<ReturnedToolResult> = serde_json::from_slice(&bytes).unwrap();
    returned.validate().unwrap();
    let captured = fixture
        .artifacts
        .with_content(scope.clone(), fixture.id.clone(), |_, reader| {
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(reader, &mut bytes).unwrap();
            bytes
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(captured, fixture.original);
    assert!(
        serde_json::from_slice::<ToolReturn<ReturnedToolResult>>(&bytes[..bytes.len() - 1])
            .is_err()
    );
    let mut foreign = scope.clone();
    foreign.session = "foreign-session".into();
    assert!(
        fixture
            .artifacts
            .get(foreign, fixture.id.clone())
            .await
            .is_err()
    );
    let mut earlier = scope.clone();
    earlier.through -= 1;
    assert!(
        fixture
            .artifacts
            .get(earlier, fixture.id.clone())
            .await
            .unwrap()
            .is_none()
    );
    let mut future = scope.clone();
    future.through += 1;
    assert!(
        fixture
            .artifacts
            .get(future, fixture.id.clone())
            .await
            .is_err()
    );
    let other = canonical::admit(&fixture.state, "other Run".into()).await;
    let mut unrelated = scope.clone();
    unrelated.run = other;
    unrelated.through = 1;
    assert!(
        fixture
            .artifacts
            .get(unrelated, fixture.id.clone())
            .await
            .unwrap()
            .is_none()
    );
    let mut altered = returned.body;
    let DurableToolProjection::Content { parts } = &mut altered.projection else {
        panic!("content projection")
    };
    let Some(ProjectionPart::Artifact { image }) = parts
        .iter_mut()
        .find(|part| matches!(part, ProjectionPart::Artifact { .. }))
    else {
        panic!("image projection")
    };
    image.reference = StorageRef::SessionFile {
        session_id: "session".into(),
        relative_path: "forged-artifact".into(),
    };
    assert!(
        preparation::project_returned_tool(
            &fixture.artifacts,
            scope,
            &altered,
            Language::En,
            true,
            &ModelPreparationResources::new(Default::default()).unwrap(),
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    fixture.unchanged().await;
    fixture.close().await;
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
            operation: maka_agent_facts::context::ModelOperation::Inference,
            language: Language::En,
            provider: provider.clone(),
            prompt: prompt.model(),
            tools: Vec::new(),
            tool_choice: Default::default(),
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

enum ImageInterruption {
    Cancel(CancellationToken),
    ReadFailure,
}
struct InterruptImage {
    source: SourceBytes,
    interruption: Mutex<Option<ImageInterruption>>,
}
impl ByteSource for InterruptImage {
    fn len(&self) -> Option<u64> {
        self.source.len()
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        let interruption = self.interruption.lock().unwrap().take();
        match interruption {
            Some(ImageInterruption::Cancel(cancellation)) => {
                cancellation.cancel();
                self.source.open(budget)
            }
            Some(ImageInterruption::ReadFailure) => Box::new(FailedImageRead),
            None => self.source.open(budget),
        }
    }
}
struct FailedImageRead;
impl ByteCursor for FailedImageRead {
    fn read_chunk(&mut self, _buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "one image read failed",
            ))
        })
    }
}
async fn interrupt_image_inputs(prompt: &mut PreparedPrompt) -> Vec<Arc<InterruptImage>> {
    let original = prompt.body.clone();
    let base = original.recipes().unwrap().clone();
    let mut images = Vec::new();
    visit_images(base.as_ref(), &mut |key, media, options| {
        images.push((key, media, options));
        Ok(())
    })
    .await
    .unwrap();
    let mut inputs = Vec::new();
    let mut replacements = BTreeMap::new();
    for (key, mut media, options) in images {
        let input = Arc::new(InterruptImage {
            source: media.bytes,
            interruption: Mutex::new(None),
        });
        media.bytes = SourceBytes::Source(input.clone());
        replacements.insert(
            key,
            source::Replacement {
                part: ContentRecipe::Media {
                    media,
                    provider_options: options,
                },
            },
        );
        inputs.push(input);
    }
    let identity = original.identity().to_owned();
    let mapped = source::mapped(base, Arc::new(replacements), identity.clone(), Arc::new(()));
    prompt.body = maka_model::prompt::Prompt::from_recipes(
        mapped,
        identity,
        original.len(),
        original.breakdown().clone(),
    )
    .with_instructions_from(&original);
    if let Some(normalization) = original.normalization() {
        prompt.body = prompt
            .body
            .clone()
            .with_normalization(normalization.clone());
    }
    prompt.rebuild_recipes();
    inputs
}

#[tokio::test]
async fn partial_image_failure_and_cancellation_resume_materialization_with_a_fresh_token() {
    let fixture = Fixture::with_images(false, 128, 128, 2).await;
    let mut provider = provider(ProviderKind::OpenaiChatCompletions);
    provider.image_input = Some(ImageInput {
        max_width: Some(64),
        max_height: Some(64),
        ..Default::default()
    });
    for cancel in [false, true] {
        let mut prompt = fixture.capture(&provider).await;
        let inputs = interrupt_image_inputs(&mut prompt).await;
        assert_eq!(inputs.len(), 2);
        let cancellation = CancellationToken::new();
        prompt
            .prepare_media(&provider, &cancellation)
            .await
            .unwrap();
        *inputs[1].interruption.lock().unwrap() = Some(if cancel {
            ImageInterruption::Cancel(cancellation.clone())
        } else {
            ImageInterruption::ReadFailure
        });
        let peak = prompt.resident_bytes();
        let result = prompt.promote(peak, &cancellation).await;
        if cancel {
            assert!(matches!(result, Err(RunError::Cancelled)));
        } else {
            assert!(
                matches!(result, Err(RunError::Preparation(ref error)) if error.to_string().contains("one image read failed"))
            );
        }
        {
            let logical = prompt.model();
            let mut outputs = Vec::new();
            visit_images(logical.recipes().unwrap().as_ref(), &mut |_, media, _| {
                outputs.push(media.bytes);
                Ok(())
            })
            .await
            .unwrap();
            let work = prompt.resources().unwrap().acquire_work().await.unwrap();
            let mut cursor = outputs[0].open(work.budget());
            let read = cursor
                .read_chunk(work.budget().allocate(64).await.unwrap())
                .await;
            assert!(
                matches!(read, Err(ref error) if error.kind() == io::ErrorKind::WouldBlock),
                "a completed image remains unpublished until the whole view is sealed"
            );
        }

        *inputs[0].interruption.lock().unwrap() = Some(ImageInterruption::ReadFailure);
        let retry = CancellationToken::new();
        prompt.promote(peak, &retry).await.unwrap();
        let actual = views(&prompt).await;
        assert_eq!(actual.len(), 2);
        for view in &actual {
            let image = image::load_from_memory(&view.bytes).unwrap().to_rgb8();
            assert_eq!(image.dimensions(), (64, 64));
            assert!(image.get_pixel(0, 0)[1] < 4);
            assert!(image.get_pixel(0, 63)[1] > 120);
        }
        prompt.close().await.unwrap();
        drop(prompt);
        drop(inputs);
    }
    fixture.unchanged().await;
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
