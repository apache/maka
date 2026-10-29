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

use maka_agent_facts::artifact::Artifact;
use maka_agent_facts::artifact::ArtifactKind;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::artifact::content_digest;
use maka_agent_facts::attachment::StorageRef;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::session::CopyPurpose;
use maka_agent_facts::tool_output::ImageOutput;
use maka_agent_facts::tool_output::ToolOutput;
use maka_agent_facts::tool_output::ToolSuccess;
use maka_agent_ports::session::history::Page;
use maka_agent_ports::session::history::Position;
use maka_agent_ports::session::history::Role;
use maka_agent_ports::session::history::Tool;
use maka_event_log::{
    EventLog,
    artifacts::ArtifactReadScope,
    bundle::{self, StagedBundle},
    sessions::SessionCopy,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const GIF: &[u8] = &[
    71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0,
    0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 68, 0, 59,
];
fn invocation(session: &str, run: &str) -> Invocation {
    Invocation {
        session_id: session.into(),
        turn_id: run.into(),
        run_id: run.into(),
        invocation_id: run.into(),
    }
}
async fn open(log: &EventLog, i: &Invocation) {
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            i.clone(),
            Fact::InvocationOpened {
                input: InvocationInput::Message {
                    content: "image test".into(),
                    source_messages: Vec::new(),
                    request_fingerprint: None,
                },
                configuration: None,
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
}
async fn end(log: &EventLog, i: &Invocation) {
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            i.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
}
fn borrowed(id: &str) -> ToolSuccess {
    ToolOutput::Image(ImageOutput {
        detail: None,
        mime_type: "image/gif".into(),
        reference: StorageRef::SessionFile {
            session_id: "images".into(),
            relative_path: id.into(),
        },
    })
    .into()
}
async fn upload(log: &EventLog, id: &str) {
    log.commit_artifact(
        Artifact {
            id: id.into(),
            session_id: "images".into(),
            turn_id: "upload".into(),
            created_at: 1,
            name: "image.gif".into(),
            kind: ArtifactKind::Image,
            size_bytes: GIF.len() as u64,
            mime_type: Some("image/gif".into()),
            source: ArtifactSource::UserUpload,
            summary: Some(content_digest(GIF)),
        },
        GIF,
    )
    .await
    .unwrap();
}
async fn rows(
    log: &EventLog,
    session: &str,
    invocation: &Invocation,
) -> (
    u64,
    BTreeMap<String, maka_agent_facts::history::RowPosition>,
) {
    let through = log
        .scoped_prefix(LogScope::Root, 1000, 8 * 1024 * 1024)
        .await
        .unwrap()
        .high_water;

    let mut rows = BTreeMap::new();
    let mut position = Position::Start;
    loop {
        let Page::Ready { chunks, after, .. } = log
            .history_text(
                session,
                through,
                position,
                false,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(8),
                    max_json_bytes: 65536,
                },
            )
            .await
            .unwrap();
        for chunk in chunks {
            if chunk.role == Role::ToolResult
                && let Some(Tool { tool_use_id, .. }) = chunk.tool
            {
                for step in ["generated", "borrowed", "missing", "later", "current"] {
                    let expected = maka_presentation::tool_message_id(
                        &invocation.invocation_id,
                        &format!("{step}:{step}"),
                    );
                    if tool_use_id == expected {
                        rows.insert(step.to_owned(), chunk.position);
                    }
                }
            }
        }
        if let Some(cursor) = after {
            position = Position::After { cursor };
        } else {
            break;
        }
    }
    (through, rows)
}
async fn export(log: &EventLog, session: &str) -> Vec<u8> {
    let inventory = log.preview_bundle(session).await.unwrap();
    log.export_bundle(session, &inventory.subtree_digest, Vec::new())
        .await
        .unwrap()
        .0
}
async fn import(log: &EventLog, bytes: &[u8]) -> bundle::ImportReceipt {
    let staged = StagedBundle::read(bytes).await.unwrap();
    let configurations: BTreeMap<String, Value> = staged
        .summary()
        .inventory
        .sessions
        .iter()
        .map(|s| (s.id.clone(), Value::Null))
        .collect();
    log.import_bundle(staged, &content_digest(b"image binding"), configurations)
        .await
        .unwrap()
}
async fn padding(log: &EventLog, session: &str, count: usize) {
    log.create_session(session, session, &Value::Null, 1)
        .await
        .unwrap();
    for n in 0..count {
        let i = invocation(session, &format!("{session}-{n}"));
        open(log, &i).await;
        end(log, &i).await;
    }
}
#[tokio::test]
async fn transferred_generated_borrowed_and_later_frozen_images_keep_exact_row_causality() {
    let dir = tempfile::tempdir().unwrap();
    let source = EventLog::open(&dir.path().join("source.sqlite"))
        .await
        .unwrap();
    padding(&source, "source-padding", 3).await;
    source
        .create_session("images", "images", &Value::Null, 1)
        .await
        .unwrap();
    let i = invocation("images", "images-run");
    open(&source, &i).await;
    // Storage/transfer fixture; native tests separately validate complete image decoding.
    let mut generated = vec![0x5a; 64 * 1024 * 1024 + 1];
    generated[..GIF.len()].copy_from_slice(GIF);
    let generated_digest = content_digest(&generated);
    let (generated_result, generated_at) = super::fixtures::output(
        &source,
        &i,
        "generated",
        ToolSuccess::image(generated.clone(), "image/gif".into()).unwrap(),
    )
    .await;
    let generated_id = generated_result.projection_artifacts()[0]
        .artifact()
        .id
        .clone();
    drop(generated_result);
    upload(&source, "borrowed").await;
    let (_, borrowed_at) =
        super::fixtures::output(&source, &i, "borrowed", borrowed("borrowed")).await;
    super::fixtures::output(&source, &i, "missing", borrowed("late")).await;
    upload(&source, "late").await;
    let (_, late_at) = super::fixtures::output(&source, &i, "later", borrowed("late")).await;
    end(&source, &i).await;
    let bytes = export(&source, "images").await;
    let summary = bundle::inspect(bytes.as_slice()).await.unwrap();
    let records = super::frames::records(&bytes, &summary.digest);
    for (id, at) in [
        (generated_id.as_str(), generated_at),
        ("borrowed", borrowed_at),
        ("late", late_at),
    ] {
        let record = records
            .iter()
            .find(|r| r["resource"] == "artifact" && r["metadata"]["id"] == id)
            .unwrap();
        assert_eq!(record["frozen_at"], at);
    }
    drop(records);
    let path = dir.path().join("destination.sqlite");
    let destination = EventLog::open(&path).await.unwrap();
    padding(&destination, "destination-padding", 11).await;
    let receipt = import(&destination, &bytes).await;
    let (through, rows) = rows(&destination, "images", &i).await;
    for step in ["generated", "borrowed", "later"] {
        let image = destination
            .tool_image("images", through, rows[step], 0, 32768)
            .await
            .unwrap();
        let expected = if step == "generated" {
            generated.as_slice()
        } else {
            GIF
        };
        assert_eq!(image.total_bytes, expected.len() as u64);
        assert_eq!(image.digest, content_digest(expected));
        assert_eq!(image.bytes, expected[..expected.len().min(32768)]);
    }
    let expected = generated.clone();
    let digest = generated_digest.clone();
    destination
        .with_artifact(
            ArtifactReadScope::Session("images"),
            &generated_id,
            move |record, reader| {
                let mut actual = Vec::new();
                reader.read_to_end(&mut actual).unwrap();
                assert_eq!(record.size_bytes, expected.len() as u64);
                assert_eq!(record.source, ArtifactSource::ToolResultProjection);
                assert_eq!(record.summary, None);
                assert_eq!(content_digest(&actual), digest);
                assert!(
                    actual == expected,
                    "import must preserve every generated image byte"
                );
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_ne!(rows["generated"].source_sequence, generated_at);
    assert!(
        destination
            .tool_image("images", through, rows["missing"], 0, 32768)
            .await
            .is_err()
    );
    assert_ne!(rows["borrowed"].source_sequence, borrowed_at);
    assert_eq!(import(&destination, &bytes).await, receipt);
    drop(bytes);
    destination.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .tool_image("images", through, rows["later"], 0, 32768)
            .await
            .unwrap()
            .bytes,
        GIF
    );
    assert!(
        reopened
            .tool_image("images", through, rows["missing"], 0, 32768)
            .await
            .is_err()
    );
    let revision = reopened
        .get_session::<Value>("images")
        .await
        .unwrap()
        .unwrap()
        .revision;
    reopened
        .copy_session(
            SessionCopy {
                source_session_id: "images".into(),
                target_session_id: "branch".into(),
                expected_source_revision: revision,
                purpose: CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::End,
                    side_conversation: false,
                },
            },
            &Value::Null,
            1,
        )
        .await
        .unwrap();
    let bytes = export(&reopened, "branch").await;
    let copied = EventLog::open(&dir.path().join("copied.sqlite"))
        .await
        .unwrap();
    padding(&copied, "copy-padding", 17).await;
    import(&copied, &bytes).await;
    assert!(
        copied
            .get_session::<Value>("images")
            .await
            .unwrap()
            .is_none()
    );
    let StorageRef::SessionFile {
        session_id,
        relative_path,
    } = copied
        .resolve_history_artifact("branch", "images", &generated_id)
        .await
        .unwrap()
        .unwrap()
    else {
        panic!("copied generated image must retain destination-owned storage")
    };
    assert_eq!(session_id, "branch");
    let (through, copied_rows) = self::rows(&copied, "branch", &i).await;
    let image = copied
        .tool_image("branch", through, copied_rows["generated"], 0, 32768)
        .await
        .unwrap();
    assert_eq!(image.total_bytes, generated.len() as u64);
    assert_eq!(image.digest, generated_digest);
    assert_eq!(image.bytes, generated[..32768]);
    assert!(
        copied
            .tool_image("branch", through, copied_rows["missing"], 0, 32768)
            .await
            .is_err()
    );
    copied
        .with_artifact(
            ArtifactReadScope::Session("branch"),
            &relative_path,
            move |record, reader| {
                let mut actual = Vec::new();
                reader.read_to_end(&mut actual).unwrap();
                assert_eq!(record.size_bytes, generated.len() as u64);
                assert_eq!(record.source, ArtifactSource::ToolResultProjection);
                assert_eq!(record.summary, None);
                assert_eq!(content_digest(&actual), generated_digest);
                assert!(
                    actual == generated,
                    "copied transfer must preserve every generated image byte"
                );
            },
        )
        .await
        .unwrap()
        .unwrap();
    copied.close().await.unwrap();
    reopened.close().await.unwrap();
    source.close().await.unwrap();
}
#[tokio::test]
async fn none_stays_unavailable_and_wrong_or_missing_consumption_witness_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let source = EventLog::open(&dir.path().join("source.sqlite"))
        .await
        .unwrap();
    source
        .create_session("images", "images", &Value::Null, 1)
        .await
        .unwrap();
    let i = invocation("images", "missing-run");
    open(&source, &i).await;
    super::fixtures::output(&source, &i, "missing", borrowed("late")).await;
    end(&source, &i).await;
    upload(&source, "late").await;
    let bytes = export(&source, "images").await;
    let destination = EventLog::open(&dir.path().join("destination.sqlite"))
        .await
        .unwrap();
    import(&destination, &bytes).await;
    let (through, rows) = rows(&destination, "images", &i).await;
    assert!(
        destination
            .tool_image("images", through, rows["missing"], 0, 32768)
            .await
            .is_err()
    );
    for at in [0, 1, 99999] {
        let changed = super::frames::rewrite_records(&bytes, |r| {
            if r["resource"] == "artifact" {
                r["frozen_at"] = json!(at);
            }
            true
        });
        let mut staged = StagedBundle::read(changed.as_slice()).await.unwrap();
        assert!(
            staged.validate_history().await.is_err(),
            "accepted unrelated witness {at}"
        );
        staged.close().await.unwrap();
    }
    destination.close().await.unwrap();
    source.close().await.unwrap();
}
#[tokio::test]
async fn copied_image_ownership_survives_transfer_without_importing_parent_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let source = EventLog::open(&dir.path().join("source.sqlite"))
        .await
        .unwrap();
    source
        .create_session("images", "images", &Value::Null, 1)
        .await
        .unwrap();
    let i = invocation("images", "copy-run");
    open(&source, &i).await;
    upload(&source, "borrowed").await;
    super::fixtures::output(&source, &i, "borrowed", borrowed("borrowed")).await;
    end(&source, &i).await;
    let revision = source
        .get_session::<Value>("images")
        .await
        .unwrap()
        .unwrap()
        .revision;
    source
        .copy_session(
            SessionCopy {
                source_session_id: "images".into(),
                target_session_id: "branch".into(),
                expected_source_revision: revision,
                purpose: CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::End,
                    side_conversation: false,
                },
            },
            &Value::Null,
            1,
        )
        .await
        .unwrap();
    let bytes = export(&source, "branch").await;
    let destination = EventLog::open(&dir.path().join("destination.sqlite"))
        .await
        .unwrap();
    padding(&destination, "destination-padding", 5).await;
    import(&destination, &bytes).await;
    assert!(
        destination
            .get_session::<Value>("images")
            .await
            .unwrap()
            .is_none()
    );
    let (through, rows) = rows(&destination, "branch", &i).await;
    assert_eq!(
        destination
            .tool_image("branch", through, rows["borrowed"], 0, 32768)
            .await
            .unwrap()
            .bytes,
        GIF
    );
    assert!(
        destination
            .tool_image("images", through, rows["borrowed"], 0, 32768)
            .await
            .is_err()
    );
    destination.close().await.unwrap();
    // Revision material belongs to the excluded editable input, even when
    // preparation replaced its attachment with a different upload.
    use maka_agent_facts::attachment::{AttachmentKind, AttachmentRef};
    use maka_agent_facts::input::{DeliveredMessage, MessageInput};
    use maka_agent_facts::message::{MessageDisposition, Placement, RootSourceMessage};
    upload(&source, "editable-only").await;
    upload(&source, "prepared-only").await;
    let attachment = |id: &str| AttachmentRef {
        kind: AttachmentKind::Image,
        name: "image.gif".into(),
        mime_type: "image/gif".into(),
        bytes: GIF.len() as u64,
        storage_ref: StorageRef::SessionFile {
            session_id: "images".into(),
            relative_path: id.into(),
        },
    };
    let mut unprepared = MessageInput::from("original editable image");
    unprepared.attachments = Some(vec![attachment("editable-only")]);
    let mut prepared = MessageInput::from("prepared image");
    prepared.attachments = Some(vec![attachment("prepared-only")]);
    let editable = invocation("images", "editable-run");
    let opening = RuntimeEvent::new(
        editable.clone(),
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: prepared.clone(),
                source_messages: vec![RootSourceMessage {
                    message: DeliveredMessage {
                        origin: None,
                        message_id: "editable-message".into(),
                        content: prepared,
                        submitted_content_digest: unprepared.content_digest().unwrap(),
                    },
                    unprepared_content: unprepared,
                    submitted_placement: Placement::CurrentTurn,
                    disposition: MessageDisposition::TurnStarted,
                    submitted_intent: None,
                }],
                request_fingerprint: None,
            },
        },
    );
    let source_sequence = source
        .append(&EventWrite::plain(opening.clone()).unwrap())
        .await
        .unwrap();
    end(&source, &editable).await;
    let revision = source
        .get_session::<Value>("images")
        .await
        .unwrap()
        .unwrap()
        .revision;
    source
        .copy_session(
            SessionCopy {
                source_session_id: "images".into(),
                target_session_id: "revision".into(),
                expected_source_revision: revision,
                purpose: CopyPurpose::Revision {
                    turn_id: editable.turn_id.clone(),
                },
            },
            &Value::Null,
            2,
        )
        .await
        .unwrap();
    let bytes = export(&source, "revision").await;
    let summary = bundle::inspect(bytes.as_slice()).await.unwrap();
    let records = super::frames::records(&bytes, &summary.digest);
    let revision_sources: Vec<_> = records
        .iter()
        .filter(|r| r["kind"] == "revision_source" && r["session"] == "revision")
        .collect();
    assert_eq!(revision_sources.len(), 1);
    assert_eq!(revision_sources[0]["sequence"], source_sequence);
    assert!(!records.iter().any(|r| r["kind"] == "member"
        && r["session"] == "revision"
        && r["sequence"] == source_sequence));
    let mut retained: Vec<_> = records
        .iter()
        .filter(|r| r["kind"] == "history_artifact" && r["session"] == "revision")
        .map(|r| r["source_artifact"].as_str().unwrap())
        .collect();
    retained.sort_unstable();
    assert_eq!(retained, ["borrowed", "editable-only"]);
    let artifacts: Vec<_> = records
        .iter()
        .filter(|r| r["kind"] == "blob" && r["resource"] == "artifact")
        .collect();
    assert_eq!(artifacts.len(), 2);
    assert!(
        artifacts
            .iter()
            .all(|r| r["metadata"]["sessionId"] == "revision")
    );
    let mut staged = StagedBundle::read(bytes.as_slice()).await.unwrap();
    staged.validate_history().await.unwrap();
    staged.close().await.unwrap();

    let mut removed = 0;
    let missing_mapping = super::frames::rewrite_records(&bytes, |record| {
        if record["kind"] == "history_artifact"
            && record["session"] == "revision"
            && record["source_artifact"] == "editable-only"
        {
            removed += 1;
            return false;
        }
        true
    });
    assert_eq!(removed, 1);
    let mut staged = StagedBundle::read(missing_mapping.as_slice())
        .await
        .unwrap();
    assert!(matches!(
        staged.validate_history().await,
        Err(bundle::BundleError::Store(maka_event_log::StoreError::InvalidTransition(reason)))
            if reason == "bundle copied reference lacks its retained Artifact"
    ));
    staged.close().await.unwrap();

    let path = dir.path().join("revision-destination.sqlite");
    let mut destination = EventLog::open(&path).await.unwrap();
    padding(&destination, "revision-padding", 9).await;
    import(&destination, &bytes).await;
    for reopened in [false, true] {
        let prefix = destination.prefix(1000, 8 * 1024 * 1024).await.unwrap();
        let relocated = prefix
            .events
            .iter()
            .find(|e| e.event.id == opening.id)
            .unwrap();
        assert_ne!(relocated.sequence, source_sequence);
        assert_eq!(relocated.event, opening);
        let input = destination
            .editable_message("revision", "editable-run", "editable-message")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(input.content.text, "original editable image");
        let attachments = input.content.attachments.as_ref().unwrap();
        assert_eq!(attachments.len(), 1);
        let StorageRef::SessionFile {
            session_id,
            relative_path,
        } = &attachments[0].storage_ref
        else {
            panic!("editable input lost its retained upload");
        };
        assert_eq!(session_id, "revision");
        assert_eq!(
            destination
                .read_artifact_chunk("revision", relative_path, 0, 32768)
                .await
                .unwrap()
                .unwrap()
                .bytes,
            GIF
        );
        assert!(
            destination
                .root_message("revision", "editable-message")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            destination
                .get_session::<Value>("images")
                .await
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            destination
                .read_artifact_chunk("images", "editable-only", 0, 32768)
                .await,
            Err(maka_event_log::StoreError::SessionNotFound)
        ));
        let (through, rows) = self::rows(&destination, "revision", &i).await;
        assert_eq!(
            destination
                .tool_image("revision", through, rows["borrowed"], 0, 32768)
                .await
                .unwrap()
                .bytes,
            GIF
        );
        let turns = destination
            .navigation_turns("revision", through, None, 32)
            .await
            .unwrap();
        assert_eq!(turns.contributions.len(), 1);
        assert_eq!(turns.contributions[0].turn_id, "copy-run");
        if !reopened {
            destination.close().await.unwrap();
            destination = EventLog::open(&path).await.unwrap();
        }
    }
    destination.close().await.unwrap();
    source.close().await.unwrap();
}

