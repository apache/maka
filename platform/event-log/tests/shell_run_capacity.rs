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

use maka_agent_facts::{
    shell_run::{
        Sandbox, ShellOutcome, ShellOutput, ShellPatch, ShellPermissions, ShellRun, ShellState,
        ShellVisibility,
    },
    terminal::{
        TerminalScreen, TerminalSize,
        display::{Color, Display, Run, Style},
    },
};
use maka_event_log::EventLog;
use serde_json::json;
use std::sync::Arc;

use maka_agent_facts::workspace::PermissionBasis;
#[path = "support/shell_binding.rs"]
mod binding;

fn record(basis: PermissionBasis, output: ShellOutput) -> ShellRun {
    ShellRun {
        id: "large".into(),
        session_id: "session".into(),
        source_run_id: None,
        source_turn_id: "turn".into(),
        source_tool_call_id: "call".into(),
        visibility: ShellVisibility::User,
        permissions: ShellPermissions {
            basis,
            sandbox: Sandbox::Disabled,
        },
        cwd: "/workspace".into(),
        command: "command".into(),
        started_at: 1,
        updated_at: 1,
        timeout_ms: None,
        revision: 1,
        state: ShellState::Starting,
        output,
    }
}

#[tokio::test]
async fn styled_display_above_old_record_limit_survives_recovery_observation_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let basis = binding::create(&log, "session", "/workspace").await;
    let mut display = Display::new(TerminalSize::new(80, 24).unwrap());
    let row = (0..80)
        .map(|n| Run {
            style: Style {
                foreground: Color::Rgb([n, 127, 255]),
                background: Color::Indexed(n),
                flags: 2,
                underline: Some(Color::Named(1)),
            },
            text: "色".into(),
            lengths: Vec::new(),
        })
        .collect::<Vec<_>>();
    display.scrollback = vec![row; 600];
    let record = record(
        basis,
        ShellOutput::Pty {
            screen: Arc::new(display),
        },
    );
    assert!(serde_json::to_vec(&record).unwrap().len() > 4 * 1024 * 1024);
    log.create_shell_run(record.clone()).await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let latest = 9_007_199_254_740_991;
    assert_eq!(log.recover_shell_runs(latest).await.unwrap(), 1);
    let orphan = log
        .read_shell_run("session", "large")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(orphan.output, record.output);
    assert!(matches!(
        orphan.state,
        ShellState::Terminal {
            outcome: ShellOutcome::Orphaned { .. },
            ..
        }
    ));
    let observed = log
        .patch_shell_run(
            "session",
            "large",
            ShellPatch {
                observed_at: Some(latest),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        matches!(observed.state, ShellState::Terminal { observed_at: Some(at), .. } if at == latest)
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.read_shell_run("session", "large").await.unwrap(),
        Some(observed)
    );
    assert_eq!(log.recover_shell_runs(latest).await.unwrap(), 0);
    log.close().await.unwrap();
}

#[tokio::test]
async fn old_terminal_text_migrates_once_preserving_identity_pipes_unicode_and_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let basis = binding::create(&log, "session", "/workspace").await;
    let pipe = record(
        basis,
        ShellOutput::Pipes {
            stdout: "untouched\u{1b}[31m".into(),
            stderr: String::new(),
            latest_stream: None,
            stdout_truncated: false,
            stderr_truncated: false,
        },
    );
    log.create_shell_run(pipe.clone()).await.unwrap();
    log.close().await.unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let pipe_raw: String = connection
        .query_row("SELECT record_json FROM shell_runs", [], |r| r.get(0))
        .unwrap();
    let mut old = TerminalScreen::new(TerminalSize::new(8, 2).unwrap());
    old.screen = "中e\u{301}\nfinal".into();
    old.scrollback = "abcdefghijklmnopqr\nolder".into();
    old.last_alternate_screen = Some("alternate before resize\nrow2\nrow3".into());
    let mut raw = serde_json::to_value(&pipe).unwrap();
    raw["id"] = json!("old-pty");
    raw["output"] = json!({"mode":"pty", "screen":old});
    // Recreate the last released shell table and ledger cut, retaining all
    // earlier migration checksums and the real Session foreign key.
    let original = include_str!("../migrations/0001_runtime.sql");
    let original = &original[original.find("CREATE TABLE shell_runs (").unwrap()
        ..original.find("CREATE TABLE message_admissions").unwrap()];
    connection.execute_batch("ALTER TABLE shell_runs RENAME TO saved_shell_runs; DROP INDEX shell_runs_session_order; DROP INDEX shell_runs_active;").unwrap();
    connection.execute_batch(original).unwrap();
    connection.execute_batch("INSERT INTO shell_runs SELECT * FROM saved_shell_runs; DROP TABLE saved_shell_runs; DELETE FROM _sqlx_migrations WHERE version = 35;").unwrap();
    connection
        .execute(
            "INSERT INTO shell_runs VALUES ('session','old-pty',1,1,?)",
            [raw.to_string()],
        )
        .unwrap();
    drop(connection);
    let log = EventLog::open(&path).await.unwrap();
    let migrated = log
        .read_shell_run("session", "old-pty")
        .await
        .unwrap()
        .unwrap();
    let ShellOutput::Pty { screen } = &migrated.output else {
        panic!()
    };
    assert_eq!(screen.text(50 * 1024).screen, "中e\u{301}\nfinal");
    assert_eq!(
        screen.text(50 * 1024).scrollback,
        "abcdefghijklmnopqr\nolder"
    );
    assert_eq!(
        screen.text(50 * 1024).last_alternate_screen.as_deref(),
        Some("alternate before resize\nrow2\nrow3")
    );
    assert!(screen.metadata.truncated);
    assert_eq!(migrated.revision, 1);
    assert_eq!(migrated.permissions, pipe.permissions);
    assert!(migrated.state.active());
    log.close().await.unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let pipe_after: String = connection
        .query_row(
            "SELECT record_json FROM shell_runs WHERE id='large'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pipe_after, pipe_raw);
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    drop(connection);
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.read_shell_run("session", "old-pty").await.unwrap(),
        Some(migrated.clone())
    );
    assert_eq!(log.recover_shell_runs(100).await.unwrap(), 2);
    assert_eq!(
        log.read_shell_run("session", "old-pty")
            .await
            .unwrap()
            .unwrap()
            .output,
        migrated.output
    );
    log.close().await.unwrap();
}
