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
        let oar = json!({"enabled":false,"executable":node,"args":[worker,state,trace]});
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

async fn enable(view: &mut AppView) {
    click(view, "Enable external agents").await;
    let acknowledge = button(view, ACKNOWLEDGE).await;
    assert!(
        !acknowledge.state.selected,
        "consent must not be preselected"
    );
    assert!(
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label == CONFIRM && node.state.disabled)
    );
    click(view, ACKNOWLEDGE).await;
    click(view, CONFIRM).await;
    // Keep the mounted UI: source changes recapture its bindings, not the VM.
    see(view, "External agents enabled").await;
    see(view, "Codex").await;
    button(view, "Disable external agents").await;
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
        assert_eq!(original[0]["enabled"], false);
        assert_eq!(original[1], original[0]);
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.resize(180, 160);
        wait_editable_composer(&mut view).await;
        open_settings(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("External agents disabled")).await;
        assert_eq!(requests(fixture.directory.path()), Vec::<Value>::new());

        click(&mut view, "Enable external agents").await;
        let acknowledge = button(&mut view, ACKNOWLEDGE).await;
        assert!(!acknowledge.state.selected);
        assert!(view.accessibility_snapshot().iter().any(|node| node.label == CONFIRM && node.state.disabled));
        see(&mut view, "outside the Maka session sandbox").await;
        click(&mut view, "Cancel enabling external agents").await;
        button(&mut view, "Enable external agents").await;
        assert_eq!(source(&client).await, (revision, before));
        assert_eq!(requests(fixture.directory.path()), Vec::<Value>::new());

        enable(&mut view).await;
        let (enabled_revision, enabled) = source(&client).await;
        assert_eq!(enabled_revision, revision + 1, "both targets must commit in one source revision");
        let mut expected = original.clone();
        for oar in &mut expected { oar["enabled"] = json!(true); }
        assert_eq!(oars(&enabled), expected);
        for text in [
            "Codex", "Installation: Installed (1.0)",
            "Authentication: Signed in (codex login status)",
            "Antigravity", "Authentication: Not signed in (native login status)",
            "Native login required", "Unknown runtime",
            "Authentication: Authentication status unknown — Vendor cannot determine account status",
            "Qwen", "Installation: Not installed", "Qwen account not checked", "Qoder",
        ] {
            see(&mut view, text).await;
        }
        support::evidence("external-agent-statuses", &view.snapshot());
        assert!(requests(fixture.directory.path()).iter().any(|request| request["kind"] == "status"));
        let count = requests(fixture.directory.path()).iter().filter(|request| request["kind"] == "status").count();
        update_worker_state(fixture.directory.path(), |state| state["signedIn"] = json!(true));
        click(&mut view, "Refresh external agents").await;
        see(&mut view, "Authentication: Signed in (native login status)").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label.contains("Not signed in (native login status)")));
        assert_eq!(requests(fixture.directory.path()).iter().filter(|request| request["kind"] == "status").count(), count + 1);

        click(&mut view, "Close settings").await;
        model_choices(&mut view).await;
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
        click(&mut view, "Disable external agents").await;
        wait_view(&mut view, |screen| screen.contains("External agents disabled")).await;
        button(&mut view, "Enable external agents").await;
        let (disabled_revision, disabled) = source(&client).await;
        assert_eq!(disabled_revision, enabled_revision + 1);
        assert_eq!(oars(&disabled), original, "disable preserves the executable and its arguments");
        let settled_requests = requests(fixture.directory.path());
        click(&mut view, "Refresh external agents").await;
        button(&mut view, "Enable external agents").await;
        click(&mut view, "Close settings").await;
        model_choices(&mut view).await;
        button(&mut view, "Use fixture-model-alt · NSH fixture").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label.contains("Use External model")));
        click(&mut view, "Use fixture-model-alt · NSH fixture").await;
        wait_view_state(&mut view, |view, _| model_menu_closed(view)).await;
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(observed["session"]["backend"], json!({"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model-alt","thinkingLevel":null}));
        assert_eq!(requests(fixture.directory.path()), settled_requests, "disabled UI must not probe or select an external runtime");
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
        enable(&mut view).await;
        click(&mut view, "Select Qwen installation line stable").await;
        click(&mut view, "View installation plan for Qwen").await;
        for text in [
            "Installation plan for Qwen", "npm install --global fixture-qwen",
            "Installation source: https://vendor.invalid/qwen",
            "Network access: yes. Elevated privileges: no. Installation changes files on this machine.",
        ] {
            see(&mut view, text).await;
        }
        assert_eq!(worker_state(fixture.directory.path())["installCount"], 0);
        click(&mut view, "Cancel external agent installation").await;
        button(&mut view, "View installation plan for Qwen").await;
        assert_eq!(worker_state(fixture.directory.path())["installed"], false);
        assert!(
            !requests(fixture.directory.path())
                .iter()
                .any(|request| request["action"] == "install")
        );
        click(&mut view, "View installation plan for Qwen").await;
        click(&mut view, "Install Qwen").await;
        see(&mut view, "Installation: Installed (fixture-installed)").await;
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

        click(&mut view, "View installation plan for Qoder").await;
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
        click(&mut view, "Select Qwen installation line stable").await;
        click(&mut view, "View installation plan for Qwen").await;
        click(&mut view, "Install Qwen").await;
        wait_view_state(&mut view, |view, _| {
            view.accessibility_snapshot().iter().any(|node| node.label.contains(
                "External agent installation returned an unknown result. Refresh to check its status."
            ))
        }).await;
        see(&mut view, "Installation: Installed (fixture-installed)").await;
        click(&mut view, "Refresh external agents").await;
        button(&mut view, "Disable external agents").await;
        click(&mut view, "Close settings").await;
        open_settings(&mut view).await;
        see(&mut view, "Installation: Installed (fixture-installed)").await;
        assert_eq!(worker_state(fixture.directory.path())["installCount"], 2);
        assert_eq!(
            requests(fixture.directory.path())
                .iter()
                .filter(|request| request["action"] == "install")
                .count(),
            2
        );
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
        enable(&mut view).await;
        click(&mut view, "Select Qwen installation line stable").await;
        click(&mut view, "View installation plan for Qwen").await;
        button(&mut view, "Install Qwen").await;
        gate.arm();
        click(&mut view, "Install Qwen").await;
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
        see(&mut view, "Installation: Installed (fixture-installed)").await;
        button(&mut view, "Disable external agents").await;
        assert!(reopened.pending_settings().await.unwrap().is_empty());
        let recovered = reopened.operation(original).await.unwrap();
        assert_eq!(recovered.reference.as_ref(), Some(&reference));
        let receipt = serde_json::to_value(recovered.receipt.unwrap()).unwrap();
        assert_eq!(receipt["outcome"]["kind"], "returned");
        assert_eq!(receipt["outcome"]["value"]["result"]["kind"], "installed");
        assert_eq!(receipt["cleanup"]["kind"], "confirmed");
        click(&mut view, "Refresh external agents").await;
        button(&mut view, "Disable external agents").await;
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
        drop(view);
        bindings.close().await.unwrap();
        reopened.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("external agent original receipt recovery timed out");
}
