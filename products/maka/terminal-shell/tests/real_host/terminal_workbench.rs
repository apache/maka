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
use ratatui::{buffer::Buffer, layout::Rect, style::Color};

fn assert_colored_output(view: &AppView) {
    let viewport = view.surface().viewport();
    let area = Rect::new(
        0,
        0,
        (viewport.width.0 / 8.0) as u16,
        (viewport.height.0 / 16.0) as u16,
    );
    let mut buffer = Buffer::empty(area);
    view.render(area, &mut buffer);
    let cells: Vec<_> = buffer
        .content
        .iter()
        .filter(|cell| matches!(cell.symbol(), "中" | "文" | "终" | "端"))
        .collect();
    assert_eq!(
        cells.iter().map(|cell| cell.symbol()).collect::<String>(),
        "中文终端"
    );
    assert!(
        cells
            .iter()
            .all(|cell| cell.fg == Color::Rgb(163, 215, 165)),
        "the original PTY's SGR green must reach the actual Unicode cells"
    );
}

fn stop_evidence(view: &AppView, phase: &str, resource: &Value) {
    let screen = view.snapshot();
    evidence(&format!("terminal-workbench-{phase}"), &screen);
    let buttons: Vec<_> = view
        .accessibility_snapshot()
        .into_iter()
        .filter(|node| node.role == nsh_core::AccessibilityRole::Button)
        .collect();
    eprintln!("terminal workbench {phase}: Host {resource}\n{screen}\nButtons: {buttons:#?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn original_pty_workbench_keeps_its_output_and_chat_draft_across_reopening() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::configured(support::Options {
            services: support::Services::Terminals,
            ..Default::default()
        })
        .await;
        let client = fixture.client().await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.resize(120, 40);
        wait_focused_input(&mut view, "Message composer").await;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                support::tick(&mut view);
                if view
                    .surface()
                    .input_context()
                    .is_some_and(|context| context.editable)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the composer did not finish loading its saved draft");
        view.handle_event(Event::Paste("WORKBENCH_UNSENT_DRAFT".into()));
        support::wait_draft(&client, &fixture.session, "WORKBENCH_UNSENT_DRAFT").await;
        let composer = view.surface().focused().unwrap();

        support::click_button(&mut view, "Browse workspace files").await;
        support::click_button(&mut view, "Show conversation terminals").await;
        support::click_button(&mut view, "Start interactive terminal").await;
        support::click_button(&mut view, "Focus terminal input").await;
        wait_focused_input(&mut view, "Terminal keyboard input").await;
        wait_view(&mut view, |screen| screen.contains("input held")).await;
        let listed = client
            .query("terminal", "list", json!({"sessionId":fixture.session}))
            .await
            .unwrap();
        assert_eq!(listed["kind"], "completed", "{listed}");
        let resources = listed["value"]["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 1);
        let original = &resources[0];
        assert_eq!(original["sessionId"], fixture.session);
        assert_eq!(original["ownership"]["kind"], "local");
        assert_eq!(original["result"]["mode"], "pty");
        assert_eq!(original["result"]["status"], "running");
        let target = json!({"sessionId":fixture.session,"ref":original["result"]["ref"]});
        let command = original["result"]["cmd"].as_str().unwrap().to_owned();

        // The echoed command contains no Chinese. Only executing this literal
        // printf through the original controller can produce the colored text.
        view.handle_event(Event::Paste(
            r"printf '\033[32m\344\270\255\346\226\207\347\273\210\347\253\257\033[0m\n'".into(),
        ));
        let (committed, received) = tokio::sync::oneshot::channel();
        view.control()
            .unwrap()
            .advance_clock(Duration::ZERO, move || {
                let _ = committed.send(());
            });
        tokio::time::timeout(Duration::from_secs(20), received)
            .await
            .unwrap()
            .unwrap();
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        let output = wait_view(&mut view, |screen| screen.contains("中文终端")).await;
        assert_colored_output(&view);
        evidence("terminal-workbench-original-pty", &output);

        support::click_button(&mut view, "Close workspace preview").await;
        wait_view_state(&mut view, |view, screen| {
            !view.accessibility_snapshot().iter().any(|node| {
                node.role == nsh_core::AccessibilityRole::Button
                    && node.label == "Close workspace preview"
            }) && screen.contains("WORKBENCH_UNSENT_DRAFT")
        })
        .await;
        tab_to_label(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(
            view.surface().input_context().unwrap().text.as_deref(),
            Some("WORKBENCH_UNSENT_DRAFT")
        );
        let hidden = client
            .query("terminal", "read", target.clone())
            .await
            .unwrap();
        assert_eq!(hidden["kind"], "completed", "{hidden}");
        assert_eq!(hidden["value"]["result"]["ref"], target["ref"]);
        assert_eq!(
            hidden["value"]["result"]["status"], "running",
            "hiding a pane must not stop its process"
        );

        support::click_button(&mut view, "Browse workspace files").await;
        support::click_button(&mut view, "Show conversation terminals").await;
        support::click_button(&mut view, &format!("Open terminal {command}")).await;
        wait_view(&mut view, |screen| screen.contains("中文终端")).await;
        assert_colored_output(&view);
        let reopened = client
            .query("terminal", "list", json!({"sessionId":fixture.session}))
            .await
            .unwrap();
        assert_eq!(reopened["kind"], "completed", "{reopened}");
        assert_eq!(reopened["value"]["resources"].as_array().unwrap().len(), 1);
        assert_eq!(
            reopened["value"]["resources"][0]["result"]["ref"], target["ref"],
            "reopening must reuse the original PTY"
        );

        let before_stop = client
            .query("terminal", "read", target.clone())
            .await
            .unwrap();
        assert_eq!(before_stop["kind"], "completed", "{before_stop}");
        assert_eq!(before_stop["value"]["result"]["status"], "running");
        stop_evidence(&view, "open-stop-confirmation", &before_stop);
        support::click_button(&mut view, "Stop terminal process").await;
        wait_view(&mut view, |screen| {
            screen.contains("Stop this terminal and its running process?")
        })
        .await;
        let confirming = client
            .query("terminal", "read", target.clone())
            .await
            .unwrap();
        assert_eq!(confirming["kind"], "completed", "{confirming}");
        assert_eq!(
            confirming["value"]["result"]["status"], "running",
            "opening confirmation must not stop the process"
        );
        stop_evidence(&view, "confirm-stop", &confirming);
        support::click_button(&mut view, "Confirm stop terminal process").await;
        wait_view(&mut view, |screen| {
            screen.contains("cancelled")
                && !screen.contains("Stop this terminal and its running process?")
        })
        .await;
        let stopped = client
            .query("terminal", "read", target.clone())
            .await
            .unwrap();
        assert_eq!(stopped["kind"], "completed", "{stopped}");
        assert_eq!(stopped["value"]["result"]["ref"], target["ref"]);
        assert_eq!(stopped["value"]["result"]["status"], "cancelled");
        support::click_button(&mut view, &format!("Close {command}")).await;
        support::click_button(&mut view, "Close workspace preview").await;
        tab_to_label(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(
            view.surface().input_context().unwrap().text.as_deref(),
            Some("WORKBENCH_UNSENT_DRAFT")
        );
        support::wait_draft(&client, &fixture.session, "WORKBENCH_UNSENT_DRAFT").await;
        assert_eq!(
            fixture.request_count.load(Ordering::SeqCst),
            0,
            "terminal input must not submit a model turn"
        );
        drop(view);
        bindings.close().await.unwrap();
        assert!(
            client
                .pending_terminals(&fixture.session)
                .await
                .unwrap()
                .is_empty()
        );
        fixture.finish().await;
    })
    .await
    .expect("real Host terminal workbench workflow timed out");
}
