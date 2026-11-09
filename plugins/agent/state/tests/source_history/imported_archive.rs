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

use crate::support::{self, imported::Tape};
use maka_agent_facts::{
    artifact::ToolReturn,
    tool_output::{DurableToolProjection, ReturnedToolResult, ToolOutput},
};
use maka_agent_facts::{
    artifact::{Artifact, ArtifactKind, ArtifactSource, PublishedArtifact, content_digest},
    attachment::{AttachmentKind, AttachmentRef, StorageRef},
    durable::ContentRef,
    history_snapshot::{
        Entry, HistoricalRole, ImportedArtifactScope, ImportedMessage, ImportedPart,
        ImportedTurnOrdinal, SnapshotId,
    },
    input::MessageInput,
    model::{ModelPart, TextKind},
};
use maka_agent_state::session_history::{
    SessionHistory,
    navigation::SourceFind,
    snapshot::{ImportedCaptureRequest, Snapshot},
    source_tree::SourceTree,
};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

struct Fixture {
    snapshot: Snapshot,
    messages: Vec<ImportedMessage>,
    part: ContentRef,
    tool_part: ContentRef,
    raw_output: serde_json::Value,
    media: PublishedArtifact,
    text: String,
}
async fn fixture(history: &SessionHistory) -> Fixture {
    let mut tape = Tape::new();
    let raw = b"\xef\xbb\xbf{\"uuid\":\"foreign-uuid\",\"original\":true}\r\n";
    let original = tape.push_blob(raw);
    let body = tape.push_blob(b"original binary\0media\xff");
    let media = PublishedArtifact {
        artifact: Artifact {
            id: "image".into(),
            session_id: "session".into(),
            turn_id: "actual-import".into(),
            created_at: 1,
            name: "original.png".into(),
            kind: ArtifactKind::Image,
            size_bytes: body.bytes,
            mime_type: Some("image/png".into()),
            source: ArtifactSource::ToolResult,
            summary: Some("原图".into()),
        },
        payload: body,
    };
    tape.push_entry(&Entry::Artifact {
        owner: support::owner(),
        session: "session".into(),
        run: None,
        through_sequence: None,
        record: media.clone(),
    });
    let mut content: MessageInput = "source input".into();
    content.attachments = Some(vec![AttachmentRef {
        kind: AttachmentKind::Image,
        name: media.artifact.name.clone(),
        mime_type: "image/png".into(),
        bytes: media.artifact.size_bytes,
        storage_ref: StorageRef::SessionFile {
            session_id: "session".into(),
            relative_path: "image".into(),
        },
    }]);
    let input = tape.push_json(&ImportedPart::Input { content });
    let text = "原文🙂\0\n".repeat(6000);
    let part = tape.push_json(&ImportedPart::Model {
        part: ModelPart::Text {
            text_kind: TextKind::Text,
            text: text.clone().into(),
            provider_options: Some(Arc::new(serde_json::json!({"vendor":{"original":true}}))),
        },
    });
    let raw_output = serde_json::json!({"stdout":"raw\0output🙂","nested":{"all":[1,true,null]},"content":[{"type":"image","data":"this is JSON, not a typed MCP block"}]});
    let tool_part = tape.push_json(&ImportedPart::ToolReturn {
        call_id: "original-foreign-call".into(),
        name: "fixture.tool".into(),
        result: ToolReturn {
            schema_version: maka_agent_facts::durable::SCHEMA_VERSION,
            artifacts: vec![media.clone()],
            body: ReturnedToolResult {
                output: ToolOutput::Json(raw_output.clone()),
                projection: DurableToolProjection::Text {
                    text: "short model projection".into(),
                },
                is_error: false,
                loaded_tools: Default::default(),
            },
        },
    });
    let metadata = tape.push_json(
        &maka_agent_facts::history_snapshot::ImportedProviderMetadata {
            version: 1,
            source: maka_agent_facts::import::Source {
                adapter: "fixture".into(),
                session_id: "foreign".into(),
            },
            metadata: serde_json::json!({"private":"opaque evidence"}),
        },
    );
    let mut messages = Vec::new();
    for (ordinal, role, parts, ids) in [
        (0, HistoricalRole::User, vec![input], vec!["image".into()]),
        (1, HistoricalRole::Assistant, vec![part.clone()], vec![]),
        (
            2,
            HistoricalRole::Tool,
            vec![tool_part.clone()],
            vec!["image".into()],
        ),
    ] {
        let message = ImportedMessage {
            turn_ordinal: ImportedTurnOrdinal(0),
            original_ordinal: 0,
            media: ids,
            source_message_id: if ordinal == 2 {
                None
            } else {
                Some("foreign-uuid".into())
            },
            source_turn_id: None,
            timestamp: Some(12),
            role,
            artifact_scope: ImportedArtifactScope {
                owner: support::owner(),
                session: "session".into(),
            },
            parts,
            provider_metadata: Some(metadata.clone()),
            original: original.clone(),
        };
        let reference = tape.push_json(&message);
        tape.push_entry(&Entry::Imported {
            ordinal,
            message: reference,
        });
        messages.push(message);
    }
    let fingerprint = tape.original_source(vec![original], content_digest(raw));
    let request = ImportedCaptureRequest {
        id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
        source: maka_agent_facts::import::Source {
            adapter: "fixture".into(),
            session_id: "foreign".into(),
        },
        fingerprint,
    };
    let snapshot = tape
        .capture(history, request, CancellationToken::new())
        .await;
    Fixture {
        snapshot,
        messages,
        part,
        tool_part,
        raw_output,
        media,
        text,
    }
}
fn file(bytes: &[u8]) -> File {
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(bytes).unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    file
}

