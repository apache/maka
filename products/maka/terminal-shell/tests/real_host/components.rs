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
async fn activity_resumes_following_after_reading_an_expanded_tool() {
    let mut view = component("activity-follow").await;
    wait_view(&mut view, |screen| screen.contains("Live activity-10")).await;
    support::click_button(&mut view, "Read older activity").await;
    support::click_button(&mut view, "Toggle tool Tool details").await;
    wait_view(&mut view, |screen| screen.contains("Tool source line 1")).await;
    support::click_button(&mut view, "Append activity").await;
    wait_view(&mut view, |screen| screen.contains("Activity count: 11")).await;
    assert!(view.snapshot().contains("Tool source line 1"));
    assert!(!view.snapshot().contains("Live activity-11"));

    let list = view
        .accessibility_snapshot()
        .into_iter()
        .find(|node| node.label == "Turn activity")
        .unwrap();
    let column = ((list.frame.origin.x.0 + list.frame.size.width.0) / 8.0).ceil() as u16 - 1;
    let row = (list.frame.origin.y.0 / 16.0).ceil() as u16 + 1;
    for _ in 0..40 {
        view.handle_event(TerminalEvent::Mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::ScrollDown,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }));
        view.poll().unwrap();
        support::tick(&mut view);
        tokio::task::yield_now().await;
    }
    wait_view(&mut view, |screen| {
        screen.contains("Live activity-11")
            && screen.contains("Following latest")
            && screen.contains("At activity end")
    })
    .await;
    support::click_button(&mut view, "Append activity").await;
    wait_view(&mut view, |screen| screen.contains("Live activity-12")).await;

    support::click_button(&mut view, "One line above latest").await;
    wait_view(&mut view, |screen| screen.contains("Above activity end")).await;
    support::click_button(&mut view, "Append activity").await;
    wait_view(&mut view, |screen| {
        screen.contains("Live activity-13") && screen.contains("At activity end")
    })
    .await;

    let terminal_rows = 100;
    view.resize(120, terminal_rows);
    let activity_height = f32::from(terminal_rows) * 16.0 / 2.0;
    wait_view_state(&mut view, |view, screen| {
        screen.contains("Live activity-13")
            && screen.contains("At activity end")
            && view.accessibility_snapshot().iter().any(|node| {
                node.label == "Turn activity" && node.frame.size.height.0 == activity_height
            })
    })
    .await;
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
    support::click_button(&mut view, "/inspect").await;
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
async fn composer_tab_accepts_prediction_as_an_undoable_draft_then_navigates() {
    let mut view = component("composer-prediction").await;
    wait_editable_composer(&mut view).await;
    wait_enabled_node(&mut view, "Use suggested message").await;
    view.handle_event(TerminalEvent::Key(KeyEvent::new(
        KeyCode::Tab,
        KeyModifiers::NONE,
    )));
    wait_view_state(&mut view, |view, screen| {
        screen.contains("No command")
            && view
                .surface()
                .input_context()
                .is_some_and(|input| input.text.as_deref() == Some("Review the changes."))
            && !view
                .accessibility_snapshot()
                .iter()
                .any(|node| node.label == "Use suggested message")
    })
    .await;
    view.handle_event(TerminalEvent::Key(KeyEvent::new(
        KeyCode::Tab,
        KeyModifiers::NONE,
    )));
    wait_view_state(&mut view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.focused && node.label != "Message composer")
    })
    .await;
    view.handle_event(TerminalEvent::Key(KeyEvent::new(
        KeyCode::BackTab,
        KeyModifiers::SHIFT,
    )));
    wait_focused_input(&mut view, "Message composer").await;
    shortcut(&mut view, 'z');
    wait_view_state(&mut view, |view, _| {
        view.surface()
            .input_context()
            .is_some_and(|input| input.text.as_deref() == Some(""))
    })
    .await;
    view.handle_event(TerminalEvent::Key(KeyEvent::new(
        KeyCode::Tab,
        KeyModifiers::NONE,
    )));
    wait_view_state(&mut view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.focused && node.label != "Message composer")
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composer_prediction_preserves_reverse_tab_and_escape_restores_forward_tab() {
    let mut view = component("composer-prediction").await;
    wait_editable_composer(&mut view).await;
    wait_enabled_node(&mut view, "Use suggested message").await;
    view.handle_event(TerminalEvent::Key(KeyEvent::new(
        KeyCode::BackTab,
        KeyModifiers::SHIFT,
    )));
    wait_view_state(&mut view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.focused && node.label != "Message composer")
    })
    .await;
    view.handle_event(TerminalEvent::Key(KeyEvent::new(
        KeyCode::Tab,
        KeyModifiers::NONE,
    )));
    wait_focused_input(&mut view, "Message composer").await;
    assert_eq!(
        view.surface().input_context().unwrap().text.as_deref(),
        Some("")
    );
    wait_enabled_node(&mut view, "Use suggested message").await;
    view.handle_event(TerminalEvent::Key(KeyEvent::new(
        KeyCode::Esc,
        KeyModifiers::NONE,
    )));
    wait_view_state(&mut view, |view, _| {
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Use suggested message")
    })
    .await;
    view.handle_event(TerminalEvent::Key(KeyEvent::new(
        KeyCode::Tab,
        KeyModifiers::NONE,
    )));
    wait_view_state(&mut view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.focused && node.label != "Message composer")
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skill_completion_is_inserted_and_backspace_deletes_the_whole_native_chip() {
    let mut view = component("composer").await;
    wait_editable_composer(&mut view).await;
    view.handle_event(TerminalEvent::Paste("before /skill:rev".into()));
    wait_view_state(&mut view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label == "skills:rev:original-route:fixture-model")
    })
    .await;
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
