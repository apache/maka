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
use maka_client::local::read_discovery;
use maka_event_log::root::{RootNamespaces, RootOwner};

#[test]
fn fresh_terminals_share_one_on_demand_host_and_reopen_the_same_root() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("new-root");
    let mut first = Pty::spawn(&["--root", root.to_str().unwrap(), "--profile", "first"]);
    let mut second = Pty::spawn(&[
        "tui",
        "--root",
        root.to_str().unwrap(),
        "--profile",
        "second",
    ]);
    for tui in [&mut first, &mut second] {
        tui.wait_for("Workspace");
        tui.host_details();
        tui.wait_for("State: ready");
    }
    let original = read_discovery(&root).unwrap();
    for tui in [&mut first, &mut second] {
        assert!(
            tui.screen
                .snapshot()
                .unwrap()
                .screen
                .contains(&original.host_epoch)
        );
        assert!(!String::from_utf8_lossy(&tui.output).contains("MAKA_HOST_PROGRESS"));
    }
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let client = runtime.block_on(super::support::client(&root));
    first.send(b"\x11");
    first.wait_for("Force quit");
    first.send(b"\x1b");
    first.wait_until(|screen| !screen.contains("Force quit"));
    first.filter_command("Close interface only");
    first.click_text("Close interface only");
    first.finish();
    runtime
        .block_on(client.request(maka_protocol::Operation::HostStatus, serde_json::json!({})))
        .unwrap();
    assert_eq!(
        read_discovery(&root).unwrap().host_epoch,
        original.host_epoch
    );
    second.send(b"\x11");
    second.wait_for("Force quit");
    // Enter defaults to cancel; forcing requires an explicit choice.
    second.send(b"\r");
    second.wait_until(|screen| !screen.contains("Force quit"));
    runtime
        .block_on(client.request(maka_protocol::Operation::HostStatus, serde_json::json!({})))
        .unwrap();
    second.send(b"\x11");
    second.wait_for("Force quit");
    second.click_text("Force quit");
    second.finish();
    assert!(RootOwner::open(&root, &RootNamespaces::for_current_account().unwrap()).is_ok());
    client.disconnect();
    drop(client);
    wait_for_idle(&root);
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let deployment = namespaces
        .ownership
        .parent()
        .unwrap()
        .join("deployments")
        .join(&original.root_id);
    assert!(
        !deployment.join("deployment.sqlite").exists(),
        "automatic launch must not install a deployment"
    );

    let mut reopened = Pty::spawn(&["--root", root.to_str().unwrap(), "--profile", "first"]);
    reopened.host_details();
    reopened.wait_for("State: ready");
    let current = read_discovery(&root).unwrap();
    assert_eq!(current.root_id, original.root_id);
    assert_ne!(current.host_epoch, original.host_epoch);
    // The Host must not be retired until the local checkpoint is durable.
    let checkpoint = directory
        .path()
        .join("tui-state")
        .join(&current.root_id)
        .join("first/state.json");
    std::fs::remove_file(&checkpoint).unwrap();
    std::fs::create_dir(&checkpoint).unwrap();
    reopened.send(b"\x11");
    reopened.wait_for("Local changes not saved");
    assert_eq!(
        read_discovery(&root).unwrap().host_epoch,
        current.host_epoch
    );
    assert!(RootOwner::open(&root, &namespaces).is_err());
    std::fs::remove_dir(&checkpoint).unwrap();
    reopened.send(b"\x11");
    reopened.finish();
    assert!(
        RootOwner::open(&root, &namespaces).is_ok(),
        "quit must await root release, not the idle timer"
    );
    wait_for_idle(&root);
}

#[test]
fn busy_root_keeps_navigation_responsive_and_quit_does_not_take_over() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("owned-root");
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let owner = RootOwner::create(&root, &namespaces).unwrap();
    let mut tui = Pty::spawn(&["--root", root.to_str().unwrap()]);
    tui.wait_for("Workspace");
    tui.host_details();
    tui.wait_for("Connecting");
    tui.click_page_text("Appearance");
    tui.wait_for("Maka dark ▾");
    tui.send(b"\x11");
    tui.finish();
    owner.validate_current().unwrap();
    assert!(read_discovery(&root).is_err());
}

fn wait_for_idle(root: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if read_discovery(root).is_err()
            && let Ok(owner) =
                RootOwner::open(root, &RootNamespaces::for_current_account().unwrap())
        {
            owner.validate_current().unwrap();
            return;
        }
        assert!(
            Instant::now() < deadline,
            "automatic Host did not release its root"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
