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
    let mut fixture = Fixture::open().await;
    let client = fixture.client().await;
    let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
    wait_editable_composer(&mut view).await;
    support::click_button(&mut view, "Choose model and effort").await;
    wait_view(&mut view, |screen| {
        screen.contains("Search models and sources…") && !screen.contains("Loading…")
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
        let draft = message.to_owned();
        view.handle_event(Event::Paste(draft.clone()));
        support::wait_draft(&client, &fixture.session, &draft).await;
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
        let run = observed["run"]["runId"].as_str().unwrap().to_owned();
        assert_ne!(previous.as_ref(), Some(&run));
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
                    json!({"sessionId":fixture.session,"runId":run}),
                )
                .await
                .unwrap();
            assert_eq!(active["execution"]["state"]["kind"], "running");
            shortcut(&mut view, 'c');
            wait_view(&mut view, |screen| {
                screen.contains("Stop the current task?")
            })
            .await;
            commit_native_events(&mut view).await;
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
                    json!({"sessionId":fixture.session,"runId":run}),
                )
                .await
                .unwrap();
            assert_eq!(active["execution"]["state"]["kind"], "running");
            shortcut(&mut view, 'c');
            wait_view(&mut view, |screen| {
                screen.contains("Stop the current task?")
            })
            .await;
            support::click_button(&mut view, "Stop task").await;
        }
        fixture.idle(&client, &fixture.session).await;
        let execution = client
            .query(
                "agent",
                "execution",
                json!({"sessionId":fixture.session,"runId":run}),
            )
            .await
            .unwrap();
        assert_eq!(execution["kind"], "found");
        assert_eq!(execution["execution"]["runId"], run);
        assert_eq!(execution["execution"]["state"]["kind"], "cancelled");
        drop(request);
        wait_view(&mut view, |screen| {
            screen.contains("Stopped") && screen.contains(&answer)
        })
        .await;
        previous = Some(run);
    }
    assert_eq!(
        fixture
            .request_count
            .load(std::sync::atomic::Ordering::SeqCst),
        2,
        "copy, undo and stop confirmation must not admit additional model requests"
    );
    drop(view);
    bindings.close().await.unwrap();
    client.close().await.unwrap();
    fixture.finish().await;
}
