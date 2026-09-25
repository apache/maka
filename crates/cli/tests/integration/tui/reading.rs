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
fn old_window_selection_and_search_resume_across_pages_and_disk_restart() {
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
    let client = runtime.block_on(async {
        use tokio::{net::TcpListener, io::AsyncWriteExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let client = support::model_client(&host.root, &url).await;
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"reading", "name":"Reading resume", "workspace":{"kind":"host_path","path":directory.path()}, "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        let model = tokio::spawn(async move {
            for _ in 0..8 {
                let (mut stream, _) = model_request(&listener).await;
                let frame = json!({"id":"reading-fixture","object":"chat.completion.chunk","model":"fixture-model",
                    "choices":[{"index":0,"delta":{"content":"Recorded."},"finish_reason":"stop"}]});
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            }
        });
        // Three-line prompt previews fill less screen space; keep the oldest
        // turn outside viewport-driven prefetch as well as the initial byte page.
        for index in 0..8 {
            let id = format!("turn-{index}");
            let prefix = if index == 0 { "Bookmark target 中文🦀\n".to_owned() } else { format!("Later turn {index}\n") };
            client.request(Operation::TurnStart, json!({"sessionId":"reading","turnId":id,
                "content":{"text":prefix + &"History context line with no additional marker.\n".repeat(260)},"maxSteps":1})).await.unwrap();
            tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    let turn = client.request(Operation::TurnQuery, json!({"sessionId":"reading","turnId":id})).await.unwrap();
                    match turn["status"].as_str() {
                        Some("completed") => break,
                        Some("failed" | "cancelled") => panic!("fixture turn failed"),
                        _ => tokio::time::sleep(Duration::from_millis(20)).await,
                    }
                }
            }).await.unwrap();
        }
        model.await.unwrap();
        client
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Reading resume");
    tui.click_text("Reading resume");
    tui.wait_for("Recorded.");
    tui.send(b"\x06Bookmark target");
    tui.wait_for("0/0"); // Oldest turn is outside the initial tail, not merely offscreen.
    tui.send(b"\x1b");
    tui.wait_until(|screen| !screen.contains("Loaded"));
    tui.wait_for("↑"); // Viewport prefetch temporarily disables older-page controls.
    tui.click_text("↑");
    tui.wait_until(|screen| !screen.contains('↑') && screen.contains("Recorded."));
    tui.send(b"\x06Bookmark target");
    tui.wait_for("1/1");
    tui.send(b"\r"); // A page arriving after typing updates matches without moving the reader.
    tui.wait_for("Bookmark target 中文🦀");
    tui.send(b"\x1b");
    tui.wait_until(|screen| {
        !screen.contains("Loaded") && screen.contains("Bookmark target 中文🦀")
    });
    tui.drag_last_text("中文🦀");
    tui.wait_for("Ctrl+C Copy");
    tui.send(b"\x03");
    tui.wait_output(b"\x1b]52;c;5Lit5paH8J+mgA==\x07");
    tui.click_text("Settings");
    tui.wait_for("Maka dark ▾");
    tui.click_text("Reading resume");
    tui.wait_for("Bookmark target 中文🦀");
    tui.wait_for("Ctrl+C Copy");
    tui.output.clear();
    tui.send(b"\x03");
    tui.wait_output(b"\x1b]52;c;5Lit5paH8J+mgA==\x07");
    let header = tui
        .screen
        .snapshot()
        .unwrap()
        .screen
        .lines()
        .next()
        .unwrap()
        .to_owned();
    assert!(
        !header.contains('↑') && !header.contains('↓'),
        "restoring a fully loaded range must not invent more history: {header}"
    );
    tui.send(b"\x1b");
    tui.send(b"\x06Bookmark target");
    tui.wait_for("1/1");
    tui.click_text("Settings");
    tui.wait_for("Maka dark ▾");
    tui.click_text("Reading resume");
    tui.wait_for("1/1");
    tui.wait_for("Bookmark target 中文🦀");
    tui.close_terminal();
    tui.finish();
    let mut reopened = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    reopened.wait_for("1/1");
    reopened.wait_for("Bookmark target 中文🦀");
    assert!(
        !reopened
            .screen
            .snapshot()
            .unwrap()
            .screen
            .contains("Ctrl+C Copy"),
        "transient text selection is not a disk bookmark"
    );
    let saved: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            directory
                .path()
                .join("tui-state")
                .join(&client.identity.root_id)
                .join("default/state.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(saved["version"], 18);
    let encoded = serde_json::to_string(&saved).unwrap();
    assert!(
        !encoded.contains("History context line"),
        "checkpoint must not duplicate transcript text"
    );
    assert!(!encoded.contains("subscriptionId"));
    reopened.close_terminal();
    reopened.finish();
    client.disconnect();
    host.retire_registered();
}
