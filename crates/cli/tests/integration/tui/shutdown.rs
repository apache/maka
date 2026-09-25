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

use super::super::candidate::CandidateFixture;
use super::*;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_protocol::{Operation, session::decode_session_create_input};
use serde_json::json;

fn serve(host: &mut CandidateFixture) {
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
}

#[test]
fn force_quit_cancels_active_turn_and_preserves_history_and_unsent_draft() {
    let directory = tempfile::tempdir().unwrap();
    let mut host = CandidateFixture::new(directory.path().join("root"));
    serve(&mut host);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (url, _finish, model) = runtime.block_on(streaming_model(directory.path().join("unused")));
    let client = runtime.block_on(async {
        let client = support::model_client(&host.root, &url).await;
        client
            .create_session(
                decode_session_create_input(&json!({
                    "sessionId":"exit-session", "name":"Shutdown fixture",
                    "workspace":{"kind":"host_path","path":directory.path()},
                    "sandboxMode":"read-only", "modelTarget":{"kind":"default"}
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        client
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Shutdown fixture");
    tui.click_text("Shutdown fixture");
    tui.wait_for("Message…");
    tui.send("草稿 first\r".as_bytes());
    tui.wait_for("Streamed 中文🦀");
    let turn = runtime.block_on(async {
        let snapshot = client
            .open_subscription(maka_protocol::subscription::SubscriptionOpenInput {
                session_id: "exit-session".into(),
                transcript: maka_protocol::subscription::TranscriptPolicy::None,
            })
            .await
            .unwrap();
        client
            .close_subscription(&snapshot.subscription_id)
            .await
            .unwrap();
        snapshot.snapshot.root_turn.unwrap()
    });
    assert!(matches!(
        turn.state,
        maka_protocol::turn::TurnState::Running(_)
    ));
    // No other client remains: the active turn itself must block safe shutdown.
    client.disconnect();
    runtime.block_on(client.closed());
    tui.click_text("Message…");
    tui.send("unsent 中文🦀".as_bytes());
    tui.wait_for("unsent 中文🦀");
    tui.send(b"\x11");
    tui.wait_for("Force quit");
    tui.send(b"\x1b[<0;1;1M\x1b[<0;1;1m");
    tui.wait_until(|screen| !screen.contains("Force quit"));
    tui.wait_for("■");
    tui.send(b"\x11");
    tui.wait_for("Force quit");
    tui.click_text("Force quit");
    tui.finish();
    assert!(host.wait_for_exit().success());
    let owner =
        RootOwner::open(&host.root, &RootNamespaces::for_current_account().unwrap()).unwrap();
    owner.validate_current().unwrap();
    drop(owner);
    model.abort();
    assert!(runtime.block_on(model).unwrap_err().is_cancelled());

    serve(&mut host);
    let client = runtime.block_on(support::client(&host.root));
    let saved = runtime
        .block_on(client.request(
            Operation::TurnQuery,
            json!({"sessionId":turn.session_id,"turnId":turn.turn_id}),
        ))
        .unwrap();
    assert_eq!(saved["status"], "cancelled");
    assert_eq!(saved["runId"], turn.run_id);
    let mut reopened = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    reopened.wait_for("unsent 中文🦀");
    reopened.wait_for("Streamed 中文🦀");
    reopened.filter_command("Close interface only");
    reopened.click_text("Close interface only");
    reopened.finish();
    assert!(
        runtime
            .block_on(client.session("exit-session"))
            .unwrap()
            .is_some()
    );
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

#[test]
fn force_confirmation_never_retargets_a_replacement_host() {
    let directory = tempfile::tempdir().unwrap();
    let mut host = CandidateFixture::new(directory.path().join("root"));
    serve(&mut host);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let observer = runtime.block_on(support::client(&host.root));
    let original_epoch = observer.identity.host_epoch.clone();
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("No sessions yet");
    tui.host_details();
    tui.wait_for("State: ready");
    tui.send(b"\x11");
    tui.wait_for("Force quit");
    runtime
        .block_on(observer.request(
            Operation::HostUpgradePrepare,
            json!({
                "expectedHostEpoch": original_epoch,
                "allowInterruptActiveTasks": true,
                "allowCooperativeHandoff": false
            }),
        ))
        .unwrap();
    assert!(host.wait_for_exit().success());
    serve(&mut host);
    let replacement = runtime.block_on(support::client(&host.root));
    assert_ne!(replacement.identity.host_epoch, original_epoch);
    tui.click_text("Force quit");
    tui.wait_for("Could not confirm that the Host stopped.");
    assert!(!tui.screen.snapshot().unwrap().screen.contains("Force quit"));
    runtime
        .block_on(replacement.request(Operation::HostStatus, json!({})))
        .unwrap();
    tui.click_text("Close interface only");
    tui.finish();
    runtime
        .block_on(replacement.request(Operation::HostStatus, json!({})))
        .unwrap();
    replacement.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}
