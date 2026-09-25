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

use super::enabled_models::catalog;
use super::*;

#[test]
fn oauth_entry_uses_host_enrollment_mouse_keyboard_and_never_starts_on_dismiss() {
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
    let (client, before) = runtime.block_on(async {
        let client = support::client(&host.root).await;
        support::provider(&client, "chatgpt").await;
        let before = catalog(&client).await;
        (client, before)
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.read_size = 128; // Split frames and escape sequences across PTY reads.
    tui.wait_for("Workspace");
    tui.host_details();
    tui.wait_for("Host epoch:");
    tui.command("Open workspace");
    tui.filter_command("Sign in to a provider");
    tui.click_text("Sign in to a provider");
    let providers = runtime
        .block_on(client.provider_directory(maka_protocol::model_provider::Scope::Profile))
        .unwrap();
    let label = select_provider(&mut tui, &providers, "chatgpt");
    tui.wait_for("Choose a provider and authentication method.");
    tui.resize(60, 20);
    tui.wait_for("Continue");
    // Selection schedules the original enrollment query, not a login. Focus
    // stays on the pop-up once it settles, even when this provider is
    // enabled: Enter only shows the choices again, and Esc closes them
    // before it dismisses the sheet.
    tui.send(b"\r");
    tui.wait_for(&format!("● {label}"));
    tui.send(b"\x1b");
    tui.wait_until(|screen| !screen.contains(&format!("● {label}")));
    tui.send(b"\x1b");
    tui.wait_until(|screen| {
        // Home's own button: the sidebar is hidden this narrow.
        !screen.contains("Sign in to a provider") && screen.contains("+ New session")
    });
    tui.resize(100, 30);
    tui.wait_for("+  New session");
    tui.filter_command("Sign in to a provider");
    tui.click_text("Sign in to a provider");
    tui.wait_for("Continue");
    tui.send(b"\x1b[<0;1;1M\x1b[<0;1;1m");
    tui.wait_until(|screen| {
        !screen.contains("Sign in to a provider") && screen.contains("No sessions yet")
    });
    assert_eq!(
        runtime.block_on(catalog(&client)),
        before,
        "enrollment and dismissal do not save credentials or connections"
    );
    tui.close_terminal();
    tui.finish();
    client.disconnect();
    host.child.as_mut().unwrap().kill().unwrap();
    host.child.as_mut().unwrap().wait().unwrap();
    host.child = None;
}

#[test]
fn oauth_start_is_durable_before_dispatch_and_crash_reopens_only_the_original_query() {
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
    runtime.block_on(async {
        let client = support::client(&host.root).await;
        support::provider(&client, "chatgpt").await;
        let before = catalog(&client).await;
        let relay = super::recovery::LostReply::oauth_start(&host.root, directory.path()).await;
        let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
        tui.wait_for("Workspace");
        tui.host_details();
        tui.wait_for("Host epoch:");
        tui.command("Open workspace");
        tui.filter_command("Sign in to a provider");
        tui.click_text("Sign in to a provider");
        let providers = client
            .provider_directory(maka_protocol::model_provider::Scope::Profile)
            .await
            .unwrap();
        select_provider(&mut tui, &providers, "chatgpt");
        tui.wait_for("Choose a provider and authentication method.");
        custom_identity(&mut tui);
        let checkpoint = directory
            .path()
            .join("tui-state")
            .join(&client.identity.root_id)
            .join("default/state.json");
        if checkpoint.exists() {
            std::fs::remove_file(&checkpoint).unwrap();
        }
        std::fs::create_dir(&checkpoint).unwrap();
        tui.click_text("Continue");
        tui.wait_for("Login was not sent:");
        tui.wait_for("Close      Check      Cancel");
        assert!(
            relay.requests().is_empty(),
            "storage failure must prevent OAuth dispatch"
        );
        std::fs::remove_dir(&checkpoint).unwrap();
        tui.click_last_text("Check");
        tui.wait_for("This Host cannot find the attempt");
        tui.click_text("New sign-in");
        select_provider(&mut tui, &providers, "chatgpt");
        tui.wait_for("Choose a provider and authentication method.");
        custom_identity(&mut tui);
        tui.click_text("Continue");
        tui.wait_for("connection failed");
        let requests = relay.requests();
        assert_eq!(requests.len(), 1);
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&checkpoint).unwrap()).unwrap();
        assert_eq!(
            saved["oauth"]["attempt"],
            serde_json::json!({"attemptId":requests[0]["attemptId"],"target":requests[0]["target"]})
        );
        assert_eq!(requests[0]["target"]["provider"]["name"], "chatgpt");
        assert_eq!(requests[0]["target"]["slug"], "work-codex");
        assert_eq!(requests[0]["target"]["name"], "Work 中文");
        assert_eq!(saved["oauth"].as_object().unwrap().len(), 2);
        assert!(!tui.terminate().unwrap().success());
        let mut reopened = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
        reopened.wait_for("Workspace");
        reopened.host_details();
        reopened.wait_for("Host epoch:");
        reopened.filter_command("View sign-in");
        reopened.click_text("View sign-in");
        reopened.wait_for("The outcome is unknown.");
        reopened.wait_for("Close      Check      Cancel");
        assert_eq!(
            relay.requests(),
            requests,
            "restart must never replay login"
        );
        reopened.click_last_text("Check");
        reopened.wait_for("This Host cannot find the attempt");
        assert_eq!(
            relay.requests(),
            requests,
            "NotFound is not permission to restart"
        );
        reopened.close_terminal();
        reopened.finish();
        assert_eq!(catalog(&client).await, before);
        drop(relay);
        client.disconnect();
    });
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

fn custom_identity(tui: &mut Pty) {
    tui.wait_for("Close      Continue");
    tui.click_text("Connection details");
    tui.wait_for("Display name");
    tui.wait_for("Connection ID");
    tui.click_text("Display name");
    tui.send("\x1b[200~Work 中文\x1b[201~".as_bytes());
    tui.click_text("Connection ID");
    tui.send(b"\x1b[200~BAD ID\x1b[201~");
    tui.wait_for("lowercase letters");
    tui.send(b"\x01\x1b[200~work-codex\x1b[201~");
    tui.wait_for("Choose a provider and authentication method.");
    tui.click_text("Connection details");
    tui.wait_until(|screen| {
        !screen.contains("Display name") && screen.contains("Close      Continue")
    });
}

/// Picks the provider's first method from the sheet's provider pop-up,
/// which keeps the focus; returns its label.
fn select_provider(
    tui: &mut Pty,
    directory: &maka_client::ProviderDirectory,
    name: &str,
) -> String {
    let provider = directory
        .entries
        .iter()
        .find(|provider| provider.identity.name == name)
        .unwrap_or_else(|| panic!("fixture provider was not published: {name}"));
    let label = format!(
        "{} · {}",
        provider.descriptor.label, provider.descriptor.authentication[0].label
    );
    tui.wait_until(|screen| {
        screen.contains("Provider  ") && !screen.contains("Checking availability…")
    });
    tui.click_text("Provider  ");
    let choice = ["○", "●"].map(|marker| format!("{marker} {label}"));
    tui.wait_until(|screen| choice.iter().any(|choice| screen.contains(choice)));
    let shown = tui.screen.snapshot().unwrap().screen;
    tui.click_text(
        choice
            .iter()
            .find(|choice| shown.contains(*choice))
            .unwrap(),
    );
    tui.wait_for(&format!("{label} ▾"));
    label
}
