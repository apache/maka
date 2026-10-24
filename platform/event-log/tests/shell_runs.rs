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

use maka_agent_facts::shell_run::ShellOutcome;
use maka_agent_facts::shell_run::ShellOutput;
use maka_agent_facts::shell_run::ShellPatch;
use maka_agent_facts::shell_run::ShellRun;
use maka_agent_facts::shell_run::ShellState;
use maka_agent_facts::shell_run::ShellVisibility;
use maka_event_log::{EventLog, StoreError};
use serde_json::json;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

use maka_agent_facts::workspace::PermissionBasis;
#[path = "support/shell_binding.rs"]
mod binding;

fn starting(id: &str, basis: PermissionBasis) -> ShellRun {
    ShellRun {
        id: id.into(),
        session_id: "session".into(),
        source_run_id: Some("run".into()),
        source_turn_id: "turn".into(),
        source_tool_call_id: "call".into(),
        visibility: ShellVisibility::Model,
        permissions: maka_agent_facts::shell_run::ShellPermissions {
            basis,
            sandbox: maka_agent_facts::shell_run::Sandbox::Disabled,
        },
        cwd: "/captured/workspace".into(),
        command: "command".into(),
        started_at: 10,
        updated_at: 10,
        timeout_ms: None,
        revision: 1,
        state: ShellState::Starting,
        output: output(""),
    }
}

fn output(text: &str) -> ShellOutput {
    ShellOutput::Pipes {
        stdout: text.into(),
        stderr: String::new(),
        latest_stream: None,
        stdout_truncated: false,
        stderr_truncated: false,
    }
}

fn state(state: ShellState) -> ShellPatch {
    ShellPatch {
        state: Some(state),
        ..Default::default()
    }
}

fn terminal(outcome: ShellOutcome) -> ShellState {
    ShellState::Terminal {
        completed_at: 20,
        outcome,
        observed_at: None,
    }
}

