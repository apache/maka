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
use maka_agent_facts::{
    artifact::ToolReturn,
    history_snapshot::{
        Entry, HistoricalRole, ImportedArtifactScope, ImportedMessage, ImportedPart, SnapshotId,
    },
    tool_output::{DurableToolProjection, ReturnedToolResult, ToolOutput},
};
use maka_agent_state::{ContentBlob, DriverDomain, Store};
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use std::{
    io::{Seek, SeekFrom, Write},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

fn original_result_value() -> Value {
    let mut deep = serde_json::json!("deep🙂\0suffix");
    for _ in 0..16 {
        deep = serde_json::json!({"nested":deep});
    }
    serde_json::json!({
        "answer":"raw result", "0":"object zero", "":"empty key",
        "nul\0key":"literal nul key", "a.b/[~]":"literal punctuation",
        "long".repeat(1025): "long key value", "array":["array zero",null,true,19,-2.5,{"nested":"object"}],
        "deep":deep, "unicode":"🙂\0suffix", "false":false,
        "content":[{"type":"image","data":"this JSON is not typed MCP"}]
    })
}

fn payload(file: &mut std::fs::File, bytes: Vec<u8>) -> ContentRef {
    let reference = ContentBlob::new(bytes.clone()).reference().clone();
    file.write_all(&[0]).unwrap();
    file.write_all(&hex::decode(reference.digest.strip_prefix("sha256:").unwrap()).unwrap())
        .unwrap();
    file.write_all(&reference.bytes.to_be_bytes()).unwrap();
    file.write_all(&bytes).unwrap();
    reference
}
fn entry(file: &mut std::fs::File, value: &Entry) {
    let bytes = serde_json::to_vec(value).unwrap();
    file.write_all(&[1]).unwrap();
    file.write_all(&(bytes.len() as u64).to_be_bytes()).unwrap();
    file.write_all(&bytes).unwrap();
}
async fn imported_fixture(
    ids: bool,
    role: HistoricalRole,
) -> (
    tempfile::TempDir,
    RootStore,
    maka_agent_state::session_history::snapshot::Snapshot,
    String,
) {
    imported_fixture_media(ids, role, false).await
}
async fn imported_fixture_media(
    ids: bool,
    role: HistoricalRole,
    include_media: bool,
) -> (
    tempfile::TempDir,
    RootStore,
    maka_agent_state::session_history::snapshot::Snapshot,
    String,
) {
    let directory = tempfile::tempdir().unwrap();
    let owner = RootOwner::create(
        &directory.path().join("root"),
        &RootNamespaces {
            ownership: directory.path().join("ownership"),
            control: directory.path().join("control"),
        },
    )
    .unwrap();
    let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .copied()
        .collect();
    let root = RootStore::open(Arc::new(owner), &migrations).await.unwrap();
    root.create_session("source", "fixture", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let writer = root.data_writer().unwrap();
    let state = Store::new(writer.clone(), DriverDomain::new(writer).unwrap()).unwrap();
    let owner = RunOwner {
        deployment: uuid::Uuid::from_u128(1),
        namespace: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::from_u128(2)]),
    };
    let history = state.session_history(owner.clone(), "source".into());
    let mut tape = tempfile::tempfile().unwrap();
    tape.write_all(maka_agent_state::session_history::snapshot::IMPORT_TAPE_MAGIC)
        .unwrap();
    let original=payload(&mut tape,serde_json::to_vec(&serde_json::json!({"id":ids.then_some("original-message"),"turnId":ids.then_some("original-turn"),"privateThinking":"not public"})).unwrap());
    let metadata=payload(&mut tape,br#"{"version":1,"source":{"adapter":"fixture","sessionId":"foreign"},"metadata":{"privateThinking":"not public"}}"#.to_vec());
    let text = format!("{}COMPLETE_SUFFIX🙂\0", "正文🙂\0\n".repeat(7000));
    let result = ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: Vec::new(),
        body: ReturnedToolResult {
            output: ToolOutput::Json(original_result_value()),
            projection: DurableToolProjection::Text {
                text: "模型可见结果🙂".into(),
            },
            is_error: false,
            loaded_tools: Default::default(),
        },
    };
    let mut parts = Vec::new();
    for part in [
        ImportedPart::Model {
            part: ModelPart::Text {
                text_kind: TextKind::Thinking,
                text: "private reasoning".into(),
                provider_options: None,
            },
        },
        ImportedPart::Model {
            part: ModelPart::Text {
                text_kind: TextKind::Text,
                text: text.clone().into(),
                provider_options: None,
            },
        },
        ImportedPart::ToolReturn {
            call_id: "foreign-call".into(),
            name: "foreign-tool".into(),
            result,
        },
    ] {
        parts.push(payload(&mut tape, serde_json::to_vec(&part).unwrap()));
    }

    if include_media {
        use base64::Engine as _;
        use maka_agent_facts::{
            artifact::{Artifact, ArtifactKind, ArtifactSource, PublishedArtifact},
            attachment::{AttachmentKind, AttachmentRef, StorageRef},
            input::MessageInput,
            tool_output::{ImageOutput, ProjectionPart},
        };
        let bytes=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==").unwrap();
        let image_payload = payload(&mut tape, bytes);
        let storage_ref = StorageRef::SessionFile {
            session_id: "source".into(),
            relative_path: "media-image".into(),
        };
        entry(
            &mut tape,
            &Entry::Artifact {
                owner: owner.clone(),
                session: "source".into(),
                run: None,
                through_sequence: None,
                record: PublishedArtifact {
                    payload: image_payload.clone(),
                    artifact: Artifact {
                        id: "media-image".into(),
                        session_id: "source".into(),
                        turn_id: "foreign-artifact-turn".into(),
                        created_at: 0,
                        name: "fixture.png".into(),
                        kind: ArtifactKind::Image,
                        size_bytes: image_payload.bytes,
                        mime_type: Some("image/png".into()),
                        source: ArtifactSource::ToolResult,
                        summary: None,
                    },
                },
            },
        );
        use image::ImageEncoder as _;
        entry(
            &mut tape,
            &Entry::Artifact {
                owner: owner.clone(),
                session: "source".into(),
                run: None,
                through_sequence: None,
                record: PublishedArtifact {
                    payload: image_payload.clone(),
                    artifact: Artifact {
                        id: "unsupported-image".into(),
                        session_id: "source".into(),
                        turn_id: "foreign-artifact-turn".into(),
                        created_at: 0,
                        name: "original-image.bin".into(),
                        kind: ArtifactKind::Image,
                        size_bytes: image_payload.bytes,
                        mime_type: Some("application/octet-stream".into()),
                        source: ArtifactSource::ToolResult,
                        summary: None,
                    },
                },
            },
        );
        let mut second_bytes = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut second_bytes,
            image::codecs::png::CompressionType::Uncompressed,
            image::codecs::png::FilterType::NoFilter,
        )
        .write_image(
            &vec![137; 200 * 100 * 4],
            200,
            100,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
        let second_payload = payload(&mut tape, second_bytes);
        entry(
            &mut tape,
            &Entry::Artifact {
                owner: owner.clone(),
                session: "source".into(),
                run: None,
                through_sequence: None,
                record: PublishedArtifact {
                    payload: second_payload.clone(),
                    artifact: Artifact {
                        id: "second-image".into(),
                        session_id: "source".into(),
                        turn_id: "foreign-artifact-turn".into(),
                        created_at: 0,
                        name: "second.png".into(),
                        kind: ArtifactKind::Image,
                        size_bytes: second_payload.bytes,
                        mime_type: Some("image/png".into()),
                        source: ArtifactSource::ToolResult,
                        summary: None,
                    },
                },
            },
        );
        let second_image = ImageOutput {
            detail: None,
            mime_type: "image/png".into(),
            reference: StorageRef::SessionFile {
                session_id: "source".into(),
                relative_path: "second-image".into(),
            },
        };
        let image = ImageOutput {
            detail: None,
            mime_type: "image/png".into(),
            reference: storage_ref.clone(),
        };
        for part in [
            ImportedPart::ToolReturn {
                call_id: "single-image".into(),
                name: "image-tool".into(),
                result: ToolReturn {
                    schema_version: SCHEMA_VERSION,
                    artifacts: Vec::new(),
                    body: ReturnedToolResult {
                        output: ToolOutput::Image(image.clone()),
                        projection: DurableToolProjection::Text {
                            text: "an image".into(),
                        },
                        is_error: false,
                        loaded_tools: Default::default(),
                    },
                },
            },
            ImportedPart::ToolReturn {
                call_id: "part-image".into(),
                name: "image-tool".into(),
                result: ToolReturn {
                    schema_version: SCHEMA_VERSION,
                    artifacts: Vec::new(),
                    body: ReturnedToolResult {
                        output: ToolOutput::Json(serde_json::json!({"original":true})),
                        projection: DurableToolProjection::Content {
                            parts: vec![
                                ProjectionPart::Text {
                                    text: "caption".into(),
                                },
                                ProjectionPart::Artifact { image },
                                ProjectionPart::Text {
                                    text: "between real images".into(),
                                },
                                ProjectionPart::Artifact {
                                    image: second_image,
                                },
                            ],
                        },
                        is_error: false,
                        loaded_tools: Default::default(),
                    },
                },
            },
            ImportedPart::Input {
                content: MessageInput {
                    preparation: Vec::new(),
                    text: "attached image".into(),
                    display_text: None,
                    attachments: Some(vec![AttachmentRef {
                        kind: AttachmentKind::Image,
                        name: "fixture.png".into(),
                        mime_type: "image/png".into(),
                        bytes: image_payload.bytes,
                        storage_ref,
                    }]),
                    quotes: None,
                    directory_references: None,
                    inline_references: None,
                },
            },
        ] {
            parts.push(payload(&mut tape, serde_json::to_vec(&part).unwrap()));
        }
    }
    if include_media {
        use maka_agent_facts::input::{
            DirectoryReference, InlineReference, InlineReferenceKind, MessageInput, QuoteRef,
        };
        for kind in 0..4 {
            let mut content: MessageInput =
                format!("{}END🙂", "reference body🙂\0".repeat(4000)).into();
            match kind {
                1 => {
                    content.quotes = Some(vec![QuoteRef {
                        text: "quoted original".into(),
                        label: None,
                        source_turn_id: None,
                        source: None,
                    }])
                }
                2 => {
                    content.directory_references = Some(vec![DirectoryReference {
                        host_id: "display-only".into(),
                        path: "/not/a/grant".into(),
                    }])
                }
                3 => {
                    content.inline_references = Some(vec![InlineReference {
                        kind: InlineReferenceKind::WorkspaceFile,
                        value: "not-a-grant.txt".into(),
                        label: "display".into(),
                        start: 0,
                    }])
                }
                _ => {}
            }
            parts.push(payload(
                &mut tape,
                serde_json::to_vec(&ImportedPart::Input { content }).unwrap(),
            ));
        }
    }
    if include_media {
        use maka_agent_facts::{attachment::StorageRef, tool_output::ImageOutput};
        parts.push(payload(
            &mut tape,
            serde_json::to_vec(&ImportedPart::ToolReturn {
                call_id: "unsupported-image".into(),
                name: "image-tool".into(),
                result: ToolReturn {
                    schema_version: SCHEMA_VERSION,
                    artifacts: Vec::new(),
                    body: ReturnedToolResult {
                        output: ToolOutput::Image(ImageOutput {
                            detail: None,
                            mime_type: "application/octet-stream".into(),
                            reference: StorageRef::SessionFile {
                                session_id: "source".into(),
                                relative_path: "unsupported-image".into(),
                            },
                        }),
                        projection: DurableToolProjection::Text {
                            text: "unsupported image media type".into(),
                        },
                        is_error: false,
                        loaded_tools: Default::default(),
                    },
                },
            })
            .unwrap(),
        ));
    }
    let message = ImportedMessage {
        original_ordinal: 0,
        turn_ordinal: maka_agent_facts::history_snapshot::ImportedTurnOrdinal(0),
        media: if include_media {
            vec![
                "media-image".into(),
                "second-image".into(),
                "unsupported-image".into(),
            ]
        } else {
            Vec::new()
        },
        source_message_id: ids.then(|| "original-message".into()),
        source_turn_id: ids.then(|| "original-turn".into()),
        timestamp: None,
        role,
        artifact_scope: ImportedArtifactScope {
            owner,
            session: "source".into(),
        },
        parts,
        provider_metadata: Some(metadata),
        original: original.clone(),
    };
    let message = payload(&mut tape, serde_json::to_vec(&message).unwrap());
    entry(
        &mut tape,
        &Entry::Imported {
            ordinal: 0,
            message,
        },
    );
    tape.seek(SeekFrom::Start(0)).unwrap();
    let snapshot = history
        .capture_imported(
            maka_agent_state::session_history::snapshot::ImportedCaptureRequest {
                id: SnapshotId::new(),
                source: maka_agent_facts::import::Source {
                    adapter: "fixture".into(),
                    session_id: "foreign".into(),
                },
                fingerprint: original,
            },
            tape,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    (directory, root, snapshot, text)
}
#[tokio::test]
async fn imported_window_preserves_ids_roles_unicode_and_real_tool_text() {
    let (_directory, root, snapshot, expected) =
        imported_fixture(true, HistoricalRole::Assistant).await;
    let stop = CancellationToken::new();
    let mut position = wire::Position::Start;
    let mut text = String::new();
    let mut result = None;
    let mut chunks_seen = 0;
    loop {
        let page = snapshot_page(&snapshot, position, false, wire::HistoryView::Text, &stop)
            .await
            .unwrap();
        assert!(encoded_bytes(&page).unwrap() <= 60 * 1024);
        let wire::Page::Ready {
            through,
            chunks,
            after,
            ..
        } = page;
        assert_eq!(through, None);
        for chunk in chunks {
            chunks_seen += 1;
            assert_eq!(chunk.run_id, None);
            assert_eq!(chunk.timestamp, None);
            assert!(chunk.model.is_none());
            assert_eq!(chunk.role, wire::Role::Assistant);
            assert_eq!(chunk.message_id.as_deref(), Some("original-message"));
            assert_eq!(chunk.turn_id.as_deref(), Some("original-turn"));
            assert_eq!(chunk.field, wire::HistoryField::Body);
            assert!(
                matches!(&chunk.position,wire::HistoryRowAddress::Imported{snapshot:id,..} if *id==snapshot.id())
            );
            if chunk
                .tool
                .as_ref()
                .is_some_and(|tool| tool.result.is_some())
            {
                assert_eq!(chunk.text, "模型可见结果🙂");
                assert_eq!(chunk.tool.as_ref().unwrap().tool_use_id, "foreign-call");
                let meta = chunk.tool.as_ref().unwrap().result.as_ref().unwrap();
                assert!(!meta.image);
                assert_eq!(meta.images, 0);
                result = Some(chunk.position);
            } else {
                text.push_str(&chunk.text);
            }
        }
        let Some(cursor) = after else {
            break;
        };
        position = wire::Position::After { cursor };
    }
    assert!(chunks_seen > 2);
    assert_eq!(text, expected);
    let address = result.unwrap();
    let source = snapshot_source(
        &snapshot,
        address.clone(),
        wire::SourceField::Result,
        Some(vec![wire::SourceSegment::Key("answer".into())]),
        wire::SourcePosition::Start,
        &stop,
    )
    .await
    .unwrap();
    assert_eq!(source.text, "raw result");
    let wire::Page::Ready { chunks, .. } = snapshot_page(
        &snapshot,
        wire::Position::Row {
            position: address.clone(),
            field: wire::HistoryField::Body,
        },
        false,
        wire::HistoryView::Conversation,
        &stop,
    )
    .await
    .unwrap();
    assert!(
        chunks[0].text.is_empty(),
        "only Conversation may elide tool body"
    );
    let mut wrong = address;
    let wire::HistoryRowAddress::Imported { snapshot: id, .. } = &mut wrong else {
        panic!("imported address")
    };
    *id = SnapshotId::new();
    assert!(
        snapshot_page(
            &snapshot,
            wire::Position::After {
                cursor: wire::Cursor {
                    position: wrong,
                    field: wire::HistoryField::Body,
                    offset: 0
                }
            },
            false,
            wire::HistoryView::Text,
            &stop
        )
        .await
        .is_err(),
        "fixed source never resets to another Root/snapshot"
    );
    root.shutdown().await.unwrap();
}
#[tokio::test]
async fn reverse_imported_window_keeps_utf8_and_source_order() {
    let (_directory, root, snapshot, expected) =
        imported_fixture(true, HistoricalRole::Assistant).await;
    let stop = CancellationToken::new();
    let mut position = wire::Position::Tail;
    let mut restored = String::new();
    loop {
        let page = snapshot_page(&snapshot, position, false, wire::HistoryView::Text, &stop)
            .await
            .unwrap();
        assert!(encoded_bytes(&page).unwrap() <= 60 * 1024);
        let wire::Page::Ready { chunks, before, .. } = page;
        let mut prefix = String::new();
        for chunk in chunks {
            if chunk.tool.is_none() {
                prefix.push_str(&chunk.text);
            }
        }
        restored.insert_str(0, &prefix);
        let Some(cursor) = before else {
            break;
        };
        position = wire::Position::Before { cursor };
    }
    assert_eq!(restored, expected);
    root.shutdown().await.unwrap();
}
#[test]
fn private_raw_fields_are_not_public_context() {
    for field in [
        wire::SourceField::Original,
        wire::SourceField::ProviderMetadata,
        wire::SourceField::Thinking,
    ] {
        assert!(!public_context_field(field));
    }
    assert!(public_context_field(wire::SourceField::Result));
}

#[tokio::test]
async fn missing_foreign_ids_stay_unknown_and_context_role_is_not_native_assistant() {
    let (_directory, root, snapshot, _) = imported_fixture(false, HistoricalRole::Context).await;
    let wire::Page::Ready { chunks, .. } = snapshot_page(
        &snapshot,
        wire::Position::Start,
        false,
        wire::HistoryView::Text,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(!chunks.is_empty());
    for chunk in chunks {
        assert_eq!(chunk.message_id, None);
        assert_eq!(chunk.turn_id, None);
        assert_eq!(chunk.run_id, None);
        assert_eq!(chunk.role, wire::Role::Context);
        assert_eq!(
            chunk.imported_turn,
            Some(maka_agent_facts::history_snapshot::ImportedTurnOrdinal(0))
        );
    }
    root.shutdown().await.unwrap();
}
#[tokio::test]
async fn source_display_uses_stored_projection_without_losing_large_raw_value() {
    use maka_agent_facts::model::prompt_source::source::{JsonSource, SourceBytes};
    use maka_agent_state::session_history::tool_result_source::ToolResultReader;
    let raw = "x".repeat(9 * 1024 * 1024);
    let result = ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: Vec::new(),
        body: ReturnedToolResult {
            output: ToolOutput::Json(serde_json::json!({"large":raw,"answer":"original🙂"})),
            projection: DurableToolProjection::Text {
                text: "readable model projection".into(),
            },
            is_error: false,
            loaded_tools: Default::default(),
        },
    };
    let source = JsonSource::new(SourceBytes::Inline(
        serde_json::to_vec(&result).unwrap().into(),
    ));
    let budget = stream::budget();
    let displayed = stream::result_value(
        ToolResultReader::returned(source.clone(), budget.clone())
            .await
            .unwrap(),
        true,
        false,
        &budget,
    )
    .await
    .unwrap();
    let (_, bytes) = stream::selected_json(displayed, None, &budget)
        .await
        .unwrap();
    let (_, _, _, text) = stream::read_window(
        bytes,
        wire::SourceFormat::Text,
        wire::SourcePosition::Start,
        8192,
        &budget,
    )
    .await
    .unwrap();
    assert_eq!(text, "readable model projection");
    let original = stream::result_value(
        ToolResultReader::returned(source, budget.clone())
            .await
            .unwrap(),
        false,
        false,
        &budget,
    )
    .await
    .unwrap();
    let (_, bytes) = stream::selected_json(
        original,
        Some(&[wire::SourceSegment::Key("answer".into())]),
        &budget,
    )
    .await
    .unwrap();
    let (_, _, _, text) = stream::read_window(
        bytes,
        wire::SourceFormat::Text,
        wire::SourcePosition::Start,
        8192,
        &budget,
    )
    .await
    .unwrap();
    assert_eq!(text, "original🙂");
}

#[tokio::test]
async fn typed_tool_result_preserves_empty_display_and_does_not_trust_business_metadata() {
    use maka_agent_facts::model::prompt_source::source::{JsonSource, SourceBytes};
    use maka_agent_state::session_history::tool_result_source::{
        ToolResultReader, ToolResultSource,
    };
    let diagnostic = "original failure diagnostic🙂\0visible body";
    for (value, is_error, display) in [
        (serde_json::json!({"count":42,"ready":true}), false, ""),
        (
            serde_json::json!({"count":42,"ready":true,"settlement":"failed","isError":true,"content":[{"type":"image","data":"not a typed image"}]}),
            false,
            "",
        ),
        (
            serde_json::json!({"error":{"message":diagnostic},"detail":{"retryable":false,"attempts":3}}),
            true,
            diagnostic,
        ),
    ] {
        let result = ToolReturn {
            schema_version: SCHEMA_VERSION,
            artifacts: Vec::new(),
            body: ReturnedToolResult {
                output: ToolOutput::Json(value.clone()),
                projection: DurableToolProjection::Text {
                    text: display.into(),
                },
                is_error,
                loaded_tools: Default::default(),
            },
        };
        let source = JsonSource::new(SourceBytes::Inline(
            serde_json::to_vec(&result).unwrap().into(),
        ));
        let budget = stream::budget();
        let ToolResultSource::Returned { body, .. } =
            ToolResultReader::returned(source.clone(), budget.clone())
                .await
                .unwrap()
        else {
            panic!("typed original ToolReturn")
        };
        assert_eq!(
            stream::media_metadata_value(&body, "isError", &budget)
                .await
                .unwrap(),
            (false, 0, is_error)
        );
        let projected = stream::result_value(
            ToolResultReader::returned(source.clone(), budget.clone())
                .await
                .unwrap(),
            true,
            false,
            &budget,
        )
        .await
        .unwrap();
        let (_, bytes) = stream::selected_json(projected, None, &budget)
            .await
            .unwrap();
        let (format, _, total, text) = stream::read_window(
            bytes,
            wire::SourceFormat::Text,
            wire::SourcePosition::Start,
            8192,
            &budget,
        )
        .await
        .unwrap();
        assert_eq!(format, wire::SourceFormat::Text);
        assert_eq!(text, display);
        assert_eq!(total, display.len() as u64);
        let original = stream::result_value(
            ToolResultReader::returned(source, budget.clone())
                .await
                .unwrap(),
            false,
            false,
            &budget,
        )
        .await
        .unwrap();
        let (_, bytes) = stream::selected_json(original, None, &budget)
            .await
            .unwrap();
        let (_, _, _, text) = stream::read_window(
            bytes,
            wire::SourceFormat::Json,
            wire::SourcePosition::Start,
            8192,
            &budget,
        )
        .await
        .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), value);
    }
}