#[tokio::test]
async fn a_copied_frozen_upload_exports_its_current_consumption_without_source_history() {
    use maka_agent_facts::attachment::AttachmentKind;
    use maka_agent_facts::attachment::AttachmentRef;
    use maka_capabilities::storage::Namespace;
    use maka_plugin_core::scope::Scope;
    let dir = tempfile::tempdir().unwrap();
    let source = EventLog::open(&dir.path().join("source.sqlite"))
        .await
        .unwrap();
    source
        .create_session("images", "images", &Value::Null, 1)
        .await
        .unwrap();
    let i = invocation("images", "outside-run");
    open(&source, &i).await;
    upload(&source, "borrowed").await;
    let (_, original_at) =
        super::fixtures::output(&source, &i, "outside", borrowed("borrowed")).await;
    end(&source, &i).await;
    source
        .create_session("detached", "detached", &Value::Null, 1)
        .await
        .unwrap();
    let copied = source
        .copy_plugin_attachment(
            &Namespace::new("image.fixture", Scope::Profile).unwrap(),
            maka_agent_ports::execution::CopyAttachment {
                target_session_id: "detached".into(),
                attachment: AttachmentRef {
                    kind: AttachmentKind::Image,
                    name: "image.gif".into(),
                    mime_type: "image/gif".into(),
                    bytes: GIF.len() as u64,
                    storage_ref: StorageRef::SessionFile {
                        session_id: "images".into(),
                        relative_path: "borrowed".into(),
                    },
                },
            },
        )
        .await
        .unwrap();
    let i = invocation("detached", "detached-run");
    open(&source, &i).await;
    let (_, current_at) = super::fixtures::output(
        &source,
        &i,
        "current",
        ToolOutput::Image(ImageOutput {
            detail: None,
            mime_type: copied.mime_type.clone(),
            reference: copied.storage_ref,
        })
        .into(),
    )
    .await;
    end(&source, &i).await;
    let bytes = export(&source, "detached").await;
    let summary = bundle::inspect(bytes.as_slice()).await.unwrap();
    let records = super::frames::records(&bytes, &summary.digest);
    let artifact = records
        .iter()
        .find(|r| r["resource"] == "artifact")
        .unwrap();
    assert_ne!(current_at, original_at);
    assert_eq!(artifact["frozen_at"], current_at);
    assert!(
        !records
            .iter()
            .any(|r| r["kind"] == "event" && r["sequence"] == original_at)
    );
    let destination = EventLog::open(&dir.path().join("destination.sqlite"))
        .await
        .unwrap();
    padding(&destination, "destination-padding", 9).await;
    import(&destination, &bytes).await;
    let (through, rows) = rows(&destination, "detached", &i).await;
    assert_eq!(
        destination
            .tool_image("detached", through, rows["current"], 0, 32768)
            .await
            .unwrap()
            .bytes,
        GIF
    );
    assert!(
        destination
            .get_session::<Value>("images")
            .await
            .unwrap()
            .is_none()
    );
    destination.close().await.unwrap();
    source.close().await.unwrap();
}
