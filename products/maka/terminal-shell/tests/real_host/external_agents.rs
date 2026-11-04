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
use maka_app_client::Client;
use std::{path::Path, sync::OnceLock};

const ACKNOWLEDGE: &str = "I understand and accept the external agent permissions";
const CONFIRM: &str = "Confirm permissions and enable";

async fn fixture() -> Fixture {
    let node = tokio::task::spawn_blocking(|| {
        static NODE: OnceLock<String> = OnceLock::new();
        NODE.get_or_init(|| {
            let output = std::process::Command::new("node")
                .args(["-p", "process.execPath"])
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        })
        .clone()
    })
    .await
    .unwrap();
    Fixture::open_with_configuration(Default::default(), move |configuration, directory| {
        let worker = directory.join("external-agent-worker.mjs");
        std::fs::write(
            &worker,
            include_str!("../support/external-agent-worker.mjs"),
        )
        .unwrap();
        let state = directory.join("external-state.json");
        std::fs::write(
            &state,
            r#"{"installed":false,"signedIn":false,"installCount":0}"#,
        )
        .unwrap();
        let trace = directory.join("external-requests.jsonl");
        std::fs::write(&trace, "").unwrap();
        let oar =
            json!({"enabled":true,"runtimes":{},"executable":node,"args":[worker,state,trace]});
        configuration["agent"]["oar"] = oar.clone();
        configuration["coordinator"]["oar"] = oar;
    })
    .await
}

fn worker_state(directory: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(directory.join("external-state.json")).unwrap()).unwrap()
}

fn update_worker_state(directory: &Path, update: impl FnOnce(&mut Value)) {
    let mut state = worker_state(directory);
    update(&mut state);
    let temporary = directory.join("external-state.next");
    std::fs::write(&temporary, serde_json::to_vec(&state).unwrap()).unwrap();
    std::fs::rename(temporary, directory.join("external-state.json")).unwrap();
}

