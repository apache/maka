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
use maka_event_log::{
    EventLog,
    root::{RootNamespaces, RootOwner},
    sessions::PluginSession,
};
use maka_plugins::{composition::Scope, storage::Namespace};
use maka_protocol::session::{SandboxMode, WorkspaceProjection, WorkspaceTarget};
use maka_runtime::import::{Content, Record, Source};
use maka_runtime_host::session::{PreparedSession, SessionTarget};
use serde_json::json;
use std::sync::Arc;

#[test]
fn imported_observations_remain_readable_without_offering_executable_turn_actions() {
    let directory = tempfile::tempdir().unwrap();
    let mut host = super::super::candidate::CandidateFixture::new(directory.path().join("root"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    // Seed through native import admission before starting the Host writer.
    // Plugin authorization is covered by the Host's plugin_commands tests.
    runtime.block_on(async {
        let owner =
            RootOwner::open(&host.root, &RootNamespaces::for_current_account().unwrap()).unwrap();
        let log = EventLog::for_root(Arc::new(owner)).await.unwrap();
        let cwd =
            maka_fs_tools::workspace::project::host_path(&directory.path().canonicalize().unwrap())
                .unwrap()
                .to_owned();
        let configuration = PreparedSession::new(
            serde_json::from_value(json!({
                "sessionId":"imported", "name":"Imported observations",
                "workspace":{"kind":"host_path","path":cwd}, "executorId":"fixture"
            }))
            .unwrap(),
        )
        .unwrap()
        .bind(
            WorkspaceProjection {
                target: WorkspaceTarget::HostPath { path: cwd.clone() },
                host_cwd: cwd,
            },
            SessionTarget::Executor {
                executor_id: "fixture".to_owned().try_into().unwrap(),
                settings: Default::default(),
            },
            SandboxMode::ReadOnly,
        );
        log.begin_session_import(
            &PluginSession {
                session_id: "imported".into(),
                creator: Namespace::new("tui.reader", Scope::Profile).unwrap(),
                fingerprint: "fixture-import".into(),
                managed: false,
                authority_session_id: None,
            },
            &Source {
                adapter: "fixture".into(),
                session_id: "foreign".into(),
            },
            &configuration,
            1,
        )
        .await
        .unwrap();
        let records: Vec<_> = [
            Content::User {
                text: "Original imported question".into(),
            },
            Content::ToolCall {
                call_id: "missing".into(),
                name: "foreign-read".into(),
                input: None,
            },
            Content::ToolCall {
                call_id: "failed".into(),
                name: "foreign-edit".into(),
                input: None,
            },
            Content::ToolResult {
                call_id: "failed".into(),
                output: json!("Original failure details"),
                is_error: true,
            },
            Content::Assistant {
                text: "Original imported answer".into(),
                thinking: Some("Original imported reasoning".into()),
                model: Some("foreign-model".into()),
            },
            Content::Note {
                text: "Source ended without a terminal record.".into(),
            },
        ]
        .into_iter()
        .enumerate()
        .map(|(index, content)| Record {
            source_message_id: format!("record-{index}"),
            source_turn_id: "foreign-turn".into(),
            timestamp: None,
            content,
        })
        .collect();
        let count = records.len() as u64;
        log.append_session_import("imported", 0, records)
            .await
            .unwrap();
        log.publish_session_import("imported", count).await.unwrap();
        log.close().await.unwrap();
    });
    host.child = Some(
        Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(["host", "serve", "--root"])
            .arg(&host.root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    host.wait_for_registration();
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Imported observations");
    tui.click_text("Imported observations");
    tui.wait_for("Original imported answer");
    tui.wait_for("Original imported reasoning");
    tui.wait_for("Source ended without a terminal record.");
    tui.wait_for("foreign-read · No result recorded");
    tui.wait_for("foreign-edit · Tool error · Original failure details");
    for message in ["Original imported question", "Original imported answer"] {
        tui.click_text(message);
        tui.send(b"\x10");
        tui.wait_for("Search commands…");
        tui.send(b"branch from this turn");
        tui.wait_for("No matching commands.");
        assert!(
            !tui.screen
                .snapshot()
                .unwrap()
                .screen
                .contains("Branch from this turn"),
            "imported observations are not local Turn boundaries"
        );
        tui.send(b"\x1b");
        tui.wait_until(|screen| !screen.contains("No matching commands."));
    }
    tui.close_terminal();
    tui.finish();
    host.retire_registered();
}
