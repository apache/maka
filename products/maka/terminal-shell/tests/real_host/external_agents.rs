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

use super::{
    support::{evidence, evidence_cells},
    *,
};
use maka_app_client::Client;
use std::{path::Path, sync::OnceLock};

const ACKNOWLEDGE: &str = "I understand and accept the external agent permissions";
const CONFIRM: &str = "Confirm permissions and enable";
const SANDBOX: &str = "Sandbox and approvals";

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
        let worker = directory.join("external-agent-cli.mjs");
        std::fs::write(&worker, include_str!("../support/external-agent-cli.mjs")).unwrap();
        let state = directory.join("external-state.json");
        std::fs::write(&state, r#"{"signedIn":true,"modelsFail":false}"#).unwrap();
        let trace = directory.join("external-requests.jsonl");
        std::fs::write(&trace, "").unwrap();
        let external = json!({"runtimes":{},"commands":{
            "codex":{"executable":node,"args":[worker,state,trace]},
            "claude":{"executable":directory.join("not-installed-claude")}
        }});
        configuration["agent"]["external"] = external;
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
        support::tick(view);
        let nodes = view.accessibility_snapshot();
        let scroll = nodes.iter().find(|node| node.label == RUNTIMES).unwrap();
        let target = nodes.iter().find(|node| matches(node)).unwrap();
        let top = scroll.frame.origin.y.0.max(0.0);
        let bottom =
            (scroll.frame.origin.y.0 + scroll.frame.size.height.0).min(view.viewport().height.0);
        let target_top = target.frame.origin.y.0;
        let target_bottom = target_top + target.frame.size.height.0;
        if target_top >= top && target_bottom <= bottom {
            return target.clone();
        }
        let metrics = view.cells();
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
    if !["Close settings", CONFIRM, "Cancel enabling external agents"].contains(&label)
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

fn external(document: &Value) -> Value {
    document["input"]["instances"]["agent"]["configuration"]["values"]["external"].clone()
}

async fn open_settings(view: &mut AppView) {
    click(view, "Choose model and effort").await;
    click(view, "Manage external agents").await;
    button(view, "Settings section External agents").await;
}

async fn reopen_section(view: &mut AppView) {
    click(view, "Settings section General").await;
    click(view, "Settings section External agents").await;
}

async fn toggle_runtime(view: &mut AppView, client: &Client, id: &str, name: &str, enabled: bool) {
    let (revision, before) = source(client).await;
    let mut expected = external(&before);
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
    expected["runtimes"][id] = json!(enabled);
    let (changed_revision, changed) = source(client).await;
    assert_eq!(
        changed_revision,
        revision + 1,
        "agent target changes in one source revision"
    );
    assert_eq!(
        external(&changed),
        expected,
        "only this runtime changes; preserve native launch settings and other switches"
    );
}

fn composer_sandbox(view: &AppView) -> Option<bool> {
    let nodes = view.accessibility_snapshot();
    nodes
        .iter()
        .any(|node| node.label == "Choose model and effort")
        .then(|| nodes.iter().any(|node| node.label == SANDBOX))
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
async fn external_agents_ui_consent_native_catalog_cache_and_failure_isolation() {
    let fixture = fixture().await;
    let client = fixture.client().await;
    let (revision, before) = source(&client).await;
    let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
    view.resize(180, 160);
    wait_editable_composer(&mut view).await;
    open_settings(&mut view).await;
    for name in ["Antigravity", "Codex", "Claude Code"] {
        assert!(
            !button(&mut view, &format!("Enable {name}"))
                .await
                .state
                .selected
        );
    }
    assert!(
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label.contains("Qwen Code")
                || node.label.contains("View installation plan"))
    );
    evidence("native-external-runtimes", &view.snapshot());
    evidence_cells("native-external-runtimes", &view);
    assert!(requests(fixture.directory.path()).is_empty());
    click(&mut view, "Enable Codex").await;
    assert!(!button(&mut view, ACKNOWLEDGE).await.state.selected);
    assert!(
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label == CONFIRM && node.state.disabled)
    );
    see(&mut view, "native full-access mode").await;
    evidence("native-external-consent", &view.snapshot());
    evidence_cells("native-external-consent", &view);
    click(&mut view, "Cancel enabling external agents").await;
    button(&mut view, "Enable Codex").await;
    assert_eq!(source(&client).await, (revision, before));
    assert!(requests(fixture.directory.path()).is_empty());

    toggle_runtime(&mut view, &client, "codex", "Codex", true).await;
    see(&mut view, "1 models available").await;
    click(&mut view, "Show Codex details").await;
    see(&mut view, "Signed in (codex account/read)").await;
    click(&mut view, "Hide Codex details").await;
    click(&mut view, "Close settings").await;
    model_choices(&mut view).await;
    button(&mut view, "Use fixture-model-alt · NSH fixture").await;
    button(&mut view, "Use External model · Native CLI · codex").await;

    let page = client
        .query("agent", "models", json!({"kind":"start","query":""}))
        .await
        .unwrap();
    let external = page["choices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|choice| {
            choice.pointer("/selection/selection/settings/model") == Some(&json!("external-model"))
        })
        .unwrap();
    let count = requests(fixture.directory.path())
        .iter()
        .filter(|row| row["method"] == "launch")
        .count();
    for _ in 0..3 {
        let checked = client
            .query("agent", "model", json!({"backend":external["selection"]}))
            .await
            .unwrap();
        assert_eq!(checked["kind"], "ready");
    }
    assert_eq!(
        requests(fixture.directory.path())
            .iter()
            .filter(|row| row["method"] == "launch")
            .count(),
        count,
        "single-model validation must reuse the shared catalog, not launch native processes"
    );

    click(&mut view, "Use External model · Native CLI · codex").await;
    wait_view_state(&mut view, |view, _| model_menu_closed(view)).await;
    let observed = client
        .query("agent", "observe", json!({"sessionId":fixture.session}))
        .await
        .unwrap();
    assert_eq!(
        observed["session"]["backend"].pointer("/selection/executor"),
        Some(&json!("external"))
    );
    // External CLIs run outside the session sandbox, so the composer must not offer its setting.
    wait_view_state(&mut view, |view, _| composer_sandbox(view) == Some(false)).await;

    open_settings(&mut view).await;
    update_worker_state(fixture.directory.path(), |state| {
        state["modelsFail"] = json!(true)
    });
    reopen_section(&mut view).await;
    button(&mut view, "Disable Codex").await;
    click(&mut view, "Close settings").await;
    model_choices(&mut view).await;
    button(&mut view, "Use fixture-model-alt · NSH fixture").await;
    assert!(
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Use External model · Native CLI · codex"),
        "failed external discovery must not retain stale external choices"
    );
    click(&mut view, "Use fixture-model-alt · NSH fixture").await;
    wait_view_state(&mut view, |view, _| model_menu_closed(view)).await;
    let observed = client
        .query("agent", "observe", json!({"sessionId":fixture.session}))
        .await
        .unwrap();
    assert_eq!(observed["session"]["backend"]["kind"], "model");
    wait_view_state(&mut view, |view, _| composer_sandbox(view) == Some(true)).await;

    open_settings(&mut view).await;
    toggle_runtime(&mut view, &client, "codex", "Codex", false).await;
    let settled = requests(fixture.directory.path());
    reopen_section(&mut view).await;
    button(&mut view, "Enable Codex").await;
    click(&mut view, "Close settings").await;
    model_choices(&mut view).await;
    button(&mut view, "Use fixture-model · NSH fixture").await;
    assert_eq!(
        requests(fixture.directory.path()),
        settled,
        "disabled runtimes must not launch native processes"
    );
    drop(view);
    bindings.close().await.unwrap();
    client.close().await.unwrap();
    fixture.finish().await;
}
