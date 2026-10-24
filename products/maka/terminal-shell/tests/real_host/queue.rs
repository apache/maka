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
use nsh_platform_tui::ServiceOutput;

async fn replace_input(view: &mut AppView, label: &str, text: &str) {
    wait_enabled_node(view, label).await;
    support::click_label(view, label);
    wait_focused_input(view, label).await;
    shortcut(view, 'a');
    assert!(view.handle_event(Event::Paste(text.into())));
    wait_view_state(view, |view, _| {
        view.surface()
            .input_context()
            .is_some_and(|context| context.text.as_deref() == Some(text))
    })
    .await;
}

async fn expanded_queue(view: &mut AppView) {
    support::wait_enabled_button(view, "Queued messages").await;
    let collapsed = view
        .accessibility_snapshot()
        .iter()
        .any(|node| node.label == "Queued messages" && !node.state.selected);
    if collapsed {
        support::click_button(view, "Queued messages").await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queue_management_preserves_the_stream_draft_and_original_message_identity() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        fixture.seed_history(2).await;
        let request_count = fixture.request_count.load(Ordering::SeqCst);
        let client = fixture.client().await;
        let started = support::mutate(&client, "send", json!({
            "sessionId":fixture.session,"message":"Keep working while I manage followups","model":fixture.selection
        })).await;
        assert_eq!(started["kind"], "started");
        let mut request = fixture.next_request().await;
        request.delta("QUEUE_CURRENT_RESPONSE").await;
        let (mut view, bindings) = fixture.view(fixture.client().await, Some(fixture.session.clone()));
        view.resize(120, 40);
        wait_editable_composer(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("QUEUE_CURRENT_RESPONSE")).await;

        // Queueing a follow-up uses the resident saved draft. It must not pull
        // a user who is reading an earlier turn back to the streaming tail.
        support::click_button(&mut view, "Jump to turn: History question 00").await;
        // Leave the turn tooltip so only the original transcript can satisfy
        // the reader assertion below.
        view.handle_event(Event::Mouse(MouseEvent {kind:MouseEventKind::Moved,column:0,row:0,modifiers:KeyModifiers::NONE}));
        wait_view(&mut view, |screen| screen.contains("History question 00")).await;
        let original = "QUEUED_LOCAL 中文😀\nsecond line";
        replace_input(&mut view, "Message composer", original).await;
        support::wait_draft(&client, &fixture.session, original).await;
        support::click_button(&mut view, "Queue message").await;
        // The same text is already in the composer before send completes.
        // Its original queued receipt must arrive before reading the queue.
        let queued = wait_view(&mut view, |screen| screen.contains("Message queued.") && screen.contains("QUEUED_LOCAL") && screen.contains("History question 00")).await;
        evidence("queue-send-keeps-history-reader", &queued);
        let queue = client.query("agent", "queue", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(queue["entries"].as_array().unwrap().len(), 1);
        let message_id = queue["entries"][0]["messageId"].as_str().unwrap().to_owned();
        let main_draft = "MAIN_DRAFT remains independent 中文";
        replace_input(&mut view, "Message composer", main_draft).await;
        support::wait_draft(&client, &fixture.session, main_draft).await;

        support::click_button(&mut view, "Edit queued message 1").await;
        wait_focused_input(&mut view, "Queued message editor").await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(original));
        // Queue editing owns Escape locally; the composer's existing global
        // stop action would otherwise cancel the run and retract this queue.
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, _| !view.accessibility_snapshot().iter().any(|node| node.label == "Queued message editor")).await;
        assert_eq!(client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap()["run"]["invocationId"], started["invocationId"]);
        support::click_button(&mut view, "Edit queued message 1").await;
        let edited = "QUEUED_EDITED 中文😀\n  keep exact lines  ";
        replace_input(&mut view, "Queued message editor", edited).await;
        // Another client changes the global queue revision while this editor
        // is open. Review keeps the user's text and never overwrites the draft.
        let removed = support::mutate(&client, "send", json!({
            "sessionId":fixture.session,"message":"QUEUED_REMOVE from another client","model":fixture.selection
        })).await;
        assert_eq!(removed["kind"], "queued");
        support::click_button(&mut view, "Review current queued message").await;
        wait_view(&mut view, |screen| screen.contains("Current queued message")).await;
        support::click_button(&mut view, "Keep my queued message edit").await;
        support::click_button(&mut view, "Save queued message").await;
        wait_view_state(&mut view, |view, _| !view.accessibility_snapshot().iter().any(|node| node.label == "Queued message editor")).await;
        let queue = client.query("agent", "queue", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(queue["entries"].as_array().unwrap().len(), 2);
        let body = client.query("agent", "queueMessage", json!({
            "sessionId":fixture.session,"messageId":message_id,"expectedRevision":queue["revision"]
        })).await.unwrap();
        assert_eq!(body["message"], edited);
        support::wait_draft(&client, &fixture.session, main_draft).await;

        expanded_queue(&mut view).await;
        support::click_button(&mut view, "Remove queued message 2").await;
        wait_view_state(&mut view, |view, screen| {
            !screen.contains("QUEUED_REMOVE") && view.accessibility_snapshot().iter().any(|node| node.label == "Steer queued message 1 now" && !node.state.disabled)
        }).await;
        assert!(fixture.store.session(&fixture.session).await.unwrap().message_cancelled(&fixture.session, removed["messageId"].as_str().unwrap()).await.unwrap());
        assert_eq!(client.query("agent", "queue", json!({"sessionId":fixture.session})).await.unwrap()["entries"].as_array().unwrap().len(), 1);

        // Reopening the real view restores the Host queue without a send echo
        // or another provider request. The same main draft survives separately.
        drop(view);
        bindings.close().await.unwrap();
        let (mut view, bindings) = fixture.view(fixture.client().await, Some(fixture.session.clone()));
        view.resize(120, 40);
        wait_editable_composer(&mut view).await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(main_draft));
        wait_view(&mut view, |screen| screen.contains("QUEUED_EDITED")).await;
        support::click_button(&mut view, "Steer queued message 1 now").await;
        wait_view(&mut view, |screen| screen.contains("Sending to current turn")).await;
        let promoted = client.query("agent", "queue", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(promoted["entries"][0]["messageId"], message_id);
        assert_eq!(promoted["entries"][0]["kind"], "steering");

        // The Host can claim this exact row at the next model step while an
        // uncommitted edit is open. Its text must remain available for Copy,
        // and must never replace the already accepted steering instruction.
        support::click_button(&mut view, "Edit queued message 1").await;
        let orphan = "UNCOMMITTED_EDIT must not steer or replace MAIN_DRAFT";
        replace_input(&mut view, "Queued message editor", orphan).await;
        request.tool("todo_write", json!({"todos":[{"content":"QUEUE_BOUNDARY","status":"completed"}]})).await;
        let mut continuation = fixture.next_request().await;
        let expected = format!("The user sent a message while you were working:\n<user_query>\n{edited}\n</user_query>");
        assert_eq!(continuation.body["messages"].as_array().unwrap().iter().filter(|message| message["content"] == expected).count(), 1);
        let prompt = continuation.body["messages"].to_string();
        assert!(!prompt.contains("QUEUED_REMOVE"));
        assert!(!prompt.contains(orphan));
        assert!(!prompt.contains(main_draft));
        assert_eq!(client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap()["run"]["invocationId"], started["invocationId"]);
        wait_view(&mut view, |screen| screen.contains("Message no longer queued")).await;
        view.surface_mut().set_host_services_enabled(true);
        view.drain_service_output().for_each(drop);
        support::click_button(&mut view, "Copy queued message edit").await;
        wait_view(&mut view, |screen| screen.contains("Edit copied")).await;
        let copied = view.drain_service_output().filter_map(|effect| match effect {
            ServiceOutput::Clipboard(text) => Some(text),
            _ => None,
        }).collect::<Vec<_>>();
        assert_eq!(copied, [orphan]);
        continuation.delta("QUEUE_FINAL_RESPONSE").await;
        continuation.finish().await;
        fixture.idle(&client, &fixture.session).await;
        // A new run state rebinds the composer's own Escape command. Its
        // scope must remain the sibling main card, outside this queue editor.
        wait_view_state(&mut view, |view, _| !view.accessibility_snapshot().iter().any(|node| node.label == "Stop response")).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, _| !view.accessibility_snapshot().iter().any(|node| node.label == "Queued message editor")).await;
        tab_to_label(&mut view, "Message composer").await;
        wait_focused_input(&mut view, "Message composer").await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(main_draft));
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), request_count + 2);
        let work = client.query("agent", "work", json!({"sessionId":fixture.session,"target":{"kind":"message","messageId":message_id}})).await.unwrap();
        assert_eq!(work["kind"], "delivered");
        assert_eq!(work["shared"], true);
        assert_eq!(work["execution"]["invocationId"], started["invocationId"]);
        assert!(client.pending_controls().await.unwrap().is_empty());
        evidence("queue-management-keeps-main-draft", &view.snapshot());
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("the original queue management workflow timed out");
}
