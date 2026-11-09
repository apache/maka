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

mod support;

use maka_agent_facts::{
    accounting::Outcome,
    artifact::content_digest,
    durable::*,
    history_snapshot::SnapshotId,
    input::{DeliveredMessage, MessageInput, RunInput},
    message::{MessageDisposition, Placement as SubmittedPlacement, RootSourceMessage},
    model::ModelUsage,
};
use maka_agent_state::{
    Admission, Change, ContentBlob,
    queue::{Placement, QueueCommand, QueueEdit},
    session_history::snapshot::CaptureRequest,
};
use maka_event_log::{
    StoreError,
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::operation::OperationCleanup;
use rusqlite::Connection;
use serde_json::json;
use std::collections::BTreeSet;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn latest_message_backend_ignores_compaction_history_and_imported_execution_lookalikes() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let (spec, contents) = support::spec("session", "message-turn", "question");
    let expected_backend = spec.backend.clone();
    let admission = Admission::new(spec, UnixMillis(1), contents);
    let message = admission.run();
    state.admit(admission).await.unwrap();
    support::complete(&state, message).await;
    let history = state.session_history(support::owner(), "session".into());
    let snapshot = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::new(),
                cut: history.capture().await.unwrap(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    for (turn, trigger) in [
        ("compact", Trigger::ContextCompact),
        (
            "goal",
            Trigger::Goal {
                goal_id: uuid::Uuid::new_v4(),
            },
        ),
    ] {
        let (mut spec, mut contents) = support::spec("session", turn, "background input");
        if matches!(&trigger, Trigger::ContextCompact) {
            let input = ContentBlob::json(&RunInput::ContextCompact {
                request_fingerprint: content_digest(b"original compact request"),
            })
            .unwrap();
            spec.input = input.reference().clone();
            contents.push(input);
        }
        spec.trigger = trigger;
        let admission = Admission::new(spec, UnixMillis(2), contents);
        let run = admission.run();
        state.admit(admission).await.unwrap();
        support::complete(&state, run).await;
    }
    let (mut spec, mut contents) = support::spec("session", "history", "history");
    let source = snapshot.reference().clone();
    let input = ContentBlob::json(&RunInput::HistorySource {
        source: source.clone(),
    })
    .unwrap();
    spec.input = input.reference().clone();
    contents.push(input);
    spec.trigger = Trigger::HistorySource;
    spec.backend = BackendSpec::Historical {};
    spec.origin = RunOrigin::Forked {
        source_run: message,
        source: source.clone(),
    };
    let install = snapshot
        .adopt(
            &history,
            uuid::Uuid::new_v4(),
            spec,
            UnixMillis(3),
            contents,
        )
        .unwrap();
    let historical = root
        .data_writer()
        .unwrap()
        .write(install)
        .await
        .unwrap()
        .run;
    let (mut spec, contents) = support::spec("session", "imported-lookalike", "imported evidence");
    spec.origin = RunOrigin::Imported { source };
    let imported = Admission::new(spec, UnixMillis(4), contents);
    let imported_run = imported.run();
    state.admit(imported).await.unwrap();
    assert_eq!(
        state
            .latest_message_backend(support::owner(), "session".into())
            .await
            .unwrap(),
        Some((message, expected_backend))
    );
    assert!(
        state
            .finished_or_stopped(support::owner(), vec![historical, imported_run])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        state
            .latest_message_backend(support::owner(), "absent".into())
            .await
            .unwrap()
            .is_none()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn mcp_references_keep_frozen_queue_and_real_cleanup_not_cancelled_soft_waits_or_history() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let queued_revision = content_digest(b"queued MCP snapshot");
    let model_revision = content_digest(b"original model MCP snapshot");
    let content = MessageInput::from("queued question");
    let source = RootSourceMessage {
        message: DeliveredMessage {
            message_id: "queued-message".into(),
            origin: None,
            submitted_content_digest: content.content_digest().unwrap(),
            content: content.clone(),
        },
        unprepared_content: content,
        submitted_placement: SubmittedPlacement::NextTurn,
        disposition: MessageDisposition::Followup,
        submitted_intent: None,
    };
    let mut request =
        support::enqueue(&state, source.clone(), vec![source], Placement::Followup).await;
    request.spec.mcp_revision = Some(queued_revision.clone());
    let queue = state.queue();
    queue
        .execute(
            "session".into(),
            QueueCommand {
                id: FactId::new(),
                at: UnixMillis(2),
                expected_revision: queue.read("session".into()).await.unwrap().revision,
                edit: QueueEdit::Update {
                    request: Box::new(request.clone()),
                },
            },
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        state
            .referenced_mcp_revisions(support::owner())
            .await
            .unwrap(),
        BTreeSet::from([queued_revision.clone()])
    );
    let (mut spec, contents) = support::spec("session", "model", "question");
    spec.mcp_revision = Some(model_revision.clone());
    let admission = Admission::new(spec, UnixMillis(3), contents);
    let run = admission.run();
    state.admit(admission).await.unwrap();
    let (step, wire, contents) = support::request(vec![]);
    let attempt = ModelAttemptId::new();
    support::append(
        &state,
        run,
        vec![
            Fact::StepPrepared {
                step,
                request: wire.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared { attempt, step },
            Fact::ModelAttemptAdmitted {
                attempt,
                upstream: json!({"original":true}),
            },
            Fact::ModelInterrupted {
                attempt,
                diagnostic: "transport ended".into(),
            },
            Fact::RunTerminated {
                terminal: Terminal::Cancelled,
                diagnostic: None,
            },
        ],
        contents,
    )
    .await;
    let (mut spec, contents) = support::spec("session", "cancelled-wait", "question");
    spec.mcp_revision = Some(content_digest(b"abandoned private wait catalog"));
    let admission = Admission::new(spec, UnixMillis(4), contents);
    let cancelled = admission.run();
    state.admit(admission).await.unwrap();
    support::append(
        &state,
        cancelled,
        vec![
            Fact::WaitRegistered {
                wait: WaitId::new(),
                reason: WaitReason::Child { run },
                due_at: None,
            },
            Fact::RunTerminated {
                terminal: Terminal::Cancelled,
                diagnostic: None,
            },
        ],
        vec![],
    )
    .await;
    let (mut spec, contents) = support::spec("session", "imported", "evidence");
    spec.mcp_revision = Some(content_digest(b"nonlocal metadata catalog"));
    spec.origin = RunOrigin::Imported {
        source: spec.input.clone(),
    };
    state
        .admit(Admission::new(spec, UnixMillis(5), contents))
        .await
        .unwrap();
    assert_eq!(
        state
            .referenced_mcp_revisions(support::owner())
            .await
            .unwrap(),
        BTreeSet::from([queued_revision.clone(), model_revision])
    );
    state
        .observe(
            run,
            vec![
                Change::new(
                    Fact::ModelClosed {
                        attempt,
                        outcome: Outcome::Aborted,
                        diagnostic: None,
                        usage: ModelUsage::default(),
                        protocol: json!({}),
                    },
                    UnixMillis(6),
                ),
                Change::new(
                    Fact::ModelCleanupObserved {
                        attempt,
                        cleanup: OperationCleanup::Confirmed,
                    },
                    UnixMillis(6),
                ),
            ],
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        state
            .referenced_mcp_revisions(support::owner())
            .await
            .unwrap(),
        BTreeSet::from([queued_revision])
    );
    queue
        .execute(
            "session".into(),
            QueueCommand {
                id: FactId::new(),
                at: UnixMillis(7),
                expected_revision: queue.read("session".into()).await.unwrap().revision,
                edit: QueueEdit::Retract {
                    request: request.id,
                },
            },
            vec![],
        )
        .await
        .unwrap();
    assert!(
        state
            .referenced_mcp_revisions(support::owner())
            .await
            .unwrap()
            .is_empty()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn batch_status_only_returns_requested_local_settlements_and_rejects_foreign_or_inconsistent_metadata()
 {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let completed = support::admit(&state, "session", "done", "question").await;
    support::complete(&state, completed).await;
    let stopped = support::admit(&state, "session", "stop", "question").await;
    support::append(
        &state,
        stopped,
        vec![Fact::StopRequested {
            diagnostic: "stop".into(),
        }],
        vec![],
    )
    .await;
    let live = support::admit(&state, "session", "live", "question").await;
    let (mut spec, contents) = support::spec("session", "foreign", "question");
    spec.owner.deployment = uuid::Uuid::from_u128(999);
    let foreign = Admission::new(spec, UnixMillis(4), contents);
    let foreign_run = foreign.run();
    state.admit(foreign).await.unwrap();
    assert_eq!(
        state
            .finished_or_stopped(
                support::owner(),
                vec![completed, stopped, live, RunId::new(), completed]
            )
            .await
            .unwrap(),
        BTreeSet::from([completed, stopped])
    );
    assert!(
        state
            .finished_or_stopped(support::owner(), vec![foreign_run])
            .await
            .is_err()
    );
    root.data_writer()
        .unwrap()
        .write(CorruptSession(completed))
        .await
        .unwrap();
    assert!(
        state
            .finished_or_stopped(support::owner(), vec![completed])
            .await
            .is_err()
    );
    assert!(
        state
            .finished_or_stopped(support::owner(), vec![live])
            .await
            .unwrap()
            .is_empty()
    );
    root.close().await.unwrap();
}

struct CorruptSession(RunId);
impl Statement for CorruptSession {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        c.execute(
            "UPDATE agent_runs SET session='foreign-session' WHERE run=?",
            [self.0.to_string()],
        )?;
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::METADATA,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

#[tokio::test]
async fn catalog_counts_owned_pending_children_and_invalidates_cursors_on_domain_changes() {
    use maka_agent_facts::interaction::{
        ClosureReason, InteractionOutcome, InteractionQuestion, InteractionRecord,
        InteractionRequest, QuestionOption,
    };
    use maka_agent_state::{
        Store,
        session_catalog::{Filter, Page, Position, SessionCatalog},
    };
    use maka_event_log::sessions::{CatalogFilter, CatalogScope, CatalogSelection};

    fn filter(roots_only: bool, include_archived: bool, needs_you_only: bool) -> Filter {
        Filter {
            base: CatalogFilter {
                roots_only,
                include_archived,
                archived_only: false,
            },
            needs_you_only,
        }
    }
    fn scope(selection: CatalogSelection, title: &str) -> CatalogScope {
        CatalogScope::Owned {
            id_prefix: "own-".into(),
            selection,
            title_query: title.into(),
        }
    }
    fn ids(page: &Page) -> BTreeSet<String> {
        page.sessions
            .iter()
            .map(|row| row.metadata.id.clone())
            .collect()
    }
    async fn question(state: &Store, run: RunId, name: &str) -> InteractionRecord {
        let view = state.frontier(run).await.unwrap();
        let record = InteractionRecord {
            execution: ExecutionIdentity {
                session_id: view.spec.session_id.clone(),
                turn_id: view.spec.turn_id.clone(),
                run_id: run,
            },
            request_id: format!("{}-{name}", view.spec.session_id),
            created_at: 200,
            request: InteractionRequest::Question {
                tool_use_id: maka_agent_facts::tool_call::tool_use_id(run, name),
                questions: vec![InteractionQuestion {
                    question: "Continue this original request?".into(),
                    options: vec![
                        QuestionOption {
                            label: "Continue".into(),
                            description: None,
                        },
                        QuestionOption {
                            label: "Stop".into(),
                            description: None,
                        },
                    ],
                }],
            },
            outcome: None,
        };
        let claim = state.claim(run).await.unwrap();
        state
            .interactions()
            .establish(&claim, (&view).into(), record, None, vec![])
            .await
            .unwrap()
    }
    struct HidePublication;
    impl Statement for HidePublication {
        type Value = ();
        type Output = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            // Exercise the Root visibility input, not a fabricated pending index.
            assert_eq!(c.execute("UPDATE session_creations SET visible=0 WHERE session_id='own-hidden' AND ready=1 AND visible=1", [])?, 1);
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::METADATA,
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let state = support::state(&root);
    for (id, title, parent, created) in [
        ("own-root", "Root", None, 1),
        ("own-child", "Needle child", Some("own-root"), 2),
        ("own-archived", "Needle archived", Some("own-root"), 3),
        ("own-hidden", "Needle hidden", Some("own-root"), 4),
        (
            "other-child",
            "Needle foreign namespace",
            Some("own-root"),
            5,
        ),
        (
            "own-foreign-owner",
            "Needle foreign evidence",
            Some("own-root"),
            6,
        ),
        ("own-blocked", "Blocked root", None, 7),
    ] {
        root.create_session(
            id,
            &format!("create:{id}"),
            &json!({"title":title,"parentSessionId":parent}),
            created,
        )
        .await
        .unwrap();
    }
    let mut runs = std::collections::BTreeMap::new();
    for session in [
        "own-child",
        "own-archived",
        "own-hidden",
        "other-child",
        "own-foreign-owner",
        "own-blocked",
    ] {
        let (mut spec, contents) = support::spec(session, "catalog-turn", "actual pending input");
        if session == "own-foreign-owner" {
            spec.owner.deployment = uuid::Uuid::from_u128(999);
        }
        let admission = Admission::new(spec, UnixMillis(100), contents);
        let run = admission.run();
        state.admit(admission).await.unwrap();
        runs.insert(session, run);
    }
    for session in [
        "own-archived",
        "own-hidden",
        "other-child",
        "own-foreign-owner",
    ] {
        question(&state, runs[session], "excluded-pending").await;
        assert_eq!(
            state
                .interactions()
                .pending(session)
                .await
                .unwrap()
                .records
                .len(),
            1
        );
    }
    root.set_session_archived::<serde_json::Value>("own-archived", true, 110)
        .await
        .unwrap();
    root.data_writer()
        .unwrap()
        .write(HidePublication)
        .await
        .unwrap();
    let catalog =
        SessionCatalog::new(root.data_writer().unwrap(), support::owner(), "own-".into()).unwrap();
    let all = scope(CatalogSelection::All, "");
    let normal = filter(false, false, false);
    let before = catalog
        .page(all.clone(), None, Position::Start, normal.clone(), 1)
        .await
        .unwrap();
    assert_eq!(before.pending_session_count, 0);
    let cursor = before.next_cursor.clone().unwrap();
    let child_metadata = root
        .get_session::<serde_json::Value>("own-child")
        .await
        .unwrap()
        .unwrap();
    let first = question(&state, runs["own-child"], "first").await;
    let pending = catalog
        .page(all.clone(), None, Position::Start, normal.clone(), 32)
        .await
        .unwrap();
    assert_eq!(pending.pending_session_count, 1);
    assert_ne!(pending.revision, before.revision);
    assert_eq!(
        root.get_session::<serde_json::Value>("own-child")
            .await
            .unwrap(),
        Some(child_metadata)
    );
    assert!(
        matches!(catalog.page(all.clone(), Some(before.revision.clone()), Position::After(cursor), normal.clone(), 1).await,
        Err(StoreError::RevisionConflict { expected, actual }) if expected == before.revision && actual == pending.revision)
    );
    let second = question(&state, runs["own-child"], "second").await;
    assert_eq!(
        state
            .interactions()
            .pending("own-child")
            .await
            .unwrap()
            .records
            .len(),
        2
    );
    let two_requests = catalog
        .page(all.clone(), None, Position::Start, normal.clone(), 32)
        .await
        .unwrap();
    assert_eq!(
        two_requests.pending_session_count, 1,
        "count sessions, not requests"
    );
    assert_ne!(two_requests.revision, pending.revision);
    assert_eq!(
        ids(&two_requests),
        BTreeSet::from([
            "own-root".into(),
            "own-child".into(),
            "own-blocked".into(),
            "own-foreign-owner".into(),
        ])
    );

    let blocker = BlockerId::new();
    support::append(
        &state,
        runs["own-blocked"],
        vec![Fact::Blocked {
            blocker,
            reason: BlockerKind::CurrentAuthorityUnavailable {
                stage: AuthorityStage::CurrentSession,
                diagnostic: "current authority is unavailable".into(),
            },
        }],
        vec![],
    )
    .await;
    let roots = catalog
        .page(
            all.clone(),
            None,
            Position::Start,
            filter(true, false, false),
            32,
        )
        .await
        .unwrap();
    assert_eq!(
        ids(&roots),
        BTreeSet::from(["own-root".into(), "own-blocked".into()])
    );
    assert_eq!(
        roots.pending_session_count, 2,
        "roots_only excludes child rows, not their sidebar count"
    );
    let needed_roots = catalog
        .page(
            all.clone(),
            None,
            Position::Start,
            filter(true, false, true),
            32,
        )
        .await
        .unwrap();
    assert_eq!(ids(&needed_roots), BTreeSet::from(["own-blocked".into()]));
    assert_eq!(needed_roots.pending_session_count, 2);
    assert!(needed_roots.sessions[0].status.blocked);
    assert!(
        needed_roots.sessions[0]
            .status
            .pending_interaction_since
            .is_none()
    );
    let children = catalog
        .page(
            scope(CatalogSelection::Children("own-root".into()), ""),
            None,
            Position::Start,
            filter(false, false, true),
            32,
        )
        .await
        .unwrap();
    assert_eq!(ids(&children), BTreeSet::from(["own-child".into()]));
    assert_eq!(children.pending_session_count, 1);
    assert_eq!(
        children.sessions[0].status.pending_interaction_since,
        Some(first.created_at)
    );
    let title = catalog
        .page(
            scope(CatalogSelection::All, "Needle"),
            None,
            Position::Start,
            filter(true, false, false),
            32,
        )
        .await
        .unwrap();
    assert!(title.sessions.is_empty());
    assert_eq!(
        title.pending_session_count, 1,
        "the title query also bounds off-page child counts"
    );
    let root_title = catalog
        .page(
            scope(CatalogSelection::All, "Root"),
            None,
            Position::Start,
            filter(true, false, false),
            32,
        )
        .await
        .unwrap();
    assert_eq!(ids(&root_title), BTreeSet::from(["own-root".into()]));
    assert_eq!(root_title.pending_session_count, 0);
    let absent = catalog
        .page(
            scope(CatalogSelection::All, "absent title"),
            None,
            Position::Start,
            normal.clone(),
            32,
        )
        .await
        .unwrap();
    assert!(absent.sessions.is_empty());
    assert_eq!(absent.pending_session_count, 0);
    let archived = catalog
        .page(
            all.clone(),
            None,
            Position::Start,
            filter(false, true, true),
            32,
        )
        .await
        .unwrap();
    assert_eq!(
        ids(&archived),
        BTreeSet::from([
            "own-child".into(),
            "own-archived".into(),
            "own-blocked".into()
        ])
    );
    assert_eq!(archived.pending_session_count, 3);
    let mut archived_only = filter(false, true, true);
    archived_only.base.archived_only = true;
    let archived = catalog
        .page(all.clone(), None, Position::Start, archived_only, 32)
        .await
        .unwrap();
    assert_eq!(ids(&archived), BTreeSet::from(["own-archived".into()]));
    assert_eq!(archived.pending_session_count, 1);
    let hidden = catalog
        .page(
            CatalogScope::Session("own-hidden".into()),
            None,
            Position::Start,
            filter(false, true, false),
            32,
        )
        .await
        .unwrap();
    assert!(hidden.sessions.is_empty());
    assert_eq!(hidden.pending_session_count, 0);
    let foreign = catalog
        .page(
            CatalogScope::Session("own-foreign-owner".into()),
            None,
            Position::Start,
            normal.clone(),
            32,
        )
        .await
        .unwrap();
    assert_eq!(
        foreign.sessions.len(),
        1,
        "Root metadata remains readable; foreign Agent evidence does not"
    );
    assert_eq!(foreign.pending_session_count, 0);
    assert!(foreign.sessions[0].status.latest.is_none());
    assert!(
        foreign.sessions[0]
            .status
            .pending_interaction_since
            .is_none()
    );
    let mut foreign_owner = support::owner();
    foreign_owner.deployment = uuid::Uuid::from_u128(999);
    let foreign_catalog =
        SessionCatalog::new(root.data_writer().unwrap(), foreign_owner, "own-".into()).unwrap();
    let foreign_own_view = foreign_catalog
        .page(
            CatalogScope::Session("own-foreign-owner".into()),
            None,
            Position::Start,
            normal.clone(),
            32,
        )
        .await
        .unwrap();
    assert_eq!(foreign_own_view.pending_session_count, 1);
    assert_eq!(
        foreign_own_view.sessions[0]
            .status
            .pending_interaction_since,
        Some(200)
    );
    assert!(
        matches!(catalog.page(CatalogScope::Session("other-child".into()), None, Position::Start, normal.clone(), 32).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "foreign catalog session")
    );

    let before_answer = catalog
        .page(all.clone(), None, Position::Start, normal.clone(), 32)
        .await
        .unwrap();
    state
        .interactions()
        .commit_outcome(
            "own-child",
            &first.request_id,
            InteractionOutcome::Closure {
                reason: ClosureReason::ProducerCancelled,
                committed_at: 300,
            },
        )
        .await
        .unwrap();
    let one_left = catalog
        .page(all.clone(), None, Position::Start, normal.clone(), 32)
        .await
        .unwrap();
    assert_eq!(one_left.pending_session_count, 2);
    assert_eq!(
        state
            .interactions()
            .pending("own-child")
            .await
            .unwrap()
            .records
            .len(),
        1
    );
    assert!(
        matches!(catalog.page(all.clone(), Some(before_answer.revision.clone()), Position::Start, normal.clone(), 32).await,
        Err(StoreError::RevisionConflict { expected, actual }) if expected == before_answer.revision && actual == one_left.revision)
    );
    state
        .interactions()
        .commit_outcome(
            "own-child",
            &second.request_id,
            InteractionOutcome::QuestionAnswer {
                answers: vec![Some("Continue".into())],
                committed_at: 301,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        catalog
            .page(all.clone(), None, Position::Start, normal.clone(), 32)
            .await
            .unwrap()
            .pending_session_count,
        1
    );
    let restored = ContentBlob::json(&json!({"originalAuthorityObservation":"available"})).unwrap();
    support::append(
        &state,
        runs["own-blocked"],
        vec![Fact::BlockerResolved {
            blocker,
            evidence: restored.reference().clone(),
        }],
        vec![restored],
    )
    .await;
    let settled = catalog
        .page(
            all.clone(),
            None,
            Position::Start,
            filter(true, false, false),
            32,
        )
        .await
        .unwrap();
    assert_eq!(settled.pending_session_count, 0);
    assert_eq!(settled.sessions[0].metadata.id, "own-blocked");
    let root_metadata = root
        .get_session::<serde_json::Value>("own-root")
        .await
        .unwrap()
        .unwrap();
    let (spec, contents) = support::spec("own-root", "recent-message", "new actual user input");
    state
        .admit(Admission::new(spec, UnixMillis(1_000), contents))
        .await
        .unwrap();
    let recent = catalog
        .page(
            all.clone(),
            None,
            Position::Start,
            filter(true, false, false),
            32,
        )
        .await
        .unwrap();
    assert_eq!(recent.sessions[0].metadata.id, "own-root");
    assert_eq!(recent.sessions[0].metadata.updated_at, 1_000);
    assert_eq!(
        recent.sessions[0].control_revision, 0,
        "actual message activity does not require a presentation control write"
    );
    assert_eq!(
        root.get_session::<serde_json::Value>("own-root")
            .await
            .unwrap(),
        Some(root_metadata)
    );
    assert!(
        matches!(catalog.page(all, Some(settled.revision.clone()), Position::Start, filter(true, false, false), 32).await,
        Err(StoreError::RevisionConflict { expected, actual }) if expected == settled.revision && actual == recent.revision)
    );
    root.close().await.unwrap();
}