fn requests(directory: &Path) -> Vec<Value> {
    std::fs::read_to_string(directory.join("external-requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

const RUNTIMES: &str = "External agent runtimes";

async fn scroll_to(
    view: &mut AppView,
    label: &str,
    matches: impl Fn(&AccessibleNode) -> bool,
) -> AccessibleNode {
    wait_view_state(view, |view, _| {
        view.accessibility_snapshot().iter().any(&matches)
    })
    .await;
    for _ in 0..160 {
        view.poll().unwrap();
        support::tick(view);
        let nodes = view.accessibility_snapshot();
        let scroll = nodes.iter().find(|node| node.label == RUNTIMES).unwrap();
        let target = nodes.iter().find(|node| matches(node)).unwrap();
        let top = scroll.frame.origin.y.0.max(0.0);
        let bottom = (scroll.frame.origin.y.0 + scroll.frame.size.height.0)
            .min(view.surface().viewport().height.0);
        let target_top = target.frame.origin.y.0;
        let target_bottom = target_top + target.frame.size.height.0;
        if target_top >= top && target_bottom <= bottom {
            return target.clone();
        }
        let metrics = view.surface().metrics();
        let column = ((scroll.frame.origin.x.0 + scroll.frame.size.width.0 / 2.0)
            / metrics.width().0)
            .floor() as u16;
        let row = ((top + bottom) / 2.0 / metrics.height().0).floor() as u16;
        view.handle_event(Event::Mouse(crossterm::event::MouseEvent {
            kind: if target_top < top {
                crossterm::event::MouseEventKind::ScrollUp
            } else {
                crossterm::event::MouseEventKind::ScrollDown
            },
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }));
        commit_native_events(view).await;
    }
    panic!(
        "could not scroll {label:?} into the external runtime viewport:\n{}",
        view.snapshot()
    );
}

async fn see(view: &mut AppView, text: &str) {
    // Accessibility retains the complete text even when terminal glyphs wrap.
    // Require its frame to be in the actual Scroll viewport, not merely mounted.
    scroll_to(view, text, |node| node.label.contains(text)).await;
}

async fn button(view: &mut AppView, label: &str) -> AccessibleNode {
    if label != "Close settings"
        && view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == RUNTIMES)
    {
        scroll_to(view, label, |node| {
            node.label == label
                && node.role == nsh_core::AccessibilityRole::Button
                && !node.state.disabled
        })
        .await
    } else {
        support::wait_enabled_button(view, label).await
    }
}

async fn click(view: &mut AppView, label: &str) {
    let mut target = button(view, label).await;
    target.frame.origin.x.0 += target.frame.size.width.0 / 2.0;
    target.frame.origin.y.0 += target.frame.size.height.0 / 2.0;
    support::click_node(view, target);
    commit_native_events(view).await;
}

async fn source(client: &Client) -> (u64, Value) {
    let read = client.query("management", "read", json!({})).await.unwrap();
    let reference = &read["source"]["reference"];
    let mut offset = 0;
    let mut text = String::new();
    loop {
        let page = client
            .query(
                "management",
                "readDocument",
                json!({"source":reference,"offset":offset}),
            )
            .await
            .unwrap();
        text.push_str(page["text"].as_str().unwrap());
        let Some(next) = page["next"].as_u64() else {
            break;
        };
        offset = next;
    }
    (
        reference["revision"].as_u64().unwrap(),
        serde_json::from_str(&text).unwrap(),
    )
}

fn oars(document: &Value) -> [Value; 2] {
    [
        document["input"]["instances"]["agent"]["configuration"]["values"]["oar"].clone(),
        document["input"]["instances"]["workhub"]["configuration"]["values"]["agent"]["oar"]
            .clone(),
    ]
}

async fn open_settings(view: &mut AppView) {
    click(view, "Choose model and effort").await;
    click(view, "Manage external agents").await;
    button(view, "Refresh external agents").await;
}

async fn toggle_runtime(view: &mut AppView, client: &Client, id: &str, name: &str, enabled: bool) {
    let (revision, before) = source(client).await;
    let mut expected = oars(&before);
    click(
        view,
        &format!("{} {name}", if enabled { "Enable" } else { "Disable" }),
    )
    .await;
    if enabled {
        let acknowledge = button(view, ACKNOWLEDGE).await;
        assert!(
            !acknowledge.state.selected,
            "each enable requires fresh consent"
        );
        assert!(
            view.accessibility_snapshot()
                .iter()
                .any(|node| node.label == CONFIRM && node.state.disabled)
        );
        click(view, ACKNOWLEDGE).await;
        click(view, CONFIRM).await;
    }
    // Keep the mounted UI: source changes recapture its bindings, not the VM.
    button(
        view,
        &format!("{} {name}", if enabled { "Disable" } else { "Enable" }),
    )
    .await;
    for oar in &mut expected {
        if enabled {
            oar["enabled"] = json!(true);
        }
        oar["runtimes"][id] = json!(enabled);
    }
    let (changed_revision, changed) = source(client).await;
    assert_eq!(
        changed_revision,
        revision + 1,
        "both targets change in one source revision"
    );
    assert_eq!(
        oars(&changed),
        expected,
        "only this runtime changes; preserve executable, args and other switches"
    );
}

fn assert_only_runtime_requests(rows: &[Value], allowed: &[&str]) {
    for request in rows {
        match request["kind"].as_str().unwrap() {
            "started" => {}
            "status" | "catalog" if request.get("runtime").is_none() => {
                let selected = request["runtimes"]
                    .as_array()
                    .expect("bulk reads require explicit runtime IDs");
                assert!(!selected.is_empty());
                for id in selected {
                    assert!(
                        allowed.contains(&id.as_str().unwrap()),
                        "unselected runtime requested: {request}"
                    );
                }
            }
            "status" | "catalog" | "setup" | "runtime_call" => {
                assert!(
                    allowed.contains(&request["runtime"].as_str().unwrap()),
                    "unselected runtime invoked: {request}"
                );
            }
            _ => panic!("unexpected worker request: {request}"),
        }
    }
}

async fn see_installed(view: &mut AppView) {
    button(view, "Disable Qwen Code").await;
    click(view, "Show Qwen Code details").await;
    see(view, "Installed (fixture-installed)").await;
    click(view, "Hide Qwen Code details").await;
}

async fn model_choices(view: &mut AppView) {
    click(view, "Choose model and effort").await;
    wait_view_state(view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Choose model" || node.label == "Search models and sources")
    })
    .await;
    if view
        .accessibility_snapshot()
        .iter()
        .any(|node| node.label == "Choose model")
    {
        click(view, "Choose model").await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn external_agents_ui_consent_updates_both_sources_and_preserves_native_selection() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let fixture = fixture().await;
        let client = fixture.client().await;
        let (revision, before) = source(&client).await;
        let original = oars(&before);
        assert_eq!(original[0]["runtimes"], json!({}));
        assert_eq!(original[1], original[0]);
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.resize(180, 160);
        wait_editable_composer(&mut view).await;
        open_settings(&mut view).await;
        for name in ["Antigravity", "Claude Code", "CodeBuddy Code", "Codex", "Grok Build", "Kimi Code", "OpenCode", "Qoder", "Qwen Code"] {
            let switch = button(&mut view, &format!("Enable {name}")).await;
            assert!(!switch.state.selected, "{name} must start off");
        }
        let nodes = view.accessibility_snapshot();
        assert!(!nodes.iter().any(|node| {
            ["Enable external agents", "1 models available", "Not installed", "Models unavailable", "Sign in required", "Could not verify sign-in"].contains(&node.label.as_str())
                || (node.label.starts_with("Show ") && node.label.ends_with(" details"))
        }), "disabled rows expose only names and switches, not unrequested runtime status");
        for root in ["agent", "workhub"] {
            let key = before["input"]["instances"][root]["key"].as_str().unwrap();
            assert!(!nodes.iter().any(|node| node.label.contains(key) || node.label.contains("agent.oar")));
        }
        assert_eq!(requests(fixture.directory.path()), Vec::<Value>::new());

        click(&mut view, "Enable Codex").await;
        let acknowledge = button(&mut view, ACKNOWLEDGE).await;
        assert!(!acknowledge.state.selected);
        assert!(view.accessibility_snapshot().iter().any(|node| node.label == CONFIRM && node.state.disabled));
        see(&mut view, "outside the Maka sandbox").await;
        click(&mut view, "Cancel enabling external agents").await;
        button(&mut view, "Enable Codex").await;
        assert_eq!(source(&client).await, (revision, before));
        assert_eq!(requests(fixture.directory.path()), Vec::<Value>::new());

        toggle_runtime(&mut view, &client, "codex", "Codex", true).await;
        see(&mut view, "1 models available").await;
        click(&mut view, "Show Codex details").await;
        see(&mut view, "Installed (1.0)").await;
        see(&mut view, "Signed in (codex login status)").await;
        click(&mut view, "Hide Codex details").await;
        assert_only_runtime_requests(&requests(fixture.directory.path()), &["codex"]);
        assert!(requests(fixture.directory.path()).iter().any(|request| request["kind"] == "runtime_call" && request["runtime"] == "codex" && request["phase"] == "authentication"));

        toggle_runtime(&mut view, &client, "claude", "Claude Code", true).await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label.contains("fixture-vendor-error")));
        click(&mut view, "Show Claude Code details").await;
        see(&mut view, "Claude listModels failed: fixture-vendor-error").await;
        click(&mut view, "Hide Claude Code details").await;
        click(&mut view, "Close settings").await;
        model_choices(&mut view).await;
        button(&mut view, "Use fixture-model-alt · NSH fixture").await;
        button(&mut view, "Use External model · OAR · codex").await;
        assert_only_runtime_requests(&requests(fixture.directory.path()), &["codex", "claude"]);
        assert!(requests(fixture.directory.path()).iter().any(|request| request["kind"] == "catalog" && request["runtimes"].as_array().is_some_and(|ids| ids.contains(&json!("claude")) && ids.contains(&json!("codex")))));
        click(&mut view, "Use External model · OAR · codex").await;
        wait_view_state(&mut view, |view, _| model_menu_closed(view)).await;
        click(&mut view, "Choose model and effort").await;
        click(&mut view, "Choose reasoning effort").await;
        click(&mut view, "Use effort vendor-deep").await;
        let screen = wait_view_state(&mut view, |view, screen| {
            model_menu_closed(view) && screen.contains("External model · vendor-deep")
        }).await;
        assert!(!screen.contains("OAR · codex"), "provider belongs in the tooltip, not the model button: {screen}");
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(observed["session"]["backend"], json!({"kind":"executor","selection":{"executor":"oar","settings":{"runtime":"codex","model":"external-model","thinkingLevel":"vendor-deep"}}}));

        open_settings(&mut view).await;
        toggle_runtime(&mut view, &client, "antigravity", "Antigravity", true).await;
        see(&mut view, "Sign in required").await;
        click(&mut view, "Show Antigravity details").await;
        see(&mut view, "Native login required").await;
        click(&mut view, "Hide Antigravity details").await;
        update_worker_state(fixture.directory.path(), |state| state["signedIn"] = json!(true));
        let count = requests(fixture.directory.path()).iter().filter(|request| request["kind"] == "status").count();
        click(&mut view, "Refresh external agents").await;
        button(&mut view, "Disable Antigravity").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label.contains("Not signed in")));
        click(&mut view, "Show Antigravity details").await;
        see(&mut view, "Signed in (native login status)").await;
        click(&mut view, "Hide Antigravity details").await;
        assert_eq!(requests(fixture.directory.path()).iter().filter(|request| request["kind"] == "status").count(), count + 1);
        assert_only_runtime_requests(&requests(fixture.directory.path()), &["codex", "claude", "antigravity"]);
        toggle_runtime(&mut view, &client, "grok", "Grok Build", true).await;
        see(&mut view, "Could not verify sign-in").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label.contains("Vendor cannot determine account status")));
        click(&mut view, "Show Grok Build details").await;
        see(&mut view, "Vendor cannot determine account status").await;
        click(&mut view, "Hide Grok Build details").await;
        assert_only_runtime_requests(&requests(fixture.directory.path()), &["codex", "claude", "antigravity", "grok"]);

        toggle_runtime(&mut view, &client, "codex", "Codex", false).await;
        let after_disable = requests(fixture.directory.path()).len();
        click(&mut view, "Refresh external agents").await;
        button(&mut view, "Enable Codex").await;
        click(&mut view, "Close settings").await;
        model_choices(&mut view).await;
        button(&mut view, "Use fixture-model-alt · NSH fixture").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label == "Use External model · OAR · codex"));
        click(&mut view, "Use fixture-model-alt · NSH fixture").await;
        wait_view_state(&mut view, |view, _| model_menu_closed(view)).await;
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(observed["session"]["backend"], json!({"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model-alt","thinkingLevel":null}));
        assert_only_runtime_requests(&requests(fixture.directory.path())[after_disable..], &["claude", "antigravity", "grok"]);
        open_settings(&mut view).await;
        for (id, name) in [("claude", "Claude Code"), ("antigravity", "Antigravity"), ("grok", "Grok Build")] {
            toggle_runtime(&mut view, &client, id, name, false).await;
        }
        let settled_requests = requests(fixture.directory.path());
        click(&mut view, "Refresh external agents").await;
        button(&mut view, "Enable Codex").await;
        click(&mut view, "Close settings").await;
        model_choices(&mut view).await;
        button(&mut view, "Use fixture-model · NSH fixture").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label.contains("Use External model")));
        click(&mut view, "Use fixture-model · NSH fixture").await;
        wait_view_state(&mut view, |view, _| model_menu_closed(view)).await;
        assert_eq!(requests(fixture.directory.path()), settled_requests, "no runtime selected means no worker starts");
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("external agent consent and picker workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn external_agents_ui_installation_requires_a_plan_and_explicit_confirmation() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let fixture = fixture().await;
        let client = fixture.client().await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.resize(180, 160);
        wait_editable_composer(&mut view).await;
        open_settings(&mut view).await;
        toggle_runtime(&mut view, &client, "qwen", "Qwen Code", true).await;
        click(&mut view, "Select Qwen Code installation line stable").await;
        click(&mut view, "View installation plan for Qwen Code").await;
        for text in [
            "Installation plan for Qwen Code", "npm install --global fixture-qwen",
            "Installation source: https://vendor.invalid/qwen",
            "Network access: yes. Elevated privileges: no. Installation changes files on this machine.",
        ] {
            see(&mut view, text).await;
        }
        assert_eq!(worker_state(fixture.directory.path())["installCount"], 0);
        click(&mut view, "Cancel external agent installation").await;
        button(&mut view, "View installation plan for Qwen Code").await;
        assert_eq!(worker_state(fixture.directory.path())["installed"], false);
        assert!(
            !requests(fixture.directory.path())
                .iter()
                .any(|request| request["action"] == "install")
        );
        click(&mut view, "View installation plan for Qwen Code").await;
        click(&mut view, "Install Qwen Code").await;
        see_installed(&mut view).await;
        assert_eq!(worker_state(fixture.directory.path())["installCount"], 1);
        let setup: Vec<_> = requests(fixture.directory.path())
            .into_iter()
            .filter(|request| request["kind"] == "setup")
            .collect();
        assert_eq!(
            setup
                .iter()
                .map(|request| request["action"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["plan", "plan", "install"]
        );
        assert!(
            setup
                .iter()
                .all(|request| request["runtime"] == "qwen" && request["options"]["line"] == "stable")
        );

        assert_only_runtime_requests(&requests(fixture.directory.path()), &["qwen"]);
        update_worker_state(fixture.directory.path(), |state| state["antigravityMissing"] = json!(true));
        toggle_runtime(&mut view, &client, "antigravity", "Antigravity", true).await;
        see(&mut view, "Automatic installation is not supported in Maka.").await;
        button(&mut view, "Open Antigravity installation guide").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label == "View installation plan for Antigravity" || node.label == "Install Antigravity"));
        click(&mut view, "Show Antigravity details").await;
        see(&mut view, "PATH or OAR_ANTIGRAVITY_BIN").await;
        click(&mut view, "Hide Antigravity details").await;
        assert!(!requests(fixture.directory.path()).iter().any(|request| request["kind"] == "setup" && request["runtime"] == "antigravity"));
        assert_eq!(worker_state(fixture.directory.path())["installCount"], 1);

        assert_only_runtime_requests(&requests(fixture.directory.path()), &["qwen", "antigravity"]);
        toggle_runtime(&mut view, &client, "qoder", "Qoder", true).await;
        click(&mut view, "View installation plan for Qoder").await;
        see(&mut view, "Installation options for Qoder").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label.contains("Fixture platform has no Qoder installer")));
        click(&mut view, "Show Qoder details").await;
        see(&mut view, "Fixture platform has no Qoder installer").await;
        assert!(
            !view
                .accessibility_snapshot()
                .iter()
                .any(|node| node.label == "Install Qoder")
        );
        click(&mut view, "Cancel external agent installation").await;

        // A vendor may return an unrecognized result after doing the work. Refresh
        // observes its effect; it must not turn that result into another install.
        update_worker_state(fixture.directory.path(), |state| {
            state["installed"] = json!(false);
            state["unknownResult"] = json!(true);
        });
        click(&mut view, "Refresh external agents").await;
        click(&mut view, "Select Qwen Code installation line stable").await;
        click(&mut view, "View installation plan for Qwen Code").await;
        click(&mut view, "Install Qwen Code").await;
        click(&mut view, "Show external agent error details").await;
        see(&mut view, "External agent installation returned an unknown result. Refresh to check its status.").await;
        see_installed(&mut view).await;
        click(&mut view, "Refresh external agents").await;
        button(&mut view, "Disable Qwen Code").await;
        click(&mut view, "Close settings").await;
        open_settings(&mut view).await;
        see_installed(&mut view).await;
        assert_eq!(worker_state(fixture.directory.path())["installCount"], 2);
        assert_eq!(
            requests(fixture.directory.path())
                .iter()
                .filter(|request| request["action"] == "install")
                .count(),
            2
        );
        assert_only_runtime_requests(&requests(fixture.directory.path()), &["qwen", "antigravity", "qoder"]);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("external agent installation workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn external_agents_ui_recovers_the_original_install_receipt_without_reinstalling() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let fixture = fixture().await;
        let gate = ReplyGate::oar_setup(fixture.directory.path(), fixture.address.clone());
        let client = fixture.client_at(&gate.address).await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.resize(180, 160);
        wait_editable_composer(&mut view).await;
        open_settings(&mut view).await;
        toggle_runtime(&mut view, &client, "qwen", "Qwen Code", true).await;
        click(&mut view, "Select Qwen Code installation line stable").await;
        click(&mut view, "View installation plan for Qwen Code").await;
        button(&mut view, "Install Qwen Code").await;
        gate.arm();
        click(&mut view, "Install Qwen Code").await;
        tokio::time::timeout(Duration::from_secs(20), gate.held.notified())
            .await
            .unwrap();
        assert_eq!(worker_state(fixture.directory.path())["installCount"], 1);
        let pending = client.pending_settings().await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].endpoint, "agent");
        assert_eq!(pending[0].method, "oarSetup");
        let original = pending[0].id;
        let reference = pending[0].reference.clone().unwrap();
        // The Host has committed, but this UI has never received that receipt.
        drop(view);
        drop(gate);
        bindings
            .close()
            .await
            .expect_err("the original transport was deliberately severed");
        drop(client);

        let reopened = fixture.client().await;
        assert!(
            reopened
                .pending_settings()
                .await
                .unwrap()
                .iter()
                .any(|operation| operation.id == original)
        );
        let (mut view, bindings) = fixture.view(reopened.clone(), Some(fixture.session.clone()));
        view.resize(180, 160);
        wait_editable_composer(&mut view).await;
        open_settings(&mut view).await;
        see_installed(&mut view).await;
        button(&mut view, "Disable Qwen Code").await;
        assert!(reopened.pending_settings().await.unwrap().is_empty());
        let recovered = reopened.operation(original).await.unwrap();
        assert_eq!(recovered.reference.as_ref(), Some(&reference));
        let receipt = serde_json::to_value(recovered.receipt.unwrap()).unwrap();
        assert_eq!(receipt["outcome"]["kind"], "returned");
        assert_eq!(receipt["outcome"]["value"]["result"]["kind"], "installed");
        assert_eq!(receipt["cleanup"]["kind"], "confirmed");
        click(&mut view, "Refresh external agents").await;
        button(&mut view, "Disable Qwen Code").await;
        assert_eq!(worker_state(fixture.directory.path())["installCount"], 1);
        let setup: Vec<_> = requests(fixture.directory.path())
            .into_iter()
            .filter(|request| request["kind"] == "setup")
            .collect();
        assert_eq!(
            setup
                .iter()
                .map(|request| request["action"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["plan", "install"]
        );
        assert_only_runtime_requests(&requests(fixture.directory.path()), &["qwen"]);
        drop(view);
        bindings.close().await.unwrap();
        reopened.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("external agent original receipt recovery timed out");
}
