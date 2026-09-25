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
use std::path::Path;

/// Reuse the production anonymous-provider onboarding controls. The independent
/// client observes the catalog; it does not prepare WorkHub's model settings.
pub(super) fn connection(
    tui: &mut Pty,
    runtime: &tokio::runtime::Runtime,
    client: &maka_client::Client,
    url: &str,
) {
    tui.wait_for("Settings");
    tui.click_text("Settings");
    tui.wait_for("Models");
    tui.click_text("Models");
    tui.wait_for("Model connections");
    tui.click_text("Model connections");
    tui.wait_for("No model connections yet.");
    tui.click_text("⊕");
    tui.wait_for("Add anonymous model connection");
    let directory = runtime
        .block_on(client.provider_directory(maka_protocol::model_provider::Scope::Profile))
        .unwrap();
    let label = &directory
        .entries
        .iter()
        .find(|entry| entry.descriptor.anonymous && entry.identity.name == "lm-studio")
        .unwrap()
        .descriptor
        .label;
    tui.wait_until(|screen| !screen.contains("Loading providers…") && screen.contains(" ▾"));
    tui.click_text(" ▾");
    let choices = ["○", "●"].map(|marker| format!("{marker} {label}"));
    tui.wait_until(|s| choices.iter().any(|choice| s.contains(choice)));
    let shown = tui.screen.snapshot().unwrap().screen;
    tui.click_text(
        choices
            .iter()
            .find(|choice| shown.contains(*choice))
            .unwrap(),
    );
    tui.wait_for(&format!("{label} ▾"));
    tui.click_text("Name (optional)");
    tui.send(b"WorkHub fixture");
    tui.click_text("Configuration (JSON)");
    tui.send(format!("\x01\x1b[200~{}\x1b[201~", json!({"baseUrl":url})).as_bytes());
    tui.click_last_text("Verify");
    tui.wait_for("Choose models");
    for model in ["fixture-model", "worker-model"] {
        tui.click_text(model);
        tui.wait_for(&format!("[✓] {model}"));
    }
    tui.click_last_text("Save connection");
    tui.wait_until(|s| !s.contains("Save connection") && s.contains("WorkHub fixture"));
    let catalog =
        runtime
            .block_on(client.connection_catalog(
                maka_protocol::configuration::ConnectionCatalogQueryInput::Start,
            ))
            .unwrap();
    assert_eq!(catalog["connectionCount"], 1);
    assert_eq!(catalog["defaultTarget"]["modelId"], "fixture-model");
}

pub(super) fn hub(
    tui: &mut Pty,
    runtime: &tokio::runtime::Runtime,
    client: &maka_client::Client,
    workspace: &Path,
) {
    open(tui);
    tui.wait_for("Set up WorkHub");
    tui.click_page_text("Set up WorkHub");
    tui.wait_for("Allow plugin access?");
    tui.click_text("Cancel");
    tui.wait_until(|s| !s.contains("Allow plugin access?") && s.contains("Set up WorkHub"));
    runtime.block_on(async {
        assert!(
            readback::hub(client, "query", Value::Null).await["coordinatorSessionId"].is_null()
        );
        assert_eq!(
            readback::hub(client, "assignments", json!({"after":null})).await["entries"],
            json!([])
        );
        let sessions = client
            .session_catalog(maka_protocol::session::SessionCatalogQueryInput::ListStart)
            .await
            .unwrap();
        let maka_protocol::session::SessionCatalogQueryResult::Page { sessions, .. } = sessions
        else {
            panic!("sessions")
        };
        assert!(
            sessions.is_empty(),
            "cancelled consent cannot create the coordinator"
        );
    });
    tui.click_page_text("Set up WorkHub");
    tui.wait_for("Allow plugin access?");
    tui.click_text("Allow and continue");
    tui.wait_for("Coordinator conversation");
    tui.click_page_text("New task setup");
    tui.wait_for("Find a model or executor");
    tui.click_page_text("worker-model");
    tui.wait_for("Directory or project ID");
    tui.click_page_text("Directory or project ID");
    tui.send(format!("\x1b[200~{}\x1b[201~", workspace.display()).as_bytes());
    tui.click_page_text("Use this configuration");
    tui.wait_for("Allow plugin access?");
    tui.click_text("Cancel");
    tui.wait_until(|s| !s.contains("Allow plugin access?") && s.contains("Use this configuration"));
    assert!(
        runtime
            .block_on(readback::creation(&workspace.join("root")))
            .is_none()
    );
    assert_eq!(
        runtime.block_on(readback::hub(client, "assignments", json!({"after":null})))["entries"],
        json!([])
    );
    tui.click_page_text("Use this configuration");
    tui.wait_for("Allow plugin access?");
    tui.click_text("Allow and continue");
    tui.wait_for("Coordinator conversation");
    let saved = runtime
        .block_on(readback::creation(&workspace.join("root")))
        .unwrap();
    assert_eq!(
        saved["authorization"]["workspace"],
        json!({"kind":"host_path","path":workspace})
    );
    assert_eq!(
        saved["settings"]["target"]["model"]["model"],
        "worker-model"
    );
}

