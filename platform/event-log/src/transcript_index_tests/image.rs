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
use maka_agent_facts::artifact::content_digest;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_output::ToolSuccess;
use maka_agent_ports::session::history::Page;
use maka_agent_ports::session::history::Position;
use maka_agent_ports::session::history::Role;
use maka_event_log::artifacts::ArtifactDeletion;

#[tokio::test]
async fn actual_tool_images_are_immutable_scoped_and_reconstructed_without_paths() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("images.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    for session in ["images", "other"] {
        log.create_session(session, session, &Value::Null, 1)
            .await
            .unwrap();
    }
    log.append(&event("images", opening())).await.unwrap();
    log.append(&event("images", request("images")))
        .await
        .unwrap();
    let call = maka_agent_facts::model::ModelToolCall {
        id: "image-call".into(),
        name: "Read".into(),
        input: Value::Null.into(),
        provider_options: None,
        provider_executed: false,
    };
    log.append(&event(
        "images",
        observe("images", ModelEvent::ToolCall(call.clone())),
    ))
    .await
    .unwrap();
    log.append(&event(
        "images",
        Fact::ModelCompleted {
            step_id: "step-images".into(),
            output: ModelStep {
                parts: vec![ModelPart::ToolCall { call }],
                finish_reason: maka_agent_facts::model::ModelFinishReason::ToolCalls,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ))
    .await
    .unwrap();
    let old = log
        .append(&event(
            "images",
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "step-images:image-call".into(),
                call: ToolCallIdentity::provider("step-images".into(), "image-call".into()),
                name: "Read".into(),
                input: Value::Null,
            },
        ))
        .await
        .unwrap();
    // Real 1x1 GIF with legal comment sub-blocks, large enough for multiple chunks.
    let mut bytes = vec![
        71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0,
        0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 68, 0,
    ];
    bytes.extend([0x21, 0xfe]);
    for _ in 0..40 {
        bytes.push(255);
        bytes.extend([b'x'; 255]);
    }
    bytes.extend([0, 0x3b]);
    let template = event(
        "images",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    let (result, _) = maka_agent_facts::event::EventWrite::tool_success(
        "image-result".into(),
        template.event().recorded_at,
        template.event().invocation.clone(),
        "step-images:image-call".into(),
        ToolSuccess::image(bytes.clone(), "image/gif".into()).unwrap(),
    )
    .unwrap();
    let artifact = result.projection_artifacts()[0].artifact().clone();
    log.append(&result).await.unwrap();
    let through = end(&log, "images", InvocationOutcome::Completed).await;

    let Page::Ready { chunks, .. } = log
        .history_text(
            "images",
            through,
            Position::Start,
            false,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(8),
                max_json_bytes: 64 * 1024,
            },
        )
        .await
        .unwrap();
    let sequence = chunks
        .iter()
        .find(|chunk| chunk.role == Role::ToolResult)
        .unwrap()
        .position;
    assert!(chunks.iter().any(|chunk| {
        chunk
            .tool
            .as_ref()
            .is_some_and(|tool| tool.result.as_ref().is_some_and(|result| result.image))
    }));
    for limit in [1, 17, 8192, 32768] {
        let mut assembled = Vec::new();
        while assembled.len() < bytes.len() {
            let chunk = log
                .tool_image("images", through, sequence, assembled.len() as u64, limit)
                .await
                .unwrap();
            assert_eq!(chunk.total_bytes, bytes.len() as u64);
            assert_eq!(chunk.mime_type, "image/gif");
            assert_eq!(chunk.digest, content_digest(&bytes));
            assert!(!chunk.bytes.is_empty());
            assert!(chunk.bytes.len() <= limit);
            assembled.extend(chunk.bytes);
        }
        assert_eq!(assembled, bytes);
    }
    let eof = log
        .tool_image("images", through, sequence, bytes.len() as u64, 8192)
        .await
        .unwrap();
    assert!(eof.bytes.is_empty());
    assert!(
        log.tool_image("images", through, sequence, bytes.len() as u64 + 1, 8192)
            .await
            .is_err()
    );
    assert!(
        log.tool_image("images", old, sequence, 0, 8192)
            .await
            .is_err()
    );
    assert!(
        log.tool_image("other", through, sequence, 0, 8192)
            .await
            .is_err()
    );
    let call = chunks
        .iter()
        .find(|chunk| chunk.role == Role::ToolCall)
        .unwrap()
        .position;
    assert!(
        log.tool_image("images", through, call, 0, 8192)
            .await
            .is_err()
    );
    assert_eq!(
        log.delete_user_artifact("images", &artifact.id)
            .await
            .unwrap(),
        ArtifactDeletion::Protected
    );
    let mut replacement = artifact.clone();
    replacement.size_bytes = 1;
    assert!(log.commit_artifact(replacement, vec![0]).await.is_err());
    assert_eq!(
        log.tool_image("images", through, sequence, 0, 8192)
            .await
            .unwrap()
            .digest,
        content_digest(&bytes)
    );
    let source = log.get_session::<Value>("images").await.unwrap().unwrap();
    let copied = log
        .copy_session(
            maka_event_log::sessions::SessionCopy {
                source_session_id: "images".into(),
                target_session_id: "copy".into(),
                expected_source_revision: source.revision,
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    turn_id: None,
                    side_conversation: false,
                },
            },
            &Value::Null,
            2,
        )
        .await
        .unwrap();
    assert!(matches!(
        copied,
        maka_event_log::sessions::SessionCopyResult::Committed(_)
    ));
    let copy_fence = *log.subscribe_commits().borrow();

    let Page::Ready {
        chunks: copy_chunks,
        ..
    } = log
        .history_text(
            "copy",
            copy_fence,
            Position::Start,
            false,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(8),
                max_json_bytes: 64 * 1024,
            },
        )
        .await
        .unwrap();
    let copied_sequence = copy_chunks
        .iter()
        .find(|chunk| chunk.role == Role::ToolResult)
        .unwrap()
        .position;
    assert_eq!(
        log.tool_image("copy", copy_fence, copied_sequence, 0, 8192)
            .await
            .unwrap()
            .bytes,
        bytes[..8192]
    );
    let copied_id: String = crate::test_store::inspect_cache(&log, move |db| { db.query_row("SELECT json_extract(payload,'$.content.ref.relativePath') FROM temp.transcript_rows WHERE session_id='copy' AND source_sequence=? AND item_index=?",[copied_sequence.source_sequence as i64, copied_sequence.item_index as i64],|row|row.get(0)).unwrap() }).await;
    assert!(!dir.path().join(&artifact.id).exists());
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.tool_image("images", through, sequence, 0, 8192)
            .await
            .unwrap()
            .bytes,
        bytes[..8192]
    );
    // Runtime-owned sources also require an original freeze; protection alone
    // cannot make bytes created later belong to an earlier borrowed reference.
    let db = Connection::open(&path).unwrap();
    let frozen: i64 = db
        .query_row(
            "SELECT canonical_at FROM artifacts WHERE session_id='images' AND id=?",
            [&artifact.id],
            |row| row.get(0),
        )
        .unwrap();
    db.execute(
        "UPDATE artifacts SET canonical_at=? WHERE session_id='images' AND id=?",
        rusqlite::params![through as i64, &artifact.id],
    )
    .unwrap();
    assert!(
        log.tool_image("images", through, sequence, 0, 8192)
            .await
            .is_err()
    );
    db.execute(
        "UPDATE artifacts SET canonical_at=? WHERE session_id='images' AND id=?",
        rusqlite::params![frozen, &artifact.id],
    )
    .unwrap();
    drop(db);
    // A lost retention proof must not let an old row read replacement bytes.
    // Corrupt only this isolated fixture's protection to exercise that boundary.
    let db = Connection::open(&path).unwrap();
    db.execute("UPDATE artifacts SET record_json=json_set(record_json,'$.mimeType','image/png') WHERE session_id='images' AND id=?",[&artifact.id]).unwrap();
    assert!(
        log.tool_image("images", through, sequence, 0, 8192)
            .await
            .is_err()
    );
    db.execute("UPDATE artifacts SET record_json=json_set(record_json,'$.mimeType','image/gif','$.source','user_upload') WHERE session_id='images' AND id=?",[&artifact.id]).unwrap();

    db.execute("UPDATE artifacts SET record_json=json_set(record_json,'$.source','user_upload') WHERE session_id='copy' AND id=?",[&copied_id]).unwrap();
    assert!(
        log.tool_image("copy", copy_fence, copied_sequence, 0, 8192)
            .await
            .is_ok(),
        "copy inherits the original canonical freeze"
    );

    db.execute(
        "UPDATE artifacts SET canonical_at=? WHERE session_id='images' AND id=?",
        rusqlite::params![through as i64, &artifact.id],
    )
    .unwrap();
    assert!(
        log.tool_image("images", through, sequence, 0, 8192)
            .await
            .is_err(),
        "later freeze cannot justify an earlier row"
    );
    let raw_metadata: String = db
        .query_row(
            "SELECT record_json FROM artifacts WHERE session_id='images' AND id=?",
            [&artifact.id],
            |r| r.get(0),
        )
        .unwrap();
    // Simulate corrupted on-disk material, bypassing normal write constraints
    // only on this isolated fixture connection. Reads still must be bounded.
    db.execute_batch("PRAGMA ignore_check_constraints=ON")
        .unwrap();
    db.execute("UPDATE artifacts SET record_json=json_set(record_json,'$.name',?) WHERE session_id='images' AND id=?",rusqlite::params!["x".repeat(20000),&artifact.id]).unwrap();
    assert!(
        log.tool_image("images", through, sequence, 0, 8192)
            .await
            .is_err()
    );
    db.execute("UPDATE artifacts SET record_json=?,canonical_at=NULL,content_sha256=? WHERE session_id='images' AND id=?",rusqlite::params![raw_metadata,"x".repeat(100000),&artifact.id]).unwrap();
    assert!(
        log.tool_image("images", through, sequence, 0, 8192)
            .await
            .is_err()
    );
    db.execute(
        "UPDATE artifacts SET content_sha256=? WHERE session_id='images' AND id=?",
        rusqlite::params![content_digest(&bytes), &artifact.id],
    )
    .unwrap();
    db.execute(
        "DELETE FROM session_history_artifacts WHERE session_id='images' AND artifact_id=?",
        [&artifact.id],
    )
    .unwrap();
    assert!(
        log.tool_image("images", through, sequence, 0, 8192)
            .await
            .is_err()
    );
    assert_eq!(
        log.delete_user_artifact("images", &artifact.id)
            .await
            .unwrap(),
        ArtifactDeletion::Deleted
    );
    let new_bytes = vec![7; bytes.len()];
    let mut replacement = artifact;
    replacement.source = maka_agent_facts::artifact::ArtifactSource::UserUpload;
    replacement.summary = Some(content_digest(&new_bytes));
    log.commit_artifact(replacement, new_bytes).await.unwrap();
    assert!(
        log.tool_image("images", through, sequence, 0, 8192)
            .await
            .is_err(),
        "fresh digest cannot justify old-row pixels"
    );
    drop(db);
    log.close().await.unwrap();
}

