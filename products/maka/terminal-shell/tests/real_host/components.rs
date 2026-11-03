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
    wait_view(&mut view, |screen| screen.contains("Live activity-11")).await;
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
async fn thinking_disclosure_renders_inline_markdown_and_keeps_formatted_body() {
    let mut view = component("thinking-markdown").await;
    let title = "Thinking · Opening Reddit homepage";
    wait_enabled_node(&mut view, title).await;
    let screen = view.snapshot();
    assert!(screen.contains("Opening Reddit homepage"));
    assert!(!screen.contains("Thinking ·"));
    assert!(!screen.contains("**Opening Reddit homepage**"));
    support::click_button(&mut view, title).await;
    wait_view(&mut view, |screen| {
        screen.contains("Checking local models and AI coding.")
            && !screen.contains("**Opening Reddit homepage**")
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
    let screen = view.snapshot();
    let line = |label: &str| {
        screen
            .lines()
            .find(|line| line.contains(label))
            .unwrap_or_default()
            .to_owned()
    };
    assert!(line("Context compacted").contains('─'), "{screen}");
    // The Host's Plan opening names the Plan on the same kind of line, without
    // its frozen request or the user's message actions.
    assert!(
        line("Executing plan: FIXTURE_PLAN").contains('─'),
        "{screen}"
    );
    assert!(
        !screen.contains("Execute the user-approved plan"),
        "{screen}"
    );
    assert!(
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Copy user message")
    );
    support::click_button(&mut view, "Use Chinese").await;
    wait_view(&mut view, |screen| {
        screen.contains("执行计划：FIXTURE_PLAN")
    })
    .await;
    assert!(!view.snapshot().contains("Executing plan:"));
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn context_statistics_keep_output_speed_including_zero_when_metrics_update() {
    let mut view = component("context-gauge").await;
    wait_view_state(&mut view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Context ≈584.3k / 500.0k · 117% · 100.5 tok/s")
    })
    .await;
    support::click_button(&mut view, "Update output speed").await;
    wait_view_state(&mut view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Context ≈584.3k / 500.0k · 117% · 0.0 tok/s")
    })
    .await;
}
