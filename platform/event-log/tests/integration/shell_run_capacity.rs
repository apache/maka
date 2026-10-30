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
        TerminalSize,
        display::{Color, Display, Run, Style},
    },
};
use maka_event_log::EventLog;
use std::sync::Arc;

use crate::support::shell_binding as binding;
use maka_agent_facts::workspace::PermissionBasis;

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
