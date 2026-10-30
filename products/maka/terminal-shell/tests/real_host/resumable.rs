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
use maka_plugin_core::operation::{OperationOutcome, Receipt};

async fn replace_input(view: &mut AppView, label: &str, text: &str) {
    wait_enabled_node(view, label).await;
    tab_to_label(view, label).await;
    wait_focused_input(view, label).await;
    shortcut(view, 'a');
    if text.is_empty() {
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Backspace,
            KeyModifiers::NONE,
        )));
    } else {
        assert!(view.handle_event(Event::Paste(text.into())));
    }
    wait_view_state(view, |view, _| {
        view.surface()
            .input_context()
            .is_some_and(|context| context.text.as_deref() == Some(text))
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn composer_continues_an_interrupted_run_and_preserves_draft_send_priority() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        support::mutate(&client, "selectBackend", json!({
            "sessionId":fixture.session,"backend":{"kind":"model",
            "connectionId":fixture.selection["connectionId"],"modelId":fixture.selection["modelId"]}
        })).await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_editable_composer(&mut view).await;
        replace_input(&mut view, "Message composer", "ORIGINAL_RESUME_INPUT").await;
        support::click_button(&mut view, "Send message").await;
        support::wait_enabled_button(&mut view, "Pause response").await;
        let mut request = fixture.next_request().await;
        request
            .thinking("THOUGHT_INTERRUPTED_BEFORE_TOOL_DISPATCH")
            .await;
        wait_view(&mut view, |screen| {
            screen.contains("THOUGHT_INTERRUPTED_BEFORE_TOOL_DISPATCH")
        })
        .await;
        let active = client
            .query("agent", "observe", json!({"sessionId":fixture.session}))
            .await
            .unwrap();
        let source_turn = active["run"]["turnId"].clone();
        support::click_button(&mut view, "Pause response").await;
        support::wait_enabled_button(&mut view, "Continue response").await;
        fixture.idle(&client, &fixture.session).await;
        drop(request);
        replace_input(&mut view, "Message composer", "UNSENT_NEW_REQUEST").await;
        support::wait_enabled_button(&mut view, "Send message").await;
        assert!(
            !view
                .accessibility_snapshot()
                .iter()
                .any(|node| node.label == "Continue response")
        );
        replace_input(&mut view, "Message composer", "").await;
        support::click_button(&mut view, "Continue response").await;
        support::wait_enabled_button(&mut view, "Pause response").await;
        let continuation = fixture.next_request().await;
        assert!(
            continuation
                .body
                .to_string()
                .contains("ORIGINAL_RESUME_INPUT")
        );
        assert!(!continuation.body.to_string().contains("UNSENT_NEW_REQUEST"));
        assert!(
            !continuation
                .body
                .to_string()
                .contains("THOUGHT_INTERRUPTED_BEFORE_TOOL_DISPATCH")
        );
        support::wait_enabled_button(&mut view, "Pause response").await;
        let resumed = client
            .query("agent", "observe", json!({"sessionId":fixture.session}))
            .await
            .unwrap();
        assert_ne!(resumed["run"]["turnId"], source_turn);
        replace_input(&mut view, "Message composer", "QUEUED_DRAFT").await;
        support::wait_enabled_button(&mut view, "Queue message").await;
        replace_input(&mut view, "Message composer", "").await;
        support::click_button(&mut view, "Pause response").await;
        support::wait_enabled_button(&mut view, "Continue response").await;
        fixture.idle(&client, &fixture.session).await;
        drop(continuation);
        tab_to_label(&mut view, "Message composer").await;
        wait_focused_input(&mut view, "Message composer").await;
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        support::wait_enabled_button(&mut view, "Pause response").await;
        let mut continuation = fixture.next_request().await;
        assert!(
            continuation
                .body
                .to_string()
                .contains("ORIGINAL_RESUME_INPUT")
        );
        continuation.delta("RESUMED_ANSWER").await;
        continuation.finish().await;
        fixture.idle(&client, &fixture.session).await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("RESUMED_ANSWER")
                && view
                    .accessibility_snapshot()
                    .iter()
                    .any(|node| node.label == "Send message" && node.state.disabled)
        })
        .await;
        support::evidence("composer-resumed-answer", &view.snapshot());
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 3);
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("composer continuation timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lost_continuation_receipt_blocks_a_new_send_and_recovers_the_original_turn() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let gate = ReplyGate::resume(fixture.directory.path(), fixture.address.clone());
        let client = fixture.client_at(&gate.address).await;
        let sent = support::mutate(&client, "send", json!({
            "sessionId":fixture.session,"message":"RECOVER_CONTINUATION_INPUT","model":fixture.selection
        })).await;
        let request = fixture.next_request().await;
        support::mutate(&client, "stop", json!({"sessionId":fixture.session,"invocationId":sent["invocationId"]})).await;
        fixture.idle(&client, &fixture.session).await;
        drop(request);
        let ready = client.query("agent", "resumable", json!({"sessionId":fixture.session,"model":fixture.selection})).await.unwrap();
        assert_eq!(ready["kind"], "ready");
        let id = Uuid::new_v4();
        let mutation = client.control(id, "resume", json!({
            "sessionId":fixture.session,"sourceInvocationId":ready["source"]["invocationId"],
            "sourceHighWater":ready["source"]["highWater"],"model":fixture.selection
        })).await.unwrap();
        let original = mutation.prepare().await.unwrap();
        gate.arm();
        let mut confirmation = Box::pin(mutation.confirm());
        tokio::select! {
            result = &mut confirmation => panic!("continuation receipt escaped its gate: {result:?}"),
            () = gate.held.notified() => {},
        }
        drop(confirmation);
        mutation.disconnect().await;
        gate.release();
        let mut continuation = fixture.next_request().await;
        continuation.delta("RECOVERED_CONTINUATION_ANSWER").await;
        continuation.finish().await;
        fixture.idle(&client, &fixture.session).await;
        client.close().await.unwrap();
        let restarted = fixture.client().await;
        assert!(restarted.operation(id).await.unwrap().receipt.is_none());
        let (mut view, bindings) = fixture.view(restarted.clone(), Some(fixture.session.clone()));
        wait_editable_composer(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("Recover original actions (1)")).await;
        replace_input(&mut view, "Message composer", "LATER_DRAFT_SURVIVES_CONTINUATION_RECOVERY").await;
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.label == "Send message" && node.state.disabled)).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        let recover = view.accessibility_snapshot().into_iter()
            .find(|node| node.label == "Recover original actions (1)").unwrap();
        support::click_node(&mut view, recover);
        support::wait_enabled_button(&mut view, "Send message").await;
        let settled = restarted.operation(id).await.unwrap();
        assert_eq!(settled.reference, original.reference);
        assert!(matches!(settled.receipt, Some(Receipt::Recorded {outcome:OperationOutcome::Returned {ref value},..}) if value["kind"] == "started" && value["execution"]["turnId"] != ready["source"]["turnId"]));
        support::wait_draft(&restarted, &fixture.session, "LATER_DRAFT_SURVIVES_CONTINUATION_RECOVERY").await;
        assert!(restarted.pending_controls().await.unwrap().is_empty());
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2);
        support::evidence("composer-recovered-continuation", &view.snapshot());
        drop(view);
        bindings.close().await.unwrap();
        drop(gate);
        fixture.finish().await;
    }).await.expect("continuation receipt recovery timed out");
}
