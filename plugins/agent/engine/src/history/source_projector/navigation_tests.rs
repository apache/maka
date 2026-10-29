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
use maka_agent_facts::history::semantic::directory::{PayloadDirectory, RowDirectory};
use maka_agent_facts::{
    artifact::{Artifact, ArtifactKind, ArtifactSource},
    attachment::StorageRef,
    event::{EventWrite, Fact, Invocation, RuntimeEvent},
    input::InvocationInput,
    tool_call::ToolCallIdentity,
    tool_output::{
        AudioOutput, DurableToolProjection, ImageDetail, ImageOutput, ProjectionPart, ToolOutput,
        ToolSuccess,
    },
};
use maka_event_log::{
    context::semantic::{CapturedSource, PayloadSource, SemanticSelection},
    root_store::SessionStore,
};

fn invocation() -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    }
}
async fn artifact(store: &SessionStore, id: &str, mime: &str, body: Vec<u8>) {
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
                source: ArtifactSource::UserUpload,
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
async fn capture(store: &SessionStore, through: u64) -> CapturedSource {
    store
        .capture_source(SemanticSelection {
            session: "session".into(),
            lineage: None,
            after: 0,
            through,
            before: through + 1,
            captured_through: through,
            replay: None,
            prior_unknown: false,
        })
        .await
        .unwrap()
}
async fn row(
    source: &CapturedSource,
    kind: &str,
    budget: &Arc<dyn SourceBudget>,
) -> (RowDirectory, PayloadSource, PayloadSource, PayloadDirectory) {
    let mut after = None;
    let mut buffer = budget.allocate(32 * 1024).await.unwrap();
    loop {
        let mut page = source.directory_page(after, buffer).await.unwrap();
        while let Some(entry) = page.next_row().unwrap() {
            let selected = matches!(
                (kind, entry.directory),
                ("User", RowDirectory::User { .. })
                    | ("ToolResult", RowDirectory::ToolResult { .. })
                    | ("ImportedUser", RowDirectory::ImportedUser { .. })
                    | ("AssistantPart", RowDirectory::AssistantPart { .. })
            );
            if selected {
                let row_root = source.metadata_source(&entry.row).unwrap();
                let payload_root = source.describe_payload(&entry.row).unwrap().unwrap();
                return (
                    entry.directory,
                    row_root,
                    payload_root,
                    entry.payload.unwrap(),
                );
            }
        }
        after = page.next;
        buffer = page.into_buffer();
        assert!(
            after.is_some(),
            "expected real captured semantic row {kind}"
        );
    }
}
async fn bytes(source: &SourceBytes, budget: &Arc<dyn SourceBudget>) -> Vec<u8> {
    let mut cursor = source.open(budget.clone());
    let mut buffer = budget.allocate(4096).await.unwrap();
    let mut output = Vec::new();
    loop {
        let read = cursor.read_chunk(buffer).await.unwrap();
        output.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            return output;
        }
    }
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
#[tokio::test]
async fn user_payload_navigation_captures_artifact_identity_larger_than_work_envelope() {
    let (_directory, root) = crate::test_support::root().await;
    let store = crate::test_support::session(&root, "session").await;
    let resources = maka_model::ModelPreparationResources::new(Default::default()).unwrap();
    let id = "a".repeat(resources.policy().work_bytes + 17);
    let image = b"\x89PNG\r\n\x1a\nuser-image".to_vec();
    artifact(&store, &id, "image/png", image.clone()).await;
    let through=append(&store,Fact::InvocationOpened{configuration:None,input:InvocationInput::Message{source_messages:Vec::new(),content:serde_json::from_value(serde_json::json!({"text":"question","attachments":[{"kind":"image","name":"upload.png","mimeType":"image/png","bytes":1,"ref":{"kind":"session_file","sessionId":"session","relativePath":id}}]})).unwrap(),request_fingerprint:None}}).await;
    let execution = store.execution_scope(None).await.unwrap().accept();
    let captured = capture(&execution.store(), through).await;
    let arena = super::super::capture_arena::CaptureArena::new(captured.clone(), None)
        .await
        .unwrap();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let cancel = tokio_util::sync::CancellationToken::new();
    let context = ProjectContext {
        language: Language::En,
        vision: true,
        provider: &ProviderKind::OpenaiChatCompletions,
        replay: None,
        captured: Some(&captured),
        row_root: None,
        payload_root: None,
        arena: Some(&arena),
        internal_arena: false,
        cancellation: &cancel,
        budget: budget.clone(),
        directory_owner: Arc::new(()),
    };
    let (metadata, row_root, payload, value) = row(&captured, "User", &budget).await;
    let context = context.for_row(&row_root, Some(&payload));
    assert!(
        footprint_row(&metadata, Some(&value), &context)
            .await
            .unwrap()
            > 0
    );
    assert_eq!(
        backing_bytes_row(&metadata, Some(&value), &context)
            .await
            .unwrap(),
        image.len()
    );
    let store = super::super::arena_recipes::ArenaRecipes::new(arena.clone(), Arc::new(()));
    let numeric = super::arena::project_row(&metadata, Some(&value), &context, &store)
        .await
        .unwrap();
    let super::arena::ArenaProjectedRow::User(numeric) = numeric else {
        panic!("numeric user projection")
    };
    let ProjectedRow::User(content) = project_row(&metadata, Some(&value), &context)
        .await
        .unwrap()
    else {
        panic!("expected user recipe")
    };
    arena.seal().await.unwrap();
    let mut content = content.open(0);
    let Some(ContentRecipe::Text { text, .. }) = content.next().await.unwrap() else {
        panic!("attachment reference text")
    };
    let expected = format!(
        "question\n\n<attachment>\nRead argument: {{\"path\":\"maka://runtime/attachments/{id}\"}}\nMarkdown image source: \"maka://runtime/attachments/{id}\"\nSession resource; the Read path above differs from the display name.\nname: \"upload.png\"\nmime_type: \"image/png\"\n</attachment>"
    );
    assert!(
        json::text_eq(&text, &expected, budget.clone())
            .await
            .unwrap()
    );
    let Some(ContentRecipe::Media { media, .. }) = content.next().await.unwrap() else {
        panic!("native captured image")
    };
    assert_eq!(bytes(&media.bytes, &budget).await, image);
    assert!(content.next().await.unwrap().is_none());
    let mut numeric = store.contents(numeric).open(0);
    let Some(ContentRecipe::Text { text, .. }) = numeric.next().await.unwrap() else {
        panic!("numeric attachment reference text")
    };
    assert!(
        json::text_eq(&text, &expected, budget.clone())
            .await
            .unwrap()
    );
    let Some(ContentRecipe::Media { media, .. }) = numeric.next().await.unwrap() else {
        panic!("numeric image")
    };
    assert_eq!(bytes(&media.bytes, &budget).await, image);
    assert!(numeric.next().await.unwrap().is_none());
    arena.close().await.unwrap();
    execution.finish();
}
#[tokio::test]
async fn tool_payload_navigation_preserves_real_canonical_audio_and_image_refs() {
    let (_directory, root) = crate::test_support::root().await;
    let store = crate::test_support::session(&root, "session").await;
    let resources = maka_model::ModelPreparationResources::new(Default::default()).unwrap();
    let image_id = "i".repeat(resources.policy().work_bytes + 31);
    let audio_id = "s".repeat(resources.policy().work_bytes + 19);
    let image = b"\x89PNG\r\n\x1a\ntool-image".to_vec();
    let audio = b"RIFFtool-audio".to_vec();
    artifact(&store, &image_id, "image/png", image.clone()).await;
    artifact(&store, &audio_id, "audio/wav", audio.clone()).await;
    open_tool(&store).await;
    let projection = DurableToolProjection::Content {
        parts: vec![
            ProjectionPart::Text {
                text: "before".into(),
            },
            ProjectionPart::Audio {
                audio: AudioOutput {
                    mime_type: "audio/wav".into(),
                    reference: StorageRef::SessionFile {
                        session_id: "session".into(),
                        relative_path: audio_id,
                    },
                },
            },
            ProjectionPart::Artifact {
                image: ImageOutput {
                    detail: Some(ImageDetail::High),
                    mime_type: "image/png".into(),
                    reference: StorageRef::SessionFile {
                        session_id: "session".into(),
                        relative_path: image_id,
                    },
                },
            },
        ],
    };
    let event = EventWrite::tool_success(
        "result".into(),
        std::time::SystemTime::now(),
        invocation(),
        "step:call".into(),
        ToolSuccess::projected(
            ToolOutput::Json(serde_json::json!({"raw":"not model projection"})),
            projection,
        ),
    )
    .unwrap()
    .0;
    let through = store.append(&event).await.unwrap();
    let execution = store.execution_scope(None).await.unwrap().accept();
    let captured = capture(&execution.store(), through).await;
    let arena = super::super::capture_arena::CaptureArena::new(captured.clone(), None)
        .await
        .unwrap();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let cancel = tokio_util::sync::CancellationToken::new();
    let context = ProjectContext {
        language: Language::En,
        vision: true,
        provider: &ProviderKind::OpenaiChatCompletions,
        replay: None,
        captured: Some(&captured),
        row_root: None,
        payload_root: None,
        arena: Some(&arena),
        internal_arena: false,
        cancellation: &cancel,
        budget: budget.clone(),
        directory_owner: Arc::new(()),
    };
    let (metadata, row_root, payload, value) = row(&captured, "ToolResult", &budget).await;
    assert_eq!(
        payload.encoding(),
        maka_event_log::context::semantic::PayloadEncoding::CanonicalProjection
    );
    let context = context.for_row(&row_root, Some(&payload));
    let shape = chat_shape_row(&metadata, Some(&value), &context)
        .await
        .unwrap();
    assert_eq!(
        (shape.content_parts, shape.media_parts, shape.media_results),
        (3, 2, 1)
    );
    assert!(
        footprint_row(&metadata, Some(&value), &context)
            .await
            .unwrap()
            > 0
    );
    backing_bytes_row(&metadata, Some(&value), &context)
        .await
        .unwrap();
    let store = super::super::arena_recipes::ArenaRecipes::new(arena.clone(), Arc::new(()));
    let numeric_list = store.begin_list(1).await.unwrap();
    let super::arena::ArenaProjectedRow::Tool(numeric) =
        super::arena::project_row(&metadata, Some(&value), &context, &store)
            .await
            .unwrap()
    else {
        panic!("numeric tool projection")
    };
    store.put(numeric_list, 0, numeric).await.unwrap();
    let ProjectedRow::Tool(result) = project_row(&metadata, Some(&value), &context)
        .await
        .unwrap()
    else {
        panic!("expected tool recipe")
    };
    arena.seal().await.unwrap();
    let ToolOutputRecipe::Content(content) = result.output else {
        panic!("expected closed content projection")
    };
    let mut content = content.open(0);
    let Some(ContentRecipe::Text { text, .. }) = content.next().await.unwrap() else {
        panic!("text before media")
    };
    assert!(
        json::text_eq(&text, "before", budget.clone())
            .await
            .unwrap()
    );
    let Some(ContentRecipe::Media { media, .. }) = content.next().await.unwrap() else {
        panic!("audio")
    };
    assert_eq!(bytes(&media.bytes, &budget).await, audio);
    let Some(ContentRecipe::Media { media, .. }) = content.next().await.unwrap() else {
        panic!("image")
    };
    assert_eq!(bytes(&media.bytes, &budget).await, image);
    assert!(
        json::text_eq(media.detail.as_ref().unwrap(), "high", budget.clone())
            .await
            .unwrap()
    );
    assert!(content.next().await.unwrap().is_none());
    let mut results = store.results(numeric_list).open(0);
    let result = results.next().await.unwrap().unwrap();
    let ToolOutputRecipe::Content(content) = result.output else {
        panic!("numeric content projection")
    };
    let mut content = content.open(0);
    let Some(ContentRecipe::Text { text, .. }) = content.next().await.unwrap() else {
        panic!("numeric preamble")
    };
    assert!(
        json::text_eq(&text, "before", budget.clone())
            .await
            .unwrap()
    );
    let Some(ContentRecipe::Media { media, .. }) = content.next().await.unwrap() else {
        panic!("numeric audio")
    };
    assert_eq!(bytes(&media.bytes, &budget).await, audio);
    let Some(ContentRecipe::Media { media, .. }) = content.next().await.unwrap() else {
        panic!("numeric image")
    };
    assert_eq!(bytes(&media.bytes, &budget).await, image);
    assert!(
        json::text_eq(media.detail.as_ref().unwrap(), "high", budget.clone())
            .await
            .unwrap()
    );
    assert!(content.next().await.unwrap().is_none());
    arena.close().await.unwrap();
    execution.finish();
}

#[tokio::test]
async fn native_user_invalid_artifact_refs_remain_unavailable_without_invalid_read_uri() {
    let (_directory, root) = crate::test_support::root().await;
    let store = crate::test_support::session(&root, "session").await;
    let attachments:Vec<_>=[("image","session","bad/slash"),("image","session",""),("image","session","世界"),("image","bad/session","valid"),("other","session","bad/slash"),("other","bad/session","valid"),("other","session","missing-file"),("image","session","missing-image")].into_iter().enumerate().map(|(index,(kind,session,id))|serde_json::json!({"kind":kind,"name":format!("attachment-{index}"),"mimeType":if kind=="image"{"image/png"}else{"text/plain"},"bytes":1,"ref":{"kind":"session_file","sessionId":session,"relativePath":id}})).collect();
    let through = append(
        &store,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: serde_json::from_value(
                    serde_json::json!({"text":"question","attachments":attachments}),
                )
                .unwrap(),
                request_fingerprint: None,
            },
        },
    )
    .await;
    let execution = store.execution_scope(None).await.unwrap().accept();
    let captured = capture(&execution.store(), through).await;
    let resources = maka_model::ModelPreparationResources::new(Default::default()).unwrap();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let cancel = tokio_util::sync::CancellationToken::new();
    for vision in [false, true] {
        let arena = super::super::capture_arena::CaptureArena::new(captured.clone(), None)
            .await
            .unwrap();
        let numeric_store =
            super::super::arena_recipes::ArenaRecipes::new(arena.clone(), Arc::new(()));
        let context = ProjectContext {
            language: Language::En,
            vision,
            provider: &ProviderKind::OpenaiChatCompletions,
            replay: None,
            captured: Some(&captured),
            row_root: None,
            payload_root: None,
            arena: Some(&arena),
            internal_arena: false,
            cancellation: &cancel,
            budget: budget.clone(),
            directory_owner: Arc::new(()),
        };
        let (metadata, row_root, payload, value) = row(&captured, "User", &budget).await;
        let context = context.for_row(&row_root, Some(&payload));
        let ProjectedRow::User(ordinary) = project_row(&metadata, Some(&value), &context)
            .await
            .unwrap()
        else {
            panic!("user")
        };
        let arena::ArenaProjectedRow::User(numeric) =
            arena::project_row(&metadata, Some(&value), &context, &numeric_store)
                .await
                .unwrap()
        else {
            panic!("numeric user")
        };
        arena.seal().await.unwrap();
        for content in [ordinary, numeric_store.contents(numeric)] {
            assert_eq!(content.len(), if vision { 6 } else { 1 });
            let mut content = content.open(0);
            let Some(ContentRecipe::Text { text, .. }) = content.next().await.unwrap() else {
                panic!("user reference text")
            };
            let text = source_text::bytes(text, budget.clone());
            let text = String::from_utf8(bytes(&text, &budget).await).unwrap();
            assert_eq!(
                text.matches(maka_agent_facts::attachment::ATTACHMENT_RESOURCE_PREFIX)
                    .count(),
                3
            );
            assert!(text.contains("maka://runtime/attachments/missing-file"));
            assert!(text.contains("maka://runtime/attachments/missing-image"));
            assert!(!text.contains("maka://runtime/attachments/bad/slash"));
            while let Some(content) = content.next().await.unwrap() {
                assert!(
                    matches!(content, ContentRecipe::Text { .. }),
                    "invalid or missing media must render unavailable text"
                );
            }
        }
        arena.close().await.unwrap();
    }
    execution.finish();
}

