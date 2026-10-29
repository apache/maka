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

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_event_log::{EventLog, StoreError, sessions::SessionMutation};
use serde_json::{Value, json};

#[tokio::test]
async fn create_replay_conflict_reopen_and_anchored_catalog_pages() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let configuration = json!({"name":"A", "instructions":"directive".repeat(8193)});
    let original = log
        .create_session("a", "request-a", &configuration, 10)
        .await
        .unwrap();
    assert_eq!(
        original,
        log.create_session("a", "request-a", &json!({"name": "ignored"}), 20)
            .await
            .unwrap()
    );
    assert_eq!(
        Some(original.clone()),
        log.probe_session_create::<Value>("a", "request-a")
            .await
            .unwrap()
    );
    assert!(matches!(
        log.probe_session_create::<Value>("a", "other").await,
        Err(StoreError::SessionConflict)
    ));
    assert!(matches!(
        log.create_session("a", "other", &json!({}), 20).await,
        Err(StoreError::SessionConflict)
    ));
    let binding = log
        .attach_workspace("chosen", &json!({"path":"/chosen"}))
        .await
        .unwrap();
    for id in ["b", "c"] {
        log.create_session(
            id,
            id,
            &json!({"workspace":binding,"boundary_revision":0}),
            10,
        )
        .await
        .unwrap();
    }
    let scoped = log
        .scoped_sessions::<Value>(
            maka_event_log::sessions::CatalogScope::Workspace("/chosen".into()),
            None,
            None.into(),
            maka_event_log::sessions::CatalogFilter {
                archived_only: false,
                include_archived: false,
                pending_only: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        scoped
            .sessions
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["b", "c"]
    );
    assert_eq!(
        log.workspace_fence("/chosen")
            .await
            .unwrap()
            .0
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect::<Vec<_>>(),
        ["b", "c"]
    );
    assert!(
        log.workspace_has_other_session("/chosen", "b")
            .await
            .unwrap()
    );
    assert_eq!(original.configuration, configuration);
    let page = log.list_sessions::<Value>(None, None, 2).await.unwrap();
    assert_eq!(
        page.sessions
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(page.next_cursor.as_deref(), Some("b"));
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(Some(original), log.get_session::<Value>("a").await.unwrap());
    let rest = log
        .list_sessions::<Value>(Some(&page.revision), page.next_cursor.as_deref(), 2)
        .await
        .unwrap();
    assert_eq!(rest.sessions[0].id, "c");
    assert_eq!(rest.revision, page.revision);
    assert!(rest.next_cursor.is_none());
    let previous = log
        .scoped_sessions::<Value>(
            maka_event_log::sessions::CatalogScope::Profile,
            Some(&page.revision),
            maka_event_log::sessions::SessionPosition::Before("c"),
            maka_event_log::sessions::CatalogFilter {
                archived_only: false,
                include_archived: true,
                pending_only: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        previous
            .sessions
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert!(previous.previous_cursor.is_none());
    assert_eq!(previous.next_cursor.as_deref(), Some("b"));
    log.create_session("d", "d", &json!({}), 30).await.unwrap();
    assert!(matches!(
        log.list_sessions::<Value>(Some(&page.revision), Some("b"), 2)
            .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    let archived = log
        .set_session_archived::<Value>("a", true, 40)
        .await
        .unwrap();
    assert_eq!(
        (archived.revision, archived.created_at, archived.updated_at),
        (2, 10, 40)
    );
    assert!(
        log.scoped_sessions::<Value>(
            maka_event_log::sessions::CatalogScope::Session("a".into()),
            None,
            None.into(),
            maka_event_log::sessions::CatalogFilter {
                archived_only: false,
                include_archived: false,
                pending_only: false
            },
        )
        .await
        .unwrap()
        .sessions
        .is_empty(),
        "read grants do not expose archived Sessions"
    );
    let before = log
        .list_sessions::<Value>(None, None, 32)
        .await
        .unwrap()
        .revision;
    assert_eq!(
        archived,
        log.set_session_archived::<Value>("a", true, 50)
            .await
            .unwrap()
    );
    assert_eq!(
        before,
        log.list_sessions::<Value>(None, None, 32)
            .await
            .unwrap()
            .revision
    );
    let active = log
        .set_session_archived::<Value>("a", false, 35)
        .await
        .unwrap();
    assert!(!active.archived);
    assert_eq!((active.revision, active.updated_at), (3, 40));
}

#[tokio::test]
async fn owned_catalog_filters_before_paging_and_binds_literal_query_and_scope_to_revision() {
    use maka_agent_facts::{
        execution::WorkspaceIdentity,
        interaction::{InteractionRecord, InteractionRequest},
    };
    use maka_event_log::sessions::{
        CatalogFilter, CatalogScope, CatalogSelection, SessionPosition,
    };

    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("owned-catalog.sqlite"))
        .await
        .unwrap();
    let project = uuid::Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
    let other_project = uuid::Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
    let identity =
        WorkspaceIdentity::from_marker_id("33333333-3333-4333-8333-333333333333").unwrap();
    let other_identity =
        WorkspaceIdentity::from_marker_id("44444444-4444-4444-8444-444444444444").unwrap();
    let query = "Keep 会话%_'";
    let title = "Keep 会话%_' 标题";
    async fn configuration(
        log: &EventLog,
        project: uuid::Uuid,
        identity: &WorkspaceIdentity,
        title: &str,
        path: &str,
    ) -> Value {
        let binding = log
            .attach_workspace(
                "catalog",
                &json!({
                    "projectId":project,"identity":identity,"path":path
                }),
            )
            .await
            .unwrap();
        json!({"title":title,"workspace":binding,"boundary_revision":0})
    }
    // These earlier IDs would displace real matches if filtering happened
    // after LIMIT. Equal paths do not establish intrinsic workspace membership.
    for (id, project, workspace, title) in [
        ("foreign_aaa_match", project, &identity, title),
        ("owned_aaa_other_workspace", project, &other_identity, title),
        (
            "owned_aaa_wrong_project",
            other_project,
            &other_identity,
            title,
        ),
        (
            "owned_aaa_literal_noise",
            project,
            &identity,
            "Keep 会话AA' 标题",
        ),
        (
            "owned_aaa_case_noise",
            project,
            &identity,
            "keep 会话%_' 标题",
        ),
    ] {
        log.create_session(
            id,
            id,
            &configuration(&log, project, workspace, title, "/shared").await,
            1,
        )
        .await
        .unwrap();
    }
    for index in 0..35 {
        let id = format!("owned_match_{index:02}");
        let path = if index == 0 { "/relocated" } else { "/shared" };
        log.create_session(
            &id,
            &id,
            &configuration(&log, project, &identity, title, path).await,
            1,
        )
        .await
        .unwrap();
    }
    for id in [
        "owned_match_00",
        "foreign_aaa_match",
        "owned_aaa_other_workspace",
        "owned_aaa_wrong_project",
        "owned_aaa_literal_noise",
        "owned_aaa_case_noise",
    ] {
        log.establish_interaction(&InteractionRecord {
            session_id: id.into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            request_id: format!("request_{id}"),
            created_at: 10,
            request: InteractionRequest::ServiceApproval {
                tool_use_id: "tool".into(),
                tool_name: "tool".into(),
                service: "service".into(),
                method: "method".into(),
                binding: "binding".into(),
                through: 1,
            },
            outcome: None,
        })
        .await
        .unwrap();
    }
    let owned = |selection, title_query: &str| CatalogScope::Owned {
        id_prefix: "owned_".into(),
        selection,
        title_query: title_query.into(),
    };
    let workspace_scope = |session_id: &str, identity: &WorkspaceIdentity, title_query: &str| {
        owned(
            CatalogSelection::Workspace {
                session_id: session_id.into(),
                identity: identity.clone(),
            },
            title_query,
        )
    };
    let workspace = workspace_scope("owned_match_00", &identity, query);
    let filter = CatalogFilter {
        archived_only: false,
        include_archived: false,
        pending_only: false,
    };
    let first = log
        .scoped_sessions::<Value>(workspace.clone(), None, SessionPosition::Start, filter)
        .await
        .unwrap();
    assert_eq!(first.sessions.len(), 32);
    assert_eq!(first.sessions.first().unwrap().id, "owned_match_00");
    assert_eq!(first.sessions.last().unwrap().id, "owned_match_31");
    assert_eq!(first.pending_session_count, 1);
    assert!(first.previous_cursor.is_none());
    assert_eq!(first.next_cursor.as_deref(), Some("owned_match_31"));
    assert_eq!(
        log.catalog_revision(workspace.clone(), filter)
            .await
            .unwrap(),
        first.revision
    );
    let tail = log
        .scoped_sessions::<Value>(
            workspace.clone(),
            Some(&first.revision),
            SessionPosition::After(first.next_cursor.as_deref().unwrap()),
            filter,
        )
        .await
        .unwrap();
    assert_eq!(
        tail.sessions
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["owned_match_32", "owned_match_33", "owned_match_34"]
    );
    assert_eq!(tail.pending_session_count, 1);
    assert!(tail.next_cursor.is_none());
    let previous = log
        .scoped_sessions::<Value>(
            workspace.clone(),
            Some(&first.revision),
            SessionPosition::Before(tail.previous_cursor.as_deref().unwrap()),
            filter,
        )
        .await
        .unwrap();
    assert_eq!(previous.sessions, first.sessions);
    for (selection, expected_pending) in [
        (CatalogSelection::Project(project), 2),
        (CatalogSelection::All, 3),
    ] {
        let page = log
            .scoped_sessions::<Value>(
                owned(selection, query),
                None,
                SessionPosition::Start,
                filter,
            )
            .await
            .unwrap();
        assert_eq!(page.sessions.len(), 32);
        assert_eq!(
            page.sessions.first().unwrap().id,
            "owned_aaa_other_workspace"
        );
        assert_eq!(page.pending_session_count, expected_pending);
    }
    let unfiltered = log
        .scoped_sessions::<Value>(
            owned(CatalogSelection::All, ""),
            None,
            SessionPosition::Start,
            filter,
        )
        .await
        .unwrap();
    assert_eq!(
        unfiltered.sessions.first().unwrap().id,
        "owned_aaa_case_noise"
    );
    assert_eq!(unfiltered.pending_session_count, 5);
    for (scope, filter) in [
        (CatalogScope::IdPrefix("owned_".into()), filter),
        (owned(CatalogSelection::All, query), filter),
        (owned(CatalogSelection::Project(project), query), filter),
        (
            owned(CatalogSelection::Project(other_project), query),
            filter,
        ),
        (workspace_scope("owned_match_01", &identity, query), filter),
        (
            workspace_scope("owned_aaa_other_workspace", &other_identity, query),
            filter,
        ),
        (
            CatalogScope::Owned {
                id_prefix: "owned".into(),
                selection: CatalogSelection::Workspace {
                    session_id: "owned_match_00".into(),
                    identity: identity.clone(),
                },
                title_query: query.into(),
            },
            filter,
        ),
        (workspace_scope("owned_match_00", &identity, "Keep"), filter),
        (
            workspace.clone(),
            CatalogFilter {
                include_archived: true,
                ..filter
            },
        ),
        (
            workspace.clone(),
            CatalogFilter {
                pending_only: true,
                ..filter
            },
        ),
    ] {
        assert!(matches!(
            log.scoped_sessions::<Value>(
                scope,
                Some(&first.revision),
                SessionPosition::After("owned_match_31"),
                filter
            )
            .await,
            Err(StoreError::RevisionConflict { .. })
        ));
    }
    let shorter = log
        .catalog_revision(owned(CatalogSelection::All, &"界".repeat(128)), filter)
        .await
        .unwrap();
    let long_scope = owned(CatalogSelection::All, &"界".repeat(129));
    let long_revision = log
        .catalog_revision(long_scope.clone(), filter)
        .await
        .unwrap();
    assert_ne!(shorter, long_revision);
    let long_page = log
        .scoped_sessions::<Value>(
            long_scope,
            Some(&long_revision),
            SessionPosition::Start,
            filter,
        )
        .await
        .unwrap();
    assert_eq!(long_page.revision, long_revision);
    assert!(long_page.sessions.is_empty());
    assert!(long_page.next_cursor.is_none());
    log.close().await.unwrap();
}

#[tokio::test]
async fn lifecycle_obeys_canonical_invocation_seal_and_validates_bounds() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    log.create_session("a", "a", &json!({}), 1).await.unwrap();
    log.create_session("b", "b", &json!({}), 1).await.unwrap();
    let invocation = Invocation {
        session_id: "a".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let opening = EventWrite::plain(RuntimeEvent::new(
        invocation.clone(),
        Fact::InvocationOpened {
            configuration: None,
            input: maka_agent_facts::input::InvocationInput::Message {
                source_messages: Vec::new(),
                content: "".into(),
                request_fingerprint: None,
            },
        },
    ))
    .unwrap();
    let successor = Invocation {
        session_id: "a".into(),
        turn_id: "successor-turn".into(),
        run_id: "successor-run".into(),
        invocation_id: "successor-invocation".into(),
    };
    let next_opening = EventWrite::plain(RuntimeEvent::new(
        successor.clone(),
        opening.event().fact.clone(),
    ))
    .unwrap();
    let before = serde_json::to_vec(&log.prefix(10, 16_384).await.unwrap()).unwrap();
    assert!(
        log.append_batch(&[opening.clone(), next_opening.clone()])
            .await
            .is_err()
    );
    assert_eq!(
        serde_json::to_vec(&log.prefix(10, 16_384).await.unwrap()).unwrap(),
        before
    );
    let first_sequence = log.append(&opening).await.unwrap();
    assert!(matches!(
        log.change_session_archived::<Value>("a", Some(0), true, 2)
            .await
            .unwrap(),
        SessionMutation::RevisionConflict {
            expected: 0,
            actual: 2
        }
    ));
    assert!(matches!(
        log.set_session_archived::<Value>("a", false, 2).await,
        Err(StoreError::SessionBusy)
    ));
    assert!(matches!(
        log.set_session_archived::<Value>("a", true, 2).await,
        Err(StoreError::SessionBusy)
    ));
    assert!(
        log.set_session_archived::<Value>("b", true, 2)
            .await
            .unwrap()
            .archived
    );
    let ending = EventWrite::plain(RuntimeEvent::new(
        invocation,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ))
    .unwrap();
    let before = serde_json::to_vec(&log.prefix(10, 16_384).await.unwrap()).unwrap();
    assert!(
        log.append_batch(&[next_opening.clone(), ending.clone()])
            .await
            .is_err()
    );
    assert_eq!(
        serde_json::to_vec(&log.prefix(10, 16_384).await.unwrap()).unwrap(),
        before
    );
    let sequences = log.append_batch(&[ending, next_opening]).await.unwrap();
    assert_eq!(sequences, vec![first_sequence + 1, first_sequence + 2]);
    assert_eq!(log.append(&opening).await.unwrap(), first_sequence);
    assert!(matches!(
        log.set_session_archived::<Value>("a", true, 2).await,
        Err(StoreError::SessionBusy)
    ));
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            successor,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    assert!(
        log.set_session_archived::<Value>("a", true, 2)
            .await
            .unwrap()
            .archived
    );
    let archived_admission = RuntimeEvent::new(
        Invocation {
            session_id: "a".into(),
            turn_id: "late-turn".into(),
            run_id: "late-run".into(),
            invocation_id: "late-invocation".into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: maka_agent_facts::input::InvocationInput::Message {
                source_messages: Vec::new(),
                content: "".into(),
                request_fingerprint: None,
            },
        },
    );
    assert!(
        log.append(&EventWrite::plain((archived_admission).clone()).unwrap())
            .await
            .is_err(),
        "archive and invocation admission serialize in the same transaction boundary"
    );
    assert!(matches!(
        log.set_session_archived::<Value>("missing", true, 2).await,
        Err(StoreError::SessionNotFound)
    ));
    assert!(
        log.create_session("bad/id", "a", &json!({}), 1)
            .await
            .is_err()
    );
    let configuration = "x".repeat(65536);
    log.create_session("large", "large", &configuration, 1)
        .await
        .unwrap();
    assert_eq!(
        log.get_session::<String>("large")
            .await
            .unwrap()
            .unwrap()
            .configuration,
        configuration
    );
    assert!(
        log.create_session("time", "time", &json!({}), u64::MAX)
            .await
            .is_err()
    );
    assert!(log.list_sessions::<Value>(None, None, 33).await.is_err());
    assert!(
        log.list_sessions::<Value>(None, Some("a"), 1)
            .await
            .is_err()
    );
    log.close().await.unwrap();
    let reopened = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    assert_eq!(
        reopened
            .get_session::<String>("large")
            .await
            .unwrap()
            .unwrap()
            .configuration,
        configuration
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn availability_tracks_visibility_without_admitting_work_or_decoding_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    assert!(!log.session_is_available("missing").await.unwrap());
    for invalid in ["", "a/b", "a.b", "a b"] {
        assert!(matches!(
            log.session_is_available(invalid).await,
            Err(StoreError::InvalidTransition(_))
        ));
    }
    let session = log
        .create_session("visible", "create", &json!({}), 1)
        .await
        .unwrap();
    assert!(log.session_is_available("visible").await.unwrap());
    let archived = log
        .set_session_archived::<Value>("visible", true, 2)
        .await
        .unwrap();
    assert!(archived.archived);
    assert!(log.session_is_available("visible").await.unwrap());
    assert!(log.get_session::<Value>("visible").await.unwrap().is_some());
    let active = log
        .set_session_archived::<Value>("visible", false, 3)
        .await
        .unwrap();
    assert!(active.revision > session.revision);
    // Visibility is independent of unrelated metadata decoding. Full readers
    // must still reject malformed configuration instead of manufacturing a record.
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults
        .execute(
            "UPDATE session_control SET configuration='{\"workspace\":false}' WHERE id='visible'",
            [],
        )
        .unwrap();
    assert!(log.session_is_available("visible").await.unwrap());
    assert!(matches!(
        log.get_session::<Value>("visible").await,
        Err(StoreError::Json(_))
    ));
    faults
        .execute(
            "UPDATE session_control SET configuration='{}' WHERE id='visible'",
            [],
        )
        .unwrap();
    drop(faults);
    assert_eq!(
        log.begin_session_removal("visible", active.revision)
            .await
            .unwrap(),
        maka_event_log::sessions::SessionRemovalResult::Accepted(
            maka_event_log::sessions::SessionRetirement::Removing
        )
    );
    assert!(!log.session_is_available("visible").await.unwrap());
    assert!(log.get_session::<Value>("visible").await.unwrap().is_none());
    assert!(
        log.retiring_session::<Value>("visible")
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        log.finish_session_retirement("visible").await.unwrap(),
        maka_event_log::sessions::SessionRetirement::Removed
    );
    assert!(!log.session_is_available("visible").await.unwrap());
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert!(!reopened.session_is_available("visible").await.unwrap());
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn availability_rejects_a_root_that_lost_its_authority() {
    use maka_event_log::root::{RootNamespaces, RootOwner};
    let directory = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let root = directory.path().join("root");
    let owner = std::sync::Arc::new(RootOwner::create(&root, &namespaces).unwrap());
    let log = maka_event_log::RootStore::open(owner).await.unwrap();
    log.create_session("visible", "create", &json!({}), 1)
        .await
        .unwrap();
    assert!(log.session_is_available("visible").await.unwrap());
    std::fs::remove_dir_all(&namespaces.control).unwrap();
    assert!(matches!(
        log.session_is_available("visible").await,
        Err(StoreError::Io(_))
    ));
    assert!(log.get_session::<Value>("visible").await.is_err());
    log.close().await.unwrap();
}
