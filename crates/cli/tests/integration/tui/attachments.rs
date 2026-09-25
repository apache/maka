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
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_protocol::{
    artifact::{ArtifactQueryInput, ArtifactQueryResult},
    session::{decode_session_create_input, sources},
    subscription::{SubscriptionOpenInput, TranscriptPolicy},
};
use serde_json::{Value, json};

#[test]
fn local_file_upload_survives_routes_and_restart_then_sends_without_text() {
    let directory = tempfile::tempdir().unwrap();
    let local = directory.path().join("attachment 中文.txt");
    let image = directory.path().join("vision.png");
    let image_base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=";
    std::fs::write(&image, STANDARD.decode(image_base64).unwrap()).unwrap();
    let content = "attachment-body-中文\n".repeat(4000);
    std::fs::write(&local, &content).unwrap();
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
    let (client,model) = runtime.block_on(async {
        use tokio::{net::TcpListener,io::AsyncWriteExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = support::model_client(&host.root,&format!("http://{}/v1",listener.local_addr().unwrap())).await;
        let (_,rows) = super::enabled_models::catalog(&client).await;
        client.request(maka_protocol::Operation::ConnectionCatalogUpdate,json!({
            "expected":{"connectionId":rows[0]["connectionId"],"revision":rows[0]["revision"]},
            "changes":{"name":"TUI fixture","configuration":{"baseUrl":format!("http://{}/v1",listener.local_addr().unwrap())},"enabled":true,"enabledModelIds":["fixture-model"],
                "modelOverrides":{"fixture-model":{"contextWindow":128000,"vision":true,"modalities":{"input":["text","image"],"output":["text"]}}}}
        })).await.unwrap();
        for (id,name) in [("files","Attachment session"),("other","Other session")] {
            client.create_session(decode_session_create_input(&json!({"sessionId":id,"name":name,
                "workspace":{"kind":"host_path","path":directory.path()},"modelTarget":{"kind":"default"}})).unwrap()).await.unwrap();
        }
        let model = tokio::spawn(async move {
            let (mut stream,body) = model_request(&listener).await;
            let frame = json!({"id":"attachment-fixture","object":"chat.completion.chunk","model":"fixture-model",
                "choices":[{"index":0,"delta":{"content":"Attachment accepted."},"finish_reason":"stop"}]});
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            body
        });
        (client,model)
    });
    let args = ["--root", host.root.to_str().unwrap()];
    let mut tui = Pty::spawn_at(&args, Some(directory.path()));
    tui.wait_for("Attachment session");
    tui.click_text("Attachment session");
    tui.wait_for("No messages yet.");
    tui.filter_command("Attach files");
    tui.click_text("Attach files");
    tui.wait_for("Local files");
    tui.wait_for("attachment 中文.txt");
    tui.click_text("attachment 中文.txt");
    tui.wait_for("Ready");
    tui.click_text("attachment 中文.txt");
    tui.wait_for("Attach files");
    tui.click_text("Attach files");
    tui.wait_for("vision.png");
    tui.click_text("vision.png");
    tui.wait_for("+1 · Ready");
    tui.wait_for("Other session"); // Sessions are listed in the sidebar.
    tui.click_text("Other session");
    tui.wait_until(|screen| {
        screen
            .lines()
            .next()
            .is_some_and(|l| l.contains("Other session"))
    });
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("attachment 中文.txt")
    );
    tui.wait_for("Attachment session");
    tui.click_text("Attachment session");
    tui.wait_for("Ready");
    tui.click_text("attachment 中文.txt");
    tui.wait_for("Remove");
    tui.resize(80, 24);
    tui.wait_for("attachment 中文.txt");
    tui.send(b"\x1b[<0;1;1M\x1b[<0;1;1m");
    tui.wait_until(|s| !s.contains("Remove"));
    tui.close_terminal();
    tui.finish();
    let checkpoint = directory
        .path()
        .join("tui-state")
        .join(&client.identity.root_id)
        .join("default/state.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(&checkpoint).unwrap()).unwrap();
    assert_eq!(saved["version"], 20);
    let attachment = saved["attachments"]["files"][0]["attachment"].clone();
    assert!(attachment.is_object());
    let artifact = attachment["ref"]["relativePath"].as_str().unwrap();
    assert_eq!(attachment["ref"]["sessionId"], "files");
    assert_eq!(attachment["bytes"], content.len());
    runtime.block_on(async {
        let ArtifactQueryResult::Artifact {
            artifact: Some(record),
            ..
        } = client
            .query_artifact(ArtifactQueryInput::Get {
                session_id: "files".into(),
                artifact_id: artifact.into(),
            })
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(
            record.summary.as_deref(),
            Some(maka_runtime::artifact::content_digest(content.as_bytes()).as_str())
        );
        assert!(matches!(
            client
                .query_artifact(ArtifactQueryInput::Get {
                    session_id: "other".into(),
                    artifact_id: artifact.into()
                })
                .await
                .unwrap(),
            ArtifactQueryResult::Artifact { artifact: None, .. }
        ));
    });
    std::fs::remove_file(&local).unwrap();
    std::fs::remove_file(&image).unwrap();
    let mut reopened = Pty::spawn_at(&args, Some(directory.path()));
    reopened.wait_for("Ready");
    reopened.wait_for("fixture-model");
    assert!(
        !reopened
            .screen
            .snapshot()
            .unwrap()
            .screen
            .contains("Local files")
    );
    reopened.send(b"\r");
    reopened.wait_for("Attachment accepted.");
    let screen = reopened.screen.snapshot().unwrap().screen;
    assert!(screen.contains("attachment 中文.txt"));
    assert!(screen.contains("vision.png"));
    reopened.close_terminal();
    reopened.finish();
    let body = runtime.block_on(model).unwrap();
    assert!(body.to_string().contains("attachment 中文.txt"));
    assert!(body["messages"].as_array().unwrap().iter().filter_map(|m|m["content"].as_array()).flatten()
        .any(|part| part["image_url"]["url"] == format!("data:image/png;base64,{image_base64}")), "selected vision model receives original image bytes");
    let saved: Value = serde_json::from_slice(&std::fs::read(&checkpoint).unwrap()).unwrap();
    assert!(saved["attachments"].get("files").is_none());
    assert!(saved["unresolved"].as_array().unwrap().is_empty());
    runtime.block_on(async {
        let opened = client
            .open_subscription(SubscriptionOpenInput {
                session_id: "files".into(),
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
                session_id: "files".into(),
                turn_id: turn,
            })
            .await
            .unwrap();
        assert_eq!(source.messages.len(), 1);
        assert_eq!(
            source.messages[0]
                .content
                .attachments
                .as_ref()
                .unwrap()
                .len(),
            2
        );
        assert!(source.messages[0].content.text.is_empty());
        assert_eq!(
            serde_json::to_value(&source.messages[0].content.attachments.as_ref().unwrap()[0])
                .unwrap(),
            attachment
        );
        let ArtifactQueryResult::Page { artifacts, .. } = client
            .query_artifact(ArtifactQueryInput::ListStart {
                session_id: "files".into(),
            })
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(artifacts.len(), 2, "reopening does not re-upload the file");
    });
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}
