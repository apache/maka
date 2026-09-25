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
    plugin::{EntryProjection, Query, QueryResult, View},
};
use serde_json::json;

fn package(directory: &std::path::Path, id: &str, title: &str, source: &str) -> std::path::PathBuf {
    let path = directory.join(id);
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("host.mjs"), source).unwrap();
    std::fs::write(path.join("maka.extension.json"),json!({"schemaVersion":1,"id":id,"displayName":title,"runtime":{"entry":"host.mjs","sdkVersion":1}}).to_string()).unwrap();
    path
}
fn host(directory: &std::path::Path) -> super::super::candidate::CandidateFixture {
    let mut host = super::super::candidate::CandidateFixture::new(directory.join("root"));
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
    host
}
fn field(tui: &mut Pty, label: &str, value: &str) {
    let screen = tui.screen.snapshot().unwrap().screen;
    let (row, col) = screen
        .lines()
        .enumerate()
        .filter_map(|(row, line)| line.find(label).map(|byte| (row, line[..byte].width())))
        .last()
        .unwrap_or_else(|| panic!("Missing field {label}: {screen}"));
    tui.click_at(row + 3, col + 2); // label, gap, top border, first editor row
    tui.send(b"\x01");
    tui.send(format!("\x1b[200~{value}\x1b[201~").as_bytes());
    tui.wait_for(value);
}
fn install(tui: &mut Pty, path: &std::path::Path, title: &str) {
    tui.command("Plugins");
    tui.wait_for("Installed packages");
    tui.click_page_text("Install package");
    tui.wait_for("Package path on Host");
    field(tui, "Package path on Host", path.to_str().unwrap());
    tui.click_page_text("Preview package");
    tui.wait_for(title);
    tui.click_page_text("Install package");
    tui.wait_for("Confirm");
    tui.click_last_text("Confirm");
    settled(tui);
    tui.click_page_text("All plugins");
    tui.wait_until(|screen| screen.contains("Installed packages") && screen.contains(title));
    tui.click_page_text(title);
    tui.wait_for("Create instance");
}
fn create(tui: &mut Pty, id: &str, config: &str) {
    tui.click_page_text("Create instance");
    tui.wait_for("Instance identifier");
    field(tui, "Instance identifier", id);
    field(tui, "Advanced configuration (JSON)", config);
    tui.click_page_text("Create instance");
    tui.wait_for("Confirm");
    tui.click_last_text("Confirm");
    settled(tui);
    tui.click_page_text("All plugins");
    tui.wait_until(|screen| screen.contains("Installed packages") && screen.contains(id));
    tui.click_page_text(id);
    wait_active(tui, id);
}
// A receipt can be painted while the follow-up directory read still shows its
// previous snapshot. Old receipts also remain behind a new confirmation Sheet.
// Wait for this Sheet to close and for its resulting read to finish before
// inspecting rows or issuing the next lifecycle command.
fn settled(tui: &mut Pty) {
    tui.wait_until(|screen| {
        screen.contains("Changes saved")
            && !screen.contains("Confirm")
            && !screen.contains("Contacting Host…")
    });
}
fn change(tui: &mut Pty, label: &str) {
    tui.wait_until(|screen| {
        screen.contains(label)
            && !screen.contains("Contacting Host…")
            && !screen.contains("Confirm")
    });
    tui.click_page_text(label);
    tui.wait_for("Confirm");
    tui.click_last_text("Confirm");
    settled(tui);
}

// A composition receipt may precede activation. This must update from the
// platform notification, without a manual Refresh or an external polling client.
fn wait_active(tui: &mut Pty, id: &str) {
    tui.wait_until(|screen| {
        screen.contains(id)
            && screen.contains("Effective: Active")
            && !screen.contains("Contacting Host…")
    });
}
fn sidebar_app(screen: &str, title: &str) -> Option<(usize, usize)> {
    screen.lines().enumerate().find_map(|(row, line)| {
        let (sidebar, _) = line.split_once('│')?;
        let sidebar = sidebar.trim_end();
        if !sidebar.ends_with(title) {
            return None;
        }
        let byte = sidebar.rfind(title)?;
        Some((row, sidebar[..byte].width()))
    })
}
fn open_app(tui: &mut Pty, title: &str) {
    // A command palette intentionally freezes its catalog when opened. A new
    // sidebar registration must not be mistaken for a result in that palette.
    tui.wait_until(|screen| sidebar_app(screen, title).is_some());
    let screen = tui.screen.snapshot().unwrap().screen;
    let (row, column) = sidebar_app(&screen, title).unwrap();
    tui.click_at(row, column);
}

