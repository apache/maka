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
    artifact::{Artifact, ArtifactKind, ArtifactSource, content_digest},
    attachment::AttachmentKind,
};
use serde_json::json;

async fn fixture() -> (tempfile::TempDir, RootStore, SessionStore, SessionStore) {
    let directory = tempfile::tempdir().unwrap();
    let p = directory.path();
    let root = RootStore::open(Arc::new(
        root::RootOwner::create(
            &p.join("root"),
            &root::RootNamespaces {
                ownership: p.join("owners"),
                control: p.join("control"),
            },
        )
        .unwrap(),
    ))
    .await
    .unwrap();
    let source = root
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    let target_id = (0..100)
        .map(|n| format!("target-{n}"))
        .find(|id| partition_for(b"session", id) != partition_for(b"session", "source"))
        .unwrap();
    let target = root
        .create_session(&target_id, &target_id, &json!({}), 1)
        .await
        .unwrap();
    (directory, root, source, target)
}
fn namespace() -> Namespace {
    Namespace::new("copy.fixture", maka_plugin_core::scope::Scope::Profile).unwrap()
}
async fn upload(source: &SessionStore, target: &SessionStore, bytes: &[u8]) -> CopyAttachment {
    source
        .commit_artifact(
            Artifact {
                id: "upload".into(),
                session_id: source.id().into(),
                turn_id: "upload".into(),
                created_at: 1,
                name: "file.bin".into(),
                kind: ArtifactKind::File,
                size_bytes: bytes.len() as u64,
                mime_type: Some("application/octet-stream".into()),
                source: ArtifactSource::UserUpload,
                summary: Some(content_digest(bytes)),
            },
            bytes.to_vec(),
        )
        .await
        .unwrap();
    CopyAttachment {
        target_session_id: target.id().into(),
        attachment: AttachmentRef {
            kind: AttachmentKind::Other,
            name: "file.bin".into(),
            mime_type: "application/octet-stream".into(),
            bytes: bytes.len() as u64,
            storage_ref: StorageRef::SessionFile {
                session_id: source.id().into(),
                relative_path: "upload".into(),
            },
        },
    }
}
async fn count(target: &SessionStore) -> i64 {
    target
        .owner()
        .unwrap()
        .connection
        .read(|connection| {
            Box::pin(async move {
                Ok(sqlx::query_scalar("SELECT count(*) FROM artifacts")
                    .fetch_one(connection)
                    .await?)
            })
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn cross_partition_copy_streams_complete_bytes_and_retries_same_receipt() {
    let (_directory, root, source, target) = fixture().await;
    let bytes: Vec<u8> = (0..(3 * 64 * 1024 + 17)).map(|i| (i % 251) as u8).collect();
    let request = upload(&source, &target, &bytes).await;
    upload(&target, &source, &bytes).await;
    let copied = root
        .copy_plugin_attachment(&namespace(), request.clone())
        .await
        .unwrap();
    let StorageRef::SessionFile {
        session_id,
        relative_path,
    } = &copied.storage_ref
    else {
        panic!()
    };
    let observed = target
        .read_artifact_chunk(session_id, relative_path, 0, bytes.len())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed.bytes, bytes);
    let before = target
        .get_artifact(session_id, relative_path)
        .await
        .unwrap();
    assert_eq!(
        root.copy_plugin_attachment(&namespace(), request)
            .await
            .unwrap(),
        copied
    );
    let after = target
        .get_artifact(session_id, relative_path)
        .await
        .unwrap();
    assert_eq!(before.revision, after.revision);
    assert_eq!(before.record, after.record);
    assert_eq!(count(&target).await, 2);
    assert_eq!(physical_content(&target).await, (1, bytes.len() as i64, 2));
    root.close().await.unwrap();
}

#[tokio::test]
async fn corrupted_source_rolls_back_target_payload_and_catalog() {
    let (_directory, root, source, target) = fixture().await;
    let request = upload(&source, &target, &vec![7; 64 * 1024 + 1]).await;
    source
        .owner()
        .unwrap()
        .connection
        .run(|connection| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE artifact_contents SET payload=zeroblob(length(payload)) WHERE content_sha256 IN (SELECT content_sha256 FROM artifacts WHERE id='upload')",
                )
                .execute(connection)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        root.copy_plugin_attachment(&namespace(), request)
            .await
            .is_err()
    );
    assert_eq!(count(&target).await, 0);
    let catalog: i64 = target
        .owner()
        .unwrap()
        .connection
        .read(|connection| {
            Box::pin(async move {
                Ok(sqlx::query_scalar("SELECT count(*) FROM artifact_catalog")
                    .fetch_one(connection)
                    .await?)
            })
        })
        .await
        .unwrap();
    assert_eq!(catalog, 0);
    root.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_accepted_copy_keeps_both_session_pins_until_target_cleanup() {
    use std::task::Poll;
    use tokio::sync::oneshot;
    let (_directory, root, source, target) = fixture().await;
    let request = upload(&source, &target, &vec![3; 2 * 64 * 1024 + 1]).await;
    let (source_owner, target_owner, same) = root
        .pin_session_pair(source.id(), target.id(), None)
        .await
        .unwrap();
    assert!(!same);
    let (entered, started) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let owner = target.owner().unwrap();
    let blocker = tokio::spawn(async move {
        owner
            .connection
            .run(move |_| {
                Box::pin(async move {
                    entered.send(()).unwrap();
                    released.await.unwrap();
                    Ok(())
                })
            })
            .await
            .unwrap();
    });
    started.await.unwrap();
    let namespace = namespace();
    let mut operation =
        Box::pin(target_owner.copy_attachment_from_partition(source_owner, &namespace, request));
    std::future::poll_fn(|cx| {
        assert!(operation.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(operation);
    drop(target_owner);
    for id in [source.id(), target.id()] {
        assert!(
            root.gates
                .try_write([gates::Key::Session(id.into())])
                .unwrap()
                .is_none()
        );
    }
    release.send(()).unwrap();
    blocker.await.unwrap();
    target
        .owner()
        .unwrap()
        .connection
        .run(|_| Box::pin(async { Ok(()) }))
        .await
        .unwrap();
    assert_eq!(count(&target).await, 1);
    for id in [source.id(), target.id()] {
        assert!(
            root.gates
                .try_write([gates::Key::Session(id.into())])
                .unwrap()
                .is_some()
        );
    }
    root.close().await.unwrap();
}

#[tokio::test]
async fn cross_partition_image_freezes_at_target_consumption_and_survives_bundle() {
    use maka_agent_facts::{
        event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
        model::{
            ModelFinishReason, ModelPart, ModelToolCall, ModelUsage, recorded::ModelCompletion,
        },
        tool_call::ToolCallIdentity,
        tool_output::{ImageOutput, ToolContent, ToolOutput, ToolSuccess},
    };
    let (_directory, root, source, target) = fixture().await;
    let bytes = vec![
        71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0,
        0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 68, 0, 59,
    ];
    source
        .commit_artifact(
            Artifact {
                id: "image".into(),
                session_id: source.id().into(),
                turn_id: "upload".into(),
                created_at: 1,
                name: "image.gif".into(),
                kind: ArtifactKind::Image,
                size_bytes: bytes.len() as u64,
                mime_type: Some("image/gif".into()),
                source: ArtifactSource::UserUpload,
                summary: Some(content_digest(&bytes)),
            },
            bytes.clone(),
        )
        .await
        .unwrap();
    source
        .owner()
        .unwrap()
        .connection
        .run(|db| {
            Box::pin(async move {
                sqlx::query("UPDATE artifacts SET canonical_at=1000 WHERE id='image'")
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    // Six ordinary facts in this partition put the target's own dispatch at
    // sequence 10, independently of the source partition's much higher freeze.
    let padding = (0..1000)
        .map(|n| format!("padding-{n}"))
        .filter(|id| partition_for(b"session", id) == partition_for(b"session", target.id()))
        .take(6);
    for id in padding {
        let session = root.create_session(&id, &id, &json!({}), 1).await.unwrap();
        session
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    Invocation {
                        session_id: id.clone(),
                        turn_id: format!("turn-{id}"),
                        run_id: format!("run-{id}"),
                        invocation_id: uuid::Uuid::new_v4().to_string(),
                    },
                    Fact::InvocationOpened {
                        configuration: None,
                        input: InvocationInput::Message {
                            source_messages: Vec::new(),
                            content: "padding".into(),
                            request_fingerprint: None,
                        },
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
    }
    let invocation = Invocation {
        session_id: target.id().into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    target
        .append(&event(Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "image".into(),
                request_fingerprint: None,
            },
        }))
        .await
        .unwrap();
    let context = target
        .read_model_view(target.id(), Some(&invocation.invocation_id))
        .await
        .unwrap();
    target
        .append(&event(Fact::ModelRequested {
            source_capture: maka_agent_facts::event::SourceCapture {
                publication_watermark: context.selection.captured_through,
                prior_unknown: context.selection.prior_unknown,
            },
            context_breakdown: None,
            item_acceptance: false,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: "step".into(),
            model_id: "model".into(),
            source_scope: context.source_evidence.scope,
            source_high_water: context.source_evidence.high_water,
            source_digest: context.source_evidence.digest,
            effective_source_digest: Some(context.effective_source_digest),
            input_digest: "fixture".into(),
            route_identity: "route".into(),
        }))
        .await
        .unwrap();
    let call = ModelToolCall {
        id: "image-call".into(),
        name: "Read".into(),
        input: serde_json::Value::Null.into(),
        provider_options: None,
        provider_executed: false,
    };
    target
        .append(&event(Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelCompletion {
                parts: owned_parts(
                    &invocation.invocation_id,
                    "step",
                    vec![ModelPart::ToolCall { call }],
                ),
                finish_reason: ModelFinishReason::ToolCalls,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        }))
        .await
        .unwrap();
    target
        .append(&event(Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "step:image-call".into(),
            call: ToolCallIdentity::provider("step".into(), "image-call".into()),
            name: "Read".into(),
            input: serde_json::Value::Null,
        }))
        .await
        .unwrap();
    let request = CopyAttachment {
        target_session_id: target.id().into(),
        attachment: AttachmentRef {
            kind: AttachmentKind::Image,
            name: "image.gif".into(),
            mime_type: "image/gif".into(),
            bytes: bytes.len() as u64,
            storage_ref: StorageRef::SessionFile {
                session_id: source.id().into(),
                relative_path: "image".into(),
            },
        },
    };
    let copied = root
        .copy_plugin_attachment(&namespace(), request.clone())
        .await
        .unwrap();
    let StorageRef::SessionFile {
        session_id,
        relative_path,
    } = copied.storage_ref.clone()
    else {
        panic!()
    };
    let artifact_id = relative_path.clone();
    assert_eq!(
        target
            .owner()
            .unwrap()
            .connection
            .read(move |db| Box::pin(async move {
                Ok(sqlx::query_scalar::<_, Option<i64>>(
                    "SELECT canonical_at FROM artifacts WHERE id=?",
                )
                .bind(artifact_id)
                .fetch_one(db)
                .await?)
            }))
            .await
            .unwrap(),
        None
    );
    let (settled, _) = EventWrite::tool_success(
        "settled".into(),
        std::time::SystemTime::now(),
        invocation.clone(),
        "step:image-call".into(),
        ToolSuccess::content(
            ToolOutput::Json(json!({})),
            vec![ToolContent::Image(ImageOutput {
                detail: None,
                mime_type: "image/gif".into(),
                reference: copied.storage_ref.clone(),
            })],
        ),
    )
    .unwrap();
    assert_eq!(target.append(&settled).await.unwrap(), 11);
    root.copy_plugin_attachment(&namespace(), request)
        .await
        .unwrap();
    let image = target
        .owner()
        .unwrap()
        .connection
        .read(move |db| {
            Box::pin(async move {
                let frozen: Option<i64> =
                    sqlx::query_scalar("SELECT canonical_at FROM artifacts WHERE id=?")
                        .bind(&relative_path)
                        .fetch_one(&mut *db)
                        .await?;
                assert_eq!(frozen, Some(11));
                crate::artifacts::read_image(
                    db,
                    &session_id,
                    &relative_path,
                    "image/gif",
                    0,
                    1024,
                    11,
                )
                .await
            })
        })
        .await
        .unwrap();
    assert_eq!(image.bytes, bytes);
    target
        .append(&event(Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        }))
        .await
        .unwrap();
    let inventory = root.preview_bundle(target.id()).await.unwrap();
    let (encoded, _) = root
        .export_bundle(target.id(), &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    let mut staged = crate::bundle::StagedBundle::read(encoded.as_slice())
        .await
        .unwrap();
    staged.validate_history().await.unwrap();
    staged.close().await.unwrap();
    root.close().await.unwrap();
}

fn owned_parts(
    invocation: &str,
    step: &str,
    parts: Vec<maka_agent_facts::model::ModelPart>,
) -> Vec<maka_agent_facts::model::recorded::CompletionPart> {
    use maka_agent_facts::model::{
        ModelPart,
        recorded::{CompletionPart, ModelPartRecord},
    };
    parts
        .into_iter()
        .enumerate()
        .map(|(ordinal, part)| {
            let message_id = match &part {
                ModelPart::ToolCall { call } => maka_agent_facts::tool_call::tool_use_id(
                    invocation,
                    &format!("{step}:{}", call.id),
                ),
                _ => uuid::Uuid::new_v4().to_string(),
            };
            CompletionPart::Own(ModelPartRecord {
                ordinal: ordinal as u64,
                message_id,
                started_at: std::time::UNIX_EPOCH,
                provider_part_id: None,
                part: std::sync::Arc::new(part),
            })
        })
        .collect()
}

async fn physical_content(session: &SessionStore) -> (i64, i64, i64) {
    session.owner().unwrap().connection.read(|db| Box::pin(async move {
        Ok(sqlx::query_as("SELECT COUNT(*),COALESCE(SUM(length(payload)),0),(SELECT COUNT(*) FROM artifacts) FROM artifact_contents")
            .fetch_one(db).await?)
    })).await.unwrap()
}

#[tokio::test]
async fn large_attachment_forks_share_one_body_until_the_last_session_retires() {
    use crate::sessions::{SessionCopy, SessionCopyResult, SessionRetirement};
    use maka_agent_facts::event::{
        EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent,
    };
    use maka_agent_facts::session::{CopyPurpose, ForkPosition};
    let (_directory, root, source, target) = fixture().await;
    let bytes = vec![43; 1024 * 1024 + 17];
    let attachment = upload(&source, &target, &bytes).await.attachment;
    let mut input: maka_agent_facts::input::MessageInput = "shared attachment".into();
    input.attachments = Some(vec![attachment]);
    let invocation = Invocation {
        session_id: "source".into(),
        turn_id: "upload".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: input,
                source_messages: vec![],
                request_fingerprint: None,
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        source
            .append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
    for index in 0..10 {
        let revision = source
            .get::<serde_json::Value>()
            .await
            .unwrap()
            .unwrap()
            .revision;
        assert!(matches!(
            root.copy_session(
                SessionCopy {
                    source_session_id: "source".into(),
                    target_session_id: format!("fork-{index}"),
                    expected_source_revision: revision,
                    purpose: CopyPurpose::Branch {
                        position: ForkPosition::End,
                        side_conversation: false
                    }
                },
                &json!({}),
                2
            )
            .await
            .unwrap(),
            SessionCopyResult::Committed(_)
        ));
    }
    assert_eq!(physical_content(&source).await, (1, 1024 * 1024 + 17, 11));
    for id in std::iter::once("source".to_owned()).chain((0..9).map(|i| format!("fork-{i}"))) {
        let session = root.session(&id).await.unwrap();
        let revision = session
            .get::<serde_json::Value>()
            .await
            .unwrap()
            .unwrap()
            .revision;
        root.begin_session_removal(&id, revision).await.unwrap();
        assert_eq!(
            root.finish_session_retirement(&id).await.unwrap(),
            SessionRetirement::Removed
        );
    }
    let survivor = root.session("fork-9").await.unwrap();
    assert_eq!(physical_content(&survivor).await, (1, 1024 * 1024 + 17, 1));
    let original_owner = root.control.owned_root().unwrap();
    root.close().await.unwrap();
    let root = RootStore::open(original_owner).await.unwrap();
    let survivor = root.session("fork-9").await.unwrap();
    let artifact = survivor
        .list_artifacts("fork-9", 0, 128)
        .await
        .unwrap()
        .records
        .pop()
        .unwrap();
    assert_eq!(
        survivor
            .read_artifact_chunk("fork-9", &artifact.id, 0, bytes.len())
            .await
            .unwrap()
            .unwrap()
            .bytes,
        bytes
    );
    let revision = survivor
        .get::<serde_json::Value>()
        .await
        .unwrap()
        .unwrap()
        .revision;
    root.begin_session_removal("fork-9", revision)
        .await
        .unwrap();
    assert_eq!(
        root.finish_session_retirement("fork-9").await.unwrap(),
        SessionRetirement::Removed
    );
    assert_eq!(physical_content(&survivor).await, (0, 0, 0));
    root.close().await.unwrap();
}

#[tokio::test]
async fn existing_content_digest_never_bypasses_incoming_byte_comparison() {
    let (_directory, root, source, target) = fixture().await;
    let bytes = vec![17; 64 * 1024 + 17];
    let request = upload(&source, &target, &bytes).await;
    upload(&target, &source, &bytes).await;
    let before = target.get_artifact(target.id(), "upload").await.unwrap();
    target
        .owner()
        .unwrap()
        .connection
        .run(|db| {
            Box::pin(async move {
                sqlx::query("UPDATE artifact_contents SET payload=zeroblob(length(payload))")
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(matches!(
        root.copy_plugin_attachment(&namespace(), request).await,
        Err(StoreError::ArtifactConflict)
    ));
    let mut another = before.record.clone().unwrap();
    another.id = "new-upload".into();
    assert!(matches!(
        target.commit_artifact(another, bytes.clone()).await,
        Err(StoreError::ArtifactConflict)
    ));
    assert_eq!(
        target
            .get_artifact(target.id(), "upload")
            .await
            .unwrap()
            .revision,
        before.revision
    );
    assert_eq!(physical_content(&target).await, (1, bytes.len() as i64, 1));
    assert_eq!(
        target
            .read_artifact_chunk(target.id(), "upload", 0, 17)
            .await
            .unwrap()
            .unwrap()
            .bytes,
        vec![0; 17]
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn deleting_the_last_upload_reference_automatically_returns_database_pages() {
    let (_directory, root, source, target) = fixture().await;
    let bytes = vec![91; 1024 * 1024 + 17];
    upload(&source, &target, &bytes).await;
    let owner = source.owner().unwrap();
    let pages_before: i64 = owner
        .connection
        .read(|db| {
            Box::pin(async move {
                Ok(sqlx::query_scalar("PRAGMA page_count")
                    .fetch_one(db)
                    .await?)
            })
        })
        .await
        .unwrap();
    assert_eq!(
        source
            .delete_user_artifact(source.id(), "upload")
            .await
            .unwrap(),
        crate::artifacts::ArtifactDeletion::Deleted
    );
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let (pages, free): (i64, i64) = owner
                .connection
                .read(|db| {
                    Box::pin(async move {
                        let pages = sqlx::query_scalar("PRAGMA page_count")
                            .fetch_one(&mut *db)
                            .await?;
                        let free = sqlx::query_scalar("PRAGMA freelist_count")
                            .fetch_one(db)
                            .await?;
                        Ok((pages, free))
                    })
                })
                .await
                .unwrap();
            if pages < pages_before && free == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect(
        "Root maintenance must return pages after upload deletion without a Session retirement",
    );
    assert_eq!(physical_content(&source).await, (0, 0, 0));
    root.close().await.unwrap();
}
