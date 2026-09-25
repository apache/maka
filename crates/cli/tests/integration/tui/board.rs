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
    plugin::{RemoteBinding, RemoteRequest, RemoteResult},
};
use serde_json::{Value, json};

mod activity;
mod lifecycle;
pub(super) mod performance;
mod wire;

/// A JavaScript plugin the binary has never heard of, installed while the
/// TUI runs: its app appears in the sidebar, works like any built-in one,
/// and redraws when someone else changes its data.
#[test]
fn a_javascript_plugin_installed_at_runtime_brings_its_own_app_into_the_running_tui() {
    let directory = tempfile::tempdir().unwrap();
    let package = directory.path().join("board-plugin");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("host.mjs"),
        include_str!("../../fixtures/board-plugin/host.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("board-ui.mjs"),
        include_str!("../../fixtures/board-plugin/board-ui.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("maka.extension.json"),
        json!({"schemaVersion":1, "id":"example.board",
            "runtime":{"entry":"host.mjs", "sdkVersion":2}})
        .to_string(),
    )
    .unwrap();
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
    let (client, _listener) = runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = support::model_client(
            &host.root,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        )
        .await;
        client
            .create_session(
                maka_protocol::session::decode_session_create_input(&json!({
                    "sessionId":"scratch", "name":"Scratch",
                    "workspace":{"kind":"host_path","path":directory.path()},
                    "modelTarget":{"kind":"default"}
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        (client, listener)
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.resize(170, 40);
    tui.wait_for("Scratch");
    assert!(!tui.screen.snapshot().unwrap().screen.contains("Board"));

    runtime.block_on(async {
        client
            .request(
                Operation::PluginPackageInstall,
                json!({"sourcePath":package}),
            )
            .await
            .unwrap();
        client
            .request(
                Operation::PluginCompositionApply,
                json!({"operations":[{"type":"insert","rootId":"profile",
                    "entry":{"id":"board","packageId":"example.board"}}]}),
            )
            .await
            .unwrap();
    });
    // Nobody tells the TUI: the Host announces the new view by itself.
    tui.wait_for("Board");
    tui.click_text("Board");
    // Empty lanes still share the width, so the first card moves nothing.
    tui.wait_until(|screen| {
        screen.contains("To do  0")
            && !screen.contains("To do  0  Doing")
            && screen.contains("A new card")
    });
    tui.click_page_text("A new card");
    tui.send(b"\x1b[200~Write the tests\x1b[201~");
    tui.wait_for("Write the tests");
    tui.click_page_text("Add");
    tui.wait_until(|screen| screen.contains("To do  1") && screen.contains("A new card"));
    tui.click_page_text("Write the tests");
    tui.wait_for("Move on");
    tui.click_page_text("Move on");
    tui.wait_until(|screen| screen.contains("To do  0") && screen.contains("Doing  1"));

    // Another writer adds a card; the open board redraws without a keystroke.
    let count = runtime.block_on(remote(&client, "add", json!("From elsewhere")));
    assert_eq!(count, 2);
    tui.wait_until(|screen| screen.contains("To do  1") && screen.contains("From elsewhere"));

    runtime.block_on(wire::preflight(&client));
    activity::exercise(&mut tui, &runtime, &client);

    // Retirement cancels the live changes stream and revokes the open page.
    runtime.block_on(toggle(&client, true));
    tui.wait_for("This app is no longer available.");
    runtime.block_on(toggle(&client, false));
    activity::replacement(&mut tui, &runtime, &client);
    tui.wait_until(|screen| {
        screen.contains("From elsewhere")
            && screen.contains("Doing  1")
            && !screen.contains("This app is no longer available.")
    });
    // The replacement activation has its own stream and the durable board.
    assert_eq!(
        runtime.block_on(remote(&client, "add", json!("After restart"))),
        3
    );
    tui.wait_until(|screen| screen.contains("To do  2") && screen.contains("After restart"));
    tui.close_terminal();
    tui.finish();

    let cards = runtime.block_on(remote(&client, "cards", Value::Null));
    let placed: Vec<_> = cards
        .as_array()
        .unwrap()
        .iter()
        .map(|card| {
            (
                card["title"].as_str().unwrap(),
                card["column"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        placed,
        [
            ("Write the tests", "doing"),
            ("From elsewhere", "todo"),
            ("After restart", "todo"),
        ]
    );
    client.disconnect();
}

async fn toggle(client: &maka_client::Client, disabled: bool) {
    let receipt = client
        .request(
            Operation::PluginCompositionApply,
            json!({"operations":[{"type":"update","entryId":"board","patch":{"disabled":disabled}}]}),
        )
        .await
        .unwrap();
    if !disabled {
        lifecycle::settle(client, disabled, &receipt).await;
    }
}

async fn remote(client: &maka_client::Client, method: &str, input: Value) -> Value {
    let binding = RemoteBinding::Package {
        package_id: "example.board".into(),
        method: method.into(),
        session_id: None,
    };
    let RemoteResult::Bound { target, .. } = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding.clone(),
        })
        .await
        .unwrap()
    else {
        panic!("bound")
    };
    let RemoteResult::Document { document } = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .unwrap()
    else {
        panic!("document")
    };
    let result = client
        .plugin_remote(RemoteRequest::Call {
            binding,
            target,
            document,
            input,
        })
        .await
        .unwrap();
    client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await
        .unwrap();
    let RemoteResult::Value { value } = result else {
        panic!("value")
    };
    value
}
