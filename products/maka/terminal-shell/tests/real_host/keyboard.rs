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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn editor_copy_and_undo_precede_interrupt_and_ctrl_c_requires_confirming_the_current_run() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        support::click_button(&mut view, "Choose model and effort").await;
        wait_view(&mut view, |screen| {
            screen.contains("Search models…") && !screen.contains("Loading…")
        })
        .await;
        support::click_button(&mut view, "Use fixture-model · NSH fixture").await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("fixture-model") && model_menu_closed(view)
        })
        .await;
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;
        const DRAFT: &str = "CTRL_C_UNDO_DRAFT_你好";
        view.handle_event(Event::Paste(DRAFT.into()));
        support::wait_draft(&client, &fixture.session, DRAFT).await;
        support::wait_enabled_button(&mut view, "Send message").await;
        shortcut(&mut view, 'a');
        shortcut(&mut view, 'c');
        shortcut(&mut view, 'c');
        support::tick(&mut view);
        assert!(!view.snapshot().contains("Press Ctrl+C again to exit."));
        support::wait_draft(&client, &fixture.session, DRAFT).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        shortcut(&mut view, 'c');
        wait_view(&mut view, |screen| !screen.contains(DRAFT)).await;
        support::wait_draft(&client, &fixture.session, "").await;
        shortcut(&mut view, 'z');
        wait_view(&mut view, |screen| screen.contains(DRAFT)).await;
        support::wait_draft(&client, &fixture.session, DRAFT).await;
        support::wait_enabled_button(&mut view, "Send message").await;
        shortcut(&mut view, 'c');
        wait_view(&mut view, |screen| !screen.contains(DRAFT)).await;
        support::wait_draft(&client, &fixture.session, "").await;
        let mut previous = None;
        for (index, message) in ["FIRST_ESC_RUN", "SECOND_CONFIRMED_CTRL_C_RUN"]
            .into_iter()
            .enumerate()
        {
            tab_to_label(&mut view, "Message composer").await;
            wait_editable_composer(&mut view).await;
            view.handle_event(Event::Paste(message.into()));
            support::wait_draft(&client, &fixture.session, message).await;
            support::wait_enabled_button(&mut view, "Send message").await;
            view.handle_event(Event::Key(KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::NONE,
            )));
            let mut request = fixture.next_request().await;
            assert!(
                request.body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| {
                        entry["role"] == "user" && entry["content"].to_string().contains(message)
                    })
            );
            let answer = format!("{message}_RESPONSE");
            request.delta(&answer).await;
            wait_view(&mut view, |screen| screen.contains(&answer)).await;
            let observed = client
                .query("agent", "observe", json!({"sessionId":fixture.session}))
                .await
                .unwrap();
            let invocation = observed["run"]["invocationId"].as_str().unwrap().to_owned();
            assert_ne!(previous.as_ref(), Some(&invocation));
            wait_enabled_node(&mut view, "Stop response").await;
            if index == 0 {
                view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
            } else {
                shortcut(&mut view, 'c');
                wait_view(&mut view, |screen| {
                    screen.contains("Stop the current task?") && screen.contains("Keep running")
                })
                .await;
                support::click_button(&mut view, "Keep running").await;
                wait_view(&mut view, |screen| {
                    !screen.contains("Stop the current task?")
                })
                .await;
                request.delta("CTRL_C_CANCEL_LEFT_THE_TASK_RUNNING").await;
                wait_view(&mut view, |screen| {
                    screen.contains("CTRL_C_CANCEL_LEFT_THE_TASK_RUNNING")
                })
                .await;
                let active = client
                    .query(
                        "agent",
                        "execution",
                        json!({"sessionId":fixture.session,"invocationId":invocation}),
                    )
                    .await
                    .unwrap();
                assert_eq!(active["execution"]["state"], "running");
                shortcut(&mut view, 'c');
                wait_view(&mut view, |screen| {
                    screen.contains("Stop the current task?")
                })
                .await;
                // A second Ctrl+C dismisses the choice; it cannot confirm Stop.
                shortcut(&mut view, 'c');
                wait_view(&mut view, |screen| {
                    !screen.contains("Stop the current task?")
                })
                .await;
                let active = client
                    .query(
                        "agent",
                        "execution",
                        json!({"sessionId":fixture.session,"invocationId":invocation}),
                    )
                    .await
                    .unwrap();
                assert_eq!(active["execution"]["state"], "running");
                shortcut(&mut view, 'c');
                wait_view(&mut view, |screen| {
                    screen.contains("Stop the current task?")
                })
                .await;
                support::click_button(&mut view, "Stop task").await;
            }
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    let execution = client
                        .query(
                            "agent",
                            "execution",
                            json!({
                                "sessionId":fixture.session,"invocationId":invocation
                            }),
                        )
                        .await
                        .unwrap();
                    if execution["execution"]["state"] == "cancelled" {
                        assert_eq!(execution["kind"], "found");
                        assert_eq!(execution["execution"]["invocationId"], invocation);
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the explicit Stop did not cancel its exact execution");
            drop(request);
            fixture.idle(&client, &fixture.session).await;
            wait_view(&mut view, |screen| {
                screen.contains("Stopped") && screen.contains(&answer)
            })
            .await;
            previous = Some(invocation);
        }
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2);
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("the editor and confirmed current-execution interrupt workflow did not finish");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_ctrl_c_requires_two_presses_and_intervening_input_resets_the_gesture() {
    let fixture = Fixture::registered().await;
    let mut terminal = support::pty::Pty::spawn(&fixture.directory.path().join("host"), None);
    terminal.wait_for("Make something remarkable.").await;
    terminal.send(b"\x03");
    terminal.wait_for("Press Ctrl+C again to exit.").await;
    terminal.send(b"\x1b[D");
    terminal
        .wait_for_absent("Press Ctrl+C again to exit.")
        .await;
    terminal.send(b"\x03\x1b[D\x03");
    terminal.wait_for("Press Ctrl+C again to exit.").await;
    terminal.send(b"\x03");
    terminal.finish().await;
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
    // Closing a viewport keeps the independently owned service Host callable.
    let client = fixture.client().await;
    let observed = client
        .query("agent", "observe", json!({"sessionId":fixture.session}))
        .await
        .unwrap();
    assert_eq!(observed["session"]["id"], fixture.session);
    client.close().await.unwrap();
    fixture.finish().await;
}
