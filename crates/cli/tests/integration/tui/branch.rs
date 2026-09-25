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
use maka_protocol::{
    Operation,
    session::{copy, decode_session_create_input},
};
use serde_json::json;

#[test]
fn branch_preserves_selected_history_and_draft_and_reopens_by_original_receipt() {
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
        let client = support::model_client(&host.root,&format!("http://{}/v1",listener.local_addr().unwrap())).await;
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"branch-source","name":"Branch source","workspace":{"kind":"host_path","path":directory.path()},"modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        let model = tokio::spawn(async move {
            for content in ["First reply.","Later reply."] {
                let (mut stream,_) = model_request(&listener).await;
                let frame = json!({"id":"branch-fixture","object":"chat.completion.chunk","model":"fixture-model",
                    "choices":[{"index":0,"delta":{"content":content},"finish_reason":"stop"}]});
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            }
        });
        for (turn,text) in [("first-turn","Selected branch point"),("later-turn","Later excluded prompt")] {
            client.request(Operation::TurnStart,json!({"sessionId":"branch-source","turnId":turn,"content":{"text":text},"maxSteps":1})).await.unwrap();
            tokio::time::timeout(Duration::from_secs(15),async {
                loop {
                    let output = client.request(Operation::TurnQuery,json!({"sessionId":"branch-source","turnId":turn})).await.unwrap();
                    match output["status"].as_str() {
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
    let before = runtime
        .block_on(client.session("branch-source"))
        .unwrap()
        .unwrap();
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Branch source");
    tui.click_text("Branch source");
    tui.wait_for("Later reply.");
    tui.send(b"Preserved branch draft");
    tui.wait_for("Preserved branch draft");
    tui.click_text("Selected branch point");
    tui.filter_command("Branch from this turn");
    tui.click_text("Branch from this turn");
    tui.wait_for("same working directory.");
    tui.send(b"\r"); // Initial focus is Cancel.
    tui.wait_until(|s| !s.contains("same working directory."));
    tui.filter_command("Branch from this turn");
    tui.click_text("Branch from this turn");
    tui.wait_for("same working directory.");
    tui.click_text("Create branch");
    tui.wait_for("Branch is ready.");
    tui.close_terminal();
    tui.finish();
    let checkpoint = directory
        .path()
        .join("tui-state")
        .join(&client.identity.root_id)
        .join("default/state.json");
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&checkpoint).unwrap()).unwrap();
    let request: copy::Input = serde_json::from_value(saved["branch"]["input"].clone()).unwrap();
    assert_eq!(request.source_session_id, "branch-source");
    assert_eq!(
        request.purpose,
        copy::Purpose::Branch {
            turn_id: Some("first-turn".into()),
            side_conversation: false
        }
    );
    runtime.block_on(async {
        let receipt = client
            .query_session_copy(request.clone())
            .await
            .unwrap()
            .receipt
            .unwrap();
        assert_eq!(receipt.request, request);
        let original = client.session("branch-source").await.unwrap().unwrap();
        assert_eq!(
            original.revision, before.revision,
            "branching normal source does not rewrite it"
        );
        let target = client
            .session(&request.target_session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            target.workspace, original.workspace,
            "branch is not a filesystem copy"
        );
    });
    let mut reopened = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    reopened.wait_for("Preserved branch draft");
    reopened.wait_for("Later reply."); // Restored draft alone does not mean Host is connected.
    reopened.filter_command("Check session branch");
    reopened.click_text("Check session branch");
    reopened.wait_for("Result not yet confirmed.");
    reopened.click_text("Check result");
    reopened.wait_for("Branch is ready.");
    reopened.click_text("Open branch");
    reopened.wait_until(|screen| {
        screen.contains("First reply.")
            && !screen.contains("Branch is ready.")
            && !screen.contains("Preserved branch draft")
    });
    let screen = reopened.screen.snapshot().unwrap().screen;
    assert!(screen.contains("Selected branch point"));
    assert!(
        !screen.contains("Later excluded prompt") && !screen.contains("Later reply."),
        "branch includes only selected history: {screen}"
    );
    assert!(
        !screen.contains("Preserved branch draft"),
        "branch does not adopt original draft"
    );
    reopened.close_terminal();
    reopened.finish();
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(checkpoint).unwrap()).unwrap();
    assert!(saved["branch"].is_null());
    let cursor = saved["navigation"]["cursor"].as_u64().unwrap() as usize;
    assert_eq!(
        saved["navigation"]["entries"][cursor]["route"]["id"],
        request.target_session_id
    );
    let receipt = runtime
        .block_on(client.query_session_copy(request))
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(receipt.request.source_session_id, "branch-source");
    client.disconnect();
    host.retire_registered();
}