#[tokio::test]
async fn native_tool_projection_rejects_invalid_media_identity_and_keeps_json_opaque() {
    for explicit_media in [true, false] {
        let (_directory, root) = crate::test_support::root().await;
        let store = crate::test_support::session(&root, "session").await;
        open_tool(&store).await;
        let opaque = serde_json::json!({"kind":"artifact","image":{"mimeType":"image/png","ref":{"kind":"session_file","sessionId":"session","relativePath":"bad/slash"}}});
        let projection = if explicit_media {
            DurableToolProjection::Content {
                parts: vec![ProjectionPart::Artifact {
                    image: ImageOutput {
                        detail: None,
                        mime_type: "image/png".into(),
                        reference: StorageRef::SessionFile {
                            session_id: "session".into(),
                            relative_path: "bad/slash".into(),
                        },
                    },
                }],
            }
        } else {
            DurableToolProjection::Json {
                value: opaque.clone(),
            }
        };
        let write = EventWrite::tool_success(
            "invalid-result".into(),
            std::time::SystemTime::now(),
            invocation(),
            "step:call".into(),
            ToolSuccess::projected(ToolOutput::Json(opaque), projection),
        )
        .unwrap()
        .0;
        if explicit_media {
            assert!(matches!(
                &write.event().fact,
                Fact::ToolSettled {
                    outcome: maka_agent_facts::event::ToolOutcome::Succeeded {
                        model_projection: DurableToolProjection::Failure,
                        ..
                    },
                    ..
                }
            ));
        }
        let through = store.append(&write).await.unwrap();
        let execution = store.execution_scope(None).await.unwrap().accept();
        let captured = capture(&execution.store(), through).await;
        let resources = maka_model::ModelPreparationResources::new(Default::default()).unwrap();
        let work = resources.acquire_work().await.unwrap();
        let budget = work.budget();
        let cancel = tokio_util::sync::CancellationToken::new();
        let context = ProjectContext {
            language: Language::En,
            vision: true,
            provider: &ProviderKind::OpenaiChatCompletions,
            replay: None,
            captured: Some(&captured),
            row_root: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &cancel,
            budget: budget.clone(),
            directory_owner: Arc::new(()),
        };
        let (metadata, row_root, payload, value) = row(&captured, "ToolResult", &budget).await;
        let context = context.for_row(&row_root, Some(&payload));
        let ProjectedRow::Tool(result) = project_row(&metadata, Some(&value), &context)
            .await
            .unwrap()
        else {
            panic!("tool")
        };
        if explicit_media {
            let ToolOutputRecipe::ErrorText(text) = result.output else {
                panic!("invalid explicit media becomes durable failure")
            };
            assert!(
                json::text_eq(
                    &text,
                    maka_agent_facts::tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE,
                    budget.clone()
                )
                .await
                .unwrap()
            );
        } else {
            let ToolOutputRecipe::Json(value) = result.output else {
                panic!("opaque JSON must not become media")
            };
            let id = json::field(&value, &["image", "ref", "relativePath"], budget.clone())
                .await
                .unwrap()
                .unwrap()
                .text()
                .unwrap();
            assert!(
                json::text_eq(&id, "bad/slash", budget.clone())
                    .await
                    .unwrap()
            );
        }
        execution.finish();
    }
}

