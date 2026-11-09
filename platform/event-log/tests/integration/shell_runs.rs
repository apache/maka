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

use maka_event_log::{EventLog, StoreError};
use maka_plugin_core::shell_run::ShellOutcome;
use maka_plugin_core::shell_run::ShellOutput;
use maka_plugin_core::shell_run::ShellPatch;
use maka_plugin_core::shell_run::ShellRun;
use maka_plugin_core::shell_run::ShellState;
use maka_plugin_core::shell_run::ShellVisibility;
use serde_json::json;

use crate::support::shell_binding as binding;
use maka_sandbox::workspace::PermissionBasis;

fn starting(id: &str, basis: PermissionBasis) -> ShellRun {
    ShellRun {
        id: id.into(),
        session_id: "session".into(),
        source_work_id: None,
        correlation: json!({"fixture":"shell-lifecycle"}),
        visibility: ShellVisibility::Model,
        permissions: maka_plugin_core::shell_run::ShellPermissions {
            basis,
            sandbox: maka_plugin_core::shell_run::Sandbox::Disabled,
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
        log.get_session::<serde_json::Value>("session")
            .await
            .unwrap()
            .unwrap()
            .revision,
        1,
        "resource control must not rewrite Session control metadata"
    );
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    let before = log.query_shell_resources("session", None, 0).await.unwrap();
    assert_eq!(before.total, 3);
    assert!(!before.resources.iter().any(|resource| matches!(
        resource.state,
        ShellState::Terminal {
            outcome: ShellOutcome::Orphaned { .. },
            ..
        }
    )));
    assert_eq!(log.recover_shell_runs(50).await.unwrap(), 2);
    let after = log.query_shell_resources("session", None, 0).await.unwrap();
    assert_eq!(after.total, before.total);
    assert!(
        after.resources.iter().any(|resource| matches!(
            resource.state,
            ShellState::Terminal {
                outcome: ShellOutcome::Orphaned { .. },
                ..
            }
        )) && log.has_unsettled_shells("session").await.unwrap(),
        "unknown cleanup is not a transient busy workspace"
    );
    assert_ne!(before.revision, after.revision);
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
    let observer = rusqlite::Connection::open(&path).unwrap();
    observer
        .execute_batch(
            "CREATE TRIGGER reject_second_recovery BEFORE UPDATE ON shell_runs
        WHEN EXISTS (SELECT 1 FROM shell_runs WHERE active = 0)
        BEGIN SELECT RAISE(ABORT, 'injected recovery fault'); END;",
        )
        .unwrap();
    assert!(log.recover_shell_runs(50).await.is_err());
    for id in ["a", "b"] {
        assert_eq!(
            log.read_shell_run("session", id).await.unwrap(),
            Some(starting(id, basis)),
            "all recovery writes roll back together"
        );
    }
    observer
        .execute_batch(
            "DROP TRIGGER reject_second_recovery;
        CREATE TRIGGER reject_outcome BEFORE UPDATE ON shell_runs
        BEGIN SELECT RAISE(ABORT, 'injected outcome fault'); END;",
        )
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
    observer
        .execute_batch("DROP TRIGGER reject_outcome")
        .unwrap();
    // A real SQLite writer lock holds the accepted update after its caller
    // disappears. Publication belongs to the SQL owner, not the abandoned await.
    let blocker =
        rusqlite::Transaction::new_unchecked(&observer, rusqlite::TransactionBehavior::Immediate)
            .unwrap();
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
    blocker.commit().unwrap();
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
    observer.close().unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(log.recover_shell_runs(60).await.unwrap(), 2);
    log.close().await.unwrap();
}

#[tokio::test]
async fn shell_admission_fences_the_complete_workspace_basis() {
    use maka_event_log::sessions::SessionMutation;
    use maka_sandbox::workspace::BindingStamp;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("permission-basis.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let original = binding::create(&log, "session", "/original").await;
    log.create_shell_run(starting("already-admitted", original))
        .await
        .unwrap();
    let replacement = log
        .attach_workspace("shell-fixture", &json!({"path":"/replacement"}))
        .await
        .unwrap();
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        log.update_session_metadata::<serde_json::Value, _>(
            "session",
            revision,
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