#[tokio::test]
async fn borrowed_upload_is_frozen_at_settlement_before_any_history_copy() {
    use maka_agent_facts::artifact::Artifact;
    use maka_agent_facts::artifact::ArtifactKind;
    use maka_agent_facts::artifact::ArtifactSource;
    use maka_agent_facts::attachment::StorageRef;
    use maka_agent_facts::tool_output::ImageOutput;
    use maka_agent_facts::tool_output::ToolOutput;
    let dir = tempfile::tempdir().unwrap();
    let log = EventLog::open(&dir.path().join("borrowed.sqlite"))
        .await
        .unwrap();
    log.create_session("borrowed", "borrowed", &Value::Null, 1)
        .await
        .unwrap();
    let bytes = vec![
        71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0,
        0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 68, 0, 59,
    ];
    let artifact = Artifact {
        id: "upload".into(),
        session_id: "borrowed".into(),
        turn_id: "upload".into(),
        created_at: 1,
        name: "image.gif".into(),
        kind: ArtifactKind::Image,
        size_bytes: bytes.len() as u64,
        mime_type: Some("image/gif".into()),
        source: ArtifactSource::UserUpload,
        summary: Some(content_digest(&bytes)),
    };
    log.commit_artifact(artifact.clone(), bytes.clone())
        .await
        .unwrap();
    log.append(&event("borrowed", opening())).await.unwrap();
    log.append(&event("borrowed", request("borrowed")))
        .await
        .unwrap();
    let call = maka_agent_facts::model::ModelToolCall {
        id: "image".into(),
        name: "Read".into(),
        input: Value::Null.into(),
        provider_options: None,
        provider_executed: false,
    };
    log.append(&event(
        "borrowed",
        observe("borrowed", ModelEvent::ToolCall(call.clone())),
    ))
    .await
    .unwrap();
    log.append(&event(
        "borrowed",
        Fact::ModelCompleted {
            step_id: "step-borrowed".into(),
            output: ModelStep {
                parts: vec![ModelPart::ToolCall { call }],
                finish_reason: maka_agent_facts::model::ModelFinishReason::ToolCalls,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ))
    .await
    .unwrap();
    log.append(&event(
        "borrowed",
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "step-borrowed:image".into(),
            call: ToolCallIdentity::provider("step-borrowed".into(), "image".into()),
            name: "Read".into(),
            input: Value::Null,
        },
    ))
    .await
    .unwrap();
    let template = event(
        "borrowed",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    let output = ToolOutput::Image(ImageOutput {
        detail: None,
        mime_type: "image/gif".into(),
        reference: StorageRef::SessionFile {
            session_id: "borrowed".into(),
            relative_path: "upload".into(),
        },
    });
    let (result, _) = maka_agent_facts::event::EventWrite::tool_success(
        "borrowed-result".into(),
        template.event().recorded_at,
        template.event().invocation.clone(),
        "step-borrowed:image".into(),
        output.into(),
    )
    .unwrap();
    log.append(&result).await.unwrap();
    let through = end(&log, "borrowed", InvocationOutcome::Completed).await;
    // No copy or SQL fixture mutation: the original committed fact protects bytes.
    assert!(
        log.session_copy_receipt("borrowed-copy")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        log.delete_user_artifact("borrowed", "upload")
            .await
            .unwrap(),
        ArtifactDeletion::Protected
    );
    let new_bytes = vec![7; bytes.len()];
    let mut replacement = artifact;
    replacement.summary = Some(content_digest(&new_bytes));
    assert!(log.commit_artifact(replacement, new_bytes).await.is_err());
    let source = log.get_session::<Value>("borrowed").await.unwrap().unwrap();
    log.copy_session(
        maka_event_log::sessions::SessionCopy {
            source_session_id: "borrowed".into(),
            target_session_id: "borrowed-copy".into(),
            expected_source_revision: source.revision,
            purpose: maka_agent_facts::session::CopyPurpose::Branch {
                turn_id: None,
                side_conversation: false,
            },
        },
        &Value::Null,
        2,
    )
    .await
    .unwrap();
    for session in ["borrowed", "borrowed-copy"] {
        let Page::Ready { chunks, .. } = log
            .history_text(
                session,
                through,
                Position::Start,
                false,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(8),
                    max_json_bytes: 64 * 1024,
                },
            )
            .await
            .unwrap();
        let sequence = chunks
            .iter()
            .find(|chunk| chunk.role == Role::ToolResult)
            .unwrap()
            .position;
        assert_eq!(
            log.tool_image(session, through, sequence, 0, 8192)
                .await
                .unwrap()
                .bytes,
            bytes
        );
    }
    log.close().await.unwrap();
}
