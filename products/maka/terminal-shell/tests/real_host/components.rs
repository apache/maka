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
async fn thinking_disclosure_renders_inline_markdown_and_keeps_formatted_body() {
    let mut view = component("thinking-markdown").await;
    let title = "Thinking · Opening Reddit homepage";
    wait_enabled_node(&mut view, title).await;
    let screen = view.snapshot();
    assert!(screen.contains("Opening Reddit homepage"));
    assert!(!screen.contains("Thinking ·"));
    assert!(!screen.contains("**Opening Reddit homepage**"));
    support::click_button(&mut view, title).await;
    let screen = wait_view(&mut view, |screen| {
        screen.contains("Checking local models and AI coding.")
    })
    .await;
    assert!(!screen.contains("**Opening Reddit homepage**"));
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composer_details_switch_without_expanding_updates_or_losing_queue_edits() {
    let mut view = component("composer-details").await;
    support::wait_enabled_button(&mut view, "Toggle conversation todo").await;
    support::wait_enabled_button(&mut view, "Toggle computer access").await;
    support::wait_enabled_button(&mut view, "Queued messages").await;
    assert!(!view.snapshot().contains("Fixture App one"));
    assert!(!view.snapshot().contains("TODO_NEXT"));
    assert!(!view.snapshot().contains("QUEUED_ORIGINAL"));
    support::evidence("composer-details-collapsed", &view.snapshot());
    support::evidence_cells("composer-details-collapsed", &view);
    view.resize(60, 24);
    tab_to_label(&mut view, "Queued messages").await;
    support::click_button(&mut view, "Queued messages").await;
    wait_view(&mut view, |screen| screen.contains("QUEUED_ORIGINAL")).await;
    support::evidence("composer-details-narrow", &view.snapshot());
    support::evidence_cells("composer-details-narrow", &view);
    support::click_button(&mut view, "Queued messages").await;
    view.resize(120, 36);

    support::click_button(&mut view, "Toggle computer access").await;
    wait_view(&mut view, |screen| screen.contains("Fixture App one")).await;
    support::click_button(&mut view, "Stop access to Fixture App one").await;
    wait_view(&mut view, |screen| {
        screen.contains("stopped:one") && screen.contains("Access stopped for this turn")
    })
    .await;
    support::click_button(&mut view, "Toggle computer access").await;
    wait_view(&mut view, |screen| !screen.contains("Fixture App one")).await;

    support::click_button(&mut view, "Queued messages").await;
    support::click_button(&mut view, "Edit queued message 1").await;
    wait_focused_input(&mut view, "Queued message editor").await;
    shortcut(&mut view, 'a');
    view.handle_event(TerminalEvent::Paste("UNSAVED_QUEUE_EDIT".into()));
    commit_native_events(&mut view).await;
    support::click_button(&mut view, "Toggle conversation todo").await;
    wait_view(&mut view, |screen| {
        screen.contains("TODO_NEXT") && !screen.contains("UNSAVED_QUEUE_EDIT")
    })
    .await;
    support::click_button(&mut view, "Add computer access").await;
    wait_view(&mut view, |screen| {
        screen.contains("TODO_NEXT") && !screen.contains("Fixture App two")
    })
    .await;
    assert!(
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Queued message editor")
    );
    support::evidence("composer-details-todo", &view.snapshot());
    support::evidence_cells("composer-details-todo", &view);

    support::click_button(&mut view, "Queued messages").await;
    wait_view_state(&mut view, |view, _| {
        view.surface()
            .input_context()
            .is_some_and(|input| input.text.as_deref() == Some("UNSAVED_QUEUE_EDIT"))
    })
    .await;
    support::click_button(&mut view, "Drain queued messages").await;
    support::click_button(&mut view, "Toggle computer access").await;
    wait_view(&mut view, |screen| {
        screen.contains("Fixture App one") && !screen.contains("UNSAVED_QUEUE_EDIT")
    })
    .await;
    support::evidence("composer-details-access", &view.snapshot());
    support::evidence_cells("composer-details-access", &view);
    support::click_button(&mut view, "Queued messages").await;
    wait_view_state(&mut view, |view, screen| {
        screen.contains("Message no longer queued")
            && view
                .surface()
                .input_context()
                .is_some_and(|input| input.text.as_deref() == Some("UNSAVED_QUEUE_EDIT"))
    })
    .await;
    support::click_button(&mut view, "Cancel queued message edit").await;
    wait_view_state(&mut view, |view, _| {
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Queued messages")
    })
    .await;

    support::click_button(&mut view, "Toggle computer access").await;
    support::click_button(&mut view, "Clear computer access").await;
    wait_view_state(&mut view, |view, _| {
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Toggle computer access")
    })
    .await;
    wait_view(&mut view, |screen| {
        screen.contains("TODO_CURRENT") && !screen.contains("TODO_NEXT")
    })
    .await;
    support::click_button(&mut view, "Restore computer access").await;
    support::wait_enabled_button(&mut view, "Toggle computer access").await;
    assert!(!view.snapshot().contains("Fixture App one"));
    assert!(
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Message composer")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plan_proposal_opens_for_approval_and_then_shows_its_progress() {
    let mut view = component("composer-plan").await;
    // A proposal awaiting approval opens the plan without a click.
    wait_view(&mut view, |screen| {
        screen.contains("PLAN_STEP_ONE_DETAIL") && screen.contains("PLAN_RISK")
    })
    .await;
    support::evidence("composer-plan-proposal", &view.snapshot());
    support::evidence_cells("composer-plan-proposal", &view);
    support::click_button(&mut view, "Planning mode").await;
    wait_view(&mut view, |screen| screen.contains("mode:plan")).await;
    support::click_button(&mut view, "Approve and execute").await;
    wait_view(&mut view, |screen| {
        screen.contains("plan:approve:proposal-one:1") && screen.contains("1/2")
    })
    .await;
    assert!(
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Approve and execute")
    );
    support::evidence("composer-plan-running", &view.snapshot());
    support::evidence_cells("composer-plan-running", &view);
    support::click_button(&mut view, "Cancel Plan").await;
    // The step the model left in progress no longer looks like it is running.
    wait_view(&mut view, |screen| {
        screen.contains("plan:cancel:execution-one") && screen.contains("Plan cancelled")
    })
    .await;
    assert!(!view.snapshot().contains('◌'), "{}", view.snapshot());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_status_icons_keep_accessible_meanings_without_inline_labels() {
    let mut view = component("tool-statuses").await;
    let labels = [
        "Recorded",
        "Unknown",
        "Error",
        "Rejected",
        "Dispatched",
        "Input recorded",
        "Running tool",
    ];
    let screen = wait_view_state(&mut view, |view, _| {
        let nodes = view.accessibility_snapshot();
        labels
            .iter()
            .all(|label| nodes.iter().any(|node| node.label == *label))
    })
    .await;
    for label in labels {
        assert!(
            !screen.contains(label),
            "status should be an icon, not inline text: {label}"
        );
    }
    assert!(
        screen.contains('?'),
        "unknown results need the question-mark icon"
    );
}