#[test]
fn page_transport_budget_includes_both_qualified_continuation_paths() {
    let position = wire::HistoryRowAddress::Snapshot {
        path: (0..80).map(|_| RunId::new()).collect(),
        snapshot: SnapshotId::new(),
        sequence: 1,
        fact: FactId::new(),
        item_index: 0,
    };
    let chunk = wire::Chunk {
        position: position.clone(),
        order: wire::HistoryOrder {
            path: vec![1; 81],
            item_index: 0,
        },
        run_id: Some(RunId::new()),
        model_part: None,
        has_references: false,
        final_output: false,
        model: None,
        origin: None,
        compaction: None,
        timing: None,
        field: wire::HistoryField::Body,
        message_id: Some("original".into()),
        turn_id: Some("turn".into()),
        imported_turn: None,
        timestamp: Some(1),
        role: wire::Role::Assistant,
        offset: 0,
        total_bytes: 4,
        text: "🙂".into(),
        tool: None,
        attachments: Vec::new(),
    };
    let page = wire::Page::Ready {
        through: Some(1),
        chunks: vec![chunk.clone()],
        before: Some(wire::Cursor {
            position: position.clone(),
            field: wire::HistoryField::Body,
            offset: 0,
        }),
        after: Some(wire::Cursor {
            position,
            field: wire::HistoryField::Body,
            offset: 4,
        }),
    };
    assert_eq!(
        page_bytes(Some(1), &[], &chunk, false).unwrap(),
        encoded_bytes(&page).unwrap()
    );
    assert!(
        encoded_bytes(&page).unwrap() > 2 * encoded_bytes(&chunk).unwrap(),
        "the complete source paths are real transport cost, not small local integer cursors"
    );
}

