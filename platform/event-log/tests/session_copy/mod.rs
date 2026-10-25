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
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_event_log::{
    EventLog, StoreError,
    artifacts::ArtifactDeletion,
    sessions::{SessionCopy, SessionCopyResult},
};
use serde_json::{Value, json};

fn attachment() -> AttachmentRef {
    AttachmentRef {
        kind: AttachmentKind::Other,
        name: "input.txt".into(),
        mime_type: "text/plain".into(),
        bytes: 5,
        storage_ref: StorageRef::SessionFile {
            session_id: "source".into(),
            relative_path: "upload".into(),
        },
    }
}

async fn turn(log: &EventLog, session: &str, turn: &str, file: bool) {
    let mut content: maka_agent_facts::input::MessageInput = turn.to_owned().into();
    if file {
        content.attachments = Some(vec![attachment()]);
    }
    let mut unprepared = content.clone();
    unprepared.text = format!("{turn} before preparation");
    let source = maka_agent_facts::message::RootSourceMessage {
        message: maka_agent_facts::input::DeliveredMessage {
            origin: None,
            message_id: format!("message-{turn}"),
            content: content.clone(),
            submitted_content_digest: unprepared.content_digest().unwrap(),
        },
        unprepared_content: unprepared,
        submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
        disposition: maka_agent_facts::message::MessageDisposition::TurnStarted,
        submitted_intent: None,
    };
    let invocation = Invocation {
        session_id: session.into(),
        turn_id: turn.into(),
        run_id: format!("run-{turn}"),
        invocation_id: format!("inv-{turn}"),
    };
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content,
                source_messages: vec![source],
                request_fingerprint: None,
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
}

async fn copy(
    log: &EventLog,
    request: SessionCopy,
) -> maka_event_log::sessions::SessionRecord<Value> {
    let SessionCopyResult::Committed(session) = log
        .copy_session(request, &json!({"name":"copy"}), 20)
        .await
        .unwrap()
    else {
        panic!("unchanged revision")
    };
    *session
}

