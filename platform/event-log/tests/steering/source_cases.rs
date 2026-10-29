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
use maka_agent_facts::attachment::AttachmentKind;
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;
use maka_agent_facts::composition::SourceKind;
use maka_agent_facts::composition::SourceRevision;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::InputReceipt;
use maka_agent_facts::input::MessageInput;
use maka_agent_facts::input::QuoteRef;
use maka_agent_facts::input::SelectionSource;
use maka_agent_facts::message::MessageDisposition;
use maka_agent_facts::message::Placement;
use maka_agent_facts::message::RootSourceMessage;
use maka_agent_facts::message::SubmittedTurnIntent;
use maka_agent_facts::session::CopyPurpose;
use maka_event_log::{
    EventLog,
    message_admissions::PendingMessageAdmission,
    message_queue::{QueueCommandKind, QueueEdit},
    sessions::{SessionCopy, SessionCopyResult},
};
use serde_json::{Value, json};

#[path = "../support/message_queue.rs"]
mod queue;

fn resource(
    invocation: &Invocation,
    id: &str,
    disposition: MessageDisposition,
) -> PendingMessageAdmission {
    let mut pending = queue::admission(invocation, id, disposition);
    pending.source.unprepared_content.quotes = Some(vec![QuoteRef {
        text: format!("captured immutable {id}"),
        label: Some(id.into()),
        source_turn_id: None,
        source: None,
    }]);
    pending.source.submitted_intent = Some(SubmittedTurnIntent {
        input_selections: [("example.resources".into(), vec![format!("{id}:revision-1")])].into(),
        input_selection_sources: vec![SelectionSource {
            provider: "example.resources".into(),
            package_id: "example".into(),
            entry_id: "entry".into(),
            activation: "original-activation".into(),
            registration: uuid::Uuid::parse_str("12345678-1234-4234-8234-123456789abc").unwrap(),
            session_id: invocation.session_id.clone(),
        }],
        turn_orchestration: None,
    });
    pending.source.message.content = prepared(&pending.source.unprepared_content);
    pending
}

fn prepared(original: &MessageInput) -> MessageInput {
    let mut content: MessageInput = format!("prepared {}", original.text).into();
    content.quotes = original.quotes.clone();
    content.preparation.push(InputReceipt {
        source: SourceRevision {
            kind: SourceKind::Input,
            name: "example.resources".into(),
            package_id: "example".into(),
            entry_id: "entry".into(),
            activation: "original-activation".into(),
            revision: "original-revision".into(),
        },
        receipt: json!({"prepared":original.text}),
    });
    content
}

fn delivery(invocation: &Invocation, source: RootSourceMessage) -> RuntimeEvent {
    RuntimeEvent::new(
        invocation.clone(),
        Fact::MessageSteered {
            message: Box::new(source.message.clone()),
            source: Box::new(source),
        },
    )
}

