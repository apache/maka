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
    // The parent's new card and the child's reset editor may paint before the
    // creation form finishes its readback. Begin local-RPC measurement only
    // after both the acknowledged action and its settled form are visible.
    tui.wait_until(|screen| {
        screen.contains("To do  1")
            && screen.contains("Write the tests")
            && screen.contains("A new card")
            && screen.contains("✓ Add")
            && !screen.contains("Loading…")
    });
    let position = |screen: &str, text: &str| {
        screen
            .lines()
            .enumerate()
            .find_map(|(row, line)| line.find(text).map(|at| (row, line[..at].width())))
            .unwrap()
    };
    let screen = tui.screen.snapshot().unwrap().screen;
    let (card_row, card_col) = position(&screen, "Write the tests");
    let (lane_row, lane_col) = position(&screen, "Doing  0");
    let stats = runtime.block_on(remote(&client, "activity-stats", Value::Null));
    let preview = format!(
        "\x1b[<0;{};{}M\x1b[<32;{};{}M",
        card_col + 1,
        card_row + 1,
        lane_col + 1,
        lane_row + 1
    );
    tui.send(preview.as_bytes());
    tui.wait_until(|screen| position(screen, "Write the tests").1 >= lane_col);
    assert_eq!(
        runtime.block_on(remote(&client, "activity-stats", Value::Null)),
        stats,
        "card preview makes no Host read or write"
    );
    tui.send(b"\x1b");
    tui.wait_until(|screen| position(screen, "Write the tests").1 < lane_col);
    assert_eq!(
        runtime.block_on(remote(&client, "activity-stats", Value::Null)),
        stats
    );
    tui.send(preview.as_bytes());
    tui.send(format!("\x1b[<0;{};{}m", lane_col + 1, lane_row + 1).as_bytes());
    tui.wait_until(|screen| screen.contains("To do  0") && screen.contains("Doing  1"));
    let moved = runtime.block_on(remote(&client, "cards", Value::Null));
    assert_eq!(moved[0]["column"], "doing");
    assert_eq!(
        runtime.block_on(remote(&client, "activity-stats", Value::Null))["viewWrites"].as_u64(),
        stats["viewWrites"].as_u64().map(|writes| writes + 1)
    );
    // Receipt completion must reach disk without a later input or clean quit.
    let checkpoint = directory
        .path()
        .join("tui-state")
        .join(&client.identity.root_id)
        .join("default/state.json");
    tui.wait_until(|_| {
        let saved: Value = serde_json::from_slice(&std::fs::read(&checkpoint).unwrap()).unwrap();
        assert_eq!(saved["root"], client.identity.root_id);
        assert_eq!(saved["version"], 23);
        !saved["apps"].as_array().unwrap().iter().any(|page| {
            page["key"]["package"] == "example.board"
                && page["key"]["method"] == "board"
                && page["key"]["within"].is_null()
                && page["key"]["route"].is_null()
                && page["pending"]["input"]["kind"] == "submit"
        })
    });
    assert_eq!(
        runtime.block_on(remote(&client, "activity-stats", Value::Null))["viewWrites"].as_u64(),
        stats["viewWrites"].as_u64().map(|writes| writes + 1),
        "persisting the receipt must not repeat the mutation"
    );
    click_card(&mut tui, "Write the tests");
    tui.wait_for("Save");
    tui.click_page_text("Note");
    tui.send(b"\x1b[200~Saved from detail\x1b[201~");
    tui.click_page_text("Save");
    tui.wait_until(|screen| screen.matches("Saved from detail").count() >= 2);
    let saved = runtime.block_on(remote(&client, "cards", Value::Null));
    assert_eq!(saved[0]["note"], "Saved from detail");
    assert!(
        tui.screen.snapshot().unwrap().screen.contains("A new card"),
        "saving a detail must not edit the independent creation form"
    );
    click_card(&mut tui, "Write the tests");
    tui.send(b" \x1b[C\r");
    tui.wait_for("Done  1");
    assert_eq!(
        runtime.block_on(remote(&client, "cards", Value::Null))[0]["column"],
        "done"
    );
    // Parent readback must also restore the selected clean detail's observation.
    // Do not refresh or reselect it: its own displayed lane proves current data.
    tui.wait_until(|screen| detail_has_lane(screen, "Done") && !screen.contains("Loading…"));
    tui.click_page_text("Note");
    tui.send(b"\x01\x1b[200~Fresh detail note\x1b[201~");
    tui.click_last_text("Save");
    tui.wait_until(|screen| {
        screen.matches("Fresh detail note").count() >= 2 && !screen.contains("Loading…")
    });
    assert_eq!(
        runtime.block_on(remote(&client, "cards", Value::Null))[0]["note"],
        "Fresh detail note"
    );
    click_card(&mut tui, "Write the tests");
    tui.send(b" \x1b[D\r");
    tui.wait_for("Doing  1");

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
    // A clean child must resume its actual form after the hidden reactivation.
    tui.wait_for("A new card");
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

/// A lane heading in the detail uses the same column as its Title field. The
/// collection's lane counts are elsewhere and cannot satisfy this readback check.
fn detail_has_lane(screen: &str, lane: &str) -> bool {
    let Some(column) = screen
        .lines()
        .find_map(|line| line.find("Title").map(|byte| line[..byte].width()))
    else {
        return false;
    };
    screen.lines().any(|line| {
        line.char_indices()
            .find(|(byte, _)| line[..*byte].width() == column)
            .is_some_and(|(byte, _)| line[byte..].trim() == lane)
    })
}

/// The selected detail repeats a card's title above the collection row. Hit the
/// collection's leftmost occurrence, never the noninteractive detail heading.
fn click_card(tui: &mut Pty, title: &str) {
    let snapshot = tui.screen.snapshot().unwrap();
    let (row, col) = snapshot
        .screen
        .lines()
        .enumerate()
        .flat_map(|(row, line)| {
            line.match_indices(title)
                .map(move |(byte, _)| (row, line[..byte].width()))
        })
        .min_by_key(|(_, col)| *col)
        .unwrap_or_else(|| panic!("No collection card {title:?}\n{}", snapshot.screen));
    tui.click_at(row, col);
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