#[tokio::test]
async fn removal_does_not_treat_revision_history_as_management_authority() {
    use maka_capabilities::storage::Namespace;
    use maka_event_log::sessions::{PluginSession, RemovalAuthority, RemoveFamilyResult};
    use maka_plugin_core::scope::Scope;
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("authority.sqlite"))
        .await
        .unwrap();
    let namespace = Namespace::new("owner", Scope::Profile).unwrap();
    log.create_session("parent", "parent", &json!({}), 1)
        .await
        .unwrap();
    log.create_plugin_session(
        &PluginSession {
            session_id: "managed".into(),
            creator: namespace.clone(),
            fingerprint: "managed".into(),
            managed: true,
            authority_session_id: None,
        },
        &json!({}),
        1,
    )
    .await
    .unwrap();
    turn(&log, "managed", "source-turn", false).await;
    let source = log.get_session::<Value>("managed").await.unwrap().unwrap();
    log.copy_plugin_session(
        SessionCopy {
            source_session_id: source.id,
            target_session_id: "unmanaged-revision".into(),
            expected_source_revision: source.revision,
            purpose: maka_agent_facts::session::CopyPurpose::Revision {
                turn_id: "source-turn".into(),
            },
        },
        &json!({}),
        2,
        PluginSession {
            session_id: "unmanaged-revision".into(),
            creator: namespace.clone(),
            fingerprint: "revision".into(),
            managed: false,
            authority_session_id: Some("parent".into()),
        },
    )
    .await
    .unwrap();
    log.retain_session("unmanaged-revision").await.unwrap();
    let revision = log
        .get_session::<Value>("unmanaged-revision")
        .await
        .unwrap()
        .unwrap()
        .revision;
    for authority in [
        RemovalAuthority::Unmanaged,
        RemovalAuthority::Granted {
            namespace,
            sessions: ["unmanaged-revision".into()].into_iter().collect(),
        },
    ] {
        assert!(matches!(
            log.remove_session_family("unmanaged-revision", revision, authority)
                .await,
            Err(StoreError::SessionConflict)
        ));
        assert!(log.session_retirement("managed").await.unwrap().is_none());
        assert!(
            log.session_removal_receipt("unmanaged-revision")
                .await
                .unwrap()
                .is_none()
        );
    }
    let revision = log
        .get_session::<Value>("parent")
        .await
        .unwrap()
        .unwrap()
        .revision;
    let RemoveFamilyResult::Accepted(plan) = log
        .remove_session_family("parent", revision, RemovalAuthority::Unmanaged)
        .await
        .unwrap()
    else {
        panic!("unchanged revision");
    };
    assert_eq!(plan.archive, ["unmanaged-revision"]);
    assert!(
        !log.get_session::<Value>("managed")
            .await
            .unwrap()
            .unwrap()
            .archived
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn family_removal_freezes_one_atomic_plan_and_does_not_rearchive_restored_dependents() {
    use maka_agent_facts::session::CopyPurpose;
    use maka_capabilities::storage::Namespace;
    use maka_event_log::sessions::{PluginSession, RemoveFamilyResult, SessionRetirement};
    use maka_plugin_core::scope::Scope;
    use sqlx::Connection;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("family.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("root", "root", &json!({}), 1)
        .await
        .unwrap();
    turn(&log, "root", "root-turn", false).await;
    for target in ["revision", "draft", "branch"] {
        let source = log.get_session::<Value>("root").await.unwrap().unwrap();
        copy(
            &log,
            SessionCopy {
                source_session_id: source.id,
                target_session_id: target.into(),
                expected_source_revision: source.revision,
                purpose: if target == "branch" {
                    CopyPurpose::EmptySideConversation
                } else {
                    CopyPurpose::Revision {
                        turn_id: "root-turn".into(),
                    }
                },
            },
        )
        .await;
        if target == "revision" {
            log.retain_session(target).await.unwrap();
        }
    }
    let child = |id: &str, parent: &str| PluginSession {
        session_id: id.into(),
        creator: Namespace::new("any-package", Scope::Profile).unwrap(),
        fingerprint: id.into(),
        managed: false,
        authority_session_id: Some(parent.into()),
    };
    log.create_plugin_session(&child("child", "revision"), &json!({}), 2)
        .await
        .unwrap();
    turn(&log, "child", "child-turn", false).await;
    let source = log.get_session::<Value>("child").await.unwrap().unwrap();
    copy(
        &log,
        SessionCopy {
            source_session_id: source.id,
            target_session_id: "child-revision".into(),
            expected_source_revision: source.revision,
            purpose: CopyPurpose::Revision {
                turn_id: "child-turn".into(),
            },
        },
    )
    .await;
    log.create_plugin_session(&child("grandchild", "child-revision"), &json!({}), 3)
        .await
        .unwrap();
    log.create_plugin_session(&child("already-archived", "root"), &json!({}), 4)
        .await
        .unwrap();
    log.set_session_archived::<Value>("already-archived", true, 5)
        .await
        .unwrap();
    let preview = log.preview_session_removal("revision").await.unwrap();
    assert_eq!(preview.remove, ["revision", "root"]);
    assert_eq!(
        preview.archive,
        ["already-archived", "child", "child-revision", "grandchild"]
    );
    assert_eq!(preview.archived_subtask_count, 2);
    // Preview does not reserve an old dependency set. Admission recomputes it.
    log.create_plugin_session(&child("late", "root"), &json!({}), 6)
        .await
        .unwrap();
    let revision = log
        .get_session::<Value>("revision")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        log.remove_session_family(
            "revision",
            revision + 1,
            maka_event_log::sessions::RemovalAuthority::Unmanaged
        )
        .await
        .unwrap(),
        RemoveFamilyResult::RevisionConflict { .. }
    ));
    let mut faults = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER refuse_archive BEFORE INSERT ON session_retirements
        WHEN NEW.session_id='child' BEGIN SELECT RAISE(ABORT,'archive failure'); END",
    )
    .execute(&mut faults)
    .await
    .unwrap();
    assert!(
        log.remove_session_family(
            "revision",
            revision,
            maka_event_log::sessions::RemovalAuthority::Unmanaged
        )
        .await
        .is_err()
    );
    assert!(log.session_retirement("root").await.unwrap().is_none());
    assert!(
        !log.get_session::<Value>("child")
            .await
            .unwrap()
            .unwrap()
            .archived
    );
    sqlx::query("DROP TRIGGER refuse_archive")
        .execute(&mut faults)
        .await
        .unwrap();
    faults.close().await.unwrap();
    let RemoveFamilyResult::Accepted(plan) = log
        .remove_session_family(
            "revision",
            revision,
            maka_event_log::sessions::RemovalAuthority::Unmanaged,
        )
        .await
        .unwrap()
    else {
        panic!("unchanged revision");
    };
    for session in &plan.remove {
        assert!(!log.session_is_available(session).await.unwrap());
    }
    for session in &plan.archive {
        assert!(log.session_is_available(session).await.unwrap());
        assert_eq!(
            log.session_retirement(session).await.unwrap(),
            Some(SessionRetirement::Archiving)
        );
    }
    for session in ["draft", "branch"] {
        assert!(log.session_is_available(session).await.unwrap());
    }
    assert_eq!(plan.archived_subtask_count, 3);
    assert!(plan.archive.contains(&"late".into()));
    assert!(log.get_session::<Value>("root").await.unwrap().is_none());
    assert!(log.get_session::<Value>("draft").await.unwrap().is_some());
    assert!(log.get_session::<Value>("branch").await.unwrap().is_some());
    assert!(
        log.get_session::<Value>("child")
            .await
            .unwrap()
            .unwrap()
            .archived
    );
    assert!(log.retain_session("child").await.is_err());
    assert!(matches!(
        log.set_session_archived::<Value>("child", false, 7).await,
        Err(StoreError::SessionBusy)
    ));
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    for session in &plan.remove {
        assert_eq!(
            log.finish_session_retirement(session).await.unwrap(),
            SessionRetirement::Removed
        );
    }
    for session in &plan.archive {
        assert_eq!(
            log.finish_session_retirement(session).await.unwrap(),
            SessionRetirement::Archived
        );
    }
    for session in &plan.remove {
        assert!(!log.session_is_available(session).await.unwrap());
    }
    for session in &plan.archive {
        assert!(log.session_is_available(session).await.unwrap());
    }
    let receipt = log
        .session_copy_receipt("child-revision")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(copy(&log, receipt.request).await.id, "child-revision");
    let archived = log.get_session::<Value>("child").await.unwrap().unwrap();
    let branch = copy(
        &log,
        SessionCopy {
            source_session_id: archived.id,
            target_session_id: "from-archived".into(),
            expected_source_revision: archived.revision,
            purpose: CopyPurpose::EmptySideConversation,
        },
    )
    .await;
    assert_eq!(branch.id, "from-archived");
    assert!(
        log.retain_session("child").await.is_err(),
        "copying history grants no execution"
    );
    log.set_session_archived::<Value>("child", false, 8)
        .await
        .unwrap();
    turn(&log, "child", "restored-turn", false).await;
    assert_eq!(
        log.remove_session_family(
            "revision",
            revision,
            maka_event_log::sessions::RemovalAuthority::Unmanaged
        )
        .await
        .unwrap(),
        RemoveFamilyResult::Accepted(plan)
    );
    assert!(
        !log.get_session::<Value>("child")
            .await
            .unwrap()
            .unwrap()
            .archived
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn copies_own_history_and_files_without_replaying_execution_across_retries_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("history.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    log.commit_artifact(
        Artifact {
            id: "upload".into(),
            session_id: "source".into(),
            turn_id: "upload".into(),
            created_at: 2,
            name: "input.txt".into(),
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
    turn(&log, "source", "first", true).await;
    let revision = log
        .get_session::<Value>("source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    let request = SessionCopy {
        source_session_id: "source".into(),
        target_session_id: "branch".into(),
        expected_source_revision: revision,
        purpose: maka_agent_facts::session::CopyPurpose::Branch {
            turn_id: Some("first".into()),
            side_conversation: false,
        },
    };
    let first = copy(&log, request.clone()).await;
    assert!(
        first.execution.is_none(),
        "inherited facts are not target execution"
    );
    let root = log.prefix(100, 65536).await.unwrap();
    let inherited = log
        .scoped_prefix(
            LogScope::Session {
                id: "branch".into(),
            },
            100,
            65536,
        )
        .await
        .unwrap();
    assert_eq!(
        inherited
            .events
            .iter()
            .map(|e| (e.sequence, &e.event))
            .collect::<Vec<_>>(),
        root.events
            .iter()
            .map(|e| (e.sequence, &e.event))
            .collect::<Vec<_>>()
    );
    let context = log
        .capture_model_context("branch", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(context.source_evidence.digest, inherited.digest);
    assert_eq!(context.tail.len(), 2);
    assert_eq!(
        log.read_frozen_model_context(&context.source_evidence, 100, 65536)
            .await
            .unwrap()
            .tail
            .len(),
        2
    );
    assert_eq!(
        log.delete_user_artifact("source", "upload").await.unwrap(),
        ArtifactDeletion::Deleted
    );
    let files = log.list_artifacts("branch", 0, 32).await.unwrap().records;
    assert_eq!(files.len(), 1);
    assert_eq!(
        log.delete_user_artifact("branch", &files[0].id)
            .await
            .unwrap(),
        ArtifactDeletion::Protected
    );
    // The original reference still occurs in canonical bytes. A descendant uses
    // the parent's ownership map, not the now-missing source upload.
    let nested = copy(
        &log,
        SessionCopy {
            source_session_id: "branch".into(),
            target_session_id: "nested".into(),
            expected_source_revision: first.revision,
            purpose: maka_agent_facts::session::CopyPurpose::Branch {
                turn_id: Some("first".into()),
                side_conversation: false,
            },
        },
    )
    .await;
    assert!(nested.execution.is_none());
    assert_eq!(
        log.list_artifacts("nested", 0, 32)
            .await
            .unwrap()
            .records
            .len(),
        1
    );
    turn(&log, "source", "later", false).await;
    assert_eq!(copy(&log, request.clone()).await, first);
    assert!(matches!(
        log.copy_session(
            SessionCopy {
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    turn_id: Some("first".into()),
                    side_conversation: true
                },
                ..request.clone()
            },
            &json!({}),
            30
        )
        .await,
        Err(StoreError::SessionConflict)
    ));
    // Real removal releases source resources without removing another Session's
    // retained evidence. Receipt recovery cannot depend on source catalog state.
    let revision = log
        .get_session::<Value>("source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.begin_session_removal("source", revision).await.unwrap();
    assert_eq!(
        log.finish_session_retirement("source").await.unwrap(),
        maka_event_log::sessions::SessionRetirement::Removed
    );
    assert_eq!(
        log.collect_session_material(None).await.unwrap(),
        maka_event_log::sessions::MaterialCollection::Retained("source".into()),
        "live descendants retain source proof"
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.session_copy_receipt("branch").await.unwrap(),
        Some(maka_agent_facts::session::CopyReceipt {
            request: request.clone(),
            state: maka_agent_facts::session::CopyState::Committed,
        }),
        "the exact request is recoverable without the source catalog"
    );
    assert_eq!(copy(&log, request).await, first);
    for session in ["branch", "nested"] {
        assert_eq!(
            log.first_message_opening(session)
                .await
                .unwrap()
                .unwrap()
                .event
                .invocation
                .turn_id,
            "first"
        );
        assert_eq!(
            log.latest_message_opening(session)
                .await
                .unwrap()
                .unwrap()
                .event
                .invocation
                .turn_id,
            "first"
        );
        let prefix = log
            .scoped_prefix(LogScope::Session { id: session.into() }, 100, 65536)
            .await
            .unwrap();
        assert_eq!(
            prefix
                .events
                .iter()
                .map(|e| (e.sequence, &e.event))
                .collect::<Vec<_>>(),
            root.events
                .iter()
                .map(|e| (e.sequence, &e.event))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            log.capture_model_context(session, None, 100_000, 64 * 1024 * 1024)
                .await
                .unwrap()
                .tail
                .len(),
            2
        );
        let files = log.list_artifacts(session, 0, 32).await.unwrap().records;
        let editable = log
            .editable_message(session, "first", "message-first")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(editable.content.text, "first before preparation");
        assert_eq!(
            editable.content.attachments.as_ref().unwrap()[0].storage_ref,
            StorageRef::SessionFile {
                session_id: session.into(),
                relative_path: files[0].id.clone()
            }
        );
        assert!(
            log.root_message(session, "message-first")
                .await
                .unwrap()
                .is_none(),
            "historical source access is not proof of target execution admission"
        );
        assert!(
            log.editable_message(session, "later", "message-later")
                .await
                .unwrap()
                .is_none(),
            "a source beyond the inherited cut is not editable in the copy"
        );
        assert!(
            log.editable_message(session, "first", "message-later")
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            log.read_artifact_chunk(session, &files[0].id, 0, 64)
                .await
                .unwrap()
                .unwrap()
                .bytes,
            b"hello"
        );
        let fence = log.navigation_fence(session).await.unwrap().unwrap();
        assert_eq!(fence, root.high_water);
        crate::transcript_cache::materialize_all_rows(&log, session, root.high_water)
            .await
            .unwrap();
        let turns = log
            .navigation_turns(session, fence, None, 32)
            .await
            .unwrap();
        assert_eq!(turns.contributions.len(), 1);
        assert_eq!(turns.contributions[0].turn_id, "first");
        assert_eq!(
            log.navigation_landmarks(session, fence, 8, None)
                .await
                .unwrap()
                .len(),
            1
        );
        let history = log
            .history_view(
                session,
                root.high_water,
                maka_event_log::transcript::HistoryWindow {
                    position: maka_agent_ports::session::history::Position::Start,
                    include_thinking: false,
                    view: maka_agent_ports::session::history::HistoryView::Text,
                    max_bytes: 16 * 1024,
                    max_chunks: Some(8),
                    max_json_bytes: 1024 * 1024,
                },
            )
            .await
            .unwrap();
        let maka_agent_ports::session::history::Page::Ready { chunks, after, .. } = &history;
        assert!(after.is_none());
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "first\n↳ input.txt · 5 B");
        assert_eq!(
            chunks[0].attachments[0].storage_ref,
            StorageRef::SessionFile {
                session_id: session.into(),
                relative_path: files[0].id.clone(),
            }
        );
        let cache_session = session.to_owned();
        crate::test_store::inspect(&log, move |inspect| {
            for table in ["transcript_cache.text", "transcript_cache.rows"] {
                inspect
                    .execute(
                        &format!("DELETE FROM {table} WHERE session_id = ?"),
                        [&cache_session],
                    )
                    .unwrap();
            }
        })
        .await;
        crate::transcript_cache::materialize_all_rows(&log, session, root.high_water)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(
                log.history_view(
                    session,
                    root.high_water,
                    maka_event_log::transcript::HistoryWindow {
                        position: maka_agent_ports::session::history::Position::Start,
                        include_thinking: false,
                        view: maka_agent_ports::session::history::HistoryView::Text,
                        max_bytes: 16 * 1024,
                        max_chunks: Some(8),
                        max_json_bytes: 1024 * 1024
                    }
                )
                .await
                .unwrap()
            )
            .unwrap(),
            serde_json::to_value(history).unwrap(),
            "rebuilding cannot depend on source metadata or cache state"
        );
        assert_eq!(
            log.editable_message(session, "first", "message-first")
                .await
                .unwrap()
                .unwrap(),
            editable
        );
    }
    assert_eq!(
        log.prefix(100, 65536).await.unwrap().events.len(),
        4,
        "only real source work was appended"
    );
}

#[tokio::test]
async fn failed_copy_publishes_neither_destination_nor_partial_resources() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("history.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    turn(&log, "source", "missing-upload", true).await;
    let revision = log
        .get_session::<Value>("source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    let request = SessionCopy {
        source_session_id: "source".into(),
        target_session_id: "target".into(),
        expected_source_revision: revision,
        purpose: maka_agent_facts::session::CopyPurpose::Branch {
            turn_id: None,
            side_conversation: false,
        },
    };
    assert!(matches!(
        log.copy_session(
            SessionCopy {
                expected_source_revision: revision + 1,
                ..request.clone()
            },
            &json!({}),
            3
        )
        .await
        .unwrap(),
        SessionCopyResult::SourceRevisionConflict { .. }
    ));
    let catalog = log
        .list_sessions::<Value>(None, None, 32)
        .await
        .unwrap()
        .revision;
    assert!(matches!(log.copy_session(request, &json!({}), 3).await,
        Err(StoreError::InvalidTransition(message)) if message == "history artifact no longer exists"));
    assert!(
        log.copy_session(
            SessionCopy {
                source_session_id: "source".into(),
                target_session_id: "target".into(),
                expected_source_revision: revision,
                purpose: maka_agent_facts::session::CopyPurpose::Revision {
                    turn_id: "missing-upload".into()
                },
            },
            &json!({}),
            3
        )
        .await
        .is_err(),
        "an excluded edit input still needs its attachments"
    );
    assert!(log.get_session::<Value>("target").await.unwrap().is_none());
    assert_eq!(
        log.list_sessions::<Value>(None, None, 32)
            .await
            .unwrap()
            .revision,
        catalog
    );
    let empty = copy(
        &log,
        SessionCopy {
            source_session_id: "source".into(),
            target_session_id: "target".into(),
            expected_source_revision: revision,
            purpose: maka_agent_facts::session::CopyPurpose::EmptySideConversation,
        },
    )
    .await;
    assert!(empty.execution.is_none());
    assert!(
        log.capture_model_context("target", None, 100_000, 64 * 1024 * 1024)
            .await
            .unwrap()
            .tail
            .is_empty()
    );
}

#[tokio::test]
async fn revisions_own_excluded_inputs_and_allocate_one_durable_family() {
    use maka_agent_facts::session::BranchOrigin;
    use maka_agent_facts::session::CopyPurpose;
    use maka_agent_facts::session::Lineage;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("revision.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    log.commit_artifact(
        Artifact {
            id: "upload".into(),
            session_id: "source".into(),
            turn_id: "first".into(),
            created_at: 2,
            name: "input.txt".into(),
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
    turn(&log, "source", "first", true).await;
    let source = log.get_session::<Value>("source").await.unwrap().unwrap();
    let request = SessionCopy {
        source_session_id: "source".into(),
        target_session_id: "revision-a".into(),
        expected_source_revision: source.revision,
        purpose: CopyPurpose::Revision {
            turn_id: "first".into(),
        },
    };
    let (a, b) = tokio::join!(
        copy(&log, request.clone()),
        copy(
            &log,
            SessionCopy {
                target_session_id: "revision-b".into(),
                ..request.clone()
            }
        )
    );
    let mut indexes = Vec::new();
    for record in [&a, &b] {
        let Some(Lineage::Revision {
            root_session_id,
            parent_session_id,
            turn_id,
            index,
            branch,
        }) = record.lineage.as_deref()
        else {
            panic!("revision has no lineage");
        };
        assert_eq!(
            (
                root_session_id.as_str(),
                parent_session_id.as_str(),
                turn_id.as_str()
            ),
            ("source", "source", "first")
        );
        assert!(branch.is_none());
        indexes.push(*index);
        assert!(record.execution.is_none());
        assert!(
            log.capture_model_context(&record.id, None, 100_000, 64 * 1024 * 1024)
                .await
                .unwrap()
                .tail
                .is_empty()
        );
        crate::transcript_cache::materialize_all_rows(&log, &record.id, 0)
            .await
            .unwrap();
        assert!(
            log.navigation_turns(&record.id, 0, None, 32)
                .await
                .unwrap()
                .contributions
                .is_empty()
        );
        assert!(
            log.root_message(&record.id, "message-first")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            log.validate_message_identity(&record.id, "message-first")
                .await
                .is_err(),
            "editing cannot reuse the source's identity"
        );
        let mut collision = RuntimeEvent::new(
            Invocation {
                session_id: record.id.clone(),
                turn_id: "collision".into(),
                run_id: "collision".into(),
                invocation_id: "collision".into(),
            },
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "new execution".into(),
                    request_fingerprint: None,
                },
            },
        );
        collision.id = "message-first".into();
        assert!(
            matches!(
                log.append(&EventWrite::plain(collision).unwrap()).await,
                Err(maka_agent_facts::event::CommitError::Rejected(reason)) if reason == StoreError::EventConflict.to_string()
            ),
            "canonical events cannot take a retained source identity either"
        );
    }
    indexes.sort();
    assert_eq!(indexes, [2, 3]);
    let branched = copy(
        &log,
        SessionCopy {
            target_session_id: "branch".into(),
            purpose: CopyPurpose::Branch {
                turn_id: Some("first".into()),
                side_conversation: false,
            },
            ..request.clone()
        },
    )
    .await;
    let branch_revision = copy(
        &log,
        SessionCopy {
            source_session_id: branched.id,
            target_session_id: "branch-revision".into(),
            expected_source_revision: branched.revision,
            purpose: request.purpose.clone(),
        },
    )
    .await;
    assert_eq!(
        branch_revision.lineage.as_deref(),
        Some(&Lineage::Revision {
            root_session_id: "branch".into(),
            parent_session_id: "branch".into(),
            turn_id: "first".into(),
            index: 2,
            branch: Some(BranchOrigin {
                parent_session_id: "source".into(),
                turn_id: Some("first".into())
            }),
        })
    );
    turn(&log, "revision-a", "edited", false).await;
    let current = log
        .get_session::<Value>("revision-a")
        .await
        .unwrap()
        .unwrap();
    let next = copy(
        &log,
        SessionCopy {
            source_session_id: "revision-a".into(),
            target_session_id: "revision-next".into(),
            expected_source_revision: current.revision,
            purpose: CopyPurpose::Revision {
                turn_id: "edited".into(),
            },
        },
    )
    .await;
    assert_eq!(
        next.lineage.as_deref(),
        Some(&Lineage::Revision {
            root_session_id: "source".into(),
            parent_session_id: "revision-a".into(),
            turn_id: "edited".into(),
            index: 4,
            branch: None,
        })
    );
    log.delete_user_artifact("source", "upload").await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        copy(&log, request).await.lineage,
        a.lineage,
        "retries do not allocate another family index"
    );
    for target in ["revision-a", "revision-b", "branch-revision"] {
        let input = log
            .editable_message(target, "first", "message-first")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(input.content.text, "first before preparation");
        let StorageRef::SessionFile {
            session_id,
            relative_path,
        } = &input.content.attachments.as_ref().unwrap()[0].storage_ref
        else {
            panic!("editable input lost its retained upload");
        };
        assert_eq!(session_id, target);
        assert_eq!(
            log.read_artifact_chunk(target, relative_path, 0, 64)
                .await
                .unwrap()
                .unwrap()
                .bytes,
            b"hello"
        );
    }
    assert!(
        log.editable_message("revision-next", "first", "message-first")
            .await
            .unwrap()
            .is_none(),
        "another draft's excluded source is not inherited history"
    );
    assert_eq!(
        log.abandon_revision("revision-b").await.unwrap(),
        maka_event_log::sessions::AbandonRevision::Abandoned
    );
    assert!(matches!(
        log.list_artifacts("revision-b", 0, 32).await,
        Err(StoreError::SessionNotFound)
    ));
    assert!(
        log.editable_message("revision-b", "first", "message-first")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn draft_abandonment_serializes_with_acceptance_and_preserves_identity_after_reopen() {
    use maka_agent_facts::input::DeliveredMessage;
    use maka_agent_facts::message::MessageDisposition;
    use maka_agent_facts::message::Placement;
    use maka_agent_facts::message::RootSourceMessage;
    use maka_agent_facts::session::CopyPurpose;
    use maka_agent_facts::session::CopyState;
    use maka_agent_facts::session::Lineage;
    use maka_event_log::{message_admissions::PendingMessageAdmission, sessions::AbandonRevision};
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("drafts.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    turn(&log, "source", "first", false).await;
    let source = log.get_session::<Value>("source").await.unwrap().unwrap();
    let request = |target: &str| SessionCopy {
        source_session_id: "source".into(),
        target_session_id: target.into(),
        expected_source_revision: source.revision,
        purpose: CopyPurpose::Revision {
            turn_id: "first".into(),
        },
    };
    let admission = |session: &str| PendingMessageAdmission {
        execution: maka_event_log::message_admissions::PendingExecution {
            owner: "maka-runtime-host".into(),
            basis: serde_json::Value::Null,
        },
        invocation: Invocation {
            session_id: session.into(),
            turn_id: format!("turn-{session}"),
            run_id: format!("run-{session}"),
            invocation_id: format!("inv-{session}"),
        },
        steering_invocation: None,
        source: RootSourceMessage {
            unprepared_content: "new input".into(),
            message: DeliveredMessage {
                origin: None,
                message_id: format!("new-{session}"),
                content: "new input".into(),
                submitted_content_digest: maka_agent_facts::input::MessageInput::from("new input")
                    .content_digest()
                    .unwrap(),
            },
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        },
        required_tools: Default::default(),
        admitted_at: 25,
    };
    for target in [
        "discarded",
        "accepted",
        "racing",
        "dependent",
        "failed-child",
        "native",
    ] {
        assert_eq!(
            copy(&log, request(target)).await.copy_state,
            Some(CopyState::Preparing)
        );
    }
    assert_eq!(
        log.abandon_revision("discarded").await.unwrap(),
        AbandonRevision::Abandoned
    );
    assert!(matches!(
        log.admit_message(admission("discarded")).await,
        Err(StoreError::SessionNotFound)
    ));
    log.admit_message(admission("accepted")).await.unwrap();
    assert_eq!(
        log.abandon_revision("accepted").await.unwrap(),
        AbandonRevision::Retained
    );
    assert!(
        log.root_message("accepted", "new-accepted")
            .await
            .unwrap()
            .is_none(),
        "pending work is not yet canonical history"
    );
    let (accepted, abandoned) = tokio::join!(
        log.admit_message(admission("racing")),
        log.abandon_revision("racing")
    );
    match abandoned.unwrap() {
        AbandonRevision::Abandoned => assert!(matches!(accepted, Err(StoreError::SessionNotFound))),
        AbandonRevision::Retained => assert!(accepted.is_ok()),
    }
    let dependent = log
        .get_session::<Value>("dependent")
        .await
        .unwrap()
        .unwrap();
    copy(
        &log,
        SessionCopy {
            source_session_id: "dependent".into(),
            target_session_id: "child".into(),
            expected_source_revision: dependent.revision,
            purpose: CopyPurpose::EmptySideConversation,
        },
    )
    .await;
    assert_eq!(
        log.abandon_revision("dependent").await.unwrap(),
        AbandonRevision::Retained
    );
    let claim = maka_event_log::sessions::PluginSession {
        session_id: "discarded".into(),
        creator: maka_capabilities::storage::Namespace::new(
            "external.workflow",
            maka_plugin_core::scope::Scope::Profile,
        )
        .unwrap(),
        fingerprint: "new-root".into(),
        managed: false,
        authority_session_id: Some("failed-child".into()),
    };
    assert!(matches!(
        log.create_plugin_session(&claim, &json!({}), 26).await,
        Err(StoreError::SessionConflict)
    ));
    assert_eq!(
        log.abandon_revision("failed-child").await.unwrap(),
        AbandonRevision::Abandoned,
        "rejected dependent creation must not retain a draft"
    );
    turn(&log, "native", "own-turn", false).await;
    assert_eq!(
        log.abandon_revision("native").await.unwrap(),
        AbandonRevision::Retained
    );

    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.abandon_revision("discarded").await.unwrap(),
        AbandonRevision::Abandoned
    );
    assert_eq!(
        log.abandon_revision("accepted").await.unwrap(),
        AbandonRevision::Retained
    );
    assert!(
        log.get_session::<Value>("discarded")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        log.session_copy_receipt("discarded").await.unwrap(),
        Some(maka_agent_facts::session::CopyReceipt {
            request: request("discarded"),
            state: CopyState::Abandoned,
        })
    );
    assert!(
        log.session_copy_receipt("never-created")
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        log.copy_session(request("discarded"), &json!({}), 30).await,
        Err(StoreError::SessionNotFound)
    ));
    assert!(matches!(
        log.create_session("discarded", "new-identity", &json!({}), 30)
            .await,
        Err(StoreError::SessionConflict)
    ));
    assert!(log.retain_session("discarded").await.is_err());
    let late = admission("discarded");
    assert!(
        log.append(
            &EventWrite::plain(RuntimeEvent::new(
                late.invocation,
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        content: late.source.message.content.clone(),
                        source_messages: vec![late.source],
                        request_fingerprint: None,
                    },
                }
            ))
            .unwrap()
        )
        .await
        .is_err(),
        "late opening must not recreate an abandoned draft"
    );
    let next = copy(&log, request("next")).await;
    assert!(
        matches!(
            next.lineage.as_deref(),
            Some(Lineage::Revision { index: 8, .. })
        ),
        "abandoned family indexes must not be reused"
    );
    let claim = maka_event_log::sessions::PluginSession {
        session_id: "plugin-root".into(),
        authority_session_id: Some("next".into()),
        ..claim
    };
    log.create_plugin_session(&claim, &json!({}), 31)
        .await
        .unwrap();
    assert_eq!(
        log.abandon_revision("next").await.unwrap(),
        AbandonRevision::Retained
    );
    assert_eq!(
        log.get_session::<Value>("next")
            .await
            .unwrap()
            .unwrap()
            .copy_state,
        Some(CopyState::Committed)
    );
    log.close().await.unwrap();
}