#[tokio::test]
async fn steering_source_validates_identity_provenance_and_preserves_large_receipts() {
    let owner = queue::invocation("turn");
    let pending = resource(&owner, "message", MessageDisposition::Steering);
    EventWrite::plain(delivery(&owner, pending.source.clone())).unwrap();
    let mut foreign = pending.source.clone();
    foreign
        .submitted_intent
        .as_mut()
        .unwrap()
        .input_selection_sources[0]
        .session_id = "child".into();
    assert!(EventWrite::plain(delivery(&owner, foreign)).is_err());
    let mut mismatch = delivery(&owner, pending.source.clone());
    if let Fact::MessageSteered { message, .. } = &mut mismatch.fact {
        message.content.text = "different delivered content".into();
    }
    assert!(EventWrite::plain(mismatch).is_err());

    let mut wire = serde_json::to_value(delivery(&owner, pending.source.clone())).unwrap();
    wire["fact"].as_object_mut().unwrap().remove("source");
    assert!(serde_json::from_value::<RuntimeEvent>(wire).is_err());

    let mut large = pending.source.clone();
    large.message.content.preparation[0].receipt = json!("x".repeat(540_000));
    large.validate().unwrap();
    large.message.validate().unwrap();
    assert!(serde_json::to_vec(&large).unwrap().len() < 1024 * 1024);
    let event = delivery(&owner, large.clone());
    assert!(serde_json::to_vec(&event).unwrap().len() > 1024 * 1024);
    let receipt_bytes = serde_json::to_vec(&large.message.content.preparation).unwrap();
    let write = EventWrite::plain(event.clone()).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("large-source.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    queue::append(&log, &owner, queue::opening()).await;
    log.admit_message(PendingMessageAdmission {
        source: large.clone(),
        ..pending
    })
    .await
    .unwrap();
    let sequence = log.append(&write).await.unwrap();
    assert_eq!(log.append(&write).await.unwrap(), sequence);
    let proof = log
        .steering_message("session", "message")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(proof.sequence, sequence);
    assert_eq!(proof.event, event);
    let Fact::MessageSteered { message, source } = &proof.event.fact else {
        unreachable!()
    };
    assert_eq!(source.as_ref(), &large);
    assert!(serde_json::to_vec(&message.content.preparation).unwrap() == receipt_bytes);
    assert!(log.pending_messages("session").await.unwrap().is_empty());
    queue::append(
        &log,
        &owner,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    )
    .await;
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(log.append(&write).await.unwrap(), sequence);
    let reopened = log
        .steering_message("session", "message")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reopened.sequence, proof.sequence);
    assert_eq!(reopened.event, proof.event);
    log.close().await.unwrap();
}

