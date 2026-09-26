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
    session::{decode_session_create_input, sources},
    subscription::{SubscriptionOpenInput, TranscriptPolicy},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

mod library;

#[test]
fn skills_candidates_page_without_execution_and_restore_exact_selection_before_send() {
    let directory = tempfile::tempdir().unwrap();
    for index in 0..129 {
        let path = directory
            .path()
            .join(format!(".maka/skills/pick-{index:03}"));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("SKILL.md"),format!("---\nname: Candidate {index:03}\ndescription: Review precisely\n---\nchosen-instructions-{index:03}\n")).unwrap();
    }
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
    let calls = Arc::new(AtomicUsize::new(0));
    let (client,model)=runtime.block_on(async {
        use tokio::{net::TcpListener,io::AsyncWriteExt};
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client=support::model_client(&host.root,&format!("http://{}/v1",listener.local_addr().unwrap())).await;
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"skills","name":"Candidate session","workspace":{"kind":"host_path","path":directory.path()},"modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        let calls=calls.clone();
        let model=tokio::spawn(async move {
            let (mut stream,body)=model_request(&listener).await;
            calls.fetch_add(1,Ordering::SeqCst);
            let frame=json!({"id":"skill-fixture","object":"chat.completion.chunk","model":"fixture-model",
                "choices":[{"index":0,"delta":{"content":"Skill accepted."},"finish_reason":"stop"}]});
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            body
        });
        (client,model)
    });
    let args = ["--root", host.root.to_str().unwrap()];
    let mut tui = Pty::spawn(&args);
    tui.wait_for("Candidate session");
    tui.click_text("Candidate session");
    tui.wait_for("No messages yet.");
    tui.filter_command("Skills");
    tui.click_text("Skills");
    tui.wait_for("Candidate 000");
    assert!(
        !tui.screen.snapshot().unwrap().cursor.visible,
        "composer cursor must not leak through the Skills picker"
    );
    tui.send(b"\x1b[C"); // Next provider page, not local list scrolling.
    tui.wait_for("Candidate 128");
    tui.click_text("Candidate 128");
    tui.wait_for("Selected · 1");
    tui.resize(80, 24);
    tui.wait_for("Selected · 1");
    tui.send(b"\x1b[<0;1;1M\x1b[<0;1;1m");
    tui.wait_until(|s| !s.contains("Selected · 1") && s.contains("Candidate 128"));
    tui.close_terminal();
    tui.finish();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "candidate browsing never executes"
    );
    let checkpoint = directory
        .path()
        .join("tui-state")
        .join(&client.identity.root_id)
        .join("default/state.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(&checkpoint).unwrap()).unwrap();
    assert_eq!(saved["version"], 23);
    let picked = saved["skills"]["skills"].as_array().unwrap();
    assert_eq!(picked.len(), 1);
    assert_eq!(picked[0]["name"], "Candidate 128");
    let selected = picked[0]["id"].as_str().unwrap().to_owned();
    assert!(saved["unresolved"].as_array().unwrap().is_empty());
    let mut reopened = Pty::spawn(&args);
    reopened.wait_for("Candidate 128");
    reopened.wait_for("fixture-model");
    reopened.send(b"\r");
    reopened.wait_for("Skill accepted.");
    reopened.close_terminal();
    reopened.finish();
    let body = runtime.block_on(model).unwrap();
    assert!(body.to_string().contains("chosen-instructions-128"));
    assert!(!body.to_string().contains("chosen-instructions-000"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let saved: Value = serde_json::from_slice(&std::fs::read(&checkpoint).unwrap()).unwrap();
    assert!(
        saved["skills"].get("skills").is_none(),
        "acceptance clears only sent selections"
    );
    runtime.block_on(async {
        let opened = client
            .open_subscription(SubscriptionOpenInput {
                session_id: "skills".into(),
                transcript: TranscriptPolicy::None,
            })
            .await
            .unwrap();
        let turn = opened.snapshot.root_turn.unwrap().turn_id;
        client
            .close_subscription(&opened.subscription_id)
            .await
            .unwrap();
        let source = client
            .session_turn_sources(sources::Input {
                session_id: "skills".into(),
                turn_id: turn,
            })
            .await
            .unwrap();
        assert_eq!(source.messages.len(), 1);
        assert!(
            source.messages[0].content.text.is_empty(),
            "original input remains empty, not plugin-prepared text"
        );
        assert_eq!(
            source.messages[0].input_selections["maka.skills"],
            [selected]
        );
    });
    client.disconnect();
}