#[tokio::test]
async fn imported_user_backing_plan_does_not_open_its_plaintext_body_for_media() {
    use maka_agent_facts::import::{Content, Record, Source};
    let (_directory, root) = crate::test_support::root().await;
    let text =
        "Imported text mentions User, Tool, attachments and image/png without carrying media.";
    root.import_session(
        &maka_event_log::sessions::PluginSession {
            session_id: "session".into(),
            creator: maka_capabilities::storage::Namespace::new(
                "external.reader",
                maka_plugin_core::scope::Scope::Profile,
            )
            .unwrap(),
            fingerprint: "plain-import".into(),
            managed: false,
            authority_session_id: None,
        },
        &Source {
            adapter: "plain-import".into(),
            session_id: "foreign".into(),
        },
        &serde_json::json!({}),
        vec![Record {
            source_message_id: "message".into(),
            source_turn_id: "foreign-turn".into(),
            timestamp: None,
            content: Content::User { text: text.into() },
        }],
        1,
    )
    .await
    .unwrap();
    let session = root.session("session").await.unwrap();
    let execution = session.execution_scope(None).await.unwrap().accept();
    let store = execution.store();
    let through = *store.subscribe_commits().unwrap().borrow();
    let captured = capture(&store, through).await;
    let resources = maka_model::ModelPreparationResources::new(Default::default()).unwrap();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let cancel = tokio_util::sync::CancellationToken::new();
    for provider in [ProviderKind::OpenaiChatCompletions, ProviderKind::Anthropic] {
        let (metadata, row_root, payload, value) = row(&captured, "ImportedUser", &budget).await;
        let context = ProjectContext {
            language: Language::En,
            vision: true,
            provider: &provider,
            replay: None,
            captured: None,
            row_root: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &cancel,
            budget: budget.clone(),
            directory_owner: Arc::new(()),
        };
        assert_eq!(
            backing_bytes_row(&metadata, Some(&value), &context)
                .await
                .unwrap(),
            0,
        );
        let mut context = context.for_row(&row_root, Some(&payload));
        context.captured = Some(&captured);
        let ProjectedRow::User(content) = project_row(&metadata, Some(&value), &context)
            .await
            .unwrap()
        else {
            panic!("imported user must remain plaintext user content");
        };
        let mut parts = content.open(0);
        let Some(ContentRecipe::Text { text: actual, .. }) = parts.next().await.unwrap() else {
            panic!("expected imported plaintext");
        };
        assert!(json::text_eq(&actual, text, budget.clone()).await.unwrap());
    }
    drop((captured, budget, work, store));
    execution.finish();
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn captured_malformed_tool_input_preserves_raw_text_and_execution_flag() {
    let (_directory, root) = crate::test_support::root().await;
    let store = crate::test_support::session(&root, "session").await;
    open_model(&store).await;
    let raw = "{\n";
    let through = append(
        &store,
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: model_completion(vec![maka_agent_facts::model::ModelPart::ToolCall {
                call: maka_agent_facts::model::ModelToolCall {
                    id: "call".into(),
                    name: "Read".into(),
                    input: maka_agent_facts::model::ToolInput::InvalidJson { raw: raw.into() },
                    provider_executed: true,
                    provider_options: None,
                },
            }]),
        },
    )
    .await;
    let execution = store.execution_scope(None).await.unwrap().accept();
    let captured = capture(&execution.store(), through).await;
    let resources = maka_model::ModelPreparationResources::new(Default::default()).unwrap();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let (directory, row_root, payload_root, payload) =
        row(&captured, "AssistantPart", &budget).await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let context = ProjectContext {
        language: Language::En,
        vision: false,
        provider: &ProviderKind::Anthropic,
        replay: None,
        captured: Some(&captured),
        row_root: Some(&row_root),
        payload_root: Some(&payload_root),
        arena: None,
        internal_arena: false,
        cancellation: &cancel,
        budget: budget.clone(),
        directory_owner: Arc::new(()),
    };
    let ProjectedRow::Assistant(AssistantRecipe::ToolCall {
        input,
        provider_executed,
        ..
    }) = project_row(&directory, Some(&payload), &context)
        .await
        .unwrap()
    else {
        panic!("expected captured tool call");
    };
    assert_eq!(provider_executed, Some(true));
    let ToolInputRecipe::Text(actual) = input else {
        panic!("malformed input must remain text");
    };
    assert!(json::text_eq(&actual, raw, budget.clone()).await.unwrap());
    drop((actual, context));
    drop((captured, budget, work));
    execution.finish();
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn captured_steering_quotes_preserve_text_and_escape_display_provenance() {
    let (_directory, root) = crate::test_support::root().await;
    let store = crate::test_support::session(&root, "session").await;
    let source = serde_json::json!({"sessionId":"foreign","sessionName":"<&>","capturedAt":1,"truncated":false});
    let through = append(
        &store,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                request_fingerprint: None,
                content: serde_json::from_value(serde_json::json!({
                    "text":"ask","quotes":[{"label":"a\"b","text":"<quoted>","source":source}],
                    "attachments":[],"directory_references":[]
                }))
                .unwrap(),
            },
        },
    )
    .await;
    let execution = store.execution_scope(None).await.unwrap().accept();
    let captured = capture(&execution.store(), through).await;
    let resources = maka_model::ModelPreparationResources::new(Default::default()).unwrap();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let (_, row_root, payload_root, payload) = row(&captured, "User", &budget).await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let context = ProjectContext {
        language: Language::En,
        vision: false,
        provider: &ProviderKind::Anthropic,
        replay: None,
        captured: Some(&captured),
        row_root: Some(&row_root),
        payload_root: Some(&payload_root),
        arena: None,
        internal_arena: false,
        cancellation: &cancel,
        budget: budget.clone(),
        directory_owner: Arc::new(()),
    };
    let ProjectedRow::User(content) = user(&payload, true, &context).await.unwrap() else {
        panic!("expected steering user");
    };
    let mut cursor = content.open(0);
    let Some(ContentRecipe::Text { text, .. }) = cursor.next().await.unwrap() else {
        panic!("expected source text");
    };
    let escaped_source = serde_json::to_string(&source)
        .unwrap()
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    let expected = format!(
        "The user sent a message while you were working:\n<user_query>\nask\n\n<quoted_excerpt label=\"a'b\">\nSession snapshot provenance (display-only): {escaped_source}\n<quoted>\n</quoted_excerpt>\n</user_query>"
    );
    assert!(
        json::text_eq(&text, &expected, budget.clone())
            .await
            .unwrap()
    );
    drop((cursor, text, content, context));
    drop((captured, budget, work));
    execution.finish();
    root.shutdown().await.unwrap();
}
