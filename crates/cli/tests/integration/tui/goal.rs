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
use serde_json::json;

/// The Goal lives beside its session: its panel arms a Goal after explicit
/// consent, and its status line appears above the composer, without a
/// model turn.
#[test]
fn goal_panel_arms_after_consent_and_shows_its_status_above_the_composer() {
    let directory = tempfile::tempdir().unwrap();
    let mut host = super::super::candidate::CandidateFixture::new(directory.path().join("root"));
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
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (client, listener) = runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = support::model_client(
            &host.root,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        )
        .await;
        client
            .create_session(
                maka_protocol::session::decode_session_create_input(&json!({
                    "sessionId":"goal-source", "name":"Goal source",
                    "workspace":{"kind":"host_path","path":directory.path()},
                    "sandboxMode":"read-only", "modelTarget":{"kind":"default"}
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        (client, listener)
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.resize(170, 40);
    tui.wait_for("Goal source");
    tui.click_text("Goal source");
    // Panels stay put away until asked for.
    tui.wait_for("◨");
    tui.click_text("◨");
    tui.wait_for("Give this session an objective");
    tui.click_page_text("Objective");
    tui.send(b"\x1b[200~Ship the inspector\x1b[201~");
    tui.wait_for("Ship the inspector");
    tui.click_page_text("Save for later");
    tui.wait_for("Allow plugin access?");
    tui.click_text("Allow and continue");
    tui.wait_until(|screen| screen.contains("Ready to start") && screen.contains("Start"));
    // The status line says the same, one line above the composer.
    tui.wait_until(|screen| {
        screen
            .lines()
            .any(|line| line.contains("◎ Ship the inspector") && line.contains("0/10"))
    });
    tui.close_terminal();
    tui.finish();
    runtime.block_on(async {
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "arming a Goal for later must not call a model"
        );
    });
    client.disconnect();
}