async fn entries(client: &maka_client::Client) -> Vec<EntryProjection> {
    let mut items = vec![];
    let mut cursor = None;
    loop {
        let QueryResult::Entries(page) = client
            .plugin_query(Query {
                view: View::Entries,
                root_id: None,
                cursor,
                limit: Some(64),
            })
            .await
            .unwrap()
        else {
            panic!()
        };
        items.extend(page.items);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    let mut flat = vec![];
    while let Some(mut entry) = items.pop() {
        items.append(&mut entry.children);
        flat.push(entry);
    }
    flat
}
fn current(
    runtime: &tokio::runtime::Runtime,
    client: &maka_client::Client,
    id: &str,
) -> EntryProjection {
    runtime
        .block_on(entries(client))
        .into_iter()
        .find(|e| e.id == id)
        .unwrap()
}

#[test]
fn local_plugin_management_installs_board_and_owns_instance_lifecycle_through_the_tui() {
    let directory = tempfile::tempdir().unwrap();
    let path = package(
        directory.path(),
        "example.board",
        "Managed Board",
        include_str!("../../fixtures/board-plugin/host.mjs"),
    );
    let host = host(directory.path());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    // The independent client only observes. Every package/composition write below
    // originates in a previewed and confirmed TUI interaction.
    let client = runtime.block_on(support::client(&host.root));
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.resize(170, 48);
    tui.wait_for("Maka");
    install(&mut tui, &path, "Managed Board");
    create(&mut tui, "aa-managed-board", "null");
    let initial = current(&runtime, &client, "aa-managed-board");
    assert!(!initial.local_disabled);
    assert!(matches!(
        initial.status,
        maka_protocol::plugin::EntryPhase::Active
    ));
    assert_eq!(initial.package_id.as_deref(), Some("example.board"));
    open_app(&mut tui, "Board");
    tui.wait_for("A new card");
    tui.click_page_text("A new card");
    tui.send(b"\x1b[200~Keep this board draft\x1b[201~");
    tui.wait_for("Keep this board draft");
    tui.command("Plugins");
    tui.wait_for("aa-managed-board");
    tui.click_page_text("aa-managed-board");
    tui.wait_for("Disable instance");
    change(&mut tui, "Disable instance");
    tui.wait_for("Enable instance");
    assert!(current(&runtime, &client, "aa-managed-board").local_disabled);
    change(&mut tui, "Enable instance");
    wait_active(&mut tui, "aa-managed-board");
    assert!(!current(&runtime, &client, "aa-managed-board").local_disabled);
    open_app(&mut tui, "Board");
    tui.wait_for("Keep this board draft");
    tui.command("Plugins");
    tui.wait_for("Managed Board");
    tui.click_page_text("Managed Board");
    tui.wait_for("Restart plugin");
    change(&mut tui, "Restart plugin");
    tui.wait_for("aa-managed-board");
    tui.click_page_text("aa-managed-board");
    wait_active(&mut tui, "aa-managed-board");
    tui.wait_for("Remove instance");
    change(&mut tui, "Remove instance");
    assert!(
        runtime
            .block_on(entries(&client))
            .iter()
            .all(|e| e.id != "aa-managed-board")
    );
    tui.click_page_text("All plugins");
    tui.wait_for("Managed Board");
    tui.click_page_text("Managed Board");
    tui.wait_for("Remove package");
    change(&mut tui, "Remove package");
    let QueryResult::Packages(packages) = runtime
        .block_on(client.plugin_query(Query {
            view: View::Packages,
            root_id: None,
            cursor: None,
            limit: Some(64),
        }))
        .unwrap()
    else {
        panic!()
    };
    assert!(
        packages
            .items
            .iter()
            .all(|p| p.extension_id != "example.board")
    );
    tui.close_terminal();
    tui.finish();
    client.disconnect();
}

#[test]
fn plugin_config_draft_survives_conflict_and_changes_real_plugin_behavior_after_new_review() {
    let directory = tempfile::tempdir().unwrap();
    let path = package(
        directory.path(),
        "example.configured",
        "Configured greeting",
        include_str!("../../fixtures/configured-plugin/host.mjs"),
    );
    let host = host(directory.path());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let client = runtime.block_on(support::client(&host.root));
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.resize(170, 48);
    tui.wait_for("Maka");
    install(&mut tui, &path, "Configured greeting");
    create(
        &mut tui,
        "aa-configured",
        r#"{"greeting":"Before configuration"}"#,
    );
    let initial = current(&runtime, &client, "aa-configured");
    assert!(matches!(
        initial.status,
        maka_protocol::plugin::EntryPhase::Active
    ));
    assert_eq!(initial.config, json!({"greeting":"Before configuration"}));
    open_app(&mut tui, "Greeting");
    tui.wait_for("Before configuration");
    tui.command("Plugins");
    tui.wait_for("aa-configured");
    tui.click_page_text("aa-configured");
    tui.wait_for("Advanced configuration (JSON)");
    tui.click_page_text("Advanced configuration (JSON)");
    tui.wait_for("Configuration drafts stay in memory");
    field(
        &mut tui,
        "Advanced configuration (JSON)",
        r#"{"greeting":"My reviewed greeting"}"#,
    );
    // Deliberate concurrent-write fault injection, never the accepted UI workflow.
    runtime.block_on(client.request(Operation::PluginCompositionApply,json!({"operations":[{"type":"update","entryId":"aa-configured","patch":{"config":{"greeting":"Concurrent greeting"}}}]}))).unwrap();
    // The platform notice must refresh current facts while retaining this draft.
    tui.wait_until(|screen| {
        screen.contains("Review current values")
            && screen.contains("Effective: Active")
            && !screen.contains("Contacting Host…")
    });
    assert!(
        tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("My reviewed greeting")
    );
    tui.click_page_text("Review current values");
    tui.wait_for("Concurrent greeting");
    tui.click_last_text("Confirm");
    tui.wait_until(|screen| screen.contains("Review changes") && !screen.contains("Confirm"));
    assert_eq!(
        current(&runtime, &client, "aa-configured").config,
        json!({"greeting":"Concurrent greeting"})
    );
    change(&mut tui, "Review changes");
    assert_eq!(
        current(&runtime, &client, "aa-configured").config,
        json!({"greeting":"My reviewed greeting"})
    );
    open_app(&mut tui, "Greeting");
    tui.wait_until(|screen| {
        screen.contains("My reviewed greeting")
            && !screen.contains("Advanced configuration (JSON)")
            && !screen.contains("All plugins")
    });
    tui.close_terminal();
    tui.finish();
    client.disconnect();
}
