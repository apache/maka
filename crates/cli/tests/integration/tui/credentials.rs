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
fn reauthentication_uses_the_new_credential_and_stale_removal_cannot_delete_it() {
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
    let (client, id, locator, provider) = runtime.block_on(async {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let client = support::model_client(&host.root, &url).await;
        let catalog = client.connection_catalog(ConnectionCatalogQueryInput::Start).await.unwrap();
        let id = catalog["items"][0]["connectionId"].clone();
        let locator = json!({"scope":"connection","connectionId":id,"kind":"provider"});
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"credential-chat","name":"Key verification","workspace":{"kind":"host_path","path":directory.path()},
            "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _, headers) = model_request_with_headers(&listener).await;
            assert!(headers.lines().any(|line| line.split_once(':').is_some_and(|(name,value)|
                name.eq_ignore_ascii_case("authorization") && value.trim() == "Bearer new-terminal-key")));
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            let chunk = json!({"id":"credential-test","object":"chat.completion.chunk","model":"fixture-model",
                "choices":[{"index":0,"delta":{"content":"New key accepted"},"finish_reason":"stop"}]});
            stream.write_all(format!("data: {chunk}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
        });
        (client, id, locator, task)
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Key verification");
    connections(&mut tui);
    clear(&mut tui);
    tui.wait_for("Credential configured");
    let rotated = runtime.block_on(async {
        support::authenticate(&client, &id, "external-rotation-key").await;
        client
            .request(Operation::CredentialVaultQuery, json!({"locator":locator}))
            .await
            .unwrap()
    });
    tui.click_last_text("Clear credential");
    tui.wait_for("changed elsewhere");
    tui.send(b"\x1b");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("TUI fixture"));
    assert_eq!(
        runtime
            .block_on(client.request(Operation::CredentialVaultQuery, json!({"locator":locator})))
            .unwrap(),
        rotated
    );

    tui.filter_command("Sign in again");
    tui.click_text("Sign in again");
    tui.wait_for("Authentication · ");
    tui.click_text("Authentication · ");
    tui.send(b"new-terminal-key");
    tui.wait_for("Choose a provider");
    tui.click_text("Continue");
    tui.wait_for("Authorization completed.");
    tui.click_last_text("Close");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("TUI fixture"));
    let authenticated = runtime
        .block_on(client.request(Operation::CredentialVaultQuery, json!({"locator":locator})))
        .unwrap();
    assert_ne!(
        authenticated["status"]["credentialId"],
        rotated["status"]["credentialId"]
    );

    tui.command("Open workspace");
    tui.wait_for("Key verification");
    tui.click_text("Key verification");
    tui.wait_for("Message…");
    tui.send(b"Verify saved key\r");
    tui.wait_for("New key accepted");
    runtime.block_on(provider).unwrap();
    connections(&mut tui);
    clear(&mut tui);
    tui.wait_for("Credential configured");
    tui.send(b"\r"); // Cancellation is the default, even after a successful login.
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("TUI fixture"));
    assert_eq!(
        runtime
            .block_on(client.request(Operation::CredentialVaultQuery, json!({"locator":locator})))
            .unwrap(),
        authenticated
    );
    clear(&mut tui);
    tui.wait_for("Credential configured");
    tui.click_last_text("Clear credential");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("TUI fixture"));
    let absent = runtime
        .block_on(client.request(Operation::CredentialVaultQuery, json!({"locator":locator})))
        .unwrap();
    assert_eq!(absent["status"]["configured"], false);
    tui.close_terminal();
    tui.finish();
    let checkpoint = directory
        .path()
        .join("tui-state")
        .join(&client.identity.root_id)
        .join("default/state.json");
    let saved = std::fs::read_to_string(checkpoint).unwrap();
    for secret in ["external-rotation-key", "new-terminal-key"] {
        assert!(!String::from_utf8_lossy(&tui.output).contains(secret));
        assert!(!saved.contains(secret));
    }
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

fn connections(tui: &mut Pty) {
    tui.click_text("⛭  Settings");
    tui.wait_for("Models");
    tui.click_text("Models");
    tui.wait_for("Model connections");
    tui.click_text("Model connections");
    tui.wait_for("› TUI fixture");
    tui.click_text("TUI fixture");
}
fn clear(tui: &mut Pty) {
    tui.filter_command("Clear credential");
    tui.click_text("Clear credential");
}