#[tokio::test]
async fn durable_lifecycle_keeps_terminal_output_mutable_and_never_reattaches_on_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let basis = binding::create(&log, "session", "/captured/workspace").await;
    let record = starting("finished", basis);
    let mut changes = log.subscribe_shell_changes();
    let mut session_changes = log.subscribe_session_commits("session");
    let foreign_changes = log.subscribe_session_commits("foreign");
    assert_eq!(log.create_shell_run(record.clone()).await.unwrap(), record);
    assert!(session_changes.has_changed().unwrap());
    session_changes.borrow_and_update();
    assert!(!foreign_changes.has_changed().unwrap());
    let change = changes.try_recv().unwrap();
    assert_eq!((&*change.session_id, &*change.id), ("session", "finished"));
    assert_eq!(
        log.read_shell_run(&change.session_id, &change.id)
            .await
            .unwrap(),
        Some(record.clone())
    );
    assert!(matches!(
        log.create_shell_run(record.clone()).await,
        Err(StoreError::ShellConflict)
    ));
    assert!(
        log.read_shell_run("other", "finished")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        log.patch_shell_run(
            "session",
            "finished",
            state(terminal(ShellOutcome::Completed))
        )
        .await
        .is_err(),
        "starting cannot claim a completed process"
    );
    assert!(!session_changes.has_changed().unwrap());
    let running = log
        .patch_shell_run("session", "finished", state(ShellState::Running))
        .await
        .unwrap();
    assert_eq!(running.revision, 2);
    assert!(session_changes.has_changed().unwrap());
    assert!(!foreign_changes.has_changed().unwrap());
    assert_eq!(changes.try_recv().unwrap(), change);
    assert!(
        matches!(
            changes.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "conflicts and rejected transitions publish no invalidations"
    );
    assert!(
        log.patch_shell_run(
            "session",
            "finished",
            ShellPatch {
                observed_at: Some(19),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );

    let finished = log
        .patch_shell_run(
            "session",
            "finished",
            ShellPatch {
                state: Some(terminal(ShellOutcome::Completed)),
                output: Some(output("first frame")),
                updated_at: Some(20),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(finished.revision, 3);
    let flushed = log
        .patch_shell_run(
            "session",
            "finished",
            ShellPatch {
                output: Some(output("first frame\nfinal frame 中文")),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(flushed.revision, 4);
    assert_eq!(flushed.state, finished.state);
    assert!(
        log.patch_shell_run(
            "session",
            "finished",
            state(terminal(ShellOutcome::Cancelled { message: None }))
        )
        .await
        .is_err()
    );
    assert!(
        log.patch_shell_run("session", "finished", state(ShellState::Running))
            .await
            .is_err()
    );
    let observed = log
        .patch_shell_run(
            "session",
            "finished",
            ShellPatch {
                observed_at: Some(30),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(observed.revision, 5);
    while changes.try_recv().is_ok() {}
    assert_eq!(
        log.patch_shell_run(
            "session",
            "finished",
            ShellPatch {
                observed_at: Some(40),
                ..Default::default()
            }
        )
        .await
        .unwrap(),
        observed
    );
    assert!(
        matches!(
            changes.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "an unchanged observation publishes no new revision"
    );

    for id in ["unspawned", "lost"] {
        log.create_shell_run(starting(id, basis)).await.unwrap();
    }
    log.patch_shell_run("session", "lost", state(ShellState::Running))
        .await
        .unwrap();
    assert_eq!(
        log.prefix(1, 1024).await.unwrap().high_water,
        0,
        "resource control is not fabricated invocation history"
    );
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    let before = log.workspace_fence("/captured/workspace").await.unwrap();
    assert_eq!(before.0.len(), 1);
    assert!(!before.0[0].orphaned_shells);
    assert_eq!(log.recover_shell_runs(50).await.unwrap(), 2);
    let after = log.workspace_fence("/captured/workspace").await.unwrap();
    assert!(
        after.0[0].orphaned_shells,
        "unknown cleanup is not a transient busy workspace"
    );
    assert_ne!(before, after);
    assert_eq!(log.recover_shell_runs(60).await.unwrap(), 0);
    assert_eq!(
        log.read_shell_run("session", "finished").await.unwrap(),
        Some(observed)
    );
    for (id, revision) in [("unspawned", 2), ("lost", 3)] {
        let orphaned = log.read_shell_run("session", id).await.unwrap().unwrap();
        assert_eq!(orphaned.revision, revision);
        assert_eq!(orphaned.updated_at, 50);
        assert!(matches!(
            orphaned.state,
            ShellState::Terminal {
                completed_at: 50,
                outcome: ShellOutcome::Orphaned { .. },
                observed_at: None
            }
        ));
        assert_eq!(orphaned.output, output(""));
        assert!(
            log.patch_shell_run("session", id, state(ShellState::Running))
                .await
                .is_err()
        );
    }
    log.close().await.unwrap();
}

#[tokio::test]
async fn recovery_commit_is_atomic_under_real_sqlite_faults() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let basis = binding::create(&log, "session", "/captured/workspace").await;
    for id in ["a", "b"] {
        log.create_shell_run(starting(id, basis)).await.unwrap();
    }
    let mut observer = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TRIGGER reject_second_recovery BEFORE UPDATE ON shell_runs
        WHEN EXISTS (SELECT 1 FROM shell_runs WHERE active = 0)
        BEGIN SELECT RAISE(ABORT, 'injected recovery fault'); END;",
    )
    .execute(&mut observer)
    .await
    .unwrap();
    assert!(log.recover_shell_runs(50).await.is_err());
    for id in ["a", "b"] {
        assert_eq!(
            log.read_shell_run("session", id).await.unwrap(),
            Some(starting(id, basis)),
            "all recovery writes roll back together"
        );
    }
    sqlx::raw_sql(
        "DROP TRIGGER reject_second_recovery;
        CREATE TRIGGER reject_outcome BEFORE UPDATE ON shell_runs
        BEGIN SELECT RAISE(ABORT, 'injected outcome fault'); END;",
    )
    .execute(&mut observer)
    .await
    .unwrap();
    let mut changes = log.subscribe_shell_changes();
    assert!(
        log.patch_shell_run("session", "a", state(ShellState::Running))
            .await
            .is_err()
    );
    assert_eq!(
        log.read_shell_run("session", "a").await.unwrap(),
        Some(starting("a", basis))
    );
    assert!(
        matches!(
            changes.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "rolled-back writes publish no invalidations"
    );
    sqlx::raw_sql("DROP TRIGGER reject_outcome")
        .execute(&mut observer)
        .await
        .unwrap();
    // A real SQLite writer lock holds the accepted update after its caller
    // disappears. Publication belongs to the SQL owner, not the abandoned await.
    let blocker = observer.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let mut update = Box::pin(log.patch_shell_run("session", "a", state(ShellState::Running)));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut update)
            .await
            .is_err()
    );
    assert!(matches!(
        changes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    drop(update);
    blocker.commit().await.unwrap();
    let change = tokio::time::timeout(std::time::Duration::from_secs(5), changes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!((&*change.session_id, &*change.id), ("session", "a"));
    assert_eq!(
        log.read_shell_run("session", "a")
            .await
            .unwrap()
            .unwrap()
            .state,
        ShellState::Running
    );
    observer.close().await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(log.recover_shell_runs(60).await.unwrap(), 2);
    log.close().await.unwrap();
}

#[tokio::test]
async fn read_prefixes_exclude_user_only_and_foreign_tasks_and_prefer_exact_ids() {
    use maka_agent_facts::read::ResourceAddress::Task;
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("prefix.sqlite"))
        .await
        .unwrap();
    let basis = binding::create(&log, "session", "/captured/workspace").await;
    assert_eq!(
        basis,
        binding::create(&log, "other", "/captured/workspace").await
    );
    for id in ["task_a", "task_ab"] {
        log.create_shell_run(starting(id, basis)).await.unwrap();
    }
    let mut hidden = starting("task_hidden", basis);
    hidden.visibility = ShellVisibility::User;
    log.create_shell_run(hidden).await.unwrap();
    let mut foreign = starting("task_foreign", basis);
    foreign.session_id = "other".into();
    log.create_shell_run(foreign).await.unwrap();
    assert_eq!(
        log.resolve_read_resource("session", Task("task_a".into()))
            .await
            .unwrap(),
        Some(Task("task_a".into()))
    );
    assert!(matches!(
        log.resolve_read_resource("session", Task("task_".into()))
            .await,
        Err(StoreError::AmbiguousReadResource)
    ));
    for prefix in ["task_h", "task_f", "TASK_A"] {
        assert!(
            log.resolve_read_resource("session", Task(prefix.into()))
                .await
                .unwrap()
                .is_none()
        );
    }
    assert_eq!(
        log.resolve_read_resource("other", Task("task_".into()))
            .await
            .unwrap(),
        Some(Task("task_foreign".into()))
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn provider_catalog_filters_before_count_pagination_and_digest() {
    let dir = tempfile::tempdir().unwrap();
    let log = EventLog::open(&dir.path().join("catalog.sqlite"))
        .await
        .unwrap();
    let basis = binding::create(&log, "session", "/captured/workspace").await;
    for prefix in ["a_other_", "z_owner_"] {
        for index in 0..70 {
            let id = format!("{prefix}{index:03}");
            let record = starting(&id, basis);
            log.create_shell_run(record).await.unwrap();
            log.patch_shell_run(
                "session",
                &id,
                state(terminal(ShellOutcome::Failed {
                    message: "fixture".into(),
                })),
            )
            .await
            .unwrap();
        }
    }
    log.create_shell_run(starting("zXownerX000", basis))
        .await
        .unwrap();
    let page = log
        .query_shell_catalog("session", "z_owner_", 0)
        .await
        .unwrap();
    assert_eq!(page.total, 70);
    assert_eq!(page.resources.len(), 64);
    assert_eq!(page.next_offset, Some(64));
    assert!(
        page.resources
            .iter()
            .all(|r| r.result.output.is_none() && r.result.resource_ref.contains("z_owner_"))
    );
    let last = log
        .query_shell_catalog("session", "z_owner_", 64)
        .await
        .unwrap();
    assert_eq!(last.resources.len(), 6);
    assert_eq!(last.total, 70);
    assert_eq!(last.revision, page.revision);
    assert_eq!(last.next_offset, None);
    log.patch_shell_run(
        "session",
        "a_other_000",
        ShellPatch {
            output: Some(output("unrelated")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        log.query_shell_catalog("session", "z_owner_", 0)
            .await
            .unwrap()
            .revision,
        page.revision
    );
    assert!(
        log.query_shell_catalog("session", "z_owner_%", 0)
            .await
            .is_err()
    );
    assert!(log.query_shell_catalog("session", "", 0).await.is_err());
}

#[tokio::test]
async fn soft_first_shell_resource_keeps_complete_identity_and_offset() {
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("singleton.sqlite"))
        .await
        .unwrap();
    let basis = binding::create(&log, "session", "/captured/workspace").await;
    let identity = "original-turn-".repeat(6000);
    let mut first = starting("a_first", basis);
    first.source_turn_id = identity.clone();
    log.create_shell_run(first).await.unwrap();
    log.create_shell_run(starting("b_second", basis))
        .await
        .unwrap();
    let page = log.query_shell_catalog("session", "a_", 0).await;
    let all = log.query_shell_resources("session", None, 0).await;
    let tail = log.query_shell_resources("session", None, 1).await;
    let foreign = log.query_shell_resources("missing", None, 0).await;
    log.close().await.unwrap();
    let page = page.expect("first complete catalog resource must progress");
    assert_eq!(page.resources.len(), 1);
    assert!(page.resources[0].source_turn_id == identity);
    assert_eq!(page.total, 1);
    assert_eq!(page.next_offset, None);
    let all = all.expect("first complete resource must progress");
    assert_eq!(all.resources.len(), 1);
    assert!(all.resources[0].source_turn_id == identity);
    assert_eq!(all.total, 2);
    assert_eq!(all.next_offset, Some(1));
    let tail = tail.unwrap();
    assert_eq!(tail.resources.len(), 1);
    assert_eq!(tail.resources[0].source_turn_id, "turn");
    assert_eq!(tail.revision, all.revision);
    assert_eq!(tail.next_offset, None);
    assert!(matches!(foreign, Err(StoreError::SessionNotFound)));
}

#[tokio::test]
async fn shell_and_protocol_admission_fence_the_complete_workspace_basis() {
    use maka_agent_facts::event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent};
    use maka_agent_facts::workspace::BindingStamp;
    use maka_event_log::sessions::SessionMutation;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("permission-basis.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let original = binding::create(&log, "session", "/original").await;
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: "work".into(),
                    request_fingerprint: None,
                    source_messages: vec![],
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    log.create_shell_run(starting("already-admitted", original))
        .await
        .unwrap();
    let replacement = log
        .attach_workspace("shell-fixture", &json!({"path":"/replacement"}))
        .await
        .unwrap();
    let revision = log.get_session::<serde_json::Value>("session").await.unwrap().unwrap().revision;
    assert!(matches!(
        log.update_session_permissions::<serde_json::Value, _>(
            "session",
            revision,
            2,
            move |configuration| {
                configuration["workspace"] = serde_json::to_value(replacement).unwrap();
                Ok(())
            }
        )
        .await
        .unwrap(),
        SessionMutation::Committed(_)
    ));
    let current = PermissionBasis {
        boundary_revision: original.boundary_revision,
        binding: BindingStamp {
            id: replacement.id,
            permission_epoch: replacement.permission_epoch_at_attach,
        },
    };
    assert_ne!(current.binding.id, original.binding.id);
    // Both revisions can be numerically identical after attaching another binding.
    assert_eq!(current.boundary_revision, original.boundary_revision);
    assert_eq!(
        current.binding.permission_epoch,
        original.binding.permission_epoch
    );
    for stale in [
        original,
        PermissionBasis {
            binding: BindingStamp {
                permission_epoch: 1,
                ..current.binding
            },
            ..current
        },
    ] {
        let id = uuid::Uuid::new_v4();
        assert!(
            log.create_shell_run(starting(&id.to_string(), stale))
                .await
                .is_err()
        );
        assert!(
            log.admit_session_process_for(&invocation, id, &stale)
                .await
                .is_err()
        );
    }
    let inspect = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        inspect
            .query_row("SELECT count(*) FROM session_processes", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        inspect
            .query_row("SELECT count(*) FROM shell_runs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(inspect);
    log.create_shell_run(starting("current", current))
        .await
        .unwrap();
    let protocol = uuid::Uuid::new_v4();
    log.admit_session_process_for(&invocation, protocol, &current)
        .await
        .unwrap();
    log.clean_session_process(protocol).await.unwrap();
    // Withdrawal of launch authority must not rewrite history or prevent cleanup.
    let settled = log
        .patch_shell_run(
            "session",
            "already-admitted",
            state(terminal(ShellOutcome::Failed {
                message: "settled".into(),
            })),
        )
        .await
        .unwrap();
    assert_eq!(settled.permissions.basis, original);
    log.close().await.unwrap();
}
