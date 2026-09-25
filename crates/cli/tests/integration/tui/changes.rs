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
use maka_protocol::session::decode_session_create_input;
use serde_json::json;

#[test]
fn real_edits_show_request_diff_without_claiming_a_file_snapshot_and_copy_without_gutters() {
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
    std::fs::write(
        directory.path().join("source.rs"),
        "  let label = \"before\";\n",
    )
    .unwrap();
    std::fs::write(directory.path().join("existing.txt"), "previous file\n").unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (client, model) = runtime.block_on(async {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let client = support::model_client(&host.root, &url).await;
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"changes", "name":"Change preview fixture",
            "workspace":{"kind":"host_path","path":directory.path()}, "sandboxMode":"workspace-write",
            "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        let model = tokio::spawn(async move {
            for index in 0..3 {
                let (mut stream, body) = model_request(&listener).await;
                if index == 1 {
                    let result = body["messages"].as_array().unwrap().iter()
                        .find(|message| message["tool_call_id"] == "edit").unwrap();
                    assert!(result["content"].as_str().unwrap().contains("whitespace"));
                }
                let (delta, reason) = if index == 2 {
                    (json!({"content":"Changes recorded"}), "stop")
                } else {
                    let (id, name, args) = if index == 0 {
                        ("edit", "Edit", json!({"path":"source.rs","old_string":"let   label = \"before\";","new_string":"let label = \"中文🦀\";"}))
                    } else {
                        ("write", "Write", json!({"path":"existing.txt","content":"replacement file\n"}))
                    };
                    (json!({"tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":args.to_string()}}]}), "tool_calls")
                };
                let frame = json!({"id":"diff-fixture","object":"chat.completion.chunk","model":"fixture-model",
                    "choices":[{"index":0,"delta":delta,"finish_reason":reason}]});
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            }
        });
        (client, model)
    });
    let mut tui = Pty::spawn_at(
        &["--root", host.root.to_str().unwrap()],
        Some(directory.path()),
    );
    tui.resize(120, 40);
    tui.wait_for("Change preview fixture");
    tui.click_text("Change preview fixture");
    tui.wait_for("Message…");
    tui.send(b"change the isolated files\r");
    tui.wait_for("Changes recorded");
    runtime.block_on(model).unwrap();
    assert_eq!(
        std::fs::read_to_string(directory.path().join("source.rs")).unwrap(),
        "let label = \"中文🦀\";\n"
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("existing.txt")).unwrap(),
        "replacement file\n"
    );
    tui.click_text("source.rs");
    use base64::Engine;
    let full_path = directory.path().canonicalize().unwrap().join("source.rs");
    let encoded = base64::engine::general_purpose::STANDARD.encode(full_path.to_str().unwrap());
    tui.wait_output(format!("\x1b]52;c;{encoded}\x07").as_bytes());
    tui.wait_for("Copy request sent to terminal");
    let screen = tui.screen.snapshot().unwrap().screen;
    assert!(
        screen.contains("◆ Edit") && !screen.contains("− let   label"),
        "copying the path must not unfold the tool"
    );
    tui.click_text("◆ Edit");
    tui.wait_for("− let   label");
    tui.wait_for("+ let label");
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("not a file snapshot")
    );
    assert!(!tui.screen.snapshot().unwrap().screen.contains("whitespace"));
    tui.drag_last_text("中文🦀");
    tui.send(b"\x03");
    tui.wait_output(b"\x1b]52;c;5Lit5paH8J+mgA==\x07");
    tui.wait_for("Copy request sent to terminal");
    tui.send(b"\x1b");
    tui.wait_for("Esc Controls"); // Wait for selection/clipboard feedback to settle before using its geometry.
    tui.click_text("◆ Write");
    tui.wait_for("+ replacement file");
    tui.wait_for("− previous file");
    tui.resize(55, 28);
    // Narrow windows hide the sidebar entirely.
    tui.wait_until(|screen| {
        !screen.contains("+  New session") && screen.contains("replacement file")
    });
    tui.send(b"\x06");
    tui.wait_for("Loaded");
    tui.send("中文🦀".as_bytes());
    tui.wait_for("1/1");
    tui.wait_for("中文🦀");
    tui.send(b"\x1b");
    tui.resize(160, 40); // Wide enough for the result JSON on one line.
    tui.wait_until(|screen| screen.contains("+  New session") && !screen.contains("Loaded"));
    tui.send(b"\x10");
    tui.wait_for("Search commands…");
    // Command additions may put execution details below the initial viewport.
    tui.send(b"\x1b[F"); // End scrolls to the last command without activating it.
    tui.wait_for("Show execution details");
    tui.click_text("Show execution details");
    tui.wait_for("old_string:");
    tui.wait_for("new_string:");
    tui.wait_for("whitespace");
    tui.close_terminal();
    tui.finish();
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

