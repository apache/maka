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
use maka_protocol::{Operation, configuration::ConnectionCatalogQueryInput, session::*};
use serde_json::json;

#[test]
fn model_choice_preserves_session_draft_and_default_and_uses_selected_context_window() {
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
    let (client, mut alternate, default, model_task, url) = runtime.block_on(async {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1",listener.local_addr().unwrap());
        let client = support::model_client(&host.root,&url).await;
        for (id,name) in [("managed","Model session"),("neighbor","Untouched neighbor")] {
            client.create_session(decode_session_create_input(&json!({
                "sessionId":id,"name":name,"workspace":{"kind":"host_path","path":directory.path()},
                "modelTarget":{"kind":"default"}
            })).unwrap()).await.unwrap();
        }
        let catalog = client.connection_catalog(ConnectionCatalogQueryInput::Start).await.unwrap();
        let default = catalog["defaultTarget"].clone();
        let created = client.request(Operation::ConnectionCatalogCreate,json!({
            "expectedCatalogRevision":catalog["revision"],"connection":{
                "slug":"alternate","name":"Alternate connection","provider":support::provider(&client,"openai-compatible").await,
                "configuration":{"baseUrl":url},"enabled":true,"enabledModelIds":["fixture-model"],
                "modelOverrides":{"fixture-model":{"displayName":"Alternate model","contextWindow":64000,"thinkingLevels":["low","high"]}}
            }
        })).await.unwrap();
        support::authenticate(&client, &created["connection"]["connectionId"], "dummy-alternate").await;
        let (_, rows) = super::enabled_models::catalog(&client).await;
        let alternate = rows.iter().find(|row| row["kind"] == "connection" && row["connectionId"] == created["connection"]["connectionId"]).unwrap();
        let alternate = json!({"connectionId":alternate["connectionId"],"revision":alternate["revision"]});
        let task = tokio::spawn(async move {
            let (mut stream,body) = model_request(&listener).await;
            assert!(body.to_string().contains("switch-keeps-draft"));
            assert_eq!(body["reasoning_effort"], "high");
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            let chunk = json!({"id":"switched-model","object":"chat.completion.chunk","model":"fixture-model",
                "choices":[{"index":0,"delta":{"content":"Selected model replied"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":16000,"completion_tokens":100,"total_tokens":16100}});
            stream.write_all(format!("data: {chunk}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
        });
        (client,alternate,default,task,url)
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Model session");
    tui.click_text("Model session");
    tui.wait_for("Message…"); // The catalog also contains the model name, but at a different position.
    tui.wait_for("fixture-model");
    tui.send(b"switch-keeps-draft");
    tui.wait_for("switch-keeps-draft");
    tui.click_last_text("fixture-model");
    tui.wait_for("Alternate model");
    tui.click_text("Alternate model");
    tui.wait_for("› Alternate model");
    alternate = runtime.block_on(async {
        client
            .request(
                Operation::ConnectionCatalogUpdate,
                json!({
                    "expected":alternate,"changes":{"name":"Alternate connection","configuration":{"baseUrl":url},"enabled":false,"enabledModelIds":["fixture-model"]}
                }),
            )
            .await
            .unwrap()["connection"]
            .clone()
    });
    tui.wait_until(|s| s.contains("Use model") && !s.contains("Alternate model"));
    assert_eq!(
        runtime
            .block_on(client.session("managed"))
            .unwrap()
            .unwrap()
            .revision,
        1
    );
    alternate = runtime.block_on(async {
        client
            .request(
                Operation::ConnectionCatalogUpdate,
                json!({
                    "expected":alternate,"changes":{"name":"Alternate connection","configuration":{"baseUrl":url},"enabled":true,"enabledModelIds":["fixture-model"]}
                }),
            )
            .await
            .unwrap()["connection"]
            .clone()
    });
    tui.wait_for("Alternate model");
    tui.click_text("Alternate model");
    tui.wait_for("› Alternate model");
    // Session CAS must still protect this dialog even if the catalog choice remains valid.
    runtime.block_on(async {
        let current = client.session("managed").await.unwrap().unwrap();
        client
            .update_session_metadata(SessionMetadataUpdateInput {
                session_id: current.id,
                expected_revision: current.revision,
                patch: SessionMetadataPatch {
                    name: Some("Renamed elsewhere".into()),
                    labels: None,
                    is_flagged: None,
                },
            })
            .await
            .unwrap();
    });
    tui.send(b"\r");
    tui.wait_for("This session changed elsewhere.");
    tui.send(b"\x1b");
    tui.wait_until(|s| s.contains("Renamed elsewhere") && !s.contains("Cancel"));
    tui.click_last_text("fixture-model");
    tui.wait_for("Alternate model");
    tui.click_text("Alternate model");
    tui.wait_for("› Alternate model");
    tui.click_text("Thinking level"); // A chooser of the levels this model supports.
    tui.wait_for("○ High");
    tui.click_text("○ High");
    tui.wait_for("High ▾");
    tui.click_last_text("Use model");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("switch-keeps-draft"));
    runtime.block_on(async {
        let current = client.session("managed").await.unwrap().unwrap();
        assert_eq!(current.revision, 3);
        assert_eq!(
            current.llm_connection_id.as_deref(),
            alternate["connectionId"].as_str()
        );
        assert_eq!(current.model, "fixture-model");
        assert_eq!(current.thinking_level, Some(ThinkingLevel::High));
        let neighbor = client.session("neighbor").await.unwrap().unwrap();
        assert_eq!(neighbor.revision, 1);
        assert_eq!(
            neighbor.llm_connection_id.as_deref(),
            default["connectionId"].as_str()
        );
        assert_eq!(current.sandbox_mode, neighbor.sandbox_mode);
        assert_eq!(
            client
                .connection_catalog(ConnectionCatalogQueryInput::Start)
                .await
                .unwrap()["defaultTarget"],
            default
        );
    });
    tui.wait_for("fixture-model · High");
    // Reopening seeds the real session setting; selecting the same model keeps it.
    tui.click_last_text("fixture-model");
    tui.wait_for("Alternate model");
    tui.click_text("Alternate model");
    tui.wait_for("High ▾");
    tui.click_text("Thinking level");
    tui.wait_for("○ Default");
    tui.click_text("○ Default");
    tui.wait_for("Default ▾");
    tui.click_last_text("Use model");
    tui.wait_until(|s| !s.contains("Cancel") && !s.contains("fixture-model · High"));
    runtime.block_on(async {
        assert!(
            client
                .session("managed")
                .await
                .unwrap()
                .unwrap()
                .thinking_level
                .is_none()
        );
    });
    tui.click_last_text("fixture-model");
    tui.wait_for("Alternate model");
    tui.click_text("Alternate model");
    tui.wait_for("Default ▾");
    tui.click_text("Thinking level");
    tui.wait_for("○ High");
    tui.click_text("○ High");
    tui.wait_for("High ▾");
    tui.click_last_text("Use model");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("fixture-model · High"));
    tui.click_text("switch-keeps-draft");
    tui.send(b"\r"); // Enter sends the current draft.
    tui.wait_for("Selected model replied");
    tui.wait_for("≈16.1k / 64.0k");
    runtime.block_on(model_task).unwrap();
    // Host defaults use catalog CAS, not the open session's revision.
    tui.send(b"default-keeps-draft");
    tui.wait_for("default-keeps-draft");
    tui.filter_command("Default model");
    tui.click_text("Default model");
    tui.wait_for("No default model");
    tui.wait_for("Alternate model");
    tui.click_text("Alternate model");
    tui.wait_for("› Alternate model");
    tui.click_last_text("Set default");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("default-keeps-draft"));
    let unchanged = runtime.block_on(async {
        let catalog = client.connection_catalog(ConnectionCatalogQueryInput::Start).await.unwrap();
        assert_eq!(catalog["defaultTarget"]["connectionId"],alternate["connectionId"]);
        let created = client.create_session(decode_session_create_input(&json!({
            "sessionId":"new-default","name":"New default session",
            "workspace":{"kind":"host_path","path":directory.path()},"modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        assert_eq!(created.llm_connection_id.as_deref(),alternate["connectionId"].as_str());
        let neighbor = client.session("neighbor").await.unwrap().unwrap();
        assert_eq!(neighbor.revision,1);
        assert_eq!(neighbor.llm_connection_id.as_deref(),default["connectionId"].as_str());
        client.session("managed").await.unwrap().unwrap().revision
    });
    tui.filter_command("Default model");
    tui.click_text("Default model");
    tui.wait_for("No default model");
    tui.wait_for("Alternate model · Current default");
    // Opening and Enter alone do not clear; then explicit selection may be cancelled.
    tui.send(b"\r");
    tui.click_text("No default model");
    tui.wait_for("Clear default");
    tui.send(b"\x1b");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("default-keeps-draft"));
    runtime.block_on(async {
        assert_eq!(
            client
                .connection_catalog(ConnectionCatalogQueryInput::Start)
                .await
                .unwrap()["defaultTarget"]["connectionId"],
            alternate["connectionId"]
        );
    });
    tui.filter_command("Default model");
    tui.click_text("Default model");
    tui.wait_for("No default model");
    tui.wait_for("Current default");
    tui.click_text("No default model");
    tui.wait_for("Clear default");
    tui.click_last_text("Clear default");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("default-keeps-draft"));
    runtime.block_on(async {
        let catalog = client.connection_catalog(ConnectionCatalogQueryInput::Start).await.unwrap();
        assert!(catalog["defaultTarget"].is_null());
        assert_eq!(client.session("managed").await.unwrap().unwrap().revision,unchanged);
        assert_eq!(client.session("neighbor").await.unwrap().unwrap().revision,1);
        let unavailable = client.create_session(decode_session_create_input(&json!({
            "sessionId":"no-default","workspace":{"kind":"host_path","path":directory.path()},"modelTarget":{"kind":"default"}
        })).unwrap()).await;
        assert!(matches!(unavailable,Err(maka_client::RequestFailure::Rejected(_))));
        assert!(client.session("no-default").await.unwrap().is_none());
        // A stale catalog basis cannot restore the cleared default.
        let result = client.set_default_model(maka_protocol::configuration::SetDefaultConnectionTargetInput {
            expected_catalog_revision:catalog["revision"].as_u64().unwrap()-1,
            target:Some(serde_json::from_value(default.clone()).unwrap()),
        }).await.unwrap();
        assert!(matches!(result,maka_protocol::configuration::CatalogMutationResult::RevisionConflict { .. }));
    });
    tui.close_terminal();
    tui.finish();
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}