pub(super) fn delegate(tui: &mut Pty, name: &str) {
    tui.click_page_text("Coordinator conversation");
    tui.wait_for("Message…");
    tui.click_page_text("Message…");
    tui.send(format!("Delegate {name}\r").as_bytes());
    tui.wait_until(|screen| {
        screen.contains("Coordinator checked the task") || screen.contains("Not sent · Draft kept")
    });
    if tui
        .screen
        .snapshot()
        .unwrap()
        .screen
        .contains("Not sent · Draft kept")
    {
        // The bottom feedback detail, not the session information in the header.
        tui.click_last_text("ⓘ");
        tui.wait_for("Not accepted · Draft kept");
        panic!(
            "coordinator Chat rejected {name}:\n{}",
            tui.screen.snapshot().unwrap().screen
        );
    }
}

#[track_caller]
pub(super) fn open_task(tui: &mut Pty, title: &str) {
    open(tui);
    tui.wait_until(|s| {
        page_contains(s, "Coordinator conversation") || page_contains(s, "Change task model")
    });
    if !page_contains(
        &tui.screen.snapshot().unwrap().screen,
        "Coordinator conversation",
    ) {
        tui.click_last_text("‹ Back");
        wait_page_text(tui, "Coordinator conversation");
    }
    select_task(tui, title);
}

#[track_caller]
pub(super) fn select_task(tui: &mut Pty, title: &str) {
    wait_page_text(tui, "Coordinator conversation");
    let visible = page_contains(&tui.screen.snapshot().unwrap().screen, title);
    eprintln!("WorkHub board selecting {title}; already displayed={visible}");
    // Reopening an already selected filter retires its current view. A title
    // on that old frame cannot acknowledge the subsequent navigation/read.
    if !visible {
        tui.click_page_text("All");
        wait_page_text(tui, title);
    }
    tui.click_page_text(title);
    wait_page_text(tui, "Change task model");
}

#[track_caller]
pub(super) fn wait_page_text(tui: &mut Pty, text: &str) {
    // Use the same page boundary as Pty::click_page_text. The task session's
    // sidebar title can appear before the new board filter has been rendered.
    tui.wait_until(|screen| page_contains(screen, text));
}

fn page_contains(screen: &str, text: &str) -> bool {
    screen.lines().any(|line| {
        let page = line.split_once('│').map_or(line, |(_, page)| page);
        page.contains(text)
    })
}

pub(super) fn ascii(tui: &mut Pty) {
    tui.click_text("Settings");
    tui.wait_for("Interface");
    tui.click_text("Interface");
    tui.wait_for("Unicode ▾");
    tui.click_text("Icons");
    tui.wait_for("○ ASCII");
    tui.send(b"\x1b[B\r");
    tui.wait_for("ASCII v");
    tui.send(b"\x1b[1;3D");
    tui.wait_for("Model connections");
    // Both Settings categories are real locations. The second Back restores
    // the selected task and its nested view without reopening its default list.
    tui.send(b"\x1b[1;3D");
}

pub(super) fn localized(root: &Path, locale: &str, coordinator: &str, setup: &str) {
    let mut tui = Pty::spawn(&["--root", root.to_str().unwrap(), "--locale", locale]);
    open(&mut tui);
    tui.wait_for(coordinator);
    tui.resize(100, 38);
    tui.wait_for(setup);
    tui.close_terminal();
    tui.finish();
}

// Match the app's sidebar entry, not a connection or coordinator named WorkHub.
fn open(tui: &mut Pty) {
    let labels = ["◈  WorkHub", "H  WorkHub"];
    tui.wait_until(|screen| labels.iter().any(|label| screen.contains(label)));
    let screen = tui.screen.snapshot().unwrap().screen;
    tui.click_text(
        labels
            .into_iter()
            .find(|label| screen.contains(label))
            .unwrap(),
    );
}