#[tokio::test]
async fn edited_and_promoted_resource_sources_are_atomic_and_survive_restart_and_copies() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("source.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let owner = queue::invocation("turn");
    queue::append(&log, &owner, queue::opening()).await;
    log.commit_artifact(
        Artifact {
            id: "upload".into(),
            session_id: "session".into(),
            turn_id: "upload".into(),
            created_at: 1,
            name: "original.txt".into(),
            kind: ArtifactKind::File,
            size_bytes: 5,
            mime_type: Some("text/plain".into()),
            source: ArtifactSource::UserUpload,
            summary: Some(content_digest(b"hello")),
        },
        b"hello",
    )
    .await
    .unwrap();

    let mut first = resource(&owner, "first", MessageDisposition::Followup);
    first.source.unprepared_content.attachments = Some(vec![AttachmentRef {
        kind: AttachmentKind::Other,
        name: "original.txt".into(),
        mime_type: "text/plain".into(),
        bytes: 5,
        storage_ref: StorageRef::SessionFile {
            session_id: "session".into(),
            relative_path: "upload".into(),
        },
    }]);
    let second = resource(&owner, "second", MessageDisposition::Steering);
    for pending in [first.clone(), second.clone()] {
        log.admit_message(pending).await.unwrap();
    }
    let mut edited = first.source.unprepared_content.clone();
    edited.text = "edited first text".into();
    let current = log.message_queue("session").await.unwrap();
    let changed = log
        .edit_message_queue(
            "session",
            current.revision,
            QueueEdit::Update {
                message_id: "first".into(),
                content: Box::new(prepared(&edited)),
                unprepared_content: Box::new(edited.clone()),
                required_tools: Default::default(),
            },
            queue::command("edit", QueueCommandKind::Update),
        )
        .await
        .unwrap();
    log.edit_message_queue(
        "session",
        changed.revision,
        QueueEdit::Promote {
            message_id: "first".into(),
            invocation: owner.clone(),
        },
        queue::command("promote", QueueCommandKind::Promote),
    )
    .await
    .unwrap();
    let pending = log.message_queue("session").await.unwrap();
    let expected = pending
        .entries
        .iter()
        .find(|p| p.source.message.message_id == "first")
        .unwrap()
        .source
        .clone();
    assert_eq!(expected.disposition, MessageDisposition::Steering);
    assert_eq!(expected.submitted_placement, Placement::NextTurn);
    assert_eq!(expected.submitted_intent, first.source.submitted_intent);

    let mut stale = expected.clone();
    stale.unprepared_content = first.source.unprepared_content.clone();
    assert!(
        log.append(&EventWrite::plain(delivery(&owner, stale)).unwrap())
            .await
            .is_err(),
        "old unprepared input cannot replace the accepted edit"
    );
    assert_eq!(log.message_queue("session").await.unwrap(), pending);

    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch("CREATE TRIGGER refuse_source_consumption BEFORE DELETE ON message_admissions BEGIN SELECT RAISE(ABORT, 'source rollback'); END;").unwrap();
    assert!(log.commit_pending_steering(&owner).await.is_err());
    assert_eq!(log.message_queue("session").await.unwrap(), pending);
    assert!(
        log.root_message("session", "first")
            .await
            .unwrap()
            .is_none()
    );
    sql.execute_batch("DROP TRIGGER refuse_source_consumption")
        .unwrap();
    assert_eq!(log.commit_pending_steering(&owner).await.unwrap(), 2);
    assert_eq!(log.commit_pending_steering(&owner).await.unwrap(), 0);
    assert!(log.pending_messages("session").await.unwrap().is_empty());
    for source in [&expected, &second.source] {
        assert_eq!(
            log.root_message("session", &source.message.message_id)
                .await
                .unwrap()
                .unwrap()
                .source(),
            source
        );
    }
    queue::append(
        &log,
        &owner,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    )
    .await;
    let revision = log
        .get_session::<Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    for (target, purpose) in [
        (
            "branch",
            CopyPurpose::Branch {
                position: maka_agent_facts::session::ForkPosition::ThroughTurn {
                    turn_id: "turn".into(),
                },
                side_conversation: false,
            },
        ),
        (
            "revision",
            CopyPurpose::Revision {
                turn_id: "turn".into(),
            },
        ),
    ] {
        assert!(matches!(
            log.copy_session(
                SessionCopy {
                    source_session_id: "session".into(),
                    target_session_id: target.into(),
                    expected_source_revision: revision,
                    purpose,
                },
                &json!({}),
                2
            )
            .await
            .unwrap(),
            SessionCopyResult::Committed(_)
        ));
    }
    let inventory = log.preview_bundle("revision").await.unwrap();
    let (bytes, _) = log
        .export_bundle("revision", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    let mut staged = maka_event_log::bundle::StagedBundle::read(bytes.as_slice())
        .await
        .unwrap();
    staged.validate_history().await.unwrap();
    staged.close().await.unwrap();
    log.delete_user_artifact("session", "upload").await.unwrap();
    log.close().await.unwrap();
    sql.execute_batch("DELETE FROM message_sources;").unwrap();
    drop(sql);
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.root_message("session", "first")
            .await
            .unwrap()
            .unwrap()
            .source(),
        &expected
    );
    for target in ["branch", "revision"] {
        let first = log
            .editable_message(target, "turn", "first")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.content.text, edited.text);
        assert_eq!(first.content.quotes, edited.quotes);
        assert!(first.content.preparation.is_empty());
        assert_eq!(
            first.intent, expected.submitted_intent,
            "viewing a child Session cannot rebind the original source identity"
        );
        assert!(
            matches!(&first.content.attachments.as_ref().unwrap()[0].storage_ref,
            StorageRef::SessionFile { session_id, .. } if session_id == target)
        );
        let second_input = log
            .editable_message(target, "turn", "second")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second_input.content, second.source.unprepared_content);
        assert_eq!(second_input.intent, second.source.submitted_intent);
        assert!(log.root_message(target, "first").await.unwrap().is_none());
    }
    log.close().await.unwrap();
}
