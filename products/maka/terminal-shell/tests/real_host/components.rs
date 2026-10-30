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
use crossterm::event::Event as TerminalEvent;
use nsh_core::prelude::*;

#[class]
struct Presentation {
    scenario: String,
}
#[class]
impl Presentation {
    #[getter]
    pub fn system_locale(&self) -> String {
        "en".into()
    }
    #[getter]
    pub fn ui_scale_factor(&self) -> f32 {
        1.0
    }
    #[getter]
    pub fn scenario(&self) -> String {
        self.scenario.clone()
    }
}

async fn component(scenario: &'static str) -> AppView {
    let mut registry = Registry::ui_set("maka/host");
    registry.value("host", move || {
        Instance::new(Presentation {
            scenario: scenario.into(),
        })
    });
    let description = (&registry).into();
    let bundle = tokio::task::spawn_blocking(move || {
        nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../terminal-shell/tests/fixtures/components.tsx"),
            minify: false,
            split: false,
            ui_sets: vec![nsh_base::registry().into(), description],
        })
        .unwrap()
    })
    .await
    .unwrap();
    let mut view = AppView::new(nsh_platform_tui::AppOptions {
        size: (120, 36),
        ..Default::default()
    });
    view.load_with_config(nsh_engine::EngineConfig {
        ui_sets: vec![nsh_base::registry(), registry],
        runtime: Some(tokio::runtime::Handle::current()),
        ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
    })
    .unwrap();
    view
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sandbox_choice_preserves_the_original_session_and_approval_setting() {
    let mut view = component("sandbox").await;
    support::click_button(&mut view, "Sandbox and approvals").await;
    support::click_button(&mut view, "Workspace write").await;
    wait_view(&mut view, |screen| {
        screen.contains("original-session:7:workspace_write:true")
    })
    .await;
    assert!(
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Workspace write" && node.state.selected)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capability_dialog_displays_the_boundary_and_answers_its_original_request() {
    let mut view = component("consent").await;
    wait_view(&mut view, |screen| {
        screen.contains("Computer access for this session")
            && screen.contains("Permission boundary: 3")
    })
    .await;
    support::click_button(&mut view, "Allow").await;
    wait_view(&mut view, |screen| {
        screen.contains("original-session:original-consent:allow")
            && screen.contains("Capability allowed")
    })
    .await;
    assert!(
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Allow" && !node.state.disabled)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composer_slash_command_and_workspace_reference_edit_the_native_draft() {
    let mut view = component("composer").await;
    wait_editable_composer(&mut view).await;
    view.handle_event(TerminalEvent::Paste("/insp".into()));
    support::click_button(&mut view, "Inspect draft").await;
    wait_view(&mut view, |screen| screen.contains("command:inspect")).await;
    wait_view_state(&mut view, |view, _| {
        view.surface()
            .input_context()
            .is_some_and(|input| input.text.as_deref() == Some(""))
    })
    .await;
    view.handle_event(TerminalEvent::Paste("check @docs/Rel".into()));
    support::click_button(&mut view, "docs/Release Notes.md").await;
    wait_view_state(&mut view, |view, screen| {
        screen.contains("files:Rel:ZG9jcw==")
            && view.surface().input_context().is_some_and(|input| {
                input.text.as_deref() == Some("check @\"docs/Release Notes.md\" ")
            })
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skill_completion_is_inserted_and_backspace_deletes_the_whole_native_chip() {
    let mut view = component("composer").await;
    wait_editable_composer(&mut view).await;
    view.handle_event(TerminalEvent::Paste("before /skill:rev".into()));
    support::click_button(&mut view, "Review changes").await;
    wait_view_state(&mut view, |view, _| {
        view.surface()
            .input_context()
            .is_some_and(|input| input.text.as_deref() == Some("before /skill:review "))
    })
    .await;
    view.handle_event(TerminalEvent::Key(KeyEvent::new(
        KeyCode::Backspace,
        KeyModifiers::NONE,
    )));
    commit_native_events(&mut view).await;
    view.handle_event(TerminalEvent::Key(KeyEvent::new(
        KeyCode::Backspace,
        KeyModifiers::NONE,
    )));
    wait_view_state(&mut view, |view, _| {
        view.surface()
            .input_context()
            .is_some_and(|input| input.text.as_deref() == Some("before "))
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_waiting_keeps_background_elapsed_time_and_completion_uses_recorded_duration() {
    let mut view = component("compaction").await;
    support::click_button(&mut view, "Wait for background compaction").await;
    wait_view(&mut view, |screen| {
        screen.contains("Compacting context… (2m ")
    })
    .await;
    support::click_button(&mut view, "Complete compaction").await;
    wait_view(&mut view, |screen| {
        screen.contains("Context compacted (2m 6s)") && !screen.contains("Compacting context")
    })
    .await;
}
