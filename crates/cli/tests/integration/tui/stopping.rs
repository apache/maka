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
use maka_protocol::{Operation, session::decode_session_create_input};
use serde_json::json;

#[test]
fn composer_stop_cancels_the_observed_run_and_keeps_unsent_text() {
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
    let (model_url, _finish, model_task) =
        runtime.block_on(streaming_model(directory.path().join("unused")));
    let client = runtime.block_on(async {
        let client = support::model_client(&host.root, &model_url).await;
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"stop-session","name":"Stop fixture session",
            "workspace":{"kind":"host_path","path":directory.path()},"sandboxMode":"read-only",
            "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        client
    });
    let mut tui = Pty::spawn_at(
        &["--root", host.root.to_str().unwrap()],
        Some(directory.path()),
    );
    tui.wait_for("Stop fixture session");
    tui.click_text("Stop fixture session");
    tui.wait_for("Message…");
    tui.send("草稿 first\r".as_bytes());
    tui.wait_for("Streamed 中文🦀");
    tui.wait_for("■");
    let running = runtime.block_on(async {
        client
            .open_subscription(maka_protocol::subscription::SubscriptionOpenInput {
                session_id: "stop-session".into(),
                transcript: maka_protocol::subscription::TranscriptPolicy::None,
            })
            .await
            .unwrap()
    });
    let turn = running.snapshot.root_turn.unwrap();
    assert!(matches!(
        turn.state,
        maka_protocol::turn::TurnState::Running(_)
    ));
    tui.click_text("Message…");
    tui.send("next unsent 中文🦀".as_bytes());
    tui.wait_for("next unsent 中文🦀");
    let header = tui
        .screen
        .snapshot()
        .unwrap()
        .screen
        .lines()
        .next()
        .unwrap()
        .to_owned();
    tui.wait_until(|screen| {
        let next = screen.lines().next().unwrap_or("");
        next != header
            && next.contains("Stop fixture session")
            && screen.contains("next unsent 中文🦀")
    });
    tui.click_text("■");
    tui.wait_for("➤");
    tui.wait_for("o_o");
    tui.wait_for("next unsent 中文🦀");
    let terminal = runtime
        .block_on(client.request(
            Operation::TurnQuery,
            json!({"sessionId":turn.session_id,"turnId":turn.turn_id}),
        ))
        .unwrap();
    assert_eq!(terminal["runId"], turn.run_id);
    assert_eq!(terminal["status"], "cancelled");
    assert_eq!(terminal["abortSource"], "runtime_cancellation");
    runtime
        .block_on(client.close_subscription(&running.subscription_id))
        .unwrap();
    model_task.abort();
    assert!(runtime.block_on(model_task).unwrap_err().is_cancelled());
    tui.close_terminal();
    tui.finish();
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}
