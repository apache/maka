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
    plugin::{RemoteBinding, RemoteRequest, RemoteResult},
    session::decode_session_create_input,
};
use serde_json::{Value, json};

#[test]
fn plugin_form_saves_in_place_and_preserves_a_stale_draft_without_model_execution() {
    let directory = tempfile::tempdir().unwrap();
    for index in 0..9 {
        let path = directory
            .path()
            .join(format!(".maka/skills/plugin-{index:03}"));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("SKILL.md"), format!("---\nname: Plugin fixture {index:03}\ndescription: Edit preferences without leaving this page\n---\nReview.")).unwrap();
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
    let (client, listener) = runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = support::model_client(&host.root, &format!("http://{}/v1", listener.local_addr().unwrap())).await;
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"plugin-form", "name":"Plugin workspace",
            "workspace":{"kind":"host_path","path":directory.path()}, "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        (client, listener)
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Plugin workspace");
    tui.click_text("Plugin workspace");
    tui.wait_for("No messages yet.");
    tui.filter_command("Plugin pages");
    tui.click_text("Plugin pages");
    tui.wait_for("maka.skills");
    tui.click_text("Skills");
    tui.wait_for("Next");
    for _ in 0..16 {
        if tui
            .screen
            .snapshot()
            .unwrap()
            .screen
            .contains("Plugin fixture 008")
        {
            break;
        }
        let before = tui.screen.snapshot().unwrap().screen;
        tui.click_text("Next");
        tui.wait_until(|screen| {
            screen != before && screen.contains("Skills") && !screen.contains("Loading…")
        });
    }
    tui.click_text("Plugin fixture 008");
    tui.wait_for("Pinned");
    tui.resize(60, 20);
    tui.wait_for("Pinned");
    assert!(
        !tui.screen.snapshot().unwrap().cursor.visible,
        "toggle forms have no text caret"
    );
    tui.click_text("Pinned");
    tui.wait_for("━●");
    tui.click_text("Save");
    tui.wait_for("✓ Save");
    assert!(
        tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("Plugin fixture 008")
    );
    let first = runtime.block_on(catalog(&client));
    let item = selected(&first);
    assert_eq!(item["pinned"], true);
    assert_eq!(item["enabled"], true);
    // A competing writer changes the same domain revision after the form loaded.
    let changed = runtime.block_on(remote(
        &client,
        json!({
            "kind":"mutate", "expectedRevision":first["revision"],
            "mutation":{"kind":"set_pinned","ref":item["ref"],"pinned":false}
        }),
    ));
    assert_eq!(changed["kind"], "committed");
    tui.click_text("Enabled");
    tui.wait_for("○─");
    tui.click_text("Save");
    tui.wait_for("Your draft is preserved");
    tui.send(b"\r"); // A stale submission is disabled, not retried.
    let after = runtime.block_on(catalog(&client));
    assert_eq!(selected(&after)["enabled"], true);
    assert_eq!(selected(&after)["pinned"], false);
    assert_eq!(after["revision"], changed["revision"]);
    tui.click_text("Resume draft");
    tui.wait_for("Draft ready");
    assert_eq!(
        runtime.block_on(catalog(&client))["revision"],
        changed["revision"],
        "reloading only reads"
    );
    tui.click_text("Save");
    tui.wait_for("✓ Save");
    let merged = runtime.block_on(catalog(&client));
    assert_eq!(selected(&merged)["enabled"], false);
    assert_eq!(
        selected(&merged)["pinned"],
        false,
        "unchanged local field must not overwrite another writer"
    );
    tui.click_text("Pinned");
    tui.wait_for("━●");
    tui.close_terminal();
    tui.finish();
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Draft preserved");
    tui.wait_until(|screen| {
        !screen.contains("connecting")
            && !screen.contains("not connected")
            && !screen.contains("connection failed")
    });
    assert_eq!(
        runtime.block_on(catalog(&client))["revision"],
        merged["revision"],
        "reopening a dirty form does not write"
    );
    tui.click_text("Resume draft");
    tui.wait_for("Draft ready");
    tui.wait_for("━●");
    tui.filter_command("Discard draft and reopen");
    tui.click_text("Discard draft and reopen");
    // Discarding reopens the app where it starts, not the directory.
    tui.wait_until(|screen| screen.contains("Plugin fixture 000") && !screen.contains("Draft"));
    tui.close_terminal();
    tui.finish();
    // The app is a place of its own: a restart returns to it and reads it fresh.
    let mut reopened = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    reopened.wait_for("Plugin fixture 000");
    assert!(
        !reopened
            .screen
            .snapshot()
            .unwrap()
            .screen
            .contains("Disconnected")
    );
    reopened.wait_for("Next");
    reopened.close_terminal();
    reopened.finish();
    runtime.block_on(async {
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "plugin navigation and editing must not call a model"
        );
    });
    client.disconnect();
}

async fn catalog(client: &maka_client::Client) -> Value {
    remote(client, json!({"kind":"catalog","view":"governance"})).await
}
fn selected(catalog: &Value) -> &Value {
    catalog["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "Plugin fixture 008")
        .unwrap()
}
async fn remote(client: &maka_client::Client, input: Value) -> Value {
    let binding = RemoteBinding::Package {
        package_id: "maka.skills".into(),
        method: "request".into(),
        session_id: Some("plugin-form".into()),
    };
    let RemoteResult::Bound { target, .. } = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding.clone(),
        })
        .await
        .unwrap()
    else {
        panic!("bound");
    };
    let RemoteResult::Document { document } = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .unwrap()
    else {
        panic!("document");
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
        panic!("value");
    };
    value
}