#[tokio::test]
async fn cell_child_codec_allows_no_projection_but_does_not_guess_ordinary_tool_codec() {
    use maka_agent_facts::model::prompt_source::source::{JsonSource, SourceBytes};
    use maka_agent_state::session_history::tool_result_source::ToolResultReader;
    let result = ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: Vec::new(),
        body: maka_agent_facts::cells::CellReturnedResult {
            output: ToolOutput::Text("cell output".into()),
            projection: None,
            is_error: true,
        },
    };
    let source = JsonSource::new(SourceBytes::Inline(
        serde_json::to_vec(&result).unwrap().into(),
    ));
    let budget = stream::budget();
    let maka_agent_state::session_history::tool_result_source::ToolResultSource::Returned {
        body,
        ..
    } = ToolResultReader::returned(source.clone(), budget.clone())
        .await
        .unwrap()
    else {
        panic!("actual ToolReturn codec");
    };
    assert_eq!(
        stream::media_metadata_value(&body, "isError", &budget)
            .await
            .unwrap(),
        (false, 0, true)
    );
    let selected = ToolResultReader::returned(source.clone(), budget.clone())
        .await
        .unwrap();
    let displayed = stream::result_value(selected, true, true, &budget)
        .await
        .unwrap();
    let (_, bytes) = stream::selected_json(displayed, None, &budget)
        .await
        .unwrap();
    let (_, _, _, text) = stream::read_window(
        bytes,
        wire::SourceFormat::Text,
        wire::SourcePosition::Start,
        8192,
        &budget,
    )
    .await
    .unwrap();
    assert_eq!(text, "cell output");
    let selected = ToolResultReader::returned(source, budget.clone())
        .await
        .unwrap();
    assert!(
        stream::result_value(selected, true, false, &budget)
            .await
            .is_err(),
        "normal ToolReturn requires its committed model projection"
    );
}