#[tokio::test]
async fn archive_preserves_foreign_ids_original_parts_media_and_scoped_navigation_after_transfer() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let history = state.session_history(support::owner(), "session".into());
    let fixture = fixture(&history).await;
    assert_eq!(
        fixture.snapshot.imported(None, 1).await.unwrap().items[0],
        (0, fixture.messages[0].clone())
    );
    assert_eq!(
        fixture.snapshot.imported(Some(0), 1).await.unwrap().items[0],
        (1, fixture.messages[1].clone())
    );
    assert!(
        fixture
            .snapshot
            .with_imported_content(0, &fixture.part, |_| Ok(()))
            .await
            .is_err()
    );
    let part: ImportedPart = fixture
        .snapshot
        .with_imported_content(1, &fixture.part, |reader| {
            Ok(serde_json::from_reader(reader)?)
        })
        .await
        .unwrap();
    let ImportedPart::Model {
        part:
            ModelPart::Text {
                text,
                provider_options,
                ..
            },
    } = part
    else {
        panic!("original ModelPart")
    };
    assert_eq!(text.to_string(), fixture.text);
    assert_eq!(
        provider_options.as_deref(),
        Some(&serde_json::json!({"vendor":{"original":true}}))
    );
    let tool: ImportedPart = fixture
        .snapshot
        .with_imported_content(2, &fixture.tool_part, |reader| {
            Ok(serde_json::from_reader(reader)?)
        })
        .await
        .unwrap();
    let ImportedPart::ToolReturn {
        call_id, result, ..
    } = tool
    else {
        panic!("original ToolReturn")
    };
    assert_eq!(call_id, "original-foreign-call");
    assert_eq!(result.artifacts, vec![fixture.media.clone()]);
    assert!(matches!(result.body.output,ToolOutput::Json(output) if output==fixture.raw_output));
    let tree = SourceTree::snapshot(&fixture.snapshot).await.unwrap();
    let rows = tree.positions(None, false, false, 16).await.unwrap();
    assert_eq!(rows.len(), 3);
    assert_ne!(rows[0].address, rows[1].address);
    use maka_agent_facts::model::prompt_source::source::{Allocate, ChargedBuffer, SourceBudget};
    struct ChunkBudget;
    impl SourceBudget for ChunkBudget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move {
                assert!(
                    minimum <= 32 * 1024,
                    "original source reading must use bounded work buffers"
                );
                Ok(ChargedBuffer::new(vec![0; minimum], ()))
            })
        }
    }
    let budget: Arc<dyn SourceBudget> = Arc::new(ChunkBudget);
    let result = tree
        .imported_tool_result(&rows[2].address, budget.clone(), &CancellationToken::new())
        .await
        .unwrap();
    use maka_agent_facts::model::prompt_source::source::json;
    assert!(
        json::text_eq(&result.call_id, "original-foreign-call", budget.clone())
            .await
            .unwrap()
    );
    assert!(
        json::text_eq(&result.name, "fixture.tool", budget.clone())
            .await
            .unwrap()
    );
    let raw = result.result.value(budget.clone()).await.unwrap();
    let mut cursor = raw.bytes().open(budget.clone());
    let mut buffer = budget.allocate(1024).await.unwrap();
    let mut original = Vec::new();
    loop {
        let read = cursor.read_chunk(buffer).await.unwrap();
        original.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            break;
        }
    }
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&original).unwrap(),
        fixture.raw_output
    );
    for mutation in 0..4 {
        let mut address = rows[2].address.clone();
        let maka_agent_facts::history::HistoryRowAddress::Imported {
            path,
            snapshot,
            message_ordinal,
            part_ordinal,
        } = &mut address
        else {
            panic!("actual imported result source");
        };
        match mutation {
            0 => path.push(maka_agent_facts::durable::RunId::new()),
            1 => *snapshot = SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
            2 => *message_ordinal = 0,
            _ => *part_ordinal = 1,
        }
        assert!(
            tree.imported_tool_result(&address, budget.clone(), &CancellationToken::new())
                .await
                .is_err()
        );
    }
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        tree.imported_tool_result(&rows[2].address, budget, &cancelled)
            .await
            .is_err()
    );
    assert!(tree.event_position(1, false).await.is_err());
    let matches = tree
        .find_page(
            SourceFind {
                after: None,
                query: "原文".into(),
                case_sensitive: false,
                whole_word: false,
                include_internal: false,
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(matches.matches[0].position, rows[1].address);
    let mut exported = fixture
        .snapshot
        .export(tempfile::tempfile().unwrap())
        .await
        .unwrap();
    let mut bytes = Vec::new();
    exported.file.read_to_end(&mut bytes).unwrap();
    let manifest = fixture.snapshot.manifest().await.unwrap();
    root.close().await.unwrap();
    let destination = tempfile::tempdir().unwrap();
    let target = support::open(destination.path(), false).await;
    support::create(&target, "target").await;
    let target_state = support::state(&target);
    let target_history = target_state.session_history(support::owner(), "target".into());
    let operation = uuid::Uuid::new_v4();
    let imported = target_history
        .import_snapshot(
            operation,
            exported.history.clone(),
            file(&bytes),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(imported.manifest().await.unwrap(), manifest);
    let record = imported
        .artifact(support::owner(), "session".into(), None, "image".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record, fixture.media);
    assert_eq!(
        imported.chunk(&record.payload, 0, u32::MAX).await.unwrap(),
        b"original binary\0media\xff"
    );
    assert!(
        imported
            .artifact(support::owner(), "target".into(), None, "image".into())
            .await
            .unwrap()
            .is_none()
    );
    let resumed = target_history
        .import_snapshot(
            operation,
            exported.history.clone(),
            tempfile::tempfile().unwrap(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(resumed.reference(), imported.reference());
    assert_eq!(
        SourceTree::snapshot(&imported)
            .await
            .unwrap()
            .positions(None, false, false, 16)
            .await
            .unwrap()
            .iter()
            .map(|row| &row.address)
            .collect::<Vec<_>>(),
        rows.iter().map(|row| &row.address).collect::<Vec<_>>()
    );
    let mut truncated = maka_agent_facts::history_snapshot::ARCHIVE_MAGIC.to_vec();
    truncated.extend_from_slice(&u64::MAX.to_be_bytes());
    let mut declared = exported.history.clone();
    use sha2::Digest;
    declared.object.digest = hex::encode(sha2::Sha256::digest(&truncated));
    declared.object.bytes = truncated.len() as u64;
    assert!(
        target_history
            .import_snapshot(
                uuid::Uuid::new_v4(),
                declared,
                file(&truncated),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    let mut corrupt = bytes;
    *corrupt.last_mut().unwrap() ^= 1;
    let failed = uuid::Uuid::new_v4();
    assert!(
        target_history
            .import_snapshot(
                failed,
                exported.history.clone(),
                file(&corrupt),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert!(
        target_history
            .imported_snapshot_receipt(failed, &exported.history)
            .await
            .unwrap()
            .is_none()
    );
    target.close().await.unwrap();
}

#[tokio::test]
async fn imported_capture_cannot_borrow_existing_root_bytes_by_hash_or_publish_partial_headers() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let history = state.session_history(support::owner(), "session".into());
    let fixture = fixture(&history).await;
    let mut tape = Tape::new();
    let original = tape.push_blob(b"owned original record");
    let fingerprint = tape.original_source(
        vec![original.clone()],
        content_digest(b"owned original record"),
    );
    let mut message = fixture.messages[1].clone();
    message.original = original;
    message.provider_metadata = None;
    // The part's digest exists in this Root, but this file does not supply it.
    let reference = tape.push_json(&message);
    tape.push_entry(&Entry::Imported {
        ordinal: 0,
        message: reference,
    });
    let request = ImportedCaptureRequest {
        id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
        source: maka_agent_facts::import::Source {
            adapter: "fixture".into(),
            session_id: "foreign".into(),
        },
        fingerprint,
    };
    assert!(
        history
            .capture_imported(request.clone(), tape.into_file(), CancellationToken::new())
            .await
            .is_err()
    );
    assert!(
        history
            .captured_imported(request.id, CancellationToken::new())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fixture
            .snapshot
            .imported(None, 16)
            .await
            .unwrap()
            .items
            .len(),
        3
    );
    root.close().await.unwrap();
}
