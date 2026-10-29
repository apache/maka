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

async fn editable_composer(view: &mut AppView) {
    tab_to_label(view, "Message composer").await;
    wait_editable_composer(view).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn final_actions_use_original_turn_accounting_and_fork_before_a_later_active_turn() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        let original = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let metadata = support::mutate(&client, "metadata", json!({
            "sessionId":fixture.session,"expectedRevision":original["session"]["revision"],
            "title":"NSH real Agent","labels":["original-label"]
        })).await;
        assert_eq!(metadata["kind"], "committed");
        let first = support::mutate(&client, "send", json!({
            "sessionId":fixture.session,"message":"First complete turn 中文","model":fixture.selection
        })).await;
        assert_eq!(first["kind"], "started");
        let mut first_request = fixture.next_request().await;
        first_request.delta("# FINAL_A\n\n**完整原文 中文😀**").await;
        first_request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        let first_observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let first_history = client.query("agent", "history", json!({"sessionId":fixture.session,"through":first_observed["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        let final_row = first_history["chunks"].as_array().unwrap().iter().find(|row| row["finalOutput"] == true).unwrap();
        let first_turn = final_row["turnId"].as_str().unwrap().to_owned();
        assert_eq!(final_row["timing"]["finished"]["outcome"], "completed");
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_view_state(&mut view, |view, screen| screen.contains("FINAL_A") && screen.contains("fixture-model") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Fork from this turn" && !node.state.disabled && node.frame.origin.y.0 >= 0.0 && node.frame.origin.y.0 < view.surface().viewport().height.0)).await;
        tab_to_label(&mut view, "View this turn's model usage").await;
        let usage_opener = view.surface().focused().unwrap();
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        let usage = wait_view(&mut view, |screen| screen.contains("1 main model request in this turn") && screen.contains("Output tokens")).await;
        // Accessibility is scoped to the active dialog; the terminal line can
        // also contain conversation text painted outside its bounds.
        let nodes = view.accessibility_snapshot();
        for (label, expected) in [
            ("Input tokens", "1"),
            ("Output tokens", "2"),
            ("Reasoning tokens", "0"),
            ("Cache read tokens", "0"),
            ("Cache write tokens", "Unavailable"),
            ("Recorded cost", "Unavailable"),
        ] {
            let field = nodes.iter().find(|node| node.label == label).unwrap();
            let values: Vec<_> = nodes.iter().filter(|node| {
                node.frame.origin.y == field.frame.origin.y
                    && node.frame.origin.x.0 >= field.frame.origin.x.0 + field.frame.size.width.0
            }).collect();
            assert_eq!(values.len(), 1, "expected one visible {label} value:\n{usage}");
            let value = values[0];
            assert_eq!(value.label, expected, "{label} did not retain its exact counter");
            let row = (value.frame.origin.y.0 / view.surface().metrics().height().0 - 0.5).ceil() as usize;
            assert_eq!(support::painted_text(&view, &value.label, row).trim(), expected, "{label} did not paint its exact counter: frame={:?}, metrics={:?}, row={row}\n{usage}", value.frame, view.surface().metrics());
        }
        evidence("final-actions-original-main-usage", &usage);
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, screen| {
            !screen.contains("Main model usage")
                && view.accessibility_snapshot().iter().any(|node| node.id == usage_opener && node.focused)
        }).await;
        assert!(view.accessibility_snapshot().iter().any(|node| node.focused && node.label == "View this turn's model usage"));
        editable_composer(&mut view).await;
        assert!(view.handle_event(Event::Paste("父会话草稿 stays here".into())));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("父会话草稿 stays here"));
        support::wait_draft(&client, &fixture.session, "父会话草稿 stays here").await;

        // This press tests metadata identity, so give both short turns room
        // before measuring its target. A bottom-following reader in the
        // original short viewport correctly scrolls when the next turn lands.
        let viewport = view.surface().viewport();
        let metrics = view.surface().metrics();
        let original_size = ((viewport.width.0 / metrics.width().0).round() as u16, (viewport.height.0 / metrics.height().0).round() as u16);
        view.resize(original_size.0, original_size.1.max(60));
        wait_mode_layout(&mut view).await;
        // Keep one physical usage press while the next turn advances the
        // history metadata fence. This completed reply still owns that action.
        let usage_button = support::wait_enabled_button(&mut view, "View this turn's model usage").await;
        let column = (usage_button.frame.origin.x.0 / 8.0 - 0.5).ceil().max(0.0) as u16;
        let row = (usage_button.frame.origin.y.0 / 16.0 - 0.5).ceil().max(0.0) as u16;
        view.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }));

        let second = support::mutate(&client, "send", json!({
            "sessionId":fixture.session,"message":"LATER_B must not be copied","model":fixture.selection
        })).await;
        assert_eq!(second["kind"], "started");
        let mut second_request = fixture.next_request().await;
        second_request.delta("ACTIVE_B is still streaming").await;
        wait_view_state(&mut view, |view, screen| screen.contains("ACTIVE_B") && screen.contains("LATER_B must not be copied") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Fork from this turn" && !node.state.disabled && node.frame.origin.y.0 >= 0.0 && node.frame.origin.y.0 < view.surface().viewport().height.0)).await;
        let current_usage = support::wait_enabled_button(&mut view, "View this turn's model usage").await;
        assert_eq!(current_usage.id, usage_button.id, "the original completed reply must retain its native action owner");
        assert_eq!(current_usage.frame, usage_button.frame, "this held press must cross a metadata update without moving its target");
        view.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }));
        wait_view(&mut view, |screen| screen.contains("Main model usage") && screen.contains("1 main model request in this turn")).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| !screen.contains("Main model usage")).await;
        let after_close = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(after_close["run"]["invocationId"], second["invocationId"], "Escape in turn usage must close its dialog without stopping the active turn");
        view.resize(original_size.0, original_size.1);
        wait_mode_layout(&mut view).await;
        support::click_button(&mut view, "Fork from this turn").await;
        let forked = wait_view(&mut view, |screen| screen.contains("Fork · NSH real Agent") && screen.contains("FINAL_A") && !screen.contains("ACTIVE_B")).await;
        let listed = client.query("agent", "list", json!({"filter":"all","scope":{"kind":"all"},"titleQuery":"Fork · NSH real Agent","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);
        let fork = &listed["sessions"][0];
        let fork_id = fork["id"].as_str().unwrap().to_owned();
        assert_ne!(fork_id, fixture.session);
        assert_eq!(fork["branch"]["sessionId"], fixture.session);
        assert_eq!(fork["branch"]["position"]["turnId"], first_turn);
        assert_eq!(fork["labels"], json!(["original-label"]));
        let current = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(current["run"]["invocationId"], second["invocationId"]);
        let child = client.query("agent", "observe", json!({"sessionId":fork_id})).await.unwrap();
        let copied = client.query("agent", "history", json!({"sessionId":fork_id,"through":child["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        assert!(copied.to_string().contains("FINAL_A"));
        assert!(!copied.to_string().contains("LATER_B"));
        assert!(!copied.to_string().contains("ACTIVE_B"));
        support::wait_draft(&client, &fixture.session, "父会话草稿 stays here").await;
        editable_composer(&mut view).await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(""), "the fork's native editor must not inherit the parent's draft");
        assert!(client.load_draft("agent", &fork_id, EDITOR).await.unwrap().is_none(), "a fork that has never been edited has no persisted draft");
        evidence("final-actions-fork-excludes-later-active-turn", &forked);

        view.resize(80, 24);
        wait_view_state(&mut view, |view, screen| screen.contains("FINAL_A") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "View this turn's model usage" && !node.state.disabled && node.frame.origin.y.0 >= 0.0 && node.frame.origin.y.0 < view.surface().viewport().height.0)).await;
        activate(&mut view, "View this turn's model usage").await;
        let copied_usage = wait_view(&mut view, |screen| screen.contains("No model usage is recorded for this turn")).await;
        assert!(!copied_usage.contains("Input tokens"), "copied history must not invent provider counters:\n{copied_usage}");
        evidence("final-actions-copied-history-usage-unavailable-80x24", &copied_usage);
        activate(&mut view, "Close turn usage").await;
        editable_composer(&mut view).await;
        assert!(view.handle_event(Event::Paste("独立分支草稿".into())));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("独立分支草稿"));
        support::wait_draft(&client, &fork_id, "独立分支草稿").await;
        support::wait_draft(&client, &fixture.session, "父会话草稿 stays here").await;
        second_request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2, "actions must not replay model calls");
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("original final-action flow did not settle");
}