#[tokio::test]
async fn snapshot_media_reads_single_projected_and_attachment_images_through_actual_cap() {
    use base64::Engine as _;
    let (_directory, root, snapshot, _) =
        imported_fixture_media(true, HistoricalRole::Assistant, true).await;
    let stop = CancellationToken::new();
    let position = |part_ordinal| wire::HistoryRowAddress::Imported {
        path: Vec::new(),
        snapshot: snapshot.id(),
        message_ordinal: 0,
        part_ordinal,
    };
    let single = snapshot_tool_image(&snapshot, position(3), None, 0, &stop)
        .await
        .unwrap();
    let ui::HistoryImagePage::Ready {
        ref digest,
        total_bytes,
        ref data,
        ref mime_type,
        ..
    } = single;
    assert_eq!(mime_type, "image/png");
    let expected = base64::engine::general_purpose::STANDARD
        .decode(data)
        .unwrap();
    assert_eq!(total_bytes, expected.len() as u64);
    assert_eq!(
        digest,
        &ContentBlob::new(expected.clone()).reference().digest
    );
    assert!(encoded_bytes(&single).unwrap() <= 60 * 1024);
    let projected = snapshot_tool_image(&snapshot, position(4), Some(0), 0, &stop)
        .await
        .unwrap();
    let attached = snapshot_attachment_image(&snapshot, position(5), 0, 0, &stop)
        .await
        .unwrap();
    for image in [projected, attached] {
        let ui::HistoryImagePage::Ready { data: actual, .. } = image;
        assert_eq!(actual, *data);
    }
    let second = snapshot_tool_image(&snapshot, position(4), Some(1), 0, &stop)
        .await
        .unwrap();
    let ui::HistoryImagePage::Ready {
        data: second_data,
        total_bytes: second_total,
        digest: second_digest,
        ..
    } = &second;
    let first_chunk = base64::engine::general_purpose::STANDARD
        .decode(second_data)
        .unwrap();
    assert!(*second_total > 32768 && first_chunk.len() <= 32768);
    assert_ne!(second_digest, digest);
    let mut restored = Vec::new();
    loop {
        let page = snapshot_tool_image(
            &snapshot,
            position(4),
            Some(1),
            restored.len() as u64,
            &stop,
        )
        .await
        .unwrap();
        assert!(encoded_bytes(&page).unwrap() <= 60 * 1024);
        let ui::HistoryImagePage::Ready {
            data,
            total_bytes,
            mime_type,
            digest,
            ..
        } = page;
        assert_eq!(mime_type, "image/png");
        assert_eq!(digest, *second_digest);
        assert_eq!(total_bytes, *second_total);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap();
        if restored.len() as u64 == total_bytes {
            assert!(bytes.is_empty());
            break;
        }
        assert!(!bytes.is_empty() && bytes.len() <= 32768);
        restored.extend(bytes);
    }
    assert_eq!(
        ContentBlob::new(restored.clone()).reference().digest,
        *second_digest
    );
    let decoded = image::load_from_memory(&restored).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (200, 100));
    for offset in [1, 17, 8192, 32768] {
        let ui::HistoryImagePage::Ready { data, .. } =
            snapshot_tool_image(&snapshot, position(4), Some(1), offset, &stop)
                .await
                .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap();
        assert_eq!(
            &restored[offset as usize..offset as usize + bytes.len()],
            bytes.as_slice()
        );
    }
    assert!(
        snapshot_tool_image(&snapshot, position(4), Some(2), 0, &stop)
            .await
            .is_err()
    );
    let wire::Page::Ready { chunks, .. } = snapshot_page(
        &snapshot,
        wire::Position::Row {
            position: position(4),
            field: wire::HistoryField::Body,
        },
        false,
        wire::HistoryView::Conversation,
        &stop,
    )
    .await
    .unwrap();
    let projected_row = chunks
        .iter()
        .find(|row| row.position == position(4))
        .unwrap();
    assert_eq!(
        projected_row
            .tool
            .as_ref()
            .unwrap()
            .result
            .as_ref()
            .unwrap()
            .images,
        2
    );
    assert!(projected_row.text.is_empty());
    assert!(
        snapshot_tool_image(&snapshot, position(3), Some(0), 0, &stop)
            .await
            .is_err(),
        "an output image is not implicitly a projection part"
    );
    let mut wrong = position(3);
    if let wire::HistoryRowAddress::Imported { snapshot, .. } = &mut wrong {
        *snapshot = SnapshotId::new();
    }
    assert!(
        snapshot_tool_image(&snapshot, wrong, None, 0, &stop)
            .await
            .is_err(),
        "serialized snapshot identity does not grant access"
    );
    let scope = snapshot.imported_message(0).await.unwrap().artifact_scope;
    let unsupported = snapshot
        .artifact(scope.owner, scope.session, None, "unsupported-image".into())
        .await
        .unwrap()
        .unwrap();
    unsupported.artifact.validate().unwrap();
    assert_eq!(
        unsupported.artifact.mime_type.as_deref(),
        Some("application/octet-stream")
    );
    assert_eq!(unsupported.payload.digest, *digest);
    assert_eq!(
        snapshot_tool_image(&snapshot, position(10), None, 0, &stop)
            .await
            .err()
            .unwrap(),
        "agent_image_source_invalid"
    );
    stop.cancel();
    assert!(
        snapshot_tool_image(&snapshot, position(3), None, 0, &stop)
            .await
            .is_err()
    );
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn snapshot_selectors_preserve_literal_keys_scalar_types_and_utf8_boundaries_without_authority()
 {
    use wire::{SourcePosition as Position, SourceSegment as Segment};
    let (directory, root, snapshot, _) = imported_fixture(true, HistoricalRole::Assistant).await;
    let stop = CancellationToken::new();
    let address = wire::HistoryRowAddress::Imported {
        path: Vec::new(),
        snapshot: snapshot.id(),
        message_ordinal: 0,
        part_ordinal: 2,
    };
    let original = original_result_value();
    let mut reads = Vec::new();
    for key in [
        "answer",
        "0",
        "",
        "nul\0key",
        "a.b/[~]",
        &"long".repeat(1025),
        "array",
        "deep",
        "unicode",
        "false",
    ] {
        let source = snapshot_source(
            &snapshot,
            address.clone(),
            wire::SourceField::Result,
            Some(vec![Segment::Key(key.into())]),
            Position::Start,
            &stop,
        )
        .await
        .unwrap();
        assert_eq!(source.path, Some(vec![Segment::Key(key.into())]));
        assert_eq!(source.position, address);
        let expected = &original[key];
        if let Some(text) = expected.as_str() {
            assert_eq!(source.format, wire::SourceFormat::Text);
            assert_eq!(source.text, text);
        } else {
            assert_eq!(source.format, wire::SourceFormat::Json);
            assert_eq!(
                serde_json::from_str::<Value>(&source.text).unwrap(),
                *expected
            );
        }
        reads.push((
            source.path.clone(),
            Position::Start,
            serde_json::to_vec(&source).unwrap(),
        ));
    }
    for (index, expected) in original["array"].as_array().unwrap().iter().enumerate() {
        let source = snapshot_source(
            &snapshot,
            address.clone(),
            wire::SourceField::Result,
            Some(vec![
                Segment::Key("array".into()),
                Segment::Index(index as u32),
            ]),
            Position::Start,
            &stop,
        )
        .await
        .unwrap();
        if let Some(text) = expected.as_str() {
            assert_eq!(source.text, text)
        } else {
            assert_eq!(
                serde_json::from_str::<Value>(&source.text).unwrap(),
                *expected
            )
        }
        reads.push((
            source.path.clone(),
            Position::Start,
            serde_json::to_vec(&source).unwrap(),
        ));
    }
    let mut deep = vec![Segment::Key("deep".into())];
    deep.extend((0..16).map(|_| Segment::Key("nested".into())));
    let source = snapshot_source(
        &snapshot,
        address.clone(),
        wire::SourceField::Result,
        Some(deep),
        Position::Start,
        &stop,
    )
    .await
    .unwrap();
    assert_eq!(source.text, "deep🙂\0suffix");
    reads.push((
        source.path.clone(),
        Position::Start,
        serde_json::to_vec(&source).unwrap(),
    ));
    for path in [
        vec![Segment::Index(0)],
        vec![Segment::Key("array".into()), Segment::Key("0".into())],
        vec![Segment::Key("array".into()), Segment::Index(99)],
        vec![Segment::Key("false".into()), Segment::Index(0)],
        vec![Segment::Key("missing".into())],
    ] {
        assert!(
            snapshot_source(
                &snapshot,
                address.clone(),
                wire::SourceField::Result,
                Some(path),
                Position::Start,
                &stop
            )
            .await
            .is_err()
        );
    }
    for path in [None, Some(Vec::new())] {
        let source = snapshot_source(
            &snapshot,
            address.clone(),
            wire::SourceField::Result,
            path.clone(),
            Position::Start,
            &stop,
        )
        .await
        .unwrap();
        assert_eq!(source.path, path);
        assert_eq!(
            serde_json::from_str::<Value>(&source.text).unwrap(),
            original
        );
        reads.push((
            source.path.clone(),
            Position::Start,
            serde_json::to_vec(&source).unwrap(),
        ));
    }
    for (position, expected) in [
        (Position::After { offset: 4 }, "\0suffix"),
        (Position::Before { offset: 4 }, "🙂"),
    ] {
        let source = snapshot_source(
            &snapshot,
            address.clone(),
            wire::SourceField::Result,
            Some(vec![Segment::Key("unicode".into())]),
            position,
            &stop,
        )
        .await
        .unwrap();
        assert_eq!(source.text, expected);
        reads.push((
            source.path.clone(),
            position,
            serde_json::to_vec(&source).unwrap(),
        ));
    }
    for position in [
        Position::After { offset: 1 },
        Position::Before { offset: 1 },
        Position::After { offset: 9999 },
    ] {
        assert!(
            snapshot_source(
                &snapshot,
                address.clone(),
                wire::SourceField::Result,
                Some(vec![Segment::Key("unicode".into())]),
                position,
                &stop
            )
            .await
            .is_err()
        );
    }
    for malformed in [
        serde_json::json!(true),
        serde_json::json!(-1),
        serde_json::json!({"kind":"key","key":"0"}),
    ] {
        assert!(serde_json::from_value::<Segment>(malformed).is_err());
    }
    let mut foreign = address.clone();
    if let wire::HistoryRowAddress::Imported { snapshot, .. } = &mut foreign {
        *snapshot = SnapshotId::new();
    }
    assert!(
        snapshot_source(
            &snapshot,
            foreign,
            wire::SourceField::Result,
            None,
            Position::Start,
            &stop
        )
        .await
        .is_err()
    );
    let id = snapshot.id();
    let manifest = snapshot.reference().clone();
    let source_scope = snapshot.imported_message(0).await.unwrap().artifact_scope;
    root.shutdown().await.unwrap();
    let closed = snapshot_source(
        &snapshot,
        address.clone(),
        wire::SourceField::Result,
        None,
        Position::Start,
        &stop,
    )
    .await
    .err()
    .unwrap();
    assert!(closed.contains("closed"), "{closed}");
    drop(snapshot);
    drop(root);
    let owner = RootOwner::open_existing(
        &directory.path().join("root"),
        &RootNamespaces {
            ownership: directory.path().join("ownership"),
            control: directory.path().join("control"),
        },
    )
    .unwrap();
    let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .copied()
        .collect();
    let root = RootStore::open(Arc::new(owner), &migrations).await.unwrap();
    let writer = root.data_writer().unwrap();
    let state = Store::new(writer.clone(), DriverDomain::new(writer).unwrap()).unwrap();
    let history = state.session_history(source_scope.owner, source_scope.session);
    let (_, reopened) = history
        .captured_imported(id, stop.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reopened.reference(), &manifest);
    assert_eq!(reopened.id(), id);
    for (path, position, expected) in reads {
        let source = snapshot_source(
            &reopened,
            address.clone(),
            wire::SourceField::Result,
            path,
            position,
            &stop,
        )
        .await
        .unwrap();
        assert_eq!(serde_json::to_vec(&source).unwrap(), expected);
    }
    for position in [
        Position::After { offset: 1 },
        Position::Before { offset: 1 },
    ] {
        assert!(
            snapshot_source(
                &reopened,
                address.clone(),
                wire::SourceField::Result,
                Some(vec![Segment::Key("unicode".into())]),
                position,
                &stop
            )
            .await
            .is_err()
        );
    }
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn snapshot_search_uses_original_unicode_rows_and_rejects_invalid_navigation() {
    use maka_agent_state::{
        recall::Field,
        session_history::{navigation::SourceFind, source_tree::SourceTree},
    };
    let (_directory, root, snapshot, expected) =
        imported_fixture(true, HistoricalRole::Assistant).await;
    let stop = CancellationToken::new();
    let tree = SourceTree::snapshot(&snapshot).await.unwrap();
    let address = wire::HistoryRowAddress::Imported {
        path: Vec::new(),
        snapshot: snapshot.id(),
        message_ordinal: 0,
        part_ordinal: 1,
    };
    let query = |query: &str, case_sensitive, after| SourceFind {
        after,
        query: query.into(),
        case_sensitive,
        whole_word: false,
        include_internal: false,
    };
    let exact = tree
        .find_page(query("complete_suffix🙂", true, None), stop.clone())
        .await
        .unwrap();
    assert!(exact.matches.is_empty());
    let folded = tree
        .find_page(query("complete_suffix🙂", false, None), stop.clone())
        .await
        .unwrap();
    assert_eq!(folded.matches.len(), 1);
    assert_eq!(folded.matches[0].position, address);
    assert_eq!(folded.matches[0].field, Field::Body);
    assert!(folded.matches[0].preview.contains("COMPLETE_SUFFIX🙂"));
    assert!(!folded.matches[0].preview.contains('\0'));
    let tail = snapshot_source(
        &snapshot,
        address.clone(),
        wire::SourceField::Body,
        None,
        wire::SourcePosition::Tail,
        &stop,
    )
    .await
    .unwrap();
    assert!(tail.offset > 0);
    assert_eq!(tail.text, &expected[tail.offset as usize..]);
    assert!(tail.text.ends_with("COMPLETE_SUFFIX🙂\0"));
    let repeated = tree
        .find_page(query("正文", true, None), stop.clone())
        .await
        .unwrap();
    assert_eq!(
        repeated.matches.len(),
        1,
        "one source row, not one result per repeated match"
    );
    assert_eq!(repeated.matches[0].position, address);
    let continuation = repeated.matches[0].position.clone();
    let rest = tree
        .find_page(query("正文", true, Some(continuation)), stop.clone())
        .await
        .unwrap();
    assert!(rest.matches.is_empty());
    assert!(rest.next_after.is_none());
    let overlap = tree
        .find_page(query("🙂\0\n正文🙂", true, None), stop.clone())
        .await
        .unwrap();
    assert_eq!(overlap.matches.len(), 1);
    assert_eq!(overlap.matches[0].position, address);
    let empty = tree
        .find_page(query("", true, None), stop.clone())
        .await
        .err()
        .unwrap();
    assert!(empty.to_string().contains("invalid history search"));
    let mut missing = address.clone();
    if let wire::HistoryRowAddress::Imported { part_ordinal, .. } = &mut missing {
        *part_ordinal = 99;
    }
    let invalid = tree
        .find_page(query("正文", true, Some(missing)), stop.clone())
        .await
        .err()
        .unwrap();
    assert!(
        invalid
            .to_string()
            .contains("not an original source position"),
        "{invalid}"
    );
    stop.cancel();
    let cancelled = tree
        .find_page(query("正文", true, None), stop)
        .await
        .err()
        .unwrap();
    assert!(
        cancelled
            .to_string()
            .contains("source navigation cancelled")
    );
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn original_reference_flags_survive_start_and_tail_only_on_first_fragments() {
    let (_directory, root, snapshot, _) =
        imported_fixture_media(true, HistoricalRole::User, true).await;
    let stop = CancellationToken::new();
    for kind in 0..4u64 {
        let address = wire::HistoryRowAddress::Imported {
            path: Vec::new(),
            snapshot: snapshot.id(),
            message_ordinal: 0,
            part_ordinal: 6 + kind,
        };
        let total = format!("{}END🙂", "reference body🙂\0".repeat(4000)).len() as u64;
        for reverse in [false, true] {
            let position = if reverse {
                wire::Position::Before {
                    cursor: wire::Cursor {
                        position: address.clone(),
                        field: wire::HistoryField::Body,
                        offset: total,
                    },
                }
            } else {
                wire::Position::Row {
                    position: address.clone(),
                    field: wire::HistoryField::Body,
                }
            };
            let page = snapshot_page(&snapshot, position, false, wire::HistoryView::Text, &stop)
                .await
                .unwrap();
            assert!(encoded_bytes(&page).unwrap() <= 60 * 1024);
            let wire::Page::Ready { chunks, .. } = page;
            let row = chunks.iter().find(|row| row.position == address).unwrap();
            assert_eq!(row.has_references, kind != 0 && row.offset == 0);
            if reverse {
                assert!(row.offset > 0);
                assert!(row.text.ends_with("END🙂"));
            } else {
                assert_eq!(row.offset, 0);
                assert_eq!(row.has_references, kind != 0);
            }
        }
    }
    root.shutdown().await.unwrap();
}