#[test]
fn code_mode_patch_stops_after_failure_and_keeps_real_tools_visible() {
    use maka_protocol::Operation;
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
    std::fs::write(directory.path().join("existing.txt"), "keep\n").unwrap();
    std::fs::write(directory.path().join("later.txt"), "not deleted").unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (client, model) = runtime.block_on(async {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let client = support::model_client(&host.root, &url).await;
        let catalog = client.request(Operation::ConnectionCatalogQuery, json!({"kind":"start"})).await.unwrap();
        let connection = catalog["items"].as_array().unwrap().iter().find(|item| item["kind"] == "connection").unwrap();
        let updated = client.request(Operation::ConnectionCatalogUpdate, json!({
            "expected":{"connectionId":connection["connectionId"],"revision":connection["revision"]},
            "changes":{"name":"TUI fixture","configuration":{"baseUrl":url},"enabled":true,"enabledModelIds":["fixture-model"],
                "modelOverrides":{"fixture-model":{"contextWindow":128000,"codeMode":true,"applyPatch":true}}}
        })).await.unwrap();
        assert_eq!(updated["kind"], "committed");
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"patches","name":"Partial patch fixture",
            "workspace":{"kind":"host_path","path":directory.path()},"sandboxMode":"workspace-write",
            "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        let model = tokio::spawn(async move {
            let create = json!({"callId":"create","operation":{"type":"create_file","path":"created.txt","diff":"++literal 中文🦀"}});
            let update = json!({"callId":"update","operation":{"type":"update_file","path":"existing.txt","diff":"@@\n-absent\n+not applied"}});
            let delete = json!({"callId":"delete","operation":{"type":"delete_file","path":"later.txt"}});
            let code = format!("await tools.apply_patch({create}); await tools.apply_patch({update}); return await tools.apply_patch({delete});");
            for index in 0..2 {
                let (mut stream, body) = model_request(&listener).await;
                if index == 0 {
                    assert!(body["tools"].to_string().contains("exec"));
                } else {
                    let message = body["messages"].as_array().unwrap().iter().find(|message| message["tool_call_id"] == "cell").unwrap();
                    let content: serde_json::Value = serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
                    assert_eq!(content["state"], "completed", "{content}");
                    assert_eq!(content["result"]["ok"], false, "{content}");
                    assert_eq!(content["result"]["toolCalls"].as_array().unwrap().len(), 2, "failure must stop before delete: {content}");
                }
                let (delta, reason) = if index == 0 {
                    (json!({"tool_calls":[{"index":0,"id":"cell","type":"function","function":{"name":"exec","arguments":json!({"code":code,"yield_time_ms":60000}).to_string()}}]}), "tool_calls")
                } else {
                    (json!({"content":"Patch stopped after the failed update"}), "stop")
                };
                let frame = json!({"id":"patch-fixture","object":"chat.completion.chunk","model":"fixture-model",
                    "choices":[{"index":0,"delta":delta,"finish_reason":reason}]});
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            }
        });
        (client, model)
    });
    let mut tui = Pty::spawn_at(
        &["--root", host.root.to_str().unwrap()],
        Some(directory.path()),
    );
    tui.resize(140, 50);
    tui.wait_for("Partial patch fixture");
    tui.click_text("Partial patch fixture");
    tui.wait_for("Message…");
    tui.send(b"Apply the isolated patch\r");
    tui.wait_for("Patch stopped after the failed update");
    runtime.block_on(model).unwrap();
    assert_eq!(
        std::fs::read_to_string(directory.path().join("created.txt")).unwrap(),
        "+literal 中文🦀"
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("existing.txt")).unwrap(),
        "keep\n"
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("later.txt")).unwrap(),
        "not deleted"
    );
    // The live answer can precede the durable tool page. Wait for the final
    // result before measuring coordinates; a pending status row can disappear.
    tui.wait_for("Failed to find expected lines in snapshot: absent");
    tui.wait_for("Patch · created.txt");
    assert!(!tui.screen.snapshot().unwrap().screen.contains("exec"));
    tui.click_text("Patch · created.txt");
    tui.wait_for("+ +literal 中文🦀");
    tui.drag_last_text("+literal 中文🦀");
    tui.send(b"\x03");
    tui.wait_output(b"\x1b]52;c;K2xpdGVyYWwg5Lit5paH8J+mgA==\x07");
    tui.wait_for("Copy request sent to terminal");
    tui.send(b"\x1b");
    tui.wait_for("Esc Controls");
    tui.click_text("Patch · created.txt"); // The whole header row folds, not just its glyph.
    tui.wait_until(|screen| !screen.contains("+ +literal 中文🦀"));
    tui.click_last_text("◆ Patch");
    tui.wait_for("− absent");
    tui.wait_for("+ not applied");
    tui.wait_for("Failed to find expected lines in snapshot: absent");
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("Error or unconfirmed outcome")
    );
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("Delete · later.txt")
    );
    tui.filter_command("Show execution details");
    tui.click_text("Show execution details");
    tui.wait_for("exec");
    tui.close_terminal();
    tui.finish();
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}
